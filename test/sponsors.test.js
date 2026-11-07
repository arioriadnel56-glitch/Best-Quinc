'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { setHandler, calls } = require('./helpers');
const { handle } = require('../server');
const jwt = require('../server/lib/jwt');
const S = require('../server/lib/sponsors');

const SECRET = process.env.JWT_SECRET;
const tokProprio = jwt.sign({ sub: 3, typ: 'user' }, SECRET);
const tokSecretaire = jwt.sign({ sub: 4, typ: 'user' }, SECRET);
const tokAdmin = jwt.sign({ sub: 1, typ: 'admin' }, SECRET);
const JETON = 'ab'.repeat(24);

let serveur; let url;
test.before(async () => {
  serveur = http.createServer((req, res) => { handle(req, res); });
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${serveur.address().port}`;
});
test.after(async () => { serveur.closeAllConnections(); await new Promise((r) => serveur.close(r)); });

// Base simulée : identité, abonnement, puis réponses propres à chaque test (première règle qui correspond)
let regles = [];
function base(...extra) {
  regles = extra;
  calls.length = 0;
  setHandler(async (sql, params) => {
    if (sql.includes('u.mdp_temporaire')) {
      const id = params[0];
      return { rows: [{ id, entreprise_id: 9, nom_complet: id === 3 ? 'Awa Koffi' : 'Secrétaire', email: 'u@a.fr', role: id === 3 ? 'proprietaire' : 'secretaire', actif: true, entreprise_statut: 'actif' }] };
    }
    if (sql.includes('FROM admins_plateforme WHERE id')) return { rows: [{ id: 1, nom_complet: 'Admin', email: 'a@a.fr', actif: true }] };
    if (sql.includes('FROM abonnements')) return { rows: [{ id: 1, date_fin: '2099-01-01' }] };
    for (const [motif, reponse] of regles) {
      if (typeof motif === 'string' ? sql.includes(motif) : motif.test(sql)) return typeof reponse === 'function' ? reponse(sql, params) : reponse;
    }
    return { rows: [], rowCount: 1 };
  });
}
const appel = async (methode, chemin, corps, tok) => {
  const r = await fetch(url + chemin, { method: methode, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: corps && !['GET', 'HEAD'].includes(methode) ? JSON.stringify(corps) : undefined });
  const texte = await r.text();
  let json = null; try { json = JSON.parse(texte); } catch { /* pas du JSON */ }
  return { status: r.status, json, texte, entetes: r.headers };
};
const requetes = (motif) => calls.filter((c) => (typeof motif === 'string' ? c.sql.includes(motif) : motif.test(c.sql)));

// ---------------------------------------------------------------------------
test('schéma : tables du module, accord de partage désactivé par défaut, lien produit', () => {
  const sql = fs.readFileSync(`${__dirname}/../server/schema.sql`, 'utf8');
  for (const t of ['sponsors', 'sponsor_images', 'sponsor_offres', 'sponsor_evenements', 'commandes_reassort']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
  assert.match(sql, /ADD COLUMN IF NOT EXISTS partage_stats BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /ALTER TABLE produits ADD COLUMN IF NOT EXISTS sponsor_id INT REFERENCES sponsors\(id\) ON DELETE SET NULL/);
  assert.match(sql, /jeton_rapport\s+VARCHAR\(64\) NOT NULL UNIQUE/);
});

test('outils : numéro WhatsApp, dates, site, message de commande', () => {
  assert.equal(S.telephoneInternational('+229 97 00-00 00'), '22997000000');
  assert.equal(S.telephoneInternational(''), null);
  assert.throws(() => S.telephoneInternational('97000000'), /indicatif/);
  assert.throws(() => S.telephoneInternational('abc'), /indicatif/);
  assert.equal(S.dateOptionnelle('2026-12-31', 'fin'), '2026-12-31');
  assert.throws(() => S.dateOptionnelle('2026-02-30', 'fin'), /invalide/);
  assert.throws(() => S.dateOptionnelle('31/12/2026', 'fin'), /invalide/);
  assert.equal(S.siteWeb('https://www.ingco.com/'), 'www.ingco.com');
  assert.throws(() => S.siteWeb('pas un site'), /invalide/);
  const m = S.messageCommande({ entreprise: { nom: 'Quincaillerie Awa', ville: 'Cotonou', telephone: '0197000000' }, utilisateur: 'Awa', lignes: [{ nom: 'Ciment', quantite: 20, unite: 'sac' }], note: 'Livraison jeudi' });
  assert.match(m, /Boutique : Quincaillerie Awa \(Cotonou\)/);
  assert.match(m, /- Ciment : 20 sac/);
  assert.match(m, /Note : Livraison jeudi/);
  assert.ok(S.lienWhatsapp('22997000000', 'a b\nc').startsWith('https://wa.me/22997000000?text=a%20b%0Ac'));
});

// ---------------------------------------------------------------------------
test('boutique : /api/partenaires renvoie partenaires et offres, et compte une vue par offre (sans doublon)', async () => {
  base(['FROM sponsors s LEFT JOIN sponsor_images', { rows: [{ id: 2, nom: 'Marque A', a_logo: false }] }],
    ['FROM sponsor_offres o', { rows: [{ id: 11, sponsor_id: 2, titre: 'Promo', texte: null, fin: null }, { id: 12, sponsor_id: 2, titre: 'Autre', texte: null, fin: null }] }]);
  const r = await appel('GET', '/api/partenaires', null, tokProprio);
  assert.equal(r.status, 200);
  assert.equal(r.json.partenaires.length, 1);
  assert.equal(r.json.offres.length, 2);
  const ev = requetes('INSERT INTO sponsor_evenements');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].params, [[11, 12], 9, 'vue']);
  assert.match(ev[0].sql, /ON CONFLICT DO NOTHING/);
  assert.match(requetes('FROM sponsors s LEFT JOIN')[0].sql, /s\.statut = 'actif'.*s\.fin >= CURRENT_DATE/s, 'seuls les contrats en cours sont montrés');
});

test('boutique : sans offre, aucune trace écrite ; la liste des marques ne compte pas de vue', async () => {
  base(['FROM sponsors s LEFT JOIN sponsor_images', { rows: [] }], ['FROM sponsor_offres o', { rows: [] }], ['SELECT s.id, s.nom FROM sponsors s', { rows: [{ id: 2, nom: 'Marque A' }] }]);
  assert.equal((await appel('GET', '/api/partenaires', null, tokProprio)).status, 200);
  assert.equal(requetes('INSERT INTO sponsor_evenements').length, 0);
  const m = await appel('GET', '/api/partenaires/marques', null, tokProprio);
  assert.deepEqual(m.json, [{ id: 2, nom: 'Marque A' }]);
  assert.equal(requetes('INSERT INTO sponsor_evenements').length, 0);
});

test('boutique : bannière du tableau de bord (une offre, tournante par jour) ou rien', async () => {
  base(['ORDER BY md5(', { rows: [{ id: 11, titre: 'Promo', texte: 'x', sponsor_id: 2, sponsor: 'Marque A', a_logo: true, logo_v: '5' }] }]);
  let r = await appel('GET', '/api/partenaires/banniere', null, tokProprio);
  assert.equal(r.json.offre.id, 11);
  assert.deepEqual(requetes('INSERT INTO sponsor_evenements')[0].params, [[11], 9, 'vue']);
  assert.deepEqual(requetes('ORDER BY md5(')[0].params, ['9'], 'rotation propre à la boutique');
  base(['ORDER BY md5(', { rows: [] }]);
  r = await appel('GET', '/api/partenaires/banniere', null, tokProprio);
  assert.equal(r.json.offre, null);
  assert.equal(requetes('INSERT INTO sponsor_evenements').length, 0);
});

test('boutique : clic sur une offre enregistré seulement pour une offre en cours', async () => {
  base();
  let r = await appel('POST', '/api/partenaires/offres/11/clic', null, tokProprio);
  assert.equal(r.status, 200);
  const q = requetes('INSERT INTO sponsor_evenements')[0];
  assert.deepEqual(q.params, [11, 9]);
  assert.match(q.sql, /s\.statut = 'actif'/);
  assert.match(q.sql, /o\.actif AND o\.debut <= CURRENT_DATE/);
  r = await appel('POST', '/api/partenaires/offres/abc/clic', null, tokProprio);
  assert.equal(r.status, 400);
});

test('boutique : les routes exigent une session', async () => {
  base();
  for (const [m, p] of [['GET', '/api/partenaires'], ['GET', '/api/reassort'], ['POST', '/api/reassort/commandes'], ['PUT', '/api/entreprise/partage-stats']]) {
    assert.equal((await appel(m, p, {})).status, 401, `${m} ${p}`);
  }
});

// ---------------------------------------------------------------------------
test('réassort : produits sous le seuil regroupés par partenaire, avec une quantité proposée', async () => {
  base(['FROM produits p JOIN sponsors s', { rows: [
    { id: 1, nom: 'Ciment', unite: 'sac', quantite_stock: 3, seuil_alerte: 10, sponsor_id: 2, sponsor: 'Marque A', peut_commander: true },
    { id: 2, nom: 'Clous', unite: 'kg', quantite_stock: 0, seuil_alerte: 0, sponsor_id: 2, sponsor: 'Marque A', peut_commander: true },
    { id: 3, nom: 'Perceuse', unite: 'pièce', quantite_stock: 1, seuil_alerte: 2, sponsor_id: 5, sponsor: 'Marque B', peut_commander: false },
  ] }]);
  const r = await appel('GET', '/api/reassort', null, tokSecretaire);
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 2);
  assert.deepEqual(r.json[0].produits.map((p) => p.quantite_suggeree), [17, 1]); // 10*2-3 ; minimum 1
  assert.equal(r.json[1].peut_commander, false);
  const q = requetes('FROM produits p JOIN sponsors s')[0];
  assert.match(q.sql, /p\.quantite_stock <= p\.seuil_alerte/);
  assert.deepEqual(q.params, [9], 'uniquement les produits de la boutique connectée');
});

function sponsorOk(extra = {}) { return ['SELECT s.id, s.nom, s.telephone_commande FROM sponsors s', { rows: [{ id: 2, nom: 'Marque A', telephone_commande: '22997000000', ...extra }] }]; }
const produitsLies = ['SELECT id, nom, unite FROM produits', { rows: [{ id: 1, nom: 'Ciment CPJ', unite: 'sac' }, { id: 2, nom: 'Clous', unite: 'kg' }] }];
const entrepriseRow = ['SELECT nom, ville, telephone FROM entreprises', { rows: [{ nom: 'Quincaillerie Awa', ville: 'Cotonou', telephone: '0197000000' }] }];

test('commande de réassort : enregistrée, lien WhatsApp prêt, trace pour l\'historique', async () => {
  base(sponsorOk(), produitsLies, entrepriseRow, ['INSERT INTO commandes_reassort', { rows: [{ id: 41 }] }]);
  const r = await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes: [{ produit_id: 1, quantite: 20 }, { produit_id: 2, quantite: 5 }], note: 'Livraison jeudi' }, tokProprio);
  assert.equal(r.status, 201);
  assert.equal(r.json.id, 41);
  assert.ok(r.json.lien_whatsapp.startsWith('https://wa.me/22997000000?text='));
  const message = decodeURIComponent(r.json.lien_whatsapp.split('?text=')[1]);
  assert.match(message, /Boutique : Quincaillerie Awa \(Cotonou\)/);
  assert.match(message, /Contact : Awa Koffi — 0197000000/);
  assert.match(message, /- Ciment CPJ : 20 sac/);
  assert.match(message, /- Clous : 5 kg/);
  assert.match(message, /Note : Livraison jeudi/);
  const ins = requetes('INSERT INTO commandes_reassort')[0];
  assert.deepEqual(ins.params.slice(0, 3), [9, 2, 3]);
  assert.deepEqual(JSON.parse(ins.params[3]), [{ produit_id: 1, nom: 'Ciment CPJ', unite: 'sac', quantite: 20 }, { produit_id: 2, nom: 'Clous', unite: 'kg', quantite: 5 }]);
  // les produits sont relus côté serveur, limités à la boutique ET au partenaire : le client ne peut pas imposer un nom ou un produit étranger
  const lecture = requetes('SELECT id, nom, unite FROM produits')[0];
  assert.deepEqual(lecture.params, [9, 2, [1, 2]]);
  assert.match(lecture.sql, /entreprise_id = \$1 AND sponsor_id = \$2 AND actif/);
});

test('commande de réassort : refus clairs', async () => {
  const lignes = [{ produit_id: 1, quantite: 20 }];
  base(sponsorOk(), produitsLies, entrepriseRow);
  assert.equal((await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes }, tokSecretaire)).status, 403, 'réservé au propriétaire');
  assert.equal((await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes: [] }, tokProprio)).status, 400);
  assert.equal((await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes: Array.from({ length: 31 }, (_, i) => ({ produit_id: i + 1, quantite: 1 })) }, tokProprio)).status, 400);
  assert.equal((await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes: [{ produit_id: 1, quantite: 0 }] }, tokProprio)).status, 400);
  assert.equal((await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes: [{ produit_id: 1, quantite: 1.5 }] }, tokProprio)).status, 400);
  assert.equal((await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes: [{ produit_id: 1, quantite: 100001 }] }, tokProprio)).status, 400);
  const doublon = await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes: [{ produit_id: 1, quantite: 1 }, { produit_id: 1, quantite: 2 }] }, tokProprio);
  assert.equal(doublon.status, 400);
  // produit d'une autre boutique ou d'un autre partenaire : la lecture ne renvoie pas toutes les lignes
  base(sponsorOk(), ['SELECT id, nom, unite FROM produits', { rows: [] }], entrepriseRow);
  const etranger = await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes }, tokProprio);
  assert.equal(etranger.status, 400);
  assert.match(etranger.json.erreur, /pas lié/);
  // partenaire sans numéro / hors contrat
  base(sponsorOk({ telephone_commande: null }), produitsLies, entrepriseRow);
  const sansNumero = await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes }, tokProprio);
  assert.equal(sansNumero.status, 400);
  assert.match(sansNumero.json.erreur, /numéro/);
  base(['SELECT s.id, s.nom, s.telephone_commande FROM sponsors s', { rows: [] }]);
  assert.equal((await appel('POST', '/api/reassort/commandes', { sponsor_id: 2, lignes }, tokProprio)).status, 404);
  assert.equal(requetes('INSERT INTO commandes_reassort').length, 0, 'aucune commande enregistrée en cas de refus');
});

test('historique des commandes de la boutique', async () => {
  base(['FROM commandes_reassort c JOIN sponsors s', { rows: [{ id: 1, sponsor: 'Marque A', lignes: [{ nom: 'Ciment', quantite: 20 }], note: null, cree_le: '2026-10-20 09:00' }] }]);
  const r = await appel('GET', '/api/reassort/commandes', null, tokSecretaire);
  assert.equal(r.status, 200);
  assert.equal(r.json[0].sponsor, 'Marque A');
  assert.equal(requetes('FROM commandes_reassort c JOIN sponsors s')[0].params[0], 9);
});

test('accord de partage des statistiques : propriétaire seulement, booléen strict', async () => {
  base();
  assert.equal((await appel('PUT', '/api/entreprise/partage-stats', { actif: true }, tokSecretaire)).status, 403);
  assert.equal((await appel('PUT', '/api/entreprise/partage-stats', { actif: 'oui' }, tokProprio)).status, 400);
  assert.equal((await appel('PUT', '/api/entreprise/partage-stats', {}, tokProprio)).status, 400);
  const r = await appel('PUT', '/api/entreprise/partage-stats', { actif: true }, tokProprio);
  assert.equal(r.status, 200);
  assert.deepEqual(requetes('UPDATE entreprises SET partage_stats')[0].params, [true, 9]);
});

// ---------------------------------------------------------------------------
test('produits : lien avec un partenaire vérifié (sous contrat) à la création et à la modification', async () => {
  const produit = { nom: 'Ciment', prix_vente: 6500, quantite_stock: 10, sponsor_id: 2 };
  base(['SELECT 1 FROM sponsors s WHERE s.id', { rows: [{ '?column?': 1 }] }], ['INSERT INTO produits', { rows: [{ id: 5 }] }]);
  let r = await appel('POST', '/api/produits', produit, tokProprio);
  assert.equal(r.status, 201);
  const ins = requetes('INSERT INTO produits')[0];
  assert.match(ins.sql, /sponsor_id\)/);
  assert.equal(ins.params[9], 2);
  assert.match(requetes('SELECT 1 FROM sponsors s WHERE s.id')[0].sql, /s\.statut = 'actif'/);

  base(['SELECT 1 FROM sponsors s WHERE s.id', { rows: [] }]);
  r = await appel('POST', '/api/produits', produit, tokProprio);
  assert.equal(r.status, 400);
  assert.match(r.json.erreur, /Partenaire inconnu ou contrat terminé/);
  assert.equal(requetes('INSERT INTO produits').length, 0);

  // modification : sans « sponsor_id » dans la demande, le lien n'est ni vérifié ni touché ; avec null, il est supprimé
  base();
  r = await appel('PUT', '/api/produits/5', { prix_vente: 7000 }, tokProprio);
  assert.equal(r.status, 200);
  assert.equal(requetes('FROM sponsors s WHERE s.id').length, 0);
  assert.ok(!requetes('UPDATE produits SET')[0].sql.includes('sponsor_id'));
  base();
  r = await appel('PUT', '/api/produits/5', { sponsor_id: null }, tokProprio);
  assert.equal(r.status, 200);
  assert.match(requetes('UPDATE produits SET')[0].sql, /sponsor_id = \$3/);
  assert.equal(requetes('UPDATE produits SET')[0].params[2], null);
});

// ---------------------------------------------------------------------------
test('admin : toutes les routes sponsors exigent un super admin', async () => {
  base();
  const routes = [['GET', '/api/admin/sponsors'], ['POST', '/api/admin/sponsors'], ['PUT', '/api/admin/sponsors/1'], ['POST', '/api/admin/sponsors/1/jeton'],
    ['PUT', '/api/admin/sponsors/1/logo'], ['DELETE', '/api/admin/sponsors/1/logo'], ['GET', '/api/admin/sponsors/1/offres'], ['POST', '/api/admin/sponsors/1/offres'],
    ['PUT', '/api/admin/offres/1'], ['DELETE', '/api/admin/offres/1'], ['GET', '/api/admin/sponsors/1/commandes']];
  for (const [m, p] of routes) {
    assert.equal((await appel(m, p, {})).status, 401, `${m} ${p} sans session`);
    assert.equal((await appel(m, p, {}, tokProprio)).status, 401, `${m} ${p} avec une session d'entreprise`);
  }
});

