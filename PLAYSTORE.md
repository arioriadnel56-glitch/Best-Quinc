# Publier Best-Quinca sur Google Play

Best-Quinca est une application web installable (PWA). Sur Google Play, elle est publiée sous la forme d'une **application Android « Trusted Web Activity »** : une fenêtre native sans barre d'adresse qui affiche votre site. Toute modification du site est visible immédiatement, sans republier l'application.

> Ce guide ne peut pas être exécuté à votre place : il faut votre compte Google Play (25 USD, une seule fois), votre site déjà en ligne en HTTPS, et la clé de signature qui vous appartient. Les règles de Google évoluent : vérifiez les points marqués ⚠ dans la Play Console avant d'envoyer.

## 1. Avant de commencer
- Le site est **déployé en HTTPS** sur votre domaine (voir `README.md` et `SECURITE.md`), avec `PUBLIC_URL=https://votre-domaine`.
- Ouvrez ces trois adresses dans un navigateur : `/confidentialite`, `/conditions`, `/supprimer-mon-compte` (déjà fournies par la plateforme, à utiliser dans la Play Console).
- Vérifiez `CONTACT_EMAIL` et `EDITEUR_NOM` (variables d'environnement) : ils apparaissent dans les pages légales. Par défaut : arioriadnel56@gmail.com / ARIORI Adnel Adedeji Fulbert.
- Choisissez le **nom de paquet** de l'application, définitif après publication. Exemple : `bj.bestquinca.app` (minuscules, au moins deux parties).

## 2. Créer le compte développeur
1. https://play.google.com/console → créer un compte (25 USD, carte bancaire internationale).
2. Vérification d'identité (pièce d'identité, téléphone, parfois adresse).
3. ⚠ Pour un **compte personnel** créé récemment, Google exige un **test fermé avec au moins 12 testeurs pendant 14 jours** avant d'autoriser la production. Un compte « organisation » n'a pas cette obligation mais demande des justificatifs d'entreprise. Vérifiez la règle en vigueur dans la console.

## 3. Générer l'application (fichier .aab)
Deux voies équivalentes.

**A. PWABuilder (la plus simple, rien à installer)**
1. https://www.pwabuilder.com → saisissez `https://votre-domaine/entrer` → *Package for stores* → *Android*.
2. Renseignez le nom de paquet, le nom « Best-Quinca », laissez PWABuilder générer la clé de signature.
3. Téléchargez l'archive : elle contient le **.aab** et le fichier **keystore** avec ses mots de passe. **Conservez-les en lieu sûr** : perdre la clé = impossible de mettre à jour l'application.

**B. Bubblewrap (ligne de commande)**
```
node scripts/generer-twa.js --domaine votre-domaine.bj --paquet bj.bestquinca.app
cd playstore
npm i -g @bubblewrap/cli
bubblewrap build
```
(Bubblewrap télécharge JDK et SDK Android et vous demande de créer la clé de signature.)

