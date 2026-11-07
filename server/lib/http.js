'use strict';

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

function readJson(req, limit = 2.5 * 1024 * 1024) {
  // Si l'hébergeur a déjà consommé le flux (corps pré-analysé), on reprend son résultat plutôt que d'attendre un « end » qui ne viendra plus.
  // On ne touche à req.body que dans ce cas : sur Vercel, y accéder lit le flux.
  if (req.readableEnded) {
    const b = req.body;
    if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return Promise.resolve(b);
    if (typeof b === 'string' || Buffer.isBuffer(b)) {
      try { const v = JSON.parse(String(b)); return Promise.resolve(v && typeof v === 'object' ? v : {}); } catch { return Promise.reject(new HttpError(400, 'Corps de requête JSON invalide.')); }
    }
    return Promise.resolve({});
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Requête trop volumineuse.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'Corps de requête JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

// Derrière un proxy, chaque proxy de confiance AJOUTE l'adresse qu'il a vue à la fin de X-Forwarded-For.
// Les entrées de gauche sont écrites par le client (donc falsifiables) : on prend celle que le proxy a ajoutée,
// en comptant `sauts` proxys de confiance depuis la droite.
function clientIp(req, trustProxy, sauts = 1, entete = '') {
  if (trustProxy) {
    // En-tête posé par le proxy frontal lui-même (ex. Render/Cloudflare : cf-connecting-ip) : le client ne peut pas le falsifier
    if (entete) {
      const v = String(req.headers[entete] || '').split(',')[0].trim();
      if (/^[0-9a-fA-F:.]{3,45}$/.test(v)) return v;
    }
    const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xf.length) return xf[Math.max(0, xf.length - Math.max(1, sauts))];
  }
  return (req.socket && req.socket.remoteAddress) || 'inconnu';
}

// --- Validation ---
function str(v, name, { min = 1, max = 255, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw new HttpError(400, `Le champ « ${name} » est obligatoire.`);
  }
  if (typeof v !== 'string') throw new HttpError(400, `Le champ « ${name} » est invalide.`);
  const s = v.trim();
  if (s.length < min) throw new HttpError(400, `Le champ « ${name} » est trop court.`);
  if (s.length > max) throw new HttpError(400, `Le champ « ${name} » est trop long (${max} caractères maximum).`);
  return s;
}

function int(v, name, { min = 0, max = 2000000000, optional = false, def } = {}) {
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    if (optional) return null;
    throw new HttpError(400, `Le champ « ${name} » est obligatoire.`);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `Le champ « ${name} » doit être un nombre entier.`);
  if (n < min || n > max) throw new HttpError(400, `Le champ « ${name} » doit être compris entre ${min} et ${max}.`);
  return n;
}

function email(v, name = 'e-mail') {
  const s = str(v, name, { max: 150 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, 'Adresse e-mail invalide.');
  return s;
}

function slugify(text) {
  return String(text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

module.exports = { HttpError, json, send, readJson, clientIp, str, int, email, slugify };
