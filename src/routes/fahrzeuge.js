const express = require('express');
const db = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

// ----------------------------------------------------------------
// GET /api/fahrzeuge – alle aktiven Fahrzeuge
// ----------------------------------------------------------------
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT f.*,
        COUNT(t.id) FILTER (WHERE t.datum = CURRENT_DATE)::int AS touren_heute
      FROM fahrzeuge f
      LEFT JOIN touren t ON t.fahrzeug_id = f.id
      WHERE f.aktiv = true
      GROUP BY f.id
      ORDER BY f.typ, f.bezeichnung
    `);
    res.json({ fahrzeuge: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fahrzeuge konnten nicht geladen werden' });
  }
});

// ----------------------------------------------------------------
// POST /api/fahrzeuge – Fahrzeug anlegen
// ----------------------------------------------------------------
router.post('/', auth, role('admin'), async (req, res) => {
  const { bezeichnung, typ, kennzeichen, max_zuladung_kg, reichweite_km, notiz } = req.body;

  if (!bezeichnung || !typ) {
    return res.status(400).json({ error: 'bezeichnung und typ erforderlich' });
  }

  const TYPEN = ['lkw', 'transporter', 'e_auto', 'e_lastenrad'];
  if (!TYPEN.includes(typ)) {
    return res.status(400).json({ error: `typ muss einer von: ${TYPEN.join(', ')} sein` });
  }

  try {
    const { rows: [f] } = await db.query(`
      INSERT INTO fahrzeuge (bezeichnung, typ, kennzeichen, max_zuladung_kg, reichweite_km, notiz)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [bezeichnung, typ, kennzeichen || null, max_zuladung_kg || null,
        reichweite_km || null, notiz || null]);

    res.status(201).json({ fahrzeug: f });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fahrzeug konnte nicht angelegt werden' });
  }
});

// ----------------------------------------------------------------
// PUT /api/fahrzeuge/:id – Fahrzeug aktualisieren
// ----------------------------------------------------------------
router.put('/:id', auth, role('admin'), async (req, res) => {
  const { bezeichnung, kennzeichen, max_zuladung_kg, reichweite_km, aktiv, notiz } = req.body;

  try {
    const { rows: [f] } = await db.query(`
      UPDATE fahrzeuge SET
        bezeichnung     = COALESCE($1, bezeichnung),
        kennzeichen     = COALESCE($2, kennzeichen),
        max_zuladung_kg = COALESCE($3, max_zuladung_kg),
        reichweite_km   = COALESCE($4, reichweite_km),
        aktiv           = COALESCE($5, aktiv),
        notiz           = COALESCE($6, notiz)
      WHERE id = $7
      RETURNING *
    `, [bezeichnung, kennzeichen, max_zuladung_kg, reichweite_km,
        aktiv ?? null, notiz, req.params.id]);

    if (!f) return res.status(404).json({ error: 'Fahrzeug nicht gefunden' });
    res.json({ fahrzeug: f });
  } catch (err) {
    res.status(500).json({ error: 'Update fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// DELETE /api/fahrzeuge/:id – Fahrzeug deaktivieren
// ----------------------------------------------------------------
router.delete('/:id', auth, role('admin'), async (req, res) => {
  try {
    await db.query(`UPDATE fahrzeuge SET aktiv = false WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Fahrzeug deaktiviert' });
  } catch (err) {
    res.status(500).json({ error: 'Deaktivierung fehlgeschlagen' });
  }
});

module.exports = router;
