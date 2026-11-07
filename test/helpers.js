'use strict';
// Remplace server/lib/db.js par une base simulée AVANT le chargement du serveur
const path = require('node:path');
process.env.DATABASE_URL = 'postgres://test/test';
process.env.JWT_SECRET = 'x'.repeat(40);

const calls = [];
let handler = async () => ({ rows: [], rowCount: 0 });
const fake = {
  query: (sql, params) => { calls.push({ sql, params }); return handler(sql, params); },
  tx: async (fn) => fn((sql, params) => { calls.push({ sql, params }); return handler(sql, params); }),
  getPool: () => ({ end: async () => {} }),
};
const dbPath = require.resolve(path.join(__dirname, '..', 'server', 'lib', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };

const http = require('node:http');
const { handle } = require('../server');

async function startServer() {
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { calls, setHandler: (h) => { handler = h; }, startServer };
