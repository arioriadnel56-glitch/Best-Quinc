'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/none';
const { clientIp } = require('../server/lib/http');
const { motDePasseFaible } = require('../server/lib/password');
const { handle } = require('../server/index');

const faux = (url) => {
  const res = { headers: {}, status: null, body: '', headersSent: false,
    setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h) { this.status = s; Object.assign(this.headers, h); this.headersSent = true; }, end(b) { this.body = String(b || ''); } };
  return { req: { url, method: 'GET', headers: {}, socket: {} }, res };
};

test('adresse IP : on lit celle ajoutée par le proxy, pas celle écrite par le client', () => {
  const req = (xf) => ({ headers: { 'x-forwarded-for': xf }, socket: { remoteAddress: '10.0.0.1' } });
  assert.equal(clientIp(req('1.1.1.1, 203.0.113.9'), true, 1), '203.0.113.9');
  assert.equal(clientIp(req('6.6.6.6, 7.7.7.7, 203.0.113.9'), true, 1), '203.0.113.9');
  assert.equal(clientIp(req('203.0.113.9, 198.51.100.4'), true, 2), '203.0.113.9');
  assert.equal(clientIp(req('1.1.1.1'), false, 1), '10.0.0.1');
});

test('adresse IP : l\'en-tête du proxy frontal (Render/Cloudflare) prime et ne peut pas être falsifié par X-Forwarded-For', () => {
  const req = (h) => ({ headers: h, socket: { remoteAddress: '10.0.0.1' } });
  assert.equal(clientIp(req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 104.22.17.40' }), true, 2, 'cf-connecting-ip'), '198.51.100.7');
  assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 104.22.17.40' }), true, 2, 'cf-connecting-ip'), '198.51.100.7');
  assert.equal(clientIp(req({ 'cf-connecting-ip': 'pas une adresse' , 'x-forwarded-for': '198.51.100.7, 104.22.17.40' }), true, 2, 'cf-connecting-ip'), '198.51.100.7');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '198.51.100.7' }), false, 1, 'cf-connecting-ip'), '10.0.0.1');
});

test('mots de passe faibles refusés', () => {
  for (const m of ['password', '12345678', 'Azerty123', '11111111', 'motdepasse123', '123456789012'.slice(0, 10)]) assert.ok(motDePasseFaible(m), m);
  assert.ok(motDePasseFaible('koffizinsou2026', ['koffi@zinsou.bj']), 'contient l\'e-mail');
  assert.equal(motDePasseFaible('Brouette-Ciment-47!', ['koffi@zinsou.bj']), null);
});

test('une adresse piégée ne fait plus tomber le serveur (400, pas de plantage)', async () => {
  for (const url of ['//[', 'http://[::1', '/%zz', '/assets/%zz', '/api/ventes/%E0%A4%A']) {
    const { req, res } = faux(url);
    await handle(req, res);
    assert.ok([400, 401, 404].includes(res.status), `${url} -> ${res.status}`);
  }
});

test('en-têtes de sécurité : CSP stricte, pas de script en ligne, HSTS seulement en HTTPS', async () => {
  const { req, res } = faux('/');
  await handle(req, res);
  const csp = res.headers['Content-Security-Policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.doesNotMatch(csp.split(';').find((d) => d.trim().startsWith('script-src')), /unsafe-inline|unsafe-eval/);
  assert.ok(res.headers['Permissions-Policy']);
  assert.equal(res.headers['Strict-Transport-Security'], undefined);
  const https = faux('/'); https.req.headers['x-forwarded-proto'] = 'https'; https.req.socket = { encrypted: true };
  await handle(https.req, https.res);
  assert.match(https.res.headers['Strict-Transport-Security'], /max-age=31536000/);
});
