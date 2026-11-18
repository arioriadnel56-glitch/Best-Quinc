'use strict';
// Registre de conformité : UNE source de vérité pour ce que la plateforme collecte, stocke dans le navigateur et envoie à des tiers.
// Les pages légales, l'espace Super admin (Conformité) et l'audit automatique lisent tous ce registre.
// Règle : tout nouveau traitement, stockage ou outil tiers DOIT être déclaré ici, sinon l'audit (npm test) échoue.
const fs = require('node:fs');
const path = require('node:path');
const { env } = require('./env');

// Version des textes : à changer dès qu'un texte change sur le fond (les acceptations enregistrées portent cette version)
const VERSIONS = { conditions: '2026-11-15', confidentialite: '2026-11-15', cookies: '2026-11-15', mentions: '2026-11-15', engagements: '2026-11-15' };
const RETENTION_CONNEXIONS_JOURS = 180; // journal de connexion (sécurité) : purge automatique

// ---- Données personnelles traitées (minimisation : rien de plus que ce tableau) ----
const DONNEES = [
  { id: 'compte', donnees: 'Nom complet, adresse e-mail, téléphone (facultatif), rôle ; mot de passe sous forme d\'empreinte irréversible', finalite: 'Créer et sécuriser votre accès', base: 'Exécution du contrat', duree: 'Tant que l\'espace existe' },
  { id: 'entreprise', donnees: 'Nom de l\'entreprise, identifiant de l\'espace ; adresse, ville, IFU, RCCM, site web, logo (facultatifs)', finalite: 'Faire fonctionner votre espace et vos factures', base: 'Exécution du contrat', duree: 'Tant que l\'espace existe' },
  { id: 'metier', donnees: 'Produits, prix, stocks, ventes, factures, crédits, remboursements, inventaires ; nom et téléphone de vos clients si vous les saisissez', finalite: 'Fournir la caisse et la gestion du stock', base: 'Exécution du contrat', duree: 'Tant que l\'espace existe (suppression immédiate à votre demande)' },
  { id: 'abonnement', donnees: 'Formule, montant, dates, état du paiement, référence de transaction (jamais de numéro de carte ni de code Mobile Money)', finalite: 'Gérer l\'abonnement et justifier les paiements', base: 'Exécution du contrat', duree: 'Tant que l\'espace existe' },
  { id: 'connexions', donnees: 'Adresse IP, navigateur (tronqué), adresse e-mail saisie, date, résultat (réussie, échouée, déconnexion)', finalite: 'Détecter les tentatives d\'intrusion et protéger les comptes', base: 'Intérêt légitime (sécurité)', duree: `${RETENTION_CONNEXIONS_JOURS} jours, puis suppression automatique` },
  { id: 'consentements', donnees: 'Conditions et politique acceptées (version, date) ; choix de partage des statistiques', finalite: 'Prouver ce que vous avez accepté et le respecter', base: 'Obligation de pouvoir démontrer le consentement', duree: 'Tant que l\'espace existe (sans adresse IP)' },
  { id: 'limitation', donnees: 'Adresse IP, en mémoire du serveur uniquement', finalite: 'Limiter les essais abusifs de connexion', base: 'Intérêt légitime (sécurité)', duree: 'Quelques minutes, jamais enregistrée durablement' },
  { id: 'partage_stats', donnees: 'Statistiques de ventes de produits partenaires, regroupées avec au moins cinq autres boutiques, sans nom ni coordonnée', finalite: 'Informer les marques partenaires', base: 'Votre consentement (désactivé par défaut, retirable à tout moment)', duree: 'Tant que vous ne retirez pas votre accord' },
];

