'use strict';
// Contrôle d'accès par rôles (RBAC) pour les trois espaces d'administration.
// - SUPER_ADMIN possède toujours toutes les permissions (calculé ici, jamais lu en base : il garde le contrôle final).
// - Les autres rôles reçoivent les permissions de admin_role_permissions, MAIS seulement celles de leur propre domaine :
//   un administrateur de sécurité ne peut jamais détenir une permission financière (même si la base était modifiée à la main).
const db = require('./db');
const { HttpError } = require('./http');

const ROLES = {
  SUPER_ADMIN: { espace: 'super', domaine: null, libelle: 'Super administrateur' },
  FINANCE_ADMIN: { espace: 'finance', domaine: 'finance', libelle: 'Administrateur financier et commercial' },
  SECURITY_ADMIN: { espace: 'security', domaine: 'securite', libelle: 'Administrateur de sécurité informatique' },
};
const ESPACES = Object.fromEntries(Object.entries(ROLES).map(([r, v]) => [v.espace, r]));

// [code, domaine, libellé]
const CATALOGUE = [
  ['super.dashboard', 'super', 'Tableau de bord général'],
  ['admins.gerer', 'super', 'Créer, modifier et suspendre les comptes administrateurs'],
  ['permissions.gerer', 'super', 'Gérer les rôles et les permissions'],
  ['demandes.valider', 'super', 'Valider ou refuser les demandes exceptionnelles et opérations sensibles'],
  ['entreprises.gerer', 'super', 'Gérer les entreprises clientes (statut, accès, remise à zéro)'],
  ['abonnements.gerer', 'super', 'Offrir des jours, suspendre ou réactiver un abonnement'],
  ['parametres.lire', 'super', 'Consulter les paramètres généraux'],
  ['parametres.ecrire', 'super', 'Modifier les paramètres généraux et les tarifs'],
  ['sponsors.gerer', 'super', 'Gérer les sponsors et leurs offres'],
  ['systeme.gerer', 'super', 'Sauvegardes et paramètres système'],
  ['journal.lire', 'super', 'Consulter toute l\'activité de la plateforme'],
  ['finance.dashboard', 'finance', 'Tableau de bord financier'],
  ['finance.entreprises.lire', 'finance', 'Consulter les entreprises clientes (lecture)'],
  ['finance.paiements.lire', 'finance', 'Consulter les paiements et transactions'],
  ['finance.agregateurs.lire', 'finance', 'Consulter les agrégateurs de paiement'],
  ['finance.agregateurs.gerer', 'finance', 'Configurer les agrégateurs (URL, clés)'],
  ['finance.abonnements.lire', 'finance', 'Consulter les abonnements'],
  ['finance.factures', 'finance', 'Générer factures et reçus'],
  ['finance.relances', 'finance', 'Gérer les relances d\'abonnement'],
  ['finance.difficultes', 'finance', 'Suivre les entreprises en difficulté'],
  ['finance.depenses', 'finance', 'Suivre les dépenses et préparer les budgets'],
  ['finance.tarifs', 'finance', 'Proposer des tarifs'],
  ['finance.rapports', 'finance', 'Rapports de rentabilité'],
  ['finance.departs', 'finance', 'Départs d\'agents et résiliations d\'entreprises'],
  ['securite.dashboard', 'securite', 'Tableau de bord de sécurité'],
  ['securite.comptes.lire', 'securite', 'Consulter les comptes et les rôles attribués'],
  ['securite.sessions.lire', 'securite', 'Consulter les connexions et sessions actives'],
  ['securite.sessions.revoquer', 'securite', 'Révoquer des sessions'],
  ['securite.comptes.bloquer', 'securite', 'Bloquer temporairement un compte menacé'],
  ['securite.journaux.lire', 'securite', 'Consulter les journaux de connexion et d\'audit (lecture seule)'],
  ['securite.alertes.gerer', 'securite', 'Traiter les alertes et incidents'],
  ['securite.rapports.lire', 'securite', 'Rapports de sécurité'],
  ['securite.signaler', 'securite', 'Signaler un compte suspect au Super admin'],
];
const CODES = new Set(CATALOGUE.map((c) => c[0]));
const DOMAINE = Object.fromEntries(CATALOGUE.map((c) => [c[0], c[1]]));

