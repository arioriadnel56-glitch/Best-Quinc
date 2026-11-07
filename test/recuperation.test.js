'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, setHandler, calls } = require('./helpers');
const jwt = require('../server/lib/jwt');
const recovery = require('../server/lib/recovery');
const { lireProduits, lireCsv, lireEntier } = require('../server/lib/csv');
const { hashPassword } = require('../server/lib/password');

const SECRET = process.env.JWT_SECRET;
const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const post = (base, p, body, tok = '') => fetch(base + p, { method: 'POST', headers: H(tok), body: JSON.stringify(body) });

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });
test.beforeEach(() => { calls.length = 0; });

// ---------- Codes de récupération ----------
test('code de récupération : format, tolérance de saisie, rejet des mauvais codes', () => {
  const c = recovery.genererCode();
  assert.match(c, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  assert.notEqual(c, recovery.genererCode());
  const h = recovery.empreinte(c);
  assert.equal(h.length, 64);
  assert.equal(recovery.correspond(c, h), true);
  assert.equal(recovery.correspond(c.toLowerCase().replace(/-/g, ' '), h), true);
  assert.equal(recovery.correspond('AAAAA-AAAAA-AAAAA-AAAAA', h), false);
  assert.equal(recovery.correspond(c, null), false);
  assert.equal(recovery.correspond(c, ''), false);
  assert.match(recovery.genererTemporaire(), /^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
});

// ---------- Import CSV ----------
test('csv : séparateurs, guillemets, BOM, retours à la ligne dans un champ', () => {
  assert.deepEqual(lireCsv('a,b\n1,"x,y"').map((l) => l.cases), [['a', 'b'], ['1', 'x,y']]);
  assert.deepEqual(lireCsv('\uFEFFa;b\r\n"1 ""cm""";2').map((l) => l.cases), [['a', 'b'], ['1 "cm"', '2']]);
  assert.deepEqual(lireCsv('a\tb\n1\t2').map((l) => l.cases), [['a', 'b'], ['1', '2']]);
  assert.equal(lireCsv('a;b\n\n\n1;2\n').length, 2);
  const l = lireCsv('a;b\n"x\ny";2\n3;4');
  assert.equal(l[1].no, 2);
  assert.equal(l[2].no, 4);
  assert.throws(() => lireCsv('a;b\n"jamais refermé;2'), /guillemet/);
});

test('csv : montants à la française et refus des valeurs absurdes', () => {
  assert.equal(lireEntier('85000').valeur, 85000);
  assert.equal(lireEntier('85 000').valeur, 85000);
  assert.equal(lireEntier('85.000').valeur, 85000);
  assert.equal(lireEntier('1,500,000').valeur, 1500000);
  assert.equal(lireEntier('6 500 F CFA').valeur, 6500);
  assert.equal(lireEntier('12,5').valeur, 13);
  assert.equal(lireEntier('').vide, true);
  assert.equal(lireEntier('-5').erreur, true);
  assert.equal(lireEntier('abc').erreur, true);
  assert.equal(lireEntier('99999999999').erreur, true);
});

test('csv : produits valides, lignes refusées avec raison, colonnes obligatoires', () => {
  const r = lireProduits("Désignation;Réf;Famille;Unité;Prix d'achat;Prix de vente;Stock initial;Seuil\n" +
    'Ciment;CIM-1;Ciment;sac;5 800;6 500;120;20\n;X;;;;100;;\nPelle;P1;;;abc;5000;;\nClou;;Quinc;kg;;1200;;');
  assert.equal(r.total, 4);
  assert.equal(r.valides.length, 2);
  assert.deepEqual(r.valides[0], { ligne: 2, nom: 'Ciment', reference: 'CIM-1', categorie: 'Ciment', unite: 'sac', prix_achat: 5800, prix_vente: 6500, stock: 120, seuil: 20 });
  assert.equal(r.valides[1].seuil, 5);
  assert.equal(r.valides[1].unite, 'kg');
  assert.deepEqual(r.refuses.map((x) => [x.ligne, x.raison.split(' ')[0]]), [[3, 'Nom'], [4, 'Prix']]);
  assert.throws(() => lireProduits('nom;reference\nA;B'), /prix_vente/);
  assert.throws(() => lireProduits('nom;prix_vente'), /vide/);
  const gros = 'nom;prix_vente\n' + Array.from({ length: 2001 }, (_, i) => `P${i};100`).join('\n');
  assert.throws(() => lireProduits(gros), /2000/);
});

function ctxProprio(extra = async () => ({ rows: [] })) {
  setHandler(async (sql, params) => {
    if (sql.includes('FROM utilisateurs u JOIN entreprises e') && sql.includes('u.mdp_temporaire')) {
      return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'P', email: 'p@a.fr', role: 'proprietaire', actif: true, entreprise_statut: 'actif', mdp_temporaire: false, mdp_modifie_le: null, a_code_recuperation: true }] };
    }
    if (sql.includes('FROM abonnements')) return { rows: [{ id: 1, date_fin: '2099-01-01' }] };
    return extra(sql, params);
  });
  return jwt.sign({ sub: 3, typ: 'user' }, SECRET);
}

