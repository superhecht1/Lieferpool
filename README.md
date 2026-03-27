# LieferPool

Virtuelle Lieferkooperative: Kleinerzeuger bündeln Mengen on-chain → ein verlässlicher Großlieferant für Caterer.

## Stack

| Schicht | Technologie |
|---------|-------------|
| Backend | Node.js · Express · PostgreSQL |
| Frontend | Vanilla JS · HTML · CSS (kein Framework) |
| Auth | JWT (30 Tage) |
| Blockchain | Solidity 0.8 · Hardhat · Polygon |
| Hosting | Render.com (1 Web Service + 1 PostgreSQL) |

## Projektstruktur

```
lieferpool/
├── src/
│   ├── server.js              ← Express + statisches Frontend
│   ├── db/index.js            ← pg Pool
│   ├── middleware/auth.js     ← JWT verify + role()
│   ├── routes/
│   │   ├── auth.js            ← POST /api/auth/login|register
│   │   ├── pools.js           ← GET|POST /api/pools + /commit
│   │   ├── erzeuger.js        ← Profil, Zertifikate, Auszahlungen
│   │   └── lieferungen.js     ← QR-Scan, Wareneingang → Auszahlung
│   └── services/
│       ├── chain.js           ← Blockchain Mock (default)
│       ├── chain.production.js← ethers.js Drop-in für Produktion
│       └── payout.js          ← anteilige Auszahlungsberechnung
├── scripts/
│   ├── migrate.js             ← DB-Schema (9 Tabellen)
│   └── seed.js                ← Testdaten
├── public/                    ← Frontend (wird von Express serviert)
│   ├── index.html             ← Login / Registrierung
│   ├── erzeuger.html          ← Erzeuger-Dashboard
│   ├── caterer.html           ← Caterer-Dashboard
│   ├── admin.html             ← Admin-Dashboard
│   ├── style.css
│   ├── api.js                 ← Alle API-Calls zentral
│   └── app.js                 ← Auth-Guard, Hilfsfunktionen
└── contracts/                 ← Solidity Smart Contracts (optional)
    ├── contracts/
    │   ├── ProducerRegistry.sol
    │   ├── SupplyPool.sol
    │   └── DeliveryContract.sol
    ├── scripts/deploy.js
    └── test/LieferPool.test.js
```

## Lokales Setup

```bash
git clone https://github.com/DEIN-USER/lieferpool.git
cd lieferpool

# Abhängigkeiten
npm install

# Environment
cp .env.example .env
# DATABASE_URL und JWT_SECRET eintragen

# Datenbank
npm run migrate
npm run seed      # Testdaten (optional)

# Starten
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
   - Build Command: `npm install && npm run migrate`
   - Start Command: `npm start`
3. **Environment Variables** setzen:
   ```
   DATABASE_URL=<Internal URL aus Schritt 1>
   JWT_SECRET=<mindestens 32 zufällige Zeichen>
   NODE_ENV=production
   ```
4. Deploy → fertig. Frontend und API laufen auf einer URL.

## API-Endpunkte

### Auth
```
POST /api/auth/register   { email, password, role, name }
POST /api/auth/login      { email, password } → { token, user }
GET  /api/auth/me
```

### Pools
```
GET  /api/pools           ?status=offen&region=NRW
POST /api/pools           (Caterer) { produkt, menge_ziel, preis_pro_einheit, lieferwoche, deadline }
POST /api/pools/:id/commit (Erzeuger) { menge }
```

### Erzeuger
```
GET  /api/erzeuger/me
PUT  /api/erzeuger/me
POST /api/erzeuger/zertifikate
GET  /api/erzeuger/auszahlungen
GET  /api/erzeuger                        (Admin)
GET  /api/erzeuger/zertifikate/pending    (Admin)
PUT  /api/erzeuger/zertifikate/:id/status (Admin)
```

### Lieferungen
```
POST /api/lieferungen               (Admin/Caterer)
GET  /api/lieferungen/scan/:qr      (Caterer)
POST /api/lieferungen/:id/wareneingang → löst Auszahlungen aus
```

## Smart Contracts (optional)

```bash
cd contracts
npm install

# Lokal testen
npx hardhat node
npx hardhat test

# Testnet deployen (Polygon Amoy)
npx hardhat run scripts/deploy.js --network amoy
```

Nach Deployment die Contract-Adressen in `.env` eintragen und `chain.production.js` aktivieren:

```bash
cp src/services/chain.production.js src/services/chain.js
```

## Datenmodell (Kurzübersicht)

```
users → erzeuger / caterer
erzeuger → zertifikate
pools (caterer) → commitments (erzeuger)
pools → lieferungen → auszahlungen
chain_events (Blockchain-Audit-Log)
```

## Lizenz

MIT
