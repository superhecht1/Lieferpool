require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await db.connect();
  try {
    await c.query(`
      ALTER TABLE erzeuger ADD COLUMN IF NOT EXISTS betriebs_typ VARCHAR(12) NOT NULL DEFAULT 'hof';
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erzeuger_betriebs_typ_chk') THEN
          ALTER TABLE erzeuger ADD CONSTRAINT erzeuger_betriebs_typ_chk CHECK (betriebs_typ IN ('hof','grosshandel'));
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS logistikpartner (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(120) NOT NULL,
        typ VARCHAR(20) NOT NULL DEFAULT 'grosshandel' CHECK (typ IN ('grosshandel','spedition','sonstige')),
        kontakt_email VARCHAR(255), ust_id VARCHAR(20),
        satz_pro_tour NUMERIC(8,2) NOT NULL DEFAULT 0,
        satz_pro_stopp NUMERIC(8,2) NOT NULL DEFAULT 0,
        aktiv BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE fahrer_profile ADD COLUMN IF NOT EXISTS logistikpartner_id UUID REFERENCES logistikpartner(id);
      ALTER TABLE touren ADD COLUMN IF NOT EXISTS logistikpartner_id UUID REFERENCES logistikpartner(id);
    `);
    console.log('✓ migrate_fix15 abgeschlossen');
  } catch (e) { console.error('migrate_fix15:', e.message); process.exit(1); }
  finally { c.release(); await db.end(); }
})();
