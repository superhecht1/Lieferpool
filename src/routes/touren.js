const express = require('express');
const db      = require('../db');
const { auth, role }   = require('../middleware/auth');
const { validateBase64Upload } = require('../middleware/upload-validate');

const router = express.Router();

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function sendPushToFahrer(fahrerId, payload) {
  try {
    const push = require('../services/push');
    await push.sendToUser(db, fahrerId, payload);
  } catch (err) {
    console.warn('[push]', err.message);
  }
}

// GET /api/touren/fahrer/liste ← muss VOR /:id stehen
router.get('/fahrer/liste', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const tableCheck = await db.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='fahrer_profile') AS exists`
    );
    if (!tableCheck.rows[0].exists) return res.json({ fahrer: [] });

    // Prüfen ob touren.fahrer_id existiert
    const colCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name='touren' AND column_name='fahrer_id'
      ) AS exists
    `).catch(() => ({ rows: [{ exists: false }] }));

    let rows;
    if (colCheck.rows[0].exists) {
      ({ rows } = await db.query(`
        SELECT u.id, u.name, u.email,
          fp.lizenzklasse, fp.aktiv,
          COUNT(DISTINCT t.id)::int AS touren_heute
        FROM users u
        JOIN fahrer_profile fp ON fp.user_id = u.id
        LEFT JOIN touren t ON t.fahrer_id = u.id AND t.datum = CURRENT_DATE
        WHERE u.role = 'fahrer' AND fp.aktiv = TRUE
        GROUP BY u.id, u.name, u.email, fp.lizenzklasse, fp.aktiv
        ORDER BY u.name
      `));
    } else {
      ({ rows } = await db.query(`
        SELECT u.id, u.name, u.email, fp.lizenzklasse, fp.aktiv, 0 AS touren_heute
        FROM users u
        JOIN fahrer_profile fp ON fp.user_id = u.id
        WHERE u.role = 'fahrer' AND fp.aktiv = TRUE
        ORDER BY u.name
      `));
    }
    res.json({ fahrer: rows });
  } catch (err) {
    console.error('[fahrer/liste]', err.message);
    res.json({ fahrer: [] }); // Nie 500 – immer leere Liste zurückgeben
  }
});

