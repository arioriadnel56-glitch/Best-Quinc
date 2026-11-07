'use strict';
const { Pool } = require('pg');
const { env } = require('./env');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: env.pgssl ? { rejectUnauthorized: false } : undefined,
      max: env.poolMax,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => console.error('Erreur PostgreSQL (connexion inactive) :', err.message));
  }
  return pool;
}

// Connexion coupée par le serveur ou le pooler pendant que la fonction serverless était en veille
const connexionCoupee = (err) => Boolean(err) && (
  /Connection terminated|terminating connection|ECONNRESET|EPIPE|Client has encountered a connection error/i.test(String(err.message))
  || ['ECONNRESET', 'EPIPE', '57P01', '57P02', '57P03'].includes(err.code)
);

// Une lecture peut être rejouée sans risque ; une écriture isolée ne l'est pas (elle a pu aboutir avant la coupure).
const estLecture = (text) => /^\s*(SELECT|WITH)\b/i.test(String(text)) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(String(text));

async function query(text, params) {
  try {
    return await getPool().query(text, params);
  } catch (err) {
    if (connexionCoupee(err) && estLecture(text)) return getPool().query(text, params);
    throw err;
  }
}

async function tx(fn) {
  let client = await getPool().connect();
  try {
    await client.query('BEGIN');
  } catch (err) {
    // Rien n'a été exécuté : on peut reprendre avec une connexion neuve
    client.release(err);
    if (!connexionCoupee(err)) throw err;
    client = await getPool().connect();
    try { await client.query('BEGIN'); } catch (err2) { client.release(err2); throw err2; }
  }
  try {
    const result = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignoré */ }
    client.release(connexionCoupee(err) ? err : undefined);
    throw err;
  }
}

module.exports = { query, tx, getPool, connexionCoupee, estLecture };