## 4. Relier l'application à votre site (obligatoire)
Sans cela, l'application affiche une barre d'adresse (mode « onglet personnalisé »).
1. Envoyez le .aab dans la Play Console (*Test interne* d'abord) en **activant Play App Signing**.
2. Console → *Configuration* → *Intégrité de l'application* → **Signature d'application** → copiez l'**empreinte SHA-256** du certificat de signature (format `AA:BB:…`). Ajoutez aussi celle de la clé d'envoi si vous testez un fichier signé localement.
3. Sur le serveur, ajoutez puis redéployez :
```
ANDROID_PACKAGE_NAME=bj.bestquinca.app
ANDROID_SHA256_FINGERPRINTS=AA:BB:…:ZZ   # plusieurs empreintes séparées par des virgules
```
4. Contrôlez `https://votre-domaine/.well-known/assetlinks.json` : il doit afficher votre paquet et l'empreinte. Test officiel : `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://votre-domaine&relation=delegate_permission/common.handle_all_urls`

## 5. Fiche du Store (fichiers dans `playstore/`)
| Élément | Valeur |
|---|---|
| Nom (27/30) | Best-Quinca : Quincaillerie |
| Description courte (70/80) | Caisse, stock, crédits clients et inventaire pour votre quincaillerie. |
| Description complète | `playstore/fiche-francais.md` |
| Icône 512×512 | `playstore/icone-512.png` |
| Image de présentation 1024×500 | `playstore/graphique-1024x500.png` |
| Captures téléphone 1080×1920 | `playstore/captures/` (6 écrans, minimum exigé : 2) |
| Catégorie | Entreprise |
| Politique de confidentialité | `https://votre-domaine/confidentialite` |
| Suppression de compte (URL) | `https://votre-domaine/supprimer-mon-compte` |
| E-mail de contact | celui de `CONTACT_EMAIL` |

Remplacez les captures par celles de votre propre boutique de démonstration si vous préférez : 2 à 8 images, côtés entre 320 et 3840 px, rapport 16:9 ou 9:16 au plus.

## 6. Déclarations demandées par la Play Console
- **Accès à l'application** : l'application exige une connexion. Créez un **espace de démonstration** sur votre serveur (un propriétaire et une secrétaire, quelques produits) et offrez-lui un abonnement actif (`/admin` → Entreprises → *Offrir des jours*, 365 par exemple). Donnez l'identifiant de l'espace, l'e-mail et le mot de passe aux relecteurs de Google. **Sans cela, l'application est refusée.**
- **Publicité** : aucune.
- **Public cible** : adultes (18 ans et plus). Pas une application pour enfants.
- **Classification du contenu** (questionnaire IARC) : catégorie « Utilitaire/Productivité », répondre « non » à la violence, au contenu sexuel, aux jeux d'argent, aux drogues, au contenu généré par les utilisateurs partagé publiquement. Résultat attendu : tous publics.
- **Fonctions financières** : l'application n'offre ni prêt, ni portefeuille, ni virement. Elle enregistre des ventes et des crédits **accordés par les commerçants à leurs clients** ; déclarez « aucune fonction financière » sauf si la console vous indique le contraire.
- **Sécurité des données** (proposition à adapter à la réalité) :
  | Donnée | Collectée | Partagée | Finalité | Facultative |
  |---|---|---|---|---|
  | Nom, e-mail | Oui | Non | Fonctionnement, gestion du compte | Non |
  | Numéro de téléphone | Oui | Non (sauf commande de réassort demandée par l'utilisateur) | Fonctionnement | Oui |
  | Historique d'achats / données de vente | Oui | Non | Fonctionnement | Non |
  | Informations de paiement (carte, Mobile Money) | **Non** : saisies chez KkiaPay/FedaPay | — | — | — |
  - Données chiffrées en transit : **oui** (HTTPS).
  - L'utilisateur peut demander la suppression de ses données : **oui**, dans l'application (Profil → Supprimer mon espace) et sur l'URL ci-dessus.
  - Données vendues : non.

## 7. ⚠ Règle des paiements Google (à connaître)
Google impose Google Play Billing pour les contenus et services numériques **achetés dans l'application**. Best-Quinca se paie par KkiaPay et FedaPay.
**Ce que fait déjà l'application Android** : lorsqu'elle est ouverte depuis Google Play, la page *Abonnement* affiche seulement l'état de l'abonnement (« actif jusqu'au… ») et **ne propose aucun paiement, aucun prix, aucun lien de paiement**. L'abonnement s'achète sur le site, dans un navigateur, comme pour les logiciels professionnels (même principe que d'autres applications de gestion d'entreprise).
**Ce que je ne peux pas garantir** : que Google accepte ce fonctionnement. Si la relecture le refuse, l'alternative est d'intégrer Google Play Billing (paiement via le Play Store, avec une commission de Google). Dites-le-moi si cela arrive.
Limite connue : le mode « Play Store » est détecté à l'ouverture de l'application ; dans de rares cas de restauration par Android, la détection peut manquer et la page de paiement normale s'afficherait.

## 8. Publier
1. *Test interne* (immédiat, jusqu'à 100 testeurs) : installez l'application, vérifiez qu'**aucune barre d'adresse** n'apparaît (sinon revoir l'étape 4).
2. *Test fermé* (12 testeurs pendant 14 jours si votre compte l'exige ⚠).
3. *Production* : envoi de la version pour examen (de quelques heures à plusieurs jours).

## 9. Après la publication
- Les modifications de la plateforme (nouvelles fonctions, corrections) sont visibles **tout de suite** dans l'application, sans mise à jour du Store.
- Ne republiez un .aab que pour changer l'icône, le nom ou la configuration Android : augmentez `appVersionCode`, signez avec **la même clé**.
- Gardez la clé de signature et ses mots de passe sauvegardés à deux endroits.

## Liste de contrôle
- [ ] Site en HTTPS, `PUBLIC_URL` défini, sécurité relue (`SECURITE.md`)
- [ ] `/confidentialite`, `/conditions`, `/supprimer-mon-compte` accessibles
- [ ] Compte Play Console vérifié, nom de paquet choisi
- [ ] .aab généré, clé de signature sauvegardée
- [ ] `ANDROID_PACKAGE_NAME` et `ANDROID_SHA256_FINGERPRINTS` configurés, `assetlinks.json` correct
- [ ] Espace de démonstration actif pour les relecteurs
- [ ] Fiche, captures, déclarations, classification, sécurité des données remplies
- [ ] Test interne OK (pas de barre d'adresse), puis test fermé, puis production
