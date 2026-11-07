# Best-Quinca

> **Version 1.8.0 — réveil invisible.** Le site (vitrine + application) peut être hébergé à part, gratuitement, et rester accessible quand le serveur Render dort : voir **DEPLOIEMENT-GRATUIT.md** et **LIVRAISON-ETAPE-1.md**.


Gestion de quincaillerie multi-entreprises : caisse, produits, stock, ventes, équipe, abonnement.
Chaque entreprise a **son espace** et **sa propre application installable (PWA)** sur téléphone ou ordinateur.
Il n'y a plus d'installation Windows : tout passe par le navigateur et la PWA.

- Serveur : Node.js 22 + PostgreSQL (Neon). Une seule dépendance : `pg`. Hébergement prévu : Vercel (fonction serverless) ; fonctionne aussi comme serveur Node classique.
- Interface : HTML/CSS/JS sans étape de compilation (servie par le serveur).
- Abonnement unique : 3 000 F CFA pour 30 jours (réglable dans `.env`).

## Démarrage

```bash
npm install
cp .env.example .env      # puis remplir DATABASE_URL et JWT_SECRET
npm start                 # crée/met à jour les tables automatiquement, puis écoute sur le port 3000
```

Générer `JWT_SECRET` :
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

Ouvrir http://localhost:3000, créer l'espace d'une entreprise : l'application est alors disponible à
`/app/<identifiant>/` (ex. `/app/quincaillerie-zinsou/`).

## La PWA de chaque entreprise

Le serveur génère, par entreprise : le manifeste (`/app/<id>/manifest.webmanifest`), le service worker
(`sw.js`, limité à `/app/<id>/`) et les icônes PNG (initiale + couleur choisies par le propriétaire dans *Réglages*).
Dès la création de l'espace, l'écran de bienvenue propose « Installer ».
Une PWA ne s'installe qu'en **HTTPS** (ou sur `localhost`) : en production, déployez derrière HTTPS (Vercel, Render, Railway, etc. le fournissent).
Sur iPhone : Partager → « Sur l'écran d'accueil ».

## Espace super admin

Adresse : `/admin` (non indexée par les moteurs de recherche). Compte et jeton **totalement séparés** de ceux des entreprises.

**Créer le premier super admin** (au choix) :
- renseigner `SUPERADMIN_EMAIL` et `SUPERADMIN_PASSWORD` (10 caractères minimum) avant le premier démarrage : le compte est créé automatiquement si aucun n'existe ;
- ou lancer `npm run superadmin` avec ces deux variables dans `.env` — cela sert aussi à **récupérer l'accès** (le mot de passe est réinitialisé).
Une fois connecté, retirez `SUPERADMIN_PASSWORD` de la configuration.

**Ce qu'on y trouve** :
- *Vue d'ensemble* : entreprises, abonnements actifs, revenus du mois et des 6 derniers mois.
- *Entreprises* : recherche, suspension/réactivation (une entreprise suspendue ne peut plus se connecter ni ouvrir son application), **offrir des jours** d'abonnement.
- *Paiements* : les 200 derniers, filtrables par état.
- *Paramètres* : **clés API** KkiaPay (publique, privée, **secrète**) et FedaPay (publique, secrète), mode test, adresses de webhook à copier chez chaque agrégateur, prix et durée des formules **mensuelle** et **annuelle**, jours d'essai.
- *Mon compte* : changement de mot de passe.

