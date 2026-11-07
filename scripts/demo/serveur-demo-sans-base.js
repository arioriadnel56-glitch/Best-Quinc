'use strict';
// Serveur de démonstration SANS PostgreSQL : la vraie application, avec une base simulée en mémoire.
// Sert à enregistrer les séquences « page d'accueil → créer son espace → installer l'application » sans rien installer d'autre.
// Usage : PORT=3100 node scripts/demo/serveur-demo-sans-base.js   (les données disparaissent à l'arrêt)
const path = require('node:path');
const http = require('node:http');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://demo/demo';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'demo-'.repeat(10);
process.env.PUBLIC_URL = process.env.PUBLIC_URL || '';

const store = { ent: [], pwa: [], usr: [], abo: [], bil: [] };
const aujourdhui = (plus = 0) => new Date(Date.now() + plus * 86400000).toISOString().slice(0, 10);

function repondre(sql, p) {
  const s = String(sql);
  if (s.includes('FROM plateforme_parametres')) return { rows: [] };
  if (s.includes('SELECT 1 FROM entreprises WHERE slug')) return { rows: store.ent.filter((e) => e.slug === p[0]).map(() => ({ '?column?': 1 })) };
  if (s.includes('INSERT INTO entreprises')) {
    const e = { id: store.ent.length + 1, nom: p[0], slug: p[1], telephone: p[2], email: p[3], statut: 'actif' };
    store.ent.push(e); return { rows: [{ id: e.id, nom: e.nom, slug: e.slug }] };
  }
  if (s.includes('INSERT INTO pwa_configs')) { store.pwa.push({ entreprise_id: p[0], nom_app: p[1], couleur: '#3E5C76' }); return { rows: [] }; }
  if (s.includes('INSERT INTO utilisateurs')) {
    const u = { id: store.usr.length + 1, entreprise_id: p[0], nom_complet: p[1], email: p[2], role: 'proprietaire', actif: true };
    store.usr.push(u); return { rows: [{ id: u.id, nom_complet: u.nom_complet, email: u.email, role: u.role }] };
  }
  if (s.includes('INSERT INTO abonnements')) { store.abo.push({ entreprise_id: p[0], jours: p[1] }); return { rows: [] }; }
  if (s.includes('u.mdp_temporaire')) {
    const u = store.usr.find((x) => x.id === p[0]); const e = u && store.ent.find((x) => x.id === u.entreprise_id);
    return { rows: u ? [{ ...u, entreprise_statut: e.statut, mdp_temporaire: false, mdp_modifie_le: null, a_code_recuperation: true }] : [] };
  }
  if (s.includes('FROM abonnements')) {
    const a = store.abo.find((x) => x.entreprise_id === p[0]);
    return { rows: a ? [{ id: 1, montant: 0, date_debut: aujourdhui(), date_fin: aujourdhui(a.jours || 30) }] : [] };
  }
  if (s.includes('SELECT e.slug, e.nom, p.nom_app, p.couleur')) {
    const e = store.ent.find((x) => x.slug === p[0]); const c = e && store.pwa.find((x) => x.entreprise_id === e.id);
    return { rows: e ? [{ slug: e.slug, nom: e.nom, nom_app: c.nom_app, couleur: c.couleur }] : [] };
  }
  if (s.includes('e.partage_stats')) {
    const e = store.ent.find((x) => x.id === p[0]); const c = store.pwa.find((x) => x.entreprise_id === p[0]);
    return { rows: [{ nom: e.nom, slug: e.slug, adresse: null, ville: null, telephone: e.telephone, email: e.email, ifu: null, rccm: null, site_web: null, pied_facture: null, pays_indicatif: '229', partage_stats: false, nom_app: c.nom_app, couleur: c.couleur, a_logo: false, logo_v: null }] };
  }
  // ----- Bilans : chiffres d'exemple cohérents (la démo n'a pas de vraies ventes) -----
  if (s.includes('to_char(now() AT TIME ZONE')) {
    const tz = process.env.FUSEAU_HORAIRE || 'Africa/Porto-Novo';
    const f = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date());
    return { rows: [{ maintenant: f, aujourdhui: f.slice(0, 10) }] };
  }
  if (s.includes('GROUP BY vente_id')) return { rows: [{ nb: 2, total: 64000, acomptes: 20000, reste: 44000 }] };
  if (s.includes('FROM reglements')) return { rows: [{ mode: 'especes', nb: 1, total: 8000 }] };
  if (s.includes('FROM remboursements')) return { rows: [{ nb: 1, total: 4000, rendu: 4000 }] };
  if (s.includes('GROUP BY mode_paiement')) return { rows: [{ mode: 'especes', nb: 9, total: 410000 }, { mode: 'mobile_money', nb: 5, total: 262000 }, { mode: 'credit', nb: 2, total: 64000 }] };
  if (s.includes('AS ca,')) return { rows: [{ ca: 736000, cout: 540000 }] };
  if (s.includes('l.nom_produit, SUM')) return { rows: [{ nom_produit: 'Ciment CPJ 32,5 (sac 50 kg)', quantite: 38, total: 304000 }, { nom_produit: 'Brouette 80 L', quantite: 5, total: 140000 }, { nom_produit: 'Peinture à eau 20 L', quantite: 4, total: 118000 }] };
  if (s.includes('Compte supprimé')) return { rows: [{ vendeur: store.usr[0] ? store.usr[0].nom_complet : 'Propriétaire', nb: 16, total: 736000 }] };
  if (s.includes("to_char((cree_le AT TIME ZONE $2)::date")) return { rows: [] };
  if (s.includes('COUNT(*) FILTER')) return { rows: [{ faibles: 3, valeur: 2150000 }] };
  if (s.includes('anomalie IS NOT NULL')) return { rows: [{ nb: 0 }] };
  if (s.includes('FROM entreprises e LEFT JOIN pwa_configs c')) { const e = store.ent.find((x) => x.id === p[0]); const c = store.pwa.find((x) => x.entreprise_id === p[0]); return { rows: e ? [{ nom: c.nom_app, couleur: c.couleur }] : [] }; }
  if (s.includes('MAX(numero)')) return { rows: [{ n: store.bil.length + 1 }] };
  if (s.includes('INSERT INTO bilans')) { const b = { id: store.bil.length + 1, numero: p[1], du: p[2], au: p[3], note: p[4], donnees: JSON.parse(p[5]), eid: p[0], cree_le: new Date() }; store.bil.push(b); return { rows: [{ id: b.id, numero: b.numero }] }; }
  if (s.includes('FROM bilans b LEFT JOIN utilisateurs u ON u.id = b.cree_par') && s.includes('b.donnees,')) { const b = store.bil.find((x) => x.id === p[0] && x.eid === p[1]); return { rows: b ? [{ id: b.id, numero: b.numero, note: b.note, donnees: b.donnees, cree_par_nom: 'Démo' }] : [] }; }
  if (s.includes('FROM bilans b')) return { rows: store.bil.filter((b) => b.eid === p[0]).sort((a, b) => b.numero - a.numero).map((b) => ({ id: b.id, numero: b.numero, du: b.du, au: b.au, note: b.note, nb_ventes: b.donnees.ventes.nb, ca_net: b.donnees.ca_net, cree_par_nom: 'Démo', cree_le: '2026-10-31 12:00' })) };
  if (s.startsWith('DELETE FROM bilans')) { const n = store.bil.length; store.bil = store.bil.filter((b) => !(b.id === p[0] && b.eid === p[1])); return { rowCount: n - store.bil.length, rows: [] }; }
  return { rows: [], rowCount: 0 };
}

const fake = {
  query: async (sql, params) => repondre(sql, params),
  tx: async (fn) => fn(async (sql, params) => repondre(sql, params)),
  getPool: () => ({ end: async () => {} }),
  connexionCoupee: () => false, estLecture: () => true,
};
const dbPath = require.resolve(path.join(__dirname, '..', '..', 'server', 'lib', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };

const { handle } = require('../../server');
const realtime = require('../../server/lib/realtime');
const server = http.createServer((req, res) => { handle(req, res); });
realtime.attach(server);
const port = Number(process.env.PORT || 3100);
server.listen(port, '127.0.0.1', () => console.log(`Démo sans base prête sur http://127.0.0.1:${port}`));
