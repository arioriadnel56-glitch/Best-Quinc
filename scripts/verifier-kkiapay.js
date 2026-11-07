'use strict';
// Contrôle la liaison avec KkiaPay : node scripts/verifier-kkiapay.js <transactionId>
// 1) Faites un paiement de test dans le widget KkiaPay (mode sandbox) et notez l'identifiant de transaction.
// 2) Lancez ce script : il doit afficher « SUCCESS » et le montant payé.
require('../server/lib/env');
const kkiapay = require('../server/payments/kkiapay');
const settings = require('../server/lib/settings');

const id = process.argv[2];
if (!id) { console.error('Usage : node scripts/verifier-kkiapay.js <transactionId>'); process.exit(1); }

(async () => {
  const cfg = await settings.snapshot(); // clés saisies dans l'espace super admin, ou .env à défaut
  if (!kkiapay.enabled(cfg)) { console.error("Clés KkiaPay manquantes : saisissez-les dans l'espace super admin (Paramètres)."); process.exit(1); }
  const r = await kkiapay.verify(cfg, id);
  console.log(r.ok ? 'Paiement confirmé.' : 'Paiement NON confirmé.');
  console.log('Réponse complète de KkiaPay :', JSON.stringify(r.brut, null, 2));
})()
  .catch((e) => { console.error('Échec :', e.message); process.exit(1); })
  .finally(() => require('../server/lib/db').getPool().end());
