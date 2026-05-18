# FrischKette

Virtuelle regionale Lebensmittel-Lieferkooperative — Food Hub Köln.

## Stack

| Schicht | Technologie |
|---------|-------------|
| Backend | Node.js · Express · PostgreSQL |
| Frontend | Vanilla JS · HTML · CSS |
| Auth | JWT (30 Tage) + Refresh Tokens |
| Blockchain | Solidity 0.8 · Hardhat · Polygon (optional) |
| E-Mail | Brevo (Transaktional) |
| Zahlungen | Stripe + SEPA pain.001 XML |
| Hosting | Render.com (1 Web Service + 1 PostgreSQL) |

## Projektstruktur

```
src/
  server.js              ← Express-App
  db/index.js            ← pg-Pool
  middleware/            ← auth, sanitize, audit, csrf, upload-validate
  routes/                ← 20+ Route-Dateien
  services/              ← email, payout, push, chain, cron, logger
public/
  admin.html             ← Admin-Dashboard (18 Tabs)
  caterer.html           ← Caterer-Dashboard (7 Tabs)
  erzeuger.html          ← Erzeuger-Dashboard (5 Tabs)
  fahrer.html            ← Fahrer-PWA (4 Tabs, Offline-fähig)
  index.html             ← Landing Page
scripts/
  migrate.js + migrate_hub.js + migrate_flow.js + migrate_fix[1-8].js
  migrate_security.js + migrate_tracking.js + migrate_pfand.js + migrate_rechnung.js
```

## Lokales Setup

```bash
git clone https://github.com/DEIN-USER/frischkette.git
cd frischkette
npm install

cp .env.example .env
# DATABASE_URL und JWT_SECRET eintragen (min. 32 Zeichen)

npm run migrate:all
npm run seed          # Testdaten (optional)
npm run dev
# → http://localhost:3000
```

### Testlogins (nach seed)
| E-Mail | Passwort | Rolle |
|--------|----------|-------|
| erzeuger@test.de | test1234 | Erzeuger |
| caterer@test.de  | test1234 | Caterer |
| admin@test.de    | test1234 | Admin |

## Render.com Deployment

1. **PostgreSQL** anlegen → Internal Database URL kopieren
2. **Web Service** anlegen (Node):
   - Build Command: `npm install && npm run migrate:all`
   - Start Command: `npm start`
3. **Environment Variables** (alle erforderlichen):

```env
# Pflicht
DATABASE_URL=<Internal URL>
JWT_SECRET=<min. 32 zufällige Zeichen>
NODE_ENV=production
APP_URL=https://deine-app.onrender.com
CORS_ORIGIN=https://deine-app.onrender.com
ADMIN_EMAIL=deine@email.de

# E-Mail (Brevo)
BREVO_API_KEY=xkeysib-...
EMAIL_FROM=noreply@frischkette.de

# Push-Notifications (optional)
VAPID_PUBLIC_KEY=...        # npm run vapid
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@frischkette.de

# Zahlungen (optional)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
SEPA_IBAN=DE00000000000000000000
SEPA_BIC=XXXXXXXX
SEPA_NAME=FrischKette

# Blockchain (optional, Standard: mock)
BLOCKCHAIN_ENABLED=false
CONTRACT_ADDRESS=0x...
PRIVATE_KEY=0x...
RPC_URL=https://polygon-rpc.com

# Hub-Koordinaten (für Tourenoptimierung)
HUB_LAT=50.9245
HUB_LON=6.9195
```

## Migrations-Reihenfolge

```
migrate.js → migrate_hub.js → migrate_flow.js →
migrate_fix.js → migrate_fix2.js → migrate_fix3.js → migrate_fix4.js → migrate_fix5.js →
migrate_security.js → migrate_tracking.js →
migrate_fix6.js → migrate_fix7.js →
migrate_pfand.js → migrate_rechnung.js → migrate_fix8.js
```

Alle auf einmal: `npm run migrate:all`

## Features

### Core (Pools + Commitments)
- Pool-Erstellung durch Caterer oder Admin
- Erzeuger sagen Mengen zu (mit Erlösvorschau)
- Auto-Schließen bei Deadline oder Zielerreichung
- SEPA pain.001 XML Export + Stripe Gebühren
- Blockchain-Audit (Polygon, optional)

### Hub (Warenwirtschaft)
- Lagerbestand, Wareneingänge, Korrekturen
- Bedarfsprognosen Caterer
- Mindestbestand-Alerts

### Flow (Logistik)
- Tourenplanung mit Nearest-Neighbor-Optimierung
- E-Lastenrad-Check (< 5 km)
- Fahrer-PWA mit QR-Scanner, GPS-Tracking, Push-Notifications
- Live-Tracking-Karte (Leaflet + OpenStreetMap)

### Sicherheit
- JWT + Refresh Tokens
- 2FA (TOTP) für Admin
- Progressive Lockout (5 Fehlversuche → 15 Min gesperrt)
- CSRF-Origin-Prüfung
- Rate-Limiting (Login, Register, SEPA, Stripe)
- XSS-Sanitization, Upload-Validierung (Magic-Bytes)
- Audit-Log aller Aktionen
- DSGVO (Art. 17 + 20)

## API-Endpunkte (Auswahl)

```
POST /api/auth/login|register|refresh|logout
GET  /api/pools?status=offen&region=NRW
POST /api/pools/:id/commit { menge }
POST /api/lieferungen { pool_id }
POST /api/lieferungen/:id/wareneingang
GET  /api/reports/auszahlungen.csv
GET  /api/sepa/export
POST /api/stripe/collect-fees
GET  /api/tracking/positions
```

## Smart Contracts (optional)

```bash
cd contracts && npm install
npx hardhat test
npx hardhat run scripts/deploy.js --network amoy   # Testnet
npx hardhat run scripts/deploy.js --network polygon # Mainnet
```

Danach `CONTRACT_ADDRESS` in `.env` eintragen und `BLOCKCHAIN_ENABLED=true` setzen.

## Lizenz

Proprietär — superhecht.ai · Mark Rusniok · Köln
