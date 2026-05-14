const express = require('express');
const db = require('../db');
const { auth, role } = require('../middleware/auth');
const { calculateAndCreatePayouts } = require('../services/payout');

const router = express.Router();

// ----------------------------------------------------------------
// Haversine-Distanz in km
// ----------------------------------------------------------------
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
    + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ----------------------------------------------------------------
// Greedy Nearest-Neighbor Routenoptimierung
// ----------------------------------------------------------------
function optimiereRoute(stopps, hubLat, hubLng) {
  if (stopps.length <= 1) return stopps;

  const remaining = [...stopps];
  const ordered   = [];
  let curLat = hubLat;
  let curLng = hubLng;

  while (remaining.length > 0) {
    let nearest = 0;
    let minDist  = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      if (s.lat == null || s.lng == null) { nearest = i; minDist = 0; break; }
      const d = haversine(curLat, curLng, parseFloat(s.lat), parseFloat(s.lng));
      if (d < minDist) { minDist = d; nearest = i; }
    }

    const stopp = remaining.splice(nearest, 1)[0];
    ordered.push(stopp);
    if (stopp.lat != null) { curLat = parseFloat(stopp.lat); curLng = parseFloat(stopp.lng); }
  }

  return ordered;
}

// ----------------------------------------------------------------
// GET /api/touren – Tourenübersicht
// ----------------------------------------------------------------
router.get('/', auth, async (req, res) => {
  try {
    const { datum, status } = req.query;
    const params = [];
    const filters = [];

    // Fahrer sieht nur eigene Touren
    if (req.user.role === 'fahrer') {
      params.push(req.user.id);
      filters.push(`t.fahrer_id = $${params.length}`);
    }
    if (datum) { params.push(datum); filters.push(`t.datum = $${params.length}`); }
    if (status) { params.push(status); filters.push(`t.status = $${params.length}`); }

    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        t.*,
        u.name AS fahrer_name,
        f.bezeichnung AS fahrzeug_bezeichnung,
        f.typ AS fahrzeug_typ,
        COUNT(s.id)::int AS stopp_anzahl,
        COUNT(s.id) FILTER (WHERE s.status = 'abgeschlossen')::int AS stopps_done
      FROM touren t
      LEFT JOIN users u ON u.id = t.fahrer_id
      LEFT JOIN fahrzeuge f ON f.id = t.fahrzeug_id
      LEFT JOIN tour_stopps s ON s.tour_id = t.id
      ${where}
      GROUP BY t.id, u.name, f.bezeichnung, f.typ
      ORDER BY t.datum DESC, t.startzeit
    `, params);

    res.json({ touren: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Touren konnten nicht geladen werden' });
  }
});

// ----------------------------------------------------------------
// GET /api/touren/heute – heutige Tour des Fahrers
// ----------------------------------------------------------------
router.get('/heute', auth, role('fahrer', 'admin'), async (req, res) => {
  try {
    const userId = req.query.fahrer_id || req.user.id;

    const { rows: [tour] } = await db.query(`
      SELECT t.*, u.name AS fahrer_name, f.bezeichnung AS fahrzeug_bezeichnung, f.typ AS fahrzeug_typ
      FROM touren t
      LEFT JOIN users u ON u.id = t.fahrer_id
      LEFT JOIN fahrzeuge f ON f.id = t.fahrzeug_id
      WHERE t.fahrer_id = $1 AND t.datum = CURRENT_DATE
        AND t.status IN ('geplant','aktiv')
      ORDER BY t.startzeit
      LIMIT 1
    `, [userId]);

    if (!tour) return res.json({ tour: null, stopps: [] });

    const { rows: stopps } = await db.query(`
      SELECT s.*,
        e.betrieb_name AS erzeuger_name,
        c.firma_name AS caterer_name
      FROM tour_stopps s
      LEFT JOIN erzeuger e ON e.id = s.erzeuger_id
      LEFT JOIN caterer c ON c.id = s.caterer_id
      WHERE s.tour_id = $1
      ORDER BY s.reihenfolge
    `, [tour.id]);

    res.json({ tour, stopps });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Laden der heutigen Tour' });
  }
});

// ----------------------------------------------------------------
// GET /api/touren/:id – Tour-Detail mit Stopps
// ----------------------------------------------------------------
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows: [tour] } = await db.query(`
      SELECT t.*, u.name AS fahrer_name,
        f.bezeichnung AS fahrzeug_bezeichnung, f.typ AS fahrzeug_typ
      FROM touren t
      LEFT JOIN users u ON u.id = t.fahrer_id
      LEFT JOIN fahrzeuge f ON f.id = t.fahrzeug_id
      WHERE t.id = $1
    `, [req.params.id]);

    if (!tour) return res.status(404).json({ error: 'Tour nicht gefunden' });

    const { rows: stopps } = await db.query(`
      SELECT s.*,
        e.betrieb_name AS erzeuger_name,
        c.firma_name AS caterer_name,
        l.qr_code, l.lieferschein_nr
      FROM tour_stopps s
      LEFT JOIN erzeuger e ON e.id = s.erzeuger_id
      LEFT JOIN caterer c ON c.id = s.caterer_id
      LEFT JOIN lieferungen l ON l.id = s.lieferung_id
      WHERE s.tour_id = $1
      ORDER BY s.reihenfolge
    `, [req.params.id]);

    res.json({ tour, stopps });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Laden der Tour' });
  }
});

// ----------------------------------------------------------------
// POST /api/touren – Neue Tour anlegen (Admin)
// ----------------------------------------------------------------
router.post('/', auth, role('admin'), async (req, res) => {
  const { fahrer_id, fahrzeug_id, datum, typ, startzeit, hub_lat, hub_lng, notiz } = req.body;

  if (!datum || !typ) {
    return res.status(400).json({ error: 'datum und typ erforderlich' });
  }

  try {
    const { rows: [tour] } = await db.query(`
      INSERT INTO touren
        (fahrer_id, fahrzeug_id, datum, typ, startzeit, hub_lat, hub_lng, notiz, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [fahrer_id || null, fahrzeug_id || null, datum, typ,
        startzeit || null, hub_lat || 50.9333, hub_lng || 6.9500,
        notiz || null, req.user.id]);

    res.status(201).json({ tour });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Tour konnte nicht angelegt werden' });
  }
});

