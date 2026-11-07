# Audit de sécurité — Best-Quinca

Méthode : lecture du code (authentification, paiements, fichiers, front) et 51 attaques automatisées contre le serveur en marche (`test/` + scripts d'attaque). Dépendances : `npm audit` → 0 vulnérabilité.

## Failles trouvées et corrigées

| # | Gravité | Faille | Correction |
|---|---------|--------|------------|
| 1 | **Critique** | Une seule requête non authentifiée (`GET //[`) faisait **planter tout le serveur** (erreur non rattrapée). | Adresse illisible → réponse 400 ; toute erreur est rattrapée, plus aucun arrêt possible ; `unhandledRejection` journalisé. |
| 2 | **Haute** | **Force brute des mots de passe** possible : derrière un proxy, l'adresse IP était lue dans la partie falsifiable de `X-Forwarded-For`, et les limites de tentatives dépendaient de cette adresse. | L'IP est lue à la droite de l'en-tête (celle ajoutée par le proxy, `TRUSTED_PROXY_HOPS`). Ajout d'un plafond **par compte**, indépendant de l'IP : 30 essais / 15 min (connexion), 20 (admin). |
| 3 | **Haute** | Un abonnement pouvait être **obtenu avec la transaction d'un autre client** : le numéro d'une transaction approuvée n'était pas lié à notre paiement. | La transaction doit porter l'identifiant de notre paiement (obligatoire pour FedaPay ; vérifié pour KkiaPay quand l'agrégateur le renvoie). |
| 4 | Moyenne | Aucune politique de sécurité du contenu (CSP) : une injection de script aurait pu voler la session. | CSP stricte : aucun script ni gestionnaire en ligne, seuls nos fichiers et les widgets KkiaPay/FedaPay. Plus `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Strict-Transport-Security` (en HTTPS). |
| 5 | Moyenne | Mots de passe triviaux acceptés (« 12345678 », « motdepasse »…). | Refus des mots de passe courants, répétitifs, tout-chiffres courts, ou contenant l'e-mail/le nom/l'identifiant d'espace (inscription, changement, récupération, équipe). |
| 6 | Basse | Les webhooks publics déclenchaient des appels sortants sans limite. | 120 appels/min par IP. |
| 7 | Basse | `/assets/%zz` et URL mal encodées → erreur 500. | Réponse 404. |
| 8 | Basse | Un `JWT_SECRET` d'exemple était accepté. | Démarrage refusé si le secret contient « change », « exemple », « votre »… |
| 9 | Basse | Pas de délai d'attente des requêtes lentes. | `requestTimeout` 30 s, `headersTimeout` 20 s. |

## Vérifié et sain (aucune faille)
- **Isolation entre quincailleries** : 14 tentatives d'accès croisé (lire/modifier/supprimer ventes, produits, utilisateurs, inventaires, règlements, remboursements d'une autre entreprise) → toutes refusées (404).
- **Droits par rôle** : la secrétaire est refusée sur toutes les actions du propriétaire ; les prix d'achat ne lui sont jamais renvoyés.
- **Jetons** : `alg: none`, charge modifiée, faux secret, jeton entreprise sur route admin et inverse → refusés.
- **Injections SQL** : requêtes paramétrées partout ; payloads classiques sans effet.
- **XSS** : aucun `innerHTML`, `eval` ni script en ligne dans le front.
- **Fichiers** : traversée de dossier, octet nul, encodages piégés → refusés. Images : type vérifié sur les octets, ni SVG ni HTML.
- **Secrets** : clés des agrégateurs chiffrées (AES-256-GCM) ; mots de passe hachés (scrypt) ; temps de réponse constant pour les comptes inconnus.
- **Webhooks** : KkiaPay protégé par secret ; FedaPay re-vérifié auprès de l'API avec la clé secrète.

## Risques restants (à connaître)
1. **KkiaPay** : la liaison transaction ↔ paiement n'est vérifiée que si KkiaPay renvoie `stateData` dans sa réponse. Je n'ai pas pu le confirmer contre leur API réelle ; sinon un avertissement est écrit dans les journaux. À contrôler lors du premier paiement test.
2. Le jeton de session est stocké dans le navigateur (localStorage) : la CSP limite fortement le risque, mais un appareil volé et déverrouillé reste un accès. Les sessions durent 7 jours (12 h pour l'administration) ; changer le mot de passe les ferme toutes.
3. Le plafond par compte peut être utilisé pour **bloquer temporairement** un propriétaire (15 min) en multipliant les mauvais essais. Compromis choisi contre la force brute.
4. Hachage scrypt à N = 16 384 : correct, mais en dessous des recommandations les plus récentes (N = 131 072). Migration possible sans casser les comptes existants.
5. Les widgets de paiement n'ont pas pu être testés en conditions réelles : si l'un d'eux affichait une erreur de politique de sécurité en production, ajoutez ses domaines dans `CSP` (`server/index.js`).
6. Sans `PUBLIC_URL`, les liens de factures reprennent l'en-tête `Host` de la requête. Définissez-le en production.

## Liste de contrôle avant la mise en ligne
- HTTPS obligatoire, `PUBLIC_URL=https://…`, `TRUST_PROXY=true` **seulement** derrière un proxy, `TRUSTED_PROXY_HOPS` adapté.
- Sur **Render** (derrière Cloudflare, qui ne nettoie pas `X-Forwarded-For`) : `TRUSTED_IP_HEADER=cf-connecting-ip` — déjà réglé dans `render.yaml`.
- `JWT_SECRET` aléatoire : `openssl rand -hex 48` (le changer invalide les sessions et les clés chiffrées en base : les ressaisir ensuite).
- Retirer `SUPERADMIN_PASSWORD` du `.env` après le premier démarrage.
- Sauvegardes quotidiennes de PostgreSQL, base non exposée à Internet.
- Mode test KkiaPay/FedaPay désactivé uniquement avec les clés de production.
