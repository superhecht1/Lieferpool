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

const apiLimiter = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anfragen' } });
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Zu viele Login-Versuche' } });
app.use('/api/', apiLimiter);
app.use('/api/auth/login', loginLimiter);

// API Routes
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/pools',       require('./routes/pools'));
app.use('/api/erzeuger',    require('./routes/erzeuger'));
app.use('/api/lieferungen', require('./routes/lieferungen'));

// Health Check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Frontend – statische Dateien aus /public
// Frontend-HTMLs/CSS/JS einfach in public/ legen, fertig.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// Alle nicht-API Routen -> index.html
app.get(/^(?!\/api)/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Interner Fehler' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LieferPool lauft auf Port ${PORT}`);
  console.log(`  Frontend: http://localhost:${PORT}`);
  console.log(`  API:      http://localhost:${PORT}/api`);
});
