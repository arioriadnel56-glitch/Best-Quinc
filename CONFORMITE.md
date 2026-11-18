# Conformité de la plateforme — ce qui est en place et ce qu'il reste à décider

## En place
- **Pages publiques** : `/mentions-legales`, `/confidentialite`, `/conditions` (CGU + CGV), `/cookies`, `/engagements`. Prix, durée d'essai, données et outils tiers y sont lus dans le code et la configuration : une seule source de vérité (`server/lib/conformite.js`).
- **Bandeau cookies** (`public/assets/consentement.js`) : Tout refuser / Personnaliser / Tout accepter avec le même poids, rien de précoché, choix valable 6 mois, retirable depuis « Gérer mes cookies ». Best-Quinca ne pose aucun cookie ; la seule catégorie facultative est le service de paiement tiers (KkiaPay, FedaPay), chargé uniquement après accord.
- **Consentements** : case d'acceptation à l'inscription (non précochée, refus côté serveur sinon), version et date enregistrées sans adresse IP ; partage de statistiques désactivé par défaut et journalisé ; l'utilisateur voit son historique et accepte une nouvelle version dans l'application ; seul le propriétaire engage l'entreprise.
- **Zéro donnée inutile** : liste exhaustive des données collectées, durées de conservation appliquées automatiquement (connexions : 180 jours ; espaces clôturés : suppression après le délai annoncé).
- **Audit des outils tiers** : automatique (`npm test`, et Administration > Conformité). Il échoue si apparaît un cookie, un outil de suivi, un domaine externe, un stockage navigateur non déclaré, une image https distante ou une formulation de type faux avis / promesse non prouvée.
- **Content Security Policy resserrée** : plus d'image externe autorisée (une image distante révèle l'adresse IP du visiteur à un tiers).

## À faire par vous (je ne peux pas le décider à votre place)
1. **Renseigner les variables** `EDITEUR_*`, `DIRECTEUR_PUBLICATION`, `HEBERGEUR_*` (voir `.env.example`) : tant qu'elles sont vides, la page affiche « Non renseigné ».
2. **Faire relire les textes par un juriste béninois** avant la mise en production. Ils décrivent fidèlement ce que fait le code, mais je ne suis pas juriste : notamment droit applicable et juridiction, délai de réponse aux demandes d'exercice de droits, traitement de la TVA éventuelle dans les prix, politique de remboursement, formalités éventuelles auprès de l'autorité de protection des données (APDP).
3. **Confirmer les engagements commerciaux** écrits dans les conditions : paiement ponctuel sans renouvellement automatique, aucun frais ajouté par Best-Quinca, vérification et correction des erreurs de paiement signalées.
4. À chaque modification de fond d'un texte : changer sa date dans `VERSIONS` (`server/lib/conformite.js`) ; les utilisateurs sont invités à accepter la nouvelle version.
