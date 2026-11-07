'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, setHandler, calls } = require('./helpers');
const jwt = require('../server/lib/jwt');
const { makeIcon } = require('../server/lib/icon');
const BQ = require('../public/assets/outils.js');

const SECRET = process.env.JWT_SECRET;
const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const send = (base, method, p, body, tok = '') => fetch(base + p, { method, headers: H(tok), body: body === undefined ? undefined : JSON.stringify(body) });

const PNG = makeIcon('Z', '#3E5C76', 128);
const PNG_B64 = PNG.toString('base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const JPEG_B64 = 'data:image/jpeg;base64,' + JPEG.toString('base64');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });
test.beforeEach(() => { calls.length = 0; });

function session(role = 'proprietaire', extra = async () => ({ rows: [] })) {
  setHandler(async (sql, params) => {
    if (sql.includes('u.mdp_temporaire')) return { rows: [{ id: 3, entreprise_id: 9, nom_complet: 'P', email: 'p@a.fr', role, actif: true, entreprise_statut: 'actif', mdp_temporaire: false, mdp_modifie_le: null }] };
    if (sql.includes('FROM abonnements')) return { rows: [{ id: 1, date_fin: '2099-01-01' }] };
    return extra(sql, params);
  });
  return jwt.sign({ sub: 3, typ: 'user' }, SECRET);
}

// ---------- Utilitaires partagés ----------
test('numéro WhatsApp : indicatif ajouté, international respecté, valeurs absurdes refusées', () => {
  assert.equal(BQ.numeroWhatsApp('+228 90 12 34 56', '229'), '22890123456');
  assert.equal(BQ.numeroWhatsApp('0197000000', '229'), '2290197000000');
  assert.equal(BQ.numeroWhatsApp('00229 97 00 00 00', '229'), '22997000000');
  assert.equal(BQ.numeroWhatsApp('97 00 00 00', '229'), '22997000000');
  assert.equal(BQ.numeroWhatsApp('22997000000', '229'), '22997000000', 'indicatif déjà présent : pas de doublon');
  assert.equal(BQ.numeroWhatsApp('(+229) 97-00-00-00', '229'), '22997000000');
  for (const mauvais of ['', '   ', 'abc', '123', '+1', '+123456789012345678', null, undefined]) assert.equal(BQ.numeroWhatsApp(mauvais, '229'), null, String(mauvais));
});

test('message WhatsApp : numéro de facture, montant et lien', () => {
  const m = BQ.messageWhatsApp({ client: 'Mme Agbodjan', entreprise: 'Zinsou', numero: 213, total: 185500, lien: 'https://x.bj/f/abc' });
  assert.match(m, /^Bonjour Mme Agbodjan,/);
  assert.ok(m.includes('n° 00213') && m.includes('185 500 F CFA') && m.includes('https://x.bj/f/abc'));
  assert.match(BQ.messageWhatsApp({ entreprise: 'Z', numero: 1, total: 5, lien: 'l' }), /^Bonjour,/);
});

// ---------- Profil ----------
test('profil : mise à jour complète, réservée au propriétaire', async () => {
  const tok = session();
  const corps = { nom: 'Quincaillerie Zinsou', ville: 'Porto-Novo', adresse: 'Marché Ouando', telephone: '+229 97 00 00 00', email: 'Contact@Zinsou.BJ',
    ifu: '3202012345678', rccm: 'RB/PNO/20 B 1234', site_web: 'https://www.zinsou.bj/', pied_facture: 'Merci !', pays_indicatif: '+229' };
  let r = await send(srv.base, 'PUT', '/api/entreprise', corps, tok);
  assert.equal(r.status, 200);
  const up = calls.find((c) => c.sql.includes('UPDATE entreprises SET nom'));
  assert.deepEqual(up.params, ['Quincaillerie Zinsou', 'Marché Ouando', 'Porto-Novo', '+229 97 00 00 00', 'contact@zinsou.bj', '3202012345678', 'RB/PNO/20 B 1234', 'www.zinsou.bj', 'Merci !', '229', 9]);

  for (const mauvais of [{ site_web: 'pas un site' }, { email: 'x' }, { pays_indicatif: '0229' }, { nom: 'A' }, { pied_facture: 'x'.repeat(301) }]) {
    r = await send(srv.base, 'PUT', '/api/entreprise', { ...corps, ...mauvais }, tok);
    assert.equal(r.status, 400, JSON.stringify(mauvais));
  }
  const sec = session('secretaire');
  assert.equal((await send(srv.base, 'PUT', '/api/entreprise', corps, sec)).status, 403);
});

// ---------- Logo ----------
test('logo : enregistré avec son icône, validé sur le contenu réel', async () => {
  const tok = session();
  let r = await send(srv.base, 'PUT', '/api/entreprise/logo', { logo: PNG_B64, icone: PNG_B64 }, tok);
  assert.equal(r.status, 200);
  const ins = calls.find((c) => c.sql.includes('INSERT INTO entreprise_images'));
  assert.ok(Buffer.isBuffer(ins.params[1]) && ins.params[1].equals(PNG));
  assert.equal(ins.params[2], 'image/png');
  assert.equal(ins.params[0], 9);

  r = await send(srv.base, 'PUT', '/api/entreprise/logo', { logo: JPEG_B64, icone: PNG_B64 }, tok);
  assert.equal(r.status, 200, 'logo JPEG accepté (préfixe data: toléré)');

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  for (const [nom, corps] of [
    ['SVG', { logo: svg, icone: PNG_B64 }],
    ['texte déguisé', { logo: Buffer.from('<html>').toString('base64'), icone: PNG_B64 }],
    ['icône JPEG', { logo: PNG_B64, icone: JPEG_B64 }],
    ['logo absent', { icone: PNG_B64 }],
    ['base64 invalide', { logo: '***', icone: PNG_B64 }],
    ['trop lourd', { logo: Buffer.concat([PNG, Buffer.alloc(420 * 1024)]).toString('base64'), icone: PNG_B64 }],
  ]) {
    assert.equal((await send(srv.base, 'PUT', '/api/entreprise/logo', corps, tok)).status, 400, nom);
  }
  assert.equal((await send(srv.base, 'PUT', '/api/entreprise/logo', { logo: PNG_B64, icone: PNG_B64 }, session('secretaire'))).status, 403);
});

test('logo : servi publiquement par espace, 404 si absent ; retrait protégé', async () => {
  setHandler(async (sql, params) => (sql.includes('FROM entreprise_images') && params[0] === 'zinsou' ? { rows: [{ logo: PNG, logo_type: 'image/png' }] } : { rows: [] }));
  const ok = await fetch(`${srv.base}/app/zinsou/logo`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await ok.arrayBuffer()).equals(PNG));
  assert.equal((await fetch(`${srv.base}/app/autre/logo`)).status, 404);
  assert.equal((await fetch(`${srv.base}/api/entreprise/logo`, { method: 'DELETE' })).status, 401);
  const tok = session();
  assert.equal((await send(srv.base, 'DELETE', '/api/entreprise/logo', undefined, tok)).status, 200);
  assert.ok(calls.some((c) => c.sql.includes('DELETE FROM entreprise_images') && c.params[0] === 9));
});

