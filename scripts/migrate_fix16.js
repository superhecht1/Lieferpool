require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await db.connect();
  try {
    const hof = parseFloat(String(process.env.GEBUEHR_HOF_PROZENT || '2.5').replace(',', '.')) || 2.5;
    await c.query(`ALTER TABLE pools ALTER COLUMN platform_fee_pct SET DEFAULT ${hof.toFixed(2)}`);
    // alte 1-%-Pools anheben, sofern noch keine Auszahlung daraus entstanden ist
    await c.query(`UPDATE pools SET platform_fee_pct = $1 WHERE platform_fee_pct = 1.00
      AND NOT EXISTS (SELECT 1 FROM commitments cm JOIN auszahlungen a ON a.commitment_id = cm.id WHERE cm.pool_id = pools.id)`, [hof]);
    await c.query(`
      ALTER TABLE caterer_rechnungen ADD COLUMN IF NOT EXISTS gebuehr_prozent NUMERIC(5,2) NOT NULL DEFAULT 0;
      ALTER TABLE caterer_rechnungen ADD COLUMN IF NOT EXISTS gebuehr_netto NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE caterer_rechnungen ADD COLUMN IF NOT EXISTS gebuehr_mwst_satz NUMERIC(5,2) NOT NULL DEFAULT 19;
      ALTER TABLE caterer_rechnungen ADD COLUMN IF NOT EXISTS gebuehr_mwst NUMERIC(12,2) NOT NULL DEFAULT 0;`);
    console.log('✓ migrate_fix16 abgeschlossen');
  } catch (e) { console.error('migrate_fix16:', e.message); process.exit(1); }
  finally { c.release(); await db.end(); }
})();
