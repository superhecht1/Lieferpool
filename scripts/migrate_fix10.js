require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();
  try {
    await c.query(`
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS lon NUMERIC(10,7);
      ALTER TABLE caterer  ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7);
      ALTER TABLE caterer  ADD COLUMN IF NOT EXISTS lon NUMERIC(10,7);

      CREATE TABLE IF NOT EXISTS abfall_meldungen (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        caterer_id       UUID NOT NULL REFERENCES caterer(id) ON DELETE CASCADE,
        lieferung_id     UUID REFERENCES lieferungen(id) ON DELETE SET NULL,
        produkt          TEXT,
        datum            DATE NOT NULL DEFAULT CURRENT_DATE,
        menge_verbraucht NUMERIC(10,2) NOT NULL DEFAULT 0,
        menge_entsorgt   NUMERIC(10,2) NOT NULL DEFAULT 0,
        grund            TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE abfall_meldungen ADD COLUMN IF NOT EXISTS menge_weitergegeben NUMERIC(10,2) NOT NULL DEFAULT 0;
      ALTER TABLE abfall_meldungen ADD COLUMN IF NOT EXISTS weitergegeben_an TEXT;

      -- Bedarf: robust gegen ältere Tabellenstände
      ALTER TABLE bedarf_prognosen ADD COLUMN IF NOT EXISTS einheit TEXT NOT NULL DEFAULT 'kg';
      ALTER TABLE bedarf_prognosen ADD COLUMN IF NOT EXISTS aktiv BOOLEAN DEFAULT true;
      ALTER TABLE bedarf_prognosen ADD COLUMN IF NOT EXISTS notiz TEXT;
      ALTER TABLE bedarf_prognosen ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE bedarf_prognosen ADD COLUMN IF NOT EXISTS qualitaet_praeferenz VARCHAR(20) DEFAULT 'A';
      ALTER TABLE bedarf_prognosen ADD COLUMN IF NOT EXISTS umpack BOOLEAN DEFAULT false;

      -- Pools: feste Liefertage und Zeitfenster (Food-Hub-Empfehlung: Mo/Mi/Fr, 06:30-09:00)
      ALTER TABLE pools ADD COLUMN IF NOT EXISTS liefertag TEXT;
      ALTER TABLE pools ADD COLUMN IF NOT EXISTS zeitfenster_von TIME DEFAULT '06:30';
      ALTER TABLE pools ADD COLUMN IF NOT EXISTS zeitfenster_bis TIME DEFAULT '09:00';

      CREATE INDEX IF NOT EXISTS idx_abfall_caterer ON abfall_meldungen(caterer_id, datum DESC);
    `);
    console.log('Migration Fix 10 OK (Koordinaten + abfall_meldungen)');
  } catch (e) {
    console.error('Migration Fix 10 fehlgeschlagen:', e.message);
    process.exit(1);
  } finally { c.release(); await pool.end(); }
})();
