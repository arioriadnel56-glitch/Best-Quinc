'use strict';
const { HttpError } = require('./http');

// Reconnaît PNG et JPEG d'après leurs premiers octets (jamais d'après ce que déclare le navigateur).
// Pas de SVG ni de HTML : une image envoyée ne peut pas contenir de script.
function typeImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

function dimensionsPng(buf) {
  if (typeImage(buf) !== 'image/png' || buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// Décode un contenu base64 (avec ou sans préfixe « data:image/...;base64, »)
function lireImage(valeur, nom, { maxOctets, maxCote }) {
  if (typeof valeur !== 'string' || !valeur) throw new HttpError(400, `L'image « ${nom} » est manquante.`);
  const b64 = valeur.replace(/^data:image\/[a-z+.-]+;base64,/i, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(400, `L'image « ${nom} » est illisible.`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > maxOctets) throw new HttpError(400, `L'image « ${nom} » est trop lourde (${Math.round(maxOctets / 1024)} Ko maximum).`);
  const type = typeImage(buf);
  if (!type) throw new HttpError(400, `L'image « ${nom} » doit être au format PNG ou JPEG.`);
  const d = dimensionsPng(buf);
  if (d && (d.w < 1 || d.h < 1 || d.w > maxCote || d.h > maxCote)) {
    throw new HttpError(400, `L'image « ${nom} » est trop grande (${maxCote} pixels maximum de côté).`);
  }
  return { buf, type };
}

module.exports = { typeImage, dimensionsPng, lireImage };
