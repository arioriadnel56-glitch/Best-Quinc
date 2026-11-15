'use strict';
// Gouvernance à trois administrateurs : rôles, permissions vérifiées côté serveur, sessions, audit, demandes, agrégateurs, relances.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, setHandler, calls } = require('./helpers');
const jwt = require('../server/lib/jwt');
const rbac = require('../server/lib/rbac');
const audit = require('../server/lib/audit');
const settings = require('../server/lib/settings');
const payments = require('../server/payments');
const { env } = require('../server/lib/env');
const { hashPassword } = require('../server/lib/password');
const { router } = require('../server');

const SECRET = process.env.JWT_SECRET;
const SID = '3f0c7e0e-0000-4000-8000-000000000001';
const tok = (sub = 1) => jwt.sign({ sub, typ: 'admin', sid: SID }, SECRET);
const H = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const SUPER = 'SUPER_ADMIN'; const FIN = 'FINANCE_ADMIN'; const SEC = 'SECURITY_ADMIN';

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });
test.beforeEach(() => { calls.length = 0; rbac.invalider(); settings.invalidate(); });

// Simule la base : session valide de l'administrateur `role`, permissions par défaut des rôles, puis le gestionnaire `extra`
function joue(role, { extra, session = {} } = {}) {
  setHandler(async (sql, params) => {
    if (sql.includes('JOIN admin_sessions')) return { rows: [{ id: 1, nom_complet: 'Test', email: `${role.toLowerCase()}@t.fr`, actif: true, role, sid: SID, mdp_temporaire: false, bloque_jusqua: null, derniere_activite: new Date(), ...session }] };
    if (sql.includes('FROM admin_role_permissions WHERE role')) return { rows: rbac.parDefaut(params[0]).map((permission) => ({ permission })) };
    if (extra) { const r = await extra(sql, params); if (r) return r; }
    return { rows: [], rowCount: 0 };
  });
}
const appel = (methode, chemin, corps, jeton = tok()) => fetch(srv.base + chemin, { method: methode, headers: H(jeton), body: corps === undefined ? undefined : JSON.stringify(corps) });
const ecritures = (re) => calls.filter((c) => re.test(c.sql));

// ---------------------------------------------------------------- RBAC
test('RBAC : un domaine ne peut jamais détenir les permissions d\'un autre (sécurité ≠ finance)', () => {
  assert.equal(rbac.autorisee(SEC, 'finance.dashboard'), false);
  assert.equal(rbac.autorisee(SEC, 'parametres.ecrire'), false);
  assert.equal(rbac.autorisee(SEC, 'abonnements.gerer'), false);
  assert.equal(rbac.autorisee(FIN, 'securite.sessions.revoquer'), false);
  assert.equal(rbac.autorisee(FIN, 'demandes.valider'), false);
  assert.equal(rbac.autorisee(SEC, 'securite.alertes.gerer'), true);
  assert.equal(rbac.autorisee(FIN, 'finance.depenses'), true);
  assert.equal(rbac.autorisee(SUPER, 'demandes.valider'), true);
  assert.equal(rbac.autorisee(SUPER, 'permission.inconnue'), false);
});

test('permissions SQL : catalogue complet, valeurs par défaut sans croisement de domaines', () => {
  const sql = rbac.seedSql();
  for (const [code] of rbac.CATALOGUE) assert.ok(sql.includes(`'${code}'`), code);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TRIGGER audit_journal_no_change BEFORE UPDATE OR DELETE ON audit_journal/);
  assert.match(schema, /CREATE TRIGGER audit_journal_no_truncate BEFORE TRUNCATE ON audit_journal/);
  assert.ok(rbac.parDefaut(SEC).every((p) => p.startsWith('securite.')));
  assert.ok(rbac.parDefaut(FIN).every((p) => p.startsWith('finance.')));
});

