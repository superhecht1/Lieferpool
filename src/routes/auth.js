const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const db       = require('../db');
const { signToken, auth, role } = require('../middleware/auth');

const router = express.Router();
const REDIRECT = { admin:'/admin', erzeuger:'/erzeuger', caterer:'/caterer', fahrer:'/fahrer' };

function makeRefreshToken() { return crypto.randomBytes(32).toString('hex'); }
function hashToken(t)       { return crypto.createHash('sha256').update(t).digest('hex'); }

async function createRefreshToken(userId) {
  const token     = makeRefreshToken();
  const expiresAt = new Date(Date.now() + 30*24*60*60*1000);
  await db.query(
    `INSERT INTO refresh_tokens (user_id,token_hash,expires_at) VALUES ($1,$2,$3)`,
    [userId, hashToken(token), expiresAt]
  );
  return token;
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, role: userRole, name } = req.body;
  if (!email||!password||!userRole||!name) return res.status(400).json({ error:'Pflichtfelder fehlen' });
  if (!['erzeuger','caterer','fahrer'].includes(userRole)) return res.status(400).json({ error:'Ungültige Rolle' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows:[user] } = await db.query(
      `INSERT INTO users (email,password,role,name) VALUES ($1,$2,$3,$4) RETURNING id,email,role,name`,
      [email.toLowerCase(), hash, userRole, name]
    );
    if (userRole==='erzeuger') {
      const { rows:[e] } = await db.query(`INSERT INTO erzeuger (user_id,betrieb_name,region) VALUES ($1,$2,'NRW') RETURNING id`,[user.id,name]);
      await db.query(`INSERT INTO zertifikate (erzeuger_id,typ,zert_nummer,status,gueltig_bis) VALUES ($1,'Basis','AUTO-'||upper(substr(md5(random()::text),1,8)),'verified',NOW()+INTERVAL '2 years')`,[e.id]);
    } else if (userRole==='caterer') {
      await db.query(`INSERT INTO caterer (user_id,firma_name,region) VALUES ($1,$2,'NRW')`,[user.id,name]);
    } else if (userRole==='fahrer') {
      await db.query(`INSERT INTO fahrer_profile (user_id) VALUES ($1)`,[user.id]);
    }
    const token        = signToken({ id:user.id, email:user.email, role:user.role, name:user.name });
    const refreshToken = await createRefreshToken(user.id);
    res.status(201).json({ token, refreshToken, user, redirect:REDIRECT[user.role] });
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error:'E-Mail bereits registriert' });
    console.error(err); res.status(500).json({ error:'Registrierung fehlgeschlagen' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ error:'E-Mail und Passwort erforderlich' });
  try {
    const { rows:[user] } = await db.query(`SELECT id,email,password,role,name FROM users WHERE email=$1`,[email.toLowerCase()]);
    if (!user) return res.status(401).json({ error:'Ungültige Anmeldedaten' });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error:'Ungültige Anmeldedaten' });
    const token        = signToken({ id:user.id, email:user.email, role:user.role, name:user.name });
    const refreshToken = await createRefreshToken(user.id);
    res.json({ token, refreshToken, user:{ id:user.id, email:user.email, role:user.role, name:user.name }, redirect:REDIRECT[user.role]||'/' });
  } catch (err) { console.error(err); res.status(500).json({ error:'Login fehlgeschlagen' }); }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error:'refreshToken erforderlich' });
  try {
    const { rows:[rt] } = await db.query(
      `SELECT rt.*,u.email,u.role,u.name FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id WHERE rt.token_hash=$1 AND rt.expires_at>NOW()`,
      [hashToken(refreshToken)]
    );
    if (!rt) return res.status(401).json({ error:'Ungültiger oder abgelaufener Refresh-Token' });
    const newToken   = signToken({ id:rt.user_id, email:rt.email, role:rt.role, name:rt.name });
    const newRefresh = makeRefreshToken();
    await db.query(`UPDATE refresh_tokens SET token_hash=$1,expires_at=$2 WHERE id=$3`,
      [hashToken(newRefresh), new Date(Date.now()+30*24*60*60*1000), rt.id]);
    res.json({ token:newToken, refreshToken:newRefresh });
  } catch (err) { console.error(err); res.status(500).json({ error:'Refresh fehlgeschlagen' }); }
});

// POST /api/auth/logout
router.post('/logout', auth, async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) await db.query(`DELETE FROM refresh_tokens WHERE token_hash=$1`,[hashToken(refreshToken)]).catch(()=>{});
  await db.query(`DELETE FROM refresh_tokens WHERE user_id=$1`,[req.user.id]).catch(()=>{});
  res.json({ message:'Abgemeldet' });
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => res.json({ user:req.user }));

