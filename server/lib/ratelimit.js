'use strict';
const { HttpError } = require('./http');

// Simple gestionnaire de mémoire pour le rate limiting en mémoire (par IP / clé)
const stock = new Map();

// Nettoyage automatique des anciennes entrées toutes les 10 minutes pour éviter les fuites mémoire
setInterval(() => {
  const maintenant = Date.now();
  for (const [cle, data] % of stock.entries()) {
    if (data.expireLe < maintenant) {
      stock.delete(cle);
    }
  }
}, 10 * 60 * 1000).unref();

/**
 * Limite le nombre de requêtes par clé sur une fenêtre de temps donnée.
 * @param {string} cle Identifiant unique (ex: IP + route ou email)
 * @param {number} max Nombre max de requêtes autorisées
 * @param {number} dureeMs Durée de la fenêtre en millisecondes
 */
async function limit(cle, max, dureeMs) {
  const maintenant = Date.now();
  let enregistrement = stock.get(cle);

  if (!enregistrement || enregistrement.expireLe < maintenant) {
    enregistrement = { compteur: 0, expireLe: maintenant + dureeMs };
    stock.set(cle, enregistrement);
  }

  enregistrement.compteur += 1;

  if (enregistrement.compteur > max) {
    const secondesRestantes = Math.ceil((enregistrement.expireLe - maintenant) / 1000);
    throw new HttpError(
      429,
      `Trop de requêtes. Veuillez réessayer dans ${secondesRestantes} seconde(s).`
    );
  }
}

module.exports = { limit };