// GET /api/touren
router.get('/', auth, async (req, res) => {
  try {
    const { datum, fahrer_id, status, page = 1, limit = 20 } = req.query;
    const params  = [];
    const filters = [];

    if (datum)     { params.push(datum);     filters.push(`t.datum = $${params.length}`); }
    if (fahrer_id) { params.push(fahrer_id); filters.push(`t.fahrer_id = $${params.length}`); }
    if (status)    { params.push(status);    filters.push(`t.status = $${params.length}`); }

    // Fahrer sehen nur ihre eigenen Touren
    if (req.user.role === 'fahrer') {
      params.push(req.user.id);
      filters.push(`t.fahrer_id = $${params.length}`);
    }

    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
    params.push(parseInt(limit), (parseInt(page)-1)*parseInt(limit));

    const { rows } = await db.query(`
      SELECT t.*,
        u.name AS fahrer_name,
        f.bezeichnung AS fahrzeug_bezeichnung,
        COUNT(s.id)::int AS stopp_anzahl,
        COUNT(s.id) FILTER (WHERE s.status IN ('abgeschlossen','uebersprungen'))::int AS stopps_done
      FROM touren t
      LEFT JOIN users u ON u.id = t.fahrer_id
      LEFT JOIN fahrzeuge f ON f.id = t.fahrzeug_id
      LEFT JOIN tour_stopps s ON s.tour_id = t.id
      ${where}
      GROUP BY t.id, u.name, f.bezeichnung
      ORDER BY t.datum DESC, t.startzeit ASC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);

    res.json({ touren: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Touren konnten nicht geladen werden' });
  }
});

// GET /api/touren/:id
// BUG FIX #1: Vorher wurde fp.id (fahrer_profile) statt user.id verwendet
// touren.fahrer_id referenziert users.id – nicht fahrer_profile.id
router.get('/meine', auth, role('fahrer'), async (req, res) => {
  try {
    const datum = req.query.datum || new Date().toISOString().slice(0,10);

    const { rows } = await db.query(`
      SELECT t.*, f.bezeichnung AS fahrzeug_bezeichnung,
        COUNT(ts.id)::int AS stopps_total,
        COUNT(ts.id) FILTER (WHERE ts.status IN ('abgeschlossen','uebersprungen'))::int AS stopps_erledigt
      FROM touren t
      LEFT JOIN fahrzeuge f ON f.id = t.fahrzeug_id
      LEFT JOIN tour_stopps ts ON ts.tour_id = t.id
      WHERE t.fahrer_id = $1 AND t.datum = $2
      GROUP BY t.id, f.bezeichnung
      ORDER BY t.startzeit
    `, [req.user.id, datum]);

    res.json({ touren: rows });
  } catch (err) { console.error(err); res.json({ touren: [] }); }
});

// GET /api/touren/meine/alle – Tourhistorie Fahrer
router.get('/meine/alle', auth, role('fahrer'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const { rows:[fp] } = await db.query(`SELECT id FROM fahrer_profile WHERE user_id=$1`, [req.user.id]);
    if (!fp) return res.json({ touren: [] });

    const { rows } = await db.query(`
      SELECT t.*, f.bezeichnung AS fahrzeug_bezeichnung,
        COUNT(ts.id)::int                                                 AS stopps_total,
        COUNT(ts.id) FILTER (WHERE ts.status IN ('abgeschlossen','uebersprungen'))::int AS stopps_erledigt
      FROM touren t
      LEFT JOIN fahrzeuge f ON f.id = t.fahrzeug_id
      LEFT JOIN tour_stopps ts ON ts.tour_id = t.id
      WHERE t.fahrer_id = $1
      GROUP BY t.id, f.bezeichnung
      ORDER BY t.datum DESC, t.startzeit DESC
      LIMIT $2
    `, [req.user.id, limit]); // FIX: req.user.id

    res.json({ touren: rows });
  } catch (err) { console.error(err); res.json({ touren: [] }); }
});

// POST /api/touren/:id/stopps/:stoppId/bestaetigen
router.post('/:id/stopps/:stoppId/bestaetigen', auth, role('fahrer'), async (req, res) => {
  const { menge_geliefert, notiz, foto } = req.body;
  try {
    await db.query(`
      UPDATE tour_stopps SET
        status         = 'abgeschlossen',
        menge_geliefert= $1,
        notiz          = COALESCE($2, notiz),
        foto_base64    = COALESCE($3, foto_base64),
        bestaetigt_at  = NOW()
      WHERE id=$4 AND tour_id=$5
    `, [menge_geliefert || null, notiz || null, foto || null, req.params.stoppId, req.params.id]);

    // Lieferschein-Status aktualisieren falls vorhanden
    await db.query(`
      UPDATE lieferungen SET status='eingegangen', wareneingang_at=NOW()
      WHERE id=(SELECT lieferung_id FROM tour_stopps WHERE id=$1)
      AND status NOT IN ('abgeschlossen','storniert')
    `, [req.params.stoppId]).catch(()=>{});

    res.json({ message: 'Stopp bestätigt' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/touren/:id/stopps/:stoppId/ueberspringen
router.post('/:id/stopps/:stoppId/ueberspringen', auth, role('fahrer'), async (req, res) => {
  const { grund } = req.body;
  try {
    await db.query(`
      UPDATE tour_stopps SET status='uebersprungen', notiz=$1
      WHERE id=$2 AND tour_id=$3
    `, [grund || null, req.params.stoppId, req.params.id]);
    res.json({ message: 'Stopp übersprungen' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/touren/:id – Tour mit Stopps für Fahrer
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows:[tour] } = await db.query(`
      SELECT t.*, f.bezeichnung AS fahrzeug_bezeichnung
      FROM touren t
      LEFT JOIN fahrzeuge f ON f.id=t.fahrzeug_id
      WHERE t.id=$1
    `, [req.params.id]);
    if (!tour) return res.status(404).json({ error: 'Tour nicht gefunden' });

    let stopps = [];
    if (req.query.stopps === 'true') {
      const { rows } = await db.query(`
        SELECT ts.*,
          e.betrieb_name AS erzeuger_name,
          c.firma_name   AS caterer_name,
          l.lieferschein_nr, l.qr_code
        FROM tour_stopps ts
        LEFT JOIN erzeuger e ON e.id = ts.erzeuger_id
        LEFT JOIN caterer  c ON c.id = ts.caterer_id
        LEFT JOIN lieferungen l ON l.id = ts.lieferung_id
        WHERE ts.tour_id=$1
        ORDER BY ts.reihenfolge
      `, [req.params.id]);
      stopps = rows;
    }

    res.json({ tour, stopps });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});


module.exports = router;

// Helper: Push senden wenn Tour einem Fahrer zugewiesen wird
async function sendTourPush(tourId, db) {
  try {
    const { rows:[tour] } = await db.query(
      `SELECT t.name, t.datum, t.startzeit, t.fahrer_id
       FROM touren t WHERE t.id=$1`, [tourId]
    );
    if (!tour?.fahrer_id) return;
    const push = require('../services/push');
    await push.sendToUser(tour.fahrer_id, {
      title: '🚲 Neue Tour zugewiesen',
      body:  `${tour.name||'Tour'} · ${tour.datum||''} · ${(tour.startzeit||'').slice(0,5)} Uhr`,
      url:   '/fahrer',
      tag:   'neue-tour',
    });
  } catch {}
}
