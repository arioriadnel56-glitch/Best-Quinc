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
            (u.code_recuperation_hash IS NOT NULL) AS a_code_recuperation, e.statut AS entreprise_statut,
            u.bloque_jusqua, u.sessions_revoquees_le
       FROM utilisateurs u JOIN entreprises e ON e.id = u.entreprise_id
      WHERE u.id = $1`,
    [payload.sub],
  );
  const u = rows[0];
  if (!u || !u.actif || u.entreprise_statut !== 'actif') throw new HttpError(401, 'Compte introuvable ou désactivé.');
  // Blocage temporaire (administrateur de sécurité) et révocation de toutes les sessions antérieures
  if (u.bloque_jusqua && new Date(u.bloque_jusqua) > new Date()) throw new HttpError(401, 'Compte temporairement bloqué pour raison de sécurité.');
  if (u.sessions_revoquees_le && payload.iat < Math.floor(new Date(u.sessions_revoquees_le).getTime() / 1000)) {
    throw new HttpError(401, 'Session fermée pour raison de sécurité. Reconnectez-vous.');
  }
  // Un changement ou une réinitialisation de mot de passe met fin à toutes les sessions plus anciennes
  if (u.mdp_modifie_le && payload.iat < Math.floor(new Date(u.mdp_modifie_le).getTime() / 1000)) {
    throw new HttpError(401, 'Votre mot de passe a changé. Reconnectez-vous.');
  }
  ctx.user = u;
}

// Espaces d'administration : jeton dédié (typ = 'admin'), jamais interchangeable avec celui d'une entreprise.
// Le jeton porte l'identifiant d'une session (sid) : révoquer la session coupe l'accès immédiatement.
async function authAdmin(ctx) {
  if (ctx.admin) return;
  const header = ctx.req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = jwt.verify(token, env.jwtSecret);
  if (!payload || payload.typ !== 'admin' || !payload.sid) throw new HttpError(401, 'Session expirée. Reconnectez-vous.');
  const { rows } = await db.query(
    `SELECT a.id, a.nom_complet, a.email, a.actif, a.role, a.mdp_temporaire, a.bloque_jusqua, s.id AS sid, s.derniere_activite
       FROM admins_plateforme a JOIN admin_sessions s ON s.admin_id = a.id
      WHERE a.id = $1 AND s.id = $2 AND s.revoquee_le IS NULL AND s.expire_le > now()`,
    [payload.sub, payload.sid],
  );
  const a = rows[0];
  if (!a || !a.actif) throw new HttpError(401, 'Session expirée ou compte désactivé. Reconnectez-vous.');
  if (a.bloque_jusqua && new Date(a.bloque_jusqua) > new Date()) throw new HttpError(401, 'Compte temporairement bloqué pour raison de sécurité.');
  // Dernière activité : écrite au plus une fois par minute
  if (!a.derniere_activite || Date.now() - new Date(a.derniere_activite).getTime() > 60000) {
    await db.query('UPDATE admin_sessions SET derniere_activite = now() WHERE id = $1', [a.sid]);
  }
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
