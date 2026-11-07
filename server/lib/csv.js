'use strict';
const { HttpError } = require('./http');

const MAX_LIGNES = 2000;

// Séparateur le plus fréquent hors guillemets sur la première ligne : « ; » (Excel en français), « , » ou tabulation
function detecterSeparateur(texte) {
  const premiere = texte.split(/\r?\n/, 1)[0] || '';
  const c = { ';': 0, ',': 0, '\t': 0 };
  let guillemets = false;
  for (const ch of premiere) {
    if (ch === '"') guillemets = !guillemets;
    else if (!guillemets && ch in c) c[ch] += 1;
  }
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][1] === 0 ? ';' : Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}

// Analyse CSV (RFC 4180) : guillemets, guillemets doublés, retours à la ligne dans un champ.
// Renvoie [{ no, cases: [...] }] où `no` est la ligne du fichier où commence l'enregistrement.
function lireCsv(texte) {
  const t = texte.replace(/^\uFEFF/, '');
  const sep = detecterSeparateur(t);
  const lignes = [];
  let cases = [];
  let champ = '';
  let guillemets = false;
  let no = 1;
  let debut = 1;
  const finChamp = () => { cases.push(champ); champ = ''; };
  const finLigne = () => {
    finChamp();
    if (cases.some((c) => c.trim() !== '')) lignes.push({ no: debut, cases });
    cases = [];
  };
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (guillemets) {
      if (ch === '"') {
        if (t[i + 1] === '"') { champ += '"'; i++; } else guillemets = false;
      } else {
        if (ch === '\n') no++;
        champ += ch;
      }
    } else if (ch === '"' && champ === '') {
      guillemets = true;
    } else if (ch === sep) {
      finChamp();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      finLigne();
      no++;
      debut = no;
    } else {
      champ += ch;
    }
  }
  if (guillemets) throw new HttpError(400, 'Le fichier est mal formé : un guillemet n\'est jamais refermé.');
  if (champ !== '' || cases.length) finLigne();
  return lignes;
}

const cle = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIAS = {
  nom: ['nom', 'nomduproduit', 'produit', 'designation', 'article', 'libelle'],
  reference: ['reference', 'ref', 'code', 'codearticle', 'sku'],
  categorie: ['categorie', 'famille', 'rayon'],
  unite: ['unite', 'unitedevente', 'conditionnement'],
  prix_achat: ['prixachat', 'prixdachat', 'achat', 'pa', 'coutachat'],
  prix_vente: ['prixvente', 'prixdevente', 'vente', 'pv', 'prix'],
  stock: ['stock', 'stockinitial', 'stockdedepart', 'quantite', 'qte'],
  seuil: ['seuil', 'seuilalerte', 'seuildalerte', 'alerte', 'stockminimum', 'stockmin'],
};

// Accepte « 85000 », « 85 000 », « 85.000 », « 1,500,000 », « 85 000 F CFA » ; « 12,5 » est arrondi à 13
function lireEntier(brut, { min = 0, max = 2000000000 } = {}) {
  let s = String(brut === undefined || brut === null ? '' : brut).trim();
  if (s === '') return { vide: true };
  s = s.replace(/[\s\u00a0\u202f]/g, '').replace(/(f\.?cfa|cfa|xof|f)$/i, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
  else if (/^\d+[.,]\d{1,2}$/.test(s)) s = String(Math.round(parseFloat(s.replace(',', '.'))));
  if (!/^\d+$/.test(s)) return { erreur: true };
  const n = Number(s);
  if (n < min || n > max) return { erreur: true };
  return { valeur: n };
}

// Transforme le texte d'un fichier en produits valides + lignes refusées (avec la raison)
function lireProduits(texte) {
  const lignes = lireCsv(texte);
  if (lignes.length < 2) throw new HttpError(400, 'Le fichier est vide : il faut une première ligne de titres puis au moins un produit.');
  if (lignes.length - 1 > MAX_LIGNES) throw new HttpError(400, `Le fichier dépasse ${MAX_LIGNES} produits. Découpez-le en plusieurs fichiers.`);

  const col = {};
  lignes[0].cases.forEach((titre, i) => {
    const k = cle(titre);
    for (const [champ, alias] of Object.entries(ALIAS)) if (col[champ] === undefined && alias.includes(k)) col[champ] = i;
  });
  const manquantes = ['nom', 'prix_vente'].filter((c) => col[c] === undefined);
  if (manquantes.length) {
    throw new HttpError(400, `Colonne(s) obligatoire(s) introuvable(s) : ${manquantes.map((m) => (m === 'nom' ? '« nom »' : '« prix_vente »')).join(', ')}. Vérifiez la première ligne du fichier (téléchargez le modèle).`);
  }

  const valides = [];
  const refuses = [];
  for (const l of lignes.slice(1)) {
    const v = (champ) => (col[champ] === undefined ? '' : String(l.cases[col[champ]] === undefined ? '' : l.cases[col[champ]]).trim());
    const nom = v('nom');
    const refus = (raison) => refuses.push({ ligne: l.no, nom: nom || '(sans nom)', raison });

    if (!nom) { refus('Nom manquant.'); continue; }
    if (nom.length > 150) { refus('Nom trop long (150 caractères maximum).'); continue; }
    const reference = v('reference');
    if (reference.length > 50) { refus('Référence trop longue (50 caractères maximum).'); continue; }
    const categorie = v('categorie');
    if (categorie.length > 100) { refus('Catégorie trop longue (100 caractères maximum).'); continue; }
    const unite = v('unite') || 'pièce';
    if (unite.length > 20) { refus('Unité trop longue (20 caractères maximum).'); continue; }

    const vente = lireEntier(v('prix_vente'));
    if (vente.vide) { refus('Prix de vente manquant.'); continue; }
    if (vente.erreur) { refus(`Prix de vente illisible : « ${v('prix_vente')} ».`); continue; }
    const achat = lireEntier(v('prix_achat'));
    if (achat.erreur) { refus(`Prix d'achat illisible : « ${v('prix_achat')} ».`); continue; }
    const stock = lireEntier(v('stock'));
    if (stock.erreur) { refus(`Stock illisible : « ${v('stock')} ».`); continue; }
    const seuil = lireEntier(v('seuil'));
    if (seuil.erreur) { refus(`Seuil d'alerte illisible : « ${v('seuil')} ».`); continue; }

    valides.push({
      ligne: l.no, nom, reference: reference || null, categorie: categorie || null, unite,
      prix_achat: achat.vide ? 0 : achat.valeur, prix_vente: vente.valeur,
      stock: stock.vide ? 0 : stock.valeur, seuil: seuil.vide ? 5 : seuil.valeur,
    });
  }
  return { valides, refuses, total: lignes.length - 1 };
}

module.exports = { lireCsv, lireProduits, lireEntier, MAX_LIGNES };
