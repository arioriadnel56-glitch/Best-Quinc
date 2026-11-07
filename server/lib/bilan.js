'use strict';
// Bilan des ventes d'une période (jour, semaine, mois…) et sa fiche PDF.
const db = require('./db');
const { HttpError } = require('./http');
const { TZ } = require('./tz');
const { Pdf, hexRgb, L, H } = require('./pdf');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = { especes: 'Espèces', mobile_money: 'Mobile Money', autre: 'Autre', credit: 'À crédit' };
const PERIODES = ['aujourdhui', 'hier', '7j', 'mois', 'mois_precedent', 'personnalisee'];
const LIMITE_JOURS = 366;

// Calcul sur des dates « civiles » (AAAA-MM-JJ), indépendant du fuseau de la machine
const enMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const enDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const ajouterJours = (s, n) => enDate(enMs(s) + n * 86400000);
const nbJours = (du, au) => Math.round((enMs(au) - enMs(du)) / 86400000) + 1;
const dateValide = (s) => DATE.test(s) && enDate(enMs(s)) === s;
const dateFr = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const dateHeureFr = (s) => `${dateFr(s.slice(0, 10))} à ${s.slice(11, 16)}`;
const fcfa = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)).replace(/[\u202f\u00a0]/g, ' ') + ' F CFA';
const entier = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)).replace(/[\u202f\u00a0]/g, ' ');

async function maintenant() {
  const { rows } = await db.query(
    "SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS maintenant, to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS aujourdhui",
    [TZ],
  );
  return rows[0];
}

// Transforme la demande (période prédéfinie ou dates précises) en deux dates
async function resoudrePeriode({ periode, du, au } = {}) {
  const { aujourdhui } = await maintenant();
  const p = periode === undefined || periode === null || periode === '' ? (du || au ? 'personnalisee' : 'aujourdhui') : String(periode);
  if (!PERIODES.includes(p)) throw new HttpError(400, 'Période invalide.');
  let d; let f;
  if (p === 'aujourdhui') { d = aujourdhui; f = aujourdhui; }
  else if (p === 'hier') { d = ajouterJours(aujourdhui, -1); f = d; }
  else if (p === '7j') { d = ajouterJours(aujourdhui, -6); f = aujourdhui; }
  else if (p === 'mois') { d = `${aujourdhui.slice(0, 8)}01`; f = aujourdhui; }
  else if (p === 'mois_precedent') { const premier = `${aujourdhui.slice(0, 8)}01`; f = ajouterJours(premier, -1); d = `${f.slice(0, 8)}01`; }
  else {
    if (!dateValide(String(du || '')) || !dateValide(String(au || ''))) throw new HttpError(400, 'Choisissez une date de début et une date de fin valides.');
    d = String(du); f = String(au);
  }
  if (f < d) throw new HttpError(400, 'La date de fin doit être après la date de début.');
  if (nbJours(d, f) > LIMITE_JOURS) throw new HttpError(400, 'Une période ne peut pas dépasser un an (366 jours).');
  return { du: d, au: f, periode: p };
}

const EN_PERIODE = "(cree_le AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date";

