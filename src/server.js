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
      imgSrc:        ["'self'", 'data:', 'blob:'],
    },
  },
}));
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'], credentials: true }));
app.use(express.json({ limit: '10mb' }));

const apiLimiter   = rateLimit({ windowMs:15*60*1000, max:200, standardHeaders:true, legacyHeaders:false, message:{error:'Zu viele Anfragen'} });
const loginLimiter = rateLimit({ windowMs:15*60*1000, max:10,  standardHeaders:true, legacyHeaders:false, message:{error:'Zu viele Login-Versuche'} });
app.use('/api/', apiLimiter);
app.use('/api/auth/login', loginLimiter);

// ── Blockchain Toggle ──────────────────────────────────────────
const chainMode = process.env.BLOCKCHAIN_ENABLED === 'true' ? 'production' : 'mock';
console.log(`[chain] Modus: ${chainMode}`);

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

// ── Blockchain Status Endpoint ─────────────────────────────────
app.get('/api/chain/status', async (req, res) => {
  if (chainMode !== 'production') {
    return res.json({ enabled: false, mode: 'mock', message: 'BLOCKCHAIN_ENABLED nicht gesetzt' });
  }
  try {
    const { ethers } = require('ethers');
    const provider   = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://polygon-rpc.com');
    const blockNr    = await provider.getBlockNumber();
    const wallet     = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const balance    = await provider.getBalance(wallet.address);
    res.json({
      enabled:         true,
      mode:            'production',
      network:         'Polygon',
      blockNumber:     blockNr,
      contractAddress: process.env.CONTRACT_ADDRESS,
      walletAddress:   wallet.address,
      walletBalance:   ethers.formatEther(balance) + ' MATIC',
    });
  } catch (err) {
    res.status(503).json({ enabled: true, mode: 'production', error: err.message });
  }
});

// ── Pool Chain-Audit ───────────────────────────────────────────
app.get('/api/chain/pool/:id', async (req, res) => {
  if (chainMode !== 'production') return res.json({ mode: 'mock' });
  try {
    const chain = require('./services/chain.production');
    const data  = await chain.getPoolFromChain(req.params.id);
    res.json({ pool: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status:'ok', chain:chainMode, ts:new Date().toISOString() }));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

['','login','erzeuger','caterer','admin','fahrer'].forEach(route => {
  app.get('/' + route, (_, res) => res.sendFile(path.join(PUBLIC_DIR, route ? route+'.html' : 'index.html')));
});

app.get(/^(?!\/api)/, (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error:'Interner Fehler' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LieferPool :${PORT} [chain:${chainMode}]`);
  try { require('./services/cron').start(); } catch (err) { console.warn('[cron]', err.message); }
});
