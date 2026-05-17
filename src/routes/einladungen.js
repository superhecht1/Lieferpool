/**
 * Einladungslinks für FrischKette
 * Admin sendet personalisierte Einladungs-E-Mails
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth, role } = require('../middleware/auth');
const crypto  = require('crypto');

// POST /api/einladungen – Einladung erstellen und versenden
router.post('/', auth, role('admin'), async (req, res) => {
  const { email, rolle, name } = req.body;
  if (!email || !rolle) return res.status(400).json({ error: 'E-Mail und Rolle erforderlich' });
  if (!['erzeuger','caterer','fahrer'].includes(rolle)) return res.status(400).json({ error: 'Ungültige Rolle' });

  try {
    // Prüfen ob E-Mail schon registriert
    const { rows:[existing] } = await db.query(`SELECT id FROM users WHERE email=$1`, [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Diese E-Mail ist bereits registriert' });

    const token     = crypto.randomBytes(32).toString('hex');
    const registerUrl = `${process.env.APP_URL||''}/register?token=${token}&rolle=${rolle}`;

    const { rows:[inv] } = await db.query(`
      INSERT INTO einladungen (token, email, rolle, name, created_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [token, email.toLowerCase(), rolle, name||null, req.user.id]);

    const rolleLabel = { erzeuger:'Erzeuger:in', caterer:'Caterer', fahrer:'Fahrer:in' }[rolle];

    const emailSvc = require('../services/email');
    await emailSvc.send({
      to: { email: email.toLowerCase(), name: name || email },
      subject: `Einladung zu FrischKette als ${rolleLabel}`,
      html: `
        <h2>Einladung zu FrischKette</h2>
        <p>Hallo${name ? ` ${name}` : ''},</p>
        <p>Du wurdest eingeladen, der regionalen Lebensmittel-Plattform <strong>FrischKette</strong> als <strong>${rolleLabel}</strong> beizutreten.</p>
        <p>Klicke auf den Button um dein Konto zu erstellen. Der Link ist <strong>7 Tage</strong> gültig.</p>
        <a href="${registerUrl}" style="display:inline-block;background:#2e7d3e;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin:16px 0">
          Jetzt registrieren →
        </a>
        <p style="font-size:12px;color:#8a9a84;margin-top:16px">
          Falls der Button nicht funktioniert, kopiere diesen Link:<br>
          <a href="${registerUrl}">${registerUrl}</a>
        </p>`,
    });

    res.status(201).json({ message: `Einladung an ${email} gesendet`, token, registerUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/einladungen – Liste aller Einladungen (Admin)
router.get('/', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT i.*, u.name AS eingeladen_von
      FROM einladungen i
      LEFT JOIN users u ON u.id=i.created_by
      ORDER BY i.created_at DESC
      LIMIT 100
    `);
    res.json({ einladungen: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/einladungen/check/:token – Token prüfen (für Register-Seite)
router.get('/check/:token', async (req, res) => {
  try {
    const { rows:[inv] } = await db.query(`
      SELECT email, rolle, name, expires_at, used
      FROM einladungen WHERE token=$1
    `, [req.params.token]);
    if (!inv) return res.status(404).json({ error: 'Einladung nicht gefunden' });
    if (inv.used) return res.status(410).json({ error: 'Einladung bereits verwendet' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: 'Einladung abgelaufen' });
    res.json({ valid: true, email: inv.email, rolle: inv.rolle, name: inv.name });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/einladungen/:id – Einladung widerrufen
router.delete('/:id', auth, role('admin'), async (req, res) => {
  try {
    await db.query(`DELETE FROM einladungen WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Einladung widerrufen' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
