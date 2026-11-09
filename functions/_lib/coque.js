// Sert la « coque » de l'application (une seule page pour toutes les quincailleries) pour toute adresse /app/<espace>/…
// et /sponsor/<jeton>. Remplace les règles « _redirects », que Cloudflare Pages n'a pas appliquées sur ce projet.
// Aucun appel au serveur Render : tout vient des fichiers du site.

const DUREE_ENTETES = 60;
let entetesCache = null;
let entetesDepuis = 0;

// Réponse d'un fichier du site. Pages renvoie parfois une redirection (« index.html » → « / ») : on la suit en interne.
export async function lireFichier(env, origine, chemin) {
  let url = new URL(chemin, origine);
  for (let i = 0; i < 4; i++) {
    const rep = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
    const suite = rep.headers.get('location');
    if (rep.status >= 300 && rep.status < 400 && suite) { url = new URL(suite, url); continue; }
    return rep;
  }
  return null;
}

// En-têtes de sécurité du site (écrits à la construction dans /_app/entetes.json) : le fichier « _headers » ne s'applique pas aux réponses d'une fonction
async function entetesSecurite(env, origine) {
  if (entetesCache && Date.now() - entetesDepuis < DUREE_ENTETES * 1000) return entetesCache;
  try {
    const rep = await lireFichier(env, origine, '/_app/entetes.json');
    entetesCache = rep && rep.ok ? await rep.json() : {};
  } catch { entetesCache = {}; }
  entetesDepuis = Date.now();
  return entetesCache;
}

export async function introuvable(env, origine) {
  const rep = await lireFichier(env, origine, '/404.html').catch(() => null);
  return new Response(rep && rep.ok ? rep.body : 'Page introuvable', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Envoie le fichier `cible` du site, avec les en-têtes de sécurité et d'éventuels en-têtes particuliers
export async function servir({ request, env, cible, supplementaires = {} }) {
  const origine = new URL(request.url).origin;
  const rep = await lireFichier(env, origine, cible);
  if (!rep || !rep.ok) return introuvable(env, origine);
  const entetes = new Headers(await entetesSecurite(env, origine));
  const type = rep.headers.get('content-type');
  if (type) entetes.set('Content-Type', type);
  entetes.set('Cache-Control', 'no-cache');
  for (const [k, v] of Object.entries(supplementaires)) entetes.set(k, v);
  return new Response(request.method === 'HEAD' ? null : rep.body, { status: 200, headers: entetes });
}

export const refuserMethode = () => new Response('Méthode non autorisée', { status: 405, headers: { Allow: 'GET, HEAD' } });
