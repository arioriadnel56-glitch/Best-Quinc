'use strict';
const crypto = require('node:crypto');

// 32 caractères distincts, sans 0/O ni 1/I (faciles à confondre) : 32 = 2^5, donc chaque octet donne un tirage uniforme
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ' + '23456789';
if (new Set(ALPHABET).size !== 32) throw new Error('Alphabet de codes invalide');

function tirage(n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] & 31];
  return s;
}

// Code de récupération : 20 caractères (100 bits), affiché par groupes de 5
function genererCode() {
  return tirage(20).match(/.{5}/g).join('-');
}

// Mot de passe provisoire : 12 caractères (60 bits), affiché par groupes de 4
function genererTemporaire() {
  return tirage(12).match(/.{4}/g).join('-');
}

const normaliser = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Le code a 100 bits d'entropie : une empreinte SHA-256 suffit (et survit à un changement de JWT_SECRET)
const empreinte = (code) => crypto.createHash('sha256').update('bq-recup:' + normaliser(code)).digest('hex');

function correspond(code, empreinteStockee) {
  const a = Buffer.from(empreinte(code), 'hex');
  const b = Buffer.from(String(empreinteStockee || '').padEnd(64, '0').slice(0, 64), 'hex');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok && Boolean(empreinteStockee);
}

module.exports = { genererCode, genererTemporaire, empreinte, correspond, normaliser };