test('admin : création d\'un partenaire (adresse secrète de 48 caractères, validations)', async () => {
  base(['INSERT INTO sponsors', { rows: [{ id: 7 }] }]);
  const ok = { nom: 'Marque A', description: 'Outillage', site_web: 'https://www.marque.com/', telephone_commande: '+229 97 00 00 00', debut: '2026-11-01', fin: '2027-10-31' };
  const r = await appel('POST', '/api/admin/sponsors', ok, tokAdmin);
  assert.equal(r.status, 201);
  assert.equal(r.json.id, 7);
  const p = requetes('INSERT INTO sponsors')[0].params;
  assert.deepEqual(p.slice(0, 6), ['Marque A', 'Outillage', 'www.marque.com', '22997000000', '2026-11-01', '2027-10-31']);
  assert.match(p[6], /^[0-9a-f]{48}$/);

  for (const [mauvais, attendu] of [[{ ...ok, nom: '' }, /nom/], [{ ...ok, telephone_commande: '97000000' }, /indicatif/], [{ ...ok, site_web: 'x' }, /site web/],
    [{ ...ok, debut: '2027-01-01', fin: '2026-01-01' }, /avant son début/], [{ ...ok, debut: '2026-13-01' }, /invalide/]]) {
    base();
    const e = await appel('POST', '/api/admin/sponsors', mauvais, tokAdmin);
    assert.equal(e.status, 400, JSON.stringify(mauvais));
    assert.match(e.json.erreur, attendu);
    assert.equal(requetes('INSERT INTO sponsors').length, 0);
  }
});

