'use strict';
// Temps réel : diffuse aux appareils connectés d'une entreprise (et aux super admins) ce qui vient de changer.
// Les événements ne contiennent que de quoi décider d'actualiser l'écran ; les données, elles, sont relues via l'API (donc authentifiées).
// Les connexions vivent dans ce processus : prévu pour UNE instance du serveur (Render, Railway...). Sur Vercel : désactivé.
const { env } = require('./env');
const jwt = require('./jwt');
const { auth, authAdmin } = require('./auth');
const { clientIp } = require('./http');
const { poigneeDeMain, refuser, Connexion } = require('./ws');

const MAX_TOTAL = 3000;
const MAX_PAR_IP = 40;
const MAX_PAR_COMPTE = 10;
const DELAI_AUTH_MS = 10000;
const INTERVALLE_MS = 10000;
const PING_TOUS_MS = 25000;
const SANS_NOUVELLE_MS = 75000;

const salons = new Map(); // « e:<id entreprise> » ou « admin » -> Set de sessions
const comptes = new Map(); // « u:<id> » ou « a:<id> » -> Set de sessions
const parIp = new Map();
const sessions = new Set();
let minuteur = null;

const ajouter = (map, cle, s) => { if (!map.has(cle)) map.set(cle, new Set()); map.get(cle).add(s); };
const retirer = (map, cle, s) => { const e = map.get(cle); if (e) { e.delete(s); if (!e.size) map.delete(cle); } };

function oubliable(s) {
  if (s.retiree) return;
  s.retiree = true;
  sessions.delete(s);
  if (s.salon) retirer(salons, s.salon, s);
  if (s.compte) retirer(comptes, s.compte, s);
  const n = (parIp.get(s.ip) || 1) - 1;
  if (n <= 0) parIp.delete(s.ip); else parIp.set(s.ip, n);
}

// Authentification par premier message (le navigateur ne peut pas envoyer d'en-tête Authorization, et une URL finit dans les journaux)
async function authentifier(s, message) {
  const jeton = String(message.token || '');
  const p = jwt.verify(jeton, env.jwtSecret);
  if (!p) return s.conn.fermer(4001, 'session invalide');
  const ctx = { req: { headers: { authorization: `Bearer ${jeton}` } } };
  try {
    if (p.typ === 'admin') {
      await authAdmin(ctx);
      s.salon = 'admin'; s.compte = `a:${ctx.admin.id}`;
    } else {
      await auth(ctx);
      s.salon = `e:${ctx.user.entreprise_id}`; s.compte = `u:${ctx.user.id}`;
    }
  } catch (e) {
    if (e && e.status) return s.conn.fermer(4001, 'session invalide');
    throw e;
  }
  if (s.conn.fermee) return;
  if ((comptes.get(s.compte) || new Set()).size >= MAX_PAR_COMPTE) return s.conn.fermer(4008, 'trop de connexions');
  s.exp = p.exp * 1000;
  s.authentifiee = true;
  ajouter(salons, s.salon, s);
  ajouter(comptes, s.compte, s);
  s.conn.envoyer(JSON.stringify({ type: 'pret' }));
}

function surMessage(s, texte) {
  s.messages += 1;
  if (s.messages > 30) return s.conn.fermer(1008, 'trop de messages');
  let m;
  try { m = JSON.parse(texte); } catch { return s.conn.fermer(1003, 'JSON attendu'); }
  if (!m || typeof m !== 'object') return s.conn.fermer(1003, 'JSON attendu');
  if (m.type === 'ping') return s.conn.envoyer('{"type":"pong"}');
  if (s.authentifiee) return undefined; // le client n'a rien d'autre à dire
  if (m.type !== 'auth' || s.authEnCours) return s.conn.fermer(4003, 'authentification attendue');
  s.authEnCours = true;
  return authentifier(s, m).catch((e) => {
    console.error('Temps réel : authentification impossible :', e.message);
    s.conn.fermer(1011, 'erreur serveur');
  });
}

