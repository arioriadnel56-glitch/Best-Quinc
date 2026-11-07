'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, setHandler, calls } = require('./helpers');
const jwt = require('../server/lib/jwt');

const ESPACE = { slug: 'zinsou', nom: 'Quincaillerie Zinsou', nom_app: 'Zinsou Quinca', couleur: '#B5532A' };
let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });

test('chaque entreprise a son propre manifeste PWA', async () => {
  setHandler(async (sql, params) => ({ rows: params[0] === 'zinsou' ? [ESPACE] : [] }));
  const res = await fetch(`${srv.base}/app/zinsou/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /manifest\+json/);
  const m = await res.json();
  assert.equal(m.name, 'Zinsou Quinca');
  assert.equal(m.start_url, '/app/zinsou/');
  assert.equal(m.scope, '/app/zinsou/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#B5532A');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
});

test('espace inconnu : 404 sur manifeste, page et icône', async () => {
  setHandler(async () => ({ rows: [] }));
  for (const p of ['/app/fantome/manifest.webmanifest', '/app/fantome/', '/app/fantome/icon-192.png', '/app/fantome/sw.js']) {
    assert.equal((await fetch(srv.base + p)).status, 404, p);
  }
});

test('page de l\'application : nom, couleur et manifeste injectés, HTML échappé', async () => {
  setHandler(async () => ({ rows: [{ ...ESPACE, nom_app: 'Zinsou <script>alert(1)</script>' }] }));
  const html = await (await fetch(`${srv.base}/app/zinsou/`)).text();
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
  assert.match(html, /theme-color" content="#B5532A"/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('{{'));
});

test('/app/slug sans slash final redirige', async () => {
  const res = await fetch(`${srv.base}/app/zinsou`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/app/zinsou/');
});

test('service worker limité au cache de l\'espace', async () => {
  setHandler(async () => ({ rows: [ESPACE] }));
  const js = await (await fetch(`${srv.base}/app/zinsou/sw.js`)).text();
  assert.match(js, /const SLUG = 'zinsou' === '\*'/); // identifiant de l'espace écrit dans le service worker
  assert.match(js, /const CACHE = 'bq-' \+ SLUG \+ '-v/);
  assert.ok(!js.includes('{{'));
  new Function(js); // doit compiler
});

test('icônes PNG générées par entreprise', async () => {
  setHandler(async () => ({ rows: [ESPACE] }));
  for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    const res = await fetch(`${srv.base}/app/zinsou/${f}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf[1], 0x50);
  }
});

test('routes protégées : sans jeton 401, jeton falsifié 401', async () => {
  setHandler(async () => ({ rows: [] }));
  for (const p of ['/api/produits', '/api/ventes', '/api/tableau-de-bord', '/api/utilisateurs', '/api/abonnement', '/api/auth/me']) {
    assert.equal((await fetch(srv.base + p)).status, 401, p);
    const r = await fetch(srv.base + p, { headers: { Authorization: 'Bearer abc.def.ghi' } });
    assert.equal(r.status, 401, p);
  }
});

test('sans abonnement actif : 402 sur les fonctions métier', async () => {
  const tok = jwt.sign({ sub: 3 }, process.env.JWT_SECRET);
  setHandler(async (sql) => {
    if (sql.includes('FROM utilisateurs u JOIN entreprises')) {
      return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'A', email: 'a@a.fr', role: 'proprietaire', actif: true, entreprise_statut: 'actif' }] };
    }
    return { rows: [] }; // aucun abonnement actif
  });
  const res = await fetch(`${srv.base}/api/produits`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(res.status, 402);
  assert.equal((await res.json()).code, 'ABONNEMENT_REQUIS');
});

test('le secrétaire ne peut pas créer de produit ni voir l\'équipe', async () => {
  const tok = jwt.sign({ sub: 4 }, process.env.JWT_SECRET);
  setHandler(async (sql) => {
    if (sql.includes('FROM utilisateurs u JOIN entreprises')) {
      return { rows: [{ id: 4, entreprise_id: 9, nom_complet: 'S', email: 's@a.fr', role: 'secretaire', actif: true, entreprise_statut: 'actif' }] };
    }
    if (sql.includes('FROM abonnements')) return { rows: [{ id: 1, date_fin: '2099-01-01' }] };
    return { rows: [] };
  });
  const h = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${srv.base}/api/produits`, { method: 'POST', headers: h, body: JSON.stringify({ nom: 'x', prix_vente: 1 }) })).status, 403);
  assert.equal((await fetch(`${srv.base}/api/utilisateurs`, { headers: h })).status, 403);
  assert.equal((await fetch(`${srv.base}/api/abonnement/initier`, { method: 'POST', headers: h, body: JSON.stringify({ agregateur: 'kkiapay' }) })).status, 403);
});

test('webhook KkiaPay refusé sans secret configuré ou mauvais secret', async () => {
  const res = await fetch(`${srv.base}/api/webhooks/kkiapay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kkiapay-secret': 'faux' }, body: '{}' });
  assert.ok([401, 503].includes(res.status));
});

test('KkiaPay et FedaPay absents de /api/config tant que non configurés ; deux formules', async () => {
  const c = await (await fetch(`${srv.base}/api/config`)).json();
  assert.equal(c.prix, 5000);
  assert.deepEqual(c.plans.map((p) => [p.id, p.prix, p.jours]), [['mensuel', 5000, 30], ['annuel', 50000, 365]]);
  assert.deepEqual(c.agregateurs, []);
});

test('JSON invalide : 400 ; route inconnue : 404 ; méthode : 405', async () => {
  const r1 = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{pas du json' });
  assert.equal(r1.status, 400);
  assert.equal((await fetch(`${srv.base}/api/nimporte`)).status, 404);
  assert.equal((await fetch(`${srv.base}/api/auth/login`)).status, 405);
});

test('connexion : identifiants inconnus -> message neutre 401', async () => {
  setHandler(async () => ({ rows: [] }));
  const r = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'zinsou', email: 'qui@ca.fr', mot_de_passe: 'peu importe' }) });
  assert.equal(r.status, 401);
  assert.match((await r.json()).erreur, /incorrect/);
});

test('inscription : validation avant toute écriture en base', async () => {
  calls.length = 0;
  const r = await fetch(`${srv.base}/api/entreprises/inscription`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nom_entreprise: 'Ets', nom_complet: 'Jean', email: 'mauvais', mot_de_passe: 'court' }) });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('fichiers statiques : pas de sortie du dossier assets', async () => {
  assert.equal((await fetch(`${srv.base}/assets/app.js`)).status, 200);
  assert.equal((await fetch(`${srv.base}/assets/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${srv.base}/assets/%2e%2e/.env.example`)).status, 404);
});
