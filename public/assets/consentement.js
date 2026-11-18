// Bandeau cookies et gestion des consentements.
// Principes : aucun cookie n'est posé par Best-Quinca ; la seule catégorie facultative est « service de paiement tiers » (KkiaPay, FedaPay),
// chargée uniquement après accord. Refuser est aussi simple qu'accepter, rien n'est coché d'avance, le choix dure 6 mois et se retire à tout moment.
(() => {
  'use strict';
  const CLE = 'bq:consentement';
  const VERSION = 1;
  const DUREE_MS = 183 * 24 * 3600 * 1000;

  const lire = () => {
    try {
      const v = JSON.parse(localStorage.getItem(CLE));
      if (v && v.v === VERSION && typeof v.paiement === 'boolean' && Date.now() - v.date < DUREE_MS) return v;
    } catch { /* stockage indisponible ou valeur illisible : on redemande */ }
    return null;
  };
  const ecrire = (paiement) => { try { localStorage.setItem(CLE, JSON.stringify({ v: VERSION, date: Date.now(), paiement })); } catch { /* le choix vaut pour cette page seulement */ } };

  const el = (tag, attrs = {}, ...enfants) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...enfants.flat().filter((x) => x !== null && x !== false && x !== undefined));
    return n;
  };

  let courant = null; // fenêtre ouverte
  let precedent = null;

  function fermer() {
    if (!courant) return;
    courant.remove(); courant = null;
    document.removeEventListener('keydown', surTouche, true);
    if (precedent && precedent.focus) precedent.focus();
    precedent = null;
  }
  function surTouche(e) {
    if (!courant || !courant.classList.contains('modal')) return;
    if (e.key === 'Escape') { e.preventDefault(); courant.dispatchEvent(new CustomEvent('bq-annuler')); return; }
    if (e.key !== 'Tab') return;
    const f = [...courant.querySelectorAll('button, input:not([disabled]), a[href]')];
    if (!f.length) return;
    const premier = f[0]; const dernier = f[f.length - 1];
    if (e.shiftKey && document.activeElement === premier) { e.preventDefault(); dernier.focus(); }
    else if (!e.shiftKey && document.activeElement === dernier) { e.preventDefault(); premier.focus(); }
  }

  function monter(boite, { modal, focus }) {
    fermer();
    precedent = document.activeElement;
    courant = el('section', { class: `bq-cookies${modal ? ' modal' : ''}`, role: 'dialog', 'aria-modal': modal ? 'true' : 'false', 'aria-labelledby': 'bq-ck-titre' }, boite);
    document.body.append(courant);
    document.addEventListener('keydown', surTouche, true);
    if (focus) { const b = courant.querySelector(focus); if (b) b.focus(); }
    return courant;
  }

  // Première visite : bandeau discret, non bloquant. Trois choix de même poids.
  function bandeau() {
    const choisir = (v) => { ecrire(v); fermer(); };
    const boite = el('div', { class: 'bq-cookies-boite' },
      el('h2', { id: 'bq-ck-titre' }, 'Vos choix sur les cookies'),
      el('p', {}, 'Best-Quinca ne dépose aucun cookie publicitaire et n\'utilise aucun outil de mesure d\'audience. Votre navigateur garde seulement ce qui sert à vous connecter et à travailler sans réseau. Si vous payez en ligne, un service de paiement tiers (KkiaPay ou FedaPay) sera chargé : choisissez ici si vous l\'autorisez.'),
      el('p', {}, el('a', { href: '/cookies' }, 'Détail des cookies'), ' · ', el('a', { href: '/confidentialite' }, 'Confidentialité')),
      el('div', { class: 'bq-cookies-actions' },
        el('button', { class: 'bq-btn', type: 'button', onclick: () => choisir(false) }, 'Tout refuser'),
        el('button', { class: 'bq-btn', type: 'button', onclick: () => ouvrir() }, 'Personnaliser'),
        el('button', { class: 'bq-btn', type: 'button', onclick: () => choisir(true) }, 'Tout accepter')));
    monter(boite, { modal: false });
  }

  // Panneau de réglage (depuis « Gérer mes cookies » ou « Personnaliser »)
  function ouvrir() {
    const etat = lire();
    const caseNecessaire = el('input', { type: 'checkbox', id: 'bq-ck-nec', checked: true, disabled: true });
    const casePaiement = el('input', { type: 'checkbox', id: 'bq-ck-pay' });
    casePaiement.checked = Boolean(etat && etat.paiement); // jamais coché d'avance : seulement si vous l'avez déjà accepté
    const enregistrer = () => { ecrire(casePaiement.checked); fermer(); };
    const boite = el('div', { class: 'bq-cookies-boite' },
      el('h2', { id: 'bq-ck-titre' }, 'Gérer mes cookies'),
      el('p', {}, 'Vous pouvez changer d\'avis à tout moment. Votre choix est mémorisé 6 mois dans ce navigateur.'),
      el('div', { class: 'bq-categorie' }, caseNecessaire, el('div', {}, el('label', { for: 'bq-ck-nec' }, 'Nécessaire'), el('small', {}, 'Connexion, travail hors-ligne, mémorisation de ce choix. Toujours actif : le service ne fonctionne pas sans. Aucun cookie.'))),
      el('div', { class: 'bq-categorie' }, casePaiement, el('div', {}, el('label', { for: 'bq-ck-pay' }, 'Services de paiement (KkiaPay, FedaPay)'), el('small', {}, 'Chargés seulement quand vous payez. Ces services sont indépendants de Best-Quinca et peuvent utiliser leurs propres cookies. Si vous refusez, le paiement en ligne reste impossible tant que vous ne les autorisez pas.'))),
      el('p', {}, el('a', { href: '/cookies' }, 'Politique cookies')),
      el('div', { class: 'bq-cookies-actions' },
        el('button', { class: 'bq-btn', type: 'button', onclick: () => { ecrire(false); fermer(); } }, 'Tout refuser'),
        el('button', { class: 'bq-btn', type: 'button', onclick: enregistrer }, 'Enregistrer mon choix'),
        el('button', { class: 'bq-btn', type: 'button', onclick: () => { ecrire(true); fermer(); } }, 'Tout accepter')));
    const f = monter(boite, { modal: true, focus: '#bq-ck-pay' });
    f.addEventListener('bq-annuler', fermer);
    f.addEventListener('click', (e) => { if (e.target === f) fermer(); });
  }

  // Demande ponctuelle au moment d'utiliser un service tiers. Résout si autorisé, rejette sinon.
  function exiger(categorie, libelle) {
    if (categorie !== 'paiement') return Promise.resolve();
    const etat = lire();
    if (etat && etat.paiement) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const nom = libelle || 'le service de paiement';
      const finir = (ok) => {
        if (ok) { ecrire(true); fermer(); resolve(); } else { fermer(); reject(new Error(`Paiement annulé : ${nom} n'a pas été autorisé.`)); }
      };
      const boite = el('div', { class: 'bq-cookies-boite' },
        el('h2', { id: 'bq-ck-titre' }, `Autoriser ${nom} ?`),
        el('p', {}, `Pour payer, votre navigateur va se connecter à ${nom}, un service indépendant de Best-Quinca, qui peut utiliser ses propres cookies et dont les conditions s'appliquent à ce paiement. Nous ne le chargeons qu'avec votre accord.`),
        el('p', {}, el('a', { href: '/cookies', target: '_blank', rel: 'noopener' }, 'En savoir plus')),
        el('div', { class: 'bq-cookies-actions' },
          el('button', { class: 'bq-btn', type: 'button', onclick: () => finir(false) }, 'Annuler'),
          el('button', { class: 'bq-btn', type: 'button', onclick: () => finir(true) }, 'Autoriser et payer')));
      const f = monter(boite, { modal: true, focus: '.bq-btn' });
      f.addEventListener('bq-annuler', () => finir(false));
    });
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-gerer-cookies]');
    if (b) { e.preventDefault(); ouvrir(); }
  });
  window.BQConsent = { etat: lire, exiger, ouvrir };
  const demarrer = () => { if (!lire()) bandeau(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer); else demarrer();
})();
