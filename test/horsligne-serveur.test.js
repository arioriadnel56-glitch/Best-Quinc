'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, setHandler, calls } = require('./helpers');
const jwt = require('../server/lib/jwt');
const { planifierVente, heureVente, texteAnomalie } = require('../server/lib/vente');

const SECRET = process.env.JWT_SECRET;
const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const post = (base, p, body, tok) => fetch(base + p, { method: 'POST', headers: H(tok), body: JSON.stringify(body) });

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });
test.beforeEach(() => { calls.length = 0; });

const P = (id, nom, prix, stock, actif = true) => ({ id, nom, prix_vente: prix, quantite_stock: stock, actif });

// ---------- Logique pure ----------
test('vente en ligne : prix du serveur, stock insuffisant ou produit archivé refusés', () => {
  const d = (qte, prix = null) => new Map([[1, { qte, prix }]]);
  const ok = planifierVente([P(1, 'Ciment', 6500, 10)], d(4, 1), { horsLigne: false });
  assert.equal(ok.total, 26000);
  assert.equal(ok.lignes[0].decremente, 4);
  assert.deepEqual(ok.anomalies, []);
  assert.throws(() => planifierVente([P(1, 'Ciment', 6500, 3)], d(4), { horsLigne: false }), /Stock insuffisant/);
  assert.throws(() => planifierVente([P(1, 'Ciment', 6500, 9, false)], d(1), { horsLigne: false }), /archivé/);
});

test('vente hors connexion : toujours enregistrée, écarts signalés, stock jamais négatif', () => {
  const d = (qte, prix = null) => new Map([[1, { qte, prix }]]);
  let r = planifierVente([P(1, 'Ciment', 7000, 10)], d(2, 6500), { horsLigne: true });
  assert.equal(r.total, 13000, 'prix affiché au client conservé');
  assert.equal(r.lignes[0].prix, 6500);
  assert.match(r.anomalies[0], /vendu 6 500 F CFA au lieu de 7 000 F CFA/);

  r = planifierVente([P(1, 'Ciment', 6500, 3)], d(5, 6500), { horsLigne: true });
  assert.equal(r.lignes[0].decremente, 3, 'le stock descend à 0, pas en dessous');
  assert.match(r.anomalies.join(';'), /stock insuffisant pour « Ciment » : 5 vendu\(s\), 3 en stock/);

  r = planifierVente([P(1, 'Ciment', 6500, 8, false)], d(1, 6500), { horsLigne: true });
  assert.match(r.anomalies[0], /archivé/);

  r = planifierVente([P(1, 'Ciment', 6500, 8)], d(1, 6500), { horsLigne: true });
  assert.deepEqual(r.anomalies, [], 'aucune anomalie quand tout concorde');
});

test('heure de vente : plausible acceptée, absurde ignorée', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(heureVente('2026-10-04T09:30:00Z', now).date, '2026-10-04T09:30:00.000Z');
  assert.equal(heureVente('2026-10-04T12:05:00Z', now).date, '2026-10-04T12:05:00.000Z');
  for (const mauvais of ['2030-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'pas une date']) {
    const r = heureVente(mauvais, now);
    assert.equal(r.date, null);
    assert.match(r.anomalie, /heure de l'appareil/);
  }
  assert.deepEqual(heureVente(undefined, now), { date: null, anomalie: null });
  assert.equal(texteAnomalie([]), null);
  assert.equal(texteAnomalie(['a'.repeat(900)]).length, 500);
});

// ---------- Route ----------
function ctxVente({ existante = null, produits = [P(1, 'Ciment', 6500, 10)] } = {}) {
  setHandler(async (sql, params) => {
    if (sql.includes('u.mdp_temporaire')) return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'S', email: 's@a.fr', role: 'secretaire', actif: true, entreprise_statut: 'actif' }] };
    if (sql.includes('FROM abonnements')) return { rows: [{ id: 1, date_fin: '2099-01-01' }] };
    if (sql.includes('FROM ventes WHERE entreprise_id = $1 AND cle')) return { rows: existante ? [existante] : [] };
    if (sql.includes('FROM produits') && sql.includes('FOR UPDATE')) return { rows: produits.filter((p) => params[1].includes(p.id)) };
    if (sql.includes('MAX(numero)')) return { rows: [{ n: 214 }] };
    if (sql.includes('INSERT INTO ventes')) return { rows: [{ id: 77, numero: 214, total: params[5], anomalie: params[9] }] };
    return { rows: [] };
  });
  return jwt.sign({ sub: 3, typ: 'user' }, SECRET);
}
const CLE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const HEURE = new Date(Date.now() - 3600000).toISOString();

