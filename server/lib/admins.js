'use strict';
const db = require('./db');
const { env } = require('./env');
const { hashPassword } = require('./password');

const MIN_PWD = 10;

// Crée un super admin ; avec { reset: true }, réinitialise le mot de passe s'il existe déjà.
async function upsertAdmin(email, nom, password, { reset = false } = {}) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Adresse e-mail invalide.');
  if (!password || password.length < MIN_PWD) throw new Error(`Le mot de passe doit contenir au moins ${MIN_PWD} caractères.`);
  const hash = await hashPassword(password);
  const ex = await db.query('SELECT id FROM admins_plateforme WHERE email = $1', [email]);
  if (ex.rows.length) {
    if (!reset) return 'existe';
    await db.query('UPDATE admins_plateforme SET mot_de_passe_hash = $1, actif = true WHERE id = $2', [hash, ex.rows[0].id]);
    return 'reinitialise';
  }
  await db.query('INSERT INTO admins_plateforme (nom_complet, email, mot_de_passe_hash) VALUES ($1, $2, $3)', [nom || 'Super administrateur', email, hash]);
  return 'cree';
}

// Au démarrage : crée le premier super admin depuis SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD.
// Si un super admin existe déjà, ces variables sont ignorées, sauf avec SUPERADMIN_RESET=true (récupération d'accès).
async function bootstrapFromEnv() {
  const { email, password, nom, reset } = env.superadmin;
  if (!email && !password) return;
  if (!email || !password) {
    console.error('Super admin : SUPERADMIN_EMAIL et SUPERADMIN_PASSWORD doivent être renseignés tous les deux.');
    return;
  }
  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM admins_plateforme');
    if (rows[0].n > 0 && !reset) {
      console.log('Super admin : un compte existe déjà, SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD sont ignorés. Pour changer le mot de passe, ajoutez SUPERADMIN_RESET=true puis redéployez.');
      return;
    }
    const r = await upsertAdmin(email, nom, password, { reset: true });
    console.log(`Super admin ${r === 'cree' ? 'créé' : 'mot de passe réinitialisé'} : ${email}. Retirez SUPERADMIN_PASSWORD${reset ? ' et SUPERADMIN_RESET' : ''} de la configuration.`);
  } catch (e) {
    console.error('Super admin : création impossible :', e.message);
  }
}

module.exports = { upsertAdmin, bootstrapFromEnv, MIN_PWD };
