/**
 * sanitize.js – XSS-Schutz und Input-Validierung
 *
 * Verwendung in Routes:
 *   const { sanitize, validate, rules } = require('../middleware/sanitize');
 *   router.post('/route', validate(rules.createPool), async (req, res) => {...})
 */

// ── HTML Escaping ──────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// ── String Sanitizer ───────────────────────────────────────────
function sanitizeString(value, maxLength = 500) {
  if (value == null) return null;
  return String(value).trim().slice(0, maxLength);
}

// ── Middleware: Sanitize req.body ──────────────────────────────
// Rekursiv alle Strings im Body sanitisieren
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = deepSanitize(req.body);
  }
  next();
}

function deepSanitize(obj, depth = 0) {
  if (depth > 5) return obj; // Max-Tiefe
  if (typeof obj === 'string') return sanitizeString(obj, 2000);
  if (Array.isArray(obj)) return obj.map(item => deepSanitize(item, depth + 1));
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // foto_base64 nicht kürzen (bis 1.4MB)
      if (key === 'foto_base64') { result[key] = value; continue; }
      result[key] = deepSanitize(value, depth + 1);
    }
    return result;
  }
  return obj;
}

// ── Validierungs-Regeln ────────────────────────────────────────
const RULES = {
  // Auth
  register: {
    email:    { required: true, type: 'email', maxLength: 255 },
    password: { required: true, minLength: 8, maxLength: 128 },
    name:     { required: true, minLength: 2, maxLength: 100 },
    role:     { required: true, enum: ['erzeuger', 'caterer', 'fahrer'] },
  },
  login: {
    email:    { required: true, type: 'email' },
    password: { required: true, minLength: 1 },
  },
  createPool: {
    produkt:          { required: true, minLength: 2, maxLength: 100 },
    menge_ziel:       { required: true, type: 'number', min: 1, max: 1000000 },
    preis_pro_einheit:{ required: true, type: 'number', min: 0.01, max: 9999 },
    lieferwoche:      { required: true, maxLength: 20 },
    deadline:         { required: true, type: 'date' },
  },
  commit: {
    menge: { required: true, type: 'number', min: 0.1, max: 100000 },
  },
  updateErzeuger: {
    betrieb_name: { maxLength: 100 },
    adresse:      { maxLength: 200 },
    plz:          { maxLength: 10, type: 'plz' },
    ort:          { maxLength: 100 },
    telefon:      { maxLength: 30 },
    website:      { maxLength: 200, type: 'url' },
    iban:         { maxLength: 34, type: 'iban' },
    ust_id:       { maxLength: 20 },
    beschreibung: { maxLength: 1000 },
    sortiment:    { maxLength: 500 },
  },
};

// ── Validierungs-Middleware Factory ───────────────────────────
function validate(rules) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, rule] of Object.entries(rules)) {
      const value = req.body[field];

      if (rule.required && (value == null || value === '')) {
        errors.push(`${field}: Pflichtfeld`);
        continue;
      }

      if (value == null || value === '') continue; // Optionales Feld leer → OK

      // Typ-Prüfungen
      if (rule.type === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          errors.push(`${field}: Ungültige E-Mail-Adresse`);
        }
      }
      if (rule.type === 'number') {
        const num = parseFloat(value);
        if (isNaN(num)) { errors.push(`${field}: Muss eine Zahl sein`); continue; }
        if (rule.min != null && num < rule.min) errors.push(`${field}: Mindest-Wert ${rule.min}`);
        if (rule.max != null && num > rule.max) errors.push(`${field}: Max-Wert ${rule.max}`);
      }
      if (rule.type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}/.test(value)) errors.push(`${field}: Format YYYY-MM-DD erwartet`);
      }
      if (rule.type === 'iban') {
        const iban = value.replace(/\s/g,'').toUpperCase();
        if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) {
          errors.push(`${field}: Ungültige IBAN`);
        }
      }
      if (rule.type === 'url' && value) {
        try { new URL(value); } catch { errors.push(`${field}: Ungültige URL`); }
      }
      if (rule.type === 'plz') {
        if (!/^\d{4,10}$/.test(value.replace(/\s/g,''))) errors.push(`${field}: Ungültige PLZ`);
      }

      // Längen
      if (rule.minLength && String(value).length < rule.minLength) {
        errors.push(`${field}: Mindestens ${rule.minLength} Zeichen`);
      }
      if (rule.maxLength && String(value).length > rule.maxLength) {
        errors.push(`${field}: Maximal ${rule.maxLength} Zeichen`);
      }

      // Enum
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push(`${field}: Muss einer von ${rule.enum.join(', ')} sein`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }
    next();
  };
}

module.exports = { escapeHtml, sanitizeString, sanitizeBody, validate, rules: RULES };