// ---- Stockage dans le navigateur (aucun cookie n'est déposé par Best-Quinca) ----
// motif : « * » remplace une partie variable (identifiant d'espace…). L'audit compare ces motifs au code réel.
const STOCKAGE = [
  { motif: 'bq:*:token', type: 'localStorage', finalite: 'Garder votre connexion à votre espace', duree: 'Jusqu\'à la déconnexion ou l\'expiration', necessaire: true },
  { motif: 'bq:admin:token', type: 'localStorage', finalite: 'Connexion à l\'administration (personnel de Best-Quinca)', duree: 'Jusqu\'à la déconnexion ou l\'expiration', necessaire: true },
  { motif: 'bq:dernier-espace', type: 'localStorage', finalite: 'Se souvenir du dernier espace ouvert pour vous y ramener', duree: 'Jusqu\'à effacement par vous', necessaire: true },
  { motif: 'bq:*:marque', type: 'localStorage', finalite: 'Afficher le nom et les couleurs de votre entreprise sans attendre le réseau', duree: 'Jusqu\'à effacement par vous', necessaire: true },
  { motif: 'bq-hors-ligne:*', type: 'localStorage', finalite: 'Garder vos ventes saisies sans réseau, puis les envoyer au retour de la connexion', duree: 'Jusqu\'à l\'envoi des ventes', necessaire: true },
  { motif: 'bq:*:code', type: 'sessionStorage', finalite: 'Afficher une seule fois votre code de récupération après l\'inscription', duree: 'Fermeture de l\'onglet', necessaire: true },
  { motif: 'bq:playstore', type: 'sessionStorage', finalite: 'Adapter l\'affichage dans l\'application Android', duree: 'Fermeture de l\'onglet', necessaire: true },
  { motif: 'bq:consentement', type: 'localStorage', finalite: 'Mémoriser votre choix sur cette page (cookies et services tiers)', duree: '6 mois', necessaire: true },
];
const AUTRES_STOCKAGES = [
  { nom: 'IndexedDB « bq-hors-ligne »', finalite: 'Copie de travail hors-ligne (produits, ventes en attente)', duree: 'Jusqu\'à effacement par vous', necessaire: true },
  { nom: 'Cache du service worker', finalite: 'Ouvrir l\'application sans réseau (fichiers de l\'application, jamais de données personnelles)', duree: 'Jusqu\'à mise à jour de l\'application', necessaire: true },
];

// ---- Outils et services tiers (exhaustif) ----
// hotes : domaines contactés ; declencheur : QUAND le navigateur les contacte ; consentement : catégorie du bandeau
const TIERS = [
  { id: 'kkiapay', nom: 'KkiaPay', finalite: 'Encaisser l\'abonnement (Mobile Money, carte)', hotes: ['cdn.kkiapay.me', '*.kkiapay.me'], donnees: 'Montant, adresse e-mail et nom du payeur, référence de paiement ; le moyen de paiement est saisi chez KkiaPay', declencheur: 'Seulement quand vous choisissez de payer avec KkiaPay, après votre autorisation', consentement: 'paiement', site: 'kkiapay.me' },
  { id: 'fedapay', nom: 'FedaPay', finalite: 'Encaisser l\'abonnement (Mobile Money, carte)', hotes: ['cdn.fedapay.com', '*.fedapay.com'], donnees: 'Montant, description de l\'abonnement, référence de paiement ; le moyen de paiement est saisi chez FedaPay', declencheur: 'Seulement quand vous choisissez de payer avec FedaPay, après votre autorisation', consentement: 'paiement', site: 'fedapay.com' },
  { id: 'whatsapp', nom: 'WhatsApp (lien wa.me)', finalite: 'Envoyer une facture ou une commande par message, à votre initiative', hotes: ['wa.me'], donnees: 'Aucune donnée envoyée par Best-Quinca : un lien s\'ouvre dans votre application WhatsApp', declencheur: 'Seulement quand vous touchez « envoyer sur WhatsApp »', consentement: null, site: 'whatsapp.com' },
  { id: 'hebergeur', nom: 'Hébergeur du service et de la base de données', finalite: 'Faire tourner le service pour notre compte (sous-traitant)', hotes: [], donnees: 'Toutes les données de l\'espace, chiffrées en transit (HTTPS)', declencheur: 'En permanence (c\'est le serveur du service)', consentement: null, site: null },
  { id: 'resend', nom: 'Resend (e-mails de relance)', finalite: 'Envoyer les rappels d\'abonnement par e-mail', hotes: ['api.resend.com'], donnees: 'Adresse e-mail et nom de l\'entreprise, texte du rappel ; envoi depuis le serveur, jamais depuis votre navigateur', declencheur: 'Seulement si l\'éditeur active les relances par e-mail', consentement: null, site: 'resend.com' },
];
// Ce que la plateforme n'utilise PAS (vérifié par l'audit : une occurrence fait échouer les tests)
const INTERDITS = ['google-analytics', 'googletagmanager', 'gtag(', 'fbq(', 'connect.facebook', 'hotjar', 'matomo', 'segment.com', 'mixpanel', 'amplitude', 'sentry', 'clarity.ms', 'doubleclick', 'adsbygoogle', 'fonts.googleapis', 'fonts.gstatic', 'cdnjs.cloudflare', 'unpkg.com', 'jsdelivr'];

