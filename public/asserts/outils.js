(function (racine, fabrique) {
  'use strict';
  // Chargé par le navigateur (window.BQ) et par les tests Node (require)
  if (typeof module === 'object' && module.exports) module.exports = fabrique();
  else racine.BQ = fabrique();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const espaces = /[\u202f\u00a0]/g;

  function fcfa(n) {
    return new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)).replace(espaces, ' ') + ' F CFA';
  }

  function nombre(n) {
    return new Intl.NumberFormat('fr-FR').format(Number(n) || 0).replace(espaces, ' ');
  }

  // Numéro officiel (5 chiffres) ou référence provisoire d'une vente faite hors connexion (« HL-0003 »)
  const numeroFacture = (n) => (typeof n === 'string' && n ? n : String(n).padStart(5, '0'));
  const numeroProvisoire = (compteur) => `HL-${String(compteur).padStart(4, '0')}`;

  // Identifiant unique d'une vente, généré sur l'appareil : le serveur s'en sert pour ne jamais l'enregistrer deux fois
  // Texte blanc ou encre selon la luminosité de la couleur de la marque (contraste WCAG) — même formule que le serveur
  function couleurLisible(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex));
    if (!m) return '#FFFFFF';
    const lin = (i) => { const c = parseInt(m[1].slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
    return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.0634) ? '#FFFFFF' : '#12202C';
  }

  function genererCle() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  // Quantité déjà vendue hors connexion et pas encore envoyée au serveur
  function quantiteEnAttente(file, produitId) {
    let n = 0;
    for (const v of file || []) {
      if (v.statut !== 'en_attente') continue;
      for (const l of v.lignes) if (l.produit_id === produitId) n += l.quantite;
    }
    return n;
  }

  // Stock réellement vendable : stock connu moins ce qui est déjà parti en caisse sans être encore synchronisé
  const stockDisponible = (produit, file) => Math.max(0, produit.quantite_stock - quantiteEnAttente(file, produit.id));

  // Que faire d'une réponse du serveur à l'envoi d'une vente ?
  //  envoyee : enregistrée · refusee : définitivement invalide · reseau/auth/abonnement/reessayer : on s'arrête et on garde la file
  function classerReponse(status) {
    if (status === 200 || status === 201) return 'envoyee';
    if (status === 0) return 'reseau';
    if (status === 401) return 'auth';
    if (status === 402) return 'abonnement';
    if (status === 400 || status === 403 || status === 404 || status === 409 || status === 413 || status === 422) return 'refusee';
    return 'reessayer';
  }

  // Envoie les ventes en attente, de la plus ancienne à la plus récente. S'arrête au premier incident non définitif.
  // `envoyer(vente)` renvoie la réponse du serveur ou lève une erreur portant `status` (ou `hors_ligne`).
  async function synchroniserFile(file, envoyer) {
    const resultats = [];
    let arret = null;
    for (const vente of file) {
      if (vente.statut !== 'en_attente') continue;
      let status = 200;
      let data = null;
      let message = '';
      try {
        data = await envoyer(vente);
      } catch (e) {
        status = e && e.hors_ligne ? 0 : (e && e.status) || 500;
        message = (e && e.message) || '';
      }
      const verdict = classerReponse(status);
      if (verdict === 'envoyee') {
        resultats.push({ cle: vente.cle, issue: 'envoyee', numero: data && data.numero, id: data && data.id, anomalie: (data && data.anomalie) || null });
      } else if (verdict === 'refusee') {
        resultats.push({ cle: vente.cle, issue: 'refusee', raison: message || 'Vente refusée par le serveur.' });
      } else {
        arret = verdict;
        break;
      }
    }
    return { resultats, arret };
  }

  // Numéro au format international sans « + » (celui qu'attend wa.me), ou null s'il est inexploitable.
  // « +228… » et « 00228… » sont pris tels quels ; sinon l'indicatif de l'entreprise est ajouté
  // (sauf si le numéro le contient déjà). Le « 0 » initial est conservé : au Bénin il fait partie du numéro (01…).
  function numeroWhatsApp(brut, indicatif) {
    const s = String(brut === undefined || brut === null ? '' : brut).trim();
    if (!s) return null;
    const ind = String(indicatif || '229').replace(/\D/g, '');
    let d = s.replace(/\D/g, '');
    if (s.startsWith('+')) {
      // international explicite
    } else if (s.startsWith('00')) {
      d = d.slice(2);
    } else if (!(d.startsWith(ind) && d.length >= ind.length + 8)) {
      d = ind + d;
    }
    return d.length >= 9 && d.length <= 15 ? d : null;
  }

  function messageWhatsApp({ client, entreprise, numero, total, lien }) {
    const nom = client ? String(client).trim() : '';
    return `Bonjour${nom ? ' ' + nom : ''},\n` +
      `voici votre facture n° ${numeroFacture(numero)} de ${entreprise}, d'un montant de ${fcfa(total)}.\n` +
      `Détail de votre achat : ${lien}\n` +
      'Merci pour votre confiance.';
  }

  return {
    fcfa, nombre, numeroFacture, numeroProvisoire, numeroWhatsApp, messageWhatsApp,
    couleurLisible, genererCle, quantiteEnAttente, stockDisponible, classerReponse, synchroniserFile,
  };
});
