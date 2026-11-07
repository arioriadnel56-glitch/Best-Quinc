'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { calls, setHandler } = require('./helpers');
const { env } = require('../server/lib/env');

const serveur = async (fn) => {
  const s = http.createServer((req, res) => { fn(req, res); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
};

test('api/index.js : sert la page d\'accueil après initialisation (migration + verrou)', async () => {
  calls.length = 0;
  setHandler(async () => ({ rows: [], rowCount: 0 }));
  const entree = require('../api/index.js');
  const s = await serveur(entree);
  try {
    const r = await fetch(`${s.base}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Best-Quinca/);
    assert.ok(calls.some((c) => c.sql.includes('pg_advisory_xact_lock')), 'verrou consultatif pris avant la migration');
    assert.ok(calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS limites_requetes')), 'le schéma contient la table de limitation');
    const n = calls.length;
    await fetch(`${s.base}/`);
    assert.equal(calls.filter((c) => c.sql.includes('pg_advisory_xact_lock')).length, 1, 'migration une seule fois par instance');
    assert.ok(calls.length >= n);
  } finally { await s.close(); }
});

test('api/index.js : les routes /api/... passent par le même point d\'entrée', async () => {
  const entree = require('../api/index.js');
  const s = await serveur(entree);
  try {
    const r = await fetch(`${s.base}/api/inconnu`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).erreur, 'Ressource introuvable.');
  } finally { await s.close(); }
});

test('limitation de débit en base (Vercel) : bloque au-delà du maximum, clé hachée', async () => {
  const { limit } = require('../server/lib/ratelimit');
  env.serverless = true;
  calls.length = 0;
  let n = 0;
  setHandler(async (sql) => (sql.includes('limites_requetes') && sql.startsWith('\n     INSERT') || sql.includes('INSERT INTO limites_requetes')
    ? { rows: [{ compteur: ++n, minutes: 7 }] } : { rows: [] }));
  try {
    await limit('login:1.2.3.4|boutique|moi@exemple.com', 2, 900000);
    await limit('login:1.2.3.4|boutique|moi@exemple.com', 2, 900000);
    await assert.rejects(() => limit('login:1.2.3.4|boutique|moi@exemple.com', 2, 900000), (e) => e.status === 429 && /7 minute/.test(e.message));
    const ins = calls.find((c) => c.sql.includes('INSERT INTO limites_requetes'));
    assert.match(ins.params[0], /^[0-9a-f]{64}$/);
    assert.equal(ins.params[1], 900);
    assert.ok(!JSON.stringify(calls).includes('moi@exemple.com'), 'aucun e-mail en clair dans la base');
  } finally { env.serverless = false; }
});

test('limitation de débit : si la base est indisponible, repli sur la mémoire', async () => {
  const { limit } = require('../server/lib/ratelimit');
  env.serverless = true;
  const log = console.error; console.error = () => {};
  setHandler(async () => { throw new Error('connexion perdue'); });
  try {
    await limit('repli:x', 1, 60000);
    await assert.rejects(() => limit('repli:x', 1, 60000), (e) => e.status === 429);
  } finally { env.serverless = false; console.error = log; setHandler(async () => ({ rows: [], rowCount: 0 })); }
});

test('migration : ne touche à rien si le schéma est déjà à jour (aucun verrou de table au démarrage à froid)', async () => {
  const { migrate } = require('../server/migrate');
  calls.length = 0;
  setHandler(async (sql) => {
    if (sql.includes('to_regclass')) return { rows: [{ t: 'schema_migrations' }] };
    if (sql.includes('FROM schema_migrations')) return { rows: [{ '?column?': 1 }] };
    return { rows: [] };
  });
  try {
    assert.equal(await migrate(), false);
    assert.equal(calls.length, 2, 'deux lectures seulement');
    assert.ok(!calls.some((c) => /ALTER TABLE|CREATE TABLE|pg_advisory/.test(c.sql)));
  } finally { setHandler(async () => ({ rows: [], rowCount: 0 })); }
});

test('migration : applique le schéma sous verrou puis enregistre son empreinte', async () => {
  const { migrate } = require('../server/migrate');
  calls.length = 0;
  setHandler(async () => ({ rows: [], rowCount: 0 }));
  assert.equal(await migrate(), true);
  const ordre = calls.map((c) => (c.sql.includes('pg_advisory') ? 'verrou' : c.sql.includes('ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS code_recuperation_hash') ? 'schema' : c.sql.startsWith('INSERT INTO schema_migrations') ? 'empreinte' : null)).filter(Boolean);
  assert.deepEqual(ordre, ['verrou', 'schema', 'empreinte']);
  const ins = calls.find((c) => c.sql.startsWith('INSERT INTO schema_migrations'));
  assert.match(ins.params[0], /^[0-9a-f]{64}$/);
});

test('corps de requête déjà lu par l\'hébergeur : pas d\'attente infinie', async () => {
  const { readJson } = require('../server/lib/http');
  assert.deepEqual(await readJson({ readableEnded: true, body: { a: 1 } }), { a: 1 });
  assert.deepEqual(await readJson({ readableEnded: true, body: '{"b":2}' }), { b: 2 });
  assert.deepEqual(await readJson({ readableEnded: true }), {});
  await assert.rejects(() => readJson({ readableEnded: true, body: '{pas du json' }), (e) => e.status === 400);
});

test('les gabarits HTML ne sont plus publics : /admin.html et /sw.template.js n\'existent pas dans public/', () => {
  const fs = require('node:fs');
  const pub = fs.readdirSync(`${__dirname}/../public`);
  assert.deepEqual(pub, ['assets']);
  for (const f of ['app.html', 'landing.html', 'admin.html', 'sw.template.js']) assert.ok(fs.existsSync(`${__dirname}/../server/templates/${f}`));
});