test('l\'administrateur de sécurité est refusé partout côté finance, abonnements, paramètres et administration (et le refus est journalisé)', async () => {
  joue(SEC);
  for (const [m, p, b] of [
    ['GET', '/api/admin/finance/dashboard'], ['GET', '/api/admin/paiements'], ['GET', '/api/admin/finance/agregateurs'], ['GET', '/api/admin/parametres'],
    ['PUT', '/api/admin/parametres', { valeurs: { abonnement_prix: 4000 } }], ['POST', '/api/admin/entreprises/5/offrir', { jours: 30 }], ['PUT', '/api/admin/super/abonnements/3/statut', { statut: 'suspendu' }],
    ['GET', '/api/admin/super/admins'], ['PUT', '/api/admin/super/roles/SECURITY_ADMIN/permissions', { permissions: [] }], ['POST', '/api/admin/entreprises/5/utilisateurs/3/reinitialiser', {}],
    ['POST', '/api/admin/super/demandes/1/decision', { decision: 'approuver' }], ['POST', '/api/admin/super/sauvegardes', {}], ['GET', '/api/admin/entreprises'],
  ]) {
    const r = await appel(m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  const refus = ecritures(/INSERT INTO audit_journal/).filter((c) => c.params[3] === 'acces.refuse');
  assert.ok(refus.length >= 10);
  assert.equal(refus[0].params[8], 'refuse');
  assert.ok(ecritures(/INSERT INTO security_alerts/).length >= 1);
});

test('l\'administrateur financier ne touche ni à la sécurité, ni aux décisions du Super admin, ni aux paramètres', async () => {
  joue(FIN);
  for (const [m, p, b] of [
    ['GET', '/api/admin/securite/alertes'], ['POST', '/api/admin/securite/sessions/3f0c7e0e-0000-4000-8000-000000000009/revoquer', {}], ['GET', '/api/admin/securite/audit'],
    ['POST', '/api/admin/super/demandes/1/decision', { decision: 'approuver' }], ['PUT', '/api/admin/parametres', { valeurs: { abonnement_prix: 100 } }], ['GET', '/api/admin/super/activite'],
    ['POST', '/api/admin/entreprises/5/offrir', { jours: 30 }], ['PUT', '/api/admin/entreprises/5/statut', { statut: 'suspendu' }],
  ]) assert.equal((await appel(m, p, b)).status, 403, `${m} ${p}`);
  assert.equal((await appel('GET', '/api/admin/finance/relances')).status, 200);
  assert.equal((await appel('GET', '/api/admin/finance/dashboard')).status, 200);
});

test('le Super admin accède à tous les espaces', async () => {
  joue(SUPER);
  for (const p of ['/api/admin/finance/dashboard', '/api/admin/securite/dashboard', '/api/admin/super/dashboard', '/api/admin/super/admins', '/api/admin/securite/alertes', '/api/admin/finance/relances']) {
    assert.equal((await appel('GET', p)).status, 200, p);
  }
});

test('sans jeton, avec un jeton d\'entreprise, ou sans session : 401 partout', async () => {
  joue(SUPER);
  const user = jwt.sign({ sub: 3, typ: 'user' }, SECRET);
  const sansSid = jwt.sign({ sub: 1, typ: 'admin' }, SECRET);
  for (const p of ['/api/admin/me', '/api/admin/finance/dashboard', '/api/admin/securite/dashboard', '/api/admin/super/admins']) {
    assert.equal((await fetch(srv.base + p)).status, 401, p);
    assert.equal((await appel('GET', p, undefined, user)).status, 401, p);
    assert.equal((await appel('GET', p, undefined, sansSid)).status, 401, p);
  }
  // Session révoquée côté serveur : le jeton, pourtant valide, ne marche plus
  setHandler(async () => ({ rows: [] }));
  assert.equal((await appel('GET', '/api/admin/me')).status, 401);
});

test('mot de passe provisoire : seul le profil est accessible tant qu\'il n\'est pas remplacé', async () => {
  joue(FIN, { session: { mdp_temporaire: true } });
  const r = await appel('GET', '/api/admin/finance/dashboard');
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'MDP_TEMPORAIRE');
  const me = await appel('GET', '/api/admin/me');
  assert.equal(me.status, 200);
  assert.equal((await me.json()).admin.mdp_temporaire, true);
});

test('/me renvoie le rôle, l\'espace et les permissions', async () => {
  joue(SEC);
  const { admin } = await (await appel('GET', '/api/admin/me')).json();
  assert.equal(admin.role, SEC); assert.equal(admin.espace, 'security');
  assert.ok(admin.permissions.includes('securite.dashboard'));
  assert.ok(!admin.permissions.some((p) => p.startsWith('finance.')));
});

// ---------------------------------------------------------------- Connexion et redirection
test('connexion : le serveur indique l\'espace du rôle, ouvre une session et journalise', async () => {
  const hash = await hashPassword('un-mot-de-passe-long');
  for (const [role, espace] of [[SUPER, 'super'], [FIN, 'finance'], [SEC, 'security']]) {
    calls.length = 0;
    setHandler(async (sql) => (sql.includes('FROM admins_plateforme WHERE email') ? { rows: [{ id: 7, nom_complet: 'X', email: `${espace}@t.fr`, mot_de_passe_hash: hash, actif: true, role, mdp_temporaire: false }] } : { rows: [] }));
    const r = await fetch(`${srv.base}/api/admin/login`, { method: 'POST', headers: H(''), body: JSON.stringify({ email: `${espace}@t.fr`, mot_de_passe: 'un-mot-de-passe-long' }) });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.redirection, `/admin/${espace}`); assert.equal(d.espace, espace); assert.equal(d.role, role);
    const payload = jwt.verify(d.token, SECRET);
    assert.equal(payload.typ, 'admin'); assert.match(payload.sid, /^[0-9a-f-]{36}$/);
    assert.equal(ecritures(/INSERT INTO admin_sessions/).length, 1);
    assert.equal(ecritures(/INSERT INTO connexions_journal/).filter((c) => c.params[4] === 'connexion').length, 1);
  }
});

test('connexion refusée : mauvais mot de passe, compte suspendu ou bloqué = 401 neutre, échec journalisé, aucune session', async () => {
  const hash = await hashPassword('un-mot-de-passe-long');
  const essaie = async (row, mdp = 'un-mot-de-passe-long') => {
    calls.length = 0;
    setHandler(async (sql) => (sql.includes('FROM admins_plateforme WHERE email') ? { rows: row ? [{ id: 7, email: 'a@t.fr', mot_de_passe_hash: hash, actif: true, role: FIN, ...row }] : [] } : { rows: [] }));
    const r = await fetch(`${srv.base}/api/admin/login`, { method: 'POST', headers: H(''), body: JSON.stringify({ email: 'a@t.fr', mot_de_passe: mdp }) });
    assert.equal(r.status, 401);
    assert.equal(ecritures(/INSERT INTO admin_sessions/).length, 0);
    return ecritures(/INSERT INTO connexions_journal/).map((c) => [c.params[4], c.params[5]]);
  };
  assert.deepEqual(await essaie({}, 'faux-mot-de-passe'), [['echec', 'mot_de_passe']]);
  assert.deepEqual(await essaie(null), [['echec', 'compte_inconnu']]);
  assert.deepEqual(await essaie({ actif: false }), [['echec', 'compte_suspendu']]);
  assert.deepEqual(await essaie({ bloque_jusqua: new Date(Date.now() + 3600000) }), [['echec', 'compte_bloque']]);
  assert.deepEqual(await essaie({ role: 'ROLE_BIDON' }), [['echec', 'role_inconnu']]);
});

test('déconnexion : la session est révoquée côté serveur', async () => {
  joue(FIN);
  assert.equal((await appel('POST', '/api/admin/logout', {})).status, 200);
  const maj = ecritures(/UPDATE admin_sessions SET revoquee_le/);
  assert.equal(maj.length, 1); assert.equal(maj[0].params[0], SID);
});

test('les quatre adresses d\'administration servent la page ; une autre adresse est introuvable', async () => {
  for (const p of ['/admin', '/admin/super', '/admin/finance', '/admin/security']) {
    const r = await fetch(srv.base + p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /admin-super\.js[\s\S]*admin-finance\.js[\s\S]*admin-securite\.js[\s\S]*admin\.js/);
  }
  assert.equal((await fetch(srv.base + '/admin/pirate')).status, 404);
});

// ---------------------------------------------------------------- Administrateurs, rôles, permissions
test('permissions : un rôle ne reçoit que des permissions de son domaine ; le Super admin ne peut pas être amputé', async () => {
  joue(SUPER);
  assert.equal((await appel('PUT', '/api/admin/super/roles/SECURITY_ADMIN/permissions', { permissions: ['securite.dashboard', 'finance.dashboard'] })).status, 400);
  assert.equal((await appel('PUT', '/api/admin/super/roles/FINANCE_ADMIN/permissions', { permissions: ['parametres.ecrire'] })).status, 400);
  assert.equal((await appel('PUT', '/api/admin/super/roles/SUPER_ADMIN/permissions', { permissions: [] })).status, 400);
  assert.equal((await appel('PUT', '/api/admin/super/roles/INCONNU/permissions', { permissions: [] })).status, 404);
  assert.equal(ecritures(/INSERT INTO admin_role_permissions/).length, 0);
  const ok = await appel('PUT', '/api/admin/super/roles/SECURITY_ADMIN/permissions', { permissions: ['securite.dashboard', 'securite.journaux.lire'] });
  assert.equal(ok.status, 200);
  assert.equal(ecritures(/INSERT INTO admin_role_permissions/).length, 2);
  assert.ok(ecritures(/INSERT INTO audit_journal/).some((c) => c.params[3] === 'role.permissions_modifiees'));
});

