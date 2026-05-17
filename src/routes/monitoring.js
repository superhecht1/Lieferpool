/**
 * Monitoring & Health-Check für FrischKette
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /health – Öffentlicher Health-Check (für Render.com)
router.get('/health', async (req, res) => {
  const start = Date.now();
  try {
    await db.query('SELECT 1');
    res.json({
      status:  'ok',
      db:      'ok',
      uptime:  Math.round(process.uptime()),
      ms:      Date.now() - start,
      ts:      new Date().toISOString(),
    });
  } catch(err) {
    res.status(503).json({ status:'error', db:'error', error: err.message });
  }
});

// GET /api/monitoring/stats – Interne Statistiken (Admin)
const { auth, role } = require('../middleware/auth');
router.get('/stats', auth, role('admin'), async (req, res) => {
  try {
    const [pools, erzeuger, caterer, lieferungen, touren, errors] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='offen')::int AS offen, COUNT(*) FILTER (WHERE status='geschlossen')::int AS geschlossen FROM pools`),
      db.query(`SELECT COUNT(*)::int AS total FROM erzeuger`),
      db.query(`SELECT COUNT(*)::int AS total FROM caterer`),
      db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='erstellt')::int AS offen FROM lieferungen`),
      db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='aktiv')::int AS aktiv FROM touren WHERE datum >= CURRENT_DATE`),
      db.query(`SELECT COUNT(*)::int AS total FROM audit_log WHERE action LIKE 'error.%' AND created_at > NOW() - INTERVAL '24 hours'`),
    ]);

    res.json({
      ts:         new Date().toISOString(),
      uptime:     Math.round(process.uptime()),
      memory:     process.memoryUsage().heapUsed,
      pools:      pools.rows[0],
      erzeuger:   erzeuger.rows[0],
      caterer:    caterer.rows[0],
      lieferungen:lieferungen.rows[0],
      touren:     touren.rows[0],
      errors_24h: errors.rows[0].total,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Cron: Täglicher Status-Check + Alert bei Problemen
async function dailyCheck() {
  try {
    const logger = require('../services/logger');
    const { rows:[stats] } = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM pools WHERE status='offen' AND deadline < NOW())::int AS abgelaufene_pools,
        (SELECT COUNT(*) FROM lieferungen WHERE status='erstellt' AND created_at < NOW()-INTERVAL '7 days')::int AS alte_lieferscheine,
        (SELECT COALESCE(SUM(pfand_offen),0)::numeric(10,2) FROM lieferungen WHERE pfand_kisten_geliefert > pfand_kisten_zurueck) AS pfand_offen
    `);

    logger.info('Daily Health Check', stats);

    // Alert wenn kritische Werte
    if (stats.abgelaufene_pools > 0 || stats.alte_lieferscheine > 5) {
      const email = require('../services/email');
      await email.send({
        to: { email: process.env.ADMIN_EMAIL, name: 'FrischKette Admin' },
        subject: '⚠ FrischKette Tagescheck — Handlungsbedarf',
        html: `<h2>Tagescheck FrischKette</h2>
          <ul>
            <li>Abgelaufene Pools: <strong>${stats.abgelaufene_pools}</strong></li>
            <li>Alte offene Lieferscheine (>7 Tage): <strong>${stats.alte_lieferscheine}</strong></li>
            <li>Offenes Pfand: <strong>${stats.pfand_offen} €</strong></li>
          </ul>
          <a href="${process.env.APP_URL}/admin">Zum Admin-Dashboard</a>`,
      }).catch(()=>{});
    }
  } catch(err) {
    require('../services/logger').error('Daily check failed', { error: err.message });
  }
}

module.exports = { router, dailyCheck };
