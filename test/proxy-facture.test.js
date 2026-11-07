'use strict';
// Proxy Cloudflare Pages des liens de factures : le visiteur ne voit jamais la page technique de l'hébergeur
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const JETON = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 caractères
let onRequest;
let api;
let mode = 'normal';
let appels = 0;

test.before(async () => {
  ({ onRequest } = await import(pathToFileURL(path.join(__dirname, '..', 'functions', 'f', '[[path]].js')).href));
  api = http.createServer((req, res) => {
    appels += 1;
    if (mode === 'lent') return; // le backend dort : la connexion reste ouverte sans réponse
    if (mode === 'reveil') { res.writeHead(503, { 'Content-Type': 'text/html' }); return res.end('<html>Service Waking Up</html>'); }
    if (req.url.endsWith('.jpg')) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=300', 'Set-Cookie': 'x=1' }); return res.end(Buffer.from([0xff, 0xd8, 0xff])); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' });
    res.end('<html><title>Facture n° 00012</title></html>');
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
});
test.after(() => { api.closeAllConnections(); api.close(); });

const env = () => ({ API_URL: `http://127.0.0.1:${api.address().port}`, DELAI_MS: 300 });
const requete = (chemin, init) => new Request(`https://best-quinca.pages.dev${chemin}`, init);

test('backend éveillé : la page de facture est relayée telle quelle', async () => {
  mode = 'normal';
  const res = await onRequest({ request: requete(`/f/${JETON}`), env: env() });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Facture n° 00012/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('images relayées avec leur cache, sans cookie', async () => {
  mode = 'normal';
  const res = await onRequest({ request: requete(`/f/${JETON}/facture.jpg`), env: env() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('backend endormi (aucune réponse dans le délai) : page Best-Quinca qui se recharge, jamais l\'écran de l\'hébergeur', async () => {
  mode = 'lent';
  const debut = Date.now();
  const res = await onRequest({ request: requete(`/f/${JETON}`), env: env() });
  assert.ok(Date.now() - debut < 2000);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.headers.get('retry-after'));
  const html = await res.text();
  assert.match(html, /Votre facture se prépare/);
  assert.match(html, /location\.replace/);
  assert.ok(!/render/i.test(html));
});

test('le proxy du backend renvoie 503 HTML (réveil) : même page de transition', async () => {
  mode = 'reveil';
  const res = await onRequest({ request: requete(`/f/${JETON}/facture.jpg`), env: env() });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Votre facture se prépare/);
});

test('après plusieurs rechargements sans succès : message d\'échec avec « Réessayer »', async () => {
  mode = 'lent';
  const res = await onRequest({ request: requete(`/f/${JETON}?essai=12`), env: env() });
  const html = await res.text();
  assert.match(html, /essai = 12/);
  assert.match(html, /La facture n'a pas pu être chargée/);
});

test('seuls les liens de factures valides passent (pas de proxy ouvert) ; GET et HEAD uniquement', async () => {
  mode = 'normal';
  appels = 0;
  for (const chemin of ['/f/court', `/f/${JETON}/../../api/admin`, `/f/${JETON}/autre.png`, '/api/config', `/f/${JETON}%2F..`]) {
    const res = await onRequest({ request: requete(chemin), env: env() });
    assert.equal(res.status, 404, chemin);
  }
  assert.equal(appels, 0); // le backend n'a même pas été sollicité
  const post = await onRequest({ request: requete(`/f/${JETON}`, { method: 'POST', body: '{}' }), env: env() });
  assert.equal(post.status, 405);
});

test('API_URL absente ou invalide : erreur claire', async () => {
  const res = await onRequest({ request: requete(`/f/${JETON}`), env: {} });
  assert.equal(res.status, 500);
});
