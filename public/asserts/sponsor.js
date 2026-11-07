(() => {
  'use strict';
  // Rapport d'un partenaire : lecture seule, adresse secrète, données anonymes et groupées.
  const root = document.getElementById('root');
  const nombre = (n) => new Intl.NumberFormat('fr-FR').format(Number(n) || 0);
  const fcfa = (n) => nombre(Math.round(Number(n) || 0)) + ' F CFA';
  const mois = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); };
  const dateFr = (iso) => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add); else el.append(c.nodeType ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  }

  const tableau = (entetes, lignes, vide) => lignes.length
    ? h('div', { class: 'tableau-defil' }, h('table', { class: 'tableau' },
      h('thead', {}, h('tr', {}, entetes.map((t, i) => h('th', { class: t.num ? 'num' : '' }, t.titre)))),
      h('tbody', {}, lignes.map((l) => h('tr', {}, l.map((c, i) => h('td', { class: entetes[i].num ? 'num' : '' }, c)))))))
    : h('p', { class: 'aide' }, vide);

  function afficher(d) {
    const K = d.seuil_anonymat;
    const stat = (t, v, detail) => h('div', { class: 'stat' }, h('span', { class: 'stat-titre' }, t), h('strong', { class: 'stat-valeur' }, v), detail && h('span', { class: 'stat-detail' }, detail));
    document.title = `Rapport — ${d.sponsor.nom}`;
    // replaceChildren() écrirait « false » pour un bloc absent : on retire les valeurs vides
    const blocs = [
      h('header', { class: 'rapport-entete' },
        d.sponsor.a_logo && h('img', { class: 'sponsor-logo grand', src: `/partenaires/${d.sponsor.id}/logo?v=${d.sponsor.logo_v || 0}`, alt: '' }),
        h('div', {}, h('h1', {}, `Rapport partenaire — ${d.sponsor.nom}`), h('p', { class: 'aide' }, `Établi le ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} · Best-Quinca`)),
        h('img', { class: 'logo-rapport', src: '/assets/marque/best-quinca.png', alt: 'Best-Quinca Hardware' }),
        h('button', { class: 'btn no-print', type: 'button', onclick: () => window.print() }, 'Imprimer / PDF')),

      h('div', { class: 'stats' },
        stat('Boutiques participantes', nombre(d.boutiques.nb), `vendent vos produits et partagent leurs statistiques`),
        d.boutiques.publiable && stat('Boutiques avec un de vos produits en alerte de stock', nombre(d.boutiques_en_alerte), 'stock sous le seuil : occasion de réassort')),

      !d.boutiques.publiable && h('section', { class: 'carte' }, h('h2', {}, 'Statistiques de vente'),
        h('p', {}, `Pas encore assez de boutiques pour publier ces chiffres : ils apparaissent à partir de ${K} boutiques participantes, afin qu'aucune boutique ne soit identifiable. Elles sont aujourd'hui ${nombre(d.boutiques.nb)}.`)),

      d.boutiques.publiable && h('section', { class: 'carte' }, h('h2', {}, 'Ventes de vos produits par mois'),
        tableau([{ titre: 'Mois' }, { titre: 'Quantité vendue', num: true }, { titre: 'Chiffre d\'affaires', num: true }, { titre: 'Boutiques', num: true }],
          d.mensuel.map((m) => [mois(m.mois), nombre(m.quantite), fcfa(m.ca), nombre(m.boutiques)]), 'Aucune vente sur la période.')),

      d.boutiques.publiable && h('div', { class: 'deux-col' },
        h('section', { class: 'carte' }, h('h2', {}, 'Produits les plus vendus (90 jours)'),
          tableau([{ titre: 'Produit' }, { titre: 'Quantité', num: true }, { titre: 'Boutiques', num: true }],
            d.top_produits.map((p) => [p.nom, nombre(p.quantite), nombre(p.boutiques)]), `Aucun produit vendu par au moins ${K} boutiques.`)),
        h('section', { class: 'carte' }, h('h2', {}, 'Par ville (90 jours)'),
          tableau([{ titre: 'Ville' }, { titre: 'Quantité', num: true }, { titre: 'Chiffre d\'affaires', num: true }, { titre: 'Boutiques', num: true }],
            d.villes.map((v) => [v.ville, nombre(v.quantite), fcfa(v.ca), nombre(v.boutiques)]), `Aucune ville avec au moins ${K} boutiques.`))),

      h('section', { class: 'carte' }, h('h2', {}, 'Vos offres auprès des boutiques'),
        tableau([{ titre: 'Offre' }, { titre: 'Période' }, { titre: 'Boutiques l\'ayant vue', num: true }, { titre: 'Ayant montré leur intérêt', num: true }],
          d.offres.map((o) => [o.titre + (o.actif ? '' : ' (inactive)'), `${dateFr(o.debut)}${o.fin ? ' → ' + dateFr(o.fin) : ''}`, nombre(o.vues), nombre(o.clics)]), 'Aucune offre pour le moment.')),

      h('section', { class: 'carte' }, h('h2', {}, 'Commandes de réassort reçues'),
        tableau([{ titre: 'Mois' }, { titre: 'Commandes', num: true }, { titre: 'Boutiques', num: true }],
          d.commandes.map((c) => [mois(c.mois), nombre(c.commandes), nombre(c.boutiques)]), 'Aucune commande pour le moment.')),

      h('p', { class: 'aide' }, `Données anonymes et groupées : un chiffre n'est publié que s'il repose sur au moins ${K} boutiques différentes, toutes ayant donné leur accord. Aucun nom de boutique, client ni prix d'achat n'est transmis dans ce rapport.`),
    ];
    root.replaceChildren(...blocs.filter((b) => b !== null && b !== undefined && b !== false));
  }

  async function demarrer() {
    const jeton = location.pathname.split('/')[2] || '';
    try {
      // Lecture seule : si le serveur dort, écran de transition puis reprise automatique
      const lire = () => window.BQR.appeler(`/api/rapport-sponsor/${encodeURIComponent(jeton)}`, { headers: { Accept: 'application/json' } }, { delai: 20000 });
      let res;
      try { res = await lire(); } catch (e) {
        if (e.kind !== 'reveil' || !(await window.BQR.attendreServeur({ avecEcran: true }))) throw new Error(e.kind === 'reveil' ? 'Le serveur ne répond pas. Réessayez dans un instant.' : 'Pas de connexion à internet. Réessayez.');
        res = await lire();
      }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 404 ? 'Rapport introuvable : l\'adresse est incorrecte ou a été renouvelée. Contactez Best-Quinca.' : (d.erreur || 'Une erreur est survenue.'));
      afficher(d);
    } catch (e) {
      root.replaceChildren(h('section', { class: 'carte' }, h('h1', {}, 'Rapport partenaire'), h('p', { class: 'erreur', role: 'alert' }, e.message)));
    }
  }
  demarrer();
})();
