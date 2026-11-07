'use strict';
const crypto = require('node:crypto');
const db = require('../lib/db');
const { HttpError, str, int } = require('../lib/http');
const { auth, role, activeSubscription } = require('../lib/auth');
const { limit } = require('../lib/ratelimit');
const payments = require('../payments');
const settings = require('../lib/settings');
const realtime = require('../lib/realtime');

// Vérifie le paiement auprès de l'agrégateur puis active (ou prolonge) l'abonnement.
// Idempotent : un paiement déjà confirmé n'ajoute pas une seconde période.
async function finaliser({ paiementId, entrepriseId, reference }) {
  const { rows } = await db.query(
    `SELECT id, entreprise_id, agregateur, montant, statut, plan, jours FROM paiements
      WHERE id = $1${entrepriseId ? ' AND entreprise_id = $2' : ''}`,
    entrepriseId ? [paiementId, entrepriseId] : [paiementId],
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, 'Paiement introuvable.');
  if (p.statut === 'reussi') return { deja_confirme: true };

  const found = await payments.get(p.agregateur);
  if (!found) throw new HttpError(400, "Cet agrégateur n'est pas disponible.");
  const v = await found.provider.verify(found.cfg, reference);
  if (!v.ok) throw new HttpError(400, "Le paiement n'est pas confirmé par l'agrégateur.", { code: 'PAIEMENT_NON_CONFIRME' });
  if (!(v.montant >= p.montant)) throw new HttpError(400, 'Le montant payé est inférieur au prix de l\'abonnement.');
  // La transaction doit avoir été créée pour CE paiement : sinon n'importe qui pourrait présenter le numéro
  // d'une transaction d'un autre client (ces numéros ne sont pas secrets) pour obtenir un abonnement gratuit.
  if (Number.isInteger(v.paiementId)) {
    if (v.paiementId !== p.id) throw new HttpError(400, 'Cette transaction correspond à un autre paiement.');
  } else if (v.liaisonObligatoire) {
    throw new HttpError(400, 'Cette transaction n\'est pas liée à ce paiement.');
  } else {
    console.warn(`Paiement ${p.id} (${p.agregateur}) : l'agrégateur n'a pas renvoyé l'identifiant du paiement, liaison non vérifiée.`);
  }

  try {
    await db.tx(async (q) => {
      const cur = await q('SELECT statut FROM paiements WHERE id = $1 FOR UPDATE', [p.id]);
      if (cur.rows[0].statut === 'reussi') return;
      const ab = await q(
        `INSERT INTO abonnements (entreprise_id, montant, statut, date_debut, date_fin)
         SELECT $1::int, $2::int, 'actif', d.debut, d.debut + $3::int
           FROM (SELECT GREATEST(CURRENT_DATE, COALESCE(MAX(date_fin), CURRENT_DATE)) AS debut
                   FROM abonnements WHERE entreprise_id = $1::int AND statut = 'actif') d
         RETURNING id`,
        [p.entreprise_id, p.montant, p.jours || found.cfg.jours],
      );
      await q(
        `UPDATE paiements SET statut = 'reussi', reference_transaction = $1, abonnement_id = $2, confirme_le = now()
          WHERE id = $3`,
        [v.reference, ab.rows[0].id, p.id],
      );
    });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Cette transaction a déjà été utilisée.');
    throw err;
  }
  realtime.publier(p.entreprise_id, 'abonnement.change');
  realtime.publierAdmins('paiement.reussi', { entreprise_id: p.entreprise_id, montant: p.montant });
  return { deja_confirme: false };
}

