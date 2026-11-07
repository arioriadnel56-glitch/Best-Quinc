// Cloudflare Pages Function : liens de factures partagés par WhatsApp (https://<votre-site>/f/<jeton>[/facture.jpg]).
// Ces pages sont produites par le backend (elles contiennent l'aperçu de la facture). Le visiteur ne doit jamais voir l'écran
// technique de l'hébergeur : si le backend dort, on lui montre une page Best-Quinca qui se recharge toute seule pendant le réveil.
// Variables (Pages → Settings → Variables and secrets) : API_URL = adresse du backend, ex. https://best-quinca.onrender.com

const FORMAT = /^\/f\/[A-Za-z0-9_-]{22}(\/(facture|apercu)\.jpg)?$/;
const DELAI_PAR_DEFAUT_MS = 6000;

const pageAttente = (essai) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Best-Quinca — chargement de la facture</title><meta name="robots" content="noindex, nofollow">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.25rem;background:#12202C;color:#fff;font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
main{max-width:26rem}h1{margin:0 0 .5rem;font-size:1.5rem}p{margin:0 0 1.25rem;color:#DCE6EC}
.b{position:relative;height:6px;overflow:hidden;border-radius:99px;background:rgba(255,255,255,.16)}
.b::after{content:"";position:absolute;inset:0 auto 0 0;width:38%;border-radius:99px;background:#FFC21A;animation:m 1.4s ease-in-out infinite}
@keyframes m{from{transform:translateX(-100%)}to{transform:translateX(270%)}}
@media (prefers-reduced-motion:reduce){.b::after{animation:none;width:100%;opacity:.55}}
a.r{display:inline-block;margin-top:1rem;padding:.7rem 1.1rem;background:#FFC21A;color:#12202C;border-radius:6px;text-decoration:none;font-weight:700}
#echec{display:none}
</style></head>
<body><main>
<div id="attente"><h1>Votre facture se prépare</h1><p>Le serveur de Best-Quinca se réveille. La facture s'affichera dans quelques instants.</p><div class="b"></div></div>
<div id="echec"><h1>La facture n'a pas pu être chargée</h1><p>Le serveur ne répond pas pour le moment. Réessayez dans un instant.</p><a class="r" href="">Réessayer</a></div>
</main>
<script>
(function () {
  var essai = ${Number(essai) || 0};
  var delais = [3000, 4000, 5000, 6000, 8000, 10000, 10000, 15000, 15000, 15000];
  if (essai >= delais.length) { document.getElementById('attente').style.display = 'none'; document.getElementById('echec').style.display = 'block'; return; }
  setTimeout(function () {
    var u = new URL(location.href); u.searchParams.set('essai', String(essai + 1)); location.replace(u.toString());
  }, delais[essai]);
})();
</script></body></html>`;

// En-têtes de la réponse du backend que l'on relaie (rien d'autre : pas de Set-Cookie, pas d'en-têtes propres à l'hébergeur)
const RELAYES = ['content-type', 'cache-control', 'x-robots-tag', 'content-length', 'etag', 'last-modified'];

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Méthode non autorisée', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const url = new URL(request.url);
  if (!FORMAT.test(url.pathname)) return new Response('Introuvable', { status: 404 });
  const api = String((env && env.API_URL) || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/i.test(api)) return new Response('API_URL n\'est pas configurée.', { status: 500 });
  const essai = Math.max(0, Math.min(50, parseInt(url.searchParams.get('essai') || '0', 10) || 0));
  const delai = Number((env && env.DELAI_MS) || DELAI_PAR_DEFAUT_MS);

  const attente = () => new Response(pageAttente(essai), {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5', 'X-Robots-Tag': 'noindex, nofollow' },
  });

  let rep;
  try {
    rep = await fetch(api + url.pathname, { method: request.method, headers: { Accept: request.headers.get('Accept') || '*/*' }, redirect: 'manual', signal: AbortSignal.timeout(delai) });
  } catch {
    return attente(); // le backend dort ou ne répond pas dans le délai : page Best-Quinca, jamais l'écran de l'hébergeur
  }
  const type = rep.headers.get('content-type') || '';
  if ([502, 503, 504].includes(rep.status) && !/json/i.test(type)) return attente();
  const entetes = new Headers();
  for (const n of RELAYES) { const v = rep.headers.get(n); if (v) entetes.set(n, v); }
  return new Response(request.method === 'HEAD' ? null : rep.body, { status: rep.status, headers: entetes });
}
