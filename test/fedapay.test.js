'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fedapay = require('../server/payments/fedapay');

const cfg = (sandbox = true) => ({ fedapay: { publicKey: 'pk_x', secretKey: 'sk_x', webhookSecret: '', sandbox } });

test('FedaPay : activé seulement avec clé publique et clé secrète', () => {
  assert.equal(fedapay.enabled(cfg()), true);
  assert.equal(fedapay.enabled({ fedapay: { publicKey: 'pk', secretKey: '' } }), false);
});

test('FedaPay : la configuration publique ne contient jamais la clé secrète', () => {
  assert.deepEqual(fedapay.publicConfig(cfg()), { publicKey: 'pk_x', sandbox: true });
});

test('FedaPay : transaction approuvée vérifiée avec la clé secrète, sandbox ou production', async () => {
  const vus = [];
  const reel = global.fetch;
  global.fetch = async (url, opts) => { vus.push({ url, auth: opts.headers.Authorization }); return { ok: true, status: 200, json: async () => ({ 'v1/transaction': { id: 77, status: 'approved', amount: 50000, custom_metadata: { paiement_id: 5 } } }) }; };
  try {
    const v = await fedapay.verify(cfg(true), '77');
    assert.equal(v.ok, true);
    assert.equal(v.montant, 50000);
    assert.equal(v.reference, '77');
    assert.equal(v.brut.custom_metadata.paiement_id, 5);
    await fedapay.verify(cfg(false), '77');
  } finally { global.fetch = reel; }
  assert.equal(vus[0].url, 'https://sandbox-api.fedapay.com/v1/transactions/77');
  assert.equal(vus[1].url, 'https://api.fedapay.com/v1/transactions/77');
  assert.equal(vus[0].auth, 'Bearer sk_x');
});

test('FedaPay : une transaction non approuvée est refusée', async () => {
  const reel = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ 'v1/transaction': { id: 8, status: 'pending', amount: 5000 } }) });
  try { assert.equal((await fedapay.verify(cfg(), '8')).ok, false); } finally { global.fetch = reel; }
});

test('FedaPay : API injoignable ou clés refusées → erreur claire, pas de succès', async () => {
  const reel = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try { await assert.rejects(() => fedapay.verify(cfg(), '9'), /FedaPay/); } finally { global.fetch = reel; }
});
