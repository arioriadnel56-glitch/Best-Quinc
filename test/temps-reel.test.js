'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const { setHandler, calls } = require('./helpers');
const { handle } = require('../server');
const realtime = require('../server/lib/realtime');
const { trame } = require('../server/lib/ws');
const jwt = require('../server/lib/jwt');

const SECRET = process.env.JWT_SECRET;
const jeton = (sub, typ = 'user') => jwt.sign({ sub, typ }, SECRET);
const tokUser = jeton(3);
const tokAutre = jeton(4);
const tokAdmin = jeton(1, 'admin');

// Utilisateur 3 : entreprise 9 ; utilisateur 4 : entreprise 12 ; admin 1
function base() {
  setHandler(async (sql, params) => {
    if (sql.includes('u.mdp_temporaire')) {
      const id = params[0];
      return { rows: [{ id, entreprise_id: id === 3 ? 9 : 12, nom_complet: 'U', email: 'u@a.fr', role: 'proprietaire', actif: true, entreprise_statut: 'actif' }] };
    }
    if (sql.includes('FROM admins_plateforme WHERE id')) return { rows: [{ id: 1, nom_complet: 'A', email: 'a@a.fr', actif: true }] };
    if (sql.includes('FROM abonnements')) return { rows: [{ id: 1, date_fin: '2099-01-01' }] };
    return { rows: [] };
  });
}

let serveur; let base_url;
const prises = new Set(); // sockets TCP ouvertes (closeAllConnections ne voit pas celles passées en WebSocket)
test.before(async () => {
  serveur = http.createServer((req, res) => { handle(req, res); });
  realtime.attach(serveur);
  serveur.on('connection', (sock) => { prises.add(sock); sock.on('close', () => prises.delete(sock)); });
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  base_url = `ws://127.0.0.1:${serveur.address().port}/ws`;
});
test.after(async () => { realtime.arreter(); serveur.closeAllConnections(); await new Promise((r) => serveur.close(r)); });
test.beforeEach(() => { calls.length = 0; base(); });

// Client WebSocket de Node (le même protocole que le navigateur)
function client() {
  const ws = new WebSocket(base_url);
  const recus = []; const attente = [];
  const etat = { fermeture: null };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); recus.push(m); attente.splice(0).forEach((f) => f()); };
  ws.onclose = (e) => { etat.fermeture = e.code; attente.splice(0).forEach((f) => f()); };
  const attendre = (cond, ms = 2000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('délai dépassé')), ms);
    const verif = () => { if (cond()) { clearTimeout(t); resolve(); } else attente.push(verif); };
    verif();
  });
  const ouvert = new Promise((r) => { ws.onopen = r; });
  return { ws, recus, etat, attendre, ouvert };
}
async function connecte(tok) {
  const c = client();
  await c.ouvert;
  c.ws.send(JSON.stringify({ type: 'auth', token: tok }));
  await c.attendre(() => c.recus.some((m) => m.type === 'pret'));
  return c;
}

test('un appareil authentifié reçoit les événements de son entreprise, pas ceux des autres', async () => {
  const a = await connecte(tokUser);
  const b = await connecte(tokAutre);
  realtime.publier(9, 'vente.creee', { numero: 5, total: 12000, par: 99 });
  await a.attendre(() => a.recus.some((m) => m.type === 'vente.creee'));
  const ev = a.recus.find((m) => m.type === 'vente.creee');
  assert.equal(ev.numero, 5);
  assert.equal(ev.total, 12000);
  assert.ok(ev.le > 0);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!b.recus.some((m) => m.type === 'vente.creee'), 'l\'autre entreprise ne voit rien');
  a.ws.close(); b.ws.close();
});

test('jeton invalide ou d\'un autre type : fermeture 4001, aucun événement', async () => {
  for (const mauvais of ['pas.un.jeton', '', jwt.sign({ sub: 3, typ: 'user' }, 'autre-secret-autre-secret-autre-secret-12')]) {
    const c = client(); await c.ouvert;
    c.ws.send(JSON.stringify({ type: 'auth', token: mauvais }));
    await c.attendre(() => c.etat.fermeture !== null);
    assert.equal(c.etat.fermeture, 4001);
  }
});

