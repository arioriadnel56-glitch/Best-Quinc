'use strict';
// Conformité : pages légales, consentements, bandeau cookies, audit des outils tiers, promesses vérifiables.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, setHandler, calls } = require('./helpers');
const jwt = require('../server/lib/jwt');
const rbac = require('../server/lib/rbac');
const settings = require('../server/lib/settings');
const c = require('../server/lib/conformite');
const pages = require('../server/lib/legal-pages');
const { router } = require('../server');

const RACINE = path.join(__dirname, '..');
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8');
const SECRET = process.env.JWT_SECRET;
const SID = '3f0c7e0e-0000-4000-8000-000000000001';
let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });
test.beforeEach(() => { calls.length = 0; settings.invalidate(); rbac.invalider(); setHandler(async () => ({ rows: [] })); });
const get = async (p) => { const r = await fetch(srv.base + p); return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }; };
const ecritures = (re) => calls.filter((x) => re.test(x.sql));

// ---------------------------------------------------------------- Audit des outils tiers
test('audit : le code actuel ne contient aucun cookie, outil de suivi, domaine ou stockage non déclaré', () => {
  const r = c.auditer();
  assert.equal(r.disponible, true);
  assert.deepEqual(r.ecarts, []);
  assert.ok(r.fichiers_analyses > 10);
});

