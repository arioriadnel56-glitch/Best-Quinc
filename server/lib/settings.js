'use strict';
// Paramètres de la plateforme modifiables depuis l'espace super admin.
// Les clés secrètes sont chiffrées (AES-256-GCM) avant d'être écrites en base,
// la clé de chiffrement est dérivée de JWT_SECRET. Elles ne sont jamais renvoyées au navigateur.
const crypto = require('node:crypto');
const db = require('./db');
const { env } = require('./env');
const { HttpError } = require('./http');

const TTL_MS = 15000;

const DEFS = {
  kkiapay_public_key: { type: 'texte', secret: false, label: 'clé publique KkiaPay' },
  kkiapay_private_key: { type: 'texte', secret: true, label: 'clé privée KkiaPay' },
  kkiapay_secret: { type: 'texte', secret: true, label: 'clé secrète KkiaPay' },
  kkiapay_sandbox: { type: 'bool', label: 'mode test KkiaPay' },
  fedapay_public_key: { type: 'texte', secret: false, label: 'clé publique FedaPay' },
  fedapay_secret_key: { type: 'texte', secret: true, label: 'clé secrète FedaPay' },
  fedapay_webhook_secret: { type: 'texte', secret: true, label: 'secret du webhook FedaPay' },
  fedapay_sandbox: { type: 'bool', label: 'mode test FedaPay' },
  abonnement_prix: { type: 'entier', min: 100, max: 10000000, defaut: 5000, label: "prix de l'abonnement mensuel" },
  abonnement_jours: { type: 'entier', min: 1, max: 366, defaut: 30, label: "durée de l'abonnement mensuel (jours)" },
  abonnement_prix_annuel: { type: 'entier', min: 100, max: 100000000, defaut: 50000, label: "prix de l'abonnement annuel" },
  abonnement_jours_annuel: { type: 'entier', min: 1, max: 732, defaut: 365, label: "durée de l'abonnement annuel (jours)" },
  essai_jours: { type: 'entier', min: 0, max: 90, defaut: 0, label: "jours d'essai gratuit" },
};

const envFallback = () => ({
  kkiapay_public_key: env.kkiapay.publicKey,
  kkiapay_private_key: env.kkiapay.privateKey,
  kkiapay_secret: env.kkiapay.secret,
  kkiapay_sandbox: String(env.kkiapay.sandbox),
  fedapay_public_key: env.fedapay.publicKey,
  fedapay_secret_key: env.fedapay.secretKey,
  fedapay_webhook_secret: env.fedapay.webhookSecret,
  fedapay_sandbox: String(env.fedapay.sandbox),
  abonnement_prix: String(env.price),
  abonnement_jours: String(env.days),
  abonnement_prix_annuel: String(env.priceAnnual),
  abonnement_jours_annuel: String(env.daysAnnual),
  essai_jours: String(env.trialDays),
});

// ---------- Chiffrement ----------
let keyCache = null;
function cle() {
  if (!keyCache || keyCache.src !== env.jwtSecret) {
    keyCache = { src: env.jwtSecret, k: Buffer.from(crypto.hkdfSync('sha256', env.jwtSecret, Buffer.alloc(0), 'bestquinca-parametres-v1', 32)) };
  }
  return keyCache.k;
}

