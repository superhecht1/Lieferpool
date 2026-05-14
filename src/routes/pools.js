const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');
const chain   = require('../services/chain');
const email   = require('../services/email');

const router = express.Router();

// GET /api/pools
router.get('/', auth, async (req, res) => {
  try {
    const { status, region, produkt } = req.query;
    const filters = []; const params = [];
    if (status)  { params.push(status);       filters.push(`p.status = $${params.length}`); }
    if (region)  { params.push(region);        filters.push(`p.region = $${params.length}`); }
    if (produkt) { params.push(`%${produkt}%`); filters.push(`p.produkt ILIKE $${params.length}`); }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT p.*, c.firma_name AS caterer_name,
        COUNT(cm.id)::int AS erzeuger_count,
        ROUND(p.menge_committed / NULLIF(p.menge_ziel,0) * 100, 1) AS fuellstand_pct
      FROM pools p
      LEFT JOIN caterer c ON c.id = p.caterer_id
      LEFT JOIN commitments cm ON cm.pool_id = p.id AND cm.status = 'aktiv'
      ${where}
      GROUP BY p.id, c.firma_name
      ORDER BY p.created_at DESC
    `, params);

    res.json({ pools: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Pools konnten nicht geladen werden' });
  }
});

// GET /api/pools/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows: [pool] } = await db.query(`
      SELECT p.*, c.firma_name AS caterer_name
      FROM pools p LEFT JOIN caterer c ON c.id = p.caterer_id
      WHERE p.id = $1
    `, [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });

    const { rows: commitments } = await db.query(`
      SELECT cm.*, e.betrieb_name, e.region
      FROM commitments cm JOIN erzeuger e ON e.id = cm.erzeuger_id
      WHERE cm.pool_id = $1 ORDER BY cm.created_at
    `, [req.params.id]);

    res.json({ pool, commitments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Pool konnte nicht geladen werden' });
  }
});

// POST /api/pools – Caterer erstellt Pool
router.post('/', auth, role('caterer', 'admin'), async (req, res) => {
  const { produkt, einheit='kg', menge_ziel, preis_pro_einheit,
          lieferwoche, deadline, region='NRW', qualitaet_stufe='A' } = req.body;

  if (!produkt || !menge_ziel || !preis_pro_einheit || !lieferwoche || !deadline) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  }

  try {
    const { rows: [caterer] } = await db.query(
      `SELECT id FROM caterer WHERE user_id = $1`, [req.user.id]
    );
    if (!caterer) return res.status(400).json({ error: 'Caterer-Profil nicht gefunden' });

    const { rows: [pool] } = await db.query(`
      INSERT INTO pools (caterer_id, produkt, einheit, menge_ziel, preis_pro_einheit,
        lieferwoche, deadline, region, qualitaet_stufe)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [caterer.id, produkt, einheit, menge_ziel, preis_pro_einheit,
        lieferwoche, deadline, region, qualitaet_stufe]);

    const { txHash, blockNr } = await chain.createPool(pool.id, {
      produkt, menge_ziel, preis: preis_pro_einheit, deadline,
    });

    // E-Mail an alle verifizierten Erzeuger
    try {
      const { rows: erzeuger } = await db.query(`
        SELECT u.email, e.betrieb_name AS name
        FROM erzeuger e JOIN users u ON u.id = e.user_id
        WHERE EXISTS (
          SELECT 1 FROM zertifikate z WHERE z.erzeuger_id = e.id AND z.status = 'verified'
        )
      `);
      if (erzeuger.length > 0) {
        email.sendNeuerPool({ erzeugerEmails: erzeuger, pool })
          .catch(e => console.warn('[email neuer pool]', e.message));
      }
    } catch (emailErr) {
      console.warn('[email]', emailErr.message);
    }

    res.status(201).json({ pool, chain: { txHash, blockNr } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Pool konnte nicht erstellt werden' });
  }
});

// POST /api/pools/:id/commit – Erzeuger sagt Menge zu
router.post('/:id/commit', auth, role('erzeuger'), async (req, res) => {
  const { menge } = req.body;
  if (!menge || menge <= 0) return res.status(400).json({ error: 'Ungültige Menge' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [pool] } = await client.query(
      `SELECT * FROM pools WHERE id = $1 FOR UPDATE`, [req.params.id]
    );
    if (!pool)                      return res.status(404).json({ error: 'Pool nicht gefunden' });
    if (pool.status !== 'offen')    return res.status(400).json({ error: 'Pool ist nicht mehr offen' });
    if (new Date(pool.deadline) < new Date()) {
      return res.status(400).json({ error: 'Deadline abgelaufen' });
    }

    const { rows: [erzeuger] } = await client.query(`
      SELECT e.id FROM erzeuger e
      JOIN zertifikate z ON z.erzeuger_id = e.id AND z.status = 'verified'
      WHERE e.user_id = $1 LIMIT 1
    `, [req.user.id]);
    if (!erzeuger) return res.status(403).json({ error: 'Kein verifiziertes Zertifikat vorhanden' });

    const { rows: [commitment] } = await client.query(`
      INSERT INTO commitments (pool_id, erzeuger_id, menge) VALUES ($1,$2,$3) RETURNING *
    `, [pool.id, erzeuger.id, menge]);

    const neue_menge = parseFloat(pool.menge_committed) + parseFloat(menge);
    let neuer_status = pool.status;

    if (neue_menge >= parseFloat(pool.menge_ziel)) {
      neuer_status = 'geschlossen';
      await chain.lockPool(pool.id);

      // E-Mail an Caterer wenn Pool voll
      try {
        const { rows: [catData] } = await client.query(`
          SELECT u.email, c.firma_name AS name, $1 AS erzeuger_count
          FROM caterer c JOIN users u ON u.id = c.user_id
          WHERE c.id = $2
        `, [commitment.id, pool.caterer_id]);
        if (catData) {
          email.sendPoolVoll({
            catererEmail: catData.email,
            catererName:  catData.name,
            pool: { ...pool, menge_committed: neue_menge, erzeuger_count: '—' },
          }).catch(e => console.warn('[email pool voll]', e.message));
        }
      } catch (emailErr) {
        console.warn('[email]', emailErr.message);
      }
    }

    await client.query(
      `UPDATE pools SET menge_committed = $1, status = $2 WHERE id = $3`,
      [neue_menge, neuer_status, pool.id]
    );

    const { txHash, blockNr } = await chain.commitQuantity(
      commitment.id, pool.id, erzeuger.id, menge
    );

    await client.query('COMMIT');

    res.status(201).json({
      commitment,
      pool_status:    neuer_status,
      pool_fuellstand: Math.min(100, Math.round(neue_menge / pool.menge_ziel * 100)),
      chain: { txHash, blockNr },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Commitment fehlgeschlagen' });
  } finally {
    client.release();
  }
});

module.exports = router;
