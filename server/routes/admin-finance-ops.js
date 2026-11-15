'use strict';
// Espace Administrateur financier et commercial (2/2) : relances, difficultés, dépenses, budgets, tarifs, départs.
const db = require('../lib/db');
const { env } = require('../lib/env');
const { HttpError, str, int } = require('../lib/http');
const { TZ } = require('../lib/tz');
const rbac = require('../lib/rbac');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const demandes = require('../lib/demandes');
const relances = require('../lib/relances');
const notifier = require('../lib/notifier');
const { limit } = require('../lib/ratelimit');

const CATEGORIES = ['hebergement', 'domaine', 'serveur', 'service_externe', 'autre'];
const PERIODES = ['mensuelle', 'annuelle', 'ponctuelle'];
const moisValide = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));

module.exports = function register(router) {
  const P = rbac.exiger;
  const estSuper = (ctx) => ctx.admin.permissions.has('demandes.valider');
  const creerDemande = async (ctx, d) => {
    const r = await demandes.creer(db.query, { ...d, admin: ctx.admin });
    await audit.journaliser(ctx, 'demande.creee', { cible_type: 'demande', cible_id: r.id, details: { type: d.type, resume: d.resume } });
    return r;
  };

  // ================= Relances =================
  const LIEN_WA = (r) => (r.canal === 'whatsapp' ? notifier.lienWhatsapp(r.telephone, r.pays_indicatif, r.message) : null);

  router.get('/api/admin/finance/relances', P('finance.relances'), async (ctx) => {
    const statut = ['programmee', 'en_cours', 'envoyee', 'echec', 'annulee'].includes(ctx.query.statut) ? ctx.query.statut : null;
    const { rows } = await db.query(
      `SELECT r.id, r.entreprise_id, e.nom AS entreprise, e.telephone, e.pays_indicatif, r.type, r.canal, r.statut, r.sujet, r.message, r.erreur, r.reponse,
              to_char(r.programmee_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS programmee_le, to_char(r.envoyee_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS envoyee_le,
              to_char(r.reponse_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS reponse_le
         FROM subscription_reminders r JOIN entreprises e ON e.id = r.entreprise_id
        WHERE ($2::text IS NULL OR r.statut = $2::text) ORDER BY r.id DESC LIMIT 200`, [TZ, statut]);
    return { relances: rows.map((r) => ({ ...r, lien_whatsapp: LIEN_WA(r) })), email_configure: notifier.emailConfigure() };
  });

  // Entreprises dont l'abonnement finit dans 7 jours ou a expiré depuis moins de 60 jours
  router.get('/api/admin/finance/relances/a-relancer', P('finance.relances'), async () => {
    const { rows } = await db.query(
      `SELECT e.id, e.nom, e.email, e.telephone, to_char(f.date_fin, 'YYYY-MM-DD') AS date_fin, (f.date_fin - CURRENT_DATE) AS jours_restants,
              (SELECT to_char(MAX(r.cree_le AT TIME ZONE $1), 'YYYY-MM-DD') FROM subscription_reminders r WHERE r.entreprise_id = e.id AND r.statut IN ('envoyee', 'programmee')) AS derniere_relance,
              EXISTS (SELECT 1 FROM entreprises_difficultes d WHERE d.entreprise_id = e.id AND d.statut = 'ouverte') AS en_difficulte
         FROM entreprises e JOIN LATERAL (SELECT MAX(date_fin) AS date_fin FROM abonnements a WHERE a.entreprise_id = e.id AND a.statut = 'actif') f ON f.date_fin IS NOT NULL
        WHERE e.statut = 'actif' AND e.cloture_le IS NULL AND f.date_fin BETWEEN CURRENT_DATE - 60 AND CURRENT_DATE + 7
        ORDER BY f.date_fin LIMIT 200`, [TZ]);
    return rows;
  });

  router.post('/api/admin/finance/relances', P('finance.relances'), async (ctx) => {
    await limit(`relance:${ctx.admin.id}`, 60, 3600 * 1000);
    const entreprise_id = int(ctx.body.entreprise_id, 'entreprise', { min: 1 });
    const canal = str(ctx.body.canal, 'canal', { max: 10 });
    if (!['email', 'whatsapp'].includes(canal)) throw new HttpError(400, 'Canal invalide.');
    const type = ctx.body.type === undefined ? 'manuelle' : str(ctx.body.type, 'type', { max: 20 });
    if (!['avant_expiration', 'apres_expiration', 'impaye', 'manuelle'].includes(type)) throw new HttpError(400, 'Type invalide.');
    let message = str(ctx.body.message, 'message', { optional: true, max: 2000 });
    let sujet = str(ctx.body.sujet, 'sujet', { optional: true, max: 200 });
    const quand = ctx.body.programmee_le ? new Date(String(ctx.body.programmee_le)) : new Date();
    if (Number.isNaN(quand.getTime())) throw new HttpError(400, 'Date de programmation invalide.');
    const e = (await db.query(`SELECT nom, slug, email, (SELECT to_char(MAX(date_fin), 'YYYY-MM-DD') FROM abonnements WHERE entreprise_id = e.id AND statut = 'actif') AS date_fin FROM entreprises e WHERE id = $1`, [entreprise_id])).rows[0];
    if (!e) throw new HttpError(404, 'Entreprise introuvable.');
    if (!message) { const g = relances.gabarit(type, { ...e, date_fin: e.date_fin || new Date().toISOString() }); message = g.texte; sujet = sujet || g.sujet; }
    const r = await db.query(
      `INSERT INTO subscription_reminders (entreprise_id, type, canal, sujet, message, programmee_le, cree_par) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, entreprise_id, type, canal, sujet, message`,
      [entreprise_id, type, canal, sujet, message, quand.toISOString(), ctx.admin.id]);
    await audit.journaliser(ctx, 'relance.creee', { cible_type: 'entreprise', cible_id: entreprise_id, details: { canal, type, programmee_le: quand.toISOString() } });
    let resultat = null;
    if (canal === 'email' && quand.getTime() <= Date.now() + 60000 && notifier.emailConfigure()) {
      await db.query("UPDATE subscription_reminders SET statut = 'en_cours' WHERE id = $1", [r.rows[0].id]);
      resultat = await relances.envoyer(r.rows[0]);
    }
    ctx.status = 201;
    return { id: r.rows[0].id, envoi: resultat };
  });

  router.post('/api/admin/finance/relances/traiter', P('finance.relances'), async (ctx) => {
    await limit(`relances-traiter:${ctx.admin.id}`, 20, 3600 * 1000);
    const r = await relances.traiter();
    await audit.journaliser(ctx, 'relance.traitement', { details: r });
    return r;
  });

  router.post('/api/admin/finance/relances/:id/envoyer', P('finance.relances'), async (ctx) => {
    await limit(`relance:${ctx.admin.id}`, 60, 3600 * 1000);
    const id = int(ctx.params.id, 'relance', { min: 1 });
    const { rows } = await db.query(`UPDATE subscription_reminders SET statut = 'en_cours' WHERE id = $1 AND canal = 'email' AND statut IN ('programmee', 'echec') RETURNING id, entreprise_id, type, sujet, message`, [id]);
    if (!rows.length) throw new HttpError(404, 'Relance introuvable, déjà envoyée, ou à envoyer manuellement (WhatsApp).');
    const r = await relances.envoyer(rows[0]);
    await audit.journaliser(ctx, 'relance.envoyee', { cible_type: 'relance', cible_id: id, resultat: r.ok ? 'succes' : 'echec', details: { erreur: r.erreur } });
    if (!r.ok) throw new HttpError(502, r.erreur);
    return { ok: true };
  });

  // Marquer comme envoyée (WhatsApp ouvert à la main), annuler, ou noter la réponse de l'entreprise
  router.put('/api/admin/finance/relances/:id', P('finance.relances'), async (ctx) => {
    const id = int(ctx.params.id, 'relance', { min: 1 });
    const reponse = str(ctx.body.reponse, 'réponse', { optional: true, max: 1000 });
    const statut = ctx.body.statut === undefined ? null : str(ctx.body.statut, 'statut', { max: 12 });
    if (statut && !['envoyee', 'annulee'].includes(statut)) throw new HttpError(400, 'Statut invalide.');
    const r = await db.query(
      `UPDATE subscription_reminders SET reponse = COALESCE($2, reponse), reponse_le = CASE WHEN $2::text IS NOT NULL THEN now() ELSE reponse_le END,
              statut = COALESCE($3, statut), envoyee_le = CASE WHEN $3 = 'envoyee' THEN now() ELSE envoyee_le END
        WHERE id = $1 AND statut <> 'en_cours'`, [id, reponse, statut]);
    if (!r.rowCount) throw new HttpError(404, 'Relance introuvable.');
    await audit.journaliser(ctx, 'relance.modifiee', { cible_type: 'relance', cible_id: id, details: { statut, reponse: Boolean(reponse) } });
    return { ok: true };
  });

  // Appel planifié par un service externe (Vercel Cron, GitHub Actions…) : en-tête x-cron-secret = CRON_SECRET
  router.post('/api/cron/relances', async (ctx) => {
    await limit(`cron:${ctx.ip}`, 30, 60 * 1000);
    const fourni = String(ctx.req.headers['x-cron-secret'] || '');
    const bon = env.cronSecret.length >= 24 && fourni.length === env.cronSecret.length && require('node:crypto').timingSafeEqual(Buffer.from(fourni), Buffer.from(env.cronSecret));
    if (!bon) throw new HttpError(401, 'Non autorisé.');
    return relances.traiter();
  });

  // ================= Entreprises en difficulté =================
  router.get('/api/admin/finance/difficultes', P('finance.difficultes'), async () => {
    const { rows } = await db.query(
      `SELECT d.id, d.entreprise_id, e.nom AS entreprise, d.situation, d.delai_jours, d.statut, d.demande_id, m.statut AS demande_statut,
              to_char(d.cree_le AT TIME ZONE $1, 'YYYY-MM-DD') AS cree_le
         FROM entreprises_difficultes d JOIN entreprises e ON e.id = d.entreprise_id LEFT JOIN subscription_management_requests m ON m.id = d.demande_id
        ORDER BY (d.statut = 'ouverte') DESC, d.id DESC LIMIT 200`, [TZ]);
    return rows;
  });

  router.post('/api/admin/finance/difficultes', P('finance.difficultes'), async (ctx) => {
    const entreprise_id = int(ctx.body.entreprise_id, 'entreprise', { min: 1 });
    const situation = str(ctx.body.situation, 'situation', { min: 5, max: 1000 });
    const delai = int(ctx.body.delai_jours, 'délai', { min: 1, max: 180, optional: true });
    const ex = await db.query('SELECT id FROM entreprises WHERE id = $1', [entreprise_id]);
    if (!ex.rows.length) throw new HttpError(404, 'Entreprise introuvable.');
    const r = await db.query('INSERT INTO entreprises_difficultes (entreprise_id, situation, delai_jours, cree_par) VALUES ($1, $2, $3, $4) RETURNING id', [entreprise_id, situation, delai, ctx.admin.id]);
    await audit.journaliser(ctx, 'difficulte.enregistree', { cible_type: 'entreprise', cible_id: entreprise_id, details: { delai_jours: delai } });
    ctx.status = 201;
    return { id: r.rows[0].id };
  });

  // Demande de prolongation exceptionnelle : envoyée au Super admin, seul à pouvoir la valider
  router.post('/api/admin/finance/difficultes/:id/prolongation', P('finance.difficultes'), async (ctx) => {
    const id = int(ctx.params.id, 'dossier', { min: 1 });
    const d = (await db.query('SELECT d.*, e.nom FROM entreprises_difficultes d JOIN entreprises e ON e.id = d.entreprise_id WHERE d.id = $1', [id])).rows[0];
    if (!d) throw new HttpError(404, 'Dossier introuvable.');
    if (d.statut !== 'ouverte') throw new HttpError(409, 'Ce dossier est déjà résolu.');
    if (d.demande_id) {
      const ex = await db.query("SELECT 1 FROM subscription_management_requests WHERE id = $1 AND statut = 'en_attente'", [d.demande_id]);
      if (ex.rows.length) throw new HttpError(409, 'Une demande de prolongation est déjà en attente pour ce dossier.');
    }
    const jours = int(ctx.body.jours, 'jours', { min: 1, max: 180, def: d.delai_jours || 15 });
    const dem = await creerDemande(ctx, { type: 'prolongation', entreprise_id: d.entreprise_id, resume: `Prolongation de ${jours} jour(s) pour ${d.nom}`, motif: d.situation, donnees: { jours, difficulte_id: id } });
    await db.query('UPDATE entreprises_difficultes SET demande_id = $2 WHERE id = $1', [id, dem.id]);
    ctx.status = 202;
    return { demande: dem };
  });

  // ================= Dépenses et budgets =================
  router.get('/api/admin/finance/depenses', P('finance.depenses'), async (ctx) => {
    const { rows } = await db.query(
      `SELECT id, categorie, libelle, fournisseur, montant, periodicite, statut, to_char(date_depense, 'YYYY-MM-DD') AS date_depense FROM hosting_expenses ORDER BY date_depense DESC, id DESC LIMIT 300`);
    const totaux = await db.query(
      `SELECT categorie, COALESCE(SUM(CASE periodicite WHEN 'annuelle' THEN montant / 12.0 ELSE montant END) FILTER (WHERE periodicite <> 'ponctuelle'), 0)::float8 AS mensuel_recurrent,
              COALESCE(SUM(montant) FILTER (WHERE periodicite = 'ponctuelle'), 0)::float8 AS ponctuel
         FROM hosting_expenses WHERE statut = 'validee' GROUP BY categorie`);
    return { depenses: rows, totaux: totaux.rows, seuil_engagement: env.seuilEngagement };
  });

  router.post('/api/admin/finance/depenses', P('finance.depenses'), async (ctx) => {
    const b = ctx.body;
    const categorie = str(b.categorie, 'catégorie', { max: 20 });
    const periodicite = b.periodicite === undefined ? 'ponctuelle' : str(b.periodicite, 'périodicité', { max: 10 });
    if (!CATEGORIES.includes(categorie) || !PERIODES.includes(periodicite)) throw new HttpError(400, 'Catégorie ou périodicité invalide.');
    const libelle = str(b.libelle, 'libellé', { min: 2, max: 150 });
    const fournisseur = str(b.fournisseur, 'fournisseur', { optional: true, max: 100 });
    const montant = int(b.montant, 'montant', { min: 1, max: 1000000000 });
    const date = b.date_depense ? String(b.date_depense) : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date invalide.');
    // Engagement important : coût sur 12 mois ≥ seuil → validation du Super admin obligatoire
    const engagement = periodicite === 'mensuelle' ? montant * 12 : montant;
    // Cumul des engagements du même administrateur sur 30 jours : fractionner une dépense ne contourne pas le seuil
    const cumul = (await db.query(
      `SELECT COALESCE(SUM(CASE periodicite WHEN 'mensuelle' THEN montant * 12 ELSE montant END), 0)::float8 AS total
         FROM hosting_expenses WHERE cree_par = $1 AND statut IN ('validee', 'en_attente') AND cree_le > now() - interval '30 days'`, [ctx.admin.id])).rows[0];
    const dejaEngage = Number(cumul && cumul.total) || 0;
    const aValider = (engagement >= env.seuilEngagement || dejaEngage + engagement >= env.seuilEngagement) && !estSuper(ctx);
    const r = await db.query(
      `INSERT INTO hosting_expenses (categorie, libelle, fournisseur, montant, periodicite, date_depense, statut, cree_par) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [categorie, libelle, fournisseur, montant, periodicite, date, aValider ? 'en_attente' : 'validee', ctx.admin.id]);
    const id = r.rows[0].id;
    let demande = null;
    if (aValider) {
      demande = await creerDemande(ctx, { type: 'engagement', resume: `Engagement : ${libelle} (${new Intl.NumberFormat('fr-FR').format(montant)} F CFA, ${periodicite})`, motif: fournisseur, donnees: { depense_id: id, montant, periodicite } });
      await db.query('UPDATE hosting_expenses SET demande_id = $2 WHERE id = $1', [id, demande.id]);
    }
    await audit.journaliser(ctx, 'depense.creee', { cible_type: 'depense', cible_id: id, details: { categorie, montant, periodicite, a_valider: aValider } });
    ctx.status = 201;
    return { id, statut: aValider ? 'en_attente' : 'validee', demande };
  });

  router.put('/api/admin/finance/depenses/:id/annuler', P('finance.depenses'), async (ctx) => {
    const id = int(ctx.params.id, 'dépense', { min: 1 });
    const r = await db.query("UPDATE hosting_expenses SET statut = 'annulee' WHERE id = $1 AND statut IN ('validee', 'en_attente') RETURNING montant, libelle", [id]);
    if (!r.rows.length) throw new HttpError(404, 'Dépense introuvable ou déjà clôturée.');
    await db.query("UPDATE subscription_management_requests SET statut = 'annulee' WHERE statut = 'en_attente' AND type = 'engagement' AND donnees->>'depense_id' = $1", [String(id)]);
    await audit.journaliser(ctx, 'depense.annulee', { cible_type: 'depense', cible_id: id, details: r.rows[0] });
    return { ok: true };
  });

  router.get('/api/admin/finance/budgets', P('finance.depenses'), async (ctx) => {
    const annee = /^\d{4}$/.test(String(ctx.query.annee)) ? String(ctx.query.annee) : String(new Date().getFullYear());
    const [prevu, reel] = await Promise.all([
      db.query("SELECT mois, categorie, montant FROM budgets_plateforme WHERE mois LIKE $1 || '-%' ORDER BY mois, categorie", [annee]),
      db.query(
        `SELECT to_char(g.m, 'YYYY-MM') AS mois, x.categorie,
                COALESCE(SUM(CASE x.periodicite WHEN 'annuelle' THEN x.montant / 12.0 ELSE x.montant END), 0)::float8 AS montant
           FROM generate_series(make_date($1::int, 1, 1), make_date($1::int, 12, 1), interval '1 month') g(m)
           JOIN hosting_expenses x ON x.statut = 'validee' AND (
                (x.periodicite = 'ponctuelle' AND date_trunc('month', x.date_depense)::date = g.m::date)
             OR (x.periodicite = 'mensuelle' AND date_trunc('month', x.date_depense)::date <= g.m::date)
             OR (x.periodicite = 'annuelle' AND date_trunc('month', x.date_depense)::date <= g.m::date AND g.m::date < (date_trunc('month', x.date_depense) + interval '12 months')::date))
          GROUP BY 1, 2 ORDER BY 1, 2`, [annee]),
    ]);
    return { annee, prevu: prevu.rows, reel: reel.rows.map((r) => ({ ...r, montant: Math.round(r.montant) })), categories: CATEGORIES };
  });

  router.put('/api/admin/finance/budgets', P('finance.depenses'), async (ctx) => {
    const mois = String(ctx.body.mois);
    const categorie = str(ctx.body.categorie, 'catégorie', { max: 20 });
    if (!moisValide(mois) || !CATEGORIES.includes(categorie)) throw new HttpError(400, 'Mois ou catégorie invalide.');
    const montant = int(ctx.body.montant, 'montant', { min: 0, max: 1000000000 });
    await db.query('INSERT INTO budgets_plateforme (mois, categorie, montant) VALUES ($1, $2, $3) ON CONFLICT (mois, categorie) DO UPDATE SET montant = EXCLUDED.montant', [mois, categorie, montant]);
    await audit.journaliser(ctx, 'budget.modifie', { cible_type: 'budget', cible_id: `${mois}:${categorie}`, details: { montant } });
    return { ok: true };
  });

  // ================= Tarifs =================
  router.get('/api/admin/finance/tarifs', P('finance.tarifs'), async () => {
    const cfg = await settings.snapshot();
    const { rows } = await db.query(
      `SELECT id, statut, resume, motif, donnees, demandeur_nom, decision_note, to_char(cree_le AT TIME ZONE $1, 'YYYY-MM-DD') AS cree_le FROM subscription_management_requests WHERE type = 'tarif' ORDER BY id DESC LIMIT 50`, [TZ]);
    return { formules: Object.values(cfg.plans), propositions: rows };
  });

  router.post('/api/admin/finance/tarifs/proposer', P('finance.tarifs'), async (ctx) => {
    const plan = str(ctx.body.plan, 'formule', { max: 10 });
    if (!['mensuel', 'annuel'].includes(plan)) throw new HttpError(400, 'Formule inconnue.');
    const cles = plan === 'annuel' ? ['abonnement_prix_annuel', 'abonnement_jours_annuel'] : ['abonnement_prix', 'abonnement_jours'];
    const prix = Number(settings.normaliser(cles[0], ctx.body.prix));
    const jours = ctx.body.jours === undefined || ctx.body.jours === '' ? null : Number(settings.normaliser(cles[1], ctx.body.jours));
    const motif = str(ctx.body.motif, 'justification', { min: 5, max: 1000 });
    const dem = await creerDemande(ctx, { type: 'tarif', resume: `Formule ${plan} : ${new Intl.NumberFormat('fr-FR').format(prix)} F CFA${jours ? ` / ${jours} jours` : ''}`, motif, donnees: { plan, prix, jours } });
    ctx.status = 202;
    return { demande: dem };
  });

  // ================= Départs (agents, entreprises) =================
  router.get('/api/admin/finance/departs/agents', P('finance.departs'), async (ctx) => {
    const id = int(ctx.query.entreprise_id, 'entreprise', { min: 1 });
    const { rows } = await db.query('SELECT id, nom_complet, role, actif FROM utilisateurs WHERE entreprise_id = $1 ORDER BY role, nom_complet', [id]);
    return rows;
  });

  router.get('/api/admin/finance/departs/verification', P('finance.departs'), async (ctx) => {
    const ent = int(ctx.query.entreprise_id, 'entreprise', { min: 1 });
    if (ctx.query.utilisateur_id) return demandes.verifierDepart(ent, int(ctx.query.utilisateur_id, 'agent', { min: 1 }));
    return demandes.verifierResiliation(ent);
  });

  router.post('/api/admin/finance/departs/agent', P('finance.departs'), async (ctx) => {
    const ent = int(ctx.body.entreprise_id, 'entreprise', { min: 1 });
    const uid = int(ctx.body.utilisateur_id, 'agent', { min: 1 });
    const motif = str(ctx.body.motif, 'motif', { min: 3, max: 1000 });
    const v = await demandes.verifierDepart(ent, uid);
    if (!v.agent.actif) throw new HttpError(409, 'Cet agent est déjà désactivé.');
    if (v.controles.some((c) => c.bloquant)) throw new HttpError(409, 'Départ impossible : cet agent est le seul propriétaire actif de l\'entreprise.');
    const dem = await creerDemande(ctx, { type: 'depart_agent', entreprise_id: ent, resume: `Départ de ${v.agent.nom}`, motif, donnees: { utilisateur_id: uid }, verification: v });
    ctx.status = 202;
    return { demande: dem, verification: v };
  });

  // Résiliation : enregistrée en brouillon, contrôlée, puis soumise explicitement au Super admin
  router.post('/api/admin/finance/departs/entreprise', P('finance.departs'), async (ctx) => {
    const ent = int(ctx.body.entreprise_id, 'entreprise', { min: 1 });
    const motif = str(ctx.body.motif, 'motif', { min: 3, max: 1000 });
    const v = await demandes.verifierResiliation(ent);
    if (v.controles.some((c) => c.bloquant)) throw new HttpError(409, 'Cette entreprise est déjà clôturée.');
    const dem = await creerDemande(ctx, { type: 'resiliation', entreprise_id: ent, resume: `Résiliation de ${v.entreprise.nom}`, motif, donnees: {}, verification: v, statut: 'brouillon' });
    ctx.status = 201;
    return { demande: dem, verification: v };
  });

  router.post('/api/admin/finance/demandes/:id/soumettre', P('finance.departs'), async (ctx) => {
    const id = int(ctx.params.id, 'demande', { min: 1 });
    const d = (await db.query("SELECT id, type, entreprise_id FROM subscription_management_requests WHERE id = $1 AND statut = 'brouillon'", [id])).rows[0];
    if (!d) throw new HttpError(404, 'Brouillon introuvable.');
    const v = d.type === 'resiliation' ? await demandes.verifierResiliation(d.entreprise_id) : null;
    if (v && v.controles.some((c) => c.bloquant)) throw new HttpError(409, 'Clôture impossible : l\'entreprise est déjà clôturée.');
    await db.query("UPDATE subscription_management_requests SET statut = 'en_attente', verification = COALESCE($2::jsonb, verification) WHERE id = $1", [id, v ? JSON.stringify(v) : null]);
    await audit.journaliser(ctx, 'demande.soumise', { cible_type: 'demande', cible_id: id, details: { type: d.type } });
    return { ok: true };
  });

  router.post('/api/admin/finance/demandes/:id/annuler', P('finance.departs'), async (ctx) => {
    const id = int(ctx.params.id, 'demande', { min: 1 });
    const r = await db.query("UPDATE subscription_management_requests SET statut = 'annulee' WHERE id = $1 AND statut IN ('brouillon', 'en_attente') AND demandeur_id = $2 RETURNING type", [id, ctx.admin.id]);
    if (!r.rows.length) throw new HttpError(404, 'Demande introuvable, déjà traitée, ou déposée par un autre administrateur.');
    await audit.journaliser(ctx, 'demande.annulee', { cible_type: 'demande', cible_id: id, details: { type: r.rows[0].type } });
    return { ok: true };
  });

  // Suivi de toutes les demandes déposées auprès du Super admin
  router.get('/api/admin/finance/demandes', P('finance.dashboard'), async () => {
    const { rows } = await db.query(
      `SELECT d.id, d.type, d.statut, d.resume, d.motif, d.verification, d.demandeur_nom, d.decision_note, d.decide_nom, d.demandeur_id,
              to_char(d.cree_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS cree_le, to_char(d.decide_le AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS decide_le
         FROM subscription_management_requests d ORDER BY d.id DESC LIMIT 100`, [TZ]);
    return rows.map((r) => ({ ...r, type_libelle: demandes.TYPES[r.type] || r.type }));
  });
};
