(() => {
  'use strict';
  // Icônes de navigation : traits de 1,8 px sur 24 px, couleur du texte (currentColor)
  const D = {
    tableau: [['rect', { x: 3, y: 3, width: 7.5, height: 9, rx: 1.6 }], ['rect', { x: 13.5, y: 3, width: 7.5, height: 5.5, rx: 1.6 }], ['rect', { x: 13.5, y: 11.5, width: 7.5, height: 9.5, rx: 1.6 }], ['rect', { x: 3, y: 15, width: 7.5, height: 6, rx: 1.6 }]],
    caisse: [['path', { d: 'M6 3h12v18l-3-2-3 2-3-2-3 2z' }], ['path', { d: 'M9.5 8h5M9.5 12h5' }]],
    produits: [['path', { d: 'M12 3l8.5 4.5v9L12 21l-8.5-4.5v-9z' }], ['path', { d: 'M3.8 7.7 12 12l8.2-4.3M12 12v9' }]],
    stock: [['path', { d: 'M12 3 3 8l9 5 9-5z' }], ['path', { d: 'm3 12.5 9 5 9-5M3 16.5l9 5 9-5' }]],
    inventaire: [['rect', { x: 5, y: 4, width: 14, height: 17, rx: 2 }], ['path', { d: 'M9 4V3h6v1M9 13l2.2 2.2L15.5 11' }]],
    credits: [['rect', { x: 3, y: 6, width: 18, height: 12, rx: 2 }], ['path', { d: 'M3 10h18M7 15h4' }]],
    bilans: [['rect', { x: 4, y: 3, width: 16, height: 18, rx: 2.2 }], ['path', { d: 'M8.5 17v-3M12 17V8.5M15.5 17v-5.5' }]],
    ventes: [['path', { d: 'M9 6h11M9 12h11M9 18h11' }], ['path', { d: 'M4.5 6h.01M4.5 12h.01M4.5 18h.01', 'stroke-width': 2.8 }]],
    partenaires: [['path', { d: 'M3.5 12.2V4.5h7.7l9.3 9.3a1.6 1.6 0 0 1 0 2.3l-5.4 5.4a1.6 1.6 0 0 1-2.3 0z' }], ['circle', { cx: 8, cy: 9, r: 1.4 }]],
    equipe: [['circle', { cx: 9, cy: 8, r: 3.2 }], ['path', { d: 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6' }], ['circle', { cx: 17.2, cy: 9, r: 2.5 }], ['path', { d: 'M17.2 14c2.5 0 4.3 1.8 4.3 4.5' }]],
    abonnement: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.2 }], ['path', { d: 'M3 10h18M7 15h4' }]],
    profil: [['path', { d: 'M4 9l1.5-5h13L20 9z' }], ['path', { d: 'M5 12v8h14v-8M10 20v-5h4v5' }]],
    reglages: [['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }], ['circle', { cx: 15, cy: 7, r: 2 }], ['circle', { cx: 9, cy: 17, r: 2 }]],
  };
  const NS = 'http://www.w3.org/2000/svg';

  window.icone = (nom) => {
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ico' })) svg.setAttribute(k, v);
    for (const [tag, attrs] of D[nom] || []) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  };
  // Page d'accueil : <span data-icone="caisse"></span>
  const habiller = () => document.querySelectorAll('[data-icone]').forEach((el) => { if (!el.firstChild) el.append(window.icone(el.dataset.icone)); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', habiller); else habiller();
})();
