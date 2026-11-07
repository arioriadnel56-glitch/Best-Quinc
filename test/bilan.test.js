'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { startServer, setHandler, calls } = require('./helpers');
const jwt = require('../server/lib/jwt');
const { Pdf, largeur, enOctets, tenir } = require('../server/lib/pdf');
const bilan = require('../server/lib/bilan');

const SECRET = process.env.JWT_SECRET;
let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });
test.beforeEach(() => { calls.length = 0; });

const appeler = (method, p, body, tok) => fetch(srv.base + p, {
  method,
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Session simulée + réponses de la base pour le calcul d'un bilan
function session(role = 'proprietaire', extra = async () => ({ rows: [], rowCount: 0 })) {
  setHandler(async (sql, params) => {
    if (sql.includes('u.mdp_temporaire')) return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'Koffi Zinsou', email: 'p@a.fr', role, actif: true, entreprise_statut: 'actif', mdp_temporaire: false, mdp_modifie_le: null }] };
    if (sql.includes('FROM abonnements')) return { rows: [{ id: 1, date_fin: '2099-01-01' }] };
    return extra(sql, params);
  });
  return jwt.sign({ sub: 3, typ: 'user' }, SECRET);
}

const baseDonnees = async (sql) => {
  if (sql.includes('to_char(now() AT TIME ZONE')) return { rows: [{ maintenant: '2026-10-30 14:05', aujourdhui: '2026-10-30' }] };
  if (sql.includes('GROUP BY vente_id')) return { rows: [{ nb: 1, total: 40000, acomptes: 10000, reste: 30000 }] };
  if (sql.includes('FROM reglements')) return { rows: [{ mode: 'especes', nb: 1, total: 5000 }] };
  if (sql.includes('FROM remboursements')) return { rows: [{ nb: 1, total: 2000, rendu: 2000 }] };
  if (sql.includes('GROUP BY mode_paiement')) return { rows: [{ mode: 'especes', nb: 5, total: 50000 }, { mode: 'mobile_money', nb: 2, total: 30000 }, { mode: 'credit', nb: 1, total: 40000 }] };
  if (sql.includes('AS ca,')) return { rows: [{ ca: 120000, cout: 90000 }] };
  if (sql.includes('l.nom_produit, SUM')) return { rows: [{ nom_produit: 'Ciment CPJ 32,5 (sac 50 kg)', quantite: 20, total: 160000 }, { nom_produit: 'Peinture (20 L) « pro »', quantite: 3, total: 88500 }] };
  if (sql.includes('Compte supprimé')) return { rows: [{ vendeur: 'Koffi Zinsou', nb: 8, total: 120000 }] };
  if (sql.includes("to_char((cree_le AT TIME ZONE $2)::date")) return { rows: [{ jour: '2026-10-29', nb: 3, total: 40000 }, { jour: '2026-10-30', nb: 5, total: 80000 }] };
  if (sql.includes('COUNT(*) FILTER')) return { rows: [{ faibles: 4, valeur: 3500000 }] };
  if (sql.includes('anomalie IS NOT NULL')) return { rows: [{ nb: 1 }] };
  if (sql.includes('FROM entreprises e LEFT JOIN pwa_configs')) return { rows: [{ nom: 'Quincaillerie Zinsou', couleur: '#1F4E79' }] };
  return { rows: [], rowCount: 0 };
};

test('dates : calcul civil indépendant du fuseau, mois précédent et validité', () => {
  assert.equal(bilan.ajouterJours('2026-03-01', -1), '2026-02-28');
  assert.equal(bilan.ajouterJours('2028-03-01', -1), '2028-02-29');
  assert.equal(bilan.nbJours('2026-10-01', '2026-10-31'), 31);
  assert.equal(bilan.dateValide('2026-02-30'), false);
  assert.equal(bilan.dateValide('2026-10-30'), true);
  assert.equal(bilan.dateFr('2026-10-30'), '30/10/2026');
});

