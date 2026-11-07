(function () {
  'use strict';
  // Stockage durable sur l'appareil (IndexedDB, avec repli sur localStorage) : liste des produits, session,
  // ventes en attente d'envoi. Ces données survivent à la fermeture de l'application et à la coupure du réseau.
  const NOM = 'bq-hors-ligne';
  let backend = null;

  function ouvrir() {
    if (backend) return backend;
    backend = new Promise((resolve) => {
      if (!('indexedDB' in window)) return resolve({ type: 'ls' });
      let r;
      try { r = indexedDB.open(NOM, 1); } catch { return resolve({ type: 'ls' }); }
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => resolve({ type: 'idb', db: r.result });
      r.onerror = () => resolve({ type: 'ls' });
      r.onblocked = () => resolve({ type: 'ls' });
    });
    return backend;
  }

  const transaction = (b, mode, fn) => new Promise((resolve, reject) => {
    const tx = b.db.transaction('kv', mode);
    const rq = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(rq ? rq.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  async function get(cle) {
    const b = await ouvrir();
    if (b.type === 'idb') { const v = await transaction(b, 'readonly', (s) => s.get(cle)); return v === undefined ? null : v; }
    try { const v = localStorage.getItem(`${NOM}:${cle}`); return v === null ? null : JSON.parse(v); } catch { return null; }
  }

  async function set(cle, valeur) {
    const b = await ouvrir();
    if (b.type === 'idb') { await transaction(b, 'readwrite', (s) => s.put(valeur, cle)); return; }
    localStorage.setItem(`${NOM}:${cle}`, JSON.stringify(valeur));
  }

  async function del(cle) {
    const b = await ouvrir();
    if (b.type === 'idb') { await transaction(b, 'readwrite', (s) => s.delete(cle)); return; }
    localStorage.removeItem(`${NOM}:${cle}`);
  }

  // Une seule modification à la fois, même avec plusieurs onglets ouverts (Web Locks quand le navigateur les propose)
  function verrou(nom, fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request(nom, fn);
    return fn();
  }

  window.BQHL = { get, set, del, verrou };
})();