test('retirer une permission à un rôle la refuse immédiatement côté serveur', async () => {
  // Le rôle sécurité n'a plus que « securite.dashboard » : les alertes sont refusées
  setHandler(async (sql, params) => {
    if (sql.includes('JOIN admin_sessions')) return { rows: [{ id: 1, nom_complet: 'S', email: 's@t.fr', actif: true, role: SEC, sid: SID, derniere_activite: new Date() }] };
    if (sql.includes('FROM admin_role_permissions WHERE role')) return { rows: [{ permission: 'securite.dashboard' }] };
    return { rows: [] };
  });
  assert.equal((await appel('GET', '/api/admin/securite/dashboard')).status, 200);
  assert.equal((await appel('GET', '/api/admin/securite/alertes')).status, 403);
});

test('administrateurs : création avec mot de passe provisoire (jamais stocké en clair), rôle validé, journalisée', async () => {
  joue(SUPER, { extra: async (sql) => (sql.includes('INSERT INTO admins_plateforme') ? { rows: [{ id: 9 }] } : null) });
  assert.equal((await appel('POST', '/api/admin/super/admins', { nom_complet: 'Marie', email: 'm@t.fr', role: 'ROLE_BIDON' })).status, 400);
  const r = await appel('POST', '/api/admin/super/admins', { nom_complet: 'Marie Sossou', email: 'M@t.fr', role: FIN });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.match(d.mot_de_passe_temporaire, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
  const ins = ecritures(/INSERT INTO admins_plateforme/)[0];
  assert.ok(ins.params[2].startsWith('scrypt$')); assert.ok(!ins.params.includes(d.mot_de_passe_temporaire));
  assert.equal(ins.params[1], 'm@t.fr'); assert.equal(ins.params[3], FIN);
  assert.ok(ecritures(/INSERT INTO audit_journal/).some((c) => c.params[3] === 'admin.creer'));
});

test('administrateurs : on ne peut ni se suspendre soi-même ni retirer le dernier Super admin', async () => {
  const cible = (id, role) => ({ id, nom_complet: 'N', email: 'n@t.fr', role, actif: true });
  joue(SUPER, { extra: async (sql, params) => {
    if (sql.includes('SELECT id, nom_complet, email, role, actif FROM admins_plateforme WHERE id')) return { rows: [cible(params[0], params[0] === 1 ? SUPER : SUPER)] };
    if (sql.includes("role = 'SUPER_ADMIN' AND actif AND id <>")) return { rows: [{ n: 0 }] };
    return null;
  } });
  assert.equal((await appel('PUT', '/api/admin/super/admins/1', { actif: false })).status, 400);
  const r = await appel('PUT', '/api/admin/super/admins/2', { actif: false });
  assert.equal(r.status, 400); assert.match((await r.json()).erreur, /au moins un Super/);
  assert.equal(ecritures(/UPDATE admins_plateforme SET nom_complet/).length, 0);
});

test('suspendre ou changer le rôle d\'un administrateur ferme ses sessions', async () => {
  joue(SUPER, { extra: async (sql, params) => {
    if (sql.includes('SELECT id, nom_complet, email, role, actif FROM admins_plateforme WHERE id')) return { rows: [{ id: 5, nom_complet: 'F', email: 'f@t.fr', role: FIN, actif: true }] };
    return null;
  } });
  assert.equal((await appel('PUT', '/api/admin/super/admins/5', { actif: false })).status, 200);
  assert.equal(ecritures(/UPDATE admin_sessions SET revoquee_le/).length, 1);
  assert.ok(ecritures(/INSERT INTO audit_journal/).some((c) => c.params[3] === 'admin.suspendre'));
});

// ---------------------------------------------------------------- Demandes
test('prolongation : l\'administrateur financier la propose, SEUL le Super admin la valide (effet appliqué à l\'approbation)', async () => {
  const dossier = { id: 4, entreprise_id: 9, situation: 'Trésorerie bloquée', delai_jours: 20, statut: 'ouverte', demande_id: null, nom: 'Quincaillerie Mawu' };
  joue(FIN, { extra: async (sql) => {
    if (sql.includes('FROM entreprises_difficultes d JOIN entreprises e')) return { rows: [dossier] };
    if (sql.includes('INSERT INTO subscription_management_requests')) return { rows: [{ id: 21, type: 'prolongation', statut: 'en_attente', resume: 'x' }] };
    return null;
  } });
  const r = await appel('POST', '/api/admin/finance/difficultes/4/prolongation', { jours: 20 });
  assert.equal(r.status, 202);
  assert.equal(ecritures(/INSERT INTO abonnements/).length, 0, 'aucun abonnement créé avant la décision');
  assert.equal((await appel('POST', '/api/admin/super/demandes/21/decision', { decision: 'approuver' })).status, 403);

  calls.length = 0;
  joue(SUPER, { extra: async (sql) => {
    if (sql.includes('FROM subscription_management_requests WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 21, type: 'prolongation', statut: 'en_attente', entreprise_id: 9, donnees: { jours: 20 }, resume: 'Prolongation', demandeur_nom: 'F' }] };
    if (sql.includes('SELECT id FROM entreprises WHERE id')) return { rows: [{ id: 9 }] };
    if (sql.includes('INSERT INTO abonnements')) return { rows: [{ date_fin: '2027-02-01' }] };
    return null;
  } });
  const ok = await appel('POST', '/api/admin/super/demandes/21/decision', { decision: 'approuver', note: 'Accord' });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).statut, 'approuvee');
  const abo = ecritures(/INSERT INTO abonnements/);
  assert.equal(abo.length, 1); assert.deepEqual(abo[0].params, [9, 20]);
  assert.ok(ecritures(/UPDATE subscription_management_requests SET statut/).length === 1);
  const actions = ecritures(/INSERT INTO audit_journal/).map((c) => c.params[3]);
  assert.ok(actions.includes('abonnement.offert') && actions.includes('demande.approuvee'));
});

test('demandes : refus sans motif impossible ; une demande déjà traitée ne se rejoue pas ; un refus n\'applique rien', async () => {
  joue(SUPER, { extra: async (sql) => (sql.includes('FOR UPDATE') ? { rows: [{ id: 3, type: 'prolongation', statut: 'approuvee', entreprise_id: 9, donnees: { jours: 5 } }] } : null) });
  assert.equal((await appel('POST', '/api/admin/super/demandes/3/decision', { decision: 'refuser' })).status, 400);
  assert.equal((await appel('POST', '/api/admin/super/demandes/3/decision', { decision: 'approuver' })).status, 409);
  assert.equal((await appel('POST', '/api/admin/super/demandes/3/decision', { decision: 'peut-etre' })).status, 400);
  calls.length = 0;
  joue(SUPER, { extra: async (sql) => (sql.includes('FOR UPDATE') ? { rows: [{ id: 3, type: 'prolongation', statut: 'en_attente', entreprise_id: 9, donnees: { jours: 5 }, resume: 'r' }] } : null) });
  assert.equal((await appel('POST', '/api/admin/super/demandes/3/decision', { decision: 'refuser', note: 'Non' })).status, 200);
  assert.equal(ecritures(/INSERT INTO abonnements/).length, 0);
  assert.ok(ecritures(/INSERT INTO audit_journal/).some((c) => c.params[3] === 'demande.refusee'));
});

test('départ d\'agent : demande préparée avec contrôles ; accès révoqués seulement à l\'approbation ; seul propriétaire = bloquant', async () => {
  const verif = (role, autres) => async (sql) => {
    if (sql.includes('FROM utilisateurs WHERE id = $1 AND entreprise_id')) return { rows: [{ id: 3, nom_complet: 'Koffi', role, actif: true }] };
    if (sql.includes('role = \'proprietaire\' AND actif AND id <>')) return { rows: [{ n: autres }] };
    if (sql.includes('INSERT INTO subscription_management_requests')) return { rows: [{ id: 30, type: 'depart_agent', statut: 'en_attente', resume: 'x' }] };
    return { rows: [{ n: 0 }] };
  };
  joue(FIN, { extra: verif('proprietaire', 0) });
  assert.equal((await appel('POST', '/api/admin/finance/departs/agent', { entreprise_id: 9, utilisateur_id: 3, motif: 'Départ' })).status, 409);
  joue(FIN, { extra: verif('secretaire', 0) });
  const r = await appel('POST', '/api/admin/finance/departs/agent', { entreprise_id: 9, utilisateur_id: 3, motif: 'Départ volontaire' });
  assert.equal(r.status, 202);
  assert.equal(ecritures(/UPDATE utilisateurs SET actif = false/).length, 0);
  calls.length = 0;
  joue(SUPER, { extra: async (sql) => {
    if (sql.includes('FOR UPDATE')) return { rows: [{ id: 30, type: 'depart_agent', statut: 'en_attente', entreprise_id: 9, donnees: { utilisateur_id: 3 }, resume: 'Départ' }] };
    if (sql.includes('UPDATE utilisateurs SET actif = false')) return { rows: [], rowCount: 1 };
    return null;
  } });
  assert.equal((await appel('POST', '/api/admin/super/demandes/30/decision', { decision: 'approuver' })).status, 200);
  const rev = ecritures(/UPDATE utilisateurs SET actif = false/);
  assert.equal(rev.length, 1); assert.deepEqual(rev[0].params, [3, 9]);
  assert.ok(/sessions_revoquees_le = now\(\)/.test(rev[0].sql));
});

test('résiliation : brouillon, puis soumission explicite ; clôture = suspension + conservation, aucune suppression', async () => {
  joue(FIN, { extra: async (sql) => {
    if (sql.includes('FROM entreprises WHERE id')) return { rows: [{ id: 9, nom: 'Mawu', statut: 'actif', cloture_le: null }] };
    if (sql.includes('INSERT INTO subscription_management_requests')) return { rows: [{ id: 40, type: 'resiliation', statut: 'brouillon', resume: 'x' }] };
    return { rows: [{ n: 0, total: 0, fin: null }] };
  } });
  const r = await appel('POST', '/api/admin/finance/departs/entreprise', { entreprise_id: 9, motif: 'Cessation d\'activité' });
  assert.equal(r.status, 201);
  assert.equal(ecritures(/INSERT INTO subscription_management_requests/)[0].params[1], 'brouillon');
  calls.length = 0;
  joue(SUPER, { extra: async (sql) => {
    if (sql.includes('FOR UPDATE')) return { rows: [{ id: 40, type: 'resiliation', statut: 'en_attente', entreprise_id: 9, donnees: {}, resume: 'Résiliation' }] };
    if (sql.includes('UPDATE entreprises SET statut = \'suspendu\', cloture_le')) return { rows: [], rowCount: 1 };
    return null;
  } });
  assert.equal((await appel('POST', '/api/admin/super/demandes/40/decision', { decision: 'approuver' })).status, 200);
  assert.equal(ecritures(/DELETE FROM/).length, 0);
  assert.equal(ecritures(/UPDATE abonnements SET statut = 'resilie'/).length, 1);
  assert.ok(/conservation_jusqua/.test(ecritures(/cloture_le/)[0].sql));
});

// ---------------------------------------------------------------- Finance : agrégateurs, dépenses, relances
test('agrégateurs : les clés ne sont jamais renvoyées en clair, chiffrées à l\'écriture, limitées à leur fournisseur', async () => {
  const stockes = new Map([['kkiapay_private_key', settings.encrypt('tsk_PRIVEE_TRES_SECRETE_123')], ['kkiapay_public_key', 'pk_PUBLIQUE_123']]);
  joue(FIN, { extra: async (sql, params) => {
    if (sql.includes('FROM payment_providers ORDER')) return { rows: [{ code: 'kkiapay', libelle: 'KkiaPay', actif: true }, { code: 'cinetpay', libelle: 'CinetPay', actif: false }] };
    if (sql.includes('INSERT INTO plateforme_parametres')) { stockes.set(params[0], params[1]); return { rows: [] }; }
    if (sql.includes('FROM plateforme_parametres')) return { rows: [...stockes].map(([cle, valeur]) => ({ cle, valeur })) };
    return null;
  } });
  const txt = await (await appel('GET', '/api/admin/finance/agregateurs')).text();
  assert.ok(!txt.includes('TRES_SECRETE')); assert.match(txt, /••••/); assert.ok(txt.includes('pk_PUBLIQUE_123'));
  assert.equal((await appel('PUT', '/api/admin/finance/agregateurs/kkiapay/cles', { valeurs: { fedapay_secret_key: 'sk_live_123456789' } })).status, 400);
  assert.equal((await appel('PUT', '/api/admin/finance/agregateurs/cinetpay/cles', { valeurs: { abonnement_prix: 1 } })).status, 400);
  const r = await appel('PUT', '/api/admin/finance/agregateurs/cinetpay/cles', { valeurs: { cinetpay_api_key: 'cle-cinetpay-0123456789' } });
  assert.equal(r.status, 200);
  assert.ok(String(stockes.get('cinetpay_api_key')).startsWith('enc1:'));
  const journal = JSON.stringify(ecritures(/INSERT INTO audit_journal/).map((c) => c.params));
  assert.ok(!journal.includes('cle-cinetpay-0123456789'));
});

test('agrégateurs : l\'administrateur financier dépose une demande d\'activation ; CinetPay non activable (adaptateur à venir)', async () => {
  joue(FIN, { extra: async (sql) => (sql.includes('INSERT INTO subscription_management_requests') ? { rows: [{ id: 50, type: 'agregateur', statut: 'en_attente', resume: 'x' }] } : null) });
  const r = await appel('POST', '/api/admin/finance/agregateurs/fedapay/activation', { actif: false });
  assert.equal(r.status, 202); assert.equal((await r.json()).applique, false);
  assert.equal(ecritures(/UPDATE payment_providers SET actif/).length, 0);
  assert.equal((await appel('POST', '/api/admin/finance/agregateurs/cinetpay/activation', { actif: true })).status, 400);
  calls.length = 0;
  joue(SUPER);
  assert.equal((await (await appel('POST', '/api/admin/finance/agregateurs/fedapay/activation', { actif: false })).json()).applique, true);
  assert.equal(ecritures(/UPDATE payment_providers SET actif/).length, 1);
});

test('un fournisseur désactivé n\'est plus proposé, mais la confirmation d\'un paiement déjà engagé reste possible', async () => {
  const stockes = new Map([['kkiapay_public_key', 'pk_123456'], ['kkiapay_private_key', settings.encrypt('tpk_123456')]]);
  setHandler(async (sql) => {
    if (sql.includes('FROM payment_providers')) return { rows: [{ code: 'kkiapay', actif: false }] };
    if (sql.includes('FROM plateforme_parametres')) return { rows: [...stockes].map(([cle, valeur]) => ({ cle, valeur })) };
    return { rows: [] };
  });
  assert.equal((await payments.enabled()).list.length, 0);
  assert.equal(await payments.get('kkiapay'), null);
  assert.ok(await payments.get('kkiapay', true));
});

test('dépenses : un engagement important attend le Super admin ; une petite dépense est validée tout de suite', async () => {
  const extra = async (sql) => {
    if (sql.includes('INSERT INTO hosting_expenses')) return { rows: [{ id: 4 }] };
    if (sql.includes('INSERT INTO subscription_management_requests')) return { rows: [{ id: 11, type: 'engagement', statut: 'en_attente', resume: 'x' }] };
    return null;
  };
  joue(FIN, { extra });
  let r = await (await appel('POST', '/api/admin/finance/depenses', { categorie: 'serveur', libelle: 'Serveur dédié', montant: 50000, periodicite: 'mensuelle' })).json();
  assert.equal(r.statut, 'en_attente'); assert.equal(ecritures(/INSERT INTO hosting_expenses/)[0].params[6], 'en_attente');
  assert.equal(ecritures(/INSERT INTO subscription_management_requests/).length, 1);
  calls.length = 0;
  r = await (await appel('POST', '/api/admin/finance/depenses', { categorie: 'domaine', libelle: 'Nom de domaine', montant: 12000, periodicite: 'annuelle' })).json();
  assert.equal(r.statut, 'validee'); assert.equal(ecritures(/INSERT INTO subscription_management_requests/).length, 0);
  assert.equal((await appel('POST', '/api/admin/finance/depenses', { categorie: 'bidon', libelle: 'x', montant: 5 })).status, 400);
  assert.equal((await appel('POST', '/api/admin/finance/depenses', { categorie: 'autre', libelle: 'ok', montant: -5 })).status, 400);
});

test('tarifs : seule une PROPOSITION est créée ; les prix ne changent qu\'à l\'approbation par le Super admin', async () => {
  joue(FIN, { extra: async (sql) => (sql.includes('INSERT INTO subscription_management_requests') ? { rows: [{ id: 60, type: 'tarif', statut: 'en_attente', resume: 'x' }] } : null) });
  assert.equal((await appel('POST', '/api/admin/finance/tarifs/proposer', { plan: 'mensuel', prix: 6000, jours: 30, motif: 'Hausse des coûts d\'hébergement' })).status, 202);
  assert.equal((await appel('POST', '/api/admin/finance/tarifs/proposer', { plan: 'mensuel', prix: 5, motif: 'trop bas ?' })).status, 400);
  assert.equal(ecritures(/plateforme_parametres/).length, 0);
  calls.length = 0;
  joue(SUPER, { extra: async (sql) => (sql.includes('FOR UPDATE') ? { rows: [{ id: 60, type: 'tarif', statut: 'en_attente', donnees: { plan: 'mensuel', prix: 6000, jours: 30 }, resume: 'Tarif' }] } : null) });
  assert.equal((await appel('POST', '/api/admin/super/demandes/60/decision', { decision: 'approuver' })).status, 200);
  const ecr = ecritures(/INSERT INTO plateforme_parametres/);
  assert.deepEqual(ecr.map((c) => c.params), [['abonnement_prix', '6000'], ['abonnement_jours', '30']]);
});

test('relances : création, planification, réponse ; e-mail non configuré = programmée mais jamais « envoyée » à tort', async () => {
  env.email.apiKey = ''; env.email.from = '';
  joue(FIN, { extra: async (sql) => {
    if (sql.includes('FROM entreprises e WHERE id')) return { rows: [{ nom: 'Mawu', slug: 'mawu', email: 'm@m.fr', date_fin: '2026-12-01' }] };
    if (sql.includes('INSERT INTO subscription_reminders')) return { rows: [{ id: 70, entreprise_id: 9, type: 'avant_expiration', canal: 'email' }] };
    return null;
  } });
  const r = await appel('POST', '/api/admin/finance/relances', { entreprise_id: 9, canal: 'email', type: 'avant_expiration' });
  assert.equal(r.status, 201); assert.equal((await r.json()).envoi, null);
  assert.equal(ecritures(/SET statut = 'en_cours'/).length, 0);
  assert.match(ecritures(/INSERT INTO subscription_reminders/)[0].params[4], /expire le 01\/12\/2026/);
  assert.equal((await appel('POST', '/api/admin/finance/relances', { entreprise_id: 9, canal: 'sms' })).status, 400);
  const t = await (await appel('POST', '/api/admin/finance/relances/traiter', {})).json();
  assert.equal(t.envoyees, 0); assert.match(t.note, /non configuré/);
});

test('planificateur externe : /api/cron/relances exige le secret', async () => {
  const ancien = env.cronSecret;
  try {
    env.cronSecret = '';
    assert.equal((await fetch(`${srv.base}/api/cron/relances`, { method: 'POST', headers: { 'x-cron-secret': '' } })).status, 401);
    env.cronSecret = 's'.repeat(30);
    setHandler(async () => ({ rows: [] }));
    assert.equal((await fetch(`${srv.base}/api/cron/relances`, { method: 'POST', headers: { 'x-cron-secret': 'mauvais' } })).status, 401);
    assert.equal((await fetch(`${srv.base}/api/cron/relances`, { method: 'POST', headers: { 'x-cron-secret': 's'.repeat(30) } })).status, 200);
  } finally { env.cronSecret = ancien; }
});

test('factures et reçus : PDF valide, reçu refusé tant que le paiement n\'est pas réussi', async () => {
  const p = (statut) => ({ id: 12, agregateur: 'kkiapay', plan: 'mensuel', jours: 30, reference_transaction: 'TX1', montant: 5000, statut, cree_le: '2026-11-01', confirme_le: '2026-11-01', nom: 'Mawu', email: 'm@m.fr', telephone: '97000000', ifu: null });
  joue(FIN, { extra: async (sql) => (sql.includes('FROM paiements p JOIN entreprises e') ? { rows: [p('reussi')] } : null) });
  const r = await appel('GET', '/api/admin/finance/paiements/12/document?type=recu');
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /recu-REC-000012\.pdf/);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  joue(FIN, { extra: async (sql) => (sql.includes('FROM paiements p JOIN entreprises e') ? { rows: [p('en_attente')] } : null) });
  assert.equal((await appel('GET', '/api/admin/finance/paiements/12/document?type=recu')).status, 400);
  assert.equal((await appel('GET', '/api/admin/finance/paiements/12/document?type=facture')).status, 200);
  joue(SEC);
  assert.equal((await appel('GET', '/api/admin/finance/paiements/12/document')).status, 403);
});

