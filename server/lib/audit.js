'use strict';
// Journal d'audit centralisé (ajout seulement : un déclencheur PostgreSQL refuse toute modification ou suppression).
const db = require('./db');

const SECRET = /(mot_de_passe|password|passwd|secret|token|jeton|hash|cle|key|code_recuperation|authorization)/i;
const MAX_PROFONDEUR = 4;

// Aucun secret ne doit jamais atterrir dans le journal : les valeurs sensibles sont masquées avant l'écriture
function nettoyer(v, profondeur = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 500 ? v.slice(0, 500) + '…' : v;
  if (typeof v !== 'object') return v;
  if (profondeur >= MAX_PROFONDEUR) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => nettoyer(x, profondeur + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = SECRET.test(k) ? '[masqué]' : nettoyer(x, profondeur + 1);
  return out;
}

// Contexte de l'acteur : soit ctx.admin (requête authentifiée), soit un objet { id, email, role }
function acteur(ctx) {
  const a = (ctx && ctx.admin) || {};
  return { id: a.id || null, email: a.email || null, role: a.role || null, ip: (ctx && ctx.ip) || null };
}

// Actions « sensibles » : elles déclenchent une alerte de sécurité visible de l'administrateur sécurité
const SENSIBLES = new Set([
  'admin.creer', 'admin.modifier', 'admin.suspendre', 'admin.reactiver', 'admin.mdp_reinitialise', 'admin.sessions_fermees',
  'role.permissions_modifiees', 'parametres.modifies', 'agregateur.cles_modifiees', 'agregateur.active', 'agregateur.desactive',
  'demande.approuvee', 'demande.refusee', 'abonnement.offert', 'abonnement.statut', 'entreprise.statut', 'acces.mdp_reinitialise', 'acces.code_regenere',
  'sauvegarde.export', 'tarif.modifie',
]);

// Écrit une entrée. Ne fait jamais échouer l'opération métier : en cas d'erreur d'écriture, on le dit dans les logs.
async function journaliser(ctx, action, { cible_type = null, cible_id = null, details = null, resultat = 'succes', q = null } = {}) {
  const a = acteur(ctx);
  if (ctx && typeof ctx === 'object') ctx.audite = true;
  const sql = `INSERT INTO audit_journal (admin_id, admin_email, role, action, cible_type, cible_id, details, ip, resultat)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`;
  const params = [a.id, a.email, a.role, action, cible_type, cible_id === null || cible_id === undefined ? null : String(cible_id), details ? JSON.stringify(nettoyer(details)) : null, a.ip, resultat];
  try {
    await (q ? q(sql, params) : db.query(sql, params));
  } catch (e) {
    console.error(`Journal d'audit : écriture impossible (${action}) :`, e.message);
    if (q) throw e; // dans une transaction, l'audit fait partie de l'opération
    return;
  }
  if (resultat === 'succes' && SENSIBLES.has(action) && !q) {
    try { await require('./securite').modificationSensible(ctx, action, cible_type, cible_id); } catch (e) { console.error('Alerte sécurité impossible :', e.message); }
  }
}

module.exports = { journaliser, nettoyer, SENSIBLES, acteur };
