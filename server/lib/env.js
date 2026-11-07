'use strict';
try { process.loadEnvFile(); } catch { /* pas de fichier .env : on utilise l'environnement */ }

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'oui'].includes(String(v).toLowerCase()));
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

// Vercel renseigne VERCEL=1 : le serveur tourne alors en fonction serverless, derrière le proxy de Vercel.
const serverless = Boolean(process.env.VERCEL);

const env = {
  port: num(process.env.PORT, 3000),
  serverless,
  trustProxy: bool(process.env.TRUST_PROXY, serverless),
  // Nombre de proxys de confiance devant le serveur (1 = l'hébergeur seul). Sert à lire la vraie adresse IP du client.
  // Nom d'un en-tête HTTP, posé par le proxy frontal, qui contient l'adresse réelle du client (Render : cf-connecting-ip)
  trustedIpHeader: (process.env.TRUSTED_IP_HEADER || '').trim().toLowerCase(),
  trustedHops: Math.max(1, num(process.env.TRUSTED_PROXY_HOPS, 1)),
  // WebSocket (temps réel) : impossible sur Vercel (fonctions serverless), actif sur un serveur permanent
  wsActif: bool(process.env.WS_ENABLED, !serverless),
  // Sur Render, RENDER_EXTERNAL_URL est fourni automatiquement ; PUBLIC_URL prime (domaine personnalisé)
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, ''),
  // Frontend hébergé à part (ex. Cloudflare Pages) : origines autorisées à appeler l'API (CORS) et à ouvrir le WebSocket.
  // Liste séparée par des virgules, sans barre finale : https://best-quinca.pages.dev,https://www.mon-domaine.com
  frontendOrigins: (process.env.FRONTEND_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter((s) => /^https?:\/\/[^/\s]+$/i.test(s)),
  databaseUrl: process.env.DATABASE_URL || '',
  pgssl: bool(process.env.PGSSL),
  // Connexions simultanées par instance : peu en serverless (Neon mutualise via son pooler)
  poolMax: num(process.env.PG_POOL_MAX, serverless ? 5 : 10),
  // Crée/met à jour les tables au premier appel de chaque instance (verrou anti-concurrence). false = `npm run migrate` à la main.
  autoMigrate: bool(process.env.AUTO_MIGRATE, true),
  jwtSecret: process.env.JWT_SECRET || '',
  // Deux formules : mensuelle (5 000 F CFA / 30 jours) et annuelle (50 000 F CFA / 365 jours)
  price: num(process.env.SUBSCRIPTION_PRICE, 5000),
  days: num(process.env.SUBSCRIPTION_DAYS, 30),
  priceAnnual: num(process.env.SUBSCRIPTION_PRICE_ANNUAL, 50000),
  daysAnnual: num(process.env.SUBSCRIPTION_DAYS_ANNUAL, 365),
  trialDays: num(process.env.TRIAL_DAYS, 0),
  // Application Android (Google Play) : nom du paquet et empreintes SHA-256 des certificats de signature (séparées par des virgules)
  androidPackage: (process.env.ANDROID_PACKAGE_NAME || '').trim(),
  androidSha256: (process.env.ANDROID_SHA256_FINGERPRINTS || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s)),
  // Pages légales : éditeur du service et contact pour les demandes sur les données personnelles
  contactEmail: (process.env.CONTACT_EMAIL || 'arioriadnel56@gmail.com').trim(),
  editeurNom: (process.env.EDITEUR_NOM || 'ARIORI Adnel Adedeji Fulbert').trim(),
  superadmin: {
    email: (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase(),
    password: process.env.SUPERADMIN_PASSWORD || '',
    nom: process.env.SUPERADMIN_NOM || 'Super administrateur',
    // true : à chaque démarrage, crée ce compte ou remet son mot de passe à la valeur de SUPERADMIN_PASSWORD (à retirer ensuite)
    reset: bool(process.env.SUPERADMIN_RESET),
  },
  kkiapay: {
    publicKey: process.env.KKIAPAY_PUBLIC_KEY || '',
    privateKey: process.env.KKIAPAY_PRIVATE_KEY || '',
    secret: process.env.KKIAPAY_SECRET || '',
    sandbox: bool(process.env.KKIAPAY_SANDBOX, true),
  },
  fedapay: {
    publicKey: process.env.FEDAPAY_PUBLIC_KEY || '',
    secretKey: process.env.FEDAPAY_SECRET_KEY || '',
    webhookSecret: process.env.FEDAPAY_WEBHOOK_SECRET || '',
    sandbox: bool(process.env.FEDAPAY_SANDBOX, true),
  },
};

function assertEnv() {
  const missing = [];
  if (!env.databaseUrl) missing.push('DATABASE_URL');
  if (env.jwtSecret.length < 32) missing.push('JWT_SECRET (32 caractères minimum)');
  else if (/(change|exemple|example|votre|your|placeholder|remplace|secret-ici)/i.test(env.jwtSecret)) missing.push('JWT_SECRET (valeur d\'exemple : générez une vraie valeur aléatoire avec openssl rand -hex 48)');
  if (missing.length) {
    throw new Error('Configuration manquante : ' + missing.join(', ') + '. Copiez .env.example vers .env et remplissez-le.');
  }
}

module.exports = { env, assertEnv };
