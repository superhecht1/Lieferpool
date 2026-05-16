/**
 * print.js – Druckansichten für Lieferscheine und Touren
 * GET /api/print/lieferung/:id → druckbares HTML
 * GET /api/print/tour/:id      → druckbares HTML
 */

const express = require('express');
const db      = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

const PRINT_CSS = `
<style>
  @page { margin: 1.5cm; size: A4; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,'Helvetica Neue',sans-serif; font-size:12px; color:#1a1d17; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:24px; padding-bottom:16px; border-bottom:2px solid #1a1d17; }
  .logo { font-size:18px; font-weight:700; }
  .logo span { color:#2e7d3e; }
  .meta { text-align:right; font-size:11px; color:#4a5244; line-height:1.7; }
  h1 { font-size:16px; font-weight:600; margin-bottom:4px; }
  h2 { font-size:13px; font-weight:600; margin:16px 0 6px; color:#1a1d17; }
  .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px; }
  .info-box { background:#f4f5f2; border-radius:4px; padding:12px 14px; }
  .info-label { font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:#8a9484; margin-bottom:3px; }
  .info-val { font-size:13px; font-weight:500; }
  table { width:100%; border-collapse:collapse; margin-bottom:16px; }
  th { font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:#8a9484; text-align:left; padding:6px 8px; border-bottom:2px solid #dde0d8; background:#f4f5f2; }
  td { padding:7px 8px; border-bottom:1px solid #dde0d8; font-size:11px; vertical-align:middle; }
  .badge { display:inline-block; font-size:9px; padding:2px 6px; border-radius:10px; font-weight:500; background:#eaf4ec; color:#2e7d3e; border:1px solid #b8dfc0; }
  .qr-box { font-family:monospace; font-size:16px; letter-spacing:.1em; padding:10px 16px; background:#eaf4ec; border:1px solid #b8dfc0; border-radius:4px; display:inline-block; margin:8px 0; }
  .sign-box { margin-top:32px; display:flex; gap:48px; }
  .sign-line { flex:1; border-top:1px solid #1a1d17; padding-top:6px; font-size:10px; color:#8a9484; }
  .foot { margin-top:32px; font-size:10px; color:#8a9484; border-top:1px solid #dde0d8; padding-top:12px; }
  .no-print { margin-bottom:16px; }
  .stopp-nr { width:28px; height:28px; border-radius:50%; background:#eaf4ec; border:1px solid #b8dfc0; display:inline-flex; align-items:center; justify-content:center; font-weight:600; font-size:11px; color:#2e7d3e; }
  @media print { .no-print { display:none !important; } }
</style>`;

