/**
 * migrate_fix11.js – IBAN-Spalten auf TEXT erweitern und Bestand verschlüsseln
 * Ablage: scripts/migrate_fix11.js · Aufruf: npm run migrate:fix11
 * Voraussetzung: FIELD_ENCRYPTION_KEY gesetzt (64 Hex-Zeichen). Mehrfaches Ausführen ist unkritisch.
 */
require('dotenv').config();
const { Pool } = require('pg');
const { encrypt, isEncrypted } = require('../src/services/fieldcrypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  if (!process.env.FIELD_ENCRYPTION_KEY) {
    console.error('✗ FIELD_ENCRYPTION_KEY fehlt. Erzeugen mit:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`ALTER TABLE erzeuger ALTER COLUMN iban TYPE TEXT`);
    await c.query(`ALTER TABLE caterer  ALTER COLUMN iban TYPE TEXT`);
    let n = 0;
    for (const t of ['erzeuger', 'caterer']) {
      const { rows } = await c.query(`SELECT id, iban FROM ${t} WHERE iban IS NOT NULL AND iban <> '' AND iban NOT LIKE 'enc:v1:%' AND iban NOT LIKE '[%'`);
      for (const r of rows) {
        await c.query(`UPDATE ${t} SET iban=$1 WHERE id=$2`, [encrypt(r.iban), r.id]);
        n++;
      }
    }
    await c.query('COMMIT');
    console.log(`✓ migrate_fix11: ${n} IBAN verschlüsselt`);
  } catch (e) {
    await c.query('ROLLBACK'); console.error('✗ migrate_fix11 fehlgeschlagen:', e.message); process.exitCode = 1;
  } finally { c.release(); await pool.end(); }
})();
