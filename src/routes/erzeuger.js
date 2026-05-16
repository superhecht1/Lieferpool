const express = require('express');
const db      = require('../db');
const { auth, role }   = require('../middleware/auth');
const { validateUpload } = require('../middleware/upload-validate');
const chain   = require('../services/chain');
const email   = require('../services/email');
const crypto  = require('crypto');

const router = express.Router();

// GET /api/erzeuger/me
router.get('/me', auth, role('erzeuger'), async (req, res) => {
  try {
    const { rows: [e] } = await db.query(
      `SELECT * FROM erzeuger WHERE user_id = $1`, [req.user.id]
    );
    if (!e) return res.status(404).json({ error: 'Profil nicht gefunden' });

    const { rows: zertifikate } = await db.query(
      `SELECT * FROM zertifikate WHERE erzeuger_id = $1 ORDER BY created_at DESC`, [e.id]
    );
    const { rows: commitments } = await db.query(`
      SELECT c.*, p.produkt, p.preis_pro_einheit, p.lieferwoche, p.status AS pool_status
      FROM commitments c JOIN pools p ON p.id = c.pool_id
      WHERE c.erzeuger_id = $1 ORDER BY c.created_at DESC LIMIT 20
    `, [e.id]);

    const { rows: auszahlungen } = await db.query(`
      SELECT a.*, p.produkt, p.lieferwoche, c.menge AS commitment_menge
      FROM auszahlungen a
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p ON p.id = c.pool_id
      WHERE a.erzeuger_id = $1 ORDER BY a.created_at DESC LIMIT 10
    `, [e.id]);

    res.json({ erzeuger: e, zertifikate, commitments, auszahlungen });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Profil konnte nicht geladen werden' });
  }
});

// PUT /api/erzeuger/me
router.put('/me', auth, role('erzeuger'), async (req, res) => {
  const {
    betrieb_name, region, iban, bank_name,
    adresse, plz, ort, telefon, website,
    beschreibung, sortiment, max_kapazitaet,
    betriebsgroesse, ust_id, gruendungsjahr,
  } = req.body;
  try {
    const { rows: [e] } = await db.query(`
      UPDATE erzeuger SET
        betrieb_name    = COALESCE($1,  betrieb_name),
        region          = COALESCE($2,  region),
        iban            = COALESCE($3,  iban),
        bank_name       = COALESCE($4,  bank_name),
        adresse         = COALESCE($5,  adresse),
        plz             = COALESCE($6,  plz),
        ort             = COALESCE($7,  ort),
        telefon         = COALESCE($8,  telefon),
        website         = COALESCE($9,  website),
        beschreibung    = COALESCE($10, beschreibung),
        sortiment       = COALESCE($11, sortiment),
        max_kapazitaet  = COALESCE($12, max_kapazitaet),
        betriebsgroesse = COALESCE($13, betriebsgroesse),
        ust_id          = COALESCE($14, ust_id),
        gruendungsjahr  = COALESCE($15, gruendungsjahr)
      WHERE user_id = $16 RETURNING *
    `, [betrieb_name, region, iban, bank_name,
        adresse, plz, ort, telefon, website,
        beschreibung, sortiment, max_kapazitaet,
        betriebsgroesse, ust_id, gruendungsjahr,
        req.user.id]);
    res.json({ erzeuger: e });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Aktualisierung fehlgeschlagen' });
  }
});

