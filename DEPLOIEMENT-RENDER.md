# Déployer Best-Quinca sur Render

Render héberge le serveur (Node.js) et la base de données (PostgreSQL) et fournit le HTTPS. Le fichier `render.yaml` du projet décrit les deux : vous n'avez rien à construire à la main.

> **Ce qui a été vérifié** : le démarrage complet du serveur « façon Render » (base vide, même configuration, installation de production, port 10000, contrôle de santé, création du compte super admin, lecture de l'adresse du visiteur derrière Cloudflare). **Ce qui ne peut l'être que chez Render** : la création réelle des services sur votre compte. Suivez l'étape 4 pour le contrôler.

## Coût indicatif (à vérifier sur render.com/pricing)
| Élément | Offre | Prix indicatif |
|---|---|---|
| Serveur web | Starter (0,5 CPU, 512 Mo, toujours éveillé) | ≈ 7 $ / mois |
| Base PostgreSQL | basic-256mb (sauvegardes quotidiennes conservées 7 jours) | ≈ 6 $ / mois |
| HTTPS, domaine personnalisé | inclus | 0 |

**N'utilisez pas les offres gratuites en production** : le service gratuit s'endort après 15 minutes sans visite (la caisse mettrait 30 à 60 secondes à répondre, le temps réel se coupe) et la base gratuite est **supprimée au bout de 30 jours, sans aucune sauvegarde**.

## 1. Préparer le dépôt GitHub
1. Créez un dépôt **privé** sur GitHub et envoyez-y le contenu du dossier `best-quinca` (le fichier `.env` est déjà exclu par `.gitignore` : ne l'envoyez jamais).
2. Le fichier `render.yaml` doit se trouver à la racine du dépôt.

## 2. Créer les services (Blueprint)
1. Render → **New +** → **Blueprint** → connectez GitHub → choisissez votre dépôt.
2. Render lit `render.yaml` et propose : le service web **best-quinca** et la base **best-quinca-db**, tous deux en région **Francfort** (la plus proche du Bénin ; la base et le serveur doivent être dans la même région).
3. Renseignez les variables demandées :
   | Variable | Valeur |
   |---|---|
   | `SUPERADMIN_EMAIL` | votre e-mail d'administrateur de la plateforme |
   | `SUPERADMIN_PASSWORD` | un mot de passe long (10 caractères minimum), à usage unique : voir étape 5 |
   | `CONTACT_EMAIL`, `EDITEUR_NOM` | contact et nom affichés dans les pages légales |
   | `PUBLIC_URL` | laissez vide pour l'instant (étape 6) |
   | `ANDROID_PACKAGE_NAME`, `ANDROID_SHA256_FINGERPRINTS` | laissez vides (voir `PLAYSTORE.md`) |
4. **Apply**. Le premier déploiement dure quelques minutes. Les tables de la base se créent automatiquement au démarrage.

## 3. Ce que Render configure pour vous
- `JWT_SECRET` : généré automatiquement. **Ne le changez plus** (cela déconnecterait tout le monde et rendrait illisibles les clés de paiement enregistrées).
- `DATABASE_URL` : adresse **interne** de la base (réseau privé, non exposée à Internet).
- `TRUST_PROXY`, `TRUSTED_IP_HEADER=cf-connecting-ip`, `TRUSTED_PROXY_HOPS=2` : Render est placé derrière Cloudflare et **ne nettoie pas** `X-Forwarded-For`. Cet en-tête donne la vraie adresse du visiteur et empêche de contourner la limitation des tentatives de connexion (voir `SECURITE.md`).
- `numInstances: 1` : **gardez une seule instance**. Le temps réel et les compteurs de tentatives vivent dans le processus ; plusieurs instances les désynchroniseraient.
- Contrôle de santé `/healthz` : Render n'envoie le trafic vers une nouvelle version que si la base répond. En cas d'échec, l'ancienne version reste en ligne.

## 4. Vérifier
1. Ouvrez l'adresse du service (`https://best-quinca-….onrender.com`, visible en haut de la page du service) : la page d'accueil s'affiche.
2. `https://…/healthz` doit répondre `{"ok":true}`.
3. `https://…/admin` : connectez-vous avec `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD`.
4. Dans l'onglet **Logs** du service : vous devez lire « Best-Quinca prêt » et aucun avertissement rouge.

## 5. Sécuriser le premier démarrage
Dans **Environment** du service, **supprimez `SUPERADMIN_PASSWORD`** (le compte existe déjà, la variable n'est plus utile et ne doit pas rester en clair).

## 6. Votre propre domaine (recommandé)
1. Service → **Settings** → **Custom Domains** → ajoutez `www.votre-domaine.bj` (ou un sous-domaine) et créez l'enregistrement DNS (CNAME) indiqué chez votre bureau d'enregistrement. Le certificat HTTPS est émis automatiquement.
2. Renseignez `PUBLIC_URL=https://www.votre-domaine.bj` dans **Environment**, puis redéployez. Sans cela, l'adresse `onrender.com` est utilisée dans les liens de factures.

## 7. Paiements et Play Store
1. `/admin` → **Paramètres** : saisissez les clés **de production** KkiaPay et FedaPay, décochez « mode test », puis copiez les adresses de webhook (avec votre domaine) dans chaque tableau de bord d'agrégateur.
2. Application Android : `PLAYSTORE.md` (variables `ANDROID_*` à ajouter dans Environment).

## 8. Sauvegardes
- Render conserve des sauvegardes logiques **7 jours** sur les bases payantes (Dashboard → base → *Recovery*). Aucune sauvegarde sur la base gratuite.
- Faites en plus **une copie hebdomadaire sur votre ordinateur** : base → *Connect* → *External Connection* (autorisez votre adresse IP dans `ipAllowList` le temps de la copie), puis :
  `pg_dump "<adresse externe>" -Fc -f sauvegarde-AAAA-MM-JJ.dump`
- Surveillez l'espace disque de la base (Dashboard → base → *Metrics*) : les factures partagées par WhatsApp sont stockées en base. Au besoin, augmentez `diskSizeGB` dans `render.yaml`.

## 9. Mises à jour
`git push` sur la branche principale → Render reconstruit et redéploie (`autoDeploy: true`). Les nouvelles tables ou colonnes se créent au démarrage. Les utilisateurs ne sont pas déconnectés.

## 10. Dépannage
| Symptôme | Cause probable |
|---|---|
| Le déploiement reste en échec au contrôle de santé | La base ne répond pas : serveur et base dans des régions différentes, ou `DATABASE_URL` écrasée. Lisez les Logs. |
| « no pg_hba.conf entry / SSL required » | Vous utilisez l'adresse **externe** de la base : mettez `PGSSL=true`. |
| Erreur « JWT_SECRET … 32 caractères » | La variable a été remplacée : laissez Render la générer. |
| « Trop de tentatives » pour tout le monde | `TRUSTED_IP_HEADER` supprimé : tous les visiteurs partagent alors une même adresse. Remettez `cf-connecting-ip`. |
| Premier chargement lent après une pause | Vous êtes sur l'offre gratuite (mise en veille). Passez en **Starter**. |
| Temps réel qui se coupe | Plusieurs instances, ou service en veille. Gardez une instance, plan Starter ou supérieur. |

## 9. Version 1.7 : ce qui change à la mise en ligne
- **Rien à faire à la main** : au démarrage, le serveur crée tout seul la table `bilans` (nouvelle page « Bilans » + fiche PDF). Vos entreprises, ventes et abonnements ne sont pas touchés. Gardez `AUTO_MIGRATE` à `true` (valeur par défaut) ; sinon lancez `npm run migrate` une fois.
- **Ne changez pas `JWT_SECRET`** et gardez **une seule instance** (`numInstances: 1`) comme avant.
- **Applications déjà installées** : la version de l'application change (1.7.1), donc chaque téléphone récupère la nouvelle interface au prochain lancement avec internet. Aucune réinstallation.
- **Vidéo de démonstration** : `public/assets/video/` pèse environ 13 Mo (MP4 + WebM). C'est accepté par GitHub (limite 100 Mo par fichier) et servi par morceaux (lecture partielle), donc fluide sur mobile.
- **Contrôle après déploiement** (5 minutes) :
  1. `https://…/healthz` répond `{"ok":true}` ; les journaux disent « Best-Quinca prêt ».
  2. La page d'accueil se charge et la vidéo se lance (le son demande un appui sur lecture).
  3. Créez un espace d'essai : la page de bienvenue propose « Installer ».
  4. Connectez-vous en propriétaire → **Bilans** → « Télécharger la fiche PDF » → ouvrez le PDF → « Enregistrer ce bilan » → « Supprimer » (demande confirmation).
  5. Connectez-vous en secrétaire : le menu **Bilans** ne doit pas apparaître.
