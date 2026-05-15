const express  = require('express');
const bcrypt   = require('bcryptjs');
const db       = require('../db');
const { signToken, auth, role } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/auth/register ────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, role: userRole, name } = req.body;
  if (!email || !password || !userRole || !name) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  }
  if (!['erzeuger', 'caterer', 'fahrer'].includes(userRole)) {
    return res.status(400).json({ error: 'Ungültige Rolle' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows: [user] } = await db.query(
      `INSERT INTO users (email, password, role, name)
       VALUES ($1,$2,$3,$4) RETURNING id, email, role, name`,
      [email.toLowerCase(), hash, userRole, name]
    );

    if (userRole === 'erzeuger') {
      const { rows: [e] } = await db.query(
        `INSERT INTO erzeuger (user_id, betrieb_name, region)
         VALUES ($1,$2,'NRW') RETURNING id`, [user.id, name]
      );
      await db.query(
        `INSERT INTO zertifikate (erzeuger_id, typ, zert_nummer, status, gueltig_bis)
         VALUES ($1,'Basis','AUTO-'||upper(substr(md5(random()::text),1,8)),'verified',NOW()+INTERVAL '2 years')`,
        [e.id]
      );
    } else if (userRole === 'caterer') {
      await db.query(
        `INSERT INTO caterer (user_id, firma_name, region) VALUES ($1,$2,'NRW')`,
        [user.id, name]
      );
    } else if (userRole === 'fahrer') {
      await db.query(
        `INSERT INTO fahrer_profile (user_id) VALUES ($1)`, [user.id]
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

// ── POST /api/auth/login ───────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
  try {
    const { rows: [user] } = await db.query(
      `SELECT id, email, password, role, name FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    if (!user) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });

    const token = signToken({ id: user.id, email: user.email, role: user.role, name: user.name });

    // Redirect-URL je nach Rolle
    const redirectMap = {
      admin:    '/admin',
      erzeuger: '/erzeuger',
      caterer:  '/caterer',
      fahrer:   '/fahrer',
    };

    res.json({
      token,
      user:     { id: user.id, email: user.email, role: user.role, name: user.name },
      redirect: redirectMap[user.role] || '/',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login fehlgeschlagen' });
  }
});

// ── GET /api/auth/me ───────────────────────────────────────────
router.get('/me', auth, (req, res) => res.json({ user: req.user }));

// ── POST /api/auth/setup – einmalig Admin anlegen ──────────────
router.post('/setup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email und password erforderlich' });
  try {
    const { rows } = await db.query(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
    if (rows.length > 0) return res.status(403).json({ error: 'Admin existiert bereits' });
    const hash = await bcrypt.hash(password, 10);
    const { rows: [user] } = await db.query(
      `INSERT INTO users (email,password,role,name) VALUES ($1,$2,'admin',$3) RETURNING id,email,role,name`,
      [email.toLowerCase(), hash, name || 'Admin']
    );
    const token = signToken({ id: user.id, email: user.email, role: user.role, name: user.name });
    res.status(201).json({ message: 'Admin erstellt. Endpunkt gesperrt.', token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'E-Mail bereits registriert' });
    console.error(err);
    res.status(500).json({ error: 'Setup fehlgeschlagen' });
  }
});

// ── POST /api/auth/fix-zertifikate – einmalig (Admin) ─────────
router.post('/fix-zertifikate', auth, role('admin'), async (req, res) => {
  try {
    const { rows: erzeuger } = await db.query(`
      SELECT e.id, e.betrieb_name FROM erzeuger e
      WHERE NOT EXISTS (
        SELECT 1 FROM zertifikate z WHERE z.erzeuger_id = e.id AND z.status='verified'
      )
    `);
    for (const e of erzeuger) {
      await db.query(`
        INSERT INTO zertifikate (erzeuger_id,typ,zert_nummer,status,gueltig_bis)
        VALUES ($1,'Basis','AUTO-'||upper(substr(md5(random()::text),1,8)),'verified',NOW()+INTERVAL '2 years')
        ON CONFLICT DO NOTHING
      `, [e.id]);
    }
    res.json({ message: `${erzeuger.length} Erzeuger gefixt`, count: erzeuger.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fix fehlgeschlagen' });
  }
});

// ── POST /api/auth/change-password ────────────────────────────
router.post('/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Beide Passwörter erforderlich' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Neues Passwort mindestens 8 Zeichen' });
  }
  try {
    const { rows: [user] } = await db.query(
      `SELECT password FROM users WHERE id=$1`, [req.user.id]
    );
    const ok = await bcrypt.compare(current_password, user.password);
    if (!ok) return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
    const hash = await bcrypt.hash(new_password, 10);
    await db.query(`UPDATE users SET password=$1 WHERE id=$2`, [hash, req.user.id]);
    res.json({ message: 'Passwort geändert' });
  } catch (err) {
    res.status(500).json({ error: 'Passwortänderung fehlgeschlagen' });
  }
});

// ── POST /api/auth/admin/create-fahrer – Admin erstellt Fahrer ─
router.post('/admin/create-fahrer', auth, role('admin'), async (req, res) => {
  const { email, password, name, lizenzklasse = 'B' } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password und name erforderlich' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows: [user] } = await db.query(
      `INSERT INTO users (email,password,role,name) VALUES ($1,$2,'fahrer',$3) RETURNING id,email,role,name`,
      [email.toLowerCase(), hash, name]
    );
    await db.query(
      `INSERT INTO fahrer_profile (user_id, lizenzklasse) VALUES ($1,$2)`,
      [user.id, lizenzklasse]
    );
    res.status(201).json({ user, message: 'Fahrer-Account erstellt' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'E-Mail bereits vorhanden' });
    console.error(err);
    res.status(500).json({ error: 'Erstellung fehlgeschlagen' });
  }
});

module.exports = router;
