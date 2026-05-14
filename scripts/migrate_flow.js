require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `
-- ============================================================
-- LIEFERPOOL FLOW MODULE – DB SCHEMA
-- Fahrzeuge, Touren, Tour-Stopps
-- ============================================================

-- ----------------------------------------------------------------
-- FAHRZEUGE: Fuhrpark
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fahrzeuge (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bezeichnung     TEXT NOT NULL,          -- z.B. "Sprinter #1", "Lastenrad Köln-Süd"
  typ             TEXT NOT NULL CHECK (typ IN ('lkw','transporter','e_auto','e_lastenrad')),
  kennzeichen     TEXT,
  max_zuladung_kg NUMERIC(8,2),
  reichweite_km   NUMERIC(6,1),           -- relevant für E-Fahrzeuge
  aktiv           BOOLEAN DEFAULT true,
  notiz           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- FAHRER: Nutzer mit Fahrer-Rolle (Erweiterung users-Tabelle)
-- ----------------------------------------------------------------
-- Fahrer werden als users mit role='fahrer' angelegt.
-- Diese Tabelle speichert Fahrer-spezifische Daten.
CREATE TABLE IF NOT EXISTS fahrer_profile (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  telefon         TEXT,
  fuehrerschein   TEXT,                   -- Führerscheinklasse
  aktiv           BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)
);

-- ----------------------------------------------------------------
-- TOUREN: Eine Tagesroute (Abholung, Auslieferung oder gemischt)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS touren (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fahrer_id       UUID REFERENCES users(id),
  fahrzeug_id     UUID REFERENCES fahrzeuge(id),
  datum           DATE NOT NULL,
  typ             TEXT NOT NULL CHECK (typ IN ('abholung','auslieferung','gemischt')),
  status          TEXT NOT NULL DEFAULT 'geplant'
                    CHECK (status IN ('geplant','aktiv','abgeschlossen','abgebrochen')),
  startzeit       TIME,                   -- geplanter Startzeit
  gestartet_at    TIMESTAMPTZ,
  abgeschlossen_at TIMESTAMPTZ,
  hub_lat         NUMERIC(10,7) DEFAULT 50.9333,  -- Köln Mitte als Default
  hub_lng         NUMERIC(10,7) DEFAULT 6.9500,
  notiz           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- TOUR-STOPPS: Einzelne Haltestellen einer Tour
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tour_stopps (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tour_id             UUID REFERENCES touren(id) ON DELETE CASCADE,
  reihenfolge         INT NOT NULL DEFAULT 0,
  typ                 TEXT NOT NULL CHECK (typ IN ('abholung','auslieferung')),

  -- Abholung: Erzeuger
  erzeuger_id         UUID REFERENCES erzeuger(id),

  -- Auslieferung: Caterer + Lieferung
  caterer_id          UUID REFERENCES caterer(id),
  lieferung_id        UUID REFERENCES lieferungen(id),

  -- Ort
  name                TEXT NOT NULL,      -- Anzeigename des Stopps
  adresse             TEXT,
  lat                 NUMERIC(10,7),
  lng                 NUMERIC(10,7),
  distanz_hub_km      NUMERIC(6,2),       -- Berechnet bei Anlage

  -- Fracht
  produkt             TEXT,
  menge_geplant_kg    NUMERIC(10,2),

  -- Status (vom Fahrer gesetzt)
  status              TEXT NOT NULL DEFAULT 'ausstehend'
                        CHECK (status IN ('ausstehend','angekommen','abgeschlossen','uebersprungen')),
  ankunft_at          TIMESTAMPTZ,
  abschluss_at        TIMESTAMPTZ,
  menge_bestaetigt_kg NUMERIC(10,2),
  qualitaet           TEXT CHECK (qualitaet IN ('A','B','C','abgelehnt')),
  fahrer_notiz        TEXT,

  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- INDIZES
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_touren_datum       ON touren(datum DESC);
CREATE INDEX IF NOT EXISTS idx_touren_fahrer      ON touren(fahrer_id);
CREATE INDEX IF NOT EXISTS idx_touren_status      ON touren(status);
CREATE INDEX IF NOT EXISTS idx_stopps_tour        ON tour_stopps(tour_id);
CREATE INDEX IF NOT EXISTS idx_stopps_reihenfolge ON tour_stopps(tour_id, reihenfolge);
CREATE INDEX IF NOT EXISTS idx_stopps_lieferung   ON tour_stopps(lieferung_id);

-- ----------------------------------------------------------------
-- Fahrer-Rolle in users CHECK ergänzen (falls nötig)
-- Achtung: PostgreSQL erlaubt ALTER TABLE ... ALTER COLUMN ... SET CHECK
-- nicht direkt. Stattdessen DROP + ADD CONSTRAINT:
-- ----------------------------------------------------------------
DO $$
BEGIN
  -- Fahrer-Rolle zur users-Tabelle hinzufügen (falls noch nicht vorhanden)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'users'
      AND constraint_name = 'users_role_check_v2'
  ) THEN
    BEGIN
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check_v2
        CHECK (role IN ('erzeuger','caterer','admin','fahrer'));
    EXCEPTION WHEN others THEN
      NULL; -- Ignorieren falls Constraint anders heißt
    END;
  END IF;
END $$;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running Flow module migration...');
    await client.query(schema);
    console.log('✅ Flow schema ready (fahrzeuge, fahrer_profile, touren, tour_stopps)');
  } catch (err) {
    console.error('❌ Flow migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
