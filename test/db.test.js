'use strict';
// Teste le vrai server/lib/db.js avec un faux module « pg » (reconnexion après coupure pendant la veille serverless)
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.DATABASE_URL = 'postgres://test/test';
process.env.JWT_SECRET = 'x'.repeat(40);

const journal = [];
let scenario = [];
class FakeClient {
  constructor(id) { this.id = id; }
  async query(text) {
    journal.push(`${this.id}:${String(text).slice(0, 30)}`);
    const next = scenario.shift();
    if (next instanceof Error) throw next;
    return next || { rows: [], rowCount: 0 };
  }
  release(err) { journal.push(`${this.id}:release${err ? '(détruite)' : ''}`); }
}
let n = 0;
class FakePool {
  on() {}
  async query(text, params) { return new FakeClient('pool').query(text, params); }
  async connect() { return new FakeClient(`c${++n}`); }
  async end() {}
}
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === 'pg' ? 'pg-faux' : orig.call(this, request, ...rest); };
require.cache['pg-faux'] = { id: 'pg-faux', filename: 'pg-faux', loaded: true, exports: { Pool: FakePool } };
const db = require('../server/lib/db');

const coupure = () => new Error('Connection terminated unexpectedly');
test.beforeEach(() => { journal.length = 0; scenario = []; });

test('détection des coupures et des lectures rejouables', () => {
  assert.ok(db.connexionCoupee(coupure()));
  assert.ok(db.connexionCoupee(Object.assign(new Error('x'), { code: 'ECONNRESET' })));
  assert.ok(!db.connexionCoupee(Object.assign(new Error('duplicate key'), { code: '23505' })));
  assert.ok(db.estLecture('SELECT 1'));
  assert.ok(db.estLecture('  with a as (select 1) select * from a'));
  assert.ok(!db.estLecture('INSERT INTO x VALUES (1)'));
  assert.ok(!db.estLecture('SELECT * FROM t FOR UPDATE'));
});

test('lecture : rejouée une fois après une coupure', async () => {
  scenario = [coupure(), { rows: [{ ok: 1 }] }];
  const r = await db.query('SELECT 1');
  assert.deepEqual(r.rows, [{ ok: 1 }]);
  assert.equal(journal.length, 2);
});

test('écriture isolée : jamais rejouée (elle a pu aboutir)', async () => {
  scenario = [coupure(), { rows: [] }];
  await assert.rejects(() => db.query('UPDATE t SET a = 1'), /Connection terminated/);
  assert.equal(journal.length, 1);
});

test('transaction : BEGIN coupé -> connexion neuve, la transaction aboutit', async () => {
  scenario = [coupure(), {}, { rows: [{ v: 7 }] }, {}];
  const r = await db.tx(async (q) => (await q('SELECT 7')).rows[0].v);
  assert.equal(r, 7);
  assert.ok(journal.includes('c1:release(détruite)'));
  assert.ok(journal.some((l) => l.startsWith('c2:COMMIT')));
  assert.ok(journal.includes('c2:release'));
});

test('transaction : erreur applicative -> ROLLBACK, connexion rendue au pool', async () => {
  scenario = [{}, new Error('boum'), {}];
  await assert.rejects(() => db.tx(async (q) => { await q('SELECT 1'); }), /boum/);
  assert.ok(journal.some((l) => l.includes(':ROLLBACK')));
  assert.ok(!journal.some((l) => l.includes('COMMIT')));
  assert.ok(journal[journal.length - 1].endsWith(':release'));
});