test('compte désactivé : refusé', async () => {
  setHandler(async (sql) => (sql.includes('u.mdp_temporaire') ? { rows: [{ id: 3, entreprise_id: 9, actif: false, entreprise_statut: 'actif' }] } : { rows: [] }));
  const c = client(); await c.ouvert;
  c.ws.send(JSON.stringify({ type: 'auth', token: tokUser }));
  await c.attendre(() => c.etat.fermeture !== null);
  assert.equal(c.etat.fermeture, 4001);
});

test('premier message autre que « auth » : fermeture', async () => {
  const c = client(); await c.ouvert;
  c.ws.send(JSON.stringify({ type: 'vente.creee' }));
  await c.attendre(() => c.etat.fermeture !== null);
  assert.equal(c.etat.fermeture, 4003);
});

test('les super admins reçoivent les événements de plateforme, pas les entreprises', async () => {
  const adm = await connecte(tokAdmin);
  const ent = await connecte(tokUser);
  realtime.publierAdmins('paiement.reussi', { entreprise_id: 9, montant: 3000 });
  await adm.attendre(() => adm.recus.some((m) => m.type === 'paiement.reussi'));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!ent.recus.some((m) => m.type === 'paiement.reussi'));
  adm.ws.close(); ent.ws.close();
});

test('fermerUtilisateur / fermerEntreprise coupent les appareils concernés', async () => {
  const u = await connecte(tokUser);
  realtime.fermerUtilisateur(3);
  await u.attendre(() => u.etat.fermeture !== null);
  assert.equal(u.etat.fermeture, 4001);
  const e = await connecte(tokAutre);
  realtime.fermerEntreprise(12);
  await e.attendre(() => e.etat.fermeture !== null);
  assert.equal(e.etat.fermeture, 4001);
});

test('ping applicatif : pong', async () => {
  const c = client(); await c.ouvert;
  c.ws.send('{"type":"ping"}');
  await c.attendre(() => c.recus.some((m) => m.type === 'pong'));
  c.ws.close();
});

