'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { creer, ErreurReseau, DELAIS_REVEIL } = require('../public/assets/reveil.js');

const reponse = (status, corps, type = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n) => (n.toLowerCase() === 'content-type' ? type : null) },
  json: async () => (typeof corps === 'string' ? JSON.parse(corps) : corps),
});

// Fabrique un client avec un faux fetch ; `scenario(url, n)` renvoie une réponse ou lève une erreur
function client(scenario, extra = {}) {
  const appels = [];
  const fetchFictif = async (url, init = {}) => {
    appels.push(url);
    return scenario(url, appels.length, init);
  };
  const r = creer({ fetch: fetchFictif, delais: [0, 0, 0, 0], delaiSonde: 50, config: { api: 'https://api.exemple.test/' }, ...extra });
  return { r, appels };
}

test('l\'adresse du serveur est configurable et sans barre finale', () => {
  const { r } = client(() => reponse(200, {}), { location: { origin: 'https://site.test', protocol: 'https:', host: 'site.test' } });
  assert.equal(r.url('/api/x'), 'https://api.exemple.test/api/x');
  assert.equal(r.origine(), 'https://api.exemple.test');
  assert.equal(r.wsUrl(), 'wss://api.exemple.test/ws');
  const meme = creer({ fetch: async () => reponse(200, {}), location: { origin: 'https://site.test', protocol: 'https:', host: 'site.test' } });
  assert.equal(meme.url('/api/x'), '/api/x');
  assert.equal(meme.wsUrl(), 'wss://site.test/ws');
});

test('slug lu dans l\'adresse de l\'espace', () => {
  const { r } = client(() => reponse(200, {}));
  assert.equal(r.slugDepuisChemin('/app/zinsou/'), 'zinsou');
  assert.equal(r.slugDepuisChemin('/app/zinsou'), 'zinsou');
  assert.equal(r.slugDepuisChemin('/app/'), '');
  assert.equal(r.slugDepuisChemin('/autre/zinsou/'), '');
});

test('aucun appel au serveur sans demande : pas de ping, pas de minuteur', async () => {
  const { r, appels } = client(() => reponse(200, { ok: true }));
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(appels.length, 0);
  assert.equal(r.etat().serveur, 'inconnu');
});

test('une réponse JSON normale marque le serveur prêt', async () => {
  const { r } = client(() => reponse(200, { a: 1 }));
  const res = await r.appeler('/api/config');
  assert.equal(res.status, 200);
  assert.equal(r.etat().serveur, 'pret');
  assert.equal(r.estPret(), true);
});

test('erreur réseau avec internet : serveur probablement en réveil ; sans internet : hors connexion', async () => {
  const { r } = client(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(r.appeler('/api/x'), (e) => e instanceof ErreurReseau && e.kind === 'reveil' && e.hors_ligne === true);
  const hors = creer({ fetch: async () => { throw new TypeError('x'); }, enLigne: () => false });
  await assert.rejects(hors.appeler('/api/x'), (e) => e.kind === 'hors_ligne');
});

test('502/503/504 du proxy (hors JSON) = réveil ; 503 JSON de l\'application = vraie réponse', async () => {
  for (const code of [502, 503, 504]) {
    const { r } = client(() => reponse(code, '<html>Service waking up</html>', 'text/html'));
    await assert.rejects(r.appeler('/api/x'), (e) => e.kind === 'reveil' && e.status === code);
  }
  const { r } = client(() => reponse(503, { erreur: 'Service indisponible' }));
  const res = await r.appeler('/api/x');
  assert.equal(res.status, 503);
});

test('page HTML renvoyée à la place du JSON = page d\'attente de l\'hébergeur, sauf pour un téléchargement', async () => {
  const { r } = client(() => reponse(200, '<html>Loading</html>', 'text/html'));
  await assert.rejects(r.appeler('/api/x'), (e) => e.kind === 'reveil');
  const { r: r2 } = client(() => reponse(200, {}, 'application/pdf'));
  assert.equal((await r2.appeler('/api/bilan/pdf', {}, { json: false })).status, 200);
});

test('délai maximum dépassé = réveil (la requête est annulée)', async () => {
  const { r } = client((url, n, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(new Error('abort'))); }));
  const debut = Date.now();
  await assert.rejects(r.appeler('/api/x', {}, { delai: 40 }), (e) => e.kind === 'reveil');
  assert.ok(Date.now() - debut < 1000);
});

