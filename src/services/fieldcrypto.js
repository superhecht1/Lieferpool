/**
 * fieldcrypto.js – Feldverschlüsselung (AES-256-GCM) für sensible Spalten (z. B. IBAN)
 * Ablage: src/services/fieldcrypto.js
 *
 * Schlüssel: Umgebungsvariable FIELD_ENCRYPTION_KEY (32 Byte, hex = 64 Zeichen oder base64).
 *   Erzeugen:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * Ohne Schlüssel wird NICHT verschlüsselt (Klartext, Warnung im Log) – die Anwendung läuft weiter.
 * Gespeichertes Format: enc:v1:<iv-b64>:<tag-b64>:<cipher-b64>
 * decrypt() akzeptiert auch Klartext (Altbestand) und gibt ihn unverändert zurück.
 */
const crypto = require('crypto');
const PREFIX = 'enc:v1:';
let warned = false;

function getKey() {
  const raw = (process.env.FIELD_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  let key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY muss 32 Byte lang sein (64 Hex-Zeichen)');
  return key;
}

function isEncrypted(v) { return typeof v === 'string' && v.startsWith(PREFIX); }

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  if (isEncrypted(plain)) return plain;
  const key = getKey();
  if (!key) {
    if (!warned) { console.warn('[fieldcrypto] FIELD_ENCRYPTION_KEY fehlt – sensible Felder werden unverschlüsselt gespeichert'); warned = true; }
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join(':');
}

function decrypt(value) {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  if (!key) return '[verschlüsselt]';
  try {
    const [iv, tag, enc] = value.slice(PREFIX.length).split(':').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (e) {
    console.error('[fieldcrypto] Entschlüsselung fehlgeschlagen:', e.message);
    return '[nicht lesbar]';
  }
}

// Entschlüsselt rekursiv alle Strings in Objekten/Arrays (für API-Antworten)
function decryptDeep(x) {
  if (typeof x === 'string') return isEncrypted(x) ? decrypt(x) : x;
  if (Array.isArray(x)) return x.map(decryptDeep);
  if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
    const o = {}; for (const k of Object.keys(x)) o[k] = decryptDeep(x[k]); return o;
  }
  return x;
}

// Express-Middleware: entschlüsselt alle JSON-Antworten
function jsonDecryptMiddleware(req, res, next) {
  const orig = res.json.bind(res);
  res.json = body => orig(decryptDeep(body));
  next();
}

module.exports = { encrypt, decrypt, decryptDeep, isEncrypted, jsonDecryptMiddleware };
