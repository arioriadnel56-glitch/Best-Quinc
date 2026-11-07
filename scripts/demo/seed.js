'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
const pool = new Pool({ connectionString: process.env.DEMO_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/bestquinca' });
const BASE = process.env.DEMO_BASE || 'http://localhost:3100';
const jour = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10); // dates relatives : la démonstration ne vieillit pas
const ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL || 'admin@bestquinca.demo';
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD || 'DemoAdmin2026!';
let seed = 20261025;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

async function call(method, path, body, token) {
  await pool.query('TRUNCATE limites_requetes');
  const r = await fetch(BASE + path, { method, headers: { 'X-Forwarded-For': `10.${int(0,250)}.${int(0,250)}.${int(1,250)}`, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const b64 = (f) => fs.readFileSync(path.join(__dirname, 'logos', f)).toString('base64');

const CATS = ['Ciment & béton', 'Fer & acier', 'Toiture', 'Visserie', 'Peinture', 'Plomberie', 'Électricité', 'Outillage'];
// nom, ref, cat, achat, vente, stock final, seuil, unité, sponsor (B = Béton Plus, O = Outillage Atlantique)
const PRODUITS = [
  ['Ciment CPJ 42,5 (sac 50 kg)', 'CIM-425', 0, 7600, 8500, 120, 30, 'sac', 'B'],
  ['Ciment CPJ 32,5 (sac 50 kg)', 'CIM-325', 0, 7200, 8000, 18, 30, 'sac', 'B'],
  ['Fer à béton 8 mm (barre 12 m)', 'FER-08', 1, 3400, 4000, 210, 50, 'barre', null],
  ['Fer à béton 10 mm (barre 12 m)', 'FER-10', 1, 5200, 6000, 85, 40, 'barre', null],
  ['Fer à béton 12 mm (barre 12 m)', 'FER-12', 1, 7400, 8500, 12, 30, 'barre', null],
  ['Tôle bac alu 3 m', 'TOL-3M', 2, 5800, 6800, 64, 20, 'feuille', null],
  ['Tôle ondulée galvanisée', 'TOL-OND', 2, 4300, 5000, 40, 15, 'feuille', null],
  ['Clous 70 mm', 'CLO-70', 3, 1100, 1500, 46, 15, 'kg', null],
  ['Clous 50 mm', 'CLO-50', 3, 1100, 1500, 9, 15, 'kg', null],
  ['Vis à bois 4×40 (boîte de 200)', 'VIS-440', 3, 1800, 2500, 35, 10, 'boîte', null],
  ['Boulons M10', 'BOU-10', 3, 150, 250, 300, 100, 'pièce', null],
  ['Peinture glycéro blanche 5 L', 'PEI-GB5', 4, 9500, 12000, 28, 8, 'pot', null],
  ['Peinture à eau intérieure 20 L', 'PEI-E20', 4, 24000, 29500, 14, 5, 'seau', null],
  ['Pinceau 50 mm', 'PIN-50', 4, 600, 1000, 75, 20, 'pièce', null],
  ['Tuyau PVC Ø50 (barre 6 m)', 'PVC-50', 5, 3900, 5000, 52, 15, 'barre', null],
  ['Tuyau PVC Ø100 (barre 6 m)', 'PVC-100', 5, 8200, 10000, 7, 10, 'barre', null],
  ['Robinet laiton 1/2"', 'ROB-12', 5, 1800, 2800, 44, 12, 'pièce', null],
  ['Colle PVC 250 ml', 'COL-PVC', 5, 1300, 2000, 23, 8, 'tube', null],
  ['Câble électrique 2,5 mm² (100 m)', 'CAB-25', 6, 28000, 34000, 16, 5, 'rouleau', null],
  ['Prise 2P+T encastrée', 'PRI-2PT', 6, 900, 1500, 120, 30, 'pièce', null],
  ['Ampoule LED 12 W', 'LED-12', 6, 700, 1200, 150, 40, 'pièce', null],
  ['Disjoncteur 20 A', 'DIS-20', 6, 3500, 5000, 25, 10, 'pièce', null],
  ['Marteau de maçon', 'MAR-MAC', 7, 3200, 4500, 18, 5, 'pièce', 'O'],
  ['Pelle ronde', 'PEL-RON', 7, 3600, 5000, 22, 6, 'pièce', 'O'],
  ['Brouette 80 L', 'BRO-80', 7, 22000, 28000, 6, 3, 'pièce', 'O'],
  ['Perceuse 650 W', 'PER-650', 7, 26000, 35000, 3, 3, 'pièce', 'O'],
  ['Cadenas 40 mm', 'CAD-40', 7, 1500, 2500, 3, 8, 'pièce', null],
  ['Gants de chantier', 'GAN-CH', 7, 500, 900, 60, 20, 'paire', null],
];
const POIDS = { 'CIM-425': 9, 'CIM-325': 5, 'FER-08': 7, 'FER-10': 6, 'FER-12': 3, 'TOL-3M': 4, 'CLO-70': 6, 'CLO-50': 3, 'VIS-440': 3, 'BOU-10': 3, 'PEI-GB5': 3, 'PIN-50': 3, 'PVC-50': 4, 'ROB-12': 2, 'PRI-2PT': 3, 'LED-12': 4, 'MAR-MAC': 2, 'PEL-RON': 2, 'GAN-CH': 3, 'CAB-25': 2, 'COL-PVC': 2 };
const QTE = { 'CIM-425': [2, 20], 'CIM-325': [2, 15], 'FER-08': [4, 30], 'FER-10': [4, 24], 'FER-12': [2, 12], 'CLO-70': [1, 5], 'CLO-50': [1, 4], 'BOU-10': [10, 60], 'PRI-2PT': [2, 12], 'LED-12': [2, 10], 'TOL-3M': [4, 20] };

async function creerBoutique(adminTok, d, sponsors) {
  const ins = await call('POST', '/api/entreprises/inscription', { nom_entreprise: d.nom, nom_complet: d.proprio, telephone: d.tel, email: d.email, mot_de_passe: 'Demo2026pass', slug: d.slug });
  const tok = ins.token;
  const ent = (await pool.query('SELECT id FROM entreprises WHERE slug = $1', [d.slug])).rows[0].id;
  // abonnements + paiements (insertion directe : le paiement réel passe par KkiaPay)
  const periodes = d.periodes; // [{debutJ, statut}]
  let k = 0;
  for (const p of periodes) {
    const ab = await pool.query(`INSERT INTO abonnements (entreprise_id, montant, statut, date_debut, date_fin) VALUES ($1, 3000, 'actif', CURRENT_DATE + $2::int, CURRENT_DATE + $2::int + 30) RETURNING id`, [ent, p]);
    await pool.query(`INSERT INTO paiements (entreprise_id, abonnement_id, agregateur, reference_transaction, montant, statut, cree_le, confirme_le)
      VALUES ($1, $2, 'kkiapay', $3, 3000, 'reussi', now() + ($4::int || ' days')::interval, now() + ($4::int || ' days')::interval)`, [ent, ab.rows[0].id, `KKP-${ent}${String(1000 + (k++) * 7 + int(0, 6))}`, p]);
  }
  if (d.temp) await pool.query("INSERT INTO abonnements (entreprise_id, montant, statut, date_debut, date_fin) VALUES ($1, 0, 'actif', CURRENT_DATE - 1, CURRENT_DATE + 30)", [ent]);
  if (d.profil) {
    await call('PUT', '/api/entreprise', { nom: d.nom, ...d.profil, email: d.email, telephone: d.tel }, tok);
  }
  if (d.couleur) await call('PUT', '/api/pwa', { nom_app: d.nomApp || d.nom, couleur: d.couleur }, tok);
  // catégories
  const cats = [];
  for (const c of CATS) { await call('POST', '/api/categories', { nom: c }, tok); }
  const lc = await call('GET', '/api/categories', null, tok);
  const parNom = new Map(lc.map((c) => [c.nom, c.id]));
  const ids = {};
  const liste = d.produits ? PRODUITS.filter((p) => d.produits.includes(p[1])) : PRODUITS;
  for (const p of liste) {
    const r = await call('POST', '/api/produits', { nom: p[0], reference: p[1], categorie_id: parNom.get(CATS[p[2]]), prix_achat: p[3], prix_vente: p[4], quantite_stock: 600, seuil_alerte: p[6], unite: p[7], sponsor_id: p[8] ? sponsors[p[8]] : null }, tok);
    ids[p[1]] = { id: r.id, p };
  }
  return { tok, ent, ids, liste };
}

async function ventes(b, n, jours, d) {
  const refs = Object.keys(POIDS).filter((r) => b.ids[r]);
  const pool_ = refs.flatMap((r) => Array(POIDS[r]).fill(r));
  const clients = ['Séraphin Agbodjan', 'Chantier Mission Hôtel', 'Hounsou Maçonnerie', 'Mme Adjakpa', 'Ets Kpadonou BTP', 'Jean-Marc Tossou', null, null, null, null];
  const plan = Array.from({ length: n }, () => { const dj = Math.min(jours - 1, Math.floor(Math.pow(rnd(), 1.6) * jours)); const h = int(8, 18), m = int(0, 59), ago = int(200, 600); return { dj, h, m, ago, key: dj === 0 ? 100000 - ago : -(dj * 1440) + h * 60 + m }; }).sort((a, c) => a.key - c.key);
  for (let i = 0; i < n; i++) {
    const nl = int(1, 3);
    const choisis = new Set();
    for (let j = 0; j < nl; j++) choisis.add(pick(pool_));
    const lignes = [...choisis].map((r) => { const q = QTE[r] || [1, 4]; return { produit_id: b.ids[r].id, quantite: int(q[0], q[1]) }; });
    const tok = d.vendeurs ? pick(d.vendeurs) : b.tok;
    const cl = pick(clients);
    const mode = pick(['especes', 'especes', 'especes', 'mobile_money', 'mobile_money', 'autre']);
    const v = await call('POST', '/api/ventes', { lignes, client_nom: cl, client_telephone: cl ? '0196' + int(100000, 999999) : null, mode_paiement: mode }, tok);
    // antidatage : plus de ventes récentes
    const { dj, h, m, ago } = plan[i];
    const sql = dj === 0
      ? `UPDATE ventes SET cree_le = now() - ($2::int || ' minutes')::interval WHERE id = $1`
      : `UPDATE ventes SET cree_le = (date_trunc('day', now() AT TIME ZONE 'Africa/Porto-Novo') - ($2::int || ' days')::interval + ($3::int || ' hours')::interval + ($4::int || ' minutes')::interval) AT TIME ZONE 'Africa/Porto-Novo' WHERE id = $1`;
    await pool.query(sql, dj === 0 ? [v.id, ago] : [v.id, dj, h, m]);
  }
  await pool.query(`UPDATE mouvements_stock m SET cree_le = v.cree_le FROM ventes v WHERE m.entreprise_id = v.entreprise_id AND m.entreprise_id = $1 AND m.motif = 'Vente n°' || v.numero`, [b.ent]);
  await pool.query(`UPDATE mouvements_stock SET cree_le = now() - interval '${jours + 5} days' WHERE entreprise_id = $1 AND motif = 'Stock initial'`, [b.ent]);
  // stock final réaliste
  for (const [ref, o] of Object.entries(b.ids)) {
    const cible = Math.max(0, Math.round(o.p[5] * (d.echelleStock || 1)));
    await pool.query('UPDATE produits SET quantite_stock = $1 WHERE id = $2', [cible, o.id]);
  }
}

(async () => {
  // Admin
  const adm = (await call('POST', '/api/admin/login', { email: ADMIN_EMAIL, mot_de_passe: ADMIN_PASSWORD })).token;
  // Partenaires
  const sp = {};
  const s1 = await call('POST', '/api/admin/sponsors', { nom: 'Béton Plus Bénin', description: 'Distributeur de ciment et de matériaux de gros œuvre, livraison sur chantier dans le Sud-Bénin.', site_web: 'www.betonplus-demo.bj', telephone_commande: '22997000001', debut: jour(-60), fin: jour(300) }, adm);
  const s2 = await call('POST', '/api/admin/sponsors', { nom: 'Outillage Atlantique', description: 'Outillage de chantier et matériel de maçonnerie, garantie 12 mois.', site_web: 'www.outillage-atlantique-demo.bj', telephone_commande: '22997000002', debut: jour(-45), fin: jour(320) }, adm);
  sp.B = s1.id; sp.O = s2.id;
  await call('PUT', `/api/admin/sponsors/${s1.id}/logo`, { logo: b64('logo-beton.png') }, adm);
  await call('PUT', `/api/admin/sponsors/${s2.id}/logo`, { logo: b64('logo-outil.png') }, adm);
  const o1 = await call('POST', `/api/admin/sponsors/${s1.id}/offres`, { titre: '−5 % sur le ciment dès 40 sacs', texte: 'Commandez 40 sacs de CPJ 42,5 ou plus et profitez de 5 % de remise, livraison incluse à Cotonou et Abomey-Calavi.', fin: jour(60) }, adm);
  await call('POST', `/api/admin/sponsors/${s1.id}/offres`, { titre: 'Fer à béton : tarif de gros', texte: 'Prix dégressifs sur les barres de 8, 10 et 12 mm pour les commandes de plus de 100 barres.', fin: jour(50) }, adm);
  await call('POST', `/api/admin/sponsors/${s2.id}/offres`, { titre: 'Brouettes renforcées : lot de 5', texte: 'Un lot de 5 brouettes 80 L à prix de gros, pneu increvable inclus.', fin: jour(40) }, adm);

  // Boutique principale
  const main = await creerBoutique(adm, {
    slug: 'quincaillerie-zinsou', nom: 'Quincaillerie Zinsou', proprio: 'Koffi Zinsou', tel: '0197123456', email: 'koffi@quincaillerie-zinsou.bj',
    periodes: [-108, -78, -48, -18],
    profil: { ville: 'Cotonou', adresse: 'Marché Dantokpa, rue 215, lot 14', ifu: '3202412345678', rccm: 'RB/COT/24 B 1234', site_web: 'www.quincaillerie-zinsou.bj', pied_facture: "Merci de votre confiance. Marchandise vendue n'est ni reprise ni échangée.", pays_indicatif: '229' },
    couleur: '#1F6F78', nomApp: 'Quincaillerie Zinsou',
  }, sp);
  await call('PUT', '/api/entreprise/logo', { logo: b64('logo-zinsou.png'), icone: b64('icone-zinsou.png') }, main.tok);
  await call('PUT', '/api/entreprise/partage-stats', { actif: true }, main.tok);
  // Équipe
  await call('POST', '/api/utilisateurs', { nom_complet: 'Aïcha Dossou', email: 'aicha@quincaillerie-zinsou.bj', mot_de_passe: 'Demo2026pass', role: 'secretaire' }, main.tok);
  await call('POST', '/api/utilisateurs', { nom_complet: 'Romuald Adjovi', email: 'romuald@quincaillerie-zinsou.bj', mot_de_passe: 'Demo2026pass', role: 'secretaire' }, main.tok);
  await pool.query(`UPDATE utilisateurs SET mdp_temporaire = false WHERE entreprise_id = $1`, [main.ent]);
  const tokA = (await call('POST', '/api/auth/login', { slug: 'quincaillerie-zinsou', email: 'aicha@quincaillerie-zinsou.bj', mot_de_passe: 'Demo2026pass' })).token;
  const tokR = (await call('POST', '/api/auth/login', { slug: 'quincaillerie-zinsou', email: 'romuald@quincaillerie-zinsou.bj', mot_de_passe: 'Demo2026pass' })).token;
  await ventes(main, 110, 35, { vendeurs: [main.tok, tokA, tokA, tokA, tokR] });
  await pool.query(`UPDATE utilisateurs SET actif = false WHERE entreprise_id = $1 AND email = 'romuald@quincaillerie-zinsou.bj'`, [main.ent]);
  // Vente hors connexion avec écart de prix (« À vérifier »)
  await call('POST', '/api/ventes', { hors_ligne: true, cle: 'hl_demo_00000001', cree_le: new Date(Date.now() - 3 * 3600e3).toISOString(), lignes: [{ produit_id: main.ids['CIM-325'].id, quantite: 6, prix_unitaire: 7800 }], client_nom: 'Chantier Mission Hôtel', mode_paiement: 'especes' }, tokA);
  // Ventes à crédit (secrétaire), un règlement partiel, un remboursement (propriétaire)
  const cred = async (nom, tel, lignes, acompte, echeance) => call('POST', '/api/ventes', { mode_paiement: 'credit', client_nom: nom, client_telephone: tel, acompte, echeance, lignes: lignes.map(([r, q]) => ({ produit_id: main.ids[r].id, quantite: q })) }, tokA);
  const c1 = await cred('Hounsou Maçonnerie', '0196123456', [['CIM-425', 12], ['FER-10', 10]], 50000, jour(-14));
  const c2 = await cred('Ets Kpadonou BTP', '0197445566', [['TOL-3M', 20], ['CLO-70', 8]], 0, jour(22));
  const c3 = await cred('Mme Adjakpa', '0195778899', [['PEI-GB5', 4], ['PIN-50', 6]], 20000, null);
  await call('POST', `/api/ventes/${c1.id}/reglements`, { montant: 30000, mode_paiement: 'mobile_money' }, tokA);
  const norm = await call('POST', '/api/ventes', { mode_paiement: 'especes', client_nom: 'Jean-Marc Tossou', client_telephone: '0194332211', lignes: [{ produit_id: main.ids['PEI-GB5'].id, quantite: 3 }, { produit_id: main.ids['ROB-12'].id, quantite: 2 }] }, main.tok);
  const dn = await call('GET', `/api/ventes/${norm.id}`, null, main.tok);
  await call('POST', `/api/ventes/${norm.id}/remboursements`, { lignes: [{ ligne_id: dn.lignes[0].id, quantite: 1 }], motif: 'Pot de peinture défectueux', mode_paiement: 'especes' }, main.tok);
  const dc = await call('GET', `/api/ventes/${c3.id}`, null, main.tok);
  await call('POST', `/api/ventes/${c3.id}/remboursements`, { lignes: [{ ligne_id: dc.lignes[1].id, quantite: 2 }], motif: 'Pinceaux non utilisés', mode_paiement: 'especes' }, main.tok);
  // FedaPay en mode test (clés fictives) : les deux agrégateurs apparaissent sur la page Abonnement
  await call('PUT', '/api/admin/parametres', { valeurs: { fedapay_public_key: 'pk_sandbox_demo', fedapay_secret_key: 'sk_sandbox_demo', fedapay_sandbox: true }, effacer: [] }, adm);
  // Stock : garder les valeurs finales (le ciment 32,5 a baissé avec la vente)
  await pool.query(`UPDATE produits SET quantite_stock = 18 WHERE id = $1`, [main.ids['CIM-325'].id]);
  // Inventaire n°1 : fait avec la secrétaire et validé il y a 12 jours (historique)
  const inv1 = await call('POST', '/api/inventaires', { note: 'Inventaire de fin de trimestre' }, main.tok);
  const det = await call('GET', `/api/inventaires/${inv1.id}`, null, tokA);
  const stocks = new Map((await call('GET', '/api/produits', null, main.tok)).map((p) => [p.nom, p.quantite_stock]));
  const deltas = [0, 0, -2, 0, 1, 0, 0, -1, 0, 0, 3, 0, -4, 0, 0, 0, 0, 1];
  for (let i = 0; i < 18 && i < det.lignes.length; i++) {
    const l = det.lignes[i];
    await call('PUT', `/api/inventaires/${inv1.id}/lignes/${l.id}`, { quantite: Math.max(0, (stocks.get(l.nom_produit) || 0) + deltas[i]) }, tokA);
  }
  await call('POST', `/api/inventaires/${inv1.id}/valider`, { remettre_tableau_a_zero: false }, main.tok);
  await pool.query(`UPDATE inventaires SET cree_le = now() - interval '12 days 3 hours', termine_le = now() - interval '12 days' WHERE id = $1`, [inv1.id]);
  await pool.query(`UPDATE lignes_inventaire SET compte_le = now() - interval '12 days 1 hour' WHERE inventaire_id = $1`, [inv1.id]);
  await pool.query(`UPDATE mouvements_stock SET cree_le = now() - interval '12 days' WHERE entreprise_id = $1 AND motif LIKE 'Inventaire n°1%'`, [main.ent]);
  // Clics et commande de réassort
  const ban = await call('GET', '/api/partenaires', null, main.tok);
  await call('POST', `/api/partenaires/offres/${o1.id}/clic`, null, main.tok);
  await call('POST', '/api/reassort/commandes', { sponsor_id: sp.B, lignes: [{ produit_id: main.ids['CIM-425'].id, quantite: 60 }], note: 'Livraison jeudi matin, merci.' }, main.tok);
  await pool.query(`UPDATE commandes_reassort SET cree_le = now() - interval '9 days' WHERE entreprise_id = $1`, [main.ent]);

  // Autres boutiques (liste admin, statistiques partenaires : au moins 5 boutiques)
  const autres = [
    { slug: 'ets-hounkpatin', nom: 'Ets Hounkpatin Matériaux', proprio: 'Basile Hounkpatin', tel: '0196224411', ville: 'Porto-Novo', periodes: [-138, -108, -78, -48, -18], n: 30 },
    { slug: 'le-bon-clou', nom: 'Quincaillerie Le Bon Clou', proprio: 'Prisca Gnonlonfoun', tel: '0195338822', ville: 'Abomey-Calavi', periodes: [-108, -78, -48, -18], n: 26 },
    { slug: 'mission-batiment-plus', nom: 'Mission Bâtiment Plus', proprio: 'Cyriaque Aballo', tel: '0194551133', ville: 'Parakou', periodes: [-78, -48, -18], n: 22 },
    { slug: 'dossou-et-fils', nom: 'Dossou & Fils Quincaillerie', proprio: 'Théodore Dossou', tel: '0197667744', ville: 'Bohicon', periodes: [-138, -108, -78, -48, -18], n: 24 },
    { slug: 'comptoir-du-batisseur', nom: 'Comptoir du Bâtisseur', proprio: 'Nadège Akpovi', tel: '0196889955', ville: 'Cotonou', periodes: [-48, -18], n: 20 },
    { slug: 'quincaillerie-adjovi', nom: 'Quincaillerie Adjovi', proprio: 'Erick Adjovi', tel: '0195990066', ville: 'Ouidah', periodes: [-78, -48, -18], n: 18 },
    { slug: 'chez-maman-clou', nom: 'Chez Maman Clou', proprio: 'Rosine Toko', tel: '0197001177', ville: 'Lokossa', periodes: [-78, -48], n: 8 },
  ];
  for (const a of autres) {
    const b = await creerBoutique(adm, { slug: a.slug, nom: a.nom, proprio: a.proprio, tel: a.tel, temp: a.slug === 'chez-maman-clou', email: `contact@${a.slug}.bj`, periodes: a.periodes, profil: { ville: a.ville, adresse: 'Centre-ville', pays_indicatif: '229' },
      produits: ['CIM-425', 'CIM-325', 'FER-08', 'FER-10', 'CLO-70', 'TOL-3M', 'PEI-GB5', 'PVC-50', 'MAR-MAC', 'PEL-RON', 'BRO-80', 'LED-12'] }, sp);
    if (a.slug !== 'chez-maman-clou') await call('PUT', '/api/entreprise/partage-stats', { actif: true }, b.tok);
    await ventes(b, a.n, 150, {});
    if (a.slug === 'chez-maman-clou') await pool.query('DELETE FROM abonnements WHERE entreprise_id = $1 AND montant = 0', [b.ent]);
    if (a.slug === 'quincaillerie-adjovi') await call('PUT', `/api/admin/entreprises/${b.ent}/statut`, { statut: 'suspendu' }, adm);
  }
  // Paiements en attente / échoué pour le filtre
  const e1 = (await pool.query(`SELECT id FROM entreprises WHERE slug = 'le-bon-clou'`)).rows[0].id;
  const e2 = (await pool.query(`SELECT id FROM entreprises WHERE slug = 'comptoir-du-batisseur'`)).rows[0].id;
  await pool.query(`INSERT INTO paiements (entreprise_id, agregateur, reference_transaction, montant, statut, cree_le) VALUES ($1, 'kkiapay', 'KKP-ECH-7781', 3000, 'echoue', now() - interval '2 days'), ($2, 'kkiapay', NULL, 3000, 'en_attente', now() - interval '3 hours')`, [e1, e2]);
  // Étalement des paiements sur 6 mois pour le graphique (déjà fait par les périodes) ; mois courant : ajouter des paiements récents
  const tous = (await pool.query(`SELECT id FROM entreprises WHERE slug <> 'chez-maman-clou'`)).rows;
  console.log('OK seed — entreprises:', tous.length + 1, '| partenaires:', sp);
  await pool.end();
})().catch((e) => { console.error('ECHEC', e); process.exit(1); });