// ---------------------------------------------------------------- Sécurité
test('sécurité : les sessions du Super admin ne sont pas révocables par l\'administrateur de sécurité', async () => {
  const autre = '3f0c7e0e-0000-4000-8000-000000000009';
  joue(SEC, { extra: async (sql) => (sql.includes('FROM admin_sessions s JOIN admins_plateforme a') ? { rows: [{ id: autre, admin_id: 2, role: SUPER }] } : null) });
  assert.equal((await appel('POST', `/api/admin/securite/sessions/${autre}/revoquer`, {})).status, 403);
  assert.equal(ecritures(/UPDATE admin_sessions SET revoquee_le/).length, 0);
  joue(SEC, { extra: async (sql) => (sql.includes('FROM admin_sessions s JOIN admins_plateforme a') ? { rows: [{ id: autre, admin_id: 2, role: FIN }] } : null) });
  assert.equal((await appel('POST', `/api/admin/securite/sessions/${autre}/revoquer`, {})).status, 200);
  assert.equal(ecritures(/UPDATE admin_sessions SET revoquee_le/).length, 1);
});

test('sécurité : blocage temporaire d\'un utilisateur (sessions fermées), jamais d\'un Super admin ni de soi-même', async () => {
  joue(SEC, { extra: async (sql, params) => {
    if (sql.includes('FROM utilisateurs WHERE id')) return { rows: [{ id: params[0], email: 'u@e.fr', est_super: 0 }] };
    if (sql.includes('FROM admins_plateforme WHERE id')) return { rows: [{ id: params[0], email: 'a@e.fr', est_super: params[0] === 2 ? 1 : 0 }] };
    return null;
  } });
  assert.equal((await appel('POST', '/api/admin/securite/comptes/utilisateur/3/bloquer', { minutes: 5, motif: 'Menace' })).status, 400, 'durée minimale 15 min');
  assert.equal((await appel('POST', '/api/admin/securite/comptes/utilisateur/3/bloquer', { minutes: 60 })).status, 400, 'motif obligatoire');
  assert.equal((await appel('POST', '/api/admin/securite/comptes/utilisateur/3/bloquer', { minutes: 60, motif: 'Tentatives suspectes' })).status, 200);
  assert.equal(ecritures(/UPDATE utilisateurs SET bloque_jusqua/).length, 1);
  assert.equal(ecritures(/UPDATE utilisateurs SET sessions_revoquees_le/).length, 1);
  assert.equal((await appel('POST', '/api/admin/securite/comptes/admin/2/bloquer', { minutes: 60, motif: 'Test' })).status, 403);
  assert.equal((await appel('POST', '/api/admin/securite/comptes/admin/1/bloquer', { minutes: 60, motif: 'Test' })).status, 403);
  assert.ok(ecritures(/INSERT INTO audit_journal/).some((c) => c.params[3] === 'securite.compte_bloque'));
});

