require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding database...');
    await client.query('BEGIN');

    const pw = await bcrypt.hash('test1234', 10);

    // Users
    const users = await client.query(`
      INSERT INTO users (email, password, role, name) VALUES
        ('erzeuger@test.de', $1, 'erzeuger', 'Hof Brüggemann'),
        ('caterer@test.de',  $1, 'caterer',  'Aramark GmbH'),
        ('admin@test.de',    $1, 'admin',    'Admin')
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email, role
    `, [pw]);

    console.log('Users:', users.rows.map(u => u.email).join(', '));

    // Erzeuger
    const eu = users.rows.find(u => u.role === 'erzeuger');
    const ca = users.rows.find(u => u.role === 'caterer');

    if (eu) {
      const { rows: [e] } = await client.query(`
        INSERT INTO erzeuger (user_id, betrieb_name, region, iban, onboarding_done)
        VALUES ($1, 'Hof Brüggemann', 'NRW', 'DE89370400440532013000', true)
        ON CONFLICT DO NOTHING RETURNING id
      `, [eu.id]);

      if (e) {
        await client.query(`
          INSERT INTO zertifikate (erzeuger_id, typ, zert_nummer, status, gueltig_bis)
          VALUES
            ($1, 'Bio', 'Bio-DE-001-2024', 'verified', '2026-12-31'),
            ($1, 'Hygiene', 'HA-NRW-2024-0042', 'verified', '2025-12-31'),
            ($1, 'QS', 'QS-0815', 'pending', '2026-06-30')
          ON CONFLICT DO NOTHING
        `, [e.id]);
      }
    }

    if (ca) {
      await client.query(`
        INSERT INTO caterer (user_id, firma_name, region)
        VALUES ($1, 'Aramark GmbH', 'NRW')
        ON CONFLICT DO NOTHING
      `, [ca.id]);
    }

    // Demo Pool
    await client.query(`
      INSERT INTO pools (produkt, einheit, menge_ziel, menge_committed, preis_pro_einheit,
        region, lieferwoche, deadline, status)
      VALUES
        ('Karotten Bio', 'kg', 1000, 780, 1.80, 'NRW', '2025-W20', NOW() + INTERVAL '10 days', 'offen'),
        ('Kohlrabi Bio', 'kg', 500, 500, 2.20, 'NRW', '2025-W19', NOW() - INTERVAL '3 days', 'geschlossen')
      ON CONFLICT DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✅ Seed complete');
    console.log('\n🔑 Test logins:');
    console.log('  erzeuger@test.de  /  test1234');
    console.log('  caterer@test.de   /  test1234');
    console.log('  admin@test.de     /  test1234');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