test('audit : détecte un cookie, un outil de suivi, un domaine externe, un stockage non déclaré, une image https et un faux avis', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-audit-'));
  try {
    fs.mkdirSync(path.join(dir, 'public', 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'server', 'templates'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'server', 'routes'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'server', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', 'assets', 'x.js'), "document.cookie = 'a=1'; fetch('https://www.google-analytics.com/collect'); localStorage.setItem('secret-pistage', '1'); const k = `tmp:${Math.random()}`; sessionStorage.getItem(k);");
    fs.writeFileSync(path.join(dir, 'server', 'templates', 'landing.html'), '<p>La meilleure appli, note moyenne 5/5 ★ — avis clients garantis</p><script src="https://cdn.pistage.example.org/t.js"></script><img src="https://tracker.test-tiers.com/p.gif">');
    fs.writeFileSync(path.join(dir, 'server', 'index.js'), 'const CSP = [\n"img-src \'self\' data: blob: https:",\n"script-src \'self\' https://cdn.inconnu-tiers.com",\n].join(\'; \');');
    fs.writeFileSync(path.join(dir, 'server', 'routes', 'a.js'), "res.setHeader('Set-Cookie', 'sid=1');");
    const types = new Set(c.auditer(dir).ecarts.map((e) => e.type));
    for (const t of ['cookie', 'outil_interdit', 'hote_non_declare', 'stockage_non_declare', 'stockage_non_resolu', 'csp', 'promesse']) assert.ok(types.has(t), `écart « ${t} » non détecté`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('registre : chaque domaine de la CSP et chaque stockage utilisé sont déclarés, aucune image distante autorisée', () => {
  const idx = lire('server', 'index.js');
  assert.doesNotMatch(/const CSP = \[[\s\S]*?\]\.join/.exec(idx)[0], /img-src[^"]*https:/);
  for (const k of ['bq:consentement', 'bq:dernier-espace', 'bq:*:token', 'bq-hors-ligne:*']) assert.ok(c.STOCKAGE.some((s) => s.motif === k), k);
  assert.ok(c.STOCKAGE.every((s) => s.necessaire === true), 'tout le stockage déclaré est strictement nécessaire');
  assert.ok(c.TIERS.filter((t) => t.consentement).every((t) => t.consentement === 'paiement'));
});

test('garde-fou de contenu : la page d\'accueil, l\'application et l\'espace partenaire ne contiennent ni faux avis ni superlatif ni promesse chiffrée', () => {
  for (const f of ['landing.html', 'app.html', 'sponsor.html']) assert.doesNotMatch(lire('server', 'templates', f).replace(/<script[\s\S]*?<\/script>/g, ''), c.motsTrompeurs, f);
  for (const mauvais of ['Le meilleur logiciel', 'Satisfaction garantie', '100 % fiable', 'ils nous font confiance', 'Note moyenne : 4,8', '★★★★★', 'Notre leader', 'Des milliers de clients', 'usage illimité', 'sans engagement']) assert.match(mauvais, c.motsTrompeurs, mauvais);
  for (const bon of ['Un seul abonnement, tout est inclus.', 'Ou 50 000 F CFA par an : 2 mois offerts.', 'Fièrement conçu au Bénin']) assert.doesNotMatch(bon, c.motsTrompeurs, bon);
});

test('aucun outil de mesure ni police ou bibliothèque externe : tout est servi par nous', () => {
  for (const f of ['landing.html', 'app.html', 'sponsor.html', 'admin.html']) {
    const h = lire('server', 'templates', f);
    for (const [, src] of h.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) assert.ok(!/^https?:/.test(src) || src.startsWith('mailto'), `${f} charge ${src}`);
  }
  assert.ok(fs.existsSync(path.join(RACINE, 'public', 'assets', 'fonts', 'carlito-regular.woff')));
});

// ---------------------------------------------------------------- Pages légales
test('les cinq pages légales existent, sont en HTML sans script en ligne, avec les liens de bas de page et le gestionnaire de cookies', async () => {
  for (const [url, titre] of [['/mentions-legales', /Mentions légales/], ['/confidentialite', /Politique de confidentialité/], ['/conditions', /Conditions générales d(?:'|&#39;)utilisation et de vente/], ['/cookies', /Politique cookies/], ['/engagements', /Nos engagements/]]) {
    const r = await get(url);
    assert.equal(r.status, 200, url); assert.match(r.type, /text\/html/);
    assert.match(r.body, titre, url);
    assert.doesNotMatch(r.body, /<script(?![^>]*\ssrc=)/i, `${url} : script en ligne`);
    for (const l of ['/mentions-legales', '/confidentialite', '/conditions', '/cookies', '/engagements', '/supprimer-mon-compte']) assert.ok(r.body.includes(`href="${l}"`), `${url} sans lien ${l}`);
    assert.match(r.body, /data-gerer-cookies/); assert.match(r.body, /consentement\.js/);
    assert.match(r.body, new RegExp(c.VERSIONS.cookies.slice(0, 4)));
  }
  assert.equal((await get('/api/legal/versions')).status, 200);
});

test('confidentialité : chaque donnée collectée, chaque destinataire, chaque durée, le droit de réclamation et l\'absence de revente sont écrits', async () => {
  const { body } = await get('/confidentialite');
  const txt = body.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  for (const d of c.DONNEES) assert.ok(txt.includes(d.donnees.slice(0, 40)), `donnée absente : ${d.id}`);
  for (const t of c.TIERS) assert.ok(txt.includes(t.nom), `tiers absent : ${t.id}`);
  assert.match(txt, new RegExp(`${c.RETENTION_CONNEXIONS_JOURS} jours`));
  assert.match(txt, /ne vendons pas vos données/); assert.match(txt, /APDP/); assert.match(txt, /case non cochée par défaut/);
});

test('cookies : « aucun cookie », chaque élément de stockage listé, service tiers seulement après accord, refus aussi simple qu\'acceptation', async () => {
  const { body } = await get('/cookies');
  assert.match(body, /aucun cookie/);
  for (const s of c.STOCKAGE) assert.ok(body.includes(s.motif.replace(/\*/g, '…')), s.motif);
  assert.match(body, /qu'après votre autorisation|qu&#39;après votre autorisation/);
  assert.match(body, /Tout refuser[\s\S]*Tout accepter[\s\S]*Personnaliser|Personnaliser[\s\S]*Tout accepter/);
});

test('conditions : prix et essai lus en direct dans la configuration, aucun renouvellement automatique, aucun frais ajouté', async () => {
  setHandler(async (sql) => (sql.includes('FROM plateforme_parametres') ? { rows: [{ cle: 'abonnement_prix', valeur: '7777' }, { cle: 'essai_jours', valeur: '14' }] } : { rows: [] }));
  const { body } = await get('/conditions');
  assert.match(body, /7 777 F CFA/); assert.match(body, /14 jours d(?:'|&#39;)essai gratuit/);
  assert.match(body, /aucun renouvellement automatique/); assert.match(body, /rien n(?:'|&#39;)est prélevé automatiquement/);
  assert.match(body, /ni frais de dossier/);
  settings.invalidate();
  setHandler(async () => ({ rows: [] }));
  const sans = await get('/conditions');
  assert.doesNotMatch(sans.body, /jours d(?:'|&#39;)essai gratuit/, 'pas d\'essai annoncé s\'il n\'existe pas');
  assert.match(sans.body, /Aucun paiement ni moyen de paiement/);
});

test('conditions et engagements : la page n\'annonce que ce que le code fait', () => {
  const t = lire('server', 'lib', 'legal-pages.js');
  // Pas de remboursement, de garantie de disponibilité ni de délai de réponse chiffré promis
  assert.doesNotMatch(t, /remboursement garanti|disponibilité de 99|garantissons|sous 24 ?h|sous 48 ?h/i);
  assert.match(t, /sans pouvoir le garantir/);
});

test('mentions légales : les champs non renseignés sont visibles (jamais masqués) et signalés au Super admin', async () => {
  const garde = {}; for (const k of ['EDITEUR_STATUT', 'EDITEUR_ADRESSE', 'EDITEUR_RCCM', 'EDITEUR_IFU', 'HEBERGEUR_NOM']) { garde[k] = process.env[k]; delete process.env[k]; }
  try {
    assert.match((await get('/mentions-legales')).body, /Non renseigné/);
    assert.ok(c.mentionsManquantes().some(([k]) => k === 'EDITEUR_IFU'));
    process.env.EDITEUR_IFU = '3202012345678'; process.env.HEBERGEUR_NOM = 'Render Inc.';
    const b = (await get('/mentions-legales')).body;
    assert.match(b, /3202012345678/); assert.match(b, /Render Inc\./);
    assert.ok(!c.mentionsManquantes().some(([k]) => k === 'EDITEUR_IFU'));
  } finally { for (const [k, v] of Object.entries(garde)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('pages légales : le texte saisi n\'est jamais interprété comme du HTML', () => {
  process.env.EDITEUR_ADRESSE = '<img src=x onerror=alert(1)>';
  try { const h = pages.mentions(); assert.doesNotMatch(h, /<img src=x/); assert.match(h, /&lt;img src=x/); } finally { delete process.env.EDITEUR_ADRESSE; }
});

// ---------------------------------------------------------------- Consentements
test('inscription : sans acceptation explicite, rien n\'est écrit ; avec elle, la preuve (version, date, sans IP) est enregistrée', async () => {
  const base = { nom_entreprise: 'Ets Test', nom_complet: 'Jean Test', email: 'j@t.fr', mot_de_passe: 'Brouette-Ciment-47' };
  const post = (b) => fetch(`${srv.base}/api/entreprises/inscription`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  for (const b of [base, { ...base, accepte_conditions: false }, { ...base, accepte_conditions: 'non' }, { ...base, accepte_conditions: 1 }]) {
    const r = await post(b);
    assert.equal(r.status, 400); assert.match((await r.json()).erreur, /acceptez les conditions/);
  }
  assert.equal(ecritures(/INSERT INTO entreprises/).length, 0);
  setHandler(async (sql) => {
    if (sql.includes('INSERT INTO entreprises')) return { rows: [{ id: 9, nom: 'Ets Test', slug: 'ets-test' }] };
    if (sql.includes('INSERT INTO utilisateurs')) return { rows: [{ id: 3, nom_complet: 'Jean Test', email: 'j@t.fr', role: 'proprietaire' }] };
    return { rows: [] };
  });
  const ok = await post({ ...base, accepte_conditions: true });
  assert.equal(ok.status, 201);
  const preuves = ecritures(/INSERT INTO consentements/);
  assert.deepEqual(preuves.map((p) => [p.params[2], p.params[3]]), [['conditions', c.VERSIONS.conditions], ['confidentialite', c.VERSIONS.confidentialite]]);
  assert.ok(preuves.every((p) => !/ip/i.test(p.sql)), 'aucune adresse IP dans la preuve de consentement');
  assert.equal((await post({ ...base, email: 'k@t.fr', accepte_conditions: 'on' })).status, 201);
});

test('consentements : lecture de l\'historique, ré-acceptation d\'une nouvelle version, types invalides refusés', async () => {
  const tok = jwt.sign({ sub: 3, typ: 'user' }, SECRET);
  const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  setHandler(async (sql) => {
    if (sql.includes('WHERE u.id = $1')) return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'U', email: 'u@e.fr', role: 'proprietaire', actif: true, entreprise_statut: 'actif' }] };
    if (sql.includes('DISTINCT ON (type)')) return { rows: [{ type: 'conditions', version: '2026-01-01', accepte: true, date: '2026-01-02' }] };
    return { rows: [] };
  });
  const g = await (await fetch(`${srv.base}/api/consentements`, { headers: H })).json();
  assert.equal(g.consentements[0].version, '2026-01-01'); assert.equal(g.versions_actuelles.conditions, c.VERSIONS.conditions);
  assert.equal((await fetch(`${srv.base}/api/consentements`, { method: 'POST', headers: H, body: JSON.stringify({ types: ['pirate'] }) })).status, 400);
  assert.equal((await fetch(`${srv.base}/api/consentements`, { method: 'POST', headers: H, body: JSON.stringify({ types: ['conditions', 'confidentialite', 'conditions'] }) })).status, 201);
  const ins = ecritures(/INSERT INTO consentements/);
  assert.deepEqual(ins.map((p) => p.params[2]), ['conditions', 'confidentialite']);
  assert.equal((await fetch(`${srv.base}/api/consentements`)).status, 401);
});

test('partage de statistiques : désactivé par défaut et chaque changement enregistré', () => {
  assert.match(lire('server', 'schema.sql'), /partage_stats BOOLEAN NOT NULL DEFAULT false/);
  assert.match(lire('server', 'routes', 'sponsors.js'), /INSERT INTO consentements[\s\S]{0,200}partage_stats/);
  assert.match(lire('public', 'assets', 'app.js'), /id: 'partage-stats', checked: Boolean\(e\.partage_stats\)/);
});

// ---------------------------------------------------------------- Interface : bandeau, formulaire, paiement
test('formulaire d\'inscription : case de consentement obligatoire, jamais précochée, avec liens vers les textes', () => {
  const h = lire('server', 'templates', 'landing.html');
  const m = /<input type="checkbox" name="accepte_conditions"([^>]*)>/.exec(h);
  assert.ok(m, 'case présente'); assert.match(m[1], /required/); assert.doesNotMatch(m[1], /checked/);
  assert.match(h, /href="\/conditions"[^>]*>conditions générales<\/a> et la <a href="\/confidentialite"/);
  const js = lire('public', 'assets', 'landing.js');
  assert.match(js, /if \(!body\.accepte_conditions\) throw/);
});

test('essai gratuit et prix : annoncés depuis la configuration, avec ce qui se passe ensuite', () => {
  const h = lire('server', 'templates', 'landing.html'); const js = lire('public', 'assets', 'landing.js');
  assert.match(h, /id="essai"/); assert.match(h, /rien n'est prélevé automatiquement/);
  assert.match(js, /Essai gratuit de \$\{jours\} jours, sans paiement à l'inscription/);
  assert.match(js, /essai_jours/);
});

test('bandeau cookies : trois choix identiques, rien de coché d\'avance, 6 mois, retrait possible, fenêtre accessible', () => {
  const js = lire('public', 'assets', 'consentement.js'); const css = lire('public', 'assets', 'consentement.css');
  for (const t of ['Tout refuser', 'Personnaliser', 'Tout accepter']) assert.ok(js.includes(`'${t}'`), t);
  const boutons = [...js.matchAll(/class: 'bq-btn'/g)].length; assert.ok(boutons >= 7);
  assert.doesNotMatch(js, /class: 'bq-btn (primaire|jaune|accent|principal)'/, 'aucun bouton mis en avant');
  assert.match(css, /\.bq-btn \{/); assert.doesNotMatch(css, /\.bq-btn\.(primaire|accent)/);
  assert.match(js, /casePaiement\.checked = Boolean\(etat && etat\.paiement\)/, 'jamais cochée sans accord déjà donné');
  assert.match(js, /183 \* 24/); assert.match(js, /data-gerer-cookies/);
  assert.match(js, /role: 'dialog'/); assert.match(js, /Escape/); assert.match(js, /aria-modal/);
  assert.doesNotMatch(js, /document\.cookie/); assert.doesNotMatch(js, /innerHTML/);
  assert.doesNotMatch(js, /checked: true(?!, disabled: true)/, 'seule la case « nécessaire » est cochée, et verrouillée');
});

test('paiement : les scripts KkiaPay et FedaPay ne sont chargés qu\'après l\'accord explicite de l\'utilisateur', () => {
  const js = lire('public', 'assets', 'app.js');
  for (const [nom, hote] of [['KkiaPay', 'cdn.kkiapay.me'], ['FedaPay', 'cdn.fedapay.com']]) {
    const i = js.indexOf(`BQConsent.exiger('paiement', '${nom}')`);
    assert.ok(i > 0, `${nom} : accord demandé`);
    assert.ok(js.indexOf(hote) > i, `${nom} : le script n'est ajouté qu'après la demande d'accord`);
  }
  assert.doesNotMatch(js.replace(/s\.src = 'https:\/\/cdn\.(kkiapay\.me|fedapay\.com)[^']*'/g, ''), /cdn\.(kkiapay|fedapay)/);
  const html = lire('server', 'templates', 'app.html');
  assert.ok(html.indexOf('consentement.js') < html.indexOf('/assets/app.js'), 'gestionnaire chargé avant l\'application');
  assert.match(lire('server', 'templates', 'sw.template.js'), /consentement\.js/);
});

test('pied de page légal présent sur la vitrine, l\'application et l\'espace partenaire', () => {
  for (const f of ['landing.html', 'app.html', 'sponsor.html']) {
    const h = lire('server', 'templates', f);
    for (const l of ['/mentions-legales', '/confidentialite', '/conditions', '/cookies', '/engagements']) assert.ok(h.includes(`href="${l}"`), `${f} sans ${l}`);
    assert.match(h, /data-gerer-cookies/); assert.match(h, /consentement\.css/);
  }
});

test('application : l\'utilisateur voit son historique de consentements et peut accepter une nouvelle version', () => {
  const js = lire('public', 'assets', 'app.js');
  assert.match(js, /Mes consentements et mes données/); assert.match(js, /rappelConditions/); assert.match(js, /J\\'ai lu et j\\'accepte/);
  assert.match(js, /api\('\/consentements', \{ method: 'POST'/);
});

// ---------------------------------------------------------------- Rétention et administration
test('rétention : historique de connexion purgé après la durée annoncée ; espaces clôturés supprimés à l\'échéance, avec trace', async () => {
  const relances = require('../server/lib/relances');
  setHandler(async (sql) => (sql.includes('FROM entreprises WHERE cloture_le IS NOT NULL') ? { rows: [{ id: 5 }, { id: 6 }] } : { rows: [] }));
  await relances.traiter({ planifier: false });
  assert.deepEqual(ecritures(/DELETE FROM connexions_journal/)[0].params, [c.RETENTION_CONNEXIONS_JOURS]);
  const sup = ecritures(/DELETE FROM entreprises WHERE id = ANY/);
  assert.equal(sup.length, 1); assert.deepEqual(sup[0].params[0], [5, 6]);
  assert.ok(ecritures(/UPDATE subscription_management_requests SET resume/).length === 1, 'demandes anonymisées avant suppression');
  assert.ok(ecritures(/INSERT INTO audit_journal/).some((x) => x.params[3] === 'retention.entreprises_supprimees'));
  assert.ok(!ecritures(/(UPDATE|DELETE FROM) audit_journal/).length, 'l\'audit n\'est jamais purgé');
});

test('administration : la page Conformité est réservée au Super admin et expose le registre et l\'audit', async () => {
  const tok = jwt.sign({ sub: 1, typ: 'admin', sid: SID }, SECRET);
  const joue = (role) => setHandler(async (sql, params) => {
    if (sql.includes('JOIN admin_sessions')) return { rows: [{ id: 1, nom_complet: 'T', email: 't@t.fr', actif: true, role, sid: SID, derniere_activite: new Date() }] };
    if (sql.includes('FROM admin_role_permissions WHERE role')) return { rows: rbac.parDefaut(params[0]).map((permission) => ({ permission })) };
    if (sql.includes('FROM consentements GROUP BY')) return { rows: [{ type: 'conditions', version: c.VERSIONS.conditions, accepte: true, n: 12 }] };
    if (sql.includes('NOT EXISTS (SELECT 1 FROM consentements')) return { rows: [{ n: 4 }] };
    return { rows: [] };
  });
  const H = { Authorization: `Bearer ${tok}` };
  joue('FINANCE_ADMIN'); assert.equal((await fetch(`${srv.base}/api/admin/super/conformite`, { headers: H })).status, 403);
  joue('SECURITY_ADMIN'); assert.equal((await fetch(`${srv.base}/api/admin/super/conformite`, { headers: H })).status, 403);
  joue('SUPER_ADMIN');
  const r = await fetch(`${srv.base}/api/admin/super/conformite`, { headers: H });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.audit.ok, true); assert.equal(d.tiers.length, c.TIERS.length); assert.equal(d.entreprises_sans_accord_a_jour, 4);
  assert.ok(Array.isArray(d.mentions_manquantes)); assert.equal(d.consentements[0].n, 12);
});

test('interface d\'administration : la page Conformité est au menu du Super admin', () => {
  assert.match(lire('public', 'assets', 'admin.js'), /\['conformite', 'Conformité'\]/);
  assert.match(lire('public', 'assets', 'admin-super.js'), /V\.conformite = async/);
  assert.ok(router.routes.some((r) => r.regex.test('/api/admin/super/conformite')));
});
