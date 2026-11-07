'use strict';
const { HttpError } = require('../lib/http');

// API FedaPay : https://docs.fedapay.com — clés « pk_… » (publique) et « sk_… » (secrète)
const base = (cfg) => (cfg.fedapay.sandbox ? 'https://sandbox-api.fedapay.com' : 'https://api.fedapay.com');

module.exports = {
  id: 'fedapay',
  label: 'FedaPay (Mobile Money, carte)',

  enabled(cfg) {
    return Boolean(cfg.fedapay.publicKey && cfg.fedapay.secretKey);
  },

  // Seules les données publiques partent vers le navigateur (le widget checkout.js n'a besoin que de la clé publique)
  publicConfig(cfg) {
    return { publicKey: cfg.fedapay.publicKey, sandbox: cfg.fedapay.sandbox };
  },

  // Vérifie côté serveur qu'une transaction est bien approuvée (ne jamais faire confiance au navigateur)
  async verify(cfg, transactionId) {
    if (!this.enabled(cfg)) throw new HttpError(503, "FedaPay n'est pas configuré. Renseignez les clés dans l'espace super admin.");
    const id = encodeURIComponent(String(transactionId).trim());
    let res;
    try {
      res = await fetch(`${base(cfg)}/v1/transactions/${id}`, {
        headers: { Authorization: `Bearer ${cfg.fedapay.secretKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(502, 'FedaPay ne répond pas. Réessayez dans un instant.');
    }
    if (!res.ok) {
      console.error(`FedaPay a répondu ${res.status} à la vérification de la transaction ${transactionId}`);
      throw new HttpError(502, `Vérification FedaPay impossible (code ${res.status}). Contrôlez les clés FedaPay dans l'espace super admin.`);
    }
    const data = await res.json().catch(() => ({}));
    const t = data['v1/transaction'] || data.transaction || data;
    const statut = String(t.status || '').toLowerCase();
    return {
      ok: statut === 'approved' || statut === 'transferred',
      montant: Number(t.amount),
      reference: String(t.id || transactionId),
      paiementId: Number.parseInt((t.custom_metadata || {}).paiement_id, 10),
      // FedaPay renvoie toujours custom_metadata : la liaison est donc obligatoire
      liaisonObligatoire: true,
      brut: t,
    };
  },
};