test('périodes prédéfinies : aujourd\'hui, hier, 7 jours, ce mois, mois dernier', async () => {
  setHandler(baseDonnees);
  const r = (periode) => bilan.resoudrePeriode({ periode });
  assert.deepEqual(await r('aujourdhui'), { du: '2026-10-30', au: '2026-10-30', periode: 'aujourdhui' });
  assert.deepEqual(await r('hier'), { du: '2026-10-29', au: '2026-10-29', periode: 'hier' });
  assert.deepEqual(await r('7j'), { du: '2026-10-24', au: '2026-10-30', periode: '7j' });
  assert.deepEqual(await r('mois'), { du: '2026-10-01', au: '2026-10-30', periode: 'mois' });
  assert.deepEqual(await r('mois_precedent'), { du: '2026-09-01', au: '2026-09-30', periode: 'mois_precedent' });
  assert.equal((await bilan.resoudrePeriode({})).periode, 'aujourdhui');
  await assert.rejects(() => r('nimporte'), /Période invalide/);
  await assert.rejects(() => bilan.resoudrePeriode({ du: '2026-10-05', au: '2026-10-01' }), /après la date de début/);
  await assert.rejects(() => bilan.resoudrePeriode({ du: '2025-01-01', au: '2026-10-01' }), /un an/);
  await assert.rejects(() => bilan.resoudrePeriode({ du: '2026-02-30', au: '2026-03-01' }), /valides/);
});

test('GET /api/bilan : chiffre d\'affaires, argent encaissé, marge et détails calculés', async () => {
  const tok = session('proprietaire', baseDonnees);
  const res = await appeler('GET', '/api/bilan?periode=hier', undefined, tok);
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.du, '2026-10-29');
  assert.equal(b.ventes.nb, 8);
  assert.equal(b.ventes.brut, 120000);
  assert.equal(b.ventes.panier_moyen, 15000);
  assert.equal(b.ca_net, 118000, 'ventes − remboursements');
  assert.equal(b.encaisse.comptant, 80000);
  assert.equal(b.encaisse.total, 93000, 'comptant 80 000 + acomptes 10 000 + règlements 5 000 − rendu 2 000');
  assert.equal(b.credit.reste, 30000);
  assert.equal(b.marge.marge, 30000);
  assert.equal(b.top_produits.length, 2);
  assert.equal(b.stock.faibles, 4);
  // Le calcul est borné à l'entreprise de l'utilisateur et au fuseau configuré
  const q = calls.find((c) => c.sql.includes('GROUP BY mode_paiement') && c.sql.includes('FROM ventes'));
  assert.equal(q.params[0], 9);
  assert.equal(q.params[2], '2026-10-29');
  // L'acompte d'origine d'une vente à crédit tient compte des sommes rendues (montant_paye est net des remboursements)
  const cr = calls.find((c) => c.sql.includes('GROUP BY vente_id') && c.sql.includes('AS acomptes'));
  assert.match(cr.sql, /montant_paye \+ COALESCE\(rb\.rendu, 0\) - COALESCE\(r\.reg, 0\)/);
});

test('bilan réservé au propriétaire (secrétaire refusée) et abonnement exigé', async () => {
  const tok = session('secretaire', baseDonnees);
  for (const [m, p] of [['GET', '/api/bilan'], ['GET', '/api/bilan/pdf'], ['POST', '/api/bilans'], ['GET', '/api/bilans'], ['GET', '/api/bilans/1'], ['GET', '/api/bilans/1/pdf'], ['DELETE', '/api/bilans/1']]) {
    assert.equal((await appeler(m, p, m === 'POST' ? {} : undefined, tok)).status, 403, `${m} ${p}`);
  }
  assert.equal((await fetch(srv.base + '/api/bilan')).status, 401);
});

test('période invalide : refusée proprement', async () => {
  const tok = session('proprietaire', baseDonnees);
  assert.equal((await appeler('GET', '/api/bilan?periode=nimporte', undefined, tok)).status, 400);
  assert.equal((await appeler('GET', '/api/bilan?du=2026-10-05&au=2026-10-01', undefined, tok)).status, 400);
  assert.equal((await appeler('GET', '/api/bilan?du=abc&au=def', undefined, tok)).status, 400);
});

// Lit tous les flux du PDF (décompressés) pour vérifier le texte réellement écrit
function texteDuPdf(buf) {
  const brut = buf.toString('latin1');
  let t = '';
  for (const m of brut.matchAll(/stream\n([\s\S]*?)\nendstream/g)) t += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1') + '\n';
  return t;
}

