'use strict';
// Bilans des ventes (jour, semaine, mois, dates libres) : consultation, fiche PDF, archivage, suppression.
// Réservé au propriétaire : le bilan montre la marge, la valeur du stock et les chiffres de toute l'équipe.
const db = require('../lib/db');
const { HttpError, str, int } = require('../lib/http');
const { auth, role, subscribed } = require('../lib/auth');
const { TZ } = require('../lib/tz');
const { resoudrePeriode, calculerBilan, pdfBilan } = require('../lib/bilan');

const base = [auth, subscribed, role('proprietaire')];

async function infosEntreprise(eid) {
  const { rows } = await db.query(
    `SELECT COALESCE(c.nom_app, e.nom) AS nom, COALESCE(c.couleur, '#3E5C76') AS couleur
       FROM entreprises e LEFT JOIN pwa_configs c ON c.entreprise_id = e.id WHERE e.id = $1`,
    [eid],
  );
  return rows[0] || { nom: 'Entreprise', couleur: '#3E5C76' };
}

const nomFichier = (b, numero) => `bilan-${numero ? `n${numero}-` : ''}${b.du}${b.du === b.au ? '' : `_au_${b.au}`}.pdf`;

function reponsePdf(ctx, buf, nom) {
  ctx.raw = {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${nom}"`,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    },
    body: buf,
  };
}

module.exports = function register(router) {
  // Calcul à la demande (rien n'est enregistré)
  router.get('/api/bilan', ...base, async (ctx) => {
    const p = await resoudrePeriode(ctx.query);
    return { ...(await calculerBilan(ctx.user.entreprise_id, p.du, p.au)), periode: p.periode };
  });

  // Fiche PDF d'un bilan calculé à l'instant
  router.get('/api/bilan/pdf', ...base, async (ctx) => {
    const p = await resoudrePeriode(ctx.query);
    const [bilan, e] = await Promise.all([calculerBilan(ctx.user.entreprise_id, p.du, p.au), infosEntreprise(ctx.user.entreprise_id)]);
    reponsePdf(ctx, pdfBilan({ entreprise: e.nom, couleur: e.couleur, bilan, par: ctx.user.nom_complet }), nomFichier(bilan));
  });

  // Enregistrer le bilan : instantané figé (les ventes ne changent plus ce document)
  router.post('/api/bilans', ...base, async (ctx) => {
    const eid = ctx.user.entreprise_id;
    const p = await resoudrePeriode(ctx.body);
    const note = str(ctx.body.note, 'note', { optional: true, max: 255 });
    const bilan = await calculerBilan(eid, p.du, p.au);
    const r = await db.tx(async (q) => {
      await q('SELECT id FROM entreprises WHERE id = $1 FOR UPDATE', [eid]); // numérotation sans trou ni doublon
      const n = await q('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM bilans WHERE entreprise_id = $1', [eid]);
      const v = await q(
        `INSERT INTO bilans (entreprise_id, numero, du, au, note, donnees, cree_par)
         VALUES ($1, $2, $3::date, $4::date, $5, $6::jsonb, $7) RETURNING id, numero`,
        [eid, n.rows[0].n, p.du, p.au, note, JSON.stringify(bilan), ctx.user.id],
      );
      return v.rows[0];
    });
    ctx.status = 201;
    return r;
  });

  router.get('/api/bilans', ...base, async (ctx) => {
    const { rows } = await db.query(
      `SELECT b.id, b.numero, to_char(b.du, 'YYYY-MM-DD') AS du, to_char(b.au, 'YYYY-MM-DD') AS au, b.note,
              (b.donnees->'ventes'->>'nb')::int AS nb_ventes, (b.donnees->>'ca_net')::float8 AS ca_net,
              u.nom_complet AS cree_par_nom, to_char(b.cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM bilans b LEFT JOIN utilisateurs u ON u.id = b.cree_par
        WHERE b.entreprise_id = $1 ORDER BY b.numero DESC LIMIT 200`,
      [ctx.user.entreprise_id, TZ],
    );
    return rows;
  });

  async function charger(ctx) {
    const id = int(ctx.params.id, 'bilan', { min: 1 });
    const { rows } = await db.query(
      `SELECT b.id, b.numero, b.note, b.donnees, u.nom_complet AS cree_par_nom
         FROM bilans b LEFT JOIN utilisateurs u ON u.id = b.cree_par WHERE b.id = $1 AND b.entreprise_id = $2`,
      [id, ctx.user.entreprise_id],
    );
    if (!rows.length) throw new HttpError(404, 'Bilan introuvable.');
    return rows[0];
  }

  router.get('/api/bilans/:id', ...base, async (ctx) => {
    const b = await charger(ctx);
    return { id: b.id, numero: b.numero, note: b.note, cree_par_nom: b.cree_par_nom, ...b.donnees };
  });

  router.get('/api/bilans/:id/pdf', ...base, async (ctx) => {
    const [b, e] = await Promise.all([charger(ctx), infosEntreprise(ctx.user.entreprise_id)]);
    reponsePdf(ctx, pdfBilan({ entreprise: e.nom, couleur: e.couleur, bilan: b.donnees, numero: b.numero, note: b.note, par: b.cree_par_nom }), nomFichier(b.donnees, b.numero));
  });

  // Supprime un bilan enregistré (le document seulement : les ventes ne sont jamais touchées)
  router.delete('/api/bilans/:id', ...base, async (ctx) => {
    const id = int(ctx.params.id, 'bilan', { min: 1 });
    const r = await db.query('DELETE FROM bilans WHERE id = $1 AND entreprise_id = $2', [id, ctx.user.entreprise_id]);
    if (!r.rowCount) throw new HttpError(404, 'Bilan introuvable.');
    return { ok: true };
  });
};
