const express = require('express');
const db = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

// ----------------------------------------------------------------
// GET /api/bedarf – eigene Bedarfsprognosen (Caterer)
// ----------------------------------------------------------------
router.get('/', auth, role('caterer', 'admin'), async (req, res) => {
  try {
    let rows;

    if (req.user.role === 'admin') {
      // Admin sieht alle
      const result = await db.query(`
        SELECT bp.*, c.firma_name AS caterer_name, u.email AS caterer_email
        FROM bedarf_prognosen bp
        JOIN caterer c ON c.id = bp.caterer_id
        JOIN users u ON u.id = c.user_id
        WHERE bp.aktiv = true
        ORDER BY bp.produkt, c.firma_name
      `);
      rows = result.rows;
    } else {
      // Caterer sieht nur eigene
      const { rows: [caterer] } = await db.query(
        `SELECT id FROM caterer WHERE user_id = $1`, [req.user.id]
      );
      if (!caterer) return res.status(404).json({ error: 'Caterer-Profil nicht gefunden' });

      const result = await db.query(`
        SELECT * FROM bedarf_prognosen
        WHERE caterer_id = $1
        ORDER BY produkt
      `, [caterer.id]);
      rows = result.rows;
    }

    res.json({ prognosen: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bedarfsprognosen konnten nicht geladen werden' });
  }
});

// ----------------------------------------------------------------
// GET /api/bedarf/aggregiert – Admin: Gesamtbedarf pro Produkt
// Basis für Pool-Planung
// ----------------------------------------------------------------
router.get('/aggregiert', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        bp.produkt,
        bp.einheit,
        COUNT(DISTINCT bp.caterer_id)::int AS caterer_anzahl,
        SUM(bp.menge_pro_woche) AS gesamt_pro_woche,
        ARRAY_AGG(DISTINCT elem) FILTER (WHERE elem IS NOT NULL) AS liefertage,
        SUM(bp.menge_pro_woche) * 4 AS gesamt_pro_monat
      FROM bedarf_prognosen bp,
           LATERAL UNNEST(bp.liefertage) AS elem
      WHERE bp.aktiv = true
      GROUP BY bp.produkt, bp.einheit
      ORDER BY gesamt_pro_woche DESC
    `);

    // Vergleich mit aktuellem Lagerbestand
    const { rows: lager } = await db.query(
      `SELECT produkt, bestand, mindestbestand FROM lager_positionen`
    );
    const lagerMap = Object.fromEntries(lager.map(l => [l.produkt, l]));

    const enriched = rows.map(r => ({
      ...r,
      bestand_aktuell: lagerMap[r.produkt]?.bestand ?? null,
      mindestbestand:  lagerMap[r.produkt]?.mindestbestand ?? null,
      deckung_tage: lagerMap[r.produkt]?.bestand
        ? Math.floor((lagerMap[r.produkt].bestand / r.gesamt_pro_woche) * 7)
        : null,
    }));

    res.json({ aggregiert: enriched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Aggregierung fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// POST /api/bedarf – Bedarfsprognose anlegen
// ----------------------------------------------------------------
router.post('/', auth, role('caterer', 'admin'), async (req, res) => {
  const { produkt, einheit = 'kg', menge_pro_woche, liefertage = [], notiz } = req.body;

  if (!produkt || !menge_pro_woche || menge_pro_woche <= 0) {
    return res.status(400).json({ error: 'produkt und menge_pro_woche erforderlich' });
  }

  const ERLAUBTE_TAGE = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag'];
  const validTage = liefertage.filter(t => ERLAUBTE_TAGE.includes(t));

  try {
    const { rows: [caterer] } = await db.query(
      `SELECT id FROM caterer WHERE user_id = $1`, [req.user.id]
    );
    if (!caterer) return res.status(404).json({ error: 'Caterer-Profil nicht gefunden' });

    const { rows: [prognose] } = await db.query(`
      INSERT INTO bedarf_prognosen
        (caterer_id, produkt, einheit, menge_pro_woche, liefertage, notiz)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [caterer.id, produkt, einheit, menge_pro_woche,
        validTage.length ? validTage : null, notiz || null]);

    res.status(201).json({ prognose });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Prognose konnte nicht angelegt werden' });
  }
});

// ----------------------------------------------------------------
// PUT /api/bedarf/:id – Prognose aktualisieren
// ----------------------------------------------------------------
router.put('/:id', auth, role('caterer', 'admin'), async (req, res) => {
  const { menge_pro_woche, liefertage, aktiv, notiz } = req.body;

  try {
    // Eigentümerprüfung für Caterer
    if (req.user.role === 'caterer') {
      const { rows: [caterer] } = await db.query(
        `SELECT id FROM caterer WHERE user_id = $1`, [req.user.id]
      );
      const { rows: [bp] } = await db.query(
        `SELECT caterer_id FROM bedarf_prognosen WHERE id = $1`, [req.params.id]
      );
      if (!bp || bp.caterer_id !== caterer?.id) {
        return res.status(403).json({ error: 'Keine Berechtigung' });
      }
    }

    const { rows: [prognose] } = await db.query(`
      UPDATE bedarf_prognosen
      SET
        menge_pro_woche = COALESCE($1, menge_pro_woche),
        liefertage      = COALESCE($2, liefertage),
        aktiv           = COALESCE($3, aktiv),
        notiz           = COALESCE($4, notiz)
      WHERE id = $5
      RETURNING *
    `, [menge_pro_woche || null, liefertage || null, aktiv ?? null, notiz || null, req.params.id]);

    if (!prognose) return res.status(404).json({ error: 'Prognose nicht gefunden' });
    res.json({ prognose });
  } catch (err) {
    res.status(500).json({ error: 'Update fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// DELETE /api/bedarf/:id – Prognose deaktivieren (soft delete)
// ----------------------------------------------------------------
router.delete('/:id', auth, role('caterer', 'admin'), async (req, res) => {
  try {
    await db.query(
      `UPDATE bedarf_prognosen SET aktiv = false WHERE id = $1`, [req.params.id]
    );
    res.json({ message: 'Prognose deaktiviert' });
  } catch (err) {
    res.status(500).json({ error: 'Deaktivierung fehlgeschlagen' });
  }
});

module.exports = router;
