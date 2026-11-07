'use strict';
// Crée le super admin, ou réinitialise son mot de passe s'il existe déjà (récupération d'accès).
// Usage : SUPERADMIN_EMAIL=moi@exemple.com SUPERADMIN_PASSWORD='un mot de passe long' node scripts/creer-superadmin.js
// (ou renseignez ces deux variables dans .env, puis lancez : npm run superadmin)
const { env, assertEnv } = require('../server/lib/env');
const { migrate } = require('../server/migrate');
const { upsertAdmin } = require('../server/lib/admins');

(async () => {
  assertEnv();
  const { email, password, nom } = env.superadmin;
  if (!email || !password) throw new Error('Renseignez SUPERADMIN_EMAIL et SUPERADMIN_PASSWORD.');
  await migrate();
  const r = await upsertAdmin(email, nom, password, { reset: true });
  console.log({ cree: 'Super admin créé.', reinitialise: 'Mot de passe réinitialisé.' }[r] || r);
  console.log("Retirez SUPERADMIN_PASSWORD de votre configuration, puis connectez-vous sur /admin");
})()
  .catch((e) => { console.error('Échec :', e.message); process.exitCode = 1; })
  .finally(() => require('../server/lib/db').getPool().end());