test('admin : modification, suspension, nouvelle adresse de rapport, logo', async () => {
  base();
  const corps = { nom: 'Marque A', statut: 'suspendu' };
  let r = await appel('PUT', '/api/admin/sponsors/7', corps, tokAdmin);
  assert.equal(r.status, 200);
  assert.equal(requetes('UPDATE sponsors SET nom')[0].params[7], 'suspendu');
  r = await appel('PUT', '/api/admin/sponsors/7', { nom: 'Marque A', statut: 'inconnu' }, tokAdmin);
  assert.equal(r.status, 400);
  base(['UPDATE sponsors SET nom', { rows: [], rowCount: 0 }]);
  assert.equal((await appel('PUT', '/api/admin/sponsors/99', { nom: 'Marque A' }, tokAdmin)).status, 404);

  base();
  r = await appel('POST', '/api/admin/sponsors/7/jeton', null, tokAdmin);
  assert.equal(r.status, 200);
  assert.match(r.json.jeton_rapport, /^[0-9a-f]{48}$/);
  assert.equal(requetes('UPDATE sponsors SET jeton_rapport')[0].params[1], r.json.jeton_rapport);
  const r2 = await appel('POST', '/api/admin/sponsors/7/jeton', null, tokAdmin);
  assert.notEqual(r2.json.jeton_rapport, r.json.jeton_rapport, 'chaque renouvellement donne une adresse différente');

  // logo : PNG ou JPEG réel seulement
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]), Buffer.alloc(8)]);
  base(['SELECT 1 FROM sponsors WHERE id', { rows: [{ '?column?': 1 }] }]);
  r = await appel('PUT', '/api/admin/sponsors/7/logo', { logo: `data:image/png;base64,${png.toString('base64')}` }, tokAdmin);
  assert.equal(r.status, 200);
  const ins = requetes('INSERT INTO sponsor_images')[0];
  assert.equal(ins.params[2], 'image/png');
  base();
  r = await appel('PUT', '/api/admin/sponsors/7/logo', { logo: Buffer.from('<svg onload=alert(1)>').toString('base64') }, tokAdmin);
  assert.equal(r.status, 400);
  assert.equal(requetes('INSERT INTO sponsor_images').length, 0);
});

