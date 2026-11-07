'use strict';
// Service worker d'un espace de quincaillerie — périmètre limité à /app/<espace>/.
// Principe : l'application s'ouvre TOUJOURS depuis l'appareil (cache d'abord), puis se met à jour en arrière-plan.
// Ainsi un serveur endormi, une connexion lente ou l'absence de réseau ne bloquent jamais l'ouverture.
const SLUG = '{{SLUG}}' === '*' ? ((new URL(self.registration.scope).pathname.match(/^\/app\/([^/]+)\//) || [])[1] || 'espace') : '{{SLUG}}';
const CACHE = 'bq-' + SLUG + '-v{{VERSION}}';
const SHELL = ['./', '/assets/style.css', '/assets/config.js', '/assets/reveil.js', '/assets/outils.js', '/assets/icones.js', '/assets/fonts/carlito-regular.woff', '/assets/fonts/carlito-bold.woff', '/assets/fonts/heros-cn-bold.woff', '/assets/marque/best-quinca-clair.png', '/assets/hors-ligne.js', '/assets/temps-reel.js', '/assets/app.js', 'icon-192.png'];
const DELAI_MISE_A_JOUR_MS = 8000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'reload' }).then((r) => {
        if (!r.ok) throw new Error(`${u} : ${r.status}`);
        return c.put(u, r);
      }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('bq-' + SLUG + '-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Récupère une version à jour (avec délai maximum) et la range dans le cache
function actualiser(cache, req, cle) {
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), DELAI_MISE_A_JOUR_MS);
  return fetch(req, { signal: ctrl.signal })
    .then((res) => { if (res.ok) cache.put(cle || req, res.clone()); return res; })
    .finally(() => clearTimeout(minuteur));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // données : jamais interceptées

  // Ouverture de l'application : la coque en cache s'affiche tout de suite, la mise à jour se fait derrière
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const copie = await cache.match('./');
        const maj = actualiser(cache, req, './').catch(() => null);
        if (copie) { event.waitUntil(maj); return copie; }
        return (await maj) || Response.error(); // première visite : pas encore de copie
      }),
    );
    return;
  }
  // Fichiers de l'interface : servis du cache, rafraîchis en arrière-plan
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/app/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const copie = await cache.match(req);
        const maj = actualiser(cache, req).catch(() => copie);
        if (copie) { event.waitUntil(maj); return copie; }
        return maj;
      }),
    );
  }
});
