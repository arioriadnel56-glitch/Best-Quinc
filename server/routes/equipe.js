'use strict';
const db = require('../lib/db');
const { HttpError, str, int, email } = require('../lib/http');
const { hashPassword, motDePasseFaible } = require('../lib/password');
const { auth, role, subscribed } = require('../lib/auth');
const realtime = require('../lib/realtime');

const proprio = role('proprietaire');
const ROLES = ['proprietaire', 'secretaire'];

module.exports = function register(router) {
  router.get('/api/utilisateurs', auth, subscribed, proprio, async (ctx) => {
    const { rows } = await db.query(
      `SELECT id, nom_complet, email, role, actif FROM utilisateurs WHERE entreprise_id = $1 ORDER BY actif DESC, nom_complet`,
      [ctx.user.entreprise_id],
    );
    return rows;
  });

  router.post('/api/utilisateurs', auth, subscribed, proprio, async (ctx) => {
    const nom = str(ctx.body.nom_complet, 'nom complet', { min: 2, max: 150 });
    const mail = email(ctx.body.email);
    const pwd = str(ctx.body.mot_de_passe, 'mot de passe', { min: 8, max: 200 });
    { const m = motDePasseFaible(pwd, [ctx.body.email, nom]); if (m) throw new HttpError(400, m); }
    const r = str(ctx.body.role, 'rôle', { max: 20 });
    if (!ROLES.includes(r)) throw new HttpError(400, 'Rôle invalide.');
    const { rows } = await db.query(
      `INSERT INTO utilisateurs (entreprise_id, nom_complet, email, mot_de_passe_hash, role, mdp_temporaire)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id, nom_complet, email, role, actif`,
      [ctx.user.entreprise_id, nom, mail, await hashPassword(pwd), r],
    );
    ctx.status = 201;
    return rows[0];
  });

  router.put('/api/utilisateurs/:id', auth, subscribed, proprio, async (ctx) => {
    const id = int(ctx.params.id, 'utilisateur', { min: 1 });
    const b = ctx.body;
    const sets = [];
    const vals = [id, ctx.user.entreprise_id];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (id === ctx.user.id && (b.actif !== undefined || b.role !== undefined)) {
      throw new HttpError(400, 'Vous ne pouvez pas modifier votre propre rôle ni désactiver votre propre compte.');
    }
    if (b.nom_complet !== undefined) add('nom_complet', str(b.nom_complet, 'nom complet', { min: 2, max: 150 }));
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) throw new HttpError(400, 'Rôle invalide.');
      add('role', b.role);
    }
    if (b.actif !== undefined) add('actif', Boolean(b.actif));
    if (b.mot_de_passe !== undefined) {
      { const np = str(b.mot_de_passe, 'mot de passe', { min: 8, max: 200 }); const m = motDePasseFaible(np, [b.email]); if (m) throw new HttpError(400, m); add('mot_de_passe_hash', await hashPassword(np)); }
      sets.push('mdp_modifie_le = now()', 'mdp_temporaire = true'); // le membre devra choisir le sien à sa prochaine connexion
    }
    if (!sets.length) throw new HttpError(400, 'Aucune modification fournie.');
    const r = await db.query(`UPDATE utilisateurs SET ${sets.join(', ')} WHERE id = $1 AND entreprise_id = $2`, vals);
    if (!r.rowCount) throw new HttpError(404, 'Utilisateur introuvable.');
    // Compte désactivé ou mot de passe changé : ses appareils perdent aussitôt le temps réel (l'API le refuse déjà)
    if (b.actif !== undefined && !b.actif || b.mot_de_passe !== undefined) realtime.fermerUtilisateur(id);
    return { ok: true };
  });

  // Paramètres de l'entreprise et de sa PWA (nom installé, couleur)
  // Supprime un compte déjà désactivé. Ses ventes restent (le vendeur s'affiche alors « Compte supprimé »).
  router.delete('/api/utilisateurs/:id', auth, subscribed, proprio, async (ctx) => {
    const id = int(ctx.params.id, 'utilisateur', { min: 1 });
    if (id === ctx.user.id) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte ici.');
    const r = await db.query('DELETE FROM utilisateurs WHERE id = $1 AND entreprise_id = $2 AND actif = false', [id, ctx.user.entreprise_id]);
    if (!r.rowCount) throw new HttpError(409, 'Désactivez d\'abord ce compte pour pouvoir le supprimer.');
    realtime.fermerUtilisateur(id);
    return { ok: true };
  });

  router.get('/api/pwa', auth, async (ctx) => {
    const { rows } = await db.query('SELECT nom_app, couleur FROM pwa_configs WHERE entreprise_id = $1', [ctx.user.entreprise_id]);
    return rows[0];
  });

  router.put('/api/pwa', auth, proprio, async (ctx) => {
    const nom = str(ctx.body.nom_app, "nom de l'application", { min: 2, max: 100 });
    const couleur = str(ctx.body.couleur, 'couleur', { max: 7 });
    if (!/^#[0-9a-fA-F]{6}$/.test(couleur)) throw new HttpError(400, 'Couleur invalide (format #RRGGBB).');
    await db.query(
      'UPDATE pwa_configs SET nom_app = $1, couleur = $2, modifie_le = now() WHERE entreprise_id = $3',
      [nom, couleur.toUpperCase(), ctx.user.entreprise_id],
    );
    return { ok: true };
  });
};