test('sécurité : signalement d\'un compte suspect au Super admin', async () => {
  joue(SEC, { extra: async (sql, params) => {
    if (sql.includes('FROM utilisateurs WHERE id')) return { rows: [{ id: 3, email: 'u@e.fr', est_super: 0 }] };
    if (sql.includes('INSERT INTO security_alerts')) return { rows: [{ id: 5 }] };
    return null;
  } });
  const r = await appel('POST', '/api/admin/securite/comptes/utilisateur/3/signaler', { motif: 'Connexions depuis plusieurs pays' });
  assert.equal(r.status, 201);
  assert.match(ecritures(/INSERT INTO security_alerts/)[0].sql, /signalee_super\) VALUES \('compte_suspect', 'haute'/);
});

test('l\'administrateur de sécurité n\'a AUCUNE route pour lire un mot de passe, modifier une donnée financière ou supprimer un journal', async () => {
  const securite = router.routes.filter((r) => r.regex.source.includes('api\\/admin\\/securite'));
  assert.ok(securite.length > 10);
  assert.ok(!router.routes.some((r) => r.method === 'DELETE' && /api\\\/admin\\\/(securite|super|finance)/.test(r.regex.source)), 'aucune route DELETE dans les trois espaces');
  const audit = router.routes.filter((r) => /audit|activite|connexions/.test(r.regex.source) && /admin/.test(r.regex.source));
  assert.ok(audit.every((r) => r.method === 'GET'), 'journaux en lecture seule');
  // aucune requête SQL de lecture de mot de passe dans les routes de sécurité
  const code = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin-securite.js'), 'utf8');
  assert.ok(!/mot_de_passe_hash|code_recuperation|plateforme_parametres|FROM paiements|FROM abonnements/.test(code));
});

