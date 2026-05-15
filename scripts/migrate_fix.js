/**
 * migrate_fix.js – Fehlende Spalten nachträglich anlegen (idempotent)
 */
require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Starte Schema-Fixes...');
    await client.query(`
      ALTER TABLE pools ADD COLUMN IF NOT EXISTS platform_fee_pct NUMERIC(5,2) DEFAULT 1.00;
      ALTER TABLE auszahlungen ADD COLUMN IF NOT EXISTS ausgezahlt_am TIMESTAMPTZ;
      ALTER TABLE auszahlungen ADD COLUMN IF NOT EXISTS zahlungsart VARCHAR(50) DEFAULT 'sepa_instant';
      ALTER TABLE auszahlungen ADD COLUMN IF NOT EXISTS chain_tx VARCHAR(100);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS iban VARCHAR(34);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);
      ALTER TABLE zertifikate ADD COLUMN IF NOT EXISTS geprueft_von UUID REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE zertifikate ADD COLUMN IF NOT EXISTS geprueft_am TIMESTAMPTZ;
      ALTER TABLE commitments ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'aktiv';

      -- touren: fahrer_id + fahrzeug_id + weitere Spalten
      DO $$ BEGIN
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name='touren') THEN
          ALTER TABLE touren ADD COLUMN IF NOT EXISTS fahrer_id   UUID REFERENCES users(id) ON DELETE SET NULL;
          ALTER TABLE touren ADD COLUMN IF NOT EXISTS fahrzeug_id UUID;
          ALTER TABLE touren ADD COLUMN IF NOT EXISTS startzeit   TIME;
          ALTER TABLE touren ADD COLUMN IF NOT EXISTS gestartet_at TIMESTAMPTZ;
          ALTER TABLE touren ADD COLUMN IF NOT EXISTS notiz       TEXT;
        END IF;
      END $$;
      ALTER TABLE pools ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN DEFAULT FALSE;
      CREATE TABLE IF NOT EXISTS fahrer_profile (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lizenzklasse VARCHAR(10) DEFAULT 'B',
        aktiv        BOOLEAN DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id)
      );
      DO $$ BEGIN
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name='tour_stopps') THEN
          ALTER TABLE tour_stopps ADD COLUMN IF NOT EXISTS notiz_abschluss TEXT;
          ALTER TABLE tour_stopps ADD COLUMN IF NOT EXISTS foto_url TEXT;
        END IF;
      END $$;
    `);
    console.log('Schema-Fixes OK');
  } finally {
    client.release();
    await db.end();
  }
}
run().catch(e => { console.error(e); process.exit(1); });
