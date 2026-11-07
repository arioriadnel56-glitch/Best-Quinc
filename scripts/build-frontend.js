'use strict';
// Construit le frontend statique de Best-Quinca dans dist/ : landing, application (une coque unique pour toutes les quincailleries),
// pages légales, administration, rapport partenaire. Aucune de ces pages ne dépend du backend : elles s'ouvrent même s'il dort.
//
//   API_URL=https://best-quinca.onrender.com npm run build:frontend
//
// À héberger sur un service statique gratuit (Cloudflare Pages, Netlify…). Sur Cloudflare Pages :
//   Build command : npm run build:frontend     Build output directory : dist
//   Variables (build ET exécution) : API_URL
// Le dossier functions/ (proxy des liens de factures) est détecté automatiquement par Cloudflare Pages.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RACINE = path.join(__dirname, '..');
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8');

function normaliserApi(brut) {
  const api = String(brut || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/i.test(api)) throw new Error('API_URL est obligatoire : adresse du backend, sans chemin (ex. https://best-quinca.onrender.com).');
  return api;
}

function ecrire(sortie, relatif, contenu) {
  const cible = path.join(sortie, relatif);
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  fs.writeFileSync(cible, contenu);
}

// Empreinte de tout ce que le navigateur met en cache : un fichier modifié => nouvelle version du service worker => mise à jour des appareils
function empreinte() {
  const h = crypto.createHash('sha256');
  const parcourir = (dossier) => {
    for (const nom of fs.readdirSync(dossier).sort()) {
      const p = path.join(dossier, nom);
      if (fs.statSync(p).isDirectory()) { if (nom !== 'video') parcourir(p); } else { h.update(nom); h.update(fs.readFileSync(p)); }
    }
  };
  parcourir(path.join(RACINE, 'public', 'assets'));
  for (const t of ['app.html', 'sw.template.js']) h.update(lire(`server/templates/${t}`));
  return h.digest('hex').slice(0, 8);
}

// Rend une page du serveur sans base de données ni réseau (pages qui ne dépendent d'aucune donnée de l'entreprise)
async function rendrePage(router, pathname) {
  const { route, params } = router.match('GET', pathname);
  if (!route) throw new Error(`Route introuvable : ${pathname}`);
  const ctx = { req: { headers: { host: 'localhost' }, socket: {} }, params, pathname, status: 200, raw: null, query: {}, body: {}, ip: '127.0.0.1' };
  for (const h of route.handlers) await h(ctx);
  if (!ctx.raw || ctx.raw.status !== 200) throw new Error(`${pathname} : réponse inattendue`);
  return ctx.raw.body;
}

const fcfa = (n) => new Intl.NumberFormat('fr-FR').format(n) + ' F CFA';

