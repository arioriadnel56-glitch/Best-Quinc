'use strict';
const { env } = require('./env');
const { HttpError } = require('./http');
const jwt = require('./jwt');
const db = require('./db');

// Charge l'utilisateur depuis le jeton ; refuse les comptes désactivés.
async function auth(ctx) {
  const header = ctx.req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = jwt.verify(token, env.jwtSecret);
  if (!payload || payload.typ === 'admin') throw new HttpError(401, 'Session expirée. Reconnectez-vous.');
  const { rows } = await db.query(
    `SELECT u.id, u.entreprise_id, u.nom_complet, u.email, u.role, u.actif, u.mdp_temporaire, u.mdp_modifie_le,
            (u.code_recuperation_hash IS NOT NULL) AS a_code_recuperation, e.statut AS entreprise_statut
       FROM utilisateurs u JOIN entreprises e ON e.id = u.entreprise_id
      WHERE u.id = $1`,
    [payload.sub],
  );
  const u = rows[0];
  if (!u || !u.actif || u.entreprise_statut !== 'actif') throw new HttpError(401, 'Compte introuvable ou désactivé.');
  // Un changement ou une réinitialisation de mot de passe met fin à toutes les sessions plus anciennes
  if (u.mdp_modifie_le && payload.iat < Math.floor(new Date(u.mdp_modifie_le).getTime() / 1000)) {
    throw new HttpError(401, 'Votre mot de passe a changé. Reconnectez-vous.');
  }
  ctx.user = u;
}

// Espace super admin : jeton dédié (typ = 'admin'), jamais interchangeable avec celui d'une entreprise
async function authAdmin(ctx) {
  const header = ctx.req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = jwt.verify(token, env.jwtSecret);
  if (!payload || payload.typ !== 'admin') throw new HttpError(401, 'Session expirée. Reconnectez-vous.');
  const { rows } = await db.query('SELECT id, nom_complet, email, actif FROM admins_plateforme WHERE id = $1', [payload.sub]);
  const a = rows[0];
  if (!a || !a.actif) throw new HttpError(401, 'Compte introuvable ou désactivé.');
  ctx.admin = a;
}

const role = (...roles) => async (ctx) => {
  if (!roles.includes(ctx.user.role)) throw new HttpError(403, 'Action réservée au propriétaire.');
};

async function activeSubscription(entrepriseId) {
  const { rows } = await db.query(
    `SELECT id, montant, to_char(date_debut, 'YYYY-MM-DD') AS date_debut, to_char(date_fin, 'YYYY-MM-DD') AS date_fin
       FROM abonnements
      WHERE entreprise_id = $1 AND statut = 'actif' AND date_fin >= CURRENT_DATE
      ORDER BY date_fin DESC LIMIT 1`,
    [entrepriseId],
  );
  return rows[0] || null;
}

// Bloque les fonctions métier tant que l'abonnement n'est pas actif.
async function subscribed(ctx) {
  const sub = await activeSubscription(ctx.user.entreprise_id);
  if (!sub) {
    throw new HttpError(402, 'Votre abonnement est expiré ou inactif. Renouvelez-le pour continuer.', { code: 'ABONNEMENT_REQUIS' });
  }
  ctx.abonnement = sub;
}

module.exports = { auth, authAdmin, role, subscribed, activeSubscription };
