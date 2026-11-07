'use strict';
// Page Bilans côté navigateur : exécutée avec un faux DOM minimal (pas de navigateur disponible en test)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { creer: creerReseau } = require('../public/assets/reveil.js');

class El {
  constructor(tag) { this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.dataset = {}; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this.parent = null; }
  append(...k) { for (const c of k) { if (c instanceof El) c.parent = this; this.children.push(c && c.nodeType ? c : texte(c)); } }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  setAttribute(n, v) { this.attrs[n] = v; if (n === 'hidden') this.hidden = true; }
  addEventListener(n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); }
  dispatch(n, ev = {}) { for (const f of this.listeners[n] || []) f({ currentTarget: this, target: this, stopPropagation() {}, preventDefault() {}, ...ev }); }
  get classList() { const s = this; return { add: () => {}, remove: () => {}, toggle: () => {}, contains: (c) => s.className.split(' ').includes(c) }; }
  showModal() {} close() { this.dispatch('close'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  after() {} closest() { return this; } querySelector() { return null; } querySelectorAll() { return []; }
  get textContent() { return this.children.map((c) => (c instanceof El ? c.textContent : c.t)).join(' '); }
}
const texte = (t) => ({ t: String(t), nodeType: 3 });
const tous = (el, out = []) => { out.push(el); el.children.forEach((c) => c instanceof El && tous(c, out)); return out; };
const bouton = (racine, libelle) => tous(racine).find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === libelle);

const BILAN = { du: '2026-10-30', au: '2026-10-30', genere_le: '2026-10-30 18:42', periode: 'aujourdhui', ventes: { nb: 8, brut: 120000, panier_moyen: 15000 }, modes: [{ mode: 'especes', nb: 5, total: 50000 }, { mode: 'credit', nb: 1, total: 40000 }], remboursements: { nb: 1, total: 2000, rendu: 2000 }, ca_net: 118000, credit: { nb: 1, total: 40000, acomptes: 10000, reste: 30000 }, reglements: { nb: 1, total: 5000, par_mode: {} }, encaisse: { comptant: 80000, acomptes: 10000, reglements: 5000, rendu: 2000, total: 93000 }, marge: { cout: 90000, marge: 30000 }, top_produits: [{ nom_produit: 'Ciment', quantite: 20, total: 160000 }], vendeurs: [{ vendeur: 'Koffi', nb: 8, total: 120000 }], jours: [], stock: { faibles: 4, valeur: 3500000 }, anomalies: 1 };

function charger() {
  const appels = [];
  const body = new El('body'); body.dataset.slug = 'zinsou';
  const toasts = new El('div');
  const document = { body, createElement: (t) => new El(t), createTextNode: texte, getElementById: (id) => (id === 'toasts' ? toasts : new El('div')), querySelectorAll: () => [], addEventListener() {} };
  const stock = { getItem: () => null, setItem() {}, removeItem() {} };
  const reponses = {
    'GET /api/bilan?periode=aujourdhui': BILAN,
    'GET /api/bilans': [{ id: 5, numero: 2, du: '2026-10-29', au: '2026-10-29', note: 'Fin de journée', nb_ventes: 2, ca_net: 5000, cree_par_nom: 'Koffi', cree_le: '2026-10-30 10:00' }],
    'DELETE /api/bilans/5': { ok: true },
    'GET /api/inventaires': [{ id: 7, numero: 3, statut: 'annule', note: null, tableau_remis: false, cree_par_nom: 'Koffi', cree_le: '2026-10-01 09:00', termine_le: '2026-10-01 10:00', nb_lignes: 10, nb_comptees: 2, nb_ecarts: 0, valeur_ecart: 0 }, { id: 6, numero: 2, statut: 'valide', note: null, tableau_remis: false, cree_par_nom: 'Koffi', cree_le: '2026-09-01 09:00', termine_le: '2026-09-01 10:00', nb_lignes: 10, nb_comptees: 10, nb_ecarts: 1, valeur_ecart: 500 }],
    'DELETE /api/inventaires/7': { ok: true },
    'GET /api/utilisateurs': [{ id: 1, nom_complet: 'Koffi', email: 'k@a.fr', role: 'proprietaire', actif: true }, { id: 2, nom_complet: 'Ancien', email: 'a@a.fr', role: 'secretaire', actif: false }, { id: 3, nom_complet: 'Actif', email: 'b@a.fr', role: 'secretaire', actif: true }],
    'DELETE /api/utilisateurs/2': { ok: true },
  };
  const fetch = async (url, opts = {}) => {
    const cle = `${opts.method || 'GET'} ${url}`;
    appels.push(cle);
    const r = reponses[cle];
    return { ok: r !== undefined, status: r !== undefined ? 200 : 404, json: async () => r || { erreur: 'introuvable' }, headers: { get: () => null } };
  };
  const window = { BQ: {}, BQHL: { get: async () => null, set: async () => {}, del: async () => {} }, BQR: creerReseau({ fetch }), addEventListener() {}, matchMedia: () => ({ matches: false }), icone: () => null };
  const ctx = { window, document, localStorage: stock, sessionStorage: stock, location: { search: '', hash: '' }, navigator: {}, fetch, Intl, URLSearchParams, Date, Math, JSON, Promise, Array, Object, Number, String, Set, Map, Error, console, File: class {}, setTimeout, clearTimeout, setInterval: () => 0, confirm: () => true, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} } };
  ctx.document.referrer = '';
  let src = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'app.js'), 'utf8');
  assert.match(src, /if \(state\.token\) demarrer\(\); else afficherConnexion\(\);\n\}\)\(\);\s*$/);
  src = src.replace(/if \(state\.token\) demarrer\(\); else afficherConnexion\(\);\n\}\)\(\);\s*$/, 'window.__t = { VUES, state };\n})();');
  vm.runInNewContext(src, ctx);
  const t = window.__t;
  t.state.user = { id: 1, role: 'proprietaire', nom_complet: 'Koffi' };
  t.state.token = 'jeton';
  return { t, appels, body, toasts };
}

