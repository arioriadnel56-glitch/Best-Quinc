'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { env, assertEnv } = require('./lib/env');
const { Router } = require('./lib/router');
const { HttpError, json, send, readJson, clientIp } = require('./lib/http');
const db = require('./lib/db');
const { migrate } = require('./migrate');
const { bootstrapFromEnv } = require('./lib/admins');
const realtime = require('./lib/realtime');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const MIME = { '.woff': 'font/woff',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.vtt': 'text/vtt; charset=utf-8',
};

const router = new Router();
['auth', 'abonnement', 'catalogue', 'sante', 'ventes', 'credits', 'bilans', 'inventaire', 'equipe', 'profil', 'sponsors', 'factures', 'pwa', 'playstore', 'admin'].forEach((n) => require(`./routes/${n}`)(router));

function serveAsset(req, res, pathname) {
  let rel;
  try { rel = path.normalize(decodeURIComponent(pathname.slice('/assets/'.length))); } catch { return notFoundPage(res); }
  const file = path.join(ASSETS, rel);
  if (!file.startsWith(ASSETS + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return notFoundPage(res);
  }
  const st = fs.statSync(file);
  const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const ext = path.extname(file);
  const media = ext === '.mp4' || ext === '.webm';
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // Polices et médias ne changent pas : on évite de les revalider à chaque page
    'Cache-Control': ext === '.woff' ? 'public, max-age=604800' : (media || ext === '.jpg') ? 'public, max-age=86400' : 'no-cache',
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  // Lecture partielle (en-tête Range) : indispensable pour la vidéo sur iPhone/Safari et pour avancer dans la vidéo
  const rg = req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim()) : null;
  if (rg && (rg[1] !== '' || rg[2] !== '')) {
    let debut; let fin;
    if (rg[1] === '') { debut = Math.max(0, st.size - Number(rg[2])); fin = st.size - 1; } // « les N derniers octets »
    else { debut = Number(rg[1]); fin = rg[2] === '' ? st.size - 1 : Math.min(Number(rg[2]), st.size - 1); }
    if (!(debut <= fin) || debut >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${debut}-${fin}/${st.size}`, 'Content-Length': fin - debut + 1 });
    const flux = fs.createReadStream(file, { start: debut, end: fin });
    flux.on('error', () => res.destroy());
    return flux.pipe(res);
  }
  if (st.size > 1024 * 1024) { // gros fichier : envoi en flux, sans le charger en mémoire
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    const flux = fs.createReadStream(file);
    flux.on('error', () => res.destroy());
    return flux.pipe(res);
  }
  return send(res, 200, fs.readFileSync(file), headers);
}

function notFoundPage(res, message = 'Page introuvable.') {
  const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Introuvable</title>
<body style="font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#EEF1F4;color:#1C2A33">
<main style="max-width:28rem;padding:2rem"><h1 style="margin:0 0 .5rem">${message}</h1><p>Vérifiez l'adresse, ou <a href="/">revenez à l'accueil de Best-Quinca</a>.</p></main></body></html>`;
  return send(res, 404, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

// Politique de sécurité du contenu : seuls nos propres scripts s'exécutent, plus les widgets de paiement KkiaPay et FedaPay.
// Aucun script ni gestionnaire en ligne n'est autorisé : une injection de code dans une page reste inopérante.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.kkiapay.me https://cdn.fedapay.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: https://*.kkiapay.me https://*.fedapay.com",
  "frame-src https://*.kkiapay.me https://*.fedapay.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function enHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (env.publicUrl.startsWith('https://')) return true;
  return env.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',').pop().trim() === 'https';
}

// CORS : seul le frontend déclaré (FRONTEND_ORIGIN) peut appeler l'API depuis un autre domaine.
// L'authentification passe par l'en-tête Authorization (jamais par cookie) : aucune requête n'est envoyée avec des identifiants ambiants.
function cors(req, res) {
  const origine = req.headers.origin;
  if (!origine || !env.frontendOrigins.length) return { demande: false, autorise: false };
  const autorise = env.frontendOrigins.includes(origine);
  res.setHeader('Vary', 'Origin');
  if (autorise) {
    res.setHeader('Access-Control-Allow-Origin', origine);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  return { demande: true, autorise };
}

async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), bluetooth=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (enHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Une adresse illisible ne doit jamais faire tomber le serveur
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return json(res, 400, { erreur: 'Adresse invalide.' }); }
  const pathname = url.pathname;
  const isApi = pathname.startsWith('/api/');
  const c = cors(req, res);
  if (req.method === 'OPTIONS') {
    // Pré-vérification du navigateur : réponse immédiate, sans toucher à la base
    res.writeHead(c.autorise ? 204 : 403, { 'Content-Length': '0' });
    return res.end();
  }

  try {
    if (req.method === 'GET' && pathname.startsWith('/assets/')) return serveAsset(req, res, pathname);

    const { route, params, pathMatched } = router.match(req.method === 'HEAD' ? 'GET' : req.method, pathname);
    if (!route) {
      if (pathMatched) return json(res, 405, { erreur: 'Méthode non autorisée.' });
      return isApi ? json(res, 404, { erreur: 'Ressource introuvable.' }) : notFoundPage(res);
    }

    const ctx = {
      req, res, params, pathname, status: 200, raw: null,
      query: Object.fromEntries(url.searchParams),
      body: {},
      ip: clientIp(req, env.trustProxy, env.trustedHops, env.trustedIpHeader),
    };
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) ctx.body = await readJson(req);

    let result;
    for (const h of route.handlers) result = await h(ctx);

    if (ctx.raw) return send(res, ctx.raw.status, ctx.raw.body, ctx.raw.headers);
    return json(res, ctx.status, result === undefined ? { ok: true } : result);
  } catch (err) {
    if (err instanceof HttpError) {
      if (!isApi && err.status === 404) return notFoundPage(res, err.message);
      return json(res, err.status, { erreur: err.message, ...err.extra });
    }
    if (err && err.code === '23505') return json(res, 409, { erreur: 'Cette valeur existe déjà.' });
    if (err && err.code === '23503') return json(res, 409, { erreur: 'Cet élément est lié à d\'autres données.' });
    if (err && (err.code === '22P02' || err.code === '22003')) return json(res, 400, { erreur: 'Valeur invalide.' });
    const id = crypto.randomBytes(4).toString('hex');
    console.error(`[${id}] ${req.method} ${pathname}`, err);
    return json(res, 500, { erreur: `Erreur interne du serveur (réf. ${id}).` });
  }
}

async function main() {
  assertEnv();
  await migrate();
  await bootstrapFromEnv();
  const server = http.createServer((req, res) => {
    // Aucune erreur, même imprévue, ne doit arrêter le serveur
    handle(req, res).catch((err) => {
      console.error('Erreur non gérée :', err);
      if (!res.headersSent) { try { json(res, 500, { erreur: 'Erreur interne du serveur.' }); } catch { res.destroy(); } } else res.destroy();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 20000;
  server.maxHeadersCount = 100;
  if (!env.publicUrl) console.warn('Attention : PUBLIC_URL n\'est pas défini. Renseignez l\'adresse publique du site (https://…) : elle sert aux liens de factures et aux en-têtes de sécurité.');
  realtime.attach(server);
  server.listen(env.port, () => console.log(`Best-Quinca prêt sur http://localhost:${env.port}`));
  const stop = () => { realtime.arreter(); server.close(() => db.getPool().end().finally(() => process.exit(0))); };
  process.on('unhandledRejection', (err) => console.error('Promesse rejetée non gérée :', err));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { handle, router, CSP };

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
