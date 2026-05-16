/**
 * DSGVO-Endpunkte für FrischKette
 * Art. 15 – Auskunft
 * Art. 17 – Recht auf Löschung
 * Art. 20 – Datenübertragbarkeit
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth } = require('../middleware/auth');

// GET /api/dsgvo/export – Alle eigenen Daten exportieren (Art. 20)
router.get('/export', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const role   = req.user.role;

    // Basis-Nutzerdaten
    const { rows:[user] } = await db.query(
      `SELECT id, email, role, name, created_at FROM users WHERE id=$1`, [userId]
    );

    let roleData = {};

    if (role === 'erzeuger') {
      const { rows:[erz] } = await db.query(
        `SELECT betrieb_name, region, adresse, plz, ort, telefon, sortiment, max_kapazitaet, created_at
         FROM erzeuger WHERE user_id=$1`, [userId]
      );
      const { rows: commits } = await db.query(
        `SELECT c.menge, c.status, c.created_at, p.produkt, p.lieferwoche
         FROM commitments c JOIN pools p ON p.id=c.pool_id
         JOIN erzeuger e ON e.id=c.erzeuger_id WHERE e.user_id=$1
         ORDER BY c.created_at DESC`, [userId]
      );
      const { rows: ausz } = await db.query(
        `SELECT a.brutto, a.netto, a.gebuehr, a.status, a.created_at
         FROM auszahlungen a JOIN erzeuger e ON e.id=a.erzeuger_id
         WHERE e.user_id=$1 ORDER BY a.created_at DESC`, [userId]
      );
      roleData = { profil: erz, commitments: commits, auszahlungen: ausz };

    } else if (role === 'caterer') {
      const { rows:[cat] } = await db.query(
        `SELECT firma_name, adresse, plz, ort, telefon, kuechen_typ, created_at
         FROM caterer WHERE user_id=$1`, [userId]
      );
      const { rows: pools } = await db.query(
        `SELECT produkt, lieferwoche, menge_ziel, preis_pro_einheit, status, created_at
         FROM pools WHERE caterer_id=(SELECT id FROM caterer WHERE user_id=$1)
         ORDER BY created_at DESC`, [userId]
      );
      roleData = { profil: cat, pools };

    } else if (role === 'fahrer') {
      const { rows: touren } = await db.query(
        `SELECT t.name, t.datum, t.status, t.created_at
         FROM touren t JOIN fahrer_profile f ON f.id=t.fahrer_id
         WHERE f.user_id=$1 ORDER BY t.created_at DESC`, [userId]
      );
      roleData = { touren };
    }

    // Audit-Log der eigenen Aktionen
    const { rows: auditEntries } = await db.query(
      `SELECT action, details, ip, created_at FROM audit_log
       WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [userId]
    );

    const exportData = {
      meta: {
        exported_at: new Date().toISOString(),
        requested_by: user.email,
        purpose: 'DSGVO Art. 20 – Datenübertragbarkeit',
        controller: 'FrischKette / superhecht.ai – Lackgässchen 24, 50968 Köln',
      },
      account: user,
      role_data: roleData,
      audit_log: auditEntries,
    };

    // Export loggen
    await db.query(`INSERT INTO data_exports (user_id) VALUES ($1)`, [userId]).catch(()=>{});

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="frischkette-meine-daten-${new Date().toISOString().slice(0,10)}.json"`
    );
    res.json(exportData);
  } catch (err) {
    console.error('[dsgvo export]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dsgvo/account – Eigenes Konto löschen/anonymisieren (Art. 17)
router.delete('/account', auth, async (req, res) => {
  const { password, reason } = req.body;
  if (!password) return res.status(400).json({ error: 'Passwort zur Bestätigung erforderlich' });

  try {
    const bcrypt = require('bcryptjs');
    const { rows:[user] } = await db.query(
      `SELECT id, email, password, role FROM users WHERE id=$1`, [req.user.id]
    );
    const pwOk = await bcrypt.compare(password, user.password);
    if (!pwOk) return res.status(401).json({ error: 'Passwort falsch' });

    // Admin kann sich nicht selbst löschen
    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Admin-Konto kann nicht selbst gelöscht werden. Bitte kontaktiere support@frischkette.de' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Commitments zurückziehen
      if (user.role === 'erzeuger') {
        await client.query(`
          UPDATE commitments SET status='zurueckgezogen'
          WHERE erzeuger_id=(SELECT id FROM erzeuger WHERE user_id=$1)
          AND status='aktiv'
        `, [user.id]);
      }

      // Nutzer anonymisieren statt löschen (wegen Abrechnungspflichten)
      const anon = `[gelöscht-${Date.now()}]`;
      await client.query(`
        UPDATE users SET
          email       = $2,
          name        = '[Gelöschter Nutzer]',
          password    = '[DELETED]',
          totp_secret = NULL,
          totp_enabled= FALSE,
          deletion_requested_at = NOW()
        WHERE id=$1
      `, [user.id, anon + '@deleted.invalid']);

      // Refresh Tokens löschen
      await client.query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [user.id]);

      // Rollenspezifische personenbezogene Daten anonymisieren
      if (user.role === 'erzeuger') {
        await client.query(`
          UPDATE erzeuger SET
            telefon='[gelöscht]', iban='[gelöscht]', ust_id='[gelöscht]',
            adresse='[gelöscht]', notizen=NULL
          WHERE user_id=$1
        `, [user.id]);
      } else if (user.role === 'caterer') {
        await client.query(`
          UPDATE caterer SET telefon='[gelöscht]', iban='[gelöscht]', adresse='[gelöscht]'
          WHERE user_id=$1
        `, [user.id]);
      }

      await client.query('COMMIT');

      // E-Mail an Admin
      try {
        require('../services/email').send({
          to:{ email: process.env.ADMIN_EMAIL, name:'FrischKette Admin' },
          subject:'Konto-Löschung beantragt',
          html:`<p>Nutzer <strong>${user.email}</strong> (${user.role}) hat sein Konto gelöscht.</p><p>Grund: ${reason||'kein Grund angegeben'}</p>`,
        });
      } catch {}

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }

    res.json({ message: 'Dein Konto wurde anonymisiert. Abrechnungsdaten werden gem. gesetzlicher Aufbewahrungspflicht (10 Jahre) aufbewahrt.' });
  } catch (err) {
    console.error('[dsgvo delete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
