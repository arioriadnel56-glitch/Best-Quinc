'use strict';
const db = require('../lib/db');
const { HttpError, str, int } = require('../lib/http');
const { auth, role, subscribed } = require('../lib/auth');
const { planifierVente, heureVente, texteAnomalie } = require('../lib/vente');
const { TZ } = require('../lib/tz');
const realtime = require('../lib/realtime');

const base = [auth, subscribed];
const MODES = ['especes', 'mobile_money', 'autre', 'credit'];
const dateOuNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

module.exports = function register(router) {
  router.post('/api/ventes', ...base, async (ctx) => {
    const b = ctx.body;
    if (!Array.isArray(b.lignes) || !b.lignes.length) throw new HttpError(400, 'Ajoutez au moins un produit à la vente.');
    if (b.lignes.length > 100) throw new HttpError(400, 'Une vente ne peut pas dépasser 100 lignes.');
    const mode = b.mode_paiement === undefined ? 'especes' : String(b.mode_paiement);
    if (!MODES.includes(mode)) throw new HttpError(400, 'Mode de paiement invalide.');
    const clientNom = str(b.client_nom, 'nom du client', { optional: true, max: 150 });
    const clientTel = str(b.client_telephone, 'téléphone du client', { optional: true, max: 30 });

    // Vente à crédit : le client doit être identifié ; un acompte et une date limite sont possibles
    const credit = mode === 'credit';
    if (credit && (!clientNom || !clientTel)) throw new HttpError(400, 'Une vente à crédit exige le nom et le téléphone du client.');
    const acompte = credit ? int(b.acompte, 'acompte', { optional: true, min: 0, max: 2000000000 }) || 0 : 0;
    const echeance = credit ? dateOuNull(b.echeance) : null;
    if (credit && b.echeance && !echeance) throw new HttpError(400, 'Date limite de paiement invalide.');

    // Vente enregistrée hors connexion : identifiant unique (anti-doublon), heure réelle, prix affiché au client
    const horsLigne = b.hors_ligne === true;
    const cle = b.cle === undefined || b.cle === null || b.cle === '' ? null : String(b.cle);
    if (cle !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(cle)) throw new HttpError(400, 'Identifiant de vente invalide.');
    if (horsLigne && cle === null) throw new HttpError(400, 'Une vente hors connexion doit avoir un identifiant.');
    const heure = horsLigne ? heureVente(b.cree_le) : { date: null, anomalie: null };

    // Regroupe les doublons d'un même produit
    const demande = new Map();
    for (const l of b.lignes) {
      const pid = int(l && l.produit_id, 'produit', { min: 1 });
      const qte = int(l && l.quantite, 'quantité', { min: 1, max: 1000000 });
      const prix = horsLigne ? int(l.prix_unitaire, 'prix unitaire', { optional: true, min: 0 }) : null;
      const deja = demande.get(pid);
      if (deja && deja.prix !== prix) throw new HttpError(400, 'Un même produit ne peut pas figurer à deux prix différents dans une vente.');
      demande.set(pid, { qte: (deja ? deja.qte : 0) + qte, prix });
    }
    const ids = [...demande.keys()].sort((a, c) => a - c);
    const eid = ctx.user.entreprise_id;

    const vente = await db.tx(async (q) => {
      // Le verrou sur l'entreprise garantit une numérotation sans trou ni doublon (et sérialise les envois d'une même vente)
      await q('SELECT id FROM entreprises WHERE id = $1 FOR UPDATE', [eid]);
      if (cle !== null) {
        const deja = await q('SELECT id, numero, total, anomalie, montant_paye FROM ventes WHERE entreprise_id = $1 AND cle = $2', [eid, cle]);
        if (deja.rows.length) return { ...deja.rows[0], deja_enregistree: true };
      }
      const prods = await q(
        `SELECT id, nom, prix_vente, quantite_stock, actif FROM produits
          WHERE entreprise_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`,
        [eid, ids],
      );
      if (prods.rows.length !== ids.length) throw new HttpError(400, 'Un des produits est introuvable.');

      const plan = planifierVente(prods.rows, demande, { horsLigne });
      const anomalie = texteAnomalie([...(heure.anomalie ? [heure.anomalie] : []), ...plan.anomalies]);

      if (credit && acompte >= plan.total) throw new HttpError(400, "L'acompte doit être inférieur au total : sinon enregistrez une vente payée.");
      const num = await q('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM ventes WHERE entreprise_id = $1', [eid]);
      const v = await q(
        `INSERT INTO ventes (entreprise_id, numero, utilisateur_id, client_nom, client_telephone, total, mode_paiement, cle, hors_ligne, anomalie, cree_le, montant_paye, echeance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, now()), $12, $13) RETURNING id, numero, total, anomalie, montant_paye`,
        [eid, num.rows[0].n, ctx.user.id, clientNom, clientTel, plan.total, mode, cle, horsLigne, anomalie, heure.date, credit ? acompte : plan.total, echeance],
      );
      for (const l of plan.lignes) {
        await q(
          `INSERT INTO lignes_vente (vente_id, produit_id, nom_produit, quantite, prix_unitaire, sous_total)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [v.rows[0].id, l.produit_id, l.nom, l.qte, l.prix, l.sousTotal],
        );
        if (l.decremente > 0) {
          await q('UPDATE produits SET quantite_stock = quantite_stock - $1 WHERE id = $2', [l.decremente, l.produit_id]);
          await q(
            `INSERT INTO mouvements_stock (entreprise_id, produit_id, type, quantite, motif, utilisateur_id)
             VALUES ($1, $2, 'vente', $3, $4, $5)`,
            [eid, l.produit_id, -l.decremente, `Vente n°${v.rows[0].numero}${horsLigne ? ' (hors connexion)' : ''}`, ctx.user.id],
          );
        }
      }
      return v.rows[0];
    });
    if (!vente.deja_enregistree) realtime.publier(eid, 'vente.creee', { numero: vente.numero, total: Number(vente.total), hors_ligne: horsLigne, par: ctx.user.id });
    ctx.status = vente.deja_enregistree ? 200 : 201;
    return vente;
  });

  // Le propriétaire marque une vente à anomalie comme vérifiée
  router.put('/api/ventes/:id/verifiee', ...base, role('proprietaire'), async (ctx) => {
    const id = int(ctx.params.id, 'vente', { min: 1 });
    const r = await db.query('UPDATE ventes SET anomalie_verifiee = true WHERE id = $1 AND entreprise_id = $2', [id, ctx.user.entreprise_id]);
    if (!r.rowCount) throw new HttpError(404, 'Vente introuvable.');
    return { ok: true };
  });

  router.get('/api/ventes', ...base, async (ctx) => {
    const { rows } = await db.query(
      `SELECT v.id, v.numero, v.total, v.mode_paiement, v.client_nom, u.nom_complet AS vendeur,
              v.hors_ligne, v.anomalie, v.anomalie_verifiee, v.rembourse, v.montant_paye,
              GREATEST(0, v.total - v.rembourse - v.montant_paye) AS solde,
              to_char(v.cree_le AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM ventes v LEFT JOIN utilisateurs u ON u.id = v.utilisateur_id
        WHERE v.entreprise_id = $1
          AND ($2::date IS NULL OR (v.cree_le AT TIME ZONE $4)::date >= $2::date)
          AND ($3::date IS NULL OR (v.cree_le AT TIME ZONE $4)::date <= $3::date)
        ORDER BY v.id DESC LIMIT 200`,
      [ctx.user.entreprise_id, dateOuNull(ctx.query.du), dateOuNull(ctx.query.au), TZ],
    );
    return rows;
  });

  router.get('/api/ventes/:id', ...base, async (ctx) => {
    const id = int(ctx.params.id, 'vente', { min: 1 });
    const v = await db.query(
      `SELECT v.id, v.numero, v.total, v.mode_paiement, v.client_nom, v.client_telephone, u.nom_complet AS vendeur,
              v.hors_ligne, v.anomalie, v.anomalie_verifiee, v.rembourse, v.montant_paye,
              GREATEST(0, v.total - v.rembourse - v.montant_paye) AS solde,
              to_char(v.echeance, 'YYYY-MM-DD') AS echeance,
              to_char(v.cree_le AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM ventes v LEFT JOIN utilisateurs u ON u.id = v.utilisateur_id
        WHERE v.id = $1 AND v.entreprise_id = $2`,
      [id, ctx.user.entreprise_id, TZ],
    );
    if (!v.rows.length) throw new HttpError(404, 'Vente introuvable.');
    const l = await db.query(
      `SELECT l.id, l.nom_produit, l.quantite, l.prix_unitaire, l.sous_total,
              COALESCE((SELECT SUM(lr.quantite) FROM lignes_remboursement lr WHERE lr.ligne_vente_id = l.id), 0)::int AS deja_rembourse
         FROM lignes_vente l WHERE l.vente_id = $1 ORDER BY l.id`,
      [id],
    );
    const reg = await db.query(
      `SELECT r.id, r.montant, r.mode_paiement, u.nom_complet AS par, to_char(r.cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM reglements r LEFT JOIN utilisateurs u ON u.id = r.utilisateur_id WHERE r.vente_id = $1 ORDER BY r.id`,
      [id, TZ],
    );
    const rem = await db.query(
      `SELECT r.id, r.numero, r.motif, r.montant, r.credit_annule, r.montant_rendu, r.mode_paiement, r.remis_en_stock, u.nom_complet AS par,
              to_char(r.cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS cree_le,
              COALESCE((SELECT json_agg(json_build_object('nom_produit', lr.nom_produit, 'quantite', lr.quantite, 'prix_unitaire', lr.prix_unitaire, 'sous_total', lr.sous_total) ORDER BY lr.id)
                          FROM lignes_remboursement lr WHERE lr.remboursement_id = r.id), '[]'::json) AS lignes
         FROM remboursements r LEFT JOIN utilisateurs u ON u.id = r.utilisateur_id WHERE r.vente_id = $1 ORDER BY r.id`,
      [id, TZ],
    );
    return { ...v.rows[0], lignes: l.rows, reglements: reg.rows, remboursements: rem.rows };
  });

  // Fin d'inventaire : le propriétaire remet les statistiques du tableau de bord à zéro (aucune vente n'est supprimée)
  router.post('/api/tableau-de-bord/remise-a-zero', ...base, role('proprietaire'), async (ctx) => {
    const note = str(ctx.body.note, 'note', { optional: true, max: 255 });
    const eid = ctx.user.entreprise_id;
    const r = await db.tx(async (q) => {
      await q('UPDATE entreprises SET tableau_depuis = now() WHERE id = $1', [eid]);
      const t = await q('INSERT INTO tableau_remises (entreprise_id, utilisateur_id, note) VALUES ($1, $2, $3) RETURNING cree_le', [eid, ctx.user.id, note]);
      return t.rows[0];
    });
    realtime.publier(eid, 'tableau.remis', { par: ctx.user.id });
    ctx.status = 201;
    return { depuis: r.cree_le };
  });

  router.get('/api/tableau-de-bord', ...base, async (ctx) => {
    const eid = ctx.user.entreprise_id;
    // Après une remise à zéro (fin d'inventaire), les statistiques repartent de cette date. Les ventes, crédits et le stock restent intacts.
    const dep = await db.query(
      `SELECT e.tableau_depuis AS depuis, t.note, t.cree_le, COALESCE(u.nom_complet, 'Administration Best-Quinca') AS par
         FROM entreprises e
         LEFT JOIN LATERAL (SELECT * FROM tableau_remises WHERE entreprise_id = e.id ORDER BY id DESC LIMIT 1) t ON true
         LEFT JOIN utilisateurs u ON u.id = t.utilisateur_id
        WHERE e.id = $1`,
      [eid],
    );
    const depuis = dep.rows[0] && dep.rows[0].depuis ? dep.rows[0].depuis : null;
    const jour = `(cree_le AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date AND ($3::timestamptz IS NULL OR cree_le >= $3::timestamptz)`;
    const mois = `(cree_le AT TIME ZONE $2) >= date_trunc('month', now() AT TIME ZONE $2) AND ($3::timestamptz IS NULL OR cree_le >= $3::timestamptz)`;
    const [auj, moi, alerte, valeur, top, sept, faibles, aVerifier, creances, rembMois] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS nb, COALESCE(SUM(total), 0)::float8 AS total FROM ventes WHERE entreprise_id = $1 AND ${jour}`, [eid, TZ, depuis]),
      db.query(`SELECT COUNT(*)::int AS nb, COALESCE(SUM(total), 0)::float8 AS total FROM ventes WHERE entreprise_id = $1 AND ${mois}`, [eid, TZ, depuis]),
      db.query('SELECT COUNT(*)::int AS nb FROM produits WHERE entreprise_id = $1 AND actif AND quantite_stock <= seuil_alerte', [eid]),
      db.query('SELECT COALESCE(SUM(quantite_stock::float8 * prix_achat), 0)::float8 AS valeur FROM produits WHERE entreprise_id = $1 AND actif', [eid]),
      db.query(
        `SELECT l.nom_produit, SUM(l.quantite)::int AS quantite, SUM(l.sous_total)::float8 AS total
           FROM lignes_vente l JOIN ventes v ON v.id = l.vente_id
          WHERE v.entreprise_id = $1 AND (v.cree_le AT TIME ZONE $2) >= date_trunc('month', now() AT TIME ZONE $2)
            AND ($3::timestamptz IS NULL OR v.cree_le >= $3::timestamptz)
          GROUP BY l.nom_produit ORDER BY total DESC LIMIT 5`,
        [eid, TZ, depuis],
      ),
      db.query(
        `SELECT to_char((cree_le AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS jour, SUM(total)::float8 AS total
           FROM ventes WHERE entreprise_id = $1 AND (cree_le AT TIME ZONE $2)::date >= (now() AT TIME ZONE $2)::date - 6
            AND ($3::timestamptz IS NULL OR cree_le >= $3::timestamptz)
          GROUP BY 1 ORDER BY 1`,
        [eid, TZ, depuis],
      ),
      db.query(
        `SELECT id, nom, quantite_stock, seuil_alerte, unite FROM produits
          WHERE entreprise_id = $1 AND actif AND quantite_stock <= seuil_alerte ORDER BY quantite_stock, nom LIMIT 8`,
        [eid],
      ),
      db.query('SELECT COUNT(*)::int AS nb FROM ventes WHERE entreprise_id = $1 AND anomalie IS NOT NULL AND NOT anomalie_verifiee', [eid]),
      db.query(
        `SELECT COUNT(*)::int AS nb, COALESCE(SUM(GREATEST(0, total - rembourse - montant_paye)), 0)::float8 AS total
           FROM ventes WHERE entreprise_id = $1 AND mode_paiement = 'credit' AND total - rembourse - montant_paye > 0`,
        [eid],
      ),
      db.query(
        `SELECT COUNT(*)::int AS nb, COALESCE(SUM(montant), 0)::float8 AS total FROM remboursements
          WHERE entreprise_id = $1 AND (cree_le AT TIME ZONE $2) >= date_trunc('month', now() AT TIME ZONE $2)
            AND ($3::timestamptz IS NULL OR cree_le >= $3::timestamptz)`,
        [eid, TZ, depuis],
      ),
    ]);
    const proprio = ctx.user.role === 'proprietaire';
    return {
      aujourdhui: auj.rows[0],
      mois: moi.rows[0],
      stock_faible: alerte.rows[0].nb,
      valeur_stock: proprio ? valeur.rows[0].valeur : null,
      top_produits: top.rows,
      sept_jours: sept.rows,
      produits_faibles: faibles.rows,
      a_verifier: proprio ? aVerifier.rows[0].nb : 0,
      remise_a_zero: depuis ? { depuis: dep.rows[0].cree_le || depuis, par: dep.rows[0].par, note: dep.rows[0].note } : null,
      credits_en_cours: creances.rows[0],
      rembourse_mois: rembMois.rows[0],
    };
  });
};