async function construire({ apiUrl, sortie }) {
  const api = normaliserApi(apiUrl);
  const dist = path.resolve(sortie || path.join(RACINE, 'dist'));
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  // Les pages du serveur lisent les tarifs en base : à la construction il n'y a pas de base, elles prennent les valeurs des variables d'environnement
  const db = require('../server/lib/db');
  db.query = async () => { throw new Error('Pas de base de données à la construction'); };
  // Les pages du serveur signalent « lecture des paramètres impossible » faute de base : attendu ici, on n'affiche pas ce faux message d'erreur
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  const { env } = require('../server/lib/env');
  const { router, CSP } = require('../server/index.js');
  const version = `${require('../package.json').version}-${empreinte()}`;

  // ---- Fichiers de l'interface ----
  fs.cpSync(path.join(RACINE, 'public', 'assets'), path.join(dist, 'assets'), { recursive: true });
  ecrire(dist, 'assets/config.js', `// Généré par scripts/build-frontend.js\nwindow.BQ_CONFIG = ${JSON.stringify({ api, prixStatiques: true })};\n`);

  // ---- Landing : tarifs écrits dans la page (aucun visiteur ne réveille le serveur pour les lire) ----
  let landing = String(await rendrePage(router, '/'));
  const offerts = Math.floor((env.price * (env.daysAnnual / env.days) - env.priceAnnual) / env.price);
  const remplacer = (html, motif, valeur) => { if (!motif.test(html)) throw new Error(`Landing : élément introuvable ${motif}`); return html.replace(motif, valeur); };
  landing = remplacer(landing, /(<strong id="prix">)[^<]*(<\/strong>)/, `$1${fcfa(env.price)}$2`);
  landing = remplacer(landing, /(<span id="periode">)[^<]*(<\/span>)/, `$1${env.days === 30 ? 'par mois' : `pour ${env.days} jours`}$2`);
  landing = remplacer(landing, /(<span id="annuel">)[^<]*(<\/span>)/, `$1Ou ${fcfa(env.priceAnnual)} par an${offerts > 0 ? ` : ${offerts} mois offerts` : ''}.$2`);
  ecrire(dist, 'index.html', landing);

  // ---- Pages produites sans données d'entreprise ----
  const pages = [
    ['/admin', 'admin.html'],
    [`/sponsor/${'0'.repeat(48)}`, 'sponsor/index.html'],
    ['/entrer', 'entrer.html'],
    ['/entrer-sw.js', 'entrer-sw.js'],
    ['/manifest-plateforme.webmanifest', 'manifest-plateforme.webmanifest'],
    ['/.well-known/assetlinks.json', '.well-known/assetlinks.json'],
    ['/confidentialite', 'confidentialite.html'],
    ['/conditions', 'conditions.html'],
    ['/supprimer-mon-compte', 'supprimer-mon-compte.html'],
    ['/favicon.ico', 'favicon.ico'],
  ];
  for (const [chemin, fichier] of pages) ecrire(dist, fichier, await rendrePage(router, chemin));

  // ---- Application : UNE coque pour toutes les quincailleries (l'espace est lu dans l'adresse /app/<espace>/) ----
  const coque = lire('server/templates/app.html')
    .replaceAll('{{SLUG}}', '').replaceAll('{{NOM}}', 'Best-Quinca').replaceAll('{{COULEUR}}', '#12202C').replaceAll('{{SUR_COULEUR}}', '#FFFFFF');
  ecrire(dist, '_app/index.html', coque);
  ecrire(dist, '_app/sw.js', lire('server/templates/sw.template.js').replaceAll('{{SLUG}}', '*').replaceAll('{{VERSION}}', version));
  // Adresses relatives : chaque espace (/app/<espace>/) obtient son propre périmètre d'installation avec le même fichier
  ecrire(dist, '_app/manifest.webmanifest', JSON.stringify({
    name: 'Best-Quinca', short_name: 'Best-Quinca', description: 'Caisse, stock et ventes de votre quincaillerie', lang: 'fr',
    start_url: './', scope: './', display: 'standalone', orientation: 'any', background_color: '#EEF1F4', theme_color: '#12202C',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [{ name: 'Caisse', url: './#/caisse', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] }],
  }));

  ecrire(dist, '404.html', `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page introuvable — Best-Quinca</title><link rel="stylesheet" href="/assets/style.css"></head><body><main class="centre"><section class="carte"><h1>Page introuvable</h1><p>Cette adresse n'existe pas.</p><a class="btn primaire" href="/">Retour à l'accueil</a></section></main></body></html>`);

  // ---- Réécritures (Cloudflare Pages / Netlify : « _redirects ») ----
  ecrire(dist, '_redirects', [
    '# Chaque espace /app/<espace>/ reçoit la même coque : le serveur n\'est pas sollicité pour afficher l\'application',
    '/app/:slug/manifest.webmanifest /_app/manifest.webmanifest 200',
    '/app/:slug/sw.js /_app/sw.js 200',
    '/app/:slug/icon-192.png /assets/marque/icone-192.png 200',
    '/app/:slug/icon-512.png /assets/marque/icone-512.png 200',
    '/app/:slug/icon-maskable-512.png /assets/marque/icone-maskable-512.png 200',
    '/app/:slug/ /_app/index.html 200',
    '/app/:slug /app/:slug/ 301',
    '/sponsor/* /sponsor/index.html 200',
    '',
  ].join('\n'));

  // ---- En-têtes de sécurité : mêmes protections que le serveur, avec l'adresse du backend autorisée pour les appels API ----
  const csp = CSP.replace("connect-src 'self'", `connect-src 'self' ${api}`);
  ecrire(dist, '_headers', [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: same-origin',
    '  X-Frame-Options: SAMEORIGIN',
    `  Content-Security-Policy: ${csp}`,
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), bluetooth=()',
    '  Cross-Origin-Opener-Policy: same-origin-allow-popups',
    '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
    '/_app/sw.js',
    '  Cache-Control: no-cache',
    '/app/:slug/sw.js',
    '  Cache-Control: no-cache',
    '/admin',
    '  Cache-Control: no-store',
    '  X-Robots-Tag: noindex, nofollow',
    '/sponsor/*',
    '  Cache-Control: no-store',
    '  Referrer-Policy: no-referrer',
    '  X-Robots-Tag: noindex, nofollow',
    '',
  ].join('\n'));

  console.warn = warn;
  console.error = error;
  return { dist, version, api };
}

module.exports = { construire, normaliserApi };

if (require.main === module) {
  construire({ apiUrl: process.env.API_URL, sortie: process.env.SORTIE })
    .then(({ dist, version, api }) => console.log(`Frontend construit dans ${dist} (version ${version}, API : ${api}). Tarifs lus dans les variables d'environnement.`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
