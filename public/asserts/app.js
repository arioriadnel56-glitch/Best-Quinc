(() => {
  'use strict';

  const BQ = window.BQ; // utilitaires partagés (outils.js)
  const HL = window.BQHL; // stockage durable sur l'appareil (hors-ligne.js)
  const R = window.BQR; // appels au serveur, réveil à la demande (reveil.js)
  // Page servie par le backend : l'identifiant est dans la page. Frontend statique : on le lit dans l'adresse /app/<espace>/
  const SLUG = document.body.dataset.slug || R.slugDepuisChemin(location.pathname);
  if (!SLUG) { location.replace('/'); return; }
  const TOKEN_KEY = `bq:${SLUG}:token`;
  // L'application Android démarre sur /entrer : on y retient la dernière quincaillerie utilisée
  try { localStorage.setItem('bq:dernier-espace', SLUG); } catch { /* stockage indisponible */ }
  // Ouvert depuis l'application Google Play (paramètre source ou référent android-app://) : l'achat de l'abonnement se fait hors de l'application
  try {
    if (new URLSearchParams(location.search).get('source') === 'playstore' || document.referrer.startsWith('android-app://')) sessionStorage.setItem('bq:playstore', '1');
  } catch { /* stockage indisponible */ }
  const enPlayStore = () => { try { return sessionStorage.getItem('bq:playstore') === '1'; } catch { return false; } };
  const root = document.getElementById('root');

  const state = {
    token: localStorage.getItem(TOKEN_KEY),
    user: null,
    entreprise: null,
    abonnement: null,
    config: null,
    installEvent: null,
    horsLigne: false,
    demarreLocal: false, // ouverte depuis la copie de l'appareil, sans avoir encore contacté le serveur
  };

  // ---------- Marque de l'entreprise (nom, couleur, logo) : gardée sur l'appareil, affichée sans serveur ----------
  const cleMarque = `bq:${SLUG}:marque`;
  function lireMarque() { try { return JSON.parse(localStorage.getItem(cleMarque) || 'null'); } catch { return null; } }
  function appliquerMarque(m) {
    if (!m || !m.nom_app) return;
    document.title = m.nom_app;
    document.body.dataset.nom = m.nom_app;
    if (/^#[0-9a-f]{6}$/i.test(m.couleur || '')) {
      document.documentElement.style.setProperty('--marque', m.couleur);
      document.documentElement.style.setProperty('--sur-marque', BQ.couleurLisible(m.couleur));
      const tc = document.querySelector('meta[name="theme-color"]');
      if (tc) tc.setAttribute('content', m.couleur);
    }
    const ap = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (ap) ap.setAttribute('content', m.nom_app);
  }
  function memoriserMarque(e) {
    if (!e || !e.nom_app) return;
    const m = { nom_app: e.nom_app, couleur: e.couleur, a_logo: Boolean(e.a_logo), logo_v: e.logo_v || 0 };
    try { localStorage.setItem(cleMarque, JSON.stringify(m)); } catch { /* stockage indisponible */ }
    appliquerMarque(m);
  }
  appliquerMarque(lireMarque());

  // ---------- Outils ----------
  const fcfa = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)) + ' F CFA';
  // « 6 500 F CFA » : le nombre en grand, l'unité en petit (l'espace fine du format français n'existe pas dans la police des titres)
  const avecUnite = (texte) => {
    const m = /^(.*?)\s*(F CFA)$/.exec(String(texte).replace(/\u202f/g, '\u00a0'));
    return m ? [m[1], h('small', { class: 'unite' }, ` ${m[2]}`)] : [String(texte)];
  };
  const nombre = (n) => new Intl.NumberFormat('fr-FR').format(Number(n) || 0);
  const estProprio = () => state.user && state.user.role === 'proprietaire';
  const MODES = { especes: 'Espèces', mobile_money: 'Mobile Money', autre: 'Autre', credit: 'À crédit' };
  // Modes acceptés pour encaisser de l'argent (règlements, remboursements) : pas de « crédit » ici
  const MODES_ARGENT = { especes: 'Espèces', mobile_money: 'Mobile Money', autre: 'Autre' };
  const TYPES_MVT = { entree: 'Entrée', sortie: 'Sortie', ajustement: 'Correction', vente: 'Vente' };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let valeur;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') valeur = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.append(c.nodeType ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    if (valeur !== undefined) el.value = valeur; // après les <option>
    return el;
  }

  // replaceChildren() écrirait « null » ou « false » pour un bloc vide : on les ignore
  const remplacer = (el, ...enfants) => el.replaceChildren(...enfants.filter((c) => c !== null && c !== undefined && c !== false && c !== ''));

  function toast(message, type = 'ok') {
    const t = h('div', { class: `toast ${type}` }, message);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), type === 'erreur' ? 6000 : 3500);
  }

  const messageReseau = (kind) => (kind === 'reveil'
    ? 'Le serveur se réveille. Ce que vous avez enregistré reste sur cet appareil ; réessayez dans un instant.'
    : 'Pas de connexion à internet. Vérifiez votre réseau puis réessayez.');

  // Réveil à la demande : lancé seulement après l'échec d'un vrai appel serveur, jamais sur minuteur.
  // Quand le serveur répond, l'écran en attente reprend tout seul (marquerReseau).
  function reveillerEnFond() {
    if (!R.enLigne()) return;
    R.reveiller({ avecEcran: false }).then((ok) => { if (ok) marquerReseau(true); majEtatReseau(); });
  }

  // Avant une action qui ne doit pas être rejouée à l'aveugle (connexion…) : on s'assure que le serveur répond, écran de transition à l'appui
  async function serveurRequis() {
    if (!(await R.garantir({ avecEcran: true }))) throw new Error('Le serveur ne répond pas. Réessayez dans un instant.');
  }

  async function api(path, { method = 'GET', body, delai } = {}) {
    let res;
    try {
      // Serveur pas encore sollicité : délai court, la vente ou la lecture bascule alors sur la copie de l'appareil
      res = await R.appeler('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }, { delai: delai || (R.estPret() ? (method === 'GET' ? 15000 : 25000) : 12000) });
    } catch (e) {
      const kind = e && e.kind ? e.kind : 'hors_ligne';
      marquerReseau(false);
      if (kind === 'reveil') reveillerEnFond();
      const err = new Error(messageReseau(kind));
      err.hors_ligne = true;
      err.kind = kind;
      throw err;
    }
    marquerReseau(true);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && state.token) deconnecter();
      if (res.status === 402 && data.code === 'ABONNEMENT_REQUIS') {
        state.abonnement = null;
        if (location.hash !== '#/abonnement') location.hash = '#/abonnement';
      }
      const err = new Error(data.erreur || 'Une erreur est survenue.');
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  // Exécute une action liée à un bouton : désactive pendant l'appel, affiche les erreurs
  async function agir(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { toast(e.message, 'erreur'); } finally { if (btn) btn.disabled = false; }
  }

  function modale(titre, contenu, { large = false, classe = '' } = {}) {
    const d = h('dialog', { class: 'modale' + (large ? ' large' : '') + (classe ? ` ${classe}` : '') },
      h('div', { class: 'modale-tete' },
        h('h2', {}, titre),
        h('button', { class: 'btn-icone', type: 'button', 'aria-label': 'Fermer', onclick: () => d.close() }, '×')),
      h('div', { class: 'modale-corps' }, contenu));
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
    return d;
  }

  function champ(libelle, input, aide) {
    return h('label', { class: 'champ' }, h('span', {}, libelle), input, aide && h('small', {}, aide));
  }

  // Confirmation avant toute suppression : explique ce qui disparaît, et surtout ce qui reste
  function confirmerSuppression({ titre, texte, bouton = 'Supprimer', action }) {
    const oui = h('button', { class: 'btn danger', type: 'button', onclick: () => agir(oui, async () => { await action(); d.close(); }) }, bouton);
    const d = modale(titre, h('div', {}, h('p', {}, texte),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Annuler'), oui)));
  }

  const dateFr = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  // ---------- Installation (PWA de l'entreprise) ----------
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvent = e;
    document.querySelectorAll('[data-installer]').forEach((b) => { b.hidden = false; });
  });
  window.addEventListener('appinstalled', () => {
    state.installEvent = null;
    toast('Application installée.');
    document.querySelectorAll('[data-installer]').forEach((b) => { b.hidden = true; });
  });
  const dejaInstallee = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  async function lancerInstallation() {
    if (!state.installEvent) return;
    state.installEvent.prompt();
    await state.installEvent.userChoice.catch(() => null);
    state.installEvent = null;
  }

  function blocInstallation() {
    const nom = state.entreprise.nom_app;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (dejaInstallee()) {
      return h('p', { class: 'ok-msg' }, `L'application « ${nom} » est déjà installée sur cet appareil.`);
    }
    return h('div', {},
      h('button', { class: 'btn primaire', type: 'button', 'data-installer': true, hidden: !state.installEvent, onclick: lancerInstallation },
        `Installer « ${nom} »`),
      h('p', { class: 'aide' }, ios
        ? 'Sur iPhone et iPad : touchez le bouton Partager, puis « Sur l\'écran d\'accueil ».'
        : 'Si le bouton n\'apparaît pas : dans le menu de votre navigateur (⋮), choisissez « Installer l\'application » ou « Ajouter à l\'écran d\'accueil ».'));
  }

  // ---------- Session ----------
  function deconnecter() {
    localStorage.removeItem(TOKEN_KEY);
    // La session et la copie des produits quittent l'appareil ; les ventes non envoyées, elles, restent
    HL.del(cleHL('me')).catch(() => {});
    HL.del(cleHL('produits')).catch(() => {});
    document.body.classList.remove('reseau-actif');
    fermerTempsReel();
    state.token = null;
    state.user = null;
    state.abonnement = null;
    afficherConnexion();
  }

  async function chargerSession() {
    const me = await api('/auth/me');
    state.user = me.utilisateur;
    state.entreprise = me.entreprise;
    state.abonnement = me.abonnement;
    memoriserMarque(me.entreprise);
    // Copie de la session pour pouvoir rouvrir l'application sans réseau
    HL.set(cleHL('me'), { utilisateur: me.utilisateur, entreprise: me.entreprise, abonnement: me.abonnement, le: Date.now() }).catch(() => {});
  }

  // ---------- Temps réel (WebSocket) ----------
  // Ce qui change sur un autre appareil de l'entreprise arrive ici. On ne réécrit jamais un écran où l'on saisit quelque chose :
  // le tableau de bord se rafraîchit seul, les listes proposent « Actualiser », la caisse n'est pas touchée (le serveur vérifie le stock à la vente).
  let tempsReel = null;
  let minuteurMaj = null;
  const vueCourante = () => (location.hash.replace(/^#\/?/, '') || 'tableau').split('?')[0];

  // Le temps réel ne sert qu'à un appareil réellement utilisé : onglet visible, serveur déjà réveillé par une vraie action,
  // activité récente. Au repos on le coupe, pour que le serveur puisse s'endormir (et ne consomme pas d'heures gratuites).
  const REPOS_MS = 10 * 60 * 1000;
  let derniereActivite = Date.now();
  let minuteurRepos = null;
  const appareilActif = () => document.visibilityState === 'visible' && Date.now() - derniereActivite < REPOS_MS;
  function surActivite() {
    const etaitAuRepos = !appareilActif();
    derniereActivite = Date.now();
    if (etaitAuRepos && state.user && !tempsReel) ouvrirTempsReel();
    clearTimeout(minuteurRepos);
    minuteurRepos = setTimeout(() => { if (!appareilActif()) fermerTempsReel(); }, REPOS_MS + 1000);
  }
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, surActivite, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(minuteurRepos); minuteurRepos = setTimeout(() => { if (!appareilActif()) fermerTempsReel(); }, 60000); }
  });

  function ouvrirTempsReel() {
    if (tempsReel || !window.BQWS || state.horsLigne || !state.user || !R.estPret() || !appareilActif()) return;
    tempsReel = window.BQWS.connecter({
      peutOuvrir: () => R.estPret() && appareilActif(),
      jeton: () => state.token,
      surEtat: (ouvert) => { if (ouvert) document.body.dataset.tempsReel = 'ouvert'; else delete document.body.dataset.tempsReel; },
      surEvenement: surEvenementTempsReel,
    });
  }

  function fermerTempsReel() {
    clearTimeout(minuteurMaj);
    if (tempsReel) tempsReel.fermer();
    tempsReel = null;
    delete document.body.dataset.tempsReel;
  }

  function proposerActualisation() {
    const vue = document.getElementById('vue');
    if (!vue || document.getElementById('bandeau-maj')) return;
    vue.prepend(h('div', { class: 'bandeau', id: 'bandeau-maj', role: 'status' },
      h('span', {}, 'Des données ont changé sur un autre appareil.'),
      h('button', { class: 'btn', type: 'button', onclick: router }, 'Actualiser')));
  }

  function surEvenementTempsReel(ev) {
    if (!state.user || state.horsLigne) return;
    const vue = vueCourante();
    if (ev.type === 'abonnement.change') {
      const avait = Boolean(state.abonnement);
      chargerSession().then(() => {
        majPastille();
        if (!avait || ['tableau', 'abonnement'].includes(vue)) router();
      }).catch(() => {});
      return;
    }
    if (ev.par === state.user.id) return; // cet appareil est déjà à jour
    if (ev.type === 'tableau.remis' && vue === 'tableau') router();
    if (ev.type === 'inventaire.change' && ev.par !== state.user.id && vue === 'inventaire' && !(document.activeElement && document.activeElement.matches('input, textarea'))) router();
    if (ev.type === 'vente.creee' && estProprio() && vue !== 'caisse') toast(`Nouvelle vente n°${ev.numero} : ${fcfa(ev.total)}`);
    if (vue === 'tableau') {
      clearTimeout(minuteurMaj);
      minuteurMaj = setTimeout(() => {
        if (vueCourante() !== 'tableau' || document.querySelector('dialog[open]')) return;
        // Actualisation silencieuse : pas de nouvelle animation d'entrée des chiffres
        document.body.classList.add('sans-anim');
        Promise.resolve(router()).finally(() => setTimeout(() => document.body.classList.remove('sans-anim'), 80));
      }, 600);
    } else if (['ventes', 'produits', 'stock'].includes(vue)) {
      proposerActualisation();
    }
  }

  // ---------- Hors connexion : stockage, file des ventes, synchronisation ----------
  const HORS_LIGNE_OK = ['caisse', 'ventes'];
  const cleHL = (suffixe) => `${SLUG}:${suffixe}`;
  const cleFile = () => cleHL(`u${state.user.id}:file`);
  const cleJournal = () => cleHL(`u${state.user.id}:journal`);
  const synchro = { enCours: false, minuteur: null };
  const pad2 = (n) => String(n).padStart(2, '0');

  // Heure locale de l'appareil au format des factures (AAAA-MM-JJ HH:MM)
  function heureLocale(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const aujourdhuiLocal = () => heureLocale(new Date()).slice(0, 10);

  const lireFile = async () => (state.user ? (await HL.get(cleFile())) || [] : []);

  // Modification de la file sous verrou : plusieurs onglets ne peuvent pas s'écraser mutuellement
  const modifierFile = (fn) => HL.verrou(`bq-file-${SLUG}-${state.user.id}`, async () => {
    const actuelle = (await HL.get(cleFile())) || [];
    const neuve = fn(actuelle);
    await HL.set(cleFile(), neuve);
    return neuve;
  });

  async function noterEnvoyees(lignes) {
    const journal = (await HL.get(cleJournal())) || [];
    // la plus récente en premier (les lignes arrivent de la plus ancienne à la plus récente)
    await HL.set(cleJournal(), [...[...lignes].reverse().map((l) => ({ ...l, le: Date.now() })), ...journal].slice(0, 20));
  }

  // Liste des produits : celle du serveur si possible (et copie sur l'appareil), sinon la dernière copie
  async function chargerProduitsCaisse({ rapide = false } = {}) {
    if (rapide && !R.estPret()) {
      // Serveur pas encore sollicité (ou peut-être endormi) : la caisse s'ouvre tout de suite sur la dernière copie, la mise à jour se fait derrière
      const copie = await HL.get(cleHL('produits')).catch(() => null);
      if (copie) return { liste: copie.liste, depuisCache: true, le: copie.le, rafraichir: true };
    }
    try {
      const liste = await api('/produits');
      // le prix d'achat n'est jamais conservé sur l'appareil
      await HL.set(cleHL('produits'), { le: Date.now(), liste: liste.map(({ prix_achat, ...p }) => p) });
      return { liste, depuisCache: false, le: Date.now() };
    } catch (e) {
      if (!e.hors_ligne) throw e;
      const copie = await HL.get(cleHL('produits'));
      if (!copie) throw new Error('Aucune liste de produits n\'est enregistrée sur cet appareil. Ouvrez la caisse une première fois avec internet.');
      return { liste: copie.liste, depuisCache: true, le: copie.le };
    }
  }

  // Indique si le réseau répond (appelé par api() à chaque échange)
  function marquerReseau(enLigne) {
    if (state.horsLigne === !enLigne) return;
    state.horsLigne = !enLigne;
    majEtatReseau();
    if (enLigne) {
      synchro.echecs = 0;
      planifierSync(800);
      ouvrirTempsReel();
      if (state.demarreLocal) revalider(); // ouverte depuis la copie de l'appareil : on remet la session et les données à jour
      if (document.querySelector('[data-indispo]')) router(); // la page « disponible avec internet » devient accessible
    }
  }

  // Après un démarrage sans serveur : session, configuration et produits sont rafraîchis dès que le serveur répond
  function revalider() {
    state.demarreLocal = false;
    chargerSession().then(() => {
      majPastille();
      if (vueCourante() !== 'caisse') router(); // jamais en pleine saisie d'un ticket
    }).catch(() => {});
    api('/config').then((c) => { state.config = c; }).catch(() => {});
    chargerProduitsCaisse().catch(() => {});
  }

  async function majEtatReseau() {
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('indispo', state.horsLigne && !HORS_LIGNE_OK.includes(a.dataset.route)));
    const p = document.getElementById('pastille-reseau');
    if (!p || !state.user) return;
    const file = await lireFile();
    const attente = file.filter((v) => v.statut === 'en_attente').length;
    const refusees = file.length - attente;
    const s = (n) => (n > 1 ? 's' : '');
    const court = window.matchMedia('(max-width: 52rem)').matches; // petit écran : texte réduit pour laisser la place au nom
    let texte = '';
    let complet = '';
    if (synchro.enCours) texte = complet = 'Envoi des ventes…';
    else if (state.horsLigne && R.etat().serveur === 'reveil') {
      complet = attente ? `Serveur en réveil · ${attente} vente${s(attente)} à envoyer` : 'Serveur en réveil…';
      texte = court ? (attente ? `Réveil · ${attente}` : 'Réveil…') : complet;
    } else if (state.horsLigne) {
      complet = attente ? `Hors connexion · ${attente} vente${s(attente)} à envoyer` : 'Hors connexion';
      texte = court ? (attente ? `Hors ligne · ${attente}` : 'Hors ligne') : complet;
    } else if (attente) {
      complet = `${attente} vente${s(attente)} à envoyer`;
      texte = court ? `${attente} à envoyer` : complet;
    } else if (refusees) {
      complet = `${refusees} vente${s(refusees)} refusée${s(refusees)}`;
      texte = court ? `${refusees} refusée${s(refusees)}` : complet;
    }
    p.hidden = !texte;
    p.textContent = texte;
    p.title = complet;
    p.classList.toggle('alerte', state.horsLigne || (!attente && refusees > 0));
    document.body.classList.toggle('reseau-actif', Boolean(texte));
  }

  function planifierSync(delai) {
    clearTimeout(synchro.minuteur);
    synchro.minuteur = setTimeout(() => synchroniser(), delai);
  }

  // Envoie les ventes en attente au serveur. Chaque vente porte son identifiant : un renvoi ne crée jamais de doublon.
  async function synchroniser({ manuel = false } = {}) {
    if (synchro.enCours || !state.user || !state.token) return;
    const file = await lireFile();
    if (!file.some((v) => v.statut === 'en_attente')) { if (manuel) toast('Aucune vente à envoyer.'); return; }
    synchro.enCours = true;
    majEtatReseau();
    let arret = null;
    let resultats = [];
    try {
      const envoyer = (v) => api('/ventes', { method: 'POST', body: {
        cle: v.cle, hors_ligne: true, cree_le: v.cree_le, mode_paiement: v.mode_paiement,
        client_nom: v.client_nom, client_telephone: v.client_telephone, acompte: v.acompte || 0, echeance: v.echeance || null,
        lignes: v.lignes.map((l) => ({ produit_id: l.produit_id, quantite: l.quantite, prix_unitaire: l.prix_unitaire })),
      } });
      ({ resultats, arret } = await BQ.synchroniserFile(file, envoyer));
      if (resultats.length) {
        const parCle = new Map(file.map((v) => [v.cle, v]));
        const issue = new Map(resultats.map((r) => [r.cle, r]));
        await modifierFile((f) => f
          .filter((v) => !(issue.get(v.cle) && issue.get(v.cle).issue === 'envoyee'))
          .map((v) => (issue.get(v.cle) && issue.get(v.cle).issue === 'refusee' ? { ...v, statut: 'refusee', raison: issue.get(v.cle).raison } : v)));
        const envoyees = resultats.filter((r) => r.issue === 'envoyee');
        const refusees = resultats.filter((r) => r.issue === 'refusee');
        if (envoyees.length) {
          await noterEnvoyees(envoyees.map((r) => ({ provisoire: parCle.get(r.cle).numero_prov, numero: r.numero, total: parCle.get(r.cle).total, anomalie: r.anomalie })));
          const aVerifier = envoyees.filter((r) => r.anomalie).length;
          toast(`${envoyees.length} vente${envoyees.length > 1 ? 's' : ''} envoyée${envoyees.length > 1 ? 's' : ''}${aVerifier ? ` (dont ${aVerifier} à vérifier par le propriétaire)` : ''}.`);
        }
        if (refusees.length) toast(`${refusees.length} vente${refusees.length > 1 ? 's' : ''} refusée${refusees.length > 1 ? 's' : ''} : voir la page Ventes.`, 'erreur');
      }
    } catch { /* api() a déjà traité l'erreur (session, abonnement, réseau) */ } finally {
      synchro.enCours = false;
      majEtatReseau();
    }
    if (arret === 'abonnement') toast('Abonnement expiré : renouvelez-le pour envoyer les ventes en attente.', 'erreur');
    if (resultats.some((r) => r.issue === 'envoyee')) synchro.echecs = 0;
    if (arret === 'reseau' || arret === 'reessayer') {
      synchro.echecs += 1;
      // Le serveur vient de répondre à la sonde de réveil (coupure brève) : on reprend tout de suite, trois fois au plus ;
      // sinon attentes croissantes : 30 s, 1 min, 2 min, 4 min, puis 5 min
      planifierSync(R.estPret() && synchro.echecs <= 3 ? 1500 : Math.min(300000, 15000 * 2 ** Math.min(synchro.echecs, 5)));
    }
    if (resultats.some((r) => r.issue === 'envoyee')) {
      chargerProduitsCaisse().catch(() => {});
      if (location.hash === '#/ventes') router();
    }
  }

  async function deconnexionDemandee() {
    const f = await lireFile();
    const n = f.filter((v) => v.statut === 'en_attente').length;
    if (n && !confirm(`${n} vente${n > 1 ? 's' : ''} n'${n > 1 ? 'ont' : 'a'} pas encore été envoyée${n > 1 ? 's' : ''}. Elles restent sur cet appareil et partiront à votre prochaine connexion. Se déconnecter ?`)) return;
    deconnecter();
  }

  // ---------- Écran de connexion ----------
  async function afficherConnexion() {
    // Aucun appel serveur pour afficher cet écran : nom, couleur et logo viennent de l'appareil (ou du modèle de la page)
    const info = lireMarque() || { nom_app: document.body.dataset.nom || 'Best-Quinca' };
    const erreur = h('p', { class: 'erreur', role: 'alert' });
    const mail = h('input', { type: 'email', required: true, autocomplete: 'username', name: 'email' });
    const pwd = h('input', { type: 'password', required: true, autocomplete: 'current-password', name: 'mot_de_passe' });
    const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Se connecter');
    const form = h('form', { class: 'carte connexion', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        erreur.textContent = '';
        btn.disabled = true;
        try {
          await serveurRequis();
          const r = await api('/auth/login', { method: 'POST', body: { slug: SLUG, email: mail.value, mot_de_passe: pwd.value } });
          state.token = r.token;
          localStorage.setItem(TOKEN_KEY, r.token);
          await demarrer();
        } catch (err) {
          erreur.textContent = err.message;
          btn.disabled = false;
        }
      } },
      info.a_logo && h('img', { class: 'logo-grand', src: `${R.url(`/app/${SLUG}/logo`)}?v=${info.logo_v || 0}`, alt: '' }),
      h('h1', {}, info.nom_app),
      h('p', { class: 'aide' }, 'Connectez-vous pour ouvrir votre caisse.'),
      champ('Adresse e-mail', mail),
      champ('Mot de passe', pwd),
      erreur,
      btn,
      h('button', { class: 'lien-btn', type: 'button', onclick: afficherRecuperation }, 'Mot de passe oublié ?'));
    root.replaceChildren(h('main', { class: 'centre' }, form,
      h('p', { class: 'aide centre-txt' }, h('a', { href: '/' }, h('img', { class: 'logo-pied-app', src: '/assets/marque/best-quinca.png', alt: 'Best-Quinca Hardware' }), 'Best-Quinca'), ' — créer un autre espace')));
  }

  // ---------- Récupération du mot de passe ----------
  function copier(texte, message = 'Copié.') {
    if (navigator.clipboard) navigator.clipboard.writeText(texte).then(() => toast(message), () => toast('Copie impossible : recopiez-le à la main.', 'erreur'));
    else toast('Copie impossible : recopiez-le à la main.', 'erreur');
  }

  function telecharger(nomFichier, texte) {
    const a = h('a', { href: URL.createObjectURL(new Blob([texte], { type: 'text/plain;charset=utf-8' })), download: nomFichier });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function blocCode(code) {
    return h('div', {},
      h('p', { class: 'code-box', 'aria-label': 'Code de récupération' }, code),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => copier(code, 'Code copié.') }, 'Copier'),
        h('button', { class: 'btn', type: 'button', onclick: () => telecharger(`code-recuperation-${SLUG}.txt`, `Code de récupération de ${SLUG} :\r\n${code}\r\nGardez-le en lieu sûr : il permet de choisir un nouveau mot de passe.\r\n`) }, 'Télécharger')));
  }

  function afficherCodeRecuperation(code, suite) {
    const ok = h('input', { type: 'checkbox' });
    const go = h('button', { class: 'btn primaire', type: 'button', disabled: true, onclick: suite }, 'Continuer');
    ok.addEventListener('change', () => { go.disabled = !ok.checked; });
    root.replaceChildren(h('main', { class: 'centre' }, h('section', { class: 'carte connexion' },
      h('h1', {}, 'Votre code de récupération'),
      h('p', {}, 'Si vous oubliez votre mot de passe, ce code vous permettra d\'en choisir un nouveau. Il ne sera plus jamais affiché : notez-le ou téléchargez-le maintenant.'),
      blocCode(code),
      h('label', { class: 'case' }, ok, 'J\'ai noté ce code en lieu sûr'),
      go)));
  }

  function afficherRecuperation() {
    const mail = h('input', { type: 'email', required: true, autocomplete: 'username' });
    const code = h('input', { required: true, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX' });
    const pwd = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
    const erreur = h('p', { class: 'erreur', role: 'alert' });
    const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Choisir un nouveau mot de passe');
    root.replaceChildren(h('main', { class: 'centre' },
      h('form', { class: 'carte connexion', novalidate: true, onsubmit: async (e) => {
        e.preventDefault();
        erreur.textContent = '';
        btn.disabled = true;
        try {
          await serveurRequis();
          const r = await api('/auth/recuperer', { method: 'POST', body: { slug: SLUG, email: mail.value, code: code.value, nouveau: pwd.value } });
          state.token = r.token;
          localStorage.setItem(TOKEN_KEY, r.token);
          afficherCodeRecuperation(r.code_recuperation, demarrer);
        } catch (err) { erreur.textContent = err.message; btn.disabled = false; }
      } },
        h('h1', {}, 'Mot de passe oublié'),
        h('p', { class: 'aide' }, 'Propriétaire : saisissez votre e-mail et le code de récupération reçu à la création de l\'espace.'),
        champ('Adresse e-mail', mail),
        champ('Code de récupération', code),
        champ('Nouveau mot de passe (8 caractères minimum)', pwd),
        erreur, btn),
      h('p', { class: 'aide centre-txt' }, 'Secrétaire : demandez à votre propriétaire de vous donner un nouveau mot de passe (page Équipe).', h('br'),
        'Code perdu ? Contactez l\'administrateur de la plateforme.'),
      h('button', { class: 'lien-btn', type: 'button', onclick: afficherConnexion }, '← Retour à la connexion')));
  }

  // Mot de passe provisoire (posé par le propriétaire ou l'administrateur) : à remplacer avant tout
  function afficherChangementObligatoire() {
    const ancien = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
    const nouveau = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
    const erreur = h('p', { class: 'erreur', role: 'alert' });
    const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Enregistrer et continuer');
    root.replaceChildren(h('main', { class: 'centre' }, h('form', { class: 'carte connexion', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      erreur.textContent = '';
      btn.disabled = true;
      try {
        const r = await api('/auth/mot-de-passe', { method: 'POST', body: { ancien: ancien.value, nouveau: nouveau.value } });
        state.token = r.token;
        localStorage.setItem(TOKEN_KEY, r.token);
        await demarrer();
      } catch (err) { erreur.textContent = err.message; btn.disabled = false; }
    } },
      h('h1', {}, 'Choisissez votre mot de passe'),
      h('p', {}, 'Votre mot de passe actuel est provisoire. Choisissez-en un que vous seul connaissez.'),
      champ('Mot de passe provisoire', ancien),
      champ('Nouveau mot de passe (8 caractères minimum)', nouveau),
      erreur, btn,
      h('button', { class: 'lien-btn', type: 'button', onclick: deconnecter }, 'Se déconnecter'))));
  }

  // ---------- Coque de l'application ----------
  const MENU = [
    { id: 'tableau', titre: 'Tableau de bord' },
    { id: 'caisse', titre: 'Caisse' },
    { id: 'produits', titre: 'Produits' },
    { id: 'stock', titre: 'Stock' },
    { id: 'inventaire', titre: 'Inventaire' },
    { id: 'ventes', titre: 'Ventes' },
    { id: 'credits', titre: 'Crédits' },
    { id: 'bilans', titre: 'Bilans', proprio: true },
    { id: 'partenaires', titre: 'Partenaires' },
    { id: 'equipe', titre: 'Équipe', proprio: true },
    { id: 'abonnement', titre: 'Abonnement', proprio: true },
    { id: 'profil', titre: 'Profil', proprio: true },
    { id: 'reglages', titre: 'Réglages' },
  ];

  function afficherCoque() {
    const nav = h('nav', { class: 'nav', id: 'nav', 'aria-label': 'Navigation principale' },
      MENU.filter((m) => !m.proprio || estProprio()).map((m) =>
        h('a', { href: `#/${m.id}`, 'data-route': m.id, onclick: () => nav.classList.remove('ouvert') }, window.icone ? window.icone(m.id) : null, h('span', {}, m.titre))),
      h('div', { class: 'nav-bas' },
        h('button', { class: 'btn', type: 'button', 'data-installer': true, hidden: !state.installEvent || dejaInstallee(), onclick: lancerInstallation }, 'Installer l\'application'),
        h('p', { class: 'aide' }, state.user.nom_complet, h('br'), estProprio() ? 'Propriétaire' : 'Secrétaire'),
        h('button', { class: 'btn', type: 'button', onclick: deconnexionDemandee }, 'Se déconnecter')));
    const entete = h('header', { class: 'entete' },
      h('button', { class: 'btn-icone menu', type: 'button', 'aria-label': 'Menu', 'aria-controls': 'nav', onclick: () => nav.classList.toggle('ouvert') }, '☰'),
      state.entreprise.a_logo && h('img', { class: 'logo-mini', src: logoUrl(), alt: '' }),
      h('strong', { class: 'nom-app' }, state.entreprise.nom_app),
      h('button', { class: 'pastille reseau', id: 'pastille-reseau', type: 'button', hidden: true, onclick: () => { location.hash = '#/ventes'; } }),
      h('span', { class: 'pastille', id: 'pastille-abo' }));
    root.replaceChildren(h('div', { class: 'app' }, entete, nav, h('main', { class: 'vue', id: 'vue', tabindex: '-1' })));
    majPastille();
    majEtatReseau();
  }

  function majPastille() {
    const p = document.getElementById('pastille-abo');
    if (!p) return;
    if (state.abonnement) {
      const court = window.matchMedia('(max-width: 52rem)').matches;
      const [y, m, d] = state.abonnement.date_fin.split('-');
      p.textContent = court ? `Jusqu'au ${d}/${m}/${y.slice(2)}` : `Abonné jusqu'au ${dateFr(state.abonnement.date_fin)}`;
      p.title = `Abonné jusqu'au ${dateFr(state.abonnement.date_fin)}`;
      p.className = 'pastille';
    }
    else { p.textContent = 'Abonnement inactif'; p.className = 'pastille alerte'; }
  }

  const VUES = {};

  async function router() {
    const vue = document.getElementById('vue');
    if (!vue) return;
    let nom = (location.hash.replace(/^#\/?/, '') || (state.horsLigne ? 'caisse' : 'tableau')).split('?')[0];
    if (!VUES[nom] || (MENU.find((m) => m.id === nom) || {}).proprio && !estProprio()) nom = 'tableau';
    // Sans réseau : seules la caisse et les ventes fonctionnent
    if (state.horsLigne) {
      document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('actif', a.dataset.route === nom));
      if (!HORS_LIGNE_OK.includes(nom)) {
        const enReveil = R.etat().serveur === 'reveil';
        remplacer(vue, h('section', { class: 'carte', 'data-indispo': true },
          h('h1', {}, enReveil ? 'Le serveur se réveille' : 'Disponible avec internet'),
          h('p', {}, enReveil
            ? 'Cette page s\'ouvrira toute seule dès que le serveur sera prêt (en général moins d\'une minute). En attendant, la caisse et les ventes restent utilisables.'
            : 'Cette page a besoin de la connexion. En attendant, la caisse et les ventes en attente restent utilisables.'),
          h('div', { class: 'actions' }, h('a', { class: 'btn primaire', href: '#/caisse' }, 'Ouvrir la caisse'), h('button', { class: 'btn', type: 'button', onclick: reessayerServeur }, 'Réessayer'))));
        return;
      }
      if (!state.abonnement) {
        remplacer(vue, h('section', { class: 'carte', 'data-indispo': true },
          h('h1', {}, 'Abonnement expiré'),
          h('p', {}, 'D\'après la date de cet appareil, l\'abonnement est terminé. Reconnectez-vous à internet pour le renouveler : vos ventes en attente seront alors envoyées.')));
        return;
      }
    }
    // Sans abonnement actif : seul l'espace abonnement (propriétaire) ou les réglages sont accessibles
    if (!state.abonnement && !['abonnement', 'reglages', 'profil', 'bienvenue'].includes(nom)) {
      if (estProprio()) { location.hash = '#/abonnement'; return; }
      remplacer(vue, h('section', { class: 'carte' },
        h('h1', {}, 'Abonnement inactif'),
        h('p', {}, 'L\'abonnement de l\'entreprise est expiré. Demandez au propriétaire de le renouveler pour reprendre les ventes.')));
      return;
    }
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('actif', a.dataset.route === nom));
    remplacer(vue, h('p', { class: 'chargement' }, 'Chargement…'));
    const indice = setTimeout(() => {
      const p = vue.querySelector('.chargement');
      if (p && !R.estPret()) p.textContent = 'Le serveur démarre, cela peut prendre une minute…';
    }, 3000);
    try {
      await VUES[nom](vue);
    } catch (e) {
      if (e.status === 401 || e.code === 'ABONNEMENT_REQUIS') return;
      if (e.hors_ligne && state.horsLigne && !HORS_LIGNE_OK.includes(nom)) return router(); // carte « disponible avec internet / serveur en réveil »
      remplacer(vue, h('section', { class: 'carte' },
        h('h1', {}, 'Impossible d\'afficher cette page'),
        h('p', {}, e.message),
        h('button', { class: 'btn', type: 'button', onclick: router }, 'Réessayer')));
    } finally {
      clearTimeout(indice);
    }
  }

  // « Réessayer » : un seul réveil partagé ; la page s'ouvre dès que le serveur répond
  async function reessayerServeur() {
    if (R.enLigne() && await R.reveiller({ avecEcran: false })) marquerReseau(true);
    router();
  }

  // ---------- Bienvenue (après création de l'espace) ----------
  VUES.bienvenue = async (vue) => {
    const suite = state.abonnement
      ? h('a', { class: 'btn primaire', href: '#/produits' }, 'Ajouter mes premiers produits')
      : h('a', { class: 'btn primaire', href: '#/abonnement' }, `Activer l'abonnement — ${fcfa(state.config ? state.config.prix : 3000)}`);
    const cleCode = `bq:${SLUG}:code`;
    const codeNouveau = sessionStorage.getItem(cleCode);
    const blocCodeNouveau = codeNouveau && h('section', { class: 'carte attention' },
      h('h2', {}, 'Votre code de récupération'),
      h('p', {}, 'Si vous oubliez votre mot de passe, ce code vous permettra d\'en choisir un nouveau. Il n\'est affiché qu\'ici : notez-le ou téléchargez-le maintenant.'),
      blocCode(codeNouveau),
      h('button', { class: 'btn primaire', type: 'button', onclick: (e) => { sessionStorage.removeItem(cleCode); e.currentTarget.closest('section').remove(); } }, 'J\'ai noté mon code'));
    remplacer(vue, blocCodeNouveau, h('section', { class: 'carte' },
      h('h1', {}, `Bienvenue, ${state.user.nom_complet.split(' ')[0]}`),
      h('p', {}, `L'espace de « ${state.entreprise.nom} » est créé. Cette application est la vôtre : installez-la pour l'ouvrir comme n'importe quelle autre application, sur ce téléphone ou cet ordinateur.`),
      blocInstallation(),
      h('hr'),
      h('p', {}, 'Ensuite :'),
      suite));
  };

  // ---------- Tableau de bord ----------
  VUES.tableau = async (vue) => {
    const d = await api('/tableau-de-bord');
    const jours = [];
    const parJour = new Map(d.sept_jours.map((j) => [j.jour, j.total]));
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      const cle = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      jours.push({ cle, etiquette: dt.toLocaleDateString('fr-FR', { weekday: 'short' }), total: parJour.get(cle) || 0 });
    }
    const max = Math.max(1, ...jours.map((j) => j.total));
    const carte = (titre, valeur, detail, alerte) => h('div', { class: 'stat' + (alerte ? ' alerte' : '') },
      h('span', { class: 'stat-titre' }, titre), h('strong', { class: 'stat-valeur' }, typeof valeur === 'string' ? avecUnite(valeur) : valeur), detail && h('span', { class: 'stat-detail' }, detail));

    remplacer(vue, 
      h('h1', {}, 'Tableau de bord'),
      !dejaInstallee() && h('div', { class: 'bandeau', 'data-installer': true, hidden: !state.installEvent },
        h('span', {}, `Installez « ${state.entreprise.nom_app} » sur cet appareil.`),
        h('button', { class: 'btn', type: 'button', onclick: lancerInstallation }, 'Installer')),
      d.remise_a_zero && h('p', { class: 'aide remise-note' }, `Statistiques comptées depuis le ${dateFr(String(d.remise_a_zero.depuis).slice(0, 10))} (remise à zéro par ${d.remise_a_zero.par}${d.remise_a_zero.note ? ` — ${d.remise_a_zero.note}` : ''}).`),
      h('div', { class: 'stats vedette' },
        carte('Ventes du jour', fcfa(d.aujourdhui.total), `${d.aujourdhui.nb} vente(s)`),
        carte('Ventes du mois', fcfa(d.mois.total), `${d.mois.nb} vente(s)`),
        carte('Stock à renouveler', nombre(d.stock_faible), d.stock_faible ? 'produit(s) sous le seuil' : 'Tout est approvisionné', d.stock_faible > 0),
        d.credits_en_cours && d.credits_en_cours.nb > 0 && carte('Crédits clients à encaisser', fcfa(d.credits_en_cours.total), `${d.credits_en_cours.nb} vente(s) non soldée(s) : voir Crédits`, true),
        d.rembourse_mois && d.rembourse_mois.nb > 0 && carte('Remboursé ce mois', fcfa(d.rembourse_mois.total), `${d.rembourse_mois.nb} remboursement(s)`),
        d.a_verifier > 0 && carte('Ventes à vérifier', nombre(d.a_verifier), 'écart de prix ou de stock : voir Ventes', true),
        d.valeur_stock !== null && carte('Valeur du stock', fcfa(d.valeur_stock), 'au prix d\'achat')),
      h('div', { class: 'deux-col' },
        h('section', { class: 'carte' }, h('h2', {}, '7 derniers jours'),
          h('div', { class: 'barres' }, jours.map((j) =>
            h('div', { class: 'barre', title: `${j.etiquette} : ${fcfa(j.total)}` },
              h('span', { class: 'barre-fut', style: `height:${Math.round((j.total / max) * 100)}%` }),
              h('span', { class: 'barre-lib' }, j.etiquette))))),
        h('section', { class: 'carte' }, h('h2', {}, 'Produits les plus vendus ce mois'),
          d.top_produits.length
            ? h('ol', { class: 'liste' }, d.top_produits.map((t) => h('li', {}, h('span', {}, t.nom_produit), h('span', { class: 'num' }, `${nombre(t.quantite)} · ${fcfa(t.total)}`))))
            : h('p', { class: 'aide' }, 'Aucune vente ce mois-ci pour le moment.'))),
      d.produits_faibles.length > 0 && h('section', { class: 'carte' }, h('h2', {}, 'À réapprovisionner'),
        h('ul', { class: 'liste' }, d.produits_faibles.map((p) =>
          h('li', {}, h('span', {}, p.nom), h('span', { class: 'num bas' }, `${nombre(p.quantite_stock)} ${p.unite} (seuil ${p.seuil_alerte})`)))),
        h('a', { class: 'btn', href: '#/stock' }, 'Enregistrer une entrée de stock')),
      estProprio() && h('section', { class: 'carte' },
        h('h2', {}, 'Bilan des ventes'),
        h('p', { class: 'aide' }, 'Faites le bilan de la journée, de la semaine ou du mois : chiffre d\'affaires, argent encaissé, crédits, produits les plus vendus. Téléchargez la fiche en PDF.'),
        h('a', { class: 'btn primaire', href: '#/bilans' }, 'Faire le bilan du jour')),
      estProprio() && h('section', { class: 'carte fin-inventaire' },
        h('h2', {}, 'Fin d\'inventaire'),
        h('p', { class: 'aide' }, 'Comptez le stock avec votre secrétaire dans la page Inventaire : en validant, vous pouvez remettre le tableau de bord à zéro pour repartir sur une période propre. Vos ventes, vos crédits clients et votre stock ne sont jamais supprimés.'),
        h('div', { class: 'actions' },
          h('a', { class: 'btn primaire', href: '#/inventaire' }, 'Ouvrir l\'inventaire'),
          h('button', { class: 'btn', type: 'button', onclick: () => remiseAZero() }, 'Remettre le tableau de bord à zéro'))));
    afficherBanniere(vue);
  };

  function remiseAZero() {
    const note = h('input', { maxlength: 255, placeholder: 'Ex. : inventaire de fin d\'octobre' });
    const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Remettre à zéro');
    const d = modale('Remettre le tableau de bord à zéro', h('form', { novalidate: true, onsubmit: (ev) => {
      ev.preventDefault();
      agir(btn, async () => {
        await api('/tableau-de-bord/remise-a-zero', { method: 'POST', body: { note: note.value } });
        d.close();
        toast('Tableau de bord remis à zéro.');
        router();
      });
    } },
    h('p', {}, 'Les ventes du jour et du mois, le graphique des 7 jours, les produits les plus vendus et les remboursements du mois repartent de zéro.'),
    h('p', { class: 'aide' }, 'Rien n\'est supprimé : l\'historique des ventes, les crédits clients et le stock restent intacts. Vérifiez que les ajustements de stock de l\'inventaire sont bien enregistrés avant de continuer.'),
    champ('Note (facultatif)', note), btn));
  }

  // Suppression définitive de l'espace (droit des utilisateurs, exigé par Google Play)
  function zoneSuppression() {
    const slug = h('input', { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: SLUG });
    const mdp = h('input', { type: 'password', autocomplete: 'current-password' });
    const btn = h('button', { class: 'btn danger', type: 'submit' }, 'Supprimer définitivement');
    function ouvrir() {
      const d = modale('Supprimer mon espace', h('form', { novalidate: true, onsubmit: (ev) => {
        ev.preventDefault();
        agir(btn, async () => {
          await api('/entreprise/suppression', { method: 'POST', body: { mot_de_passe: mdp.value, confirmation: slug.value.trim() } });
          try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem('bq:dernier-espace'); } catch { /* ignoré */ }
          d.close();
          location.replace('/?espace=supprime');
        });
      } },
      h('p', {}, h('strong', {}, 'Cette action est définitive.'), ' Votre espace, les comptes de votre équipe, les produits, le stock, les ventes, les factures, les crédits et les inventaires seront supprimés.'),
      h('p', { class: 'aide' }, 'Les liens de factures déjà envoyés à vos clients cesseront de fonctionner.'),
      champ(`Pour confirmer, saisissez l'identifiant de votre espace : ${SLUG}`, slug),
      champ('Votre mot de passe', mdp), btn));
    }
    return h('section', { class: 'carte zone-danger' },
      h('h2', {}, 'Supprimer mon espace'),
      h('p', { class: 'aide' }, 'Supprime définitivement votre quincaillerie et toutes ses données. Pensez à noter ce dont vous avez besoin avant de continuer.'),
      h('button', { class: 'btn danger', type: 'button', onclick: ouvrir }, 'Supprimer mon espace et toutes mes données'));
  }

  // Une offre de partenaire, clairement marquée « Sponsorisé », sous le titre du tableau de bord
  async function afficherBanniere(vue) {
    let r;
    try { r = await api('/partenaires/banniere'); } catch { return; }
    const o = r && r.offre;
    if (!o || !vue.isConnected || vueCourante() !== 'tableau' || vue.querySelector('.sponsor-offre')) return;
    const el = h('section', { class: 'carte sponsor-offre', 'aria-label': 'Offre d\'un partenaire' },
      o.a_logo && h('img', { class: 'sponsor-logo', src: `/partenaires/${o.sponsor_id}/logo?v=${o.logo_v || 0}`, alt: '' }),
      h('div', {},
        h('span', { class: 'puce' }, 'Sponsorisé'),
        h('strong', { class: 'bloc-pt' }, `${o.sponsor} — ${o.titre}`),
        o.texte && h('span', { class: 'aide' }, o.texte)),
      h('a', { class: 'btn', href: '#/partenaires', onclick: () => { api(`/partenaires/offres/${o.id}/clic`, { method: 'POST' }).catch(() => {}); } }, 'Voir l\'offre'));
    const h1 = vue.querySelector('h1');
    if (h1) h1.after(el);
  }

  // ---------- Facture (image) ----------
  const POLICE = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const logoUrl = () => `${R.url(`/app/${SLUG}/logo`)}?v=${state.entreprise.logo_v || 0}`;

  function chargerImage(src) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  const versBlob = (canvas, type, qualite) => new Promise((resolve) => canvas.toBlob(resolve, type, qualite));

  async function jpegSous(canvas, maxOctets) {
    let q = 0.92;
    let b = await versBlob(canvas, 'image/jpeg', q);
    while (b.size > maxOctets && q > 0.45) { q -= 0.1; b = await versBlob(canvas, 'image/jpeg', q); }
    return b;
  }

  const base64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Image illisible.'));
    r.readAsDataURL(blob);
  });

  // Découpe un texte en lignes qui tiennent dans `largeur` (coupe aussi les mots trop longs)
  function lignesTexte(g, texte, largeur) {
    const lignes = [];
    let cur = '';
    const pousser = (mot) => {
      const essai = cur ? `${cur} ${mot}` : mot;
      if (g.measureText(essai).width <= largeur) { cur = essai; return; }
      if (cur) { lignes.push(cur); cur = ''; }
      if (g.measureText(mot).width <= largeur) { cur = mot; return; }
      let morceau = '';
      for (const ch of mot) {
        if (g.measureText(morceau + ch).width > largeur && morceau) { lignes.push(morceau); morceau = ''; }
        morceau += ch;
      }
      cur = morceau;
    };
    String(texte).split(/\s+/).filter(Boolean).forEach(pousser);
    if (cur) lignes.push(cur);
    return lignes;
  }

  // Dessine la facture complète : identité de l'entreprise, client, détail des lignes, total, mode de paiement
  async function dessinerFacture(v) {
    const e = state.entreprise;
    const logo = e.a_logo ? await chargerImage(logoUrl()) : null;
    const W = 560, S = 2, M = 28, HMAX = 4000;
    const marque = /^#[0-9a-fA-F]{6}$/.test(e.couleur) ? e.couleur : '#3E5C76';
    const c = document.createElement('canvas');
    c.width = W * S; c.height = HMAX * S;
    const g = c.getContext('2d');
    g.scale(S, S);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, HMAX);
    g.textBaseline = 'top';
    g.fillStyle = marque; g.fillRect(0, 0, W, 10);

    // Identité
    let y = 10 + M, x = M, hLogo = 0;
    if (logo) {
      const r = Math.min(120 / logo.naturalWidth, 76 / logo.naturalHeight);
      const lw = logo.naturalWidth * r;
      hLogo = logo.naturalHeight * r;
      g.drawImage(logo, M, y, lw, hLogo);
      x = M + lw + 16;
    }
    const largeurId = W - M - x;
    let yy = y;
    g.fillStyle = '#1C2A33'; g.font = `700 20px ${POLICE}`;
    for (const l of lignesTexte(g, e.nom, largeurId)) { g.fillText(l, x, yy); yy += 25; }
    g.font = `400 13px ${POLICE}`; g.fillStyle = '#5B6B77';
    const infos = [
      [e.adresse, e.ville].filter(Boolean).join(', '),
      [e.telephone && `Tél. ${e.telephone}`, e.email].filter(Boolean).join('  ·  '),
      [e.ifu && `IFU ${e.ifu}`, e.rccm && `RCCM ${e.rccm}`].filter(Boolean).join('  ·  '),
      e.site_web,
    ].filter(Boolean);
    for (const t of infos) for (const l of lignesTexte(g, t, largeurId)) { g.fillText(l, x, yy); yy += 18; }
    y = Math.max(yy, y + hLogo) + 14;
    g.fillStyle = '#D3DAE0'; g.fillRect(M, y, W - 2 * M, 1);
    y += 18;

    // Titre, numéro, date
    g.fillStyle = marque; g.font = `800 28px ${POLICE}`; g.fillText(v.titre || 'FACTURE', M, y);
    g.textAlign = 'right';
    g.fillStyle = '#1C2A33'; g.font = `700 16px ${POLICE}`; g.fillText(`N° ${BQ.numeroFacture(v.numero)}`, W - M, y + 1);
    g.fillStyle = '#5B6B77'; g.font = `400 13px ${POLICE}`; g.fillText(v.cree_le || '', W - M, y + 23);
    g.textAlign = 'left';
    y += 54;

    // Client
    if (v.client_nom || v.client_telephone) {
      g.fillStyle = '#F2F5F7'; g.fillRect(M, y, W - 2 * M, 54);
      g.fillStyle = marque; g.fillRect(M, y, 4, 54);
      g.fillStyle = '#5B6B77'; g.font = `600 11px ${POLICE}`; g.fillText(v.titre ? 'CLIENT' : 'FACTURÉ À', M + 16, y + 9);
      g.fillStyle = '#1C2A33'; g.font = `700 15px ${POLICE}`;
      g.fillText([v.client_nom, v.client_telephone].filter(Boolean).join('  ·  '), M + 16, y + 27);
      y += 54 + 20;
    }

    // Tableau des lignes
    const xm = W - M - 10, xp = xm - 100, xq = xp - 92;
    const largeurDesignation = xq - 44 - (M + 10);
    g.fillStyle = `${marque}22`; g.fillRect(M, y, W - 2 * M, 30);
    g.fillStyle = marque; g.font = `700 11px ${POLICE}`;
    g.fillText('DÉSIGNATION', M + 10, y + 10);
    g.textAlign = 'right';
    g.fillText('QTÉ', xq, y + 10); g.fillText('PRIX UNIT.', xp, y + 10); g.fillText('MONTANT', xm, y + 10);
    g.textAlign = 'left';
    y += 30;
    g.font = `400 14px ${POLICE}`;
    for (const l of v.lignes) {
      const lg = lignesTexte(g, l.nom_produit, largeurDesignation);
      const hl = Math.max(1, lg.length) * 19 + 16;
      g.fillStyle = '#1C2A33';
      lg.forEach((t, k) => g.fillText(t, M + 10, y + 8 + k * 19));
      g.textAlign = 'right';
      g.fillText(BQ.nombre(l.quantite), xq, y + 8);
      g.fillText(BQ.nombre(l.prix_unitaire), xp, y + 8);
      g.font = `600 14px ${POLICE}`; g.fillText(BQ.nombre(l.sous_total), xm, y + 8); g.font = `400 14px ${POLICE}`;
      g.textAlign = 'left';
      y += hl;
      g.fillStyle = '#E5EAEE'; g.fillRect(M, y - 1, W - 2 * M, 1);
    }
    y += 16;

    // Total
    g.fillStyle = marque; g.fillRect(M, y, W - 2 * M, 54);
    g.fillStyle = '#fff'; g.font = `700 13px ${POLICE}`; g.fillText(v.etiquetteTotal || 'TOTAL À PAYER', M + 14, y + 20);
    g.textAlign = 'right'; g.font = `800 24px ${POLICE}`; g.fillText(BQ.fcfa(v.total), W - M - 14, y + 14);
    g.textAlign = 'left';
    y += 54 + 16;

    // Remboursements et crédit : la facture montre ce qui a été repris, ce qui est payé et ce qui reste dû
    const rembourse = Number(v.rembourse) || 0;
    const credit = v.mode_paiement === 'credit';
    const paye = v.montant_paye === undefined || v.montant_paye === null ? v.total : Number(v.montant_paye);
    const solde = credit ? Math.max(0, v.total - rembourse - paye) : 0;
    const ligneMontant = (libelle, valeur, couleur) => {
      g.fillStyle = couleur || '#1C2A33'; g.font = `600 14px ${POLICE}`;
      g.fillText(libelle, M, y); g.textAlign = 'right'; g.fillText(valeur, W - M, y); g.textAlign = 'left';
      y += 24;
    };
    if (rembourse > 0) { ligneMontant('Articles remboursés', `- ${BQ.fcfa(rembourse)}`, '#B4402A'); ligneMontant('Total net', BQ.fcfa(v.total - rembourse)); }
    if (credit) {
      ligneMontant('Déjà payé', BQ.fcfa(paye), '#117A52');
      g.fillStyle = solde > 0 ? '#F8E4DE' : '#DCF0E6'; g.fillRect(M, y - 6, W - 2 * M, 44);
      g.fillStyle = solde > 0 ? '#B4402A' : '#117A52'; g.font = `700 13px ${POLICE}`; g.fillText(solde > 0 ? 'RESTE À PAYER' : 'SOLDÉ', M + 14, y + 8);
      g.textAlign = 'right'; g.font = `800 20px ${POLICE}`; g.fillText(BQ.fcfa(solde), W - M - 14, y + 4); g.textAlign = 'left';
      y += 44 + 6;
      if (solde > 0 && v.echeance) { g.fillStyle = '#5B6B77'; g.font = `400 13px ${POLICE}`; g.fillText(`À régler avant le ${dateFr(v.echeance)}`, M, y); y += 22; }
    }

    g.fillStyle = '#5B6B77'; g.font = `400 13px ${POLICE}`;
    if (!v.titre) g.fillText(`Mode de paiement : ${MODES[v.mode_paiement] || v.mode_paiement || '—'}`, M, y);
    else for (const t of v.infos || []) for (const l of lignesTexte(g, t, W - 2 * M - 10)) { g.fillText(l, M, y); y += 19; }
    if (v.vendeur) { g.textAlign = 'right'; g.fillText(`${v.titre ? 'Traité par' : 'Servi par'} ${v.vendeur}`, W - M, y); g.textAlign = 'left'; }
    y += 34;

    // Bas de facture
    g.fillStyle = '#5B6B77'; g.font = `400 13px ${POLICE}`; g.textAlign = 'center';
    for (const l of lignesTexte(g, e.pied_facture || 'Merci pour votre confiance.', W - 2 * M - 20)) { g.fillText(l, W / 2, y); y += 19; }
    g.textAlign = 'left';
    y += M - 6;

    const out = document.createElement('canvas');
    out.width = W * S; out.height = Math.ceil(y * S);
    out.getContext('2d').drawImage(c, 0, 0, W * S, out.height, 0, 0, W * S, out.height);
    return out;
  }

  // Carte d'aperçu 1200×630 affichée par WhatsApp à côté du lien : entreprise, numéro, montant
  async function dessinerApercu(v) {
    const e = state.entreprise;
    const logo = e.a_logo ? await chargerImage(logoUrl()) : null;
    const W = 600, H = 315, S = 2;
    const marque = /^#[0-9a-fA-F]{6}$/.test(e.couleur) ? e.couleur : '#3E5C76';
    const c = document.createElement('canvas');
    c.width = W * S; c.height = H * S;
    const g = c.getContext('2d');
    g.scale(S, S);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = marque; g.fillRect(0, 0, 16, H);
    g.textBaseline = 'top';
    let x = 48;
    if (logo) {
      const r = Math.min(150 / logo.naturalWidth, 64 / logo.naturalHeight);
      g.drawImage(logo, 48, 34, logo.naturalWidth * r, logo.naturalHeight * r);
      x = 48 + logo.naturalWidth * r + 16;
    }
    g.fillStyle = '#1C2A33'; g.font = `700 22px ${POLICE}`;
    lignesTexte(g, e.nom, W - x - 32).slice(0, 2).forEach((l, k) => g.fillText(l, x, 40 + k * 28));
    g.fillStyle = marque; g.font = `700 15px ${POLICE}`;
    g.fillText(`FACTURE N° ${BQ.numeroFacture(v.numero)}`, 48, 128);
    g.fillStyle = '#1C2A33'; g.font = `800 46px ${POLICE}`;
    g.fillText(BQ.fcfa(v.total), 48, 156);
    g.fillStyle = '#5B6B77'; g.font = `400 16px ${POLICE}`;
    const n = v.lignes.length;
    g.fillText(`${n} article${n > 1 ? 's' : ''} · ${v.cree_le || ''}`, 48, 218);
    if (v.client_nom) g.fillText(`Pour : ${v.client_nom}`, 48, 242);
    g.fillStyle = marque; g.font = `600 14px ${POLICE}`;
    g.fillText('Touchez le lien pour voir le détail de votre facture', 48, 280);
    return c;
  }

  function telechargerBlob(blob, nom) {
    const a = h('a', { href: URL.createObjectURL(blob), download: nom });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function afficherFacture(v0) {
    const v = { ...v0 };
    const e = state.entreprise;
    let dlg = null;
    const num = BQ.numeroFacture(v.numero);
    // Recharge la vente après un règlement ou un remboursement et rouvre la facture à jour
    const rouvrir = async () => { const frais = await api(`/ventes/${v.id}`); if (dlg) dlg.close(); await afficherFacture(frais); };
    const canvas = await dessinerFacture(v);
    canvas.className = 'facture-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Facture n° ${num}, ${BQ.fcfa(v.total)}`);

    const rafraichir = async () => {
      const n = await dessinerFacture(v);
      canvas.width = n.width; canvas.height = n.height;
      canvas.getContext('2d').drawImage(n, 0, 0);
    };
    const nomClient = h('input', { maxlength: 150, value: v.client_nom || '', autocomplete: 'off', 'aria-label': 'Nom du client' });
    const tel = h('input', { type: 'tel', inputmode: 'tel', maxlength: 30, value: v.client_telephone || '', autocomplete: 'off',
      placeholder: `+${e.pays_indicatif || '229'} …`, 'aria-label': 'Numéro WhatsApp du client' });
    const retour = h('div', { 'aria-live': 'polite' });

    // Enregistre le client sur la vente s'il a changé, puis redessine la facture
    async function majClient() {
      const changement = nomClient.value.trim() !== (v.client_nom || '') || tel.value.trim() !== (v.client_telephone || '');
      if (!changement) return;
      if (v.local) {
        // Vente encore sur l'appareil : on corrige la file d'attente
        const nom = nomClient.value.trim() || null;
        const telephone = tel.value.trim() || null;
        await modifierFile((f) => f.map((x) => (x.cle === v.cle ? { ...x, client_nom: nom, client_telephone: telephone } : x)));
      } else {
        await api(`/ventes/${v.id}/client`, { method: 'PUT', body: { client_nom: nomClient.value, client_telephone: tel.value } });
      }
      v.client_nom = nomClient.value.trim() || null;
      v.client_telephone = tel.value.trim() || null;
      await rafraichir();
    }

    const blocAnomalie = v.anomalie && !v.anomalie_verifiee ? h('div', { class: 'resultat attention-box' },
      h('p', {}, h('strong', {}, 'À vérifier : '), v.anomalie),
      estProprio() && h('button', { class: 'btn petit', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
        await api(`/ventes/${v.id}/verifiee`, { method: 'PUT' });
        v.anomalie_verifiee = true;
        blocAnomalie.remove();
        toast('Vente marquée comme vérifiée.');
      }) }, 'Marquer comme vérifiée')) : null;
    const noteLocale = v.local ? h('p', { class: 'aide' }, 'Vente gardée sur cet appareil (référence provisoire). L\'envoi par WhatsApp sera possible une fois la vente envoyée au serveur : retrouvez-la ensuite dans Ventes. En attendant, vous pouvez télécharger, imprimer ou partager l\'image.') : null;

    const btnWa = h('button', { class: 'btn primaire', type: 'button', disabled: Boolean(v.local), onclick: () => agir(btnWa, async () => {
      const numero = BQ.numeroWhatsApp(tel.value, e.pays_indicatif);
      if (!numero) throw new Error('Saisissez le numéro WhatsApp du client (avec l\'indicatif, ex. +228…, s\'il n\'est pas dans le pays de l\'entreprise).');
      await majClient();
      const [fact, apercu] = await Promise.all([jpegSous(canvas, 480 * 1024), dessinerApercu(v).then((c) => jpegSous(c, 230 * 1024))]);
      const r = await api(`/ventes/${v.id}/facture-image`, { method: 'POST', body: { image: await base64(fact), apercu: await base64(apercu) } });
      const texte = BQ.messageWhatsApp({ client: v.client_nom, entreprise: e.nom, numero: v.numero, total: v.total, lien: r.url });
      const adresse = `https://wa.me/${numero}?text=${encodeURIComponent(texte)}`;
      retour.replaceChildren(h('div', { class: 'resultat' },
        h('p', {}, h('strong', {}, 'Facture prête.'), ' WhatsApp s\'ouvre sur la conversation du client : appuyez sur « Envoyer ».'),
        h('p', { class: 'aide' }, 'Le client reçoit un lien qui affiche la facture en image. WhatsApp ne s\'est pas ouvert ?'),
        h('a', { class: 'btn', href: adresse, target: '_blank', rel: 'noopener' }, 'Ouvrir WhatsApp')));
      const a = h('a', { href: adresse, target: '_blank', rel: 'noopener' });
      document.body.append(a);
      a.click();
      a.remove();
    }) }, 'Envoyer sur WhatsApp');

    const btnPartage = typeof navigator.share === 'function' && h('button', { class: 'btn', type: 'button', onclick: () => agir(btnPartage, async () => {
      await majClient();
      const fichier = new File([await versBlob(canvas, 'image/png')], `facture-${num}.png`, { type: 'image/png' });
      if (!navigator.canShare || !navigator.canShare({ files: [fichier] })) throw new Error('Le partage d\'images n\'est pas disponible sur cet appareil : utilisez « Télécharger l\'image ».');
      try { await navigator.share({ files: [fichier], title: `Facture n° ${num}`, text: `Facture n° ${num} — ${e.nom}` }); } catch (err) { if (err.name !== 'AbortError') throw err; }
    }) }, 'Partager l\'image');

    const btnDl = h('button', { class: 'btn', type: 'button', onclick: () => agir(btnDl, async () => {
      await majClient();
      telechargerBlob(await versBlob(canvas, 'image/png'), `facture-${num}.png`);
    }) }, 'Télécharger l\'image');

    const btnPrint = h('button', { class: 'btn', type: 'button', onclick: () => {
      document.getElementById('recu-print').replaceChildren(h('img', { src: canvas.toDataURL('image/png'), alt: `Facture n° ${num}` }));
      setTimeout(() => window.print(), 50);
    } }, 'Imprimer');

    dlg = modale(`Facture n° ${num}`, h('div', { class: 'facture-layout' },
      h('div', { class: 'facture-apercu' }, canvas),
      h('div', { class: 'facture-controles' },
        blocAnomalie,
        noteLocale,
        v.local ? null : suiviVente(v, rouvrir),
        champ('Nom du client', nomClient),
        champ('WhatsApp du client', tel),
        h('div', { class: 'actions' }, btnWa, btnPartage, btnDl, btnPrint),
        retour,
        h('p', { class: 'aide' }, 'Le bouton WhatsApp ouvre la conversation du client avec un lien qui affiche cette facture en image. « Partager l\'image » envoie l\'image elle-même : vous choisissez ensuite le contact dans WhatsApp.'))),
      { large: true, classe: 'facture' });
  }

  const numAvoir = (n) => `AV-${String(n).padStart(5, '0')}`;
  const aujourdhuiIso = () => new Date().toLocaleDateString('sv-SE');

  // Suivi d'une vente à crédit (règlements) et des remboursements, dans la fenêtre de facture
  function suiviVente(v, rouvrir) {
    const solde = Number(v.solde) || 0;
    const credit = v.mode_paiement === 'credit';
    const items = [];
    if (credit) {
      const enRetard = solde > 0 && v.echeance && v.echeance < aujourdhuiIso();
      items.push(h('div', { class: 'suivi-statut' },
        h('span', { class: 'badge ' + (solde > 0 ? (enRetard ? 'retard' : 'credit') : 'solde') }, solde > 0 ? `À crédit — reste ${fcfa(solde)}` : 'Crédit soldé'),
        v.echeance && solde > 0 && h('small', {}, enRetard ? `en retard depuis le ${dateFr(v.echeance)}` : `à régler avant le ${dateFr(v.echeance)}`)));
      if (solde > 0) {
        const montant = h('input', { type: 'number', min: 1, max: solde, step: 1, value: solde, inputmode: 'numeric', 'aria-label': 'Montant du règlement' });
        const mode = h('select', { 'aria-label': 'Mode de règlement' }, Object.entries(MODES_ARGENT).map(([k, l]) => h('option', { value: k }, l)));
        items.push(h('div', { class: 'suivi-form' },
          champ('Règlement reçu (F CFA)', montant), champ('Mode', mode),
          h('button', { class: 'btn primaire', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
            await api(`/ventes/${v.id}/reglements`, { method: 'POST', body: { montant: Number(montant.value), mode_paiement: mode.value } });
            toast('Règlement enregistré.');
            await rouvrir();
          }) }, 'Enregistrer le règlement')));
      }
    }
    if (v.reglements && v.reglements.length) {
      items.push(h('details', {}, h('summary', {}, `${v.reglements.length} règlement(s) reçu(s)`),
        h('ul', { class: 'liste' }, v.reglements.map((r) => h('li', {}, h('span', {}, `${r.cree_le} · ${MODES[r.mode_paiement] || r.mode_paiement}`), h('span', { class: 'num' }, fcfa(r.montant)))))));
    }
    if (v.remboursements && v.remboursements.length) {
      items.push(h('div', {}, h('h3', {}, 'Remboursements'),
        h('ul', { class: 'liste' }, v.remboursements.map((r) => h('li', {},
          h('span', {}, `Avoir ${numAvoir(r.numero)} · ${r.cree_le}`, h('small', { class: 'bloc-pt' }, r.motif)),
          h('span', {}, h('strong', { class: 'num' }, fcfa(r.montant)), ' ',
            h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => afficherAvoir(v, r)) }, 'Voir l\'avoir')))))));
    }
    const restant = (v.lignes || []).some((l) => l.quantite - (l.deja_rembourse || 0) > 0);
    if (estProprio() && restant) items.push(h('button', { class: 'btn', type: 'button', onclick: () => ouvrirRemboursement(v, rouvrir) }, 'Rembourser des articles'));
    return items.length ? h('section', { class: 'suivi' }, items) : null;
  }

  // Remboursement : le propriétaire choisit les articles repris ; la dette du client est annulée avant de rendre de l'argent
  function ouvrirRemboursement(v, rouvrir) {
    const sel = new Map();
    const lignes = v.lignes.filter((l) => l.quantite - (l.deja_rembourse || 0) > 0);
    const resume = h('div', { class: 'resultat', 'aria-live': 'polite' });
    const motif = h('input', { maxlength: 255, placeholder: 'Ex. : produit défectueux, erreur de commande…' });
    const stock = h('input', { type: 'checkbox', checked: true });
    const modeSel = h('select', {}, Object.entries(MODES_ARGENT).map(([k, l]) => h('option', { value: k }, l)));
    const valeur = () => lignes.reduce((t, l) => t + (sel.get(l.id) || 0) * l.prix_unitaire, 0);
    let btn = null;
    function maj() {
      const val = valeur();
      const credit = Math.min(Number(v.solde) || 0, val);
      resume.replaceChildren(
        h('p', {}, h('strong', {}, 'Valeur reprise : '), fcfa(val)),
        credit > 0 && h('p', {}, `Dette du client annulée : ${fcfa(credit)}`),
        h('p', {}, h('strong', {}, 'À rendre au client : '), fcfa(val - credit)));
      if (btn) btn.disabled = val <= 0;
    }
    const rows = lignes.map((l) => {
      const max = l.quantite - (l.deja_rembourse || 0);
      return h('div', { class: 'rb-ligne' },
        h('span', {}, l.nom_produit, h('small', { class: 'bloc-pt' }, `${fcfa(l.prix_unitaire)} · ${max} remboursable(s)`)),
        h('input', { type: 'number', min: 0, max, step: 1, value: 0, inputmode: 'numeric', 'aria-label': `Quantité à rembourser : ${l.nom_produit}`,
          oninput: (e) => { sel.set(l.id, Math.max(0, Math.min(max, parseInt(e.target.value, 10) || 0))); maj(); } }));
    });
    btn = h('button', { class: 'btn primaire gros', type: 'button', disabled: true, onclick: (ev) => agir(ev.currentTarget, async () => {
      if (!motif.value.trim()) throw new Error('Indiquez le motif du remboursement.');
      const r = await api(`/ventes/${v.id}/remboursements`, { method: 'POST', body: {
        lignes: [...sel].filter(([, q]) => q > 0).map(([ligne_id, quantite]) => ({ ligne_id, quantite })),
        motif: motif.value.trim(), remettre_en_stock: stock.checked, mode_paiement: modeSel.value } });
      d.close();
      toast(`Remboursement ${numAvoir(r.numero)} enregistré.`);
      await rouvrir();
    }) }, 'Valider le remboursement');
    const d = modale(`Rembourser — vente n° ${BQ.numeroFacture(v.numero)}`, h('div', {},
      h('p', { class: 'aide' }, 'Indiquez la quantité reprise pour chaque article.'),
      rows, champ('Motif du remboursement', motif),
      h('label', { class: 'case' }, stock, ' Remettre les articles en stock'),
      champ('Argent rendu en', modeSel), resume, h('div', { class: 'actions' }, btn)));
    maj();
  }

  // Avoir : la facture de remboursement remise au client
  async function afficherAvoir(v, r) {
    const av = {
      titre: 'AVOIR', etiquetteTotal: 'TOTAL REMBOURSÉ', numero: numAvoir(r.numero), cree_le: r.cree_le,
      client_nom: v.client_nom, client_telephone: v.client_telephone, lignes: r.lignes, total: r.montant, vendeur: r.par,
      infos: [`Remboursement de la facture n° ${BQ.numeroFacture(v.numero)}`, `Motif : ${r.motif}`,
        r.credit_annule > 0 && `Dette annulée : ${fcfa(r.credit_annule)}`,
        r.montant_rendu > 0 && `Rendu au client : ${fcfa(r.montant_rendu)} (${MODES[r.mode_paiement] || r.mode_paiement})`].filter(Boolean),
    };
    const canvas = await dessinerFacture(av);
    canvas.className = 'facture-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Avoir ${av.numero}, ${fcfa(r.montant)}`);
    const btnDl = h('button', { class: 'btn', type: 'button', onclick: () => agir(btnDl, async () => telechargerBlob(await versBlob(canvas, 'image/png'), `avoir-${av.numero}.png`)) }, 'Télécharger l\'image');
    const btnPrint = h('button', { class: 'btn', type: 'button', onclick: () => {
      document.getElementById('recu-print').replaceChildren(h('img', { src: canvas.toDataURL('image/png'), alt: `Avoir ${av.numero}` }));
      setTimeout(() => window.print(), 50);
    } }, 'Imprimer');
    const btnPartage = typeof navigator.share === 'function' && h('button', { class: 'btn', type: 'button', onclick: () => agir(btnPartage, async () => {
      const fichier = new File([await versBlob(canvas, 'image/png')], `avoir-${av.numero}.png`, { type: 'image/png' });
      if (!navigator.canShare || !navigator.canShare({ files: [fichier] })) throw new Error('Le partage d\'images n\'est pas disponible sur cet appareil : utilisez « Télécharger l\'image ».');
      try { await navigator.share({ files: [fichier], title: `Avoir ${av.numero}` }); } catch (err) { if (err.name !== 'AbortError') throw err; }
    }) }, 'Partager l\'image');
    modale(`Avoir ${av.numero}`, h('div', { class: 'facture-layout' },
      h('div', { class: 'facture-apercu' }, canvas),
      h('div', { class: 'facture-controles' }, h('div', { class: 'actions' }, btnPartage, btnDl, btnPrint))),
    { large: true, classe: 'facture' });
  }

  // ---------- Inventaire ----------
  const ecartBadge = (e) => (e === null || e === undefined ? null
    : h('span', { class: 'badge ' + (e === 0 ? 'solde' : e < 0 ? 'retard' : 'credit') }, e === 0 ? 'conforme' : `${e > 0 ? '+' : ''}${nombre(e)}`));

  VUES.inventaire = async (vue) => {
    const liste = await api('/inventaires');
    const courant = liste.find((i) => i.statut === 'en_cours');
    if (courant) return afficherInventaire(vue, courant.id);
    const STATUT = { valide: ['Validé', 'solde'], annule: ['Annulé', 'retard'] };
    const note = h('input', { maxlength: 255, placeholder: 'Ex. : inventaire de fin d\'octobre' });
    const btn = h('button', { class: 'btn primaire gros', type: 'button', onclick: () => agir(btn, async () => {
      await api('/inventaires', { method: 'POST', body: { note: note.value } });
      toast('Inventaire démarré : vous pouvez compter avec votre secrétaire.');
      router();
    }) }, 'Démarrer un inventaire');
    remplacer(vue, h('h1', {}, 'Inventaire'),
      h('section', { class: 'carte' },
        estProprio()
          ? [h('h2', {}, 'Aucun inventaire en cours'),
            h('p', { class: 'aide' }, 'Démarrer fige la liste de vos produits. Vous et votre secrétaire comptez ensuite chaque article sur vos téléphones : la secrétaire compte « à l\'aveugle », sans voir le stock théorique. Vous validez à la fin : le stock est corrigé et chaque écart est enregistré.'),
            champ('Note (facultatif)', note), btn]
          : [h('h2', {}, 'Aucun inventaire en cours'), h('p', { class: 'aide' }, 'Le propriétaire doit d\'abord démarrer un inventaire. Il apparaîtra ici dès qu\'il sera lancé.')]),
      liste.length > 0 && h('section', { class: 'carte' }, h('h2', {}, 'Inventaires précédents'),
        h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
          h('thead', {}, h('tr', {}, ['N°', 'Date', 'Lancé par', 'Comptés', 'Écarts', 'Valeur des écarts', 'État', ''].map((t, i) => h('th', { class: i === 5 ? 'num' : '' }, t)))),
          h('tbody', {}, liste.map((i) => h('tr', { class: 'cliquable', tabindex: '0', onclick: () => agir(null, async () => rapportInventaire(i.id)), onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
            h('td', {}, `n°${i.numero}`, i.note && h('small', { class: 'bloc-pt' }, i.note)),
            h('td', {}, (i.termine_le || i.cree_le).slice(0, 16)), h('td', {}, i.cree_par_nom || '—'),
            h('td', {}, `${i.nb_comptees} / ${i.nb_lignes}`),
            h('td', {}, i.nb_ecarts === null ? '—' : String(i.nb_ecarts)),
            h('td', { class: 'num' }, i.valeur_ecart === null ? '—' : fcfa(i.valeur_ecart)),
            h('td', {}, h('span', { class: 'badge ' + (STATUT[i.statut] || ['', ''])[1] }, (STATUT[i.statut] || [i.statut])[0]), i.tableau_remis && h('small', { class: 'bloc-pt' }, 'tableau remis à zéro')),
            h('td', {}, estProprio() && i.statut === 'annule' && h('button', { class: 'btn petit danger', type: 'button', onclick: (e) => {
              e.stopPropagation();
              confirmerSuppression({ titre: `Supprimer l'inventaire n°${i.numero} ?`,
                texte: 'Cet inventaire a été annulé : il n\'a pas modifié votre stock. Vous le retirez de l\'historique. Les inventaires validés sont conservés.',
                action: async () => { await api(`/inventaires/${i.id}`, { method: 'DELETE' }); toast('Inventaire supprimé.'); router(); } });
            } }, 'Supprimer')))))))));
  };

  // Rapport d'un inventaire terminé
  async function rapportInventaire(id) {
    const d = await api(`/inventaires/${id}`);
    const owner = estProprio();
    const comptes = d.lignes.filter((l) => l.quantite_comptee !== null);
    const valeur = comptes.reduce((t, l) => t + (l.valeur_ecart || 0), 0);
    modale(`Inventaire n°${d.numero}`, h('div', {},
      h('p', { class: 'aide' }, `Lancé le ${d.cree_le}${d.cree_par_nom ? ` par ${d.cree_par_nom}` : ''}${d.termine_le ? ` · terminé le ${d.termine_le}` : ''}${d.tableau_remis ? ' · tableau de bord remis à zéro' : ''}.`),
      owner && h('p', {}, h('strong', {}, 'Valeur des écarts : '), fcfa(valeur), ' (au prix d\'achat)'),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {}, ['Produit', 'Théorique', 'Compté', 'Écart'].map((t, i) => h('th', { class: i > 0 ? 'num' : '' }, t)))),
        h('tbody', {}, comptes.length ? comptes.map((l) => h('tr', {}, h('td', {}, l.nom_produit), h('td', { class: 'num' }, l.theorique === undefined ? '—' : nombre(l.theorique)), h('td', { class: 'num' }, nombre(l.quantite_comptee)), h('td', { class: 'num' }, ecartBadge(l.ecart) || '—')))
          : [h('tr', {}, h('td', { colspan: 4, class: 'aide' }, 'Aucun produit compté.'))]))),
      h('p', { class: 'aide' }, `${comptes.length} produit(s) compté(s) sur ${d.lignes.length}.`)), { large: true });
  }

  async function afficherInventaire(vue, id) {
    const d = await api(`/inventaires/${id}`);
    const owner = estProprio();
    const lignes = d.lignes;
    let filtre = 'tous';
    let mot = '';
    const corps = h('tbody');
    const barre = h('span', { class: 'inv-barre-fut' });
    const progres = h('strong', {});
    const nbCompte = () => lignes.filter((l) => l.quantite_comptee !== null).length;

    function majProgres() {
      const n = nbCompte();
      progres.textContent = `${n} / ${lignes.length} produits comptés`;
      barre.style.width = `${lignes.length ? Math.round((n / lignes.length) * 100) : 0}%`;
    }

    async function enregistrer(l, input, cellEcart) {
      const brut = input.value.trim();
      const q = brut === '' ? null : Number(brut);
      if (q !== null && (!Number.isInteger(q) || q < 0)) { toast('Saisissez un nombre entier positif.', 'erreur'); input.value = l.quantite_comptee === null ? '' : l.quantite_comptee; return; }
      if (q === l.quantite_comptee) return;
      try {
        const r = await api(`/inventaires/${id}/lignes/${l.id}`, { method: 'PUT', body: { quantite: q } });
        l.quantite_comptee = r.quantite_comptee;
        if (owner) { l.ecart = r.quantite_comptee === null ? null : r.ecart; if (l.ecart !== null) l.theorique = r.quantite_comptee - r.ecart; }
        input.closest('tr').classList.toggle('compte', l.quantite_comptee !== null);
        if (cellEcart) cellEcart.replaceChildren(...[ecartBadge(l.ecart)].filter(Boolean));
        majProgres();
      } catch (e) { toast(e.message, 'erreur'); }
    }

    function dessiner() {
      const m = mot.toLowerCase();
      const visibles = lignes.filter((l) => (!m || l.nom_produit.toLowerCase().includes(m))
        && (filtre === 'tous' || (filtre === 'a_compter' && l.quantite_comptee === null) || (filtre === 'ecarts' && l.ecart !== null && l.ecart !== undefined && l.ecart !== 0)));
      let cat = null;
      const rows = [];
      for (const l of visibles) {
        if (l.categorie !== cat) { cat = l.categorie; rows.push(h('tr', { class: 'inv-cat' }, h('td', { colspan: owner ? 4 : 2 }, cat || 'Sans catégorie'))); }
        const cellEcart = owner ? h('td', { class: 'num' }, ...[ecartBadge(l.ecart)].filter(Boolean)) : null;
        const input = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: l.quantite_comptee === null ? '' : l.quantite_comptee, 'aria-label': `Quantité comptée : ${l.nom_produit}`, placeholder: '—',
          onchange: () => enregistrer(l, input, cellEcart), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } } });
        rows.push(h('tr', { class: l.quantite_comptee !== null ? 'compte' : '' },
          h('td', {}, l.nom_produit, h('small', { class: 'bloc-pt' }, l.unite || '')),
          owner && h('td', { class: 'num' }, l.theorique === undefined || l.theorique === null ? '—' : nombre(l.theorique)),
          h('td', { class: 'num' }, input),
          owner && cellEcart));
      }
      corps.replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: owner ? 4 : 2, class: 'aide' }, 'Aucun produit ne correspond.'))]));
    }

    const filtres = h('div', { class: 'inv-filtres' }, [['tous', 'Tous'], ['a_compter', 'À compter'], ...(owner ? [['ecarts', 'Écarts']] : [])].map(([k, t]) =>
      h('button', { type: 'button', class: 'btn petit', 'aria-pressed': String(k === filtre), onclick: (e) => { filtre = k; filtres.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); dessiner(); } }, t)));

    function validerModale() {
      const comptes = lignes.filter((l) => l.quantite_comptee !== null);
      const ecarts = comptes.filter((l) => l.ecart);
      const valeur = comptes.reduce((t, l) => t + (l.valeur_ecart || 0), 0);
      const remettre = h('input', { type: 'checkbox', checked: true });
      const btn = h('button', { class: 'btn primaire gros', type: 'button', onclick: () => agir(btn, async () => {
        const r = await api(`/inventaires/${id}/valider`, { method: 'POST', body: { remettre_tableau_a_zero: remettre.checked } });
        dlg.close();
        toast(`Inventaire n°${r.numero} validé : ${r.stocks_corriges} stock(s) corrigé(s)${r.tableau_remis ? ', tableau de bord remis à zéro' : ''}.`);
        router();
      }) }, 'Valider l\'inventaire');
      const dlg = modale('Valider l\'inventaire', h('div', {},
        h('p', {}, h('strong', {}, `${comptes.length} produit(s) compté(s)`), ` sur ${lignes.length}.`),
        lignes.length - comptes.length > 0 && h('p', { class: 'aide' }, `${lignes.length - comptes.length} produit(s) non compté(s) : leur stock ne sera pas modifié.`),
        h('div', { class: 'resultat' },
          h('p', {}, h('strong', {}, 'Écarts constatés : '), String(ecarts.length)),
          h('p', {}, h('strong', {}, 'Valeur des écarts : '), fcfa(valeur), ' (au prix d\'achat)')),
        h('p', { class: 'aide' }, 'Le stock de chaque produit compté devient la quantité comptée (les ventes faites après le comptage restent déduites). Chaque correction est enregistrée dans l\'historique du stock.'),
        h('label', { class: 'case' }, remettre, ' Remettre le tableau de bord à zéro (ventes, graphique, produits les plus vendus)'),
        h('div', { class: 'actions' }, btn)));
    }

    const actions = owner ? h('div', { class: 'actions' },
      h('button', { class: 'btn primaire', type: 'button', onclick: validerModale }, 'Valider l\'inventaire'),
      h('button', { class: 'btn', type: 'button', onclick: (e) => agir(e.currentTarget, async () => {
        if (!confirm('Annuler cet inventaire ? Les comptages saisis seront perdus et le stock ne sera pas modifié.')) return;
        await api(`/inventaires/${id}/annuler`, { method: 'POST' });
        toast('Inventaire annulé.');
        router();
      }) }, 'Annuler l\'inventaire')) : h('p', { class: 'aide' }, 'Quand vous avez fini de compter, prévenez le propriétaire : lui seul valide l\'inventaire.');

    remplacer(vue, h('h1', {}, `Inventaire n°${d.numero}`),
      h('section', { class: 'carte' },
        h('div', { class: 'inv-progres' }, progres, h('span', { class: 'inv-barre' }, barre)),
        d.aveugle && h('p', { class: 'aide' }, 'Comptage à l\'aveugle : le stock théorique est masqué. Comptez ce que vous voyez sur les étagères et saisissez la quantité.'),
        d.note && h('p', { class: 'aide' }, d.note),
        h('div', { class: 'filtres' }, h('input', { type: 'search', placeholder: 'Chercher un produit', 'aria-label': 'Chercher un produit', oninput: (e) => { mot = e.target.value; dessiner(); } }), filtres),
        h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau inventaire' },
          h('thead', {}, h('tr', {}, ['Produit', ...(owner ? ['Théorique'] : []), 'Compté', ...(owner ? ['Écart'] : [])].map((t, i) => h('th', { class: i > 0 ? 'num' : '' }, t)))), corps)),
        actions));
    majProgres();
    dessiner();
  }

  // ---------- Crédits clients ----------
  VUES.credits = async (vue) => {
    const d = await api('/credits');
    const e = state.entreprise;
    const relance = (c) => {
      const numero = BQ.numeroWhatsApp(c.client_telephone, e.pays_indicatif);
      if (!numero) return null;
      const texte = `Bonjour ${c.client_nom || ''}, ici ${e.nom}. Il reste ${fcfa(c.solde)} à régler sur votre facture n° ${BQ.numeroFacture(c.numero)}${c.echeance ? ` (échéance le ${dateFr(c.echeance)})` : ''}. Merci.`;
      return `https://wa.me/${numero}?text=${encodeURIComponent(texte)}`;
    };
    remplacer(vue, h('h1', {}, 'Crédits clients'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'stat-titre' }, 'Total à encaisser'), h('strong', { class: 'stat-valeur' }, avecUnite(fcfa(d.total_du))), h('span', { class: 'stat-detail' }, `${d.credits.length} vente(s) non soldée(s)`)),
        h('div', { class: 'stat' + (d.total_en_retard > 0 ? ' alerte' : '') }, h('span', { class: 'stat-titre' }, 'Dont en retard'), h('strong', { class: 'stat-valeur' }, avecUnite(fcfa(d.total_en_retard))), h('span', { class: 'stat-detail' }, 'date limite dépassée'))),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {}, ['Client', 'Vente', 'Échéance', 'Total', 'Payé', 'Reste', ''].map((t, i) => h('th', { class: i >= 3 && i <= 5 ? 'num' : '' }, t)))),
        h('tbody', {}, d.credits.length ? d.credits.map((c) => h('tr', {},
          h('td', {}, h('strong', {}, c.client_nom || '—'), h('small', { class: 'bloc-pt' }, c.client_telephone || '')),
          h('td', {}, `n°${c.numero}`, h('small', { class: 'bloc-pt' }, c.cree_le)),
          h('td', {}, c.echeance ? [dateFr(c.echeance), c.en_retard && h('span', { class: 'badge retard' }, 'en retard')] : '—'),
          h('td', { class: 'num' }, fcfa(c.total)), h('td', { class: 'num' }, fcfa(c.montant_paye)), h('td', { class: 'num' }, h('strong', {}, fcfa(c.solde))),
          h('td', { class: 'actions-ligne' },
            h('button', { class: 'btn petit primaire', type: 'button', onclick: () => agir(null, async () => afficherFacture(await api(`/ventes/${c.id}`))) }, 'Encaisser'),
            relance(c) && h('a', { class: 'btn petit', href: relance(c), target: '_blank', rel: 'noopener' }, 'Relancer'))))
          : [h('tr', {}, h('td', { colspan: 7, class: 'aide' }, 'Aucun crédit en cours : tous vos clients sont à jour.'))]))),
      h('p', { class: 'aide' }, 'Pour vendre à crédit, choisissez « À crédit » dans la Caisse (nom et téléphone du client obligatoires). Chaque vente à crédit est facturée avec son reste à payer.'));
  };

  // Aperçu d'une facture type avec le profil actuel (exemple clairement indiqué)
  async function apercuModele() {
    const lignes = [
      { nom_produit: 'Exemple : ciment CPJ 42,5 (sac de 50 kg)', quantite: 10, prix_unitaire: 6500, sous_total: 65000 },
      { nom_produit: 'Exemple : fer à béton 8 mm (barre de 12 m)', quantite: 24, prix_unitaire: 4000, sous_total: 96000 },
    ];
    const total = lignes.reduce((t, l) => t + l.sous_total, 0);
    const maintenant = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const canvas = await dessinerFacture({ numero: 1, cree_le: maintenant, client_nom: 'Client exemple', mode_paiement: 'especes', total, lignes, vendeur: state.user.nom_complet });
    canvas.className = 'facture-canvas';
    modale('Aperçu de vos factures', [canvas, h('p', { class: 'aide' }, 'Exemple avec des produits fictifs : vos vraies factures utilisent vos ventes.')], { large: true });
  }

  // ---------- Caisse ----------
  VUES.caisse = async (vue) => {
    const charge = await chargerProduitsCaisse({ rapide: true });
    let produits = charge.liste;
    let file = await lireFile();
    const panier = new Map();
    let recherche = '';
    let mode = 'especes';
    const client = { nom: '', tel: '' };
    const credit = { acompte: '', echeance: '' };

    const grille = h('div', { class: 'grille-produits' });
    const lignesEl = h('div', { class: 'ticket-lignes' });
    const totalEl = h('strong', {}, fcfa(0));
    // Sur téléphone, le ticket est sous la liste des produits : une barre fixe rappelle le panier et y mène
    const barrePanierNb = h('span', { class: 'panier-nb' });
    const barrePanierTotal = h('strong', { class: 'panier-total' });
    const barrePanier = h('button', { class: 'panier-barre', type: 'button', hidden: true, onclick: () => document.getElementById('ticket').scrollIntoView({ behavior: 'smooth', block: 'start' }) },
      barrePanierNb, barrePanierTotal, h('span', { class: 'panier-cta' }, 'Voir le ticket'));
    const btnEncaisser = h('button', { class: 'btn primaire gros', type: 'button', disabled: true }, 'Encaisser');

    const parId = (id) => produits.find((p) => p.id === id);
    // Le stock vendable tient compte des ventes déjà faites sur cet appareil et pas encore envoyées
    const dispo = (p) => BQ.stockDisponible(p, file);
    const total = () => [...panier].reduce((s, [id, q]) => s + (parId(id) ? parId(id).prix_vente * q : 0), 0);

    function ajouter(p) {
      const q = (panier.get(p.id) || 0) + 1;
      if (q > dispo(p)) { toast(`Il ne reste que ${dispo(p)} ${p.unite} de « ${p.nom} ».`, 'erreur'); return; }
      panier.set(p.id, q);
      dessinerTicket();
    }

    function dessinerGrille() {
      const mot = recherche.toLowerCase();
      const liste = produits.filter((p) => !mot || `${p.nom} ${p.reference || ''}`.toLowerCase().includes(mot));
      grille.replaceChildren(...(liste.length ? liste.map((p) =>
        h('button', { class: 'prod', type: 'button', disabled: dispo(p) <= 0, onclick: () => ajouter(p) },
          h('span', { class: 'prod-nom' }, p.nom),
          h('span', { class: 'prod-prix' }, avecUnite(fcfa(p.prix_vente))),
          h('span', { class: 'prod-stock' + (dispo(p) <= p.seuil_alerte ? ' bas' : '') },
            dispo(p) <= 0 ? 'Rupture' : `${nombre(dispo(p))} ${p.unite}`)))
        : [h('p', { class: 'aide' }, produits.length ? 'Aucun produit ne correspond.' : 'Aucun produit pour le moment. Ajoutez-en depuis la page Produits.')]));
    }

    function dessinerTicket() {
      lignesEl.replaceChildren(...(panier.size ? [...panier].map(([id, q]) => {
        const p = parId(id);
        return h('div', { class: 'tl' },
          h('span', { class: 'tl-nom' }, p.nom),
          h('span', { class: 'tl-qte' },
            h('button', { class: 'btn-icone', type: 'button', 'aria-label': 'Retirer un', onclick: () => { if (q <= 1) panier.delete(id); else panier.set(id, q - 1); dessinerTicket(); } }, '−'),
            h('span', {}, nombre(q)),
            h('button', { class: 'btn-icone', type: 'button', 'aria-label': 'Ajouter un', onclick: () => ajouter(p) }, '+')),
          h('span', { class: 'num' }, nombre(p.prix_vente * q)));
      }) : [h('p', { class: 'aide' }, 'Touchez un produit pour l\'ajouter au ticket.')]));
      totalEl.replaceChildren(...avecUnite(fcfa(total())));
      btnEncaisser.disabled = panier.size === 0;
      const articles = [...panier.values()].reduce((s, q) => s + q, 0);
      barrePanier.hidden = articles === 0;
      barrePanierNb.textContent = `${articles} article${articles > 1 ? 's' : ''}`;
      barrePanierTotal.replaceChildren(...avecUnite(fcfa(total())));
    }

    // Vente gardée sur l'appareil : facture immédiate (référence provisoire), envoi au serveur dès que le réseau revient
    async function vendreHorsLigne(cle, lignes) {
      const cleCompteur = cleHL(`u${state.user.id}:compteur`);
      const compteur = ((await HL.get(cleCompteur)) || 0) + 1;
      await HL.set(cleCompteur, compteur);
      const detail = lignes.map((l) => {
        const p = parId(l.produit_id);
        return { produit_id: p.id, nom_produit: p.nom, quantite: l.quantite, prix_unitaire: p.prix_vente, sous_total: p.prix_vente * l.quantite };
      });
      const item = {
        cle, statut: 'en_attente', numero_prov: BQ.numeroProvisoire(compteur), cree_le: new Date().toISOString(),
        client_nom: client.nom.trim() || null, client_telephone: client.tel.trim() || null, mode_paiement: mode,
        acompte: mode === 'credit' ? Number(credit.acompte) || 0 : 0, echeance: mode === 'credit' && credit.echeance ? credit.echeance : null,
        lignes: detail, total: detail.reduce((t, l) => t + l.sous_total, 0), vendeur: state.user.nom_complet,
      };
      await modifierFile((f) => [...f, item]);
      file = await lireFile();
      panier.clear();
      dessinerGrille();
      dessinerTicket();
      majEtatReseau();
      toast(`Vente ${item.numero_prov} gardée sur l'appareil : elle sera envoyée dès que la connexion reviendra.`);
      afficherFacture(factureLocale(item));
    }

    btnEncaisser.addEventListener('click', () => agir(btnEncaisser, async () => {
      if (mode === 'credit') {
        if (!client.nom.trim() || !client.tel.trim()) throw new Error('Une vente à crédit exige le nom et le téléphone du client.');
        const a = Number(credit.acompte) || 0;
        if (a < 0 || a >= total()) throw new Error("L'acompte doit être inférieur au total de la vente.");
      }
      const cle = BQ.genererCle();
      const lignes = [...panier].map(([produit_id, quantite]) => ({ produit_id, quantite }));
      if (!state.horsLigne) {
        try {
          // L'identifiant accompagne aussi les ventes en ligne : si le réseau lâche en plein envoi, un renvoi ne fait pas de doublon
          const v = await api('/ventes', { method: 'POST', body: { cle, lignes, client_nom: client.nom, client_telephone: client.tel, mode_paiement: mode,
            ...(mode === 'credit' ? { acompte: Number(credit.acompte) || 0, echeance: credit.echeance || null } : {}) }, delai: R.estPret() ? 20000 : 8000 });
          const detail = await api(`/ventes/${v.id}`);
          panier.clear();
          produits = (await chargerProduitsCaisse()).liste;
          dessinerGrille();
          dessinerTicket();
          toast(`Vente n°${v.numero} enregistrée.`);
          afficherFacture(detail);
          return;
        } catch (e) {
          if (!e.hors_ligne) throw e; // refus du serveur (stock, produit archivé…) : on l'affiche
        }
      }
      await vendreHorsLigne(cle, lignes);
    }));

    const zoneCredit = h('div', { class: 'zone-credit', hidden: true },
      champ('Acompte versé maintenant (F CFA)', h('input', { type: 'number', inputmode: 'numeric', min: 0, step: 1, placeholder: '0', oninput: (e) => { credit.acompte = e.target.value; } })),
      champ('Date limite de paiement', h('input', { type: 'date', oninput: (e) => { credit.echeance = e.target.value; } })),
      h('p', { class: 'aide' }, 'Le nom et le téléphone du client sont obligatoires. Le reste à payer apparaît sur la facture et dans la page Crédits.'));
    const selMode = h('select', { onchange: (e) => { mode = e.target.value; zoneCredit.hidden = mode !== 'credit'; }, value: mode },
      Object.entries(MODES).map(([v, l]) => h('option', { value: v }, l)));

    const attente = file.filter((v) => v.statut === 'en_attente').length;
    const bandeau = (state.horsLigne || (charge.depuisCache && !charge.rafraichir))
      ? h('div', { class: 'bandeau hors-ligne' }, h('span', {},
        h('strong', {}, 'Mode hors connexion. '),
        `Liste des produits enregistrée le ${new Date(charge.le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}. Les ventes sont gardées sur cet appareil et envoyées automatiquement dès que la connexion revient.`))
      : (attente ? h('div', { class: 'bandeau' }, h('span', {}, `${attente} vente${attente > 1 ? 's' : ''} faite${attente > 1 ? 's' : ''} hors connexion en attente d'envoi.`),
        h('button', { class: 'btn', type: 'button', onclick: () => synchroniser({ manuel: true }) }, 'Envoyer maintenant')) : null);

    remplacer(vue, h('h1', {}, 'Caisse'), bandeau,
      h('div', { class: 'caisse' },
        h('section', { class: 'caisse-produits' },
          h('input', { type: 'search', placeholder: 'Chercher un produit ou une référence', 'aria-label': 'Chercher un produit',
            oninput: (e) => { recherche = e.target.value; dessinerGrille(); } }),
          grille),
        h('aside', { class: 'ticket', id: 'ticket', 'aria-label': 'Ticket en cours' },
          h('h2', {}, 'Ticket'),
          lignesEl,
          h('div', { class: 'ticket-total' }, h('span', {}, 'Total'), totalEl),
          champ('Client (facultatif)', h('input', { maxlength: 150, oninput: (e) => { client.nom = e.target.value; } })),
          champ('Téléphone du client (facultatif)', h('input', { type: 'tel', maxlength: 30, oninput: (e) => { client.tel = e.target.value; } })),
          champ('Mode de paiement', selMode),
          zoneCredit,
          btnEncaisser)),
      barrePanier);
    dessinerGrille();
    dessinerTicket();
    // Ouverture sur la copie de l'appareil : les produits à jour (stock des autres appareils) arrivent dès que le serveur répond
    if (charge.rafraichir) {
      chargerProduitsCaisse().then((c) => {
        if (c.depuisCache || !document.getElementById('ticket')) return;
        produits = c.liste;
        dessinerGrille();
        dessinerTicket();
      }).catch(() => {});
    }
    // La barre se retire quand le ticket est à l'écran
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => barrePanier.classList.toggle('masquee', e.isIntersecting)).observe(document.getElementById('ticket'));
    }
  };

  // Vente gardée sur l'appareil, présentée comme une facture (même rendu que les ventes du serveur)
  function factureLocale(item) {
    return {
      local: true, id: null, cle: item.cle, numero: item.numero_prov, cree_le: heureLocale(new Date(item.cree_le)),
      client_nom: item.client_nom, client_telephone: item.client_telephone, mode_paiement: item.mode_paiement,
      total: item.total, vendeur: item.vendeur, lignes: item.lignes,
      montant_paye: item.mode_paiement === 'credit' ? (item.acompte || 0) : item.total, rembourse: 0, echeance: item.echeance || null,
    };
  }

  // ---------- Produits ----------
  VUES.produits = async (vue) => {
    let categories = await api('/categories');
    const marques = await api('/partenaires/marques').catch(() => []);
    let afficherArchives = false;
    let alerteSeule = false;
    let recherche = '';
    const corps = h('tbody');

    async function charger() {
      const qs = new URLSearchParams({ q: recherche, alerte: alerteSeule ? '1' : '0', archives: afficherArchives ? '1' : '0' });
      const liste = await api(`/produits?${qs}`);
      corps.replaceChildren(...(liste.length ? liste.map((p) =>
        h('tr', { class: p.actif ? '' : 'archive' },
          h('td', {}, h('strong', {}, p.nom), p.reference && h('small', { class: 'bloc-pt' }, `Réf. ${p.reference}`), !p.actif && h('small', { class: 'bloc-pt' }, 'Archivé')),
          h('td', {}, p.categorie || '—'),
          estProprio() && h('td', { class: 'num' }, nombre(p.prix_achat)),
          h('td', { class: 'num' }, nombre(p.prix_vente)),
          h('td', { class: 'num' + (p.quantite_stock <= p.seuil_alerte ? ' bas' : '') }, `${nombre(p.quantite_stock)} ${p.unite}`),
          estProprio() && h('td', { class: 'actions-ligne' },
            h('button', { class: 'btn petit', type: 'button', onclick: () => formulaire(p) }, 'Modifier'),
            h('button', { class: 'btn petit', type: 'button', onclick: (e) => agir(e.target, async () => {
              if (p.actif) {
                if (!confirm(`Archiver « ${p.nom} » ? Il ne sera plus proposé à la vente, l'historique est conservé.`)) return;
                await api(`/produits/${p.id}`, { method: 'DELETE' });
              } else {
                await api(`/produits/${p.id}`, { method: 'PUT', body: { actif: true } });
              }
              await charger();
            }) }, p.actif ? 'Archiver' : 'Réactiver')))
      ) : [h('tr', {}, h('td', { colspan: 6, class: 'aide' }, 'Aucun produit.'))]));
    }

    function formulaire(p) {
      const nouveau = !p;
      const sponsorInitial = p && p.sponsor_id ? String(p.sponsor_id) : '';
      const sponsorHorsListe = Boolean(sponsorInitial) && !marques.some((m) => String(m.id) === sponsorInitial);
      const f = {
        nom: h('input', { required: true, maxlength: 150, value: p ? p.nom : '' }),
        reference: h('input', { maxlength: 50, value: p && p.reference ? p.reference : '' }),
        categorie: h('select', { value: p && p.categorie_id ? String(p.categorie_id) : '' },
          h('option', { value: '' }, 'Sans catégorie'), categories.map((c) => h('option', { value: String(c.id) }, c.nom))),
        unite: h('input', { maxlength: 20, value: p ? p.unite : 'pièce', placeholder: 'pièce, sac, kg, mètre…' }),
        achat: h('input', { type: 'number', inputmode: 'numeric', min: 0, step: 1, value: p ? p.prix_achat : 0 }),
        vente: h('input', { type: 'number', inputmode: 'numeric', min: 0, step: 1, required: true, value: p ? p.prix_vente : '' }),
        stock: h('input', { type: 'number', inputmode: 'numeric', min: 0, step: 1, value: 0 }),
        seuil: h('input', { type: 'number', inputmode: 'numeric', min: 0, step: 1, value: p ? p.seuil_alerte : 5 }),
        partenaire: h('select', { value: sponsorInitial },
          h('option', { value: '' }, 'Aucun'),
          sponsorHorsListe && h('option', { value: sponsorInitial }, 'Partenaire actuel (contrat terminé)'),
          marques.map((m) => h('option', { value: String(m.id) }, m.nom))),
      };
      const err = h('p', { class: 'erreur', role: 'alert' });
      const btn = h('button', { class: 'btn primaire', type: 'submit' }, nouveau ? 'Ajouter le produit' : 'Enregistrer');
      const form = h('form', { novalidate: true, onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        try {
          const body = {
            nom: f.nom.value, reference: f.reference.value, categorie_id: f.categorie.value || null, unite: f.unite.value,
            prix_achat: f.achat.value === '' ? 0 : Number(f.achat.value), prix_vente: f.vente.value === '' ? '' : Number(f.vente.value),
            seuil_alerte: f.seuil.value === '' ? 5 : Number(f.seuil.value),
          };
          // Le partenaire n'est envoyé que s'il change : un contrat terminé ne doit pas être effacé par inadvertance
          if (f.partenaire.value !== sponsorInitial) body.sponsor_id = f.partenaire.value ? Number(f.partenaire.value) : null;
          if (nouveau) { body.quantite_stock = f.stock.value === '' ? 0 : Number(f.stock.value); await api('/produits', { method: 'POST', body }); }
          else await api(`/produits/${p.id}`, { method: 'PUT', body });
          d.close();
          toast(nouveau ? 'Produit ajouté.' : 'Produit modifié.');
          await charger();
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      } },
        champ('Nom du produit', f.nom),
        h('div', { class: 'duo' }, champ('Référence', f.reference), champ('Unité de vente', f.unite)),
        champ('Catégorie', f.categorie),
        h('div', { class: 'duo' }, champ('Prix d\'achat (F CFA)', f.achat), champ('Prix de vente (F CFA)', f.vente)),
        h('div', { class: 'duo' },
          nouveau ? champ('Stock de départ', f.stock) : h('div'),
          champ('Alerte quand le stock descend à', f.seuil)),
        (marques.length > 0 || sponsorHorsListe) && champ('Fourni par un partenaire', f.partenaire, 'Permet de commander ce produit en un clic chez le partenaire quand le stock est bas.'),
        err, btn);
      const d = modale(nouveau ? 'Nouveau produit' : 'Modifier le produit', form);
    }

    async function lireFichier(fichier) {
      const buf = await fichier.arrayBuffer();
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
    }

    function importer() {
      const MODELE = "nom;reference;categorie;unite;prix_achat;prix_vente;stock;seuil_alerte\r\nCiment CPJ 42,5 (sac de 50 kg);CIM-001;Ciment;sac;5800;6500;120;20\r\nClous 70 mm;CLO-070;Quincaillerie;kg;900;1200;50;10\r\n";
      const rapport = h('div', { 'aria-live': 'polite' });
      let contenu = null;
      const fichier = h('input', { type: 'file', accept: '.csv,.txt,text/csv', 'aria-label': 'Fichier CSV' });
      const go = h('button', { class: 'btn primaire', type: 'button', hidden: true });

      fichier.addEventListener('change', async () => {
        go.hidden = true;
        rapport.replaceChildren();
        if (!fichier.files[0]) return;
        try {
          contenu = await lireFichier(fichier.files[0]);
          const r = await api('/produits/import', { method: 'POST', body: { contenu, simuler: true } });
          rapport.replaceChildren(
            h('p', {}, h('strong', {}, `${nombre(r.a_importer)} produit(s) prêt(s) à être importé(s)`), r.nb_ignores ? ` — ${nombre(r.nb_ignores)} ligne(s) ignorée(s) sur ${nombre(r.total_lignes)}.` : `, sur ${nombre(r.total_lignes)} ligne(s).`),
            r.apercu.length > 0 && h('ul', { class: 'liste' }, r.apercu.map((p) => h('li', {}, h('span', {}, p.nom + (p.categorie ? ` · ${p.categorie}` : '')), h('span', { class: 'num' }, `${fcfa(p.prix_vente)} · stock ${nombre(p.stock)}`)))),
            r.nb_ignores > 0 && h('details', {}, h('summary', {}, 'Voir les lignes ignorées'),
              h('ul', { class: 'liste' }, r.ignores.map((i) => h('li', {}, h('span', {}, `Ligne ${i.ligne} — ${i.nom}`), h('span', { class: 'bas' }, i.raison)))),
              r.nb_ignores > r.ignores.length && h('p', { class: 'aide' }, `… et ${nombre(r.nb_ignores - r.ignores.length)} autre(s).`)));
          if (r.a_importer > 0) {
            go.textContent = `Importer ${nombre(r.a_importer)} produit(s)`;
            go.hidden = false;
          }
        } catch (e) { rapport.replaceChildren(h('p', { class: 'erreur' }, e.message)); }
      });

      go.addEventListener('click', () => agir(go, async () => {
        const r = await api('/produits/import', { method: 'POST', body: { contenu, simuler: false } });
        categories = await api('/categories');
        d.close();
        toast(`${nombre(r.importes)} produit(s) importé(s).`);
        await charger();
      }));

      const d = modale('Importer des produits', [
        h('p', {}, 'Préparez votre liste dans Excel (ou tout tableur), puis enregistrez-la au format ', h('strong', {}, 'CSV'), ' (Fichier → Enregistrer sous → « CSV UTF-8 » ou « CSV (séparateur : point-virgule) »).'),
        h('p', { class: 'aide' }, 'Colonnes : nom et prix_vente sont obligatoires ; reference, categorie, unite, prix_achat, stock et seuil_alerte sont facultatives. Les produits déjà présents (même référence, ou même nom sans référence) sont ignorés, jamais modifiés. Jusqu\'à 2 000 produits par fichier.'),
        h('p', {}, h('button', { class: 'btn petit', type: 'button', onclick: () => {
          const a = h('a', { href: URL.createObjectURL(new Blob(['\uFEFF' + MODELE], { type: 'text/csv;charset=utf-8' })), download: 'modele-produits.csv' });
          document.body.append(a); a.click(); a.remove();
        } }, 'Télécharger le modèle'), h('small', { class: 'bloc-pt' }, 'Les deux lignes d\'exemple du modèle sont à remplacer par vos produits.')),
        champ('Fichier CSV', fichier),
        rapport,
        h('div', { class: 'actions' }, go)], { large: true });
    }

    function gererCategories() {
      const liste = h('ul', { class: 'liste' });
      const nom = h('input', { maxlength: 100, placeholder: 'Nouvelle catégorie (ex. Plomberie)' });
      function dessiner() {
        liste.replaceChildren(...(categories.length ? categories.map((c) =>
          h('li', {}, h('span', {}, c.nom), h('button', { class: 'btn petit', type: 'button', onclick: (e) => agir(e.target, async () => {
            await api(`/categories/${c.id}`, { method: 'DELETE' });
            categories = await api('/categories');
            dessiner();
          }) }, 'Supprimer')))
          : [h('li', {}, h('span', { class: 'aide' }, 'Aucune catégorie.'))]));
      }
      dessiner();
      const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Ajouter');
      modale('Catégories', [liste, h('form', { class: 'ligne-form', onsubmit: (e) => {
        e.preventDefault();
        agir(btn, async () => {
          await api('/categories', { method: 'POST', body: { nom: nom.value } });
          nom.value = '';
          categories = await api('/categories');
          dessiner();
        });
      } }, nom, btn)]);
    }

    remplacer(vue, 
      h('div', { class: 'titre-actions' }, h('h1', {}, 'Produits'),
        estProprio() && h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: gererCategories }, 'Catégories'),
          h('button', { class: 'btn', type: 'button', onclick: importer }, 'Importer (CSV)'),
          h('button', { class: 'btn primaire', type: 'button', onclick: () => formulaire(null) }, 'Nouveau produit'))),
      h('div', { class: 'filtres' },
        h('input', { type: 'search', placeholder: 'Chercher un produit ou une référence', 'aria-label': 'Chercher',
          oninput: (e) => { recherche = e.target.value; clearTimeout(VUES._t); VUES._t = setTimeout(charger, 250); } }),
        h('label', { class: 'case' }, h('input', { type: 'checkbox', onchange: (e) => { alerteSeule = e.target.checked; charger(); } }), 'Stock bas seulement'),
        estProprio() && h('label', { class: 'case' }, h('input', { type: 'checkbox', onchange: (e) => { afficherArchives = e.target.checked; charger(); } }), 'Voir les archivés')),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Produit'), h('th', {}, 'Catégorie'), estProprio() && h('th', { class: 'num' }, 'Achat'), h('th', { class: 'num' }, 'Vente'),
          h('th', { class: 'num' }, 'En stock'), estProprio() && h('th', {}, ''))),
        corps)));
    await charger();
  };

  // ---------- Stock ----------
  VUES.stock = async (vue) => {
    const produits = await api('/produits');
    const histo = h('tbody');
    const selProd = h('select', { required: true }, h('option', { value: '' }, 'Choisir un produit…'),
      produits.map((p) => h('option', { value: String(p.id) }, `${p.nom} — ${nombre(p.quantite_stock)} ${p.unite}`)));
    const types = [['entree', 'Entrée (réapprovisionnement)'], ['sortie', 'Sortie (casse, perte, usage interne)']];
    if (estProprio()) types.push(['ajustement', 'Correction (nouveau stock exact)']);
    const selType = h('select', {}, types.map(([v, l]) => h('option', { value: v }, l)));
    const qte = h('input', { type: 'number', inputmode: 'numeric', min: 0, step: 1, required: true });
    const motif = h('input', { maxlength: 255, placeholder: 'Ex. livraison fournisseur' });
    const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Enregistrer le mouvement');
    const err = h('p', { class: 'erreur', role: 'alert' });

    async function chargerHisto() {
      const lignes = await api('/mouvements');
      histo.replaceChildren(...(lignes.length ? lignes.map((m) =>
        h('tr', {}, h('td', {}, m.cree_le), h('td', {}, m.produit), h('td', {}, TYPES_MVT[m.type] || m.type),
          h('td', { class: 'num ' + (m.quantite < 0 ? 'bas' : '') }, (m.quantite > 0 ? '+' : '') + nombre(m.quantite)),
          h('td', {}, m.motif || ''), h('td', {}, m.utilisateur || '')))
        : [h('tr', {}, h('td', { colspan: 6, class: 'aide' }, 'Aucun mouvement.'))]));
    }

    remplacer(vue, h('h1', {}, 'Stock'),
      h('div', { class: 'deux-col' },
        h('form', { class: 'carte', novalidate: true, onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          if (!selProd.value) { err.textContent = 'Choisissez un produit.'; return; }
          btn.disabled = true;
          try {
            const r = await api(`/produits/${selProd.value}/stock`, { method: 'POST', body: {
              type: selType.value, quantite: qte.value === '' ? '' : Number(qte.value), motif: motif.value } });
            toast(`Stock mis à jour : ${nombre(r.quantite_stock)} en stock.`);
            const opt = selProd.selectedOptions[0];
            const p = produits.find((x) => String(x.id) === selProd.value);
            p.quantite_stock = r.quantite_stock;
            opt.textContent = `${p.nom} — ${nombre(r.quantite_stock)} ${p.unite}`;
            qte.value = ''; motif.value = '';
            await chargerHisto();
          } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
        } },
          h('h2', {}, 'Nouveau mouvement'),
          champ('Produit', selProd), champ('Type', selType), champ('Quantité', qte), champ('Motif (facultatif)', motif), err, btn),
        h('section', { class: 'carte' }, h('h2', {}, 'À surveiller'),
          (() => {
            const bas = produits.filter((p) => p.quantite_stock <= p.seuil_alerte);
            return bas.length
              ? h('ul', { class: 'liste' }, bas.slice(0, 12).map((p) => h('li', {}, h('span', {}, p.nom), h('span', { class: 'num bas' }, `${nombre(p.quantite_stock)} ${p.unite}`))))
              : h('p', { class: 'aide' }, 'Aucun produit sous son seuil d\'alerte.');
          })())),
      h('section', { class: 'carte' }, h('h2', {}, 'Derniers mouvements'),
        h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
          h('thead', {}, h('tr', {}, ['Date', 'Produit', 'Type', 'Qté', 'Motif', 'Par'].map((t, i) => h('th', { class: i === 3 ? 'num' : '' }, t)))), histo))));
    await chargerHisto();
  };

  // ---------- Bilans (ventes du jour, de la semaine, du mois…) + fiche PDF ----------
  const PERIODES_BILAN = [['aujourdhui', 'Aujourd\'hui'], ['hier', 'Hier'], ['7j', '7 derniers jours'], ['mois', 'Ce mois'], ['mois_precedent', 'Mois dernier'], ['personnalisee', 'Dates précises']];
  const jourFr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const titrePeriode = (b) => (b.du === b.au ? `Journée du ${jourFr(b.du)}` : `Du ${jourFr(b.du)} au ${jourFr(b.au)}`);

  // Récupère la fiche PDF (la session est dans l'en-tête : un simple lien ne passerait pas)
  async function recupererPdf(chemin) {
    let res;
    try { res = await R.appeler('/api' + chemin, { headers: { Authorization: `Bearer ${state.token}` } }, { delai: 30000, json: false }); }
    catch (e) { throw new Error(messageReseau(e && e.kind)); }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      if (res.status === 401) deconnecter();
      throw new Error(d.erreur || 'Impossible de générer la fiche PDF.');
    }
    const nom = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'bilan.pdf';
    return { blob: await res.blob(), nom };
  }
  async function telechargerPdf(chemin) {
    const { blob, nom } = await recupererPdf(chemin);
    telechargerBlob(blob, nom);
    toast('Fiche PDF téléchargée.');
  }
  async function partagerPdf(chemin) {
    const { blob, nom } = await recupererPdf(chemin);
    const f = new File([blob], nom, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: nom }); } catch (e) { if (e.name !== 'AbortError') throw e; }
    } else { telechargerBlob(blob, nom); toast('Partage indisponible ici : la fiche est téléchargée.'); }
  }

  // Le contenu d'un bilan (utilisé par la page et par la fenêtre « Voir »)
  function blocBilan(b) {
    const carte = (titre, valeur, detail, alerte) => h('div', { class: 'stat' + (alerte ? ' alerte' : '') },
      h('span', { class: 'stat-titre' }, titre), h('strong', { class: 'stat-valeur' }, avecUnite(valeur)), detail && h('span', { class: 'stat-detail' }, detail));
    const ligne = (libelle, valeur, { gras = false, retrait = false, alerte = false } = {}) => h('div', { class: 'ligne-bilan' + (gras ? ' gras' : '') + (retrait ? ' retrait' : '') },
      h('span', {}, libelle), h('span', { class: 'num' + (alerte ? ' bas' : '') }, valeur));
    const moins = (n) => (n ? `- ${fcfa(n)}` : fcfa(0));
    const vente = (n) => `${nombre(n)} vente${n > 1 ? 's' : ''}`;
    const comptant = b.modes.filter((m) => m.mode !== 'credit');
    return h('div', { class: 'bilan' },
      h('div', { class: 'stats vedette' },
        carte('Chiffre d\'affaires net', fcfa(b.ca_net), `ventes ${fcfa(b.ventes.brut)} − remboursements`),
        carte('Ventes', nombre(b.ventes.nb), b.ventes.nb ? `panier moyen ${fcfa(b.ventes.panier_moyen)}` : 'aucune vente sur la période'),
        carte('Argent encaissé', fcfa(b.encaisse.total), 'ventes comptant, acomptes, règlements'),
        carte('Marge estimée', fcfa(b.marge.marge), 'au prix d\'achat actuel'),
        carte('Reste à encaisser', fcfa(b.credit.reste), `${vente(b.credit.nb)} à crédit sur la période`, b.credit.reste > 0)),
      h('div', { class: 'deux-col' },
        h('section', { class: 'carte' }, h('h2', {}, 'Chiffre d\'affaires'),
          ligne('Ventes de la période', fcfa(b.ventes.brut), { gras: true }),
          b.modes.filter((m) => m.nb).map((m) => ligne(`${MODES[m.mode]} (${vente(m.nb)})`, fcfa(m.total), { retrait: true })),
          ligne(`Remboursements (${b.remboursements.nb})`, moins(b.remboursements.total), { alerte: b.remboursements.total > 0 }),
          ligne('Chiffre d\'affaires net', fcfa(b.ca_net), { gras: true })),
        h('section', { class: 'carte' }, h('h2', {}, 'Argent encaissé'),
          comptant.filter((m) => m.nb).map((m) => ligne(`Ventes comptant — ${MODES[m.mode]}`, fcfa(m.total))),
          !comptant.some((m) => m.nb) && ligne('Ventes payées comptant', fcfa(0)),
          ligne('Acomptes sur ventes à crédit', fcfa(b.encaisse.acomptes)),
          ligne(`Règlements de crédits reçus (${b.reglements.nb})`, fcfa(b.encaisse.reglements)),
          ligne('Remboursements rendus', moins(b.encaisse.rendu), { alerte: b.encaisse.rendu > 0 }),
          ligne('Total encaissé', fcfa(b.encaisse.total), { gras: true }))),
      h('div', { class: 'deux-col' },
        h('section', { class: 'carte' }, h('h2', {}, 'Produits les plus vendus'),
          b.top_produits.length
            ? h('ol', { class: 'liste' }, b.top_produits.map((t) => h('li', {}, h('span', {}, t.nom_produit), h('span', { class: 'num' }, `${nombre(t.quantite)} · ${fcfa(t.total)}`))))
            : h('p', { class: 'aide' }, 'Aucune vente sur cette période.')),
        h('section', { class: 'carte' }, h('h2', {}, 'Ventes par vendeur'),
          b.vendeurs.length
            ? h('ul', { class: 'liste' }, b.vendeurs.map((v) => h('li', {}, h('span', {}, v.vendeur), h('span', { class: 'num' }, `${vente(v.nb)} · ${fcfa(v.total)}`))))
            : h('p', { class: 'aide' }, 'Aucune vente sur cette période.'))),
      b.jours.length > 1 && h('section', { class: 'carte' }, h('h2', {}, 'Jour par jour'),
        (() => {
          const max = Math.max(1, ...b.jours.map((j) => j.total));
          return h('div', { class: 'jours-bilan' }, b.jours.map((j) => h('div', { class: 'jour-bilan' },
            h('span', {}, jourFr(j.jour)),
            h('span', { class: 'jour-barre' }, h('span', { style: `width:${Math.max(2, Math.round((j.total / max) * 100))}%` })),
            h('span', { class: 'num' }, fcfa(j.total)))));
        })()),
      h('section', { class: 'carte' }, h('h2', {}, 'Crédits et stock'),
        ligne(`Ventes à crédit de la période (${b.credit.nb})`, fcfa(b.credit.total)),
        ligne('Reste à encaisser sur ces ventes', fcfa(b.credit.reste), { alerte: b.credit.reste > 0 }),
        ligne('Valeur du stock (au prix d\'achat)', fcfa(b.stock.valeur)),
        ligne('Produits à réapprovisionner', nombre(b.stock.faibles), { alerte: b.stock.faibles > 0 }),
        b.anomalies > 0 && ligne('Ventes à vérifier (écart de prix ou de stock)', nombre(b.anomalies), { alerte: true })),
      h('p', { class: 'aide' }, 'La marge est une estimation : elle utilise le prix d\'achat actuel des produits. Le bilan ne dépend pas de la remise à zéro du tableau de bord.'));
  }

  VUES.bilans = async (vue) => {
    let periode = 'aujourdhui';
    const auj = aujourdhuiIso();
    const du = h('input', { type: 'date', value: auj, max: auj, 'aria-label': 'Du' });
    const au = h('input', { type: 'date', value: auj, max: auj, 'aria-label': 'Au' });
    const boutons = h('div', { class: 'periodes', role: 'group', 'aria-label': 'Période du bilan' });
    const dates = h('div', { class: 'dates-bilan', hidden: true });
    const resultat = h('div', {});
    const archive = h('section', { class: 'carte' });
    const requete = () => (periode === 'personnalisee' ? `periode=personnalisee&du=${du.value}&au=${au.value}` : `periode=${periode}`);
    const corps = () => (periode === 'personnalisee' ? { periode, du: du.value, au: au.value } : { periode });

    function majBoutons() {
      boutons.replaceChildren(...PERIODES_BILAN.map(([id, titre]) => h('button', { class: 'btn', type: 'button', 'aria-pressed': String(periode === id), onclick: () => { periode = id; majBoutons(); dates.hidden = id !== 'personnalisee'; if (id !== 'personnalisee') calculer(); } }, titre)));
    }

    async function calculer() {
      remplacer(resultat, h('p', { class: 'chargement' }, 'Calcul du bilan…'));
      try {
        const b = await api(`/bilan?${requete()}`);
        const pdf = h('button', { class: 'btn primaire', type: 'button', onclick: (e) => agir(e.currentTarget, () => telechargerPdf(`/bilan/pdf?${requete()}`)) }, 'Télécharger la fiche PDF');
        const partage = typeof navigator.canShare === 'function' && h('button', { class: 'btn', type: 'button', onclick: (e) => agir(e.currentTarget, () => partagerPdf(`/bilan/pdf?${requete()}`)) }, 'Partager le PDF');
        const garder = h('button', { class: 'btn', type: 'button', onclick: () => enregistrer(b) }, 'Enregistrer ce bilan');
        remplacer(resultat,
          h('div', { class: 'titre-actions' }, h('h2', { class: 'titre-bilan' }, titrePeriode(b)), h('div', { class: 'actions' }, pdf, partage, garder)),
          blocBilan(b));
      } catch (e) {
        remplacer(resultat, h('section', { class: 'carte' }, h('p', { class: 'erreur', role: 'alert' }, e.message)));
      }
    }

    function enregistrer(b) {
      const note = h('input', { maxlength: 255, placeholder: 'Ex. : fin de journée, contrôle avec la secrétaire' });
      const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Enregistrer le bilan');
      const d = modale('Enregistrer ce bilan', h('form', { novalidate: true, onsubmit: (ev) => {
        ev.preventDefault();
        agir(btn, async () => {
          const r = await api('/bilans', { method: 'POST', body: { ...corps(), note: note.value } });
          d.close();
          toast(`Bilan n°${r.numero} enregistré.`);
          await chargerArchive();
        });
      } },
      h('p', {}, `${titrePeriode(b)} : les chiffres actuels sont conservés tels quels, même si de nouvelles ventes arrivent ensuite.`),
      champ('Note (facultatif)', note), btn));
    }

    async function chargerArchive() {
      let liste;
      try { liste = await api('/bilans'); } catch (e) { remplacer(archive, h('h2', {}, 'Bilans enregistrés'), h('p', { class: 'erreur' }, e.message)); return; }
      remplacer(archive, h('h2', {}, 'Bilans enregistrés'),
        liste.length
          ? h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
            h('thead', {}, h('tr', {}, ['N°', 'Période', 'Ventes', 'Chiffre d\'affaires net', 'Enregistré', ''].map((t, i) => h('th', { class: i === 3 ? 'num' : '' }, t)))),
            h('tbody', {}, liste.map((b) => h('tr', {},
              h('td', {}, `n°${b.numero}`),
              h('td', {}, titrePeriode(b), b.note && h('small', { class: 'bloc-pt' }, b.note)),
              h('td', {}, nombre(b.nb_ventes)),
              h('td', { class: 'num' }, fcfa(b.ca_net)),
              h('td', {}, `${jourFr(b.cree_le.slice(0, 10))} ${b.cree_le.slice(11, 16)}`, b.cree_par_nom && h('small', { class: 'bloc-pt' }, b.cree_par_nom)),
              h('td', { class: 'actions-ligne' },
                h('button', { class: 'btn petit', type: 'button', onclick: (e) => agir(e.currentTarget, () => voir(b)) }, 'Voir'),
                h('button', { class: 'btn petit', type: 'button', onclick: (e) => agir(e.currentTarget, () => telechargerPdf(`/bilans/${b.id}/pdf`)) }, 'PDF'),
                h('button', { class: 'btn petit danger', type: 'button', onclick: () => confirmerSuppression({
                  titre: `Supprimer le bilan n°${b.numero} ?`,
                  texte: 'Seul ce document est supprimé. Vos ventes, vos crédits clients et votre stock ne changent pas : vous pourrez refaire ce bilan à tout moment.',
                  action: async () => { await api(`/bilans/${b.id}`, { method: 'DELETE' }); toast('Bilan supprimé.'); await chargerArchive(); } }) }, 'Supprimer')))))))
          : h('p', { class: 'aide' }, 'Aucun bilan enregistré. Faites un bilan ci-dessus puis touchez « Enregistrer ce bilan » pour le garder, par exemple chaque soir.'));
    }

    async function voir(b) {
      const d = await api(`/bilans/${b.id}`);
      modale(`Bilan n°${d.numero} — ${titrePeriode(d)}`, h('div', {},
        h('p', { class: 'aide' }, `Enregistré le ${d.genere_le ? `${jourFr(d.genere_le.slice(0, 10))} à ${d.genere_le.slice(11, 16)}` : ''}${d.cree_par_nom ? ` par ${d.cree_par_nom}` : ''}${d.note ? ` · ${d.note}` : ''}.`),
        h('div', { class: 'actions' }, h('button', { class: 'btn primaire', type: 'button', onclick: (e) => agir(e.currentTarget, () => telechargerPdf(`/bilans/${d.id}/pdf`)) }, 'Télécharger la fiche PDF')),
        blocBilan(d)), { large: true });
    }

    dates.append(champ('Du', du), champ('Au', au),
      h('button', { class: 'btn primaire', type: 'button', onclick: (e) => agir(e.currentTarget, calculer) }, 'Calculer'));
    majBoutons();
    remplacer(vue, h('h1', {}, 'Bilans'),
      h('section', { class: 'carte' }, h('h2', {}, 'Faire un bilan'),
        h('p', { class: 'aide' }, 'Choisissez la période : le bilan du jour, de la semaine, du mois ou entre deux dates. Vous pouvez le télécharger en PDF, le partager, ou l\'enregistrer pour le retrouver plus tard.'),
        boutons, dates),
      resultat, archive);
    await Promise.all([calculer(), chargerArchive()]);
  };

  // ---------- Ventes ----------
  VUES.ventes = async (vue) => {
    const corps = h('tbody');
    const du = h('input', { type: 'date', 'aria-label': 'Du' });
    const au = h('input', { type: 'date', 'aria-label': 'Au' });
    const totalEl = h('strong', {});
    const file = await lireFile();
    const journal = (await HL.get(cleJournal())) || [];

    async function charger() {
      const qs = new URLSearchParams();
      if (du.value) qs.set('du', du.value);
      if (au.value) qs.set('au', au.value);
      let lignes;
      try {
        lignes = await api(`/ventes?${qs}`);
      } catch (e) {
        if (!e.hors_ligne) throw e;
        totalEl.textContent = '—';
        corps.replaceChildren(h('tr', {}, h('td', { colspan: 6, class: 'aide' }, 'Historique indisponible hors connexion. Il s\'affichera dès que la connexion reviendra.')));
        return;
      }
      totalEl.textContent = fcfa(lignes.reduce((s, v) => s + v.total, 0));
      corps.replaceChildren(...(lignes.length ? lignes.map((v) =>
        h('tr', { class: 'cliquable', tabindex: '0',
          onclick: () => agir(null, async () => afficherFacture(await api(`/ventes/${v.id}`))),
          onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
          h('td', {}, `n°${v.numero}`, v.hors_ligne && h('small', { class: 'bloc-pt' }, 'faite hors connexion'),
            v.anomalie && !v.anomalie_verifiee && h('span', { class: 'puce alerte', title: v.anomalie }, 'À vérifier')),
          h('td', {}, v.cree_le), h('td', {}, v.client_nom || '—'),
          h('td', {}, MODES[v.mode_paiement] || v.mode_paiement,
            v.mode_paiement === 'credit' && h('span', { class: 'badge ' + (Number(v.solde) > 0 ? 'credit' : 'solde') }, Number(v.solde) > 0 ? `reste ${fcfa(v.solde)}` : 'soldé'),
            Number(v.rembourse) > 0 && h('span', { class: 'badge retard' }, `remboursé ${fcfa(v.rembourse)}`)),
          h('td', {}, v.vendeur || '—'), h('td', { class: 'num' }, fcfa(v.total))))
        : [h('tr', {}, h('td', { colspan: 6, class: 'aide' }, 'Aucune vente sur cette période.'))]));
    }
    du.addEventListener('change', charger);
    au.addEventListener('change', charger);

    // Ventes faites sur cet appareil et pas encore envoyées
    const blocFile = file.length ? h('section', { class: 'carte attention' },
      h('div', { class: 'titre-actions' },
        h('h2', {}, 'À envoyer au serveur'),
        h('button', { class: 'btn primaire', type: 'button', disabled: state.horsLigne || !file.some((v) => v.statut === 'en_attente'),
          onclick: (e) => agir(e.currentTarget, async () => { await synchroniser({ manuel: true }); router(); }) }, 'Envoyer maintenant')),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {}, ['Référence', 'Date', 'Client', 'État', 'Total', ''].map((t, i) => h('th', { class: i === 4 ? 'num' : '' }, t)))),
        h('tbody', {}, file.map((v) => h('tr', {},
          h('td', {}, h('strong', {}, v.numero_prov)),
          h('td', {}, heureLocale(new Date(v.cree_le))),
          h('td', {}, v.client_nom || '—'),
          h('td', {}, v.statut === 'en_attente'
            ? h('span', { class: 'puce' }, 'En attente d\'envoi')
            : [h('span', { class: 'puce alerte' }, 'Refusée'), h('small', { class: 'bloc-pt' }, v.raison || '')]),
          h('td', { class: 'num' }, fcfa(v.total)),
          h('td', { class: 'actions-ligne' },
            h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => afficherFacture(factureLocale(v))) }, 'Facture'),
            v.statut === 'refusee' && estProprio() && h('button', { class: 'btn petit', type: 'button', onclick: (e) => agir(e.currentTarget, async () => {
              if (!confirm(`Supprimer la vente ${v.numero_prov} refusée par le serveur ? Elle ne sera jamais enregistrée.`)) return;
              await modifierFile((f) => f.filter((x) => x.cle !== v.cle));
              majEtatReseau();
              router();
            }) }, 'Supprimer'))))))),
      h('p', { class: 'aide' }, 'Ces ventes sont gardées sur cet appareil. Elles partent automatiquement dès que la connexion revient, sans doublon possible. Une vente « refusée » n\'a pas pu être enregistrée (produit introuvable, par exemple) : le propriétaire peut la supprimer.')) : null;

    const blocJournal = journal.length ? h('section', { class: 'carte' },
      h('h2', {}, 'Envoyées récemment'),
      h('ul', { class: 'liste' }, journal.slice(0, 5).map((j) => h('li', {},
        h('span', {}, `${j.provisoire} → facture n° ${BQ.numeroFacture(j.numero)}`, j.anomalie && h('span', { class: 'puce alerte', title: j.anomalie }, 'À vérifier')),
        h('span', { class: 'num' }, fcfa(j.total)))))) : null;

    let rembs = [];
    if (estProprio() && !state.horsLigne) { try { rembs = await api('/remboursements'); } catch { rembs = []; } }
    const blocRemb = rembs.length ? h('section', { class: 'carte' }, h('h2', {}, 'Remboursements récents'),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {}, ['Avoir', 'Date', 'Vente', 'Client', 'Motif', 'Montant'].map((t, i) => h('th', { class: i === 5 ? 'num' : '' }, t)))),
        h('tbody', {}, rembs.slice(0, 15).map((r) => h('tr', { class: 'cliquable', tabindex: '0',
          onclick: () => agir(null, async () => afficherFacture(await api(`/ventes/${r.vente_id}`))),
          onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
        h('td', {}, numAvoir(r.numero)), h('td', {}, r.cree_le), h('td', {}, `n°${r.vente_numero}`), h('td', {}, r.client_nom || '—'),
        h('td', {}, r.motif), h('td', { class: 'num' }, fcfa(r.montant)))))))) : null;

    remplacer(vue, h('h1', {}, 'Ventes'), blocFile, blocJournal,
      h('div', { class: 'filtres' }, champ('Du', du), champ('Au', au), h('p', { class: 'total-periode' }, 'Total affiché : ', totalEl)),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {}, ['Vente', 'Date', 'Client', 'Paiement', 'Vendeur', 'Total'].map((t, i) => h('th', { class: i === 5 ? 'num' : '' }, t)))), corps)),
      blocRemb,
      h('p', { class: 'aide' }, 'Touchez une vente pour voir sa facture, l\'envoyer au client sur WhatsApp ou l\'imprimer. Les 200 dernières ventes de la période sont affichées.'));
    await charger();
  };

  // ---------- Équipe ----------
  VUES.equipe = async (vue) => {
    const corps = h('tbody');

    async function charger() {
      const liste = await api('/utilisateurs');
      corps.replaceChildren(...liste.map((u) => {
        const moi = u.id === state.user.id;
        return h('tr', { class: u.actif ? '' : 'archive' },
          h('td', {}, h('strong', {}, u.nom_complet), moi && h('small', { class: 'bloc-pt' }, 'Vous')),
          h('td', {}, u.email),
          h('td', {}, u.role === 'proprietaire' ? 'Propriétaire' : 'Secrétaire'),
          h('td', {}, u.actif ? 'Actif' : 'Désactivé'),
          h('td', { class: 'actions-ligne' }, !moi && [
            h('button', { class: 'btn petit', type: 'button', onclick: (e) => agir(e.target, async () => {
              await api(`/utilisateurs/${u.id}`, { method: 'PUT', body: { actif: !u.actif } });
              await charger();
            }) }, u.actif ? 'Désactiver' : 'Réactiver'),
            h('button', { class: 'btn petit', type: 'button', onclick: () => nouveauMotDePasse(u) }, 'Mot de passe'),
            !u.actif && h('button', { class: 'btn petit danger', type: 'button', onclick: () => confirmerSuppression({
              titre: `Supprimer le compte de ${u.nom_complet} ?`,
              texte: 'Le compte est supprimé définitivement et ne pourra plus se connecter. Les ventes qu\'il a enregistrées sont conservées : le vendeur s\'affichera « Compte supprimé ».',
              action: async () => { await api(`/utilisateurs/${u.id}`, { method: 'DELETE' }); toast('Compte supprimé.'); await charger(); } }) }, 'Supprimer')]));
      }));
    }

    function nouveauMotDePasse(u) {
      const pwd = h('input', { type: 'password', minlength: 8, required: true, autocomplete: 'new-password' });
      const err = h('p', { class: 'erreur', role: 'alert' });
      const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Changer le mot de passe');
      const d = modale(`Mot de passe de ${u.nom_complet}`, h('form', { novalidate: true, onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ''; btn.disabled = true;
        try { await api(`/utilisateurs/${u.id}`, { method: 'PUT', body: { mot_de_passe: pwd.value } }); d.close(); toast('Mot de passe modifié.'); }
        catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      } }, champ('Nouveau mot de passe (8 caractères minimum)', pwd), err, btn));
    }

    function ajouter() {
      const f = {
        nom: h('input', { required: true, maxlength: 150 }),
        mail: h('input', { type: 'email', required: true, maxlength: 150 }),
        pwd: h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
        role: h('select', {}, h('option', { value: 'secretaire' }, 'Secrétaire (caisse et stock)'), h('option', { value: 'proprietaire' }, 'Propriétaire (accès complet)')),
      };
      const err = h('p', { class: 'erreur', role: 'alert' });
      const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Créer le compte');
      const d = modale('Nouveau membre', h('form', { novalidate: true, onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ''; btn.disabled = true;
        try {
          await api('/utilisateurs', { method: 'POST', body: { nom_complet: f.nom.value, email: f.mail.value, mot_de_passe: f.pwd.value, role: f.role.value } });
          d.close(); toast('Compte créé.'); await charger();
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      } }, champ('Nom complet', f.nom), champ('Adresse e-mail', f.mail), champ('Mot de passe provisoire', f.pwd), champ('Rôle', f.role), err, btn));
    }

    remplacer(vue, 
      h('div', { class: 'titre-actions' }, h('h1', {}, 'Équipe'), h('button', { class: 'btn primaire', type: 'button', onclick: ajouter }, 'Nouveau membre')),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {}, ['Nom', 'E-mail', 'Rôle', 'État', ''].map((t) => h('th', {}, t)))), corps)),
      h('p', { class: 'aide' }, 'Le secrétaire peut vendre et gérer les entrées de stock. Il ne voit ni les prix d\'achat, ni l\'équipe, ni l\'abonnement.'));
    await charger();
  };

  // ---------- Abonnement ----------
  function kkiapay(init, cfg) {
    const charger = () => new Promise((resolve, reject) => {
      if (window.openKkiapayWidget) return resolve();
      const s = document.createElement('script');
      s.src = 'https://cdn.kkiapay.me/k.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Impossible de charger KkiaPay. Vérifiez votre connexion.'));
      document.head.append(s);
    });
    return charger().then(() => new Promise((resolve, reject) => {
      const ajouterEcouteur = (evt, fn) => (window.addKkiapayListener ? window.addKkiapayListener(evt, fn) : (evt === 'success' ? window.addSuccessListener(fn) : window.addFailedListener(fn)));
      const retirer = (evt, fn) => { if (window.removeKkiapayListener) window.removeKkiapayListener(evt, fn); };
      const ok = (r) => { retirer('success', ok); retirer('failed', ko); resolve(r.transactionId); };
      const ko = () => { retirer('success', ok); retirer('failed', ko); reject(new Error('Paiement annulé ou refusé.')); };
      ajouterEcouteur('success', ok);
      ajouterEcouteur('failed', ko);
      window.openKkiapayWidget({
        amount: init.montant,
        key: cfg.publicKey,
        api_key: cfg.publicKey,
        sandbox: cfg.sandbox,
        email: state.user.email,
        name: state.user.nom_complet,
        data: String(init.paiement_id),
        theme: getComputedStyle(document.documentElement).getPropertyValue('--marque').trim() || '#3E5C76',
      });
    }));
  }

  // FedaPay : widget checkout.js (clé publique seulement ; la confirmation est revérifiée par le serveur)
  function fedapay(init, cfg) {
    const charger = () => new Promise((resolve, reject) => {
      if (window.FedaPay) return resolve();
      const s = document.createElement('script');
      s.src = 'https://cdn.fedapay.com/checkout.js?v=1.1.7';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Impossible de charger FedaPay. Vérifiez votre connexion.'));
      document.head.append(s);
    });
    return charger().then(() => new Promise((resolve, reject) => {
      const widget = window.FedaPay.init({
        public_key: cfg.publicKey,
        environment: cfg.sandbox ? 'sandbox' : 'live',
        transaction: {
          amount: init.montant,
          description: `Abonnement Best-Quinca (${init.plan})`,
          custom_metadata: { paiement_id: init.paiement_id },
        },
        customer: { email: state.user.email, lastname: state.user.nom_complet },
        onComplete(resp) {
          const t = resp && resp.transaction;
          if (resp && resp.reason === window.FedaPay.CHECKOUT_COMPLETED && t && t.id) resolve(String(t.id));
          else reject(new Error('Paiement annulé ou refusé.'));
        },
      });
      widget.open();
    }));
  }

  async function payer(agregateur, plan, btn) {
    await agir(btn, async () => {
      const init = await api('/abonnement/initier', { method: 'POST', body: { agregateur: agregateur.id, plan } });
      let reference;
      if (agregateur.id === 'kkiapay') reference = await kkiapay(init, agregateur.config);
      else if (agregateur.id === 'fedapay') reference = await fedapay(init, agregateur.config);
      else throw new Error('Ce moyen de paiement n\'est pas pris en charge.');
      toast('Paiement reçu, vérification en cours…');
      await api('/abonnement/confirmer', { method: 'POST', body: { paiement_id: init.paiement_id, transaction_id: reference } });
      await chargerSession();
      majPastille();
      toast('Abonnement activé. Merci !');
      location.hash = '#/tableau';
    });
  }

  VUES.abonnement = async (vue) => {
    if (enPlayStore()) {
      // Dans l'application Google Play, on affiche l'état de l'abonnement sans proposer de paiement
      const a = await api('/abonnement');
      state.abonnement = a.actif;
      majPastille();
      return remplacer(vue, h('h1', {}, 'Abonnement'),
        h('section', { class: 'carte' },
          a.actif ? h('p', { class: 'ok-msg' }, `Abonnement actif jusqu'au ${dateFr(a.actif.date_fin)}.`)
            : h('p', { class: 'erreur-msg' }, 'Votre abonnement est inactif : la caisse, le stock et les ventes sont suspendus.'),
          h('p', { class: 'aide' }, 'La gestion de l\'abonnement n\'est pas disponible dans cette application. Elle se fait depuis votre compte Best-Quinca, sur un navigateur.')));
    }
    const [abo, cfg] = await Promise.all([api('/abonnement'), api('/config')]);
    state.config = cfg;
    state.abonnement = abo.actif;
    majPastille();
    const STATUTS = { reussi: 'Réussi', en_attente: 'Non finalisé', echoue: 'Échoué' };
    const AGREGATEURS = { kkiapay: 'KkiaPay', fedapay: 'FedaPay' };
    const PLANS = { mensuel: 'Mensuel', annuel: 'Annuel' };
    const plans = cfg.plans || [];
    const mensuel = plans.find((p) => p.id === 'mensuel');
    const annuel = plans.find((p) => p.id === 'annuel');
    const economie = mensuel && annuel ? Math.round(mensuel.prix * (annuel.jours / mensuel.jours)) - annuel.prix : 0;
    let choix = 'mensuel';
    const zoneBoutons = h('div', { class: 'actions' });
    const carte = (p) => h('button', {
      type: 'button', class: 'plan-carte', 'data-plan': p.id, 'aria-pressed': String(p.id === choix),
      onclick: () => { choix = p.id; document.querySelectorAll('.plan-carte').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.plan === choix))); dessinerBoutons(); },
    },
    h('span', { class: 'plan-nom' }, p.label),
    h('strong', { class: 'plan-prix' }, fcfa(p.prix)),
    h('span', { class: 'plan-duree' }, p.id === 'annuel' ? 'par an' : 'par mois'),
    p.id === 'annuel' && economie > 0 ? h('span', { class: 'plan-eco' }, `Économisez ${fcfa(economie)}`) : null);
    function dessinerBoutons() {
      const p = plans.find((x) => x.id === choix);
      remplacer(zoneBoutons, ...cfg.agregateurs.map((a) =>
        h('button', { class: 'btn primaire gros', type: 'button', onclick: (e) => payer(a, choix, e.currentTarget) },
          `Payer ${fcfa(p.prix)} avec ${AGREGATEURS[a.id] || a.label}`)));
    }
    if (cfg.agregateurs.length) dessinerBoutons();
    remplacer(vue, h('h1', {}, 'Abonnement'),
      h('section', { class: 'carte' },
        abo.actif
          ? [h('p', { class: 'ok-msg' }, `Abonnement actif jusqu'au ${dateFr(abo.actif.date_fin)}.`), h('p', { class: 'aide' }, 'Payer maintenant prolonge la période à partir de cette date.')]
          : h('p', { class: 'erreur-msg' }, 'Votre abonnement est inactif. Payez pour utiliser la caisse, le stock et les ventes.'),
        h('p', { class: 'aide' }, 'Choisissez votre formule — un seul abonnement pour toute la plateforme.'),
        h('div', { class: 'plans' }, plans.map(carte)),
        cfg.agregateurs.length
          ? zoneBoutons
          : h('p', { class: 'erreur-msg' }, 'Aucun moyen de paiement n\'est configuré sur ce serveur.')),
      h('section', { class: 'carte' }, h('h2', {}, 'Historique des paiements'),
        abo.paiements.length
          ? h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
            h('thead', {}, h('tr', {}, ['Date', 'Formule', 'Moyen', 'Montant', 'État'].map((t, i) => h('th', { class: i === 3 ? 'num' : '' }, t)))),
            h('tbody', {}, abo.paiements.map((p) => h('tr', {}, h('td', {}, p.cree_le), h('td', {}, PLANS[p.plan] || 'Mensuel'), h('td', {}, AGREGATEURS[p.agregateur] || p.agregateur), h('td', { class: 'num' }, fcfa(p.montant)), h('td', {}, STATUTS[p.statut] || p.statut))))))
          : h('p', { class: 'aide' }, 'Aucun paiement pour le moment.')));
  };

  // ---------- Profil de l'entreprise ----------
  async function preparerLogo(fichier) {
    if (!/^image\/(png|jpeg|webp)$/.test(fichier.type)) throw new Error('Choisissez une image PNG, JPEG ou WebP.');
    if (fichier.size > 8 * 1024 * 1024) throw new Error('Image trop lourde (8 Mo maximum).');
    const url = URL.createObjectURL(fichier);
    const img = await chargerImage(url);
    URL.revokeObjectURL(url);
    if (!img || !img.naturalWidth) throw new Error('Image illisible.');
    const lw = img.naturalWidth, lh = img.naturalHeight;

    // Logo : 512 px au plus, transparence conservée ; repassé en JPEG sur fond blanc s'il est trop lourd
    const r = Math.min(1, 512 / Math.max(lw, lh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(lw * r)); c.height = Math.max(1, Math.round(lh * r));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    let blob = await versBlob(c, 'image/png');
    if (blob.size > 380 * 1024) {
      const f = document.createElement('canvas');
      f.width = c.width; f.height = c.height;
      const fg = f.getContext('2d');
      fg.fillStyle = '#fff'; fg.fillRect(0, 0, f.width, f.height); fg.drawImage(c, 0, 0);
      blob = await jpegSous(f, 380 * 1024);
    }

    // Icône carrée de l'application installée : logo centré sur fond blanc, avec marge de sécurité
    const i = document.createElement('canvas');
    i.width = 512; i.height = 512;
    const ig = i.getContext('2d');
    ig.fillStyle = '#fff'; ig.fillRect(0, 0, 512, 512);
    const ri = Math.min(310 / lw, 310 / lh);
    ig.drawImage(img, (512 - lw * ri) / 2, (512 - lh * ri) / 2, lw * ri, lh * ri);
    const icone = await versBlob(i, 'image/png');
    if (icone.size > 290 * 1024) throw new Error('Ce logo est trop détaillé. Essayez une version plus simple.');
    return { logo: await base64(blob), icone: await base64(icone) };
  }

  VUES.profil = async (vue) => {
    const e = state.entreprise;
    const zone = h('div', { class: 'logo-zone' });
    function dessinerLogo() {
      zone.replaceChildren(state.entreprise.a_logo
        ? h('img', { class: 'logo-grand', src: logoUrl(), alt: 'Logo de l\'entreprise' })
        : h('div', { class: 'logo-vide', 'aria-hidden': 'true' }, (state.entreprise.nom || '?').trim().charAt(0).toUpperCase()));
    }
    dessinerLogo();

    const fichier = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Choisir un logo', hidden: true });
    fichier.addEventListener('change', () => agir(null, async () => {
      const f = fichier.files[0];
      fichier.value = '';
      if (!f) return;
      const corps = await preparerLogo(f);
      await api('/entreprise/logo', { method: 'PUT', body: corps });
      await chargerSession();
      dessinerLogo();
      btnRetirer.hidden = false;
      toast('Logo enregistré. Il apparaît maintenant sur vos factures.');
    }));
    const btnRetirer = h('button', { class: 'btn', type: 'button', hidden: !e.a_logo, onclick: (ev) => agir(ev.currentTarget, async () => {
      if (!confirm('Retirer le logo de l\'entreprise ?')) return;
      await api('/entreprise/logo', { method: 'DELETE' });
      await chargerSession();
      dessinerLogo();
      btnRetirer.hidden = true;
      toast('Logo retiré.');
    }) }, 'Retirer le logo');

    const f = {
      nom: h('input', { required: true, maxlength: 150, value: e.nom }),
      ville: h('input', { maxlength: 100, value: e.ville || '', autocomplete: 'off' }),
      adresse: h('input', { maxlength: 255, value: e.adresse || '', autocomplete: 'off' }),
      tel: h('input', { type: 'tel', maxlength: 30, value: e.telephone || '' }),
      mail: h('input', { type: 'email', maxlength: 150, value: e.email || '' }),
      ifu: h('input', { maxlength: 30, value: e.ifu || '', autocomplete: 'off' }),
      rccm: h('input', { maxlength: 40, value: e.rccm || '', autocomplete: 'off' }),
      web: h('input', { maxlength: 120, value: e.site_web || '', placeholder: 'www.monentreprise.com', autocapitalize: 'none' }),
      ind: h('input', { inputmode: 'numeric', maxlength: 4, value: e.pays_indicatif || '229' }),
      pied: h('textarea', { rows: 3, maxlength: 300, placeholder: 'Ex. Marchandises vendues non reprises ni échangées. Merci de votre confiance.' }),
    };
    f.pied.value = e.pied_facture || '';
    const partage = h('input', { type: 'checkbox', id: 'partage-stats', checked: Boolean(e.partage_stats) });
    partage.addEventListener('change', async () => {
      const voulu = partage.checked;
      try {
        await api('/entreprise/partage-stats', { method: 'PUT', body: { actif: voulu } });
        await chargerSession();
        toast(voulu ? 'Merci : vos ventes comptent désormais, de façon anonyme, dans les statistiques des partenaires.' : 'Partage désactivé.');
      } catch (ex) { partage.checked = !voulu; toast(ex.message, 'erreur'); }
    });
    const sectionPartage = h('section', { class: 'carte' }, h('h2', {}, 'Partenaires et statistiques'),
      h('label', { class: 'case', for: 'partage-stats' }, partage, 'Partager mes statistiques de vente, de façon anonyme, avec mes partenaires fournisseurs'),
      h('p', { class: 'aide' }, 'Seuls des totaux regroupant au moins 5 boutiques sont transmis (produits du partenaire, villes). Jamais votre nom, vos clients, vos prix d\'achat ni le détail de vos ventes. Désactivable à tout moment.'));
    const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Enregistrer le profil');

    remplacer(vue, h('h1', {}, 'Profil de l\'entreprise'),
      h('section', { class: 'carte' }, h('h2', {}, 'Logo'),
        h('div', { class: 'logo-ligne' }, zone,
          h('div', {},
            h('div', { class: 'actions' },
              h('button', { class: 'btn', type: 'button', onclick: () => fichier.click() }, 'Choisir un logo'), btnRetirer),
            h('p', { class: 'aide' }, 'PNG, JPEG ou WebP. Il apparaît sur vos factures, à la connexion et comme icône de l\'application (réinstallez l\'application sur vos appareils pour changer son icône).')),
          fichier)),
      h('form', { class: 'carte', novalidate: true, onsubmit: (ev) => {
        ev.preventDefault();
        agir(btn, async () => {
          await api('/entreprise', { method: 'PUT', body: {
            nom: f.nom.value, ville: f.ville.value, adresse: f.adresse.value, telephone: f.tel.value, email: f.mail.value,
            ifu: f.ifu.value, rccm: f.rccm.value, site_web: f.web.value, pays_indicatif: f.ind.value, pied_facture: f.pied.value,
          } });
          await chargerSession();
          toast('Profil enregistré. Il apparaît sur vos factures.');
        });
      } },
        h('h2', {}, 'Informations de l\'entreprise'),
        champ('Nom de l\'entreprise', f.nom),
        h('div', { class: 'duo' }, champ('Ville', f.ville), champ('Adresse', f.adresse)),
        h('div', { class: 'duo' }, champ('Téléphone', f.tel), champ('Adresse e-mail', f.mail)),
        h('div', { class: 'duo' }, champ('Numéro IFU', f.ifu), champ('Numéro RCCM', f.rccm)),
        h('div', { class: 'duo' }, champ('Site web', f.web),
          champ('Indicatif téléphonique du pays', f.ind, 'Ajouté aux numéros WhatsApp saisis sans indicatif (229 = Bénin).')),
        champ('Message en bas des factures', f.pied, 'Conditions de vente, remerciements… Par défaut : « Merci pour votre confiance. »'),
        h('div', { class: 'actions' }, btn,
          h('button', { class: 'btn', type: 'button', onclick: () => agir(null, apercuModele) }, 'Voir un aperçu de facture'))),
      sectionPartage,
      estProprio() && zoneSuppression());
  };

  // ---------- Partenaires : offres, réassort, historique ----------
  VUES.partenaires = async (vue) => {
    const [reassort, d, commandes] = await Promise.all([api('/reassort'), api('/partenaires'), api('/reassort/commandes')]);
    const nomParId = new Map(d.partenaires.map((p) => [p.id, p]));
    const logo = (p) => p.a_logo && h('img', { class: 'sponsor-logo', src: `/partenaires/${p.id}/logo?v=${p.logo_v || 0}`, alt: '' });
    const lienSite = (p) => p.site_web && h('a', { href: `https://${p.site_web}`, target: '_blank', rel: 'noopener noreferrer' }, p.site_web);

    function carteReassort(g) {
      const lignes = g.produits.map((p) => ({
        p, coche: h('input', { type: 'checkbox', checked: true, 'aria-label': `Commander ${p.nom}` }),
        qte: h('input', { class: 'qte', type: 'number', inputmode: 'numeric', min: 1, max: 100000, step: 1, value: p.quantite_suggeree, 'aria-label': `Quantité de ${p.nom}` }),
      }));
      const note = h('input', { maxlength: 300, placeholder: 'Message pour le partenaire (facultatif)' });
      const zone = h('div', { 'aria-live': 'polite' });
      const btn = h('button', { class: 'btn primaire', type: 'button', disabled: !g.peut_commander || !estProprio() }, 'Préparer la commande');
      btn.addEventListener('click', () => agir(btn, async () => {
        const choisies = lignes.filter((l) => l.coche.checked).map((l) => ({ produit_id: l.p.id, quantite: Number(l.qte.value) }));
        if (!choisies.length) throw new Error('Cochez au moins un produit.');
        const r = await api('/reassort/commandes', { method: 'POST', body: { sponsor_id: g.sponsor_id, lignes: choisies, note: note.value } });
        // Le bouton WhatsApp est un vrai lien : les navigateurs mobiles bloquent l'ouverture automatique d'une fenêtre après un appel réseau
        zone.replaceChildren(h('p', {}, 'Commande enregistrée. Envoyez-la maintenant au partenaire :'),
          h('a', { class: 'btn primaire', href: r.lien_whatsapp, target: '_blank', rel: 'noopener noreferrer' }, 'Envoyer sur WhatsApp'));
        btn.hidden = true;
      }));
      return h('section', { class: 'carte' }, h('h3', {}, g.sponsor),
        // Liste (et non tableau) : sur téléphone, la quantité à commander doit rester visible sans faire défiler
        h('ul', { class: 'reassort-liste' }, lignes.map((l) => h('li', { class: 'reassort-ligne' },
          h('label', { class: 'reassort-nom' }, l.coche,
            h('span', {}, h('strong', {}, l.p.nom), h('small', { class: 'bloc-pt bas' }, `En stock : ${nombre(l.p.stock)} ${l.p.unite} (seuil ${nombre(l.p.seuil)})`))),
          h('span', { class: 'reassort-qte' }, l.qte, h('span', { class: 'aide' }, l.p.unite))))),
        h('label', { class: 'champ' }, h('span', {}, 'Message'), note),
        !g.peut_commander && h('p', { class: 'aide' }, 'Ce partenaire n\'a pas encore de numéro pour recevoir les commandes.'),
        !estProprio() && h('p', { class: 'aide' }, 'Seul le propriétaire peut passer commande.'),
        h('p', { class: 'aide' }, 'Votre nom, votre ville et votre téléphone sont transmis au partenaire avec la commande.'),
        zone, btn);
    }

    remplacer(vue, h('h1', {}, 'Partenaires'),
      reassort.length > 0 && h('div', {}, h('h2', {}, 'À réapprovisionner chez vos partenaires'), reassort.map(carteReassort)),
      d.offres.length > 0 && h('section', { class: 'carte' }, h('h2', {}, 'Offres en cours'),
        h('ul', { class: 'liste offres' }, d.offres.map((o) => {
          const p = nomParId.get(o.sponsor_id) || { nom: '' };
          return h('li', {}, h('div', {}, h('strong', {}, `${p.nom} — ${o.titre}`),
            o.texte && h('span', { class: 'bloc-pt' }, o.texte), o.fin && h('small', { class: 'bloc-pt' }, `Jusqu'au ${dateFr(o.fin)}`)),
            h('button', { class: 'btn petit', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
              await api(`/partenaires/offres/${o.id}/clic`, { method: 'POST' });
              toast('Votre intérêt est enregistré.');
            }) }, 'Ça m\'intéresse'));
        }))),
      h('section', { class: 'carte' }, h('h2', {}, 'Nos partenaires'),
        d.partenaires.length
          ? h('div', { class: 'partenaires-grille' }, d.partenaires.map((p) => h('div', { class: 'partenaire' }, logo(p), h('strong', {}, p.nom),
            p.description && h('span', { class: 'aide' }, p.description), lienSite(p))))
          : h('p', { class: 'aide' }, 'Aucun partenaire pour le moment.')),
      commandes.length > 0 && h('section', { class: 'carte' }, h('h2', {}, 'Mes commandes de réassort'),
        h('ul', { class: 'liste commandes' }, commandes.map((c) => h('li', {}, h('div', {}, h('strong', {}, c.sponsor),
          h('small', { class: 'bloc-pt' }, c.lignes.map((l) => `${l.nom} × ${l.quantite}`).join(', '))), h('span', { class: 'aide' }, c.cree_le))))));
  };

  // ---------- Réglages ----------
  VUES.reglages = async (vue) => {
    const e = state.entreprise;
    const sections = [h('h1', {}, 'Réglages'),
      h('section', { class: 'carte' }, h('h2', {}, 'Application installable'),
        h('p', {}, `Chaque entreprise a sa propre application. Celle-ci s'ouvre à l'adresse ${location.origin}/app/${SLUG}/ et s'installe sur téléphone ou ordinateur.`),
        blocInstallation())];

    if (estProprio()) {
      const nomApp = h('input', { required: true, maxlength: 100, value: e.nom_app });
      const couleur = h('input', { type: 'color', value: e.couleur.toLowerCase() });
      const btnPwa = h('button', { class: 'btn primaire', type: 'submit' }, 'Enregistrer');
      sections.push(h('form', { class: 'carte', novalidate: true, onsubmit: (ev) => {
        ev.preventDefault();
        agir(btnPwa, async () => {
          await api('/pwa', { method: 'PUT', body: { nom_app: nomApp.value, couleur: couleur.value } });
          await chargerSession();
          toast('Enregistré. Le nom et l\'icône se mettent à jour à la prochaine installation de l\'application.');
        });
      } },
        h('h2', {}, 'Apparence de l\'application'),
        champ('Nom affiché sur l\'appareil', nomApp), champ('Couleur de l\'application', couleur), btnPwa));

    }

    const ancien = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
    const nouveau = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
    const btnPw = h('button', { class: 'btn primaire', type: 'submit' }, 'Changer le mot de passe');
    sections.push(h('form', { class: 'carte', novalidate: true, onsubmit: (ev) => {
      ev.preventDefault();
      agir(btnPw, async () => {
        const r = await api('/auth/mot-de-passe', { method: 'POST', body: { ancien: ancien.value, nouveau: nouveau.value } });
        state.token = r.token; // les autres appareils sont déconnectés, celui-ci reste connecté
        localStorage.setItem(TOKEN_KEY, r.token);
        ancien.value = ''; nouveau.value = '';
        toast('Mot de passe modifié. Vos autres appareils ont été déconnectés.');
      });
    } }, h('h2', {}, 'Mon mot de passe'), champ('Mot de passe actuel', ancien), champ('Nouveau mot de passe (8 caractères minimum)', nouveau), btnPw));

    if (estProprio()) {
      const mdp = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
      const btnCode = h('button', { class: 'btn', type: 'submit' }, state.user.a_code_recuperation ? 'Générer un nouveau code' : 'Générer mon code');
      sections.push(h('form', { class: 'carte', novalidate: true, onsubmit: (ev) => {
        ev.preventDefault();
        agir(btnCode, async () => {
          const r = await api('/auth/code-recuperation', { method: 'POST', body: { mot_de_passe: mdp.value } });
          mdp.value = '';
          state.user.a_code_recuperation = true;
          modale('Nouveau code de récupération', [
            h('p', {}, 'Notez-le ou téléchargez-le maintenant : il ne sera plus affiché. L\'ancien code ne fonctionne plus.'),
            blocCode(r.code_recuperation)]);
        });
      } },
        h('h2', {}, 'Code de récupération'),
        h('p', {}, state.user.a_code_recuperation
          ? 'Un code est enregistré. Il vous permet de choisir un nouveau mot de passe si vous l\'oubliez (écran de connexion → « Mot de passe oublié »).'
          : 'Aucun code enregistré : si vous oubliez votre mot de passe, seul l\'administrateur de la plateforme pourra vous aider. Générez-en un.'),
        champ('Votre mot de passe actuel (pour confirmer)', mdp), btnCode));
    }

    remplacer(vue, ...sections);
  };

  // ---------- Démarrage ----------
  // Le jeton est signé côté serveur : ici on lit seulement sa date d'expiration et son propriétaire
  function lireJeton(jeton) {
    try { return JSON.parse(atob(jeton.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
  }

  async function demarrer() {
    let depuisCopie = false;
    const copie = await HL.get(cleHL('me')).catch(() => null);
    const jeton = lireJeton(state.token || '');
    const copieValable = Boolean(copie && copie.utilisateur && jeton && jeton.sub === copie.utilisateur.id && jeton.exp * 1000 > Date.now() && !copie.utilisateur.mdp_temporaire);
    try {
      // Avec une copie valable de la session, on n'attend pas un serveur endormi (3,5 s au plus) : l'application s'ouvre sur les données de l'appareil.
      // Sans copie (première connexion sur cet appareil), le serveur est indispensable : écran de transition le temps du réveil.
      await chargerSession0(copieValable);
    } catch (e) {
      if (!e.hors_ligne) { state.token = null; return afficherConnexion(); }
      // Serveur injoignable au démarrage : on rouvre la dernière session connue, si elle est encore valable
      if (!copieValable) {
        root.replaceChildren(h('main', { class: 'centre' }, h('section', { class: 'carte' },
          h('h1', {}, 'Hors connexion'),
          h('p', {}, copie && jeton && jeton.exp * 1000 <= Date.now()
            ? 'Votre session a expiré. Reconnectez-vous une fois avec internet : vos ventes en attente sont conservées.'
            : e.message),
          h('button', { class: 'btn primaire', type: 'button', onclick: demarrer }, 'Réessayer'))));
        return;
      }
      state.user = copie.utilisateur;
      state.entreprise = copie.entreprise;
      appliquerMarque(lireMarque());
      state.abonnement = copie.abonnement && copie.abonnement.date_fin >= aujourdhuiLocal() ? copie.abonnement : null;
      state.horsLigne = true;
      state.demarreLocal = true; // le serveur n'a pas encore répondu : revalider dès qu'il sera là
      depuisCopie = true;
    }
    if (state.user.mdp_temporaire) return afficherChangementObligatoire();
    if (!depuisCopie) {
      try { state.config = await api('/config'); } catch { /* facultatif */ }
    }
    afficherCoque();
    await router();
    if (!depuisCopie) {
      chargerProduitsCaisse().catch(() => {}); // copie des produits pour la prochaine coupure
      planifierSync(1000);
      ouvrirTempsReel();
    }
  }

  // Lecture de la session : délai court si une copie locale peut prendre le relais, réveil avec écran sinon
  async function chargerSession0(copieValable) {
    if (copieValable) {
      const r = await api('/auth/me', { delai: 3500 });
      state.user = r.utilisateur; state.entreprise = r.entreprise; state.abonnement = r.abonnement;
      memoriserMarque(r.entreprise);
      HL.set(cleHL('me'), { utilisateur: r.utilisateur, entreprise: r.entreprise, abonnement: r.abonnement, le: Date.now() }).catch(() => {});
      return;
    }
    try {
      await chargerSession();
    } catch (e) {
      if (e.kind !== 'reveil' || !(await R.attendreServeur({ avecEcran: true }))) throw e;
      await chargerSession();
    }
  }

  // Aucun minuteur ne sollicite le serveur. Il n'est contacté que si une vraie opération l'exige :
  // retour du réseau avec des ventes à envoyer, retour sur l'application avec des ventes à envoyer, ou action de l'utilisateur.
  async function auRetourDuReseau() {
    if (!state.user) return;
    const f = await lireFile();
    const besoin = f.some((v) => v.statut === 'en_attente') || document.querySelector('[data-indispo]');
    if (besoin) { if (state.horsLigne) reveillerEnFond(); else planifierSync(500); } else majEtatReseau();
  }
  window.addEventListener('online', auRetourDuReseau);
  window.addEventListener('offline', () => { if (state.user) marquerReseau(false); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') auRetourDuReseau(); });

  window.addEventListener('hashchange', router);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => { /* l'application reste utilisable sans mode hors-ligne */ });
  }

  if (state.token) demarrer(); else afficherConnexion();
})();
