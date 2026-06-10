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


// GET /api/rechnungen/:id/download – Rechnung als echter PDF-Download (pdfkit)
router.get('/:id/download', auth, async (req, res) => {
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
    if (req.user.role === 'erzeuger') {
      const { rows:[erz] } = await db.query(`SELECT id FROM erzeuger WHERE user_id=$1`,[req.user.id]);
      if (!erz || erz.id !== r.erzeuger_id) return res.status(403).send('Kein Zugriff');
    }

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const filename = `Rechnung-${r.rechnungs_nr}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const G = '#2e7d3e';
    const DARK = '#0d1f15';
    const GRAY = '#8a9484';
    const W = 495; // usable width

    // ── Logo ─────────────────────────────────────────────────────
    doc.fontSize(20).font('Helvetica-Bold').fillColor(DARK).text('Frisch', 60, 60, { continued: true });
    doc.fillColor(G).text('Kette');
    doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Regionale Lieferkooperative', 60, 85);

    // ── Rechts: Datum, Status ─────────────────────────────────────
    const datum = new Date(r.rechnungsdatum).toLocaleDateString('de-DE');
    const leist = r.leistungsdatum ? new Date(r.leistungsdatum).toLocaleDateString('de-DE') : datum;
    doc.fontSize(9).font('Helvetica').fillColor(GRAY)
       .text(`Rechnungsdatum: ${datum}`, 60, 60, { align: 'right', width: W })
       .text(`Leistungsdatum: ${leist}`, 60, 72, { align: 'right', width: W })
       .text(`Status: ${r.status}`,      60, 84, { align: 'right', width: W });

    // ── Trennlinie ────────────────────────────────────────────────
    doc.moveTo(60, 105).lineTo(555, 105).lineWidth(1.5).strokeColor(DARK).stroke();

    // ── Titel ─────────────────────────────────────────────────────
    doc.fontSize(16).font('Helvetica-Bold').fillColor(DARK).text('Abrechnung / Gutschrift', 60, 120);
    doc.fontSize(10).font('Helvetica').fillColor(GRAY).text(`Rechnungs-Nr.: ${r.rechnungs_nr}`, 60, 142);

    // ── Adressblock ───────────────────────────────────────────────
    const adrY = 175;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY)
       .text('LEISTUNGSERBRINGER (ERZEUGER:IN)', 60, adrY)
       .text('AUFTRAGGEBER (PLATTFORM)', 310, adrY);

    doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK)
       .text(r.betrieb_name, 60, adrY + 14)
       .text('FrischKette / superhecht.ai', 310, adrY + 14);
    doc.fontSize(9).font('Helvetica').fillColor(DARK)
       .text([r.erz_adresse, `${r.erz_plz||''} ${r.erz_ort||''}`, r.erz_email,
              r.ust_id ? `USt-ID: ${r.ust_id}` : '(USt-ID fehlt)'].filter(Boolean).join('\n'), 60, adrY + 27)
       .text('Lackgässchen 24\n50968 Köln\nrusniok@googlemail.com', 310, adrY + 27);

    // ── Tabelle ───────────────────────────────────────────────────
    const tY = 290;
    // Header
    doc.rect(60, tY, W, 20).fill(DARK);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff');
    doc.text('Pos.', 66, tY+6, { width: 25 });
    doc.text('Leistungsbeschreibung', 95, tY+6, { width: 230 });
    doc.text('Netto (€)', 330, tY+6, { width: 60, align: 'right' });
    const mwstSatz = parseFloat(r.mwst_satz).toFixed(0);
    doc.text(`MwSt. ${mwstSatz}%`, 395, tY+6, { width: 60, align: 'right' });
    doc.text('Brutto (€)', 460, tY+6, { width: 90, align: 'right' });

    // Row 1
    const row1Y = tY + 22;
    doc.rect(60, row1Y, W, 22).fill('#f9faf7');
    doc.fontSize(9).font('Helvetica').fillColor(DARK);
    doc.text('1', 66, row1Y+7, { width: 25 });
    doc.text(r.leistung_beschr || '', 95, row1Y+7, { width: 230 });
    doc.text(parseFloat(r.netto).toFixed(2), 330, row1Y+7, { width: 60, align: 'right' });
    doc.text(parseFloat(r.mwst).toFixed(2),  395, row1Y+7, { width: 60, align: 'right' });
    doc.text(parseFloat(r.brutto).toFixed(2),460, row1Y+7, { width: 90, align: 'right' });

    // Summenzeilen
    const s1Y = row1Y + 26;
    doc.rect(60, s1Y, W, 18).fill('#f0f1ee');
    doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK);
    doc.text('Summe Netto', 66, s1Y+5, { width: 360 });
    doc.text(`${parseFloat(r.netto).toFixed(2)} €`, 66, s1Y+5, { width: W-10, align: 'right' });

    const s2Y = s1Y + 20;
    doc.rect(60, s2Y, W, 18).fill('#ffffff');
    doc.fontSize(9).font('Helvetica').fillColor(DARK);
    doc.text(`zzgl. Umsatzsteuer ${mwstSatz}% (Lebensmittel)`, 66, s2Y+5, { width: 360 });
    doc.text(`${parseFloat(r.mwst).toFixed(2)} €`, 66, s2Y+5, { width: W-10, align: 'right' });

    const s3Y = s2Y + 22;
    doc.rect(60, s3Y, W, 22).fill('#eaf4ec');
    doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK);
    doc.text('Gesamtbetrag Brutto', 66, s3Y+6, { width: 360 });
    doc.text(`${parseFloat(r.brutto).toFixed(2)} €`, 66, s3Y+6, { width: W-10, align: 'right' });

    // ── Hinweis ───────────────────────────────────────────────────
    const hinweisY = s3Y + 40;
    doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
       .text(
         `Hinweis: Diese Abrechnung wird gemäß §14 UStG als Gutschrift ausgestellt. ` +
         `Die Zahlung erfolgt per SEPA-Überweisung. ` +
         `Lebensmittel unterliegen dem ermäßigten Umsatzsteuersatz von ${mwstSatz}% (§12 Abs. 2 UStG).`,
         60, hinweisY, { width: W, lineGap: 2 }
       );

    // ── Footer ─────────────────────────────────────────────────────
    doc.moveTo(60, 770).lineTo(555, 770).lineWidth(0.5).strokeColor(GRAY).stroke();
    doc.fontSize(8).font('Helvetica').fillColor(GRAY)
       .text(
         `FrischKette · superhecht.ai (i.Gr.) · Lackgässchen 24 · 50968 Köln · Rechnungs-Nr.: ${r.rechnungs_nr}`,
         60, 775, { width: W, align: 'center' }
       );

    doc.end();
  } catch(err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
