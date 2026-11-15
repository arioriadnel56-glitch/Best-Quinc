'use strict';
// Facture / reçu d'abonnement Best-Quinca (PDF une page), généré avec le générateur PDF interne.
const { Pdf, L } = require('./pdf');
const { env } = require('./env');

const X = 48;
const NUIT = [0.07, 0.125, 0.17];
const nombre = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)).replace(/[\u202f\u00a0]/g, ' ');
const dateFr = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };

// p : { id, plan, jours, montant, statut, agregateur, reference_transaction, cree_le (YYYY-MM-DD), confirme_le }, e : { nom, email, telephone, ifu }
function documentPdf(type, p, e) {
  const recu = type === 'recu';
  const num = `${recu ? 'REC' : 'FAC'}-${String(p.id).padStart(6, '0')}`;
  const pdf = new Pdf({ titre: `${recu ? 'Reçu' : 'Facture'} ${num}`, auteur: 'Best-Quinca' });
  pdf.rect(0, 0, L, 74, { fond: NUIT });
  pdf.texte(X, 38, 'Best-Quinca', { taille: 21, gras: true, couleur: [1, 1, 1] });
  pdf.texte(X, 57, 'Gestion de quincaillerie', { taille: 10, couleur: [1, 1, 1] });
  pdf.texte(L - X, 38, recu ? 'REÇU DE PAIEMENT' : 'FACTURE', { taille: 14, gras: true, couleur: [1, 0.76, 0.1], align: 'right' });
  pdf.texte(L - X, 57, num, { taille: 10, couleur: [1, 1, 1], align: 'right' });

  let y = 120;
  pdf.texte(X, y, 'Client', { taille: 9, gras: true, couleur: [0.31, 0.37, 0.42] });
  pdf.texte(X, y + 18, e.nom, { taille: 13, gras: true, max: 300 });
  if (e.email) pdf.texte(X, y + 34, e.email, { taille: 10 });
  if (e.telephone) pdf.texte(X, y + 48, e.telephone, { taille: 10 });
  if (e.ifu) pdf.texte(X, y + 62, `IFU : ${e.ifu}`, { taille: 10 });
  pdf.texte(L - X, y, 'Date', { taille: 9, gras: true, couleur: [0.31, 0.37, 0.42], align: 'right' });
  pdf.texte(L - X, y + 18, dateFr(recu && p.confirme_le ? p.confirme_le : p.cree_le), { taille: 12, gras: true, align: 'right' });

  y = 230;
  pdf.rect(X, y, L - 2 * X, 28, { fond: [0.91, 0.925, 0.937] });
  pdf.texte(X + 10, y + 18, 'Désignation', { taille: 10, gras: true });
  pdf.texte(L - X - 10, y + 18, 'Montant', { taille: 10, gras: true, align: 'right' });
  y += 28;
  const designation = `Abonnement Best-Quinca ${p.plan === 'annuel' ? 'annuel' : 'mensuel'}${p.jours ? ` (${p.jours} jours)` : ''}`;
  pdf.texte(X + 10, y + 22, designation, { taille: 11, max: 340 });
  pdf.texte(L - X - 10, y + 22, `${nombre(p.montant)} F CFA`, { taille: 11, align: 'right' });
  pdf.trait(X, y + 36, L - X, y + 36);
  y += 64;
  pdf.texte(L - X - 150, y, 'TOTAL', { taille: 12, gras: true });
  pdf.texte(L - X - 10, y, `${nombre(p.montant)} F CFA`, { taille: 14, gras: true, align: 'right' });

  y += 52;
  const ligne = (k, v) => { pdf.texte(X, y, k, { taille: 9, gras: true, couleur: [0.31, 0.37, 0.42] }); pdf.texte(X + 130, y, v, { taille: 10, max: 330 }); y += 18; };
  const STATUTS = { reussi: 'Payé', en_attente: 'En attente de paiement', echoue: 'Échoué' };
  ligne('Statut', STATUTS[p.statut] || p.statut);
  ligne('Moyen de paiement', p.agregateur === 'fedapay' ? 'FedaPay' : p.agregateur === 'kkiapay' ? 'KkiaPay' : String(p.agregateur));
  if (p.reference_transaction) ligne('Référence transaction', String(p.reference_transaction));

  pdf.trait(X, 760, L - X, 760);
  pdf.texte(X, 780, `${env.editeurNom} — ${env.contactEmail}`, { taille: 9, couleur: [0.31, 0.37, 0.42] });
  pdf.texte(X, 794, recu ? 'Ce reçu atteste du paiement de l\'abonnement indiqué.' : 'Facture émise pour l\'abonnement indiqué.', { taille: 9, couleur: [0.31, 0.37, 0.42] });
  return { buffer: pdf.construire(), nom: `${recu ? 'recu' : 'facture'}-${num}.pdf` };
}

module.exports = { documentPdf };
