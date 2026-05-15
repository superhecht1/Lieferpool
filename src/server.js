require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const app = express();
app.set('trust proxy', 1);

// Stripe Webhook braucht raw body → vor express.json() mounten
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://js.stripe.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
      fontSrc:       ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
      connectSrc:    ["'self'", 'https://api.stripe.com'],
      imgSrc:        ["'self'", 'data:', 'blob:'],
      frameSrc:      ["'self'", 'https://js.stripe.com'],
    },
  },
}));

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'], credentials: true }));
app.use(express.json({ limit: '10mb' }));

const apiLimiter   = rateLimit({ windowMs:15*60*1000, max:200, standardHeaders:true, legacyHeaders:false, message:{error:'Zu viele Anfragen'} });
const loginLimiter = rateLimit({ windowMs:15*60*1000, max:10,  standardHeaders:true, legacyHeaders:false, message:{error:'Zu viele Login-Versuche'} });
app.use('/api/', apiLimiter);
app.use('/api/auth/login', loginLimiter);

// Blockchain Toggle
const chainMode = process.env.BLOCKCHAIN_ENABLED === 'true' ? 'production' : 'mock';
console.log(`[chain] Modus: ${chainMode}`);

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

// Push Test Endpoint
app.post('/api/push/test', require('./middleware/auth').auth, require('./middleware/auth').role('admin'), async (req, res) => {
  const { fahrer_id, message } = req.body;
  if (!fahrer_id) return res.status(400).json({ error: 'fahrer_id erforderlich' });
  try {
    const push = require('./services/push');
    const db   = require('./db');
    const result = await push.sendToUser(db, fahrer_id, {
      title: '🔔 Test-Push von Admin',
      body:  message || 'Test-Benachrichtigung',
      icon:  '/icon-192.png',
      tag:   'test-' + Date.now(),
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Chain Status
app.get('/api/chain/status', async (req, res) => {
  if (chainMode !== 'production') return res.json({ enabled:false, mode:'mock' });
  try {
    const { ethers } = require('ethers');
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://polygon-rpc.com');
    const blockNr  = await provider.getBlockNumber();
    const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const balance  = await provider.getBalance(wallet.address);
    res.json({ enabled:true, mode:'production', blockNumber:blockNr, contractAddress:process.env.CONTRACT_ADDRESS, walletBalance:ethers.formatEther(balance)+' MATIC' });
  } catch (err) { res.status(503).json({ enabled:true, error:err.message }); }
});

app.get('/health', (_, res) => res.json({ status:'ok', chain:chainMode, ts:new Date().toISOString() }));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// HTML Routes
const pages = ['login','erzeuger','caterer','admin','fahrer'];
pages.forEach(p => app.get('/'+p, (_,res) => res.sendFile(path.join(PUBLIC_DIR, p+'.html'))));
app.get('/', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpunkt nicht gefunden' });
  }
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled:', err);
  res.status(500).json({ error: 'Interner Fehler' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LieferPool :${PORT} [chain:${chainMode}]`);
  try { require('./services/cron').start(); } catch (err) { console.warn('[cron]', err.message); }
});
