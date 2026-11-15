# Gouvernance à trois administrateurs — Best-Quinca

Trois espaces indépendants, chacun avec son tableau de bord, son menu latéral, ses permissions et son profil :

| Rôle | Adresse | Mission |
|---|---|---|
| `SUPER_ADMIN` | `/admin/super` | Propriétaire : tous les droits, valide les opérations sensibles |
| `FINANCE_ADMIN` | `/admin/finance` | Finances, abonnements, agrégateurs, relances, tarifs, départs |
| `SECURITY_ADMIN` | `/admin/security` | Sécurité **informatique** : accès, sessions, journaux, alertes, rapports |

L'adresse `/admin` reste la page de connexion : après authentification, le serveur renvoie le rôle et l'utilisateur est redirigé vers son espace. Ouvrir l'espace d'un autre rôle renvoie vers le sien — et surtout **chaque appel d'API est contrôlé par le serveur** (le masquage de boutons ne protège rien).

## Mise en service (rien à supprimer, rien à recréer)

1. Déployer. Au démarrage, `server/migrate.js` ajoute les tables et colonnes nécessaires (aucune donnée supprimée) et insère les permissions par défaut.
2. Votre compte administrateur existant devient automatiquement `SUPER_ADMIN`. **Il devra se reconnecter une fois** (les anciens jetons n'ont pas de session).
3. Dans `/admin/super` → *Administrateurs* → *Nouvel administrateur* : créez le compte Finance et le compte Sécurité. Un mot de passe provisoire est affiché **une seule fois** ; son titulaire doit le remplacer à sa première connexion (le serveur bloque tout le reste d'ici là).
4. `npm run superadmin` reste la procédure de secours (rend le compte Super admin actif, débloqué, mot de passe réinitialisé).

## Permissions (RBAC)

- Le Super admin possède toujours toutes les permissions (calculé dans le code, non modifiable).
- Un rôle ne peut détenir que les permissions **de son propre domaine** : impossible d'accorder un droit financier à l'administrateur de sécurité, ni l'inverse — refusé par l'API et ignoré à l'exécution même si la base était modifiée à la main.
- Le Super admin ajuste les permissions de chaque rôle dans *Rôles et permissions* (changement immédiat, journalisé).
- Catalogue : `server/lib/rbac.js`. Toute permission refusée est journalisée et crée une alerte de sécurité.

L'administrateur de sécurité **ne peut jamais** : lire un mot de passe (aucune requête ne les sélectionne), modifier finances, abonnements ou paramètres, supprimer un journal, révoquer une session du Super admin.

## Garde-fous de sécurité (audit)

- **Clés de paiement** : les changer sur un fournisseur **actif** est réservé au Super admin (sinon un administrateur financier pourrait rediriger les encaissements vers son propre compte). Un fournisseur inactif se configure librement ; son activation passe par une demande.
- **Seuil d'engagement** : calculé sur le **cumul des 30 derniers jours** de l'administrateur (impossible de contourner en fractionnant une dépense).
- **Mot de passe provisoire** : le nouveau mot de passe doit être différent de l'ancien ; tant qu'il n'est pas changé, le serveur refuse toute autre action.
- **Dernier Super admin** : la vérification et la modification se font dans une même transaction verrouillée (deux suspensions simultanées ne peuvent pas laisser la plateforme sans Super admin).
- **Départ d'un propriétaire** : revérifié à l'approbation (jamais d'entreprise laissée sans propriétaire actif).
- **Journal** : toute écriture d'administration est tracée, même sans journal dédié ; les refus répétés ne peuvent pas inonder le journal ; l'audit n'est **jamais** purgé. L'historique de connexions est conservé 1 an, les sessions expirées 30 jours.
- **Limites de débit** : connexion, changement de mot de passe, relances, signalements, export, appel planifié.

## Journal d'audit

Table `audit_journal` : acteur, rôle, action, cible, détails (ancien/nouvel état), adresse IP, résultat, date. **Ajout seulement** : un déclencheur PostgreSQL refuse tout `UPDATE`, `DELETE` et `TRUNCATE`, même pour le Super admin. Les secrets (mots de passe, clés, jetons) sont masqués avant écriture. Historique des connexions/déconnexions/échecs dans `connexions_journal`.

## Circuit de validation

L'administrateur financier **prépare**, le Super admin **décide** ; l'effet n'est appliqué qu'à l'approbation (*Demandes à valider*) :
prolongation exceptionnelle · changement de tarif · activation/désactivation d'un fournisseur de paiement · engagement financier ≥ `SEUIL_ENGAGEMENT` sur 12 mois · départ d'un agent (accès révoqués à l'approbation) · résiliation d'entreprise (clôture : compte suspendu, abonnements marqués résiliés, **aucune donnée supprimée**, conservation `CONSERVATION_ANS` ans).

## Agrégateurs de paiement

KkiaPay et FedaPay : opérationnels. Clés **chiffrées** (même mécanisme que les Paramètres), jamais réaffichées. Désactiver un fournisseur bloque les **nouveaux** paiements ; la confirmation d'un paiement déjà engagé reste possible. **CinetPay : clés et URL préparables, mais l'adaptateur de paiement n'est pas encore développé** — il ne peut pas être activé.

## Relances

- Planification automatique : J-7, J-1, J+1, J+7 autour de la fin d'abonnement (sans doublon).
- **E-mail** : via l'API Resend — renseigner `EMAIL_API_KEY` et `EMAIL_FROM`. Sans cela, les relances restent « programmées » (jamais marquées envoyées à tort).
- **WhatsApp** : aucune API intégrée. L'interface prépare un lien `wa.me` avec le message ; l'administrateur l'ouvre lui-même.
- Envoi automatique : toutes les 30 min sur un serveur permanent (Render, Railway). Sur Vercel (sans tâche de fond), appeler `POST /api/cron/relances` avec l'en-tête `x-cron-secret: <CRON_SECRET>` depuis un cron externe.

## Sauvegardes

*Système et sauvegardes* propose un **export JSON** (sans mot de passe ni clé), journalisé. Ce n'est **pas** une sauvegarde de reprise après sinistre : activez aussi les sauvegardes automatiques de votre hébergeur de base de données.

## Variables d'environnement ajoutées (toutes facultatives, voir `.env.example`)

`EMAIL_API_KEY`, `EMAIL_FROM`, `CRON_SECRET`, `RELANCES_AUTO`, `SEUIL_ENGAGEMENT`, `CONSERVATION_ANS`, `CINETPAY_SITE_ID`, `CINETPAY_API_KEY`, `CINETPAY_SECRET_KEY`.

## Tests

`npm test` : `test/gouvernance.test.js` (40 tests) couvre rôles refusés, sessions, redirections, validation des demandes, clés jamais exposées, journal, détection d'alertes, et la cohérence de chaque appel de l'interface avec une route serveur.
