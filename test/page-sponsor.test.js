'use strict';
// Exécute public/assets/sponsor.js avec un faux DOM : la page ne doit jamais afficher « false », « null » ou « undefined »
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { creer: creerReseau } = require('../public/assets/reveil.js');

class Noeud {
  constructor(tag) { this.tag = tag; this.nodeType = 1; this.enfants = []; this.attrs = {}; this.className = ''; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  // Comme un vrai navigateur : tout ce qui n'est pas un nœud est écrit en texte (« false », « null »…)
  append(...n) { this.enfants.push(...n.map((x) => (x && x.nodeType ? x : String(x)))); }
  replaceChildren(...n) { this.enfants = n.map((x) => (x && x.nodeType ? x : String(x))); }
  get textContent() { return this.enfants.map((e) => (typeof e === 'string' ? e : e.textContent)).join(' '); }
}
const faux = (rapport, statut = 200) => {
  const root = new Noeud('main');
  const document = {
    createElement: (t) => new Noeud(t),
    createTextNode: (t) => String(t),
    getElementById: () => root,
    title: '',
  };
  const fetch = async () => ({ ok: statut === 200, status: statut, json: async () => rapport, headers: { get: () => 'application/json' } });
  const ctx = vm.createContext({
    document, window: { print() {}, BQR: creerReseau({ fetch }) }, location: { pathname: `/sponsor/${'ab'.repeat(24)}` }, console,
    Intl, Date, Number, Object, Array, String, encodeURIComponent, fetch,
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/../public/assets/sponsor.js`, 'utf8'), ctx);
  return root;
};
const rapport = (publiable) => ({
  sponsor: { id: 1, nom: 'Outillage Pro', a_logo: false }, seuil_anonymat: 5, boutiques: { nb: publiable ? 14 : 3, publiable },
  mensuel: publiable ? [{ mois: '2026-10', quantite: 88, ca: 2720000, boutiques: 14 }] : [], top_produits: [], villes: [], boutiques_en_alerte: publiable ? 5 : null,
  offres: [], commandes: [],
});
const attendre = () => new Promise((r) => setTimeout(r, 20));

for (const publiable of [true, false]) {
  test(`page du rapport (${publiable ? 'publiable' : 'sous le seuil'}) : aucun « false » ni « null » affiché`, async () => {
    const root = faux(rapport(publiable));
    await attendre();
    const texte = root.textContent;
    assert.match(texte, /Rapport partenaire — Outillage Pro/);
    assert.ok(!/\b(false|null|undefined|NaN)\b/.test(texte), `texte affiché : ${texte}`);
    assert.equal(/Pas encore assez de boutiques/.test(texte), !publiable);
    assert.equal(/Ventes de vos produits par mois/.test(texte), publiable);
  });
}

test('page du rapport : adresse inconnue -> message clair, sans détail technique', async () => {
  const root = faux({ erreur: 'Rapport introuvable.' }, 404);
  await attendre();
  assert.match(root.textContent, /adresse est incorrecte ou a été renouvelée/);
});
