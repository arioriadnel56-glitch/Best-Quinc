'use strict';
// Demandes soumises au Super administrateur (table subscription_management_requests).
// L'administrateur financier PRÉPARE et PROPOSE ; seul le Super admin DÉCIDE, et l'effet n'est appliqué qu'à l'approbation.
const db = require('./db');
const env = require('./env').env;
const { HttpError } = require('./http');
const settings = require('./settings');
const audit = require('./audit');
const realtime = require('./realtime');
const { offrirJours } = require('./abonnements-admin');

const TYPES = {
  prolongation: 'Prolongation exceptionnelle',
  tarif: 'Changement de tarif',
  agregateur: 'Activation d\'un fournisseur de paiement',
  engagement: 'Engagement financier important',
  depart_agent: 'Départ d\'un agent',
  resiliation: 'Résiliation d\'une entreprise',
};

async function creer(q, { type, entreprise_id = null, admin, resume, motif = null, donnees = {}, verification = null, statut = 'en_attente' }) {
  const r = await q(
    `INSERT INTO subscription_management_requests (type, statut, entreprise_id, demandeur_id, demandeur_nom, resume, motif, donnees, verification)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) RETURNING id, type, statut, resume`,
    [type, statut, entreprise_id, admin.id, admin.nom_complet, String(resume).slice(0, 300), motif, JSON.stringify(donnees), verification ? JSON.stringify(verification) : null],
  );
  return r.rows[0];
}

// ---- Contrôles préalables (affichés au Super admin) ----
async function verifierDepart(entrepriseId, utilisateurId) {
  const u = await db.query('SELECT id, nom_complet, role, actif FROM utilisateurs WHERE id = $1 AND entreprise_id = $2', [utilisateurId, entrepriseId]);
  if (!u.rows.length) throw new HttpError(404, 'Agent introuvable dans cette entreprise.');
  const agent = u.rows[0];
  const [credits, inv, derniere, proprios] = await Promise.all([
    db.query("SELECT COUNT(*)::int AS n FROM ventes WHERE utilisateur_id = $1 AND mode_paiement = 'credit' AND total > montant_paye", [utilisateurId]),
    db.query("SELECT COUNT(*)::int AS n FROM inventaires WHERE cree_par = $1 AND statut = 'en_cours'", [utilisateurId]),
    db.query("SELECT COUNT(*)::int AS n FROM ventes WHERE utilisateur_id = $1 AND cree_le > now() - interval '7 days'", [utilisateurId]),
    db.query("SELECT COUNT(*)::int AS n FROM utilisateurs WHERE entreprise_id = $1 AND role = 'proprietaire' AND actif AND id <> $2", [entrepriseId, utilisateurId]),
  ]);
  const seulProprio = agent.role === 'proprietaire' && !(proprios.rows[0] && proprios.rows[0].n > 0);
  return {
    agent: { id: agent.id, nom: agent.nom_complet, role: agent.role, actif: agent.actif },
    controles: [
      { id: 'proprietaire', libelle: 'Autre propriétaire actif dans l\'entreprise', ok: !seulProprio, bloquant: seulProprio },
      { id: 'credits', libelle: 'Ventes à crédit encore ouvertes saisies par l\'agent', ok: !(credits.rows[0] && credits.rows[0].n), valeur: credits.rows[0] ? credits.rows[0].n : 0 },
      { id: 'inventaire', libelle: 'Inventaire en cours ouvert par l\'agent', ok: !(inv.rows[0] && inv.rows[0].n), valeur: inv.rows[0] ? inv.rows[0].n : 0 },
      { id: 'activite', libelle: 'Ventes saisies par l\'agent ces 7 derniers jours (historique conservé)', ok: true, valeur: derniere.rows[0] ? derniere.rows[0].n : 0 },
    ],
  };
}