// ----------------------------------------------------------------
// PUT /api/touren/:id – Tour aktualisieren (Fahrer, Fahrzeug, etc.)
// ----------------------------------------------------------------
router.put('/:id', auth, role('admin'), async (req, res) => {
  const { fahrer_id, fahrzeug_id, startzeit, notiz, status } = req.body;
  try {
    const { rows: [tour] } = await db.query(`
      UPDATE touren SET
        fahrer_id   = COALESCE($1, fahrer_id),
        fahrzeug_id = COALESCE($2, fahrzeug_id),
        startzeit   = COALESCE($3, startzeit),
        notiz       = COALESCE($4, notiz),
        status      = COALESCE($5, status)
      WHERE id = $6
      RETURNING *
    `, [fahrer_id, fahrzeug_id, startzeit, notiz, status, req.params.id]);

    if (!tour) return res.status(404).json({ error: 'Tour nicht gefunden' });
    res.json({ tour });
  } catch (err) {
    res.status(500).json({ error: 'Update fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// POST /api/touren/:id/stopps – Stopp hinzufügen
// ----------------------------------------------------------------
router.post('/:id/stopps', auth, role('admin'), async (req, res) => {
  const {
    typ, name, adresse, lat, lng,
    erzeuger_id, caterer_id, lieferung_id,
    produkt, menge_geplant_kg,
  } = req.body;

  if (!typ || !name) {
    return res.status(400).json({ error: 'typ und name erforderlich' });
  }

  try {
    // Tour laden für Hub-Koordinaten
    const { rows: [tour] } = await db.query(
      `SELECT hub_lat, hub_lng FROM touren WHERE id = $1`, [req.params.id]
    );
    if (!tour) return res.status(404).json({ error: 'Tour nicht gefunden' });

    // Distanz zum Hub berechnen
    let distanzHubKm = null;
    if (lat != null && lng != null) {
      distanzHubKm = parseFloat(
        haversine(parseFloat(tour.hub_lat), parseFloat(tour.hub_lng),
                  parseFloat(lat), parseFloat(lng)).toFixed(2)
      );
    }

    // Reihenfolge = aktuell größte + 1
    const { rows: [{ max_r }] } = await db.query(
      `SELECT COALESCE(MAX(reihenfolge), 0) AS max_r FROM tour_stopps WHERE tour_id = $1`,
      [req.params.id]
    );

    const { rows: [stopp] } = await db.query(`
      INSERT INTO tour_stopps
        (tour_id, reihenfolge, typ, name, adresse, lat, lng, distanz_hub_km,
         erzeuger_id, caterer_id, lieferung_id, produkt, menge_geplant_kg)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [req.params.id, parseInt(max_r) + 1, typ, name, adresse || null,
        lat || null, lng || null, distanzHubKm,
        erzeuger_id || null, caterer_id || null, lieferung_id || null,
        produkt || null, menge_geplant_kg || null]);

    res.status(201).json({ stopp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stopp konnte nicht hinzugefügt werden' });
  }
});

// ----------------------------------------------------------------
// DELETE /api/touren/:id/stopps/:stoppId – Stopp entfernen
// ----------------------------------------------------------------
router.delete('/:id/stopps/:stoppId', auth, role('admin'), async (req, res) => {
  try {
    await db.query(
      `DELETE FROM tour_stopps WHERE id = $1 AND tour_id = $2`,
      [req.params.stoppId, req.params.id]
    );
    res.json({ message: 'Stopp entfernt' });
  } catch (err) {
    res.status(500).json({ error: 'Löschen fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// POST /api/touren/:id/optimieren – Reihenfolge optimieren (Nearest-Neighbor)
// ----------------------------------------------------------------
router.post('/:id/optimieren', auth, role('admin'), async (req, res) => {
  try {
    const { rows: [tour] } = await db.query(
      `SELECT * FROM touren WHERE id = $1`, [req.params.id]
    );
    if (!tour) return res.status(404).json({ error: 'Tour nicht gefunden' });

    const { rows: stopps } = await db.query(
      `SELECT * FROM tour_stopps WHERE tour_id = $1 ORDER BY reihenfolge`,
      [req.params.id]
    );

    const optimiert = optimiereRoute(stopps, parseFloat(tour.hub_lat), parseFloat(tour.hub_lng));

    // Reihenfolge in DB schreiben
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < optimiert.length; i++) {
        await client.query(
          `UPDATE tour_stopps SET reihenfolge = $1 WHERE id = $2`,
          [i + 1, optimiert[i].id]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // E-Lastenrad Check: Alle Stopps ≤ 5km vom Hub?
    const alleInRadius = optimiert.every(s =>
      s.lat == null || s.distanz_hub_km == null || parseFloat(s.distanz_hub_km) <= 5
    );

    res.json({
      stopps:          optimiert.map((s, i) => ({ ...s, reihenfolge: i + 1 })),
      e_lastenrad_ok:  alleInRadius,
      message:         `Route optimiert. ${alleInRadius ? '✓ E-Lastenrad geeignet (alle Stopps ≤ 5km).' : 'Stopps außerhalb 5km Radius – Transporter/LKW empfohlen.'}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Optimierung fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// POST /api/touren/:id/starten – Fahrer startet Tour
// ----------------------------------------------------------------
router.post('/:id/starten', auth, role('fahrer', 'admin'), async (req, res) => {
  try {
    const { rows: [tour] } = await db.query(`
      UPDATE touren SET status = 'aktiv', gestartet_at = NOW()
      WHERE id = $1 AND (fahrer_id = $2 OR $3 = 'admin')
      RETURNING *
    `, [req.params.id, req.user.id, req.user.role]);

    if (!tour) return res.status(404).json({ error: 'Tour nicht gefunden oder keine Berechtigung' });
    res.json({ tour });
  } catch (err) {
    res.status(500).json({ error: 'Tour konnte nicht gestartet werden' });
  }
});

// ----------------------------------------------------------------
// POST /api/touren/:id/stopps/:stoppId/ankommen – Fahrer kommt an
// ----------------------------------------------------------------
router.post('/:id/stopps/:stoppId/ankommen', auth, role('fahrer', 'admin'), async (req, res) => {
  try {
    const { rows: [stopp] } = await db.query(`
      UPDATE tour_stopps
      SET status = 'angekommen', ankunft_at = NOW()
      WHERE id = $1 AND tour_id = $2
      RETURNING *
    `, [req.params.stoppId, req.params.id]);

    if (!stopp) return res.status(404).json({ error: 'Stopp nicht gefunden' });
    res.json({ stopp });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ----------------------------------------------------------------
// POST /api/touren/:id/stopps/:stoppId/abschliessen
// Fahrer bestätigt Stopp erledigt
// Bei Auslieferungs-Stopps: triggert Wareneingang + Lagerbuchung
// ----------------------------------------------------------------
router.post('/:id/stopps/:stoppId/abschliessen', auth, role('fahrer', 'admin'), async (req, res) => {
  const { menge_bestaetigt_kg, qualitaet = 'A', notiz } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [stopp] } = await client.query(`
      SELECT s.*, t.hub_lat, t.hub_lng
      FROM tour_stopps s
      JOIN touren t ON t.id = s.tour_id
      WHERE s.id = $1 AND s.tour_id = $2
    `, [req.params.stoppId, req.params.id]);

    if (!stopp) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Stopp nicht gefunden' });
    }

    const menge = parseFloat(menge_bestaetigt_kg || stopp.menge_geplant_kg || 0);

    // Stopp als abgeschlossen markieren
    await client.query(`
      UPDATE tour_stopps SET
        status               = 'abgeschlossen',
        abschluss_at         = NOW(),
        menge_bestaetigt_kg  = $1,
        qualitaet            = $2,
        fahrer_notiz         = $3
      WHERE id = $4
    `, [menge, qualitaet, notiz || null, stopp.id]);

    await client.query('COMMIT');

    let wareneingangResult = null;

    // Bei Auslieferung: Wareneingang im Backend bestätigen
    if (stopp.typ === 'auslieferung' && stopp.lieferung_id && menge > 0) {
      try {
        // Lieferschein-Hash generieren
        const crypto = require('crypto');
        const lieferscheinHash = '0x' + crypto
          .createHash('sha256')
          .update(stopp.lieferung_id + menge)
          .digest('hex').slice(0, 64);

        // Lieferung als eingegangen markieren
        const dbDirect = require('../db');
        await dbDirect.query(`
          UPDATE lieferungen SET
            menge_geliefert = $1, qualitaet = $2, status = 'eingegangen',
            wareneingang_at = NOW(), notiz = $3, lieferschein_hash = $4
          WHERE id = $5 AND status != 'eingegangen'
        `, [menge, qualitaet, notiz || `Bestätigt von Fahrer (Tour)`, lieferscheinHash, stopp.lieferung_id]);

        // Lager-Ausgang buchen (Ware verlässt Lager)
        if (stopp.produkt) {
          try {
            const { rows: [lager] } = await dbDirect.query(
              `SELECT id, bestand FROM lager_positionen WHERE produkt = $1 LIMIT 1`,
              [stopp.produkt]
            );
            if (lager && parseFloat(lager.bestand) >= menge) {
              await dbDirect.query(
                `UPDATE lager_positionen SET bestand = bestand - $1 WHERE id = $2`,
                [menge, lager.id]
              );
              await dbDirect.query(`
                INSERT INTO lager_bewegungen
                  (lager_id, typ, menge, bestand_nach, lieferung_id, abnehmer_ref, notiz, erstellt_von)
                VALUES ($1, 'ausgang', $2,
                  (SELECT bestand FROM lager_positionen WHERE id = $1),
                  $3, $4, $5, $6)
              `, [lager.id, menge, stopp.lieferung_id,
                  stopp.name, `Auslieferung Tour #${req.params.id.slice(0,8)}`, req.user.id]);
            }
          } catch (lagerErr) {
            console.warn('Lager-Ausgang konnte nicht gebucht werden:', lagerErr.message);
          }
        }

        // Auszahlungen berechnen
        const { payouts } = await calculateAndCreatePayouts(stopp.lieferung_id);
        wareneingangResult = { auszahlungen: payouts.length };
      } catch (wiErr) {
        console.warn('Wareneingang-Trigger fehlgeschlagen:', wiErr.message);
      }
    }

    // Tour abschließen wenn alle Stopps erledigt
    const { rows: [{ offen }] } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE status IN ('ausstehend','angekommen')) AS offen
      FROM tour_stopps WHERE tour_id = $1
    `, [req.params.id]);

    let tourStatus = null;
    if (parseInt(offen) === 0) {
      await db.query(`
        UPDATE touren SET status = 'abgeschlossen', abgeschlossen_at = NOW() WHERE id = $1
      `, [req.params.id]);
      tourStatus = 'abgeschlossen';
    }

    res.json({
      stopp:            { ...stopp, status: 'abgeschlossen', menge_bestaetigt_kg: menge },
      wareneingang:     wareneingangResult,
      tour_abgeschlossen: tourStatus === 'abgeschlossen',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Abschluss fehlgeschlagen' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// POST /api/touren/:id/stopps/:stoppId/ueberspringen
// ----------------------------------------------------------------
router.post('/:id/stopps/:stoppId/ueberspringen', auth, role('fahrer', 'admin'), async (req, res) => {
  const { notiz } = req.body;
  try {
    await db.query(`
      UPDATE tour_stopps SET status = 'uebersprungen', fahrer_notiz = $1, abschluss_at = NOW()
      WHERE id = $2 AND tour_id = $3
    `, [notiz || null, req.params.stoppId, req.params.id]);
    res.json({ message: 'Stopp übersprungen' });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ----------------------------------------------------------------
// GET /api/touren/fahrer/liste – alle Fahrer für Dropdown (Admin)
// ----------------------------------------------------------------
router.get('/fahrer/liste', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.name, u.email,
        fp.telefon, fp.fuehrerschein
      FROM users u
      LEFT JOIN fahrer_profile fp ON fp.user_id = u.id
      WHERE u.role = 'fahrer'
      ORDER BY u.name
    `);
    res.json({ fahrer: rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Fahrer' });
  }
});

module.exports = router;
