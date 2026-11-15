'use strict';
// Espace Administrateur financier et commercial (1/2) : tableau de bord, agrégateurs, abonnements, documents, rentabilité.
const db = require('../lib/db');
const { env } = require('../lib/env');
const { HttpError, str, int } = require('../lib/http');
const { TZ } = require('../lib/tz');
const rbac = require('../lib/rbac');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const demandes = require('../lib/demandes');
const { documentPdf } = require('../lib/pdf-abonnement');

const PROVIDERS = {
  kkiapay: { operationnel: true, cles: ['kkiapay_public_key', 'kkiapay_private_key', 'kkiapay_secret', 'kkiapay_sandbox'] },
  fedapay: { operationnel: true, cles: ['fedapay_public_key', 'fedapay_secret_key', 'fedapay_webhook_secret', 'fedapay_sandbox'] },
  cinetpay: { operationnel: false, cles: ['cinetpay_site_id', 'cinetpay_api_key', 'cinetpay_secret_key', 'cinetpay_sandbox'] },
};

// Revenus encaissés et dépenses de fonctionnement, mois par mois (dépenses récurrentes réparties sur les mois couverts)
const SERIE_SQL = `
  WITH mois AS (SELECT generate_series(date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month', date_trunc('month', CURRENT_DATE), interval '1 month')::date AS m)
  SELECT to_char(m, 'YYYY-MM') AS mois,
    COALESCE((SELECT SUM(p.montant) FROM paiements p WHERE p.statut = 'reussi' AND date_trunc('month', p.confirme_le AT TIME ZONE $2)::date = m), 0)::float8 AS revenus,
    COALESCE((SELECT SUM(CASE x.periodicite WHEN 'annuelle' THEN x.montant / 12.0 ELSE x.montant END) FROM hosting_expenses x
               WHERE x.statut = 'validee' AND (
                    (x.periodicite = 'ponctuelle' AND date_trunc('month', x.date_depense)::date = m)
                 OR (x.periodicite = 'mensuelle' AND date_trunc('month', x.date_depense)::date <= m)
                 OR (x.periodicite = 'annuelle' AND date_trunc('month', x.date_depense)::date <= m AND m < (date_trunc('month', x.date_depense) + interval '12 months')::date))), 0)::float8 AS depenses
    FROM mois ORDER BY m`;
const serie = async (n) => (await db.query(SERIE_SQL, [n, TZ])).rows;

// État d'abonnement de chaque entreprise d'après son dernier abonnement
const ABOS_SQL = `
  SELECT * FROM (
    SELECT e.id AS entreprise_id, e.nom, e.slug, e.email, e.telephone, e.statut AS entreprise_statut, e.cloture_le IS NOT NULL AS cloturee,
           l.id AS abonnement_id, l.montant, l.statut AS abo_statut, to_char(l.date_debut, 'YYYY-MM-DD') AS date_debut, to_char(l.date_fin, 'YYYY-MM-DD') AS date_fin,
           CASE WHEN l.id IS NULL THEN 'aucun' WHEN l.statut = 'resilie' THEN 'resilie' WHEN l.statut = 'suspendu' THEN 'suspendu' WHEN l.date_fin >= CURRENT_DATE THEN 'actif' ELSE 'expire' END AS etat,
           (l.date_fin - CURRENT_DATE) AS jours_restants,
           (SELECT COUNT(*) FROM paiements p WHERE p.entreprise_id = e.id AND p.statut = 'reussi')::int AS nb_paiements,
           (SELECT COUNT(*) FROM paiements p WHERE p.entreprise_id = e.id AND p.statut IN ('en_attente', 'echoue') AND p.cree_le > now() - interval '30 days')::int AS paiements_en_souffrance,
           (SELECT to_char(MAX(p.confirme_le AT TIME ZONE $1), 'YYYY-MM-DD') FROM paiements p WHERE p.entreprise_id = e.id AND p.statut = 'reussi') AS dernier_paiement
      FROM entreprises e
      LEFT JOIN LATERAL (SELECT * FROM abonnements a WHERE a.entreprise_id = e.id AND a.statut <> 'annule' ORDER BY a.date_fin DESC, a.id DESC LIMIT 1) l ON true
  ) t`;

