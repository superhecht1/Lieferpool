const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

// GET /api/caterer/me
router.get('/me', auth, role('caterer', 'admin'), async (req, res) => {
  try {
    const userId = req.user.role === 'admin' && req.query.user_id ? req.query.user_id : req.user.id;
    const { rows: [c] } = await db.query(
      `SELECT c.*, u.email FROM caterer c JOIN users u ON u.id = c.user_id WHERE c.user_id = $1`,
      [userId]
    );
    if (!c) return res.status(404).json({ error: 'Caterer-Profil nicht gefunden' });

    const { rows: pools } = await db.query(
      `SELECT p.id, p.produkt, p.status, p.lieferwoche, p.menge_committed, p.menge_ziel
       FROM pools p WHERE p.caterer_id = $1 ORDER BY p.created_at DESC LIMIT 10`,
      [c.id]
    );

    res.json({ caterer: c, pools });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// PUT /api/caterer/me
router.put('/me', auth, role('caterer'), async (req, res) => {
  const {
    firma_name, region, adresse, plz, ort, telefon, website,
    beschreibung, ust_id, kuechen_typ, kuechen_kapazitaet,
    anz_plaetze, bank_name, iban, gruendungsjahr,
  } = req.body;
  try {
    const { rows: [c] } = await db.query(`
      UPDATE caterer SET
        firma_name          = COALESCE($1,  firma_name),
        region              = COALESCE($2,  region),
        adresse             = COALESCE($3,  adresse),
        plz                 = COALESCE($4,  plz),
        ort                 = COALESCE($5,  ort),
        telefon             = COALESCE($6,  telefon),
        website             = COALESCE($7,  website),
        beschreibung        = COALESCE($8,  beschreibung),
        ust_id              = COALESCE($9,  ust_id),
        kuechen_typ         = COALESCE($10, kuechen_typ),
        kuechen_kapazitaet  = COALESCE($11, kuechen_kapazitaet),
        anz_plaetze         = COALESCE($12, anz_plaetze),
        bank_name           = COALESCE($13, bank_name),
        iban                = COALESCE($14, iban),
        gruendungsjahr      = COALESCE($15, gruendungsjahr)
      WHERE user_id = $16 RETURNING *
    `, [firma_name, region, adresse, plz, ort, telefon, website,
        beschreibung, ust_id, kuechen_typ, kuechen_kapazitaet,
        anz_plaetze, bank_name, iban, gruendungsjahr, req.user.id]);
    res.json({ caterer: c });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Aktualisierung fehlgeschlagen' });
  }
});

// GET /api/caterer (Admin: alle Caterer)
router.get('/', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.*, u.email,
        COUNT(DISTINCT p.id)::int AS pool_count
      FROM caterer c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN pools p ON p.caterer_id = c.id
      GROUP BY c.id, u.email
      ORDER BY c.created_at DESC
    `);
    res.json({ caterer: rows || [] });
  } catch (err) {
    console.error('[caterer GET /]', err.message);
    res.json({ caterer: [] }); // Nie 500 zurückgeben, immer leere Liste
  }
});


// GET /api/caterer/detail/:id (Admin)
router.get('/detail/:id', auth, role('admin'), async (req, res) => {
  try {
    const { rows: [c] } = await db.query(
      `SELECT c.*, u.email FROM caterer c JOIN users u ON u.id=c.user_id WHERE c.id=$1`,
      [req.params.id]
    );
    if (!c) return res.status(404).json({ error: 'Nicht gefunden' });

    const { rows: pools } = await db.query(
      `SELECT id, produkt, lieferwoche, status, menge_committed, menge_ziel
       FROM pools WHERE caterer_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [c.id]
    );

    res.json({ caterer: c, pools });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
