// /app/<espace>/ : l'application. Chaque espace obtient la même coque ; l'espace est lu dans l'adresse par le navigateur.
import { servir, introuvable, refuserMethode } from '../_lib/coque.js';

const FICHIERS = {
  '/': '/_app/index.html',
  '/sw.js': '/_app/sw.js',
  '/manifest.webmanifest': '/_app/manifest.webmanifest',
  '/icon-192.png': '/assets/marque/icone-192.png',
  '/icon-512.png': '/assets/marque/icone-512.png',
  '/icon-maskable-512.png': '/assets/marque/icone-maskable-512.png',
};

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return refuserMethode();
  const url = new URL(request.url);
  const m = /^\/app\/([a-z0-9-]{3,60})(\/.*)?$/.exec(url.pathname);
  if (!m) return introuvable(env, url.origin);
  if (m[2] === undefined) return new Response(null, { status: 301, headers: { Location: `/app/${m[1]}/${url.search}` } });
  const cible = FICHIERS[m[2]];
  if (!cible) return introuvable(env, url.origin);
  return servir({ request, env, cible, supplementaires: m[2] === '/sw.js' ? { 'Cache-Control': 'no-cache, no-store, must-revalidate' } : {} });
}
