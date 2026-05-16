/**
 * Admin 2FA (TOTP) für FrischKette
 * Verwendet otplib für Time-based One-Time Passwords
 */
const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { auth, role } = require('../middleware/auth');
const { authenticator } = require('otplib');
const QRCode   = require('qrcode');

authenticator.options = { window: 1 }; // Erlaube ±30 Sekunden Toleranz

// GET /api/admin/2fa/setup – TOTP Secret generieren + QR ausgeben
router.get('/setup', auth, role('admin'), async (req, res) => {
  try {
    const { rows:[user] } = await db.query(
      `SELECT name, email, totp_enabled FROM users WHERE id=$1`, [req.user.id]
    );

    if (user.totp_enabled) {
      return res.json({ alreadyEnabled: true, message: '2FA ist bereits aktiviert' });
    }

    const secret = authenticator.generateSecret();
    const otpUri = authenticator.keyuri(user.email, 'FrischKette', secret);
    const qrDataUrl = await QRCode.toDataURL(otpUri, { width: 256, margin: 2 });

    // Secret temporär speichern (noch nicht aktiviert)
    await db.query(
      `UPDATE users SET totp_secret=$1, totp_verified=FALSE WHERE id=$2`,
      [secret, req.user.id]
    );

    res.json({ secret, qrDataUrl, otpUri });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/2fa/verify – Ersten Code bestätigen + 2FA aktivieren
router.post('/verify', auth, role('admin'), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code erforderlich' });
  try {
    const { rows:[user] } = await db.query(
      `SELECT totp_secret FROM users WHERE id=$1`, [req.user.id]
    );
    if (!user?.totp_secret) return res.status(400).json({ error: 'Bitte zuerst 2FA einrichten' });

    const valid = authenticator.check(code.replace(/\s/g,''), user.totp_secret);
    if (!valid) return res.status(400).json({ error: 'Ungültiger Code' });

    await db.query(
      `UPDATE users SET totp_enabled=TRUE, totp_verified=TRUE WHERE id=$1`, [req.user.id]
    );
    res.json({ message: '2FA erfolgreich aktiviert' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/2fa/disable – 2FA deaktivieren (mit Code bestätigen)
router.post('/disable', auth, role('admin'), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code erforderlich' });
  try {
    const { rows:[user] } = await db.query(
      `SELECT totp_secret FROM users WHERE id=$1`, [req.user.id]
    );
    const valid = authenticator.check(code.replace(/\s/g,''), user?.totp_secret || '');
    if (!valid) return res.status(400).json({ error: 'Ungültiger Code' });

    await db.query(
      `UPDATE users SET totp_secret=NULL, totp_enabled=FALSE, totp_verified=FALSE WHERE id=$1`,
      [req.user.id]
    );
    res.json({ message: '2FA deaktiviert' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/2fa/check – 2FA-Code beim Login prüfen
router.post('/check', async (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'userId und code erforderlich' });
  try {
    const { rows:[user] } = await db.query(
      `SELECT totp_secret, totp_enabled FROM users WHERE id=$1 AND role='admin'`, [userId]
    );
    if (!user?.totp_enabled) return res.json({ valid: true, required: false });

    const valid = authenticator.check(code.replace(/\s/g,''), user.totp_secret);
    if (!valid) return res.status(400).json({ error: 'Ungültiger 2FA-Code', valid: false });

    res.json({ valid: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
