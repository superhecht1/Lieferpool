/**
 * Rechnungsstellung für FrischKette
 * Erzeuger bekommen ordnungsgemäße Abrechnungsbelege nach deutschem Recht
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

function rechnungsNr() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth()+1).padStart(2,'0');
  const ran = Math.random().toString(36).slice(2,6).toUpperCase();
  return `FK-${y}${m}-${ran}`;
}

function mwstBerechnen(netto, satz = 7.00) {
  const mwst   = Math.round(netto * (satz/100) * 100) / 100;
  const brutto = Math.round((netto + mwst) * 100) / 100;
  return { netto, mwst, brutto, satz };
}

// GET /api/rechnungen – Rechnungen eines Erzeugers / alle (Admin)
router.get('/', auth, async (req, res) => {
  try {
    let query, params;
    if (req.user.role === 'admin') {
      query  = `SELECT r.*, e.betrieb_name, u.email
                FROM rechnungen r
                JOIN erzeuger e ON e.id=r.erzeuger_id
                JOIN users u ON u.id=e.user_id
                ORDER BY r.rechnungsdatum DESC LIMIT 200`;
      params = [];
    } else {
      const { rows:[erz] } = await db.query(`SELECT id FROM erzeuger WHERE user_id=$1`,[req.user.id]);
      if (!erz) return res.json({ rechnungen: [] });
      query  = `SELECT r.* FROM rechnungen r WHERE r.erzeuger_id=$1 ORDER BY r.rechnungsdatum DESC`;
      params = [erz.id];
    }
    const { rows } = await db.query(query, params);
    res.json({ rechnungen: rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rechnungen/erstellen – Rechnung für Auszahlung erstellen
router.post('/erstellen', auth, role('admin'), async (req, res) => {
  const { auszahlung_id, mwst_satz = 7.00 } = req.body;
  if (!auszahlung_id) return res.status(400).json({ error: 'auszahlung_id erforderlich' });

  try {
    const { rows:[az] } = await db.query(`
      SELECT a.*, e.betrieb_name, e.adresse, e.plz, e.ort, e.ust_id, e.iban,
             eu.email, eu.name AS erzeuger_user_name,
             l.lieferschein_nr, l.lieferdatum, p.produkt, p.lieferwoche,
             a.menge AS liefermenge
      FROM auszahlungen a
      JOIN erzeuger e ON e.id=a.erzeuger_id
      JOIN users eu ON eu.id=e.user_id
      LEFT JOIN lieferungen l ON l.id=a.lieferung_id
      LEFT JOIN pools p ON p.id=l.pool_id
      WHERE a.id=$1
    `, [auszahlung_id]);

    if (!az) return res.status(404).json({ error: 'Auszahlung nicht gefunden' });

    // Doppelt prüfen
    const { rows:[exists] } = await db.query(
      `SELECT id FROM rechnungen WHERE auszahlung_id=$1`, [auszahlung_id]
    );
    if (exists) return res.status(409).json({ error: 'Rechnung bereits erstellt', id: exists.id });

    const netto   = parseFloat(az.netto || az.brutto || 0);
    const { mwst, brutto, satz } = mwstBerechnen(netto, mwst_satz);
    const nr      = rechnungsNr();
    const beschr  = az.produkt
      ? `Lieferung ${az.produkt} · KW ${az.lieferwoche} · ${az.liefermenge || ''} kg · Lieferschein ${az.lieferschein_nr || '—'}`
      : `Lieferung gemäß Lieferschein ${az.lieferschein_nr || '—'}`;

    const { rows:[rech] } = await db.query(`
      INSERT INTO rechnungen (
        rechnungs_nr, erzeuger_id, auszahlung_id, lieferung_id,
        leistungsdatum, leistung_beschr,
        netto, mwst_satz, mwst, brutto
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [nr, az.erzeuger_id, auszahlung_id, az.lieferung_id,
        az.lieferdatum || new Date().toISOString().slice(0,10),
        beschr, netto, satz, mwst, brutto]);

    // MwSt. in Auszahlung aktualisieren
    await db.query(`
      UPDATE auszahlungen SET netto_betrag=$1, mwst_betrag=$2, brutto_betrag=$3, mwst_satz=$4
      WHERE id=$5
    `, [netto, mwst, brutto, satz, auszahlung_id]);

    // E-Mail an Erzeuger
    try {
      const email = require('../services/email');
      await email.send({
        to: { email: az.email, name: az.betrieb_name },
        subject: `FrischKette Abrechnung ${nr}`,
        html: `<h2>Abrechnung ${nr}</h2>
          <p>Liebe:r ${az.betrieb_name},</p>
          <p>Ihre Abrechnung für die Lieferung ist erstellt:</p>
          <table style="border-collapse:collapse;width:100%;max-width:400px">
            <tr><td style="padding:4px 0;color:#666">Leistung</td><td>${beschr}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Nettobetrag</td><td>${netto.toFixed(2)} €</td></tr>
            <tr><td style="padding:4px 0;color:#666">MwSt. ${satz}%</td><td>${mwst.toFixed(2)} €</td></tr>
            <tr style="font-weight:bold"><td style="padding:4px 0">Bruttobetrag</td><td>${brutto.toFixed(2)} €</td></tr>
          </table>
          <p>Die SEPA-Überweisung erfolgt gemäß Vereinbarung. Das Belegdokument können Sie in Ihrem Dashboard herunterladen.</p>
          <a href="${process.env.APP_URL||''}/erzeuger" style="background:#2e7d3e;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:12px">Zum Dashboard</a>`,
      }).catch(()=>{});
    } catch {}

    res.status(201).json({ rechnung: rech });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rechnungen/:id/pdf – Rechnung als HTML-Druckansicht
router.get('/:id/pdf', auth, async (req, res) => {
  try {
    const { rows:[r] } = await db.query(`
      SELECT r.*,
             e.betrieb_name, e.adresse AS erz_adresse, e.plz AS erz_plz,
             e.ort AS erz_ort, e.ust_id,
             u.email AS erz_email
      FROM rechnungen r
      JOIN erzeuger e ON e.id=r.erzeuger_id
      JOIN users u ON u.id=e.user_id
      WHERE r.id=$1
    `, [req.params.id]);

    if (!r) return res.status(404).send('Rechnung nicht gefunden');

    // Zugangsprüfung
    if (req.user.role === 'erzeuger') {
      const { rows:[erz] } = await db.query(`SELECT id FROM erzeuger WHERE user_id=$1`,[req.user.id]);
      if (!erz || erz.id !== r.erzeuger_id) return res.status(403).send('Kein Zugriff');
    }

    const datum = new Date(r.rechnungsdatum).toLocaleDateString('de-DE');
    const leist = r.leistungsdatum ? new Date(r.leistungsdatum).toLocaleDateString('de-DE') : datum;

    const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Rechnung ${r.rechnungs_nr}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Arial,sans-serif; font-size:13px; color:#171d13; background:#fff; padding:2cm; }
  .logo { font-size:1.6rem; font-weight:800; color:#0d1f15; letter-spacing:-.01em; margin-bottom:.25rem; }
  .logo span { color:#c8912a; }
  .header { display:flex; justify-content:space-between; margin-bottom:2rem; padding-bottom:1rem; border-bottom:2px solid #0d1f15; }
  .title { font-size:1.4rem; font-weight:700; color:#0d1f15; margin:2rem 0 .5rem; }
  .rech-nr { font-size:.85rem; color:#8a9a84; }
  .adr-box { display:flex; gap:3cm; margin-bottom:2rem; }
  .adr h4 { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:#8a9a84; margin-bottom:.5rem; }
  table { width:100%; border-collapse:collapse; margin-bottom:1.5rem; }
  th { background:#0d1f15; color:#fff; padding:8px 10px; text-align:left; font-size:12px; }
  td { padding:8px 10px; border-bottom:1px solid #dde0d8; vertical-align:top; }
  .tr-total { font-weight:700; background:#faf7f0; }
  .tr-brutto { font-weight:700; font-size:1rem; background:#eaf4ec; }
  .amount { text-align:right; font-family:'Courier New',monospace; }
  .footer { margin-top:3rem; padding-top:1rem; border-top:1px solid #dde0d8; font-size:11px; color:#8a9a84; }
  .badge { display:inline-block; background:#eaf4ec; color:#2e7d3e; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; }
  @media print { button { display:none } }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="logo">Frisch<span>Kette</span></div>
    <div style="font-size:12px;color:#4a5244;margin-top:.25rem">superhecht.ai (i.Gr.)<br>Lackgässchen 24 · 50968 Köln<br>rusniok@googlemail.com</div>
  </div>
  <div style="text-align:right">
    <button onclick="window.print()" style="background:#0d1f15;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:12px;margin-bottom:.5rem">🖨 Drucken</button>
    <div style="font-size:11px;color:#8a9a84">Rechnungsdatum: ${datum}</div>
    <div style="font-size:11px;color:#8a9a84">Leistungsdatum: ${leist}</div>
    <div style="margin-top:.25rem"><span class="badge">${r.status}</span></div>
  </div>
</div>

<div class="title">Abrechnung / Gutschrift</div>
<div class="rech-nr">Rechnungs-Nr.: <strong>${r.rechnungs_nr}</strong></div>

<div class="adr-box" style="margin-top:1.5rem">
  <div class="adr">
    <h4>Leistungserbringer (Erzeuger:in)</h4>
    <strong>${r.betrieb_name}</strong><br>
    ${r.erz_adresse||''}<br>
    ${r.erz_plz||''} ${r.erz_ort||''}<br>
    ${r.erz_email}<br>
    ${r.ust_id ? `USt-ID: ${r.ust_id}` : '<em style="color:#c62828">USt-ID fehlt — bitte im Profil ergänzen</em>'}
  </div>
  <div class="adr">
    <h4>Auftraggeber (Plattform)</h4>
    <strong>FrischKette / superhecht.ai</strong><br>
    Lackgässchen 24<br>
    50968 Köln<br>
    rusniok@googlemail.com
  </div>
</div>

<table>
  <thead>
    <tr><th>Pos.</th><th>Leistungsbeschreibung</th><th class="amount">Netto (€)</th><th class="amount">MwSt. ${parseFloat(r.mwst_satz).toFixed(0)}%</th><th class="amount">Brutto (€)</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>1</td>
      <td>${r.leistung_beschr}</td>
      <td class="amount">${parseFloat(r.netto).toFixed(2)}</td>
      <td class="amount">${parseFloat(r.mwst).toFixed(2)}</td>
      <td class="amount">${parseFloat(r.brutto).toFixed(2)}</td>
    </tr>
    <tr class="tr-total">
      <td colspan="2">Summe Netto</td>
      <td class="amount" colspan="3">${parseFloat(r.netto).toFixed(2)} €</td>
    </tr>
    <tr>
      <td colspan="2">zzgl. Umsatzsteuer ${parseFloat(r.mwst_satz).toFixed(0)}% (Lebensmittel)</td>
      <td class="amount" colspan="3">${parseFloat(r.mwst).toFixed(2)} €</td>
    </tr>
    <tr class="tr-brutto">
      <td colspan="2">Gesamtbetrag Brutto</td>
      <td class="amount" colspan="3">${parseFloat(r.brutto).toFixed(2)} €</td>
    </tr>
  </tbody>
</table>

<div style="font-size:12px;color:#4a5244;line-height:1.7">
  <strong>Hinweis:</strong> Diese Abrechnung wird gemäß §14 UStG als Gutschrift ausgestellt. Die Zahlung erfolgt per SEPA-Überweisung.<br>
  Lebensmittel unterliegen dem ermäßigten Umsatzsteuersatz von ${parseFloat(r.mwst_satz).toFixed(0)}% (§12 Abs. 2 UStG).
</div>

<div class="footer">
  FrischKette · superhecht.ai (i.Gr.) · Lackgässchen 24 · 50968 Köln ·
  Steuer-Nr.: [bitte ergänzen] · Rechnungs-Nr.: ${r.rechnungs_nr}
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rechnungen/:id/stornieren
router.post('/:id/stornieren', auth, role('admin'), async (req, res) => {
  try {
    await db.query(`UPDATE rechnungen SET status='storniert' WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Rechnung storniert' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