test('import : la simulation n\'écrit rien et signale les doublons ; l\'import crée catégories et produits', async () => {
  let n = 0;
  const tok = ctxProprio(async (sql) => {
    if (sql.includes('SELECT lower(nom)')) return { rows: [{ nom: 'clous 70 mm', reference: null }, { nom: 'ciment', reference: 'cim-1' }] };
    if (sql.includes('FROM categories')) return { rows: [{ id: 1, nom: 'Ciment' }] };
    if (sql.includes('INSERT INTO categories') || sql.includes('INSERT INTO produits')) return { rows: [{ id: ++n }] };
    return { rows: [] };
  });
  const csv = 'nom;reference;categorie;prix_vente;stock\nCiment CPJ;CIM-1;ciment;6500;10\nClous 70 mm;;Quinc;1200;5\nPelle;PE-1;Outillage;5000;3\nMarteau;MA-1;outillage;4000;0\nPelle bis;PE-1;;100;\n';

  let r = await post(srv.base, '/api/produits/import', { contenu: csv, simuler: true }, tok);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.simulation, true);
  assert.equal(j.a_importer, 2);
  assert.equal(j.importes, 0);
  assert.equal(j.nb_ignores, 3);
  assert.ok(j.ignores.some((i) => /référence/.test(i.raison)) && j.ignores.some((i) => /même nom/.test(i.raison)));
  assert.equal(calls.filter((c) => /INSERT/.test(c.sql)).length, 0, 'aucune écriture en simulation');

  calls.length = 0;
  r = await post(srv.base, '/api/produits/import', { contenu: csv, simuler: false }, tok);
  j = await r.json();
  assert.equal(j.importes, 2);
  assert.equal(calls.filter((c) => c.sql.includes('INSERT INTO produits')).length, 2);
  assert.equal(calls.filter((c) => c.sql.includes('INSERT INTO categories')).length, 1, 'Outillage créée une seule fois malgré la casse');
  assert.equal(calls.filter((c) => c.sql.includes('INSERT INTO mouvements_stock')).length, 1, 'mouvement seulement si stock > 0');
});

test('import : réservé au propriétaire, fichier vide ou illisible refusé', async () => {
  const tok = ctxProprio();
  assert.equal((await post(srv.base, '/api/produits/import', { contenu: '' }, tok)).status, 400);
  assert.equal((await post(srv.base, '/api/produits/import', { contenu: 'nom;reference\nA;B' }, tok)).status, 400);
  const sec = jwt.sign({ sub: 4, typ: 'user' }, SECRET);
  setHandler(async (sql) => {
    if (sql.includes('u.mdp_temporaire')) return { rows: [{ id: 4, entreprise_id: 9, nom_complet: 'S', email: 's@a.fr', role: 'secretaire', actif: true, entreprise_statut: 'actif' }] };
    if (sql.includes('FROM abonnements')) return { rows: [{ id: 1, date_fin: '2099-01-01' }] };
    return { rows: [] };
  });
  assert.equal((await post(srv.base, '/api/produits/import', { contenu: 'nom;prix_vente\nA;1', simuler: true }, sec)).status, 403);
});

