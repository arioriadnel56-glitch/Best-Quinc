// Espace Administrateur financier et commercial : tableau de bord, abonnements, agrégateurs, relances, dépenses, tarifs, départs.
(window.BQA_MODULES = window.BQA_MODULES || []).push((A) => {
  'use strict';
  const { h, api, toast, agir, remplacer, ui, nombre, fcfa, dateFr, state, router } = A;
  const V = A.vues.finance;
  A.menus.finance = [
    'Pilotage', ['tableau', 'Tableau de bord'], ['abonnements', 'Abonnements'], ['paiements', 'Paiements et reçus'], ['agregateurs', 'Agrégateurs de paiement'],
    'Clients', ['relances', 'Relances'], ['difficultes', 'Entreprises en difficulté'], ['departs', 'Départs et résiliations'],
    'Budget', ['depenses', 'Dépenses et budgets'], ['tarifs', 'Tarifs et rentabilité'],
    'Suivi', ['demandes', 'Mes demandes'], ['compte', 'Mon compte'],
  ];
  const ETATS = { actif: ['Actif', 'ok'], expire: ['Expiré', 'alerte'], suspendu: ['Suspendu', 'alerte'], resilie: ['Résilié', ''], aucun: ['Aucun', ''] };
  const CATEGORIES = [['hebergement', 'Hébergement'], ['domaine', 'Domaine'], ['serveur', 'Serveur'], ['service_externe', 'Service externe'], ['autre', 'Autre']];
  const libCat = Object.fromEntries(CATEGORIES);
  const mois = (m) => `${m.slice(5)}/${m.slice(2, 4)}`;

  let cacheEntreprises = null;
  async function entreprises() {
    if (!cacheEntreprises) cacheEntreprises = (await api('/entreprises')).map((e) => [String(e.id), e.nom]);
    return cacheEntreprises;
  }
  const selectEnt = async (valeur) => h('select', { 'aria-label': 'Entreprise' }, (await entreprises()).map(([v, l]) => h('option', { value: v, selected: v === String(valeur) }, l)));

  // ---------- Tableau de bord ----------
  A.partage.financeTableau = async (vue) => {
    const d = await api('/finance/dashboard');
    remplacer(vue, h('h1', {}, 'Tableau de bord financier'),
      h('div', { class: 'stats egales' },
        ui.stat('Chiffre d\'affaires', fcfa(d.revenus.total), `${fcfa(d.revenus.mois)} encaissés ce mois-ci`),
        ui.stat('Revenus des abonnements (mois)', fcfa(d.revenus.mois), `${nombre(d.revenus.nb_mois)} paiement(s) · dont annuels ${fcfa(d.revenus.mois_annuel)}`),
        ui.stat('Dépenses du mois', fcfa(d.depenses.mois), d.depenses.en_attente_validation ? `${d.depenses.en_attente_validation} en attente de validation` : 'hébergement, domaines, services'),
        ui.stat('Résultat du mois', fcfa(d.resultat_mois), 'revenus − dépenses', d.resultat_mois < 0)),
      h('div', { class: 'stats egales' },
        ui.stat('Paiements reçus (mois)', nombre(d.revenus.nb_mois)),
        ui.stat('Paiements en attente', nombre(d.paiements.en_attente), `${fcfa(d.paiements.montant_attente)} · ${nombre(d.paiements.echoues)} échoué(s) sur 30 jours`, d.paiements.en_attente > 0),
        ui.stat('Abonnements expirés', nombre(d.abonnements.expires), `${nombre(d.abonnements.impayes)} impayé(s) · ${nombre(d.abonnements.suspendus)} suspendu(s)`, d.abonnements.expires > 0),
        ui.stat('Entreprises à relancer', nombre(d.abonnements.a_relancer), h('a', { href: '#/relances' }, `${nombre(d.relances_a_traiter)} relance(s) à traiter`), d.abonnements.a_relancer > 0)),
      h('section', { class: 'carte' }, h('h2', {}, 'Revenus et dépenses — 6 derniers mois'),
        ui.barres(d.serie.map((s) => ({ libelle: mois(s.mois), revenus: s.revenus, depenses: s.depenses })), [{ cle: 'revenus', nom: 'Revenus', classe: '' }, { cle: 'depenses', nom: 'Dépenses', classe: 'depense' }], 'Revenus et dépenses')));
  };
  V.tableau = (vue) => A.partage.financeTableau(vue);

  // ---------- Abonnements (partagé avec le Super admin) ----------
  A.partage.abonnements = async (vue, { super: estSuper = false } = {}) => {
    const etat = h('select', { 'aria-label': 'État', onchange: charger },
      h('option', { value: '' }, 'Tous les états'), ...['actif', 'expire', 'impaye', 'suspendu', 'resilie', 'aucun'].map((e) => h('option', { value: e }, e === 'impaye' ? 'Impayés' : ETATS[e][0])));
    const q = h('input', { type: 'search', placeholder: 'Chercher une entreprise', 'aria-label': 'Chercher' });
    q.addEventListener('input', ui.debounce(() => charger()));
    const zone = h('div'); const formules = h('div', { class: 'stats egales' });
    async function charger() {
      const d = await api(`/finance/abonnements?etat=${encodeURIComponent(etat.value)}&q=${encodeURIComponent(q.value)}`);
      formules.replaceChildren(...d.formules.map((f) => ui.stat(`Formule ${f.label.toLowerCase()}`, fcfa(f.prix), `${f.jours} jours`)));
      zone.replaceChildren(ui.tableau(['Entreprise', 'Période', 'Reste', 'État', 'Paiements', ''], d.entreprises.map((e) => {
        const [lib, cls] = ETATS[e.etat] || [e.etat, ''];
        return [h('div', {}, h('strong', {}, e.nom), h('small', { class: 'bloc-pt' }, e.email || '—')),
          e.date_debut ? `${dateFr(e.date_debut)} → ${dateFr(e.date_fin)}${e.montant === 0 ? ' (offert)' : ''}` : '—',
          e.jours_restants === null || e.jours_restants === undefined ? '—' : (e.jours_restants >= 0 ? `${e.jours_restants} j` : `expiré depuis ${-e.jours_restants} j`),
          h('span', {}, ui.puce(lib, cls), e.paiements_en_souffrance > 0 && ui.puce(`${e.paiements_en_souffrance} non réglé(s)`, 'alerte')),
          `${nombre(e.nb_paiements)}${e.dernier_paiement ? ` · dernier le ${dateFr(e.dernier_paiement)}` : ''}`,
          h('div', { class: 'actions-ligne' },
            h('button', { class: 'btn petit', type: 'button', onclick: () => historique(e) }, 'Historique'),
            !e.cloturee && h('button', { class: 'btn petit', type: 'button', onclick: () => nouvelleRelance(e.entreprise_id) }, 'Relancer'),
            estSuper && h('button', { class: 'btn petit', type: 'button', onclick: () => offrir(e) }, 'Offrir des jours'),
            estSuper && e.abonnement_id && ['actif', 'suspendu'].includes(e.abo_statut) && h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => {
              const suspendre = e.abo_statut === 'actif';
              if (!(await ui.confirmer(suspendre ? 'Suspendre cet abonnement ?' : 'Réactiver cet abonnement ?', e.nom))) return;
              await api(`/super/abonnements/${e.abonnement_id}/statut`, { method: 'PUT', body: { statut: suspendre ? 'suspendu' : 'actif' } }); toast('Abonnement mis à jour.'); await charger();
            }) }, e.abo_statut === 'actif' ? 'Suspendre' : 'Réactiver'))];
      }), { vide: 'Aucune entreprise.' }));
    }
    async function historique(e) {
      const l = await api(`/finance/entreprises/${e.entreprise_id}/paiements`);
      A.modale(`Paiements — ${e.nom}`, ui.tableau(['Date', 'Formule', 'Moyen', 'Montant', 'État'], l.map((p) => [p.cree_le, p.plan === 'annuel' ? 'Annuel' : 'Mensuel', p.agregateur, fcfa(p.montant), ui.puce({ reussi: 'Réussi', en_attente: 'Non finalisé', echoue: 'Échoué' }[p.statut] || p.statut, p.statut === 'reussi' ? 'ok' : p.statut === 'echoue' ? 'alerte' : '')]), { vide: 'Aucun paiement.', num: [3] }), { large: true });
    }
    function offrir(e) {
      ui.formulaire(`Offrir des jours à ${e.nom}`, [{ nom: 'jours', libelle: 'Nombre de jours', type: 'number', valeur: 30, min: 1, max: 366 }], async (v, d) => {
        const r = await api(`/entreprises/${e.entreprise_id}/offrir`, { method: 'POST', body: { jours: Number(v.jours) } });
        d.close(); toast(`Abonnement prolongé jusqu'au ${dateFr(r.date_fin)}.`); await charger();
      }, { bouton: 'Offrir' });
    }
    remplacer(vue, h('h1', {}, 'Abonnements'), formules, h('div', { class: 'filtres' }, etat, q), zone,
      !estSuper && h('p', { class: 'aide' }, 'Une prolongation exceptionnelle se demande depuis « Entreprises en difficulté » : seul le Super administrateur peut la valider.'));
    await charger();
  };
  V.abonnements = (vue) => A.partage.abonnements(vue);

  // ---------- Paiements, factures et reçus ----------
  V.paiements = async (vue) => {
    const STATUTS = { reussi: ['Réussi', 'ok'], en_attente: ['Non finalisé', ''], echoue: ['Échoué', 'alerte'] };
    const filtre = h('select', { 'aria-label': 'État', onchange: charger }, h('option', { value: '' }, 'Tous les états'), h('option', { value: 'reussi' }, 'Réussis'), h('option', { value: 'en_attente' }, 'Non finalisés'), h('option', { value: 'echoue' }, 'Échoués'));
    const zone = h('div');
    async function charger() {
      const l = await api(`/paiements?statut=${encodeURIComponent(filtre.value)}`);
      zone.replaceChildren(ui.tableau(['Date', 'Entreprise', 'Formule', 'Moyen', 'Transaction', 'Montant', 'État', 'Document'], l.map((p) => {
        const [lib, cls] = STATUTS[p.statut] || [p.statut, ''];
        const dl = (type) => agir(null, () => ui.telecharger(`/finance/paiements/${p.id}/document?type=${type}`, { nom: `${type}.pdf` }));
        return [p.cree_le, p.entreprise, p.plan === 'annuel' ? 'Annuel' : 'Mensuel', p.agregateur, p.reference_transaction ? h('span', { class: 'mono' }, p.reference_transaction) : '—', fcfa(p.montant), ui.puce(lib, cls),
          h('div', { class: 'actions-ligne' }, p.statut === 'reussi' && h('button', { class: 'btn petit', type: 'button', onclick: () => dl('recu') }, 'Reçu'), h('button', { class: 'btn petit', type: 'button', onclick: () => dl('facture') }, 'Facture'))];
      }), { vide: 'Aucun paiement.', num: [5] }));
    }
    remplacer(vue, h('h1', {}, 'Paiements et reçus'), h('div', { class: 'filtres' }, filtre), zone, h('p', { class: 'aide' }, 'Les 200 derniers paiements. Chaque reçu ou facture généré est enregistré dans le journal d\'audit.'));
    await charger();
  };

  // ---------- Agrégateurs de paiement ----------
  V.agregateurs = async (vue) => {
    const zone = h('div', { class: 'deux-col' });
    async function charger() {
      const l = await api('/finance/agregateurs');
      zone.replaceChildren(...l.map(carte));
    }
    function carte(p) {
      const urls = { url_service: h('input', { type: 'url', value: p.url_service || '', placeholder: 'https://…' }), url_callback: h('input', { type: 'url', value: p.url_callback || '', placeholder: 'https://…' }), url_webhook: h('input', { type: 'url', value: p.url_webhook || '', placeholder: p.webhook_defaut }) };
      const notes = h('textarea', { rows: 2, maxlength: 500 }); notes.value = p.notes || '';
      const champs = {};
      const lignesCles = p.champs.map((c) => {
        const id = c.cle;
        if (c.cle.endsWith('_sandbox')) { const s = h('select', {}, h('option', { value: 'true', selected: c.valeur !== 'false' }, 'Mode test (aucun vrai paiement)'), h('option', { value: 'false', selected: c.valeur === 'false' }, 'Production')); champs[id] = s; return A.champ('Environnement', s); }
        const el = h('input', { type: c.secret ? 'password' : 'text', autocomplete: 'off', value: c.secret ? '' : (c.valeur || ''), placeholder: c.secret ? (c.definie ? `${c.apercu} — laisser vide pour conserver` : 'Non définie') : '' });
        champs[id] = el;
        return A.champ(id.replace(/_/g, ' '), el, c.secret ? (c.definie ? 'Enregistrée et chiffrée. Jamais réaffichée.' : 'Sera chiffrée avant enregistrement.') : null);
      });
      const st = p.stats;
      return h('section', { class: 'carte' }, h('h2', {}, p.libelle, p.actif ? ui.puce('Actif', 'ok') : ui.puce('Inactif', 'alerte'), !p.operationnel && ui.puce('Intégration à venir'), p.operationnel && (p.configure ? ui.puce('Clés présentes', 'ok') : ui.puce('Clés manquantes', 'alerte'))),
        h('p', { class: 'petit-texte' }, `${nombre(st.total)} transaction(s) · ${nombre(st.reussis)} réussie(s) · ${nombre(st.echoues)} échouée(s) · ${nombre(st.en_attente)} non finalisée(s) · ${fcfa(st.montant)} encaissés`),
        h('div', { class: 'actions-ligne' },
          h('button', { class: 'btn petit', type: 'button', onclick: () => transactions(p) }, 'Transactions'),
          h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => {
            const veut = !p.actif;
            if (!(await ui.confirmer(veut ? `Activer ${p.libelle} ?` : `Désactiver ${p.libelle} ?`, veut ? 'Les entreprises pourront payer avec ce fournisseur.' : 'Les nouveaux paiements ne l\'utiliseront plus (les paiements en cours restent confirmables).'))) return;
            const r = await api(`/finance/agregateurs/${p.code}/activation`, { method: 'POST', body: { actif: veut } });
            toast(r.applique ? 'Fournisseur mis à jour.' : 'Demande envoyée au Super administrateur.'); await charger();
          }) }, p.actif ? 'Désactiver' : 'Activer')),
        h('h3', {}, 'Adresses'), A.champ('URL du service', urls.url_service), A.champ('URL de callback', urls.url_callback), A.champ('URL du webhook', urls.url_webhook, `Adresse à saisir chez le fournisseur : ${p.webhook_defaut}`), A.champ('Notes', notes),
        h('button', { class: 'btn', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
          await api(`/finance/agregateurs/${p.code}`, { method: 'PUT', body: { url_service: urls.url_service.value, url_callback: urls.url_callback.value, url_webhook: urls.url_webhook.value, notes: notes.value } }); toast('Adresses enregistrées.');
        }) }, 'Enregistrer les adresses'),
        h('h3', {}, 'Clés et identifiants'), lignesCles,
        h('button', { class: 'btn primaire', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
          const valeurs = {}; for (const [k, el] of Object.entries(champs)) valeurs[k] = el.value;
          if (!(await ui.confirmer('Enregistrer les clés ?', 'Les clés sont chiffrées avant l\'enregistrement et ne seront plus jamais affichées en clair. L\'opération est journalisée (sans les valeurs).'))) return;
          await api(`/finance/agregateurs/${p.code}/cles`, { method: 'PUT', body: { valeurs } }); toast('Clés enregistrées.'); await charger();
        }) }, 'Enregistrer les clés'));
    }
    async function transactions(p) {
      const l = await api(`/finance/agregateurs/${p.code}/transactions`);
      A.modale(`Transactions — ${p.libelle}`, ui.tableau(['Date', 'Entreprise', 'Référence', 'Montant', 'État'], l.map((t) => [t.cree_le, t.entreprise, t.reference_transaction ? h('span', { class: 'mono' }, t.reference_transaction) : '—', fcfa(t.montant), ui.puce({ reussi: 'Réussi', en_attente: 'Non finalisé', echoue: 'Échoué' }[t.statut] || t.statut, t.statut === 'reussi' ? 'ok' : t.statut === 'echoue' ? 'alerte' : '')]), { vide: 'Aucune transaction.', num: [3] }), { large: true });
    }
    remplacer(vue, h('h1', {}, 'Agrégateurs de paiement'), h('p', { class: 'aide' }, 'KkiaPay et FedaPay sont opérationnels. CinetPay : les clés peuvent déjà être préparées, l\'adaptateur de paiement reste à développer. L\'activation d\'un fournisseur est soumise à l\'autorisation du Super administrateur.'), zone);
    await charger();
  };

  // ---------- Relances ----------
  async function nouvelleRelance(entrepriseId, type = 'manuelle') {
    const ent = await selectEnt(entrepriseId);
    const canal = h('select', {}, h('option', { value: 'email' }, 'E-mail'), h('option', { value: 'whatsapp' }, 'WhatsApp (lien à ouvrir)'));
    const typ = h('select', {}, [['manuelle', 'Rappel libre'], ['avant_expiration', 'Avant expiration'], ['apres_expiration', 'Après expiration'], ['impaye', 'Impayé']].map(([v, l]) => h('option', { value: v, selected: v === type }, l)));
    const quand = h('input', { type: 'datetime-local' });
    const msg = h('textarea', { rows: 4, maxlength: 2000, placeholder: 'Laisser vide pour utiliser le message type' });
    const btn = h('button', { class: 'btn primaire', type: 'submit' }, 'Créer la relance');
    const d = A.modale('Nouvelle relance', h('form', { novalidate: true, onsubmit: (ev) => {
      ev.preventDefault();
      agir(btn, async () => {
        const r = await api('/finance/relances', { method: 'POST', body: { entreprise_id: Number(ent.value), canal: canal.value, type: typ.value, message: msg.value, programmee_le: quand.value ? new Date(quand.value).toISOString() : undefined } });
        d.close(); toast(r.envoi ? (r.envoi.ok ? 'Relance envoyée.' : `Relance créée, envoi impossible : ${r.envoi.erreur}`) : 'Relance enregistrée.'); if (location.hash.includes('relances')) router();
      });
    } }, A.champ('Entreprise', ent), A.champ('Canal', canal), A.champ('Type', typ), A.champ('Programmer (facultatif)', quand, 'Vide = maintenant'), A.champ('Message', msg), btn));
  }

  V.relances = async (vue) => {
    const [aRelancer, liste] = await Promise.all([api('/finance/relances/a-relancer'), api('/finance/relances')]);
    const LIB = { programmee: ['Programmée', ''], en_cours: ['En cours', ''], envoyee: ['Envoyée', 'ok'], echec: ['Échec', 'alerte'], annulee: ['Annulée', ''] };
    const TYPES = { avant_expiration: 'Avant expiration', apres_expiration: 'Après expiration', impaye: 'Impayé', manuelle: 'Libre' };
    remplacer(vue, h('h1', {}, 'Relances d\'abonnement'),
      !liste.email_configure && h('section', { class: 'carte attention' }, h('p', {}, h('strong', {}, 'E-mail non configuré. '), 'Les relances restent programmées mais ne partent pas : renseignez EMAIL_API_KEY et EMAIL_FROM (voir GOUVERNANCE-ADMIN.md). Les liens WhatsApp fonctionnent sans configuration.')),
      h('div', { class: 'filtres' },
        h('button', { class: 'btn primaire', type: 'button', onclick: () => nouvelleRelance() }, 'Nouvelle relance'),
        h('button', { class: 'btn', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => { const r = await api('/finance/relances/traiter', { method: 'POST' }); toast(`${r.planifiees} planifiée(s), ${r.envoyees} envoyée(s), ${r.echecs} échec(s).${r.note ? ' ' + r.note : ''}`); router(); }) }, 'Planifier et envoyer les relances dues')),
      h('section', { class: 'carte' }, h('h2', {}, 'Entreprises à relancer'), h('p', { class: 'petit-texte' }, 'Abonnement finissant sous 7 jours, ou expiré depuis moins de 60 jours.'),
        ui.tableau(['Entreprise', 'Fin', 'Dernière relance', ''], aRelancer.map((e) => [h('div', {}, h('strong', {}, e.nom), e.en_difficulte && ui.puce('En difficulté', 'alerte')), `${dateFr(e.date_fin)} (${e.jours_restants >= 0 ? `dans ${e.jours_restants} j` : `il y a ${-e.jours_restants} j`})`, e.derniere_relance ? dateFr(e.derniere_relance) : 'jamais',
          h('button', { class: 'btn petit', type: 'button', onclick: () => nouvelleRelance(e.id, e.jours_restants >= 0 ? 'avant_expiration' : 'apres_expiration') }, 'Relancer')]), { vide: 'Aucune entreprise à relancer.' })),
      h('section', { class: 'carte' }, h('h2', {}, 'Historique des relances'),
        ui.tableau(['Programmée', 'Entreprise', 'Canal / type', 'État', 'Réponse', ''], liste.relances.map((r) => {
          const [lib, cls] = LIB[r.statut] || [r.statut, ''];
          return [r.programmee_le, r.entreprise, `${r.canal === 'email' ? 'E-mail' : 'WhatsApp'} · ${TYPES[r.type] || r.type}`, h('span', {}, ui.puce(lib, cls), r.erreur && h('small', { class: 'bloc-pt' }, r.erreur)), r.reponse || '—',
            h('div', { class: 'actions-ligne' },
              r.canal === 'email' && ['programmee', 'echec'].includes(r.statut) && h('button', { class: 'btn petit', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => { await api(`/finance/relances/${r.id}/envoyer`, { method: 'POST' }); toast('Relance envoyée.'); router(); }) }, 'Envoyer'),
              r.lien_whatsapp && r.statut !== 'envoyee' && h('a', { class: 'btn petit', href: r.lien_whatsapp, target: '_blank', rel: 'noopener', onclick: () => agir(null, async () => { await api(`/finance/relances/${r.id}`, { method: 'PUT', body: { statut: 'envoyee' } }); }) }, 'Ouvrir WhatsApp'),
              h('button', { class: 'btn petit', type: 'button', onclick: () => ui.formulaire('Réponse de l\'entreprise', [{ nom: 'reponse', libelle: 'Réponse reçue', type: 'textarea', valeur: r.reponse || '' }], async (v, d) => { await api(`/finance/relances/${r.id}`, { method: 'PUT', body: { reponse: v.reponse } }); d.close(); router(); }) }, 'Réponse'),
              ['programmee', 'echec'].includes(r.statut) && h('button', { class: 'btn petit', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => { await api(`/finance/relances/${r.id}`, { method: 'PUT', body: { statut: 'annulee' } }); router(); }) }, 'Annuler'))];
        }), { vide: 'Aucune relance.' })));
  };

  // ---------- Entreprises en difficulté ----------
  V.difficultes = async (vue) => {
    const l = await api('/finance/difficultes');
    async function enregistrer() {
      const ent = await selectEnt();
      ui.formulaire('Enregistrer une situation', [{ nom: 'situation', libelle: 'Situation de l\'entreprise', type: 'textarea', placeholder: 'Ex. : trésorerie bloquée jusqu\'à la fin du mois, promesse de paiement…' }, { nom: 'delai_jours', libelle: 'Délai supplémentaire proposé (jours)', type: 'number', min: 1, max: 180, valeur: 15 }],
        async (v, d) => { await api('/finance/difficultes', { method: 'POST', body: { entreprise_id: Number(ent.value), situation: v.situation, delai_jours: v.delai_jours ? Number(v.delai_jours) : undefined } }); d.close(); toast('Situation enregistrée.'); router(); },
        { intro: undefined }).querySelector('.modale-corps form').prepend(A.champ('Entreprise', ent));
    }
    remplacer(vue, h('h1', {}, 'Entreprises en difficulté'), h('p', { class: 'aide' }, 'Vous enregistrez la situation et proposez un délai. La prolongation exceptionnelle est soumise au Super administrateur, seul à pouvoir la valider.'),
      h('div', { class: 'filtres' }, h('button', { class: 'btn primaire', type: 'button', onclick: enregistrer }, 'Enregistrer une situation')),
      ui.tableau(['Date', 'Entreprise', 'Situation', 'Délai proposé', 'Suivi', ''], l.map((d) => [d.cree_le, d.entreprise, d.situation, d.delai_jours ? `${d.delai_jours} j` : '—',
        d.statut === 'resolue' ? ui.puce('Résolu', 'ok') : (d.demande_statut ? ui.puce(ui.statutDem(d.demande_statut)[0], ui.statutDem(d.demande_statut)[1]) : ui.puce('Ouvert')),
        d.statut === 'ouverte' && d.demande_statut !== 'en_attente' && h('button', { class: 'btn petit', type: 'button', onclick: () => ui.formulaire(`Prolongation pour ${d.entreprise}`, [{ nom: 'jours', libelle: 'Jours demandés', type: 'number', min: 1, max: 180, valeur: d.delai_jours || 15 }],
          async (v, dlg) => { await api(`/finance/difficultes/${d.id}/prolongation`, { method: 'POST', body: { jours: Number(v.jours) } }); dlg.close(); toast('Demande envoyée au Super administrateur.'); router(); }, { bouton: 'Soumettre au Super administrateur' }) }, 'Demander une prolongation')]), { vide: 'Aucun dossier.' }));
  };

  // ---------- Départs d'agents et résiliations d'entreprises ----------
  V.departs = async (vue) => {
    const entA = await selectEnt(); const agent = h('select', { 'aria-label': 'Agent' }); const motifA = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Motif du départ' }); const zoneA = h('div');
    const entR = await selectEnt(); const motifR = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Motif de la résiliation' }); const zoneR = h('div');
    async function agents() {
      if (!entA.value) return;
      const l = await api(`/finance/departs/agents?entreprise_id=${entA.value}`);
      agent.replaceChildren(...l.filter((a) => a.actif).map((a) => h('option', { value: a.id }, `${a.nom_complet} (${a.role})`)));
      zoneA.replaceChildren();
    }
    entA.addEventListener('change', () => agir(null, agents));
    const verif = (v) => [h('p', {}, h('strong', {}, 'Vérifications préalables')), A.partage.verification(v)];
    remplacer(vue, h('h1', {}, 'Départs et résiliations'),
      h('p', { class: 'aide' }, 'Les accès ne sont révoqués et le compte clôturé qu\'après validation du Super administrateur. L\'historique des opérations est toujours conservé.'),
      h('div', { class: 'deux-col' },
        h('section', { class: 'carte' }, h('h2', {}, 'Départ d\'un agent'), A.champ('Entreprise', entA), A.champ('Agent', agent), A.champ('Motif', motifA), zoneA,
          h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => { const v = await api(`/finance/departs/verification?entreprise_id=${entA.value}&utilisateur_id=${agent.value}`); zoneA.replaceChildren(...verif(v)); }) }, 'Vérifier'),
            h('button', { class: 'btn primaire', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
              if (!(await ui.confirmer('Soumettre le départ ?', 'La demande est envoyée au Super administrateur, qui révoquera les accès.'))) return;
              const r = await api('/finance/departs/agent', { method: 'POST', body: { entreprise_id: Number(entA.value), utilisateur_id: Number(agent.value), motif: motifA.value } });
              zoneA.replaceChildren(...verif(r.verification)); toast('Demande de départ soumise.');
            }) }, 'Soumettre au Super administrateur'))),
        h('section', { class: 'carte' }, h('h2', {}, 'Résiliation d\'une entreprise'), A.champ('Entreprise', entR), A.champ('Motif', motifR), zoneR,
          h('button', { class: 'btn', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
            const r = await api('/finance/departs/entreprise', { method: 'POST', body: { entreprise_id: Number(entR.value), motif: motifR.value } });
            zoneR.replaceChildren(...verif(r.verification), h('p', { class: 'petit-texte' }, `Les données sont conservées ${r.verification.conservation_ans} ans après la clôture.`),
              h('button', { class: 'btn primaire', type: 'button', onclick: (e2) => agir(e2.currentTarget, async () => {
                if (!(await ui.confirmer('Soumettre la clôture définitive ?', 'Le Super administrateur devra la valider. Aucune donnée n\'est supprimée.'))) return;
                await api(`/finance/demandes/${r.demande.id}/soumettre`, { method: 'POST' }); zoneR.replaceChildren(h('p', { class: 'resultat' }, 'Clôture soumise au Super administrateur.'));
              }) }, 'Soumettre la clôture au Super administrateur'));
            toast('Résiliation enregistrée (brouillon).');
          }) }, 'Enregistrer et vérifier'))));
    await agents().catch(() => {});
  };

  // ---------- Dépenses et budgets ----------
  V.depenses = async (vue) => {
    const d = await api('/finance/depenses');
    const annee = String(new Date().getFullYear());
    const ajouter = () => ui.formulaire('Nouvelle dépense', [
      { nom: 'categorie', libelle: 'Catégorie', type: 'select', options: CATEGORIES }, { nom: 'libelle', libelle: 'Libellé', placeholder: 'Ex. : hébergement Render, nom de domaine…' }, { nom: 'fournisseur', libelle: 'Fournisseur' },
      { nom: 'montant', libelle: 'Montant (F CFA)', type: 'number', min: 1 }, { nom: 'periodicite', libelle: 'Périodicité', type: 'select', options: [['ponctuelle', 'Ponctuelle'], ['mensuelle', 'Mensuelle'], ['annuelle', 'Annuelle']] },
      { nom: 'date_depense', libelle: 'Date', type: 'date', valeur: new Date().toISOString().slice(0, 10) },
    ], async (v, dlg) => {
      const r = await api('/finance/depenses', { method: 'POST', body: { ...v, montant: Number(v.montant) } });
      dlg.close(); toast(r.statut === 'en_attente' ? 'Engagement important : envoyé au Super administrateur pour validation.' : 'Dépense enregistrée.'); router();
    }, { intro: `Au-delà de ${nombre(d.seuil_engagement)} F CFA d'engagement sur 12 mois, la dépense attend l'approbation du Super administrateur.` });
    const budgets = await api(`/finance/budgets?annee=${annee}`);
    const mCourant = new Date().toISOString().slice(0, 7);
    const prevu = (m, c) => (budgets.prevu.find((b) => b.mois === m && b.categorie === c) || {}).montant;
    const reel = (m, c) => (budgets.reel.find((b) => b.mois === m && b.categorie === c) || {}).montant || 0;
    const zoneB = h('div');
    const moisSel = h('input', { type: 'month', value: mCourant, onchange: dessinerBudget });
    function dessinerBudget() {
      const m = moisSel.value; const champs = {};
      zoneB.replaceChildren(ui.tableau(['Catégorie', 'Budget prévu', 'Réalisé', 'Écart'], CATEGORIES.map(([c, l]) => {
        const i = h('input', { type: 'number', min: 0, value: prevu(m, c) === undefined ? '' : prevu(m, c), 'aria-label': `Budget ${l}` }); champs[c] = i;
        const ecart = (Number(prevu(m, c)) || 0) - reel(m, c);
        return [l, i, fcfa(reel(m, c)), h('span', { class: ecart < 0 ? 'puce alerte' : 'puce ok' }, fcfa(ecart))];
      }), { num: [1, 2, 3] }), h('button', { class: 'btn primaire', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => {
        for (const [c, i] of Object.entries(champs)) if (i.value !== '') await api('/finance/budgets', { method: 'PUT', body: { mois: m, categorie: c, montant: Number(i.value) } });
        toast('Budget enregistré.');
      }) }, 'Enregistrer le budget'));
    }
    remplacer(vue, h('h1', {}, 'Dépenses et budgets'),
      h('div', { class: 'stats egales' }, ...d.totaux.map((t) => ui.stat(libCat[t.categorie] || t.categorie, fcfa(t.mensuel_recurrent), `par mois · ponctuel ${fcfa(t.ponctuel)}`))),
      h('div', { class: 'filtres' }, h('button', { class: 'btn primaire', type: 'button', onclick: ajouter }, 'Nouvelle dépense')),
      ui.tableau(['Date', 'Libellé', 'Catégorie', 'Périodicité', 'Montant', 'État', ''], d.depenses.map((x) => [dateFr(x.date_depense), h('div', {}, h('strong', {}, x.libelle), x.fournisseur && h('small', { class: 'bloc-pt' }, x.fournisseur)), libCat[x.categorie] || x.categorie, x.periodicite, fcfa(x.montant),
        ui.puce({ validee: 'Validée', en_attente: 'À valider', refusee: 'Refusée', annulee: 'Annulée' }[x.statut] || x.statut, x.statut === 'validee' ? 'ok' : x.statut === 'refusee' ? 'alerte' : ''),
        ['validee', 'en_attente'].includes(x.statut) && h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => { if (!(await ui.confirmer('Annuler cette dépense ?', x.libelle))) return; await api(`/finance/depenses/${x.id}/annuler`, { method: 'PUT' }); router(); }) }, 'Annuler')]), { vide: 'Aucune dépense enregistrée.', num: [4] }),
      h('section', { class: 'carte' }, h('h2', {}, 'Budget mensuel'), h('div', { class: 'filtres' }, A.champ('Mois', moisSel)), zoneB));
    dessinerBudget();
  };

  // ---------- Tarifs et rentabilité ----------
  V.tarifs = async (vue) => {
    const marge = h('input', { type: 'number', min: 0, max: 300, value: 30 }); const nbMois = h('input', { type: 'number', min: 1, max: 24, value: 6 });
    const zone = h('div');
    const t = await api('/finance/tarifs');
    function proposer(plan, prix, jours) {
      ui.formulaire(`Proposer un tarif ${plan}`, [{ nom: 'prix', libelle: 'Prix (F CFA)', type: 'number', valeur: prix, min: 100 }, { nom: 'jours', libelle: 'Durée (jours)', type: 'number', valeur: jours, min: 1 }, { nom: 'motif', libelle: 'Justification', type: 'textarea' }],
        async (v, d) => { await api('/finance/tarifs/proposer', { method: 'POST', body: { plan, prix: Number(v.prix), jours: Number(v.jours), motif: v.motif } }); d.close(); toast('Proposition envoyée au Super administrateur.'); router(); }, { bouton: 'Soumettre au Super administrateur' });
    }
    async function calculer() {
      const r = await api(`/finance/rentabilite?mois=${Number(nbMois.value) || 6}&marge=${Number(marge.value) || 0}`);
      const f = (id) => t.formules.find((x) => x.id === id) || { jours: 30 };
      zone.replaceChildren(
        h('div', { class: 'stats egales' }, ui.stat('Revenus', fcfa(r.totaux.revenus), `sur ${r.mois} mois`), ui.stat('Dépenses', fcfa(r.totaux.depenses)), ui.stat('Résultat', fcfa(r.totaux.resultat), r.totaux.taux_marge_pct === null ? '' : `marge ${r.totaux.taux_marge_pct} %`, r.totaux.resultat < 0),
          ui.stat('Coût de fonctionnement', fcfa(r.cout_fonctionnement_mensuel), 'par mois (3 derniers mois)'), ui.stat('Coût par entreprise', fcfa(r.cout_par_entreprise), `${nombre(r.entreprises_payantes)} entreprise(s) payante(s)`)),
        h('section', { class: 'carte' }, h('h2', {}, 'Revenus et dépenses'), ui.barres(r.serie.map((s) => ({ libelle: mois(s.mois), revenus: s.revenus, depenses: s.depenses })), [{ cle: 'revenus', nom: 'Revenus' }, { cle: 'depenses', nom: 'Dépenses', classe: 'depense' }], 'Rentabilité')),
        h('section', { class: 'carte' }, h('h2', {}, 'Prix suggérés'), h('p', { class: 'petit-texte' }, r.note),
          ui.tableau(['Formule', 'Prix actuel', 'Prix suggéré', ''], [['mensuel', 'Mensuel', r.prix_actuels.mensuel, r.prix_suggeres.mensuel], ['annuel', 'Annuel', r.prix_actuels.annuel, r.prix_suggeres.annuel]].map(([id, l, a, s]) => [l, fcfa(a), fcfa(s), h('button', { class: 'btn petit', type: 'button', onclick: () => proposer(id, s, f(id).jours) }, 'Proposer')]), { num: [1, 2] }),
          h('p', { class: 'petit-texte' }, `Seuil de rentabilité mensuel par entreprise : ${fcfa(r.prix_suggeres.seuil_rentabilite_mensuel)}.`)));
    }
    remplacer(vue, h('h1', {}, 'Tarifs et rentabilité'),
      h('div', { class: 'stats egales' }, ...t.formules.map((f) => ui.stat(`Formule ${f.label.toLowerCase()}`, fcfa(f.prix), `${f.jours} jours`))),
      h('div', { class: 'filtres' }, A.champ('Marge visée (%)', marge), A.champ('Période (mois)', nbMois), h('button', { class: 'btn', type: 'button', onclick: (ev) => agir(ev.currentTarget, calculer) }, 'Calculer')), zone,
      h('section', { class: 'carte' }, h('h2', {}, 'Mes propositions'), ui.tableau(['Date', 'Proposition', 'État', 'Décision'], t.propositions.map((p) => [p.cree_le, h('div', {}, h('strong', {}, p.resume), h('small', { class: 'bloc-pt' }, p.motif)), ui.puce(ui.statutDem(p.statut)[0], ui.statutDem(p.statut)[1]), p.decision_note || '—']), { vide: 'Aucune proposition.' })));
    await calculer();
  };

  // ---------- Suivi de mes demandes ----------
  V.demandes = async (vue) => {
    const l = await api('/finance/demandes');
    remplacer(vue, h('h1', {}, 'Mes demandes'), h('p', { class: 'aide' }, 'Suivi des demandes adressées au Super administrateur.'),
      ui.tableau(['Date', 'Type', 'Demande', 'État', 'Décision', ''], l.map((d) => {
        const [lib, cls] = ui.statutDemande[d.statut] || [d.statut, ''];
        return [d.cree_le, d.type_libelle, h('div', {}, h('strong', {}, d.resume), h('small', { class: 'bloc-pt' }, `Par ${d.demandeur_nom || '—'}`)), ui.puce(lib, cls), d.decision_note ? `${d.decide_nom || ''} : ${d.decision_note}` : (d.decide_nom || '—'),
          h('div', { class: 'actions-ligne' },
            d.statut === 'brouillon' && h('button', { class: 'btn petit', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => { await api(`/finance/demandes/${d.id}/soumettre`, { method: 'POST' }); toast('Soumise au Super administrateur.'); router(); }) }, 'Soumettre'),
            ['brouillon', 'en_attente'].includes(d.statut) && d.demandeur_id === state.admin.id && h('button', { class: 'btn petit', type: 'button', onclick: (ev) => agir(ev.currentTarget, async () => { await api(`/finance/demandes/${d.id}/annuler`, { method: 'POST' }); router(); }) }, 'Annuler'))];
      }), { vide: 'Aucune demande.' }));
  };
});
