'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/none';
process.env.ANDROID_PACKAGE_NAME = 'bj.exemple.app';
process.env.ANDROID_SHA256_FINGERPRINTS = `${Array(32).fill('AB').join(':')}, pas-une-empreinte`;
process.env.CONTACT_EMAIL = 'contact@exemple.bj';
const { handle } = require('../server/index');

const appeler = async (url) => {
  const res = { headers: {}, status: null, body: '', headersSent: false,
    setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h) { this.status = s; Object.assign(this.headers, h); this.headersSent = true; }, end(b) { this.body = String(b || ''); } };
  await handle({ url, method: 'GET', headers: {}, socket: {} }, res);
  return res;
};

test('assetlinks.json : paquet et empreinte valides publiés, empreinte invalide ignorée', async () => {
  const r = await appeler('/.well-known/assetlinks.json');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j[0].target.package_name, 'bj.exemple.app');
  assert.deepEqual(j[0].target.sha256_cert_fingerprints, [Array(32).fill('AB').join(':')]);
  assert.deepEqual(j[0].relation, ['delegate_permission/common.handle_all_urls']);
});

test('manifeste de la plateforme : démarre sur /entrer, icônes maskable incluses', async () => {
  const m = JSON.parse((await appeler('/manifest-plateforme.webmanifest')).body);
  assert.equal(m.start_url, '/entrer?source=playstore');
  assert.equal(m.scope, '/');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
});

test('pages légales publiques : contact et suppression de compte', async () => {
  for (const [url, motif] of [['/confidentialite', /Politique de confidentialité/], ['/conditions', /Conditions d'utilisation/], ['/supprimer-mon-compte', /Supprimer mon espace/]]) {
    const r = await appeler(url);
    assert.equal(r.status, 200, url);
    assert.match(r.body, motif);
    assert.match(r.body, /contact@exemple\.bj/);
    assert.doesNotMatch(r.body, /<script/i);
  }
});

test('écran d\'entrée sans identifiant : formulaire ; script externe uniquement (compatible CSP)', async () => {
  const r = await appeler('/entrer?source=playstore');
  assert.equal(r.status, 200);
  assert.match(r.body, /name="espace"/);
  assert.match(r.body, /<script src="\/assets\/entrer\.js" defer>/);
  assert.doesNotMatch(r.body, /<script>[^<]/);
});

test('service worker de l\'écran d\'entrée limité à /entrer', async () => {
  const r = await appeler('/entrer-sw.js');
  assert.equal(r.headers['Service-Worker-Allowed'], '/entrer');
});
