// Simulateur d'hébergeur « Render Free » devant le vrai serveur Best-Quinca (port 3100) :
//  - dort      : le serveur est endormi ; la première requête déclenche le réveil, qui dure `reveilMs`
//                style 'html503' = page d'attente de l'hébergeur (503 HTML, sans en-têtes CORS) ; style 'hang' = connexion laissée en attente
//  - eveille   : transmet tout au vrai serveur
//  - coupe     : transmet POST /api/ventes au vrai serveur mais coupe la connexion avant de renvoyer la réponse (n fois)
const http = require('node:http');
const net = require('node:net');
const CIBLE = { host: '127.0.0.1', port: 3100 };
const etat = { mode: 'eveille', style: 'html503', reveilMs: 8000, reveilDebut: 0, coupe: 0 };
const journal = [];
const attentes = [];

function reveiller() {
  if (etat.reveilDebut) return;
  etat.reveilDebut = Date.now();
  setTimeout(() => { etat.mode = 'eveille'; etat.reveilDebut = 0; while (attentes.length) attentes.shift()(); }, etat.reveilMs);
}

function transmettre(req, res, { coupeReponse = false } = {}) {
  const p = http.request({ ...CIBLE, method: req.method, path: req.url, headers: req.headers }, (r) => {
    if (coupeReponse) { r.resume(); r.on('end', () => req.socket.destroy()); return; }
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  p.on('error', () => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('api injoignable'); });
  req.pipe(p);
}

const serveur = http.createServer((req, res) => {
  journal.push({ t: Date.now(), m: req.method, u: req.url, mode: etat.mode });
  if (etat.mode === 'dort') {
    reveiller();
    if (etat.style === 'hang') { attentes.push(() => transmettre(req, res)); return; }
    res.writeHead(503, { 'Content-Type': 'text/html' }); // comme l'hébergeur : pas d'en-têtes CORS
    return res.end('<html><body><h1>Service Waking Up</h1><p>Allocating compute resources…</p></body></html>');
  }
  if (etat.coupe > 0 && req.method === 'POST' && req.url === '/api/ventes') { etat.coupe -= 1; return transmettre(req, res, { coupeReponse: true }); }
  transmettre(req, res);
});
serveur.on('upgrade', (req, socket, head) => {
  journal.push({ t: Date.now(), m: 'UPGRADE', u: req.url, mode: etat.mode });
  if (etat.mode === 'dort') { reveiller(); return socket.destroy(); }
  const s = net.connect(CIBLE, () => {
    s.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head && head.length) s.write(head);
    socket.pipe(s); s.pipe(socket);
  });
  s.on('error', () => socket.destroy()); socket.on('error', () => s.destroy());
});
serveur.listen(3101, '127.0.0.1');

// Commandes de pilotage (port à part : jamais soumises au « sommeil »)
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/mode') {
    for (const [k, v] of u.searchParams) etat[k] = ['reveilMs', 'coupe'].includes(k) ? Number(v) : v;
    if (etat.mode === 'dort') etat.reveilDebut = 0;
    return res.end(JSON.stringify(etat));
  }
  if (u.pathname === '/journal') { const depuis = Number(u.searchParams.get('depuis') || 0); return res.end(JSON.stringify(journal.filter((j) => j.t >= depuis))); }
  if (u.pathname === '/reset') { journal.length = 0; return res.end('ok'); }
  res.statusCode = 404; res.end();
}).listen(3199, '127.0.0.1');
console.log('render-sim prêt');
