'use strict';
// Frontend hébergé à part : seul le domaine déclaré (FRONTEND_ORIGIN) peut appeler l'API depuis le navigateur
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { env } = require('../server/lib/env');

const FRONT = 'https://best-quinca.pages.dev';
let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });

test('sans FRONTEND_ORIGIN : aucun en-tête CORS (comportement historique, même domaine)', async () => {
  env.frontendOrigins.length = 0;
  const res = await fetch(`${srv.base}/healthz`, { headers: { Origin: FRONT } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('pré-vérification (OPTIONS) d\'un domaine autorisé : 204 immédiat avec les bons en-têtes', async () => {
  env.frontendOrigins.push(FRONT);
  const res = await fetch(`${srv.base}/api/ventes`, { method: 'OPTIONS', headers: { Origin: FRONT, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), FRONT);
  assert.match(res.headers.get('access-control-allow-headers'), /Authorization/i);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  assert.equal(res.headers.get('access-control-allow-credentials'), null); // pas de cookies : l'authentification est dans l'en-tête Authorization
  assert.match(res.headers.get('vary'), /Origin/i);
});

test('réponse d\'une vraie requête : l\'origine autorisée est renvoyée, jamais « * »', async () => {
  env.frontendOrigins.push(FRONT);
  const res = await fetch(`${srv.base}/healthz`, { headers: { Origin: FRONT } });
  assert.equal(res.headers.get('access-control-allow-origin'), FRONT);
});

test('domaine non déclaré : pré-vérification refusée et aucun en-tête d\'autorisation', async () => {
  env.frontendOrigins.length = 0;
  env.frontendOrigins.push(FRONT);
  const pre = await fetch(`${srv.base}/api/ventes`, { method: 'OPTIONS', headers: { Origin: 'https://pirate.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 403);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
  const res = await fetch(`${srv.base}/healthz`, { headers: { Origin: 'https://pirate.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('FRONTEND_ORIGIN : valeurs invalides ignorées, barre finale retirée', () => {
  const lire = (v) => { process.env.FRONTEND_ORIGIN = v; delete require.cache[require.resolve('../server/lib/env')]; return require('../server/lib/env').env.frontendOrigins; };
  assert.deepEqual(lire('https://a.pages.dev/, http://localhost:8788 ,pas-une-adresse,https://b.test/chemin'), ['https://a.pages.dev', 'http://localhost:8788']);
  delete process.env.FRONTEND_ORIGIN;
});
