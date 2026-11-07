'use strict';
const db = require('../lib/db');
const { HttpError, str, int } = require('../lib/http');
const { auth, role, subscribed } = require('../lib/auth');
const { lireProduits } = require('../lib/csv');
const realtime = require('../lib/realtime');
const { SPONSOR_ACTIF } = require('../lib/sponsors');

// Prévient les autres appareils de l'entreprise (celui qui agit est déjà à jour : « par »)
const notifier = (ctx, type, extra) => realtime.publier(ctx.user.entreprise_id, type, { par: ctx.user.id, ...extra });

const proprio = role('proprietaire');
const base = [auth, subscribed];

async function checkCategorie(q, categorieId, entrepriseId) {
  if (categorieId === null) return;
  const r = await q('SELECT 1 FROM categories WHERE id = $1 AND entreprise_id = $2', [categorieId, entrepriseId]);
  if (!r.rows.length) throw new HttpError(400, 'Catégorie inconnue.');
}

// Un produit ne peut être rattaché qu'à un partenaire sous contrat
async function checkSponsor(q, sponsorId) {
  if (sponsorId === null) return;
  const r = await q(`SELECT 1 FROM sponsors s WHERE s.id = $1 AND ${SPONSOR_ACTIF}`, [sponsorId]);
  if (!r.rows.length) throw new HttpError(400, 'Partenaire inconnu ou contrat terminé.');
}

function readProduit(b, partiel = false) {
  const p = {};
  const need = (k) => !partiel || b[k] !== undefined;
  if (need('nom')) p.nom = str(b.nom, 'nom du produit', { max: 150 });
  if (need('reference')) p.reference = str(b.reference, 'référence', { optional: true, max: 50 });
  if (need('categorie_id')) p.categorie_id = int(b.categorie_id, 'catégorie', { optional: true, min: 1 });
  if (need('prix_achat')) p.prix_achat = int(b.prix_achat, "prix d'achat", { def: 0 });
  if (need('prix_vente')) p.prix_vente = int(b.prix_vente, 'prix de vente');
  if (need('seuil_alerte')) p.seuil_alerte = int(b.seuil_alerte, "seuil d'alerte", { def: 5 });
  if (need('sponsor_id')) p.sponsor_id = int(b.sponsor_id, 'partenaire', { optional: true, min: 1 });
  if (need('unite')) p.unite = str(b.unite, 'unité', { optional: true, max: 20 }) || 'pièce';
  return p;
}

