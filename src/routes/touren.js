const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

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
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows: [tour] } = await db.query(`
      SELECT t.*, u.name AS fahrer_name, f.bezeichnung AS fahrzeug_bezeichnung
      FROM touren t
      LEFT JOIN users u ON u.id = t.fahrer_id
      LEFT JOIN fahrzeuge f ON f.id = t.fahrzeug_id
      WHERE t.id = $1
    `, [req.params.id]);
    if (!tour) return res.status(404).json({ error: 'Tour nicht gefunden' });

    const { rows: stopps } = await db.query(
      `SELECT * FROM tour_stopps WHERE tour_id = $1 ORDER BY reihenfolge`,
      [req.params.id]
    );
    res.json({ tour, stopps });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/touren
router.post('/', auth, role('admin'), async (req, res) => {
  const { datum, typ, fahrer_id, fahrzeug_id, startzeit, notiz } = req.body;
  if (!datum || !typ) return res.status(400).json({ error: 'datum und typ erforderlich' });
  try {
    const { rows: [tour] } = await db.query(`
      INSERT INTO touren (datum, typ, fahrer_id, fahrzeug_id, startzeit, notiz, status)
      VALUES ($1,$2,$3,$4,$5,$6,'geplant') RETURNING *
    `, [datum, typ, fahrer_id||null, fahrzeug_id||null, startzeit||null, notiz||null]);

    // Push-Benachrichtigung an Fahrer bei Zuweisung
    if (fahrer_id) {
      await sendPushToFahrer(fahrer_id, {
        title: '🚚 Neue Tour zugewiesen',
        body:  `${typ === 'abholung' ? 'Abholung' : typ === 'auslieferung' ? 'Auslieferung' : 'Tour'} · ${datum} ${startzeit ? '· ' + startzeit.slice(0,5) + ' Uhr' : ''}`,
        icon:  '/icon-192.png',
        data:  { url: '/fahrer', tourId: tour.id },
        tag:   'tour-' + tour.id,
      });
    }

    res.status(201).json({ tour });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Tour konnte nicht erstellt werden' });
  }
});

