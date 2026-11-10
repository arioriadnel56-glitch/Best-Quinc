'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../lib/db');
const { HttpError, str, int } = require('../lib/http');
const { auth, authAdmin, role, subscribed } = require('../lib/auth');
const { lireImage } = require('../lib/images');
const { limit } = require('../lib/ratelimit');
const { TZ } = require('../lib/tz');
const realtime = require('../lib/realtime');
const S = require('../lib/sponsors');

const sponsorHtml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'sponsor.html'), 'utf8');
const proprio = role('proprietaire');
const base = [auth, subscribed];
const nouveauJeton = () => crypto.randomBytes(24).toString('hex');

const LOGO = '(si.sponsor_id IS NOT NULL) AS a_logo, (EXTRACT(EPOCH FROM si.modifie_le))::bigint AS logo_v';

async function tracer(entrepriseId, offreIds, type) {
  if (!offreIds.length) return;
  await db.query(
    'INSERT INTO sponsor_evenements (offre_id, entreprise_id, type) SELECT unnest($1::int[]), $2::int, $3::text ON CONFLICT DO NOTHING',
    [offreIds, entrepriseId, type],
  );
}

function champsSponsor(b) {
  const debut = S.dateOptionnelle(b.debut, 'début du contrat');
  const fin = S.dateOptionnelle(b.fin, 'fin du contrat');
  if (debut && fin && fin < debut) throw new HttpError(400, 'La fin du contrat est avant son début.');
  return {
    nom: str(b.nom, 'nom du partenaire', { min: 2, max: 120 }),
    description: str(b.description, 'description', { optional: true, max: 500 }),
    site_web: S.siteWeb(b.site_web),
    telephone_commande: S.telephoneInternational(b.telephone_commande),
    debut,
    fin,
  };
}

function champsOffre(b) {
  const debut = S.dateOptionnelle(b.debut, 'début de l\'offre');
  const fin = S.dateOptionnelle(b.fin, 'fin de l\'offre');
  if (debut && fin && fin < debut) throw new HttpError(400, 'La fin de l\'offre est avant son début.');
  return {
    titre: str(b.titre, 'titre de l\'offre', { min: 2, max: 120 }),
    texte: str(b.texte, 'texte de l\'offre', { optional: true, max: 300 }),
    debut,
    fin,
  };
}

