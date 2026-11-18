'use strict';
// Relances d'abonnement : planification automatique (avant/après expiration) et envoi des relances échues.
const db = require('./db');
const { env } = require('./env');
const notifier = require('./notifier');
const conformite = require('./conformite');

const dateFr = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };

function gabarit(type, e) {
  const lien = env.publicUrl ? `${env.publicUrl}/app/${e.slug}/` : '';
  const pied = lien ? `\n\nRenouveler maintenant : ${lien}\n\nL'équipe Best-Quinca` : '\n\nL\'équipe Best-Quinca';
  if (type === 'avant_expiration') {
    return { sujet: 'Votre abonnement Best-Quinca arrive à échéance', texte: `Bonjour ${e.nom},\n\nVotre abonnement Best-Quinca expire le ${dateFr(e.date_fin)}. Renouvelez-le dès maintenant pour que votre caisse et votre stock restent accessibles.${pied}` };
  }
  if (type === 'apres_expiration') {
    return { sujet: 'Votre abonnement Best-Quinca a expiré', texte: `Bonjour ${e.nom},\n\nVotre abonnement Best-Quinca a expiré le ${dateFr(e.date_fin)}. Vos données sont conservées : renouvelez votre abonnement pour retrouver l'accès à votre espace.\n\nSi vous rencontrez une difficulté de paiement, répondez simplement à ce message.${pied}` };
  }
  return { sujet: 'Best-Quinca : rappel concernant votre abonnement', texte: `Bonjour ${e.nom},\n\nNous vous rappelons que votre abonnement Best-Quinca nécessite votre attention.${pied}` };
}

// Insère les relances automatiques manquantes : J-7 et J-1 avant la fin, J+1 et J+7 après. Idempotent (clé unique).
async function planifierAutomatiques() {
  const r = await db.query(
    `WITH fin AS (
       SELECT e.id AS entreprise_id, e.nom, e.slug, e.email, MAX(a.date_fin) AS date_fin
         FROM entreprises e JOIN abonnements a ON a.entreprise_id = e.id AND a.statut IN ('actif', 'suspendu')
        WHERE e.statut = 'actif' AND e.cloture_le IS NULL AND e.email IS NOT NULL
        GROUP BY e.id
     ), regles(decalage, type) AS (VALUES (-7, 'avant_expiration'), (-1, 'avant_expiration'), (1, 'apres_expiration'), (7, 'apres_expiration'))
     INSERT INTO subscription_reminders (entreprise_id, type, canal, sujet, message, programmee_le, cle)
     SELECT f.entreprise_id, g.type, 'email', '', '', now(), 'auto:' || f.entreprise_id || ':' || f.date_fin || ':' || g.decalage
       FROM fin f CROSS JOIN regles g
      WHERE CURRENT_DATE = f.date_fin + g.decalage
     ON CONFLICT (cle) WHERE cle IS NOT NULL DO NOTHING
     RETURNING id`,
  );
  return r.rows.length;
}

// Envoie une relance précise (statut en_cours déjà posé par l'appelant). Retourne { ok, erreur }
async function envoyer(rel) {
  const { rows } = await db.query(
    `SELECT e.nom, e.slug, e.email, (SELECT to_char(MAX(date_fin), 'YYYY-MM-DD') FROM abonnements WHERE entreprise_id = e.id AND statut = 'actif') AS date_fin
       FROM entreprises e WHERE e.id = $1`, [rel.entreprise_id]);
  const e = rows[0];
  if (!e) return { ok: false, erreur: 'Entreprise introuvable.' };
  let { sujet, message } = rel;
  if (!message) { const g = gabarit(rel.type, { ...e, date_fin: e.date_fin || new Date().toISOString() }); sujet = g.sujet; message = g.texte; }
  const r = await notifier.envoyerEmail({ a: e.email, sujet: sujet || 'Best-Quinca', texte: message });
  await db.query(
    `UPDATE subscription_reminders SET statut = $2, envoyee_le = CASE WHEN $2 = 'envoyee' THEN now() END, erreur = $3, sujet = $4, message = $5 WHERE id = $1`,
    [rel.id, r.ok ? 'envoyee' : 'echec', r.ok ? null : String(r.erreur).slice(0, 300), sujet, message],
  );
  return r;
}

// Rétention : historique de connexions conservé 1 an, sessions expirées 30 jours. L'audit n'est jamais purgé.
async function purger() {
  try {
    await db.query('DELETE FROM connexions_journal WHERE cree_le < now() - make_interval(days => $1::int)', [conformite.RETENTION_CONNEXIONS_JOURS]);
    await db.query("DELETE FROM admin_sessions WHERE expire_le < now() - interval '30 days'");
    // Espaces clôturés dont la durée de conservation annoncée est écoulée : suppression définitive (la politique de confidentialité le promet)
    const dus = await db.query('SELECT id FROM entreprises WHERE cloture_le IS NOT NULL AND conservation_jusqua IS NOT NULL AND conservation_jusqua < CURRENT_DATE');
    const ids = (dus.rows || []).map((r) => r.id);
    if (ids.length) {
      await db.tx(async (q) => {
        // Les demandes d'administration gardent une trace, mais sans le nom ni le motif de l'entreprise supprimée
        await q("UPDATE subscription_management_requests SET resume = 'Entreprise supprimée à l''échéance de conservation', motif = NULL, verification = NULL, donnees = '{}'::jsonb WHERE entreprise_id = ANY($1::int[])", [ids]);
        await q('DELETE FROM entreprises WHERE id = ANY($1::int[])', [ids]);
      });
      await require('./audit').journaliser({ admin: { email: 'système', role: 'SYSTEME' } }, 'retention.entreprises_supprimees', { cible_type: 'entreprise', details: { nombre: ids.length } });
    }
  } catch (e) { console.error('Purge de rétention impossible :', e.message); }
}

// Traite les relances échues (e-mail uniquement). « FOR UPDATE SKIP LOCKED » : deux instances ne les envoient jamais en double.
async function traiter({ planifier = true } = {}) {
  await purger();
  const planifiees = planifier ? await planifierAutomatiques() : 0;
  if (!notifier.emailConfigure()) return { planifiees, envoyees: 0, echecs: 0, note: 'E-mail non configuré : relances programmées mais non envoyées.' };
  const { rows } = await db.query(
    `UPDATE subscription_reminders SET statut = 'en_cours'
      WHERE id IN (SELECT id FROM subscription_reminders WHERE statut = 'programmee' AND canal = 'email' AND programmee_le <= now() ORDER BY programmee_le LIMIT 50 FOR UPDATE SKIP LOCKED)
      RETURNING id, entreprise_id, type, sujet, message`,
  );
  let envoyees = 0; let echecs = 0;
  for (const rel of rows) { const r = await envoyer(rel); if (r.ok) envoyees++; else echecs++; }
  return { planifiees, envoyees, echecs };
}

function demarrerPlanificateur() {
  if (env.serverless || !env.relancesAuto) return null;
  const t = setInterval(() => { traiter().catch((e) => console.error('Relances automatiques :', e.message)); }, 30 * 60 * 1000);
  t.unref();
  return t;
}

module.exports = { gabarit, planifierAutomatiques, envoyer, traiter, demarrerPlanificateur };
