'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('./http');
const { env } = require('./env');

const buckets = new Map();

const tropDeTentatives = (minutes) => new HttpError(429, `Trop de tentatives. Réessayez dans ${Math.max(1, minutes)} minute(s).`);

// Compteur en mémoire (serveur classique, tests, repli).
function limitMemoire(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset <= now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > max) throw tropDeTentatives(Math.ceil((b.reset - now) / 60000));
}

// Compteur en base (Vercel) : chaque appel peut tomber sur une instance différente,
// la mémoire ne suffit donc pas. Une seule requête SQL atomique par appel.
async function limitBase(key, max, windowMs) {
  const db = require('./db');
  const cle = crypto.createHash('sha256').update(key).digest('hex');
  const { rows } = await db.query(
    `INSERT INTO limites_requetes (cle, compteur, expire_le)
     VALUES ($1, 1, now() + make_interval(secs => $2::float8))
     ON CONFLICT (cle) DO UPDATE SET
       compteur  = CASE WHEN limites_requetes.expire_le <= now() THEN 1 ELSE limites_requetes.compteur + 1 END,
       expire_le = CASE WHEN limites_requetes.expire_le <= now() THEN EXCLUDED.expire_le ELSE limites_requetes.expire_le END
     RETURNING compteur, CEIL(EXTRACT(EPOCH FROM (expire_le - now())) / 60)::int AS minutes`,
    [cle, windowMs / 1000],
  );
  // Nettoyage occasionnel des compteurs périmés
  if (Math.random() < 0.02) await db.query("DELETE FROM limites_requetes WHERE expire_le < now() - interval '1 day'");
  if (rows[0] && rows[0].compteur > max) throw tropDeTentatives(rows[0].minutes);
}

// Autorise `max` appels par fenêtre de `windowMs` pour une clé donnée. À appeler avec await.
async function limit(key, max, windowMs) {
  if (!env.serverless) return limitMemoire(key, max, windowMs);
  try {
    return await limitBase(key, max, windowMs);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('Limitation de débit en base indisponible, repli sur la mémoire :', err.message);
    return limitMemoire(key, max, windowMs);
  }
}

module.exports = { limit };
