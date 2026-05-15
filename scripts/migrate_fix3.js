require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Starte Migration Fix 3 (Profil-Felder)...');
    await client.query(`
      -- Erweiterte Erzeuger-Profil Felder
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS adresse          VARCHAR(200);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS plz              VARCHAR(10);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS ort              VARCHAR(100);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS telefon          VARCHAR(30);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS website          VARCHAR(200);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS beschreibung     TEXT;
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS sortiment        TEXT;
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS max_kapazitaet   NUMERIC(10,1);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS betriebsgroesse  VARCHAR(20) DEFAULT 'klein';
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS ust_id           VARCHAR(20);
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS gruendungsjahr   SMALLINT;

      -- Erweiterte Caterer-Profil Felder
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS adresse           VARCHAR(200);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS plz               VARCHAR(10);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS ort               VARCHAR(100);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS telefon           VARCHAR(30);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS website           VARCHAR(200);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS beschreibung      TEXT;
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS ust_id            VARCHAR(20);
      ALTER TABLE caterer ADD COLUMN IF NOT EXISTS kuechen_kapazitaet VARCHAR(50);
    `);
    console.log('Migration Fix 3 OK');
  } finally {
    client.release();
    await db.end();
  }
}
run().catch(e => { console.error(e); process.exit(1); });
