require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Fix 5 – Lieferungen Schema...');
    await client.query(`
      -- Lieferungen Tabelle komplett sicherstellen
      CREATE TABLE IF NOT EXISTS lieferungen (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pool_id          UUID NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
        lieferschein_nr  VARCHAR(50) UNIQUE NOT NULL,
        qr_code          VARCHAR(50) UNIQUE NOT NULL,
        lieferdatum      DATE,
        menge_bestellt   NUMERIC(10,2),
        menge_geliefert  NUMERIC(10,2),
        qualitaet        VARCHAR(20),
        status           VARCHAR(30) DEFAULT 'offen',
        notiz            TEXT,
        wareneingang_at  TIMESTAMPTZ,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );

      -- Fehlende Spalten nachrüsten
      ALTER TABLE lieferungen ADD COLUMN IF NOT EXISTS lieferdatum     DATE;
      ALTER TABLE lieferungen ADD COLUMN IF NOT EXISTS menge_bestellt  NUMERIC(10,2);
      ALTER TABLE lieferungen ADD COLUMN IF NOT EXISTS menge_geliefert NUMERIC(10,2);
      ALTER TABLE lieferungen ADD COLUMN IF NOT EXISTS qualitaet       VARCHAR(20);
      ALTER TABLE lieferungen ADD COLUMN IF NOT EXISTS notiz           TEXT;
      ALTER TABLE lieferungen ADD COLUMN IF NOT EXISTS wareneingang_at TIMESTAMPTZ;

      -- Index für schnelle Pool-Suche
      CREATE INDEX IF NOT EXISTS idx_lieferungen_pool ON lieferungen(pool_id);
      CREATE INDEX IF NOT EXISTS idx_lieferungen_qr   ON lieferungen(qr_code);
    `);
    console.log('Migration Fix 5 OK');
  } finally {
    client.release();
    await db.end();
  }
}
run().catch(e => { console.error(e); process.exit(1); });
