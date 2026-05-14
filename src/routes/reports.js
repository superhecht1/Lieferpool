const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

// ----------------------------------------------------------------
// Hilfsfunktionen
// ----------------------------------------------------------------
function toCSV(rows, columns) {
  const header = columns.map(c => c.label).join(';');
  const lines  = rows.map(row =>
    columns.map(c => {
      const val = row[c.key] ?? '';
      const str = String(val).replace(/"/g, '""');
      return str.includes(';') || str.includes('\n') ? `"${str}"` : str;
    }).join(';')
  );
  return '\uFEFF' + [header, ...lines].join('\r\n'); // BOM für Excel
}

function fmt(n, decimals = 2) {
  return parseFloat(n || 0).toFixed(decimals).replace('.', ',');
}

// ----------------------------------------------------------------
// GET /api/reports/auszahlungen.csv
// ----------------------------------------------------------------
router.get('/auszahlungen.csv', auth, role('admin', 'erzeuger'), async (req, res) => {
  try {
    const { von, bis, status } = req.query;
    const params  = [];
    const filters = [];

    // Erzeuger sieht nur eigene
    if (req.user.role === 'erzeuger') {
      const { rows: [e] } = await db.query(
        `SELECT id FROM erzeuger WHERE user_id = $1`, [req.user.id]
      );
      if (!e) return res.status(403).json({ error: 'Kein Erzeuger-Profil' });
      params.push(e.id);
      filters.push(`a.erzeuger_id = $${params.length}`);
    }

    if (von)    { params.push(von);    filters.push(`a.created_at >= $${params.length}`); }
    if (bis)    { params.push(bis);    filters.push(`a.created_at <= $${params.length}`); }
    if (status) { params.push(status); filters.push(`a.status = $${params.length}`); }

    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        a.created_at,
        e.betrieb_name,
        p.produkt,
        p.lieferwoche,
        c.menge         AS commitment_menge_kg,
        a.brutto,
        a.abzug_qualitaet,
        a.platform_fee,
        a.netto,
        a.status,
        a.ausgezahlt_am,
        a.zahlungsart
      FROM auszahlungen a
      JOIN erzeuger e    ON e.id = a.erzeuger_id
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p       ON p.id = c.pool_id
      ${where}
      ORDER BY a.created_at DESC
    `, params);

    const csv = toCSV(rows, [
      { label: 'Datum',            key: 'created_at',          },
      { label: 'Betrieb',          key: 'betrieb_name'         },
      { label: 'Produkt',          key: 'produkt'              },
      { label: 'Lieferwoche',      key: 'lieferwoche'          },
      { label: 'Menge (kg)',       key: 'commitment_menge_kg'  },
      { label: 'Brutto (€)',       key: 'brutto'               },
      { label: 'Qualitätsabzug',   key: 'abzug_qualitaet'      },
      { label: 'Plattformfee',     key: 'platform_fee'         },
      { label: 'Netto (€)',        key: 'netto'                },
      { label: 'Status',           key: 'status'               },
      { label: 'Ausgezahlt am',    key: 'ausgezahlt_am'        },
      { label: 'Zahlungsart',      key: 'zahlungsart'          },
    ]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="auszahlungen.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// GET /api/reports/pools.csv
// ----------------------------------------------------------------
router.get('/pools.csv', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        p.created_at,
        p.produkt,
        p.lieferwoche,
        p.menge_ziel,
        p.menge_committed,
        p.preis_pro_einheit,
        p.status,
        p.region,
        COUNT(c.id)::int AS erzeuger_count,
        ROUND(p.menge_committed / NULLIF(p.menge_ziel,0) * 100, 1) AS fuellstand_pct
      FROM pools p
      LEFT JOIN commitments c ON c.pool_id = p.id AND c.status != 'zurueckgezogen'
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);

    const csv = toCSV(rows, [
      { label: 'Erstellt am',      key: 'created_at'       },
      { label: 'Produkt',          key: 'produkt'          },
      { label: 'Lieferwoche',      key: 'lieferwoche'      },
      { label: 'Ziel (kg)',        key: 'menge_ziel'       },
      { label: 'Committet (kg)',   key: 'menge_committed'  },
      { label: 'Füllstand (%)',    key: 'fuellstand_pct'   },
      { label: 'Preis (€/kg)',     key: 'preis_pro_einheit'},
      { label: 'Erzeuger',         key: 'erzeuger_count'   },
      { label: 'Region',           key: 'region'           },
      { label: 'Status',           key: 'status'           },
    ]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pools.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// GET /api/reports/lieferungen.csv
// ----------------------------------------------------------------
router.get('/lieferungen.csv', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        l.created_at,
        l.lieferschein_nr,
        l.qr_code,
        p.produkt,
        p.lieferwoche,
        l.menge_bestellt,
        l.menge_geliefert,
        l.qualitaet,
        l.status,
        l.wareneingang_at,
        l.notiz
      FROM lieferungen l
      JOIN pools p ON p.id = l.pool_id
      ORDER BY l.created_at DESC
    `);

    const csv = toCSV(rows, [
      { label: 'Erstellt am',        key: 'created_at'       },
      { label: 'Lieferschein Nr.',   key: 'lieferschein_nr'  },
      { label: 'QR-Code',            key: 'qr_code'          },
      { label: 'Produkt',            key: 'produkt'          },
      { label: 'Lieferwoche',        key: 'lieferwoche'      },
      { label: 'Bestellt (kg)',      key: 'menge_bestellt'   },
      { label: 'Geliefert (kg)',     key: 'menge_geliefert'  },
      { label: 'Qualität',           key: 'qualitaet'        },
      { label: 'Status',             key: 'status'           },
      { label: 'Wareneingang am',    key: 'wareneingang_at'  },
      { label: 'Notiz',              key: 'notiz'            },
    ]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lieferungen.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

// ----------------------------------------------------------------
// GET /api/reports/abrechnung/:erzeuger_id
// HTML-Abrechnung für einen Erzeuger (druckbar / als PDF speicherbar)
// ----------------------------------------------------------------
router.get('/abrechnung/:erzeuger_id', auth, role('admin', 'erzeuger'), async (req, res) => {
  try {
    // Erzeuger prüfen
    const { rows: [e] } = await db.query(`
      SELECT e.*, u.email, u.name FROM erzeuger e
      JOIN users u ON u.id = e.user_id
      WHERE e.id = $1
    `, [req.params.erzeuger_id]);

    if (!e) return res.status(404).json({ error: 'Erzeuger nicht gefunden' });

    // Nur eigene Daten für Erzeuger
    if (req.user.role === 'erzeuger') {
      const { rows: [me] } = await db.query(
        `SELECT id FROM erzeuger WHERE user_id = $1`, [req.user.id]
      );
      if (!me || me.id !== e.id) return res.status(403).json({ error: 'Kein Zugriff' });
    }

    const { von, bis } = req.query;
    const params  = [e.id];
    const filters = [`a.erzeuger_id = $1`];
    if (von) { params.push(von); filters.push(`a.created_at >= $${params.length}`); }
    if (bis) { params.push(bis); filters.push(`a.created_at <= $${params.length}`); }

    const { rows: auszahlungen } = await db.query(`
      SELECT a.*, p.produkt, p.lieferwoche, c.menge AS commitment_menge
      FROM auszahlungen a
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p ON p.id = c.pool_id
      WHERE ${filters.join(' AND ')}
      ORDER BY a.created_at DESC
    `, params);

    const gesamt     = auszahlungen.reduce((s, r) => s + parseFloat(r.netto), 0);
    const ausgezahlt = auszahlungen.filter(r => r.status === 'ausgezahlt').reduce((s, r) => s + parseFloat(r.netto), 0);
    const ausstehend = auszahlungen.filter(r => r.status !== 'ausgezahlt').reduce((s, r) => s + parseFloat(r.netto), 0);

    const zeitraum = von && bis
      ? `${new Date(von).toLocaleDateString('de-DE')} – ${new Date(bis).toLocaleDateString('de-DE')}`
      : 'Alle Zeiträume';

    const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Abrechnung – ${e.betrieb_name}</title>
<style>
  @page { margin: 2cm; }
  * { box-sizing: border-box; margin:0; padding:0; }
  body { font-family: -apple-system, sans-serif; font-size: 13px; color: #1a1d17; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:32px; padding-bottom:20px; border-bottom:2px solid #1a1d17; }
  .logo { font-size:20px; font-weight:700; }
  .logo span { color:#2e7d3e; }
  .meta { text-align:right; font-size:12px; color:#4a5244; line-height:1.7; }
  h1 { font-size:18px; margin-bottom:4px; }
  .betrieb { font-size:13px; color:#4a5244; margin-bottom:24px; }
  .summary { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:32px; }
  .sum-box { background:#f4f5f2; border-radius:6px; padding:14px 16px; }
  .sum-label { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:#8a9484; margin-bottom:4px; }
  .sum-val { font-size:20px; font-weight:300; }
  .sum-val.green { color:#2e7d3e; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { background:#f4f5f2; padding:8px 10px; text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:#8a9484; border-bottom:2px solid #dde0d8; }
  td { padding:9px 10px; border-bottom:1px solid #dde0d8; vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  .badge { display:inline-block; font-size:10px; padding:2px 7px; border-radius:10px; font-weight:500; }
  .b-green { background:#eaf4ec; color:#2e7d3e; }
  .b-amber { background:#fdf3e0; color:#b5780a; }
  .b-gray  { background:#f4f5f2; color:#8a9484; }
  .total-row td { font-weight:600; background:#f4f5f2; }
  .foot { margin-top:40px; font-size:11px; color:#8a9484; border-top:1px solid #dde0d8; padding-top:16px; }
  @media print { .no-print { display:none; } }
</style>
</head>
<body>
<div class="head">
  <div>
    <div class="logo">Liefer<span>Pool</span></div>
    <div style="font-size:11px;color:#8a9484;margin-top:4px">Regionale Lieferkooperative</div>
  </div>
  <div class="meta">
    Abrechnung<br>
    ${zeitraum}<br>
    Erstellt: ${new Date().toLocaleDateString('de-DE')}
  </div>
</div>

<h1>${e.betrieb_name}</h1>
<div class="betrieb">${e.email} · Region: ${e.region}${e.iban ? ' · IBAN: ' + e.iban : ''}</div>

<div class="summary">
  <div class="sum-box">
    <div class="sum-label">Gesamt Netto</div>
    <div class="sum-val">${fmt(gesamt)} €</div>
  </div>
  <div class="sum-box">
    <div class="sum-label">Ausgezahlt</div>
    <div class="sum-val green">${fmt(ausgezahlt)} €</div>
  </div>
  <div class="sum-box">
    <div class="sum-label">Ausstehend</div>
    <div class="sum-val">${fmt(ausstehend)} €</div>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>Datum</th>
      <th>Produkt</th>
      <th>KW</th>
      <th>Menge (kg)</th>
      <th>Brutto (€)</th>
      <th>Abzüge (€)</th>
      <th>Netto (€)</th>
      <th>Status</th>
    </tr>
  </thead>
  <tbody>
    ${auszahlungen.map(a => `
      <tr>
        <td>${new Date(a.created_at).toLocaleDateString('de-DE')}</td>
        <td>${a.produkt}</td>
        <td>${a.lieferwoche}</td>
        <td>${fmt(a.commitment_menge, 0)}</td>
        <td>${fmt(a.brutto)}</td>
        <td>−${fmt(parseFloat(a.abzug_qualitaet||0) + parseFloat(a.platform_fee||0))}</td>
        <td style="font-weight:500">${fmt(a.netto)}</td>
        <td>
          <span class="badge ${a.status==='ausgezahlt'?'b-green':a.status==='veranlasst'?'b-amber':'b-gray'}">
            ${a.status}
          </span>
        </td>
      </tr>
    `).join('')}
    <tr class="total-row">
      <td colspan="6" style="text-align:right">Gesamt Netto:</td>
      <td>${fmt(gesamt)} €</td>
      <td></td>
    </tr>
  </tbody>
</table>

<div class="foot">
  LieferPool · Automatisch generierte Abrechnung · Keine Rechnung im steuerrechtlichen Sinne
  <button onclick="window.print()" class="no-print" style="margin-left:16px;padding:4px 12px;background:#2e7d3e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">
    Drucken / Als PDF speichern
  </button>
</div>

</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Abrechnung konnte nicht erstellt werden' });
  }
});

// ----------------------------------------------------------------
// GET /api/reports/dashboard – Kennzahlen für Admin-Übersicht
// ----------------------------------------------------------------
router.get('/dashboard', auth, role('admin'), async (req, res) => {
  try {
    const [pools, auszahlungen, erzeuger, lieferungen] = await Promise.all([
      db.query(`SELECT status, COUNT(*)::int AS count, SUM(menge_committed) AS volumen FROM pools GROUP BY status`),
      db.query(`SELECT status, COUNT(*)::int AS count, SUM(netto) AS summe FROM auszahlungen GROUP BY status`),
      db.query(`SELECT COUNT(*)::int AS count FROM erzeuger`),
      db.query(`SELECT COUNT(*)::int AS count FROM lieferungen WHERE status = 'eingegangen'`),
    ]);

    res.json({
      pools:       pools.rows,
      auszahlungen:auszahlungen.rows,
      erzeuger:    erzeuger.rows[0]?.count || 0,
      lieferungen: lieferungen.rows[0]?.count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Dashboard-Daten fehlgeschlagen' });
  }
});

module.exports = router;
