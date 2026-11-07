(() => {
  'use strict';
  // Connexion WebSocket au serveur (/ws) : reçoit « il s'est passé quelque chose » pour actualiser l'écran.
  // Reconnexion automatique avec attente croissante ; si le serveur n'offre pas de WebSocket (hébergement serverless),
  // on s'arrête après quelques essais et l'application continue de fonctionner normalement.
  const MAX_ECHECS = 8;

  // peutOuvrir() : le temps réel ne doit jamais réveiller un serveur endormi (seule une vraie action de l'utilisateur le fait)
  function connecter({ jeton, surEvenement, surEtat, peutOuvrir = () => true }) {
    let ws = null;
    let essais = 0;
    let arret = false;
    let minuteur = null;

    const adresse = window.BQR ? window.BQR.wsUrl() : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

    function planifier(delai) {
      clearTimeout(minuteur);
      if (arret) return;
      essais += 1;
      if (delai === undefined && essais > MAX_ECHECS) return; // repris au retour du réseau ou de l'écran
      const attente = delai !== undefined ? delai : Math.min(30000, 1000 * 2 ** (essais - 1)) * (0.5 + Math.random() / 2);
      minuteur = setTimeout(ouvrir, attente);
    }

    function ouvrir() {
      if (arret || ws) return;
      if (!peutOuvrir()) return; // serveur non prêt ou appareil au repos : on attend une vraie activité
      const utilise = jeton();
      if (!utilise) return;
      let sock;
      try { sock = new WebSocket(adresse); } catch { planifier(); return; }
      ws = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token: utilise }));
      sock.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (!m || typeof m.type !== 'string') return;
        if (m.type === 'pret') { essais = 0; surEtat(true); return; }
        if (m.type === 'pong') return;
        try { surEvenement(m); } catch { /* un écran qui échoue ne doit pas couper la connexion */ }
      };
      sock.onerror = () => {};
      sock.onclose = (e) => {
        if (ws === sock) ws = null;
        surEtat(false);
        if (arret) return;
        if (e.code === 4001) {
          // Session refusée : on ne réessaie que si l'appareil a reçu un nouveau jeton entre-temps (changement de mot de passe)
          const actuel = jeton();
          if (actuel && actuel !== utilise) planifier(500);
          return;
        }
        planifier();
      };
    }

    function relancer() {
      if (arret || ws) return;
      essais = 0;
      clearTimeout(minuteur);
      ouvrir();
    }

    function fermer() {
      arret = true;
      clearTimeout(minuteur);
      window.removeEventListener('online', relancer);
      document.removeEventListener('visibilitychange', auRetour);
      if (ws) { try { ws.close(1000); } catch { /* ignoré */ } ws = null; }
    }

    const auRetour = () => { if (document.visibilityState === 'visible') relancer(); };
    window.addEventListener('online', relancer);
    document.addEventListener('visibilitychange', auRetour);
    ouvrir();
    return { fermer, relancer };
  }

  window.BQWS = { connecter };
})();
