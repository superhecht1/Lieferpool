require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await db.connect();
  try {
    console.log('Migration Rechnungen + MwSt...');
    await client.query(`
      -- MwSt.-Felder in Auszahlungen
      ALTER TABLE auszahlungen
        ADD COLUMN IF NOT EXISTS mwst_satz      NUMERIC(5,2) DEFAULT 7.00,
        ADD COLUMN IF NOT EXISTS netto_betrag   NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS mwst_betrag    NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS brutto_betrag  NUMERIC(10,2);

      -- Rechnungstabelle
      CREATE TABLE IF NOT EXISTS rechnungen (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rechnungs_nr     VARCHAR(50) UNIQUE NOT NULL,
        erzeuger_id      UUID NOT NULL REFERENCES erzeuger(id),
        auszahlung_id    UUID REFERENCES auszahlungen(id),
        lieferung_id     UUID REFERENCES lieferungen(id),
        rechnungsdatum   DATE NOT NULL DEFAULT CURRENT_DATE,
        leistungsdatum   DATE,
        leistung_beschr  TEXT NOT NULL,
        netto            NUMERIC(10,2) NOT NULL,
        mwst_satz        NUMERIC(5,2)  DEFAULT 7.00,
        mwst             NUMERIC(10,2) NOT NULL,
        brutto           NUMERIC(10,2) NOT NULL,
        status           VARCHAR(20) DEFAULT 'erstellt'
                           CHECK (status IN ('erstellt','versendet','storniert')),
        pdf_path         TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_rech_erzeuger ON rechnungen(erzeuger_id);

      -- Einladungslinks
      CREATE TABLE IF NOT EXISTS einladungen (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token      VARCHAR(100) NOT NULL UNIQUE,
        email      VARCHAR(255) NOT NULL,
        rolle      VARCHAR(20) NOT NULL CHECK (rolle IN ('erzeuger','caterer','fahrer')),
        name       TEXT,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
        used       BOOLEAN DEFAULT FALSE,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Wiederkehrende Pool-Vorlagen
      CREATE TABLE IF NOT EXISTS pool_vorlagen (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        caterer_id       UUID NOT NULL REFERENCES caterer(id),
        produkt          VARCHAR(255) NOT NULL,
        menge_ziel       NUMERIC(10,2),
        preis_pro_einheit NUMERIC(10,2),
        wochentag        SMALLINT CHECK (wochentag BETWEEN 0 AND 6),
        deadline_tage    SMALLINT DEFAULT 3,
        aktiv            BOOLEAN DEFAULT TRUE,
        notiz            TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );

      -- Qualitätsbewertungen
      ALTER TABLE lieferungen
        ADD COLUMN IF NOT EXISTS qualitaet_caterer  VARCHAR(20)
          CHECK (qualitaet_caterer IN ('A','B','C','abgelehnt')),
        ADD COLUMN IF NOT EXISTS qualitaet_notiz    TEXT,
        ADD COLUMN IF NOT EXISTS qualitaet_at       TIMESTAMPTZ;

      -- S3/Speicher für Fotos
      ALTER TABLE tour_stopps
        ADD COLUMN IF NOT EXISTS foto_url    TEXT,
        ADD COLUMN IF NOT EXISTS foto_key    TEXT;
    `);
    console.log('Migration Rechnungen OK');
  } catch(err) { console.error(err.message); process.exit(1); }
  finally { client.release(); await db.end(); }
}
run();
