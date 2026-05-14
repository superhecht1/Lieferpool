require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'"],
      imgSrc:     ["'self'", 'data:'],
    },
  },
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

const apiLimiter   = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anfragen' } });
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Zu viele Login-Versuche' } });
app.use('/api/', apiLimiter);
app.use('/api/auth/login', loginLimiter);

// ── Core Routes ────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/pools',       require('./routes/pools'));
app.use('/api/erzeuger',    require('./routes/erzeuger'));
app.use('/api/lieferungen', require('./routes/lieferungen'));

// ── Hub Module Routes ──────────────────────────────────────────
app.use('/api/lager',       require('./routes/lager'));
app.use('/api/bedarf',      require('./routes/bedarf'));

// ── Flow Module Routes ─────────────────────────────────────────
app.use('/api/touren',      require('./routes/touren'));
app.use('/api/fahrzeuge',   require('./routes/fahrzeuge'));

// Health Check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Statische Dateien
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// HTML-Routen
app.get('/',         (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/login',    (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/erzeuger', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'erzeuger.html')));
app.get('/caterer',  (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'caterer.html')));
app.get('/admin',    (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/fahrer',   (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'fahrer.html')));

app.get(/^(?!\/api)/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Interner Fehler' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LieferPool läuft auf Port ${PORT}`);
  console.log(`  /api/touren    → Tourenplanung (Flow)`);
  console.log(`  /api/fahrzeuge → Fuhrpark (Flow)`);
  console.log(`  /fahrer        → Fahrer-App (mobil)`);
});