test('admin : offres (création, modification, suppression, validations)', async () => {
  base(['SELECT 1 FROM sponsors WHERE id', { rows: [{ '?column?': 1 }] }], ['INSERT INTO sponsor_offres', { rows: [{ id: 21 }] }]);
  let r = await appel('POST', '/api/admin/sponsors/7/offres', { titre: '-10 % sur les perceuses', texte: 'Jusqu\'à fin novembre', fin: '2026-11-30' }, tokAdmin);
  assert.equal(r.status, 201);
  assert.deepEqual(requetes('INSERT INTO sponsor_offres')[0].params, [7, '-10 % sur les perceuses', 'Jusqu\'à fin novembre', null, '2026-11-30']);
  base();
  assert.equal((await appel('POST', '/api/admin/sponsors/7/offres', { titre: 'x' }, tokAdmin)).status, 400);
  assert.equal((await appel('POST', '/api/admin/sponsors/7/offres', { titre: 'Promo', debut: '2026-12-01', fin: '2026-11-01' }, tokAdmin)).status, 400);
  r = await appel('PUT', '/api/admin/offres/21', { titre: 'Promo', actif: false }, tokAdmin);
  assert.equal(r.status, 200);
  assert.equal(requetes('UPDATE sponsor_offres')[0].params[5], false);
  base(['UPDATE sponsor_offres', { rows: [], rowCount: 0 }]);
  assert.equal((await appel('PUT', '/api/admin/offres/99', { titre: 'Promo' }, tokAdmin)).status, 404);
  base();
  assert.equal((await appel('DELETE', '/api/admin/offres/21', null, tokAdmin)).status, 200);
  assert.deepEqual(requetes('DELETE FROM sponsor_offres')[0].params, [21]);
});

