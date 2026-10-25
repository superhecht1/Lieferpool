/**
 * cookieauth.js – Sitzung per httpOnly-Cookie statt Token im localStorage
 * Ablage: src/middleware/cookieauth.js · Einbinden in server.js VOR originCheck:
 *   app.use(require('./middleware/cookieauth'));
 * Das Access-Token liegt im Cookie "lp_at" (httpOnly, SameSite=Strict) und wird hier in den
 * Authorization-Header übersetzt – die vorhandene auth-Middleware bleibt unverändert.
 * Der Browser-Client sendet "Bearer cookie" bzw. ?_t=cookie / ?token=cookie als Platzhalter.
 * Echte Bearer-Header (API-Clients, Tests, 2FA-Zwischentoken) bleiben unberührt.
 */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function cookieAuth(req, res, next) {
  req.cookies = req.cookies || parseCookies(req.headers.cookie);
  const jwt = req.cookies.lp_at;
  if (jwt) {
    const h = req.headers.authorization || '';
    if (!h || h === 'Bearer cookie') req.headers.authorization = 'Bearer ' + jwt;
    if (req.query) for (const k of ['_t', 'token']) if (req.query[k] === 'cookie') req.query[k] = jwt;
  }
  next();
}

module.exports = cookieAuth;
module.exports.parseCookies = parseCookies;
