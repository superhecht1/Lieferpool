require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Security – 2FA + DSGVO...');
    await client.query(`
      -- 2FA für Admin
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS totp_secret    VARCHAR(100),
        ADD COLUMN IF NOT EXISTS totp_enabled   BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS totp_verified  BOOLEAN DEFAULT FALSE;

      -- DSGVO: Einwilligung + Löschanfrage
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS dsgvo_consent     BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS dsgvo_consent_at  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;

      -- CSRF tokens
      CREATE TABLE IF NOT EXISTS csrf_tokens (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token      VARCHAR(100) NOT NULL UNIQUE,
        session_id VARCHAR(100),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 hours',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_csrf_token ON csrf_tokens(token);

      -- Datenexport-Log
      CREATE TABLE IF NOT EXISTS data_exports (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Migration Security OK');
  } finally { client.release(); await db.end(); }
}
run().catch(e => { console.error(e); process.exit(1); });
