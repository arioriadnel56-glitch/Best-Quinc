'use strict';
const db = require('../lib/db');
const { HttpError, str, int } = require('../lib/http');
const { auth, role, subscribed } = require('../lib/auth');
const { TZ } = require('../lib/tz');
const realtime = require('../lib/realtime');

const base = [auth, subscribed];
const proprio = (ctx) => ctx.user.role === 'proprietaire';

module.exports = function register(router) {
  // Liste des inventaires (les plus récents d'abord) : le propriétaire voit les écarts et leur valeur
  router.get('/api/inventaires', ...base, async (ctx) => {
    const { rows } = await db.query(
      `SELECT i.id, i.numero, i.statut, i.note, i.tableau_remis, u.nom_complet AS cree_par_nom,
              to_char(i.cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS cree_le,
              to_char(i.termine_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS termine_le,
              (SELECT COUNT(*)::int FROM lignes_inventaire l WHERE l.inventaire_id = i.id) AS nb_lignes,
              (SELECT COUNT(*)::int FROM lignes_inventaire l WHERE l.inventaire_id = i.id AND l.quantite_comptee IS NOT NULL) AS nb_comptees,
              (SELECT COUNT(*)::int FROM lignes_inventaire l WHERE l.inventaire_id = i.id AND l.quantite_comptee IS NOT NULL AND l.quantite_comptee <> l.stock_au_comptage) AS nb_ecarts,
              (SELECT COALESCE(SUM((l.quantite_comptee - l.stock_au_comptage)::float8 * l.prix_achat), 0) FROM lignes_inventaire l WHERE l.inventaire_id = i.id AND l.quantite_comptee IS NOT NULL) AS valeur_ecart
         FROM inventaires i LEFT JOIN utilisateurs u ON u.id = i.cree_par
        WHERE i.entreprise_id = $1 ORDER BY i.id DESC LIMIT 30`,
      [ctx.user.entreprise_id, TZ],
    );
    const owner = proprio(ctx);
    return rows.map((r) => (owner ? r : { ...r, nb_ecarts: null, valeur_ecart: null }));
  });

  // Détail : comptage à l'aveugle pour la secrétaire tant que l'inventaire est en cours (elle ne voit pas le stock théorique)
  router.get('/api/inventaires/:id', ...base, async (ctx) => {
    const id = int(ctx.params.id, 'inventaire', { min: 1 });
    const inv = await db.query(
      `SELECT i.id, i.numero, i.statut, i.note, i.tableau_remis, u.nom_complet AS cree_par_nom, v.nom_complet AS valide_par_nom,
              to_char(i.cree_le AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS cree_le,
              to_char(i.termine_le AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS termine_le
         FROM inventaires i LEFT JOIN utilisateurs u ON u.id = i.cree_par LEFT JOIN utilisateurs v ON v.id = i.valide_par
        WHERE i.id = $1 AND i.entreprise_id = $2`,
      [id, ctx.user.entreprise_id, TZ],
    );
    if (!inv.rows.length) throw new HttpError(404, 'Inventaire introuvable.');
    const i = inv.rows[0];
    const aveugle = !proprio(ctx) && i.statut === 'en_cours';
    const l = await db.query(
      `SELECT l.id, l.nom_produit, l.categorie, l.unite, l.prix_achat, l.quantite_comptee, l.stock_au_comptage, l.ecart_applique,
              p.quantite_stock AS stock_actuel, uc.nom_complet AS compte_par_nom,
              to_char(l.compte_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS compte_le
         FROM lignes_inventaire l LEFT JOIN produits p ON p.id = l.produit_id LEFT JOIN utilisateurs uc ON uc.id = l.compte_par
        WHERE l.inventaire_id = $1 ORDER BY l.categorie NULLS LAST, l.nom_produit`,
      [id, TZ],
    );
    const owner = proprio(ctx);
    const lignes = l.rows.map((r) => {
      const theorique = r.quantite_comptee !== null ? r.stock_au_comptage : r.stock_actuel;
      const out = { id: r.id, nom_produit: r.nom_produit, categorie: r.categorie, unite: r.unite, quantite_comptee: r.quantite_comptee, compte_par_nom: r.compte_par_nom, compte_le: r.compte_le };
      if (!aveugle) {
        out.theorique = theorique;
        out.ecart = r.quantite_comptee !== null && theorique !== null ? r.quantite_comptee - theorique : null;
        out.ecart_applique = r.ecart_applique;
        if (owner) out.valeur_ecart = out.ecart !== null ? out.ecart * r.prix_achat : null;
      }
      return out;
    });
    return { ...i, aveugle, lignes };
  });

  router.post('/api/inventaires', ...base, role('proprietaire'), async (ctx) => {
    const note = str(ctx.body.note, 'note', { optional: true, max: 255 });
    const eid = ctx.user.entreprise_id;
    let r;
    try {
      r = await db.tx(async (q) => {
        await q('SELECT id FROM entreprises WHERE id = $1 FOR UPDATE', [eid]);
        const deja = await q("SELECT id FROM inventaires WHERE entreprise_id = $1 AND statut = 'en_cours'", [eid]);
        if (deja.rows.length) throw new HttpError(409, 'Un inventaire est déjà en cours : terminez-le ou annulez-le d\'abord.');
        const n = await q('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM inventaires WHERE entreprise_id = $1', [eid]);
        const inv = await q('INSERT INTO inventaires (entreprise_id, numero, note, cree_par) VALUES ($1, $2, $3, $4) RETURNING id, numero', [eid, n.rows[0].n, note, ctx.user.id]);
        const ins = await q(
          `INSERT INTO lignes_inventaire (inventaire_id, produit_id, nom_produit, categorie, unite, prix_achat)
           SELECT $1, p.id, p.nom, c.nom, p.unite, p.prix_achat FROM produits p LEFT JOIN categories c ON c.id = p.categorie_id
            WHERE p.entreprise_id = $2 AND p.actif`,
          [inv.rows[0].id, eid],
        );
        if (!ins.rowCount) throw new HttpError(400, 'Aucun produit à inventorier : ajoutez d\'abord des produits.');
        return inv.rows[0];
      });
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'Un inventaire est déjà en cours.');
      throw err;
    }
    realtime.publier(eid, 'inventaire.change', { par: ctx.user.id });
    ctx.status = 201;
    return r;
  });

  // Saisie d'un comptage (propriétaire ou secrétaire). quantite = null efface le comptage de la ligne.
  router.put('/api/inventaires/:id/lignes/:ligne', ...base, async (ctx) => {
    const id = int(ctx.params.id, 'inventaire', { min: 1 });
    const lid = int(ctx.params.ligne, 'ligne', { min: 1 });
    const efface = ctx.body.quantite === null;
    const quantite = efface ? null : int(ctx.body.quantite, 'quantité comptée', { min: 0, max: 100000000 });
    const eid = ctx.user.entreprise_id;
    const res = await db.tx(async (q) => {
      const inv = await q('SELECT statut FROM inventaires WHERE id = $1 AND entreprise_id = $2 FOR SHARE', [id, eid]);
      if (!inv.rows.length) throw new HttpError(404, 'Inventaire introuvable.');
      if (inv.rows[0].statut !== 'en_cours') throw new HttpError(409, 'Cet inventaire est terminé : le comptage est fermé.');
      const l = await q('SELECT l.id, l.produit_id, p.quantite_stock FROM lignes_inventaire l LEFT JOIN produits p ON p.id = l.produit_id WHERE l.id = $1 AND l.inventaire_id = $2 FOR UPDATE OF l', [lid, id]);
      if (!l.rows.length) throw new HttpError(404, 'Ligne introuvable.');
      if (efface) {
        await q('UPDATE lignes_inventaire SET quantite_comptee = NULL, stock_au_comptage = NULL, compte_par = NULL, compte_le = NULL WHERE id = $1', [lid]);
        return { quantite_comptee: null };
      }
      // Le stock théorique est figé au moment du comptage : les ventes faites ensuite sont rajoutées à la validation
      await q('UPDATE lignes_inventaire SET quantite_comptee = $1, stock_au_comptage = $2, compte_par = $3, compte_le = now() WHERE id = $4', [quantite, l.rows[0].quantite_stock === null ? 0 : l.rows[0].quantite_stock, ctx.user.id, lid]);
      return { quantite_comptee: quantite, ecart: proprio(ctx) ? quantite - (l.rows[0].quantite_stock || 0) : undefined };
    });
    realtime.publier(eid, 'inventaire.change', { par: ctx.user.id });
    return res;
  });

  // Validation : le stock est corrigé pour chaque produit compté (en tenant compte des ventes faites après le comptage)
  router.post('/api/inventaires/:id/valider', ...base, role('proprietaire'), async (ctx) => {
    const id = int(ctx.params.id, 'inventaire', { min: 1 });
    const remettre = ctx.body.remettre_tableau_a_zero === true;
    const eid = ctx.user.entreprise_id;
    const res = await db.tx(async (q) => {
      const inv = await q('SELECT id, numero, statut FROM inventaires WHERE id = $1 AND entreprise_id = $2 FOR UPDATE', [id, eid]);
      if (!inv.rows.length) throw new HttpError(404, 'Inventaire introuvable.');
      if (inv.rows[0].statut !== 'en_cours') throw new HttpError(409, 'Cet inventaire est déjà terminé.');
      const lignes = await q('SELECT * FROM lignes_inventaire WHERE inventaire_id = $1 AND quantite_comptee IS NOT NULL AND produit_id IS NOT NULL ORDER BY produit_id', [id]);
      if (!lignes.rows.length) throw new HttpError(400, 'Comptez au moins un produit avant de valider l\'inventaire.');
      let ecarts = 0, valeur = 0, corriges = 0;
      for (const l of lignes.rows) {
        const p = await q('SELECT quantite_stock FROM produits WHERE id = $1 AND entreprise_id = $2 FOR UPDATE', [l.produit_id, eid]);
        if (!p.rows.length) continue;
        const apres = await q('SELECT COALESCE(SUM(quantite), 0)::int AS s FROM mouvements_stock WHERE produit_id = $1 AND cree_le > $2', [l.produit_id, l.compte_le]);
        const cible = Math.max(0, l.quantite_comptee + apres.rows[0].s);
        const delta = cible - p.rows[0].quantite_stock;
        if (l.quantite_comptee !== l.stock_au_comptage) { ecarts += 1; valeur += (l.quantite_comptee - l.stock_au_comptage) * l.prix_achat; }
        if (delta !== 0) {
          await q('UPDATE produits SET quantite_stock = $1 WHERE id = $2', [cible, l.produit_id]);
          await q(
            `INSERT INTO mouvements_stock (entreprise_id, produit_id, type, quantite, motif, utilisateur_id) VALUES ($1, $2, 'ajustement', $3, $4, $5)`,
            [eid, l.produit_id, delta, `Inventaire n°${inv.rows[0].numero} : compté ${l.quantite_comptee}, théorique ${l.stock_au_comptage}`, ctx.user.id],
          );
          corriges += 1;
        }
        await q('UPDATE lignes_inventaire SET ecart_applique = $1 WHERE id = $2', [delta, l.id]);
      }
      await q("UPDATE inventaires SET statut = 'valide', termine_le = now(), valide_par = $1, tableau_remis = $2 WHERE id = $3", [ctx.user.id, remettre, id]);
      if (remettre) {
        await q('UPDATE entreprises SET tableau_depuis = now() WHERE id = $1', [eid]);
        await q('INSERT INTO tableau_remises (entreprise_id, utilisateur_id, note) VALUES ($1, $2, $3)', [eid, ctx.user.id, `Fin de l'inventaire n°${inv.rows[0].numero}`]);
      }
      const total = await q('SELECT COUNT(*)::int AS n FROM lignes_inventaire WHERE inventaire_id = $1', [id]);
      return { numero: inv.rows[0].numero, comptes: lignes.rows.length, non_comptes: total.rows[0].n - lignes.rows.length, ecarts, stocks_corriges: corriges, valeur_ecart: valeur, tableau_remis: remettre };
    });
    realtime.publier(eid, 'inventaire.change', { par: ctx.user.id });
    if (res.tableau_remis) realtime.publier(eid, 'tableau.remis', { par: ctx.user.id });
    return res;
  });

  // Nettoie l'historique : seul un inventaire annulé peut être supprimé (un inventaire validé a corrigé le stock : on le garde comme preuve)
  router.delete('/api/inventaires/:id', ...base, role('proprietaire'), async (ctx) => {
    const id = int(ctx.params.id, 'inventaire', { min: 1 });
    const r = await db.query("DELETE FROM inventaires WHERE id = $1 AND entreprise_id = $2 AND statut = 'annule'", [id, ctx.user.entreprise_id]);
    if (!r.rowCount) throw new HttpError(409, 'Seul un inventaire annulé peut être supprimé.');
    realtime.publier(ctx.user.entreprise_id, 'inventaire.change', { par: ctx.user.id });
    return { ok: true };
  });

  router.post('/api/inventaires/:id/annuler', ...base, role('proprietaire'), async (ctx) => {
    const id = int(ctx.params.id, 'inventaire', { min: 1 });
    const r = await db.query("UPDATE inventaires SET statut = 'annule', termine_le = now(), valide_par = $3 WHERE id = $1 AND entreprise_id = $2 AND statut = 'en_cours'", [id, ctx.user.entreprise_id, ctx.user.id]);
    if (!r.rowCount) throw new HttpError(404, 'Aucun inventaire en cours à annuler.');
    realtime.publier(ctx.user.entreprise_id, 'inventaire.change', { par: ctx.user.id });
    return { ok: true };
  });
};