module.exports = function register(router) {
  // ---- Catégories ----
  router.get('/api/categories', ...base, async (ctx) => {
    const { rows } = await db.query('SELECT id, nom FROM categories WHERE entreprise_id = $1 ORDER BY nom', [ctx.user.entreprise_id]);
    return rows;
  });

  router.post('/api/categories', ...base, proprio, async (ctx) => {
    const nom = str(ctx.body.nom, 'nom de la catégorie', { max: 100 });
    const { rows } = await db.query('INSERT INTO categories (entreprise_id, nom) VALUES ($1, $2) RETURNING id, nom', [ctx.user.entreprise_id, nom]);
    notifier(ctx, 'produits.modifies');
    ctx.status = 201;
    return rows[0];
  });

  router.delete('/api/categories/:id', ...base, proprio, async (ctx) => {
    const id = int(ctx.params.id, 'catégorie', { min: 1 });
    await db.query('DELETE FROM categories WHERE id = $1 AND entreprise_id = $2', [id, ctx.user.entreprise_id]);
    notifier(ctx, 'produits.modifies');
    return { ok: true };
  });

  // ---- Produits ----
  router.get('/api/produits', ...base, async (ctx) => {
    const qtxt = String(ctx.query.q || '').slice(0, 100).replace(/[\\%_]/g, '\\$&');
    const { rows } = await db.query(
      `SELECT p.id, p.nom, p.reference, p.categorie_id, c.nom AS categorie, p.prix_achat, p.prix_vente,
              p.quantite_stock, p.seuil_alerte, p.unite, p.actif, p.sponsor_id
         FROM produits p LEFT JOIN categories c ON c.id = p.categorie_id
        WHERE p.entreprise_id = $1
          AND ($2::boolean OR p.actif)
          AND ($3::text = '' OR p.nom ILIKE '%' || $3::text || '%' OR p.reference ILIKE '%' || $3::text || '%')
          AND (NOT $4::boolean OR p.quantite_stock <= p.seuil_alerte)
        ORDER BY p.nom LIMIT 1000`,
      [ctx.user.entreprise_id, ctx.query.archives === '1', qtxt, ctx.query.alerte === '1'],
    );
    // Le prix d'achat (marge) n'est visible que par le propriétaire
    if (ctx.user.role !== 'proprietaire') rows.forEach((r) => { r.prix_achat = null; });
    return rows;
  });

  router.post('/api/produits', ...base, proprio, async (ctx) => {
    const p = readProduit(ctx.body);
    const stockInitial = int(ctx.body.quantite_stock, 'stock initial', { def: 0 });
    const eid = ctx.user.entreprise_id;
    const created = await db.tx(async (q) => {
      await checkCategorie(q, p.categorie_id, eid);
      await checkSponsor(q, p.sponsor_id);
      const r = await q(
        `INSERT INTO produits (entreprise_id, categorie_id, nom, reference, prix_achat, prix_vente, quantite_stock, seuil_alerte, unite, sponsor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [eid, p.categorie_id, p.nom, p.reference, p.prix_achat, p.prix_vente, stockInitial, p.seuil_alerte, p.unite, p.sponsor_id],
      );
      if (stockInitial > 0) {
        await q(
          `INSERT INTO mouvements_stock (entreprise_id, produit_id, type, quantite, motif, utilisateur_id)
           VALUES ($1, $2, 'entree', $3, 'Stock initial', $4)`,
          [eid, r.rows[0].id, stockInitial, ctx.user.id],
        );
      }
      return r.rows[0];
    });
    notifier(ctx, 'produits.modifies');
    ctx.status = 201;
    return created;
  });

  // Import en masse depuis un fichier CSV. Avec simuler: true, rien n'est écrit : on renvoie seulement le compte rendu.
  router.post('/api/produits/import', ...base, proprio, async (ctx) => {
    const contenu = typeof ctx.body.contenu === 'string' ? ctx.body.contenu : '';
    if (!contenu.trim()) throw new HttpError(400, 'Aucun fichier reçu.');
    if (contenu.length > 900000) throw new HttpError(400, 'Fichier trop volumineux. Découpez-le en plusieurs fichiers.');
    const simuler = ctx.body.simuler === true;
    const { valides, refuses, total } = lireProduits(contenu);
    const eid = ctx.user.entreprise_id;

    const aImporter = [];
    const ignores = [...refuses];
    const resultat = await db.tx(async (q) => {
      // Doublons : par référence si le fichier en donne une, sinon par nom (sans tenir compte des majuscules)
      const ex = await q('SELECT lower(nom) AS nom, lower(reference) AS reference FROM produits WHERE entreprise_id = $1', [eid]);
      const refs = new Set(ex.rows.map((r) => r.reference).filter(Boolean));
      const noms = new Set(ex.rows.map((r) => r.nom));
      for (const p of valides) {
        const kRef = p.reference ? p.reference.toLowerCase() : null;
        const kNom = p.nom.toLowerCase();
        if (kRef ? refs.has(kRef) : noms.has(kNom)) {
          ignores.push({ ligne: p.ligne, nom: p.nom, raison: kRef ? `La référence « ${p.reference} » existe déjà (ou apparaît deux fois dans le fichier).` : 'Un produit de même nom existe déjà (ou apparaît deux fois dans le fichier).' });
          continue;
        }
        if (kRef) refs.add(kRef); else noms.add(kNom);
        aImporter.push(p);
      }
      if (simuler || !aImporter.length) return 0;

      // Catégories : on réutilise celles qui existent (sans tenir compte des majuscules), on crée les autres
      const cats = new Map((await q('SELECT id, nom FROM categories WHERE entreprise_id = $1', [eid])).rows.map((c) => [c.nom.toLowerCase(), c.id]));
      for (const p of aImporter) {
        if (!p.categorie || cats.has(p.categorie.toLowerCase())) continue;
        const c = await q('INSERT INTO categories (entreprise_id, nom) VALUES ($1, $2) RETURNING id', [eid, p.categorie]);
        cats.set(p.categorie.toLowerCase(), c.rows[0].id);
      }
      for (const p of aImporter) {
        const r = await q(
          `INSERT INTO produits (entreprise_id, categorie_id, nom, reference, prix_achat, prix_vente, quantite_stock, seuil_alerte, unite)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [eid, p.categorie ? cats.get(p.categorie.toLowerCase()) : null, p.nom, p.reference, p.prix_achat, p.prix_vente, p.stock, p.seuil, p.unite],
        );
        if (p.stock > 0) {
          await q(
            `INSERT INTO mouvements_stock (entreprise_id, produit_id, type, quantite, motif, utilisateur_id)
             VALUES ($1, $2, 'entree', $3, 'Stock initial (import)', $4)`,
            [eid, r.rows[0].id, p.stock, ctx.user.id],
          );
        }
      }
      return aImporter.length;
    });

    if (!simuler && resultat > 0) notifier(ctx, 'produits.modifies');
    ignores.sort((a, b) => a.ligne - b.ligne);
    return {
      simulation: simuler,
      total_lignes: total,
      a_importer: aImporter.length,
      importes: resultat,
      ignores: ignores.slice(0, 50),
      nb_ignores: ignores.length,
      apercu: aImporter.slice(0, 5).map((p) => ({ nom: p.nom, reference: p.reference, categorie: p.categorie, prix_vente: p.prix_vente, stock: p.stock })),
    };
  });

  router.put('/api/produits/:id', ...base, proprio, async (ctx) => {
    const id = int(ctx.params.id, 'produit', { min: 1 });
    const p = readProduit(ctx.body, true);
    if (ctx.body.actif !== undefined) p.actif = Boolean(ctx.body.actif);
    const cols = Object.keys(p);
    if (!cols.length) throw new HttpError(400, 'Aucune modification fournie.');
    const eid = ctx.user.entreprise_id;
    await db.tx(async (q) => {
      if (p.categorie_id !== undefined) await checkCategorie(q, p.categorie_id, eid);
      if (p.sponsor_id !== undefined) await checkSponsor(q, p.sponsor_id);
      const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
      const r = await q(`UPDATE produits SET ${sets} WHERE id = $1 AND entreprise_id = $2`, [id, eid, ...cols.map((c) => p[c])]);
      if (!r.rowCount) throw new HttpError(404, 'Produit introuvable.');
    });
    notifier(ctx, 'produits.modifies');
    return { ok: true };
  });

  // Un produit déjà vendu n'est jamais supprimé : il est archivé
  router.delete('/api/produits/:id', ...base, proprio, async (ctx) => {
    const id = int(ctx.params.id, 'produit', { min: 1 });
    const r = await db.query('UPDATE produits SET actif = false WHERE id = $1 AND entreprise_id = $2', [id, ctx.user.entreprise_id]);
    if (!r.rowCount) throw new HttpError(404, 'Produit introuvable.');
    notifier(ctx, 'produits.modifies');
    return { ok: true };
  });

  // ---- Mouvements de stock ----
  router.post('/api/produits/:id/stock', ...base, async (ctx) => {
    const id = int(ctx.params.id, 'produit', { min: 1 });
    const type = str(ctx.body.type, 'type de mouvement', { max: 20 });
    if (!['entree', 'sortie', 'ajustement'].includes(type)) throw new HttpError(400, 'Type de mouvement invalide.');
    if (type === 'ajustement' && ctx.user.role !== 'proprietaire') throw new HttpError(403, 'Seul le propriétaire peut corriger le stock.');
    const quantite = int(ctx.body.quantite, 'quantité', { min: type === 'ajustement' ? 0 : 1 });
    const motif = str(ctx.body.motif, 'motif', { optional: true, max: 255 });
    const eid = ctx.user.entreprise_id;

    const result = await db.tx(async (q) => {
      const cur = await q('SELECT quantite_stock FROM produits WHERE id = $1 AND entreprise_id = $2 FOR UPDATE', [id, eid]);
      if (!cur.rows.length) throw new HttpError(404, 'Produit introuvable.');
      const avant = cur.rows[0].quantite_stock;
      let delta;
      if (type === 'entree') delta = quantite;
      else if (type === 'sortie') delta = -quantite;
      else delta = quantite - avant;
      const apres = avant + delta;
      if (apres < 0) throw new HttpError(400, `Stock insuffisant : il reste ${avant} en stock.`);
      await q('UPDATE produits SET quantite_stock = $1 WHERE id = $2', [apres, id]);
      await q(
        `INSERT INTO mouvements_stock (entreprise_id, produit_id, type, quantite, motif, utilisateur_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [eid, id, type, delta, motif, ctx.user.id],
      );
      return { quantite_stock: apres };
    });
    notifier(ctx, 'stock.modifie', { produit_id: id });
    ctx.status = 201;
    return result;
  });

  router.get('/api/mouvements', ...base, async (ctx) => {
    const produitId = ctx.query.produit_id ? int(ctx.query.produit_id, 'produit', { min: 1 }) : null;
    const { rows } = await db.query(
      `SELECT m.id, m.type, m.quantite, m.motif, p.nom AS produit, u.nom_complet AS utilisateur,
              to_char(m.cree_le AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM mouvements_stock m
         JOIN produits p ON p.id = m.produit_id
         LEFT JOIN utilisateurs u ON u.id = m.utilisateur_id
        WHERE m.entreprise_id = $1 AND ($2::int IS NULL OR m.produit_id = $2::int)
        ORDER BY m.id DESC LIMIT 100`,
      [ctx.user.entreprise_id, produitId, require('../lib/tz').TZ],
    );
    return rows;
  });
};
