(() => {
  'use strict';
  const fcfa = (n) => new Intl.NumberFormat('fr-FR').format(n) + ' F CFA';

  const R = window.BQR;
  const cfg = window.BQ_CONFIG || {};

  // Vitrine hébergée à part : les tarifs sont écrits dans la page à la construction. Aucun visiteur ne réveille le serveur pour les lire.
  // Servie par le backend (même domaine) : les tarifs actuels sont lus comme avant.
  if (!cfg.prixStatiques) fetch('/api/config').then((r) => r.json()).then((c) => {
    document.getElementById('prix').textContent = fcfa(c.prix);
    document.getElementById('periode').textContent = c.jours === 30 ? 'par mois' : `pour ${c.jours} jours`;
    const m = (c.plans || []).find((p) => p.id === 'mensuel');
    const a = (c.plans || []).find((p) => p.id === 'annuel');
    const el = document.getElementById('annuel');
    if (el && m && a) {
      const offerts = Math.floor((m.prix * (a.jours / m.jours) - a.prix) / m.prix);
      el.textContent = `Ou ${fcfa(a.prix)} par an${offerts > 0 ? ` : ${offerts} mois offerts` : ''}.`;
    } else if (el) el.remove();
  }).catch(() => { /* le texte par défaut reste affiché */ });

  const formIns = document.getElementById('form-inscription');
  const errIns = document.getElementById('erreur-inscription');
  formIns.addEventListener('submit', async (e) => {
    e.preventDefault();
    errIns.textContent = '';
    const btn = formIns.querySelector('button');
    btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(formIns));
      // Créer un espace est une vraie opération serveur : on s'assure qu'il répond (écran de transition le temps du réveil)
      if (!(await R.garantir({ avecEcran: true }))) throw new Error('Le serveur ne répond pas. Réessayez dans un instant.');
      const res = await fetch(R.url('/api/entreprises/inscription'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.erreur || "L'inscription a échoué.");
      localStorage.setItem(`bq:${data.entreprise.slug}:token`, data.token);
      sessionStorage.setItem(`bq:${data.entreprise.slug}:code`, data.code_recuperation);
      location.href = `/app/${data.entreprise.slug}/#/bienvenue`;
    } catch (err) {
      errIns.textContent = err instanceof TypeError ? 'Pas de connexion à internet. Réessayez.' : err.message;
      btn.disabled = false;
    }
  });

  document.getElementById('form-acces').addEventListener('submit', (e) => {
    e.preventDefault();
    const slug = new FormData(e.target).get('slug').toString().trim().toLowerCase().replace(/^\/?(app\/)?/, '').replace(/\/.*$/, '');
    if (slug) location.href = `/app/${encodeURIComponent(slug)}/`;
  });
})();