// ---- Protocole bas niveau (client malveillant ou défaillant) ----
function brut(extra = {}) {
  return new Promise((resolve, reject) => {
    const port = serveur.address().port;
    const s = net.connect(port, '127.0.0.1');
    const cle = crypto.randomBytes(16).toString('base64');
    const entetes = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': cle, 'Sec-WebSocket-Version': '13', ...extra };
    s.write(`GET /ws HTTP/1.1\r\n${Object.entries(entetes).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    let tampon = Buffer.alloc(0);
    s.on('data', (c) => { tampon = Buffer.concat([tampon, c]); });
    s.on('error', reject);
    setTimeout(() => resolve({ s, cle, lire: () => tampon, texte: () => tampon.toString('latin1') }), 150);
  });
}
const masquee = (opcode, charge, fin = true) => {
  const m = crypto.randomBytes(4);
  const p = Buffer.from(charge).map((o, i) => o ^ m[i & 3]);
  const tete = p.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | p.length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([tete, m, p]);
};
// code de fermeture contenu dans la première trame « close » reçue après l'en-tête HTTP
const codeFermeture = (buf) => {
  const i = buf.indexOf('\r\n\r\n') + 4;
  return buf[i] === 0x88 ? buf.readUInt16BE(i + 2) : null;
};

test('poignée de main : accept calculé selon la RFC 6455', async () => {
  const c = await brut({ 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' });
  assert.match(c.texte(), /^HTTP\/1\.1 101/);
  assert.match(c.texte(), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  c.s.destroy();
});

test('origine étrangère refusée (403) ; version ou clé invalides refusées (400)', async () => {
  let c = await brut({ Origin: 'https://site-pirate.example' });
  assert.match(c.texte(), /^HTTP\/1\.1 403/); c.s.destroy();
  c = await brut({ 'Sec-WebSocket-Version': '8' });
  assert.match(c.texte(), /^HTTP\/1\.1 400/); c.s.destroy();
  c = await brut({ 'Sec-WebSocket-Key': 'trop-court' });
  assert.match(c.texte(), /^HTTP\/1\.1 400/); c.s.destroy();
});

test('trame non masquée -> 1002 ; binaire -> 1003 ; message trop gros -> 1009', async () => {
  let c = await brut();
  c.s.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); // texte non masqué
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(codeFermeture(c.lire()), 1002); c.s.destroy();

  c = await brut();
  c.s.write(masquee(0x2, [1, 2, 3]));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(codeFermeture(c.lire()), 1003); c.s.destroy();

  c = await brut();
  c.s.write(masquee(0x1, Buffer.alloc(20000, 97)).subarray(0, 8)); // annonce 20 000 octets
  c.s.write(Buffer.from([0x81, 0x80 | 126, 0x4e, 0x20]));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(codeFermeture(c.lire()), 1009); c.s.destroy();
});

test('message fragmenté (texte + continuation) bien assemblé', async () => {
  const c = await brut();
  c.s.write(masquee(0x1, '{"type":"pi', false));
  c.s.write(masquee(0x0, 'ng"}', true));
  await new Promise((r) => setTimeout(r, 150));
  const i = c.lire().indexOf('\r\n\r\n') + 4;
  assert.equal(c.lire()[i], 0x81);
  assert.match(c.lire().subarray(i + 2).toString(), /pong/);
  c.s.destroy();
});

test('ping du client -> pong du serveur avec la même charge', async () => {
  const c = await brut();
  c.s.write(masquee(0x9, 'salut'));
  await new Promise((r) => setTimeout(r, 120));
  const i = c.lire().indexOf('\r\n\r\n') + 4;
  assert.equal(c.lire()[i], 0x8a);
  assert.equal(c.lire().subarray(i + 2, i + 7).toString(), 'salut');
  c.s.destroy();
});

test('trame sortante : longueurs 7, 16 et 64 bits', () => {
  assert.equal(trame(1, Buffer.alloc(10)).length, 12);
  assert.equal(trame(1, Buffer.alloc(300)).length, 304);
  assert.equal(trame(1, Buffer.alloc(70000)).length, 70010);
});

test('une vente publie « vente.creee » aux autres appareils de l\'entreprise', async () => {
  const autre = await connecte(tokUser); // même entreprise (9)
  setHandler(async (sql, params) => {
    if (sql.includes('u.mdp_temporaire')) return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'S', email: 's@a.fr', role: 'secretaire', actif: true, entreprise_statut: 'actif' }] };
    if (sql.includes('FROM abonnements')) return { rows: [{ id: 1, date_fin: '2099-01-01' }] };
    if (sql.includes('FROM produits') && sql.includes('FOR UPDATE')) return { rows: [{ id: 1, nom: 'Ciment', prix_vente: 6500, quantite_stock: 10, actif: true }] };
    if (sql.includes('MAX(numero)')) return { rows: [{ n: 214 }] };
    if (sql.includes('INSERT INTO ventes')) return { rows: [{ id: 77, numero: 214, total: params[5], anomalie: null }] };
    return { rows: [] };
  });
  const port = serveur.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/ventes`, { method: 'POST', headers: { Authorization: `Bearer ${tokUser}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ lignes: [{ produit_id: 1, quantite: 2 }] }) });
  assert.equal(r.status, 201);
  await autre.attendre(() => autre.recus.some((m) => m.type === 'vente.creee'));
  const ev = autre.recus.find((m) => m.type === 'vente.creee');
  assert.equal(ev.numero, 214);
  assert.equal(ev.total, 13000);
  assert.equal(ev.par, 3);
  autre.ws.close();
});

test('publier / fermer sans personne de connecté ne lève rien', () => {
  realtime.publier(404, 'x'); realtime.publierAdmins('x'); realtime.fermerUtilisateur(404); realtime.fermerEntreprise(404);
});

// ---- Client navigateur (public/assets/temps-reel.js) exécuté avec le vrai WebSocket de Node ----
function chargerClient() {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const ecouteurs = {};
  const fenetre = {
    addEventListener: (n, f) => { (ecouteurs[n] = ecouteurs[n] || []).push(f); },
    removeEventListener: (n, f) => { ecouteurs[n] = (ecouteurs[n] || []).filter((x) => x !== f); },
  };
  const port = serveur.address().port;
  const ctx = vm.createContext({
    window: fenetre, WebSocket, setTimeout, clearTimeout, Math, JSON,
    location: { protocol: 'http:', host: `127.0.0.1:${port}` },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/../public/assets/temps-reel.js`, 'utf8'), ctx);
  return { BQWS: fenetre.BQWS, declencher: (n) => (ecouteurs[n] || []).forEach((f) => f()) };
}
const attends = (cond, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tic = () => (cond() ? resolve() : Date.now() - t0 > ms ? reject(new Error('délai dépassé')) : setTimeout(tic, 20));
  tic();
});

test('client : se connecte, reçoit les événements, signale son état et se ferme proprement', async () => {
  const { BQWS } = chargerClient();
  const evenements = []; const etats = [];
  const c = BQWS.connecter({ jeton: () => tokUser, surEvenement: (e) => evenements.push(e), surEtat: (o) => etats.push(o) });
  await attends(() => etats.includes(true));
  realtime.publier(9, 'stock.modifie', { produit_id: 1, par: 99 });
  await attends(() => evenements.some((e) => e.type === 'stock.modifie'));
  assert.ok(!evenements.some((e) => e.type === 'pret' || e.type === 'pong'), 'les messages techniques ne remontent pas à l\'écran');
  c.fermer();
  await attends(() => etats[etats.length - 1] === false);
});

test('client : session refusée (4001) -> pas de reconnexion en boucle ; nouveau jeton -> reconnexion', async () => {
  const { BQWS } = chargerClient();
  let courant = 'jeton-invalide'; const etats = [];
  const c = BQWS.connecter({ jeton: () => courant, surEvenement: () => {}, surEtat: (o) => etats.push(o) });
  await attends(() => etats.includes(false));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!etats.includes(true), 'aucune connexion établie avec un mauvais jeton');
  const avant = etats.length;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(etats.length, avant, 'pas de nouvelle tentative');
  c.fermer();

  // changement de mot de passe : l'appareil reçoit un jeton neuf pendant que l'ancien est refusé
  const cc = chargerClient();
  let jeton2 = tokUser; const etats2 = [];
  const c2 = cc.BQWS.connecter({ jeton: () => jeton2, surEvenement: () => {}, surEtat: (o) => etats2.push(o) });
  await attends(() => etats2.includes(true));
  jeton2 = tokUser + 'x'; // l'appareil a changé de jeton ; le serveur coupe l'ancienne session
  realtime.fermerUtilisateur(3);
  await attends(() => etats2.includes(false));
  jeton2 = jeton(3); // jeton valide neuf
  await attends(() => etats2.filter(Boolean).length >= 2, 4000);
  c2.fermer();
});

test('client : coupure réseau -> reconnexion automatique', async () => {
  const { BQWS } = chargerClient();
  const etats = [];
  const c = BQWS.connecter({ jeton: () => tokUser, surEvenement: () => {}, surEtat: (o) => etats.push(o) });
  await attends(() => etats.includes(true));
  // coupure brutale côté réseau (sans trame de fermeture, donc sans code 4001)
  for (const sock of [...prises]) sock.destroy();
  await attends(() => etats.includes(false));
  await attends(() => etats.filter(Boolean).length >= 2, 5000);
  c.fermer();
});