async function calculerBilan(eid, du, au) {
  const a = [eid, TZ, du, au];
  const [now, modes, credits, reglements, remb, marge, top, vendeurs, jours, stock, anomalies] = await Promise.all([
    maintenant(),
    db.query(`SELECT mode_paiement AS mode, COUNT(*)::int AS nb, COALESCE(SUM(total), 0)::float8 AS total
                FROM ventes WHERE entreprise_id = $1 AND ${EN_PERIODE} GROUP BY mode_paiement`, a),
    db.query(`SELECT COUNT(*)::int AS nb, COALESCE(SUM(v.total), 0)::float8 AS total,
                     COALESCE(SUM(GREATEST(0, v.montant_paye + COALESCE(rb.rendu, 0) - COALESCE(r.reg, 0))), 0)::float8 AS acomptes,
                     COALESCE(SUM(GREATEST(0, v.total - v.rembourse - v.montant_paye)), 0)::float8 AS reste
                FROM ventes v
                LEFT JOIN (SELECT vente_id, SUM(montant) AS reg FROM reglements WHERE entreprise_id = $1 GROUP BY vente_id) r ON r.vente_id = v.id
                LEFT JOIN (SELECT vente_id, SUM(montant_rendu) AS rendu FROM remboursements WHERE entreprise_id = $1 GROUP BY vente_id) rb ON rb.vente_id = v.id
               WHERE v.entreprise_id = $1 AND v.mode_paiement = 'credit'
                 AND (v.cree_le AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`, a),
    db.query(`SELECT mode_paiement AS mode, COUNT(*)::int AS nb, COALESCE(SUM(montant), 0)::float8 AS total
                FROM reglements WHERE entreprise_id = $1 AND ${EN_PERIODE} GROUP BY mode_paiement`, a),
    db.query(`SELECT COUNT(*)::int AS nb, COALESCE(SUM(montant), 0)::float8 AS total, COALESCE(SUM(montant_rendu), 0)::float8 AS rendu
                FROM remboursements WHERE entreprise_id = $1 AND ${EN_PERIODE}`, a),
    db.query(`SELECT COALESCE(SUM(l.sous_total), 0)::float8 AS ca, COALESCE(SUM(l.quantite::float8 * COALESCE(p.prix_achat, 0)), 0)::float8 AS cout
                FROM lignes_vente l JOIN ventes v ON v.id = l.vente_id LEFT JOIN produits p ON p.id = l.produit_id
               WHERE v.entreprise_id = $1 AND (v.cree_le AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`, a),
    db.query(`SELECT l.nom_produit, SUM(l.quantite)::int AS quantite, SUM(l.sous_total)::float8 AS total
                FROM lignes_vente l JOIN ventes v ON v.id = l.vente_id
               WHERE v.entreprise_id = $1 AND (v.cree_le AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
               GROUP BY l.nom_produit ORDER BY total DESC, l.nom_produit LIMIT 10`, a),
    db.query(`SELECT COALESCE(u.nom_complet, 'Compte supprimé') AS vendeur, COUNT(*)::int AS nb, COALESCE(SUM(v.total), 0)::float8 AS total
                FROM ventes v LEFT JOIN utilisateurs u ON u.id = v.utilisateur_id
               WHERE v.entreprise_id = $1 AND (v.cree_le AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
               GROUP BY u.nom_complet ORDER BY total DESC`, a),
    db.query(`SELECT to_char((cree_le AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS jour, COUNT(*)::int AS nb, COALESCE(SUM(total), 0)::float8 AS total
                FROM ventes WHERE entreprise_id = $1 AND ${EN_PERIODE} GROUP BY 1 ORDER BY 1`, a),
    db.query(`SELECT COUNT(*) FILTER (WHERE quantite_stock <= seuil_alerte)::int AS faibles,
                     COALESCE(SUM(quantite_stock::float8 * prix_achat), 0)::float8 AS valeur
                FROM produits WHERE entreprise_id = $1 AND actif`, [eid]),
    db.query(`SELECT COUNT(*)::int AS nb FROM ventes
               WHERE entreprise_id = $1 AND anomalie IS NOT NULL AND NOT anomalie_verifiee AND ${EN_PERIODE}`, a),
  ]);

  const parMode = Object.fromEntries(Object.keys(MODES).map((m) => [m, { nb: 0, total: 0 }]));
  for (const r of modes.rows) if (parMode[r.mode]) parMode[r.mode] = { nb: Number(r.nb), total: Number(r.total) };
  const nbVentes = Object.values(parMode).reduce((t, m) => t + m.nb, 0);
  const brut = Object.values(parMode).reduce((t, m) => t + m.total, 0);
  const comptant = ['especes', 'mobile_money', 'autre'].reduce((t, m) => t + parMode[m].total, 0);

  const c = credits.rows[0] || {};
  const credit = { nb: Number(c.nb) || 0, total: Number(c.total) || 0, acomptes: Number(c.acomptes) || 0, reste: Number(c.reste) || 0 };
  const parReglement = Object.fromEntries(['especes', 'mobile_money', 'autre'].map((m) => [m, 0]));
  let reglTotal = 0; let reglNb = 0;
  for (const r of reglements.rows) { reglTotal += Number(r.total); reglNb += Number(r.nb); if (r.mode in parReglement) parReglement[r.mode] += Number(r.total); }
  const rb = remb.rows[0] || {};
  const remboursements = { nb: Number(rb.nb) || 0, total: Number(rb.total) || 0, rendu: Number(rb.rendu) || 0 };
  const m = marge.rows[0] || {};
  const cout = Number(m.cout) || 0;
  const s = stock.rows[0] || {};
  const encaisse = comptant + credit.acomptes + reglTotal - remboursements.rendu;

  return {
    du, au,
    genere_le: now.maintenant,
    ventes: { nb: nbVentes, brut, panier_moyen: nbVentes ? brut / nbVentes : 0 },
    modes: Object.entries(parMode).map(([mode, v]) => ({ mode, nb: v.nb, total: v.total })),
    remboursements,
    ca_net: brut - remboursements.total,
    credit,
    reglements: { nb: reglNb, total: reglTotal, par_mode: parReglement },
    encaisse: { comptant, acomptes: credit.acomptes, reglements: reglTotal, rendu: remboursements.rendu, total: encaisse },
    marge: { cout, marge: (Number(m.ca) || 0) - cout },
    top_produits: top.rows.map((r) => ({ nom_produit: r.nom_produit, quantite: Number(r.quantite), total: Number(r.total) })),
    vendeurs: vendeurs.rows.map((r) => ({ vendeur: r.vendeur, nb: Number(r.nb), total: Number(r.total) })),
    jours: jours.rows.map((r) => ({ jour: r.jour, nb: Number(r.nb), total: Number(r.total) })),
    stock: { faibles: Number(s.faibles) || 0, valeur: Number(s.valeur) || 0 },
    anomalies: Number((anomalies.rows[0] || {}).nb) || 0,
  };
}

