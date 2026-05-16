const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');
const chain   = require('../services/chain');
const email   = require('../services/email');

const router = express.Router();

// ── GET /api/pools ─────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { status, region, produkt, page = 1, limit = 50 } = req.query;

    // Filter-Params (für WHERE)
    const filterParams = [];
    const filters      = [];
    if (status)  { filterParams.push(status);        filters.push(`p.status = $${filterParams.length}`); }
    if (region)  { filterParams.push(region);         filters.push(`p.region = $${filterParams.length}`); }
    if (produkt) { filterParams.push(`%${produkt}%`); filters.push(`p.produkt ILIKE $${filterParams.length}`); }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    // Haupt-Query-Params: Filter + Pagination
    const queryParams = [
      ...filterParams,
      parseInt(limit),
      (parseInt(page) - 1) * parseInt(limit),
    ];
    const limitIdx  = queryParams.length - 1; // $N für OFFSET
    const offsetIdx = queryParams.length;      // wird nicht verwendet direkt

    const [{ rows }, { rows: [count] }] = await Promise.all([
      db.query(`
        SELECT p.*, c.firma_name AS caterer_name,
          COUNT(cm.id)::int AS erzeuger_count,
          ROUND(p.menge_committed / NULLIF(p.menge_ziel,0) * 100, 1) AS fuellstand_pct
        FROM pools p
        LEFT JOIN caterer c ON c.id = p.caterer_id
        LEFT JOIN commitments cm ON cm.pool_id = p.id AND cm.status = 'aktiv'
        ${where}
        GROUP BY p.id, c.firma_name
        ORDER BY p.created_at DESC
        LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}
      `, queryParams),
      db.query(`SELECT COUNT(*) FROM pools p ${where}`, filterParams),
    ]);

    res.json({
      pools: rows,
      pagination: {
        total: parseInt(count.count),
        page:  parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count.count / limit),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Pools konnten nicht geladen werden' });
  }
});

// ── GET /api/pools/:id ─────────────────────────────────────────
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
    res.status(500).json({ error: 'Pool konnte nicht geladen werden' });
  }
});

