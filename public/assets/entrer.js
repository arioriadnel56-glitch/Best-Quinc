(() => {
  'use strict';
  // Écran d'entrée de l'application Android : retrouve la dernière quincaillerie utilisée et l'ouvre directement.
  const q = new URLSearchParams(location.search);
  const playstore = q.get('source') === 'playstore';
  try { if (playstore) sessionStorage.setItem('bq:playstore', '1'); } catch { /* stockage indisponible */ }
  let dernier = null;
  try { dernier = localStorage.getItem('bq:dernier-espace'); } catch { /* stockage indisponible */ }
  if (dernier && /^[a-z0-9-]{3,60}$/.test(dernier) && !q.has('changer') && !q.has('espace')) {
    location.replace(`/app/${dernier}/${playstore ? '?source=playstore' : ''}`);
    return;
  }
  // Identifiant saisi (?espace=…) : la page étant servie sans serveur, la redirection se fait ici ; l'existence de l'espace est vérifiée à la connexion
  if (q.has('espace')) {
    const brut = (q.get('espace') || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^\/?(app\/)?/, '').replace(/\/.*$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (/^[a-z0-9-]{3,60}$/.test(brut)) { location.replace(`/app/${brut}/${playstore ? '?source=playstore' : ''}`); return; }
  }
  if (playstore) {
    // Conserve l'origine « application Android » lors de la saisie de l'identifiant
    const f = document.querySelector('form');
    if (f) { const h = document.createElement('input'); h.type = 'hidden'; h.name = 'source'; h.value = 'playstore'; f.append(h); }
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/entrer-sw.js', { scope: '/entrer' }).catch(() => {});
})();
