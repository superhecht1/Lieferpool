require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Fix 6 – Lieferungen Status Constraint...');

    // Bestehende Constraint entfernen und neu anlegen mit allen erlaubten Werten
    await client.query(`
      ALTER TABLE lieferungen
        DROP CONSTRAINT IF EXISTS lieferungen_status_check;

      ALTER TABLE lieferungen
        ADD CONSTRAINT lieferungen_status_check
        CHECK (status IN (
          'offen',        -- Ursprünglicher Wert
          'erstellt',     -- Lieferschein erstellt
          'ausstehend',   -- Auf Abholung wartend
          'unterwegs',    -- In Auslieferung
          'eingegangen',  -- Wareneingang bestätigt
          'abgeschlossen',-- Abgeschlossen
          'storniert'     -- Storniert
        ));
    `);

    console.log('Migration Fix 6 OK');
  } catch (err) {
    console.error('Fehler:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await db.end();
  }
}
run();
