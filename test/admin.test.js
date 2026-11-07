'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, setHandler, calls } = require('./helpers');
const jwt = require('../server/lib/jwt');
const settings = require('../server/lib/settings');
const { hashPassword } = require('../server/lib/password');

const SECRET = process.env.JWT_SECRET;
const adminTok = jwt.sign({ sub: 1, typ: 'admin' }, SECRET);
const userTok = jwt.sign({ sub: 3, typ: 'user' }, SECRET);
const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

let srv;
let stockes; // simule la table plateforme_parametres
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });
test.beforeEach(() => {
  stockes = new Map();
  settings.invalidate();
  setHandler(async (sql, params) => {
    if (sql.includes('FROM admins_plateforme WHERE id')) return { rows: [{ id: 1, nom_complet: 'Adnel', email: 'a@b.fr', actif: true }] };
    if (sql.includes('INSERT INTO plateforme_parametres')) { stockes.set(params[0], params[1]); return { rows: [] }; }
    if (sql.includes('DELETE FROM plateforme_parametres')) { stockes.delete(params[0]); return { rows: [] }; }
    if (sql.includes('FROM plateforme_parametres')) return { rows: [...stockes].map(([cle, valeur]) => ({ cle, valeur })) };
    return { rows: [] };
  });
});

test('chiffrement : aller-retour, sel aléatoire, falsification détectée', () => {
  const a = settings.encrypt('sk_live_abcdef123456');
  const b = settings.encrypt('sk_live_abcdef123456');
  assert.notEqual(a, b);
  assert.ok(!a.includes('abcdef'));
  assert.equal(settings.decrypt(a), 'sk_live_abcdef123456');
  const [p, iv, tag, ct] = a.split(':');
  const abime = [p, iv, tag, Buffer.from('xxxxxxxxxxxxxxxxxxxx').toString('base64')].join(':');
  assert.equal(settings.decrypt(abime), null);
  assert.equal(settings.decrypt('pas-chiffre'), null);
});

test('un jeton admin ne donne aucun accès aux routes entreprise, et inversement', async () => {
  assert.equal((await fetch(`${srv.base}/api/produits`, { headers: H(adminTok) })).status, 401);
  assert.equal((await fetch(`${srv.base}/api/auth/me`, { headers: H(adminTok) })).status, 401);
  for (const p of ['/api/admin/me', '/api/admin/stats', '/api/admin/entreprises', '/api/admin/paiements', '/api/admin/parametres']) {
    assert.equal((await fetch(srv.base + p, { headers: H(userTok) })).status, 401, p);
    assert.equal((await fetch(srv.base + p)).status, 401, p);
  }
  assert.equal((await fetch(`${srv.base}/api/admin/me`, { headers: H(adminTok) })).status, 200);
});

test('connexion admin : identifiants inconnus -> 401 neutre ; bon mot de passe -> jeton admin', async () => {
  let r = await fetch(`${srv.base}/api/admin/login`, { method: 'POST', headers: H(''), body: JSON.stringify({ email: 'qui@ca.fr', mot_de_passe: 'xxxxxxxxxxxx' }) });
  assert.equal(r.status, 401);
  assert.match((await r.json()).erreur, /incorrect/);

  const hash = await hashPassword('un-mot-de-passe-long');
  setHandler(async (sql) => (sql.includes('FROM admins_plateforme WHERE email') ? { rows: [{ id: 7, mot_de_passe_hash: hash, actif: true }] } : { rows: [] }));
  r = await fetch(`${srv.base}/api/admin/login`, { method: 'POST', headers: H(''), body: JSON.stringify({ email: 'ok@ca.fr', mot_de_passe: 'un-mot-de-passe-long' }) });
  assert.equal(r.status, 200);
  const payload = jwt.verify((await r.json()).token, SECRET);
  assert.equal(payload.typ, 'admin');
  assert.equal(payload.sub, 7);
});

test('paramètres : les secrets sont enregistrés chiffrés et jamais renvoyés en clair', async () => {
  const KEY = 'tpk_secret_ABCDEFGH12345678';
  const r = await fetch(`${srv.base}/api/admin/parametres`, { method: 'PUT', headers: H(adminTok),
    body: JSON.stringify({ valeurs: { kkiapay_secret: KEY, kkiapay_public_key: 'pk_test_123456', kkiapay_private_key: 'tpr_private_654321' } }) });
  assert.equal(r.status, 200);
  const corps = await r.text();
  assert.ok(!corps.includes(KEY), 'la réponse ne doit pas contenir la clé');
  // en base : chiffré pour les secrets, clair pour la clé publique
  assert.ok(stockes.get('kkiapay_secret').startsWith('enc1:'));
  assert.ok(!stockes.get('kkiapay_secret').includes('ABCDEFGH'));
  assert.equal(stockes.get('kkiapay_public_key'), 'pk_test_123456');
  assert.ok(!calls.some((c) => JSON.stringify(c.params || []).includes(KEY)), 'la clé ne doit jamais être envoyée en clair à la base');

  const g = await (await fetch(`${srv.base}/api/admin/parametres`, { headers: H(adminTok) })).json();
  assert.equal(g.parametres.kkiapay_secret.definie, true);
  assert.equal(g.parametres.kkiapay_secret.source, 'admin');
  assert.equal(g.parametres.kkiapay_secret.apercu, '••••5678');
  assert.ok(!JSON.stringify(g).includes(KEY));
  assert.equal(g.parametres.kkiapay_public_key.valeur, 'pk_test_123456');
});

