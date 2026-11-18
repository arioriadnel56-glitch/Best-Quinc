'use strict';
const { HttpError } = require('./http');

const stock = new Map();

// Nettoyage automatique des anciennes entrées toutes les 10 minutes
setInterval(() => {
  const maintenant = Date.now();
  for (const [cle, data] of stock.entries()) {
    if (data.expireLe < maintenant) {
      stock.delete(cle);
    }
  }
}, 10 * 60 * 1000).unref();

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
