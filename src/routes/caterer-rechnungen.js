/**
 * caterer-rechnungen.js – Ausgangsrechnungen an Caterer (Betreiber → Caterer)
 * Ablage: backend/src/routes/caterer-rechnungen.js · app.use('/api/caterer-rechnungen', require('./routes/caterer-rechnungen'));
 *   GET  /caterer                 (Admin)  Caterer-Auswahl
 *   GET  /vorschau?caterer_id&monat (Admin) noch nicht abgerechnete Wareneingänge
 *   POST /erstellen {caterer_id, monat, mwst_satz=7, zahlungsziel_tage=14} (Admin)
 *   GET  /                         Liste (Admin: alle, Caterer: eigene)
 *   GET  /:id/pdf                  PDF (Admin / eigener Caterer)
 *   POST /:id/bezahlt              (Admin) Zahlungseingang vermerken
 *   POST /:id/stornieren           (Admin) erzeugt Storno-Rechnung (negativ), gibt Lieferungen wieder frei
 * Pflichtangaben nach § 14 UStG: Absender/Empfänger, Steuernummer oder USt-IdNr., Datum, fortlaufende Nr., Leistung,
 * Leistungszeitraum, Entgelt, Steuersatz und -betrag. Absenderdaten per Umgebungsvariablen (FIRMA_*).
 * Pfand wird NICHT auf der Rechnung geführt, sondern im Pfand-Kontoauszug (steuerliche Behandlung mit der Steuerberatung klären).
 */
const express = require('express');
const db = require('../db');
const { auth, role } = require('../middleware/auth');
const gebuehr = require('../services/gebuehr');
const router = express.Router();

const r2 = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const firma = () => ({
  name: process.env.FIRMA_NAME || 'Mark Rusniok (superhecht.ai)',
  strasse: process.env.FIRMA_STRASSE || 'Gottesweg 20',
  ort: process.env.FIRMA_ORT || '50969 Köln',
  ustid: process.env.FIRMA_USTID || '', steuernr: process.env.FIRMA_STEUERNR || '',
  iban: process.env.FIRMA_IBAN || '', bic: process.env.FIRMA_BIC || '', bank: process.env.FIRMA_BANK || '',
  email: process.env.FIRMA_EMAIL || 'info@think-cloud.org',
});
const validMonat = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
const POS_SQL = `
  SELECT l.id AS lieferung_id, l.lieferschein_nr, COALESCE(l.wareneingang_at::date, l.lieferdatum, l.created_at::date) AS datum,
         p.produkt, p.einheit, p.preis_pro_einheit::float AS preis, COALESCE(l.menge_geliefert,0)::float AS menge
  FROM lieferungen l JOIN pools p ON p.id = l.pool_id
  WHERE p.caterer_id = $1 AND l.status = 'eingegangen'
    AND to_char(COALESCE(l.wareneingang_at::date, l.lieferdatum, l.created_at::date), 'YYYY-MM') = $2
    AND NOT EXISTS (SELECT 1 FROM caterer_rechnung_positionen x WHERE x.lieferung_id = l.id AND x.aktiv)
  ORDER BY datum, l.lieferschein_nr`;

