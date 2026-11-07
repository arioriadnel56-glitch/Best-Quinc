'use strict';
const { HttpError } = require('./http');

const fmt = (n) => new Intl.NumberFormat('fr-FR').format(n).replace(/[\u202f\u00a0]/g, ' ') + ' F CFA';

// Prépare les lignes d'une vente à partir des produits verrouillés en base.
// - Vente en ligne : le prix est celui du serveur, un stock insuffisant ou un produit archivé refuse la vente.
// - Vente hors connexion : la marchandise est déjà remise au client. La vente est enregistrée au prix affiché au client,
//   le stock ne descend jamais sous zéro, et tout écart est noté en « anomalie » pour que le propriétaire vérifie.
function planifierVente(produits, demande, { horsLigne }) {
  const anomalies = [];
  let total = 0;
  const lignes = produits.map((p) => {
    const d = demande.get(p.id);
    let prix = p.prix_vente;
    if (!horsLigne) {
      if (!p.actif) throw new HttpError(400, `« ${p.nom} » est archivé et ne peut plus être vendu.`);
      if (p.quantite_stock < d.qte) throw new HttpError(400, `Stock insuffisant pour « ${p.nom} » : ${p.quantite_stock} disponible(s).`);
    } else {
      if (d.prix !== null && d.prix !== p.prix_vente) {
        anomalies.push(`« ${p.nom} » vendu ${fmt(d.prix)} au lieu de ${fmt(p.prix_vente)} (prix actuel)`);
        prix = d.prix;
      }
      if (!p.actif) anomalies.push(`« ${p.nom} » a été archivé depuis`);
      if (p.quantite_stock < d.qte) anomalies.push(`stock insuffisant pour « ${p.nom} » : ${d.qte} vendu(s), ${p.quantite_stock} en stock`);
    }
    const sousTotal = prix * d.qte;
    total += sousTotal;
    return { produit_id: p.id, nom: p.nom, qte: d.qte, decremente: Math.min(d.qte, p.quantite_stock), prix, sousTotal };
  });
  if (total > 2000000000) throw new HttpError(400, 'Montant de la vente trop élevé.');
  return { lignes, total, anomalies };
}

// Heure de la vente donnée par l'appareil : acceptée si plausible (30 jours en arrière, 10 minutes d'avance au plus)
function heureVente(valeur, maintenant = Date.now()) {
  if (valeur === undefined || valeur === null || valeur === '') return { date: null, anomalie: null };
  const t = Date.parse(valeur);
  if (Number.isFinite(t) && t >= maintenant - 30 * 86400000 && t <= maintenant + 10 * 60000) return { date: new Date(t).toISOString(), anomalie: null };
  return { date: null, anomalie: "heure de l'appareil incohérente : l'heure d'envoi a été retenue" };
}

const texteAnomalie = (liste) => (liste.length ? liste.join(' ; ').slice(0, 500) : null);

module.exports = { planifierVente, heureVente, texteAnomalie };
