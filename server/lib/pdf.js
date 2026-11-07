'use strict';
// Générateur PDF minimal, sans dépendance : texte (Helvetica), rectangles, traits, pages A4.
// Suffisant pour des fiches de bilan lisibles et imprimables.
const zlib = require('node:zlib');

const L = 595.28; // largeur A4 en points
const H = 841.89; // hauteur A4

// Largeurs Helvetica (normal, gras) pour les caractères 32 à 126, en millièmes d'em
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Caractères hors Latin-1 présents dans le jeu WinAnsi (cp1252)
const SPECIAUX = { '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, '…': 0x85, 'œ': 0x9c, 'Œ': 0x8c, '€': 0x80, '•': 0x95 };

function nettoyer(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\u00a0\u202f\u2009]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ');
}

// Convertit en octets WinAnsi (une lettre = un octet), « ? » pour ce qui n'existe pas
function enOctets(s) {
  let out = '';
  for (const ch of nettoyer(s)) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) out += ch;
    else if (c >= 160 && c <= 255) out += ch;
    else if (SPECIAUX[ch]) out += String.fromCharCode(SPECIAUX[ch]);
    else out += '?';
  }
  return out;
}

function largeurCar(ch, gras) {
  const c = ch.charCodeAt(0);
  const t = gras ? W_BOLD : W_REG;
  if (c >= 32 && c < 127) return t[c - 32];
  if (c === 0x92 || c === 0x91) return gras ? 278 : 222;
  if (c === 0x93 || c === 0x94) return gras ? 500 : 333;
  if (c === 0x96) return 556;
  if (c === 0x97) return 1000;
  if (c === 0x85) return 1000;
  if (c === 0x9c) return gras ? 944 : 944;
  if (c === 0x8c) return 1000;
  if (c === 0x95) return 350;
  if (c === 0xab || c === 0xbb) return 556;
  if (c === 0xb7) return 278;
  // Lettres accentuées : même largeur que la lettre de base
  const base = ch.normalize('NFD').charCodeAt(0);
  if (base >= 32 && base < 127) return t[base - 32];
  return 556;
}

// Largeur d'un texte en points
function largeur(texte, taille, gras = false) {
  let w = 0;
  for (const ch of enOctets(texte)) w += largeurCar(ch, gras);
  return (w * taille) / 1000;
}

// Coupe un texte pour qu'il tienne dans une largeur (… à la fin si trop long)
function tenir(texte, taille, gras, max) {
  const t = nettoyer(texte);
  if (largeur(t, taille, gras) <= max) return t;
  let s = t;
  while (s.length > 1 && largeur(s + '…', taille, gras) > max) s = s.slice(0, -1);
  return s + '…';
}

const hexRgb = (hex, repli = [0.24, 0.36, 0.46]) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return repli;
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
};
const nb = (n) => (Math.round(n * 100) / 100).toString();
const coul = (c) => c.map(nb).join(' ');

class Pdf {
  constructor({ titre = 'Document', auteur = 'Best-Quinca' } = {}) {
    this.titre = titre;
    this.auteur = auteur;
    this.pages = [];
    this.page = null;
    this.nouvellePage();
  }

  nouvellePage() {
    this.page = [];
    this.pages.push(this.page);
    return this.page;
  }

  // y mesuré depuis le haut de la page
  texte(x, y, s, { taille = 10, gras = false, couleur = [0.08, 0.13, 0.17], align = 'left', max } = {}) {
    let t = nettoyer(s);
    if (max) t = tenir(t, taille, gras, max);
    const w = largeur(t, taille, gras);
    const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    const esc = enOctets(t).replace(/([\\()])/g, '\\$1');
    this.page.push(`BT /${gras ? 'F2' : 'F1'} ${nb(taille)} Tf ${coul(couleur)} rg ${nb(px)} ${nb(H - y)} Td (${esc}) Tj ET`);
  }

  rect(x, y, w, h, { fond, trait, epaisseur = 0.6 } = {}) {
    const ops = [];
    if (fond) ops.push(`${coul(fond)} rg`);
    if (trait) ops.push(`${coul(trait)} RG ${nb(epaisseur)} w`);
    ops.push(`${nb(x)} ${nb(H - y - h)} ${nb(w)} ${nb(h)} re ${fond && trait ? 'B' : fond ? 'f' : 'S'}`);
    this.page.push(ops.join(' '));
  }

  trait(x1, y1, x2, y2, { couleur = [0.83, 0.86, 0.88], epaisseur = 0.6 } = {}) {
    this.page.push(`${coul(couleur)} RG ${nb(epaisseur)} w ${nb(x1)} ${nb(H - y1)} m ${nb(x2)} ${nb(H - y2)} l S`);
  }

  // Assemble le fichier PDF (Buffer)
  construire() {
    const objets = [];
    const ajouter = (corps) => { objets.push(corps); return objets.length; };
    ajouter('<< /Type /Catalog /Pages 2 0 R >>');
    ajouter(null); // Pages : renseigné plus bas
    ajouter('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    ajouter('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const ops of this.pages) {
      const flux = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      const idContenu = ajouter({ flux });
      const idPage = ajouter(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${nb(L)} ${nb(H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${idContenu} 0 R >>`);
      kids.push(`${idPage} 0 R`);
    }
    objets[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
    const idInfo = ajouter(`<< /Title (${enOctets(this.titre).replace(/([\\()])/g, '\\$1')}) /Producer (Best-Quinca) /Author (${enOctets(this.auteur).replace(/([\\()])/g, '\\$1')}) >>`);

    const morceaux = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const decalages = [];
    let pos = morceaux[0].length;
    objets.forEach((o, i) => {
      decalages.push(pos);
      let b;
      if (o && o.flux) b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${o.flux.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), o.flux, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      else b = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
      morceaux.push(b);
      pos += b.length;
    });
    const xref = [`xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`];
    for (const d of decalages) xref.push(`${String(d).padStart(10, '0')} 00000 n \n`);
    xref.push(`trailer\n<< /Size ${objets.length + 1} /Root 1 0 R /Info ${idInfo} 0 R >>\nstartxref\n${pos}\n%%EOF\n`);
    morceaux.push(Buffer.from(xref.join(''), 'latin1'));
    return Buffer.concat(morceaux);
  }
}

module.exports = { Pdf, largeur, tenir, enOctets, hexRgb, L, H };
