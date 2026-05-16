require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Tracking...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS fahrer_position (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        fahrer_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tour_id     UUID REFERENCES touren(id) ON DELETE SET NULL,
        lat         DECIMAL(10,7) NOT NULL,
        lon         DECIMAL(10,7) NOT NULL,
        speed_kmh   DECIMAL(5,1),
        heading     DECIMAL(5,1),
        accuracy_m  DECIMAL(7,1),
        aktiv       BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pos_fahrer  ON fahrer_position(fahrer_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pos_aktiv   ON fahrer_position(aktiv, created_at DESC);

      -- Letzte Position pro Fahrer (Materialized View Alternative: simple table)
      CREATE TABLE IF NOT EXISTS fahrer_position_live (
        fahrer_id   UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        tour_id     UUID REFERENCES touren(id) ON DELETE SET NULL,
        lat         DECIMAL(10,7),
        lon         DECIMAL(10,7),
        speed_kmh   DECIMAL(5,1),
        heading     DECIMAL(5,1),
        accuracy_m  DECIMAL(7,1),
        online      BOOLEAN DEFAULT TRUE,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Tracking Migration OK');
  } finally { client.release(); await db.end(); }
}
run().catch(e => { console.error(e); process.exit(1); });
