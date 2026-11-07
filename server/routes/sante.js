'use strict';
// Contrôle de santé pour l'hébergeur (Render, Railway…) : répond 200 seulement si le serveur ET la base répondent.
// Aucune donnée n'est renvoyée.
const db = require('../lib/db');

module.exports = function register(router) {
  router.get('/healthz', async (ctx) => {
    let ok = false;
    try {
      await Promise.race([db.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), 4000))]);
      ok = true;
    } catch { /* base injoignable */ }
    ctx.raw = { status: ok ? 200 : 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok }) };
  });
};