// ---------- Récupération du mot de passe ----------
test('inscription : le code est renvoyé une fois, seule son empreinte va en base', async () => {
  setHandler(async (sql) => {
    if (sql.includes('SELECT 1 FROM entreprises')) return { rows: [] };
    if (sql.includes('INSERT INTO entreprises')) return { rows: [{ id: 5, nom: 'Ets Test', slug: 'ets-test' }] };
    if (sql.includes('INSERT INTO utilisateurs')) return { rows: [{ id: 8, nom_complet: 'Jean', email: 'j@t.fr', role: 'proprietaire' }] };
    return { rows: [] };
  });
  const r = await post(srv.base, '/api/entreprises/inscription', { nom_entreprise: 'Ets Test', nom_complet: 'Jean Test', email: 'j@t.fr', mot_de_passe: 'Brouette-Ciment-47' });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.match(j.code_recuperation, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  const ins = calls.find((c) => c.sql.includes('INSERT INTO utilisateurs'));
  assert.ok(ins.params.includes(recovery.empreinte(j.code_recuperation)));
  assert.ok(!JSON.stringify(calls).includes(j.code_recuperation), 'le code ne doit jamais être envoyé en clair à la base');
});

test('mot de passe oublié : bon code -> nouveau mot de passe + nouveau code ; mauvais code -> refus neutre', async () => {
  const code = recovery.genererCode();
  setHandler(async (sql) => (sql.includes('code_recuperation_hash') && sql.includes('SELECT')
    ? { rows: [{ id: 11, code_recuperation_hash: recovery.empreinte(code), actif: true, statut: 'actif' }] } : { rows: [] }));

  let r = await post(srv.base, '/api/auth/recuperer', { slug: 'zinsou', email: 'rec1@a.fr', code: 'AAAAA-AAAAA-AAAAA-AAAAA', nouveau: 'nouveau-mdp-1' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).erreur, /incorrect/);
  assert.equal(calls.filter((c) => /UPDATE/.test(c.sql)).length, 0);

  calls.length = 0;
  r = await post(srv.base, '/api/auth/recuperer', { slug: 'zinsou', email: 'rec1@a.fr', code: code.toLowerCase(), nouveau: 'nouveau-mdp-1' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(jwt.verify(j.token, SECRET).sub, 11);
  assert.notEqual(j.code_recuperation, code);
  const up = calls.find((c) => c.sql.includes('UPDATE utilisateurs'));
  assert.match(up.sql, /mdp_modifie_le = now\(\)/);
  assert.ok(up.params[0].startsWith('scrypt$') && !JSON.stringify(up.params).includes('nouveau-mdp-1'));
  assert.equal(up.params[1], recovery.empreinte(j.code_recuperation), 'l\'ancien code est remplacé');
});

test('mot de passe oublié : compte inconnu, sans code (secrétaire) ou espace suspendu -> même refus', async () => {
  const cas = [[], [{ id: 1, code_recuperation_hash: null, actif: true, statut: 'actif' }],
    [{ id: 1, code_recuperation_hash: recovery.empreinte('AAAAA-AAAAA-AAAAA-AAAAA'), actif: true, statut: 'suspendu' }]];
  for (const [i, rows] of cas.entries()) {
    setHandler(async () => ({ rows }));
    const r = await post(srv.base, '/api/auth/recuperer', { slug: 'zinsou', email: `cas${i}@a.fr`, code: 'AAAAA-AAAAA-AAAAA-AAAAA', nouveau: 'nouveau-mdp-1' });
    assert.equal(r.status, 400, `cas ${i}`);
    assert.equal(calls.filter((c) => /UPDATE/.test(c.sql)).length, 0);
  }
});

test('mot de passe oublié : essais limités (anti-force brute)', async () => {
  setHandler(async () => ({ rows: [] }));
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const r = await post(srv.base, '/api/auth/recuperer', { slug: 'zinsou', email: 'brute@a.fr', code: 'AAAAA-AAAAA-AAAAA-AAAAA', nouveau: 'nouveau-mdp-1' });
    codes.push(r.status);
  }
  assert.deepEqual(codes.slice(0, 5), [400, 400, 400, 400, 400]);
  assert.equal(codes[5], 429);
});

test('un changement de mot de passe ferme les sessions plus anciennes', async () => {
  const futur = new Date(Date.now() + 60000).toISOString();
  const passe = new Date(Date.now() - 3600000).toISOString();
  const tok = jwt.sign({ sub: 3, typ: 'user' }, SECRET);
  const avec = (mdp) => setHandler(async (sql) => {
    if (sql.includes('u.mdp_temporaire')) return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'P', email: 'p@a.fr', role: 'proprietaire', actif: true, entreprise_statut: 'actif', mdp_temporaire: false, mdp_modifie_le: mdp, a_code_recuperation: false }] };
    if (sql.includes('FROM entreprises e JOIN pwa_configs')) return { rows: [{ nom: 'E', slug: 'e', nom_app: 'E', couleur: '#3E5C76' }] };
    return { rows: [] };
  });
  avec(futur);
  assert.equal((await fetch(`${srv.base}/api/auth/me`, { headers: H(tok) })).status, 401);
  avec(passe);
  const ok = await fetch(`${srv.base}/api/auth/me`, { headers: H(tok) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).utilisateur.mdp_temporaire, false);
});

