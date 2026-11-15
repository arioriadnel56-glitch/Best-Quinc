'use strict';
const { HttpError } = require('./http');

// Ajoute `jours` à la fin de l'abonnement en cours (abonnement gratuit de 0 F). Utilisé par « Offrir des jours » (Super admin)
// et par la validation d'une prolongation exceptionnelle demandée par l'administrateur financier.
async function offrirJours(q, entrepriseId, jours) {
  const e = await q('SELECT id FROM entreprises WHERE id = $1', [entrepriseId]);
  if (!e.rows.length) throw new HttpError(404, 'Entreprise introuvable.');
  const r = await q(
    `INSERT INTO abonnements (entreprise_id, montant, statut, date_debut, date_fin)
     SELECT $1::int, 0, 'actif', d.debut, d.debut + $2::int
       FROM (SELECT GREATEST(CURRENT_DATE, COALESCE(MAX(date_fin), CURRENT_DATE)) AS debut
               FROM abonnements WHERE entreprise_id = $1::int AND statut = 'actif') d
     RETURNING to_char(date_fin, 'YYYY-MM-DD') AS date_fin`,
    [entrepriseId, jours],
  );
  return r.rows[0].date_fin;
}

module.exports = { offrirJours };