async function verifierResiliation(entrepriseId) {
  const e = await db.query('SELECT id, nom, statut, cloture_le FROM entreprises WHERE id = $1', [entrepriseId]);
  if (!e.rows.length) throw new HttpError(404, 'Entreprise introuvable.');
  const [attente, echoues, abo, users] = await Promise.all([
    db.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(montant), 0)::int AS total FROM paiements WHERE entreprise_id = $1 AND statut = 'en_attente' AND cree_le > now() - interval '30 days'", [entrepriseId]),
    db.query("SELECT COUNT(*)::int AS n FROM paiements WHERE entreprise_id = $1 AND statut = 'echoue' AND cree_le > now() - interval '30 days'", [entrepriseId]),
    db.query("SELECT to_char(MAX(date_fin), 'YYYY-MM-DD') AS fin FROM abonnements WHERE entreprise_id = $1 AND statut = 'actif'", [entrepriseId]),
    db.query('SELECT COUNT(*)::int AS n FROM utilisateurs WHERE entreprise_id = $1 AND actif', [entrepriseId]),
  ]);
  return {
    entreprise: { id: e.rows[0].id, nom: e.rows[0].nom, statut: e.rows[0].statut },
    controles: [
      { id: 'deja_cloturee', libelle: 'Entreprise non encore clôturée', ok: !e.rows[0].cloture_le, bloquant: Boolean(e.rows[0].cloture_le) },
      { id: 'paiements_attente', libelle: 'Paiements d\'abonnement non finalisés (30 derniers jours)', ok: !(attente.rows[0] && attente.rows[0].n), valeur: attente.rows[0] ? attente.rows[0].n : 0 },
      { id: 'paiements_echoues', libelle: 'Paiements échoués (30 derniers jours)', ok: !(echoues.rows[0] && echoues.rows[0].n), valeur: echoues.rows[0] ? echoues.rows[0].n : 0 },
      { id: 'abonnement', libelle: 'Fin du dernier abonnement actif', ok: true, valeur: (abo.rows[0] && abo.rows[0].fin) || 'aucun' },
      { id: 'utilisateurs', libelle: 'Comptes utilisateurs qui seront fermés (données conservées)', ok: true, valeur: users.rows[0] ? users.rows[0].n : 0 },
    ],
    conservation_ans: env.conservationAns,
  };
}

// ---- Application d'une décision d'approbation (dans la transaction de décision) ----
async function appliquer(q, d, ctx, effets) {
  const x = d.donnees || {};
  switch (d.type) {
    case 'prolongation': {
      const fin = await offrirJours(q, d.entreprise_id, Number(x.jours));
      await q("UPDATE entreprises_difficultes SET statut = 'resolue' WHERE demande_id = $1", [d.id]);
      await audit.journaliser(ctx, 'abonnement.offert', { q, cible_type: 'entreprise', cible_id: d.entreprise_id, details: { jours: x.jours, nouvelle_fin: fin, demande: d.id } });
      effets.push(() => realtime.publier(d.entreprise_id, 'abonnement.change'));
      break;
    }
    case 'tarif': {
      const [cleP, cleJ] = x.plan === 'annuel' ? ['abonnement_prix_annuel', 'abonnement_jours_annuel'] : ['abonnement_prix', 'abonnement_jours'];
      const ecrire = [[cleP, settings.normaliser(cleP, x.prix)]];
      if (x.jours !== undefined && x.jours !== null) ecrire.push([cleJ, settings.normaliser(cleJ, x.jours)]);
      for (const [k, v] of ecrire) {
        await q('INSERT INTO plateforme_parametres (cle, valeur) VALUES ($1, $2) ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur, modifie_le = now()', [k, v]);
      }
      await audit.journaliser(ctx, 'tarif.modifie', { q, cible_type: 'parametres', details: { plan: x.plan, prix: x.prix, jours: x.jours, demande: d.id } });
      effets.push(() => settings.invalidate());
      break;
    }
    case 'agregateur': {
      const r = await q('UPDATE payment_providers SET actif = $1, modifie_le = now(), modifie_par = $3 WHERE code = $2', [Boolean(x.actif), x.code, ctx.admin.id]);
      if (!r.rowCount) throw new HttpError(404, 'Fournisseur introuvable.');
      await audit.journaliser(ctx, x.actif ? 'agregateur.active' : 'agregateur.desactive', { q, cible_type: 'agregateur', cible_id: x.code, details: { demande: d.id } });
      break;
    }
    case 'engagement': {
      await q("UPDATE hosting_expenses SET statut = 'validee' WHERE id = $1 AND statut = 'en_attente'", [x.depense_id]);
      await audit.journaliser(ctx, 'depense.validee', { q, cible_type: 'depense', cible_id: x.depense_id, details: { demande: d.id } });
      break;
    }
    case 'depart_agent': {
      const cible = await q('SELECT role FROM utilisateurs WHERE id = $1 AND entreprise_id = $2 FOR UPDATE', [x.utilisateur_id, d.entreprise_id]);
      if (cible.rows[0] && cible.rows[0].role === 'proprietaire') {
        const autres = await q("SELECT COUNT(*)::int AS n FROM utilisateurs WHERE entreprise_id = $1 AND role = 'proprietaire' AND actif AND id <> $2", [d.entreprise_id, x.utilisateur_id]);
        if (!(autres.rows[0] && autres.rows[0].n > 0)) throw new HttpError(409, 'Cet agent est devenu le seul propriétaire actif : le départ ne peut plus être appliqué.');
      }
      const r = await q('UPDATE utilisateurs SET actif = false, sessions_revoquees_le = now() WHERE id = $1 AND entreprise_id = $2', [x.utilisateur_id, d.entreprise_id]);
      if (!r.rowCount) throw new HttpError(404, 'Agent introuvable.');
      await audit.journaliser(ctx, 'agent.acces_revoque', { q, cible_type: 'utilisateur', cible_id: x.utilisateur_id, details: { entreprise_id: d.entreprise_id, demande: d.id } });
      effets.push(() => realtime.fermerUtilisateur(x.utilisateur_id));
      break;
    }
    case 'resiliation': {
      const r = await q(
        `UPDATE entreprises SET statut = 'suspendu', cloture_le = now(), conservation_jusqua = CURRENT_DATE + make_interval(years => $2::int) WHERE id = $1 AND cloture_le IS NULL`,
        [d.entreprise_id, env.conservationAns],
      );
      if (!r.rowCount) throw new HttpError(409, 'Cette entreprise est déjà clôturée ou introuvable.');
      await q("UPDATE abonnements SET statut = 'resilie' WHERE entreprise_id = $1 AND statut = 'actif'", [d.entreprise_id]);
      await audit.journaliser(ctx, 'entreprise.cloturee', { q, cible_type: 'entreprise', cible_id: d.entreprise_id, details: { demande: d.id, conservation_ans: env.conservationAns } });
      effets.push(() => realtime.fermerEntreprise(d.entreprise_id));
      break;
    }
    default: throw new HttpError(400, 'Type de demande inconnu.');
  }
}

