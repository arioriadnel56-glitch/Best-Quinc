'use strict';
const db = require('../lib/db');
const { HttpError, str, int } = require('../lib/http');
const { auth, role, subscribed } = require('../lib/auth');
const { TZ } = require('../lib/tz');
const realtime = require('../lib/realtime');

const base = [auth, subscribed];
const MODES = ['especes', 'mobile_money', 'autre'];
const mode = (v) => {
  const m = v === undefined || v === null || v === '' ? 'especes' : String(v);
  if (!MODES.includes(m)) throw new HttpError(400, 'Mode de paiement invalide.');
  return m;
};
// Reste à payer d'une vente : valeur nette des articles gardés moins l'argent conservé
const SOLDE = 'GREATEST(0, v.total - v.rembourse - v.montant_paye)';

module.exports = function register(router) {
  // Créances en cours : toutes les ventes à crédit non soldées
  router.get('/api/credits', ...base, async (ctx) => {
    const { rows } = await db.query(
      `SELECT v.id, v.numero, v.client_nom, v.client_telephone, v.total, v.rembourse, v.montant_paye,
              ${SOLDE} AS solde,
              to_char(v.echeance, 'YYYY-MM-DD') AS echeance,
              (v.echeance IS NOT NULL AND v.echeance < (now() AT TIME ZONE $2)::date) AS en_retard,
              to_char(v.cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM ventes v
        WHERE v.entreprise_id = $1 AND v.mode_paiement = 'credit' AND ${SOLDE} > 0
        ORDER BY (v.echeance IS NULL), v.echeance, v.id`,
      [ctx.user.entreprise_id, TZ],
    );
    const du = rows.reduce((s, r) => s + Number(r.solde), 0);
    const retard = rows.filter((r) => r.en_retard).reduce((s, r) => s + Number(r.solde), 0);
    return { total_du: du, total_en_retard: retard, credits: rows };
  });

  // Encaissement d'un règlement (partiel ou total) sur une vente à crédit
  router.post('/api/ventes/:id/reglements', ...base, async (ctx) => {
    const id = int(ctx.params.id, 'vente', { min: 1 });
    const montant = int(ctx.body.montant, 'montant', { min: 1, max: 2000000000 });
    const m = mode(ctx.body.mode_paiement);
    const eid = ctx.user.entreprise_id;
    const res = await db.tx(async (q) => {
      const v = await q('SELECT id, numero, total, rembourse, montant_paye FROM ventes WHERE id = $1 AND entreprise_id = $2 AND mode_paiement = \'credit\' FOR UPDATE', [id, eid]);
      if (!v.rows.length) throw new HttpError(404, 'Vente à crédit introuvable.');
      const x = v.rows[0];
      const solde = Math.max(0, x.total - x.rembourse - x.montant_paye);
      if (solde <= 0) throw new HttpError(400, 'Cette vente est déjà soldée.');
      if (montant > solde) throw new HttpError(400, `Le règlement dépasse le reste à payer (${solde} F CFA).`);
      const r = await q(
        'INSERT INTO reglements (entreprise_id, vente_id, montant, mode_paiement, utilisateur_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [eid, id, montant, m, ctx.user.id],
      );
      await q('UPDATE ventes SET montant_paye = montant_paye + $1 WHERE id = $2', [montant, id]);
      return { id: r.rows[0].id, numero: x.numero, solde: solde - montant };
    });
    realtime.publier(eid, 'credit.regle', { numero: res.numero, montant, par: ctx.user.id });
    ctx.status = 201;
    return res;
  });

  // Remboursement : retour de tout ou partie d'une vente. Réservé au propriétaire (sortie d'argent).
  // Règle : la valeur reprise annule d'abord la dette du client (vente à crédit), le reste lui est rendu.
  router.post('/api/ventes/:id/remboursements', ...base, role('proprietaire'), async (ctx) => {
    const id = int(ctx.params.id, 'vente', { min: 1 });
    const b = ctx.body;
    if (!Array.isArray(b.lignes) || !b.lignes.length) throw new HttpError(400, 'Choisissez au moins un article à rembourser.');
    if (b.lignes.length > 100) throw new HttpError(400, 'Trop de lignes.');
    const motif = str(b.motif, 'motif', { max: 255 });
    const m = mode(b.mode_paiement);
    const remettre = b.remettre_en_stock !== false;
    const demande = new Map();
    for (const l of b.lignes) {
      const lid = int(l && l.ligne_id, 'ligne', { min: 1 });
      const qte = int(l && l.quantite, 'quantité', { min: 1, max: 1000000 });
      demande.set(lid, (demande.get(lid) || 0) + qte);
    }
    const eid = ctx.user.entreprise_id;

    const res = await db.tx(async (q) => {
      await q('SELECT id FROM entreprises WHERE id = $1 FOR UPDATE', [eid]);
      const v = await q('SELECT id, numero, total, rembourse, montant_paye FROM ventes WHERE id = $1 AND entreprise_id = $2 FOR UPDATE', [id, eid]);
      if (!v.rows.length) throw new HttpError(404, 'Vente introuvable.');
      const x = v.rows[0];
      const lignes = await q(
        `SELECT l.id, l.produit_id, l.nom_produit, l.quantite, l.prix_unitaire,
                COALESCE((SELECT SUM(lr.quantite) FROM lignes_remboursement lr WHERE lr.ligne_vente_id = l.id), 0)::int AS deja
           FROM lignes_vente l WHERE l.vente_id = $1 AND l.id = ANY($2::int[]) ORDER BY l.id`,
        [id, [...demande.keys()]],
      );
      if (lignes.rows.length !== demande.size) throw new HttpError(400, "Un des articles n'appartient pas à cette vente.");
      let valeur = 0;
      for (const l of lignes.rows) {
        const qte = demande.get(l.id);
        if (qte > l.quantite - l.deja) throw new HttpError(400, `« ${l.nom_produit} » : ${l.quantite - l.deja} article(s) seulement peuvent encore être remboursés.`);
        valeur += qte * l.prix_unitaire;
      }
      if (valeur <= 0) throw new HttpError(400, 'Le montant à rembourser est nul.');

      const soldeAvant = Math.max(0, x.total - x.rembourse - x.montant_paye);
      const creditAnnule = Math.min(soldeAvant, valeur);
      const rendu = valeur - creditAnnule;
      const num = await q('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM remboursements WHERE entreprise_id = $1', [eid]);
      const r = await q(
        `INSERT INTO remboursements (entreprise_id, vente_id, numero, motif, montant, credit_annule, montant_rendu, mode_paiement, remis_en_stock, utilisateur_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, numero`,
        [eid, id, num.rows[0].n, motif, valeur, creditAnnule, rendu, m, remettre, ctx.user.id],
      );
      for (const l of lignes.rows) {
        const qte = demande.get(l.id);
        await q(
          `INSERT INTO lignes_remboursement (remboursement_id, ligne_vente_id, nom_produit, quantite, prix_unitaire, sous_total)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [r.rows[0].id, l.id, l.nom_produit, qte, l.prix_unitaire, qte * l.prix_unitaire],
        );
        if (remettre && l.produit_id) {
          await q('UPDATE produits SET quantite_stock = quantite_stock + $1 WHERE id = $2 AND entreprise_id = $3', [qte, l.produit_id, eid]);
          await q(
            `INSERT INTO mouvements_stock (entreprise_id, produit_id, type, quantite, motif, utilisateur_id)
             VALUES ($1, $2, 'retour', $3, $4, $5)`,
            [eid, l.produit_id, qte, `Remboursement n°${r.rows[0].numero} (vente n°${x.numero})`, ctx.user.id],
          );
        }
      }
      // L'argent rendu au client sort de ce que la boutique a conservé sur cette vente
      await q('UPDATE ventes SET rembourse = rembourse + $1, montant_paye = montant_paye - $2 WHERE id = $3', [valeur, rendu, id]);
      return { id: r.rows[0].id, numero: r.rows[0].numero, montant: valeur, credit_annule: creditAnnule, montant_rendu: rendu, vente_numero: x.numero };
    });
    realtime.publier(eid, 'remboursement.cree', { numero: res.numero, montant: res.montant, par: ctx.user.id });
    ctx.status = 201;
    return res;
  });

  router.get('/api/remboursements', ...base, async (ctx) => {
    const { rows } = await db.query(
      `SELECT r.id, r.vente_id, r.numero, r.montant, r.credit_annule, r.montant_rendu, r.motif, v.numero AS vente_numero, v.client_nom,
              u.nom_complet AS par, to_char(r.cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM remboursements r JOIN ventes v ON v.id = r.vente_id LEFT JOIN utilisateurs u ON u.id = r.utilisateur_id
        WHERE r.entreprise_id = $1 ORDER BY r.id DESC LIMIT 200`,
      [ctx.user.entreprise_id, TZ],
    );
    return rows;
  });
};