// PUT /api/touren/:id – Tour aktualisieren (inkl. Fahrer-Zuweisung mit Push)
router.put('/:id', auth, role('admin'), async (req, res) => {
  const { datum, typ, fahrer_id, fahrzeug_id, startzeit, notiz, status } = req.body;
  try {
    const { rows: [old] } = await db.query(`SELECT fahrer_id FROM touren WHERE id=$1`,[req.params.id]);
    const { rows: [tour] } = await db.query(`
      UPDATE touren SET
        datum       = COALESCE($1, datum),
        typ         = COALESCE($2, typ),
        fahrer_id   = COALESCE($3, fahrer_id),
        fahrzeug_id = COALESCE($4, fahrzeug_id),
        startzeit   = COALESCE($5, startzeit),
        notiz       = COALESCE($6, notiz),
        status      = COALESCE($7, status)
      WHERE id = $8 RETURNING *
    `, [datum, typ, fahrer_id, fahrzeug_id, startzeit, notiz, status, req.params.id]);

    // Push wenn Fahrer neu zugewiesen wurde
    if (fahrer_id && fahrer_id !== old?.fahrer_id) {
      await sendPushToFahrer(fahrer_id, {
        title: '🚚 Tour zugewiesen',
        body:  `${tour.typ} · ${tour.datum}${tour.startzeit ? ' · ' + tour.startzeit.slice(0,5) + ' Uhr' : ''}`,
        data:  { url: '/fahrer', tourId: tour.id },
        tag:   'tour-' + tour.id,
      });
    }

    res.json({ tour });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/touren/:id/stopps
router.post('/:id/stopps', auth, role('admin'), async (req, res) => {
  const { typ, name, adresse, produkt, menge_geplant_kg, lat, lon } = req.body;
  if (!name) return res.status(400).json({ error: 'name erforderlich' });
  try {
    const { rows: [maxRow] } = await db.query(
      `SELECT COALESCE(MAX(reihenfolge),0) AS max FROM tour_stopps WHERE tour_id=$1`,
      [req.params.id]
    );
    let distanz = null;
    if (lat && lon) {
      const HUB_LAT = parseFloat(process.env.HUB_LAT || '50.9245');
      const HUB_LON = parseFloat(process.env.HUB_LON || '6.9195');
      distanz = Math.round(haversineKm(HUB_LAT, HUB_LON, lat, lon) * 10) / 10;
    }
    const { rows: [stopp] } = await db.query(`
      INSERT INTO tour_stopps (tour_id, typ, name, adresse, produkt, menge_geplant_kg, reihenfolge, status, distanz_hub_km)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'ausstehend',$8) RETURNING *
    `, [req.params.id, typ||'auslieferung', name, adresse||null, produkt||null,
        menge_geplant_kg||null, maxRow.max+1, distanz]);
    res.status(201).json({ stopp });
  } catch (err) {
    res.status(500).json({ error: 'Stopp konnte nicht hinzugefügt werden' });
  }
});

// DELETE /api/touren/:id/stopps/:sid
router.delete('/:id/stopps/:sid', auth, role('admin'), async (req, res) => {
  try {
    await db.query(`DELETE FROM tour_stopps WHERE id=$1 AND tour_id=$2`,[req.params.sid, req.params.id]);
    res.json({ message: 'Stopp gelöscht' });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/touren/:id/starten
router.post('/:id/starten', auth, async (req, res) => {
  try {
    const { rows: [t] } = await db.query(
      `UPDATE touren SET status='gestartet', gestartet_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json({ tour: t });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/touren/:id/optimieren
router.post('/:id/optimieren', auth, role('admin'), async (req, res) => {
  try {
    const { rows: stopps } = await db.query(
      `SELECT * FROM tour_stopps WHERE tour_id=$1 AND status='ausstehend' ORDER BY reihenfolge`,
      [req.params.id]
    );
    if (stopps.length < 2) return res.json({ message: 'Weniger als 2 Stopps – keine Optimierung nötig' });

    // Nearest-Neighbor von Hub aus
    const HUB_LAT = parseFloat(process.env.HUB_LAT || '50.9245');
    const HUB_LON = parseFloat(process.env.HUB_LON || '6.9195');
    const withCoords = stopps.filter(s => s.lat && s.lon);
    if (withCoords.length < 2) return res.json({ message: 'Nicht genug Koordinaten für Optimierung', e_lastenrad_ok: false });

    let remaining = [...withCoords];
    const ordered = [];
    let curLat = HUB_LAT, curLon = HUB_LON;
    while (remaining.length) {
      let nearest = remaining.reduce((best, s) => {
        const d = haversineKm(curLat, curLon, s.lat, s.lon);
        return d < best.dist ? { stopp: s, dist: d } : best;
      }, { stopp: null, dist: Infinity });
      ordered.push(nearest.stopp);
      remaining = remaining.filter(s => s.id !== nearest.stopp.id);
      curLat = nearest.stopp.lat; curLon = nearest.stopp.lon;
    }

    for (let i = 0; i < ordered.length; i++) {
      await db.query(`UPDATE tour_stopps SET reihenfolge=$1 WHERE id=$2`,[i+1, ordered[i].id]);
    }

    const maxDist = Math.max(...ordered.map(s => haversineKm(HUB_LAT, HUB_LON, s.lat, s.lon)));
    const eLastenrad = maxDist <= 5;
    res.json({ message: `${ordered.length} Stopps optimiert${eLastenrad ? ' · E-Lastenrad möglich (≤5km)' : ''}`, e_lastenrad_ok: eLastenrad });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/touren/:id/stopps/:sid/ankommen
router.post('/:id/stopps/:sid/ankommen', auth, async (req, res) => {
  try {
    const { rows: [s] } = await db.query(
      `UPDATE tour_stopps SET angekommen_at=NOW() WHERE id=$1 AND tour_id=$2 RETURNING *`,
      [req.params.sid, req.params.id]
    );
    res.json({ stopp: s });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/touren/:id/stopps/:sid/abschliessen – mit Foto
router.post('/:id/stopps/:sid/abschliessen', auth, async (req, res) => {
  const { menge_geladen_kg, notiz, foto_base64 } = req.body;

  // Foto auf max 1MB begrenzen
  const fotoData = foto_base64 && foto_base64.length < 1400000 ? foto_base64 : null;

  try {
    const { rows: [s] } = await db.query(`
      UPDATE tour_stopps SET
        status          = 'abgeschlossen',
        abgeschlossen_at = NOW(),
        menge_geladen_kg = COALESCE($1, menge_geladen_kg),
        notiz_abschluss  = COALESCE($2, notiz_abschluss),
        foto_base64      = COALESCE($3, foto_base64)
      WHERE id=$4 AND tour_id=$5 RETURNING id,status,menge_geladen_kg,notiz_abschluss,abgeschlossen_at
    `, [menge_geladen_kg||null, notiz||null, fotoData, req.params.sid, req.params.id]);

    if (!s) return res.status(404).json({ error: 'Stopp nicht gefunden' });

    // Prüfen ob alle Stopps erledigt → Tour abschließen
    const { rows: [count] } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE status='ausstehend')::int AS offen
      FROM tour_stopps WHERE tour_id=$1
    `, [req.params.id]);
    if (count.offen === 0) {
      await db.query(`UPDATE touren SET status='abgeschlossen' WHERE id=$1`,[req.params.id]);
    }

    res.json({ stopp: s });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler beim Abschließen' });
  }
});

// POST /api/touren/:id/stopps/:sid/ueberspringen
router.post('/:id/stopps/:sid/ueberspringen', auth, async (req, res) => {
  const { notiz } = req.body;
  try {
    const { rows: [s] } = await db.query(`
      UPDATE tour_stopps SET status='uebersprungen', notiz_abschluss=$1
      WHERE id=$2 AND tour_id=$3 RETURNING *
    `, [notiz||null, req.params.sid, req.params.id]);
    res.json({ stopp: s });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

module.exports = router;
