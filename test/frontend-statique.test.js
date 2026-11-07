'use strict';
// Frontend statique (dist/) : l'application s'ouvre sans le backend. Vérifie la construction, les réécritures d'adresses,
// le comportement du service worker serveur endormi, et qu'un visiteur de la vitrine ne sollicite jamais le serveur.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const API = 'https://api.exemple.test';
let dist;
const lire = (p) => fs.readFileSync(path.join(dist, p), 'utf8');

test.before(async () => {
  const { construire } = require('../scripts/build-frontend.js');
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-dist-'));
  console.warn = () => {}; // « lecture des paramètres impossible » : attendu à la construction (pas de base)
  console.error = () => {};
  await construire({ apiUrl: `${API}/`, sortie: dist });
});
test.after(() => fs.rmSync(dist, { recursive: true, force: true }));

test('API_URL obligatoire et sans chemin', () => {
  const { normaliserApi } = require('../scripts/build-frontend.js');
  assert.throws(() => normaliserApi(''), /API_URL/);
  assert.throws(() => normaliserApi('best-quinca.onrender.com'), /API_URL/);
  assert.throws(() => normaliserApi('https://x.test/chemin'), /API_URL/);
  assert.equal(normaliserApi('https://x.test/'), 'https://x.test');
});

test('fichiers produits : vitrine, coque d\'application, pages légales, administration, rapport partenaire', () => {
  for (const f of ['index.html', '_app/index.html', '_app/sw.js', '_app/manifest.webmanifest', 'admin.html', 'sponsor/index.html', 'entrer.html', 'confidentialite.html', 'conditions.html', 'supprimer-mon-compte.html', '404.html', 'favicon.ico', '_redirects', '_headers', 'assets/config.js', 'assets/reveil.js']) {
    assert.ok(fs.existsSync(path.join(dist, f)), `manquant : ${f}`);
  }
  assert.match(lire('assets/config.js'), /"api":"https:\/\/api\.exemple\.test"/);
});

test('aucun modèle non rempli ({{…}}) et tout fichier /assets/ référencé existe', () => {
  for (const f of ['index.html', '_app/index.html', '_app/sw.js', 'admin.html', 'sponsor/index.html', 'entrer.html', 'conditions.html']) {
    const t = lire(f);
    assert.ok(!t.includes('{{'), `${f} contient un modèle non rempli`);
    for (const m of t.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) assert.ok(fs.existsSync(path.join(dist, m[1])), `${f} référence ${m[1]} absent`);
  }
});

test('reveil.js et config.js sont chargés avant les scripts qui appellent le serveur', () => {
  for (const [f, script] of [['index.html', 'landing.js'], ['_app/index.html', 'app.js'], ['admin.html', 'admin.js'], ['sponsor/index.html', 'sponsor.js']]) {
    const h = lire(f);
    const i = (s) => h.indexOf(`/assets/${s}`);
    assert.ok(i('config.js') > -1 && i('reveil.js') > i('config.js') && i(script) > i('reveil.js'), `${f} : ordre des scripts`);
  }
});

test('coque de l\'application : aucun espace figé dans la page (il est lu dans l\'adresse)', () => {
  const h = lire('_app/index.html');
  assert.match(h, /<body data-slug="" data-nom="Best-Quinca">/);
});

// Émulation des règles « _redirects » (Cloudflare Pages / Netlify) : première règle correspondante
function resoudre(chemin) {
  const regles = lire('_redirects').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
  for (const [de, vers, statut] of regles) {
    const motif = new RegExp(`^${de.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z]+/g, '([^/]+)').replace(/\*/g, '(.*)')}$`);
    const m = motif.exec(chemin);
    if (m) return { statut: Number(statut), cible: vers.replace(/:[a-z]+/g, () => m[1]) };
  }
  return null;
}