test('menu : « Bilans » est réservé au propriétaire', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'app.js'), 'utf8');
  assert.match(src, /\{ id: 'bilans', titre: 'Bilans', proprio: true \}/);
});

test('page Bilans : calcule le bilan du jour, propose PDF / enregistrer, liste les bilans enregistrés', async () => {
  const { t, appels } = charger();
  const vue = new El('main');
  await t.VUES.bilans(vue);
  assert.ok(appels.includes('GET /api/bilan?periode=aujourdhui'));
  assert.ok(appels.includes('GET /api/bilans'));
  const txt = vue.textContent.replace(/[\u202f\u00a0]/g, ' ');
  assert.match(txt, /Journée du 30\/10\/2026/);
  assert.match(txt, /Chiffre d'affaires net/);
  assert.match(txt, /Argent encaissé/);
  assert.match(txt, /118 000/);
  assert.match(txt, /93 000/);
  assert.match(txt, /Reste à encaisser/);
  assert.ok(bouton(vue, 'Télécharger la fiche PDF'), 'bouton PDF');
  assert.ok(bouton(vue, 'Enregistrer ce bilan'), 'bouton enregistrer');
  for (const p of ['Aujourd\'hui', 'Hier', '7 derniers jours', 'Ce mois', 'Mois dernier', 'Dates précises']) assert.ok(bouton(vue, p), p);
  assert.match(txt, /n°2/);
  assert.match(txt, /30\/10\/2026 10:00/, 'date d\'enregistrement lisible');
  assert.match(txt, /Fin de journée/);
  assert.ok(!/undefined|NaN|\[object/.test(txt), 'aucune valeur cassée à l\'écran');
});

test('bilan enregistré : « Supprimer » demande confirmation, puis supprime et recharge la liste', async () => {
  const { t, appels, body } = charger();
  const vue = new El('main');
  await t.VUES.bilans(vue);
  bouton(vue, 'Supprimer').dispatch('click');
  const dialogue = body.children.find((c) => c.tagName === 'DIALOG');
  assert.ok(dialogue, 'fenêtre de confirmation');
  assert.match(dialogue.textContent, /Supprimer le bilan n°2 \?/);
  assert.match(dialogue.textContent, /Vos ventes, vos crédits clients et votre stock ne changent pas/);
  assert.ok(!appels.includes('DELETE /api/bilans/5'), 'rien n\'est supprimé avant la confirmation');
  bouton(dialogue, 'Annuler').dispatch('click');
  assert.ok(!appels.includes('DELETE /api/bilans/5'));
  bouton(vue, 'Supprimer').dispatch('click');
  const d2 = body.children.filter((c) => c.tagName === 'DIALOG').pop();
  bouton(d2, 'Supprimer').dispatch('click');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(appels.includes('DELETE /api/bilans/5'));
});

test('inventaire : « Supprimer » seulement sur un inventaire annulé', async () => {
  const { t, appels, body } = charger();
  const vue = new El('main');
  await t.VUES.inventaire(vue);
  const boutons = tous(vue).filter((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Supprimer');
  assert.equal(boutons.length, 1, 'un seul inventaire annulé');
  boutons[0].dispatch('click');
  const dialogue = body.children.find((c) => c.tagName === 'DIALOG');
  assert.match(dialogue.textContent, /Supprimer l'inventaire n°3 \?/);
  bouton(dialogue, 'Supprimer').dispatch('click');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(appels.includes('DELETE /api/inventaires/7'));
});

test('équipe : « Supprimer » seulement sur un compte désactivé (jamais soi-même)', async () => {
  const { t, appels, body } = charger();
  const vue = new El('main');
  await t.VUES.equipe(vue);
  const boutons = tous(vue).filter((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Supprimer');
  assert.equal(boutons.length, 1);
  boutons[0].dispatch('click');
  const dialogue = body.children.find((c) => c.tagName === 'DIALOG');
  assert.match(dialogue.textContent, /Supprimer le compte de Ancien \?/);
  bouton(dialogue, 'Supprimer').dispatch('click');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(appels.includes('DELETE /api/utilisateurs/2'));
});
