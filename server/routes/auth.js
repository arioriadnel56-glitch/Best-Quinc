'use strict';
const { env } = require('../lib/env');
const db = require('../lib/db');
const jwt = require('../lib/jwt');
const { HttpError, str, email, slugify } = require('../lib/http');
const { hashPassword, verifyPassword, motDePasseFaible } = require('../lib/password');
const verifierMdp = (pwd, contexte) => { const m = motDePasseFaible(pwd, contexte); if (m) throw new HttpError(400, m); };
const { auth, role, activeSubscription } = require('../lib/auth');
const { limit } = require('../lib/ratelimit');
const settings = require('../lib/settings');
const recovery = require('../lib/recovery');
const realtime = require('../lib/realtime');

// Hash factice : on dépense le même temps de calcul quand l'utilisateur n'existe pas
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

const token = (userId) => jwt.sign({ sub: userId, typ: 'user' }, env.jwtSecret);

module.exports = function register(router) {
  // Création d'une entreprise : son espace, son propriétaire et sa configuration PWA
  router.post('/api/entreprises/inscription', async (ctx) => {
    await limit(`inscription:${ctx.ip}`, 5, 3600 * 1000);
    const b = ctx.body;
    const nom = str(b.nom_entreprise, "nom de l'entreprise", { min: 2, max: 150 });
    const nomComplet = str(b.nom_complet, 'votre nom', { min: 2, max: 150 });
    const mail = email(b.email);
    const pwd = str(b.mot_de_passe, 'mot de passe', { min: 8, max: 200 });
    const tel = str(b.telephone, 'téléphone', { optional: true, max: 30 });
    const base = slugify(b.slug ? String(b.slug) : nom);
    verifierMdp(pwd, [mail, base, nomComplet]);
    if (base.length < 3) throw new HttpError(400, "L'identifiant de l'espace doit contenir au moins 3 lettres ou chiffres.");
    const hash = await hashPassword(pwd);
    const code = recovery.genererCode();
    const { essaiJours } = await settings.snapshot();

    const out = await db.tx(async (q) => {
      let slug = base;
      for (let i = 2; ; i++) {
        const ex = await q('SELECT 1 FROM entreprises WHERE slug = $1', [slug]);
        if (!ex.rows.length) break;
        if (b.slug) throw new HttpError(409, "Cet identifiant d'espace est déjà pris.");
        if (i > 50) throw new HttpError(409, "Impossible de générer un identifiant d'espace. Précisez-en un.");
        slug = `${base}-${i}`;
      }
      const ent = await q(
        'INSERT INTO entreprises (nom, slug, telephone, email) VALUES ($1, $2, $3, $4) RETURNING id, nom, slug',
        [nom, slug, tel, mail],
      );
      const e = ent.rows[0];
      await q('INSERT INTO pwa_configs (entreprise_id, nom_app) VALUES ($1, $2)', [e.id, nom.slice(0, 100)]);
      const usr = await q(
        `INSERT INTO utilisateurs (entreprise_id, nom_complet, email, mot_de_passe_hash, role, code_recuperation_hash)
         VALUES ($1, $2, $3, $4, 'proprietaire', $5) RETURNING id, nom_complet, email, role`,
        [e.id, nomComplet, mail, hash, recovery.empreinte(code)],
      );
      if (essaiJours > 0) {
        await q(
          `INSERT INTO abonnements (entreprise_id, montant, statut, date_debut, date_fin)
           VALUES ($1::int, 0, 'actif', CURRENT_DATE, CURRENT_DATE + $2::int)`,
          [e.id, essaiJours],
        );
      }
      return { e, u: usr.rows[0] };
    });

    realtime.publierAdmins('entreprise.nouvelle', { nom: out.e.nom });
    ctx.status = 201;
    // Le code de récupération n'est affiché qu'une seule fois
    return { token: token(out.u.id), entreprise: { nom: out.e.nom, slug: out.e.slug }, utilisateur: out.u, code_recuperation: code };
  });

  // Informations publiques pour personnaliser l'écran de connexion
  router.get('/api/entreprises/:slug/public', async (ctx) => {
    const { rows } = await db.query(
      `SELECT e.nom, e.slug, p.nom_app, p.couleur, (i.entreprise_id IS NOT NULL) AS a_logo,
              (EXTRACT(EPOCH FROM i.modifie_le))::bigint AS logo_v
         FROM entreprises e JOIN pwa_configs p ON p.entreprise_id = e.id
         LEFT JOIN entreprise_images i ON i.entreprise_id = e.id
        WHERE e.slug = $1 AND e.statut = 'actif'`,
      [ctx.params.slug.toLowerCase()],
    );
    if (!rows.length) throw new HttpError(404, 'Espace introuvable.');
    return rows[0];
  });

  router.post('/api/auth/login', async (ctx) => {
    const slug = str(ctx.body.slug, 'espace', { max: 60 }).toLowerCase();
    const mail = email(ctx.body.email);
    const pwd = str(ctx.body.mot_de_passe, 'mot de passe', { max: 200 });
    await limit(`login:${ctx.ip}|${slug}|${mail}`, 10, 15 * 60 * 1000);
    await limit(`login-ip:${ctx.ip}`, 100, 15 * 60 * 1000);
    // Plafond par compte, quelle que soit l'adresse IP : empêche la force brute même avec des centaines d'adresses
    await limit(`login-cible:${slug}|${mail}`, 30, 15 * 60 * 1000);

    const { rows } = await db.query(
      `SELECT u.id, u.mot_de_passe_hash, u.actif, e.statut
         FROM utilisateurs u JOIN entreprises e ON e.id = u.entreprise_id
        WHERE e.slug = $1 AND u.email = $2`,
      [slug, mail],
    );
    const u = rows[0];
    const ok = await verifyPassword(pwd, u ? u.mot_de_passe_hash : DUMMY_HASH);
    if (!u || !ok || !u.actif || u.statut !== 'actif') throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
    return { token: token(u.id) };
  });

  router.get('/api/auth/me', auth, async (ctx) => {
    const u = ctx.user;
    const ent = await db.query(
      `SELECT e.nom, e.slug, e.adresse, e.ville, e.telephone, e.email, e.ifu, e.rccm, e.site_web, e.pied_facture, e.pays_indicatif, e.partage_stats,
              p.nom_app, p.couleur, (i.entreprise_id IS NOT NULL) AS a_logo,
              (EXTRACT(EPOCH FROM i.modifie_le))::bigint AS logo_v
         FROM entreprises e JOIN pwa_configs p ON p.entreprise_id = e.id
         LEFT JOIN entreprise_images i ON i.entreprise_id = e.id WHERE e.id = $1`,
      [u.entreprise_id],
    );
    const sub = await activeSubscription(u.entreprise_id);
    return {
      utilisateur: {
        id: u.id, nom_complet: u.nom_complet, email: u.email, role: u.role,
        mdp_temporaire: Boolean(u.mdp_temporaire), a_code_recuperation: Boolean(u.a_code_recuperation),
      },
      entreprise: ent.rows[0],
      abonnement: sub,
    };
  });

  router.post('/api/auth/mot-de-passe', auth, async (ctx) => {
    const ancien = str(ctx.body.ancien, 'ancien mot de passe', { max: 200 });
    const nouveau = str(ctx.body.nouveau, 'nouveau mot de passe', { min: 8, max: 200 });
    await limit(`mdp:${ctx.user.id}`, 10, 15 * 60 * 1000);
    const { rows } = await db.query('SELECT mot_de_passe_hash FROM utilisateurs WHERE id = $1', [ctx.user.id]);
    if (!(await verifyPassword(ancien, rows[0].mot_de_passe_hash))) throw new HttpError(400, 'Ancien mot de passe incorrect.');
    if (ancien === nouveau) throw new HttpError(400, "Choisissez un mot de passe différent de l'ancien.");
    verifierMdp(nouveau, [ctx.user.email, ctx.user.nom_complet]);
    await db.query(
      'UPDATE utilisateurs SET mot_de_passe_hash = $1, mdp_modifie_le = now(), mdp_temporaire = false WHERE id = $2',
      [await hashPassword(nouveau), ctx.user.id],
    );
    // Les autres appareils sont déconnectés ; cet appareil reçoit une session neuve
    realtime.fermerUtilisateur(ctx.user.id);
    return { token: token(ctx.user.id) };
  });

  // Nouveau code de récupération (propriétaire, avec confirmation du mot de passe). L'ancien code cesse de fonctionner.
  router.post('/api/auth/code-recuperation', auth, role('proprietaire'), async (ctx) => {
    const pwd = str(ctx.body.mot_de_passe, 'mot de passe', { max: 200 });
    await limit(`code:${ctx.user.id}`, 10, 15 * 60 * 1000);
    const { rows } = await db.query('SELECT mot_de_passe_hash FROM utilisateurs WHERE id = $1', [ctx.user.id]);
    if (!(await verifyPassword(pwd, rows[0].mot_de_passe_hash))) throw new HttpError(400, 'Mot de passe incorrect.');
    const code = recovery.genererCode();
    await db.query('UPDATE utilisateurs SET code_recuperation_hash = $1 WHERE id = $2', [recovery.empreinte(code), ctx.user.id]);
    return { code_recuperation: code };
  });

  // Mot de passe oublié : l'espace, l'e-mail et le code de récupération donnent droit à un nouveau mot de passe
  router.post('/api/auth/recuperer', async (ctx) => {
    const slug = str(ctx.body.slug, 'espace', { max: 60 }).toLowerCase();
    const mail = email(ctx.body.email);
    const code = str(ctx.body.code, 'code de récupération', { max: 60 });
    const nouveau = str(ctx.body.nouveau, 'nouveau mot de passe', { min: 8, max: 200 });
    await limit(`recup:${ctx.ip}|${slug}|${mail}`, 5, 15 * 60 * 1000);
    await limit(`recup-cible:${slug}|${mail}`, 10, 3600 * 1000);
    verifierMdp(nouveau, [mail, slug]);

    const { rows } = await db.query(
      `SELECT u.id, u.code_recuperation_hash, u.actif, e.statut
         FROM utilisateurs u JOIN entreprises e ON e.id = u.entreprise_id
        WHERE e.slug = $1 AND u.email = $2`,
      [slug, mail],
    );
    const u = rows[0];
    const ok = recovery.correspond(code, u ? u.code_recuperation_hash : null);
    if (!u || !ok || !u.actif || u.statut !== 'actif') {
      throw new HttpError(400, "Espace, e-mail ou code de récupération incorrect. Si vous n'avez plus votre code, contactez l'administrateur de la plateforme.");
    }
    const neuf = recovery.genererCode();
    await db.query(
      `UPDATE utilisateurs SET mot_de_passe_hash = $1, mdp_modifie_le = now(), mdp_temporaire = false, code_recuperation_hash = $2 WHERE id = $3`,
      [await hashPassword(nouveau), recovery.empreinte(neuf), u.id],
    );
    realtime.fermerUtilisateur(u.id);
    // Le code utilisé est remplacé par un nouveau, à conserver
    return { token: token(u.id), code_recuperation: neuf };
  });
};
