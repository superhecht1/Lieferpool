require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
const path      = require('path');

const app = express();
app.set('trust proxy', 1);

// ── X-Request-ID ───────────────────────────────────────────────
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ── Stripe Webhook (raw body) ──────────────────────────────────
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// ── Helmet / Security Headers ──────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://js.stripe.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
      fontSrc:       ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
      connectSrc:    ["'self'", 'https://api.stripe.com'],
      imgSrc:        ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org'],
      frameSrc:      ["'self'", 'https://js.stripe.com'],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permittedCrossDomainPolicies: false,
}));

// ── CORS ───────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: ${origin} nicht erlaubt`));
    }
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID'],
}));

app.use(express.json({ limit: '10mb' }));

// ── Input Sanitization ─────────────────────────────────────────
const { sanitizeBody } = require('./middleware/sanitize');
app.use(sanitizeBody);

// ── Rate Limiting ──────────────────────────────────────────────
const makeLimit = (max, windowMin = 15, msg = 'Zu viele Anfragen') =>
  rateLimit({ windowMs: windowMin*60*1000, max, standardHeaders: true, legacyHeaders: false, message: { error: msg }, keyGenerator: (req) => req.ip });

app.use('/api/', makeLimit(200));
app.use('/api/auth/login',         makeLimit(10,  15, 'Zu viele Login-Versuche – 15 Min. warten'));
app.use('/api/auth/register',      makeLimit(5,   60, 'Registrierungslimit erreicht'));
app.use('/api/auth/refresh',       makeLimit(30,   5, 'Zu viele Refresh-Anfragen'));
app.use('/api/auszahlungen/bulk',  makeLimit(5,   60, 'Bulk-Aktion zu häufig'));
app.use('/api/sepa/export',        makeLimit(3,   60, 'SEPA-Export zu häufig'));
app.use('/api/stripe/collect',     makeLimit(5,   60, 'Stripe zu häufig'));

// Blockchain-Toggle
const chainMode = process.env.BLOCKCHAIN_ENABLED === 'true' ? 'production' : 'mock';
console.log(`[chain] ${chainMode}`);

// ── Routes ─────────────────────────────────────────────────────
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/pools',        require('./routes/pools'));
app.use('/api/erzeuger',     require('./routes/erzeuger'));
app.use('/api/caterer',      require('./routes/caterer'));
app.use('/api/lieferungen',  require('./routes/lieferungen'));
app.use('/api/lager',        require('./routes/lager'));
app.use('/api/bedarf',       require('./routes/bedarf'));
app.use('/api/touren',       require('./routes/touren'));
app.use('/api/fahrzeuge',    require('./routes/fahrzeuge'));
app.use('/api/auszahlungen', require('./routes/auszahlungen'));
app.use('/api/reports',      require('./routes/reports'));
app.use('/api/stripe',       require('./routes/stripe'));
app.use('/api/sepa',         require('./routes/sepa'));
app.use('/api/print',        require('./routes/print'));
app.use('/api/tracking',     require('./routes/tracking'));
app.use('/api/audit',        require('./middleware/audit').router);

// Chain Status
app.get('/api/chain/status', async (req, res) => {
  if (chainMode !== 'production') return res.json({ enabled: false, mode: 'mock' });
  try {
    const { ethers } = require('ethers');
    const provider   = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://polygon-rpc.com');
    const blockNr    = await provider.getBlockNumber();
    const wallet     = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const balance    = await provider.getBalance(wallet.address);
    res.json({ enabled: true, mode: 'production', blockNumber: blockNr,
      contractAddress: process.env.CONTRACT_ADDRESS,
      walletBalance: ethers.formatEther(balance) + ' MATIC' });
  } catch (err) { res.status(503).json({ enabled: true, error: err.message }); }
});

// Push Test
app.post('/api/push/test', require('./middleware/auth').auth, require('./middleware/auth').role('admin'), async (req, res) => {
  const { fahrer_id, message } = req.body;
  if (!fahrer_id) return res.status(400).json({ error: 'fahrer_id erforderlich' });
  try {
    const push = require('./services/push');
    const db   = require('./db');
    const result = await push.sendToUser(db, fahrer_id, {
      title: '🔔 Test-Push von Admin', body: message || 'Test', icon: '/icon-192.png', tag: 'test-' + Date.now(),
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (_, res) => res.json({ status: 'ok', chain: chainMode, ts: new Date().toISOString() }));

// ── Static + HTML Routes ───────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

['login','erzeuger','caterer','admin','fahrer','impressum','datenschutz','agb'].forEach(p => {
  app.get('/' + p, (_, res) => res.sendFile(path.join(PUBLIC_DIR, p + '.html')));
});
app.get('/', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpunkt nicht gefunden' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  const reqId = req.id || '?';
  console.error(`[${reqId}] Unhandled:`, err.message);
  if (err.message?.includes('CORS')) return res.status(403).json({ error: err.message });
  res.status(500).json({ error: 'Interner Fehler', requestId: reqId });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LieferPool :${PORT} [chain:${chainMode}]`);
  try { require('./services/cron').start(); } catch (err) { console.warn('[cron]', err.message); }
  // JWT Secret Warnung
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32) console.warn('⚠ JWT_SECRET zu kurz! Mindestens 32 Zeichen verwenden.');
});