module.exports = function register(router) {
  // =====================================================================
  // Côté boutique
  // =====================================================================

  router.get('/api/partenaires', ...base, async (ctx) => {
    const s = await db.query(
      `SELECT s.id, s.nom, s.description, s.site_web, ${LOGO}
         FROM sponsors s LEFT JOIN sponsor_images si ON si.sponsor_id = s.id
        WHERE ${S.SPONSOR_ACTIF} ORDER BY s.nom`,
    );
    const o = await db.query(
      `SELECT o.id, o.sponsor_id, o.titre, o.texte, to_char(o.fin, 'YYYY-MM-DD') AS fin
         FROM sponsor_offres o JOIN sponsors s ON s.id = o.sponsor_id
        WHERE ${S.SPONSOR_ACTIF} AND ${S.OFFRE_ACTIVE} ORDER BY o.id DESC`,
    );
    await tracer(ctx.user.entreprise_id, o.rows.map((r) => r.id), 'vue');
    return { partenaires: s.rows, offres: o.rows };
  });

  router.get('/api/partenaires/marques', ...base, async () => {
    const { rows } = await db.query(`SELECT s.id, s.nom FROM sponsors s WHERE ${S.SPONSOR_ACTIF} ORDER BY s.nom`);
    return rows;
  });

  router.get('/api/partenaires/banniere', ...base, async (ctx) => {
    const { rows } = await db.query(
      `SELECT o.id, o.titre, o.texte, s.id AS sponsor_id, s.nom AS sponsor, ${LOGO}
         FROM sponsor_offres o JOIN sponsors s ON s.id = o.sponsor_id
         LEFT JOIN sponsor_images si ON si.sponsor_id = s.id
        WHERE ${S.SPONSOR_ACTIF} AND ${S.OFFRE_ACTIVE}
        ORDER BY md5(o.id::text || CURRENT_DATE::text || $1::text) LIMIT 1`,
      [String(ctx.user.entreprise_id)],
    );
    if (rows.length) await tracer(ctx.user.entreprise_id, [rows[0].id], 'vue');
    return { offre: rows[0] || null };
  });

  router.post('/api/partenaires/offres/:id/clic', ...base, async (ctx) => {
    await limit(`clic:${ctx.user.entreprise_id}`, 300, 3600 * 1000);
    const id = int(ctx.params.id, 'offre', { min: 1 });
    await db.query(
      `INSERT INTO sponsor_evenements (offre_id, entreprise_id, type)
       SELECT o.id, $2::int, 'clic' FROM sponsor_offres o JOIN sponsors s ON s.id = o.sponsor_id
        WHERE o.id = $1 AND ${S.SPONSOR_ACTIF} AND ${S.OFFRE_ACTIVE} ON CONFLICT DO NOTHING`,
      [id, ctx.user.entreprise_id],
    );
    return { ok: true };
  });

  router.get('/partenaires/:id/logo', async (ctx) => {
    const id = int(ctx.params.id, 'partenaire', { min: 1 });
    const { rows } = await db.query('SELECT logo, logo_type FROM sponsor_images WHERE sponsor_id = $1', [id]);
    const r = rows[0];
    if (!r || !Buffer.isBuffer(r.logo)) throw new HttpError(404, 'Logo introuvable.');
    ctx.raw = { status: 200, headers: { 'Content-Type': r.logo_type, 'Cache-Control': 'public, max-age=3600' }, body: r.logo };
  });

  router.get('/api/reassort', ...base, async (ctx) => {
    const { rows } = await db.query(
      `SELECT p.id, p.nom, p.unite, p.quantite_stock, p.seuil_alerte, s.id AS sponsor_id, s.nom AS sponsor,
              (s.telephone_commande IS NOT NULL) AS peut_commander
         FROM produits p JOIN sponsors s ON s.id = p.sponsor_id
        WHERE p.entreprise_id = $1 AND p.actif AND p.quantite_stock <= p.seuil_alerte AND ${S.SPONSOR_ACTIF}
        ORDER BY s.nom, p.nom`,
      [ctx.user.entreprise_id],
    );
    const groupes = new Map();
    for (const r of rows) {
      if (!groupes.has(r.sponsor_id)) groupes.set(r.sponsor_id, { sponsor_id: r.sponsor_id, sponsor: r.sponsor, peut_commander: r.peut_commander, produits: [] });
      groupes.get(r.sponsor_id).produits.push({
        id: r.id, nom: r.nom, unite: r.unite, stock: r.quantite_stock, seuil: r.seuil_alerte,
        quantite_suggeree: Math.max(r.seuil_alerte * 2 - r.quantite_stock, 1),
      });
    }
    return [...groupes.values()];
  });

  router.post('/api/reassort/commandes', ...base, proprio, async (ctx) => {
    const eid = ctx.user.entreprise_id;
    await limit(`reassort:${eid}`, 30, 3600 * 1000);
    const sponsorId = int(ctx.body.sponsor_id, 'partenaire', { min: 1 });
    const note = str(ctx.body.note, 'note', { optional: true, max: 300 });
    const brut = Array.isArray(ctx.body.lignes) ? ctx.body.lignes : [];
    if (!brut.length || brut.length > 30) throw new HttpError(400, 'Choisissez entre 1 et 30 produits.');
    const demandes = brut.map((l) => ({
      produit_id: int(l && l.produit_id, 'produit', { min: 1 }),
      quantite: int(l && l.quantite, 'quantité', { min: 1, max: 100000 }),
    }));
    const ids = demandes.map((l) => l.produit_id);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Un produit est présent deux fois dans la commande.');

    const sp = await db.query(`SELECT s.id, s.nom, s.telephone_commande FROM sponsors s WHERE s.id = $1 AND ${S.SPONSOR_ACTIF}`, [sponsorId]);
    if (!sp.rows.length) throw new HttpError(404, 'Partenaire introuvable ou contrat terminé.');
    if (!sp.rows[0].telephone_commande) throw new HttpError(400, 'Ce partenaire n\'a pas encore de numéro pour recevoir les commandes.');

    const prods = await db.query(
      'SELECT id, nom, unite FROM produits WHERE entreprise_id = $1 AND sponsor_id = $2 AND actif AND id = ANY($3::int[])',
      [eid, sponsorId, ids],
    );
    if (prods.rows.length !== ids.length) throw new HttpError(400, 'Un des produits n\'est pas lié à ce partenaire.');
    const parId = new Map(prods.rows.map((p) => [p.id, p]));
    const lignes = demandes.map((l) => ({ produit_id: l.produit_id, nom: parId.get(l.produit_id).nom, unite: parId.get(l.produit_id).unite, quantite: l.quantite }));

    const ent = (await db.query('SELECT nom, ville, telephone FROM entreprises WHERE id = $1', [eid])).rows[0];
    const { rows } = await db.query(
      'INSERT INTO commandes_reassort (entreprise_id, sponsor_id, utilisateur_id, lignes, note) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id',
      [eid, sponsorId, ctx.user.id, JSON.stringify(lignes), note],
    );
    const message = S.messageCommande({ entreprise: ent, utilisateur: ctx.user.nom_complet, lignes, note });
    realtime.publierAdmins('commande.reassort', { sponsor: sp.rows[0].nom, entreprise: ent.nom });
    ctx.status = 201;
    return { id: rows[0].id, message, lien_whatsapp: S.lienWhatsapp(sp.rows[0].telephone_commande, message) };
  });

  router.get('/api/reassort/commandes', ...base, async (ctx) => {
    const { rows } = await db.query(
      `SELECT c.id, s.nom AS sponsor, c.lignes, c.note, to_char(c.cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM commandes_reassort c JOIN sponsors s ON s.id = c.sponsor_id
        WHERE c.entreprise_id = $1 ORDER BY c.id DESC LIMIT 30`,
      [ctx.user.entreprise_id, TZ],
    );
    return rows;
  });

  router.put('/api/entreprise/partage-stats', auth, proprio, async (ctx) => {
    if (typeof ctx.body.actif !== 'boolean') throw new HttpError(400, 'Valeur invalide.');
    await db.query('UPDATE entreprises SET partage_stats = $1 WHERE id = $2', [ctx.body.actif, ctx.user.entreprise_id]);
    return { partage_stats: ctx.body.actif };
  });

  // =====================================================================
  // Super admin (Protéges par authAdmin)
  // =====================================================================
  router.get('/api/admin/sponsors', authAdmin, async () => {
    const { rows } = await db.query(
      `SELECT s.id, s.nom, s.description, s.site_web, s.telephone_commande, s.statut, s.jeton_rapport,
              to_char(s.debut, 'YYYY-MM-DD') AS debut, to_char(s.fin, 'YYYY-MM-DD') AS fin, ${LOGO},
              (SELECT COUNT(*) FROM sponsor_offres o WHERE o.sponsor_id = s.id AND o.actif)::int AS nb_offres,
              (SELECT COUNT(DISTINCT p.entreprise_id) FROM produits p WHERE p.sponsor_id = s.id)::int AS nb_boutiques,
              (SELECT COUNT(*) FROM commandes_reassort c WHERE c.sponsor_id = s.id)::int AS nb_commandes
         FROM sponsors s LEFT JOIN sponsor_images si ON si.sponsor_id = s.id ORDER BY s.id DESC`,
    );
    return rows;
  });

  router.post('/api/admin/sponsors', authAdmin, async (ctx) => {
    const c = champsSponsor(ctx.body);
    const { rows } = await db.query(
      `INSERT INTO sponsors (nom, description, site_web, telephone_commande, debut, fin, jeton_rapport)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [c.nom, c.description, c.site_web, c.telephone_commande, c.debut, c.fin, nouveauJeton()],
    );
    console.log(`[admin ${ctx.admin.email}] partenaire créé : ${c.nom}`);
    ctx.status = 201;
    return rows[0];
  });

  router.put('/api/admin/sponsors/:id', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'partenaire', { min: 1 });
    const c = champsSponsor(ctx.body);
    const statut = ctx.body.statut === undefined ? 'actif' : ctx.body.statut;
    if (!['actif', 'suspendu'].includes(statut)) throw new HttpError(400, 'Statut invalide.');
    const r = await db.query(
      `UPDATE sponsors SET nom = $2, description = $3, site_web = $4, telephone_commande = $5, debut = $6, fin = $7, statut = $8 WHERE id = $1`,
      [id, c.nom, c.description, c.site_web, c.telephone_commande, c.debut, c.fin, statut],
    );
    if (!r.rowCount) throw new HttpError(404, 'Partenaire introuvable.');
    console.log(`[admin ${ctx.admin.email}] partenaire ${id} modifié (${statut})`);
    return { ok: true };
  });

  router.post('/api/admin/sponsors/:id/jeton', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'partenaire', { min: 1 });
    const jeton = nouveauJeton();
    const r = await db.query('UPDATE sponsors SET jeton_rapport = $2 WHERE id = $1', [id, jeton]);
    if (!r.rowCount) throw new HttpError(404, 'Partenaire introuvable.');
    console.log(`[admin ${ctx.admin.email}] adresse de rapport renouvelée pour le partenaire ${id}`);
    return { jeton_rapport: jeton };
  });

  router.put('/api/admin/sponsors/:id/logo', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'partenaire', { min: 1 });
    const logo = lireImage(ctx.body.logo, 'logo', { maxOctets: 300 * 1024, maxCote: 1024 });
    const existe = await db.query('SELECT 1 FROM sponsors WHERE id = $1', [id]);
    if (!existe.rows.length) throw new HttpError(404, 'Partenaire introuvable.');
    await db.query(
      `INSERT INTO sponsor_images (sponsor_id, logo, logo_type) VALUES ($1, $2, $3)
       ON CONFLICT (sponsor_id) DO UPDATE SET logo = EXCLUDED.logo, logo_type = EXCLUDED.logo_type, modifie_le = now()`,
      [id, logo.buf, logo.type],
    );
    return { ok: true };
  });

  router.delete('/api/admin/sponsors/:id/logo', authAdmin, async (ctx) => {
    await db.query('DELETE FROM sponsor_images WHERE sponsor_id = $1', [int(ctx.params.id, 'partenaire', { min: 1 })]);
    return { ok: true };
  });

  router.get('/api/admin/sponsors/:id/offres', authAdmin, async (ctx) => {
    const { rows } = await db.query(
      `SELECT o.id, o.titre, o.texte, o.actif, to_char(o.debut, 'YYYY-MM-DD') AS debut, to_char(o.fin, 'YYYY-MM-DD') AS fin,
              (SELECT COUNT(DISTINCT x.entreprise_id) FROM sponsor_evenements x WHERE x.offre_id = o.id AND x.type = 'vue')::int AS vues,
              (SELECT COUNT(DISTINCT x.entreprise_id) FROM sponsor_evenements x WHERE x.offre_id = o.id AND x.type = 'clic')::int AS clics
         FROM sponsor_offres o WHERE o.sponsor_id = $1 ORDER BY o.id DESC`,
      [int(ctx.params.id, 'partenaire', { min: 1 })],
    );
    return rows;
  });

  router.post('/api/admin/sponsors/:id/offres', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'partenaire', { min: 1 });
    const o = champsOffre(ctx.body);
    const existe = await db.query('SELECT 1 FROM sponsors WHERE id = $1', [id]);
    if (!existe.rows.length) throw new HttpError(404, 'Partenaire introuvable.');
    const { rows } = await db.query(
      'INSERT INTO sponsor_offres (sponsor_id, titre, texte, debut, fin) VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5) RETURNING id',
      [id, o.titre, o.texte, o.debut, o.fin],
    );
    ctx.status = 201;
    return rows[0];
  });

  router.put('/api/admin/offres/:id', authAdmin, async (ctx) => {
    const id = int(ctx.params.id, 'offre', { min: 1 });
    const o = champsOffre(ctx.body);
    const actif = ctx.body.actif === undefined ? true : Boolean(ctx.body.actif);
    const r = await db.query(
      'UPDATE sponsor_offres SET titre = $2, texte = $3, debut = COALESCE($4::date, debut), fin = $5, actif = $6 WHERE id = $1',
      [id, o.titre, o.texte, o.debut, o.fin, actif],
    );
    if (!r.rowCount) throw new HttpError(404, 'Offre introuvable.');
    return { ok: true };
  });

  router.delete('/api/admin/offres/:id', authAdmin, async (ctx) => {
    await db.query('DELETE FROM sponsor_offres WHERE id = $1', [int(ctx.params.id, 'offre', { min: 1 })]);
    return { ok: true };
  });

  router.get('/api/admin/sponsors/:id/commandes', authAdmin, async (ctx) => {
    const { rows } = await db.query(
      `SELECT c.id, e.nom AS entreprise, e.telephone, c.lignes, c.note, to_char(c.cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM commandes_reassort c JOIN entreprises e ON e.id = c.entreprise_id
        WHERE c.sponsor_id = $1 ORDER BY c.id DESC LIMIT 100`,
      [int(ctx.params.id, 'partenaire', { min: 1 }), TZ],
    );
    return rows;
  });

  // =====================================================================
  // Rapport du partenaire (adresse secrète, aucune connexion)
  // =====================================================================
  router.get('/sponsor/:jeton', async (ctx) => {
    ctx.raw = {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      },
      body: sponsorHtml,
    };
  });

  router.get('/api/rapport-sponsor/:jeton', async (ctx) => {
    await limit(`rapport:${ctx.ip}`, 60, 60 * 1000);
    const jeton = String(ctx.params.jeton);
    if (!/^[0-9a-f]{48}$/.test(jeton)) throw new HttpError(404, 'Rapport introuvable.');
    const sp = await db.query(
      `SELECT s.id, s.nom, ${LOGO} FROM sponsors s LEFT JOIN sponsor_images si ON si.sponsor_id = s.id
        WHERE s.jeton_rapport = $1 AND s.statut = 'actif'`,
      [jeton],
    );
    if (!sp.rows.length) throw new HttpError(404, 'Rapport introuvable.');
    const sponsor = sp.rows[0];
    const sid = sponsor.id;
    const K = S.SEUIL_ANONYMAT;

    const reseau = await db.query(
      `SELECT COUNT(DISTINCT e.id)::int AS nb FROM entreprises e JOIN produits p ON p.entreprise_id = e.id AND p.sponsor_id = $1
        WHERE e.partage_stats = true AND e.statut = 'actif'`,
      [sid],
    );
    const nbBoutiques = reseau.rows[0] ? reseau.rows[0].nb : 0;
    const publiable = nbBoutiques >= K;

    const DEPUIS_6_MOIS = `v.cree_le >= (date_trunc('month', now() AT TIME ZONE $2) - interval '5 months') AT TIME ZONE $2`;
    const VENTES = `FROM lignes_vente l JOIN ventes v ON v.id = l.vente_id JOIN produits p ON p.id = l.produit_id
                    JOIN entreprises e ON e.id = v.entreprise_id
                   WHERE p.sponsor_id = $1 AND e.partage_stats = true AND e.statut = 'actif'`;

    let mensuel = []; let topProduits = []; let villes = []; let enAlerte = null;
    if (publiable) {
      mensuel = (await db.query(
        `SELECT to_char(date_trunc('month', v.cree_le AT TIME ZONE $2), 'YYYY-MM') AS mois,
                SUM(l.quantite)::int AS quantite, SUM(l.sous_total)::bigint AS ca, COUNT(DISTINCT v.entreprise_id)::int AS boutiques
           ${VENTES} AND ${DEPUIS_6_MOIS}
          GROUP BY 1 HAVING COUNT(DISTINCT v.entreprise_id) >= $3 ORDER BY 1`,
        [sid, TZ, K],
      )).rows;
      topProduits = (await db.query(
        `SELECT max(l.nom_produit) AS nom, SUM(l.quantite)::int AS quantite, SUM(l.sous_total)::bigint AS ca, COUNT(DISTINCT v.entreprise_id)::int AS boutiques
           ${VENTES} AND v.cree_le >= now() - interval '90 days'
          GROUP BY lower(btrim(l.nom_produit)) HAVING COUNT(DISTINCT v.entreprise_id) >= $2
          ORDER BY SUM(l.quantite) DESC LIMIT 10`,
        [sid, K],
      )).rows;
      villes = (await db.query(
        `SELECT max(initcap(btrim(e.ville))) AS ville, SUM(l.quantite)::int AS quantite, SUM(l.sous_total)::bigint AS ca, COUNT(DISTINCT v.entreprise_id)::int AS boutiques
           ${VENTES} AND e.ville IS NOT NULL AND btrim(e.ville) <> '' AND v.cree_le >= now() - interval '90 days'
          GROUP BY lower(btrim(e.ville)) HAVING COUNT(DISTINCT v.entreprise_id) >= $2
          ORDER BY SUM(l.sous_total) DESC LIMIT 15`,
        [sid, K],
      )).rows;
      const alerte = await db.query(
        `SELECT COUNT(DISTINCT p.entreprise_id)::int AS nb FROM produits p JOIN entreprises e ON e.id = p.entreprise_id
          WHERE p.sponsor_id = $1 AND p.actif AND e.partage_stats = true AND e.statut = 'actif' AND p.quantite_stock <= p.seuil_alerte`,
        [sid],
      );
      enAlerte = alerte.rows[0] ? alerte.rows[0].nb : 0;
    }

    const offres = (await db.query(
      `SELECT o.id, o.titre, to_char(o.debut, 'YYYY-MM-DD') AS debut, to_char(o.fin, 'YYYY-MM-DD') AS fin, o.actif,
              (SELECT COUNT(DISTINCT x.entreprise_id) FROM sponsor_evenements x WHERE x.offre_id = o.id AND x.type = 'vue')::int AS vues,
              (SELECT COUNT(DISTINCT x.entreprise_id) FROM sponsor_evenements x WHERE x.offre_id = o.id AND x.type = 'clic')::int AS clics
         FROM sponsor_offres o WHERE o.sponsor_id = $1 ORDER BY o.id DESC LIMIT 20`,
      [sid],
    )).rows;
    const commandes = (await db.query(
      `SELECT to_char(date_trunc('month', c.cree_le AT TIME ZONE $2), 'YYYY-MM') AS mois, COUNT(*)::int AS commandes, COUNT(DISTINCT c.entreprise_id)::int AS boutiques
         FROM commandes_reassort c
        WHERE c.sponsor_id = $1 AND c.cree_le >= (date_trunc('month', now() AT TIME ZONE $2) - interval '5 months') AT TIME ZONE $2
        GROUP BY 1 ORDER BY 1`,
      [sid, TZ],
    )).rows;

    const nombre = (x) => Number(x) || 0;
    const ca = (rows) => rows.map((r) => ({ ...r, ca: nombre(r.ca) }));
    return {
      sponsor: { id: sponsor.id, nom: sponsor.nom, a_logo: sponsor.a_logo, logo_v: sponsor.logo_v },
      seuil_anonymat: K,
      boutiques: { nb: nbBoutiques, publiable },
      mensuel: ca(mensuel),
      top_produits: ca(topProduits),
      villes: ca(villes),
      boutiques_en_alerte: enAlerte,
      offres,
      commandes,
    };
  });
};
