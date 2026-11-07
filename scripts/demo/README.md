# Vidéo de démonstration (page d'accueil)

La vidéo de la page d'accueil est **enregistrée automatiquement sur la vraie application** : elle se refait en une commande quand l'interface change.

## Refaire la vidéo
1. Lancer le serveur sur une base **de démonstration** (jamais la production) :
   `node scripts/demo/seed.js` crée une quincaillerie fictive (« Quincaillerie Zinsou »), ses produits, ventes, crédits, inventaire, partenaires et un compte super admin de démonstration (variables `DEMO_*` pour adapter). Le serveur doit déjà tourner et le compte super admin exister (`SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` au premier démarrage, identiques à `DEMO_ADMIN_*`).
2. Outils : Python 3, `pip install playwright`, `playwright install chromium`, `ffmpeg`.
3. `python3 scripts/demo/enregistrer-demo.py`
4. Résultat dans `public/assets/video/` : `demo-fr.mp4` (lecture partout), `demo-fr.webm` (repli), `demo-fr-poster.jpg` (image affichée avant la lecture).

Les prix affichés dans la dernière scène sont lus sur le serveur au moment de l'enregistrement : refaites la vidéo si vous changez les tarifs.

## Séquences « créer son espace » et « installer l'application »
La vidéo commence par trois séquences (A : page d'accueil, B : création de l'espace, C : installation PWA), puis enchaîne avec la démonstration de la caisse.
1. Serveur **vierge** (aucun espace « quincaillerie-dossou ») : votre serveur de test, ou, sans PostgreSQL, `TRIAL_DAYS=14 PORT=3100 node scripts/demo/serveur-demo-sans-base.js` (la vraie application avec une base simulée en mémoire).
2. `python3 scripts/demo/enregistrer-creation.py` (variables `DEMO_BASE`, `DEMO_SORTIE`) : remplit le vrai formulaire, crée l'espace, affiche le code de récupération puis simule l'invite d'installation du navigateur (Chrome n'en envoie pas en mode automatique) et l'écran d'accueil d'un téléphone. Résultat : `creation-fr.mp4` (sans son).
3. Assemblage avec ffmpeg : carte de titre + `creation-fr.mp4` + `demo-fr.mp4` à partir de la seconde 5,25 (après son ancienne carte de titre), puis musique et voix.

## Voix
La vidéo livrée contient la musique de fond (elle baisse quand la voix parle) et la voix française sur **toute** la démonstration : séquences A, B, C (accueil, création, installation) puis caisse. `narration-fr.txt` donne les phrases et leur moment exact. Pour changer la voix : enregistrez les phrases dans un fichier audio, coupez-les aux silences et posez chacune à son moment avec ffmpeg (`atrim` puis `adelay`), puis mixez avec la musique (`sidechaincompress` pour baisser la musique sous la voix). Les explications restent aussi écrites à l'écran, pour les téléphones sans son.

## Autre langue
Les légendes sont dans le dictionnaire `T` de `enregistrer-demo.py` (une entrée par langue, `DEMO_LANG=en`). La version anglaise sera réalisable dès que l'interface de la plateforme sera traduite : les captures montrent l'application réelle.
