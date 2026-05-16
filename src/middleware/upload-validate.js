/**
 * File-Upload-Validierung für FrischKette
 * Prüft MIME-Type, Dateigröße, Dateiendung
 */

const ALLOWED_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  document: ['application/pdf', 'image/jpeg', 'image/png'],
  all: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
};

const ALLOWED_EXTENSIONS = {
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  document: ['.pdf', '.jpg', '.jpeg', '.png'],
  all: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf'],
};

const MAX_SIZE = {
  image:    5 * 1024 * 1024,  // 5 MB
  document: 10 * 1024 * 1024, // 10 MB
  all:      10 * 1024 * 1024,
};

// Prüfe Magic Bytes (echten Dateityp, nicht nur Extension)
const MAGIC_BYTES = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png':  [0x89, 0x50, 0x4E, 0x47],
  'image/gif':  [0x47, 0x49, 0x46],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF
};

function detectMimeFromBuffer(buffer) {
  const bytes = [...buffer.slice(0, 8)];
  for (const [mime, magic] of Object.entries(MAGIC_BYTES)) {
    if (magic.every((b, i) => bytes[i] === b)) return mime;
  }
  return null;
}

function validateUpload(type = 'all', maxSizeMB = null) {
  return (req, res, next) => {
    if (!req.file && !req.body?.file) return next();

    const file = req.file;
    if (!file) return next();

    const maxBytes = maxSizeMB ? maxSizeMB * 1024 * 1024 : MAX_SIZE[type];
    const allowedMimes = ALLOWED_TYPES[type] || ALLOWED_TYPES.all;
    const allowedExts  = ALLOWED_EXTENSIONS[type] || ALLOWED_EXTENSIONS.all;

    // 1. Größencheck
    if (file.size > maxBytes) {
      return res.status(400).json({
        error: `Datei zu groß. Maximum: ${Math.round(maxBytes / 1024 / 1024)} MB`
      });
    }

    // 2. Extension-Check
    const ext = ('.' + (file.originalname || '').split('.').pop()).toLowerCase();
    if (!allowedExts.includes(ext)) {
      return res.status(400).json({
        error: `Dateityp nicht erlaubt. Erlaubt: ${allowedExts.join(', ')}`
      });
    }

    // 3. MIME-Type-Check (Header)
    if (!allowedMimes.includes(file.mimetype)) {
      return res.status(400).json({
        error: `MIME-Type nicht erlaubt: ${file.mimetype}`
      });
    }

    // 4. Magic-Bytes-Check (echter Dateityp)
    if (file.buffer) {
      const detectedMime = detectMimeFromBuffer(file.buffer);
      if (detectedMime && !allowedMimes.includes(detectedMime)) {
        console.warn(`[upload] Magic bytes mismatch: claimed=${file.mimetype} detected=${detectedMime}`);
        return res.status(400).json({
          error: 'Dateiinhalt stimmt nicht mit Dateityp überein'
        });
      }
    }

    // 5. Dateiname sanieren
    file.safeOriginalName = file.originalname
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '_')
      .substring(0, 100);

    next();
  };
}

// Base64-Upload validieren (für Foto-Uploads in Fahrer-App)
function validateBase64Upload(type = 'image', maxSizeMB = 5) {
  return (req, res, next) => {
    const data = req.body?.foto || req.body?.image || req.body?.file;
    if (!data || !data.startsWith('data:')) return next();

    const maxBytes = maxSizeMB * 1024 * 1024;

    // Größe aus Base64 abschätzen
    const base64Data = data.split(',')[1] || '';
    const sizeBytes  = Math.ceil(base64Data.length * 0.75);

    if (sizeBytes > maxBytes) {
      return res.status(400).json({
        error: `Bild zu groß. Maximum: ${maxSizeMB} MB`
      });
    }

    // MIME aus Data-URL
    const mime = data.split(';')[0].split(':')[1];
    const allowedMimes = ALLOWED_TYPES[type] || ALLOWED_TYPES.image;
    if (!allowedMimes.includes(mime)) {
      return res.status(400).json({
        error: `Bildformat nicht erlaubt: ${mime}`
      });
    }

    // Magic-Bytes aus Base64 prüfen
    try {
      const buf = Buffer.from(base64Data.substring(0, 16), 'base64');
      const detected = detectMimeFromBuffer(buf);
      if (detected && !allowedMimes.includes(detected)) {
        return res.status(400).json({ error: 'Ungültiges Bildformat' });
      }
    } catch {}

    next();
  };
}

module.exports = { validateUpload, validateBase64Upload };