test('GET /api/bilan/pdf : vrai fichier PDF, nom de fichier daté, contenu du bilan', async () => {
  const tok = session('proprietaire', baseDonnees);
  const res = await appeler('GET', '/api/bilan/pdf?periode=7j', undefined, tok);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="bilan-2026-10-24_au_2026-10-30\.pdf"/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.match(buf.subarray(-8).toString('latin1'), /%%EOF/);
  assert.equal(Number(res.headers.get('content-length')), buf.length);
  const t = texteDuPdf(buf);
  assert.match(t, /Quincaillerie Zinsou/);
  assert.match(t, /Du 24\/10\/2026 au 30\/10\/2026/);
  assert.match(t, /93 000 F CFA/, 'total encaissé');
  assert.match(t, /118 000 F CFA/, 'chiffre d\'affaires net');
  assert.match(t, /Page 1 \/ \d/);
  assert.ok(!/undefined|NaN/.test(t), 'aucune valeur manquante');
  // Le pied de page et les accents sont corrects (WinAnsi)
  assert.ok(t.includes('Fiche g\\351n\\351r\\351e') || t.includes('Fiche g\xe9n\xe9r\xe9e'));
});

test('POST /api/bilans : enregistre un instantané numéroté', async () => {
  const tok = session('proprietaire', async (sql, params) => {
    if (sql.includes('INSERT INTO bilans')) return { rows: [{ id: 12, numero: 4 }] };
    if (sql.includes('MAX(numero)')) return { rows: [{ n: 4 }] };
    return baseDonnees(sql, params);
  });
  const res = await appeler('POST', '/api/bilans', { periode: 'aujourdhui', note: 'Fin de journée' }, tok);
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: 12, numero: 4 });
  const ins = calls.find((c) => c.sql.includes('INSERT INTO bilans'));
  assert.equal(ins.params[0], 9);
  assert.equal(ins.params[1], 4);
  assert.equal(ins.params[4], 'Fin de journée');
  assert.equal(JSON.parse(ins.params[5]).ca_net, 118000);
  assert.ok(calls.some((c) => c.sql.includes('FOR UPDATE')), 'numérotation verrouillée');
});

test('bilans enregistrés : liste, détail, PDF et suppression (propriétaire de l\'entreprise seulement)', async () => {
  const donnees = { du: '2026-10-29', au: '2026-10-29', genere_le: '2026-10-30 10:00', ventes: { nb: 2, brut: 5000, panier_moyen: 2500 }, modes: [], remboursements: { nb: 0, total: 0, rendu: 0 }, ca_net: 5000, credit: { nb: 0, total: 0, acomptes: 0, reste: 0 }, reglements: { nb: 0, total: 0, par_mode: {} }, encaisse: { comptant: 5000, acomptes: 0, reglements: 0, rendu: 0, total: 5000 }, marge: { cout: 0, marge: 5000 }, top_produits: [], vendeurs: [], jours: [], stock: { faibles: 0, valeur: 0 }, anomalies: 0 };
  let existe = true;
  const tok = session('proprietaire', async (sql, params) => {
    if (sql.includes('FROM bilans b LEFT JOIN utilisateurs u ON u.id = b.cree_par') && sql.includes('b.donnees,')) return { rows: existe ? [{ id: 5, numero: 2, note: 'Test', donnees, cree_par_nom: 'Koffi' }] : [] };
    if (sql.includes('FROM bilans b')) return { rows: [{ id: 5, numero: 2, du: '2026-10-29', au: '2026-10-29', note: 'Test', nb_ventes: 2, ca_net: 5000, cree_par_nom: 'Koffi', cree_le: '2026-10-30 10:00' }] };
    if (sql.startsWith('DELETE FROM bilans')) { const ok = existe; existe = false; return { rowCount: ok ? 1 : 0, rows: [] }; }
    return baseDonnees(sql, params);
  });
  const liste = await (await appeler('GET', '/api/bilans', undefined, tok)).json();
  assert.equal(liste[0].numero, 2);
  const d = await (await appeler('GET', '/api/bilans/5', undefined, tok)).json();
  assert.equal(d.ca_net, 5000);
  assert.equal(d.numero, 2);
  const pdf = await appeler('GET', '/api/bilans/5/pdf', undefined, tok);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-disposition'), /bilan-n2-2026-10-29\.pdf/);
  assert.match(texteDuPdf(Buffer.from(await pdf.arrayBuffer())), /Bilan n\\? ?0002|0002/);
  assert.equal((await appeler('DELETE', '/api/bilans/5', undefined, tok)).status, 200);
  const del = calls.find((c) => c.sql.startsWith('DELETE FROM bilans'));
  assert.deepEqual(del.params, [5, 9], 'filtré par entreprise');
  assert.equal((await appeler('DELETE', '/api/bilans/5', undefined, tok)).status, 404);
  assert.equal((await appeler('GET', '/api/bilans/5', undefined, tok)).status, 404);
  assert.equal((await appeler('GET', '/api/bilans/abc', undefined, tok)).status, 400);
});

