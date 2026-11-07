'use strict';
// Serveur WebSocket minimal (RFC 6455), sans dépendance : poignée de main, trames texte, ping/pong, fermeture.
// Le serveur n'envoie que du texte ; il accepte du texte (fragmenté ou non) et refuse le binaire.
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_ENTRANT = 16 * 1024; // un client n'a que de très petits messages à envoyer
const MAX_SORTANT_EN_ATTENTE = 1024 * 1024; // au-delà, le client est trop lent : on le coupe

function refuser(socket, status, texte) {
  socket.end(`HTTP/1.1 ${status} ${texte}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Poignée de main HTTP -> 101. Renvoie false (et répond) si la demande n'est pas valable.
function poigneeDeMain(req, socket) {
  const cle = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !cle || req.headers['sec-websocket-version'] !== '13' || Buffer.from(cle, 'base64').length !== 16) {
    refuser(socket, 400, 'Bad Request');
    return false;
  }
  const accept = crypto.createHash('sha1').update(cle + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return true;
}

function trame(opcode, charge) {
  const n = charge.length;
  let tete;
  if (n < 126) tete = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { tete = Buffer.alloc(4); tete[0] = 0x80 | opcode; tete[1] = 126; tete.writeUInt16BE(n, 2); }
  else { tete = Buffer.alloc(10); tete[0] = 0x80 | opcode; tete[1] = 127; tete.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([tete, charge]);
}

class Connexion {
  // surMessage(texte), surFermeture()
  constructor(socket, { surMessage, surFermeture, surPong }) {
    this.socket = socket;
    this.surMessage = surMessage;
    this.surFermeture = surFermeture;
    this.surPong = surPong;
    this.tampon = Buffer.alloc(0);
    this.fragments = [];
    this.tailleFragments = 0;
    this.fermee = false;
    this.closeEnvoye = false;
    socket.setNoDelay(true);
    socket.on('data', (c) => this.recevoir(c));
    socket.on('close', () => this.terminer());
    socket.on('error', () => this.terminer());
  }

  recevoir(chunk) {
    if (this.fermee) return;
    this.tampon = this.tampon.length ? Buffer.concat([this.tampon, chunk]) : chunk;
    try {
      while (this.lireTrame());
    } catch (e) {
      this.fermer(e.code || 1002, e.message);
    }
  }

  // Lit une trame complète du tampon ; renvoie false s'il en manque une partie
  lireTrame() {
    const b = this.tampon;
    if (b.length < 2) return false;
    const fin = Boolean(b[0] & 0x80);
    if (b[0] & 0x70) throw Object.assign(new Error('bits réservés'), { code: 1002 });
    const opcode = b[0] & 0x0f;
    if (!(b[1] & 0x80)) throw Object.assign(new Error('trame non masquée'), { code: 1002 });
    let longueur = b[1] & 0x7f;
    let pos = 2;
    if (longueur === 126) {
      if (b.length < 4) return false;
      longueur = b.readUInt16BE(2); pos = 4;
    } else if (longueur === 127) {
      if (b.length < 10) return false;
      const grand = b.readBigUInt64BE(2);
      if (grand > BigInt(MAX_ENTRANT)) throw Object.assign(new Error('message trop gros'), { code: 1009 });
      longueur = Number(grand); pos = 10;
    }
    if (longueur > MAX_ENTRANT) throw Object.assign(new Error('message trop gros'), { code: 1009 });
    const controle = opcode >= 8;
    if (controle && (!fin || longueur > 125)) throw Object.assign(new Error('trame de contrôle invalide'), { code: 1002 });
    if (b.length < pos + 4 + longueur) return false;
    const masque = b.subarray(pos, pos + 4);
    const charge = Buffer.from(b.subarray(pos + 4, pos + 4 + longueur));
    for (let i = 0; i < charge.length; i++) charge[i] ^= masque[i & 3];
    this.tampon = b.subarray(pos + 4 + longueur);

    if (opcode === 0x8) { this.fermer(1000, ''); return false; }
    if (opcode === 0x9) { this.ecrire(trame(0xA, charge)); return true; }
    if (opcode === 0xA) { if (this.surPong) this.surPong(); return true; }
    if (opcode === 0x2) throw Object.assign(new Error('binaire non accepté'), { code: 1003 });
    if (opcode !== 0x0 && opcode !== 0x1) throw Object.assign(new Error('opcode inconnu'), { code: 1002 });
    if (opcode === 0x1 && this.fragments.length) throw Object.assign(new Error('fragment attendu'), { code: 1002 });
    if (opcode === 0x0 && !this.fragments.length) throw Object.assign(new Error('fragment inattendu'), { code: 1002 });
    this.fragments.push(charge);
    this.tailleFragments += charge.length;
    if (this.tailleFragments > MAX_ENTRANT) throw Object.assign(new Error('message trop gros'), { code: 1009 });
    if (fin) {
      const texte = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = []; this.tailleFragments = 0;
      this.surMessage(texte);
    }
    return !this.fermee && this.tampon.length > 0;
  }

  ecrire(buf) {
    if (this.fermee || this.socket.destroyed) return;
    if (this.socket.writableLength > MAX_SORTANT_EN_ATTENTE) { this.detruire(); return; }
    this.socket.write(buf);
  }

  envoyer(texte) { this.ecrire(trame(0x1, Buffer.from(texte))); }
  envoyerBrut(buf) { this.ecrire(trame(0x1, buf)); }
  ping() { this.ecrire(trame(0x9, Buffer.alloc(0))); }

  fermer(code = 1000, raison = '') {
    if (this.fermee || this.closeEnvoye) return;
    this.closeEnvoye = true;
    const r = Buffer.from(String(raison).slice(0, 100));
    const charge = Buffer.alloc(2 + r.length);
    charge.writeUInt16BE(code, 0);
    r.copy(charge, 2);
    try { this.socket.write(trame(0x8, charge)); this.socket.end(); } catch { /* déjà fermée */ }
    setTimeout(() => this.detruire(), 1500).unref();
  }

  detruire() {
    try { this.socket.destroy(); } catch { /* ignoré */ }
    this.terminer();
  }

  terminer() {
    if (this.fermee) return;
    this.fermee = true;
    this.surFermeture();
  }
}

module.exports = { poigneeDeMain, refuser, Connexion, trame };
