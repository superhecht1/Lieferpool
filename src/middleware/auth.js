const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

// Verifiziert JWT und hängt user ans Request
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Kein Token' });
  }
  try {
    req.user = jwt.verify(header.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token ungültig' });
  }
}

// Rollenprüfung – Verwendung: role('admin') oder role('erzeuger', 'admin')
function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Kein Zugriff' });
    }
    next();
  };
}

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '30d' });
}

module.exports = { auth, role, signToken };
