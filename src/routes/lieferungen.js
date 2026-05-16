const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');
const payout  = require('../services/payout');
const email   = require('../services/email');

const router = express.Router();

// GET /api/lieferungen – Liste (Admin + Caterer)
router.get('/', auth, async (req, res) => {
  // Tabelle existiert-Check
  try {
    await db.query(`SELECT 1 FROM lieferungen LIMIT 1`);
  } catch {
    return res.json({ lieferungen: [] });
  }
  try {
    const { pool_id, status, limit = 50 } = req.query;
    const params = [parseInt(limit)];
    const filters = [];

    // Caterer sieht nur eigene Pools
    if (req.user.role === 'caterer') {
      const { rows: [cat] } = await db.query(
        `SELECT id FROM caterer WHERE user_id = $1`, [req.user.id]
      );
      if (!cat) return res.json({ lieferungen: [] });
      params.push(cat.id);
      filters.push(`p.caterer_id = $${params.length}`);
    }

    if (pool_id) { params.push(pool_id); filters.push(`l.pool_id = $${params.length}`); }
    if (status)  { params.push(status);  filters.push(`l.status = $${params.length}`); }

    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        l.id, l.pool_id, l.lieferschein_nr, l.qr_code,
        l.status, l.created_at,
        COALESCE(l.lieferdatum::text,    '')  AS lieferdatum,
        COALESCE(l.menge_bestellt,       0)   AS menge_bestellt,
        COALESCE(l.menge_geliefert,      0)   AS menge_geliefert,
        COALESCE(l.qualitaet,            '')  AS qualitaet,
        COALESCE(l.notiz,                '')  AS notiz,
        l.wareneingang_at,
        p.produkt, p.lieferwoche, p.caterer_id
      FROM lieferungen l
      JOIN pools p ON p.id = l.pool_id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT $1
    `, params);

    res.json({ lieferungen: rows });
  } catch (err) {
    console.error('[lieferungen GET]', err.message);
    // Graceful fallback – nie 500 an Frontend
    res.json({ lieferungen: [] });
  }
});

// GET /api/lieferungen/scan/:qr
router.get('/scan/:qr', auth, role('caterer', 'fahrer', 'admin'), async (req, res) => {
  try {
    const { rows: [l] } = await db.query(`
      SELECT l.*, p.produkt, p.lieferwoche
      FROM lieferungen l JOIN pools p ON p.id = l.pool_id
      WHERE l.qr_code = $1
    `, [req.params.qr.toUpperCase()]);

    if (!l) return res.status(404).json({ error: 'Lieferschein nicht gefunden' });
    res.json({ lieferung: l });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Suchen' });
  }
});

// POST /api/lieferungen – Lieferschein erstellen (Admin)
router.post('/', auth, role('admin', 'caterer'), async (req, res) => {
  const { pool_id, lieferdatum } = req.body;
  if (!pool_id) return res.status(400).json({ error: 'pool_id erforderlich' });

  try {
    const { rows: [pool] } = await db.query(
      `SELECT * FROM pools WHERE id = $1`, [pool_id]
    );
    if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });

    const nr  = 'LP-' + Date.now().toString(36).toUpperCase().slice(-8);
    const qr  = 'QR-' + Math.random().toString(36).slice(2,10).toUpperCase();
    const dat = lieferdatum || new Date().toISOString().split('T')[0];

    const { rows: [lief] } = await db.query(`
      INSERT INTO lieferungen (pool_id, lieferschein_nr, qr_code, lieferdatum, menge_bestellt, status)
      VALUES ($1, $2, $3, $4, $5, 'erstellt')
      RETURNING *
    `, [pool_id, nr, qr, dat, pool.menge_committed]);

    // E-Mail an Caterer
    try {
      const { rows:[cat] } = await db.query(
        `SELECT c.firma_name, u.email FROM caterer c JOIN users u ON u.id=c.user_id WHERE c.id=$1`,
        [pool.caterer_id]
      );
      if (cat?.email) {
        require('../services/email').sendLieferscheinErstellt({
          catererEmail: cat.email, catererName: cat.firma_name,
          produkt: pool.produkt, lieferwoche: pool.lieferwoche,
          lieferscheinNr: lief.lieferschein_nr, qrCode: lief.qr_code,
        }).catch(()=>{});
      }
    } catch {}
    res.status(201).json({ lieferung: { ...lief, produkt: pool.produkt, lieferwoche: pool.lieferwoche } });
  } catch (err) {
    console.error('[lieferungen POST]', err.message);
    res.status(500).json({ error: 'Lieferschein konnte nicht erstellt werden: ' + err.message });
  }
});

// POST /api/lieferungen/:id/wareneingang
router.post('/:id/wareneingang', auth, role('caterer', 'admin'), async (req, res) => {
  const { menge_geliefert, qualitaet = 'A', notiz } = req.body;
  if (!menge_geliefert) return res.status(400).json({ error: 'menge_geliefert erforderlich' });

  try {
    const { rows: [lief] } = await db.query(`
      UPDATE lieferungen
      SET menge_geliefert = $1, qualitaet = $2, notiz = $3,
          status = 'eingegangen', wareneingang_at = NOW()
      WHERE id = $4 RETURNING *
    `, [menge_geliefert, qualitaet, notiz, req.params.id]);

    if (!lief) return res.status(404).json({ error: 'Lieferung nicht gefunden' });

    // Auszahlungen berechnen
    let payoutResult = null;
    try {
      payoutResult = await payout.calculateAndCreatePayouts(lief.id);
    } catch (payErr) {
      console.warn('[wareneingang payout]', payErr.message);
    }

    // Erzeuger per E-Mail benachrichtigen
    try {
      const { rows: erzeuger } = await db.query(`
        SELECT DISTINCT u.email, e.betrieb_name, $2 AS produkt
        FROM commitments c
        JOIN erzeuger e ON e.id = c.erzeuger_id
        JOIN users u ON u.id = e.user_id
        JOIN pools p ON p.id = c.pool_id
        WHERE c.pool_id = $1 AND c.status IN ('aktiv','geliefert')
      `, [lief.pool_id, lief.produkt || '']);

      for (const e of erzeuger) {
        email.sendWareneingangBestaetigt({
          erzeugerEmail: e.email,
          erzeugerName:  e.betrieb_name,
          lieferung: { ...lief, produkt: e.produkt },
        }).catch(err => console.warn('[email wareneingang]', err.message));
      }
    } catch (emailErr) {
      console.warn('[email]', emailErr.message);
    }

    res.json({ lieferung: lief, payouts: payoutResult?.payouts || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Wareneingang fehlgeschlagen' });
  }
});


// GET /api/lieferungen/qr/:code – QR-Code als PNG
router.get('/qr/:code', async (req, res) => {
  const code   = req.params.code;
  const appUrl = process.env.APP_URL || 'https://frischkette.onrender.com';
  const qrData = `${appUrl}/caterer?qr=${code}`;

  try {
    const QRCode = require('qrcode');
    const png = await QRCode.toBuffer(qrData, {
      type: 'png', width: 300, margin: 2,
      color: { dark: '#0d1f15', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(png);
  } catch (err) {
    // Fallback: Redirect zu externem QR-Generator
    console.warn('[qr] qrcode Paket Fehler, Fallback:', err.message);
    return res.redirect(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrData)}&color=0d1f15`);
  }
});

