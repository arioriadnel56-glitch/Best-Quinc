'use strict';
// Espace Super administrateur : administrateurs, rôles et permissions, demandes à valider, activité, abonnements, système.
const crypto = require('node:crypto');
const db = require('../lib/db');
const { env } = require('../lib/env');
const { HttpError, str, int, email } = require('../lib/http');
const { hashPassword } = require('../lib/password');
const { TZ } = require('../lib/tz');
const rbac = require('../lib/rbac');
const audit = require('../lib/audit');
const demandes = require('../lib/demandes');
const recovery = require('../lib/recovery');
const realtime = require('../lib/realtime');
const { limit } = require('../lib/ratelimit');

const ROLES_VALIDES = Object.keys(rbac.ROLES);
const MIN_PWD = 10;

// Tables exportables (sans aucune colonne de secret) pour la sauvegarde logique
const EXPORTS = {
  entreprises: 'SELECT id, nom, slug, statut, email, telephone, ville, cree_le, cloture_le, conservation_jusqua FROM entreprises ORDER BY id',
  abonnements: 'SELECT * FROM abonnements ORDER BY id',
  paiements: 'SELECT id, entreprise_id, abonnement_id, agregateur, reference_transaction, montant, statut, plan, jours, cree_le, confirme_le FROM paiements ORDER BY id',
  utilisateurs: 'SELECT id, entreprise_id, nom_complet, email, role, actif, cree_le FROM utilisateurs ORDER BY id',
  admins: 'SELECT id, nom_complet, email, role, actif, cree_le, derniere_connexion FROM admins_plateforme ORDER BY id',
  roles_permissions: 'SELECT role, permission FROM admin_role_permissions ORDER BY role, permission',
  demandes: 'SELECT * FROM subscription_management_requests ORDER BY id',
  depenses: 'SELECT * FROM hosting_expenses ORDER BY id',
  audit: 'SELECT * FROM audit_journal ORDER BY id',
};
const MAX_LIGNES = 50000;

