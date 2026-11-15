'use strict';
// Espace Administrateur de sécurité informatique. Aucun accès aux mots de passe, aux finances, aux abonnements
// ni aux paramètres : toutes les routes sont en lecture, ou limitent un accès (session, blocage) ou traitent une alerte.
const db = require('../lib/db');
const { HttpError, str, int } = require('../lib/http');
const { TZ } = require('../lib/tz');
const rbac = require('../lib/rbac');
const audit = require('../lib/audit');
const realtime = require('../lib/realtime');
const { limit } = require('../lib/ratelimit');

const PERIODES = { jour: '1 day', semaine: '7 days', mois: '30 days' };

module.exports = function register(router) {
  const P = rbac.exiger;
  const un = async (sql, params) => (await db.query(sql, params)).rows[0] || {};

  // ---------- Tableau de bord ----------
  router.get('/api/admin/securite/dashboard', P('securite.dashboard'), async () => {
    const [sess, ent, ech, al, susp, adm] = await Promise.all([
      un("SELECT COUNT(*)::int AS n FROM admin_sessions WHERE revoquee_le IS NULL AND expire_le > now()"),
      un("SELECT COUNT(DISTINCT compte_id)::int AS n FROM connexions_journal WHERE type_compte = 'entreprise' AND evenement = 'connexion' AND cree_le > now() - interval '12 hours'"),
      un("SELECT COUNT(*) FILTER (WHERE cree_le > now() - interval '24 hours')::int AS j, COUNT(*) FILTER (WHERE cree_le > now() - interval '15 minutes')::int AS recent FROM connexions_journal WHERE evenement = 'echec'"),
      un("SELECT COUNT(*) FILTER (WHERE statut = 'ouverte' AND type <> 'modification_sensible')::int AS ouvertes, COUNT(*) FILTER (WHERE statut IN ('ouverte', 'en_cours') AND gravite IN ('haute', 'critique'))::int AS graves FROM security_alerts"),
      un("SELECT COUNT(*)::int AS n FROM (SELECT email FROM connexions_journal WHERE evenement = 'echec' AND cree_le > now() - interval '24 hours' AND email IS NOT NULL GROUP BY email HAVING COUNT(*) >= 5) s"),
      un("SELECT COUNT(*)::int AS n FROM admins_plateforme WHERE bloque_jusqua > now()"),
    ]);
    const niveau = (al.graves || 0) > 0 ? 'critique' : (al.ouvertes || 0) > 0 || (ech.recent || 0) >= 5 ? 'vigilance' : 'normal';
    const serie = await db.query(
      `SELECT to_char(d, 'MM-DD') AS jour, COALESCE(c.echecs, 0)::int AS echecs, COALESCE(c.connexions, 0)::int AS connexions
         FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, interval '1 day') d
         LEFT JOIN (SELECT (cree_le AT TIME ZONE $1)::date AS j, COUNT(*) FILTER (WHERE evenement = 'echec') AS echecs, COUNT(*) FILTER (WHERE evenement = 'connexion') AS connexions
                      FROM connexions_journal WHERE cree_le > now() - interval '8 days' GROUP BY 1) c ON c.j = d::date ORDER BY d`, [TZ]);
    return {
      niveau, connexions_actives: { administrateurs: sess.n || 0, entreprises_12h: ent.n || 0 },
      echecs: { dernieres_24h: ech.j || 0, dernieres_15min: ech.recent || 0 }, alertes: { ouvertes: al.ouvertes || 0, graves: al.graves || 0 },
      comptes_suspects: susp.n || 0, admins_bloques: adm.n || 0, serie: serie.rows,
    };
  });

  // ---------- Comptes (jamais de mot de passe ni de hash) ----------
  router.get('/api/admin/securite/comptes', P('securite.comptes.lire'), async (ctx) => {
    const q = String(ctx.query.q || '').slice(0, 100).replace(/[\\%_]/g, '\\$&');
    const [adm, usr] = await Promise.all([
      db.query(`SELECT a.id, a.nom_complet, a.email, a.role, a.actif, a.bloque_jusqua, to_char(a.derniere_connexion AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS derniere_connexion,
                       (SELECT COUNT(*) FROM admin_sessions s WHERE s.admin_id = a.id AND s.revoquee_le IS NULL AND s.expire_le > now())::int AS sessions_actives,
                       (SELECT COUNT(*) FROM connexions_journal c WHERE c.type_compte = 'admin' AND c.compte_id = a.id AND c.evenement = 'echec' AND c.cree_le > now() - interval '24 hours')::int AS echecs_24h
                  FROM admins_plateforme a ORDER BY a.id`, [TZ]),
      db.query(`SELECT u.id, u.nom_complet, u.email, u.role, u.actif, u.bloque_jusqua, e.nom AS entreprise, e.id AS entreprise_id,
                       (SELECT to_char(MAX(c.cree_le) AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') FROM connexions_journal c WHERE c.type_compte = 'entreprise' AND c.compte_id = u.id AND c.evenement = 'connexion') AS derniere_connexion,
                       (SELECT COUNT(*) FROM connexions_journal c WHERE c.type_compte = 'entreprise' AND c.compte_id = u.id AND c.evenement = 'echec' AND c.cree_le > now() - interval '24 hours')::int AS echecs_24h
                  FROM utilisateurs u JOIN entreprises e ON e.id = u.entreprise_id
                 WHERE ($2::text = '' OR u.email ILIKE '%' || $2::text || '%' OR u.nom_complet ILIKE '%' || $2::text || '%' OR e.nom ILIKE '%' || $2::text || '%')
                 ORDER BY u.id DESC LIMIT 200`, [TZ, q]),
    ]);
    return { administrateurs: adm.rows, utilisateurs: usr.rows };
  });

  // Comptes suspects : beaucoup d'échecs récents, ou alerte ouverte
  router.get('/api/admin/securite/comptes-suspects', P('securite.comptes.lire'), async () => {
    const { rows } = await db.query(
      `SELECT email, type_compte, COUNT(*)::int AS echecs, COUNT(DISTINCT ip)::int AS adresses, to_char(MAX(cree_le) AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS dernier
         FROM connexions_journal WHERE evenement = 'echec' AND cree_le > now() - interval '24 hours' AND email IS NOT NULL
        GROUP BY email, type_compte HAVING COUNT(*) >= 5 ORDER BY COUNT(*) DESC LIMIT 50`, [TZ]);
    return rows;
  });

  // ---------- Sessions ----------
  router.get('/api/admin/securite/sessions', P('securite.sessions.lire'), async () => {
    const [adm, ent] = await Promise.all([
      db.query(`SELECT s.id, a.id AS admin_id, a.email, a.role, s.ip, s.navigateur, to_char(s.cree_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS cree_le,
                       to_char(s.derniere_activite AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS derniere_activite
                  FROM admin_sessions s JOIN admins_plateforme a ON a.id = s.admin_id WHERE s.revoquee_le IS NULL AND s.expire_le > now() ORDER BY s.derniere_activite DESC LIMIT 100`, [TZ]),
      db.query(`SELECT c.compte_id AS utilisateur_id, c.email, e.nom AS entreprise, c.ip, to_char(MAX(c.cree_le) AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS derniere
                  FROM connexions_journal c LEFT JOIN entreprises e ON e.id = c.entreprise_id
                 WHERE c.type_compte = 'entreprise' AND c.evenement = 'connexion' AND c.cree_le > now() - interval '12 hours'
                 GROUP BY c.compte_id, c.email, e.nom, c.ip ORDER BY MAX(c.cree_le) DESC LIMIT 100`, [TZ]),
    ]);
    return { administrateurs: adm.rows, entreprises: ent.rows };
  });

  // Les sessions du Super administrateur ne peuvent pas être révoquées par l'administrateur de sécurité
  router.post('/api/admin/securite/sessions/:id/revoquer', P('securite.sessions.revoquer'), async (ctx) => {
    const id = str(ctx.params.id, 'session', { max: 40 });
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Session invalide.');
    const s = (await db.query('SELECT s.id, s.admin_id, a.role FROM admin_sessions s JOIN admins_plateforme a ON a.id = s.admin_id WHERE s.id = $1 AND s.revoquee_le IS NULL', [id])).rows[0];
    if (!s) throw new HttpError(404, 'Session introuvable ou déjà fermée.');
    if (s.role === 'SUPER_ADMIN' && ctx.admin.role !== 'SUPER_ADMIN') throw new HttpError(403, 'Les sessions du Super administrateur ne peuvent être révoquées que par lui-même : signalez le compte.');
    await db.query("UPDATE admin_sessions SET revoquee_le = now(), revoquee_par = $2, motif_revocation = 'securite' WHERE id = $1", [id, ctx.admin.id]);
    realtime.fermerAdmin(s.admin_id);
    await audit.journaliser(ctx, 'securite.session_revoquee', { cible_type: 'admin', cible_id: s.admin_id, details: { session: id } });
    return { ok: true };
  });

  router.post('/api/admin/securite/utilisateurs/:id/revoquer-sessions', P('securite.sessions.revoquer'), async (ctx) => {
    const id = int(ctx.params.id, 'utilisateur', { min: 1 });
    const r = await db.query('UPDATE utilisateurs SET sessions_revoquees_le = now() WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) throw new HttpError(404, 'Utilisateur introuvable.');
    realtime.fermerUtilisateur(id);
    await audit.journaliser(ctx, 'securite.sessions_utilisateur_revoquees', { cible_type: 'utilisateur', cible_id: id });
    return { ok: true };
  });

  // ---------- Blocage temporaire (jamais définitif : la suspension relève du Super admin) ----------
  const cible = async (type, id) => {
    if (type === 'utilisateur') return (await db.query('SELECT id, email, 0 AS est_super FROM utilisateurs WHERE id = $1', [id])).rows[0];
    if (type === 'admin') return (await db.query("SELECT id, email, (role = 'SUPER_ADMIN')::int AS est_super FROM admins_plateforme WHERE id = $1", [id])).rows[0];
    throw new HttpError(400, 'Type de compte invalide.');
  };

  router.post('/api/admin/securite/comptes/:type/:id/bloquer', P('securite.comptes.bloquer'), async (ctx) => {
    const type = ctx.params.type; const id = int(ctx.params.id, 'compte', { min: 1 });
    const minutes = int(ctx.body.minutes, 'durée', { min: 15, max: 10080, def: 60 });
    const motif = str(ctx.body.motif, 'motif', { min: 3, max: 300 });
    const c = await cible(type, id);
    if (!c) throw new HttpError(404, 'Compte introuvable.');
    if (type === 'admin' && (c.est_super || id === ctx.admin.id)) throw new HttpError(403, 'Ce compte administrateur ne peut pas être bloqué par la sécurité : signalez-le au Super administrateur.');
    const table = type === 'admin' ? 'admins_plateforme' : 'utilisateurs';
    await db.query(`UPDATE ${table} SET bloque_jusqua = now() + make_interval(mins => $2::int) WHERE id = $1`, [id, minutes]);
    if (type === 'admin') { await db.query("UPDATE admin_sessions SET revoquee_le = now(), revoquee_par = $2, motif_revocation = 'blocage' WHERE admin_id = $1 AND revoquee_le IS NULL", [id, ctx.admin.id]); realtime.fermerAdmin(id); }
    else { await db.query('UPDATE utilisateurs SET sessions_revoquees_le = now() WHERE id = $1', [id]); realtime.fermerUtilisateur(id); }
    await audit.journaliser(ctx, 'securite.compte_bloque', { cible_type: type, cible_id: id, details: { minutes, motif, email: c.email } });
    await require('../lib/securite').alerter({ type: 'compte_bloque', gravite: 'moyenne', titre: `Compte bloqué ${minutes} min : ${c.email}`, details: { motif, par: ctx.admin.email }, type_compte: type === 'admin' ? 'admin' : 'entreprise', compte_id: id, email: c.email, dedupMin: 1 });
    return { ok: true };
  });

  router.post('/api/admin/securite/comptes/:type/:id/debloquer', P('securite.comptes.bloquer'), async (ctx) => {
    const type = ctx.params.type; const id = int(ctx.params.id, 'compte', { min: 1 });
    const c = await cible(type, id);
    if (!c) throw new HttpError(404, 'Compte introuvable.');
    await db.query(`UPDATE ${type === 'admin' ? 'admins_plateforme' : 'utilisateurs'} SET bloque_jusqua = NULL WHERE id = $1`, [id]);
    await audit.journaliser(ctx, 'securite.compte_debloque', { cible_type: type, cible_id: id, details: { email: c.email } });
    return { ok: true };
  });

  // Signalement d'un compte suspect au Super admin : alerte marquée « signalée »
  router.post('/api/admin/securite/comptes/:type/:id/signaler', P('securite.signaler'), async (ctx) => {
    const type = ctx.params.type; const id = int(ctx.params.id, 'compte', { min: 1 });
    await limit(`signaler:${ctx.admin.id}`, 30, 3600 * 1000);
    const motif = str(ctx.body.motif, 'motif', { min: 5, max: 500 });
    const c = await cible(type, id);
    if (!c) throw new HttpError(404, 'Compte introuvable.');
    const r = await db.query(
      `INSERT INTO security_alerts (type, gravite, titre, details, type_compte, compte_id, email, signalee_super) VALUES ('compte_suspect', 'haute', $1, $2::jsonb, $3, $4, $5, true) RETURNING id`,
      [`Compte signalé au Super administrateur : ${c.email}`, JSON.stringify({ motif, par: ctx.admin.email }), type === 'admin' ? 'admin' : 'entreprise', id, c.email]);
    await audit.journaliser(ctx, 'securite.compte_signale', { cible_type: type, cible_id: id, details: { motif, alerte: r.rows[0].id } });
    ctx.status = 201;
    return { alerte: r.rows[0].id };
  });

  // ---------- Journaux (lecture seule) ----------
  router.get('/api/admin/securite/connexions', P('securite.journaux.lire'), async (ctx) => {
    const ev = ['connexion', 'echec', 'deconnexion'].includes(ctx.query.evenement) ? ctx.query.evenement : null;
    const type = ['admin', 'entreprise'].includes(ctx.query.type) ? ctx.query.type : null;
    const q = String(ctx.query.q || '').slice(0, 100).replace(/[\\%_]/g, '\\$&');
    const { rows } = await db.query(
      `SELECT id, to_char(cree_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI:SS') AS cree_le, type_compte, email, evenement, motif, ip, navigateur
         FROM connexions_journal WHERE ($2::text IS NULL OR evenement = $2::text) AND ($3::text IS NULL OR type_compte = $3::text)
          AND ($4::text = '' OR email ILIKE '%' || $4::text || '%' OR ip ILIKE '%' || $4::text || '%') ORDER BY id DESC LIMIT 200`, [TZ, ev, type, q]);
    return rows;
  });

  // Journal d'audit : lecture seule (aucune route de modification ni de suppression n'existe ; le déclencheur SQL les refuserait aussi)
  router.get('/api/admin/securite/audit', P('securite.journaux.lire'), async (ctx) => {
    const filtre = ctx.query.filtre === 'sensibles' ? ['admin.%', 'role.%', 'parametres.%', 'agregateur.%', 'acces.%', 'securite.%', 'demande.%', 'sauvegarde.%', 'tarif.%'] : null;
    const permissions = ctx.query.filtre === 'permissions';
    const action = String(ctx.query.action || '').slice(0, 80).replace(/[\\%_]/g, '\\$&');
    const { rows } = await db.query(
      `SELECT id, to_char(cree_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI:SS') AS cree_le, admin_email, role, action, cible_type, cible_id, details, ip, resultat
         FROM audit_journal WHERE ($2::text[] IS NULL OR action LIKE ANY ($2::text[])) AND (NOT $3::boolean OR action IN ('role.permissions_modifiees', 'admin.modifier', 'admin.creer', 'acces.refuse'))
          AND ($4::text = '' OR action ILIKE $4::text || '%') ORDER BY id DESC LIMIT 200`, [TZ, filtre, permissions, action]);
    return rows;
  });

  // ---------- Alertes et incidents ----------
  router.get('/api/admin/securite/alertes', P('securite.alertes.gerer'), async (ctx) => {
    const statut = ['ouverte', 'en_cours', 'traitee', 'faux_positif'].includes(ctx.query.statut) ? ctx.query.statut : null;
    const { rows } = await db.query(
      `SELECT id, type, gravite, statut, titre, details, type_compte, email, ip, signalee_super, note, to_char(cree_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS cree_le, to_char(traitee_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS traitee_le
         FROM security_alerts WHERE ($2::text IS NULL OR statut = $2::text) AND ($3::boolean OR type <> 'modification_sensible')
        ORDER BY (statut IN ('ouverte', 'en_cours')) DESC, id DESC LIMIT 200`, [TZ, statut, ctx.query.tout === '1']);
    return rows;
  });

  router.put('/api/admin/securite/alertes/:id', P('securite.alertes.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'alerte', { min: 1 });
    const statut = str(ctx.body.statut, 'statut', { max: 12 });
    if (!['en_cours', 'traitee', 'faux_positif', 'ouverte'].includes(statut)) throw new HttpError(400, 'Statut invalide.');
    const note = str(ctx.body.note, 'note', { optional: true, max: 500 });
    const r = await db.query(
      `UPDATE security_alerts SET statut = $2, note = COALESCE($3, note), traitee_par = $4, traitee_le = CASE WHEN $2 IN ('traitee', 'faux_positif') THEN now() ELSE NULL END WHERE id = $1 RETURNING type`,
      [id, statut, note, ctx.admin.id]);
    if (!r.rows.length) throw new HttpError(404, 'Alerte introuvable.');
    await audit.journaliser(ctx, 'securite.alerte_traitee', { cible_type: 'alerte', cible_id: id, details: { statut, note } });
    return { ok: true };
  });

  // ---------- Rapports ----------
  router.get('/api/admin/securite/rapports', P('securite.rapports.lire'), async (ctx) => {
    const periode = PERIODES[ctx.query.periode] ? ctx.query.periode : 'jour';
    const iv = PERIODES[periode];
    const [conn, echecs, alertes, parType, blocages, acces] = await Promise.all([
      un(`SELECT COUNT(*) FILTER (WHERE evenement = 'connexion')::int AS connexions, COUNT(*) FILTER (WHERE evenement = 'echec')::int AS echecs, COUNT(*) FILTER (WHERE evenement = 'deconnexion')::int AS deconnexions,
                 COUNT(DISTINCT ip) FILTER (WHERE evenement = 'echec')::int AS adresses_en_echec FROM connexions_journal WHERE cree_le > now() - $1::interval`, [iv]),
      db.query(`SELECT email, COUNT(*)::int AS echecs FROM connexions_journal WHERE evenement = 'echec' AND cree_le > now() - $1::interval AND email IS NOT NULL GROUP BY email ORDER BY COUNT(*) DESC LIMIT 5`, [iv]),
      un(`SELECT COUNT(*) FILTER (WHERE type <> 'modification_sensible')::int AS total, COUNT(*) FILTER (WHERE gravite IN ('haute', 'critique'))::int AS graves, COUNT(*) FILTER (WHERE statut IN ('traitee', 'faux_positif'))::int AS closes FROM security_alerts WHERE cree_le > now() - $1::interval`, [iv]),
      db.query(`SELECT type, COUNT(*)::int AS n FROM security_alerts WHERE cree_le > now() - $1::interval AND type <> 'modification_sensible' GROUP BY type ORDER BY n DESC`, [iv]),
      un(`SELECT COUNT(*)::int AS n FROM audit_journal WHERE action = 'securite.compte_bloque' AND cree_le > now() - $1::interval`, [iv]),
      un(`SELECT COUNT(*)::int AS n FROM audit_journal WHERE action = 'acces.refuse' AND cree_le > now() - $1::interval`, [iv]),
    ]);
    const provisoires = await un("SELECT COUNT(*)::int AS n FROM admins_plateforme WHERE mdp_temporaire AND actif");
    // Recommandations déduites des chiffres de la période
    const reco = [];
    if (conn.echecs >= 20) reco.push('Nombre élevé d\'échecs de connexion : vérifier les adresses les plus actives et envisager un blocage temporaire des comptes ciblés.');
    if (conn.adresses_en_echec >= 5) reco.push('Plusieurs adresses distinctes échouent : possible attaque distribuée. Surveiller les comptes administrateurs en priorité.');
    if (alertes.graves > 0) reco.push(`${alertes.graves} alerte(s) grave(s) sur la période : à traiter ou à signaler au Super administrateur.`);
    if (acces.n > 0) reco.push(`${acces.n} tentative(s) d'accès non autorisé : contrôler les rôles attribués et les permissions.`);
    if (provisoires.n > 0) reco.push(`${provisoires.n} compte(s) administrateur gardent encore un mot de passe provisoire : demander son remplacement.`);
    if (!reco.length) reco.push('Aucune anomalie notable sur la période. Continuer la surveillance habituelle et revoir les rôles chaque mois.');
    return {
      periode, connexions: conn, alertes: { ...alertes, par_type: parType.rows }, comptes_les_plus_cibles: echecs.rows, comptes_bloques: blocages.n || 0, acces_refuses: acces.n || 0,
      recommandations: reco, genere_le: new Date().toISOString(),
    };
  });
};
