'use strict';
// Envoi de messages aux entreprises. E-mail : API HTTP Resend (EMAIL_API_KEY + EMAIL_FROM). WhatsApp : aucune API intégrée
// (pas de fournisseur configuré) — on prépare un lien wa.me que l'administrateur ouvre lui-même, puis il marque la relance comme envoyée.
const { env } = require('./env');

const emailConfigure = () => Boolean(env.email.apiKey && env.email.from);

async function envoyerEmail({ a, sujet, texte }) {
  if (!emailConfigure()) return { ok: false, erreur: 'E-mail non configuré (EMAIL_API_KEY et EMAIL_FROM).' };
  if (!a) return { ok: false, erreur: 'Aucune adresse e-mail pour cette entreprise.' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.email.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.email.from, to: [a], subject: sujet, text: texte }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, erreur: `Le service e-mail a répondu ${res.status}.` };
    return { ok: true };
  } catch {
    return { ok: false, erreur: 'Le service e-mail ne répond pas.' };
  }
}

// Numéro international sans « + » : indicatif du pays (défaut 229) + numéro local
function lienWhatsapp(telephone, indicatif, message) {
  const chiffres = String(telephone || '').replace(/\D/g, '');
  if (chiffres.length < 6) return null;
  const ind = String(indicatif || '229').replace(/\D/g, '');
  const complet = chiffres.startsWith(ind) && chiffres.length > ind.length + 5 ? chiffres : ind + chiffres.replace(/^0+/, '');
  return `https://wa.me/${complet}?text=${encodeURIComponent(message)}`;
}

module.exports = { emailConfigure, envoyerEmail, lienWhatsapp };
