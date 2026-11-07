'use strict';
// Point d'entrée Vercel : toutes les requêtes dynamiques (voir vercel.json) arrivent ici.
const { handle } = require('../server');
const { ensureReady } = require('../server/boot');
const { json } = require('../server/lib/http');

module.exports = async (req, res) => {
  try {
    await ensureReady();
  } catch (err) {
    console.error('Démarrage impossible :', err.message);
    return json(res, 503, { erreur: 'Service indisponible : vérifiez DATABASE_URL et JWT_SECRET (voir les logs Vercel).' });
  }
  return handle(req, res);
};
