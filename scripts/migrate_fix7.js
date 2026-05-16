require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Fix 7 – Passwort-Reset...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      VARCHAR(100) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 hours',
        used       BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_prt_token ON password_reset_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_prt_user  ON password_reset_tokens(user_id);
    `);
    console.log('Migration Fix 7 OK');
  } finally { client.release(); await db.end(); }
}
run().catch(e => { console.error(e); process.exit(1); });
