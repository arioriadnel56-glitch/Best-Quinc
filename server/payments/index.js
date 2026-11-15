'use strict';
const settings = require('../lib/settings');
const db = require('../lib/db');
// Agrégateurs opérationnels : KkiaPay et FedaPay (CinetPay : clés enregistrables, adaptateur à venir)
const providers = [require('./kkiapay'), require('./fedapay')];

// Agrégateurs désactivés par l'administration (table payment_providers). En cas de problème de lecture, on ne bloque pas les paiements.
async function desactives() {
  try {
    const { rows } = await db.query('SELECT code, actif FROM payment_providers');
    return new Set((rows || []).filter((r) => r && r.actif === false).map((r) => r.code));
  } catch (e) {
    console.error('Lecture des agrégateurs impossible :', e.message);
    return new Set();
  }
}

// Agrégateurs utilisables d'après la configuration actuelle et l'activation décidée par l'administration
async function enabled() {
  const cfg = await settings.snapshot();
  const off = await desactives();
  return { cfg, list: providers.filter((p) => p.enabled(cfg) && !off.has(p.id)) };
}

// `verification` = true : on confirme un paiement déjà engagé (webhook, retour du client). Un agrégateur désactivé depuis
// n'interrompt jamais la confirmation d'un paiement en cours ; la désactivation ne bloque que les NOUVEAUX paiements.
async function get(id, verification = false) {
  const cfg = await settings.snapshot();
  const off = verification ? new Set() : await desactives();
  const provider = providers.find((p) => p.id === id && p.enabled(cfg) && !off.has(p.id));
  return provider ? { provider, cfg } : null;
}

module.exports = { enabled, get };
