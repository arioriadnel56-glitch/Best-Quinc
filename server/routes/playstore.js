'use strict';
// Application Android (Trusted Web Activity) et exigences de Google Play : vérification du site, écran d'entrée,
// pages légales publiques et suppression de compte.
const db = require('../lib/db');
const { env } = require('../lib/env');
const { HttpError, str, slugify } = require('../lib/http');
const { auth, role } = require('../lib/auth');
const { verifyPassword } = require('../lib/password');
const { limit } = require('../lib/ratelimit');
const settings = require('../lib/settings');
const realtime = require('../lib/realtime');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fcfa = (n) => new Intl.NumberFormat('fr-FR').format(n).replace(/[\u202f\u00a0]/g, ' ') + ' F CFA';
const MISE_A_JOUR = '27 octobre 2026';

const CSS = `*{box-sizing:border-box}body{margin:0;background:#EEF1F4;color:#1C2A33;font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:#12202C;padding:.7rem 1.2rem}header img{height:3.6rem;width:auto;display:block}
main{max-width:46rem;margin:0 auto;padding:1.4rem 1.2rem 3rem}h1{font-size:1.7rem;line-height:1.2;margin:.4rem 0 .3rem}h2{font-size:1.15rem;margin:1.8rem 0 .4rem;border-left:5px solid #F2B705;padding-left:.6rem}
p,li{color:#2B3B46}li{margin:.25rem 0}a{color:#1F6F78}.maj{color:#5B6B77;font-size:.9rem}
.carte{background:#fff;border:1px solid #D3DAE0;border-radius:12px;padding:1rem 1.2rem;margin:1rem 0}
input{font:inherit;width:100%;min-height:48px;padding:.6rem .8rem;border:1px solid #9AA8B3;border-radius:8px;background:#fff}
button,.btn{font:inherit;font-weight:700;min-height:48px;padding:.6rem 1.2rem;border:0;border-radius:8px;background:#F2B705;color:#12202C;cursor:pointer;text-decoration:none;display:inline-block}
.erreur{color:#B4402A;font-weight:600}footer{max-width:46rem;margin:0 auto;padding:0 1.2rem 2rem;color:#5B6B77;font-size:.9rem}footer a{margin-right:1rem}`;

function page(titre, corps, extra = '') {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titre)} — Best-Quinca</title><meta name="theme-color" content="#12202C"><link rel="icon" href="/favicon.ico"><style>${CSS}</style>${extra}</head>
<body><header><a href="/"><img src="/assets/marque/best-quinca-clair.png" alt="Best-Quinca Hardware" width="760" height="632"></a></header>
<main>${corps}</main>
<footer><a href="/mentions-legales">Mentions légales</a><a href="/confidentialite">Confidentialité</a><a href="/conditions">Conditions générales</a><a href="/cookies">Cookies</a><a href="/engagements">Nos engagements</a><a href="/supprimer-mon-compte">Supprimer mon compte</a> <button type="button" data-gerer-cookies style="background:none;border:0;padding:0;font:inherit;color:#1F6F78;text-decoration:underline;cursor:pointer">Gérer mes cookies</button></footer><link rel="stylesheet" href="/assets/consentement.css"><script src="/assets/consentement.js" defer></script></body></html>`;
}

const html = (ctx, status, body, cache = 'no-cache') => { ctx.raw = { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache }, body }; };

function suppression() {
  const c = esc(env.contactEmail);
  return page('Supprimer mon compte', `
<h1>Supprimer mon compte et mes données</h1>
<p>Vous pouvez supprimer votre espace Best-Quinca et toutes ses données quand vous le souhaitez.</p>
<div class="carte"><h2 style="margin-top:0">Depuis l'application (immédiat)</h2>
<ol><li>Connectez-vous avec le compte <strong>propriétaire</strong> de la quincaillerie.</li><li>Ouvrez le menu <strong>Profil</strong>.</li><li>Tout en bas, choisissez <strong>« Supprimer mon espace et toutes mes données »</strong>.</li><li>Saisissez l'identifiant de votre espace et votre mot de passe pour confirmer.</li></ol></div>
<div class="carte"><h2 style="margin-top:0">Par e-mail</h2><p>Si vous ne pouvez plus vous connecter, écrivez à <a href="mailto:${c}">${c}</a> depuis l'adresse e-mail du compte propriétaire, en indiquant l'identifiant de votre espace. Nous supprimons l'espace après vérification de votre identité.</p></div>
<h2>Ce qui est supprimé</h2>
<ul><li>L'espace de la quincaillerie et les comptes de tous ses utilisateurs (propriétaire et secrétaires).</li><li>Les produits, stocks, mouvements, ventes, factures, crédits, remboursements, inventaires et clients enregistrés.</li><li>Les liens de factures déjà partagés cessent de fonctionner.</li><li>L'historique des paiements d'abonnement de l'espace.</li></ul>
<p><strong>La suppression est définitive.</strong> Pensez à noter ce dont vous avez besoin avant de continuer. Des copies de sauvegarde techniques peuvent subsister temporairement chez l'hébergeur avant leur effacement définitif.</p>`);
}