test('icône de l\'application : celle du logo si elle existe, sinon l\'initiale générée', async () => {
  const ESPACE = { slug: 'zinsou', nom: 'Z', nom_app: 'Zinsou Quinca', couleur: '#3E5C76' };
  const perso = makeIcon('Q', '#B5532A', 300);
  setHandler(async (sql) => (sql.includes('JOIN pwa_configs') ? { rows: [ESPACE] } : sql.includes('entreprise_images') ? { rows: [{ icone: perso }] } : { rows: [] }));
  let r = await fetch(`${srv.base}/app/zinsou/icon-512.png`);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(perso));
  r = await fetch(`${srv.base}/app/zinsou/icon-maskable-512.png`);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(perso));
  setHandler(async (sql) => (sql.includes('JOIN pwa_configs') ? { rows: [ESPACE] } : { rows: [] }));
  r = await fetch(`${srv.base}/app/zinsou/icon-192.png`);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(makeIcon('Zinsou Quinca', '#3E5C76', 192)));
});

// ---------- Factures ----------
test('facture : image enregistrée, lien secret renvoyé, vente d\'une autre entreprise refusée', async () => {
  const tok = session('secretaire', async (sql, params) => {
    if (sql.includes('SELECT id FROM ventes')) return { rows: params[0] === 5 && params[1] === 9 ? [{ id: 5 }] : [] };
    if (sql.includes('INSERT INTO factures_images')) return { rows: [{ jeton: params[2] }] };
    return { rows: [] };
  });
  const corps = { image: JPEG_B64, apercu: JPEG.toString('base64') };
  let r = await send(srv.base, 'POST', '/api/ventes/5/facture-image', corps, tok);
  assert.equal(r.status, 200, 'le secrétaire peut envoyer une facture');
  const { url } = await r.json();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/f\/[A-Za-z0-9_-]{22}$/);
  const ins = calls.find((c) => c.sql.includes('INSERT INTO factures_images'));
  assert.ok(ins.sql.includes('ON CONFLICT (vente_id) DO UPDATE') && !/jeton\s*=\s*EXCLUDED/.test(ins.sql), 'le lien reste stable au renvoi');
  assert.equal(ins.params[1], 9);

  assert.equal((await send(srv.base, 'POST', '/api/ventes/6/facture-image', corps, tok)).status, 404);
  assert.equal((await send(srv.base, 'POST', '/api/ventes/5/facture-image', { ...corps, image: Buffer.from('<svg>').toString('base64') }, tok)).status, 400);
  assert.equal((await send(srv.base, 'POST', '/api/ventes/5/facture-image', { image: JPEG_B64 }, tok)).status, 400);
  assert.equal((await send(srv.base, 'POST', '/api/ventes/5/facture-image', { ...corps, image: Buffer.concat([JPEG, Buffer.alloc(510 * 1024)]).toString('base64') }, tok)).status, 400);
  assert.equal((await fetch(`${srv.base}/api/ventes/5/facture-image`, { method: 'POST', headers: H(''), body: JSON.stringify(corps) })).status, 401);
});