test('route : vente hors connexion enregistrée avec son heure, son prix et son identifiant', async () => {
  const tok = ctxVente({ produits: [P(1, 'Ciment', 7000, 2)] });
  const r = await post(srv.base, '/api/ventes', { hors_ligne: true, cle: CLE, cree_le: HEURE, mode_paiement: 'especes',
    lignes: [{ produit_id: 1, quantite: 5, prix_unitaire: 6500 }] }, tok);
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.total, 32500);
  assert.match(j.anomalie, /au lieu de 7 000/);
  assert.match(j.anomalie, /stock insuffisant/);
  const ins = calls.find((c) => c.sql.includes('INSERT INTO ventes'));
  assert.equal(ins.params[7], CLE);
  assert.equal(ins.params[8], true);
  assert.equal(ins.params[10], new Date(HEURE).toISOString());
  const maj = calls.find((c) => c.sql.includes('UPDATE produits SET quantite_stock'));
  assert.equal(maj.params[0], 2, 'le stock ne descend que de ce qui existait');
  const mvt = calls.find((c) => c.sql.includes('INSERT INTO mouvements_stock'));
  assert.equal(mvt.params[2], -2);
  assert.match(mvt.params[3], /hors connexion/);
});

test('route : un renvoi avec le même identifiant ne crée pas de seconde vente', async () => {
  const tok = ctxVente({ existante: { id: 77, numero: 214, total: 32500, anomalie: null } });
  const r = await post(srv.base, '/api/ventes', { hors_ligne: true, cle: CLE, lignes: [{ produit_id: 1, quantite: 1, prix_unitaire: 6500 }] }, tok);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.deja_enregistree, true);
  assert.equal(j.numero, 214);
  assert.equal(calls.filter((c) => /^\s*(INSERT|UPDATE)/.test(c.sql)).length, 0, 'aucune écriture');
});

test('route : un prix envoyé par le client est ignoré pour une vente en ligne', async () => {
  const tok = ctxVente();
  const r = await post(srv.base, '/api/ventes', { lignes: [{ produit_id: 1, quantite: 2, prix_unitaire: 1 }] }, tok);
  assert.equal(r.status, 201);
  assert.equal((await r.json()).total, 13000);
});

test('route : refus des identifiants invalides, produits inconnus et prix incohérents', async () => {
  const tok = ctxVente();
  const l = [{ produit_id: 1, quantite: 1, prix_unitaire: 6500 }];
  assert.equal((await post(srv.base, '/api/ventes', { hors_ligne: true, lignes: l }, tok)).status, 400, 'hors ligne sans identifiant');
  assert.equal((await post(srv.base, '/api/ventes', { hors_ligne: true, cle: 'court', lignes: l }, tok)).status, 400);
  assert.equal((await post(srv.base, '/api/ventes', { hors_ligne: true, cle: CLE, lignes: [{ produit_id: 99, quantite: 1, prix_unitaire: 5 }] }, tok)).status, 400, 'produit d\'une autre entreprise');
  assert.equal((await post(srv.base, '/api/ventes', { hors_ligne: true, cle: CLE, lignes: [{ produit_id: 1, quantite: 1, prix_unitaire: 5 }, { produit_id: 1, quantite: 1, prix_unitaire: 6 }] }, tok)).status, 400);
  assert.equal((await post(srv.base, '/api/ventes', { hors_ligne: true, cle: CLE, lignes: [{ produit_id: 1, quantite: 1, prix_unitaire: -5 }] }, tok)).status, 400);
});

test('route : heure absurde -> vente enregistrée à l\'heure d\'envoi avec anomalie', async () => {
  const tok = ctxVente();
  const r = await post(srv.base, '/api/ventes', { hors_ligne: true, cle: CLE, cree_le: '2031-01-01T00:00:00Z', lignes: [{ produit_id: 1, quantite: 1, prix_unitaire: 6500 }] }, tok);
  assert.equal(r.status, 201);
  assert.match((await r.json()).anomalie, /heure de l'appareil/);
  assert.equal(calls.find((c) => c.sql.includes('INSERT INTO ventes')).params[10], null);
});

test('route : marquer une anomalie comme vérifiée est réservé au propriétaire', async () => {
  const tok = ctxVente();
  const r = await fetch(`${srv.base}/api/ventes/77/verifiee`, { method: 'PUT', headers: H(tok), body: '{}' });
  assert.equal(r.status, 403);
});