test('détection : tentatives répétées → alerte (une seule), connexion depuis une adresse inconnue → alerte', async () => {
  const securite = require('../server/lib/securite');
  setHandler(async (sql) => {
    if (sql.includes("evenement = 'echec' AND email")) return { rows: [{ n: 7 }] };
    if (sql.includes('COUNT(DISTINCT email)')) return { rows: [{ comptes: 1, n: 3 }] };
    if (sql.includes('FROM security_alerts WHERE type')) return { rows: [] };
    return { rows: [] };
  });
  await securite.enregistrerConnexion({ type_compte: 'admin', email: 'a@t.fr', evenement: 'echec', ctx: { ip: '9.9.9.9', req: { headers: {} } } });
  const al = ecritures(/INSERT INTO security_alerts/);
  assert.equal(al.length, 1); assert.equal(al[0].params[0], 'tentatives_repetees'); assert.equal(al[0].params[1], 'haute');
  calls.length = 0;
  setHandler(async (sql) => (sql.includes('FILTER (WHERE ip = $2)') ? { rows: [{ connue: 0, total: 4 }] } : { rows: [] }));
  await securite.connexionInhabituelle({ id: 1, email: 'a@t.fr', role: FIN }, { ip: '8.8.8.8' });
  assert.equal(ecritures(/INSERT INTO security_alerts/)[0].params[0], 'connexion_inhabituelle');
});