// ---- Mentions légales : champs fournis par l'éditeur (variables d'environnement) ----
function editeur() {
  const v = (k) => (process.env[k] || '').trim();
  return {
    nom: env.editeurNom, statut: v('EDITEUR_STATUT') || 'Agence Freelance Aloba Tower', adresse: v('EDITEUR_ADRESSE') || 'Porto-Novo', telephone: v('EDITEUR_TELEPHONE'), email: env.contactEmail,
    rccm: v('EDITEUR_RCCM'), ifu: v('EDITEUR_IFU'), directeur: v('DIRECTEUR_PUBLICATION') || env.editeurNom,
    hebergeur: { nom: v('HEBERGEUR_NOM'), adresse: v('HEBERGEUR_ADRESSE'), site: v('HEBERGEUR_SITE') },
  };
}
function mentionsManquantes() {
  const e = editeur();
  const m = [];
  if (!e.statut) m.push(['EDITEUR_STATUT', 'Statut juridique de l\'éditeur (entreprise individuelle, société…)']);
  if (!e.adresse) m.push(['EDITEUR_ADRESSE', 'Adresse de l\'éditeur']);
  if (!e.telephone) m.push(['EDITEUR_TELEPHONE', 'Téléphone de l\'éditeur']);
  if (!e.rccm) m.push(['EDITEUR_RCCM', 'Numéro RCCM (si l\'activité y est immatriculée)']);
  if (!e.ifu) m.push(['EDITEUR_IFU', 'Numéro IFU']);
  if (!e.hebergeur.nom) m.push(['HEBERGEUR_NOM', 'Nom de l\'hébergeur']);
  if (!e.hebergeur.adresse) m.push(['HEBERGEUR_ADRESSE', 'Adresse de l\'hébergeur']);
  return m;
}

// ---- Audit automatique du code (outils tiers, stockage, cookies, promesses) ----
const RACINE = path.join(__dirname, '..', '..');
const lire = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const liste = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)); } catch { return []; } };
const motifVersRegex = (m) => new RegExp('^' + m.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');

// Clé de stockage normalisée d'un appel (« ${x} » → « * »), en résolvant les constantes du même fichier
function clesDeStockage(src) {
  const cles = new Set();
  for (const m of src.matchAll(/(?:local|session)Storage\.\w+Item\(\s*([^,)]+)/g)) {
    let arg = m[1].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
      const d = new RegExp('(?:const|let|var)\\s+' + arg.replace(/\$/g, '\\$') + '\\s*=\\s*([`\'"][^;\\n]*[`\'"])').exec(src);
      if (d) arg = d[1];
    }
    if (/^[`'"]/.test(arg)) {
      // Une constante texte simple du même fichier remplace sa mention dans le gabarit (ex. « ${NOM} »)
      const resolu = arg.slice(1, -1).replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (tout, id) => {
        const d = new RegExp('(?:const|let|var)\\s+' + id.replace(/\$/g, '\\$') + "\\s*=\\s*'([^'$`]*)'").exec(src);
        return d ? d[1] : tout;
      });
      // Un gabarit dont une partie est un appel de fonction (ex. Math.random()) ne peut pas être déclaré : l'audit le signale
      if (/\$\{[^}]*\(/.test(resolu)) cles.add(`?${arg}`);
      else cles.add(resolu.replace(/\$\{[^}]*\}/g, '*'));
    }
    else cles.add(`?${arg}`); // clé impossible à résoudre : l'audit la signale
  }
  return cles;
}

const motsTrompeurs = /(\b100 ?%|garanti[es]?\b|n°\s?1\b|numéro un|le meilleur|la meilleure|les meilleurs|illimité|sans engagement|leader|des milliers|des centaines|ils nous font confiance|avis clients?|témoignages?|★|⭐|\bnote moyenne\b|\d+\s?\/\s?5\b)/i;