// ── POST /api/pools – Caterer erstellt Pool ────────────────────
router.post('/', auth, role('caterer', 'admin'), async (req, res) => {
  const { produkt, einheit='kg', menge_ziel, preis_pro_einheit,
          lieferwoche, deadline, region='NRW', qualitaet_stufe='A',
          platform_fee_pct=1.0 } = req.body;

  if (!produkt || !menge_ziel || !preis_pro_einheit || !lieferwoche || !deadline) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  }

  try {
    let caterer_id;
    if (req.user.role === 'admin') {
      caterer_id = req.body.caterer_id || null;
    } else {
      const { rows: [c] } = await db.query(
        `SELECT id FROM caterer WHERE user_id=$1`, [req.user.id]
      );
      if (!c) return res.status(400).json({ error: 'Caterer-Profil nicht gefunden' });
      caterer_id = c.id;
    }

    const { rows: [pool] } = await db.query(`
      INSERT INTO pools (caterer_id, produkt, einheit, menge_ziel, preis_pro_einheit,
        lieferwoche, deadline, region, qualitaet_stufe, platform_fee_pct)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [caterer_id, produkt, einheit, menge_ziel, preis_pro_einheit,
        lieferwoche, deadline, region, qualitaet_stufe, platform_fee_pct]);

    const { txHash, blockNr } = await chain.createPool(pool.id, {
      produkt, menge_ziel, preis: preis_pro_einheit, deadline,
    });

    // E-Mail an alle Erzeuger (non-blocking)
    db.query(`
      SELECT u.email, e.betrieb_name AS name FROM erzeuger e JOIN users u ON u.id=e.user_id
      WHERE EXISTS (SELECT 1 FROM zertifikate z WHERE z.erzeuger_id=e.id AND z.status='verified')
    `).then(({ rows }) => {
      if (rows.length > 0) email.sendNeuerPool({ erzeugerEmails: rows, pool })
        .catch(e => console.warn('[email]', e.message));
    }).catch(() => {});

    res.status(201).json({ pool, chain: { txHash, blockNr } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Pool konnte nicht erstellt werden' });
  }
});

// ── PUT /api/pools/:id/status – Admin oder eigener Caterer ────
router.put('/:id/status', auth, role('admin', 'caterer'), async (req, res) => {
  const { status } = req.body;
  const erlaubt = req.user.role === 'admin'
    ? ['geschlossen', 'abgebrochen', 'offen']
    : ['geschlossen', 'abgebrochen'];
  if (!erlaubt.includes(status)) {
    return res.status(400).json({ error: `Status muss einer von ${erlaubt.join(', ')} sein` });
  }
  try {
    const params = [status, req.params.id];
    let where = 'id=$2';
    if (req.user.role === 'caterer') {
      const { rows:[cat] } = await db.query(`SELECT id FROM caterer WHERE user_id=$1`, [req.user.id]);
      if (!cat) return res.status(403).json({ error: 'Kein Caterer-Profil' });
      params.push(cat.id);
      where = 'id=$2 AND caterer_id=$3';
    }
    const { rows: [pool] } = await db.query(
      `UPDATE pools SET status=$1 WHERE ${where} RETURNING *`, params
    );
    if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden oder kein Zugriff' });

    // Bei Abbruch: alle aktiven Commitments zurückziehen
    if (status === 'abgebrochen') {
      await db.query(
        `UPDATE commitments SET status='zurueckgezogen' WHERE pool_id=$1 AND status='aktiv'`,
        [req.params.id]
      );
    }

    res.json({ pool, message: `Pool auf "${status}" gesetzt` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Status konnte nicht geändert werden' });
  }
});

// ── POST /api/pools/:id/commit – Erzeuger sagt Menge zu ────────
router.post('/:id/commit', auth, role('erzeuger'), async (req, res) => {
  const { menge } = req.body;
  if (!menge || menge <= 0) return res.status(400).json({ error: 'Ungültige Menge' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [pool] } = await client.query(
      `SELECT * FROM pools WHERE id=$1 FOR UPDATE`, [req.params.id]
    );
    if (!pool)                   return res.status(404).json({ error: 'Pool nicht gefunden' });
    if (pool.status !== 'offen') return res.status(400).json({ error: 'Pool ist nicht offen' });
    if (new Date(pool.deadline) < new Date()) {
      return res.status(400).json({ error: 'Deadline abgelaufen' });
    }

    const { rows: [erzeuger] } = await client.query(`
      SELECT e.id FROM erzeuger e
      JOIN zertifikate z ON z.erzeuger_id=e.id AND z.status='verified'
      WHERE e.user_id=$1 LIMIT 1
    `, [req.user.id]);
    if (!erzeuger) return res.status(403).json({ error: 'Kein verifiziertes Zertifikat' });

    // Doppeltes Commitment prüfen
    const { rows: existing } = await client.query(
      `SELECT id FROM commitments WHERE pool_id=$1 AND erzeuger_id=$2 AND status='aktiv'`,
      [req.params.id, erzeuger.id]
    );
    if (existing.length > 0) return res.status(409).json({ error: 'Du hast diesem Pool bereits zugesagt' });

    const { rows: [commitment] } = await client.query(
      `INSERT INTO commitments (pool_id,erzeuger_id,menge,status) VALUES ($1,$2,$3,'aktiv') RETURNING *`,
      [pool.id, erzeuger.id, menge]
    );

    const neue_menge = parseFloat(pool.menge_committed) + parseFloat(menge);
    let neuer_status = pool.status;

    if (neue_menge >= parseFloat(pool.menge_ziel)) {
      neuer_status = 'geschlossen';
      await chain.lockPool(pool.id);

      // E-Mail an Caterer (non-blocking)
      db.query(
        `SELECT u.email, c.firma_name AS name FROM caterer c JOIN users u ON u.id=c.user_id WHERE c.id=$1`,
        [pool.caterer_id]
      ).then(({ rows: [cat] }) => {
        if (cat) email.sendPoolVoll({
          catererEmail: cat.email, catererName: cat.name,
          pool: { ...pool, menge_committed: neue_menge },
        }).catch(e => console.warn('[email]', e.message));
      }).catch(() => {});
    }

    await client.query(
      `UPDATE pools SET menge_committed=$1, status=$2 WHERE id=$3`,
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

// ── DELETE /api/pools/:id/commit – Commitment zurückziehen ─────
router.delete('/:id/commit', auth, role('erzeuger'), async (req, res) => {
  try {
    const { rows: [erzeuger] } = await db.query(
      `SELECT id FROM erzeuger WHERE user_id=$1`, [req.user.id]
    );
    if (!erzeuger) return res.status(404).json({ error: 'Profil nicht gefunden' });

    const { rows: [pool] } = await db.query(
      `SELECT status FROM pools WHERE id=$1`, [req.params.id]
    );
    if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
    if (pool.status !== 'offen') {
      return res.status(400).json({ error: 'Commitment kann nur bei offenen Pools zurückgezogen werden' });
    }

    const { rows: [c] } = await db.query(`
      UPDATE commitments SET status='zurueckgezogen'
      WHERE pool_id=$1 AND erzeuger_id=$2 AND status='aktiv'
      RETURNING menge
    `, [req.params.id, erzeuger.id]);

    if (!c) return res.status(404).json({ error: 'Kein aktives Commitment gefunden' });

    // Menge vom Pool abziehen
    await db.query(
      `UPDATE pools SET menge_committed = GREATEST(0, menge_committed - $1) WHERE id=$2`,
      [c.menge, req.params.id]
    );

    res.json({ message: 'Commitment zurückgezogen', menge: c.menge });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Zurückziehen fehlgeschlagen' });
  }
});


// PATCH /api/pools/:id/deadline – Admin ändert Deadline
router.patch('/:id/deadline', auth, role('admin'), async (req, res) => {
  const { deadline } = req.body;
  if (!deadline) return res.status(400).json({ error: 'deadline erforderlich' });
  try {
    const { rows: [pool] } = await db.query(
      `UPDATE pools SET deadline=$1 WHERE id=$2 RETURNING id,produkt,deadline,status`,
      [deadline, req.params.id]
    );
    if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
    res.json({ pool, message: `Deadline auf ${deadline} gesetzt` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// PUT /api/pools/:id/commit – Menge ändern
router.put('/:id/commit', auth, role('erzeuger'), async (req, res) => {
  const { menge } = req.body;
  if (!menge || menge <= 0) return res.status(400).json({ error: 'Ungültige Menge' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [pool] } = await client.query(
      `SELECT * FROM pools WHERE id=$1 FOR UPDATE`, [req.params.id]
    );
    if (!pool)                   return res.status(404).json({ error: 'Pool nicht gefunden' });
    if (pool.status !== 'offen') return res.status(400).json({ error: 'Pool ist nicht mehr offen' });
    if (new Date(pool.deadline) < new Date()) {
      return res.status(400).json({ error: 'Deadline abgelaufen' });
    }

    const { rows: [erzeuger] } = await client.query(
      `SELECT id FROM erzeuger WHERE user_id=$1`, [req.user.id]
    );
    if (!erzeuger) return res.status(404).json({ error: 'Erzeuger-Profil nicht gefunden' });

    const { rows: [existing] } = await client.query(
      `SELECT id, menge FROM commitments WHERE pool_id=$1 AND erzeuger_id=$2 AND status='aktiv'`,
      [req.params.id, erzeuger.id]
    );
    if (!existing) return res.status(404).json({ error: 'Kein aktives Commitment gefunden' });

    const diff = parseFloat(menge) - parseFloat(existing.menge);

    // Commitment updaten
    await client.query(
      `UPDATE commitments SET menge=$1 WHERE id=$2`,
      [menge, existing.id]
    );

    // Pool-Gesamtmenge anpassen
    const neue_menge = parseFloat(pool.menge_committed) + diff;
    let neuer_status = pool.status;
    if (neue_menge >= parseFloat(pool.menge_ziel)) {
      neuer_status = 'geschlossen';
    }

    await client.query(
      `UPDATE pools SET menge_committed=$1, status=$2 WHERE id=$3`,
      [Math.max(0, neue_menge), neuer_status, pool.id]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Commitment aktualisiert',
      alte_menge: parseFloat(existing.menge),
      neue_menge: parseFloat(menge),
      diff: diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1),
      pool_status: neuer_status,
      pool_fuellstand: Math.min(100, Math.round(Math.max(0, neue_menge) / pool.menge_ziel * 100)),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Änderung fehlgeschlagen' });
  } finally {
    client.release();
  }
});

module.exports = router;
