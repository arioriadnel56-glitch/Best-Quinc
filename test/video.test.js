'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/none';
const { handle } = require('../server/index');

const appeler = async (url, headers = {}) => {
  const morceaux = [];
  const res = { headers: {}, status: null, headersSent: false,
    setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h) { this.status = s; Object.assign(this.headers, h); this.headersSent = true; },
    write(c) { morceaux.push(Buffer.from(c)); return true; }, end(b) { if (b) morceaux.push(Buffer.from(b)); this.fini = true; this.emit && this.emit('finish'); },
    on() { return this; }, once() { return this; }, emit() {}, removeListener() {} };
  await handle({ url, method: 'GET', headers, socket: {} }, res);
  await new Promise((r) => setTimeout(r, 150));
  return { res, corps: Buffer.concat(morceaux) };
};
const VIDEO = path.join(__dirname, '..', 'public', 'assets', 'video', 'demo-fr.mp4');

test('page d\'accueil : section vidéo avec lecture à la demande (pas de téléchargement automatique)', async () => {
  const { res, corps } = await appeler('/');
  assert.equal(res.status, 200);
  const html = corps.toString();
  assert.match(html, /<video[^>]+controls[^>]+preload="none"/);
  assert.match(html, /poster="\/assets\/video\/demo-fr-poster\.jpg"/);
  assert.match(html, /src="\/assets\/video\/demo-fr\.mp4"/);
  assert.match(html, /href="#demo"/);
  assert.doesNotMatch(html, /autoplay/);
});

test('les fichiers vidéo et l\'affiche existent et sont de taille raisonnable pour le mobile', () => {
  for (const f of ['demo-fr.mp4', 'demo-fr-poster.jpg']) assert.ok(fs.existsSync(path.join(path.dirname(VIDEO), f)), f);
  assert.ok(fs.statSync(VIDEO).size < 6 * 1024 * 1024, 'la vidéo MP4 doit rester sous 6 Mo');
});

test('vidéo : lecture partielle (Range) pour iPhone/Safari et pour avancer dans la vidéo', async () => {
  const { res, corps } = await appeler('/assets/video/demo-fr.mp4', { range: 'bytes=0-99' });
  assert.equal(res.status, 206);
  assert.equal(corps.length, 100);
  assert.equal(res.headers['Accept-Ranges'], 'bytes');
  assert.match(res.headers['Content-Range'], /^bytes 0-99\/\d+$/);
  assert.equal(res.headers['Content-Type'], 'video/mp4');
  const fin = await appeler('/assets/video/demo-fr.mp4', { range: 'bytes=-10' });
  assert.equal(fin.res.status, 206);
  assert.equal(fin.corps.length, 10);
  const invalide = await appeler('/assets/video/demo-fr.mp4', { range: 'bytes=999999999-' });
  assert.equal(invalide.res.status, 416);
});
