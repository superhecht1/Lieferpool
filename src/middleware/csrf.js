/**
 * CSRF-Schutz für FrischKette
 * 
 * Da wir JWT-Auth via Authorization-Header nutzen, ist CSRF für API-Calls
 * inherent sicher. Zusätzlich validieren wir Origin/Referer für
 * state-ändernde Requests als Defense-in-Depth.
 */
const crypto = require('crypto');

const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || process.env.APP_URL || '')
  .split(',').map(o => o.trim()).filter(Boolean);

// Origin-Validierung für state-ändernde Requests
function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const origin  = req.headers['origin']  || '';
  const referer = req.headers['referer'] || '';

  // Erlaube nur eigene Origin (oder kein Origin = server-to-server)
  if (!origin && !referer) return next(); // Server-zu-Server-Calls

  const allowed = [...ALLOWED_ORIGINS, 'http://localhost', 'http://127.0.0.1'];
  const isAllowed = allowed.some(o =>
    origin.startsWith(o) || referer.startsWith(o)
  );

  if (origin && !isAllowed) {
    console.warn(`[csrf] Blocked origin: ${origin} (${req.method} ${req.path})`);
    return res.status(403).json({ error: 'CSRF: ungültige Origin' });
  }

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
