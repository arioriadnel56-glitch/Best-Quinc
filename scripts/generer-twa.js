#!/usr/bin/env node
'use strict';
// Prépare la configuration de l'application Android (Bubblewrap) pour votre domaine et votre nom de paquet.
// Usage : node scripts/generer-twa.js --domaine bestquinca.exemple.bj --paquet bj.bestquinca.app
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const domaine = String(args.domaine || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const paquet = String(args.paquet || '').trim().toLowerCase();

function erreur(msg) { console.error(`Erreur : ${msg}\nUsage : node scripts/generer-twa.js --domaine bestquinca.exemple.bj --paquet bj.bestquinca.app`); process.exit(1); }
if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domaine)) erreur('domaine invalide (ex. : monsite.bj, sans https://).');
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(paquet)) erreur('nom de paquet invalide (minuscules, au moins deux parties séparées par des points, ex. : bj.bestquinca.app).');

const base = `https://${domaine}`;
const twa = {
  packageId: paquet,
  host: domaine,
  name: 'Best-Quinca',
  launcherName: 'Best-Quinca',
  display: 'standalone',
  orientation: 'default',
  themeColor: '#12202C',
  themeColorDark: '#12202C',
  navigationColor: '#12202C',
  navigationColorDark: '#12202C',
  navigationDividerColor: '#12202C',
  navigationDividerColorDark: '#12202C',
  backgroundColor: '#EEF1F4',
  enableNotifications: false,
  startUrl: '/entrer?source=playstore',
  iconUrl: `${base}/assets/marque/icone-512.png`,
  maskableIconUrl: `${base}/assets/marque/icone-maskable-512.png`,
  splashScreenFadeOutDuration: 300,
  signingKey: { path: './android.keystore', alias: 'bestquinca' },
  appVersionName: '1.0.0',
  appVersionCode: 1,
  shortcuts: [],
  generatorApp: 'bubblewrap-cli',
  webManifestUrl: `${base}/manifest-plateforme.webmanifest`,
  fallbackType: 'customtabs',
  features: {},
  alphaDependencies: { enabled: false },
  enableSiteSettingsShortcut: true,
  isChromeOSOnly: false,
  isMetaQuest: false,
  fullScopeUrl: `${base}/`,
  minSdkVersion: 21,
};
const dossier = path.join(__dirname, '..', 'playstore');
fs.mkdirSync(dossier, { recursive: true });
fs.writeFileSync(path.join(dossier, 'twa-manifest.json'), `${JSON.stringify(twa, null, 2)}\n`);
console.log(`Fichier créé : playstore/twa-manifest.json\n
Étapes suivantes (détail dans PLAYSTORE.md) :
  1. cd playstore && npm i -g @bubblewrap/cli && bubblewrap build   (ou utilisez pwabuilder.com avec ${base})
  2. Après le premier envoi dans la Play Console, copiez l'empreinte SHA-256 de la « clé de signature de l'application »
     et ajoutez dans la configuration du serveur :
       ANDROID_PACKAGE_NAME=${paquet}
       ANDROID_SHA256_FINGERPRINTS=<empreinte SHA-256>
  3. Vérifiez : ${base}/.well-known/assetlinks.json`);
