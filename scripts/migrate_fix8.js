require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Fix 8 – Fehlende Tabellen...');
    await client.query(`
      -- Audit-Log Tabelle (wird von audit.js verwendet)
      CREATE TABLE IF NOT EXISTS audit_log (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
        action      VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50),
        entity_id   VARCHAR(100),
        details     JSONB DEFAULT '{}',
        ip          VARCHAR(50),
        user_agent  VARCHAR(300),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

      -- Login-Versuche (für progressive lockout)
      CREATE TABLE IF NOT EXISTS login_attempts (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email      VARCHAR(255) NOT NULL,
        ip         VARCHAR(50),
        success    BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, created_at DESC);

      -- Qualitätspräferenz in Bedarfsprognosen (war in migrate_hub.js vergessen)
      ALTER TABLE bedarf_prognosen
        ADD COLUMN IF NOT EXISTS qualitaet_praeferenz VARCHAR(20) DEFAULT 'A';

      -- tour_stopps: fehlende Spalten
      ALTER TABLE tour_stopps ADD COLUMN IF NOT EXISTS bestaetigt_at TIMESTAMPTZ;
      ALTER TABLE tour_stopps ADD COLUMN IF NOT EXISTS menge_geliefert NUMERIC(10,2);
    `);
    console.log('Migration Fix 8 OK');
  } catch(err) { console.error(err.message); process.exit(1); }
  finally { client.release(); await db.end(); }
}
run();