const titrePeriode = (b) => (b.du === b.au ? `Journée du ${dateFr(b.du)}` : `Du ${dateFr(b.du)} au ${dateFr(b.au)}`);

// Note : ventes.montant_paye = acompte + règlements − sommes rendues. L'acompte d'origine se retrouve donc en rajoutant
// les sommes rendues et en retirant les règlements (sinon un remboursement serait déduit deux fois de l'argent encaissé).

// ---------- Fiche PDF ----------
function pdfBilan({ entreprise, couleur, bilan: b, numero, note, par }) {
  const marque = hexRgb(couleur);
  const encre = [0.08, 0.13, 0.17]; const doux = [0.35, 0.42, 0.47]; const trait = [0.83, 0.86, 0.88];
  const pale = [0.94, 0.96, 0.97]; const rouge = [0.7, 0.25, 0.16]; const vert = [0.07, 0.48, 0.32];
  const X = 40; const LARG = L - 80; const BAS = H - 56;
  const pdf = new Pdf({ titre: `Bilan des ventes - ${titrePeriode(b)}`, auteur: entreprise });
  let y = 0;

  const entete = () => {
    pdf.rect(0, 0, L, 74, { fond: marque });
    pdf.texte(X, 36, entreprise, { taille: 19, gras: true, couleur: [1, 1, 1], max: LARG - 130 });
    pdf.texte(X, 56, 'Bilan des ventes', { taille: 11, couleur: [1, 1, 1] });
    pdf.texte(L - X, 36, numero ? `Bilan n° ${String(numero).padStart(4, '0')}` : 'Bilan', { taille: 11, gras: true, couleur: [1, 1, 1], align: 'right' });
    pdf.texte(L - X, 56, `Édité le ${dateHeureFr(b.genere_le)}`, { taille: 9, couleur: [1, 1, 1], align: 'right' });
  };
  const suite = () => {
    pdf.nouvellePage();
    pdf.rect(0, 0, L, 34, { fond: marque });
    pdf.texte(X, 22, `${entreprise} — Bilan des ventes`, { taille: 10, gras: true, couleur: [1, 1, 1], max: LARG - 160 });
    pdf.texte(L - X, 22, titrePeriode(b), { taille: 9, couleur: [1, 1, 1], align: 'right' });
    y = 56;
  };
  const place = (h) => { if (y + h > BAS) suite(); };
  const titre = (t, h = 44) => {
    place(h);
    y += 12;
    pdf.rect(X, y - 10, 4, 14, { fond: marque });
    pdf.texte(X + 10, y + 1, t, { taille: 11.5, gras: true });
    y += 10;
    pdf.trait(X, y, X + LARG, y);
    y += 6;
  };
  const ligne = (libelle, valeur, { gras = false, indent = 0, couleur: cv = encre, fond } = {}) => {
    place(20);
    if (fond) pdf.rect(X, y - 2, LARG, 19, { fond });
    pdf.texte(X + 6 + indent, y + 11, libelle, { taille: 10, gras, couleur: gras ? encre : doux, max: LARG - 150 - indent });
    pdf.texte(X + LARG - 6, y + 11, valeur, { taille: 10, gras, couleur: cv, align: 'right' });
    pdf.trait(X, y + 17, X + LARG, y + 17, { couleur: [0.92, 0.94, 0.95] });
    y += 19;
  };
  // Tableau : colonnes { t: titre, x: position, a: alignement, w: largeur max }
  const tableau = (cols, lignes) => {
    place(40);
    pdf.rect(X, y, LARG, 19, { fond: pale });
    for (const c of cols) pdf.texte(c.a === 'right' ? X + c.x : X + c.x, y + 13, c.t, { taille: 9, gras: true, couleur: doux, align: c.a || 'left' });
    y += 21;
    for (const l of lignes) {
      place(20);
      cols.forEach((c, i) => pdf.texte(X + c.x, y + 11, l[i], { taille: 9.5, align: c.a || 'left', max: c.w, gras: Boolean(l.gras) }));
      pdf.trait(X, y + 17, X + LARG, y + 17, { couleur: [0.92, 0.94, 0.95] });
      y += 19;
    }
  };

  entete();
  y = 98;
  pdf.texte(X, y, titrePeriode(b), { taille: 16, gras: true });
  y += 16;
  const sousTitre = [par ? `Établi par ${par}` : null, note || null].filter(Boolean).join(' · ');
  if (sousTitre) { pdf.texte(X, y, sousTitre, { taille: 9.5, couleur: doux, max: LARG }); y += 6; }
  y += 14;

  // Quatre cartes de synthèse
  const cartes = [
    ['Ventes', entier(b.ventes.nb), b.ventes.nb ? `panier moyen ${fcfa(b.ventes.panier_moyen)}` : 'aucune vente'],
    ['Chiffre d\'affaires net', fcfa(b.ca_net), `brut ${fcfa(b.ventes.brut)}`],
    ['Argent encaissé', fcfa(b.encaisse.total), 'caisse + mobile money'],
    ['Marge estimée', fcfa(b.marge.marge), 'au prix d\'achat actuel'],
  ];
  const cw = (LARG - 3 * 8) / 4;
  cartes.forEach((c, i) => {
    const cx = X + i * (cw + 8);
    pdf.rect(cx, y, cw, 62, { fond: pale, trait });
    pdf.rect(cx, y, 4, 62, { fond: i === 3 ? vert : marque });
    pdf.texte(cx + 12, y + 17, c[0], { taille: 8.5, gras: true, couleur: doux, max: cw - 16 });
    pdf.texte(cx + 12, y + 37, c[1], { taille: i === 0 ? 17 : 12.5, gras: true, max: cw - 16 });
    pdf.texte(cx + 12, y + 52, c[2], { taille: 7.5, couleur: doux, max: cw - 16 });
  });
  y += 70;

  titre('Chiffre d\'affaires');
  ligne('Ventes de la période', fcfa(b.ventes.brut), { gras: true });
  for (const m of b.modes) if (m.nb) ligne(`${MODES[m.mode]} (${m.nb} vente${m.nb > 1 ? 's' : ''})`, fcfa(m.total), { indent: 12 });
  ligne(`Remboursements (${b.remboursements.nb})`, b.remboursements.total ? `- ${fcfa(b.remboursements.total)}` : fcfa(0), { couleur: b.remboursements.total ? rouge : encre });
  ligne('Chiffre d\'affaires net', fcfa(b.ca_net), { gras: true, fond: pale });

  titre('Argent encaissé', 150);
  const comptant = b.modes.filter((m) => m.mode !== 'credit');
  for (const m of comptant) if (m.nb) ligne(`Ventes payées comptant — ${MODES[m.mode]}`, fcfa(m.total));
  if (!comptant.some((m) => m.nb)) ligne('Ventes payées comptant', fcfa(0));
  ligne('Acomptes reçus sur les ventes à crédit', fcfa(b.encaisse.acomptes));
  ligne(`Règlements de crédits reçus (${b.reglements.nb})`, fcfa(b.encaisse.reglements));
  ligne('Remboursements rendus aux clients', b.encaisse.rendu ? `- ${fcfa(b.encaisse.rendu)}` : fcfa(0), { couleur: b.encaisse.rendu ? rouge : encre });
  ligne('Total encaissé', fcfa(b.encaisse.total), { gras: true, fond: pale });

  titre('Crédits clients', 80);
  ligne(`Ventes à crédit de la période (${b.credit.nb})`, fcfa(b.credit.total));
  ligne('Reste à encaisser sur ces ventes', fcfa(b.credit.reste), { gras: true, couleur: b.credit.reste ? rouge : encre });

  if (b.top_produits.length) {
    titre('Produits les plus vendus', 90);
    tableau([{ t: 'Produit', x: 6, w: 300 }, { t: 'Quantité', x: 390, a: 'right' }, { t: 'Montant', x: LARG - 6, a: 'right' }],
      b.top_produits.map((p) => [p.nom_produit, entier(p.quantite), fcfa(p.total)]));
  }
  if (b.vendeurs.length) {
    titre('Ventes par vendeur', 90);
    tableau([{ t: 'Vendeur', x: 6, w: 300 }, { t: 'Ventes', x: 390, a: 'right' }, { t: 'Montant', x: LARG - 6, a: 'right' }],
      b.vendeurs.map((v) => [v.vendeur, entier(v.nb), fcfa(v.total)]));
  }
  if (b.jours.length > 1) {
    titre('Ventes jour par jour', 100);
    const max = Math.max(1, ...b.jours.map((j) => j.total));
    place(40);
    pdf.rect(X, y, LARG, 19, { fond: pale });
    pdf.texte(X + 6, y + 13, 'Jour', { taille: 9, gras: true, couleur: doux });
    pdf.texte(X + 330, y + 13, 'Ventes', { taille: 9, gras: true, couleur: doux, align: 'right' });
    pdf.texte(X + LARG - 6, y + 13, 'Montant', { taille: 9, gras: true, couleur: doux, align: 'right' });
    y += 21;
    for (const j of b.jours) {
      place(20);
      pdf.texte(X + 6, y + 11, dateFr(j.jour), { taille: 9.5 });
      pdf.rect(X + 78, y + 3, Math.max(1, (j.total / max) * 170), 9, { fond: marque });
      pdf.texte(X + 330, y + 11, entier(j.nb), { taille: 9.5, align: 'right' });
      pdf.texte(X + LARG - 6, y + 11, fcfa(j.total), { taille: 9.5, align: 'right' });
      pdf.trait(X, y + 17, X + LARG, y + 17, { couleur: [0.92, 0.94, 0.95] });
      y += 19;
    }
  }

  titre('Stock (à la date d\'édition)');
  ligne('Valeur du stock au prix d\'achat', fcfa(b.stock.valeur));
  ligne('Produits à réapprovisionner', entier(b.stock.faibles), { couleur: b.stock.faibles ? rouge : encre });
  if (b.anomalies) ligne('Ventes à vérifier (écart de prix ou de stock)', entier(b.anomalies), { couleur: rouge });

  place(100);
  y += 22;
  pdf.rect(X, y, LARG, 70, { trait });
  pdf.texte(X + 10, y + 16, 'Visa du propriétaire', { taille: 9, gras: true, couleur: doux });
  pdf.texte(X + LARG / 2 + 10, y + 16, 'Date', { taille: 9, gras: true, couleur: doux });
  pdf.trait(X + LARG / 2, y, X + LARG / 2, y + 70);
  y += 80;
  pdf.texte(X, y, 'La marge est une estimation : elle utilise le prix d\'achat actuel des produits. Les montants sont en francs CFA.', { taille: 8, couleur: doux, max: LARG });

  // Pied de page sur chaque page
  const n = pdf.pages.length;
  pdf.pages.forEach((p, i) => {
    pdf.page = p;
    pdf.trait(X, H - 36, X + LARG, H - 36);
    pdf.texte(X, H - 22, 'Fiche générée par Best-Quinca', { taille: 8, couleur: doux });
    pdf.texte(X + LARG, H - 22, `Page ${i + 1} / ${n}`, { taille: 8, couleur: doux, align: 'right' });
  });
  return pdf.construire();
}

module.exports = { resoudrePeriode, calculerBilan, pdfBilan, titrePeriode, dateFr, dateValide, ajouterJours, nbJours, MODES, PERIODES };
