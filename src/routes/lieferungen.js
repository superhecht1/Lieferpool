const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { auth, role } = require('../middleware/auth');
const chain = require('../services/chain');
const { calculateAndCreatePayouts } = require('../services/payout');

const router = express.Router();

// ----------------------------------------------------------------
// Hilfsfunktion: Wareneingang → Lagerbuchung
// Wird intern nach Bestätigung aufgerufen
// ----------------------------------------------------------------
async function bucheWareneingang(client, { produkt, einheit = 'kg', menge, region = 'NRW',
                                           pool_id, lieferung_id, qualitaet, user_id }) {
  // Lager-Position holen oder anlegen
  const { rows: [lager] } = await client.query(`
    INSERT INTO lager_positionen (produkt, einheit, region)
    VALUES ($1, $2, $3)
    ON CONFLICT (produkt, region) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `, [produkt, einheit, region]);

  // Bestand erhöhen
  const { rows: [updated] } = await client.query(`
    UPDATE lager_positionen SET bestand = bestand + $1 WHERE id = $2 RETURNING bestand
  `, [menge, lager.id]);

  // Bewegung buchen
  await client.query(`
    INSERT INTO lager_bewegungen
      (lager_id, typ, menge, bestand_nach, pool_id, lieferung_id, qualitaet, notiz, erstellt_von)
    VALUES ($1, 'eingang', $2, $3, $4, $5, $6, $7, $8)
  `, [lager.id, menge, updated.bestand, pool_id, lieferung_id,
      qualitaet, 'Automatisch bei Wareneingangsbestätigung', user_id]);

  return { bestand_aktuell: updated.bestand, unterbestand: updated.bestand <= lager.mindestbestand };
}

// ----------------------------------------------------------------
// POST /api/lieferungen – Lieferschein erstellen
// ----------------------------------------------------------------
router.post('/', auth, role('admin', 'caterer'), async (req, res) => {
  const { pool_id, lieferdatum } = req.body;
  if (!pool_id) return res.status(400).json({ error: 'pool_id fehlt' });

  try {
    const { rows: [pool] } = await db.query(
      `SELECT * FROM pools WHERE id = $1`, [pool_id]
    );
    if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });

    const qr = 'LP-' + uuidv4().slice(0, 8).toUpperCase();
    const nr = 'LS-' + Date.now();

    const { rows: [lief] } = await db.query(`
      INSERT INTO lieferungen
        (pool_id, lieferschein_nr, qr_code, menge_bestellt, lieferdatum)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [pool_id, nr, qr, pool.menge_committed, lieferdatum || null]);

    res.status(201).json({ lieferung: lief });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lieferschein konnte nicht erstellt werden' });
  }
});

// ----------------------------------------------------------------
// GET /api/lieferungen/scan/:qr – QR-Code scannen
// ----------------------------------------------------------------
router.get('/scan/:qr', auth, role('caterer', 'admin'), async (req, res) => {
  try {
    const { rows: [lief] } = await db.query(`
      SELECT l.*, p.produkt, p.preis_pro_einheit, c.firma_name AS caterer_name
      FROM lieferungen l
      JOIN pools p ON p.id = l.pool_id
      LEFT JOIN caterer c ON c.id = p.caterer_id
      WHERE l.qr_code = $1
    `, [req.params.qr.toUpperCase()]);

    if (!lief) return res.status(404).json({ error: 'QR-Code nicht gefunden' });
    res.json({ lieferung: lief });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Scan fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// POST /api/lieferungen/:id/wareneingang
// Caterer bestätigt Wareneingang → Auszahlungen + Lagerbuchung
// ----------------------------------------------------------------
router.post('/:id/wareneingang', auth, role('caterer', 'admin'), async (req, res) => {
  const { menge_geliefert, qualitaet = 'A', notiz } = req.body;

  if (!menge_geliefert) return res.status(400).json({ error: 'menge_geliefert fehlt' });
  if (!['A', 'B', 'C', 'abgelehnt'].includes(qualitaet)) {
    return res.status(400).json({ error: 'Ungültige Qualitätsstufe' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lieferung + Pool laden
    const { rows: [lief] } = await client.query(`
      SELECT l.*, p.produkt, p.einheit, p.region
      FROM lieferungen l
      JOIN pools p ON p.id = l.pool_id
      WHERE l.id = $1
    `, [req.params.id]);

    if (!lief) return res.status(404).json({ error: 'Lieferung nicht gefunden' });
    if (lief.status === 'eingegangen') {
      return res.status(400).json({ error: 'Wareneingang bereits bestätigt' });
    }

    const lieferschein_hash = '0x' + Buffer.from(lief.lieferschein_nr + menge_geliefert)
      .toString('hex').slice(0, 64);

    // On-chain bestätigen
    const { txHash: deliveryTx } = await chain.confirmDelivery(
      lief.id, lief.pool_id, menge_geliefert, qualitaet
    );

    // Lieferung aktualisieren
    await client.query(`
      UPDATE lieferungen
      SET menge_geliefert = $1, qualitaet = $2, status = 'eingegangen',
          wareneingang_at = NOW(), bestaetigt_von = $3,
          lieferschein_hash = $4, chain_tx = $5, notiz = $6
      WHERE id = $7
    `, [menge_geliefert, qualitaet, req.user.id, lieferschein_hash, deliveryTx, notiz, lief.id]);

    // ── NEU: Automatische Lagerbuchung ──────────────────────────
    let lagerInfo = null;
    if (qualitaet !== 'abgelehnt') {
      lagerInfo = await bucheWareneingang(client, {
        produkt:     lief.produkt,
        einheit:     lief.einheit,
        menge:       parseFloat(menge_geliefert),
        region:      lief.region || 'NRW',
        pool_id:     lief.pool_id,
        lieferung_id: lief.id,
        qualitaet,
        user_id:     req.user.id,
      });
    }
    // ─────────────────────────────────────────────────────────────

    await client.query('COMMIT');

    // Auszahlungen berechnen (außerhalb der Transaktion, eigene Transaktion intern)
    const { payouts, txHash: payoutTx } = qualitaet !== 'abgelehnt'
      ? await calculateAndCreatePayouts(lief.id)
      : { payouts: [], txHash: null };

    res.json({
      message: 'Wareneingang bestätigt',
      auszahlungen: payouts.length,
      gesamt_netto: payouts.reduce((s, p) => s + p.netto, 0).toFixed(2),
      lager: lagerInfo,
      chain: { deliveryTx, payoutTx },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Wareneingang fehlgeschlagen' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// GET /api/lieferungen/:id
// ----------------------------------------------------------------
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows: [lief] } = await db.query(`
      SELECT l.*, p.produkt, p.preis_pro_einheit
      FROM lieferungen l
      JOIN pools p ON p.id = l.pool_id
      WHERE l.id = $1
    `, [req.params.id]);

    if (!lief) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ lieferung: lief });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
