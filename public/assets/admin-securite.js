// Espace Administrateur de sécurité informatique : alertes, comptes, sessions, journaux, rapports. Aucune donnée financière.
(window.BQA_MODULES = window.BQA_MODULES || []).push((A) => {
  'use strict';
  const { h, api, toast, agir, remplacer, ui, nombre, router } = A;
  const V = A.vues.security;
  A.menus.security = [
    'Surveillance', ['tableau', 'Tableau de bord'], ['alertes', 'Alertes et incidents'], ['comptes', 'Comptes et accès'], ['sessions', 'Sessions actives'],
    'Journaux', ['connexions', 'Connexions'], ['audit', 'Audit (lecture seule)'], 'Rapports', ['rapports', 'Rapports de sécurité'], ['compte', 'Mon compte'],
  ];
  const resume = (o) => { try { const t = JSON.stringify(o); return t.length > 160 ? t.slice(0, 160) + '…' : t; } catch { return ''; } };
  const TYPES_ALERTE = { tentatives_repetees: 'Tentatives répétées', connexion_inhabituelle: 'Connexion inhabituelle', activite_suspecte: 'Activité suspecte', acces_non_autorise: 'Accès non autorisé', modification_sensible: 'Modification sensible', comportement_anormal: 'Comportement anormal', compte_suspect: 'Compte signalé', compte_bloque: 'Compte bloqué' };

  // ---------- Tableau de bord ----------
  A.partage.securiteTableau = async (vue) => {
    const d = await api('/securite/dashboard');
    const lib = { normal: 'Situation normale', vigilance: 'Vigilance', critique: 'Situation critique' }[d.niveau];
    remplacer(vue, h('h1', {}, 'Sécurité informatique'), h('p', {}, 'État général : ', h('span', { class: `niveau ${d.niveau}` }, lib)),
      h('div', { class: 'stats egales' },
        ui.stat('Connexions actives', nombre(d.connexions_actives.administrateurs + d.connexions_actives.entreprises_12h), `${nombre(d.connexions_actives.administrateurs)} administrateur(s) · ${nombre(d.connexions_actives.entreprises_12h)} utilisateur(s) d'entreprise (12 h)`),
        ui.stat('Échecs de connexion (24 h)', nombre(d.echecs.dernieres_24h), `${nombre(d.echecs.dernieres_15min)} ces 15 dernières minutes`, d.echecs.dernieres_15min >= 5),
        ui.stat('Alertes ouvertes', nombre(d.alertes.ouvertes), `${nombre(d.alertes.graves)} grave(s)`, d.alertes.graves > 0),
        ui.stat('Comptes suspects', nombre(d.comptes_suspects), `${nombre(d.admins_bloques)} administrateur(s) bloqué(s)`, d.comptes_suspects > 0)),
      h('section', { class: 'carte' }, h('h2', {}, 'Connexions et échecs — 7 jours'),
        ui.barres(d.serie.map((s) => ({ libelle: s.jour, connexions: s.connexions, echecs: s.echecs })), [{ cle: 'connexions', nom: 'Connexions réussies' }, { cle: 'echecs', nom: 'Échecs', classe: 'depense' }], 'Connexions et échecs', nombre)));
  };
  V.tableau = async (vue) => { await A.partage.securiteTableau(vue); const z = h('div'); vue.append(z); await A.partage.securiteAlertes(z, { limite: 5 }); };

  // ---------- Alertes et incidents ----------
  A.partage.securiteAlertes = async (zone, { limite } = {}) => {
    const filtre = h('select', { 'aria-label': 'État', onchange: charger }, h('option', { value: '' }, 'Toutes'), h('option', { value: 'ouverte' }, 'Ouvertes'), h('option', { value: 'en_cours' }, 'En cours'), h('option', { value: 'traitee' }, 'Traitées'), h('option', { value: 'faux_positif' }, 'Faux positifs'));
    const tout = h('input', { type: 'checkbox', onchange: charger });
    const corps = h('div');
    async function charger() {
      let l = await api(`/securite/alertes?statut=${encodeURIComponent(filtre.value)}${tout.checked ? '&tout=1' : ''}`);
      if (limite) l = l.slice(0, limite);
      corps.replaceChildren(ui.tableau(['Date', 'Gravité', 'Alerte', 'Compte / adresse', 'État', ''], l.map((a) => [a.cree_le, ui.puce(a.gravite, a.gravite),
        h('div', {}, h('strong', {}, a.titre), h('small', { class: 'bloc-pt' }, `${TYPES_ALERTE[a.type] || a.type}${a.signalee_super ? ' · signalée au Super administrateur' : ''}`), a.details && h('small', { class: 'bloc-pt mono' }, resume(a.details)), a.note && h('small', { class: 'bloc-pt' }, `Note : ${a.note}`)),
        h('div', {}, a.email || '—', a.ip && h('small', { class: 'bloc-pt mono' }, a.ip)), ui.puce({ ouverte: 'Ouverte', en_cours: 'En cours', traitee: 'Traitée', faux_positif: 'Faux positif' }[a.statut], a.statut === 'ouverte' ? 'alerte' : a.statut === 'traitee' ? 'ok' : ''),
        ['ouverte', 'en_cours'].includes(a.statut) && h('button', { class: 'btn petit', type: 'button', onclick: () => traiter(a) }, 'Traiter')]), { vide: 'Aucune alerte.' }));
    }
    function traiter(a) {
      ui.formulaire('Traiter l\'alerte', [{ nom: 'statut', libelle: 'Nouvel état', type: 'select', valeur: 'traitee', options: [['en_cours', 'En cours d\'analyse'], ['traitee', 'Traitée'], ['faux_positif', 'Faux positif']] }, { nom: 'note', libelle: 'Note', type: 'textarea', max: 500 }],
        async (v, d) => { await api(`/securite/alertes/${a.id}`, { method: 'PUT', body: v }); d.close(); toast('Alerte mise à jour.'); await charger(); }, { intro: a.titre });
    }
    zone.replaceChildren(h('section', { class: 'carte' }, h('h2', {}, 'Alertes et incidents'), !limite && h('div', { class: 'filtres' }, filtre, h('label', { class: 'case' }, tout, 'Afficher les modifications sensibles')), corps));
    await charger();
  };
  V.alertes = async (vue) => { remplacer(vue, h('h1', {}, 'Alertes et incidents')); const z = h('div'); vue.append(z); await A.partage.securiteAlertes(z); };

  // ---------- Comptes et accès ----------
  V.comptes = async (vue) => {
    const q = h('input', { type: 'search', placeholder: 'Chercher un compte, une entreprise', 'aria-label': 'Chercher' });
    const zone = h('div');
    q.addEventListener('input', ui.debounce(() => charger()));
    const bloque = (c) => c.bloque_jusqua && new Date(c.bloque_jusqua) > new Date();
    function actions(type, c) {
      const act = (libelle, fn) => h('button', { class: 'btn petit', type: 'button', onclick: fn }, libelle);
      return h('div', { class: 'actions-ligne' },
        bloque(c) ? act('Débloquer', () => agir(null, async () => { await api(`/securite/comptes/${type}/${c.id}/debloquer`, { method: 'POST' }); toast('Compte débloqué.'); await charger(); }))
          : act('Bloquer', () => ui.formulaire(`Bloquer ${c.email} temporairement`, [{ nom: 'minutes', libelle: 'Durée', type: 'select', valeur: '60', options: [['15', '15 minutes'], ['60', '1 heure'], ['240', '4 heures'], ['1440', '24 heures'], ['10080', '7 jours']] }, { nom: 'motif', libelle: 'Motif de sécurité', type: 'textarea', max: 300 }],
            async (v, d) => { await api(`/securite/comptes/${type}/${c.id}/bloquer`, { method: 'POST', body: { minutes: Number(v.minutes), motif: v.motif } }); d.close(); toast('Compte bloqué, sessions fermées.'); await charger(); }, { bouton: 'Bloquer', intro: 'Le blocage est temporaire et ferme les sessions en cours. Il est journalisé.' })),
        type === 'utilisateur' && act('Fermer les sessions', () => agir(null, async () => { if (!(await ui.confirmer('Fermer les sessions ?', c.email))) return; await api(`/securite/utilisateurs/${c.id}/revoquer-sessions`, { method: 'POST' }); toast('Sessions fermées.'); })),
        act('Signaler', () => ui.formulaire(`Signaler ${c.email} au Super administrateur`, [{ nom: 'motif', libelle: 'Motif du signalement', type: 'textarea', max: 500 }],
          async (v, d) => { await api(`/securite/comptes/${type}/${c.id}/signaler`, { method: 'POST', body: v }); d.close(); toast('Compte signalé au Super administrateur.'); }, { bouton: 'Signaler' })));
    }
    async function charger() {
      const [d, susp] = await Promise.all([api(`/securite/comptes?q=${encodeURIComponent(q.value)}`), api('/securite/comptes-suspects')]);
      zone.replaceChildren(
        susp.length ? h('section', { class: 'carte attention' }, h('h2', {}, 'Comptes suspects (24 h)'), ui.tableau(['Compte', 'Type', 'Échecs', 'Adresses', 'Dernier échec'], susp.map((s) => [s.email, s.type_compte === 'admin' ? 'Administrateur' : 'Entreprise', nombre(s.echecs), nombre(s.adresses), s.dernier]), { num: [2, 3] })) : null,
        h('section', { class: 'carte' }, h('h2', {}, 'Administrateurs et rôles'), ui.tableau(['Compte', 'Rôle', 'État', 'Dernière connexion', 'Sessions', 'Échecs 24 h', ''], d.administrateurs.map((a) => [h('div', {}, h('strong', {}, a.nom_complet), h('small', { class: 'bloc-pt' }, a.email)), a.role,
          h('span', {}, a.actif ? ui.puce('Actif', 'ok') : ui.puce('Suspendu', 'alerte'), bloque(a) && ui.puce('Bloqué', 'alerte')), a.derniere_connexion || 'jamais', nombre(a.sessions_actives), nombre(a.echecs_24h),
          a.role === 'SUPER_ADMIN' ? h('span', { class: 'petit-texte' }, 'Signalement uniquement') : actions('admin', a)]), { num: [4, 5] })),
        h('section', { class: 'carte' }, h('h2', {}, 'Utilisateurs des entreprises'), ui.tableau(['Utilisateur', 'Entreprise', 'Rôle', 'État', 'Dernière connexion', 'Échecs 24 h', ''], d.utilisateurs.map((u) => [h('div', {}, h('strong', {}, u.nom_complet), h('small', { class: 'bloc-pt' }, u.email)), u.entreprise, u.role,
          h('span', {}, u.actif ? ui.puce('Actif', 'ok') : ui.puce('Désactivé'), bloque(u) && ui.puce('Bloqué', 'alerte')), u.derniere_connexion || 'jamais', nombre(u.echecs_24h), actions('utilisateur', u)]), { vide: 'Aucun utilisateur.', num: [5] })));
    }
    remplacer(vue, h('h1', {}, 'Comptes et accès'), h('p', { class: 'aide' }, 'Aucun mot de passe n\'est visible ici. Vous pouvez bloquer temporairement un compte menacé ou le signaler ; la suspension définitive relève du Super administrateur.'), h('div', { class: 'filtres' }, q), zone);
    await charger();
  };

  // ---------- Sessions actives ----------
  V.sessions = async (vue) => {
    const d = await api('/securite/sessions');
    remplacer(vue, h('h1', {}, 'Sessions actives'),
      h('section', { class: 'carte' }, h('h2', {}, 'Administrateurs'), ui.tableau(['Compte', 'Rôle', 'Adresse', 'Navigateur', 'Ouverte', 'Dernière activité', ''], d.administrateurs.map((s) => [s.email, s.role, h('span', { class: 'mono' }, s.ip || '—'), h('small', {}, (s.navigateur || '').slice(0, 60)), s.cree_le, s.derniere_activite,
        s.role === 'SUPER_ADMIN' ? '' : h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => { if (!(await ui.confirmer('Révoquer cette session ?', s.email))) return; await api(`/securite/sessions/${s.id}/revoquer`, { method: 'POST' }); toast('Session révoquée.'); router(); }) }, 'Révoquer')]), { vide: 'Aucune session.' })),
      h('section', { class: 'carte' }, h('h2', {}, 'Utilisateurs d\'entreprise connectés (12 dernières heures)'), ui.tableau(['Utilisateur', 'Entreprise', 'Adresse', 'Dernière connexion', ''], d.entreprises.map((s) => [s.email, s.entreprise || '—', h('span', { class: 'mono' }, s.ip || '—'), s.derniere,
        s.utilisateur_id && h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => { if (!(await ui.confirmer('Fermer ses sessions ?', s.email))) return; await api(`/securite/utilisateurs/${s.utilisateur_id}/revoquer-sessions`, { method: 'POST' }); toast('Sessions fermées.'); }) }, 'Fermer les sessions')]), { vide: 'Aucune connexion récente.' })));
  };

  // ---------- Journal des connexions ----------
  V.connexions = async (vue) => {
    const ev = h('select', { onchange: charger }, h('option', { value: '' }, 'Tous les événements'), h('option', { value: 'connexion' }, 'Connexions'), h('option', { value: 'echec' }, 'Échecs'), h('option', { value: 'deconnexion' }, 'Déconnexions'));
    const type = h('select', { onchange: charger }, h('option', { value: '' }, 'Tous les comptes'), h('option', { value: 'admin' }, 'Administrateurs'), h('option', { value: 'entreprise' }, 'Entreprises'));
    const q = h('input', { type: 'search', placeholder: 'E-mail ou adresse IP' }); q.addEventListener('input', ui.debounce(() => charger()));
    const zone = h('div');
    async function charger() {
      const l = await api(`/securite/connexions?evenement=${ev.value}&type=${type.value}&q=${encodeURIComponent(q.value)}`);
      zone.replaceChildren(ui.tableau(['Date', 'Compte', 'Événement', 'Motif', 'Adresse', 'Navigateur'], l.map((c) => [c.cree_le, h('div', {}, c.email || '—', h('small', { class: 'bloc-pt' }, c.type_compte === 'admin' ? 'Administrateur' : 'Entreprise')),
        ui.puce({ connexion: 'Connexion', echec: 'Échec', deconnexion: 'Déconnexion' }[c.evenement], c.evenement === 'echec' ? 'alerte' : c.evenement === 'connexion' ? 'ok' : ''), c.motif || '—', h('span', { class: 'mono' }, c.ip || '—'), h('small', {}, (c.navigateur || '').slice(0, 60))]), { vide: 'Aucun événement.' }));
    }
    remplacer(vue, h('h1', {}, 'Historique des connexions'), h('div', { class: 'filtres' }, ev, type, q), zone);
    await charger();
  };

  // ---------- Audit (lecture seule) ----------
  V.audit = async (vue) => {
    const filtre = h('select', { onchange: charger }, h('option', { value: '' }, 'Toutes les actions'), h('option', { value: 'sensibles' }, 'Modifications sensibles'), h('option', { value: 'permissions' }, 'Permissions et rôles'));
    const zone = h('div');
    async function charger() {
      const l = await api(`/securite/audit?filtre=${filtre.value}`);
      zone.replaceChildren(ui.tableau(['Date', 'Acteur', 'Action', 'Cible et détails', 'Résultat', 'Adresse'], l.map((e) => [e.cree_le, h('div', {}, e.admin_email || '—', e.role && h('small', { class: 'bloc-pt' }, e.role)), h('span', { class: 'mono' }, e.action),
        h('div', {}, e.cible_type ? `${e.cible_type} ${e.cible_id || ''}` : '—', e.details && h('small', { class: 'bloc-pt mono' }, resume(e.details))), ui.puce(e.resultat, e.resultat === 'succes' ? 'ok' : 'alerte'), e.ip || '—']), { vide: 'Aucune entrée.' }));
    }
    remplacer(vue, h('h1', {}, 'Journal d\'audit'), h('p', { class: 'aide' }, 'Lecture seule : vous ne pouvez ni modifier ni supprimer ces entrées (le serveur et la base de données le refusent).'), h('div', { class: 'filtres' }, filtre), zone);
    await charger();
  };

  // ---------- Rapports ----------
  V.rapports = async (vue) => {
    const periode = h('select', { onchange: charger }, h('option', { value: 'jour' }, 'Rapport journalier (24 h)'), h('option', { value: 'semaine' }, 'Rapport hebdomadaire (7 jours)'), h('option', { value: 'mois' }, 'Rapport mensuel (30 jours)'));
    const zone = h('div'); let dernier = null;
    async function charger() {
      const r = await api(`/securite/rapports?periode=${periode.value}`); dernier = r;
      zone.replaceChildren(
        h('div', { class: 'stats egales' }, ui.stat('Connexions réussies', nombre(r.connexions.connexions)), ui.stat('Échecs de connexion', nombre(r.connexions.echecs), `${nombre(r.connexions.adresses_en_echec)} adresse(s) distincte(s)`, r.connexions.echecs >= 20),
          ui.stat('Alertes', nombre(r.alertes.total), `${nombre(r.alertes.graves)} grave(s) · ${nombre(r.alertes.closes)} clôturée(s)`, r.alertes.graves > 0), ui.stat('Blocages / accès refusés', `${nombre(r.comptes_bloques)} / ${nombre(r.acces_refuses)}`)),
        h('section', { class: 'carte' }, h('h2', {}, 'Recommandations'), h('ul', { class: 'liste' }, r.recommandations.map((t) => h('li', {}, t)))),
        h('div', { class: 'deux-col' },
          h('section', { class: 'carte' }, h('h2', {}, 'Alertes par type'), ui.tableau(['Type', 'Nombre'], r.alertes.par_type.map((t) => [TYPES_ALERTE[t.type] || t.type, nombre(t.n)]), { vide: 'Aucune alerte.', num: [1] })),
          h('section', { class: 'carte' }, h('h2', {}, 'Comptes les plus ciblés'), ui.tableau(['Compte', 'Échecs'], r.comptes_les_plus_cibles.map((c) => [c.email, nombre(c.echecs)]), { vide: 'Aucun échec.', num: [1] }))),
        h('button', { class: 'btn', type: 'button', onclick: telecharger }, 'Télécharger le rapport (texte)'));
    }
    function telecharger() {
      const r = dernier; if (!r) return;
      const t = [`Rapport de sécurité Best-Quinca — période : ${r.periode}`, `Généré le ${r.genere_le}`, '', `Connexions réussies : ${r.connexions.connexions}`, `Échecs de connexion : ${r.connexions.echecs}`, `Alertes : ${r.alertes.total} (graves : ${r.alertes.graves})`, `Comptes bloqués : ${r.comptes_bloques} · accès refusés : ${r.acces_refuses}`, '', 'Recommandations :', ...r.recommandations.map((x) => `- ${x}`)].join('\n');
      const a = h('a', { href: URL.createObjectURL(new Blob([t], { type: 'text/plain;charset=utf-8' })), download: `rapport-securite-${r.periode}.txt` }); document.body.append(a); a.click(); a.remove();
    }
    remplacer(vue, h('h1', {}, 'Rapports de sécurité'), h('div', { class: 'filtres' }, periode), zone);
    await charger();
  };
});
