const express = require('express');
const db = require('../db');
const { auth, role } = require('../middleware/auth');
const chain = require('../services/chain');
const crypto = require('crypto');

const router = express.Router();

// GET /api/erzeuger/me – eigenes Profil
router.get('/me', auth, role('erzeuger'), async (req, res) => {
  try {
    const { rows: [e] } = await db.query(
      `SELECT * FROM erzeuger WHERE user_id = $1`,
      [req.user.id]
    );
    if (!e) return res.status(404).json({ error: 'Profil nicht gefunden' });

    const { rows: zertifikate } = await db.query(
      `SELECT * FROM zertifikate WHERE erzeuger_id = $1 ORDER BY created_at DESC`,
      [e.id]
    );

    const { rows: commitments } = await db.query(`
      SELECT c.*, p.produkt, p.preis_pro_einheit, p.lieferwoche, p.status AS pool_status
      FROM commitments c
      JOIN pools p ON p.id = c.pool_id
      WHERE c.erzeuger_id = $1
      ORDER BY c.created_at DESC
      LIMIT 20
    `, [e.id]);

    res.json({ erzeuger: e, zertifikate, commitments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Profil konnte nicht geladen werden' });
  }
});

// PUT /api/erzeuger/me – Profil aktualisieren
router.put('/me', auth, role('erzeuger'), async (req, res) => {
  const { betrieb_name, region, iban, bank_name } = req.body;
  try {
    const { rows: [e] } = await db.query(`
      UPDATE erzeuger
      SET betrieb_name = COALESCE($1, betrieb_name),
          region       = COALESCE($2, region),
          iban         = COALESCE($3, iban),
          bank_name    = COALESCE($4, bank_name)
      WHERE user_id = $5
      RETURNING *
    `, [betrieb_name, region, iban, bank_name, req.user.id]);
    res.json({ erzeuger: e });
  } catch (err) {
    res.status(500).json({ error: 'Aktualisierung fehlgeschlagen' });
  }
});

// POST /api/erzeuger/zertifikate – Zertifikat einreichen
// Produktiv: multer upload → S3, hier vereinfacht mit Metadaten
router.post('/zertifikate', auth, role('erzeuger'), async (req, res) => {
  const { typ, zert_nummer, gueltig_bis } = req.body;
  if (!typ || !zert_nummer) return res.status(400).json({ error: 'typ und zert_nummer erforderlich' });

  try {
    const { rows: [e] } = await db.query(
      `SELECT id FROM erzeuger WHERE user_id = $1`,
      [req.user.id]
    );

    // Hash der Zertifikat-Daten (produktiv: Hash der echten Datei)
    const certHash = crypto.createHash('sha256')
      .update(`${e.id}-${typ}-${zert_nummer}-${gueltig_bis}`)
      .digest('hex');

    const { rows: [z] } = await db.query(`
      INSERT INTO zertifikate (erzeuger_id, typ, zert_nummer, datei_hash, gueltig_bis, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *
    `, [e.id, typ, zert_nummer, certHash, gueltig_bis || null]);

    // Hash on-chain registrieren
    const { txHash } = await chain.registerCertificate(e.id, certHash);
    await db.query(`UPDATE zertifikate SET chain_tx = $1 WHERE id = $2`, [txHash, z.id]);

    res.status(201).json({ zertifikat: { ...z, chain_tx: txHash } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Zertifikat konnte nicht eingereicht werden' });
  }
});

// GET /api/erzeuger/auszahlungen – Auszahlungshistorie
router.get('/auszahlungen', auth, role('erzeuger'), async (req, res) => {
  try {
    const { rows: [e] } = await db.query(
      `SELECT id FROM erzeuger WHERE user_id = $1`,
      [req.user.id]
    );

    const { rows } = await db.query(`
      SELECT
        a.*,
        p.produkt,
        p.lieferwoche,
        c.menge AS commitment_menge
      FROM auszahlungen a
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p ON p.id = c.pool_id
      WHERE a.erzeuger_id = $1
      ORDER BY a.created_at DESC
    `, [e.id]);

    const gesamt = rows
      .filter(r => r.status === 'ausgezahlt')
      .reduce((s, r) => s + parseFloat(r.netto), 0);

    const ausstehend = rows
      .filter(r => ['ausstehend', 'veranlasst'].includes(r.status))
      .reduce((s, r) => s + parseFloat(r.netto), 0);

    res.json({ auszahlungen: rows, gesamt: gesamt.toFixed(2), ausstehend: ausstehend.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Auszahlungen' });
  }
});

// ----------------------------------------------------------------
// ADMIN – alle Erzeuger
// ----------------------------------------------------------------
router.get('/', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT e.*, u.email,
        COUNT(DISTINCT z.id) FILTER (WHERE z.status = 'verified') AS zert_count,
        COUNT(DISTINCT c.id) AS commitment_count
      FROM erzeuger e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN zertifikate z ON z.erzeuger_id = e.id
      LEFT JOIN commitments c ON c.erzeuger_id = e.id
      GROUP BY e.id, u.email
      ORDER BY e.created_at DESC
    `);
    res.json({ erzeuger: rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ADMIN – Zertifikat genehmigen / ablehnen
router.put('/zertifikate/:id/status', auth, role('admin'), async (req, res) => {
  const { status } = req.body;
  if (!['verified', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Ungültiger Status' });
  }
  try {
    const { rows: [z] } = await db.query(`
      UPDATE zertifikate
      SET status = $1, geprueft_von = $2, geprueft_am = NOW()
      WHERE id = $3
      RETURNING *
    `, [status, req.user.id, req.params.id]);
    if (!z) return res.status(404).json({ error: 'Zertifikat nicht gefunden' });
    res.json({ zertifikat: z });
  } catch (err) {
    res.status(500).json({ error: 'Status konnte nicht gesetzt werden' });
  }
});

// ADMIN – ausstehende Zertifikate
router.get('/zertifikate/pending', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT z.*, e.betrieb_name, u.email
      FROM zertifikate z
      JOIN erzeuger e ON e.id = z.erzeuger_id
      JOIN users u ON u.id = e.user_id
      WHERE z.status = 'pending'
      ORDER BY z.created_at ASC
    `);
    res.json({ zertifikate: rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
