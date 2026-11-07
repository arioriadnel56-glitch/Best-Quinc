'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calls, setHandler } = require('./helpers');
const { env } = require('../server/lib/env');
const { bootstrapFromEnv } = require('../server/lib/admins');

const ecrit = () => calls.filter((c) => /^(INSERT|UPDATE)/i.test(c.sql.trim()));
const prepare = (n, existe = false) => {
  calls.length = 0;
  setHandler(async (sql) => {
    if (sql.includes('COUNT(*)')) return { rows: [{ n }] };
    if (sql.includes('SELECT id FROM admins_plateforme')) return { rows: existe ? [{ id: 1 }] : [] };
    return { rows: [], rowCount: 1 };
  });
};
const config = (o) => Object.assign(env.superadmin, { email: 'moi@exemple.com', password: 'un-mot-de-passe-long', reset: false }, o);
const silence = () => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; return () => { console.log = l; console.error = e; }; };

test('super admin : créé quand la table est vide', async () => {
  prepare(0); config({}); const fin = silence();
  try { await bootstrapFromEnv(); } finally { fin(); }
  assert.equal(ecrit().length, 1);
  assert.match(ecrit()[0].sql, /INSERT INTO admins_plateforme/);
});

test('super admin : variables ignorées si un compte existe déjà (cas typique du « ça ne passe pas »)', async () => {
  prepare(1); config({}); const fin = silence();
  try { await bootstrapFromEnv(); } finally { fin(); }
  assert.equal(ecrit().length, 0);
});

test('super admin : SUPERADMIN_RESET=true remet le mot de passe d\'un compte existant', async () => {
  prepare(1, true); config({ reset: true }); const fin = silence();
  try { await bootstrapFromEnv(); } finally { fin(); }
  assert.equal(ecrit().length, 1);
  assert.match(ecrit()[0].sql, /UPDATE admins_plateforme SET mot_de_passe_hash/);
});

test('super admin : SUPERADMIN_RESET=true avec un autre e-mail crée un second compte', async () => {
  prepare(1, false); config({ reset: true }); const fin = silence();
  try { await bootstrapFromEnv(); } finally { fin(); }
  assert.match(ecrit()[0].sql, /INSERT INTO admins_plateforme/);
});

test('super admin : mot de passe trop court -> rien n\'est écrit, erreur claire dans les logs', async () => {
  prepare(0); config({ password: 'court' });
  const msgs = []; const e = console.error; console.error = (...a) => msgs.push(a.join(' '));
  try { await bootstrapFromEnv(); } finally { console.error = e; }
  assert.equal(ecrit().length, 0);
  assert.match(msgs.join(' '), /au moins 10 caractères/);
});

test('super admin : un seul des deux champs renseigné -> message explicite', async () => {
  prepare(0); config({ password: '' });
  const msgs = []; const e = console.error; console.error = (...a) => msgs.push(a.join(' '));
  try { await bootstrapFromEnv(); } finally { console.error = e; }
  assert.equal(ecrit().length, 0);
  assert.match(msgs.join(' '), /tous les deux/);
});
