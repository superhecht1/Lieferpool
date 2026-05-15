require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:       ["'self'", 'https://fonts.gstatic.com'],
      connectSrc:    ["'self'"],
      imgSrc:        ["'self'", 'data:'],
    },
  },
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

const apiLimiter   = rateLimit({ windowMs:15*60*1000, max:200, standardHeaders:true, legacyHeaders:false, message:{error:'Zu viele Anfragen'} });
const loginLimiter = rateLimit({ windowMs:15*60*1000, max:10,  standardHeaders:true, legacyHeaders:false, message:{error:'Zu viele Login-Versuche'} });
app.use('/api/', apiLimiter);
app.use('/api/auth/login', loginLimiter);

// ── Routes ─────────────────────────────────────────────────────
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/pools',        require('./routes/pools'));
app.use('/api/erzeuger',     require('./routes/erzeuger'));
app.use('/api/lieferungen',  require('./routes/lieferungen'));
app.use('/api/lager',        require('./routes/lager'));
app.use('/api/bedarf',       require('./routes/bedarf'));
app.use('/api/touren',       require('./routes/touren'));
app.use('/api/fahrzeuge',    require('./routes/fahrzeuge'));
app.use('/api/auszahlungen', require('./routes/auszahlungen'));
app.use('/api/reports',      require('./routes/reports'));

app.get('/health', (req, res) => res.json({ status:'ok', ts:new Date().toISOString() }));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/',         (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/login',    (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/erzeuger', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'erzeuger.html')));
app.get('/caterer',  (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'caterer.html')));
app.get('/admin',    (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/fahrer',   (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'fahrer.html')));

app.get(/^(?!\/api)/, (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Interner Fehler' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LieferPool :${PORT}`);
  // Hintergrund-Jobs starten
  try {
    const cron = require('./services/cron');
    cron.start();
  } catch (err) {
    console.warn('[cron] Konnte nicht gestartet werden:', err.message);
  }
});
