require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Security...');
    await client.query(`
      -- Audit-Log: jede sicherheitsrelevante Aktion
      CREATE TABLE IF NOT EXISTS audit_log (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
        action      VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50),
        entity_id   VARCHAR(100),
        details     JSONB,
        ip          VARCHAR(45),
        user_agent  VARCHAR(300),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_user     ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_log(created_at DESC);

      -- Login-Versuche für Progressive Lockout
      CREATE TABLE IF NOT EXISTS login_attempts (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email      VARCHAR(255) NOT NULL,
        ip         VARCHAR(45),
        success    BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_login_email  ON login_attempts(email, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_login_ip     ON login_attempts(ip, created_at DESC);

      -- Cleanup alte Login-Versuche nach 24h (via Cron)
      -- ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours';
    `);
    console.log('Security Migration OK');
  } finally { client.release(); await db.end(); }
}
run().catch(e => { console.error(e); process.exit(1); });