test('mot de passe provisoire signalé à la connexion', async () => {
  const tok = jwt.sign({ sub: 3, typ: 'user' }, SECRET);
  setHandler(async (sql) => {
    if (sql.includes('u.mdp_temporaire')) return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'P', email: 'p@a.fr', role: 'secretaire', actif: true, entreprise_statut: 'actif', mdp_temporaire: true, mdp_modifie_le: null, a_code_recuperation: false }] };
    if (sql.includes('FROM entreprises e JOIN pwa_configs')) return { rows: [{ nom: 'E', slug: 'e', nom_app: 'E', couleur: '#3E5C76' }] };
    return { rows: [] };
  });
  assert.equal((await (await fetch(`${srv.base}/api/auth/me`, { headers: H(tok) })).json()).utilisateur.mdp_temporaire, true);
});

test('changement de mot de passe : ancien requis, mot de passe identique refusé, jeton neuf renvoyé', async () => {
  const hash = await hashPassword('ancien-mdp-ok');
  const tok = jwt.sign({ sub: 3, typ: 'user' }, SECRET);
  setHandler(async (sql) => {
    if (sql.includes('u.mdp_temporaire')) return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'P', email: 'p@a.fr', role: 'proprietaire', actif: true, entreprise_statut: 'actif', mdp_temporaire: true, mdp_modifie_le: null }] };
    if (sql.includes('SELECT mot_de_passe_hash')) return { rows: [{ mot_de_passe_hash: hash }] };
    return { rows: [] };
  });
  assert.equal((await post(srv.base, '/api/auth/mot-de-passe', { ancien: 'faux-faux-faux', nouveau: 'nouveau-mdp-2' }, tok)).status, 400);
  assert.equal((await post(srv.base, '/api/auth/mot-de-passe', { ancien: 'ancien-mdp-ok', nouveau: 'ancien-mdp-ok' }, tok)).status, 400);
  const r = await post(srv.base, '/api/auth/mot-de-passe', { ancien: 'ancien-mdp-ok', nouveau: 'nouveau-mdp-2' }, tok);
  assert.equal(r.status, 200);
  assert.equal(jwt.verify((await r.json()).token, SECRET).sub, 3);
  const up = calls.find((c) => c.sql.includes('UPDATE utilisateurs'));
  assert.match(up.sql, /mdp_temporaire = false/);
});

// ---------- Récupération par le super admin ----------
test('super admin : mot de passe provisoire et nouveau code, limités à l\'entreprise ciblée', async () => {
  const adminTok = jwt.sign({ sub: 1, typ: 'admin' }, SECRET);
  setHandler(async (sql, params) => {
    if (sql.includes('FROM admins_plateforme WHERE id')) return { rows: [{ id: 1, nom_complet: 'Adnel', email: 'a@b.fr', actif: true }] };
    if (sql.includes('UPDATE utilisateurs') && params.includes(777)) return { rows: [] }; // utilisateur d'une autre entreprise
    if (sql.includes('UPDATE utilisateurs')) return { rows: [{ email: 'p@a.fr' }] };
    return { rows: [] };
  });
  let r = await post(srv.base, '/api/admin/entreprises/9/utilisateurs/3/reinitialiser', {}, adminTok);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.match(j.mot_de_passe_temporaire, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
  const up = calls.find((c) => c.sql.includes('UPDATE utilisateurs'));
  assert.match(up.sql, /mdp_temporaire = true/);
  assert.ok(up.params[0].startsWith('scrypt$'));
  assert.ok(!JSON.stringify(calls).includes(j.mot_de_passe_temporaire));
  assert.deepEqual(up.params.slice(1), [3, 9], 'filtré par utilisateur ET entreprise');

  assert.equal((await post(srv.base, '/api/admin/entreprises/9/utilisateurs/777/reinitialiser', {}, adminTok)).status, 404);

  r = await post(srv.base, '/api/admin/entreprises/9/utilisateurs/3/code-recuperation', {}, adminTok);
  j = await r.json();
  assert.match(j.code_recuperation, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);

  const userTok = jwt.sign({ sub: 3, typ: 'user' }, SECRET);
  assert.equal((await post(srv.base, '/api/admin/entreprises/9/utilisateurs/3/reinitialiser', {}, userTok)).status, 401);
});
