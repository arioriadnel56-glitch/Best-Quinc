'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertEnv } = require('./lib/env');
const db = require('./lib/db');

// Verrou consultatif : si plusieurs instances serverless démarrent en même temps, une seule applique le schéma.
const LOCK_ID = 727274;

// Applique schema.sql seulement s'il a changé depuis la dernière application (empreinte gardée en base).
// Évite, à chaque démarrage à froid, de reprendre des verrous sur les tables pendant que d'autres instances travaillent.
// Renvoie true si le schéma a été appliqué.
async function migrate() {
  assertEnv();
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const empreinte = crypto.createHash('sha256').update(sql).digest('hex');

  const t = await db.query("SELECT to_regclass('public.schema_migrations') AS t");
  if (t.rows[0] && t.rows[0].t) {
    const deja = await db.query('SELECT 1 FROM schema_migrations WHERE empreinte = $1', [empreinte]);
    if (deja.rows.length) return false;
  }

  return db.tx(async (q) => {
    await q('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await q('CREATE TABLE IF NOT EXISTS schema_migrations (empreinte VARCHAR(64) PRIMARY KEY, applique_le TIMESTAMPTZ NOT NULL DEFAULT now())');
    // Une autre instance a pu l'appliquer pendant l'attente du verrou
    const deja = await q('SELECT 1 FROM schema_migrations WHERE empreinte = $1', [empreinte]);
    if (deja.rows.length) return false;
    await q(sql);
    await q('INSERT INTO schema_migrations (empreinte) VALUES ($1) ON CONFLICT DO NOTHING', [empreinte]);
    return true;
  });
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then((appliquee) => { console.log(appliquee ? 'Base de données mise à jour.' : 'Base de données déjà à jour.'); return db.getPool().end(); })
    .catch((err) => { console.error('Échec de la migration :', err.message); process.exit(1); });
}
