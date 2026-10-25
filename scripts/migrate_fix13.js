require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await db.connect();
  try {
    await c.query(`
      ALTER TABLE tour_stopps ADD COLUMN IF NOT EXISTS pfand_kisten_abgeholt INTEGER;
      CREATE TABLE IF NOT EXISTS pfand_konten (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type VARCHAR(20) NOT NULL, entity_id UUID NOT NULL,
        kisten_saldo INTEGER DEFAULT 0, pfand_saldo NUMERIC(10,2) DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (entity_type, entity_id));
      -- Konto neu aufbauen: positiv = Kisten beim Caterer
      INSERT INTO pfand_konten (entity_type, entity_id, kisten_saldo, pfand_saldo)
      SELECT 'caterer', p.caterer_id,
             SUM(l.pfand_kisten_geliefert - COALESCE(l.pfand_kisten_zurueck,0))::int,
             SUM((l.pfand_kisten_geliefert - COALESCE(l.pfand_kisten_zurueck,0)) * l.pfand_pro_kiste)
      FROM lieferungen l JOIN pools p ON p.id = l.pool_id
      WHERE l.pfand_kisten_geliefert > 0 AND p.caterer_id IS NOT NULL
      GROUP BY p.caterer_id
      ON CONFLICT (entity_type, entity_id) DO UPDATE
        SET kisten_saldo = EXCLUDED.kisten_saldo, pfand_saldo = EXCLUDED.pfand_saldo, updated_at = NOW();
    `);
    console.log('✓ migrate_fix13 abgeschlossen');
  } catch (e) { console.error('migrate_fix13:', e.message); process.exit(1); }
  finally { c.release(); await db.end(); }
})();