function entrer(erreur) {
  return page('Mon espace', `
<h1>Accédez à votre espace</h1><p>Saisissez l'identifiant de votre quincaillerie (celui de l'adresse de votre espace).</p>
${erreur ? `<p class="erreur" role="alert">${esc(erreur)}</p>` : ''}
<form class="carte" method="get" action="/entrer"><label for="espace"><strong>Identifiant de l'espace</strong></label>
<input id="espace" name="espace" required minlength="3" maxlength="60" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="ex. : quincaillerie-zinsou">
<p><button type="submit">Ouvrir mon espace</button></p></form>
<p>Pas encore d'espace ? <a href="/">Créer ma quincaillerie</a></p>`, '<link rel="manifest" href="/manifest-plateforme.webmanifest"><script src="/assets/entrer.js" defer></script>');
}

const SW = `'use strict';
// Écran d'entrée disponible sans réseau : l'application Android s'ouvre toujours, puis ouvre l'espace de la quincaillerie
const V = 'entrer-v1';
const FICHIERS = ['/entrer', '/assets/entrer.js', '/assets/marque/best-quinca-clair.png', '/favicon.ico'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n !== V).map((n) => caches.delete(n)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copie = r.clone(); caches.open(V).then((c) => c.put(e.request, copie)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});`;

module.exports = function register(router) {
  // Vérification du site par Android (liens d'application) : sans elle, l'application affiche une barre d'adresse
  router.get('/.well-known/assetlinks.json', async (ctx) => {
    const liens = env.androidPackage && env.androidSha256.length
      ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: env.androidPackage, sha256_cert_fingerprints: env.androidSha256 } }]
      : [];
    ctx.raw = { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, body: JSON.stringify(liens) };
  });

  router.get('/manifest-plateforme.webmanifest', async (ctx) => {
    const m = {
      id: '/entrer', name: 'Best-Quinca', short_name: 'Best-Quinca', description: 'Caisse, stock et ventes de votre quincaillerie', lang: 'fr',
      start_url: '/entrer?source=playstore', scope: '/', display: 'standalone', orientation: 'any', background_color: '#EEF1F4', theme_color: '#12202C',
      icons: [
        { src: '/assets/marque/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/assets/marque/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/assets/marque/icone-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    };
    ctx.raw = { status: 200, headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' }, body: JSON.stringify(m) };
  });

  router.get('/entrer-sw.js', async (ctx) => {
    ctx.raw = { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/entrer' }, body: SW };
  });

  // Écran d'entrée : l'application Android démarre ici puis ouvre l'espace de la quincaillerie
  router.get('/entrer', async (ctx) => {
    const brut = ctx.query.espace;
    if (brut === undefined || brut === '') return html(ctx, 200, entrer(null));
    const slug = slugify(String(brut).slice(0, 80));
    const r = slug.length >= 3 ? await db.query("SELECT slug FROM entreprises WHERE slug = $1 AND statut = 'actif'", [slug]) : { rows: [] };
    if (!r.rows.length) return html(ctx, 404, entrer("Cet identifiant n'existe pas. Vérifiez l'adresse de votre espace."));
    const suite = ctx.query.source === 'playstore' ? '?source=playstore' : '';
    ctx.raw = { status: 302, headers: { Location: `/app/${r.rows[0].slug}/${suite}`, 'Cache-Control': 'no-store' }, body: '' };
  });

  router.get('/supprimer-mon-compte', async (ctx) => html(ctx, 200, suppression()));

  // Suppression de l'espace par son propriétaire (exigée par Google Play pour toute application qui crée des comptes).
  // Pas de contrôle d'abonnement : un espace expiré doit pouvoir être supprimé.
  router.post('/api/entreprise/suppression', auth, role('proprietaire'), async (ctx) => {
    await limit(`suppression:${ctx.user.id}`, 5, 3600 * 1000);
    const pwd = str(ctx.body.mot_de_passe, 'mot de passe', { max: 200 });
    const confirmation = str(ctx.body.confirmation, 'confirmation', { max: 80 }).toLowerCase();
    const { rows } = await db.query(
      'SELECT u.mot_de_passe_hash, e.slug, e.nom FROM utilisateurs u JOIN entreprises e ON e.id = u.entreprise_id WHERE u.id = $1',
      [ctx.user.id],
    );
    if (!rows.length || !(await verifyPassword(pwd, rows[0].mot_de_passe_hash))) throw new HttpError(400, 'Mot de passe incorrect.');
    if (confirmation !== rows[0].slug) throw new HttpError(400, "Saisissez l'identifiant de votre espace pour confirmer la suppression.");
    const eid = ctx.user.entreprise_id;
    // Toutes les tables liées à l'entreprise sont en suppression en cascade
    await db.query('DELETE FROM entreprises WHERE id = $1', [eid]);
    realtime.fermerEntreprise(eid);
    realtime.publierAdmins('entreprise.supprimee', { nom: rows[0].nom });
    return { ok: true };
  });
};