module.exports = function register(router) {
  router.get('/api/config', async () => {
    const { cfg, list } = await payments.enabled();
    return {
      prix: cfg.prix,
      jours: cfg.jours,
      plans: Object.values(cfg.plans),
      essai_jours: cfg.essaiJours,
      agregateurs: list.map((p) => ({ id: p.id, label: p.label, config: p.publicConfig(cfg) })),
    };
  });

  router.get('/api/abonnement', auth, async (ctx) => {
    const cfg = await settings.snapshot();
    const actif = await activeSubscription(ctx.user.entreprise_id);
    const { rows } = await db.query(
      `SELECT id, agregateur, montant, statut, plan, to_char(cree_le, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM paiements WHERE entreprise_id = $1 ORDER BY id DESC LIMIT 20`,
      [ctx.user.entreprise_id],
    );
    return { actif, prix: cfg.prix, jours: cfg.jours, plans: Object.values(cfg.plans), paiements: rows };
  });

  router.post('/api/abonnement/initier', auth, role('proprietaire'), async (ctx) => {
    await limit(`initier:${ctx.user.entreprise_id}`, 20, 3600 * 1000);
    const id = str(ctx.body.agregateur, 'agrégateur', { max: 20 });
    const found = await payments.get(id);
    if (!found) throw new HttpError(400, "Ce moyen de paiement n'est pas disponible.");
    // Formule choisie : mensuelle (défaut) ou annuelle. Prix et durée viennent du serveur, jamais du navigateur.
    const planId = ctx.body.plan === undefined ? 'mensuel' : String(ctx.body.plan);
    const plan = found.cfg.plans[planId];
    if (!plan) throw new HttpError(400, "Formule d'abonnement inconnue.");
    const { rows } = await db.query(
      `INSERT INTO paiements (entreprise_id, agregateur, montant, plan, jours) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ctx.user.entreprise_id, found.provider.id, plan.prix, plan.id, plan.jours],
    );
    ctx.status = 201;
    return { paiement_id: rows[0].id, montant: plan.prix, plan: plan.id, jours: plan.jours, agregateur: found.provider.id };
  });

  router.post('/api/abonnement/confirmer', auth, role('proprietaire'), async (ctx) => {
    const paiementId = int(ctx.body.paiement_id, 'paiement', { min: 1 });
    const reference = str(ctx.body.transaction_id, 'transaction', { max: 120 });
    await limit(`confirmer:${ctx.user.entreprise_id}`, 30, 3600 * 1000);
    await finaliser({ paiementId, entrepriseId: ctx.user.entreprise_id, reference });
    return { abonnement: await activeSubscription(ctx.user.entreprise_id) };
  });

  // Notification serveur-à-serveur de KkiaPay : filet de sécurité si le navigateur est fermé avant la confirmation
  router.post('/api/webhooks/kkiapay', async (ctx) => {
    await limit(`webhook:${ctx.ip}`, 120, 60 * 1000);
    const cfg = await settings.snapshot();
    const attendu = Buffer.from(cfg.kkiapay.secret || '');
    const recu = Buffer.from(String(ctx.req.headers['x-kkiapay-secret'] || ''));
    if (!attendu.length) throw new HttpError(503, 'Webhook KkiaPay non configuré.');
    if (attendu.length !== recu.length || !crypto.timingSafeEqual(attendu, recu)) throw new HttpError(401, 'Signature invalide.');

    const reference = String(ctx.body.transactionId || '');
    if (!reference) throw new HttpError(400, 'transactionId manquant.');
    const found = await payments.get('kkiapay');
    if (!found) throw new HttpError(503, 'KkiaPay indisponible.');
    const v = await found.provider.verify(found.cfg, reference);
    if (!v.ok) return { recu: true, ignore: 'transaction non réussie' };

    const paiementId = parseInt(ctx.body.stateData || (v.brut && v.brut.stateData), 10);
    if (!Number.isInteger(paiementId)) return { recu: true, ignore: 'paiement non identifié' };
    try {
      await finaliser({ paiementId, entrepriseId: null, reference });
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) return { recu: true, ignore: err.message };
      throw err;
    }
    return { recu: true };
  });

  // Notification serveur-à-serveur de FedaPay (filet de sécurité si le navigateur est fermé avant la confirmation).
  // On ne retient que le paiement dont l'identifiant a été transmis à la création de la transaction.
  router.post('/api/webhooks/fedapay', async (ctx) => {
    await limit(`webhook:${ctx.ip}`, 120, 60 * 1000);
    const found = await payments.get('fedapay');
    if (!found) throw new HttpError(503, 'FedaPay indisponible.');
    // Pas de confiance dans le contenu reçu : seule la réponse de l'API FedaPay, interrogée avec la clé secrète, fait foi.
    const entite = (ctx.body && (ctx.body.entity || ctx.body.object)) || {};
    const reference = String(entite.id || ctx.body.id_transaction || '');
    if (!reference) throw new HttpError(400, 'Transaction manquante.');
    const v = await found.provider.verify(found.cfg, reference);
    if (!v.ok) return { recu: true, ignore: 'transaction non approuvée' };
    const meta = (v.brut && v.brut.custom_metadata) || {};
    const paiementId = parseInt(meta.paiement_id, 10);
    if (!Number.isInteger(paiementId)) return { recu: true, ignore: 'paiement non identifié' };
    try {
      await finaliser({ paiementId, entrepriseId: null, reference });
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) return { recu: true, ignore: err.message };
      throw err;
    }
    return { recu: true };
  });
};

module.exports.finaliser = finaliser;