test('utilisateurs d\'entreprise : un compte bloqué ou aux sessions révoquées est refusé, la connexion bloquée aussi (et journalisée)', async () => {
  const user = jwt.sign({ sub: 3, typ: 'user' }, SECRET);
  const ligne = (o) => ({ id: 3, entreprise_id: 9, nom_complet: 'U', email: 'u@e.fr', role: 'proprietaire', actif: true, entreprise_statut: 'actif', ...o });
  setHandler(async (sql) => (sql.includes('FROM utilisateurs u JOIN entreprises e ON e.id = u.entreprise_id\n      WHERE u.id') || sql.includes('WHERE u.id = $1') ? { rows: [ligne({ bloque_jusqua: new Date(Date.now() + 3600000) })] } : { rows: [] }));
  assert.equal((await fetch(`${srv.base}/api/auth/me`, { headers: H(user) })).status, 401);
  setHandler(async (sql) => (sql.includes('WHERE u.id = $1') ? { rows: [ligne({ sessions_revoquees_le: new Date(Date.now() + 60000) })] } : { rows: [] }));
  assert.equal((await fetch(`${srv.base}/api/auth/me`, { headers: H(user) })).status, 401);
  const hash = await hashPassword('un-mot-de-passe-long');
  calls.length = 0;
  setHandler(async (sql) => (sql.includes('WHERE e.slug = $1') ? { rows: [{ id: 3, entreprise_id: 9, mot_de_passe_hash: hash, actif: true, statut: 'actif', bloque_jusqua: new Date(Date.now() + 3600000) }] } : { rows: [] }));
  const r = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: H(''), body: JSON.stringify({ slug: 'mawu', email: 'u@e.fr', mot_de_passe: 'un-mot-de-passe-long' }) });
  assert.equal(r.status, 401); assert.match((await r.json()).erreur, /bloqué/);
  assert.deepEqual(ecritures(/INSERT INTO connexions_journal/).map((c) => [c.params[4], c.params[5]]), [['echec', 'compte_bloque']]);
});

// ---------------------------------------------------------------- Journal d'audit
test('audit : aucun secret n\'est écrit dans le journal, les valeurs sensibles sont masquées', () => {
  const n = audit.nettoyer({ email: 'a@b.fr', mot_de_passe: 'abc', nested: { api_key: 'k', token: 't', secret_x: 's', code_recuperation: 'c', ok: 1 }, liste: [{ password: 'p', nom: 'n' }] });
  assert.equal(n.mot_de_passe, '[masqué]'); assert.equal(n.nested.api_key, '[masqué]'); assert.equal(n.nested.token, '[masqué]'); assert.equal(n.nested.secret_x, '[masqué]'); assert.equal(n.nested.code_recuperation, '[masqué]');
  assert.equal(n.nested.ok, 1); assert.equal(n.email, 'a@b.fr'); assert.equal(n.liste[0].password, '[masqué]'); assert.equal(n.liste[0].nom, 'n');
});

test('audit : toute action sensible est journalisée avec acteur, adresse IP et ancien/nouvel état', async () => {
  joue(SUPER, { extra: async (sql) => (sql.includes('SELECT statut FROM entreprises') ? { rows: [{ statut: 'actif' }] } : { rows: [], rowCount: 1 }) });
  assert.equal((await appel('PUT', '/api/admin/entreprises/5/statut', { statut: 'suspendu' })).status, 200);
  const e = ecritures(/INSERT INTO audit_journal/).find((c) => c.params[3] === 'entreprise.statut');
  assert.ok(e);
  assert.equal(e.params[0], 1); assert.equal(e.params[1], 'super_admin@t.fr'); assert.equal(e.params[2], SUPER);
  assert.deepEqual(JSON.parse(e.params[6]), { avant: 'actif', apres: 'suspendu' });
  assert.ok(e.params[7]); assert.equal(e.params[8], 'succes');
  // Aucune route ne modifie ou supprime le journal
  assert.ok(!ecritures(/(UPDATE|DELETE FROM) audit_journal/).length);
});

test('export de données : sans secret, journalisé, limité en fréquence', async () => {
  joue(SUPER, { extra: async (sql) => (sql.includes('FROM admins_plateforme ORDER') ? { rows: [{ id: 1, nom_complet: 'A', email: 'a@b.fr', role: SUPER }] } : null) });
  const r = await appel('POST', '/api/admin/super/sauvegardes', { tables: ['admins'] });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /best-quinca-export-.*\.json/);
  const corps = await r.text();
  assert.ok(!/mot_de_passe|hash/.test(corps)); assert.ok(JSON.parse(corps).tables.admins.length === 1);
  assert.ok(ecritures(/INSERT INTO sauvegardes_journal/).length === 1);
  assert.ok(ecritures(/INSERT INTO audit_journal/).some((c) => c.params[3] === 'sauvegarde.export'));
  assert.equal((await appel('POST', '/api/admin/super/sauvegardes', { tables: ['mots_de_passe'] })).status, 400);
  const sqlExports = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin-super.js'), 'utf8').match(/const EXPORTS = \{[\s\S]*?\n\};/)[0];
  assert.ok(!/mot_de_passe_hash|code_recuperation|valeur/.test(sqlExports));
});

// ---------------------------------------------------------------- Cohérence interface ↔ serveur
test('interface : chaque appel d\'API des écrans correspond à une route existante', () => {
  const dir = path.join(__dirname, '..', 'public', 'assets');
  const manquants = [];
  for (const f of ['admin.js', 'admin-super.js', 'admin-finance.js', 'admin-securite.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/(?:api|telecharger)\(\s*([`'"])(\/[^`'"?]*)/g)) {
      const chemin = '/api/admin' + m[2].replace(/\$\{[^}]*\}/g, '1');
      if (!router.routes.some((r) => r.regex.test(chemin))) manquants.push(`${f} : ${chemin}`);
    }
  }
  assert.deepEqual(manquants, []);
});

test('interface : les scripts d\'espace sont chargés avant admin.js et existent', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'server', 'templates', 'admin.html'), 'utf8');
  const srcs = [...html.matchAll(/src="\/assets\/([^"]+)"/g)].map((m) => m[1]);
  for (const s of srcs) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'assets', s)), s);
  assert.ok(srcs.indexOf('admin-super.js') < srcs.indexOf('admin.js') && srcs.indexOf('admin-securite.js') < srcs.indexOf('admin.js'));
});

