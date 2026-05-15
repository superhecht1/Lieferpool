require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Starte Migration Fix 2...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint   TEXT NOT NULL UNIQUE,
        p256dh     TEXT NOT NULL,
        auth_key   TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE tour_stopps ADD COLUMN IF NOT EXISTS foto_base64 TEXT;
      ALTER TABLE tour_stopps ADD COLUMN IF NOT EXISTS menge_geladen_kg NUMERIC(10,2);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
    `);
    console.log('Migration Fix 2 OK');
  } finally {
    client.release();
    await db.end();
  }
}
run().catch(e => { console.error(e); process.exit(1); });
