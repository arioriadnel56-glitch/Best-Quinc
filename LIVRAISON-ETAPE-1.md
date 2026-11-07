# Livraison — Étape 1 : réveil invisible, 750 h préservées, hors connexion renforcé (v1.8.0)

Périmètre livré : **Parties 2 (A, B, C), 3, 11 (en partie)** de la mission, et le début de la Partie 4. Les Parties 5 (hors ligne complet), 6 et 7 (nouvelle file de synchronisation générale), 8, 9 et 10 restent à faire (section « Reste à faire »).

## 1. Ce qui est fait

**Le visiteur ne voit plus jamais l'écran de Render.**
- Le site (vitrine, application, pages légales, administration, rapport partenaire) est produit en fichiers statiques par `npm run build:frontend` et peut être hébergé gratuitement (Cloudflare Pages). Il s'ouvre sans le serveur.
- Les appels au serveur se font en arrière-plan (CORS réglé par `FRONTEND_ORIGIN`). Un serveur endormi est détecté (coupure, 502/503/504 hors JSON, page HTML à la place du JSON, délai dépassé), jamais simulé : « prêt » veut dire que `/healthz` a répondu `ok` (serveur **et** base).
- Réveil à la demande avec attentes progressives (1, 2, 3, 5, 5, 8, 10, 10, 15, 15, 15, 15 s, soit 13 essais), écran de transition aux couleurs de Best-Quinca, reprise automatique de l'action ; après les essais : message clair + « Réessayer » (+ « Continuer hors connexion » quand c'est possible).
- Liens de factures partagés : relayés par une fonction Cloudflare qui affiche une page Best-Quinca (rechargement automatique) pendant le réveil.
- Service worker réécrit : l'application s'ouvre **d'abord depuis l'appareil**, puis se met à jour derrière (avec délai maximum).
- La connexion et l'application ne font **aucun appel serveur** avant qu'une action l'exige ; la vitrine n'en fait aucun (tarifs écrits dans la page à la construction).

**750 heures.** Plus aucun sondage de 45 s. Aucun ping, aucun cron, aucun `healthCheckPath` dans `render.yaml`. Le temps réel (WebSocket) ne s'ouvre que si l'onglet est visible, le serveur déjà réveillé par une vraie action et l'appareil actif (coupé après 10 min de repos). Mesuré : 35 s sans toucher l'écran = 0 requête.
*À savoir :* 744 h/mois suffisent à faire tourner **un** service Render 24 h/24 ; les 750 h ne sont donc un enjeu que si vous hébergez plusieurs services gratuits sur le même compte.