// ── Lieferschein ───────────────────────────────────────────────
router.get('/lieferung/:id', auth, async (req, res) => {
  try {
    const { rows: [lief] } = await db.query(`
      SELECT l.*,
        p.produkt, p.lieferwoche, p.preis_pro_einheit, p.region,
        c.firma_name AS caterer_name, uc.email AS caterer_email,
        ca.adresse AS caterer_adresse, ca.ort AS caterer_ort, ca.plz AS caterer_plz
      FROM lieferungen l
      JOIN pools p    ON p.id = l.pool_id
      JOIN caterer ca ON ca.id = p.caterer_id
      JOIN users uc   ON uc.id = ca.user_id
      LEFT JOIN caterer c ON c.id = p.caterer_id
      WHERE l.id = $1
    `, [req.params.id]);

    if (!lief) return res.status(404).send('Lieferschein nicht gefunden');

    const { rows: commitments } = await db.query(`
      SELECT e.betrieb_name, e.adresse, e.ort, e.plz, c.menge, c.status
      FROM commitments c
      JOIN erzeuger e ON e.id = c.erzeuger_id
      WHERE c.pool_id = $1 AND c.status != 'zurueckgezogen'
      ORDER BY e.betrieb_name
    `, [lief.pool_id]);

    const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<title>Lieferschein ${lief.lieferschein_nr}</title>
${PRINT_CSS}
</head>
<body>
<div class="no-print">
  <button onclick="window.print()" style="padding:8px 20px;background:#2e7d3e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;margin-right:8px">🖨 Drucken / Als PDF speichern</button>
  <button onclick="window.close()" style="padding:8px 16px;background:#f4f5f2;border:1px solid #dde0d8;border-radius:4px;cursor:pointer;font-size:13px">Schließen</button>
</div>

<div class="head">
  <div><div class="logo">Liefer<span>Pool</span></div><div style="font-size:10px;color:#8a9484;margin-top:2px">Regionale Lieferkooperative</div></div>
  <div class="meta">
    <strong>LIEFERSCHEIN</strong><br>
    Nr: ${lief.lieferschein_nr}<br>
    Datum: ${new Date().toLocaleDateString('de-DE')}<br>
    ${lief.lieferdatum ? 'Lieferdatum: ' + new Date(lief.lieferdatum).toLocaleDateString('de-DE') : ''}
  </div>
</div>

<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Produkt</div>
    <div class="info-val">${lief.produkt}</div>
    <div style="font-size:11px;color:#4a5244;margin-top:4px">
      Lieferwoche: ${lief.lieferwoche}<br>
      Preis: ${parseFloat(lief.preis_pro_einheit).toFixed(2)} €/kg<br>
      Region: ${lief.region}
    </div>
  </div>
  <div class="info-box">
    <div class="info-label">Empfänger (Caterer)</div>
    <div class="info-val">${lief.caterer_name}</div>
    <div style="font-size:11px;color:#4a5244;margin-top:4px">
      ${lief.caterer_email}<br>
      ${lief.caterer_adresse ? lief.caterer_adresse + ', ' + (lief.caterer_plz||'') + ' ' + (lief.caterer_ort||'') : ''}
    </div>
  </div>
</div>

<div style="margin-bottom:16px">
  <div class="info-label">QR-Code für Wareneingang</div>
  <div style="display:flex;align-items:flex-start;gap:20px;margin-top:6px">
    <div>
      <img src="/api/lieferungen/qr/${lief.qr_code}"
           alt="QR ${lief.qr_code}"
           style="width:110px;height:110px;border-radius:4px;border:1px solid #dde0d8;display:block">
      <div style="font-family:monospace;font-size:10px;color:#4a5244;margin-top:4px;text-align:center">${lief.qr_code}</div>
    </div>
    <div style="font-size:11px;color:#4a5244;line-height:1.6;max-width:300px">
      <strong>Scannen:</strong> FrischKette öffnen → Wareneingang → Kamera auf Code richten<br>
      <strong>Manuell:</strong> Code eingeben: <strong style="font-family:monospace">${lief.qr_code}</strong>
    </div>
  </div>
</div>

<h2>Erzeuger:innen (${commitments.length})</h2>
<table>
  <thead><tr><th>Betrieb</th><th>Adresse</th><th>Menge (kg)</th><th>Status</th><th>Unterschrift / Stempel</th></tr></thead>
  <tbody>
    ${commitments.map(c => `
      <tr>
        <td style="font-weight:500">${c.betrieb_name}</td>
        <td style="color:#4a5244">${c.adresse ? c.adresse + ', ' + (c.plz||'') + ' ' + (c.ort||'') : '—'}</td>
        <td style="font-family:monospace;font-weight:600">${parseFloat(c.menge||0).toFixed(0)}</td>
        <td><span class="badge">${c.status}</span></td>
        <td style="min-width:100px">&nbsp;</td>
      </tr>`).join('')}
    <tr style="background:#f4f5f2">
      <td colspan="2" style="font-weight:700;text-align:right">Gesamt:</td>
      <td style="font-family:monospace;font-weight:700">${commitments.reduce((s,c)=>s+parseFloat(c.menge||0),0).toFixed(0)}</td>
      <td colspan="2"></td>
    </tr>
  </tbody>
</table>

${lief.menge_geliefert ? `
<div class="info-box" style="margin-bottom:16px">
  <div class="info-label">Wareneingang bestätigt</div>
  <div class="info-val">Geliefert: ${lief.menge_geliefert} kg · Qualität: ${lief.qualitaet||'—'}</div>
  ${lief.wareneingang_at ? `<div style="font-size:11px;color:#4a5244;margin-top:4px">Am: ${new Date(lief.wareneingang_at).toLocaleString('de-DE')}</div>` : ''}
  ${lief.notiz ? `<div style="font-size:11px;color:#4a5244;margin-top:2px">Notiz: ${lief.notiz}</div>` : ''}
</div>` : ''}

<div class="sign-box">
  <div class="sign-line">Unterschrift Fahrer:in</div>
  <div class="sign-line">Unterschrift Caterer (Wareneingang)</div>
  <div class="sign-line">Datum &amp; Uhrzeit</div>
</div>

<div class="foot">
  LieferPool · superhecht.ai · Gottesweg 20, 50969 Köln · Automatisch generierter Lieferschein
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[print lieferung]', err.message);
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── Tourenplan ─────────────────────────────────────────────────
router.get('/tour/:id', auth, async (req, res) => {
  try {
    const { rows: [tour] } = await db.query(`
      SELECT t.*, u.name AS fahrer_name, u.email AS fahrer_email,
        f.bezeichnung AS fahrzeug, f.kennzeichen
      FROM touren t
      LEFT JOIN users u ON u.id = t.fahrer_id
      LEFT JOIN fahrzeuge f ON f.id = t.fahrzeug_id
      WHERE t.id = $1
    `, [req.params.id]);

    if (!tour) return res.status(404).send('Tour nicht gefunden');

    const { rows: stopps } = await db.query(
      `SELECT * FROM tour_stopps WHERE tour_id = $1 ORDER BY reihenfolge`,
      [req.params.id]
    );

    const gesamt_kg = stopps.reduce((s, st) => s + parseFloat(st.menge_geplant_kg || 0), 0);

    const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Tourenplan ${tour.datum}</title>
${PRINT_CSS}
</head>
<body>
<div class="no-print">
  <button onclick="window.print()" style="padding:8px 20px;background:#2e7d3e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;margin-right:8px">🖨 Drucken</button>
  <button onclick="window.close()" style="padding:8px 16px;background:#f4f5f2;border:1px solid #dde0d8;border-radius:4px;cursor:pointer;font-size:13px">Schließen</button>
</div>

<div class="head">
  <div><div class="logo">Liefer<span>Pool</span></div></div>
  <div class="meta">
    <strong>TOURENPLAN</strong><br>
    ${new Date(tour.datum).toLocaleDateString('de-DE', {weekday:'long', day:'numeric', month:'long', year:'numeric'})}<br>
    Erstellt: ${new Date().toLocaleString('de-DE',{dateStyle:'short',timeStyle:'short'})}
  </div>
</div>

<div class="info-grid" style="margin-bottom:20px">
  <div class="info-box">
    <div class="info-label">Fahrer:in</div>
    <div class="info-val">${tour.fahrer_name || '—'}</div>
    <div style="font-size:11px;color:#4a5244;margin-top:3px">${tour.fahrer_email || ''}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Fahrzeug</div>
    <div class="info-val">${tour.fahrzeug || '—'}</div>
    <div style="font-size:11px;color:#4a5244;margin-top:3px">
      ${tour.kennzeichen || ''}${tour.startzeit ? ' · Start: ' + tour.startzeit.slice(0,5) + ' Uhr' : ''}
    </div>
  </div>
  <div class="info-box">
    <div class="info-label">Tour-Typ</div>
    <div class="info-val">${tour.typ === 'abholung' ? 'Abholung (Erzeuger → Hub)' : tour.typ === 'auslieferung' ? 'Auslieferung (Hub → Caterer)' : 'Gemischt'}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Stopps / Volumen</div>
    <div class="info-val">${stopps.length} Stopps · ${gesamt_kg.toFixed(0)} kg geplant</div>
  </div>
</div>

${tour.notiz ? `<div class="info-box" style="margin-bottom:16px"><div class="info-label">Notiz</div><div>${tour.notiz}</div></div>` : ''}

<h2>Stoppliste</h2>
<table>
  <thead><tr>
    <th style="width:32px">#</th>
    <th>Typ</th>
    <th>Name / Betrieb</th>
    <th>Adresse</th>
    <th>Produkt</th>
    <th>Menge (kg)</th>
    <th>Dist.</th>
    <th>Ankunft</th>
    <th>OK ✓</th>
  </tr></thead>
  <tbody>
    ${stopps.map(s => `
      <tr>
        <td><span class="stopp-nr">${s.reihenfolge}</span></td>
        <td style="font-size:10px;font-weight:500;color:${s.typ==='abholung'?'#b5780a':'#2e7d3e'}">${s.typ.toUpperCase()}</td>
        <td style="font-weight:500">${s.name}</td>
        <td style="font-size:10px;color:#4a5244">${s.adresse || '—'}</td>
        <td style="font-size:10px">${s.produkt || '—'}</td>
        <td style="font-family:monospace;font-weight:600">${s.menge_geplant_kg ? parseFloat(s.menge_geplant_kg).toFixed(0) : '—'}</td>
        <td style="font-size:10px;color:#4a5244">${s.distanz_hub_km ? s.distanz_hub_km + ' km' : '—'}</td>
        <td style="min-width:50px">&nbsp;</td>
        <td style="font-size:18px;text-align:center">☐</td>
      </tr>`).join('')}
  </tbody>
</table>

<div class="sign-box">
  <div class="sign-line">Unterschrift Fahrer:in</div>
  <div class="sign-line">Startkilometerstand</div>
  <div class="sign-line">Endkilometerstand</div>
</div>

<div class="foot">
  LieferPool · Automatisch generierter Tourenplan · ${new Date().toLocaleString('de-DE')}
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[print tour]', err.message);
    res.status(500).send('Fehler: ' + err.message);
  }
});

module.exports = router;
