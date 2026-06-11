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
      von_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      an_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
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

  console.log('[migrate_fix9] ✓ done');
  await db.end();
  process.exit(0);
}

migrate().catch(async err => { console.error(err); await db.end(); process.exit(1); });
