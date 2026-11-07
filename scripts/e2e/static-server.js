// Émule un hébergeur statique (Cloudflare Pages) : fichiers de dist/, règles _redirects, en-têtes _headers ; AUCUN accès au backend
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = process.argv[2];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const regles = fs.readFileSync(path.join(DIST, '_redirects'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
const entetesGlobaux = {}; { let cur = null; for (const l of fs.readFileSync(path.join(DIST, '_headers'), 'utf8').split('\n')) { if (!l.trim()) continue; if (!l.startsWith(' ')) cur = l.trim(); else if (cur === '/*') { const i = l.indexOf(':'); entetesGlobaux[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } } }
const compte = { requetes: 0 };
function resoudre(p) {
  for (const [de, vers, statut] of regles) {
    const m = new RegExp(`^${de.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z]+/g, '([^/]+)').replace(/\*/g, '(.*)')}$`).exec(p);
    if (m) return { statut: Number(statut), cible: vers.replace(/:[a-z]+/g, () => m[1]) };
  }
  return null;
}
function fichier(p) {
  for (const c of [p, `${p}.html`, path.join(p, 'index.html')]) { const f = path.join(DIST, c); if (f.startsWith(DIST) && fs.existsSync(f) && fs.statSync(f).isFile()) return f; }
  return null;
}
http.createServer((req, res) => {
  compte.requetes += 1;
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__compte') return res.end(JSON.stringify(compte));
  const r = resoudre(p);
  if (r && r.statut === 301) { res.writeHead(301, { Location: r.cible }); return res.end(); }
  const f = fichier(r ? r.cible : p);
  if (!f) { res.writeHead(404, { ...entetesGlobaux, 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(DIST, '404.html'))); }
  const ext = path.extname(f);
  res.writeHead(200, { ...entetesGlobaux, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(3102, '127.0.0.1');
console.log('statique prêt');