test('facture : l\'adresse publique configurée est utilisée dans le lien', async () => {
  const { env } = require('../server/lib/env');
  env.publicUrl = 'https://best-quinca.example.bj';
  try {
    const tok = session('proprietaire', async (sql, params) => (sql.includes('SELECT id FROM ventes') ? { rows: [{ id: 5 }] } : sql.includes('INSERT INTO factures_images') ? { rows: [{ jeton: 'A'.repeat(22) }] } : { rows: [] }));
    const r = await send(srv.base, 'POST', '/api/ventes/5/facture-image', { image: JPEG_B64, apercu: JPEG_B64 }, tok);
    assert.equal((await r.json()).url, `https://best-quinca.example.bj/f/${'A'.repeat(22)}`);
  } finally { env.publicUrl = ''; }
});

test('facture publique : page avec aperçu WhatsApp, images, pas d\'injection, 404 propres', async () => {
  const jeton = 'Zx3_-9AbCdEfGhIjKlMnOp';
  const apercu = Buffer.concat([JPEG, Buffer.from('apercu')]);
  setHandler(async (sql, params) => {
    if (sql.includes('FROM factures_images f JOIN ventes v')) return params[0] === jeton ? { rows: [{ jeton, image_type: 'image/jpeg', numero: 213, total: 185500, nom: 'Zinsou <b>"&"</b>' }] } : { rows: [] };
    if (sql.includes('FROM factures_images WHERE jeton')) return { rows: [sql.includes('apercu') ? { img: apercu, image_type: 'image/jpeg' } : { img: JPEG, image_type: 'image/jpeg' }] };
    return { rows: [] };
  });
  const page = await fetch(`${srv.base}/f/${jeton}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  const html = await page.text();
  assert.ok(html.includes('property="og:image" content="http://127.0.0.1:'));
  assert.ok(html.includes(`/f/${jeton}/apercu.jpg`) && html.includes(`/f/${jeton}/facture.jpg`));
  assert.ok(html.includes('Facture n° 00213') && html.includes('185 500 F CFA'));
  assert.ok(!html.includes('<b>') && html.includes('&lt;b&gt;'), 'nom de l\'entreprise échappé');

  const img = await fetch(`${srv.base}/f/${jeton}/facture.jpg`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPEG));
  const ap = await fetch(`${srv.base}/f/${jeton}/apercu.jpg`);
  assert.ok(Buffer.from(await ap.arrayBuffer()).equals(apercu));

  for (const p of ['/f/court', `/f/${'a'.repeat(23)}`, '/f/inconnu_inconnu_inconnu_', `/f/${'B'.repeat(22)}`, `/f/${'B'.repeat(22)}/facture.jpg`]) {
    assert.equal((await fetch(srv.base + p)).status, 404, p);
  }
});

test('client d\'une vente modifiable après coup, dans sa propre entreprise seulement', async () => {
  const tok = session('secretaire', async (sql, params) => ({ rows: [], rowCount: params[2] === 5 ? 1 : 0 }));
  let r = await send(srv.base, 'PUT', '/api/ventes/5/client', { client_nom: 'Mme Agbodjan', client_telephone: '+229 97 00 00 00' }, tok);
  assert.equal(r.status, 200);
  const up = calls.find((c) => c.sql.includes('UPDATE ventes SET client_nom'));
  assert.deepEqual(up.params, ['Mme Agbodjan', '+229 97 00 00 00', 5, 9]);
  assert.equal((await send(srv.base, 'PUT', '/api/ventes/6/client', { client_nom: 'X' }, tok)).status, 404);
  assert.equal((await send(srv.base, 'PUT', '/api/ventes/5/client', { client_nom: 'x'.repeat(200) }, tok)).status, 400);
});