test('paramètres : champ secret vide = valeur conservée ; effacer la supprime', async () => {
  await fetch(`${srv.base}/api/admin/parametres`, { method: 'PUT', headers: H(adminTok), body: JSON.stringify({ valeurs: { kkiapay_secret: 'cle-secrete-12345' } }) });
  const avant = stockes.get('kkiapay_secret');
  let r = await fetch(`${srv.base}/api/admin/parametres`, { method: 'PUT', headers: H(adminTok), body: JSON.stringify({ valeurs: { kkiapay_secret: '', abonnement_prix: 4500 } }) });
  assert.equal(r.status, 200);
  assert.equal(stockes.get('kkiapay_secret'), avant);
  assert.equal(stockes.get('abonnement_prix'), '4500');
  r = await fetch(`${srv.base}/api/admin/parametres`, { method: 'PUT', headers: H(adminTok), body: JSON.stringify({ effacer: ['kkiapay_secret'] }) });
  assert.equal(r.status, 200);
  assert.equal(stockes.has('kkiapay_secret'), false);
});

test('paramètres : validation (clé inconnue, prix hors bornes, espaces dans une clé)', async () => {
  const put = (valeurs) => fetch(`${srv.base}/api/admin/parametres`, { method: 'PUT', headers: H(adminTok), body: JSON.stringify({ valeurs }) });
  assert.equal((await put({ nimporte: 'x' })).status, 400);
  assert.equal((await put({ abonnement_prix: 5 })).status, 400);
  assert.equal((await put({ abonnement_jours: 1.5 })).status, 400);
  assert.equal((await put({ kkiapay_secret: 'a b c d e f g' })).status, 400);
  assert.equal((await put({ kkiapay_sandbox: 'peut-être' })).status, 400);
  assert.equal((await fetch(`${srv.base}/api/admin/parametres`, { method: 'PUT', headers: H(adminTok), body: '{}' })).status, 400);
  assert.equal(stockes.size, 0);
});

test('les clés saisies par le super admin activent KkiaPay et changent le prix, sans fuite de clé privée', async () => {
  let c = await (await fetch(`${srv.base}/api/config`)).json();
  assert.deepEqual(c.agregateurs, []);
  await fetch(`${srv.base}/api/admin/parametres`, { method: 'PUT', headers: H(adminTok),
    body: JSON.stringify({ valeurs: { kkiapay_public_key: 'pk_test_PUBLIC', kkiapay_private_key: 'tpr_PRIVEE_SECRETE', kkiapay_secret: 'tsk_SECRETE_API', abonnement_prix: 5000 } }) });
  settings.invalidate();
  const brut = await (await fetch(`${srv.base}/api/config`)).text();
  c = JSON.parse(brut);
  assert.equal(c.prix, 5000);
  assert.equal(c.agregateurs.length, 1);
  assert.equal(c.agregateurs[0].id, 'kkiapay');
  assert.equal(c.agregateurs[0].config.publicKey, 'pk_test_PUBLIC');
  assert.ok(!brut.includes('PRIVEE_SECRETE') && !brut.includes('SECRETE_API'));
});

test('webhook KkiaPay : accepte uniquement la clé secrète enregistrée par le super admin', async () => {
  await fetch(`${srv.base}/api/admin/parametres`, { method: 'PUT', headers: H(adminTok), body: JSON.stringify({ valeurs: { kkiapay_secret: 'tsk_SECRETE_API' } }) });
  settings.invalidate();
  const post = (secret) => fetch(`${srv.base}/api/webhooks/kkiapay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kkiapay-secret': secret }, body: '{}' });
  assert.equal((await post('mauvaise')).status, 401);
  assert.equal((await post('tsk_SECRETE_API')).status, 400); // signature acceptée, corps sans transactionId
});

test('entreprises : suspendre, offrir des jours (bornes), listing protégé', async () => {
  const put = (id, statut) => fetch(`${srv.base}/api/admin/entreprises/${id}/statut`, { method: 'PUT', headers: H(adminTok), body: JSON.stringify({ statut }) });
  assert.equal((await put(5, 'detruit')).status, 400);
  assert.equal((await put(5, 'suspendu')).status, 404); // aucune ligne modifiée dans la base simulée
  const off = (jours) => fetch(`${srv.base}/api/admin/entreprises/5/offrir`, { method: 'POST', headers: H(adminTok), body: JSON.stringify({ jours }) });
  assert.equal((await off(0)).status, 400);
  assert.equal((await off(400)).status, 400);
  assert.equal((await fetch(`${srv.base}/api/admin/entreprises`, { headers: H(adminTok) })).status, 200);
});

test('page /admin servie sans mise en cache et non indexable', async () => {
  const r = await fetch(`${srv.base}/admin`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.match(await r.text(), /admin\.js/);
});