// GET /api/lieferungen/qr-svg/:code – QR als SVG
router.get('/qr-svg/:code', async (req, res) => {
  const code   = req.params.code;
  const appUrl = process.env.APP_URL || 'https://frischkette.onrender.com';
  const qrData = `${appUrl}/caterer?qr=${code}`;

  try {
    const QRCode = require('qrcode');
    const svg = await QRCode.toString(qrData, {
      type: 'svg', width: 200, margin: 2,
      color: { dark: '#0d1f15', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(svg);
  } catch (err) {
    return res.redirect(`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}&color=0d1f15`);
  }
});


// DELETE /api/lieferungen/:id – Lieferschein löschen (nur Admin, nur wenn nicht abgeschlossen)
router.delete('/:id', auth, role('admin'), async (req, res) => {
  try {
    const { rows: [lief] } = await db.query(
      `SELECT id, status, lieferschein_nr FROM lieferungen WHERE id=$1`, [req.params.id]
    );
    if (!lief) return res.status(404).json({ error: 'Lieferschein nicht gefunden' });
    if (lief.status === 'abgeschlossen') {
      return res.status(400).json({ error: 'Abgeschlossene Lieferscheine können nicht gelöscht werden' });
    }
    await db.query(`DELETE FROM lieferungen WHERE id=$1`, [req.params.id]);
    res.json({ message: `Lieferschein ${lief.lieferschein_nr} gelöscht` });
  } catch (err) {
    console.error('[lieferungen DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// GET /api/lieferungen/meine – Erzeuger sieht seine Lieferscheine
router.get('/meine', auth, role('erzeuger'), async (req, res) => {
  try {
    const { rows: [erz] } = await db.query(
      `SELECT id FROM erzeuger WHERE user_id=$1`, [req.user.id]
    );
    if (!erz) return res.json({ lieferungen: [] });

    const { rows } = await db.query(`
      SELECT DISTINCT
        l.id, l.lieferschein_nr, l.qr_code, l.lieferdatum,
        l.menge_bestellt, l.menge_geliefert, l.status, l.created_at,
        p.produkt, p.lieferwoche, p.preis_pro_einheit,
        c.menge AS meine_menge,
        -- Mein Anteil: meine Menge / Gesamtmenge * Nettobetrag
        ROUND(
          (c.menge / NULLIF(p.menge_committed, 0))
          * (l.menge_geliefert * p.preis_pro_einheit * 0.99)
        , 2) AS mein_anteil
      FROM lieferungen l
      JOIN pools p       ON p.id = l.pool_id
      JOIN commitments c ON c.pool_id = p.id AND c.erzeuger_id = $1 AND c.status = 'aktiv'
      ORDER BY l.created_at DESC
    `, [erz.id]);

    res.json({ lieferungen: rows });
  } catch (err) {
    console.error('[lieferungen/meine]', err.message);
    res.json({ lieferungen: [] });
  }
});

module.exports = router;