// ---------------------------------------------------------------- Corrections issues de l'audit de sécurité
test('mot de passe : le nouveau doit différer de l\'ancien (le mot de passe provisoire ne peut pas être « conservé »)', async () => {
  joue(FIN, { session: { mdp_temporaire: true }, extra: async (sql) => (sql.includes('SELECT mot_de_passe_hash FROM admins_plateforme') ? { rows: [{ mot_de_passe_hash: await hashPassword('Provisoire-1234-ab') }] } : null) });
  const r = await appel('POST', '/api/admin/mot-de-passe', { ancien: 'Provisoire-1234-ab', nouveau: 'Provisoire-1234-ab' });
  assert.equal(r.status, 400); assert.match((await r.json()).erreur, /différent/);
  assert.equal(ecritures(/UPDATE admins_plateforme SET mot_de_passe_hash/).length, 0);
});

test('clés de paiement : un fournisseur ACTIF ne peut être reconfiguré que par le Super admin (anti-détournement)', async () => {
  const extra = (actif) => async (sql) => {
    if (sql.includes('SELECT actif FROM payment_providers WHERE code')) return { rows: [{ actif }] };
    if (sql.includes('FROM plateforme_parametres')) return { rows: [] };
    return null;
  };
  const corps = { valeurs: { kkiapay_public_key: 'pk_nouvelle_123456' } };
  joue(FIN, { extra: extra(true) });
  assert.equal((await appel('PUT', '/api/admin/finance/agregateurs/kkiapay/cles', corps)).status, 403);
  assert.equal(ecritures(/INSERT INTO plateforme_parametres/).length, 0);
  joue(FIN, { extra: extra(false) });
  assert.equal((await appel('PUT', '/api/admin/finance/agregateurs/kkiapay/cles', corps)).status, 200);
  calls.length = 0;
  joue(SUPER, { extra: extra(true) });
  assert.equal((await appel('PUT', '/api/admin/finance/agregateurs/kkiapay/cles', corps)).status, 200);
});

test('dépenses : fractionner un gros engagement en petites dépenses ne contourne pas le seuil', async () => {
  joue(FIN, { extra: async (sql) => {
    if (sql.includes('FROM hosting_expenses WHERE cree_par')) return { rows: [{ total: 80000 }] };
    if (sql.includes('INSERT INTO hosting_expenses')) return { rows: [{ id: 8 }] };
    if (sql.includes('INSERT INTO subscription_management_requests')) return { rows: [{ id: 12, type: 'engagement', statut: 'en_attente', resume: 'x' }] };
    return null;
  } });
  // 30 000 F seul passerait (< 100 000), mais le cumul 30 j atteint 110 000 : validation obligatoire
  const r = await (await appel('POST', '/api/admin/finance/depenses', { categorie: 'autre', libelle: 'Petite dépense', montant: 30000, periodicite: 'ponctuelle' })).json();
  assert.equal(r.statut, 'en_attente');
});

test('départ d\'agent : à l\'approbation, on revérifie qu\'il reste un autre propriétaire', async () => {
  joue(SUPER, { extra: async (sql) => {
    if (sql.includes('FROM subscription_management_requests WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 30, type: 'depart_agent', statut: 'en_attente', entreprise_id: 9, donnees: { utilisateur_id: 3 }, resume: 'Départ' }] };
    if (sql.includes('SELECT role FROM utilisateurs WHERE id')) return { rows: [{ role: 'proprietaire' }] };
    if (sql.includes("role = 'proprietaire' AND actif AND id <>")) return { rows: [{ n: 0 }] };
    return null;
  } });
  const r = await appel('POST', '/api/admin/super/demandes/30/decision', { decision: 'approuver' });
  assert.equal(r.status, 409);
  assert.equal(ecritures(/UPDATE utilisateurs SET actif = false/).length, 0);
});

test('dernier Super admin : vérification et modification dans une même transaction verrouillée', async () => {
  joue(SUPER, { extra: async (sql, params) => {
    if (sql.includes('SELECT id, nom_complet, email, role, actif FROM admins_plateforme WHERE id')) return { rows: [{ id: 2, nom_complet: 'N', email: 'n@t.fr', role: SUPER, actif: true }] };
    if (sql.includes("role = 'SUPER_ADMIN' AND actif AND id <>")) return { rows: [{ n: 0 }] };
    return null;
  } });
  assert.equal((await appel('PUT', '/api/admin/super/admins/2', { actif: false })).status, 400);
  assert.ok(ecritures(/role = 'SUPER_ADMIN' AND actif FOR UPDATE/).length === 1, 'verrou des lignes Super admin');
  assert.equal(ecritures(/UPDATE admins_plateforme SET nom_complet/).length, 0);
});

test('journal : toute écriture d\'administration est tracée, même sans journal spécifique (ex. sponsors)', async () => {
  joue(SUPER, { extra: async (sql) => (sql.includes('INSERT INTO sponsors') ? { rows: [{ id: 3 }] } : null) });
  const r = await appel('POST', '/api/admin/sponsors', { nom: 'Marque Test' });
  assert.ok(r.status < 500, String(r.status));
  assert.ok(ecritures(/INSERT INTO audit_journal/).some((c) => c.params[3] === 'api.post' && c.params[5] === '/api/admin/sponsors'));
  // Les lectures ne sont pas journalisées
  calls.length = 0;
  await appel('GET', '/api/admin/finance/dashboard');
  assert.equal(ecritures(/INSERT INTO audit_journal/).length, 0);
});

test('journal : les clés d\'objet dangereuses (__proto__…) sont ignorées', () => {
  const n = audit.nettoyer(JSON.parse('{"__proto__":{"polluted":true},"constructor":"x","ok":1}'));
  assert.equal(n.ok, 1); assert.equal(({}).polluted, undefined); assert.ok(!Object.prototype.hasOwnProperty.call(n, 'constructor'));
});

test('anti-inondation : au-delà de 20 refus par minute, le journal n\'enfle plus (la requête reste refusée)', async () => {
  const securite = require('../server/lib/securite');
  setHandler(async () => ({ rows: [] }));
  const ctx = { admin: { id: 777, email: 'x@t.fr', role: FIN }, ip: '1.1.1.1', pathname: '/api/admin/securite/alertes' };
  for (let i = 0; i < 40; i++) await securite.accesRefuse(ctx, 'securite.alertes.gerer');
  assert.equal(ecritures(/INSERT INTO audit_journal/).length, 20);
});

test('rétention : purge des anciennes connexions et sessions, jamais du journal d\'audit', async () => {
  const relances = require('../server/lib/relances');
  setHandler(async () => ({ rows: [] }));
  await relances.traiter({ planifier: false });
  assert.equal(ecritures(/DELETE FROM connexions_journal/).length, 1);
  assert.equal(ecritures(/DELETE FROM admin_sessions/).length, 1);
  assert.equal(ecritures(/audit_journal/).filter((c) => /DELETE|UPDATE|TRUNCATE/i.test(c.sql)).length, 0);
});
