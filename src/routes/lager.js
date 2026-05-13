const express = require('express');
const db = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

// ----------------------------------------------------------------
// GET /api/lager – alle Lager-Positionen (Bestandsübersicht)
// ----------------------------------------------------------------
router.get('/', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const { region } = req.query;
    const params = [];
    let where = '';
    if (region) { params.push(region); where = `WHERE region = $1`; }

    const { rows } = await db.query(`
      SELECT
        lp.*,
        CASE WHEN lp.bestand <= lp.mindestbestand THEN true ELSE false END AS unterbestand,
        COALESCE(
          (SELECT SUM(m.menge) FROM lager_bewegungen m
           WHERE m.lager_id = lp.id AND m.typ = 'eingang'
             AND m.created_at >= NOW() - INTERVAL '7 days'), 0
        ) AS eingang_7d,
        COALESCE(
          (SELECT SUM(m.menge) FROM lager_bewegungen m
           WHERE m.lager_id = lp.id AND m.typ = 'ausgang'
             AND m.created_at >= NOW() - INTERVAL '7 days'), 0
        ) AS ausgang_7d
      FROM lager_positionen lp
      ${where}
      ORDER BY lp.produkt
    `, params);

    res.json({ lager: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lager konnte nicht geladen werden' });
  }
});

// ----------------------------------------------------------------
// GET /api/lager/alerts – Positionen unter Mindestbestand
// ----------------------------------------------------------------
router.get('/alerts', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM lager_positionen
      WHERE bestand <= mindestbestand
      ORDER BY (mindestbestand - bestand) DESC
    `);
    res.json({ alerts: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Alerts konnten nicht geladen werden' });
  }
});

// ----------------------------------------------------------------
// GET /api/lager/bewegungen – Buchungshistorie
// ----------------------------------------------------------------
router.get('/bewegungen', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const { produkt, typ, limit = 50 } = req.query;
    const params = [parseInt(limit)];
    const filters = [];

    if (produkt) { params.push(produkt); filters.push(`lp.produkt = $${params.length}`); }
    if (typ)     { params.push(typ);     filters.push(`m.typ = $${params.length}`); }

    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        m.*,
        lp.produkt,
        lp.einheit,
        u.name AS erstellt_von_name
      FROM lager_bewegungen m
      JOIN lager_positionen lp ON lp.id = m.lager_id
      LEFT JOIN users u ON u.id = m.erstellt_von
      ${where}
      ORDER BY m.created_at DESC
      LIMIT $1
    `, params);

    res.json({ bewegungen: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bewegungen konnten nicht geladen werden' });
  }
});