// POST /api/auth/change-password
router.post('/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password||!new_password) return res.status(400).json({ error:'Beide Passwörter erforderlich' });
  if (new_password.length<8) return res.status(400).json({ error:'Min. 8 Zeichen' });
  try {
    const { rows:[u] } = await db.query(`SELECT password FROM users WHERE id=$1`,[req.user.id]);
    if (!await bcrypt.compare(current_password, u.password)) return res.status(401).json({ error:'Aktuelles Passwort falsch' });
    await db.query(`UPDATE users SET password=$1 WHERE id=$2`,[await bcrypt.hash(new_password,10),req.user.id]);
    res.json({ message:'Passwort geändert' });
  } catch (err) { res.status(500).json({ error:'Fehler' }); }
});

// POST /api/auth/push-subscribe
router.post('/push-subscribe', auth, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint||!keys?.p256dh||!keys?.auth) return res.status(400).json({ error:'Ungültige Subscription' });
  try {
    await db.query(
      `INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth_key) VALUES ($1,$2,$3,$4) ON CONFLICT (endpoint) DO UPDATE SET p256dh=$3,auth_key=$4`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ message:'Gespeichert' });
  } catch (err) { res.status(500).json({ error:'Fehler' }); }
});

// DELETE /api/auth/push-subscribe
router.delete('/push-subscribe', auth, async (req, res) => {
  const { endpoint } = req.body;
  await db.query(`DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2`,[req.user.id,endpoint]).catch(()=>{});
  res.json({ message:'Entfernt' });
});

// GET /api/auth/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error:'Push nicht konfiguriert' });
  res.json({ publicKey:key });
});

// POST /api/auth/setup
router.post('/setup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email||!password) return res.status(400).json({ error:'email und password erforderlich' });
  try {
    const { rows } = await db.query(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
    if (rows.length>0) return res.status(403).json({ error:'Admin existiert bereits' });
    const hash = await bcrypt.hash(password,10);
    const { rows:[user] } = await db.query(`INSERT INTO users (email,password,role,name) VALUES ($1,$2,'admin',$3) RETURNING id,email,role,name`,[email.toLowerCase(),hash,name||'Admin']);
    const token = signToken({ id:user.id, email:user.email, role:user.role, name:user.name });
    res.status(201).json({ message:'Admin erstellt', token, user });
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error:'E-Mail bereits registriert' });
    res.status(500).json({ error:'Setup fehlgeschlagen' });
  }
});

// POST /api/auth/fix-zertifikate (Admin)
router.post('/fix-zertifikate', auth, role('admin'), async (req, res) => {
  try {
    const { rows:erzeuger } = await db.query(`SELECT e.id FROM erzeuger e WHERE NOT EXISTS (SELECT 1 FROM zertifikate z WHERE z.erzeuger_id=e.id AND z.status='verified')`);
    for (const e of erzeuger) {
      await db.query(`INSERT INTO zertifikate (erzeuger_id,typ,zert_nummer,status,gueltig_bis) VALUES ($1,'Basis','AUTO-'||upper(substr(md5(random()::text),1,8)),'verified',NOW()+INTERVAL '2 years') ON CONFLICT DO NOTHING`,[e.id]);
    }
    res.json({ count:erzeuger.length });
  } catch (err) { res.status(500).json({ error:'Fix fehlgeschlagen' }); }
});

// POST /api/auth/admin/create-fahrer
router.post('/admin/create-fahrer', auth, role('admin'), async (req, res) => {
  const { email, password, name, lizenzklasse='B' } = req.body;
  if (!email||!password||!name) return res.status(400).json({ error:'Alle Felder erforderlich' });
  try {
    const hash = await bcrypt.hash(password,10);
    const { rows:[user] } = await db.query(`INSERT INTO users (email,password,role,name) VALUES ($1,$2,'fahrer',$3) RETURNING id,email,role,name`,[email.toLowerCase(),hash,name]);
    await db.query(`INSERT INTO fahrer_profile (user_id,lizenzklasse) VALUES ($1,$2)`,[user.id,lizenzklasse]);
    res.status(201).json({ user, message:'Fahrer-Account erstellt' });
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error:'E-Mail bereits vorhanden' });
    res.status(500).json({ error:'Erstellung fehlgeschlagen' });
  }
});

// GET /api/auth/fahrer-list (Admin)
router.get('/fahrer-list', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id,u.name,u.email,fp.lizenzklasse,fp.aktiv,
        COUNT(DISTINCT t.id)::int AS touren_gesamt
      FROM users u
      JOIN fahrer_profile fp ON fp.user_id=u.id
      LEFT JOIN touren t ON t.fahrer_id=u.id
      WHERE u.role='fahrer'
      GROUP BY u.id,u.name,u.email,fp.lizenzklasse,fp.aktiv ORDER BY u.name
    `);
    res.json({ fahrer:rows });
  } catch (err) { res.status(500).json({ error:'Fehler' }); }
});

module.exports = router;
