'use strict';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class Router {
  constructor() { this.routes = []; }

  add(method, path, ...handlers) {
    const keys = [];
    const pattern = path.split('/').map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return escapeRe(seg);
    }).join('/');
    this.routes.push({ method, regex: new RegExp('^' + pattern + '/?$'), keys, handlers });
  }

  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { return { route: null, pathMatched: false }; }
      return { route: r, params };
    }
    return { route: null, pathMatched };
  }
}

module.exports = { Router };
