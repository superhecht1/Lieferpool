require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Fix 4...');
    await client.query(`
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS adresse          VARCHAR(200);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS plz              VARCHAR(10);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS ort              VARCHAR(100);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS telefon          VARCHAR(30);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS website          VARCHAR(200);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS beschreibung     TEXT;
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS ust_id           VARCHAR(20);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS kuechen_typ      VARCHAR(50);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS kuechen_kapazitaet VARCHAR(50);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS anz_plaetze      INTEGER;
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS bank_name        VARCHAR(100);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS iban             VARCHAR(34);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS gruendungsjahr   SMALLINT;

      ALTER TABLE auszahlungen ADD COLUMN IF NOT EXISTS stripe_payment_intent VARCHAR(200);
      ALTER TABLE auszahlungen ADD COLUMN IF NOT EXISTS stripe_fee_collected   BOOLEAN DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS stripe_sessions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pool_id         UUID REFERENCES pools(id) ON DELETE SET NULL,
        auszahlung_ids  UUID[],
        stripe_session_id VARCHAR(200) UNIQUE,
        amount_cents    INTEGER,
        status          VARCHAR(30) DEFAULT 'pending',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Migration Fix 4 OK');
  } finally { client.release(); await db.end(); }
}
run().catch(e => { console.error(e); process.exit(1); });
