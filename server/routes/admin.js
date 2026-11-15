'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { env } = require('../lib/env');
const db = require('../lib/db');
const jwt = require('../lib/jwt');
const { HttpError, str, int, email } = require('../lib/http');
const { hashPassword, verifyPassword } = require('../lib/password');
const crypto = require('node:crypto');
const rbac = require('../lib/rbac');
const { offrirJours } = require('../lib/abonnements-admin');
const audit = require('../lib/audit');
const securite = require('../lib/securite');
const { motDePasseFaible } = require('../lib/password');

// Sécurisation de l'import de limit pour éviter tout crash si le module exporte un objet ou une fonction
const ratelimitModule = require('../lib/ratelimit');
const limit = typeof ratelimitModule === 'function' ? ratelimitModule : (ratelimitModule.limit || (async () => {}));

const { TZ } = require('../lib/tz');
const settings = require('../lib/settings');
const { MIN_PWD } = require('../lib/admins');
const recovery = require('../lib/recovery');
const realtime = require('../lib/realtime');

const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'admin.html'), 'utf8');
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;
const SESSION_S = 12 * 3600;

module.exports = function register(router) {
  const servirAdmin = async (ctx) => {
    ctx.raw = {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
      body: adminHtml,
    };
  };
  ['/admin', '/admin/super', '/admin/finance', '/admin/security'].forEach((chemin) => router.get(chemin, servirAdmin));

  // ---- Connexion, session, profil (tous rôles) ----
  router.post('/api/admin/login', async (ctx) => {
    const mail = email(ctx.body.email);
    const pwd = str(ctx.body.mot_de_passe, 'mot de passe', { max: 200 });
    
    if (typeof limit === 'function') {
      await limit(`admin-login:${ctx.ip}|${mail}`, 8, 15 * 60 * 1000);
      await limit(`admin-login-ip:${ctx.ip}`, 30, 15 * 60 * 1000);
      await limit(`admin-login-cible:${mail}`, 20, 15 * 60 * 1000);
    }

    const { rows } = await db.query('SELECT id, nom_complet, email, mot_de_passe_hash, actif, role, mdp_temporaire, bloque_jusqua FROM admins_plateforme WHERE email = $1', [mail]);
    const a = rows[0];
    const ok = await verifyPassword(pwd, a ? a.mot_de_passe_hash : DUMMY_HASH);
    const echec = async (motif, message = 'E-mail ou mot de passe incorrect.') => {
      await securite.enregistrerConnexion({ type_compte: 'admin', compte_id: a ? a.id : null, email: mail, evenement: 'echec', motif, ctx });
      throw new HttpError(401, message);
    };
    if (!a || !ok) await echec(!a ? 'compte_inconnu' : 'mot_de_passe');
    if (!a.actif) await echec('compte_suspendu');
    if (a.bloque_jusqua && new Date(a.bloque_jusqua) > new Date()) await echec('compte_bloque', 'Compte temporairement bloqué pour raison de sécurité. Contactez le Super administrateur.');
    if (!rbac.ROLES[a.role]) await echec('role_inconnu', 'Ce compte n\'a pas de rôle valide.');
    await securite.connexionInhabituelle(a, ctx);
    const sid = crypto.randomUUID();
    await db.query(
      `INSERT INTO admin_sessions (id, admin_id, ip, navigateur, expire_le) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::float8))`,
      [sid, a.id, ctx.ip || null, securite.navigateur(ctx.req), SESSION_S],
    );
    await db.query('UPDATE admins_plateforme SET derniere_connexion = now() WHERE id = $1', [a.id]);
    await securite.enregistrerConnexion({ type_compte: 'admin', compte_id: a.id, email: a.email, evenement: 'connexion', ctx });
    await audit.journaliser({ admin: a, ip: ctx.ip }, 'admin.connexion', { cible_type: 'admin', cible_id: a.id });
    const espace = rbac.ROLES[a.role].espace;
    return { token: jwt.sign({ sub: a.id, typ: 'admin', sid }, env.jwtSecret, SESSION_S), role: a.role, espace, redirection: `/admin/${espace}`, mdp_temporaire: Boolean(a.mdp_temporaire) };
  });

  router.post('/api/admin/logout', rbac.connecte, async (ctx) => {
    await db.query('UPDATE admin_sessions SET revoquee_le = now(), motif_revocation = $2 WHERE id = $1 AND revoquee_le IS NULL', [ctx.admin.sid, 'deconnexion']);
    await securite.enregistrerConnexion({ type_compte: 'admin', compte_id: ctx.admin.id, email: ctx.admin.email, evenement: 'deconnexion', ctx });
    return { ok: true };
  });

  router.get('/api/admin/me', rbac.connecte, async (ctx) => {
    const perms = await rbac.permissionsDe(ctx.admin.role);
    const r = rbac.ROLES[ctx.admin.role] || {};
    return {
      admin: {
        id: ctx.admin.id, nom_complet: ctx.admin.nom_complet, email: ctx.admin.email,
        role: ctx.admin.role, role_libelle: r.libelle || ctx.admin.role, espace: r.espace || null,
        permissions: [...perms].sort(), mdp_temporaire: Boolean(ctx.admin.mdp_temporaire),
      },
    };
  });

  router.post('/api/admin/mot-de-passe', rbac.connecte, async (ctx) => {
    const ancien = str(ctx.body.ancien, 'ancien mot de passe', { max: 200 });
    const nouveau = str(ctx.body.nouveau, 'nouveau mot de passe', { min: MIN_PWD, max: 200 });
    if (typeof limit === 'function') {
      await limit(`admin-mdp:${ctx.admin.id}`, 10, 15 * 60 * 1000);
    }
    if (nouveau === ancien) throw new HttpError(400, 'Le nouveau mot de passe doit être différent de l\'actuel.');
    const faible = motDePasseFaible(nouveau, [ctx.admin.email, ctx.admin.nom_complet]);
    if (faible) throw new HttpError(400, faible);
    const { rows } = await db.query('SELECT mot_de_passe_hash FROM admins_plateforme WHERE id = $1', [ctx.admin.id]);
    if (!(await verifyPassword(ancien, rows[0].mot_de_passe_hash))) throw new HttpError(400, 'Ancien mot de passe incorrect.');
    await db.query('UPDATE admins_plateforme SET mot_de_passe_hash = $1, mdp_temporaire = false WHERE id = $2', [await hashPassword(nouveau), ctx.admin.id]);
    await db.query(`UPDATE admin_sessions SET revoquee_le = now(), motif_revocation = 'mot_de_passe_change' WHERE admin_id = $1 AND id <> $2 AND revoquee_le IS NULL`, [ctx.admin.id, ctx.admin.sid]);
    await audit.journaliser(ctx, 'admin.mdp_change', { cible_type: 'admin', cible_id: ctx.admin.id });
    return { ok: true };
  });

  router.get('/api/admin/moi/activite', rbac.connecte, async (ctx) => {
    const { rows } = await db.query(
      `SELECT id, to_char(cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI:SS') AS cree_le, action, cible_type, cible_id, resultat, ip
         FROM audit_journal WHERE admin_id = $1 ORDER BY id DESC LIMIT 100`, [ctx.admin.id, TZ]);
    return rows;
  });

  router.get('/api/admin/notifications', rbac.connecte, async (ctx) => {
    const p = await rbac.permissionsDe(ctx.admin.role);
    const items = [];
    const compte = async (sql) => (await db.query(sql)).rows[0]?.n || 0;
    if (p.has('demandes.valider')) {
      const n = await compte("SELECT COUNT(*)::int AS n FROM subscription_management_requests WHERE statut = 'en_attente'");
      if (n) items.push({ id: 'demandes', texte: `${n} demande(s) à valider`, lien: '#/demandes', nombre: n });
    }
    if (p.has('securite.alertes.gerer') || p.has('admins.gerer')) {
      const n = await compte("SELECT COUNT(*)::int AS n FROM security_alerts WHERE statut = 'ouverte' AND type <> 'modification_sensible'");
      if (n) items.push({ id: 'alertes', texte: `${n} alerte(s) de sécurité ouverte(s)`, lien: p.has('securite.alertes.gerer') ? '#/alertes' : '#/securite', nombre: n });
    }
    if (p.has('finance.relances')) {
      const n = await compte("SELECT COUNT(*)::int AS n FROM subscription_reminders WHERE statut = 'echec' OR (statut = 'programmee' AND programmee_le <= now())");
      if (n) items.push({ id: 'relances', texte: `${n} relance(s) à traiter`, lien: '#/relances', nombre: n });
    }
    return { total: items.reduce((t, i) => t + i.nombre, 0), items };
  });

  router.get('/api/admin/stats', rbac.exiger('super.dashboard'), async () => {
    const [ent, abo, rev, serie] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE statut = 'actif')::int AS actives,
                COUNT(*) FILTER (WHERE statut <> 'actif')::int AS suspendues,
                COUNT(*) FILTER (WHERE (cree_le AT TIME ZONE $1) >= date_trunc('month', now() AT TIME ZONE $1))::int AS nouvelles_mois
           FROM entreprises`,
        [TZ],
      ),
      db.query(
        `SELECT COUNT(DISTINCT entreprise_id)::int AS actifs,
                COUNT(DISTINCT entreprise_id) FILTER (WHERE montant > 0)::int AS payants
           FROM abonnements WHERE statut = 'actif' AND date_fin >= CURRENT_DATE`,
      ),
      db.query(
        `SELECT COALESCE(SUM(montant) FILTER (WHERE (confirme_le AT TIME ZONE $1) >= date_trunc('month', now() AT TIME ZONE $1)), 0)::float8 AS mois,
                COALESCE(SUM(montant), 0)::float8 AS total
           FROM paiements WHERE statut = 'reussi'`,
        [TZ],
      ),
      db.query(
        `SELECT to_char(date_trunc('month', confirme_le AT TIME ZONE $1), 'YYYY-MM') AS mois, SUM(montant)::float8 AS total
           FROM paiements WHERE statut = 'reussi' AND confirme_le >= now() - interval '6 months'
          GROUP BY 1 ORDER BY 1`,
        [TZ],
      ),
    ]);
    return { entreprises: ent.rows[0], abonnes: abo.rows[0], revenus: rev.rows[0], serie: serie.rows };
  });

  router.get('/api/admin/entreprises', rbac.exiger('finance.entreprises.lire'), async (ctx) => {
    const q = String(ctx.query.q || '').slice(0, 100).replace(/[\\%_]/g, '\\$&');
    const { rows } = await db.query(
      `SELECT e.id, e.nom, e.slug, e.statut, e.email, e.telephone,
              to_char(e.cree_le AT TIME ZONE $1, 'YYYY-MM-DD') AS cree_le,
              (SELECT COUNT(*) FROM utilisateurs u WHERE u.entreprise_id = e.id)::int AS nb_utilisateurs,
              (SELECT COUNT(*) FROM ventes v WHERE v.entreprise_id = e.id)::int AS nb_ventes,
              (SELECT to_char(MAX(a.date_fin), 'YYYY-MM-DD') FROM abonnements a
                WHERE a.entreprise_id = e.id AND a.statut = 'actif' AND a.date_fin >= CURRENT_DATE) AS fin_abonnement
         FROM entreprises e
        WHERE ($2::text = '' OR e.nom ILIKE '%' || $2::text || '%' OR e.slug ILIKE '%' || $2::text || '%' OR e.email ILIKE '%' || $2::text || '%')
        ORDER BY e.id DESC LIMIT 200`,
      [TZ, q],
    );
    return rows;
  });

  router.put('/api/admin/entreprises/:id/statut', rbac.exiger('entreprises.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const statut = str(ctx.body.statut, 'statut', { max: 20 });
    if (!['actif', 'suspendu'].includes(statut)) throw new HttpError(400, 'Statut invalide.');
    const avant = await db.query('SELECT statut FROM entreprises WHERE id = $1', [id]);
    const r = await db.query('UPDATE entreprises SET statut = $1 WHERE id = $2', [statut, id]);
    if (!r.rowCount) throw new HttpError(404, 'Entreprise introuvable.');
    if (statut === 'suspendu') realtime.fermerEntreprise(id);
    await audit.journaliser(ctx, 'entreprise.statut', { cible_type: 'entreprise', cible_id: id, details: { avant: avant.rows[0] && avant.rows[0].statut, apres: statut } });
    return { ok: true };
  });

  router.post('/api/admin/entreprises/:id/offrir', rbac.exiger('abonnements.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const jours = int(ctx.body.jours, 'nombre de jours', { min: 1, max: 366 });
    const fin = await db.tx((q) => offrirJours(q, id, jours));
    await audit.journaliser(ctx, 'abonnement.offert', { cible_type: 'entreprise', cible_id: id, details: { jours, nouvelle_fin: fin } });
    realtime.publier(id, 'abonnement.change');
    return { date_fin: fin };
  });

  router.get('/api/admin/entreprises/:id/utilisateurs', rbac.exiger('entreprises.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const { rows } = await db.query(
      `SELECT id, nom_complet, email, role, actif, (code_recuperation_hash IS NOT NULL) AS a_code_recuperation
         FROM utilisateurs WHERE entreprise_id = $1 ORDER BY role, nom_complet`,
      [id],
    );
    return rows;
  });

  router.post('/api/admin/entreprises/:id/utilisateurs/:uid/reinitialiser', rbac.exiger('entreprises.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const uid = int(ctx.params.uid, 'utilisateur', { min: 1 });
    const temporaire = recovery.genererTemporaire();
    const r = await db.query(
      `UPDATE utilisateurs SET mot_de_passe_hash = $1, mdp_modifie_le = now(), mdp_temporaire = true, actif = true
        WHERE id = $2 AND entreprise_id = $3 RETURNING email`,
      [await hashPassword(temporaire), uid, id],
    );
    if (!r.rows.length) throw new HttpError(404, 'Utilisateur introuvable dans cette entreprise.');
    realtime.fermerUtilisateur(uid);
    await audit.journaliser(ctx, 'acces.mdp_reinitialise', { cible_type: 'utilisateur', cible_id: uid, details: { entreprise_id: id } });
    return { email: r.rows[0].email, mot_de_passe_temporaire: temporaire };
  });

  router.post('/api/admin/entreprises/:id/utilisateurs/:uid/code-recuperation', rbac.exiger('entreprises.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const uid = int(ctx.params.uid, 'utilisateur', { min: 1 });
    const code = recovery.genererCode();
    const r = await db.query(
      `UPDATE utilisateurs SET code_recuperation_hash = $1 WHERE id = $2 AND entreprise_id = $3 RETURNING email`,
      [recovery.empreinte(code), uid, id],
    );
    if (!r.rows.length) throw new HttpError(404, 'Utilisateur introuvable dans cette entreprise.');
    await audit.journaliser(ctx, 'acces.code_regenere', { cible_type: 'utilisateur', cible_id: uid, details: { entreprise_id: id } });
    return { email: r.rows[0].email, code_recuperation: code };
  });

  router.get('/api/admin/paiements', rbac.exiger('finance.paiements.lire'), async (ctx) => {
    const statut = ['reussi', 'en_attente', 'echoue'].includes(ctx.query.statut) ? ctx.query.statut : null;
    const { rows } = await db.query(
      `SELECT p.id, p.agregateur, p.plan, p.reference_transaction, p.montant, p.statut, e.nom AS entreprise, e.slug,
              to_char(p.cree_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM paiements p JOIN entreprises e ON e.id = p.entreprise_id
        WHERE ($2::text IS NULL OR p.statut = $2::text)
        ORDER BY p.id DESC LIMIT 200`,
      [TZ, statut],
    );
    return rows;
  });

  router.post('/api/admin/entreprises/:id/tableau-remise', rbac.exiger('entreprises.gerer'), async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const note = str(ctx.body.note, 'note', { optional: true, max: 255 });
    const r = await db.tx(async (q) => {
      const e = await q('UPDATE entreprises SET tableau_depuis = now() WHERE id = $1 RETURNING id', [id]);
      if (!e.rows.length) throw new HttpError(404, 'Entreprise introuvable.');
      await q('INSERT INTO tableau_remises (entreprise_id, admin_id, note) VALUES ($1, $2, $3)', [id, ctx.admin.id, note]);
      return e.rows[0];
    });
    await audit.journaliser(ctx, 'entreprise.tableau_remis', { cible_type: 'entreprise', cible_id: id, details: { note } });
    realtime.publier(r.id, 'tableau.remis', { par: 'admin' });
    ctx.status = 201;
    return { ok: true };
  });

  router.get('/api/admin/parametres', rbac.exiger('parametres.lire'), async () => ({
    parametres: await settings.describe(),
    webhook_kkiapay: '/api/webhooks/kkiapay',
    webhook_fedapay: '/api/webhooks/fedapay',
  }));

  router.put('/api/admin/parametres', rbac.exiger('parametres.ecrire'), async (ctx) => {
    const valeurs = ctx.body.valeurs && typeof ctx.body.valeurs === 'object' && !Array.isArray(ctx.body.valeurs) ? ctx.body.valeurs : {};
    const effacer = Array.isArray(ctx.body.effacer) ? ctx.body.effacer : [];
    const aEcrire = {};
    for (const [k, v] of Object.entries(valeurs)) {
      if (!settings.DEFS[k]) throw new HttpError(400, `Paramètre inconnu : ${k}.`);
      if (settings.DEFS[k].secret && (v === '' || v === null || v === undefined)) continue;
      aEcrire[k] = settings.normaliser(k, v);
    }
    for (const k of effacer) {
      if (!settings.DEFS[k]) throw new HttpError(400, `Paramètre inconnu : ${k}.`);
      if (k in aEcrire) throw new HttpError(400, 'Impossible de modifier et d\'effacer le même paramètre.');
    }
    if (!Object.keys(aEcrire).length && !effacer.length) throw new HttpError(400, 'Aucune modification à enregistrer.');
    await settings.save(aEcrire, effacer);
    await audit.journaliser(ctx, 'parametres.modifies', { cible_type: 'parametres', details: { modifies: Object.keys(aEcrire).filter((k) => !settings.DEFS[k].secret), champs_proteges_modifies: Object.keys(aEcrire).filter((k) => settings.DEFS[k].secret), effaces: effacer } });
    return { parametres: await settings.describe() };
  });
};
