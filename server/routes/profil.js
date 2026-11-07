'use strict';
const db = require('../lib/db');
const { HttpError, str, email } = require('../lib/http');
const { auth, role } = require('../lib/auth');
const { lireImage } = require('../lib/images');
const { limit } = require('../lib/ratelimit');

const proprio = role('proprietaire');

function siteWeb(v) {
  const s = str(v, 'site web', { optional: true, max: 120 });
  if (s === null) return null;
  const nu = s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s]*)?$/i.test(nu)) {
    throw new HttpError(400, 'Le site web est invalide (exemple : www.monentreprise.com).');
  }
  return nu;
}

module.exports = function register(router) {
  // Profil de l'entreprise : ces informations apparaissent sur les factures
  router.put('/api/entreprise', auth, proprio, async (ctx) => {
    const b = ctx.body;
    const nom = str(b.nom, "nom de l'entreprise", { min: 2, max: 150 });
    const adresse = str(b.adresse, 'adresse', { optional: true, max: 255 });
    const ville = str(b.ville, 'ville', { optional: true, max: 100 });
    const tel = str(b.telephone, 'téléphone', { optional: true, max: 30 });
    const mail = b.email ? email(b.email) : null;
    const ifu = str(b.ifu, 'numéro IFU', { optional: true, max: 30 });
    const rccm = str(b.rccm, 'numéro RCCM', { optional: true, max: 40 });
    const web = siteWeb(b.site_web);
    const pied = str(b.pied_facture, 'message de bas de facture', { optional: true, max: 300 });
    const indicatif = String(b.pays_indicatif === undefined || b.pays_indicatif === '' ? '229' : b.pays_indicatif).replace(/^\+/, '');
    if (!/^[1-9]\d{0,3}$/.test(indicatif)) throw new HttpError(400, "L'indicatif téléphonique est invalide (exemple : 229 pour le Bénin).");
    await db.query(
      `UPDATE entreprises SET nom = $1, adresse = $2, ville = $3, telephone = $4, email = $5, ifu = $6, rccm = $7,
              site_web = $8, pied_facture = $9, pays_indicatif = $10 WHERE id = $11`,
      [nom, adresse, ville, tel, mail, ifu, rccm, web, pied, indicatif, ctx.user.entreprise_id],
    );
    return { ok: true };
  });

  // Logo : l'application redimensionne l'image avant l'envoi et fournit aussi l'icône carrée de l'application installée
  router.put('/api/entreprise/logo', auth, proprio, async (ctx) => {
    await limit(`logo:${ctx.user.entreprise_id}`, 20, 3600 * 1000);
    const logo = lireImage(ctx.body.logo, 'logo', { maxOctets: 400 * 1024, maxCote: 1024 });
    const icone = lireImage(ctx.body.icone, 'icône', { maxOctets: 300 * 1024, maxCote: 1024 });
    if (icone.type !== 'image/png') throw new HttpError(400, "L'icône doit être au format PNG.");
    await db.query(
      `INSERT INTO entreprise_images (entreprise_id, logo, logo_type, icone) VALUES ($1, $2, $3, $4)
       ON CONFLICT (entreprise_id) DO UPDATE SET logo = EXCLUDED.logo, logo_type = EXCLUDED.logo_type, icone = EXCLUDED.icone, modifie_le = now()`,
      [ctx.user.entreprise_id, logo.buf, logo.type, icone.buf],
    );
    return { ok: true };
  });

  router.delete('/api/entreprise/logo', auth, proprio, async (ctx) => {
    await db.query('DELETE FROM entreprise_images WHERE entreprise_id = $1', [ctx.user.entreprise_id]);
    return { ok: true };
  });

  // Le logo est public (écran de connexion, factures partagées)
  router.get('/app/:slug/logo', async (ctx) => {
    const { rows } = await db.query(
      `SELECT i.logo, i.logo_type FROM entreprise_images i JOIN entreprises e ON e.id = i.entreprise_id
        WHERE e.slug = $1 AND e.statut = 'actif'`,
      [ctx.params.slug.toLowerCase()],
    );
    const r = rows[0];
    if (!r || !Buffer.isBuffer(r.logo)) throw new HttpError(404, 'Logo introuvable.');
    ctx.raw = { status: 200, headers: { 'Content-Type': r.logo_type, 'Cache-Control': 'public, max-age=300' }, body: r.logo };
  });
};
