require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Pfand – Pfandkisten-System...');
    await client.query(`
      -- Pfand-Spalten in Lieferungen
      ALTER TABLE lieferungen
        ADD COLUMN IF NOT EXISTS pfand_kisten_geliefert  INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS pfand_kisten_zurueck    INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS pfand_pro_kiste         NUMERIC(6,2) DEFAULT 3.00,
        ADD COLUMN IF NOT EXISTS pfand_gesamt            NUMERIC(10,2) GENERATED ALWAYS AS
          (pfand_kisten_geliefert * pfand_pro_kiste) STORED,
        ADD COLUMN IF NOT EXISTS pfand_offen             NUMERIC(10,2) GENERATED ALWAYS AS
          ((pfand_kisten_geliefert - pfand_kisten_zurueck) * pfand_pro_kiste) STORED;

      -- Pfand-Konto: wer schuldet wem wie viele Kisten
      CREATE TABLE IF NOT EXISTS pfand_konten (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type   VARCHAR(20) NOT NULL CHECK (entity_type IN ('erzeuger','caterer')),
        entity_id     UUID NOT NULL,
        kisten_saldo  INTEGER DEFAULT 0,  -- negativ = schuldet Kisten
        pfand_saldo   NUMERIC(10,2) DEFAULT 0.00,
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (entity_type, entity_id)
      );

      -- Pfand-Bewegungen (Audit-Trail)
      CREATE TABLE IF NOT EXISTS pfand_bewegungen (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lieferung_id  UUID REFERENCES lieferungen(id) ON DELETE SET NULL,
        entity_type   VARCHAR(20) NOT NULL,
        entity_id     UUID NOT NULL,
        bewegung_typ  VARCHAR(30) NOT NULL,
        kisten_anzahl INTEGER NOT NULL DEFAULT 0,
        pfand_betrag  NUMERIC(10,2) NOT NULL DEFAULT 0,
        notiz         TEXT,
        created_by    UUID REFERENCES users(id),
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pfand_bew_entity ON pfand_bewegungen(entity_type, entity_id);
    `);
    console.log('Migration Pfand OK');
  } catch(err) { console.error('Fehler:', err.message); process.exit(1); }
  finally { client.release(); await db.end(); }
}
run();
