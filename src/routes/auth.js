const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { signToken, auth } = require('../middleware/auth');

const router = express.Router();

// ----------------------------------------------------------------
// POST /api/auth/register
// ----------------------------------------------------------------
router.post('/register', async (req, res) => {
  const { email, password, role, name } = req.body;
  if (!email || !password || !role || !name) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  }
  if (!['erzeuger', 'caterer'].includes(role)) {
    return res.status(400).json({ error: 'Ungültige Rolle' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows: [user] } = await db.query(
      `INSERT INTO users (email, password, role, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, name`,
      [email.toLowerCase(), hash, role, name]
    );

    if (role === 'erzeuger') {
      await db.query(
        `INSERT INTO erzeuger (user_id, betrieb_name, region) VALUES ($1, $2, 'NRW')`,
        [user.id, name]
      );
    } else {
      await db.query(
        `INSERT INTO caterer (user_id, firma_name, region) VALUES ($1, $2, 'NRW')`,
        [user.id, name]
      );
    }

    const token = signToken({ id: user.id, email: user.email, role: user.role, name: user.name });
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'E-Mail bereits registriert' });
    console.error(err);
    res.status(500).json({ error: 'Registrierung fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// POST /api/auth/login
// ----------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
  }
  try {
    const { rows: [user] } = await db.query(
      `SELECT id, email, password, role, name FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    if (!user) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });

    const token = signToken({ id: user.id, email: user.email, role: user.role, name: user.name });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// GET /api/auth/me
// ----------------------------------------------------------------
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// ----------------------------------------------------------------
// POST /api/auth/setup
// Legt einmalig einen Admin-User an.
// Funktioniert NUR wenn noch kein Admin in der DB existiert.
// ----------------------------------------------------------------
router.post('/setup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email und password erforderlich' });
  }
  try {
    // Sicherheitscheck: bereits ein Admin vorhanden?
    const { rows } = await db.query(
      `SELECT id FROM users WHERE role = 'admin' LIMIT 1`
    );
    if (rows.length > 0) {
      return res.status(403).json({ error: 'Admin existiert bereits. Setup gesperrt.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows: [user] } = await db.query(
      `INSERT INTO users (email, password, role, name)
       VALUES ($1, $2, 'admin', $3)
       RETURNING id, email, role, name`,
      [email.toLowerCase(), hash, name || 'Admin']
    );

    const token = signToken({ id: user.id, email: user.email, role: user.role, name: user.name });
    res.status(201).json({
      message: 'Admin erfolgreich erstellt. Dieser Endpunkt ist jetzt gesperrt.',
      token,
      user,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'E-Mail bereits registriert' });
    console.error(err);
    res.status(500).json({ error: 'Setup fehlgeschlagen' });
  }
});

module.exports = router;
