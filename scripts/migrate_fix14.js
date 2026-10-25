require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await db.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS rechnungsnummern (jahr INTEGER PRIMARY KEY, letzte INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS caterer_rechnungen (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rechnungs_nr VARCHAR(30) UNIQUE NOT NULL,
        typ VARCHAR(10) NOT NULL DEFAULT 'rechnung' CHECK (typ IN ('rechnung','storno')),
        caterer_id UUID NOT NULL REFERENCES caterer(id),
        monat CHAR(7) NOT NULL,
        rechnungsdatum DATE NOT NULL DEFAULT CURRENT_DATE,
        leistung_von DATE, leistung_bis DATE, zahlungsziel DATE,
        mwst_satz NUMERIC(5,2) NOT NULL,
        netto NUMERIC(12,2) NOT NULL, mwst NUMERIC(12,2) NOT NULL, brutto NUMERIC(12,2) NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'offen' CHECK (status IN ('offen','bezahlt','storniert')),
        bezahlt_am DATE,
        bezug_id UUID REFERENCES caterer_rechnungen(id),
        empfaenger JSONB,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_crech_caterer ON caterer_rechnungen(caterer_id, monat);
      CREATE TABLE IF NOT EXISTS caterer_rechnung_positionen (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rechnung_id UUID NOT NULL REFERENCES caterer_rechnungen(id) ON DELETE CASCADE,
        lieferung_id UUID REFERENCES lieferungen(id),
        lieferschein_nr VARCHAR(40), datum DATE, produkt TEXT,
        menge NUMERIC(12,3), einheit VARCHAR(20), preis NUMERIC(12,4), summe NUMERIC(12,2),
        aktiv BOOLEAN NOT NULL DEFAULT TRUE);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_crech_pos_lieferung ON caterer_rechnung_positionen(lieferung_id) WHERE aktiv;
    `);
    console.log('✓ migrate_fix14 abgeschlossen');
  } catch (e) { console.error('migrate_fix14:', e.message); process.exit(1); }
  finally { c.release(); await db.end(); }
})();
