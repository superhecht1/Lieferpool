/** benachrichtigungen.js – Einstellungen für Erinnerungen · Ablage: src/routes/benachrichtigungen.js
 *  Einbinden in server.js:  app.use('/api/benachrichtigungen', require('./routes/benachrichtigungen'));
 */
const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

router.get('/einstellungen', auth, async (req, res) => {
  try {
    const { rows: [p] } = await db.query(`SELECT email_erinnerungen, push_erinnerungen FROM notif_prefs WHERE user_id=$1`, [req.user.id]);
    res.json(p || { email_erinnerungen: true, push_erinnerungen: true });
  } catch (e) { res.status(500).json({ error: 'Einstellungen konnten nicht geladen werden' }); }
});

router.put('/einstellungen', auth, async (req, res) => {
  const email_erinnerungen = req.body.email_erinnerungen !== false;
  const push_erinnerungen  = req.body.push_erinnerungen  !== false;
  try {
    await db.query(`
      INSERT INTO notif_prefs (user_id, email_erinnerungen, push_erinnerungen, updated_at) VALUES ($1,$2,$3,NOW())
      ON CONFLICT (user_id) DO UPDATE SET email_erinnerungen=$2, push_erinnerungen=$3, updated_at=NOW()`,
      [req.user.id, email_erinnerungen, push_erinnerungen]);
    res.json({ email_erinnerungen, push_erinnerungen });
  } catch (e) { res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden' }); }
});

module.exports = router;
