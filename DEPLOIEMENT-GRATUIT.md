# Déploiement gratuit : Cloudflare Pages + Render Free + Supabase

Objectif : personne ne voit jamais l'écran technique de Render. Le **site** (vitrine, application, pages légales, administration) est servi par un hébergeur statique qui ne dort jamais ; le **serveur** Render ne se réveille que pour une vraie opération (connexion, envoi de ventes, lecture de données).

```
Navigateur ──► Cloudflare Pages  (site : toujours disponible, mis en cache sur l'appareil)
     │
     └──(appels API, en arrière-plan, avec écran de transition si le serveur dort)──► Render Free ──► Supabase (PostgreSQL)
```

> **À savoir avant de commencer.** Je n'ai pas pu tester sur de vrais comptes Cloudflare / Render / Supabase. La logique a été validée dans Chromium avec un vrai serveur Best-Quinca, une vraie base PostgreSQL et un simulateur d'hébergeur endormi (voir `LIVRAISON-ETAPE-1.md`). Faites la liste de contrôle de l'étape 7 sur vos vrais services.

## 0. Sauvegarde (obligatoire avant tout)
Cette version **ne modifie pas le schéma de la base** : aucune migration, aucune suppression. Faites quand même une sauvegarde complète et vérifiez qu'elle se restaure :
```
pg_dump "<adresse Supabase>" -Fc -f best-quinca-AAAA-MM-JJ.dump
pg_restore --list best-quinca-AAAA-MM-JJ.dump | head      # le fichier doit se lire
```
Conservez aussi la valeur actuelle de `JWT_SECRET` : la changer déconnecte tout le monde et rend illisibles les clés chiffrées.

