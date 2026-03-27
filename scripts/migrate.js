require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `
-- ============================================================
-- LIEFERPOOL DATABASE SCHEMA
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------
-- USERS & ROLES
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('erzeuger', 'caterer', 'admin')),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- ERZEUGER (Betrieb)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erzeuger (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  betrieb_name    TEXT NOT NULL,
  region          TEXT NOT NULL DEFAULT 'NRW',
  iban            TEXT,
  bank_name       TEXT,
  blockchain_did  TEXT UNIQUE,       -- Decentralized Identifier
  onboarding_done BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- ZERTIFIKATE
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zertifikate (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  erzeuger_id    UUID REFERENCES erzeuger(id) ON DELETE CASCADE,
  typ            TEXT NOT NULL,         -- 'Bio', 'QS', 'Demeter', 'Hygiene'
  zert_nummer    TEXT,
  datei_pfad     TEXT,                  -- S3 key
  datei_hash     TEXT,                  -- SHA256 – on-chain gespeichert
  chain_tx       TEXT,                  -- Blockchain TX Hash
  status         TEXT DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  gueltig_bis    DATE,
  geprueft_von   UUID REFERENCES users(id),
  geprueft_am    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- CATERER (Abnehmer)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS caterer (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  firma_name   TEXT NOT NULL,
  region       TEXT NOT NULL DEFAULT 'NRW',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- POOLS (Angebotsbündelung)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pools (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  caterer_id     UUID REFERENCES caterer(id),
  produkt        TEXT NOT NULL,
  einheit        TEXT NOT NULL DEFAULT 'kg',
  menge_ziel     NUMERIC(10,2) NOT NULL,
  menge_committed NUMERIC(10,2) DEFAULT 0,
  preis_pro_einheit NUMERIC(8,2) NOT NULL,
  region         TEXT NOT NULL DEFAULT 'NRW',
  lieferwoche    TEXT NOT NULL,          -- z.B. '2025-W20'
  deadline       TIMESTAMPTZ NOT NULL,
  qualitaet_stufe TEXT DEFAULT 'A',
  toleranz_pct   NUMERIC(4,2) DEFAULT 5,
  status         TEXT DEFAULT 'offen' CHECK (status IN ('offen','geschlossen','geliefert','abgebrochen')),
  chain_contract TEXT,                   -- Smart Contract Adresse
  chain_tx       TEXT,
  platform_fee_pct NUMERIC(4,2) DEFAULT 1.0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- COMMITMENTS (Erzeuger → Pool)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commitments (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pool_id      UUID REFERENCES pools(id) ON DELETE CASCADE,
  erzeuger_id  UUID REFERENCES erzeuger(id),
  menge        NUMERIC(10,2) NOT NULL,
  status       TEXT DEFAULT 'aktiv' CHECK (status IN ('aktiv','zurueckgezogen','geliefert','teilgeliefert')),
  chain_tx     TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- LIEFERUNGEN (physische Lieferung)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lieferungen (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pool_id         UUID REFERENCES pools(id),
  lieferschein_nr TEXT UNIQUE NOT NULL,
  qr_code         TEXT UNIQUE NOT NULL,
  menge_bestellt  NUMERIC(10,2) NOT NULL,
  menge_geliefert NUMERIC(10,2),
  qualitaet       TEXT CHECK (qualitaet IN ('A','B','C','abgelehnt')),
  lieferdatum     DATE,
  wareneingang_at TIMESTAMPTZ,
  bestaetigt_von  UUID REFERENCES users(id),     -- Caterer-User
  lieferschein_hash TEXT,                         -- on-chain
  chain_tx        TEXT,
  status          TEXT DEFAULT 'geplant' CHECK (status IN ('geplant','unterwegs','eingegangen','abgelehnt')),
  notiz           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- AUSZAHLUNGEN
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auszahlungen (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  commitment_id UUID REFERENCES commitments(id),
  lieferung_id  UUID REFERENCES lieferungen(id),
  erzeuger_id   UUID REFERENCES erzeuger(id),
  brutto        NUMERIC(10,2) NOT NULL,
  abzug_qualitaet NUMERIC(10,2) DEFAULT 0,
  platform_fee  NUMERIC(10,2) DEFAULT 0,
  netto         NUMERIC(10,2) NOT NULL,
  status        TEXT DEFAULT 'ausstehend' CHECK (status IN ('ausstehend','veranlasst','ausgezahlt','fehlgeschlagen')),
  zahlungsart   TEXT DEFAULT 'sepa_instant',
  chain_tx      TEXT,
  ausgezahlt_am TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- BLOCKCHAIN EVENTS LOG (Audit)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chain_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type  TEXT NOT NULL,   -- 'commitment', 'pool_lock', 'delivery', 'payout'
  entity_id   UUID NOT NULL,
  entity_type TEXT NOT NULL,
  tx_hash     TEXT,
  block_nr    BIGINT,
  payload     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- INDIZES
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_commitments_pool    ON commitments(pool_id);
CREATE INDEX IF NOT EXISTS idx_commitments_erzeuger ON commitments(erzeuger_id);
CREATE INDEX IF NOT EXISTS idx_pools_caterer        ON pools(caterer_id);
CREATE INDEX IF NOT EXISTS idx_pools_status         ON pools(status);
CREATE INDEX IF NOT EXISTS idx_zertifikate_erzeuger ON zertifikate(erzeuger_id);
CREATE INDEX IF NOT EXISTS idx_auszahlungen_erzeuger ON auszahlungen(erzeuger_id);
CREATE INDEX IF NOT EXISTS idx_chain_events_entity  ON chain_events(entity_id);

-- ----------------------------------------------------------------
-- TRIGGER: updated_at automatisch setzen
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS \$\$ BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END; \$\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pools_updated_at ON pools;
CREATE TRIGGER trg_pools_updated_at
  BEFORE UPDATE ON pools
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');
    await client.query(schema);
    console.log('✅ Schema ready');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