// Effets d'un REFUS (ex. dépense non validée)
async function refuser(q, d, ctx) {
  if (d.type === 'engagement') await q("UPDATE hosting_expenses SET statut = 'refusee' WHERE id = $1 AND statut = 'en_attente'", [(d.donnees || {}).depense_id]);
  if (d.type === 'prolongation') await q("UPDATE entreprises_difficultes SET statut = 'ouverte' WHERE demande_id = $1", [d.id]);
}

async function decider(ctx, id, decision, note) {
  if (!['approuver', 'refuser'].includes(decision)) throw new HttpError(400, 'Décision invalide.');
  const effets = [];
  const res = await db.tx(async (q) => {
    const r = await q('SELECT * FROM subscription_management_requests WHERE id = $1 FOR UPDATE', [id]);
    const d = r.rows[0];
    if (!d) throw new HttpError(404, 'Demande introuvable.');
    if (d.statut !== 'en_attente') throw new HttpError(409, 'Cette demande a déjà été traitée ou n\'est pas encore soumise.');
    const approuvee = decision === 'approuver';
    if (approuvee) await appliquer(q, d, ctx, effets); else await refuser(q, d, ctx);
    await q(
      `UPDATE subscription_management_requests SET statut = $2, decide_par = $3, decide_nom = $4, decide_le = now(), decision_note = $5 WHERE id = $1`,
      [id, approuvee ? 'approuvee' : 'refusee', ctx.admin.id, ctx.admin.nom_complet, note],
    );
    await audit.journaliser(ctx, approuvee ? 'demande.approuvee' : 'demande.refusee', { q, cible_type: 'demande', cible_id: id, details: { type: d.type, resume: d.resume, note, demandeur: d.demandeur_nom } });
    return { id, statut: approuvee ? 'approuvee' : 'refusee' };
  });
  effets.forEach((f) => { try { f(); } catch { /* temps réel facultatif */ } });
  try { await require('./securite').modificationSensible(ctx, `demande.${res.statut}`, 'demande', id); } catch (e) { console.error('Alerte sécurité impossible :', e.message); }
  return res;
}

module.exports = { TYPES, creer, decider, verifierDepart, verifierResiliation };
