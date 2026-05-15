/**
 * audit.js – Audit-Log Middleware
 *
 * Verwendung:
 *   const { auditLog, ACTIONS } = require('../middleware/audit');
 *   router.put('/:id/status', auth, role('admin'), auditLog(ACTIONS.AUSZAHLUNG_VERANLASST), async (req, res) => {...})
 */

const db = require('../db');

const ACTIONS = {
  // Auth
  LOGIN:                    'auth.login',
  LOGIN_FAILED:             'auth.login_failed',
  LOGOUT:                   'auth.logout',
  PASSWORD_CHANGED:         'auth.password_changed',
  REGISTER:                 'auth.register',

  // Zertifikate
  ZERT_EINGEREICHT:         'zertifikat.eingereicht',
  ZERT_VERIFIZIERT:         'zertifikat.verifiziert',
  ZERT_ABGELEHNT:           'zertifikat.abgelehnt',

  // Pools
  POOL_ERSTELLT:            'pool.erstellt',
  POOL_GESCHLOSSEN:         'pool.geschlossen',
  POOL_ABGEBROCHEN:         'pool.abgebrochen',
  POOL_DEADLINE_GEAENDERT:  'pool.deadline_geaendert',

  // Commitments
  COMMITMENT_ERSTELLT:      'commitment.erstellt',
  COMMITMENT_ZURUECKGEZOGEN:'commitment.zurueckgezogen',

  // Auszahlungen
  AUSZAHLUNG_VERANLASST:    'auszahlung.veranlasst',
  AUSZAHLUNG_AUSGEZAHLT:    'auszahlung.ausgezahlt',
  BULK_VERANLASST:          'auszahlung.bulk_veranlasst',
  SEPA_EXPORT:              'auszahlung.sepa_export',

  // Lieferungen
  LIEFERSCHEIN_ERSTELLT:    'lieferung.lieferschein_erstellt',
  WARENEINGANG_BESTAETIGT:  'lieferung.wareneingang',

  // Admin
  FAHRER_ERSTELLT:          'admin.fahrer_erstellt',
  ADMIN_SETUP:              'admin.setup',
};

/**
 * Direkter Log-Eintrag (für explizite Aufrufe in Route-Handlern)
 */
async function log(req, action, entityType, entityId, details = {}) {
  try {
    const userId = req.user?.id || null;
    const ip     = req.ip || req.connection?.remoteAddress || null;
    const ua     = req.headers['user-agent']?.slice(0, 300) || null;

    await db.query(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [userId, action, entityType || null, entityId ? String(entityId) : null,
        JSON.stringify(details), ip, ua]);
  } catch (err) {
    // Audit-Log-Fehler nie nach oben propagieren
    console.error('[audit] Fehler:', err.message);
  }
}

/**
 * Middleware Factory: loggt nach erfolgreicher Response
 */
function auditLog(action, getDetails) {
  return (req, res, next) => {
    const origJson = res.json.bind(res);
    res.json = (data) => {
      // Nur bei Erfolg loggen
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const entityId = req.params.id || data?.pool?.id || data?.lieferung?.id ||
                        data?.commitment?.id || data?.auszahlung?.id || null;
        const details  = getDetails ? getDetails(req, data) : {};
        log(req, action, null, entityId, details).catch(() => {});
      }
      return origJson(data);
    };
    next();
  };
}

/**
 * GET /api/audit – Admin kann Audit-Log einsehen
 */
const express = require('express');
const { auth, role } = require('./auth');
const router  = express.Router();

router.get('/', auth, role('admin'), async (req, res) => {
  try {
    const { action, limit = 100, page = 1 } = req.query;
    const params  = [parseInt(limit), (parseInt(page)-1)*parseInt(limit)];
    const filters = [];
    if (action) { params.push(action); filters.push(`al.action = $${params.length}`); }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT al.*, u.email, u.name, u.role
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      ${where}
      ORDER BY al.created_at DESC
      LIMIT $1 OFFSET $2
    `, params);

    const { rows: [count] } = await db.query(
      `SELECT COUNT(*) FROM audit_log ${where}`, params.slice(2)
    );

    res.json({ logs: rows, total: parseInt(count.count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { log, auditLog, ACTIONS, router };