// ----------------------------------------------------------------
// POST /api/lager/eingang – manueller Wareneingang buchen
// (automatischer Eingang läuft über lieferungen/wareneingang)
// ----------------------------------------------------------------
router.post('/eingang', auth, role('admin'), async (req, res) => {
  const { produkt, einheit = 'kg', menge, region = 'NRW',
          pool_id, lieferung_id, qualitaet = 'A', notiz } = req.body;

  if (!produkt || !menge || menge <= 0) {
    return res.status(400).json({ error: 'produkt und menge erforderlich' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lager-Position holen oder anlegen
    const { rows: [lager] } = await client.query(`
      INSERT INTO lager_positionen (produkt, einheit, region)
      VALUES ($1, $2, $3)
      ON CONFLICT (produkt, region) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `, [produkt, einheit, region]);

    // Bestand erhöhen
    const { rows: [updated] } = await client.query(`
      UPDATE lager_positionen
      SET bestand = bestand + $1
      WHERE id = $2
      RETURNING bestand
    `, [menge, lager.id]);

    // Bewegung buchen
    const { rows: [bewegung] } = await client.query(`
      INSERT INTO lager_bewegungen
        (lager_id, typ, menge, bestand_nach, pool_id, lieferung_id, qualitaet, notiz, erstellt_von)
      VALUES ($1, 'eingang', $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [lager.id, menge, updated.bestand, pool_id || null, lieferung_id || null,
        qualitaet, notiz || null, req.user.id]);

    await client.query('COMMIT');

    res.status(201).json({
      bewegung,
      bestand_aktuell: updated.bestand,
      produkt,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Eingang konnte nicht gebucht werden' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// POST /api/lager/ausgang – Warenausgang buchen (Auslieferung)
// ----------------------------------------------------------------
router.post('/ausgang', auth, role('admin', 'caterer'), async (req, res) => {
  const { produkt, region = 'NRW', menge, abnehmer_ref, notiz } = req.body;

  if (!produkt || !menge || menge <= 0) {
    return res.status(400).json({ error: 'produkt und menge erforderlich' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [lager] } = await client.query(`
      SELECT * FROM lager_positionen WHERE produkt = $1 AND region = $2 FOR UPDATE
    `, [produkt, region]);

    if (!lager) return res.status(404).json({ error: 'Produkt nicht im Lager' });
    if (lager.bestand < menge) {
      return res.status(400).json({
        error: `Nicht genug Bestand. Verfügbar: ${lager.bestand} ${lager.einheit}`,
      });
    }

    const { rows: [updated] } = await client.query(`
      UPDATE lager_positionen
      SET bestand = bestand - $1
      WHERE id = $2
      RETURNING bestand
    `, [menge, lager.id]);

    const { rows: [bewegung] } = await client.query(`
      INSERT INTO lager_bewegungen
        (lager_id, typ, menge, bestand_nach, abnehmer_ref, notiz, erstellt_von)
      VALUES ($1, 'ausgang', $2, $3, $4, $5, $6)
      RETURNING *
    `, [lager.id, menge, updated.bestand, abnehmer_ref || null, notiz || null, req.user.id]);

    await client.query('COMMIT');

    res.status(201).json({
      bewegung,
      bestand_aktuell: updated.bestand,
      unterbestand: updated.bestand <= lager.mindestbestand,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ausgang konnte nicht gebucht werden' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// PUT /api/lager/:id/mindestbestand – Mindestbestand setzen
// ----------------------------------------------------------------
router.put('/:id/mindestbestand', auth, role('admin'), async (req, res) => {
  const { mindestbestand } = req.body;
  if (mindestbestand == null) return res.status(400).json({ error: 'mindestbestand fehlt' });

  try {
    const { rows: [lager] } = await db.query(`
      UPDATE lager_positionen SET mindestbestand = $1 WHERE id = $2 RETURNING *
    `, [mindestbestand, req.params.id]);

    if (!lager) return res.status(404).json({ error: 'Position nicht gefunden' });
    res.json({ lager });
  } catch (err) {
    res.status(500).json({ error: 'Update fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// POST /api/lager/korrektur – Bestandskorrektur (z.B. nach Inventur)
// ----------------------------------------------------------------
router.post('/korrektur', auth, role('admin'), async (req, res) => {
  const { produkt, region = 'NRW', bestand_soll, notiz } = req.body;
  if (!produkt || bestand_soll == null) {
    return res.status(400).json({ error: 'produkt und bestand_soll erforderlich' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [lager] } = await client.query(`
      SELECT * FROM lager_positionen WHERE produkt = $1 AND region = $2 FOR UPDATE
    `, [produkt, region]);

    if (!lager) return res.status(404).json({ error: 'Produkt nicht gefunden' });

    const differenz = parseFloat(bestand_soll) - parseFloat(lager.bestand);

    await client.query(`
      UPDATE lager_positionen SET bestand = $1 WHERE id = $2
    `, [bestand_soll, lager.id]);

    await client.query(`
      INSERT INTO lager_bewegungen
        (lager_id, typ, menge, bestand_nach, notiz, erstellt_von)
      VALUES ($1, 'korrektur', $2, $3, $4, $5)
    `, [lager.id, differenz, bestand_soll,
        notiz || `Inventurkorrektur (${differenz >= 0 ? '+' : ''}${differenz})`, req.user.id]);

    await client.query('COMMIT');
    res.json({ produkt, alter_bestand: lager.bestand, neuer_bestand: bestand_soll, differenz });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Korrektur fehlgeschlagen' });
  } finally {
    client.release();
  }
});

module.exports = router;