**Hors connexion / reprise (existant conservé et fiabilisé).** Caisse et ventes fonctionnent sans serveur ; la caisse s'ouvre tout de suite sur la dernière copie des produits ; une vente faite pendant le réveil est gardée sur l'appareil puis envoyée automatiquement une seule fois (clé d'idempotence existante). Reprise plus rapide après une coupure brève (1,5 s au lieu de 30 s, constaté en test).

**Indicateur de connexion** : « Serveur en réveil… », « Hors connexion », « N ventes à envoyer », « Envoi des ventes… », « ventes refusées ».

## 2. Fichiers
**Créés** : `public/assets/reveil.js`, `public/assets/config.js`, `scripts/build-frontend.js`, `functions/f/[[path]].js`, `functions/package.json`, `render.starter.yaml` (ancienne config payante), `DEPLOIEMENT-GRATUIT.md`, `LIVRAISON-ETAPE-1.md`, `scripts/e2e/*`, `test/reveil.test.js`, `test/cors.test.js`, `test/proxy-facture.test.js`, `test/frontend-statique.test.js`.
**Modifiés** : `server/index.js` (CORS, export CSP), `server/lib/env.js` (`FRONTEND_ORIGIN`), `server/lib/realtime.js` (origines WebSocket), `server/templates/{app,landing,admin,sponsor}.html`, `server/templates/sw.template.js`, `public/assets/{app,admin,landing,sponsor,entrer,outils,temps-reel}.js`, `public/assets/style.css`, `render.yaml` (offre Free), `.env.example`, `package.json` (1.8.0, script `build:frontend`), `README.md`, et 3 tests adaptés (`bilans-client`, `page-sponsor`, `serveur`).
**Base de données** : aucune modification. **Dépendances** : aucune ajoutée.

## 3. Tests
**Automatiques** : 232 tests, 232 réussis (187 existants + 45 nouveaux : réveil, CORS, proxy de factures, construction statique, réécritures d'adresses, service worker).

**Navigateur réel** (Chromium), vrai serveur Best-Quinca, PostgreSQL 16 réel, **hébergeur endormi simulé** (le réveil dure 6 à 10 s dans les essais, pas les 30–60 s d'un vrai Render) :

| Situation | Résultat mesuré |
|---|---|
| Nouveau visiteur, serveur endormi | Vitrine en 0,28–0,32 s, **0 requête** reçue par le serveur, 0 erreur console. *Avant (même simulateur) :* la page d'attente de l'hébergeur (« Service Waking Up ») s'affiche en 0,08 s et rien d'autre pendant tout le réveil. |
| Nouvel appareil sur `/app/<espace>/`, serveur endormi | Écran de connexion en 0,32 s, 0 requête. *Avant :* page de l'hébergeur. |
| Visiteur arrivant pendant le réveil | Vitrine en 0,28 s |
| Inscription / connexion pendant le sommeil (2 modes : page 503 ou connexion laissée en attente) | Écran « Votre espace se prépare » après ≈1,5 s ; aboutit seul ; 6,8–7,6 s au total pour un réveil de 6 s ; page de l'hébergeur jamais affichée |
| Réouverture de l'application, serveur endormi | Caisse et produits affichés en 0,41 s ; indicateur « Serveur en réveil… » ; revient à la normale seul |
| Vente serveur endormi | Enregistrée en 0,87 s sur l'appareil, envoyée seule après réveil (12 s), stock cohérent |
| Hors connexion : ouverture, vente, fermeture/réouverture | Ouverture en 0,18 s ; la vente survit à la fermeture ; au retour du réseau envoi en 1 s, une seule fois |
| Réponse perdue (le serveur a enregistré, l'appareil n'a rien reçu) | 1 vente (pas 2), stock décrémenté une fois |
| Deux appareils vendent le dernier article hors connexion | 2 ventes enregistrées chacune une fois, stock 0 (jamais négatif), 1 vente marquée « à vérifier » avec le motif |
| Session refusée par le serveur avec une vente en attente | Retour à la connexion, vente conservée, envoyée une fois après reconnexion |
| Coupure en pleine synchronisation (3 ventes, 2e envoi coupé) | Reprise automatique en 2,7 s, 3 ventes, 0 doublon |
| Déploiement d'une nouvelle version avec une vente en attente | Nouveau cache, ancien supprimé, vente envoyée une fois, nouvelle feuille de style chargée |
| 35 s sans toucher l'écran | 0 requête, 0 connexion temps réel |

Un défaut a été trouvé et corrigé pendant ces essais : après une coupure brève, la reprise attendait 30 s même si le serveur répondait déjà.

## 4. Limites et points non vérifiés
- **Non testé sur de vrais Render / Supabase / Cloudflare Pages.** Les réécritures d'adresses (`_redirects`) et les en-têtes (`_headers`) sont validés par un émulateur, pas par Cloudflare ; la forme exacte de la page d'attente de Render (en-têtes, code) est supposée : la détection couvre les cas courants et les mesures réelles (liste de contrôle, `DEPLOIEMENT-GRATUIT.md` étape 7) la confirmeront.
- **Aucune mesure Core Web Vitals (LCP, INP, CLS), de temps d'API ni de consommation réelle de Render** : elles demandent votre déploiement. Rien n'a été inventé.
- Le navigateur affiche des erreurs « CORS » dans la console pendant un réveil (la réponse de l'hébergeur n'a pas d'en-têtes CORS) : normal, invisible pour l'utilisateur.
- Le nom et l'icône **à l'installation** de l'application sont génériques (« Best-Quinca ») ; le nom, la couleur et le logo de la quincaillerie s'appliquent dans l'application dès qu'ils sont connus (compromis validé).
- Tarifs de la vitrine et pages légales : figés à chaque déploiement Pages.
- Les liens de factures passent par une fonction Cloudflare : le limiteur du serveur (240 vues/min par adresse) voit l'adresse de la fonction pour tous les lecteurs d'une facture.
- Ouvrir l'application avec une session enregistrée réveille le serveur (validation de session) : choix délibéré, modifiable.
- Le limiteur de tentatives de connexion reste en mémoire : il repart à zéro à chaque réveil (observé en test).

## 5. Reste à faire (étapes suivantes)
- **C. Hors ligne complet** : produits (ajout/modification), entrées/sorties/ajustements de stock, clients, règlements et acomptes après coup, opérations de caisse, rapports locaux datés. Nécessite une file générale IndexedDB (type d'opération, identifiant de transaction, statuts, conflits) et `POST /api/sync` avec clés d'idempotence pour **toutes** les opérations (aujourd'hui seules les ventes en ont). Une table additive sera nécessaire (migration après sauvegarde).
- **D.** Écran « Synchronisation » (liste des opérations, journal d'erreurs, reprise manuelle).
- **E.** Performance : compression HTTP, fichiers versionnés à cache long, découpage de `app.js`, images WebP, pagination, index SQL validés par `EXPLAIN`, `statement_timeout`, fusion des 2 requêtes d'authentification.
- **F.** Sécurité : durée du jeton, chiffrement des données locales de clients, limiteur de connexion persistant.
- Mesures avant/après sur votre déploiement réel (Partie 14).

## 6. Variables d'environnement
Nouvelle : `FRONTEND_ORIGIN` (Render). Frontend : `API_URL` (Cloudflare Pages, build + exécution) et les variables listées à l'étape 3 de `DEPLOIEMENT-GRATUIT.md`.

## 7. Retour arrière
Voir `DEPLOIEMENT-GRATUIT.md`, section 8 : le serveur sert toujours lui-même le site si `FRONTEND_ORIGIN` est vide et si le domaine pointe vers lui ; aucune donnée ni table n'a été modifiée.
