'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('../server/lib/jwt');
const { hashPassword, verifyPassword } = require('../server/lib/password');
const { slugify, str, int, email, HttpError } = require('../server/lib/http');
const { Router } = require('../server/lib/router');
const { makeIcon, initialOf } = require('../server/lib/icon');
const { limit } = require('../server/lib/ratelimit');

const SECRET = 's'.repeat(40);

test('jwt : signature valide, falsifiée et expirée', () => {
  const t = jwt.sign({ sub: 7 }, SECRET);
  assert.equal(jwt.verify(t, SECRET).sub, 7);
  assert.equal(jwt.verify(t, 'autre-secret-autre-secret-autre-secret'), null);
  const [h, p, s] = t.split('.');
  const pirate = Buffer.from(JSON.stringify({ sub: 1, exp: 9999999999 })).toString('base64url');
  assert.equal(jwt.verify(`${h}.${pirate}.${s}`, SECRET), null);
  assert.equal(jwt.verify(jwt.sign({ sub: 7 }, SECRET, -10), SECRET), null);
  assert.equal(jwt.verify('n.importe.quoi', SECRET), null);
  assert.equal(jwt.verify('', SECRET), null);
});

test('jwt : refuse alg:none', () => {
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: 1, exp: 9999999999 })).toString('base64url');
  assert.equal(jwt.verify(`${h}.${p}.`, SECRET), null);
});

test('mot de passe : hash vérifiable, sel unique, mauvais mot de passe refusé', async () => {
  const a = await hashPassword('secret123');
  const b = await hashPassword('secret123');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('secret123', a), true);
  assert.equal(await verifyPassword('secret124', a), false);
  assert.equal(await verifyPassword('x', 'format-invalide'), false);
});

test('slugify : accents, espaces, symboles', () => {
  assert.equal(slugify('Quincaillerie Zinsou & Fils'), 'quincaillerie-zinsou-fils');
  assert.equal(slugify('  Éts Kpossou  '), 'ets-kpossou');
  assert.equal(slugify('A'.repeat(100)).length, 40);
  assert.equal(slugify('***'), '');
});

test('validation : champs obligatoires, bornes et e-mail', () => {
  assert.equal(str(' abc ', 'x'), 'abc');
  assert.throws(() => str('', 'x'), HttpError);
  assert.equal(str('', 'x', { optional: true }), null);
  assert.throws(() => str('a'.repeat(300), 'x'), /trop long/);
  assert.throws(() => str(12, 'x'), HttpError);
  assert.equal(int('12', 'n'), 12);
  assert.throws(() => int(1.5, 'n'), /entier/);
  assert.throws(() => int(-1, 'n'), /compris entre/);
  assert.equal(int(undefined, 'n', { def: 5 }), 5);
  assert.equal(email('Adnel@Mail.COM'), 'adnel@mail.com');
  assert.throws(() => email('pas-un-mail'), /invalide/);
});

test('routeur : paramètres, méthode non autorisée, 404', () => {
  const r = new Router();
  r.get('/a/:id/b', () => {});
  r.post('/a/:id/b', () => {});
  const ok = r.match('GET', '/a/42/b');
  assert.equal(ok.params.id, '42');
  assert.equal(r.match('GET', '/a/x%20y/b').params.id, 'x y');
  const mauvaise = r.match('DELETE', '/a/42/b');
  assert.equal(mauvaise.route, null);
  assert.equal(mauvaise.pathMatched, true);
  assert.equal(r.match('GET', '/zzz').pathMatched, false);
});

test('icône : PNG valide, couleur et initiale', () => {
  const png = makeIcon('Quincaillerie', '#3E5C76', 192);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 192);
  assert.equal(initialOf('éts kpossou'), 'E');
  assert.equal(initialOf('漢字'), 'B');
  assert.equal(makeIcon('X', 'pas-une-couleur', 64).length > 0, true);
});

test('limiteur : bloque après le maximum', async () => {
  const cle = 'k' + Math.random();
  for (let i = 0; i < 3; i++) await limit(cle, 3, 60000);
  await assert.rejects(() => limit(cle, 3, 60000), /Trop de tentatives/);
});