// Permissions accordées par défaut aux rôles non super (toutes celles de leur domaine)
const parDefaut = (role) => (ROLES[role] && ROLES[role].domaine ? CATALOGUE.filter((c) => c[1] === ROLES[role].domaine).map((c) => c[0]) : CATALOGUE.map((c) => c[0]));

// Une permission peut-elle être détenue par ce rôle ?
const autorisee = (role, code) => CODES.has(code) && (role === 'SUPER_ADMIN' || DOMAINE[code] === ROLES[role]?.domaine);

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
// Instructions SQL ajoutées au schéma (ajouts seuls : ne retire jamais une permission déjà accordée ou retirée par le Super admin)
function seedSql() {
  const lignes = [];
  lignes.push(`INSERT INTO admin_permissions (code, libelle, domaine) VALUES ${CATALOGUE.map(([c, d, l]) => `(${lit(c)}, ${lit(l)}, ${lit(d)})`).join(', ')} ON CONFLICT (code) DO UPDATE SET libelle = EXCLUDED.libelle, domaine = EXCLUDED.domaine;`);
  for (const role of ['FINANCE_ADMIN', 'SECURITY_ADMIN']) {
    // Premier remplissage seulement : si le rôle a déjà des lignes, le Super admin a la main
    lignes.push(`INSERT INTO admin_role_permissions (role, permission) SELECT ${lit(role)}, p FROM unnest(ARRAY[${parDefaut(role).map(lit).join(', ')}]::text[]) AS p WHERE NOT EXISTS (SELECT 1 FROM admin_role_permissions WHERE role = ${lit(role)}) ON CONFLICT DO NOTHING;`);
  }
  return lignes.join('\n');
}

const TTL = 10000;
const cache = new Map();
const invalider = () => cache.clear();

async function permissionsDe(role) {
  if (role === 'SUPER_ADMIN') return new Set(CODES);
  if (!ROLES[role]) return new Set();
  const c = cache.get(role);
  if (c && Date.now() - c.at < TTL) return c.set;
  const { rows } = await db.query('SELECT permission FROM admin_role_permissions WHERE role = $1', [role]);
  const set = new Set(rows.map((r) => r.permission).filter((p) => autorisee(role, p)));
  cache.set(role, { at: Date.now(), set });
  return set;
}

// Middleware : authentifie l'administrateur puis exige TOUTES les permissions listées. Tout refus est journalisé.
function exiger(...codes) {
  return async (ctx) => {
    const { authAdmin } = require('./auth');
    await authAdmin(ctx);
    const set = await permissionsDe(ctx.admin.role);
    ctx.admin.permissions = set;
    // Mot de passe provisoire : tant qu'il n'est pas remplacé, seules les routes de profil sont accessibles
    if (ctx.admin.mdp_temporaire) throw new HttpError(403, 'Choisissez d\'abord un nouveau mot de passe (Mon compte).', { code: 'MDP_TEMPORAIRE' });
    const manque = codes.find((c) => !set.has(c));
    if (manque) {
      try { await require('./securite').accesRefuse(ctx, manque); } catch (e) { console.error('Journalisation du refus impossible :', e.message); }
      throw new HttpError(403, 'Vous n\'avez pas la permission d\'effectuer cette action.');
    }
  };
}

// Accès à l'espace lui-même, sans permission particulière (profil, notifications…)
const connecte = async (ctx) => { await require('./auth').authAdmin(ctx); };

module.exports = { ROLES, ESPACES, CATALOGUE, CODES, DOMAINE, autorisee, parDefaut, seedSql, permissionsDe, exiger, connecte, invalider };
