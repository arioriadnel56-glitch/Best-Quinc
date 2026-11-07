(function (racine) {
  'use strict';
  // Couche réseau de Best-Quinca (frontend) : appels au serveur avec délai maximum, détection d'un serveur endormi
  // ou en cours de réveil, réveil À LA DEMANDE avec attentes progressives, écran de transition aux couleurs de la marque.
  //
  // Règles :
  //  - aucun minuteur ne contacte le serveur « pour le garder éveillé » : le réveil n'est lancé qu'après l'échec d'un vrai appel,
  //    ou avant une action qui exige le serveur (connexion, inscription, envoi des ventes en attente) ;
  //  - la disponibilité n'est JAMAIS simulée : « prêt » signifie que /healthz a répondu { ok: true } (serveur ET base).

  class ErreurReseau extends Error {
    constructor(kind, message, status) {
      super(message);
      this.name = 'ErreurReseau';
      this.kind = kind; // 'hors_ligne' | 'reveil'
      this.hors_ligne = true;
      if (status) this.status = status;
    }
  }

  // Attentes entre deux sondes (ms) : 13 essais en tout, environ 2 minutes 30 au maximum
  const DELAIS_REVEIL = [1000, 2000, 3000, 5000, 5000, 8000, 10000, 10000, 15000, 15000, 15000, 15000];
  const VALIDITE_PRET_MS = 10 * 60 * 1000; // au-delà, rien ne prouve que le serveur n'a pas été remis en veille

  function creer(opt) {
    const cfg = opt.config || {};
    const base = String(cfg.api || '').trim().replace(/\/+$/, '');
    const appelFetch = opt.fetch;
    const poser = opt.setTimeout || setTimeout;
    const retirer = opt.clearTimeout || clearTimeout;
    const maintenant = opt.now || Date.now;
    const enLigne = opt.enLigne || (() => true);
    const delais = opt.delais || DELAIS_REVEIL;
    const delaiSonde = opt.delaiSonde || 10000;
    const lieu = opt.location || null;
    const ecran = opt.ecran || null;

    const etat = { serveur: 'inconnu', tentative: 0, max: delais.length + 1, depuis: 0, dernierSucces: 0 };
    const ecouteurs = new Set();
    let promesse = null;
    let abandon = false;

    const instantane = () => ({ ...etat });
    const notifier = () => { for (const f of [...ecouteurs]) { try { f(instantane()); } catch { /* un écouteur fautif ne bloque pas les autres */ } } };
    const surEtat = (f) => { ecouteurs.add(f); return () => ecouteurs.delete(f); };
    const attendre = (ms) => new Promise((r) => poser(r, ms));
    const url = (chemin) => base + chemin;
    const origine = () => base || (lieu ? lieu.origin : '');

    function wsUrl() {
      if (base) return base.replace(/^http/i, 'ws') + '/ws';
      const l = lieu || { protocol: 'https:', host: '' };
      return `${l.protocol === 'https:' ? 'wss' : 'ws'}://${l.host}/ws`;
    }

    const slugDepuisChemin = (chemin) => {
      const m = /^\/app\/([a-z0-9-]{3,60})(?:\/|$)/.exec(String(chemin || ''));
      return m ? m[1] : '';
    };

    function marquerPret() {
      etat.dernierSucces = maintenant();
      if (etat.serveur !== 'pret') { etat.serveur = 'pret'; etat.tentative = 0; notifier(); }
    }

    // Le serveur est-il réputé prêt ? (réponse récente de sa part)
    const estPret = () => etat.serveur === 'pret' && maintenant() - etat.dernierSucces < VALIDITE_PRET_MS;

    // Réponse d'un hébergeur qui n'a pas encore démarré l'application : page HTML au lieu de JSON, ou 502/503/504 du proxy
    function reponseDeReveil(res, json) {
      const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      const routage = (res.headers && res.headers.get && res.headers.get('x-render-routing')) || '';
      if ((res.status === 502 || res.status === 503 || res.status === 504) && !/json/i.test(ct)) return true;
      if (json && res.ok && /text\/html/i.test(ct)) return true;
      return /hibernate|no-server|wake/i.test(routage);
    }

    // Appel du serveur avec délai maximum. Lève ErreurReseau (kind 'hors_ligne' ou 'reveil') si le serveur n'a pas pu répondre.
    async function appeler(chemin, init = {}, { delai = 15000, json = true } = {}) {
      // Pendant un réveil en cours, inutile d'envoyer d'autres requêtes : on échoue tout de suite (la file locale prend le relais)
      if (etat.serveur === 'reveil') throw new ErreurReseau('reveil', 'Serveur en cours de réveil.');
      if (!enLigne()) throw new ErreurReseau('hors_ligne', 'Pas de connexion à internet.');
      const ctrl = new AbortController();
      const minuteur = poser(() => ctrl.abort(), delai);
      let res;
      try {
        res = await appelFetch(url(chemin), { ...init, signal: ctrl.signal });
      } catch {
        retirer(minuteur);
        // Un serveur endormi coupe la connexion ou répond sans en-têtes CORS : le navigateur ne voit qu'une erreur réseau
        throw new ErreurReseau(enLigne() ? 'reveil' : 'hors_ligne', enLigne() ? 'Le serveur ne répond pas (réveil possible).' : 'Pas de connexion à internet.');
      }
      retirer(minuteur);
      if (reponseDeReveil(res, json)) throw new ErreurReseau('reveil', 'Le serveur démarre.', res.status);
      marquerPret();
      return res;
    }

    // Une seule sonde : /healthz répond { ok: true } seulement si le serveur ET la base de données répondent
    async function sonder() {
      const ctrl = new AbortController();
      const minuteur = poser(() => ctrl.abort(), delaiSonde);
      try {
        const res = await appelFetch(url('/healthz'), { cache: 'no-store', headers: { Accept: 'application/json' }, signal: ctrl.signal });
        if (!res.ok) return false;
        const d = await res.json().catch(() => null);
        return Boolean(d && d.ok === true);
      } catch {
        return false;
      } finally {
        retirer(minuteur);
      }
    }

    // Réveille le serveur (une seule boucle à la fois, partagée par tous les appelants). Résout true quand il est prêt.
    function reveiller({ avecEcran = false } = {}) {
      if (!promesse) {
        abandon = false;
        etat.serveur = 'reveil';
        etat.tentative = 0;
        etat.depuis = maintenant();
        notifier();
        promesse = (async () => {
          for (let i = 0; i <= delais.length; i++) {
            if (abandon) break;
            if (!enLigne()) { etat.serveur = 'inconnu'; notifier(); return false; }
            etat.tentative = i + 1;
            notifier();
            if (await sonder()) { marquerPret(); return true; }
            if (i < delais.length && !abandon) await attendre(delais[i]);
          }
          etat.serveur = 'indisponible';
          notifier();
          return false;
        })().finally(() => { promesse = null; });
      }
      if (avecEcran && ecran) ecran.attente(instantane, surEtat);
      return promesse;
    }

    const reveilEnCours = () => promesse !== null;
    function abandonner() { abandon = true; }

    // Attend que le serveur soit prêt, avec l'écran de transition. En cas d'échec : message clair + « Réessayer ».
    async function attendreServeur({ avecEcran = true, peutContinuer = false } = {}) {
      for (;;) {
        const ok = await reveiller({ avecEcran });
        if (ok) { if (ecran) ecran.masquer(); return true; }
        if (!avecEcran || !ecran) return false;
        const choix = await ecran.echec({ peutContinuer, hors_ligne: !enLigne() });
        if (choix === 'continuer') { ecran.masquer(); return false; }
      }
    }

    // Avant une action qui exige le serveur et ne doit pas être rejouée à l'aveugle (connexion, inscription…)
    async function garantir(options) {
      if (estPret()) return true;
      return attendreServeur(options);
    }

    return {
      ErreurReseau, appeler, sonder, reveiller, attendreServeur, garantir, abandonner, reveilEnCours, estPret,
      etat: instantane, surEtat, url, origine, wsUrl, slugDepuisChemin,
      enLigne: () => enLigne(),
    };
  }

  // ---------- Écran de transition aux couleurs de Best-Quinca (navigateur uniquement) ----------
  function ecranDom(doc) {
    let el = null;
    let desabonner = null;
    let horloge = null;
    let retour = null;

    const noeud = (tag, classe, texte) => { const n = doc.createElement(tag); if (classe) n.className = classe; if (texte !== undefined) n.textContent = texte; return n; };

    function monter() {
      if (el) return el;
      el = noeud('div', 'reveil');
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-label', 'Réveil du serveur');
      const carte = noeud('div', 'reveil-carte');
      const logo = noeud('img', 'reveil-logo');
      logo.src = '/assets/marque/best-quinca-clair.png';
      logo.alt = 'Best-Quinca';
      logo.width = 120;
      logo.height = 100;
      carte.append(logo, noeud('h1', 'reveil-titre'), noeud('p', 'reveil-texte'), noeud('div', 'reveil-barre'), noeud('p', 'reveil-detail'), noeud('div', 'reveil-actions'));
      el.append(carte);
      doc.body.append(el);
      return el;
    }

    const champ = (nom) => el.querySelector(`.reveil-${nom}`);

    function arreterSuivi() {
      if (desabonner) { desabonner(); desabonner = null; }
      if (horloge) { clearInterval(horloge); horloge = null; }
    }

    function afficherAttente(lireEtat, surEtat) {
      monter();
      arreterSuivi();
      el.classList.remove('echec');
      champ('titre').textContent = 'Votre espace se prépare';
      champ('texte').textContent = 'Le serveur de Best-Quinca se réveille. Cela prend en général moins d\'une minute. Vous pouvez patienter : l\'action reprendra toute seule.';
      champ('actions').replaceChildren();
      const maj = () => {
        const s = lireEtat();
        const secondes = s.depuis ? Math.max(0, Math.round((Date.now() - s.depuis) / 1000)) : 0;
        champ('detail').textContent = `Tentative ${Math.max(1, s.tentative)} sur ${s.max} · ${secondes} s`;
      };
      maj();
      desabonner = surEtat(maj);
      horloge = setInterval(maj, 1000);
    }

    function afficherEchec({ peutContinuer, hors_ligne }) {
      monter();
      arreterSuivi();
      el.classList.add('echec');
      champ('titre').textContent = hors_ligne ? 'Pas de connexion à internet' : 'Le serveur ne répond pas';
      champ('texte').textContent = hors_ligne
        ? 'Vérifiez votre réseau. Ce qui est enregistré sur cet appareil est conservé.'
        : 'Le serveur ou la base de données est injoignable pour le moment. Vérifiez votre connexion, puis réessayez. Ce qui est enregistré sur cet appareil est conservé.';
      champ('detail').textContent = '';
      return new Promise((resoudre) => {
        const reessayer = noeud('button', 'btn primaire', 'Réessayer');
        reessayer.type = 'button';
        reessayer.addEventListener('click', () => resoudre('reessayer'));
        const actions = [reessayer];
        if (peutContinuer) {
          const continuer = noeud('button', 'btn', 'Continuer hors connexion');
          continuer.type = 'button';
          continuer.addEventListener('click', () => resoudre('continuer'));
          actions.push(continuer);
        }
        champ('actions').replaceChildren(...actions);
        reessayer.focus();
        retour = resoudre;
      });
    }

    function masquer() {
      arreterSuivi();
      if (retour) { retour = null; }
      if (el) { el.remove(); el = null; }
    }

    return { attente: afficherAttente, echec: afficherEchec, masquer };
  }

  // ---------- Démarrage dans le navigateur ----------
  if (typeof module === 'object' && module.exports) {
    module.exports = { creer, ErreurReseau, DELAIS_REVEIL };
  } else if (racine && racine.document) {
    racine.BQR = creer({
      config: racine.BQ_CONFIG || {},
      fetch: racine.fetch.bind(racine),
      enLigne: () => racine.navigator.onLine !== false,
      location: racine.location,
      ecran: ecranDom(racine.document),
    });
  }
})(typeof self !== 'undefined' ? self : this);
