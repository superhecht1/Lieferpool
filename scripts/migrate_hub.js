require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `
-- ============================================================
-- LIEFERPOOL HUB MODULE – DB SCHEMA
-- ============================================================

-- ----------------------------------------------------------------
-- LAGER-POSITIONEN: aktueller Bestand pro Produkt
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lager_positionen (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  produkt         TEXT NOT NULL,
  einheit         TEXT NOT NULL DEFAULT 'kg',
  bestand         NUMERIC(10,2) NOT NULL DEFAULT 0,
  mindestbestand  NUMERIC(10,2) NOT NULL DEFAULT 0,
  region          TEXT NOT NULL DEFAULT 'NRW',
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (produkt, region)
);

-- ----------------------------------------------------------------
-- LAGER-BEWEGUNGEN: jede Ein-/Ausbuchung
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lager_bewegungen (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lager_id        UUID REFERENCES lager_positionen(id) ON DELETE CASCADE,
  typ             TEXT NOT NULL CHECK (typ IN ('eingang', 'ausgang', 'korrektur')),
  menge           NUMERIC(10,2) NOT NULL,
  bestand_nach    NUMERIC(10,2),                        -- Bestand nach der Buchung
  pool_id         UUID REFERENCES pools(id),            -- Verknüpfung Eingang ↔ Pool
  lieferung_id    UUID REFERENCES lieferungen(id),       -- Verknüpfung Eingang ↔ Lieferung
  abnehmer_ref    TEXT,                                  -- Freitext: wer hat abgeholt / wohin
  qualitaet       TEXT CHECK (qualitaet IN ('A','B','C','abgelehnt')),
  notiz           TEXT,
  erstellt_von    UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- BEDARF-PROGNOSEN: wöchentlicher Bedarf je Caterer × Produkt
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedarf_prognosen (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  caterer_id        UUID REFERENCES caterer(id) ON DELETE CASCADE,
  produkt           TEXT NOT NULL,
  einheit           TEXT NOT NULL DEFAULT 'kg',
  menge_pro_woche   NUMERIC(10,2) NOT NULL,
  liefertage        TEXT[],           -- ['Montag','Mittwoch','Freitag']
  aktiv             BOOLEAN DEFAULT true,
  notiz             TEXT,
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- INDIZES
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_lager_bewegungen_lager    ON lager_bewegungen(lager_id);
CREATE INDEX IF NOT EXISTS idx_lager_bewegungen_pool     ON lager_bewegungen(pool_id);
CREATE INDEX IF NOT EXISTS idx_lager_bewegungen_created  ON lager_bewegungen(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bedarf_prognosen_caterer  ON bedarf_prognosen(caterer_id);
CREATE INDEX IF NOT EXISTS idx_bedarf_prognosen_produkt  ON bedarf_prognosen(produkt);

-- ----------------------------------------------------------------
-- TRIGGER: updated_at für lager_positionen + bedarf_prognosen
-- ----------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_lager_updated_at ON lager_positionen;
CREATE TRIGGER trg_lager_updated_at
  BEFORE UPDATE ON lager_positionen
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_bedarf_updated_at ON bedarf_prognosen;
CREATE TRIGGER trg_bedarf_updated_at
  BEFORE UPDATE ON bedarf_prognosen
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running Hub module migration...');
    await client.query(schema);
    console.log('✅ Hub schema ready (lager_positionen, lager_bewegungen, bedarf_prognosen)');
  } catch (err) {
    console.error('❌ Hub migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
