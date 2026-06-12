/**
 * migrate_fix9.js – Nachrichten-System
 */
require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  console.log('[migrate_fix9] Nachrichten-System...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS nachrichten (
      id           SERIAL PRIMARY KEY,
      von_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
      an_user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
      betreff      TEXT    NOT NULL DEFAULT '',
      text         TEXT    NOT NULL,
      gelesen      BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_nachrichten_an      ON nachrichten(an_user_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_nachrichten_von     ON nachrichten(von_user_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_nachrichten_gelesen ON nachrichten(an_user_id, gelesen)`);

  // Stats: monatliche Auszahlungen-Aggregation für Reports-Chart
  await db.query(`
    CREATE TABLE IF NOT EXISTS stats_cache (
      id         SERIAL PRIMARY KEY,
      typ        VARCHAR(50) NOT NULL,
      periode    VARCHAR(20) NOT NULL,
      data       JSONB       NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(typ, periode)
    )
  `);



  // users: aktiv Spalte sicherstellen
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS aktiv BOOLEAN DEFAULT true`);


  // ── Blockchain-Support ──────────────────────────────────────
  // chain_tx Spalten
  await db.query(`ALTER TABLE pools        ADD COLUMN IF NOT EXISTS chain_tx VARCHAR(100)`);
  await db.query(`ALTER TABLE commitments  ADD COLUMN IF NOT EXISTS chain_tx VARCHAR(100)`);
  await db.query(`ALTER TABLE lieferungen  ADD COLUMN IF NOT EXISTS chain_tx VARCHAR(100)`);
  await db.query(`ALTER TABLE auszahlungen ADD COLUMN IF NOT EXISTS chain_tx VARCHAR(100)`);
  await db.query(`ALTER TABLE zertifikate  ADD COLUMN IF NOT EXISTS chain_tx VARCHAR(100)`);
  await db.query(`ALTER TABLE zertifikate  ADD COLUMN IF NOT EXISTS cert_hash VARCHAR(200)`);

  // chain_events Tabelle
  await db.query(`
    CREATE TABLE IF NOT EXISTS chain_events (
      id          SERIAL PRIMARY KEY,
      event_type  VARCHAR(60)  NOT NULL,
      entity_id   UUID,
      entity_type VARCHAR(40),
      tx_hash     VARCHAR(100),
      block_nr    INTEGER,
      payload     JSONB        DEFAULT '{}',
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_chain_events_entity ON chain_events(entity_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_chain_events_type   ON chain_events(event_type)`);

  // fahrer_profile: lizenzklasse Spalte (Code erwartet diese, Migration hatte nur 'fuehrerschein')
  await db.query(`
    ALTER TABLE fahrer_profile
    ADD COLUMN IF NOT EXISTS lizenzklasse VARCHAR(10) DEFAULT 'B'
  `);
  await db.query(`
    UPDATE fahrer_profile SET lizenzklasse = fuehrerschein
    WHERE lizenzklasse = 'B' AND fuehrerschein IS NOT NULL
  `);

  console.log('[migrate_fix9] ✓ done');
  await db.end();
  process.exit(0);
}

migrate().catch(async err => { console.error(err); await db.end(); process.exit(1); });
