'use strict';
const crypto = require('node:crypto');

const scrypt = (pwd, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(pwd, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
});

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const key = await scrypt(password, salt);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Mots de passe courants refusés (comparaison en minuscules)
const COURANTS = new Set(['12345678', '123456789', '1234567890', '87654321', 'password', 'password1', 'password123', 'motdepasse', 'motdepasse1', 'motdepasse123', 'azerty123', 'azertyuiop', 'azerty1234', 'qwertyuiop', 'qwerty123', 'qwerty1234', '00000000', '11111111', 'abcdefgh', 'abcd1234', 'admin1234', 'administrateur', 'bestquinca', 'quincaillerie', 'iloveyou', 'bonjour123', 'benin2020', 'cotonou123', 'welcome1', 'welcome123']);

// Retourne un message d'erreur si le mot de passe est trop faible, sinon null. `contexte` : e-mail, nom, identifiant de l'espace…
function motDePasseFaible(pwd, contexte = []) {
  const p = String(pwd);
  const bas = p.toLowerCase();
  if (COURANTS.has(bas)) return 'Ce mot de passe est trop courant. Choisissez-en un plus personnel.';
  if (new Set(p).size < 4) return 'Ce mot de passe est trop répétitif.';
  if (/^\d+$/.test(p) && p.length < 12) return 'Un mot de passe uniquement composé de chiffres doit faire au moins 12 caractères. Ajoutez des lettres.';
  for (const c of contexte) {
    const m = String(c || '').toLowerCase().split('@')[0].replace(/[^a-z0-9]/g, '');
    if (m.length >= 4 && bas.includes(m)) return 'Le mot de passe ne doit pas contenir votre e-mail, votre nom ou l\'identifiant de votre espace.';
  }
  return null;
}

module.exports = { hashPassword, verifyPassword, motDePasseFaible };
