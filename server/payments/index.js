'use strict';
const settings = require('../lib/settings');
// Deux agrégateurs seulement : KkiaPay et FedaPay
const providers = [require('./kkiapay'), require('./fedapay')];

// Agrégateurs utilisables d'après la configuration actuelle
async function enabled() {
  const cfg = await settings.snapshot();
  return { cfg, list: providers.filter((p) => p.enabled(cfg)) };
}

async function get(id) {
  const cfg = await settings.snapshot();
  const provider = providers.find((p) => p.id === id && p.enabled(cfg));
  return provider ? { provider, cfg } : null;
}

module.exports = { enabled, get };
