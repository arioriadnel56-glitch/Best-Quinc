// Espace Super administrateur : demandes à valider, administrateurs, rôles et permissions, activité, système.
(window.BQA_MODULES = window.BQA_MODULES || []).push((A) => {
  'use strict';
  const { h, api, toast, agir, remplacer, ui, nombre, state, router } = A;
  const V = A.vues.super;
  const ROLES = { SUPER_ADMIN: 'Super administrateur', FINANCE_ADMIN: 'Administrateur financier et commercial', SECURITY_ADMIN: 'Administrateur de sécurité' };
  const DOMAINES = { super: 'Super administrateur', finance: 'Finance et commerce', securite: 'Sécurité informatique' };
  const resume = (o) => { try { const t = JSON.stringify(o); return t.length > 140 ? t.slice(0, 140) + '…' : t; } catch { return ''; } };

  // Résultat des contrôles préalables préparés par l'administrateur financier
  A.partage.verification = (v) => (!v || !v.controles ? null : h('ul', { class: 'liste-verif' }, v.controles.map((c) => h('li', {},
    ui.puce(c.bloquant ? 'Bloquant' : c.ok ? 'OK' : 'À vérifier', c.bloquant ? 'alerte' : c.ok ? 'ok' : ''),
    h('span', {}, c.libelle, c.valeur !== undefined && c.valeur !== null ? ` : ${c.valeur}` : '')))));

  // ---------- Demandes à valider ----------
  V.demandes = async (vue) => {
    const filtre = h('select', { 'aria-label': 'Filtrer', onchange: charger },
      h('option', { value: 'en_attente' }, 'À valider'), h('option', { value: '' }, 'Toutes'), h('option', { value: 'approuvee' }, 'Approuvées'), h('option', { value: 'refusee' }, 'Refusées'));
    const zone = h('div');
    async function charger() {
      const l = await api(`/super/demandes?statut=${encodeURIComponent(filtre.value)}`);
      zone.replaceChildren(ui.tableau(['Date', 'Type', 'Demande', 'Déposée par', 'État', ''], l.map((d) => {
        const [lib, cls] = ui.statutDemande[d.statut] || [d.statut, ''];
        return [d.cree_le, d.type_libelle,
          h('div', {}, h('strong', {}, d.resume), d.entreprise && h('small', { class: 'bloc-pt' }, d.entreprise), d.decision_note && h('small', { class: 'bloc-pt' }, `Décision : ${d.decision_note}`)),
          d.demandeur_nom || '—', ui.puce(lib, cls),
          d.statut === 'en_attente' ? h('button', { class: 'btn petit', type: 'button', onclick: () => examiner(d) }, 'Examiner') : ''];
      }), { vide: 'Aucune demande.' }));
    }
    function examiner(d) {
      const note = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Note de décision (obligatoire pour un refus)' });
      const decider = (decision) => agir(null, async () => {
        const ok = await ui.confirmer(decision === 'approuver' ? 'Approuver cette demande ?' : 'Refuser cette demande ?',
          decision === 'approuver' ? 'L\'opération sera appliquée immédiatement et enregistrée dans le journal d\'audit.' : 'Le refus sera enregistré dans le journal d\'audit.', { bouton: decision === 'approuver' ? 'Approuver' : 'Refuser' });
        if (!ok) return;
        await api(`/super/demandes/${d.id}/decision`, { method: 'POST', body: { decision, note: note.value } });
        dlg.close(); toast(decision === 'approuver' ? 'Demande approuvée.' : 'Demande refusée.'); await charger();
      });
      const dlg = A.modale(d.type_libelle, [h('p', {}, h('strong', {}, d.resume)), d.entreprise && h('p', { class: 'aide' }, `Entreprise : ${d.entreprise}`),
        d.motif && h('p', {}, `Motif : ${d.motif}`), h('p', { class: 'petit-texte' }, `Déposée par ${d.demandeur_nom || '—'} le ${d.cree_le}`),
        A.partage.verification(d.verification), A.champ('Décision', note),
        h('div', { class: 'actions' }, h('button', { class: 'btn primaire', type: 'button', onclick: () => decider('approuver') }, 'Approuver'),
          h('button', { class: 'btn', type: 'button', onclick: () => decider('refuser') }, 'Refuser'))], { large: true });
    }
    remplacer(vue, h('h1', {}, 'Demandes à valider'), h('p', { class: 'aide' }, 'Prolongations exceptionnelles, tarifs, fournisseurs de paiement, engagements, départs et résiliations : seul le Super administrateur décide.'), h('div', { class: 'filtres' }, filtre), zone);
    await charger();
  };

  // ---------- Administrateurs ----------
  V.admins = async (vue) => {
    const zone = h('div');
    async function charger() {
      const l = await api('/super/admins');
      zone.replaceChildren(ui.tableau(['Administrateur', 'Rôle', 'État', 'Dernière connexion', 'Sessions', ''], l.map((a) => [
        h('div', {}, h('strong', {}, a.nom_complet), h('small', { class: 'bloc-pt' }, a.email)),
        ROLES[a.role] || a.role,
        h('span', {}, a.actif ? ui.puce('Actif', 'ok') : ui.puce('Suspendu', 'alerte'), a.bloque_jusqua && new Date(a.bloque_jusqua) > new Date() && ui.puce('Bloqué (sécurité)', 'alerte'), a.mdp_temporaire && ui.puce('Mot de passe provisoire')),
        a.derniere_connexion || 'jamais', nombre(a.sessions_actives),
        h('div', { class: 'actions-ligne' },
          h('button', { class: 'btn petit', type: 'button', onclick: () => modifier(a) }, 'Modifier'),
          h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => {
            if (!(await ui.confirmer('Réinitialiser le mot de passe ?', `${a.email} sera déconnecté et recevra un mot de passe provisoire.`))) return;
            const r = await api(`/super/admins/${a.id}/mot-de-passe`, { method: 'POST' });
            ui.secretUnique(`Mot de passe provisoire — ${r.email}`, r.mot_de_passe_temporaire); await charger();
          }) }, 'Nouveau mot de passe'),
          h('button', { class: 'btn petit', type: 'button', onclick: () => agir(null, async () => {
            if (!(await ui.confirmer('Fermer toutes les sessions ?', `${a.email} devra se reconnecter.`))) return;
            const r = await api(`/super/admins/${a.id}/deconnecter`, { method: 'POST' });
            toast(`${r.sessions_fermees} session(s) fermée(s).`); await charger();
          }) }, 'Déconnecter'))])));
    }
    function modifier(a) {
      ui.formulaire(`Modifier ${a.nom_complet}`, [
        { nom: 'nom_complet', libelle: 'Nom', valeur: a.nom_complet },
        { nom: 'role', libelle: 'Rôle', type: 'select', valeur: a.role, options: Object.entries(ROLES) },
        { nom: 'actif', libelle: 'Compte', type: 'select', valeur: String(a.actif), options: [['true', 'Actif'], ['false', 'Suspendu']], aide: 'Suspendre ou changer de rôle ferme immédiatement ses sessions.' },
      ], async (v, d) => {
        if (!(await ui.confirmer('Confirmer la modification ?', 'Le changement est enregistré dans le journal d\'audit.'))) return;
        await api(`/super/admins/${a.id}`, { method: 'PUT', body: { nom_complet: v.nom_complet, role: v.role, actif: v.actif === 'true' } });
        d.close(); toast('Administrateur modifié.'); await charger();
      });
    }
    function creer() {
      ui.formulaire('Nouvel administrateur', [
        { nom: 'nom_complet', libelle: 'Nom complet' }, { nom: 'email', libelle: 'Adresse e-mail', type: 'email' },
        { nom: 'role', libelle: 'Rôle', type: 'select', valeur: 'FINANCE_ADMIN', options: Object.entries(ROLES) },
      ], async (v, d) => {
        const r = await api('/super/admins', { method: 'POST', body: v });
        d.close(); ui.secretUnique(`Compte créé — ${r.email}`, r.mot_de_passe_temporaire); await charger();
      }, { bouton: 'Créer le compte', intro: 'Un mot de passe provisoire sera généré ; l\'administrateur devra le remplacer à sa première connexion.' });
    }
    remplacer(vue, h('h1', {}, 'Administrateurs'), h('div', { class: 'filtres' }, h('button', { class: 'btn primaire', type: 'button', onclick: creer }, 'Nouvel administrateur')), zone);
    await charger();
  };

  // ---------- Rôles et permissions ----------
  V.roles = async (vue) => {
    const d = await api('/super/roles');
    const cartes = d.roles.map((r) => {
      const cases = {};
      const groupes = Object.keys(DOMAINES).map((dom) => {
        const perms = d.catalogue.filter((p) => p.domaine === dom);
        const autorise = r.code === 'SUPER_ADMIN' || (r.code === 'FINANCE_ADMIN' && dom === 'finance') || (r.code === 'SECURITY_ADMIN' && dom === 'securite');
        if (!autorise) return null;
        return h('div', { class: 'matrice' }, h('p', { class: 'groupe-titre' }, h('strong', {}, DOMAINES[dom])),
          perms.map((p) => { const c = h('input', { type: 'checkbox', checked: r.permissions.includes(p.code), disabled: !r.modifiable }); cases[p.code] = c; return h('label', {}, c, h('span', {}, p.libelle, h('small', { class: 'bloc-pt mono' }, p.code))); }));
      });
      const btn = h('button', { class: 'btn primaire', type: 'button', disabled: !r.modifiable, onclick: () => agir(btn, async () => {
        if (!(await ui.confirmer(`Modifier les permissions de « ${r.libelle} » ?`, 'Les administrateurs de ce rôle perdent ou gagnent ces droits immédiatement. Le changement est journalisé.'))) return;
        const res = await api(`/super/roles/${r.code}/permissions`, { method: 'PUT', body: { permissions: Object.keys(cases).filter((k) => cases[k].checked) } });
        toast(`Permissions mises à jour (+${res.ajoutees.length} / −${res.retirees.length}).`);
      }) }, 'Enregistrer');
      return h('section', { class: 'carte' }, h('h2', {}, r.libelle), h('p', { class: 'petit-texte' }, r.description),
        r.modifiable ? null : h('p', { class: 'aide' }, 'Le Super administrateur possède toujours toutes les permissions : elles ne peuvent pas être retirées.'), groupes, btn);
    });
    remplacer(vue, h('h1', {}, 'Rôles et permissions'),
      h('p', { class: 'aide' }, 'Un rôle ne peut recevoir que des permissions de son propre domaine : l\'administrateur de sécurité ne peut jamais détenir de droit financier, ni l\'inverse.'), h('div', { class: 'deux-col' }, cartes));
  };

  // ---------- Activité (journal d'audit en lecture seule) ----------
  V.activite = async (vue) => {
    const action = h('input', { type: 'search', placeholder: 'Filtrer par action (ex. admin., demande., acces.)', 'aria-label': 'Action' });
    const zone = h('div'); const corps = h('tbody'); let dernier = null; let fin = false;
    const plus = h('button', { class: 'btn', type: 'button', onclick: () => charger(true) }, 'Charger plus');
    async function charger(suite = false) {
      if (!suite) { corps.replaceChildren(); dernier = null; fin = false; }
      const l = await api(`/super/activite?limite=100&action=${encodeURIComponent(action.value)}${dernier ? `&avant=${dernier}` : ''}`);
      l.forEach((e) => corps.append(h('tr', {}, h('td', {}, e.cree_le), h('td', {}, e.admin_email || '—', e.role && h('small', { class: 'bloc-pt' }, e.role)), h('td', {}, h('span', { class: 'mono' }, e.action)),
        h('td', {}, e.cible_type ? `${e.cible_type} ${e.cible_id || ''}` : '—', e.details && h('small', { class: 'bloc-pt mono' }, resume(e.details))), h('td', {}, ui.puce(e.resultat, e.resultat === 'succes' ? 'ok' : 'alerte')), h('td', {}, e.ip || '—'))));
      if (l.length) dernier = l[l.length - 1].id;
      fin = l.length < 100; plus.hidden = fin;
    }
    action.addEventListener('input', ui.debounce(() => charger()));
    remplacer(vue, h('h1', {}, 'Activité de la plateforme'), h('p', { class: 'aide' }, 'Journal d\'audit : en lecture seule. Aucune modification ni suppression n\'est possible, même pour le Super administrateur.'),
      h('div', { class: 'filtres' }, action),
      h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' }, h('thead', {}, h('tr', {}, ['Date', 'Acteur', 'Action', 'Cible et détails', 'Résultat', 'Adresse IP'].map((t) => h('th', {}, t)))), corps)), zone, plus);
    await charger();
  };

  // ---------- Pages qui réutilisent les blocs des autres espaces ----------
  V.abonnements = async (vue) => A.partage.abonnements(vue, { super: true });
  V.finances = async (vue) => { await A.partage.financeTableau(vue); };
  V.securite = async (vue) => {
    await A.partage.securiteTableau(vue);
    const z = h('div'); vue.append(z);
    await A.partage.securiteAlertes(z);
  };

  // ---------- Conformité ----------
  V.conformite = async (vue) => {
    const d = await api('/super/conformite');
    const ECART = { cookie: 'Cookie', outil_interdit: 'Outil de suivi', hote_non_declare: 'Domaine externe', stockage_non_declare: 'Stockage navigateur', stockage_non_resolu: 'Stockage non analysable', csp: 'Politique de sécurité', promesse: 'Formulation à justifier' };
    const auditOk = d.audit.ok === true;
    const accords = d.consentements.filter((c) => c.type === 'conditions' && c.accepte && c.version === d.versions.conditions).reduce((t, c) => t + c.n, 0);
    remplacer(vue, h('h1', {}, 'Conformité'),
      h('p', { class: 'aide' }, 'Registre des données, du stockage navigateur et des outils tiers. Les pages publiques (confidentialité, cookies, engagements) sont générées depuis ce registre ; l\'audit ci-dessous relit le code à chaque affichage.'),
      h('div', { class: 'stats egales' },
        ui.stat('Audit des outils tiers', d.audit.disponible === false ? 'Indisponible' : (auditOk ? 'Conforme' : `${d.audit.ecarts.length} écart(s)`), d.audit.disponible === false ? 'fichiers non accessibles sur cet hébergement' : `${d.audit.fichiers_analyses} fichiers analysés`, d.audit.disponible !== false && !auditOk),
        ui.stat('Mentions légales', d.mentions_manquantes.length ? `${d.mentions_manquantes.length} à renseigner` : 'Complètes', 'éditeur et hébergeur', d.mentions_manquantes.length > 0),
        ui.stat('Textes en vigueur', d.versions.conditions, `confidentialité ${d.versions.confidentialite} · cookies ${d.versions.cookies}`),
        ui.stat('Accords à jour', nombre(accords), `${nombre(d.entreprises_sans_accord_a_jour)} entreprise(s) sans accord à la version actuelle`, d.entreprises_sans_accord_a_jour > 0)),
      d.mentions_manquantes.length ? h('section', { class: 'carte attention' }, h('h2', {}, 'Mentions légales à compléter'),
        h('p', { class: 'petit-texte' }, 'Ces informations sont affichées publiquement dans les mentions légales. Renseignez-les dans les variables d\'environnement de l\'hébergeur, puis redéployez.'),
        h('ul', { class: 'liste' }, d.mentions_manquantes.map((m) => h('li', {}, h('span', { class: 'mono' }, m.cle), m.libelle)))) : null,
      !auditOk && d.audit.disponible !== false ? h('section', { class: 'carte attention' }, h('h2', {}, 'Écarts détectés par l\'audit'),
        ui.tableau(['Type', 'Fichier', 'Détail'], d.audit.ecarts.map((e) => [ECART[e.type] || e.type, h('span', { class: 'mono' }, e.fichier), e.detail]))) : null,
      h('section', { class: 'carte' }, h('h2', {}, 'Outils et services tiers'), ui.tableau(['Service', 'Pourquoi', 'Données', 'Quand'], d.tiers.map((t) => [h('strong', {}, t.nom), t.finalite, t.donnees, t.declencheur]))),
      h('section', { class: 'carte' }, h('h2', {}, 'Stockage dans le navigateur (aucun cookie)'), ui.tableau(['Élément', 'Type', 'Finalité', 'Durée'], d.stockage.map((s) => [h('span', { class: 'mono' }, s.motif), s.type, s.finalite, s.duree]))),
      h('section', { class: 'carte' }, h('h2', {}, 'Données personnelles traitées'), ui.tableau(['Données', 'Finalité', 'Base', 'Durée'], d.donnees.map((x) => [x.donnees, x.finalite, x.base, x.duree])),
        h('p', { class: 'petit-texte' }, `Historique de connexion supprimé automatiquement après ${d.retention_connexions_jours} jours. Journal d'audit des administrateurs : jamais purgé.`)),
      h('section', { class: 'carte' }, h('h2', {}, 'Consentements enregistrés'), ui.tableau(['Texte', 'Version', 'Décision', 'Nombre'], d.consentements.map((c) => [c.type, c.version, c.accepte ? 'accepté' : 'retiré', nombre(c.n)]), { vide: 'Aucun consentement enregistré.', num: [3] })));
  };

  // ---------- Système et sauvegardes ----------
  V.systeme = async (vue) => {
    const s = await api('/super/systeme');
    const choix = {};
    const mo = (o) => (o === null || o === undefined ? '—' : `${(o / 1048576).toFixed(1)} Mo`);
    const jours = Math.floor(s.demarrage_depuis_s / 3600);
    const btn = h('button', { class: 'btn primaire', type: 'button', onclick: () => agir(btn, async () => {
      const tables = Object.keys(choix).filter((k) => choix[k].checked);
      if (!tables.length) throw new Error('Choisissez au moins une table.');
      if (!(await ui.confirmer('Exporter les données ?', 'Le fichier contient des données clients (sans mots de passe ni clés). Conservez-le en lieu sûr. L\'export est enregistré dans le journal d\'audit.', { bouton: 'Exporter' }))) return;
      await ui.telecharger('/super/sauvegardes', { method: 'POST', body: { tables }, nom: 'export.json' });
      toast('Export téléchargé.'); router();
    }) }, 'Exporter en JSON');
    const oui = (b) => ui.puce(b ? 'Configuré' : 'Non configuré', b ? 'ok' : 'alerte');
    remplacer(vue, h('h1', {}, 'Système et sauvegardes'),
      h('div', { class: 'stats egales' }, ui.stat('Version', s.version, `Node ${s.node}`), ui.stat('Base de données', mo(s.base_octets), 'taille actuelle'), ui.stat('En service depuis', `${jours} h`, s.serverless ? 'mode serverless' : 'serveur permanent'), ui.stat('Temps réel', s.websocket ? 'Actif' : 'Inactif', 'WebSocket')),
      h('div', { class: 'deux-col' },
        h('section', { class: 'carte' }, h('h2', {}, 'Paramètres système'),
          h('ul', { class: 'liste' }, h('li', {}, 'Relances par e-mail', oui(s.configuration.email_relances)), h('li', {}, 'Planificateur externe (CRON_SECRET)', oui(s.configuration.cron_secret)),
            h('li', {}, 'Relances automatiques', ui.puce(s.configuration.relances_auto ? 'Activées' : 'Désactivées', s.configuration.relances_auto ? 'ok' : '')),
            h('li', {}, 'Seuil de validation des engagements', ui.puce(`${nombre(s.configuration.seuil_engagement)} F CFA`)), h('li', {}, 'Conservation des données clôturées', ui.puce(`${s.configuration.conservation_ans} ans`))),
          h('p', { class: 'petit-texte' }, 'Ces valeurs se règlent dans les variables d\'environnement de l\'hébergeur (voir GOUVERNANCE-ADMIN.md). Les tarifs et clés de paiement se règlent dans « Paramètres ».')),
        h('section', { class: 'carte' }, h('h2', {}, 'Export des données'),
          h('p', { class: 'petit-texte' }, 'Export logique en JSON. Ce n\'est pas une sauvegarde de reprise après sinistre : activez aussi les sauvegardes automatiques de votre hébergeur de base de données (Neon, Railway, Render…).'),
          h('div', { class: 'matrice' }, s.tables_exportables.map((t) => { const c = h('input', { type: 'checkbox', checked: true }); choix[t] = c; return h('label', {}, c, h('span', {}, t)); })), btn)),
      h('section', { class: 'carte' }, h('h2', {}, 'Derniers exports'), ui.tableau(['Date', 'Tables', 'Lignes'], s.sauvegardes.map((x) => [x.cree_le, x.tables, nombre(x.lignes)]), { vide: 'Aucun export effectué.', num: [2] })),
      h('section', { class: 'carte' }, h('h2', {}, 'Plus grosses tables'), ui.tableau(['Table', 'Lignes (estimation)'], s.tables.map((t) => [h('span', { class: 'mono' }, t.table), nombre(t.lignes)]), { num: [1] })));
  };
});
