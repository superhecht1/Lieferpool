const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');
const email   = require('../services/email');

const router = express.Router();

// ----------------------------------------------------------------
// GET /api/auszahlungen – alle Auszahlungen (Admin)
// ----------------------------------------------------------------
router.get('/', auth, role('admin'), async (req, res) => {
  try {
    const { status, erzeuger_id, limit = 100 } = req.query;
    const params  = [parseInt(limit)];
    const filters = [];

    if (status)      { params.push(status);      filters.push(`a.status = $${params.length}`); }
    if (erzeuger_id) { params.push(erzeuger_id); filters.push(`a.erzeuger_id = $${params.length}`); }

    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        a.*,
        e.betrieb_name,
        u.email AS erzeuger_email,
        p.produkt,
        p.lieferwoche,
        c.menge AS commitment_menge
      FROM auszahlungen a
      JOIN erzeuger e  ON e.id  = a.erzeuger_id
      JOIN users u     ON u.id  = e.user_id
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p     ON p.id  = c.pool_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT $1
    `, params);

    // Summen berechnen
    const gesamt     = rows.reduce((s, r) => s + parseFloat(r.netto), 0);
    const ausstehend = rows.filter(r => r.status === 'ausstehend').reduce((s, r) => s + parseFloat(r.netto), 0);
    const veranlasst = rows.filter(r => r.status === 'veranlasst').reduce((s, r) => s + parseFloat(r.netto), 0);
    const ausgezahlt = rows.filter(r => r.status === 'ausgezahlt').reduce((s, r) => s + parseFloat(r.netto), 0);

    res.json({
      auszahlungen: rows,
      summen: {
        gesamt:     gesamt.toFixed(2),
        ausstehend: ausstehend.toFixed(2),
        veranlasst: veranlasst.toFixed(2),
        ausgezahlt: ausgezahlt.toFixed(2),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Laden der Auszahlungen' });
  }
});

// ----------------------------------------------------------------
// PUT /api/auszahlungen/:id/status – Status aktualisieren
// ----------------------------------------------------------------
router.put('/:id/status', auth, role('admin'), async (req, res) => {
  const { status } = req.body;
  const ERLAUBT = ['ausstehend', 'veranlasst', 'ausgezahlt', 'fehlgeschlagen'];
  if (!ERLAUBT.includes(status)) {
    return res.status(400).json({ error: 'Ungültiger Status' });
  }

  try {
    const { rows: [az] } = await db.query(`
      UPDATE auszahlungen
      SET status = $1,
          ausgezahlt_am = CASE WHEN $1 = 'ausgezahlt' THEN NOW() ELSE ausgezahlt_am END
      WHERE id = $2
      RETURNING *
    `, [status, req.params.id]);

    if (!az) return res.status(404).json({ error: 'Auszahlung nicht gefunden' });

    // E-Mail bei Veranlassung
    if (status === 'veranlasst') {
      try {
        const { rows: [detail] } = await db.query(`
          SELECT e.betrieb_name, u.email AS erzeuger_email, p.produkt, p.lieferwoche, c.menge
          FROM auszahlungen a
          JOIN erzeuger e    ON e.id = a.erzeuger_id
          JOIN users u       ON u.id = e.user_id
          JOIN commitments c ON c.id = a.commitment_id
          JOIN pools p       ON p.id = c.pool_id
          WHERE a.id = $1
        `, [req.params.id]);

        if (detail) {
          await email.sendAuszahlungVeranlasst({
            erzeugerEmail: detail.erzeuger_email,
            erzeugerName:  detail.betrieb_name,
            auszahlung: {
              ...az,
              produkt:     detail.produkt,
              lieferwoche: detail.lieferwoche,
              menge:       detail.menge,
            },
          });
        }
      } catch (emailErr) {
        console.warn('[auszahlungen] E-Mail fehlgeschlagen:', emailErr.message);
      }
    }

    res.json({ auszahlung: az });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Status konnte nicht gesetzt werden' });
  }
});

// ----------------------------------------------------------------
// POST /api/auszahlungen/bulk-veranlassen
// Alle ausstehenden Auszahlungen auf "veranlasst" setzen
// ----------------------------------------------------------------
router.post('/bulk-veranlassen', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      UPDATE auszahlungen
      SET status = 'veranlasst'
      WHERE status = 'ausstehend'
      RETURNING id, netto, erzeuger_id
    `);

    // E-Mails versenden (async, nicht blockierend)
    if (rows.length > 0) {
      db.query(`
        SELECT a.id, a.netto, a.brutto, a.abzug_qualitaet, a.platform_fee,
               e.betrieb_name, u.email AS erzeuger_email,
               p.produkt, p.lieferwoche, c.menge
        FROM auszahlungen a
        JOIN erzeuger e    ON e.id = a.erzeuger_id
        JOIN users u       ON u.id = e.user_id
        JOIN commitments c ON c.id = a.commitment_id
        JOIN pools p       ON p.id = c.pool_id
        WHERE a.id = ANY($1)
      `, [rows.map(r => r.id)]).then(({ rows: details }) => {
        details.forEach(d => {
          email.sendAuszahlungVeranlasst({
            erzeugerEmail: d.erzeuger_email,
            erzeugerName:  d.betrieb_name,
            auszahlung:    d,
          }).catch(e => console.warn('[email]', e.message));
        });
      }).catch(e => console.warn('[bulk email]', e.message));
    }

    const gesamt = rows.reduce((s, r) => s + parseFloat(r.netto), 0);
    res.json({
      message:  `${rows.length} Auszahlungen veranlasst`,
      count:    rows.length,
      gesamt:   gesamt.toFixed(2),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk-Veranlassung fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// POST /api/auszahlungen/bulk-ausgezahlt
// Alle veranlassten auf "ausgezahlt" setzen
// ----------------------------------------------------------------
router.post('/bulk-ausgezahlt', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      UPDATE auszahlungen
      SET status = 'ausgezahlt', ausgezahlt_am = NOW()
      WHERE status = 'veranlasst'
      RETURNING id, netto
    `);

    const gesamt = rows.reduce((s, r) => s + parseFloat(r.netto), 0);
    res.json({
      message: `${rows.length} Auszahlungen als ausgezahlt markiert`,
      count:   rows.length,
      gesamt:  gesamt.toFixed(2),
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