module.exports = function register(router) {
  const P = rbac.exiger;

  // ---------- Tableau de bord général ----------
  router.get('/api/admin/super/dashboard', P('super.dashboard'), async () => {
    const un = async (sql, params) => (await db.query(sql, params)).rows[0] || {};
    const [adm, dem, al, dep, ent] = await Promise.all([
      un("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE actif)::int AS actifs FROM admins_plateforme"),
      un("SELECT COUNT(*)::int AS n FROM subscription_management_requests WHERE statut = 'en_attente'"),
      un("SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE gravite IN ('haute', 'critique'))::int AS graves FROM security_alerts WHERE statut IN ('ouverte', 'en_cours') AND type <> 'modification_sensible'"),
      un("SELECT COALESCE(SUM(montant), 0)::float8 AS mois FROM hosting_expenses WHERE statut = 'validee' AND date_depense >= date_trunc('month', CURRENT_DATE)"),
      un("SELECT COUNT(*) FILTER (WHERE cloture_le IS NOT NULL)::int AS cloturees FROM entreprises"),
    ]);
    return { admins: adm, demandes_en_attente: dem.n || 0, alertes: al, depenses_mois: dep.mois || 0, entreprises_cloturees: ent.cloturees || 0 };
  });

  // ---------- Administrateurs ----------
  router.get('/api/admin/super/admins', P('admins.gerer'), async () => {
    const { rows } = await db.query(
      `SELECT a.id, a.nom_complet, a.email, a.role, a.actif, a.mdp_temporaire, a.bloque_jusqua,
              to_char(a.cree_le AT TIME ZONE $1, 'YYYY-MM-DD') AS cree_le, to_char(a.derniere_connexion AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS derniere_connexion,
              (SELECT COUNT(*) FROM admin_sessions s WHERE s.admin_id = a.id AND s.revoquee_le IS NULL AND s.expire_le > now())::int AS sessions_actives
         FROM admins_plateforme a ORDER BY a.id`, [TZ]);
    return rows;
  });

  router.post('/api/admin/super/admins', P('admins.gerer'), async (ctx) => {
    const nom = str(ctx.body.nom_complet, 'nom', { min: 2, max: 150 });
    const mail = email(ctx.body.email);
    const role = str(ctx.body.role, 'rôle', { max: 20 });
    if (!ROLES_VALIDES.includes(role)) throw new HttpError(400, 'Rôle invalide.');
    const temporaire = recovery.genererTemporaire();
    const r = await db.query(
      `INSERT INTO admins_plateforme (nom_complet, email, mot_de_passe_hash, role, mdp_temporaire, cree_par) VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
      [nom, mail, await hashPassword(temporaire), role, ctx.admin.id]);
    await audit.journaliser(ctx, 'admin.creer', { cible_type: 'admin', cible_id: r.rows[0].id, details: { email: mail, role } });
    ctx.status = 201;
    return { id: r.rows[0].id, email: mail, role, mot_de_passe_temporaire: temporaire };
  });

  // Garde-fou : la plateforme garde toujours au moins un Super admin actif
  async function dernierSuper(q, id) {
    const { rows } = await q("SELECT COUNT(*)::int AS n FROM admins_plateforme WHERE role = 'SUPER_ADMIN' AND actif AND id <> $1", [id]);
    return !(rows[0] && rows[0].n > 0);
  }

  router.put('/api/admin/super/admins/:id', P('admins.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'administrateur', { min: 1 });
    const avant = (await db.query('SELECT id, nom_complet, email, role, actif FROM admins_plateforme WHERE id = $1', [id])).rows[0];
    if (!avant) throw new HttpError(404, 'Administrateur introuvable.');
    const nom = ctx.body.nom_complet === undefined ? avant.nom_complet : str(ctx.body.nom_complet, 'nom', { min: 2, max: 150 });
    const role = ctx.body.role === undefined ? avant.role : str(ctx.body.role, 'rôle', { max: 20 });
    const actif = ctx.body.actif === undefined ? avant.actif : Boolean(ctx.body.actif);
    if (!ROLES_VALIDES.includes(role)) throw new HttpError(400, 'Rôle invalide.');
    const retireSuper = avant.role === 'SUPER_ADMIN' && (role !== 'SUPER_ADMIN' || !actif);
    if (id === ctx.admin.id && (role !== avant.role || !actif)) throw new HttpError(400, 'Vous ne pouvez pas changer votre propre rôle ni vous suspendre.');
    await db.tx(async (q) => {
      if (retireSuper) {
        await q("SELECT id FROM admins_plateforme WHERE role = 'SUPER_ADMIN' AND actif FOR UPDATE");
        if (await dernierSuper(q, id)) throw new HttpError(400, 'Il doit rester au moins un Super administrateur actif.');
      }
      await q('UPDATE admins_plateforme SET nom_complet = $1, role = $2, actif = $3 WHERE id = $4', [nom, role, actif, id]);
    });
    if (!actif || role !== avant.role) {
      await db.query(`UPDATE admin_sessions SET revoquee_le = now(), revoquee_par = $2, motif_revocation = 'compte_modifie' WHERE admin_id = $1 AND revoquee_le IS NULL`, [id, ctx.admin.id]);
      realtime.fermerAdmin(id);
    }
    const action = avant.actif && !actif ? 'admin.suspendre' : !avant.actif && actif ? 'admin.reactiver' : 'admin.modifier';
    await audit.journaliser(ctx, action, { cible_type: 'admin', cible_id: id, details: { avant: { nom: avant.nom_complet, role: avant.role, actif: avant.actif }, apres: { nom, role, actif } } });
    return { ok: true };
  });

  router.post('/api/admin/super/admins/:id/mot-de-passe', P('admins.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'administrateur', { min: 1 });
    const temporaire = recovery.genererTemporaire();
    const r = await db.query('UPDATE admins_plateforme SET mot_de_passe_hash = $1, mdp_temporaire = true WHERE id = $2 RETURNING email', [await hashPassword(temporaire), id]);
    if (!r.rows.length) throw new HttpError(404, 'Administrateur introuvable.');
    await db.query(`UPDATE admin_sessions SET revoquee_le = now(), revoquee_par = $2, motif_revocation = 'mot_de_passe_reinitialise' WHERE admin_id = $1 AND revoquee_le IS NULL`, [id, ctx.admin.id]);
    realtime.fermerAdmin(id);
    await audit.journaliser(ctx, 'admin.mdp_reinitialise', { cible_type: 'admin', cible_id: id });
    return { email: r.rows[0].email, mot_de_passe_temporaire: temporaire };
  });

  router.post('/api/admin/super/admins/:id/deconnecter', P('admins.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'administrateur', { min: 1 });
    const r = await db.query(`UPDATE admin_sessions SET revoquee_le = now(), revoquee_par = $2, motif_revocation = 'deconnexion_forcee' WHERE admin_id = $1 AND revoquee_le IS NULL`, [id, ctx.admin.id]);
    realtime.fermerAdmin(id);
    await audit.journaliser(ctx, 'admin.sessions_fermees', { cible_type: 'admin', cible_id: id, details: { sessions: r.rowCount } });
    return { sessions_fermees: r.rowCount };
  });

  // ---------- Rôles et permissions ----------
  router.get('/api/admin/super/roles', P('permissions.gerer'), async () => {
    const [roles, accordees] = await Promise.all([
      db.query('SELECT code, libelle, description FROM admin_roles ORDER BY code'),
      db.query('SELECT role, permission FROM admin_role_permissions'),
    ]);
    const parRole = {};
    for (const r of accordees.rows) (parRole[r.role] = parRole[r.role] || []).push(r.permission);
    return {
      roles: roles.rows.map((r) => ({
        ...r,
        modifiable: r.code !== 'SUPER_ADMIN',
        permissions: r.code === 'SUPER_ADMIN' ? [...rbac.CODES] : (parRole[r.code] || []).filter((p) => rbac.autorisee(r.code, p)),
      })),
      catalogue: rbac.CATALOGUE.map(([code, domaine, libelle]) => ({ code, domaine, libelle })),
    };
  });

  router.put('/api/admin/super/roles/:role/permissions', P('permissions.gerer'), async (ctx) => {
    const role = ctx.params.role;
    if (role === 'SUPER_ADMIN') throw new HttpError(400, 'Le Super administrateur possède toujours toutes les permissions.');
    if (!ROLES_VALIDES.includes(role)) throw new HttpError(404, 'Rôle introuvable.');
    const demandees = Array.isArray(ctx.body.permissions) ? [...new Set(ctx.body.permissions.map(String))] : null;
    if (!demandees) throw new HttpError(400, 'Liste de permissions invalide.');
    const interdite = demandees.find((p) => !rbac.autorisee(role, p));
    if (interdite) throw new HttpError(400, `La permission « ${interdite} » ne peut pas être attribuée à ce rôle (hors de son domaine).`);
    const avant = (await db.query('SELECT permission FROM admin_role_permissions WHERE role = $1', [role])).rows.map((r) => r.permission);
    await db.tx(async (q) => {
      await q('DELETE FROM admin_role_permissions WHERE role = $1', [role]);
      for (const p of demandees) await q('INSERT INTO admin_role_permissions (role, permission) VALUES ($1, $2)', [role, p]);
    });
    rbac.invalider();
    const ajoutees = demandees.filter((p) => !avant.includes(p));
    const retirees = avant.filter((p) => !demandees.includes(p));
    await audit.journaliser(ctx, 'role.permissions_modifiees', { cible_type: 'role', cible_id: role, details: { ajoutees, retirees } });
    return { ok: true, ajoutees, retirees };
  });

  // ---------- Demandes à valider ----------
  router.get('/api/admin/super/demandes', P('demandes.valider'), async (ctx) => {
    const statut = ['en_attente', 'approuvee', 'refusee', 'brouillon', 'annulee'].includes(ctx.query.statut) ? ctx.query.statut : null;
    const { rows } = await db.query(
      `SELECT d.id, d.type, d.statut, d.resume, d.motif, d.donnees, d.verification, d.demandeur_nom, d.decide_nom, d.decision_note,
              to_char(d.cree_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS cree_le, to_char(d.decide_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS decide_le, e.nom AS entreprise
         FROM subscription_management_requests d LEFT JOIN entreprises e ON e.id = d.entreprise_id
        WHERE d.statut <> 'brouillon' AND ($2::text IS NULL OR d.statut = $2::text)
        ORDER BY (d.statut = 'en_attente') DESC, d.id DESC LIMIT 200`, [TZ, statut]);
    return rows.map((r) => ({ ...r, type_libelle: demandes.TYPES[r.type] || r.type }));
  });

  router.post('/api/admin/super/demandes/:id/decision', P('demandes.valider'), async (ctx) => {
    const id = int(ctx.params.id, 'demande', { min: 1 });
    const decision = str(ctx.body.decision, 'décision', { max: 10 });
    const note = str(ctx.body.note, 'note', { optional: true, max: 500 });
    if (decision === 'refuser' && !note) throw new HttpError(400, 'Indiquez le motif du refus.');
    return demandes.decider(ctx, id, decision, note);
  });

  // ---------- Activité (journal d'audit, lecture seule) ----------
  router.get('/api/admin/super/activite', P('journal.lire'), async (ctx) => {
    const lim = Math.min(Math.max(parseInt(ctx.query.limite, 10) || 100, 1), 300);
    const avant = parseInt(ctx.query.avant, 10) || null;
    const action = String(ctx.query.action || '').slice(0, 80);
    const admin = parseInt(ctx.query.admin, 10) || null;
    const { rows } = await db.query(
      `SELECT id, to_char(cree_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI:SS') AS cree_le, admin_email, role, action, cible_type, cible_id, details, ip, resultat
         FROM audit_journal
        WHERE ($2::bigint IS NULL OR id < $2::bigint) AND ($3::text = '' OR action ILIKE $3::text || '%') AND ($4::int IS NULL OR admin_id = $4::int)
        ORDER BY id DESC LIMIT $5`, [TZ, avant, action.replace(/[\\%_]/g, '\\$&'), admin, lim]);
    return rows;
  });

  // ---------- Abonnements ----------
  router.put('/api/admin/super/abonnements/:id/statut', P('abonnements.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'abonnement', { min: 1 });
    const statut = str(ctx.body.statut, 'statut', { max: 20 });
    if (!['actif', 'suspendu'].includes(statut)) throw new HttpError(400, 'Statut invalide.');
    const r = await db.query("UPDATE abonnements SET statut = $1 WHERE id = $2 AND statut IN ('actif', 'suspendu') RETURNING entreprise_id", [statut, id]);
    if (!r.rows.length) throw new HttpError(404, 'Abonnement introuvable ou résilié.');
    realtime.publier(r.rows[0].entreprise_id, 'abonnement.change');
    await audit.journaliser(ctx, 'abonnement.statut', { cible_type: 'abonnement', cible_id: id, details: { statut } });
    return { ok: true };
  });

  // ---------- Conformité : mentions légales, outils tiers, consentements (lecture seule) ----------
  router.get('/api/admin/super/conformite', P('conformite.lire'), async () => {
    const c = require('../lib/conformite');
    const [cons, sans] = await Promise.all([
      db.query('SELECT type, version, accepte, COUNT(*)::int AS n FROM consentements GROUP BY type, version, accepte ORDER BY type, version DESC'),
      db.query("SELECT COUNT(*)::int AS n FROM entreprises e WHERE e.cloture_le IS NULL AND NOT EXISTS (SELECT 1 FROM consentements k WHERE k.entreprise_id = e.id AND k.type = 'conditions' AND k.version = $1 AND k.accepte)", [c.VERSIONS.conditions]),
    ]);
    return {
      versions: c.VERSIONS, mentions_manquantes: c.mentionsManquantes().map(([cle, libelle]) => ({ cle, libelle })), audit: c.auditer(),
      donnees: c.DONNEES, stockage: [...c.STOCKAGE, ...c.AUTRES_STOCKAGES.map((s) => ({ motif: s.nom, type: 'Navigateur', ...s }))], tiers: c.TIERS,
      consentements: cons.rows, entreprises_sans_accord_a_jour: (sans.rows[0] && sans.rows[0].n) || 0, retention_connexions_jours: c.RETENTION_CONNEXIONS_JOURS,
    };
  });

  // ---------- Système : informations et sauvegarde logique ----------
  router.get('/api/admin/super/systeme', P('systeme.gerer'), async () => {
    const [taille, tables, sauvegardes] = await Promise.all([
      db.query('SELECT pg_database_size(current_database())::float8 AS octets'),
      db.query(`SELECT relname AS table, n_live_tup::int AS lignes FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 12`),
      db.query(`SELECT id, tables, lignes, octets, to_char(cree_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS cree_le FROM sauvegardes_journal ORDER BY id DESC LIMIT 10`, [TZ]),
    ]);
    return {
      version: require('../../package.json').version, node: process.version, demarrage_depuis_s: Math.round(process.uptime()),
      serverless: env.serverless, websocket: env.wsActif,
      base_octets: taille.rows[0] ? taille.rows[0].octets : null, tables: tables.rows, sauvegardes: sauvegardes.rows,
      configuration: { email_relances: Boolean(env.email.apiKey && env.email.from), cron_secret: Boolean(env.cronSecret), relances_auto: env.relancesAuto, seuil_engagement: env.seuilEngagement, conservation_ans: env.conservationAns },
      tables_exportables: Object.keys(EXPORTS),
    };
  });

  // Export JSON (sans aucun mot de passe, jeton ou clé). Ce n'est pas une sauvegarde de reprise après sinistre :
  // celle-ci reste celle de l'hébergeur de la base (Neon, Railway, Render…) — voir GOUVERNANCE-ADMIN.md.
  router.post('/api/admin/super/sauvegardes', P('systeme.gerer'), async (ctx) => {
    await limit(`sauvegarde:${ctx.admin.id}`, 5, 3600 * 1000);
    const demandees = Array.isArray(ctx.body.tables) && ctx.body.tables.length ? ctx.body.tables.map(String) : Object.keys(EXPORTS);
    const inconnue = demandees.find((t) => !EXPORTS[t]);
    if (inconnue) throw new HttpError(400, `Table inconnue : ${inconnue}.`);
    const contenu = { genere_le: new Date().toISOString(), version: require('../../package.json').version, tables: {} };
    let lignes = 0;
    for (const t of demandees) {
      const { rows } = await db.query(`${EXPORTS[t]} LIMIT ${MAX_LIGNES}`);
      contenu.tables[t] = rows; lignes += rows.length;
      if (rows.length === MAX_LIGNES) contenu.tables[`${t}__tronque`] = true;
    }
    const corps = JSON.stringify(contenu);
    await db.query('INSERT INTO sauvegardes_journal (admin_id, tables, lignes, octets) VALUES ($1, $2, $3, $4)', [ctx.admin.id, demandees.join(','), lignes, corps.length]);
    await audit.journaliser(ctx, 'sauvegarde.export', { cible_type: 'systeme', details: { tables: demandees, lignes } });
    const nom = `best-quinca-export-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}.json`;
    ctx.raw = { status: 200, body: corps, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${nom}"`, 'Cache-Control': 'no-store' } };
  });
};
module.exports.MIN_PWD = MIN_PWD;
