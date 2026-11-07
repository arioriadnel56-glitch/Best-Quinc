(() => {
  'use strict';

  const TOKEN_KEY = 'bq:admin:token';
  const root = document.getElementById('root');
  const state = { token: localStorage.getItem(TOKEN_KEY), admin: null };

  const fcfa = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)) + ' F CFA';
  // « 36 000 F CFA » : le nombre en grand, l'unité en petit
  const unite = (t) => {
    const m = /^(.*?)\s*(F CFA)$/.exec(String(t).replace(/\u202f/g, '\u00a0'));
    return m ? [m[1], h('small', { class: 'unite' }, ` ${m[2]}`)] : [String(t)];
  };
  const nombre = (n) => new Intl.NumberFormat('fr-FR').format(Number(n) || 0);
  const dateFr = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  };

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
    if (valeur !== undefined) el.value = valeur;
    return el;
  }

  // replaceChildren() écrirait « null » ou « false » pour un bloc vide : on les ignore
  const remplacer = (el, ...enfants) => el.replaceChildren(...enfants.filter((c) => c !== null && c !== undefined && c !== false && c !== ''));

  function toast(message, type = 'ok') {
    const t = h('div', { class: `toast ${type}` }, message);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), type === 'erreur' ? 6000 : 3500);
  }

  const R = window.BQR; // appels au serveur et réveil à la demande (reveil.js)
  const messageReseau = (kind) => (kind === 'reveil' ? 'Le serveur ne répond pas. Réessayez dans un instant.' : 'Pas de connexion à internet. Réessayez.');

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    const envoyer = () => R.appeler('/api/admin' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, { delai: 20000 });
    try {
      // Une écriture n'est jamais rejouée à l'aveugle : on s'assure d'abord que le serveur répond. Une lecture peut être reprise après le réveil.
      if (method !== 'GET' && !(await R.garantir({ avecEcran: true }))) throw new R.ErreurReseau('reveil', 'Le serveur ne répond pas.');
      try { res = await envoyer(); } catch (e) {
        if (method !== 'GET' || e.kind !== 'reveil' || !(await R.attendreServeur({ avecEcran: true }))) throw e;
        res = await envoyer();
      }
    } catch (e) {
      throw new Error(messageReseau(e && e.kind));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && state.token) deconnecter();
      const err = new Error(data.erreur || 'Une erreur est survenue.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function agir(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { toast(e.message, 'erreur'); } finally { if (btn) btn.disabled = false; }
  }

  function modale(titre, contenu, { large = false } = {}) {
    const d = h('dialog', { class: 'modale' + (large ? ' large' : '') },
      h('div', { class: 'modale-tete' }, h('h2', {}, titre),
        h('button', { class: 'btn-icone', type: 'button', 'aria-label': 'Fermer', onclick: () => d.close() }, '×')),
      h('div', { class: 'modale-corps' }, contenu));
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
    return d;
  }

  const champ = (libelle, input, aide) => h('label', { class: 'champ' }, h('span', {}, libelle), input, aide && h('small', {}, aide));

  // Temps réel : un paiement ou une inscription apparaît sans recharger la page
  let tempsReel = null;
  let minuteurMaj = null;
  function ouvrirTempsReel() {
    if (tempsReel || !window.BQWS) return;
    tempsReel = window.BQWS.connecter({
      peutOuvrir: () => document.visibilityState === 'visible',
      jeton: () => state.token,
      surEtat: () => {},
      surEvenement: (ev) => {
        if (ev.type === 'paiement.reussi') toast(`Paiement reçu : ${fcfa(ev.montant)}`);
        else if (ev.type === 'entreprise.nouvelle') toast(`Nouvelle entreprise : ${ev.nom}`);
        else if (ev.type === 'commande.reassort') toast(`Commande de réassort : ${ev.entreprise} → ${ev.sponsor}`);
        else return;
        const vue = location.hash.replace(/^#\/?/, '') || 'tableau';
        if (['tableau', 'paiements'].includes(vue)) {
          clearTimeout(minuteurMaj);
          minuteurMaj = setTimeout(router, 600);
        }
      },
    });
  }

  function deconnecter() {
    if (tempsReel) { tempsReel.fermer(); tempsReel = null; }
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
    state.admin = null;
    afficherConnexion();
  }

  // ---------- Connexion ----------
  function afficherConnexion() {
    const erreur = h('p', { class: 'erreur', role: 'alert' });
    const mail = h('input', { type: 'email', required: true, autocomplete: 'username' });
    const pwd = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
    const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Se connecter');
    root.replaceChildren(h('main', { class: 'centre' },
      h('form', { class: 'carte connexion', novalidate: true, onsubmit: async (e) => {
        e.preventDefault();
        erreur.textContent = '';
        btn.disabled = true;
        try {
          const r = await api('/login', { method: 'POST', body: { email: mail.value, mot_de_passe: pwd.value } });
          state.token = r.token;
          localStorage.setItem(TOKEN_KEY, r.token);
          await demarrer();
        } catch (err) { erreur.textContent = err.message; btn.disabled = false; }
      } },
        h('img', { class: 'logo-connexion', src: '/assets/marque/best-quinca.png', alt: 'Best-Quinca Hardware' }),
        h('h1', {}, 'Administration'),
        h('p', { class: 'aide' }, 'Accès réservé aux administrateurs de la plateforme Best-Quinca.'),
        champ('Adresse e-mail', mail), champ('Mot de passe', pwd), erreur, btn)));
  }

  // ---------- Coque ----------
  const ONGLETS = [['tableau', 'Vue d\'ensemble'], ['entreprises', 'Entreprises'], ['paiements', 'Paiements'], ['sponsors', 'Sponsors'], ['parametres', 'Paramètres'], ['compte', 'Mon compte']];
  const VUES = {};

  function afficherCoque() {
    root.replaceChildren(
      h('header', { class: 'admin-top' }, h('strong', {}, h('img', { class: 'logo-admin', src: '/assets/marque/best-quinca-clair.png', alt: 'Best-Quinca Hardware' }), 'Administration'),
        h('span', {}, state.admin.nom_complet),
        h('button', { class: 'btn petit', type: 'button', onclick: deconnecter }, 'Se déconnecter')),
      h('nav', { class: 'onglets', 'aria-label': 'Sections' }, ONGLETS.map(([id, t]) => h('a', { href: `#/${id}`, 'data-route': id }, t))),
      h('main', { class: 'admin-vue', id: 'vue', tabindex: '-1' }));
  }

  async function router() {
    const vue = document.getElementById('vue');
    if (!vue) return;
    let nom = (location.hash.replace(/^#\/?/, '') || 'tableau');
    if (!VUES[nom]) nom = 'tableau';
    document.querySelectorAll('.onglets a').forEach((a) => a.classList.toggle('actif', a.dataset.route === nom));
    remplacer(vue, h('p', { class: 'chargement' }, 'Chargement…'));
    try { await VUES[nom](vue); } catch (e) {
      if (e.status === 401) return;
      remplacer(vue, h('section', { class: 'carte' }, h('h1', {}, "Impossible d'afficher cette page"), h('p', {}, e.message),
        h('button', { class: 'btn', type: 'button', onclick: router }, 'Réessayer')));
    }
  }

  // ---------- Vue d'ensemble ----------
  VUES.tableau = async (vue) => {
    const d = await api('/stats');
    const stat = (t, v, detail, alerte) => h('div', { class: 'stat' + (alerte ? ' alerte' : '') },
      h('span', { class: 'stat-titre' }, t), h('strong', { class: 'stat-valeur' }, typeof v === 'string' ? unite(v) : v), detail && h('span', { class: 'stat-detail' }, detail));
    const max = Math.max(1, ...d.serie.map((s) => s.total));
    remplacer(vue, h('h1', {}, "Vue d'ensemble"),
      h('div', { class: 'stats' },
        stat('Entreprises', nombre(d.entreprises.total), `${nombre(d.entreprises.nouvelles_mois)} nouvelle(s) ce mois-ci`),
        stat('Abonnements actifs', nombre(d.abonnes.actifs), `dont ${nombre(d.abonnes.payants)} payant(s)`),
        stat('Revenus du mois', fcfa(d.revenus.mois), `${fcfa(d.revenus.total)} au total`),
        stat('Entreprises suspendues', nombre(d.entreprises.suspendues), null, d.entreprises.suspendues > 0)),
      h('section', { class: 'carte' }, h('h2', {}, 'Revenus des 6 derniers mois'),
        d.serie.length
          ? h('div', { class: 'barres' }, d.serie.map((s) => h('div', { class: 'barre', title: `${s.mois} : ${fcfa(s.total)}` },
            h('span', { class: 'barre-fut', style: `height:${Math.round((s.total / max) * 100)}%` }), h('span', { class: 'barre-lib' }, s.mois.slice(5) + '/' + s.mois.slice(2, 4)))))
          : h('p', { class: 'aide' }, 'Aucun paiement enregistré pour le moment.')));
  };

  // ---------- Entreprises ----------
  VUES.entreprises = async (vue) => {
    const corps = h('tbody');
    let recherche = '';
    let timer;

    async function charger() {
      const liste = await api(`/entreprises?q=${encodeURIComponent(recherche)}`);
      corps.replaceChildren(...(liste.length ? liste.map((e) => h('tr', { class: e.statut === 'actif' ? '' : 'archive' },
        h('td', {}, h('strong', {}, e.nom), h('small', { class: 'bloc-pt' }, h('a', { href: `/app/${e.slug}/`, target: '_blank', rel: 'noopener' }, e.slug)), h('small', { class: 'bloc-pt' }, `Créée le ${dateFr(e.cree_le)}`)),
        h('td', {}, e.email || '—', e.telephone && h('small', { class: 'bloc-pt' }, e.telephone)),
        h('td', { class: 'num' }, nombre(e.nb_utilisateurs)),
        h('td', { class: 'num' }, nombre(e.nb_ventes)),
        h('td', {}, e.fin_abonnement ? h('span', { class: 'puce ok' }, `jusqu'au ${dateFr(e.fin_abonnement)}`) : h('span', { class: 'puce alerte' }, 'Inactif')),
        h('td', {}, e.statut === 'actif' ? h('span', { class: 'puce ok' }, 'Active') : h('span', { class: 'puce alerte' }, 'Suspendue')),
        h('td', { class: 'actions-ligne' },
          h('button', { class: 'btn petit', type: 'button', onclick: () => acces(e) }, 'Accès'),
          h('button', { class: 'btn petit', type: 'button', onclick: () => offrir(e) }, 'Offrir des jours'),
          h('button', { class: 'btn petit', type: 'button', onclick: () => remiseZero(e) }, 'Remettre le tableau à zéro'),
          h('button', { class: 'btn petit', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
            const suspendre = e.statut === 'actif';
            if (suspendre && !confirm(`Suspendre « ${e.nom} » ? Ses utilisateurs ne pourront plus se connecter ni ouvrir l'application.`)) return;
            await api(`/entreprises/${e.id}/statut`, { method: 'PUT', body: { statut: suspendre ? 'suspendu' : 'actif' } });
            toast(suspendre ? 'Entreprise suspendue.' : 'Entreprise réactivée.');
            await charger();
          }) }, e.statut === 'actif' ? 'Suspendre' : 'Réactiver'))))
        : [h('tr', {}, h('td', { colspan: 7, class: 'aide' }, 'Aucune entreprise.'))]));
    }

    // Récupération d'accès : mot de passe provisoire ou nouveau code, affichés une seule fois
    async function acces(e) {
      const utilisateurs = await api(`/entreprises/${e.id}/utilisateurs`).catch((err) => { toast(err.message, 'erreur'); return null; });
      if (!utilisateurs) return;
      const resultat = h('div', { 'aria-live': 'polite' });
      const montrer = (titre, valeur, email, aide) => resultat.replaceChildren(h('div', { class: 'resultat' },
        h('p', {}, h('strong', {}, titre), ` pour ${email}`),
        h('p', { class: 'code-box' }, valeur),
        h('div', { class: 'actions' }, h('button', { class: 'btn petit', type: 'button', onclick: () => navigator.clipboard && navigator.clipboard.writeText(valeur).then(() => toast('Copié.')) }, 'Copier')),
        h('p', { class: 'aide' }, aide)));
      const lignes = utilisateurs.map((u) => h('li', { class: u.actif ? '' : 'archive' },
        h('span', {}, h('strong', {}, u.nom_complet), h('small', { class: 'bloc-pt' }, `${u.email} · ${u.role === 'proprietaire' ? 'Propriétaire' : 'Secrétaire'}${u.actif ? '' : ' · désactivé'}`)),
        h('span', { class: 'actions' },
          h('button', { class: 'btn petit', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
            if (!confirm(`Réinitialiser le mot de passe de ${u.nom_complet} ?\nVérifiez d'abord son identité (appel, message depuis le numéro de l'entreprise…). Ses sessions en cours seront fermées.`)) return;
            const r = await api(`/entreprises/${e.id}/utilisateurs/${u.id}/reinitialiser`, { method: 'POST' });
            montrer('Mot de passe provisoire', r.mot_de_passe_temporaire, r.email, 'Transmettez-le à son titulaire par un canal sûr. Il sera obligé d\'en choisir un nouveau à sa première connexion. Ce mot de passe ne sera plus affiché.');
          }) }, 'Nouveau mot de passe'),
          u.role === 'proprietaire' && h('button', { class: 'btn petit', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
            if (!confirm(`Générer un nouveau code de récupération pour ${u.nom_complet} ? L'ancien code ne fonctionnera plus.`)) return;
            const r = await api(`/entreprises/${e.id}/utilisateurs/${u.id}/code-recuperation`, { method: 'POST' });
            montrer('Code de récupération', r.code_recuperation, r.email, 'À remettre au propriétaire : il pourra choisir lui-même un nouveau mot de passe (écran de connexion → « Mot de passe oublié »). Ce code ne sera plus affiché.');
          }) }, 'Nouveau code'))));
      modale(`Accès — ${e.nom}`, [
        h('p', { class: 'aide' }, `Contact de l'entreprise : ${e.email || 'aucun e-mail'}${e.telephone ? ' · ' + e.telephone : ''}`),
        h('ul', { class: 'liste' }, lignes), resultat]);
    }

    // Fin d'inventaire : seules les statistiques du tableau de bord repartent de zéro (ventes, crédits et stock restent intacts)
    function remiseZero(e) {
      const note = h('input', { maxlength: 255, placeholder: 'Ex. : inventaire de fin d\'octobre' });
      const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Remettre à zéro');
      const d = modale(`Tableau de bord — ${e.nom}`, h('form', { novalidate: true, onsubmit: (ev) => {
        ev.preventDefault();
        agir(btn, async () => {
          await api(`/entreprises/${e.id}/tableau-remise`, { method: 'POST', body: { note: note.value } });
          d.close();
          toast(`Tableau de bord de « ${e.nom} » remis à zéro.`);
        });
      } },
      h('p', {}, 'Les chiffres du tableau de bord (ventes du jour et du mois, 7 derniers jours, produits les plus vendus, remboursements du mois) repartent de zéro maintenant.'),
      h('p', { class: 'aide' }, 'Aucune vente n\'est supprimée : l\'historique, les crédits clients et le stock restent intacts.'),
      champ('Note (facultatif)', note), btn));
    }

    function offrir(e) {
      const jours = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 366, step: 1, value: 30, required: true });
      const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Offrir');
      const d = modale(`Offrir des jours à ${e.nom}`, h('form', { novalidate: true, onsubmit: (ev) => {
        ev.preventDefault();
        agir(btn, async () => {
          const r = await api(`/entreprises/${e.id}/offrir`, { method: 'POST', body: { jours: Number(jours.value) } });
          d.close();
          toast(`Abonnement prolongé jusqu'au ${dateFr(r.date_fin)}.`);
          await charger();
        });
      } }, champ('Nombre de jours', jours, "Les jours s'ajoutent à la fin de l'abonnement en cours."), btn));
    }

    remplacer(vue, h('h1', {}, 'Entreprises'),
      h('div', { class: 'filtres' }, h('input', { type: 'search', placeholder: 'Chercher par nom, identifiant ou e-mail', 'aria-label': 'Chercher',
        oninput: (ev) => { recherche = ev.target.value; clearTimeout(timer); timer = setTimeout(charger, 250); } })),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {}, ['Entreprise', 'Contact', 'Utilisateurs', 'Ventes', 'Abonnement', 'Statut', ''].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'num' : '' }, t)))), corps)));
    await charger();
  };

  // ---------- Paiements ----------
  VUES.paiements = async (vue) => {
    const corps = h('tbody');
    const STATUTS = { reussi: ['Réussi', 'ok'], en_attente: ['Non finalisé', ''], echoue: ['Échoué', 'alerte'] };
    const filtre = h('select', { 'aria-label': 'Filtrer par état', onchange: charger },
      h('option', { value: '' }, 'Tous les états'), h('option', { value: 'reussi' }, 'Réussis'), h('option', { value: 'en_attente' }, 'Non finalisés'), h('option', { value: 'echoue' }, 'Échoués'));

    async function charger() {
      const liste = await api(`/paiements?statut=${encodeURIComponent(filtre.value)}`);
      corps.replaceChildren(...(liste.length ? liste.map((p) => {
        const [lib, cls] = STATUTS[p.statut] || [p.statut, ''];
        return h('tr', {}, h('td', {}, p.cree_le), h('td', {}, p.entreprise), h('td', {}, p.plan === 'annuel' ? 'Annuel' : 'Mensuel'), h('td', {}, p.agregateur === 'fedapay' ? 'FedaPay' : p.agregateur === 'kkiapay' ? 'KkiaPay' : p.agregateur),
          h('td', {}, p.reference_transaction ? h('span', { class: 'mono' }, p.reference_transaction) : '—'),
          h('td', { class: 'num' }, fcfa(p.montant)), h('td', {}, h('span', { class: `puce ${cls}` }, lib)));
      }) : [h('tr', {}, h('td', { colspan: 7, class: 'aide' }, 'Aucun paiement.'))]));
    }
    remplacer(vue, h('h1', {}, 'Paiements'), h('div', { class: 'filtres' }, filtre),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {}, ['Date', 'Entreprise', 'Formule', 'Moyen', 'Transaction', 'Montant', 'État'].map((t, i) => h('th', { class: i === 5 ? 'num' : '' }, t)))), corps)),
      h('p', { class: 'aide' }, 'Les 200 derniers paiements. « Non finalisé » : le client a ouvert le paiement sans le terminer.'));
    await charger();
  };

  // ---------- Paramètres ----------
  const SOURCES = { admin: ['Enregistrée ici', 'ok'], env: ['Valeur du fichier .env / par défaut', ''], null: ['Non définie', 'alerte'] };

  // ---------- Sponsors ----------
  async function logoEnBase64(fichier) {
    if (!/^image\/(png|jpeg|webp)$/.test(fichier.type)) throw new Error('Choisissez une image PNG, JPEG ou WebP.');
    const url = URL.createObjectURL(fichier);
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error('Image illisible.')); i.src = url; });
    URL.revokeObjectURL(url);
    const r = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * r)); c.height = Math.max(1, Math.round(img.naturalHeight * r));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/png');
    if (data.length * 0.75 > 280 * 1024) throw new Error('Ce logo est trop détaillé. Utilisez une version plus simple.');
    return data;
  }

  VUES.sponsors = async (vue) => {
    const corps = h('tbody');

    async function charger() {
      const liste = await api('/sponsors');
      corps.replaceChildren(...(liste.length ? liste.map(ligne) : [h('tr', {}, h('td', { colspan: 6, class: 'aide' }, 'Aucun partenaire. Ajoutez-en un après accord écrit de la marque ou du distributeur.'))]));
    }

    function ligne(s) {
      const periode = s.debut || s.fin ? `${s.debut ? dateFr(s.debut) : '…'} → ${s.fin ? dateFr(s.fin) : '…'}` : 'Sans limite';
      return h('tr', {},
        h('td', {}, s.a_logo && h('img', { class: 'sponsor-logo', src: `/partenaires/${s.id}/logo?v=${s.logo_v || 0}`, alt: '' }), h('strong', { class: 'bloc-pt' }, s.nom),
          s.telephone_commande ? h('small', { class: 'bloc-pt' }, `Commandes : +${s.telephone_commande}`) : h('small', { class: 'bloc-pt bas' }, 'Pas de numéro de commande')),
        h('td', {}, periode),
        h('td', {}, h('span', { class: `puce ${s.statut === 'actif' ? 'ok' : 'alerte'}` }, s.statut === 'actif' ? 'Actif' : 'Suspendu')),
        h('td', { class: 'num' }, `${nombre(s.nb_boutiques)} boutique(s) · ${nombre(s.nb_offres)} offre(s)`),
        h('td', { class: 'num' }, nombre(s.nb_commandes)),
        h('td', {}, h('div', { class: 'actions-ligne' },
          h('button', { class: 'btn petit', type: 'button', onclick: () => formulaire(s) }, 'Modifier'),
          h('button', { class: 'btn petit', type: 'button', onclick: () => offres(s) }, 'Offres'),
          h('button', { class: 'btn petit', type: 'button', onclick: () => commandes(s) }, 'Commandes'),
          h('button', { class: 'btn petit', type: 'button', onclick: () => rapport(s) }, 'Rapport'))));
    }

    function formulaire(s) {
      const nouveau = !s;
      const f = {
        nom: h('input', { required: true, maxlength: 120, value: s ? s.nom : '' }),
        description: h('textarea', { rows: 3, maxlength: 500 }),
        site: h('input', { maxlength: 150, value: s && s.site_web ? s.site_web : '', placeholder: 'www.marque.com', autocapitalize: 'none' }),
        tel: h('input', { type: 'tel', maxlength: 30, value: s && s.telephone_commande ? s.telephone_commande : '', placeholder: '22997000000' }),
        debut: h('input', { type: 'date', value: s && s.debut ? s.debut : '' }),
        fin: h('input', { type: 'date', value: s && s.fin ? s.fin : '' }),
        statut: h('select', { value: s ? s.statut : 'actif' }, h('option', { value: 'actif' }, 'Actif'), h('option', { value: 'suspendu' }, 'Suspendu')),
      };
      f.description.value = s && s.description ? s.description : '';
      const fichier = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, 'aria-label': 'Choisir un logo' });
      fichier.addEventListener('change', () => agir(null, async () => {
        const fic = fichier.files[0]; fichier.value = '';
        if (!fic) return;
        await api(`/sponsors/${s.id}/logo`, { method: 'PUT', body: { logo: await logoEnBase64(fic) } });
        toast('Logo enregistré.');
        await charger();
      }));
      const err = h('p', { class: 'erreur', role: 'alert' });
      const btn = h('button', { class: 'btn primaire', type: 'submit' }, nouveau ? 'Ajouter le partenaire' : 'Enregistrer');
      const form = h('form', { novalidate: true, onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ''; btn.disabled = true;
        try {
          const body = { nom: f.nom.value, description: f.description.value, site_web: f.site.value, telephone_commande: f.tel.value, debut: f.debut.value, fin: f.fin.value };
          if (nouveau) await api('/sponsors', { method: 'POST', body });
          else await api(`/sponsors/${s.id}`, { method: 'PUT', body: { ...body, statut: f.statut.value } });
          d.close(); toast(nouveau ? 'Partenaire ajouté.' : 'Partenaire modifié.'); await charger();
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      } },
        champ('Nom de la marque ou du distributeur', f.nom),
        champ('Présentation (visible par les boutiques)', f.description),
        h('div', { class: 'duo' }, champ('Site web', f.site), champ('WhatsApp pour les commandes', f.tel, 'Avec l\'indicatif du pays, sans « + » (22997000000).')),
        h('div', { class: 'duo' }, champ('Début du contrat', f.debut), champ('Fin du contrat', f.fin)),
        !nouveau && champ('État', f.statut, 'Suspendu : le partenaire disparaît de l\'application et son rapport n\'est plus accessible.'),
        !nouveau && h('div', { class: 'param' }, h('strong', {}, 'Logo'),
          h('div', { class: 'actions' }, s.a_logo && h('img', { class: 'sponsor-logo', src: `/partenaires/${s.id}/logo?v=${s.logo_v || 0}`, alt: '' }),
            h('button', { class: 'btn petit', type: 'button', onclick: () => fichier.click() }, 'Choisir un logo'),
            s.a_logo && h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => { await api(`/sponsors/${s.id}/logo`, { method: 'DELETE' }); toast('Logo retiré.'); d.close(); await charger(); }) }, 'Retirer')),
          h('small', {}, 'N\'ajoutez le logo d\'une marque qu\'avec son accord écrit.'), fichier),
        err, btn);
      const d = modale(nouveau ? 'Nouveau partenaire' : 'Modifier le partenaire', form);
    }

    async function offres(s) {
      const zone = h('div');
      modale(`Offres — ${s.nom}`, zone, { large: true });
      async function dessiner(edition) {
        const liste = await api(`/sponsors/${s.id}/offres`);
        const f = {
          titre: h('input', { required: true, maxlength: 120, value: edition ? edition.titre : '' }),
          texte: h('input', { maxlength: 300, value: edition && edition.texte ? edition.texte : '' }),
          debut: h('input', { type: 'date', value: edition ? edition.debut : '' }),
          fin: h('input', { type: 'date', value: edition && edition.fin ? edition.fin : '' }),
          actif: h('input', { type: 'checkbox', checked: edition ? edition.actif : true }),
        };
        const err = h('p', { class: 'erreur', role: 'alert' });
        const btn = h('button', { class: 'btn primaire', type: 'submit' }, edition ? 'Enregistrer l\'offre' : 'Ajouter l\'offre');
        const form = h('form', { novalidate: true, onsubmit: async (e) => {
          e.preventDefault(); err.textContent = ''; btn.disabled = true;
          try {
            const body = { titre: f.titre.value, texte: f.texte.value, debut: f.debut.value, fin: f.fin.value, actif: f.actif.checked };
            if (edition) await api(`/offres/${edition.id}`, { method: 'PUT', body });
            else await api(`/sponsors/${s.id}/offres`, { method: 'POST', body });
            await dessiner(null); await charger();
          } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
        } },
          h('h3', {}, edition ? 'Modifier l\'offre' : 'Nouvelle offre'),
          champ('Titre', f.titre), champ('Détail', f.texte),
          h('div', { class: 'duo' }, champ('Début', f.debut), champ('Fin', f.fin)),
          h('label', { class: 'case' }, f.actif, 'Offre active'), err, h('div', { class: 'actions' }, btn,
            edition && h('button', { class: 'btn', type: 'button', onclick: () => dessiner(null) }, 'Annuler')));
        remplacer(zone, form, h('hr'), h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
          h('thead', {}, h('tr', {}, ['Offre', 'Période', 'Boutiques ayant vu', 'Ayant cliqué', ''].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'num' : '' }, t)))),
          h('tbody', {}, liste.length ? liste.map((o) => h('tr', {},
            h('td', {}, h('strong', {}, o.titre), !o.actif && h('span', { class: 'puce' }, 'Inactive'), o.texte && h('small', { class: 'bloc-pt' }, o.texte)),
            h('td', {}, `${dateFr(o.debut)}${o.fin ? ' → ' + dateFr(o.fin) : ''}`), h('td', { class: 'num' }, nombre(o.vues)), h('td', { class: 'num' }, nombre(o.clics)),
            h('td', {}, h('div', { class: 'actions-ligne' },
              h('button', { class: 'btn petit', type: 'button', onclick: () => dessiner(o) }, 'Modifier'),
              h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => {
                if (!confirm(`Supprimer l'offre « ${o.titre} » ?`)) return;
                await api(`/offres/${o.id}`, { method: 'DELETE' }); await dessiner(null); await charger();
              }) }, 'Supprimer'))))) : [h('tr', {}, h('td', { colspan: 5, class: 'aide' }, 'Aucune offre.'))]))));
      }
      await dessiner(null);
    }

    async function commandes(s) {
      const liste = await api(`/sponsors/${s.id}/commandes`);
      modale(`Commandes de réassort — ${s.nom}`, liste.length
        ? h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
          h('thead', {}, h('tr', {}, ['Date', 'Boutique', 'Produits', 'Message'].map((t) => h('th', {}, t)))),
          h('tbody', {}, liste.map((c) => h('tr', {}, h('td', {}, c.cree_le),
            h('td', {}, h('strong', {}, c.entreprise), c.telephone && h('small', { class: 'bloc-pt' }, c.telephone)),
            h('td', {}, c.lignes.map((l) => `${l.nom} × ${l.quantite} ${l.unite}`).join(', ')), h('td', {}, c.note || '—'))))))
        : h('p', { class: 'aide' }, 'Aucune commande pour le moment.'), { large: true });
    }

    function rapport(s) {
      const adresse = (j) => `${location.origin}/sponsor/${j}`;
      const code = h('code', {}, adresse(s.jeton_rapport));
      const zone = h('div', {},
        h('p', {}, 'Cette adresse donne accès au rapport de statistiques anonymes du partenaire, sans mot de passe. Envoyez-la uniquement à la personne concernée.'),
        h('div', { class: 'copie' }, code,
          h('button', { class: 'btn petit', type: 'button', onclick: () => navigator.clipboard && navigator.clipboard.writeText(code.textContent).then(() => toast('Adresse copiée.')) }, 'Copier')),
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: adresse(s.jeton_rapport), target: '_blank', rel: 'noopener' }, 'Ouvrir le rapport'),
          h('button', { class: 'btn', type: 'button', onclick: () => agir(null, async () => {
            if (!confirm('Créer une nouvelle adresse ? L\'ancienne cessera de fonctionner immédiatement.')) return;
            const r = await api(`/sponsors/${s.id}/jeton`, { method: 'POST' });
            s.jeton_rapport = r.jeton_rapport; code.textContent = adresse(r.jeton_rapport); toast('Nouvelle adresse créée.');
          }) }, 'Renouveler l\'adresse')));
      modale(`Rapport — ${s.nom}`, zone);
    }

    remplacer(vue, h('h1', {}, 'Sponsors'),
      h('p', { class: 'aide' }, 'Marques et distributeurs partenaires : présentation, offres, commandes de réassort et rapport de statistiques anonymes. Ajoutez un partenaire seulement après son accord écrit.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primaire', type: 'button', onclick: () => formulaire(null) }, 'Nouveau partenaire')),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
        h('thead', {}, h('tr', {}, ['Partenaire', 'Contrat', 'État', 'Réseau', 'Commandes', ''].map((t, i) => h('th', { class: i === 4 ? 'num' : '' }, t)))), corps)));
    await charger();
  };

  VUES.parametres = async (vue) => {
    const { parametres: P, webhook_kkiapay: webhook, webhook_fedapay: webhookFeda } = await api('/parametres');
    const saisies = {};   // clé -> input
    const aEffacer = new Set();

    const puce = (k) => { const [t, c] = SOURCES[P[k].source] || SOURCES.null; return h('span', { class: `puce ${c}` }, t); };

    // Champ de clé secrète : jamais pré-rempli ; vide = conserver la valeur actuelle
    function cleSecrete(k, libelle, aide) {
      const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': libelle,
        placeholder: P[k].definie ? `Enregistrée (${P[k].apercu}) — laisser vide pour conserver` : 'Coller la clé ici' });
      saisies[k] = input;
      return h('div', { class: 'param' },
        h('div', { class: 'param-tete' }, h('label', {}, libelle), puce(k)),
        h('div', { class: 'ligne' }, input,
          P[k].source === 'admin' && h('button', { class: 'btn', type: 'button', onclick: (e) => {
            if (!confirm(`Effacer la ${libelle.toLowerCase()} enregistrée ?`)) return;
            aEffacer.add(k);
            input.value = '';
            input.disabled = true;
            input.placeholder = 'Sera effacée à l\'enregistrement';
            e.currentTarget.disabled = true;
          } }, 'Effacer')),
        aide && h('small', {}, aide));
    }

    function champTexte(k, libelle, aide, type = 'text') {
      const input = h('input', { type, value: P[k].valeur || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': libelle });
      saisies[k] = input;
      return h('div', { class: 'param' }, h('div', { class: 'param-tete' }, h('label', {}, libelle), puce(k)), input, aide && h('small', {}, aide));
    }

    const sandbox = h('input', { type: 'checkbox', checked: P.kkiapay_sandbox.valeur !== 'false' });
    const sandboxFeda = h('input', { type: 'checkbox', checked: P.fedapay_sandbox.valeur !== 'false' });
    const entier = (k, libelle, aide) => {
      const input = h('input', { type: 'number', inputmode: 'numeric', step: 1, value: P[k].valeur, 'aria-label': libelle });
      saisies[k] = input;
      return h('div', { class: 'param' }, h('div', { class: 'param-tete' }, h('label', {}, libelle)), input, aide && h('small', {}, aide));
    };

    const btn = h('button', { class: 'btn primaire gros', type: 'submit' }, 'Enregistrer les paramètres');
    const form = h('form', { novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      agir(btn, async () => {
        const valeurs = {};
        const effacer = [...aEffacer];
        for (const [k, input] of Object.entries(saisies)) {
          if (input.disabled) continue;
          const v = input.value.trim();
          if (P[k].secret) { if (v) valeurs[k] = v; }
          else if (v === '') { if (P[k].source === 'admin' && !(k in P && typeof P[k].valeur === 'string' && /^\d+$/.test(P[k].valeur))) effacer.push(k); }
          else if (v !== String(P[k].valeur || '')) valeurs[k] = v;
        }
        if (String(sandbox.checked) !== String(P.kkiapay_sandbox.valeur !== 'false')) valeurs.kkiapay_sandbox = sandbox.checked;
        if (String(sandboxFeda.checked) !== String(P.fedapay_sandbox.valeur !== 'false')) valeurs.fedapay_sandbox = sandboxFeda.checked;
        if (!Object.keys(valeurs).length && !effacer.length) { toast('Aucune modification à enregistrer.'); return; }
        await api('/parametres', { method: 'PUT', body: { valeurs, effacer } });
        toast('Paramètres enregistrés.');
        await VUES.parametres(vue);
      });
    } },
      h('section', { class: 'carte' }, h('h2', {}, 'Paiement KkiaPay'),
        h('p', { class: 'aide' }, 'Ces clés se trouvent dans votre tableau de bord KkiaPay, menu Développeurs → Clés API. Elles sont chiffrées avant d\'être enregistrées et ne sont plus jamais affichées.'),
        champTexte('kkiapay_public_key', 'Clé publique', 'Visible par les navigateurs : elle sert à ouvrir la fenêtre de paiement.'),
        cleSecrete('kkiapay_private_key', 'Clé privée', 'Utilisée uniquement par le serveur pour vérifier chaque paiement.'),
        cleSecrete('kkiapay_secret', 'Clé secrète API', 'Clé secrète du compte KkiaPay. Elle sert aussi à authentifier les notifications (webhook) envoyées par KkiaPay.'),
        h('div', { class: 'param' }, h('label', { class: 'case' }, sandbox, 'Mode test (sandbox) — aucun vrai argent n\'est débité'),
          h('small', {}, 'Décochez-le uniquement avec vos clés de production.')),
        h('div', { class: 'param' }, h('div', { class: 'param-tete' }, h('label', {}, 'Adresse de notification (webhook) à saisir dans KkiaPay')),
          h('div', { class: 'copie' }, h('code', {}, R.origine() + webhook),
            h('button', { class: 'btn petit', type: 'button', onclick: () => navigator.clipboard && navigator.clipboard.writeText(R.origine() + webhook).then(() => toast('Adresse copiée.')) }, 'Copier')))),
      h('section', { class: 'carte' }, h('h2', {}, 'Paiement FedaPay'),
        h('p', { class: 'aide' }, 'Ces clés se trouvent dans votre tableau de bord FedaPay, menu Paramètres → Clés API. Elles sont chiffrées avant d\'être enregistrées et ne sont plus jamais affichées.'),
        champTexte('fedapay_public_key', 'Clé publique (pk_…)', 'Visible par les navigateurs : elle sert à ouvrir la fenêtre de paiement.'),
        cleSecrete('fedapay_secret_key', 'Clé secrète (sk_…)', 'Utilisée uniquement par le serveur pour vérifier chaque paiement auprès de FedaPay.'),
        cleSecrete('fedapay_webhook_secret', 'Secret du webhook (facultatif)', 'Le serveur revérifie de toute façon chaque transaction auprès de FedaPay.'),
        h('div', { class: 'param' }, h('label', { class: 'case' }, sandboxFeda, 'Mode test (sandbox) — aucun vrai argent n\'est débité'),
          h('small', {}, 'Décochez-le uniquement avec vos clés de production (pk_live_… / sk_live_…).')),
        h('div', { class: 'param' }, h('div', { class: 'param-tete' }, h('label', {}, 'Adresse de notification (webhook) à saisir dans FedaPay')),
          h('div', { class: 'copie' }, h('code', {}, R.origine() + webhookFeda),
            h('button', { class: 'btn petit', type: 'button', onclick: () => navigator.clipboard && navigator.clipboard.writeText(R.origine() + webhookFeda).then(() => toast('Adresse copiée.')) }, 'Copier')))),
      h('section', { class: 'carte' }, h('h2', {}, 'Abonnement'),
        entier('abonnement_prix', 'Prix mensuel (F CFA)', 'Formule mensuelle. Un changement s\'applique aux paiements suivants.'),
        entier('abonnement_jours', 'Durée mensuelle (jours)', 'Durée accordée par paiement mensuel.'),
        entier('abonnement_prix_annuel', 'Prix annuel (F CFA)', 'Formule annuelle.'),
        entier('abonnement_jours_annuel', 'Durée annuelle (jours)', 'Durée accordée par paiement annuel (365 par défaut).'),
        entier('essai_jours', 'Jours d\'essai gratuit à l\'inscription', '0 = aucun essai : l\'entreprise doit payer pour commencer.')),
      btn);
    remplacer(vue, h('h1', {}, 'Paramètres'), form);
  };

  // ---------- Mon compte ----------
  VUES.compte = async (vue) => {
    const ancien = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
    const nouveau = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
    const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Changer le mot de passe');
    remplacer(vue, h('h1', {}, 'Mon compte'),
      h('form', { class: 'carte', novalidate: true, onsubmit: (e) => {
        e.preventDefault();
        agir(btn, async () => {
          await api('/mot-de-passe', { method: 'POST', body: { ancien: ancien.value, nouveau: nouveau.value } });
          ancien.value = ''; nouveau.value = '';
          toast('Mot de passe modifié.');
        });
      } },
        h('p', {}, `Connecté en tant que ${state.admin.nom_complet} (${state.admin.email}).`),
        champ('Mot de passe actuel', ancien), champ('Nouveau mot de passe (10 caractères minimum)', nouveau), btn));
  };

  // ---------- Démarrage ----------
  async function demarrer() {
    try {
      state.admin = (await api('/me')).admin;
    } catch (e) {
      state.token = null;
      return afficherConnexion();
    }
    afficherCoque();
    await router();
    ouvrirTempsReel();
  }

  window.addEventListener('hashchange', router);
  if (state.token) demarrer(); else afficherConnexion();
})();