test('réécritures : chaque adresse d\'un espace aboutit à un fichier existant, sans solliciter le backend', () => {
  for (const [adresse, fichier] of [
    ['/app/zinsou/', '_app/index.html'], ['/app/zinsou/sw.js', '_app/sw.js'], ['/app/zinsou/manifest.webmanifest', '_app/manifest.webmanifest'],
    ['/app/zinsou/icon-192.png', 'assets/marque/icone-192.png'], ['/app/zinsou/icon-512.png', 'assets/marque/icone-512.png'],
    ['/app/zinsou/icon-maskable-512.png', 'assets/marque/icone-maskable-512.png'], ['/sponsor/' + 'ab'.repeat(24), 'sponsor/index.html'],
  ]) {
    const r = resoudre(adresse);
    assert.ok(r && r.statut === 200, adresse);
    assert.equal(r.cible.replace(/^\//, ''), fichier, adresse);
    assert.ok(fs.existsSync(path.join(dist, fichier)), fichier);
  }
  assert.deepEqual(resoudre('/app/zinsou'), { statut: 301, cible: '/app/zinsou/' });
  assert.equal(resoudre('/assets/style.css'), null); // les vrais fichiers ne sont pas réécrits
});

test('manifeste unique à adresses relatives : chaque espace garde son propre périmètre d\'installation', () => {
  const m = JSON.parse(lire('_app/manifest.webmanifest'));
  const base = 'https://site.test/app/zinsou/manifest.webmanifest';
  assert.equal(new URL(m.start_url, base).pathname, '/app/zinsou/');
  assert.equal(new URL(m.scope, base).pathname, '/app/zinsou/');
  for (const i of m.icons) assert.ok(resoudre(new URL(i.src, base).pathname), i.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
});

test('en-têtes : CSP du serveur + adresse du backend autorisée, sans script en ligne', () => {
  const h = lire('_headers');
  const csp = /Content-Security-Policy: (.*)/.exec(h)[1];
  assert.match(csp, /connect-src 'self' https:\/\/api\.exemple\.test /);
  assert.match(csp, /script-src 'self' https:\/\/cdn\.kkiapay\.me/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(h, /\/sponsor\/\*\n  Cache-Control: no-store\n  Referrer-Policy: no-referrer/);
});

test('vitrine : tarifs écrits dans la page', () => {
  const h = lire('index.html');
  assert.match(h, /<strong id="prix">5\s000\sF CFA<\/strong>|<strong id="prix">[^<]*5[^<]*000[^<]*<\/strong>/);
  assert.match(h, /<span id="periode">par mois<\/span>/);
  assert.match(h, /<span id="annuel">Ou [^<]*50[^<]*000[^<]* par an : 2 mois offerts\.<\/span>/);
});

test('visiteur de la vitrine : AUCUNE requête vers le serveur à l\'ouverture', () => {
  const requetes = [];
  const el = () => ({ addEventListener() {}, querySelector: () => ({}), textContent: '', remove() {} });
  const ctx = vm.createContext({
    window: { BQ_CONFIG: JSON.parse(/window\.BQ_CONFIG = (.*);/.exec(lire('assets/config.js'))[1]), BQR: {} },
    document: { getElementById: el },
    fetch: (...a) => { requetes.push(a[0]); return Promise.reject(new Error('interdit')); },
    Intl, FormData: class {}, localStorage: {}, sessionStorage: {}, location: {}, encodeURIComponent,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'landing.js'), 'utf8'), ctx);
  assert.deepEqual(requetes, []);
});

// ---- Service worker : ouverture instantanée même quand le serveur est endormi ----
function fabriquerSw({ reseau }) {
  const caches = new Map(); // nom -> Map(adresse absolue -> { status, corps })
  const norm = (k) => new URL(typeof k === 'string' ? k : k.url, 'https://site.test/app/zinsou/sw.js').href;
  const cache = (nom) => ({
    async put(k, res) { const c = res.clone(); caches.get(nom).set(norm(k), { status: c.status, corps: Buffer.from(await c.arrayBuffer()) }); },
    async match(k) { const e = caches.get(nom).get(norm(k)); return e ? new Response(e.corps, { status: e.status }) : undefined; },
  });
  const ecouteurs = {};
  const appelsReseau = [];
  const self = {
    registration: { scope: 'https://site.test/app/zinsou/' }, location: { origin: 'https://site.test' },
    addEventListener: (n, f) => { ecouteurs[n] = f; },
    skipWaiting() {}, clients: { claim: async () => {} },
  };
  const ctx = vm.createContext({
    self, URL, Response, Promise, AbortController, console,
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 80)), clearTimeout,
    caches: {
      open: async (n) => { if (!caches.has(n)) caches.set(n, new Map()); return cache(n); },
      keys: async () => [...caches.keys()],
      delete: async (n) => caches.delete(n),
    },
    fetch: (req, init = {}) => { appelsReseau.push(typeof req === 'string' ? req : req.url); return reseau(req, init); },
  });
  vm.runInContext(lire('_app/sw.js'), ctx);
  const evenement = (extra) => { const e = { respondWith(p) { this.reponse = p; }, waitUntil(p) { this.attente = p; }, ...extra }; return e; };
  return { ecouteurs, caches, evenement, appelsReseau };
}
const navigation = { method: 'GET', mode: 'navigate', url: 'https://site.test/app/zinsou/?source=playstore' };
const coupee = (req, init) => new Promise((_, rej) => { if (init.signal) init.signal.addEventListener('abort', () => rej(new Error('abort'))); else rej(new Error('hors ligne')); });

test('service worker : installation du cache nommé d\'après l\'espace lu dans son adresse', async () => {
  const sw = fabriquerSw({ reseau: async () => new Response('ok') });
  const e = sw.evenement();
  sw.ecouteurs.install(e);
  await e.attente;
  const noms = [...sw.caches.keys()];
  assert.equal(noms.length, 1);
  assert.match(noms[0], /^bq-zinsou-v1\.\d+\.\d+-[0-9a-f]{8}$/);
  assert.ok(sw.caches.get(noms[0]).has('https://site.test/app/zinsou/'));
  assert.ok(sw.caches.get(noms[0]).has('https://site.test/assets/reveil.js'));
});

test('service worker : serveur endormi ou réseau coupé = l\'application s\'ouvre quand même, tout de suite', async () => {
  let reseauOk = true;
  const sw = fabriquerSw({ reseau: (req, init) => (reseauOk ? Promise.resolve(new Response('coque v1')) : coupee(req, init)) });
  const inst = sw.evenement();
  sw.ecouteurs.install(inst);
  await inst.attente;
  reseauOk = false; // le backend / l'hébergeur ne répond plus : la requête reste en attente jusqu'à l'annulation
  const e = sw.evenement({ request: navigation });
  sw.ecouteurs.fetch(e);
  const debut = Date.now();
  const res = await e.reponse;
  assert.ok(Date.now() - debut < 50, 'la coque en cache doit répondre sans attendre le réseau');
  assert.equal(await res.text(), 'coque v1');
  await e.attente; // la mise à jour en arrière-plan échoue silencieusement
});

test('service worker : réseau disponible = coque du cache servie, puis mise à jour pour la prochaine ouverture', async () => {
  let version = 'coque v1';
  const sw = fabriquerSw({ reseau: async () => new Response(version) });
  const inst = sw.evenement();
  sw.ecouteurs.install(inst);
  await inst.attente;
  version = 'coque v2';
  const e = sw.evenement({ request: navigation });
  sw.ecouteurs.fetch(e);
  assert.equal(await (await e.reponse).text(), 'coque v1');
  await e.attente;
  const e2 = sw.evenement({ request: navigation });
  sw.ecouteurs.fetch(e2);
  assert.equal(await (await e2.reponse).text(), 'coque v2');
});

test('service worker : jamais d\'interception des appels de données ni des écritures', async () => {
  const sw = fabriquerSw({ reseau: async () => new Response('x') });
  for (const req of [
    { method: 'GET', mode: 'cors', url: 'https://site.test/api/produits' },
    { method: 'GET', mode: 'cors', url: `${API}/api/produits` },
    { method: 'POST', mode: 'cors', url: 'https://site.test/assets/app.js' },
  ]) {
    const e = sw.evenement({ request: req });
    sw.ecouteurs.fetch(e);
    assert.equal(e.reponse, undefined, `${req.method} ${req.url}`);
  }
});

test('service worker : activation = nettoyage des anciennes versions de CET espace seulement', async () => {
  const sw = fabriquerSw({ reseau: async () => new Response('x') });
  const inst = sw.evenement();
  sw.ecouteurs.install(inst);
  await inst.attente;
  sw.caches.set('bq-zinsou-v0.9.0', new Map());
  sw.caches.set('bq-autre-espace-v1.0.0', new Map());
  const e = sw.evenement();
  sw.ecouteurs.activate(e);
  await e.attente;
  assert.ok(!sw.caches.has('bq-zinsou-v0.9.0'));
  assert.ok(sw.caches.has('bq-autre-espace-v1.0.0'));
});

test('service worker : première visite sans réseau = erreur normale du navigateur (rien à afficher)', async () => {
  const sw = fabriquerSw({ reseau: coupee });
  const e = sw.evenement({ request: navigation });
  sw.ecouteurs.fetch(e);
  const res = await e.reponse;
  assert.equal(res.type, 'error');
});
