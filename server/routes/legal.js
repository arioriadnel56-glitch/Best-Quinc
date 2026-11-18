'use strict';
// Pages légales publiques (mentions, confidentialité, conditions générales, cookies, engagements) et versions des textes.
const pages = require('../lib/legal-pages');
const conformite = require('../lib/conformite');
const settings = require('../lib/settings');
const db = require('../lib/db');
const { HttpError } = require('../lib/http');
const { auth, role } = require('../lib/auth');
const { TZ } = require('../lib/tz');

const html = (ctx, corps) => { ctx.raw = { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, body: corps }; };

// La base peut dormir (vitrine statique) : on retombe alors sur la configuration d'environnement, sans jamais bloquer la page
async function config() {
  try { return await settings.snapshot(); } catch { return null; }
}

module.exports = function register(router) {
  router.get('/mentions-legales', async (ctx) => html(ctx, pages.mentions()));
  router.get('/confidentialite', async (ctx) => html(ctx, pages.confidentialite()));
  router.get('/conditions', async (ctx) => html(ctx, pages.conditions(await config())));
  router.get('/cookies', async (ctx) => html(ctx, pages.cookies()));
  router.get('/engagements', async (ctx) => html(ctx, pages.engagements(await config())));
  // Historique des consentements de l'entreprise (dernier état de chaque type)
  router.get('/api/consentements', auth, async (ctx) => {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (type) type, version, accepte, to_char(cree_le AT TIME ZONE $2, 'YYYY-MM-DD') AS date
         FROM consentements WHERE entreprise_id = $1 ORDER BY type, cree_le DESC`, [ctx.user.entreprise_id, TZ]);
    return { consentements: rows, versions_actuelles: conformite.VERSIONS };
  });
  // Seul le propriétaire engage l'entreprise : une secrétaire ne peut pas accepter les conditions à sa place
  router.post('/api/consentements', auth, role('proprietaire'), async (ctx) => {
    const types = (Array.isArray(ctx.body.types) ? ctx.body.types : []).filter((t) => ['conditions', 'confidentialite'].includes(t));
    if (!types.length) throw new HttpError(400, 'Aucun texte à accepter.');
    for (const type of [...new Set(types)]) {
      await db.query('INSERT INTO consentements (entreprise_id, utilisateur_id, type, version, accepte) VALUES ($1, $2, $3, $4, true)',
        [ctx.user.entreprise_id, ctx.user.id, type, conformite.VERSIONS[type]]);
    }
    ctx.status = 201;
    return { ok: true };
  });
  router.get('/api/legal/versions', async () => ({ versions: conformite.VERSIONS }));
};
