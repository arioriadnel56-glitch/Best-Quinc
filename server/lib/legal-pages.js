'use strict';
// Pages légales publiques : mentions légales, confidentialité, conditions (CGU/CGV), cookies, engagements.
// Tout ce qui est factuel (prix, durée d'essai, données, outils tiers) vient du code et des paramètres : une seule source de vérité.
const { env } = require('./env');
const c = require('./conformite');

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const fcfa = (n) => new Intl.NumberFormat('fr-FR').format(n).replace(/[\u202f\u00a0]/g, ' ') + ' F CFA';
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const dateLongue = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d === 1 ? '1er' : d} ${MOIS[m - 1]} ${y}`; };

const CSS = `*{box-sizing:border-box}body{margin:0;background:#EEF1F4;color:#1C2A33;font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:#12202C;padding:.7rem 1.2rem}header img{height:3.6rem;width:auto;display:block}
main{max-width:50rem;margin:0 auto;padding:1.4rem 1.2rem 3rem}h1{font-size:1.7rem;line-height:1.2;margin:.4rem 0 .3rem}h2{font-size:1.15rem;margin:1.8rem 0 .4rem;border-left:5px solid #F2B705;padding-left:.6rem}
p,li{color:#2B3B46}li{margin:.25rem 0}a{color:#1F6F78}.maj{color:#5B6B77;font-size:.9rem}
.carte{background:#fff;border:1px solid #D3DAE0;border-radius:12px;padding:1rem 1.2rem;margin:1rem 0}
.defil{overflow-x:auto;margin:.8rem 0}table{border-collapse:collapse;width:100%;background:#fff;font-size:.93rem}th,td{border:1px solid #D3DAE0;padding:.5rem .6rem;text-align:left;vertical-align:top}th{background:#E3E9EE}
.vide{color:#8A5A00;font-weight:600}.ok{color:#1E7A45;font-weight:600}
nav.pied{max-width:50rem;margin:0 auto;padding:0 1.2rem 2.2rem;color:#5B6B77;font-size:.92rem;display:flex;flex-wrap:wrap;gap:.4rem 1.1rem}nav.pied a,nav.pied button{color:#1F6F78;background:none;border:0;padding:0;font:inherit;text-decoration:underline;cursor:pointer}`;

const LIENS = [['/mentions-legales', 'Mentions légales'], ['/confidentialite', 'Confidentialité'], ['/conditions', 'Conditions générales'], ['/cookies', 'Cookies'], ['/engagements', 'Nos engagements'], ['/supprimer-mon-compte', 'Supprimer mon compte']];
const pied = () => `<nav class="pied" aria-label="Informations légales">${LIENS.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}<button type="button" data-gerer-cookies>Gérer mes cookies</button></nav>`;

function page(titre, corps) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titre)} — Best-Quinca</title><meta name="theme-color" content="#12202C"><link rel="icon" href="/favicon.ico"><style>${CSS}</style>
<link rel="stylesheet" href="/assets/consentement.css"></head>
<body><header><a href="/"><img src="/assets/marque/best-quinca-clair.png" alt="Best-Quinca Hardware" width="760" height="632"></a></header>
<main>${corps}</main>${pied()}<script src="/assets/consentement.js" defer></script></body></html>`;
}
const tete = (titre, version) => `<h1>${esc(titre)}</h1><p class="maj">Version du ${esc(dateLongue(version))}</p>`;
const tableau = (entetes, lignes) => `<div class="defil"><table><thead><tr>${entetes.map((e) => `<th scope="col">${esc(e)}</th>`).join('')}</tr></thead><tbody>${lignes.map((l) => `<tr>${l.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const champ = (v) => (v ? esc(v) : '<span class="vide">Non renseigné</span>');

// Tarifs : lus dans les paramètres ; repli sur la configuration d'environnement (vitrine statique sans base de données)
function tarifs(cfg) {
  if (cfg && cfg.plans) return { m: cfg.plans.mensuel, a: cfg.plans.annuel, essai: cfg.essaiJours };
  return { m: { prix: env.price, jours: env.days }, a: { prix: env.priceAnnual, jours: env.daysAnnual }, essai: env.trialDays };
}

function mentions() {
  const e = c.editeur();
  return page('Mentions légales', `${tete('Mentions légales', c.VERSIONS.mentions)}
<h2>Éditeur du service</h2>
<div class="carte"><p><strong>${esc(e.nom)}</strong></p>
<p>Statut : ${champ(e.statut)}<br>Adresse : ${champ(e.adresse)}<br>Téléphone : ${champ(e.telephone)}<br>E-mail : <a href="mailto:${esc(e.email)}">${esc(e.email)}</a><br>N° RCCM : ${champ(e.rccm)}<br>N° IFU : ${champ(e.ifu)}</p>
<p>Directeur de la publication : ${esc(e.directeur)}</p></div>
<h2>Hébergement</h2>
<div class="carte"><p>Nom : ${champ(e.hebergeur.nom)}<br>Adresse : ${champ(e.hebergeur.adresse)}${e.hebergeur.site ? `<br>Site : ${esc(e.hebergeur.site)}` : ''}</p></div>
<h2>Le service</h2><p>Best-Quinca est une application en ligne de gestion pour quincailleries (caisse, stock, ventes, crédits clients, inventaire). Les conditions d'accès et le prix sont décrits dans les <a href="/conditions">conditions générales</a>.</p>
<h2>Propriété intellectuelle</h2><p>Le nom Best-Quinca, le logo, les textes, les images et le code de l'application sont la propriété de l'éditeur, sauf mention contraire. Toute reproduction sans autorisation est interdite. Les polices de caractères sont distribuées sous leurs licences d'origine (<a href="/assets/fonts/LICENCES.txt">voir les licences</a>).</p>
<h2>Données personnelles et cookies</h2><p>Voir la <a href="/confidentialite">politique de confidentialité</a> et la <a href="/cookies">politique cookies</a>.</p>
<h2>Signaler un contenu ou un problème</h2><p>Pour signaler un contenu illicite ou un abus, écrivez à <a href="mailto:${esc(e.email)}">${esc(e.email)}</a> en indiquant l'adresse de la page concernée.</p>
<h2>Droit applicable</h2><p>Le service est régi par le droit béninois.</p>`);
}

function confidentialite() {
  const e = c.editeur();
  const m = esc(e.email);
  const heberg = e.hebergeur.nom ? esc(e.hebergeur.nom) : 'l\'hébergeur indiqué dans les <a href="/mentions-legales">mentions légales</a>';
  return page('Politique de confidentialité', `${tete('Politique de confidentialité', c.VERSIONS.confidentialite)}
<p>Cette page décrit, simplement, ce que Best-Quinca fait de vos données. Elle décrit nos pratiques actuelles ; chaque tableau ci-dessous est généré à partir de la liste que nous tenons à jour dans le code du service.</p>
<h2>Qui est responsable de quoi</h2>
<ul><li><strong>${esc(e.nom)}</strong> (voir les <a href="/mentions-legales">mentions légales</a>) est responsable des données de votre <em>compte</em> et de votre <em>abonnement</em>.</li>
<li>Pour les données de <em>vos</em> clients que vous saisissez (noms, téléphones, ventes), <strong>c'est vous le responsable</strong> ; nous les traitons seulement pour faire fonctionner le service pour vous, sur vos instructions.</li></ul>
<h2>Ce que nous collectons — et rien de plus</h2>
${tableau(['Données', 'Pourquoi', 'Base', 'Durée'], c.DONNEES.map((d) => [esc(d.donnees), esc(d.finalite), esc(d.base), esc(d.duree)]))}
<h2>Ce que nous ne faisons pas</h2>
<ul><li>Nous ne vendons pas vos données et nous ne les louons à personne.</li><li>Pas de publicité, pas de profilage, pas de mesure d'audience, aucun traceur de réseau social.</li><li>Aucun cookie n'est déposé par Best-Quinca (voir la <a href="/cookies">politique cookies</a>).</li><li>Nous ne vous demandons aucune donnée dont le service n'a pas besoin : le téléphone et les informations de facturation de l'entreprise sont facultatifs.</li></ul>
<h2>Vos choix et consentements</h2>
<ul><li><strong>À l'inscription</strong> : vous cochez vous-même (case non cochée par défaut) l'acceptation des conditions et de cette politique. Nous conservons la version acceptée et la date, sans adresse IP.</li>
<li><strong>Partage de statistiques avec les marques partenaires</strong> : désactivé par défaut ; vous l'activez ou le retirez à tout moment dans votre profil. Chaque changement est enregistré.</li>
<li><strong>Services de paiement</strong> : le service de paiement (KkiaPay ou FedaPay) n'est chargé qu'après votre autorisation, au moment de payer.</li>
<li><strong>Retirer un accord</strong> : le lien « Gérer mes cookies » en bas de chaque page ; ou, pour le partage de statistiques, votre profil.</li></ul>
<h2>Avec qui nous partageons des données</h2>
${tableau(['Destinataire', 'Pourquoi', 'Données concernées', 'Quand'], c.TIERS.map((t) => [esc(t.nom), esc(t.finalite), esc(t.donnees), esc(t.declencheur)]))}
<p>Lorsque vous passez une commande de réassort à une marque partenaire, votre nom, votre ville et votre téléphone lui sont transmis, à votre demande.</p>
<h2>Où sont stockées les données</h2><p>Le service est hébergé chez ${heberg}. Selon la région choisie chez l'hébergeur, les données peuvent être stockées hors du Bénin ; la région est précisée dans les mentions légales lorsque nous la connaissons.</p>
<h2>Sécurité</h2><ul><li>Connexion chiffrée (HTTPS) ; mots de passe conservés sous forme d'empreinte irréversible ; clés des services de paiement chiffrées.</li><li>Cloisonnement entre quincailleries : une boutique n'accède jamais aux données d'une autre.</li><li>Accès d'administration du service séparés par rôle, et chaque action d'un administrateur est inscrite dans un journal qui ne peut être ni modifié ni effacé.</li><li>Aucune mesure ne garantit un risque nul : si une atteinte à vos données survenait, nous vous en informerions.</li></ul>
<h2>Vos droits</h2><p>Vous pouvez demander l'accès à vos données, leur correction, leur effacement, vous opposer à un traitement, en demander la limitation ou la copie, conformément à la réglementation applicable au Bénin sur la protection des données personnelles (Code du numérique). Vous pouvez supprimer votre espace vous-même, immédiatement, depuis l'application (<a href="/supprimer-mon-compte">comment faire</a>). Pour tout autre droit : <a href="mailto:${m}">${m}</a>, depuis l'adresse e-mail de votre compte ; nous répondons dans un délai raisonnable.</p>
<h2>Réclamation</h2><p>Si vous estimez que vos droits ne sont pas respectés, vous pouvez vous adresser à l'Autorité de protection des données personnelles du Bénin (APDP), après nous avoir contactés.</p>
<h2>Après la clôture d'un espace</h2><p>Si votre espace est clôturé à la suite d'une résiliation (et non supprimé à votre demande), ses données sont conservées ${c.RETENTION_CLOTURE_ANS_TEXTE()} puis supprimées automatiquement.</p>
<h2>Mineurs</h2><p>Le service est destiné à un usage professionnel et ne s'adresse pas aux mineurs.</p>
<h2>Modifications</h2><p>Quand cette politique change sur le fond, la date de version change, et nous vous en informons dans l'application. Vous pouvez demander les versions précédentes à ${m}.</p>`);
}

function conditions(cfg) {
  const e = c.editeur(); const t = tarifs(cfg); const m = esc(e.email);
  const essai = t.essai > 0
    ? `<p>À la création de votre espace, vous bénéficiez de <strong>${t.essai} jours d'essai gratuit</strong>. Aucun paiement ni moyen de paiement n'est demandé pour créer l'espace. À la fin de l'essai, la caisse et la gestion sont suspendues tant qu'aucun abonnement n'est payé ; <strong>rien n'est prélevé automatiquement</strong>.</p>`
    : '<p>Aucun paiement ni moyen de paiement n\'est demandé pour créer l\'espace. Les fonctions de caisse et de gestion nécessitent un abonnement payé ; <strong>rien n\'est prélevé automatiquement</strong>.</p>';
  return page('Conditions générales d\'utilisation et de vente', `${tete('Conditions générales d\'utilisation et de vente', c.VERSIONS.conditions)}
<p>Le service Best-Quinca est édité par <strong>${esc(e.nom)}</strong> (<a href="/mentions-legales">mentions légales</a>). En créant un espace, vous déclarez avoir lu et accepté ces conditions et la <a href="/confidentialite">politique de confidentialité</a>. Les prix et durées ci-dessous sont lus en direct dans la configuration du service.</p>
<h2>1. Le service</h2><p>Un espace en ligne par quincaillerie : caisse, stock, ventes, crédits clients, remboursements, inventaires, factures. Le propriétaire de l'espace invite ses secrétaires et reste responsable de leurs actions.</p>
<h2>2. Compte</h2><p>Vous fournissez des informations exactes et gardez votre mot de passe et votre code de récupération confidentiels. Vous êtes responsable de l'usage de votre compte.</p>
<h2>3. Essai gratuit</h2>${essai}
<h2>4. Prix et paiement</h2>
${tableau(['Formule', 'Prix', 'Durée'], [['Mensuelle', `<strong>${esc(fcfa(t.m.prix))}</strong>`, `${t.m.jours} jours`], ['Annuelle', `<strong>${esc(fcfa(t.a.prix))}</strong>`, `${t.a.jours} jours`]])}
<ul><li>Le prix affiché est le prix payé à Best-Quinca : nous n'ajoutons ni frais de dossier, ni option obligatoire, ni commission.</li>
<li>Le paiement est <strong>ponctuel</strong> (KkiaPay ou FedaPay) : nous ne conservons aucun moyen de paiement et il n'y a <strong>aucun renouvellement automatique</strong>. Vous renouvelez quand vous le décidez.</li>
<li>Le service de paiement ou votre opérateur peut appliquer ses propres frais. Le montant exact qui sera débité s'affiche dans sa fenêtre de paiement avant que vous ne confirmiez : si ce montant diffère du prix ci-dessus, ne confirmez pas et écrivez-nous.</li>
<li>Un paiement réussi prolonge la période en cours de la durée de la formule choisie. Vous retrouvez chaque paiement dans l'application.</li>
<li>Les prix peuvent changer ; le nouveau prix ne s'applique qu'aux paiements effectués après la modification, jamais à une période déjà payée.</li></ul>
<h2>5. Erreur ou problème de paiement</h2><p>En cas de double débit ou de paiement non pris en compte, écrivez à <a href="mailto:${m}">${m}</a> avec la référence de la transaction : nous la vérifions dans nos enregistrements et la corrigeons si elle est confirmée.</p>
<h2>6. Fin d'abonnement</h2><p>Sans abonnement actif, l'espace reste consultable en lecture ; la caisse et la gestion sont suspendues. Vos données restent conservées et accessibles dès que vous renouvelez.</p>
<h2>7. Vos données</h2><p>Vous restez propriétaire des données de votre quincaillerie. Vous devez avoir le droit de saisir les informations de vos clients. Vous pouvez supprimer votre espace à tout moment, immédiatement (<a href="/supprimer-mon-compte">comment faire</a>).</p>
<h2>8. Usage interdit</h2><p>Activités illégales, tentative d'accès aux données d'une autre boutique, perturbation du service. Nous pouvons suspendre un espace en cas d'usage frauduleux ou d'abus, et nous vous en indiquons la raison.</p>
<h2>9. Disponibilité et responsabilité</h2><p>Nous faisons le maximum pour que le service soit disponible, sans pouvoir le garantir en permanence. Faites des inventaires et des exports réguliers de ce qui est important pour vous. Le service est un outil de gestion : il ne remplace pas votre comptabilité ni vos obligations légales.</p>
<h2>10. Modifications des conditions</h2><p>Quand ces conditions changent sur le fond, la date de version change et nous vous en informons dans l'application. Si vous les refusez, vous pouvez supprimer votre espace.</p>
<h2>11. Droit applicable et contact</h2><p>Droit béninois. Pour toute question ou réclamation : <a href="mailto:${m}">${m}</a>. Nous cherchons d'abord une solution amiable.</p>`);
}

function cookies() {
  return page('Politique cookies', `${tete('Politique cookies et stockage', c.VERSIONS.cookies)}
<p class="carte"><strong>En bref :</strong> Best-Quinca ne dépose <strong>aucun cookie</strong>, n'utilise <strong>aucun outil de mesure d'audience ni de publicité</strong>. Votre navigateur garde seulement ce qui est nécessaire pour vous connecter et travailler sans réseau.</p>
<h2>Ce que le service garde dans votre navigateur</h2>
${tableau(['Élément', 'Type', 'À quoi il sert', 'Durée'], [...c.STOCKAGE.map((s) => [`<code>${esc(s.motif.replace(/\*/g, '…'))}</code>`, esc(s.type), esc(s.finalite), esc(s.duree)]), ...c.AUTRES_STOCKAGES.map((s) => [esc(s.nom), 'Navigateur', esc(s.finalite), esc(s.duree)])])}
<p>Tous ces éléments sont <strong>strictement nécessaires</strong> au service que vous demandez : ils ne demandent pas de consentement. Vous pouvez les effacer à tout moment dans les réglages de votre navigateur (vous serez alors déconnecté).</p>
<h2>Services tiers : seulement si vous payez</h2>
<p>Quand vous choisissez de payer en ligne, le navigateur charge le service de paiement choisi. Ce service est indépendant de Best-Quinca et peut utiliser ses propres cookies ou éléments de stockage, régis par sa propre politique. <strong>Nous ne le chargeons qu'après votre autorisation</strong> :</p>
${tableau(['Service', 'Ce qu\'il reçoit', 'Quand'], c.TIERS.filter((t) => t.consentement === 'paiement').map((t) => [`${esc(t.nom)} (${esc(t.site)})`, esc(t.donnees), esc(t.declencheur)]))}
<h2>Votre choix, simple et réversible</h2>
<ul><li>Le bandeau propose <strong>Tout refuser</strong>, <strong>Tout accepter</strong> et <strong>Personnaliser</strong> avec la même importance. Rien n'est coché d'avance.</li><li>Refuser ne coupe aucune fonction du service, sauf le paiement en ligne tant que vous n'autorisez pas le service de paiement.</li><li>Votre choix est mémorisé 6 mois dans votre navigateur, puis redemandé.</li><li>Changez d'avis quand vous voulez : <button type="button" data-gerer-cookies style="background:none;border:0;padding:0;font:inherit;color:#1F6F78;text-decoration:underline;cursor:pointer">Gérer mes cookies</button>.</li></ul>
<h2>Ce que nous n'utilisons pas</h2><p>Aucun outil de statistiques de fréquentation, aucun pixel publicitaire ou de réseau social, aucune police ou bibliothèque chargée depuis un site tiers (les polices sont hébergées par nous). Cette liste est vérifiée automatiquement à chaque modification du code : voir <a href="/engagements">nos engagements</a>.</p>`);
}

function engagements(cfg) {
  const t = tarifs(cfg);
  const lignes = [
    ['Zéro piège', 'Aucune case précochée ; refuser est aussi simple qu\'accepter ; aucun renouvellement automatique ; la suppression du compte se fait seul, en quelques touches.', 'Le paiement est ponctuel et aucun moyen de paiement n\'est enregistré (<a href="/conditions">conditions, art. 4</a>). La suppression : <a href="/supprimer-mon-compte">procédure</a>.'],
    ['Zéro frais caché', `Le prix affiché (${esc(fcfa(t.m.prix))} pour ${t.m.jours} jours, ${esc(fcfa(t.a.prix))} pour ${t.a.jours} jours) est celui que Best-Quinca encaisse : pas de frais de dossier, pas d'option obligatoire.`, 'Les prix de cette page sont lus dans la configuration du service ; le montant exact débité s\'affiche chez le service de paiement avant votre confirmation.'],
    ['Zéro donnée inutile', 'Seules les données du tableau de la <a href="/confidentialite">politique de confidentialité</a> sont collectées ; le téléphone et les informations de facturation sont facultatifs ; l\'historique de connexion est supprimé automatiquement après ' + c.RETENTION_CONNEXIONS_JOURS + ' jours.', 'La liste est dans le code (registre de conformité) et visible par l\'éditeur dans l\'administration.'],
    ['Zéro outil tiers caché', 'Aucun outil de mesure, de publicité ou de réseau social. Les seuls services tiers sont listés dans la <a href="/confidentialite">politique de confidentialité</a>, et le service de paiement n\'est chargé qu\'après votre autorisation.', 'Un audit automatique analyse le code à chaque version : il échoue si un cookie, un stockage, un domaine externe ou un outil de suivi non déclaré apparaît.'],
    ['Zéro faux avis', 'Nous n\'affichons aucune note, aucun avis, aucun témoignage. Si nous en publions un jour, il sera signé, daté, vérifiable et non rémunéré.', 'L\'audit automatique refuse les mentions de notes, d\'avis et de témoignages dans les pages publiques.'],
    ['Zéro promesse non prouvée', 'Chaque fonction annoncée sur la page d\'accueil existe dans l\'application et se voit dans la démonstration vidéo. Nous ne promettons ni gains, ni disponibilité permanente.', 'Pas de superlatif ni de chiffre d\'usage sur la page d\'accueil ; l\'audit automatique les refuse.'],
    ['Vos données restent les vôtres', 'Pas de revente, pas de publicité ciblée ; le partage de statistiques avec les marques partenaires est désactivé par défaut, retirable à tout moment.', 'Le réglage est dans votre profil ; chaque changement est enregistré.'],
  ];
  return page('Nos engagements', `${tete('Nos engagements, preuves à l\'appui', c.VERSIONS.engagements)}
<p>Un engagement n'a de valeur que si vous pouvez le vérifier. Pour chacun, voici ce qui le rend vérifiable.</p>
${tableau(['Engagement', 'Ce que cela veut dire', 'Comment le vérifier'], lignes.map(([a, b, d]) => [`<strong>${esc(a)}</strong>`, b, d]))}
<h2>Un doute, une erreur ?</h2><p>Si vous trouvez sur le site une phrase que vous ne pouvez pas vérifier, ou un écart avec cette page, écrivez-nous : <a href="mailto:${esc(c.editeur().email)}">${esc(c.editeur().email)}</a>. Nous corrigeons le texte ou la fonction.</p>`);
}

module.exports = { mentions, confidentialite, conditions, cookies, engagements, page, esc, LIENS };
