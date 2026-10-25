/** migrate_fix12.js – Benachrichtigungs-Einstellungen + Versandprotokoll · Ablage: scripts/ · npm run migrate:fix12 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS notif_prefs (
        user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email_erinnerungen BOOLEAN NOT NULL DEFAULT TRUE,
        push_erinnerungen  BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS erinnerungen_log (
        key        TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_erinnerungen_created ON erinnerungen_log(created_at);
    `);
    console.log('✓ migrate_fix12 abgeschlossen');
  } catch (e) { console.error('✗ migrate_fix12:', e.message); process.exitCode = 1; }
  finally { c.release(); await pool.end(); }
})();