function auditer(racine = RACINE) {
  const ecarts = [];
  const assets = liste(path.join(racine, 'public', 'assets'), /\.js$/);
  const modeles = liste(path.join(racine, 'server', 'templates'), /\.(html|js)$/);
  if (!assets.length) return { disponible: false, ok: null, ecarts: [], verifie_le: new Date().toISOString() };
  const fichiers = [...assets, ...modeles].map((p) => ({ p, rel: path.relative(racine, p), src: lire(p) })).filter((f) => f.src !== null);

  // 1. Aucun cookie posé ou lu par le code
  for (const f of fichiers) if (/document\.cookie/.test(f.src)) ecarts.push({ type: 'cookie', fichier: f.rel, detail: 'document.cookie utilisé : déclarez et justifiez ce cookie' });
  for (const f of liste(path.join(racine, 'server'), /\.js$/).concat(liste(path.join(racine, 'server', 'routes'), /\.js$/), liste(path.join(racine, 'server', 'lib'), /\.js$/))) {
    const s = f.endsWith('conformite.js') ? null : lire(f);
    if (s && /set-cookie/i.test(s)) ecarts.push({ type: 'cookie', fichier: path.relative(racine, f), detail: 'En-tête Set-Cookie envoyé : déclarez et justifiez ce cookie' });
  }
  // 2. Aucun outil de mesure ou de publicité
  for (const f of fichiers) for (const mot of INTERDITS) if (f.src.includes(mot)) ecarts.push({ type: 'outil_interdit', fichier: f.rel, detail: `« ${mot} » : outil non déclaré` });
  // 3. Chaque hôte externe du code est déclaré
  const declares = TIERS.flatMap((t) => t.hotes);
  const hoteDeclare = (h) => declares.some((d) => (d.startsWith('*.') ? h === d.slice(2) || h.endsWith(d.slice(1)) : h === d));
  for (const f of fichiers) {
    for (const m of f.src.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      const h = m[1].toLowerCase();
      if (h === 'www.w3.org' || h === 'schema.org' || h.endsWith('.example') || h === 'example.com' || h.endsWith('example.com')) continue;
      if (!hoteDeclare(h)) ecarts.push({ type: 'hote_non_declare', fichier: f.rel, detail: `${h} n'est pas déclaré dans le registre des outils tiers` });
    }
  }
  // 4. Chaque clé de stockage du navigateur est déclarée
  const motifs = STOCKAGE.map((s) => motifVersRegex(s.motif));
  for (const f of fichiers.filter((x) => x.p.endsWith('.js') || x.p.endsWith('.html'))) {
    for (const cle of clesDeStockage(f.src)) {
      if (cle.startsWith('?')) { ecarts.push({ type: 'stockage_non_resolu', fichier: f.rel, detail: `clé non analysable (${cle.slice(1)}) : utilisez une constante déclarée` }); continue; }
      if (!motifs.some((re) => re.test(cle))) ecarts.push({ type: 'stockage_non_declare', fichier: f.rel, detail: `clé « ${cle} » absente du registre de stockage` });
    }
  }
  // 5. La politique de sécurité (CSP) n'ouvre que les hôtes déclarés
  const idx = lire(path.join(racine, 'server', 'index.js')) || '';
  const csp = /const CSP = \[([\s\S]*?)\]\.join/.exec(idx);
  if (csp) {
    for (const m of csp[1].matchAll(/https?:\/\/(\*\.)?([a-z0-9.-]+)/gi)) {
      const h = (m[1] || '') + m[2];
      if (!hoteDeclare(h.replace(/^\*\./, '')) && !declares.includes(h)) ecarts.push({ type: 'csp', fichier: 'server/index.js', detail: `la CSP autorise ${h}, absent du registre` });
    }
    if (/img-src[^"]*\bhttps:(?!\/)/.test(csp[1])) ecarts.push({ type: 'csp', fichier: 'server/index.js', detail: 'img-src autorise toutes les images https : chaque image distante révèle l\'adresse IP du visiteur à un tiers' });
  }
  // 6. Aucun vocabulaire de promesse non prouvée ou de faux avis dans les pages et modèles publics
  for (const f of fichiers.filter((x) => x.rel.startsWith('server/templates') || /(landing|sponsor|consentement)\.js$/.test(x.rel))) {
    const texte = f.src.replace(/<script[\s\S]*?<\/script>/g, ' ');
    const m = motsTrompeurs.exec(texte);
    if (m) ecarts.push({ type: 'promesse', fichier: f.rel, detail: `formulation à justifier ou retirer : « ${m[0]} »` });
  }
  return { disponible: true, ok: ecarts.length === 0, ecarts, verifie_le: new Date().toISOString(), fichiers_analyses: fichiers.length };
}

const RETENTION_CLOTURE_ANS_TEXTE = () => `${env.conservationAns} an${env.conservationAns > 1 ? 's' : ''}`;

module.exports = { RETENTION_CLOTURE_ANS_TEXTE, VERSIONS, RETENTION_CONNEXIONS_JOURS, DONNEES, STOCKAGE, AUTRES_STOCKAGES, TIERS, INTERDITS, editeur, mentionsManquantes, auditer, clesDeStockage, motifVersRegex, motsTrompeurs };
