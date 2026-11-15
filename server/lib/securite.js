'use strict';
// Détection et alertes de sécurité informatique. Toutes les écritures sont tolérantes aux pannes :
// une alerte qui ne peut pas être enregistrée ne doit jamais bloquer une connexion ou une opération.
const db = require('./db');

const SEUIL_ECHECS = 5;          // échecs de connexion sur 15 minutes avant alerte
const FENETRE_MIN = 15;
const SEUIL_RAFALE = 25;         // actions sensibles par administrateur sur 10 minutes
const navigateur = (req) => String((req && req.headers && req.headers['user-agent']) || '').slice(0, 200);

// Crée une alerte, sauf s'il en existe déjà une ouverte du même type pour la même cible depuis moins de `dedupMin` minutes
async function alerter({ type, gravite = 'moyenne', titre, details = null, type_compte = null, compte_id = null, email = null, ip = null, dedupMin = 30 }) {
  const { rows } = await db.query(
    `SELECT 1 FROM security_alerts WHERE type = $1 AND statut IN ('ouverte', 'en_cours') AND cree_le > now() - make_interval(mins => $2::int)
        AND COALESCE(email, '') = COALESCE($3::text, '') AND COALESCE(ip, '') = COALESCE($4::text, '') LIMIT 1`,
    [type, dedupMin, email, ip],
  );
  if (rows.length) return false;
  await db.query(
    `INSERT INTO security_alerts (type, gravite, titre, details, type_compte, compte_id, email, ip) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [type, gravite, titre, details ? JSON.stringify(details) : null, type_compte, compte_id, email, ip],
  );
  return true;
}

// Historique des connexions (administrateurs et entreprises)
async function enregistrerConnexion({ type_compte, compte_id = null, entreprise_id = null, email = null, evenement, motif = null, ctx }) {
  try {
    await db.query(
      `INSERT INTO connexions_journal (type_compte, compte_id, entreprise_id, email, evenement, motif, ip, navigateur) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [type_compte, compte_id, entreprise_id, email, evenement, motif, (ctx && ctx.ip) || null, navigateur(ctx && ctx.req)],
    );
    if (evenement === 'echec') await analyserEchecs({ type_compte, email, ip: ctx && ctx.ip });
  } catch (e) { console.error('Journal de connexion : écriture impossible :', e.message); }
}

async function analyserEchecs({ type_compte, email, ip }) {
  if (email) {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM connexions_journal WHERE evenement = 'echec' AND email = $1 AND cree_le > now() - make_interval(mins => $2::int)`, [email, FENETRE_MIN]);
    if (r.rows[0] && r.rows[0].n >= SEUIL_ECHECS) {
      await alerter({ type: 'tentatives_repetees', gravite: type_compte === 'admin' ? 'haute' : 'moyenne', titre: `Tentatives de connexion répétées sur ${email}`, details: { echecs: r.rows[0].n, fenetre_min: FENETRE_MIN }, type_compte, email, ip: null });
    }
  }
  if (ip) {
    const r = await db.query(
      `SELECT COUNT(DISTINCT email)::int AS comptes, COUNT(*)::int AS n FROM connexions_journal WHERE evenement = 'echec' AND ip = $1 AND cree_le > now() - make_interval(mins => $2::int)`, [ip, FENETRE_MIN]);
    const x = r.rows[0];
    if (x && (x.comptes >= 4 || x.n >= SEUIL_ECHECS * 2)) {
      await alerter({ type: 'activite_suspecte', gravite: 'haute', titre: `Adresse ${ip} : ${x.n} échecs sur ${x.comptes} compte(s)`, details: { echecs: x.n, comptes: x.comptes }, ip });
    }
  }
}

// Connexion réussie d'un administrateur depuis une adresse jamais vue
async function connexionInhabituelle(admin, ctx) {
  try {
    if (!ctx.ip) return;
    const r = await db.query(
      `SELECT COUNT(*) FILTER (WHERE ip = $2)::int AS connue, COUNT(*)::int AS total FROM connexions_journal
        WHERE type_compte = 'admin' AND compte_id = $1 AND evenement = 'connexion' AND cree_le > now() - interval '60 days'`, [admin.id, ctx.ip]);
    const x = r.rows[0];
    if (x && x.total > 0 && x.connue === 0) {
      await alerter({ type: 'connexion_inhabituelle', titre: `Connexion de ${admin.email} depuis une nouvelle adresse`, details: { role: admin.role }, type_compte: 'admin', compte_id: admin.id, email: admin.email, ip: ctx.ip, dedupMin: 240 });
    }
  } catch (e) { console.error('Détection de connexion inhabituelle impossible :', e.message); }
}

const refus = new Map();
async function accesRefuse(ctx, permission) {
  const cle = ctx.admin.id; const maintenant = Date.now(); const r = refus.get(cle);
  if (!r || r.fin <= maintenant) refus.set(cle, { n: 1, fin: maintenant + 60000 });
  else if (++r.n > 20) return; // plus de 20 refus par minute pour un même compte : déjà signalé, on n'inonde pas le journal
  const audit = require('./audit');
  await audit.journaliser(ctx, 'acces.refuse', { cible_type: 'permission', cible_id: permission, resultat: 'refuse', details: { chemin: ctx.pathname } });
  await alerter({ type: 'acces_non_autorise', gravite: 'haute', titre: `Accès refusé : ${ctx.admin.email} (${ctx.admin.role}) a tenté « ${permission} »`, details: { permission, chemin: ctx.pathname }, type_compte: 'admin', compte_id: ctx.admin.id, email: ctx.admin.email, ip: ctx.ip, dedupMin: 10 });
}

async function modificationSensible(ctx, action, cible_type, cible_id) {
  const a = (ctx && ctx.admin) || {};
  await alerter({ type: 'modification_sensible', gravite: 'faible', titre: `Modification sensible : ${action}`, details: { action, cible_type, cible_id, par: a.email }, type_compte: 'admin', compte_id: a.id || null, email: a.email || null, ip: null, dedupMin: 1 });
  if (!a.id) return;
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM audit_journal WHERE admin_id = $1 AND resultat = 'succes' AND cree_le > now() - interval '10 minutes'`, [a.id]);
  if (r.rows[0] && r.rows[0].n >= SEUIL_RAFALE) {
    await alerter({ type: 'comportement_anormal', gravite: 'haute', titre: `Rythme anormal d'actions par ${a.email} : ${r.rows[0].n} en 10 minutes`, details: { actions: r.rows[0].n }, type_compte: 'admin', compte_id: a.id, email: a.email, dedupMin: 30 });
  }
}

module.exports = { alerter, enregistrerConnexion, connexionInhabituelle, accesRefuse, modificationSensible, navigateur, SEUIL_ECHECS };
