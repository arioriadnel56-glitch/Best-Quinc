'use strict';
// Règles communes du module partenaires (sponsors)
const { HttpError, str } = require('./http');

// Nombre minimal de boutiques derrière un chiffre publié à un partenaire : en dessous, on ne publie rien
// (sinon un chiffre « par ville » ou « par produit » pourrait désigner une boutique précise)
const SEUIL_ANONYMAT = 5;

// Partenaire sous contrat à cette date (alias SQL « s »)
const SPONSOR_ACTIF = `s.statut = 'actif' AND (s.debut IS NULL OR s.debut <= CURRENT_DATE) AND (s.fin IS NULL OR s.fin >= CURRENT_DATE)`;
// Offre en cours (alias SQL « o »)
const OFFRE_ACTIVE = 'o.actif AND o.debut <= CURRENT_DATE AND (o.fin IS NULL OR o.fin >= CURRENT_DATE)';

// WhatsApp : chiffres seulement, avec l'indicatif du pays (22997000000)
function telephoneInternational(v) {
  const s = str(v, 'numéro de commande', { optional: true, max: 30 });
  if (s === null) return null;
  const chiffres = s.replace(/[\s.\-()]/g, '').replace(/^\+/, '').replace(/^00/, '');
  // Au moins 10 chiffres : un numéro local à 8 chiffres (sans indicatif) est refusé, WhatsApp ne saurait pas où l'envoyer
  if (!/^[1-9]\d{9,14}$/.test(chiffres)) {
    throw new HttpError(400, 'Le numéro de commande doit contenir l\'indicatif du pays (exemple : 22997000000 pour le Bénin).');
  }
  return chiffres;
}

function dateOptionnelle(v, nom) {
  const s = str(v, nom, { optional: true, max: 10 });
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) {
    throw new HttpError(400, `La date « ${nom} » est invalide (format AAAA-MM-JJ).`);
  }
  return s;
}

function siteWeb(v) {
  const s = str(v, 'site web', { optional: true, max: 150 });
  if (s === null) return null;
  const nu = s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s]*)?$/i.test(nu)) {
    throw new HttpError(400, 'Le site web est invalide (exemple : www.marque.com).');
  }
  return nu;
}

// Texte envoyé au distributeur par WhatsApp
function messageCommande({ entreprise, utilisateur, lignes, note }) {
  const lieu = entreprise.ville ? ` (${entreprise.ville})` : '';
  const contact = [utilisateur, entreprise.telephone].filter(Boolean).join(' — ');
  const corps = lignes.map((l) => `- ${l.nom} : ${l.quantite} ${l.unite}`).join('\n');
  return [
    'Bonjour, commande de réapprovisionnement envoyée depuis Best-Quinca.',
    `Boutique : ${entreprise.nom}${lieu}`,
    `Contact : ${contact}`,
    'Produits demandés :',
    corps,
    note ? `Note : ${note}` : null,
  ].filter(Boolean).join('\n');
}

const lienWhatsapp = (telephone, message) => `https://wa.me/${telephone}?text=${encodeURIComponent(message)}`;

module.exports = { SEUIL_ANONYMAT, SPONSOR_ACTIF, OFFRE_ACTIVE, telephoneInternational, dateOptionnelle, siteWeb, messageCommande, lienWhatsapp };
