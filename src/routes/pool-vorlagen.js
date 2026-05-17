/**
 * Wiederkehrende Pool-Vorlagen für FrischKette
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

// GET /api/pool-vorlagen – Liste
router.get('/', auth, async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      const r = await db.query(`
        SELECT pv.*, c.firma_name
        FROM pool_vorlagen pv
        JOIN caterer c ON c.id=pv.caterer_id
        ORDER BY pv.created_at DESC
      `);
      rows = r.rows;
    } else {
      const { rows:[cat] } = await db.query(`SELECT id FROM caterer WHERE user_id=$1`,[req.user.id]);
      if (!cat) return res.json({ vorlagen: [] });
      const r = await db.query(`SELECT * FROM pool_vorlagen WHERE caterer_id=$1 ORDER BY wochentag`,[cat.id]);
      rows = r.rows;
    }
    res.json({ vorlagen: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/pool-vorlagen – Vorlage erstellen
router.post('/', auth, role('caterer','admin'), async (req, res) => {
  const { produkt, menge_ziel, preis_pro_einheit, wochentag, deadline_tage, notiz } = req.body;
  if (!produkt || wochentag == null) return res.status(400).json({ error: 'Produkt und Wochentag erforderlich' });
  try {
    let caterer_id;
    if (req.user.role === 'admin') {
      caterer_id = req.body.caterer_id;
    } else {
      const { rows:[cat] } = await db.query(`SELECT id FROM caterer WHERE user_id=$1`,[req.user.id]);
      caterer_id = cat?.id;
    }
    if (!caterer_id) return res.status(400).json({ error: 'Caterer nicht gefunden' });

    const { rows:[v] } = await db.query(`
      INSERT INTO pool_vorlagen (caterer_id, produkt, menge_ziel, preis_pro_einheit, wochentag, deadline_tage, notiz)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [caterer_id, produkt, menge_ziel||null, preis_pro_einheit||null, parseInt(wochentag), parseInt(deadline_tage)||3, notiz||null]);

    res.status(201).json({ vorlage: v, message: `Vorlage erstellt — Pool wird jeden ${WOCHENTAGE[parseInt(wochentag)]} automatisch erstellt` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/pool-vorlagen/:id – Vorlage bearbeiten
router.put('/:id', auth, role('caterer','admin'), async (req, res) => {
  const { produkt, menge_ziel, preis_pro_einheit, wochentag, deadline_tage, aktiv, notiz } = req.body;
  try {
    await db.query(`
      UPDATE pool_vorlagen SET
        produkt=$1, menge_ziel=$2, preis_pro_einheit=$3,
        wochentag=$4, deadline_tage=$5, aktiv=$6, notiz=$7
      WHERE id=$8
    `, [produkt, menge_ziel||null, preis_pro_einheit||null,
        parseInt(wochentag), parseInt(deadline_tage)||3, aktiv !== false, notiz||null,
        req.params.id]);
    res.json({ message: 'Vorlage aktualisiert' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/pool-vorlagen/:id
router.delete('/:id', auth, role('caterer','admin'), async (req, res) => {
  try {
    await db.query(`DELETE FROM pool_vorlagen WHERE id=$1`,[req.params.id]);
    res.json({ message: 'Vorlage gelöscht' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/pool-vorlagen/:id/erstellen – Pool aus Vorlage sofort erstellen
router.post('/:id/erstellen', auth, role('caterer','admin'), async (req, res) => {
  try {
    const { rows:[v] } = await db.query(`
      SELECT pv.*, c.id AS cat_id
      FROM pool_vorlagen pv JOIN caterer c ON c.id=pv.caterer_id
      WHERE pv.id=$1
    `, [req.params.id]);
    if (!v) return res.status(404).json({ error: 'Vorlage nicht gefunden' });

    // Nächste KW berechnen
    const heute     = new Date();
    const naechste  = new Date(heute);
    naechste.setDate(heute.getDate() + (7 - heute.getDay() + v.wochentag) % 7 || 7);
    const kw        = getKW(naechste);
    const lieferwoche = `${naechste.getFullYear()}-KW${String(kw).padStart(2,'0')}`;

    // Deadline setzen
    const deadline  = new Date(naechste);
    deadline.setDate(deadline.getDate() - (v.deadline_tage||3));

    const { rows:[pool] } = await db.query(`
      INSERT INTO pools (caterer_id, produkt, menge_ziel, preis_pro_einheit, lieferwoche, deadline, notiz, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'offen') RETURNING *
    `, [v.cat_id, v.produkt, v.menge_ziel, v.preis_pro_einheit, lieferwoche, deadline.toISOString(), v.notiz||null]);

    res.status(201).json({ pool, message: `Pool für ${lieferwoche} erstellt` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

const WOCHENTAGE = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];

function getKW(date) {
  const d    = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day  = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y1   = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - y1) / 86400000) + 1) / 7);
}

module.exports = router;