router.get('/caterer', auth, role('admin'), async (req, res) => {
  try { res.json({ caterer: (await db.query(`SELECT id, firma_name FROM caterer ORDER BY firma_name`)).rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/vorschau', auth, role('admin'), async (req, res) => {
  if (!validMonat(req.query.monat) || !req.query.caterer_id) return res.status(400).json({ error: 'caterer_id und monat (YYYY-MM) erforderlich' });
  try {
    const { rows } = await db.query(POS_SQL, [req.query.caterer_id, req.query.monat]);
    const netto = r2(rows.reduce((s, p) => s + r2(p.menge * p.preis), 0));
    const gp = gebuehr.kuecheProzent();
    res.json({ anzahl: rows.length, netto, gebuehr_prozent: gp, gebuehr_netto: r2(netto * gp / 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Einnahmen aus der Servicegebühr je Monat (Admin): Küchenseite = Rechnungen nach Storno, Hofseite = Abzug bei Auszahlungen
router.get('/gebuehren', auth, role('admin'), async (req, res) => {
  try {
    const monat = validMonat(req.query.monat) ? req.query.monat : new Date().toISOString().slice(0, 7);
    const { rows: [k] } = await db.query(`SELECT COALESCE(SUM(gebuehr_netto),0)::float AS netto, COALESCE(SUM(gebuehr_mwst),0)::float AS mwst,
        COUNT(*) FILTER (WHERE typ='rechnung')::int AS rechnungen
      FROM caterer_rechnungen WHERE to_char(rechnungsdatum,'YYYY-MM') = $1`, [monat]);
    const { rows: [h] } = await db.query(`SELECT COALESCE(SUM(platform_fee),0)::float AS summe, COUNT(*)::int AS anzahl
      FROM auszahlungen WHERE status <> 'fehlgeschlagen' AND to_char(created_at,'YYYY-MM') = $1`, [monat]);
    res.json({ monat, kueche_netto: r2(k.netto), kueche_mwst: r2(k.mwst), kueche_rechnungen: k.rechnungen,
               hof: r2(h.summe), hof_auszahlungen: h.anzahl, gesamt_netto: r2(k.netto + h.summe) });
  } catch (e) { res.status(500).json({ error: 'Gebühreneinnahmen konnten nicht geladen werden' }); }
});

router.post('/erstellen', auth, role('admin'), async (req, res) => {
  const { caterer_id, monat } = req.body;
  const satz = Number(req.body.mwst_satz ?? 7), tage = Math.min(90, Math.max(0, parseInt(req.body.zahlungsziel_tage ?? 14)));
  if (!caterer_id || !validMonat(monat)) return res.status(400).json({ error: 'caterer_id und monat (YYYY-MM) erforderlich' });
  if (![0, 7, 19].includes(satz)) return res.status(400).json({ error: 'Steuersatz muss 0, 7 oder 19 sein' });
  const f = firma();
  if (!f.ustid && !f.steuernr) return res.status(400).json({ error: 'Pflichtangabe fehlt: FIRMA_USTID oder FIRMA_STEUERNR in den Render-Umgebungsvariablen setzen' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [cat] } = await client.query(`SELECT id, firma_name, adresse, plz, ort, ust_id FROM caterer WHERE id=$1`, [caterer_id]);
    if (!cat) throw Object.assign(new Error('Caterer nicht gefunden'), { status: 404 });
    if (!cat.firma_name || !cat.adresse || !cat.ort) throw Object.assign(new Error('Caterer-Anschrift unvollständig (Name, Straße, Ort) – im Profil ergänzen'), { status: 400 });
    const { rows: pos } = await client.query(POS_SQL, [caterer_id, monat]);
    if (!pos.length) throw Object.assign(new Error('Keine offenen Wareneingänge in diesem Monat'), { status: 409 });
    const zeilen = pos.map(p => ({ ...p, summe: r2(p.menge * p.preis) }));
    const netto = r2(zeilen.reduce((s, p) => s + p.summe, 0)), mwst = r2(netto * satz / 100);
    // Servicegebühr (Küchenseite): eigene Zeile, eigener Steuersatz, Prozentsatz wird festgeschrieben
    const gProz = gebuehr.kuecheProzent(), gSatz = gebuehr.kucheMwst();
    const gNetto = r2(netto * gProz / 100), gMwst = r2(gNetto * gSatz / 100);
    const brutto = r2(netto + mwst + gNetto + gMwst);
    const jahr = new Date().getFullYear();
    const { rows: [n] } = await client.query(`INSERT INTO rechnungsnummern (jahr, letzte) VALUES ($1,1)
      ON CONFLICT (jahr) DO UPDATE SET letzte = rechnungsnummern.letzte + 1 RETURNING letzte`, [jahr]);
    const nr = `RE-${jahr}-${String(n.letzte).padStart(5, '0')}`;
    const daten = zeilen.map(z => z.datum);
    const von = new Date(Math.min(...daten.map(d => +new Date(d)))).toISOString().slice(0, 10);
    const bis = new Date(Math.max(...daten.map(d => +new Date(d)))).toISOString().slice(0, 10);
    const { rows: [re] } = await client.query(`
      INSERT INTO caterer_rechnungen (rechnungs_nr, caterer_id, monat, leistung_von, leistung_bis, zahlungsziel, mwst_satz, netto, mwst, brutto, empfaenger, created_by,
        gebuehr_prozent, gebuehr_netto, gebuehr_mwst_satz, gebuehr_mwst)
      VALUES ($1,$2,$3,$4,$5, CURRENT_DATE + $6::int, $7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [nr, caterer_id, monat, von, bis, tage, satz, netto, mwst, brutto,
       JSON.stringify({ name: cat.firma_name, adresse: cat.adresse, plzort: [cat.plz, cat.ort].filter(Boolean).join(' '), ust_id: cat.ust_id || null }), req.user.id, gProz, gNetto, gSatz, gMwst]);
    for (const z of zeilen) await client.query(`INSERT INTO caterer_rechnung_positionen
      (rechnung_id, lieferung_id, lieferschein_nr, datum, produkt, menge, einheit, preis, summe) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [re.id, z.lieferung_id, z.lieferschein_nr, z.datum, z.produkt, z.menge, z.einheit || 'kg', z.preis, z.summe]);
    await client.query('COMMIT');
    res.status(201).json({ rechnung: re });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ error: 'Eine dieser Lieferungen wurde gerade bereits abgerechnet – bitte neu laden' });
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Rechnung konnte nicht erstellt werden' });
  } finally { client.release(); }
});

async function eigenerCatererId(req) {
  if (req.user.role !== 'caterer') return null;
  const { rows: [c] } = await db.query(`SELECT id FROM caterer WHERE user_id=$1`, [req.user.id]);
  return c?.id || '00000000-0000-0000-0000-000000000000';
}

router.get('/', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const cid = await eigenerCatererId(req);
    const { rows } = await db.query(`
      SELECT r.id, r.rechnungs_nr, r.typ, r.monat, r.rechnungsdatum, r.zahlungsziel, r.mwst_satz, (r.netto + r.gebuehr_netto) AS netto, (r.mwst + r.gebuehr_mwst) AS mwst, r.brutto, r.status, r.bezahlt_am, c.firma_name
      FROM caterer_rechnungen r JOIN caterer c ON c.id = r.caterer_id
      WHERE ($1::uuid IS NULL OR r.caterer_id = $1) ORDER BY r.created_at DESC LIMIT 200`, [cid]);
    res.json({ rechnungen: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/pdf', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Ungültige ID' });
    const cid = await eigenerCatererId(req);
    const { rows: [re] } = await db.query(`SELECT * FROM caterer_rechnungen WHERE id=$1 AND ($2::uuid IS NULL OR caterer_id=$2)`, [req.params.id, cid]);
    if (!re) return res.status(404).json({ error: 'Nicht gefunden' });
    const storno = re.typ === 'storno';
    const { rows: pos } = await db.query(`SELECT * FROM caterer_rechnung_positionen WHERE rechnung_id=$1 ORDER BY datum, lieferschein_nr`, [storno ? re.bezug_id : re.id]);
    const bezug = storno ? (await db.query(`SELECT rechnungs_nr, rechnungsdatum FROM caterer_rechnungen WHERE id=$1`, [re.bezug_id])).rows[0] : null;
    const f = firma(), emp = re.empfaenger || {};
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${re.rechnungs_nr}.pdf"`);
    doc.pipe(res);
    const eur = v => Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    const dat = d => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const sg = storno ? -1 : 1;
    // Absender
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(`${f.name} · ${f.strasse} · ${f.ort}`, 50, 50);
    doc.fontSize(11).fillColor('#000').text(emp.name || '', 50, 80);
    doc.fontSize(10).text(emp.adresse || '').text(emp.plzort || '');
    if (emp.ust_id) doc.fontSize(9).fillColor('#555').text('USt-IdNr.: ' + emp.ust_id);
    // Kopfdaten rechts
    let y = 80;
    [['Rechnungs-Nr.', re.rechnungs_nr], ['Rechnungsdatum', dat(re.rechnungsdatum)],
     ['Leistungszeitraum', `${dat(re.leistung_von)} – ${dat(re.leistung_bis)}`], ['Zahlbar bis', storno ? '—' : dat(re.zahlungsziel)]]
      .forEach(([k, v]) => { doc.font('Helvetica').fontSize(9).fillColor('#555').text(k, 350, y, { width: 90 }); doc.fillColor('#000').text(v, 440, y, { width: 105 }); y += 14; });
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(storno ? 'Stornorechnung' : 'Rechnung', 50, 175);
    doc.font('Helvetica').fontSize(9).fillColor('#555');
    if (storno && bezug) doc.text(`Storno zur Rechnung ${bezug.rechnungs_nr} vom ${dat(bezug.rechnungsdatum)}`, 50, 196);
    else doc.text('Lieferung regionaler Lebensmittel laut Lieferscheinen:', 50, 196);
    const cols = [['Datum', 58], ['Lieferschein', 88], ['Artikel', 150], ['Menge', 66], ['Preis', 66], ['Summe', 67]];
    doc.y = 220;
    const row = (cells, bold) => {
      if (doc.y > 720) doc.addPage();
      const yy = doc.y; let x = 50;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000');
      cells.forEach((c, i) => { doc.text(String(c), x, yy, { width: cols[i][1] - 4, lineBreak: false, ellipsis: true, align: i >= 3 ? 'right' : 'left' }); x += cols[i][1]; });
      doc.y = yy + 15;
      if (bold) doc.moveTo(50, doc.y - 3).lineTo(545, doc.y - 3).strokeColor('#999').stroke();
    };
    row(cols.map(c => c[0]), true);
    pos.forEach(p => row([dat(p.datum), p.lieferschein_nr || '', p.produkt || '',
      `${Number(p.menge).toLocaleString('de-DE', { maximumFractionDigits: 3 })} ${p.einheit || 'kg'}`, eur(p.preis), eur(sg * Number(p.summe))]));
    if (doc.y > 650) doc.addPage();
    doc.moveDown(.6); doc.moveTo(280, doc.y).lineTo(545, doc.y).strokeColor('#999').stroke(); doc.moveDown(.4);
    const sum = (k, v, bold) => { const yy = doc.y; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#000').text(k, 280, yy, { width: 170 }); doc.text(eur(v), 450, yy, { width: 95, align: 'right' }); doc.y = yy + 16; };
    sum('Warenwert netto', re.netto);
    if (Number(re.gebuehr_netto) !== 0) sum(`Servicegebühr ${Number(re.gebuehr_prozent).toLocaleString('de-DE')} % (netto)`, re.gebuehr_netto);
    sum(`Umsatzsteuer ${Number(re.mwst_satz).toLocaleString('de-DE')} % auf Ware`, re.mwst);
    if (Number(re.gebuehr_netto) !== 0) sum(`Umsatzsteuer ${Number(re.gebuehr_mwst_satz).toLocaleString('de-DE')} % auf Gebühr`, re.gebuehr_mwst);
    sum(storno ? 'Gutschrift brutto' : 'Rechnungsbetrag', re.brutto, true);
    doc.x = 50; doc.moveDown(1).font('Helvetica').fontSize(9).fillColor('#000');
    const W = { width: 495 };
    if (!storno) {
      doc.text(`Bitte überweise den Betrag bis zum ${dat(re.zahlungsziel)} unter Angabe der Rechnungsnummer.`, 50, doc.y, W);
      if (f.iban) doc.text(`Bankverbindung: ${f.bank ? f.bank + ' · ' : ''}IBAN ${f.iban}${f.bic ? ' · BIC ' + f.bic : ''}`, 50, doc.y, W);
    } else doc.text('Der Betrag wird mit offenen Forderungen verrechnet bzw. erstattet.', 50, doc.y, W);
    doc.moveDown(.6).fillColor('#555').fontSize(8).text('Pfandkisten werden gesondert im Pfand-Kontoauszug geführt und sind in diesem Betrag nicht enthalten.', 50, doc.y, W);
    doc.text(`Leistungsdatum entspricht dem Leistungszeitraum. ${f.ustid ? 'USt-IdNr. ' + f.ustid : ''}${f.ustid && f.steuernr ? ' · ' : ''}${f.steuernr ? 'Steuernr. ' + f.steuernr : ''} · ${f.name}, ${f.strasse}, ${f.ort} · ${f.email}`, 50, doc.y, W);
    doc.end();
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: 'PDF konnte nicht erstellt werden' }); }
});

router.post('/:id/bezahlt', auth, role('admin'), async (req, res) => {
  try {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.datum || '') ? req.body.datum : new Date().toISOString().slice(0, 10);
    const { rowCount } = await db.query(`UPDATE caterer_rechnungen SET status='bezahlt', bezahlt_am=$2 WHERE id=$1 AND typ='rechnung' AND status='offen'`, [req.params.id, d]);
    if (!rowCount) return res.status(409).json({ error: 'Nur offene Rechnungen können als bezahlt markiert werden' });
    res.json({ message: 'Als bezahlt vermerkt' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/stornieren', auth, role('admin'), async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [o] } = await client.query(`SELECT * FROM caterer_rechnungen WHERE id=$1 AND typ='rechnung' FOR UPDATE`, [req.params.id]);
    if (!o) throw Object.assign(new Error('Rechnung nicht gefunden'), { status: 404 });
    if (o.status === 'storniert') throw Object.assign(new Error('Bereits storniert'), { status: 409 });
    const jahr = new Date().getFullYear();
    const { rows: [n] } = await client.query(`INSERT INTO rechnungsnummern (jahr, letzte) VALUES ($1,1)
      ON CONFLICT (jahr) DO UPDATE SET letzte = rechnungsnummern.letzte + 1 RETURNING letzte`, [jahr]);
    const nr = `RE-${jahr}-${String(n.letzte).padStart(5, '0')}`;
    await client.query(`INSERT INTO caterer_rechnungen (rechnungs_nr, typ, caterer_id, monat, leistung_von, leistung_bis, mwst_satz, netto, mwst, brutto, status, bezug_id, empfaenger, created_by,
        gebuehr_prozent, gebuehr_netto, gebuehr_mwst_satz, gebuehr_mwst)
      VALUES ($1,'storno',$2,$3,$4,$5,$6,$7,$8,$9,'storniert',$10,$11,$12,$13,$14,$15,$16)`,
      [nr, o.caterer_id, o.monat, o.leistung_von, o.leistung_bis, o.mwst_satz, -o.netto, -o.mwst, -o.brutto, o.id, JSON.stringify(o.empfaenger), req.user.id,
       o.gebuehr_prozent, -o.gebuehr_netto, o.gebuehr_mwst_satz, -o.gebuehr_mwst]);
    await client.query(`UPDATE caterer_rechnungen SET status='storniert' WHERE id=$1`, [o.id]);
    await client.query(`UPDATE caterer_rechnung_positionen SET aktiv=FALSE WHERE rechnung_id=$1`, [o.id]);
    await client.query('COMMIT');
    res.json({ message: 'Storniert', storno_nr: nr });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Storno fehlgeschlagen' });
  } finally { client.release(); }
});

module.exports = router;
