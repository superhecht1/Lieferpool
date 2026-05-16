/**
 * tracking.js – Fahrer GPS Live-Tracking
 *
 * POST /api/tracking/position       – Fahrer sendet Position
 * GET  /api/tracking/positions      – Admin sieht alle aktiven Fahrer
 * GET  /api/tracking/trail/:id      – Breadcrumb-Trail eines Fahrers
 * POST /api/tracking/offline        – Fahrer meldet sich offline
 */

const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

// POST /api/tracking/position – Fahrer sendet GPS
router.post('/position', auth, role('fahrer'), async (req, res) => {
  const { lat, lon, speed_kmh, heading, accuracy_m, tour_id } = req.body;
  if (!lat || !lon) return res.status(400).json({ error: 'lat/lon erforderlich' });

  try {
    // Verlaufs-Tabelle (letzten 8h, danach per Cron löschen)
    await db.query(`
      INSERT INTO fahrer_position (fahrer_id, tour_id, lat, lon, speed_kmh, heading, accuracy_m)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [req.user.id, tour_id||null, lat, lon,
        speed_kmh||null, heading||null, accuracy_m||null]);

    // Live-Position upsert
    await db.query(`
      INSERT INTO fahrer_position_live (fahrer_id, tour_id, lat, lon, speed_kmh, heading, accuracy_m, online, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
      ON CONFLICT (fahrer_id) DO UPDATE SET
        tour_id    = EXCLUDED.tour_id,
        lat        = EXCLUDED.lat,
        lon        = EXCLUDED.lon,
        speed_kmh  = EXCLUDED.speed_kmh,
        heading    = EXCLUDED.heading,
        accuracy_m = EXCLUDED.accuracy_m,
        online     = TRUE,
        updated_at = NOW()
    `, [req.user.id, tour_id||null, lat, lon,
        speed_kmh||null, heading||null, accuracy_m||null]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[tracking]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tracking/offline – Fahrer offline melden
router.post('/offline', auth, role('fahrer'), async (req, res) => {
  try {
    await db.query(
      `UPDATE fahrer_position_live SET online=FALSE WHERE fahrer_id=$1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tracking/positions – Admin: alle aktiven Fahrer mit letzter Position
router.get('/positions', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        fl.fahrer_id, fl.lat, fl.lon, fl.speed_kmh, fl.heading,
        fl.online, fl.updated_at,
        u.name AS fahrer_name, u.email,
        t.typ AS tour_typ, t.status AS tour_status, t.datum AS tour_datum,
        -- Aktueller Stopp
        s.name AS stopp_name, s.adresse AS stopp_adresse,
        s.reihenfolge AS stopp_nr, s.status AS stopp_status,
        -- Fortschritt
        (SELECT COUNT(*)::int FROM tour_stopps WHERE tour_id=fl.tour_id) AS stopps_gesamt,
        (SELECT COUNT(*)::int FROM tour_stopps WHERE tour_id=fl.tour_id AND status='abgeschlossen') AS stopps_done
      FROM fahrer_position_live fl
      JOIN users u ON u.id = fl.fahrer_id
      LEFT JOIN touren t ON t.id = fl.tour_id
      LEFT JOIN tour_stopps s ON s.tour_id = fl.tour_id
        AND s.status = 'ausstehend'
        AND s.reihenfolge = (
          SELECT MIN(reihenfolge) FROM tour_stopps
          WHERE tour_id = fl.tour_id AND status = 'ausstehend'
        )
      WHERE fl.updated_at > NOW() - INTERVAL '2 hours'
      ORDER BY fl.updated_at DESC
    `);

    // Sekunden seit letztem Update
    const now = Date.now();
    const positions = rows.map(r => ({
      ...r,
      sekunden_her: Math.round((now - new Date(r.updated_at).getTime()) / 1000),
      ist_aktiv: (now - new Date(r.updated_at).getTime()) < 5 * 60 * 1000, // < 5 Min
    }));

    res.json({ positions });
  } catch (err) {
    console.error('[tracking positions]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/trail/:fahrerId – Breadcrumb-Trail letzte 2h
router.get('/trail/:fahrerId', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT lat, lon, speed_kmh, created_at
      FROM fahrer_position
      WHERE fahrer_id = $1 AND created_at > NOW() - INTERVAL '2 hours'
      ORDER BY created_at ASC
    `, [req.params.fahrerId]);
    res.json({ trail: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
