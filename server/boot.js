'use strict';
// Initialisation exécutée une seule fois par instance serverless (premier appel), pas à chaque requête.
const { env, assertEnv } = require('./lib/env');
const { migrate } = require('./migrate');
const { bootstrapFromEnv } = require('./lib/admins');

let ready = null;

function ensureReady() {
  if (!ready) {
    ready = (async () => {
      assertEnv();
      if (env.autoMigrate) await migrate();
      await bootstrapFromEnv();
    })().catch((err) => { ready = null; throw err; }); // en cas d'échec, le prochain appel réessaie
  }
  return ready;
}

module.exports = { ensureReady };
