'use strict';
// Garde-fous du design : fichiers référencés présents, couleurs lisibles, pas de CSS invalide qui ferait disparaître un fond
require('./helpers'); // base simulée : pwa.js charge la couche base de données
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8');
const css = lire('public/assets/style.css');

test('feuille de style : chaque fichier référencé existe (polices comprises)', () => {
  const urls = [...css.matchAll(/url\("?(\/assets\/[^")]+)"?\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 3, 'les trois polices sont déclarées');
  for (const u of urls) assert.ok(fs.existsSync(path.join(RACINE, 'public', u)), `fichier manquant : ${u}`);
});

test('feuille de style : pas de raccourci « background » invalide (couleur + dégradés multiples), qui rendrait le fond transparent', () => {
  assert.ok(!/background:\s*var\(--nuit\)\s+var\(--grille\)/.test(css));
  // une couleur de repli est toujours prévue pour le texte posé sur la couleur de la boutique
  assert.ok(!/var\(--sur-marque\)/.test(css), 'utiliser var(--sur-marque, #fff)');
});

test('feuille de style : le focus clavier est visible et le mouvement réduit respecté', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('hors connexion : tout ce que la page charge est mis en cache par le service worker', () => {
  const sw = lire('server/templates/sw.template.js');
  const shell = sw.match(/const SHELL = \[(.*?)\];/s)[1];
  const chemins = [...shell.matchAll(/'(\/assets\/[^']+)'/g)].map((m) => m[1]);
  for (const c of chemins) assert.ok(fs.existsSync(path.join(RACINE, 'public', c)), `fichier mis en cache introuvable : ${c}`);
  const html = lire('server/templates/app.html');
  for (const src of [...html.matchAll(/src="(\/assets\/[^"]+)"/g)].map((m) => m[1]).concat(['/assets/style.css'])) {
    assert.ok(chemins.includes(src), `${src} est chargé par la page mais absent du cache hors connexion`);
  }
  for (const police of ['carlito-regular', 'carlito-bold', 'heros-cn-bold']) assert.ok(chemins.some((c) => c.includes(police)), `police ${police} non mise en cache`);
});

test('gabarit de l\'application : tous les repères {{…}} sont remplacés par le serveur', () => {
  const html = lire('server/templates/app.html');
  const pwa = lire('server/routes/pwa.js');
  const reperes = new Set([...html.matchAll(/{{([A-Z_]+)}}/g)].map((m) => m[1]));
  assert.ok(reperes.has('SUR_COULEUR'));
  for (const r of reperes) assert.ok(pwa.includes(`'{{${r}}}'`), `{{${r}}} n'est pas remplacé`);
});

test('couleur du texte posé sur la couleur de la boutique : toujours lisible (contraste WCAG ≥ 4,5)', () => {
  const { couleurLisible } = require('../server/routes/pwa');
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contraste = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  for (const fond of ['#3E5C76', '#1F4E79', '#0F766E', '#8B1E3F', '#1D4ED8', '#000000', '#FFC21A', '#F5E000', '#FFFFFF', '#E4572E']) {
    const texte = couleurLisible(fond);
    assert.ok(['#FFFFFF', '#12202C'].includes(texte));
    if (fond !== '#E4572E') assert.ok(contraste(fond, texte) >= 4.5, `${fond} avec ${texte} : ${contraste(fond, texte).toFixed(2)}`);
  }
  assert.equal(couleurLisible('pas une couleur'), '#FFFFFF');
});

test('page d\'accueil : les éléments utilisés par landing.js existent', () => {
  const html = lire('server/templates/landing.html');
  const js = lire('public/assets/landing.js');
  for (const id of new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))) assert.match(html, new RegExp(`id="${id}"`), `#${id} absent`);
  assert.match(html, /src="\/assets\/icones\.js"/);
  for (const n of [...html.matchAll(/data-icone="([a-z]+)"/g)].map((m) => m[1])) assert.match(lire('public/assets/icones.js'), new RegExp(`\\b${n}:`), `icône ${n} inconnue`);
});

test('navigation : chaque entrée du menu a son icône', () => {
  const icones = lire('public/assets/icones.js');
  const app = lire('public/assets/app.js');
  const menu = app.match(/const MENU = \[([\s\S]*?)\];/)[1];
  for (const id of [...menu.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1])) assert.match(icones, new RegExp(`\\b${id}:`), `pas d'icône pour « ${id} »`);
});

test('polices embarquées : licences fournies', () => {
  const l = lire('public/assets/fonts/LICENCES.txt');
  assert.match(l, /Carlito/); assert.match(l, /Heros/);
});
