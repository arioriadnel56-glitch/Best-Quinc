'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BQ = require('../public/assets/outils.js');

const V = (cle, lignes, statut = 'en_attente') => ({ cle, statut, lignes: lignes.map(([produit_id, quantite]) => ({ produit_id, quantite })) });

test('identifiant de vente : unique et conforme à ce qu\'accepte le serveur', () => {
  const vus = new Set();
  for (let i = 0; i < 500; i++) {
    const c = BQ.genererCle();
    assert.match(c, /^[A-Za-z0-9_-]{8,64}$/);
    vus.add(c);
  }
  assert.equal(vus.size, 500);
});

test('stock disponible : déduit les ventes hors connexion en attente, jamais négatif', () => {
  const file = [V('a', [[1, 3], [2, 1]]), V('b', [[1, 2]]), V('c', [[1, 50]], 'refusee')];
  assert.equal(BQ.quantiteEnAttente(file, 1), 5, 'une vente refusée ne compte pas');
  assert.equal(BQ.stockDisponible({ id: 1, quantite_stock: 12 }, file), 7);
  assert.equal(BQ.stockDisponible({ id: 1, quantite_stock: 4 }, file), 0);
  assert.equal(BQ.stockDisponible({ id: 9, quantite_stock: 4 }, file), 4);
  assert.equal(BQ.stockDisponible({ id: 1, quantite_stock: 4 }, null), 4);
});

test('numéros de facture : officiel sur 5 chiffres, provisoire hors connexion', () => {
  assert.equal(BQ.numeroFacture(213), '00213');
  assert.equal(BQ.numeroFacture('HL-0003'), 'HL-0003');
  assert.equal(BQ.numeroProvisoire(3), 'HL-0003');
});

test('verdict par réponse du serveur', () => {
  const att = { 200: 'envoyee', 201: 'envoyee', 0: 'reseau', 401: 'auth', 402: 'abonnement', 400: 'refusee', 404: 'refusee', 409: 'refusee',
    500: 'reessayer', 502: 'reessayer', 503: 'reessayer', 429: 'reessayer' };
  for (const [status, v] of Object.entries(att)) assert.equal(BQ.classerReponse(Number(status)), v, status);
});

const erreur = (status, message = 'm') => Object.assign(new Error(message), status === 0 ? { hors_ligne: true } : { status });

test('synchronisation : tout est envoyé dans l\'ordre', async () => {
  const file = [V('a', [[1, 1]]), V('b', [[1, 1]]), V('c', [[1, 1]])];
  const vus = [];
  const r = await BQ.synchroniserFile(file, async (v) => { vus.push(v.cle); return { id: vus.length, numero: 200 + vus.length, anomalie: v.cle === 'b' ? 'stock' : null }; });
  assert.deepEqual(vus, ['a', 'b', 'c']);
  assert.equal(r.arret, null);
  assert.deepEqual(r.resultats.map((x) => [x.cle, x.issue, x.numero, x.anomalie]), [['a', 'envoyee', 201, null], ['b', 'envoyee', 202, 'stock'], ['c', 'envoyee', 203, null]]);
});

test('synchronisation : coupure réseau au milieu -> on s\'arrête et on conserve le reste', async () => {
  const file = [V('a', [[1, 1]]), V('b', [[1, 1]]), V('c', [[1, 1]])];
  let n = 0;
  const r = await BQ.synchroniserFile(file, async () => { n++; if (n === 2) throw erreur(0); return { numero: n }; });
  assert.equal(r.arret, 'reseau');
  assert.deepEqual(r.resultats.map((x) => x.cle), ['a']);
  assert.equal(n, 2, 'la vente c n\'est même pas tentée');
});

test('synchronisation : une vente refusée n\'empêche pas les suivantes', async () => {
  const file = [V('a', [[1, 1]]), V('b', [[1, 1]]), V('c', [[1, 1]])];
  const r = await BQ.synchroniserFile(file, async (v) => { if (v.cle === 'b') throw erreur(400, 'Un des produits est introuvable.'); return { numero: 1 }; });
  assert.equal(r.arret, null);
  assert.deepEqual(r.resultats.map((x) => [x.cle, x.issue]), [['a', 'envoyee'], ['b', 'refusee'], ['c', 'envoyee']]);
  assert.equal(r.resultats[1].raison, 'Un des produits est introuvable.');
});

test('synchronisation : session expirée, abonnement expiré, erreur serveur -> arrêt sans rien perdre', async () => {
  for (const [st, arret] of [[401, 'auth'], [402, 'abonnement'], [500, 'reessayer'], [503, 'reessayer']]) {
    const r = await BQ.synchroniserFile([V('a', [[1, 1]]), V('b', [[1, 1]])], async () => { throw erreur(st); });
    assert.equal(r.arret, arret, String(st));
    assert.deepEqual(r.resultats, []);
  }
});

test('synchronisation : les ventes déjà refusées ne sont pas renvoyées', async () => {
  let appels = 0;
  const r = await BQ.synchroniserFile([V('a', [[1, 1]], 'refusee'), V('b', [[1, 1]])], async () => { appels++; return { numero: 5 }; });
  assert.equal(appels, 1);
  assert.deepEqual(r.resultats.map((x) => x.cle), ['b']);
});

test('synchronisation : file vide', async () => {
  assert.deepEqual(await BQ.synchroniserFile([], async () => { throw new Error('jamais'); }), { resultats: [], arret: null });
});

test('interface : jamais d\'appel direct à vue.replaceChildren (il écrirait « null » pour un bloc vide)', () => {
  const fs = require('node:fs');
  for (const f of ['app.js', 'admin.js']) {
    const code = fs.readFileSync(`${__dirname}/../public/assets/${f}`, 'utf8');
    assert.ok(!/\bvue\.replaceChildren\(/.test(code), `${f} : utiliser remplacer(vue, …)`);
    assert.ok(code.includes('const remplacer ='), `${f} : fonction remplacer absente`);
  }
});