test('admin : liste des partenaires avec adresse du rapport, et commandes reçues', async () => {
  base(['FROM sponsors s LEFT JOIN sponsor_images si ON si.sponsor_id = s.id ORDER BY s.id DESC', { rows: [{ id: 7, nom: 'Marque A', jeton_rapport: JETON, nb_boutiques: 3 }] }],
    ['FROM commandes_reassort c JOIN entreprises e', { rows: [{ id: 1, entreprise: 'Quincaillerie Awa', lignes: [{ nom: 'Ciment', quantite: 20, unite: 'sac' }] }] }]);
  assert.equal((await appel('GET', '/api/admin/sponsors', null, tokAdmin)).json[0].jeton_rapport, JETON);
  const c = await appel('GET', '/api/admin/sponsors/7/commandes', null, tokAdmin);
  assert.equal(c.json[0].entreprise, 'Quincaillerie Awa');
  assert.equal(requetes('FROM commandes_reassort c JOIN entreprises e')[0].params[0], 7);
});

// ---------------------------------------------------------------------------
test('logo public d\'un partenaire : image servie ou 404', async () => {
  base(['SELECT logo, logo_type FROM sponsor_images', { rows: [{ logo: Buffer.from([0x89, 0x50, 0x4e, 0x47]), logo_type: 'image/png' }] }]);
  let r = await fetch(`${url}/partenaires/7/logo`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  base(['SELECT logo, logo_type FROM sponsor_images', { rows: [] }]);
  r = await fetch(`${url}/partenaires/7/logo`);
  assert.equal(r.status, 404);
});

test('page du rapport : jamais indexée, adresse secrète jamais transmise en Referer', async () => {
  base();
  const r = await fetch(`${url}/sponsor/${JETON}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(await r.text(), /\/assets\/sponsor\.js/);
});

const reseau = (nb) => ['FROM entreprises e JOIN produits p ON p.entreprise_id = e.id AND p.sponsor_id', { rows: [{ nb }] }];
const sponsorRapport = ['FROM sponsors s LEFT JOIN sponsor_images si ON si.sponsor_id = s.id\n        WHERE s.jeton_rapport', { rows: [{ id: 7, nom: 'Marque A', a_logo: false, logo_v: null }] }];

test('rapport : adresse inconnue, mal formée ou renouvelée -> 404 (sans fuite d\'information)', async () => {
  base(['s.jeton_rapport = $1', { rows: [] }]);
  for (const j of ['court', 'z'.repeat(48), JETON, '../../etc/passwd']) {
    const r = await appel('GET', `/api/rapport-sponsor/${encodeURIComponent(j)}`);
    assert.equal(r.status, 404, j);
    assert.equal(r.json.erreur, 'Rapport introuvable.');
  }
  const q = requetes('s.jeton_rapport = $1')[0];
  assert.match(q.sql, /s\.statut = 'actif'/, 'un partenaire suspendu n\'a plus accès à son rapport');
});

test('rapport : sous le seuil d\'anonymat, AUCUNE donnée de vente n\'est même lue', async () => {
  base(sponsorRapport, reseau(4), ['FROM sponsor_offres o WHERE o.sponsor_id', { rows: [{ id: 1, titre: 'Promo', actif: true, vues: 12, clics: 3 }] }],
    ['FROM commandes_reassort c', { rows: [{ mois: '2026-10', commandes: 2, boutiques: 2 }] }]);
  const r = await appel('GET', `/api/rapport-sponsor/${JETON}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.boutiques, { nb: 4, publiable: false });
  assert.equal(r.json.seuil_anonymat, 5);
  assert.deepEqual([r.json.mensuel, r.json.top_produits, r.json.villes], [[], [], []]);
  assert.equal(r.json.boutiques_en_alerte, null);
  assert.equal(requetes('lignes_vente').length, 0, 'les lignes de vente ne sont pas interrogées');
  assert.equal(requetes('p.quantite_stock <= p.seuil_alerte').length, 0);
  assert.equal(r.json.offres[0].vues, 12);
  assert.equal(r.json.commandes[0].commandes, 2);
});

test('rapport : au-delà du seuil, chaque chiffre exige au moins 5 boutiques et l\'accord de partage', async () => {
  base(sponsorRapport, reseau(8),
    [/GROUP BY 1 HAVING/, { rows: [{ mois: '2026-10', quantite: 120, ca: '780000', boutiques: 8 }] }],
    [/GROUP BY lower\(btrim\(l\.nom_produit\)\)/, { rows: [{ nom: 'Perceuse 650W', quantite: 40, ca: '400000', boutiques: 6 }] }],
    [/GROUP BY lower\(btrim\(e\.ville\)\)/, { rows: [{ ville: 'Cotonou', quantite: 70, ca: '500000', boutiques: 5 }] }],
    ['COUNT(DISTINCT p.entreprise_id)::int AS nb FROM produits p JOIN entreprises e', { rows: [{ nb: 3 }] }]);
  const r = await appel('GET', `/api/rapport-sponsor/${JETON}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.boutiques.publiable, true);
  assert.equal(r.json.mensuel[0].ca, 780000, 'les montants (bigint) sont convertis en nombres');
  assert.equal(r.json.top_produits[0].nom, 'Perceuse 650W');
  assert.equal(r.json.villes[0].ville, 'Cotonou');
  assert.equal(r.json.boutiques_en_alerte, 3);
  const ventes = requetes('FROM lignes_vente l');
  assert.equal(ventes.length, 3);
  for (const q of ventes) {
    assert.match(q.sql, /e\.partage_stats = true/, 'seules les boutiques consentantes comptent');
    assert.match(q.sql, /HAVING COUNT\(DISTINCT v\.entreprise_id\) >= \$\d/);
    assert.ok(q.params.includes(5), 'seuil de 5 boutiques passé à la requête');
    assert.ok(!/client_nom|client_telephone|prix_achat|utilisateur_id/.test(q.sql), 'aucune donnée personnelle ni prix d\'achat');
  }
  assert.match(requetes('COUNT(DISTINCT p.entreprise_id)::int AS nb FROM produits p JOIN entreprises e')[0].sql, /e\.partage_stats = true/);
});

test('rapport : limitation de débit par adresse IP', async () => {
  base(['s.jeton_rapport = $1', { rows: [] }]);
  let dernier;
  for (let i = 0; i < 62; i++) dernier = await appel('GET', `/api/rapport-sponsor/${JETON}`);
  assert.equal(dernier.status, 429);
});
