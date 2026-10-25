/**
 * admin-users.js – Nutzerverwaltung (nur Admin)
 * Ablage: backend/src/routes/admin-users.js · Einbinden: app.use('/api/admin/users', require('./routes/admin-users'));
 *   GET  /?q=&rolle=            Liste aller Nutzer
 *   GET  /:id                   Nutzer + Profil (Erzeuger/Caterer)
 *   PUT  /:id                   {name, email, aktiv, profil:{…}} bearbeiten
 *   POST /:id/passwort          temporäres Passwort setzen (wird einmalig zurückgegeben), alle Sitzungen beenden
 * Rolle bleibt unverändert (Profile hängen an der Rolle). Eigenes Konto kann nicht deaktiviert werden.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { auth, role } = require('../middleware/auth');
const { encrypt } = require('../services/fieldcrypto');
const router = express.Router();
router.use(auth, role('admin'));

const UUID = /^[0-9a-f-]{36}$/i;
const PROFIL = {
  erzeuger: { tabelle: 'erzeuger', felder: ['betrieb_name', 'region', 'adresse', 'plz', 'ort', 'telefon', 'website', 'beschreibung', 'ust_id', 'bank_name'] },
  caterer:  { tabelle: 'caterer',  felder: ['firma_name', 'region', 'adresse', 'plz', 'ort', 'telefon', 'website', 'beschreibung', 'ust_id', 'bank_name'] },
};
const text = v => (v === null || v === undefined) ? undefined : String(v).trim().slice(0, 1000);

router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const rolle = ['admin', 'erzeuger', 'caterer', 'fahrer'].includes(req.query.rolle) ? req.query.rolle : null;
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.name, u.role, COALESCE(u.aktiv, TRUE) AS aktiv, u.created_at,
             COALESCE(e.betrieb_name, c.firma_name) AS betrieb
      FROM users u LEFT JOIN erzeuger e ON e.user_id = u.id LEFT JOIN caterer c ON c.user_id = u.id
      WHERE ($1::text IS NULL OR u.role = $1)
        AND ($2 = '' OR u.email ILIKE '%' || $2 || '%' OR u.name ILIKE '%' || $2 || '%' OR COALESCE(e.betrieb_name, c.firma_name, '') ILIKE '%' || $2 || '%')
      ORDER BY u.created_at DESC LIMIT 500`, [rolle, q]);
    res.json({ nutzer: rows });
  } catch (e) { console.error('[admin-users]', e.message); res.status(500).json({ error: 'Nutzer konnten nicht geladen werden' }); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Ungültige ID' });
    const { rows: [u] } = await db.query(`SELECT id, email, name, role, COALESCE(aktiv, TRUE) AS aktiv, created_at FROM users WHERE id=$1`, [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    let profil = null;
    const p = PROFIL[u.role];
    if (p) {
      const { rows: [r] } = await db.query(`SELECT * FROM ${p.tabelle} WHERE user_id=$1`, [u.id]);
      if (r) { profil = Object.fromEntries(p.felder.map(f => [f, r[f] ?? ''])); profil.iban_gesetzt = !!r.iban; }
    }
    res.json({ nutzer: u, profil, profil_felder: p ? p.felder : [] });
  } catch (e) { res.status(500).json({ error: 'Nutzer konnte nicht geladen werden' }); }
});

router.put('/:id', async (req, res) => {
  const id = req.params.id;
  if (!UUID.test(id)) return res.status(400).json({ error: 'Ungültige ID' });
  const b = req.body || {};
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [u] } = await client.query(`SELECT id, email, role FROM users WHERE id=$1 FOR UPDATE`, [id]);
    if (!u) throw Object.assign(new Error('Nutzer nicht gefunden'), { status: 404 });
    const sets = [], vals = [], felder = [];
    const add = (spalte, wert) => { vals.push(wert); sets.push(`${spalte}=$${vals.length}`); felder.push(spalte); };
    if (b.name !== undefined) { const n = text(b.name); if (!n) throw Object.assign(new Error('Name darf nicht leer sein'), { status: 400 }); add('name', n); }
    let emailNeu = null;
    if (b.email !== undefined) {
      const m = String(b.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m) || m.length > 200) throw Object.assign(new Error('E-Mail ungültig'), { status: 400 });
      if (m !== u.email) { add('email', m); emailNeu = m; }
    }
    let sperren = false;
    if (b.aktiv !== undefined) {
      const a = b.aktiv === true || b.aktiv === 'true';
      if (!a && u.id === req.user.id) throw Object.assign(new Error('Das eigene Konto kann nicht deaktiviert werden'), { status: 400 });
      add('aktiv', a); sperren = !a;
    }
    if (sets.length) await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${vals.length + 1}`, [...vals, id]);

    const p = PROFIL[u.role];
    if (p && b.profil && typeof b.profil === 'object') {
      const ps = [], pv = [];
      for (const f of p.felder) if (b.profil[f] !== undefined) { pv.push(text(b.profil[f]) ?? ''); ps.push(`${f}=$${pv.length}`); felder.push(`${p.tabelle}.${f}`); }
      const iban = String(b.profil.iban || '').replace(/\s+/g, '').toUpperCase();
      if (iban) {
        if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw Object.assign(new Error('IBAN ungültig'), { status: 400 });
        pv.push(encrypt(iban)); ps.push(`iban=$${pv.length}`); felder.push(`${p.tabelle}.iban`);
      }
      if (ps.length) await client.query(`UPDATE ${p.tabelle} SET ${ps.join(', ')} WHERE user_id=$${pv.length + 1}`, [...pv, id]);
    }
    // Sitzungen beenden, wenn Konto gesperrt oder E-Mail geändert wurde
    if (sperren || emailNeu) await client.query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [id]).catch(() => {});
    await client.query('COMMIT');
    try { await require('../middleware/audit').log(req, 'admin.user_geaendert', 'user', id, { felder }); } catch {}
    res.json({ message: 'Gespeichert', geaendert: felder });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ error: 'E-Mail bereits vergeben' });
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Speichern fehlgeschlagen' });
  } finally { client.release(); }
});

router.post('/:id/passwort', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Ungültige ID' });
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Eigenes Passwort bitte über „Passwort ändern“ setzen' });
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const pw = Array.from(crypto.randomBytes(14), x => alphabet[x % alphabet.length]).join('');
    const { rowCount } = await db.query(`UPDATE users SET password=$1 WHERE id=$2`, [await bcrypt.hash(pw, 10), req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
    await db.query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [req.params.id]).catch(() => {});
    try { await require('../middleware/audit').log(req, 'admin.user_passwort_gesetzt', 'user', req.params.id, {}); } catch {}
    res.json({ passwort: pw });
  } catch (e) { res.status(500).json({ error: 'Passwort konnte nicht gesetzt werden' }); }
});

module.exports = router;
