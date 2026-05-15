const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

async function getCatererId(userId) {
  const { rows: [c] } = await db.query(
    `SELECT id FROM caterer WHERE user_id=$1`, [userId]
  );
  return c?.id || null;
}

// GET /api/bedarf – eigene Prognosen des Caterers
router.get('/', auth, role('caterer', 'admin'), async (req, res) => {
  try {
    let where = '';
    const params = [];

    if (req.user.role === 'caterer') {
      const catId = await getCatererId(req.user.id);
      if (!catId) return res.json({ prognosen: [] });
      params.push(catId);
      where = `WHERE bp.caterer_id = $1`;
    }

    const { rows } = await db.query(`
      SELECT bp.*, c.firma_name
      FROM bedarf_prognosen bp
      JOIN caterer c ON c.id = bp.caterer_id
      ${where}
      ORDER BY bp.created_at DESC
    `, params);

    res.json({ prognosen: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// GET /api/bedarf/aggregiert – für Lager-Abgleich (Admin)
router.get('/aggregiert', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        bp.produkt,
        bp.einheit,
        SUM(bp.menge_pro_woche)::numeric          AS gesamt_pro_woche,
        COUNT(DISTINCT bp.caterer_id)::int         AS caterer_anzahl,
        l.bestand                                  AS bestand_aktuell,
        CASE
          WHEN SUM(bp.menge_pro_woche) > 0
          THEN ROUND(l.bestand / (SUM(bp.menge_pro_woche) / 7))
        END                                        AS deckung_tage
      FROM bedarf_prognosen bp
      LEFT JOIN (
        SELECT produkt, SUM(bestand) AS bestand
        FROM lager_positionen GROUP BY produkt
      ) l ON LOWER(l.produkt) = LOWER(bp.produkt)
      GROUP BY bp.produkt, bp.einheit, l.bestand
      ORDER BY gesamt_pro_woche DESC
    `);
    res.json({ aggregiert: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Aggregieren' });
  }
});

// POST /api/bedarf
router.post('/', auth, role('caterer'), async (req, res) => {
  const { produkt, menge_pro_woche, einheit='kg', qualitaet_praeferenz='A' } = req.body;
  if (!produkt || !menge_pro_woche) {
    return res.status(400).json({ error: 'produkt und menge_pro_woche erforderlich' });
  }
  try {
    const catId = await getCatererId(req.user.id);
    if (!catId) return res.status(400).json({ error: 'Caterer-Profil fehlt' });

    const { rows: [b] } = await db.query(`
      INSERT INTO bedarf_prognosen (caterer_id, produkt, menge_pro_woche, einheit, qualitaet_praeferenz)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [catId, produkt, menge_pro_woche, einheit, qualitaet_praeferenz]);

    res.status(201).json({ prognose: b });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erstellen fehlgeschlagen' });
  }
});

// PUT /api/bedarf/:id
router.put('/:id', auth, role('caterer'), async (req, res) => {
  const { menge_pro_woche, qualitaet_praeferenz } = req.body;
  try {
    const catId = await getCatererId(req.user.id);
    const { rows: [b] } = await db.query(`
      UPDATE bedarf_prognosen SET
        menge_pro_woche      = COALESCE($1, menge_pro_woche),
        qualitaet_praeferenz = COALESCE($2, qualitaet_praeferenz)
      WHERE id=$3 AND caterer_id=$4
      RETURNING *
    `, [menge_pro_woche, qualitaet_praeferenz, req.params.id, catId]);
    if (!b) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ prognose: b });
  } catch (err) {
    res.status(500).json({ error: 'Aktualisierung fehlgeschlagen' });
  }
});

// DELETE /api/bedarf/:id
router.delete('/:id', auth, role('caterer', 'admin'), async (req, res) => {
  try {
    const catId = req.user.role === 'caterer' ? await getCatererId(req.user.id) : null;
    const condition = catId ? `id=$1 AND caterer_id=$2` : `id=$1`;
    const params    = catId ? [req.params.id, catId] : [req.params.id];

    const { rowCount } = await db.query(
      `DELETE FROM bedarf_prognosen WHERE ${condition}`, params
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ message: 'Gelöscht' });
  } catch (err) {
    res.status(500).json({ error: 'Löschen fehlgeschlagen' });
  }
});

module.exports = router;