// POST /api/erzeuger/zertifikate
router.post('/zertifikate', auth, role('erzeuger'), async (req, res) => {
  const { typ, zert_nummer, gueltig_bis } = req.body;
  if (!typ || !zert_nummer) return res.status(400).json({ error: 'typ und zert_nummer erforderlich' });

  try {
    const { rows: [e] } = await db.query(
      `SELECT id FROM erzeuger WHERE user_id = $1`, [req.user.id]
    );
    const certHash = crypto.createHash('sha256')
      .update(`${e.id}-${typ}-${zert_nummer}-${gueltig_bis}`)
      .digest('hex');

    const { rows: [z] } = await db.query(`
      INSERT INTO zertifikate (erzeuger_id, typ, zert_nummer, datei_hash, gueltig_bis, status)
      VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *
    `, [e.id, typ, zert_nummer, certHash, gueltig_bis || null]);

    const { txHash } = await chain.registerCertificate(e.id, certHash);
    await db.query(`UPDATE zertifikate SET chain_tx = $1 WHERE id = $2`, [txHash, z.id]);

    res.status(201).json({ zertifikat: { ...z, chain_tx: txHash } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Einreichung fehlgeschlagen' });
  }
});

// GET /api/erzeuger/auszahlungen
router.get('/auszahlungen', auth, role('erzeuger'), async (req, res) => {
  try {
    const { rows: [e] } = await db.query(
      `SELECT id FROM erzeuger WHERE user_id = $1`, [req.user.id]
    );
    const { rows } = await db.query(`
      SELECT a.*, p.produkt, p.lieferwoche, c.menge AS commitment_menge
      FROM auszahlungen a
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p ON p.id = c.pool_id
      WHERE a.erzeuger_id = $1 ORDER BY a.created_at DESC
    `, [e.id]);

    const gesamt     = rows.filter(r => r.status === 'ausgezahlt').reduce((s,r) => s + parseFloat(r.netto), 0);
    const ausstehend = rows.filter(r => ['ausstehend','veranlasst'].includes(r.status)).reduce((s,r) => s + parseFloat(r.netto), 0);

    res.json({ auszahlungen: rows, gesamt: gesamt.toFixed(2), ausstehend: ausstehend.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// ── ADMIN ─────────────────────────────────────────────────────

// GET /api/erzeuger (Admin)
router.get('/', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT e.*, u.email,
        COUNT(DISTINCT z.id) FILTER (WHERE z.status = 'verified') AS zert_count,
        COUNT(DISTINCT c.id) AS commitment_count
      FROM erzeuger e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN zertifikate z ON z.erzeuger_id = e.id
      LEFT JOIN commitments c ON c.erzeuger_id = e.id
      GROUP BY e.id, u.email
      ORDER BY e.created_at DESC
    `);
    res.json({ erzeuger: rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/erzeuger/zertifikate/pending (Admin)
router.get('/zertifikate/pending', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT z.*, e.betrieb_name, u.email
      FROM zertifikate z
      JOIN erzeuger e ON e.id = z.erzeuger_id
      JOIN users u ON u.id = e.user_id
      WHERE z.status = 'pending'
      ORDER BY z.created_at ASC
    `);
    res.json({ zertifikate: rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// PUT /api/erzeuger/zertifikate/:id/status (Admin) — mit E-Mail
router.put('/zertifikate/:id/status', auth, role('admin'), async (req, res) => {
  const { status } = req.body;
  if (!['verified', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Ungültiger Status' });
  }
  try {
    const { rows: [z] } = await db.query(`
      UPDATE zertifikate SET status=$1, geprueft_von=$2, geprueft_am=NOW()
      WHERE id=$3 RETURNING *
    `, [status, req.user.id, req.params.id]);
    if (!z) return res.status(404).json({ error: 'Zertifikat nicht gefunden' });

    // E-Mail an Erzeuger
    try {
      const { rows: [detail] } = await db.query(`
        SELECT u.email, e.betrieb_name FROM zertifikate zz
        JOIN erzeuger e ON e.id = zz.erzeuger_id
        JOIN users u ON u.id = e.user_id
        WHERE zz.id = $1
      `, [z.id]);

      if (detail) {
        const fn = status === 'verified'
          ? email.sendZertifikatVerifiziert
          : email.sendZertifikatAbgelehnt;

        fn({
          erzeugerEmail: detail.email,
          erzeugerName:  detail.betrieb_name,
          zertifikat:    z,
        }).catch(e => console.warn('[email zert]', e.message));
      }
    } catch (emailErr) {
      console.warn('[email]', emailErr.message);
    }

    res.json({ zertifikat: z });
  } catch (err) {
    res.status(500).json({ error: 'Status konnte nicht gesetzt werden' });
  }
});


// GET /api/erzeuger/detail/:id (Admin)
router.get('/detail/:id', auth, role('admin'), async (req, res) => {
  try {
    const { rows: [e] } = await db.query(
      `SELECT e.*, u.email FROM erzeuger e JOIN users u ON u.id=e.user_id WHERE e.id=$1`,
      [req.params.id]
    );
    if (!e) return res.status(404).json({ error: 'Nicht gefunden' });

    const [{ rows: zertifikate }, { rows: commitments }, { rows: auszahlungen }] = await Promise.all([
      db.query(`SELECT * FROM zertifikate WHERE erzeuger_id=$1 ORDER BY created_at DESC`,[e.id]),
      db.query(`SELECT c.*,p.produkt,p.lieferwoche FROM commitments c JOIN pools p ON p.id=c.pool_id WHERE c.erzeuger_id=$1 ORDER BY c.created_at DESC LIMIT 10`,[e.id]),
      db.query(`SELECT a.*,p.produkt,p.lieferwoche FROM auszahlungen a JOIN commitments c ON c.id=a.commitment_id JOIN pools p ON p.id=c.pool_id WHERE a.erzeuger_id=$1 ORDER BY a.created_at DESC LIMIT 10`,[e.id]),
    ]);

    res.json({ erzeuger: e, zertifikate, commitments, auszahlungen });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Fehler' });
  }
});


// GET /api/erzeuger/export/csv – Admin exportiert Erzeuger-Liste als CSV
router.get('/export/csv', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT e.betrieb_name, u.email, e.region, e.adresse, e.plz, e.ort,
             e.telefon, e.iban, e.ust_id, e.sortiment, e.max_kapazitaet,
             COUNT(DISTINCT c.id)::int AS commitments,
             COALESCE(SUM(a.netto),0)::numeric(10,2) AS ausgezahlt_gesamt,
             e.created_at::date
      FROM erzeuger e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN commitments c ON c.erzeuger_id = e.id
      LEFT JOIN auszahlungen a ON a.erzeuger_id = e.id AND a.status='ausgezahlt'
      GROUP BY e.id, u.email
      ORDER BY e.betrieb_name
    `);

    const headers = ['Betrieb','E-Mail','Region','Adresse','PLZ','Ort','Telefon','IBAN','USt-ID','Sortiment','Kapazität (kg/Wo)','Commitments','Ausgezahlt (€)','Mitglied seit'];
    const rows_csv = rows.map(r => [
      r.betrieb_name, r.email, r.region||'', r.adresse||'', r.plz||'', r.ort||'',
      r.telefon||'', r.iban||'', r.ust_id||'', r.sortiment||'', r.max_kapazitaet||'',
      r.commitments, r.ausgezahlt_gesamt, r.created_at,
    ].map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(';'));

    const csv = [headers.join(';'), ...rows_csv].join('\n');
    const filename = `frischkette-erzeuger-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM für Excel
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