// Même hôte que le site (ou PUBLIC_URL) ; sans en-tête Origin (outil, application native), on laisse passer : le jeton reste exigé
function origineValable(req) {
  const o = req.headers.origin;
  if (!o) return true;
  let h;
  try { h = new URL(o).host; } catch { return false; }
  const hotes = [req.headers.host];
  if (env.trustProxy && req.headers['x-forwarded-host']) hotes.push(String(req.headers['x-forwarded-host']).split(',')[0].trim());
  if (env.publicUrl) { try { hotes.push(new URL(env.publicUrl).host); } catch { /* ignoré */ } }
  for (const f of env.frontendOrigins) { try { hotes.push(new URL(f).host); } catch { /* ignoré */ } }
  return hotes.includes(h);
}

function surMiseAJour(req, socket, head) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws') return socket.destroy();
  if (!origineValable(req)) return refuser(socket, 403, 'Forbidden');
  const ip = clientIp(req, env.trustProxy, env.trustedHops, env.trustedIpHeader);
  if (sessions.size >= MAX_TOTAL || (parIp.get(ip) || 0) >= MAX_PAR_IP) return refuser(socket, 503, 'Service Unavailable');
  if (!poigneeDeMain(req, socket)) return undefined;

  const s = { ip, ne: Date.now(), vu: Date.now(), ping: Date.now(), messages: 0, authentifiee: false, authEnCours: false, retiree: false, salon: null, compte: null, exp: 0 };
  s.conn = new Connexion(socket, {
    surMessage: (t) => surMessage(s, t),
    surFermeture: () => oubliable(s),
    surPong: () => { s.vu = Date.now(); },
  });
  sessions.add(s);
  parIp.set(ip, (parIp.get(ip) || 0) + 1);
  if (head && head.length) s.conn.recevoir(head);
  return undefined;
}

function battement() {
  const maintenant = Date.now();
  for (const s of [...sessions]) {
    s.messages = 0;
    if (!s.authentifiee && maintenant - s.ne > DELAI_AUTH_MS) { s.conn.fermer(4003, 'authentification trop lente'); continue; }
    if (s.authentifiee && s.exp <= maintenant) { s.conn.fermer(4001, 'session expirée'); continue; }
    if (maintenant - s.vu > SANS_NOUVELLE_MS) { s.conn.detruire(); continue; }
    if (maintenant - s.ping >= PING_TOUS_MS) { s.ping = maintenant; s.conn.ping(); }
  }
}

// Branche le WebSocket sur le serveur HTTP (chemin /ws)
function attach(server) {
  if (!env.wsActif) return;
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    try { surMiseAJour(req, socket, head); } catch (e) { console.error('Temps réel :', e.message); socket.destroy(); }
  });
  if (!minuteur) { minuteur = setInterval(battement, INTERVALLE_MS); minuteur.unref(); }
}

function diffuser(salon, type, donnees) {
  const ensemble = salons.get(salon);
  if (!ensemble || !ensemble.size) return;
  const charge = Buffer.from(JSON.stringify({ type, ...donnees, le: Date.now() }));
  for (const s of ensemble) s.conn.envoyerBrut(charge);
}

// Ne lève jamais : un incident de diffusion ne doit pas faire échouer l'action de l'utilisateur
const sans = (fn) => (...a) => { try { fn(...a); } catch (e) { console.error('Temps réel :', e.message); } };

const publier = sans((entrepriseId, type, donnees = {}) => diffuser(`e:${entrepriseId}`, type, donnees));
const publierAdmins = sans((type, donnees = {}) => diffuser('admin', type, donnees));

function fermerEnsemble(ensemble, raison) {
  if (!ensemble) return;
  for (const s of [...ensemble]) s.conn.fermer(4001, raison);
}
const fermerUtilisateur = sans((id) => fermerEnsemble(comptes.get(`u:${id}`), 'session terminée'));
const fermerEntreprise = sans((id) => fermerEnsemble(salons.get(`e:${id}`), 'espace suspendu'));

function arreter() {
  if (minuteur) { clearInterval(minuteur); minuteur = null; }
  for (const s of [...sessions]) s.conn.fermer(1001, 'arrêt du serveur');
}

const stats = () => ({ connexions: sessions.size, salons: salons.size });

module.exports = { attach, publier, publierAdmins, fermerUtilisateur, fermerEntreprise, arreter, stats };
