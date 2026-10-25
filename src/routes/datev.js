/**
 * datev.js – DATEV-Buchungsstapel (EXTF, Format 700 / Buchungsstapel v13) der Erzeuger-Abrechnungen
 * Ablage: backend/src/routes/datev.js · Einbinden: app.use('/api/datev', require('./routes/datev'));
 *   GET /api/datev/buchungsstapel?monat=YYYY-MM   (Admin)  → EXTF_Buchungsstapel_YYYY-MM.csv
 * Gebucht wird je Abrechnung (rechnungen, Status <> storniert, nach Rechnungsdatum):
 *   Soll Wareneingang (Konto)  an  Haben Kreditor (Gegenkonto) in Höhe des Bruttobetrags.
 *   Wareneingangskonto richtet sich nach dem Steuersatz der Abrechnung (Automatikkonten mit Vorsteuer, daher kein BU-Schlüssel):
 *   SKR03: 7 % → 3300, 19 % → 3400, sonst 3200 · SKR04: 7 % → 5300, 19 % → 5400, sonst 5200.
 *   Bei Erzeugern mit Durchschnittssatzbesteuerung (§ 24 UStG) bitte mit der Steuerberatung klären, welches Konto gilt.
 * Konfiguration per Umgebungsvariablen (alle optional):
 *   DATEV_BERATER (1000) · DATEV_MANDANT (1) · DATEV_SKR (03|04, Standard 03)
 *   DATEV_KONTO_WARE (erzwingt ein festes Konto für alle Sätze) · DATEV_KREDITOR_START (70000)
 * Kreditorennummer je Erzeuger = START + laufende Nummer (nach Anlagedatum) – bitte Stammdaten in DATEV entsprechend anlegen.
 * WICHTIG: Vor dem ersten echten Import mit der Steuerberatung einen Probeimport machen.
 */
const express = require('express');
const db = require('../db');
const { auth, role } = require('../middleware/auth');
const router = express.Router();

const q = s => '"' + String(s ?? '').replace(/[\r\n;]+/g, ' ').replace(/"/g, '""') + '"';
const num = v => Number(v).toFixed(2).replace('.', ',');
const ttmm = d => { const x = new Date(d); return String(x.getUTCDate()).padStart(2, '0') + String(x.getUTCMonth() + 1).padStart(2, '0'); };
const ymd = d => new Date(d).toISOString().slice(0, 10).replace(/-/g, '');

router.get('/buchungsstapel', auth, role('admin'), async (req, res) => {
  try {
    const monat = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.monat || '') ? req.query.monat : new Date().toISOString().slice(0, 7);
    const skr = process.env.DATEV_SKR === '04' ? '04' : '03';
    const fest = parseInt(process.env.DATEV_KONTO_WARE) || null;
    const kontoFuer = satz => fest || (skr === '04'
      ? (Math.round(satz) === 7 ? 5300 : Math.round(satz) === 19 ? 5400 : 5200)
      : (Math.round(satz) === 7 ? 3300 : Math.round(satz) === 19 ? 3400 : 3200));
    const start = parseInt(process.env.DATEV_KREDITOR_START) || 70000;
    const berater = parseInt(process.env.DATEV_BERATER) || 1000;
    const mandant = parseInt(process.env.DATEV_MANDANT) || 1;

    // laufende Nummer über ALLE Erzeuger stabil halten → Unterabfrage mit Nummerierung, dann filtern
    const abfrage = async order => (await db.query(`
      SELECT x.* FROM (
        SELECT r.rechnungs_nr, r.rechnungsdatum, r.brutto, r.mwst_satz, r.status, e.betrieb_name,
               (SELECT COUNT(*) FROM erzeuger e2 ${order === 'id' ? 'WHERE e2.id <= e.id' : 'JOIN users u2 ON u2.id = e2.user_id JOIN users u ON u.id = e.user_id WHERE (u2.created_at, u2.id) <= (u.created_at, u.id)'})::int AS lfd
        FROM rechnungen r JOIN erzeuger e ON e.id = r.erzeuger_id
      ) x
      WHERE x.status <> 'storniert' AND to_char(x.rechnungsdatum, 'YYYY-MM') = $1
      ORDER BY x.rechnungsdatum, x.rechnungs_nr`, [monat])).rows;
    let rows;
    try { rows = await abfrage('created'); } catch { rows = await abfrage('id'); }

    const jahr = monat.slice(0, 4);
    const von = jahr + monat.slice(5, 7) + '01';
    const bis = ymd(new Date(Date.UTC(+jahr, +monat.slice(5, 7), 0)));
    const jetzt = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '000';
    const kopf = ['"EXTF"', 700, 21, q('Buchungsstapel'), 13, jetzt, '', q('RE'), q(''), q(''), berater, mandant,
      jahr + '0101', 4, von, bis, q('FrischKette ' + monat), q(''), 1, 0, 0, q('EUR'), '', q(''), '', '', q(skr), '', '', q(''), q('')].join(';');
    const spalten = ['Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz',
      'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext'].join(';');
    const zeilen = rows.map(r => [num(r.brutto), q('S'), q('EUR'), '', '', '', kontoFuer(parseFloat(r.mwst_satz) || 0), start + r.lfd - 1, '',
      ttmm(r.rechnungsdatum), q(String(r.rechnungs_nr).slice(0, 36)), '', '', q(('Abrechnung ' + r.betrieb_name).slice(0, 60))].join(';'));

    const csv = [kopf, spalten, ...zeilen].join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=windows-1252');
    res.setHeader('Content-Disposition', `attachment; filename="EXTF_Buchungsstapel_${monat}.csv"`);
    res.send(Buffer.from(csv, 'latin1'));
  } catch (e) { console.error('[datev]', e.message); res.status(500).json({ error: 'DATEV-Export fehlgeschlagen' }); }
});

module.exports = router;