module.exports = function register(router) {
  const P = rbac.exiger;
  const origine = () => env.publicUrl || '';

  // ---------- Tableau de bord financier ----------
  router.get('/api/admin/finance/dashboard', P('finance.dashboard'), async () => {
    const un = async (sql, params) => (await db.query(sql, params)).rows[0] || {};
    const [rev, att, abos, dep, relance, s] = await Promise.all([
      un(`SELECT COALESCE(SUM(montant), 0)::float8 AS total,
                 COALESCE(SUM(montant) FILTER (WHERE (confirme_le AT TIME ZONE $1) >= date_trunc('month', now() AT TIME ZONE $1)), 0)::float8 AS mois,
                 COUNT(*) FILTER (WHERE (confirme_le AT TIME ZONE $1) >= date_trunc('month', now() AT TIME ZONE $1))::int AS nb_mois,
                 COALESCE(SUM(montant) FILTER (WHERE plan = 'annuel' AND (confirme_le AT TIME ZONE $1) >= date_trunc('month', now() AT TIME ZONE $1)), 0)::float8 AS mois_annuel
            FROM paiements WHERE statut = 'reussi'`, [TZ]),
      un(`SELECT COUNT(*) FILTER (WHERE statut = 'en_attente')::int AS en_attente, COALESCE(SUM(montant) FILTER (WHERE statut = 'en_attente'), 0)::float8 AS montant_attente,
                 COUNT(*) FILTER (WHERE statut = 'echoue')::int AS echoues
            FROM paiements WHERE cree_le > now() - interval '30 days'`),
      un(`SELECT COUNT(*) FILTER (WHERE etat = 'actif')::int AS actifs, COUNT(*) FILTER (WHERE etat = 'expire')::int AS expires,
                 COUNT(*) FILTER (WHERE etat = 'suspendu')::int AS suspendus,
                 COUNT(*) FILTER (WHERE etat = 'expire' AND paiements_en_souffrance > 0)::int AS impayes,
                 COUNT(*) FILTER (WHERE NOT cloturee AND ((etat = 'actif' AND jours_restants <= 7) OR (etat = 'expire' AND jours_restants >= -60)))::int AS a_relancer
            FROM (${ABOS_SQL.replace('$1', '$1')}) z WHERE NOT cloturee`, [TZ]),
      un(`SELECT COALESCE(SUM(CASE periodicite WHEN 'annuelle' THEN montant / 12.0 ELSE montant END) FILTER (WHERE periodicite <> 'ponctuelle'), 0)::float8 AS recurrentes_mensuelles,
                 COALESCE(SUM(montant) FILTER (WHERE periodicite = 'ponctuelle' AND date_depense >= date_trunc('month', CURRENT_DATE)), 0)::float8 AS ponctuelles_mois,
                 COUNT(*) FILTER (WHERE statut = 'en_attente')::int AS en_attente_validation
            FROM hosting_expenses WHERE statut IN ('validee', 'en_attente')`),
      un("SELECT COUNT(*)::int AS n FROM subscription_reminders WHERE statut IN ('echec') OR (statut = 'programmee' AND programmee_le <= now())"),
      serie(6),
    ]);
    const depenses_mois = (dep.recurrentes_mensuelles || 0) + (dep.ponctuelles_mois || 0);
    return { revenus: rev, paiements: att, abonnements: abos, depenses: { mois: depenses_mois, en_attente_validation: dep.en_attente_validation || 0 }, relances_a_traiter: relance.n || 0, resultat_mois: (rev.mois || 0) - depenses_mois, serie: s };
  });

  // ---------- Abonnements ----------
  router.get('/api/admin/finance/abonnements', P('finance.abonnements.lire'), async (ctx) => {
    const etat = ['actif', 'expire', 'suspendu', 'impaye', 'resilie', 'aucun'].includes(ctx.query.etat) ? ctx.query.etat : '';
    const q = String(ctx.query.q || '').slice(0, 100).replace(/[\\%_]/g, '\\$&');
    const { rows } = await db.query(
      `${ABOS_SQL} WHERE ($2::text = '' OR t.nom ILIKE '%' || $2::text || '%' OR t.slug ILIKE '%' || $2::text || '%')
          AND ($3::text = '' OR (CASE WHEN $3::text = 'impaye' THEN t.etat = 'expire' AND t.paiements_en_souffrance > 0 ELSE t.etat = $3::text END))
        ORDER BY (t.etat = 'expire') DESC, t.date_fin NULLS LAST LIMIT 300`, [TZ, q, etat]);
    const cfg = await settings.snapshot();
    return { entreprises: rows, formules: Object.values(cfg.plans) };
  });

  router.get('/api/admin/finance/entreprises/:id/paiements', P('finance.paiements.lire'), async (ctx) => {
    const id = int(ctx.params.id, 'entreprise', { min: 1 });
    const { rows } = await db.query(
      `SELECT id, agregateur, plan, reference_transaction, montant, statut, to_char(cree_le AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM paiements WHERE entreprise_id = $1 ORDER BY id DESC LIMIT 100`, [id, TZ]);
    return rows;
  });

  // ---------- Factures et reçus (PDF) ----------
  router.get('/api/admin/finance/paiements/:id/document', P('finance.factures'), async (ctx) => {
    const id = int(ctx.params.id, 'paiement', { min: 1 });
    const type = ctx.query.type === 'facture' ? 'facture' : 'recu';
    const { rows } = await db.query(
      `SELECT p.id, p.agregateur, p.plan, p.jours, p.reference_transaction, p.montant, p.statut,
              to_char(p.cree_le AT TIME ZONE $2, 'YYYY-MM-DD') AS cree_le, to_char(p.confirme_le AT TIME ZONE $2, 'YYYY-MM-DD') AS confirme_le,
              e.nom, e.email, e.telephone, e.ifu
         FROM paiements p JOIN entreprises e ON e.id = p.entreprise_id WHERE p.id = $1`, [id, TZ]);
    const p = rows[0];
    if (!p) throw new HttpError(404, 'Paiement introuvable.');
    if (type === 'recu' && p.statut !== 'reussi') throw new HttpError(400, 'Un reçu n\'existe que pour un paiement réussi. Générez une facture à la place.');
    const { buffer, nom } = documentPdf(type, p, p);
    await audit.journaliser(ctx, `document.${type}`, { cible_type: 'paiement', cible_id: id });
    ctx.raw = { status: 200, body: buffer, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${nom}"`, 'Cache-Control': 'no-store' } };
  });

  // ---------- Agrégateurs de paiement ----------
  router.get('/api/admin/finance/agregateurs', P('finance.agregateurs.lire'), async () => {
    const [prov, stats, decrit] = await Promise.all([
      db.query('SELECT code, libelle, actif, url_service, url_callback, url_webhook, notes, to_char(modifie_le AT TIME ZONE $1, \'YYYY-MM-DD HH24:MI\') AS modifie_le FROM payment_providers ORDER BY code', [TZ]),
      db.query(`SELECT agregateur, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE statut = 'reussi')::int AS reussis, COUNT(*) FILTER (WHERE statut = 'echoue')::int AS echoues,
                       COUNT(*) FILTER (WHERE statut = 'en_attente')::int AS en_attente, COALESCE(SUM(montant) FILTER (WHERE statut = 'reussi'), 0)::float8 AS montant
                  FROM paiements GROUP BY agregateur`),
      settings.describe(),
    ]);
    const st = Object.fromEntries(stats.rows.map((r) => [r.agregateur, r]));
    return prov.rows.map((p) => {
      const def = PROVIDERS[p.code] || { operationnel: false, cles: [] };
      const champs = def.cles.map((cle) => ({ cle, ...(decrit[cle] || {}) }));
      const configure = champs.filter((c) => !c.secret || true).every((c) => /sandbox|webhook_secret|secret$/.test(c.cle) && !/(public|private|api)_key|site_id/.test(c.cle) ? true : c.definie);
      return {
        ...p, operationnel: def.operationnel, configure, champs,
        webhook_defaut: `${origine()}/api/webhooks/${p.code}`,
        stats: st[p.code] || { total: 0, reussis: 0, echoues: 0, en_attente: 0, montant: 0 },
      };
    });
  });

  const urlOuNull = (v, nom) => {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim();
    if (s.length > 300 || !/^https:\/\/[^\s]+$/i.test(s)) throw new HttpError(400, `« ${nom} » doit être une adresse https:// valide.`);
    return s;
  };

  router.put('/api/admin/finance/agregateurs/:code', P('finance.agregateurs.gerer'), async (ctx) => {
    const code = ctx.params.code;
    if (!PROVIDERS[code]) throw new HttpError(404, 'Fournisseur introuvable.');
    const b = ctx.body;
    const vals = [urlOuNull(b.url_service, 'URL du service'), urlOuNull(b.url_callback, 'URL de callback'), urlOuNull(b.url_webhook, 'URL du webhook'), b.notes ? String(b.notes).slice(0, 500) : null];
    await db.query('UPDATE payment_providers SET url_service = $2, url_callback = $3, url_webhook = $4, notes = $5, modifie_le = now(), modifie_par = $6 WHERE code = $1', [code, ...vals, ctx.admin.id]);
    await audit.journaliser(ctx, 'agregateur.urls_modifiees', { cible_type: 'agregateur', cible_id: code, details: { url_service: vals[0], url_callback: vals[1], url_webhook: vals[2] } });
    return { ok: true };
  });

  // Clés : jamais renvoyées en clair, chiffrées avant l'écriture, un champ secret laissé vide n'est pas modifié
  router.put('/api/admin/finance/agregateurs/:code/cles', P('finance.agregateurs.gerer'), async (ctx) => {
    const code = ctx.params.code;
    const def = PROVIDERS[code];
    if (!def) throw new HttpError(404, 'Fournisseur introuvable.');
    const valeurs = ctx.body.valeurs && typeof ctx.body.valeurs === 'object' && !Array.isArray(ctx.body.valeurs) ? ctx.body.valeurs : {};
    const effacer = Array.isArray(ctx.body.effacer) ? ctx.body.effacer.map(String) : [];
    const aEcrire = {};
    for (const [k, v] of Object.entries(valeurs)) {
      if (!def.cles.includes(k)) throw new HttpError(400, `Champ inconnu pour ce fournisseur : ${k}.`);
      if (settings.DEFS[k].secret && (v === '' || v === null || v === undefined)) continue;
      aEcrire[k] = settings.normaliser(k, v);
    }
    for (const k of effacer) {
      if (!def.cles.includes(k)) throw new HttpError(400, `Champ inconnu pour ce fournisseur : ${k}.`);
      if (k in aEcrire) throw new HttpError(400, 'Impossible de modifier et d\'effacer le même champ.');
    }
    if (!Object.keys(aEcrire).length && !effacer.length) throw new HttpError(400, 'Aucune modification à enregistrer.');
    // Changer les clés d'un fournisseur qui encaisse = pouvoir rediriger l'argent des abonnements : réservé au Super admin
    const etat = (await db.query('SELECT actif FROM payment_providers WHERE code = $1', [code])).rows[0];
    if (etat && etat.actif && !ctx.admin.permissions.has('demandes.valider')) {
      throw new HttpError(403, 'Les clés d\'un fournisseur actif ne peuvent être modifiées que par le Super administrateur. Demandez sa désactivation, ou contactez-le.');
    }
    await settings.save(aEcrire, effacer);
    await audit.journaliser(ctx, 'agregateur.cles_modifiees', { cible_type: 'agregateur', cible_id: code, details: { champs_modifies: Object.keys(aEcrire), champs_effaces: effacer } });
    return { ok: true };
  });

  // Activation / désactivation : le Super admin décide ; l'administrateur financier dépose une demande
  router.post('/api/admin/finance/agregateurs/:code/activation', P('finance.agregateurs.gerer'), async (ctx) => {
    const code = ctx.params.code;
    if (!PROVIDERS[code]) throw new HttpError(404, 'Fournisseur introuvable.');
    const actif = Boolean(ctx.body.actif);
    if (actif && !PROVIDERS[code].operationnel) throw new HttpError(400, 'Ce fournisseur n\'est pas encore intégré : son adaptateur de paiement reste à développer.');
    if (ctx.admin.permissions.has('demandes.valider')) {
      await db.query('UPDATE payment_providers SET actif = $2, modifie_le = now(), modifie_par = $3 WHERE code = $1', [code, actif, ctx.admin.id]);
      await audit.journaliser(ctx, actif ? 'agregateur.active' : 'agregateur.desactive', { cible_type: 'agregateur', cible_id: code });
      return { applique: true };
    }
    const deja = await db.query("SELECT id FROM subscription_management_requests WHERE type = 'agregateur' AND statut = 'en_attente' AND donnees->>'code' = $1", [code]);
    if (deja.rows.length) throw new HttpError(409, 'Une demande est déjà en attente pour ce fournisseur.');
    const motif = str(ctx.body.motif, 'motif', { optional: true, max: 500 });
    const d = await demandes.creer(db.query, { type: 'agregateur', admin: ctx.admin, resume: `${actif ? 'Activer' : 'Désactiver'} ${code}`, motif, donnees: { code, actif } });
    await audit.journaliser(ctx, 'demande.creee', { cible_type: 'demande', cible_id: d.id, details: { type: 'agregateur', code, actif } });
    ctx.status = 202;
    return { applique: false, demande: d };
  });

  router.get('/api/admin/finance/agregateurs/:code/transactions', P('finance.paiements.lire'), async (ctx) => {
    const code = ctx.params.code;
    if (!PROVIDERS[code]) throw new HttpError(404, 'Fournisseur introuvable.');
    const statut = ['reussi', 'en_attente', 'echoue'].includes(ctx.query.statut) ? ctx.query.statut : null;
    const { rows } = await db.query(
      `SELECT p.id, p.plan, p.reference_transaction, p.montant, p.statut, e.nom AS entreprise, to_char(p.cree_le AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS cree_le
         FROM paiements p JOIN entreprises e ON e.id = p.entreprise_id
        WHERE p.agregateur = $1 AND ($2::text IS NULL OR p.statut = $2::text) ORDER BY p.id DESC LIMIT 200`, [code, statut, TZ]);
    return rows;
  });

  // ---------- Rentabilité et coûts de fonctionnement ----------
  router.get('/api/admin/finance/rentabilite', P('finance.rapports'), async (ctx) => {
    const mois = Math.min(Math.max(parseInt(ctx.query.mois, 10) || 6, 1), 24);
    const marge = Math.min(Math.max(parseInt(ctx.query.marge, 10) || 30, 0), 300);
    const [s, abos, cfg] = await Promise.all([
      serie(mois),
      db.query("SELECT COUNT(*) FILTER (WHERE etat = 'actif' AND montant > 0)::int AS payants, COUNT(*) FILTER (WHERE etat = 'actif')::int AS actifs FROM (" + ABOS_SQL + ') z WHERE NOT cloturee', [TZ]),
      settings.snapshot(),
    ]);
    const revenus = s.reduce((t, x) => t + x.revenus, 0);
    const depenses = s.reduce((t, x) => t + x.depenses, 0);
    const derniers = s.slice(-3);
    const coutMensuel = derniers.length ? derniers.reduce((t, x) => t + x.depenses, 0) / derniers.length : 0;
    const payants = (abos.rows[0] && abos.rows[0].payants) || 0;
    const coutParEntreprise = coutMensuel / Math.max(1, payants);
    const arrondi = (n) => Math.ceil(n / 100) * 100;
    return {
      mois, marge_pct: marge, serie: s,
      totaux: { revenus, depenses, resultat: revenus - depenses, taux_marge_pct: revenus ? Math.round(((revenus - depenses) / revenus) * 1000) / 10 : null },
      cout_fonctionnement_mensuel: Math.round(coutMensuel),
      entreprises_payantes: payants, cout_par_entreprise: Math.round(coutParEntreprise),
      prix_actuels: { mensuel: cfg.prix, annuel: cfg.prixAnnuel },
      prix_suggeres: { mensuel: arrondi(coutParEntreprise * (1 + marge / 100)), annuel: arrondi(coutParEntreprise * 12 * (1 + marge / 100)), seuil_rentabilite_mensuel: arrondi(coutParEntreprise) },
      note: 'Suggestions indicatives calculées sur les coûts réels des 3 derniers mois et le nombre d\'entreprises payantes. Tout changement de tarif est soumis au Super administrateur.',
    };
  });
};
module.exports.PROVIDERS = PROVIDERS;
