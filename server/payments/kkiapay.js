'use strict';
const { HttpError } = require('../lib/http');

// `cfg` vient de settings.snapshot() : les clés sont celles saisies dans l'espace super admin (ou le .env à défaut)
const base = (cfg) => (cfg.kkiapay.sandbox ? 'https://api-sandbox.kkiapay.me' : 'https://api.kkiapay.me');

module.exports = {
  id: 'kkiapay',
  label: 'KkiaPay (Mobile Money, carte)',

  enabled(cfg) {
    return Boolean(cfg.kkiapay.publicKey && cfg.kkiapay.privateKey);
  },

  // Seules les données publiques partent vers le navigateur
  publicConfig(cfg) {
    return { publicKey: cfg.kkiapay.publicKey, sandbox: cfg.kkiapay.sandbox };
  },

  // Vérifie côté serveur qu'une transaction a bien réussi (ne jamais faire confiance au navigateur)
  async verify(cfg, transactionId) {
    if (!this.enabled(cfg)) throw new HttpError(503, "KkiaPay n'est pas configuré. Renseignez les clés dans l'espace super admin.");
    let res;
    try {
      res = await fetch(`${base(cfg)}/api/v1/transactions/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Les trois clés du compte KkiaPay, comme le SDK officiel
          'x-api-key': cfg.kkiapay.publicKey,
          'x-private-key': cfg.kkiapay.privateKey,
          ...(cfg.kkiapay.secret ? { 'x-secret-key': cfg.kkiapay.secret } : {}),
        },
        body: JSON.stringify({ transactionId }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(502, 'KkiaPay ne répond pas. Réessayez dans un instant.');
    }
    if (!res.ok) {
      console.error(`KkiaPay a répondu ${res.status} à la vérification de la transaction ${transactionId}`);
      throw new HttpError(502, `Vérification KkiaPay impossible (code ${res.status}). Contrôlez les clés KkiaPay dans l'espace super admin.`);
    }
    const data = await res.json().catch(() => ({}));
    return {
      ok: String(data.status || '').toUpperCase() === 'SUCCESS',
      montant: Number(data.amount),
      reference: String(data.transactionId || transactionId),
      // Identifiant de notre paiement, transmis à KkiaPay à la création (stateData)
      paiementId: Number.parseInt(data.stateData, 10),
      brut: data,
    };
  },
};
