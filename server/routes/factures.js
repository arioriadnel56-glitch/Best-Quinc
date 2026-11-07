'use strict';
const crypto = require('node:crypto');
const db = require('../lib/db');
const { env } = require('../lib/env');
const { HttpError, str, int } = require('../lib/http');
const { auth, subscribed } = require('../lib/auth');
const { lireImage } = require('../lib/images');
const { limit } = require('../lib/ratelimit');

const base = [auth, subscribed];
const FORMAT = /^[A-Za-z0-9_-]{22}$/;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numero = (n) => String(n).padStart(5, '0');
const fcfa = (n) => new Intl.NumberFormat('fr-FR').format(n).replace(/[\u202f\u00a0]/g, ' ') + ' F CFA';

// Adresse publique du site, pour les liens et les aperçus (WhatsApp exige une adresse absolue)
function racine(ctx) {
  if (env.publicUrl) return env.publicUrl;
  const xf = env.trustProxy ? String(ctx.req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const proto = xf === 'https' || ctx.req.socket.encrypted ? 'https' : 'http';
  return `${proto}://${ctx.req.headers.host}`;
}

async function chargerPublic(ctx) {
  await limit(`facture-pub:${ctx.ip}`, 240, 60 * 1000);
  const jeton = ctx.params.jeton;
  if (!FORMAT.test(jeton)) throw new HttpError(404, 'Facture introuvable.');
  const { rows } = await db.query(
    `SELECT f.jeton, f.image_type, v.numero, v.total, e.nom
       FROM factures_images f JOIN ventes v ON v.id = f.vente_id JOIN entreprises e ON e.id = f.entreprise_id
      WHERE f.jeton = $1 AND e.statut = 'actif'`,
    [jeton],
  );
  if (!rows.length) throw new HttpError(404, 'Facture introuvable.');
  return rows[0];
}

module.exports = function register(router) {
  // Renseigner ou corriger le client après la vente (pour pouvoir lui renvoyer la facture)
  router.put('/api/ventes/:id/client', ...base, async (ctx) => {
    const id = int(ctx.params.id, 'vente', { min: 1 });
    const nom = str(ctx.body.client_nom, 'nom du client', { optional: true, max: 150 });
    const tel = str(ctx.body.client_telephone, 'téléphone du client', { optional: true, max: 30 });
    const r = await db.query('UPDATE ventes SET client_nom = $1, client_telephone = $2 WHERE id = $3 AND entreprise_id = $4', [nom, tel, id, ctx.user.entreprise_id]);
    if (!r.rowCount) throw new HttpError(404, 'Vente introuvable.');
    return { ok: true };
  });

  // L'application dessine la facture et en envoie l'image (complète) et une carte d'aperçu pour la messagerie
  router.post('/api/ventes/:id/facture-image', ...base, async (ctx) => {
    const id = int(ctx.params.id, 'vente', { min: 1 });
    await limit(`facture-img:${ctx.user.entreprise_id}`, 120, 3600 * 1000);
    const image = lireImage(ctx.body.image, 'facture', { maxOctets: 500 * 1024, maxCote: 4000 });
    const apercu = lireImage(ctx.body.apercu, 'aperçu', { maxOctets: 250 * 1024, maxCote: 2000 });
    const vente = await db.query('SELECT id FROM ventes WHERE id = $1 AND entreprise_id = $2', [id, ctx.user.entreprise_id]);
    if (!vente.rows.length) throw new HttpError(404, 'Vente introuvable.');
    // Le lien reste le même si la facture est renvoyée (client corrigé, par exemple)
    const { rows } = await db.query(
      `INSERT INTO factures_images (vente_id, entreprise_id, jeton, image, image_type, apercu)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (vente_id) DO UPDATE SET image = EXCLUDED.image, image_type = EXCLUDED.image_type, apercu = EXCLUDED.apercu, modifie_le = now()
       RETURNING jeton`,
      [id, ctx.user.entreprise_id, crypto.randomBytes(16).toString('base64url'), image.buf, image.type, apercu.buf],
    );
    return { url: `${racine(ctx)}/f/${rows[0].jeton}` };
  });

  // ---- Pages publiques (lien secret de 128 bits) ----
  router.get('/f/:jeton', async (ctx) => {
    const f = await chargerPublic(ctx);
    const url = `${racine(ctx)}/f/${f.jeton}`;
    const titre = `Facture n° ${numero(f.numero)} — ${f.nom}`;
    const desc = `Montant : ${fcfa(f.total)}. Détail de votre achat.`;
    const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titre)}</title><meta name="robots" content="noindex, nofollow">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(titre)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(url)}/apercu.jpg"><meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">
<style>body{margin:0;background:#EEF1F4;color:#1C2A33;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:1rem}img{display:block;width:100%;height:auto;background:#fff;border:1px solid #D3DAE0;border-radius:6px}
h1{font-size:1.1rem;margin:.5rem 0 1rem}a.b{display:inline-block;margin:1rem 0;padding:.7rem 1.1rem;background:#3E5C76;color:#fff;border-radius:6px;text-decoration:none;font-weight:600}
p{color:#5B6B77;font-size:.875rem}</style></head>
<body><main><h1>${esc(titre)}</h1>
<img src="${esc(url)}/facture.jpg" alt="${esc(titre)}">
<a class="b" href="${esc(url)}/facture.jpg" download="facture-${esc(numero(f.numero))}.jpg">Télécharger l'image</a>
<p>Facture émise par ${esc(f.nom)}. Pour toute question, contactez directement l'entreprise.</p></main></body></html>`;
    ctx.raw = { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' }, body: html };
  });

  const image = (nom, colonne, typeFixe) => router.get(`/f/:jeton/${nom}`, async (ctx) => {
    const f = await chargerPublic(ctx);
    const { rows } = await db.query(`SELECT ${colonne} AS img${typeFixe ? '' : ', image_type'} FROM factures_images WHERE jeton = $1`, [f.jeton]);
    if (!rows.length || !Buffer.isBuffer(rows[0].img)) throw new HttpError(404, 'Facture introuvable.');
    ctx.raw = {
      status: 200,
      headers: { 'Content-Type': typeFixe || rows[0].image_type, 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex, nofollow' },
      body: rows[0].img,
    };
  });
  image('facture.jpg', 'image', null);
  image('apercu.jpg', 'apercu', 'image/jpeg');
};