## 1. Supabase
Tableau de bord → **Connect** → utilisez le **Session pooler** (port 5432 sur l'hôte `…pooler.supabase.com`). Render Free n'a pas d'IPv6 : la « Direct connection » ne fonctionnera pas. Cette adresse devient `DATABASE_URL` sur Render, avec `PGSSL=true`.

## 2. Render (serveur)
1. Blueprint : « New + → Blueprint » sur le dépôt, ou service Web manuel : plan **Free**, build `npm ci --omit=dev`, start `npm start`.
2. **Ne mettez aucun « Health Check Path »** (le fichier `render.yaml` n'en contient pas) : une vérification périodique pourrait empêcher la mise en veille.
3. Variables :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | adresse Supabase (étape 1) |
| `PGSSL` | `true` |
| `PG_POOL_MAX` | `5` |
| `JWT_SECRET` | **la valeur actuelle** (jamais une nouvelle) |
| `TRUST_PROXY`, `TRUSTED_IP_HEADER`, `TRUSTED_PROXY_HOPS` | `true`, `cf-connecting-ip`, `2` |
| `PUBLIC_URL` | adresse du **site** (Cloudflare Pages ou votre domaine), pas celle de Render |
| `FRONTEND_ORIGIN` | la même adresse du site, sans barre finale (plusieurs : séparées par des virgules) |
| `CONTACT_EMAIL`, `EDITEUR_NOM`, `SUBSCRIPTION_*`, `ANDROID_*` | comme avant |

`PUBLIC_URL` et `FRONTEND_ORIGIN` ne sont connues qu'après l'étape 3 : déployez d'abord, renseignez-les ensuite, puis redéployez.

## 3. Cloudflare Pages (site)
1. « Workers & Pages → Create → Pages → Connect to Git », choisissez le dépôt.
2. **Build command** : `npm run build:frontend` — **Build output directory** : `dist` — variable `NODE_VERSION` = `22`.
3. Variables (Production **et** Preview) : `API_URL` = adresse du serveur Render (ex. `https://best-quinca-api.onrender.com`, sans chemin). Reprenez aussi, **à l'identique de Render**, `CONTACT_EMAIL`, `EDITEUR_NOM`, `SUBSCRIPTION_PRICE`, `SUBSCRIPTION_DAYS`, `SUBSCRIPTION_PRICE_ANNUAL`, `SUBSCRIPTION_DAYS_ANNUAL`, `ANDROID_PACKAGE_NAME`, `ANDROID_SHA256_FINGERPRINTS` : les pages légales, les tarifs de la vitrine et `assetlinks.json` sont écrits à la construction.
4. Le dossier `functions/` est détecté automatiquement : il relaie les liens de factures `/f/…` vers le serveur en affichant une page Best-Quinca si le serveur dort. Il lit `API_URL` à l'exécution (même variable).
5. Quand vous changez les tarifs dans `/admin`, l'application les affiche aussitôt, mais la **vitrine** garde l'ancien prix jusqu'au prochain déploiement Pages (mettez à jour les variables `SUBSCRIPTION_*` puis « Retry deployment »).

## 4. Domaine public
Le domaine public doit pointer vers **Cloudflare Pages**, jamais vers Render. ⚠ Si votre domaine actuel pointe vers Render, le changer a deux conséquences : (a) chaque appareil devra se reconnecter (les sessions sont liées à l'adresse du site) ; (b) **les ventes en attente sur un appareil ne peuvent pas passer d'une adresse à l'autre** : faites envoyer toutes les ventes en attente (l'indicateur de connexion ne doit plus afficher « à envoyer ») avant de basculer. Si vous gardez l'adresse `*.pages.dev`, rien de tout cela ne vous concerne.

## 5. Autres services à repointer
- **Webhooks KkiaPay / FedaPay** : ils doivent viser le **serveur** (Render), pas le site. L'écran `/admin → Paramètres` affiche désormais la bonne adresse (celle de l'API).
- **Application Android (Play Store)** : `assetlinks.json` est servi par le site ; l'adresse de départ de l'application doit être celle du site.

## 6. Ce qui a changé pour les utilisateurs
- Ouverture instantanée de l'application, même serveur endormi ou sans internet (après une première visite).
- Ouvrir l'application avec une session enregistrée **réveille le serveur en arrière-plan** (validation de la session). C'est un choix délibéré : le serveur est prêt quand arrive la première vente. Une vente faite pendant le réveil est gardée sur l'appareil et envoyée automatiquement.
- Au repos (10 minutes sans toucher l'écran, ou onglet masqué) le temps réel est coupé et plus aucune requête n'est envoyée : le serveur peut s'endormir.

## 7. Liste de contrôle sur vos vrais services
1. Attendre 20 minutes sans aucune visite, puis ouvrir le site depuis un téléphone qui ne l'a jamais visité : la vitrine s'affiche aussitôt.
2. Ouvrir `https://votre-site/app/<espace>/` : l'écran de connexion s'affiche aussitôt ; se connecter pendant que Render dort : l'écran « Votre espace se prépare » s'affiche puis la connexion aboutit toute seule.
3. Dans les journaux Render, vérifier qu'aucune requête n'arrive quand personne n'utilise l'application, et que le service passe bien en veille.
4. Vente en mode avion, fermeture, réouverture, retour du réseau : la vente est envoyée une seule fois.
5. Ouvrir un lien de facture `https://votre-site/f/…` pendant que Render dort : page Best-Quinca qui se recharge, puis la facture.
6. Installer l'application (Android/iOS) depuis le site et vérifier l'icône et le nom.
7. Noter les durées de réveil réelles (Render affiche en général 30 à 60 s) et le temps affiché par l'écran de transition.

## 8. Retour arrière
- **Site** : dans Cloudflare Pages, « Deployments » → redéployer la version précédente ; ou repointer le domaine vers Render (l'ancien fonctionnement : le serveur sert encore tout seul le site, rien n'a été retiré).
- **Serveur** : redéployer l'ancien commit sur Render. L'ancienne configuration payante est dans `render.starter.yaml`.
- **Base de données** : aucune modification dans cette version, donc rien à restaurer ; la sauvegarde de l'étape 0 reste votre filet de sécurité.
- Retirer `FRONTEND_ORIGIN` désactive le CORS : le serveur revient au fonctionnement « un seul domaine ».