function encrypt(texte) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cle(), iv);
  const ct = Buffer.concat([c.update(String(texte), 'utf8'), c.final()]);
  return ['enc1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

// Renvoie null si le contenu est illisible (ex. JWT_SECRET changé depuis l'enregistrement)
function decrypt(stocke) {
  const p = String(stocke).split(':');
  if (p.length !== 4 || p[0] !== 'enc1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', cle(), Buffer.from(p[1], 'base64'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------- Lecture ----------
let cache = null;

async function lignes() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const map = new Map();
  try {
    const { rows } = await db.query('SELECT cle, valeur FROM plateforme_parametres');
    for (const r of rows || []) {
      if (r && typeof r.cle === 'string' && typeof r.valeur === 'string' && DEFS[r.cle]) map.set(r.cle, r.valeur);
    }
  } catch (e) {
    console.error('Lecture des paramètres impossible :', e.message);
    if (cache) return cache.map;
  }
  cache = { at: Date.now(), map };
  return map;
}

function resoudre(map, k) {
  const def = DEFS[k];
  if (map.has(k)) {
    const v = def.secret ? decrypt(map.get(k)) : map.get(k);
    if (v !== null && v !== '') return { valeur: v, source: 'admin' };
    if (v === null) console.error(`Paramètre « ${k} » illisible (JWT_SECRET modifié ?). Saisissez-le à nouveau.`);
  }
  const e = envFallback()[k];
  if (e !== undefined && e !== null && e !== '') return { valeur: String(e), source: 'env' };
  return { valeur: null, source: null };
}

// Configuration résolue, utilisée par le reste du serveur
async function snapshot() {
  const m = await lignes();
  const g = (k) => resoudre(m, k).valeur;
  const entier = (k) => { const n = parseInt(g(k), 10); return Number.isFinite(n) ? n : DEFS[k].defaut; };
  return {
    kkiapay: {
      publicKey: g('kkiapay_public_key') || '',
      privateKey: g('kkiapay_private_key') || '',
      secret: g('kkiapay_secret') || '',
      sandbox: g('kkiapay_sandbox') !== 'false',
    },
    fedapay: {
      publicKey: g('fedapay_public_key') || '',
      secretKey: g('fedapay_secret_key') || '',
      webhookSecret: g('fedapay_webhook_secret') || '',
      sandbox: g('fedapay_sandbox') !== 'false',
    },
    prix: entier('abonnement_prix'),
    jours: entier('abonnement_jours'),
    prixAnnuel: entier('abonnement_prix_annuel'),
    joursAnnuel: entier('abonnement_jours_annuel'),
    // Formules proposées aux entreprises
    plans: {
      mensuel: { id: 'mensuel', label: 'Mensuel', prix: entier('abonnement_prix'), jours: entier('abonnement_jours') },
      annuel: { id: 'annuel', label: 'Annuel', prix: entier('abonnement_prix_annuel'), jours: entier('abonnement_jours_annuel') },
    },
    essaiJours: entier('essai_jours'),
  };
}

const masque = (v) => (v.length >= 8 ? '••••' + v.slice(-4) : '••••');

// Vue pour l'espace super admin : aucun secret en clair
async function describe() {
  const m = await lignes();
  const out = {};
  for (const [k, def] of Object.entries(DEFS)) {
    const r = resoudre(m, k);
    out[k] = def.secret
      ? { secret: true, definie: r.valeur !== null, source: r.source, apercu: r.valeur ? masque(r.valeur) : null }
      : { secret: false, definie: r.valeur !== null, source: r.source, valeur: r.valeur !== null ? r.valeur : (def.defaut !== undefined ? String(def.defaut) : '') };
  }
  return out;
}

// ---------- Écriture ----------
function normaliser(k, v) {
  const def = DEFS[k];
  if (!def) throw new HttpError(400, `Paramètre inconnu : ${k}.`);
  if (def.type === 'bool') {
    if (v === true || v === 'true') return 'true';
    if (v === false || v === 'false') return 'false';
    throw new HttpError(400, `Valeur invalide pour « ${def.label} ».`);
  }
  if (def.type === 'entier') {
    const n = typeof v === 'number' ? v : Number(v);
    if (v === '' || v === null || !Number.isInteger(n) || n < def.min || n > def.max) {
      throw new HttpError(400, `« ${def.label} » doit être un nombre entier entre ${def.min} et ${def.max}.`);
    }
    return String(n);
  }
  if (typeof v !== 'string') throw new HttpError(400, `Valeur invalide pour « ${def.label} ».`);
  const s = v.trim();
  if (s.length < 6 || s.length > 300 || /\s/.test(s)) {
    throw new HttpError(400, `La ${def.label} semble invalide (6 à 300 caractères, sans espace). Recopiez-la telle qu'affichée par le fournisseur.`);
  }
  return s;
}

async function save(valeurs, effacer) {
  await db.tx(async (q) => {
    for (const [k, v] of Object.entries(valeurs)) {
      await q(
        `INSERT INTO plateforme_parametres (cle, valeur) VALUES ($1, $2)
         ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur, modifie_le = now()`,
        [k, DEFS[k].secret ? encrypt(v) : v],
      );
    }
    for (const k of effacer) await q('DELETE FROM plateforme_parametres WHERE cle = $1', [k]);
  });
  cache = null;
}

module.exports = { DEFS, snapshot, describe, normaliser, save, encrypt, decrypt, invalidate: () => { cache = null; } };
