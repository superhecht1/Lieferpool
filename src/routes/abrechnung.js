/**
 * abrechnung.js – Monatliche Lieferabrechnung je Abnehmer (Caterer)
 * Ablage: src/routes/abrechnung.js · Einbinden: app.use('/api/abrechnung', require('./routes/abrechnung'));
 *   GET /api/abrechnung?monat=YYYY-MM[&caterer_id=…]      → JSON
 *   GET /api/abrechnung/pdf?monat=YYYY-MM[&caterer_id=…]  → PDF
 * Caterer sehen nur ihre eigenen Daten, Admin wählt über caterer_id.
 * WICHTIG: Das Dokument ist eine Übersicht über bestätigte Wareneingänge, KEINE Rechnung im Sinne des UStG.
 */
const express = require('express');
const db = require('../db');
const { auth, role } = require('../middleware/auth');
const router = express.Router();

async function laden(req) {
  const monat = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.monat || '') ? req.query.monat : new Date().toISOString().slice(0, 7);
  let catererId = req.query.caterer_id || null;
  if (req.user.role === 'caterer') {
    const { rows: [c] } = await db.query(`SELECT id FROM caterer WHERE user_id = $1`, [req.user.id]);
    if (!c) return { fehler: 'Kein Caterer-Profil' };
    catererId = c.id;
  }
  if (!catererId) return { fehler: 'caterer_id erforderlich' };
  const { rows: [cat] } = await db.query(`SELECT id, firma_name, adresse, plz, ort FROM caterer WHERE id = $1`, [catererId]);
  if (!cat) return { fehler: 'Caterer nicht gefunden' };
  const { rows } = await db.query(`
    SELECT l.id, l.lieferschein_nr, COALESCE(l.wareneingang_at::date, l.lieferdatum, l.created_at::date) AS datum,
           p.produkt, p.einheit, p.preis_pro_einheit::float AS preis, COALESCE(l.menge_geliefert, 0)::float AS menge
    FROM lieferungen l JOIN pools p ON p.id = l.pool_id
    WHERE p.caterer_id = $1 AND l.status = 'eingegangen'
      AND to_char(COALESCE(l.wareneingang_at::date, l.lieferdatum, l.created_at::date), 'YYYY-MM') = $2
    ORDER BY datum, l.lieferschein_nr`, [catererId, monat]);
  const positionen = rows.map(r => ({ ...r, summe: Math.round(r.menge * r.preis * 100) / 100 }));
  const summe = Math.round(positionen.reduce((s, p) => s + p.summe, 0) * 100) / 100;
  return { monat, caterer: cat, positionen, summe };
}

router.get('/', auth, role('caterer', 'admin'), async (req, res) => {
  try { const d = await laden(req); if (d.fehler) return res.status(400).json({ error: d.fehler }); res.json(d); }
  catch (e) { res.status(500).json({ error: 'Abrechnung konnte nicht erstellt werden' }); }
});

router.get('/pdf', auth, role('caterer', 'admin'), async (req, res) => {
  try {
    const d = await laden(req); if (d.fehler) return res.status(400).json({ error: d.fehler });
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="lieferabrechnung_${d.monat}.pdf"`);
    doc.pipe(res);
    const eur = v => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    const num = v => v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
    doc.fontSize(20).fillColor('#2e7d3e').text('Lieferabrechnung', 50, 50);
    doc.fontSize(10).fillColor('#555').text(`LieferPool · Monat ${d.monat.slice(5)}/${d.monat.slice(0, 4)}`);
    doc.moveDown(1).fillColor('#000').fontSize(11).text(d.caterer.firma_name || '');
    doc.fontSize(9).fillColor('#555').text([d.caterer.adresse, [d.caterer.plz, d.caterer.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '));
    doc.moveDown(1.2);
    const cols = [['Datum', 62], ['Lieferschein', 90], ['Produkt', 150], ['Menge', 60], ['Preis', 60], ['Summe', 73]];
    const row = (cells, bold) => {
      if (doc.y > 750) doc.addPage();
      const y = doc.y; let x = 50;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000');
      cells.forEach((c, i) => { doc.text(String(c), x, y, { width: cols[i][1] - 4, lineBreak: false, ellipsis: true, align: i >= 3 ? 'right' : 'left' }); x += cols[i][1]; });
      doc.y = y + 15;
      if (bold) doc.moveTo(50, doc.y - 3).lineTo(545, doc.y - 3).strokeColor('#999').stroke();
    };
    row(cols.map(c => c[0]), true);
    if (!d.positionen.length) doc.font('Helvetica').fontSize(9).fillColor('#666').text('Keine bestätigten Wareneingänge in diesem Monat.', 50, doc.y + 4);
    d.positionen.forEach(p => row([new Date(p.datum).toLocaleDateString('de-DE'), p.lieferschein_nr || '', p.produkt || '', `${num(p.menge)} ${p.einheit || 'kg'}`, eur(p.preis), eur(p.summe)]));
    doc.moveDown(.8); doc.moveTo(350, doc.y).lineTo(545, doc.y).strokeColor('#999').stroke();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(`Summe: ${eur(d.summe)}`, 50, doc.y + 6, { width: 495, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#666').text(
      'Hinweis: Diese Übersicht fasst die im Monat bestätigten Wareneingänge zusammen und ist keine Rechnung im Sinne des Umsatzsteuergesetzes. ' +
      'Maßgeblich sind die Rechnungen bzw. Gutschriften der liefernden Betriebe. Preise netto/wie im Pool vereinbart.', 50, doc.y + 24, { width: 495 });
    doc.end();
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: 'PDF konnte nicht erstellt werden' }); }
});

module.exports = router;
