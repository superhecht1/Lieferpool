const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { signToken, auth, role } = require('../middleware/auth');

const router = express.Router();

// ----------------------------------------------------------------
// POST /api/auth/register
// ----------------------------------------------------------------
router.post('/register', async (req, res) => {
  const { email, password, role: userRole, name } = req.body;
  if (!email || !password || !userRole || !name) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  }
  if (!['erzeuger', 'caterer'].includes(userRole)) {
    return res.status(400).json({ error: 'Ungültige Rolle' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows: [user] } = await db.query(
      `INSERT INTO users (email, password, role, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, name`,
      [email.toLowerCase(), hash, userRole, name]
    );

    if (userRole === 'erzeuger') {
      // Erzeuger-Profil anlegen
      const { rows: [e] } = await db.query(
        `INSERT INTO erzeuger (user_id, betrieb_name, region)
         VALUES ($1, $2, 'NRW')
         RETURNING id`,
        [user.id, name]
      );
      // Standard-Zertifikat automatisch anlegen & verifizieren
      // → Erzeuger kann sofort Mengen zusagen ohne Admin-Schritt
      await db.query(
        `INSERT INTO zertifikate
           (erzeuger_id, typ, zert_nummer, status, gueltig_bis)
         VALUES
           ($1, 'Basis', 'AUTO-' || upper(substr(md5(random()::text), 1, 8)),
            'verified', NOW() + INTERVAL '2 years')`,
        [e.id]
      );
    } else {
      await db.query(
        `INSERT INTO caterer (user_id, firma_name, region)
         VALUES ($1, $2, 'NRW')`,
        [user.id, name]
      );
    }

    const token = signToken({
      id: user.id, email: user.email, role: user.role, name: user.name,
    });
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, role: user.role, name: user.name },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'E-Mail bereits registriert' });
    }
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

    const token = signToken({
      id: user.id, email: user.email, role: user.role, name: user.name,
    });
    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, name: user.name },
    });
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
// Gesperrt sobald ein Admin existiert.
// ----------------------------------------------------------------
router.post('/setup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email und password erforderlich' });
  }
  try {
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

    const token = signToken({
      id: user.id, email: user.email, role: user.role, name: user.name,
    });
    res.status(201).json({
      message: 'Admin erstellt. Dieser Endpunkt ist jetzt gesperrt.',
      token,
      user,
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'E-Mail bereits registriert' });
    }
    console.error(err);
    res.status(500).json({ error: 'Setup fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// POST /api/auth/fix-zertifikate
// Legt für alle Erzeuger ohne verifiziertes Zertifikat
// automatisch eines an. Nur für Admin.
// Einmalig ausführen um bestehende User zu fixen.
// ----------------------------------------------------------------
router.post('/fix-zertifikate', auth, role('admin'), async (req, res) => {
  try {
    // Alle Erzeuger ohne verifiziertes Zertifikat finden
    const { rows: erzeuger } = await db.query(`
      SELECT e.id, e.betrieb_name
      FROM erzeuger e
      WHERE NOT EXISTS (
        SELECT 1 FROM zertifikate z
        WHERE z.erzeuger_id = e.id AND z.status = 'verified'
      )
    `);

    if (erzeuger.length === 0) {
      return res.json({ message: 'Alle Erzeuger haben bereits verifizierte Zertifikate.', count: 0 });
    }

    // Für jeden betroffenen Erzeuger ein Basis-Zertifikat anlegen
    for (const e of erzeuger) {
      await db.query(`
        INSERT INTO zertifikate
          (erzeuger_id, typ, zert_nummer, status, gueltig_bis)
        VALUES
          ($1, 'Basis', 'AUTO-' || upper(substr(md5(random()::text), 1, 8)),
           'verified', NOW() + INTERVAL '2 years')
        ON CONFLICT DO NOTHING
      `, [e.id]);
    }

    res.json({
      message: `${erzeuger.length} Erzeuger mit Basis-Zertifikat versehen.`,
      count: erzeuger.length,
      erzeuger: erzeuger.map(e => e.betrieb_name),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fix fehlgeschlagen' });
  }
});

module.exports = router;