test('réveil : sondes /healthz jusqu\'au succès, puis prêt', async () => {
  const { r, appels } = client((url, n) => (n < 3 ? reponse(503, '<html>wake</html>', 'text/html') : reponse(200, { ok: true })));
  const vus = [];
  r.surEtat((s) => vus.push(s.serveur));
  assert.equal(await r.reveiller(), true);
  assert.equal(appels.length, 3);
  assert.ok(appels.every((u) => u === 'https://api.exemple.test/healthz'));
  assert.equal(r.etat().serveur, 'pret');
  assert.ok(vus.includes('reveil') && vus.at(-1) === 'pret');
});

test('réveil : base de données injoignable (ok: false) = pas prêt', async () => {
  const { r, appels } = client(() => reponse(503, { ok: false }));
  assert.equal(await r.reveiller(), false);
  assert.equal(appels.length, 5); // 4 attentes + 1
  assert.equal(r.etat().serveur, 'indisponible');
});

test('réveil : une seule boucle partagée entre appelants simultanés', async () => {
  const { r, appels } = client((url, n) => (n < 2 ? reponse(503, '', 'text/html') : reponse(200, { ok: true })));
  const [a, b, c] = await Promise.all([r.reveiller(), r.reveiller(), r.reveiller()]);
  assert.deepEqual([a, b, c], [true, true, true]);
  assert.equal(appels.length, 2);
});

test('pendant un réveil, les appels échouent aussitôt sans solliciter le serveur', async () => {
  let libere;
  const bloque = new Promise((res) => { libere = res; });
  const { r, appels } = client(async (url) => { await bloque; return reponse(200, { ok: true }); });
  const boucle = r.reveiller();
  await assert.rejects(r.appeler('/api/ventes', { method: 'POST' }), (e) => e.kind === 'reveil');
  assert.equal(appels.length, 1); // seule la sonde est partie
  libere();
  assert.equal(await boucle, true);
});

test('les attentes sont progressives et bornées', () => {
  for (let i = 1; i < DELAIS_REVEIL.length; i++) assert.ok(DELAIS_REVEIL[i] >= DELAIS_REVEIL[i - 1]);
  const total = DELAIS_REVEIL.reduce((s, x) => s + x, 0);
  assert.ok(total >= 60000 && total <= 180000, `durée totale ${total} ms`);
});

test('hors connexion : la boucle s\'arrête sans solliciter le réseau', async () => {
  const { r, appels } = client(() => reponse(200, { ok: true }), { enLigne: () => false });
  assert.equal(await r.reveiller(), false);
  assert.equal(appels.length, 0);
  assert.equal(r.etat().serveur, 'inconnu');
});

test('écran : échec puis « Réessayer » relance le réveil et reprend', async () => {
  const journal = [];
  let vague = 0;
  const ecran = {
    attente: () => journal.push('attente'),
    echec: async (o) => { journal.push(`echec:${o.peutContinuer}`); return 'reessayer'; },
    masquer: () => journal.push('masque'),
  };
  const { r } = client(() => { vague += 1; return vague <= 5 ? reponse(503, '', 'text/html') : reponse(200, { ok: true }); }, { ecran });
  assert.equal(await r.attendreServeur({ peutContinuer: true }), true);
  assert.deepEqual(journal.filter((x) => x !== 'attente'), ['echec:true', 'masque']);
});

test('écran : « Continuer hors connexion » rend la main sans serveur', async () => {
  const ecran = { attente: () => {}, echec: async () => 'continuer', masquer: () => {} };
  const { r } = client(() => reponse(503, '', 'text/html'), { ecran });
  assert.equal(await r.attendreServeur({ peutContinuer: true }), false);
});

test('garantir : pas de sonde si le serveur vient de répondre, sonde sinon', async () => {
  const { r, appels } = client(() => reponse(200, { ok: true }));
  await r.appeler('/api/config');
  assert.equal(await r.garantir({ avecEcran: false }), true);
  assert.equal(appels.length, 1);
  let t = 0;
  const { r: r2, appels: a2 } = client(() => reponse(200, { ok: true }), { now: () => t });
  await r2.appeler('/api/config');
  t += 11 * 60 * 1000; // plus de 10 minutes : le serveur a pu se rendormir
  assert.equal(await r2.garantir({ avecEcran: false }), true);
  assert.equal(a2.length, 2);
  assert.ok(a2[1].endsWith('/healthz'));
});