**Sécurité des clés** : les clés secrètes sont chiffrées (AES-256-GCM) avant d'être écrites en base ; la clé de chiffrement est dérivée de `JWT_SECRET`.
Elles ne sont jamais renvoyées au navigateur (seul un aperçu `••••1234` s'affiche). Laisser un champ de clé vide conserve la clé actuelle.
⚠️ **Ne changez pas `JWT_SECRET` après avoir enregistré des clés** : elles deviendraient illisibles et il faudrait les ressaisir
(changer `JWT_SECRET` déconnecte aussi tous les utilisateurs).
Les valeurs du fichier `.env` ne servent plus que de secours quand rien n'est enregistré dans les Paramètres.

## Abonnement et paiements

- Sans abonnement actif, toutes les fonctions métier répondent « 402 » ; seul le propriétaire accède à la page *Abonnement*.
- Deux formules : **mensuelle 5 000 F CFA / 30 jours** et **annuelle 50 000 F CFA / 365 jours** (soit 10 000 F CFA d'économie). Prix et durées se règlent dans Paramètres. Un paiement réussi ajoute la durée de la formule choisie (à la suite de la période en cours s'il en reste).
- Deux agrégateurs seulement : **KkiaPay** et **FedaPay**.
- Le serveur **vérifie toujours le paiement auprès de l'agrégateur** avant d'activer quoi que ce soit ; une transaction ne peut servir qu'une fois.

### KkiaPay
1. Dans `/admin` → Paramètres, saisir les clés publique, privée et secrète (tableau de bord KkiaPay → Développeurs) et laisser le mode test coché pour les essais.
2. **Avant la mise en production**, validez la liaison : faites un paiement de test dans l'application, notez l'identifiant de transaction, puis
   `node scripts/verifier-kkiapay.js <transactionId>` — il doit afficher « Paiement confirmé ».
3. Webhook (filet de sécurité si le client ferme son navigateur) : copier l'adresse affichée dans Paramètres vers le tableau de bord KkiaPay.

### FedaPay
1. Dans `/admin` → Paramètres, saisir la clé publique (`pk_…`) et la clé secrète (`sk_…`) du tableau de bord FedaPay (Paramètres → Clés API). Laisser le mode test coché pour les essais.
2. La fenêtre de paiement est le widget officiel `checkout.js` ; le serveur redemande ensuite la transaction à l'API FedaPay avec la clé secrète et n'active l'abonnement que si elle est **approuvée** pour le bon montant.
3. Webhook (filet de sécurité si le client ferme son navigateur) : copier l'adresse affichée dans Paramètres vers FedaPay (événement « transaction approuvée »).
4. ⚠️ Cette intégration n'a pas pu être testée contre l'API réelle de FedaPay ici (pas d'accès réseau) : faites un paiement en mode test avant la mise en production.

## Ventes à crédit et remboursements

- **Vente à crédit** : dans la Caisse, mode de paiement « À crédit ». Nom **et** téléphone du client obligatoires ; acompte et date limite facultatifs. La facture indique ce qui est payé et le **reste à payer**. Secrétaire et propriétaire peuvent vendre à crédit et encaisser des règlements.
- **Page Crédits** : toutes les créances non soldées, retards en évidence, bouton « Encaisser » (règlement partiel ou total, plafonné au reste dû) et « Relancer » (WhatsApp).
- **Remboursement** (propriétaire uniquement) : depuis la facture d'une vente → « Rembourser des articles ». On choisit les quantités reprises, le motif, et si le stock est remis. Sur une vente à crédit, la valeur reprise **annule d'abord la dette** du client ; seul le surplus est rendu en argent. Chaque remboursement génère un **avoir** numéroté (AV-00001…) téléchargeable, imprimable, partageable.
- Chaque achat reste facturé : facture n° pour la vente, avoir pour le remboursement. Le tableau de bord affiche les crédits à encaisser et le total remboursé du mois.


## Bilans et fiche PDF (propriétaire)

Menu **Bilans** (réservé au propriétaire : il montre la marge, la valeur du stock et les chiffres de toute l'équipe).
- **Période** : aujourd'hui, hier, 7 derniers jours, ce mois, mois dernier, ou deux dates précises (366 jours maximum). Les jours se comptent dans le fuseau `FUSEAU_HORAIRE` (Africa/Porto-Novo par défaut).
- **Contenu** : nombre de ventes et panier moyen, chiffre d'affaires brut puis net des remboursements, répartition par mode de paiement, **argent encaissé** (ventes comptant + acomptes + règlements de crédits reçus − remboursements rendus), crédits restant à encaisser, marge estimée, produits les plus vendus, ventes par vendeur, détail jour par jour, valeur du stock et produits à réapprovisionner.
- **Fiche PDF** (A4, aux couleurs de l'entreprise, plusieurs pages si besoin) : bouton « Télécharger la fiche PDF » ou « Partager le PDF » (WhatsApp, e-mail…). Le PDF est produit par le serveur sans aucune dépendance supplémentaire (`server/lib/pdf.js`).
- **Enregistrer ce bilan** : conserve un instantané numéroté (n°1, 2…) avec une note, qu'on peut revoir ou retélécharger en PDF plus tard, même si de nouvelles ventes arrivent ensuite.
- La marge est **estimée** avec le prix d'achat actuel des produits. Le bilan est indépendant de la remise à zéro du tableau de bord.

### Ce que l'on peut supprimer (et pourquoi pas le reste)
| Élément | Qui | Règle |
|---|---|---|
| Bilan enregistré | propriétaire | toujours : seul le document disparaît, les ventes ne bougent pas |
| Inventaire | propriétaire | seulement un inventaire **annulé** (un inventaire validé a corrigé le stock : on le garde comme preuve) |
| Compte d'un membre | propriétaire | seulement un compte **déjà désactivé**, jamais le sien ; ses ventes restent (vendeur affiché « Compte supprimé ») |
| Produit, catégorie | propriétaire | déjà existant (archivage du produit, l'historique est conservé) |
| Vente, facture, crédit | personne | jamais supprimés : on passe par un **remboursement** (avoir), pour que la comptabilité reste juste |

Chaque suppression demande une confirmation qui explique ce qui disparaît et ce qui est conservé.

## Mode hors connexion (caisse)

**Principe** : une première visite avec internet suffit. L'application garde alors sur l'appareil la liste des produits (sans les prix d'achat) et la session. Ensuite, même sans réseau, elle s'ouvre et la caisse fonctionne.

**Ce qui marche sans internet** : ouvrir l'application installée, vendre, dessiner la facture en image (télécharger, imprimer, partager l'image), consulter les ventes en attente.
**Ce qui demande internet** : tableau de bord, produits, stock, équipe, abonnement, historique des ventes, paiement KkiaPay, envoi WhatsApp par lien, import CSV. Ces pages l'expliquent clairement et restent grisées dans le menu.

**Fonctionnement d'une vente hors connexion**
- Elle reçoit une référence provisoire (`HL-0001`…) et une facture immédiate. Le stock affiché baisse tout de suite (les ventes en attente sont déduites).
- Le prix et le total sont **figés** à ce que le client a vu. L'heure réelle de la vente est conservée.
- Une pastille « Hors connexion · N à envoyer » reste visible. Dès que le réseau revient, les ventes partent **automatiquement**, de la plus ancienne à la plus récente (aussi toutes les 45 s tant qu'il en reste, et sur le bouton « Envoyer maintenant »).
- **Aucun doublon possible** : chaque vente porte un identifiant unique. Si le réseau lâche après l'enregistrement mais avant la réponse, le renvoi est reconnu par le serveur.
- Le serveur attribue le numéro de facture officiel. La page Ventes montre la correspondance (`HL-0001 → facture n° 00301`) ; l'envoi WhatsApp devient possible à partir de là.

**Écarts entre le moment de la vente et l'envoi** : la vente est toujours enregistrée (la marchandise est partie), mais signalée **« À vérifier »** pour le propriétaire (carte sur le tableau de bord, étiquette dans Ventes, bouton « Marquer comme vérifiée ») quand : le prix a changé depuis, le stock était insuffisant (il ne descend jamais sous zéro), le produit a été archivé, ou l'heure de l'appareil est incohérente.
Une vente **refusée** (produit introuvable) reste visible avec sa raison et n'est jamais renvoyée en boucle ; le propriétaire peut la supprimer.

**Limites à connaître**
- Les ventes non envoyées sont **sur l'appareil** : vider les données du navigateur ou désinstaller l'application les efface. L'application prévient avant une déconnexion s'il en reste.
- Chaque vendeur a sa propre file : les ventes sont enregistrées au nom de la personne connectée qui les a faites.
- Si l'abonnement expire avant l'envoi, les ventes attendent (rien n'est perdu) jusqu'au renouvellement. Hors connexion, l'application bloque la caisse si l'abonnement est terminé d'après la date de l'appareil.
- La session reste valable 7 jours ; au-delà, une reconnexion avec internet est nécessaire (la file est conservée).
- Le numéro de facture hors connexion est provisoire : si vous imprimez la facture avant l'envoi, elle porte la référence `HL-…`.

## Profil de l'entreprise, logo et factures

**Profil** (propriétaire, menu *Profil*) : logo, nom, ville, adresse, téléphone, e-mail, **IFU**, **RCCM**, site web, indicatif téléphonique du pays (229 par défaut) et message de bas de facture.
Le logo est redimensionné par l'application avant l'envoi (PNG, JPEG ou WebP acceptés ; SVG refusé par sécurité). Il apparaît sur les factures, l'écran de connexion, l'en-tête de l'application, et devient l'**icône de l'application installée** (l'entreprise doit réinstaller l'application pour voir la nouvelle icône). *Voir un aperçu de facture* montre le rendu avec le profil actuel.

**Facture** : après chaque vente (et depuis *Ventes*, à tout moment), l'application dessine la facture en **image** : identité de l'entreprise, numéro, date, client, lignes détaillées (désignation, quantité, prix unitaire, montant), total, mode de paiement, bas de facture. On peut la **télécharger**, l'**imprimer**, la **partager** (feuille de partage du téléphone) et l'**envoyer sur WhatsApp**.

**Envoi WhatsApp** : le bouton ouvre la conversation du client (numéro saisi, indicatif de l'entreprise ajouté s'il manque) avec un message prêt et un **lien** vers la facture ; WhatsApp affiche à côté une carte d'aperçu (entreprise, n° de facture, montant) et le client ouvre le lien pour voir la facture complète en image et la télécharger. Il suffit d'appuyer sur « Envoyer ».
Le lien contient un code secret de 128 bits, la page n'est pas indexée par les moteurs de recherche, et une entreprise suspendue n'est plus accessible.
Renseignez `PUBLIC_URL` (ex. `https://votre-domaine`) pour que les liens soient toujours corrects derrière un proxy.

⚠️ **Limite de WhatsApp** : sans l'API officielle *WhatsApp Business* (compte Meta Business, modèles de messages approuvés, facturation par conversation), un site web ne peut pas déposer lui-même une image dans la conversation d'un client sans que l'utilisateur appuie sur « Envoyer ». C'est pourquoi la solution ci-dessus (lien + aperçu, ou partage de l'image) fonctionne dès maintenant, sans compte ni frais. Un envoi 100 % automatique est possible avec l'API WhatsApp Business ; il demande des identifiants Meta propres à chaque entreprise ou à la plateforme.

## Mot de passe oublié (récupération d'accès)

Un mot de passe n'est jamais stocké en clair : personne, pas même vous, ne peut le relire. On le **remplace** par un nouveau. Trois voies :

1. **Le propriétaire, seul** — à la création de l'espace, un **code de récupération** (20 caractères) est affiché une fois. Écran de connexion → « Mot de passe oublié » → e-mail + code → nouveau mot de passe. Le code utilisé est remplacé par un nouveau, à noter. Le propriétaire peut en générer un autre à tout moment dans *Réglages* (avec son mot de passe).
2. **Un secrétaire** — le propriétaire lui donne un nouveau mot de passe dans *Équipe*. Ce mot de passe est provisoire : le secrétaire doit en choisir un à sa prochaine connexion.
3. **Code perdu** — dans l'espace super admin, *Entreprises → Accès* : générer un **mot de passe provisoire** (affiché une seule fois) ou un **nouveau code**. Vérifiez l'identité du demandeur avant (contact de l'entreprise affiché dans la fenêtre).

Sécurité : toute réinitialisation ou tout changement de mot de passe **ferme les sessions ouvertes** ailleurs ; les tentatives de récupération sont limitées (5 par 15 min, 10 par heure et par compte) ; la réponse est la même que le compte existe ou non.
Super admin lui-même : `npm run superadmin` réinitialise son mot de passe (accès au serveur requis).

## Import de produits (CSV)

*Produits → Importer (CSV)* (propriétaire). Depuis Excel : *Enregistrer sous → CSV UTF-8* (ou « CSV séparateur point-virgule »). Les fichiers `.xlsx` ne sont pas lus directement.
Colonnes (titres reconnus avec ou sans accents) : `nom` et `prix_vente` obligatoires ; `reference`, `categorie`, `unite`, `prix_achat`, `stock`, `seuil_alerte` facultatives. Un modèle est téléchargeable dans la fenêtre d'import.
L'application vérifie d'abord le fichier (rien n'est écrit), affiche le compte rendu ligne par ligne, puis importe sur confirmation. Les produits déjà présents (même référence, ou même nom sans référence) sont **ignorés, jamais modifiés** ; les catégories manquantes sont créées ; un stock de départ crée son mouvement d'entrée. Jusqu'à 2 000 produits par fichier.

## Rôles
- **Propriétaire** : tout, y compris prix d'achat, équipe, abonnement, réglages de l'application.
- **Secrétaire** : caisse, consultation des produits, entrées/sorties de stock, ventes. Ne voit ni les prix d'achat ni l'équipe ni l'abonnement.

## Design

Identité « étiquette de rayon » : acier de nuit et jaune de chantier, chiffres en condensé gras comme sur un prix de rayon. La couleur choisie par chaque boutique (Profil) colore ses boutons, bandeaux et graphiques ; le texte posé dessus passe automatiquement en blanc ou en encre pour rester lisible.
- Polices embarquées (Carlito pour le texte, TeX Gyre Heros Cn pour les titres et les chiffres, sous-ensembles latins, licences dans `public/assets/fonts/LICENCES.txt`) : aucune dépendance à un service externe, et elles fonctionnent hors connexion.
- Ordinateur : navigation latérale sombre avec icônes. Téléphone : barre de navigation en bas, comme une application, et barre de panier à la caisse.
- Accessibilité : double anneau de focus visible au clavier, zones tactiles d'au moins 44 px, mouvements réduits respectés, impression propre du rapport partenaire.
- Tout le style est dans `public/assets/style.css` (variables en tête de fichier) ; les icônes dans `public/assets/icones.js`.

## Partenaires (sponsors) : offres, réassort et statistiques

Pour qu'une marque ou un distributeur (quincaillerie, outillage, matériaux…) parraine la plateforme.

**Dans l'espace super admin → onglet Sponsors**
- Créer un partenaire : nom, présentation, site, **WhatsApp pour les commandes** (avec l'indicatif du pays, ex. `22997000000`), dates du contrat, état (actif / suspendu), logo. Hors de ses dates ou suspendu, un partenaire disparaît de l'application.
- **Offres** : titre, détail, période ; pour chacune, le nombre de boutiques qui l'ont vue et qui s'y sont intéressées.
- **Commandes** reçues par le partenaire (là, la boutique est nommée : c'est elle qui a passé commande).
- **Rapport** : une adresse secrète `/sponsor/<48 caractères>` à envoyer au partenaire, sans mot de passe, renouvelable à tout moment (l'ancienne cesse de fonctionner).
- N'ajoutez le nom et le logo d'une marque qu'**avec son accord écrit**.

**Pour les boutiques**
- Menu **Partenaires** : offres en cours, liste des partenaires, historique des commandes. Une offre apparaît aussi sur le tableau de bord, marquée « Sponsorisé ».
- Fiche produit → **Fourni par un partenaire** : quand le stock passe sous le seuil, le produit apparaît dans « À réapprovisionner chez vos partenaires », avec une quantité proposée. Le propriétaire ajuste, puis la commande est enregistrée et s'ouvre dans **WhatsApp** vers le partenaire (nom, ville et téléphone de la boutique inclus, ce qui est indiqué à l'écran).
- Profil → **Partager mes statistiques** : désactivé par défaut. Sans cet accord, les ventes d'une boutique n'entrent dans aucune statistique.

**Rapport du partenaire** (lecture seule) : ventes mensuelles de ses produits, produits les plus vendus, ventes par ville, boutiques en alerte de stock, audience de ses offres, commandes de réassort. **Un chiffre n'est publié que s'il repose sur au moins 5 boutiques différentes ayant donné leur accord** ; en dessous, la page l'indique et ne lit même pas les ventes. Jamais de nom de boutique, de client, de prix d'achat ni de détail de vente.

À prévoir hors du code : un contrat de sponsoring avec chaque partenaire, et vos conditions d'utilisation (traitement et partage anonymisé des statistiques, loi béninoise sur les données personnelles) rédigées par un juriste. La commande passe par WhatsApp : le paiement, la livraison et le suivi se font entre la boutique et le partenaire.

## Temps réel (WebSocket)

L'application se connecte à `/ws` dès l'ouverture d'une session. Quand un appareil de l'entreprise fait une vente, change un produit ou le stock, ou quand un paiement active l'abonnement, les autres appareils sont prévenus aussitôt :
- le **tableau de bord** se rafraîchit seul ;
- **Ventes, Produits, Stock** affichent un bandeau « Actualiser » (jamais de réécriture d'un écran où l'on saisit) ; la **caisse** n'est pas touchée, le serveur vérifie le stock au moment de la vente ;
- le **propriétaire** voit une notification « Nouvelle vente n°… » ;
- le **super admin** voit apparaître les paiements et les nouvelles entreprises ;
- un compte désactivé, un mot de passe changé ou une entreprise suspendue coupent aussitôt les connexions concernées.

Sécurité : le jeton n'est pas dans l'adresse mais envoyé en premier message (10 s pour s'authentifier), l'origine doit être celle du site, 40 connexions par adresse IP et 10 par compte au maximum, messages limités à 16 Ko, et les événements ne contiennent aucune donnée sensible (les détails se relisent via l'API authentifiée). Sans WebSocket (Vercel, ou réseau qui les bloque), l'application fonctionne comme avant, sans temps réel.

Les connexions vivent dans le processus du serveur : **une seule instance** (`numInstances: 1`). Pour en faire tourner plusieurs, il faudrait relayer les événements par Postgres (`LISTEN/NOTIFY` avec la connexion *directe* de Neon, pas le pooler).

## Déploiement sur Render (recommandé)

Tout est décrit dans **[DEPLOIEMENT-RENDER.md](DEPLOIEMENT-RENDER.md)** : le fichier `render.yaml` crée en un clic le serveur (région Francfort) **et** la base PostgreSQL gérée, avec contrôle de santé (`/healthz`), HTTPS automatique et déploiement à chaque `git push`.

Variante avec une base externe Neon : dans `render.yaml`, remplacez la variable `DATABASE_URL` par `sync: false` (chaîne « Pooled connection » de Neon), mettez `PGSSL=true` et supprimez le bloc `databases`.

## Déploiement sur Railway + Neon (avec WebSocket)

Le fichier `railway.json` règle le démarrage (`npm start`), le contrôle de santé, une seule instance et le redémarrage automatique en cas d'arrêt. Railway fournit le port dans `PORT`, que le serveur lit déjà.

1. **Neon** : créer le projet, copier la **Pooled connection** (`…-pooler…?sslmode=require`). Région proche de celle de Railway.
2. **GitHub** : mettre le dossier dans votre dépôt.
3. **Railway** : *New Project → Deploy from GitHub repo*, choisir le dépôt. Le premier déploiement échoue tant que les variables manquent : c'est normal.
4. Onglet **Variables** du service :
   - `DATABASE_URL` : la chaîne Neon ;
   - `JWT_SECRET` : au moins 32 caractères (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) ; gardez l'ancien si vous reprenez des données ;
   - `TRUST_PROXY` = `true` ;
   - `SUPERADMIN_EMAIL` et `SUPERADMIN_PASSWORD` (10 caractères minimum) ;
   - `PUBLIC_URL` = `https://${{RAILWAY_PUBLIC_DOMAIN}}` (ou votre domaine personnalisé).
5. **Settings → Networking → Generate Domain** pour obtenir l'adresse publique, puis *Redeploy*.
6. Ouvrir `https://<votre-domaine>/admin`, se connecter, puis **supprimer `SUPERADMIN_PASSWORD`**.
7. Mettre à jour l'adresse du webhook dans le tableau de bord KkiaPay.

Ne mettez pas de base PostgreSQL Railway en plus : la base est chez Neon. Gardez **une seule réplique** (le temps réel vit dans le processus). Pour contrôler que les WebSocket passent : dans l'application, ouvrez deux appareils sur la même entreprise, faites une vente sur l'un, le propriétaire reçoit « Nouvelle vente n°… » sur l'autre.

## Déploiement sur Vercel + Neon (sans WebSocket)

Vercel ne peut pas garder une connexion ouverte : le temps réel y est désactivé automatiquement.

**1. Base de données Neon**
1. Créer un projet sur https://neon.tech. Région conseillée : **AWS Europe (Frankfurt)** — elle correspond à la région Vercel `fra1` fixée dans `vercel.json` (si vous choisissez une autre région Neon, changez `regions` dans `vercel.json`).
2. Dans *Connect*, cocher **Pooled connection** et copier la chaîne `postgresql://…-pooler…/neondb?sslmode=require`. C'est votre `DATABASE_URL`.

**2. Projet Vercel**
1. Mettre le dossier sur GitHub (le dépôt existant convient), puis *Add New → Project* sur Vercel et importer le dépôt. Aucun réglage de build à changer : `vercel.json` s'en charge.
2. Variables d'environnement (*Settings → Environment Variables*) :
   - `DATABASE_URL` : la chaîne Neon ci-dessus ;
   - `JWT_SECRET` : `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` ;
   - `SUPERADMIN_EMAIL` et `SUPERADMIN_PASSWORD` (10 caractères minimum) pour créer le super admin au premier appel ;
   - `PUBLIC_URL` (facultatif) : l'adresse finale du site, ex. `https://best-quinca.vercel.app`.
3. *Deploy*. Au premier appel, les tables sont créées automatiquement (verrou anti-concurrence). Ouvrir `/admin`, se connecter, **puis supprimer `SUPERADMIN_PASSWORD`** de Vercel et redéployer.
4. KkiaPay : renseigner les clés dans `/admin → Paramètres` et **mettre à jour l'adresse du webhook** dans le tableau de bord KkiaPay (nouvelle adresse Vercel, affichée dans Paramètres).

**Ce qui change par rapport à un serveur classique**
- Chaque requête peut tomber sur une instance différente : la limitation de tentatives (connexion, récupération, etc.) est donc **comptée en base** (table `limites_requetes`) et non plus en mémoire.
- Limites Vercel : corps de requête 4,5 Mo maximum, durée 30 s par requête (réglable dans `vercel.json`).
- Les fichiers de `public/assets` sont servis par le CDN de Vercel ; les pages (`/`, `/admin`, `/app/<id>/`, manifestes, icônes, API) passent par `api/index.js`. Les gabarits HTML sont dans `server/templates/` (et non dans `public/`) pour ne pas être exposés en double.
- Le schéma SQL n'est appliqué que s'il a changé (empreinte enregistrée dans la table `schema_migrations`) : un démarrage à froid ne verrouille donc pas les tables pendant que d'autres instances travaillent.
- Si Neon ou son pooler coupe une connexion pendant la mise en veille de la fonction, les lectures sont rejouées automatiquement et les transactions reprennent sur une connexion neuve.
- `TRUST_PROXY` est activé automatiquement sur Vercel. `AUTO_MIGRATE=false` permet de ne migrer qu'à la main (`DATABASE_URL=… npm run migrate`).

**Reprendre les données de Render** (si l'ancienne base contient déjà des entreprises) :
`pg_dump "<ancienne DATABASE_URL>" --no-owner --no-acl | psql "<DATABASE_URL Neon>"`
Gardez le **même `JWT_SECRET`** que sur Render, sinon les clés KkiaPay enregistrées dans `/admin` seront illisibles (à ressaisir) et tous les utilisateurs seront déconnectés.

**Impossible d'entrer dans `/admin` ?** Dans l'ordre :
1. Les variables ajoutées sur Vercel ne comptent qu'après un **nouveau déploiement** (*Deployments → ⋯ → Redeploy*).
2. Le super admin n'est créé **que si aucun n'existe encore**. Si une première tentative a créé un compte (autre e-mail, autre mot de passe), les nouvelles valeurs sont ignorées. Solution : ajoutez `SUPERADMIN_RESET=true`, redéployez, ouvrez le site une fois, connectez-vous, puis **supprimez `SUPERADMIN_RESET` et `SUPERADMIN_PASSWORD`**.
3. Le mot de passe doit faire **10 caractères minimum**, sans guillemets ajoutés autour de la valeur dans Vercel.
4. Regardez *Logs* sur Vercel : une ligne « Super admin … » dit ce qui s'est passé.
5. Réponse « Service indisponible » : `DATABASE_URL` ou `JWT_SECRET` (32 caractères minimum) manquant ou erroné.

**En local avec Neon** : mettre la chaîne Neon dans `.env` puis `npm start`.
Variables : `DATABASE_URL`, `JWT_SECRET`, `PUBLIC_URL`, `PGSSL=true` si l'hébergeur l'exige sans l'indiquer dans l'URL. Sauvegardez régulièrement la base (Neon conserve un historique de restauration, durée selon l'offre).

## Tests
`npm test` — 150 tests (jetons, mots de passe, routage, manifeste/icônes par entreprise, droits d'accès, abonnement requis, espace super admin, chiffrement des clés, récupération de mot de passe, import CSV, profil, logo, factures partagées, numéros WhatsApp, ventes hors connexion et synchronisation, point d'entrée Vercel, migration par empreinte, reconnexion à la base, limitation de débit en base).
Ils utilisent une base simulée : les requêtes SQL elles-mêmes (dont celle de `limites_requetes`) se vérifient au premier lancement sur votre PostgreSQL / Neon.

Auteur : ARIORI Adnel Adedeji Fulbert — arioriadnel56@gmail.com

## Identité visuelle et fin d'inventaire

- **Logo Best-Quinca Hardware** : fichiers dans `public/assets/marque/` (version pour fonds clairs, version inversée pour les bandeaux sombres, symbole seul, favicon). Il apparaît sur la page d'accueil, dans le menu de l'application, aux écrans de connexion, dans l'administration et sur le rapport partenaire. Chaque quincaillerie garde son propre logo sur ses factures et son application installée.
- **Remise à zéro du tableau de bord** (fin d'inventaire) : bouton « Terminer l'inventaire et remettre le tableau de bord à zéro » en bas du tableau de bord (propriétaire), et bouton « Remettre le tableau à zéro » par entreprise dans `/admin` → Entreprises. Seules les statistiques repartent de la date de remise : ventes du jour et du mois, 7 derniers jours, produits les plus vendus, remboursements du mois. L'historique des ventes, les crédits clients et le stock ne sont jamais supprimés. Chaque remise est journalisée (qui, quand, note) et rappelée en tête du tableau de bord.

## Inventaire (comptage avec la secrétaire)

- Menu **Inventaire**. Le propriétaire démarre un inventaire : la liste des produits actifs est figée. Le propriétaire **et** la secrétaire saisissent les quantités comptées, chacun sur son téléphone, en même temps.
- **Comptage à l'aveugle** : tant que l'inventaire est en cours, la secrétaire ne voit pas le stock théorique ni les écarts. Le propriétaire voit pour chaque produit le théorique, le compté, l'écart et sa valeur au prix d'achat.
- **Validation** (propriétaire uniquement) : le stock de chaque produit compté devient la quantité comptée. Les ventes faites après le comptage d'un produit restent déduites. Chaque correction est écrite dans l'historique du stock (« Inventaire n°N : compté X, théorique Y »). Les produits non comptés ne sont pas modifiés.
- À la validation, une case permet de **remettre le tableau de bord à zéro** (cochée par défaut). On peut aussi annuler un inventaire : le stock reste intact.
- Les inventaires terminés restent consultables (rapport avec écarts). Un seul inventaire peut être en cours à la fois par entreprise.

## Sécurité

Voir [SECURITE.md](SECURITE.md) : audit réalisé, failles corrigées, risques restants et liste de contrôle avant la mise en ligne.

## Google Play

Voir [PLAYSTORE.md](PLAYSTORE.md) : publication pas à pas, fiche du Store (`playstore/`), déclarations, règle des paiements et liste de contrôle. Variables : `ANDROID_PACKAGE_NAME`, `ANDROID_SHA256_FINGERPRINTS`, `CONTACT_EMAIL`, `EDITEUR_NOM`.

## Vidéo de démonstration

La page d'accueil présente une vidéo de 2 minutes (`public/assets/video/`), chargée seulement quand le visiteur appuie sur lecture (économie de données mobiles). Elle est enregistrée automatiquement sur la vraie application : voir [scripts/demo/README.md](scripts/demo/README.md) pour la refaire après un changement d'interface, ajouter une voix, ou préparer une autre langue.
