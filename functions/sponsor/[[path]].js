// /sponsor/<jeton> : rapport partenaire (page unique ; les données sont lues par le navigateur auprès du serveur, avec écran de réveil)
import { servir, introuvable, refuserMethode } from '../_lib/coque.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return refuserMethode();
  const url = new URL(request.url);
  if (!/^\/sponsor\/[A-Za-z0-9_-]{16,100}$/.test(url.pathname)) return introuvable(env, url.origin);
  return servir({
    request, env, cible: '/sponsor/index.html',
    supplementaires: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}