test('suppression d\'un inventaire : seulement s\'il est annulé', async () => {
  const tok = session('proprietaire', async (sql) => (sql.startsWith('DELETE FROM inventaires') ? { rowCount: 0, rows: [] } : { rows: [] }));
  const refus = await appeler('DELETE', '/api/inventaires/7', undefined, tok);
  assert.equal(refus.status, 409);
  const del = calls.find((c) => c.sql.startsWith('DELETE FROM inventaires'));
  assert.match(del.sql, /statut = 'annule'/);
  assert.deepEqual(del.params, [7, 9]);
  const tok2 = session('proprietaire', async (sql) => (sql.startsWith('DELETE FROM inventaires') ? { rowCount: 1, rows: [] } : { rows: [] }));
  assert.equal((await appeler('DELETE', '/api/inventaires/7', undefined, tok2)).status, 200);
  const sec = session('secretaire');
  assert.equal((await appeler('DELETE', '/api/inventaires/7', undefined, sec)).status, 403);
});

test('suppression d\'un membre : pas soi-même, seulement un compte désactivé', async () => {
  const tok = session('proprietaire', async (sql) => (sql.startsWith('DELETE FROM utilisateurs') ? { rowCount: 0, rows: [] } : { rows: [] }));
  assert.equal((await appeler('DELETE', '/api/utilisateurs/3', undefined, tok)).status, 400, 'soi-même');
  assert.equal((await appeler('DELETE', '/api/utilisateurs/8', undefined, tok)).status, 409, 'compte actif');
  const del = calls.find((c) => c.sql.startsWith('DELETE FROM utilisateurs'));
  assert.match(del.sql, /actif = false/);
  assert.deepEqual(del.params, [8, 9]);
  const tok2 = session('proprietaire', async (sql) => (sql.startsWith('DELETE FROM utilisateurs') ? { rowCount: 1, rows: [] } : { rows: [] }));
  assert.equal((await appeler('DELETE', '/api/utilisateurs/8', undefined, tok2)).status, 200);
  assert.equal((await appeler('DELETE', '/api/utilisateurs/8', undefined, session('secretaire'))).status, 403);
});

test('PDF : largeurs, accents WinAnsi, texte tronqué, parenthèses échappées, structure valide', () => {
  assert.ok(Math.abs(largeur('Bonjour', 10) - 34.5) < 0.1);
  assert.ok(largeur('Bonjour', 10, true) > largeur('Bonjour', 10));
  assert.equal(largeur('é', 10), largeur('e', 10));
  assert.equal(enOctets('é œ ’ \u202f x'), '\xe9 \x9c \x92   x'.replace('  ', '  '));
  assert.equal(enOctets('日'), '?');
  const long = tenir('Un très long nom de produit qui ne tient pas dans la colonne', 10, false, 100);
  assert.ok(long.endsWith('…') && largeur(long, 10) <= 100);
  const p = new Pdf({ titre: 'Titre (test)' });
  p.texte(40, 60, 'Montant (net) \\ 100', { taille: 12 });
  p.nouvellePage();
  p.rect(10, 10, 50, 20, { fond: [1, 0, 0], trait: [0, 0, 0] });
  const buf = p.construire();
  const s = buf.toString('latin1');
  assert.match(s, /\/Count 2/);
  assert.match(s, /Titre \\\(test\\\)/);
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)[1]);
  assert.equal(s.slice(startxref, startxref + 4), 'xref', 'la table xref pointe au bon endroit');
  assert.match(texteDuPdf(buf), /\(Montant \\\(net\\\) \\\\ 100\) Tj/);
});

