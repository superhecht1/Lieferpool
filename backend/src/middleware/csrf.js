/**
 * CSRF-Schutz für FrischKette
 *
 * Die Sitzung liegt in einem httpOnly-Cookie (SameSite=Strict). Zusätzlich prüfen wir bei
 * state-ändernden Requests die Herkunft (Origin/Referer, exakter Vergleich) und Sec-Fetch-Site.
 * Cookie-authentifizierte Requests ohne erkennbare Herkunft werden abgelehnt.
 */
const crypto = require('crypto');

const originOf = u => { try { return new URL(u).origin; } catch { return ''; } };
const ALLOWED = new Set(
  (process.env.CORS_ORIGIN || process.env.APP_URL || '').split(',').map(o => originOf(o.trim())).filter(Boolean)
);
const isLocal = o => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const cookieAuthed = !!(req.cookies && req.cookies.lp_at);
  const self = req.protocol + '://' + req.get('host');
  const ok = o => !!o && (o === self || ALLOWED.has(o) || isLocal(o));

  const origin  = req.headers['origin'] || '';
  const referer = originOf(req.headers['referer'] || '');
  const site    = req.headers['sec-fetch-site'] || '';

  if (origin) {
    // 'null' (z. B. aus Sandbox/Redirect) und fremde Herkunft blockieren
    if (!ok(origin)) { console.warn(`[csrf] Blocked origin: ${origin} (${req.method} ${req.path})`); return res.status(403).json({ error: 'CSRF: ungültige Origin' }); }
    return next();
  }
  if (referer) {
    if (!ok(referer)) { console.warn(`[csrf] Blocked referer: ${referer} (${req.method} ${req.path})`); return res.status(403).json({ error: 'CSRF: ungültige Herkunft' }); }
    return next();
  }
  // Weder Origin noch Referer: nur ohne Cookie-Sitzung erlaubt (Server-zu-Server, Webhooks, API-Clients)
  if (cookieAuthed && site !== 'same-origin') return res.status(403).json({ error: 'CSRF: Herkunft fehlt' });
  if (site === 'cross-site') return res.status(403).json({ error: 'CSRF: Cross-Site-Request' });
  next();
}

// CSRF-Token generieren (für zukünftige Cookie-basierte Flows)
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// X-CSRF-Token Header validieren (falls gesetzt)
function csrfTokenCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const headerToken = req.headers['x-csrf-token'];
  const cookieToken = req.cookies?.['csrf-token'];

  // Wenn beide vorhanden, müssen sie übereinstimmen
  if (headerToken && cookieToken && headerToken !== cookieToken) {
    return res.status(403).json({ error: 'CSRF: Token ungültig' });
  }

  next();
}

// Rate-Limit für sensitive Endpunkte
const sensitiveCallMap = new Map();
function sensitiveRateLimit(max = 5, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    const entry = sensitiveCallMap.get(key) || { count: 0, reset: now + windowMs };

    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    sensitiveCallMap.set(key, entry);

    if (entry.count > max) {
      return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warte kurz.' });
    }
    next();
  };
}

module.exports = { originCheck, csrfTokenCheck, generateToken, sensitiveRateLimit };
