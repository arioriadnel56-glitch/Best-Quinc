# Tests de bout en bout (navigateur réel)

Ces scénarios ont servi à valider l'étape « réveil invisible + hors connexion » dans **Chromium** (Playwright), avec le **vrai serveur Best-Quinca**, une **vraie base PostgreSQL 16** et un simulateur d'hébergeur endormi.
Ils ne remplacent pas un essai sur votre vrai Render/Supabase/Cloudflare (voir `LIVRAISON-ETAPE-1.md`).

## Pièces
- `render-sim.js` : se place devant le serveur (port 3101 → 3100). Modes : `dort` (page d'attente 503 sans CORS, ou connexion laissée en attente), `eveille`, réponse coupée. Journalise chaque requête reçue. Pilotage sur le port 3199.
- `static-server.js <dossier dist>` : émule l'hébergeur statique (règles `_redirects`, en-têtes `_headers` dont la CSP) sur le port 3102. Il n'a aucun accès au backend.
- `lib.py` + `scenario-*.py` : scénarios Playwright (Python).

## Prérequis
PostgreSQL local (les scénarios lisent la base avec `psql -h /tmp -p 5433 -d bq`), `pip install playwright && playwright install chromium`, Node 22.
Les chemins (`/tmp/...`, port 5433) sont ceux de la machine de test : adaptez `lib.py` (fonction `sql`) et les URL en tête des scénarios.

## Lancement (résumé)
1. `API_URL=http://127.0.0.1:3101 SORTIE=/tmp/dist-e2e node scripts/build-frontend.js`
2. API : `PORT=3100 TRIAL_DAYS=30 FRONTEND_ORIGIN=http://127.0.0.1:3102 PUBLIC_URL=http://127.0.0.1:3102 DATABASE_URL=… JWT_SECRET=… node server/index.js`
3. `node scripts/e2e/render-sim.js` puis `node scripts/e2e/static-server.js /tmp/dist-e2e`
4. Dans l'ordre : `scenario-1…`, `scenario-2…`, `scenario-3…`, `scenario-4…`, `scenario-5-6…`
   (le limiteur de tentatives de connexion est en mémoire : redémarrez l'API si trop de connexions de test s'enchaînent).