test('PDF : un bilan long passe sur plusieurs pages sans erreur', () => {
  const top = Array.from({ length: 10 }, (_, i) => ({ nom_produit: `Produit numéro ${i + 1}`, quantite: i + 1, total: (i + 1) * 1000 }));
  const jours = Array.from({ length: 60 }, (_, i) => ({ jour: bilan.ajouterJours('2026-09-01', i), nb: i % 7, total: 10000 + i * 500 }));
  const b = { du: '2026-09-01', au: '2026-10-30', genere_le: '2026-10-30 10:00', ventes: { nb: 10, brut: 100000, panier_moyen: 10000 }, modes: [{ mode: 'especes', nb: 10, total: 100000 }], remboursements: { nb: 0, total: 0, rendu: 0 }, ca_net: 100000, credit: { nb: 0, total: 0, acomptes: 0, reste: 0 }, reglements: { nb: 0, total: 0, par_mode: {} }, encaisse: { comptant: 100000, acomptes: 0, reglements: 0, rendu: 0, total: 100000 }, marge: { cout: 60000, marge: 40000 }, top_produits: top, vendeurs: [{ vendeur: 'A', nb: 10, total: 100000 }], jours, stock: { faibles: 0, valeur: 1 }, anomalies: 0 };
  const buf = bilan.pdfBilan({ entreprise: 'Test', couleur: '#8B1E3F', bilan: b, par: 'Moi' });
  const n = Number(/\/Count (\d+)/.exec(buf.toString('latin1'))[1]);
  assert.ok(n >= 2, `pages : ${n}`);
  assert.match(texteDuPdf(buf), new RegExp(`Page ${n} / ${n}`));
});

test('bilan d\'une période sans aucune vente : zéros partout, PDF valide, rien de « undefined »', async () => {
  const tok = session('proprietaire', async (sql) => {
    if (sql.includes('to_char(now() AT TIME ZONE')) return { rows: [{ maintenant: '2026-10-31 09:00', aujourdhui: '2026-10-31' }] };
    if (sql.includes('FROM entreprises e LEFT JOIN pwa_configs')) return { rows: [{ nom: 'Boutique vide', couleur: null }] };
    if (sql.includes('COUNT(*) FILTER')) return { rows: [{ faibles: 0, valeur: 0 }] };
    return { rows: [], rowCount: 0 };
  });
  const b = await (await appeler('GET', '/api/bilan?periode=aujourdhui', undefined, tok)).json();
  assert.equal(b.ventes.nb, 0);
  assert.equal(b.ventes.panier_moyen, 0);
  assert.equal(b.ca_net, 0);
  assert.equal(b.encaisse.total, 0);
  assert.deepEqual(b.top_produits, []);
  const res = await appeler('GET', '/api/bilan/pdf?periode=aujourdhui', undefined, tok);
  assert.equal(res.status, 200);
  const t = texteDuPdf(Buffer.from(await res.arrayBuffer()));
  assert.ok(!/undefined|NaN|null/.test(t));
  assert.match(t, /aucune vente/);
});

test('PDF : noms hostiles (parenthèses, barres obliques, emoji, très longs) ne cassent pas le fichier', () => {
  const b = { du: '2026-10-30', au: '2026-10-30', genere_le: '2026-10-30 10:00', ventes: { nb: 1, brut: 1000, panier_moyen: 1000 }, modes: [{ mode: 'especes', nb: 1, total: 1000 }], remboursements: { nb: 0, total: 0, rendu: 0 }, ca_net: 1000, credit: { nb: 0, total: 0, acomptes: 0, reste: 0 }, reglements: { nb: 0, total: 0, par_mode: {} }, encaisse: { comptant: 1000, acomptes: 0, reglements: 0, rendu: 0, total: 1000 }, marge: { cout: 0, marge: 1000 }, top_produits: [{ nom_produit: `Vis ) ( \\ ${'x'.repeat(300)} 😀 日本`, quantite: 1, total: 1000 }], vendeurs: [{ vendeur: 'A) Tj /F1 99 Tf (B', nb: 1, total: 1000 }], jours: [], stock: { faibles: 0, valeur: 0 }, anomalies: 0 };
  const buf = bilan.pdfBilan({ entreprise: 'N\u2019Dah (Cotonou) \\ \u20ac 😀', couleur: 'pas-une-couleur', bilan: b, note: ')'.repeat(5), par: '(' });
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  const t = texteDuPdf(buf);
  assert.ok(!t.includes('99 Tf (B'), 'le texte ne peut pas injecter d\'instructions PDF');
  assert.match(buf.toString('latin1'), /\/Count [12]/);
});
