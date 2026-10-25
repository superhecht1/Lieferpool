/**
 * Nachrichten-System – interne Plattform-Nachrichten
 * Admin → Erzeuger/Caterer, Erzeuger → Admin, Caterer → Admin
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

// GET /api/nachrichten – eigene Nachrichten (Posteingang)
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT n.*,
             von.name  AS von_name,
             von.role  AS von_role,
             an.name   AS an_name
      FROM nachrichten n
      LEFT JOIN users von ON von.id = n.von_user_id
      LEFT JOIN users an  ON an.id  = n.an_user_id
      WHERE n.an_user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 100
    `, [req.user.id]);
    const ungelesen = rows.filter(r => !r.gelesen).length;
    res.json({ nachrichten: rows, ungelesen });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/nachrichten/gesendet – gesendete Nachrichten
router.get('/gesendet', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT n.*,
             an.name  AS an_name,
             an.role  AS an_role
      FROM nachrichten n
      LEFT JOIN users an ON an.id = n.an_user_id
      WHERE n.von_user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 100
    `, [req.user.id]);
    res.json({ nachrichten: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/nachrichten/ungelesen-count
router.get('/ungelesen-count', auth, async (req, res) => {
  try {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM nachrichten WHERE an_user_id=$1 AND gelesen=false`,
      [req.user.id]
    );
    res.json({ count: r.count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/nachrichten – Nachricht senden
router.post('/', auth, async (req, res) => {
  const { an_user_id, betreff, text } = req.body;
  if (!an_user_id || !text) return res.status(400).json({ error: 'an_user_id und text erforderlich' });

  // Sicherheit: Nicht-Admins dürfen nur an Admins schreiben
  if (req.user.role !== 'admin') {
    const { rows: [ziel] } = await db.query(`SELECT role FROM users WHERE id=$1`, [an_user_id]);
    if (!ziel) return res.status(404).json({ error: 'Empfänger nicht gefunden' });
    if (ziel.role !== 'admin') return res.status(403).json({ error: 'Nur Nachrichten an Admins erlaubt' });
  }

  try {
    const { rows: [n] } = await db.query(`
      INSERT INTO nachrichten (von_user_id, an_user_id, betreff, text)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [req.user.id, an_user_id, betreff || '', text]);

    // Push-Benachrichtigung an Empfänger (non-blocking)
    const { rows: [sub] } = await db.query(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1 LIMIT 1`,
      [an_user_id]
    ).catch(() => ({ rows: [] }));
    if (sub) {
      const webpush = require('web-push');
      webpush.setVapidDetails(
        'mailto:' + (process.env.ADMIN_EMAIL || 'admin@frischkette.de'),
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: 'Neue Nachricht', body: betreff || text.slice(0, 60), tag: 'nachricht' })
      ).catch(() => {});
    }

    res.status(201).json({ nachricht: n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/nachrichten/alle-gelesen – alle als gelesen
router.put('/alle-gelesen', auth, async (req, res) => {
  try {
    await db.query(
      `UPDATE nachrichten SET gelesen=true WHERE an_user_id=$1 AND gelesen=false`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/nachrichten/:id/gelesen – als gelesen markieren
router.put('/:id/gelesen', auth, async (req, res) => {
  try {
    await db.query(
      `UPDATE nachrichten SET gelesen=true WHERE id=$1 AND an_user_id=$2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// DELETE /api/nachrichten/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM nachrichten WHERE id=$1 AND (an_user_id=$2 OR von_user_id=$2)`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/nachrichten/empfaenger-liste – Admin: alle User; andere: nur Admins
router.get('/empfaenger-liste', auth, async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      ({ rows } = await db.query(
        `SELECT u.id, u.name, u.email, u.role,
                COALESCE(e.betrieb_name, c.firma_name) AS firma
         FROM users u
         LEFT JOIN erzeuger e ON e.user_id=u.id
         LEFT JOIN caterer  c ON c.user_id=u.id
         WHERE u.id != $1
         ORDER BY u.role, u.name`,
        [req.user.id]
      ));
    } else {
      ({ rows } = await db.query(
        `SELECT id, name, email, role FROM users WHERE role='admin'`,
        []
      ));
    }
    res.json({ empfaenger: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
