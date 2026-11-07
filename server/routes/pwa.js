'use strict';
const fs = require('node:fs');
const path = require('node:path');
const db = require('../lib/db');
const { HttpError } = require('../lib/http');
const { makeIcon } = require('../lib/icon');
const FAVICON = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'assets', 'marque', 'favicon-64.png'));

const TPL = path.join(__dirname, '..', 'templates');
const VERSION = require('../../package.json').version;
const read = (f) => fs.readFileSync(path.join(TPL, f), 'utf8');
const appHtml = read('app.html');
const swTemplate = read('sw.template.js');
const landingHtml = read('landing.html');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadEspace(slug) {
  const { rows } = await db.query(
    `SELECT e.slug, e.nom, p.nom_app, p.couleur
       FROM entreprises e JOIN pwa_configs p ON p.entreprise_id = e.id
      WHERE e.slug = $1 AND e.statut = 'actif'`,
    [slug.toLowerCase()],
  );
  if (!rows.length) throw new HttpError(404, 'Espace introuvable.');
  return rows[0];
}

// Texte blanc ou encre selon la luminosité de la couleur choisie (contraste WCAG) : une marque jaune ne doit pas porter du blanc
function couleurLisible(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return '#FFFFFF';
  const lin = (i) => { const c = parseInt(m[1].slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.0634) ? '#FFFFFF' : '#12202C';
}

module.exports = function register(router) {
  router.get('/', async (ctx) => {
    ctx.raw = { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, body: landingHtml };
  });

  router.get('/favicon.ico', async (ctx) => {
    ctx.raw = { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }, body: FAVICON };
  });

  // Page de l'application de l'entreprise (son propre espace, son propre manifeste)
  router.get('/app/:slug', async (ctx) => {
    if (!ctx.pathname.endsWith('/')) {
      ctx.raw = { status: 301, headers: { Location: ctx.pathname + '/' }, body: '' };
      return;
    }
    const e = await loadEspace(ctx.params.slug);
    const html = appHtml
      .replaceAll('{{SLUG}}', esc(e.slug))
      .replaceAll('{{NOM}}', esc(e.nom_app))
      .replaceAll('{{COULEUR}}', esc(e.couleur))
      .replaceAll('{{SUR_COULEUR}}', couleurLisible(e.couleur));
    ctx.raw = { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, body: html };
  });

  router.get('/app/:slug/manifest.webmanifest', async (ctx) => {
    const e = await loadEspace(ctx.params.slug);
    const root = `/app/${e.slug}/`;
    const manifest = {
      id: root,
      name: e.nom_app,
      short_name: e.nom_app.slice(0, 12),
      description: `Gestion de ${e.nom}`,
      lang: 'fr',
      start_url: root,
      scope: root,
      display: 'standalone',
      orientation: 'any',
      background_color: '#EEF1F4',
      theme_color: e.couleur,
      icons: [
        { src: `${root}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${root}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `${root}icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [{ name: 'Caisse', url: `${root}#/caisse`, icons: [{ src: `${root}icon-192.png`, sizes: '192x192', type: 'image/png' }] }],
    };
    ctx.raw = { status: 200, headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' }, body: JSON.stringify(manifest) };
  });

  router.get('/app/:slug/sw.js', async (ctx) => {
    const e = await loadEspace(ctx.params.slug);
    const js = swTemplate.replaceAll('{{SLUG}}', e.slug).replaceAll('{{VERSION}}', VERSION);
    ctx.raw = { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }, body: js };
  });

  const icon = (file, size, maskable) => router.get(`/app/:slug/${file}`, async (ctx) => {
    const e = await loadEspace(ctx.params.slug);
    const img = await db.query('SELECT icone FROM entreprise_images i JOIN entreprises e ON e.id = i.entreprise_id WHERE e.slug = $1', [e.slug]);
    const perso = img.rows[0] && Buffer.isBuffer(img.rows[0].icone) ? img.rows[0].icone : null;
    ctx.raw = {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' },
      body: perso || makeIcon(e.nom_app, e.couleur, size, maskable),
    };
  });
  icon('icon-192.png', 192, false);
  icon('icon-512.png', 512, false);
  icon('icon-maskable-512.png', 512, true);
};

module.exports.couleurLisible = couleurLisible;
