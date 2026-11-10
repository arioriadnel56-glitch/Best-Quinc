'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { env } = require('../lib/env');
const db = require('../lib/db');
const jwt = require('../lib/jwt');
const { HttpError, str, int, email } = require('../lib/http');
const { hashPassword, verifyPassword } = require('../lib/password');
const { authAdmin } = require('../lib/auth');
const { limit } = require('../lib/ratelimit');
const { TZ } = require('../lib/tz');
const settings = require('../lib/settings');
const { MIN_PWD } = require('../lib/admins');
const recovery = require('../lib/recovery');
const realtime = require('../lib/realtime');

const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'admin.html'), 'utf8');
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;
const SESSION_S = 12 * 3600;

module.exports = function register(router) {
  router.get('/admin', async (ctx) => {
    ctx.raw = {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
      body: adminHtml,
    };
  });

  router.post('/api/admin/login', async (ctx) => {
    const mail = email(ctx.body.email);
    const pwd = str(ctx.body.mot_de_passe, 'mot de passe', { max: 200 });
    await limit(`admin-login:${ctx.ip}|${mail}`, 8, 15 * 60 * 1000);
    await limit(`admin-login-ip:${ctx.ip}`, 30, 15 * 60 * 1000);
    await limit(`admin-login-cible:${mail}`, 20, 15 * 60 * 1000);
    const { rows } = await db.query('SELECT id, mot_de_passe_hash, actif FROM admins_plateforme WHERE email = $1', [mail]);
    const a = rows[0];
    const ok = await verifyPassword(pwd, a ? a.mot_de_passe_hash : DUMMY_HASH);
    if (!a || !ok || !a.actif) throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
    return { token: jwt.sign({ sub: a.id, typ: 'admin' }, env.jwtSecret, SESSION_S) };
  });

  router.get('/api/admin/me', authAdmin, async (ctx) => ({
    admin: { nom_complet: ctx.admin.nom_complet, email: ctx.admin.email },
  }));

  router.post('/api/admin/mot-de-passe', authAdmin, async (ctx) => {
    const ancien = str(ctx.body.ancien, 'ancien mot de passe', { max: 200 });
    const nouveau = str(ctx.body.nouveau, 'nouveau mot de passe', { min: MIN_PWD, max: 200 });
    const { rows } = await db.query('SELECT mot_de_passe_hash FROM admins_plateforme WHERE id = $1', [ctx.admin.id]);
    if (!(await verifyPassword(ancien, rows[0].mot_de_passe_hash))) throw new HttpError(400, 'Ancien mot de passe incorrect.');
    await db.query('UPDATE admins_plateforme SET mot_de_passe_hash = $1 WHERE id = $2', [await hashPassword(nouveau), ctx.admin.id]);
    return { ok: true };
  });

  // ---- Vue d'ensemble ----
  router.get('/api/admin/stats', authAdmin, async () => {
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

  // ---- Entreprises ----
  router.get('/api/admin/entreprises', authAdmin, async (ctx) => {
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

  router.put('/api/admin/entreprises/:id/statut', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const statut = str(ctx.body.statut, 'statut', { max: 20 });
    if (!['actif', 'suspendu'].includes(statut)) throw new HttpError(400, 'Statut invalide.');
    const r = await db.query('UPDATE entreprises SET statut = $1 WHERE id = $2', [statut, id]);
    if (!r.rowCount) throw new HttpError(404, 'Entreprise introuvable.');
    if (statut === 'suspendu') realtime.fermerEntreprise(id);
    return { ok: true };
  });

  router.post('/api/admin/entreprises/:id/offrir', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const jours = int(ctx.body.jours, 'nombre de jours', { min: 1, max: 366 });
    const fin = await db.tx(async (q) => {
      const e = await q('SELECT id FROM entreprises WHERE id = $1', [id]);
      if (!e.rows.length) throw new HttpError(404, 'Entreprise introuvable.');
      const r = await q(
        `INSERT INTO abonnements (entreprise_id, montant, statut, date_debut, date_fin)
         SELECT $1::int, 0, 'actif', d.debut, d.debut + $2::int
           FROM (SELECT GREATEST(CURRENT_DATE, COALESCE(MAX(date_fin), CURRENT_DATE)) AS debut
                   FROM abonnements WHERE entreprise_id = $1::int AND statut = 'actif') d
         RETURNING to_char(date_fin, 'YYYY-MM-DD') AS date_fin`,
        [id, jours],
      );
      return r.rows[0].date_fin;
    });
    realtime.publier(id, 'abonnement.change');
    return { date_fin: fin };
  });

  // ---- Récupération d'accès d'une entreprise ----
  router.get('/api/admin/entreprises/:id/utilisateurs', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const { rows } = await db.query(
      `SELECT id, nom_complet, email, role, actif, (code_recuperation_hash IS NOT NULL) AS a_code_recuperation
         FROM utilisateurs WHERE entreprise_id = $1 ORDER BY role, nom_complet`,
      [id],
    );
    return rows;
  });

  router.post('/api/admin/entreprises/:id/utilisateurs/:uid/reinitialiser', authAdmin, async (ctx) => {
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
    console.log(`[admin ${ctx.admin.email}] mot de passe réinitialisé : utilisateur ${uid}, entreprise ${id}`);
    return { email: r.rows[0].email, mot_de_passe_temporaire: temporaire };
  });

  router.post('/api/admin/entreprises/:id/utilisateurs/:uid/code-recuperation', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const uid = int(ctx.params.uid, 'utilisateur', { min: 1 });
    const code = recovery.genererCode();
    const r = await db.query(
      `UPDATE utilisateurs SET code_recuperation_hash = $1 WHERE id = $2 AND entreprise_id = $3 RETURNING email`,
      [recovery.empreinte(code), uid, id],
    );
    if (!r.rows.length) throw new HttpError(404, 'Utilisateur introuvable dans cette entreprise.');
    console.log(`[admin ${ctx.admin.email}] code de récupération régénéré : utilisateur ${uid}, entreprise ${id}`);
    return { email: r.rows[0].email, code_recuperation: code };
  });

  // ---- Paiements ----
  router.get('/api/admin/paiements', authAdmin, async (ctx) => {
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

  router.post('/api/admin/entreprises/:id/tableau-remise', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const note = str(ctx.body.note, 'note', { optional: true, max: 255 });
    const r = await db.tx(async (q) => {
      const e = await q('UPDATE entreprises SET tableau_depuis = now() WHERE id = $1 RETURNING id', [id]);
      if (!e.rows.length) throw new HttpError(404, 'Entreprise introuvable.');
      await q('INSERT INTO tableau_remises (entreprise_id, admin_id, note) VALUES ($1, $2, $3)', [id, ctx.admin.id, note]);
      return e.rows[0];
    });
    realtime.publier(r.id, 'tableau.remis', { par: 'admin' });
    ctx.status = 201;
    return { ok: true };
  });

  // ---- Paramètres ----
  router.get('/api/admin/parametres', authAdmin, async () => ({
    parametres: await settings.describe(),
    webhook_kkiapay: '/api/webhooks/kkiapay',
    webhook_fedapay: '/api/webhooks/fedapay',
  }));

  router.put('/api/admin/parametres', authAdmin, async (ctx) => {
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
    console.log(`[admin ${ctx.admin.email}] paramètres modifiés : ${[...Object.keys(aEcrire), ...effacer.map((k) => `${k} (effacé)`)].join(', ')}`);
    return { parametres: await settings.describe() };
  });
};
