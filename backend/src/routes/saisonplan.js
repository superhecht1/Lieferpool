/**
 * saisonplan.js – Saisonkalender und Planungsvorschläge
 * Ablage: src/routes/saisonplan.js · Einbinden: app.use('/api/saisonplan', require('./routes/saisonplan'));
 *   GET /api/saisonplan[?monat=1-12]
 *     kalender: je Kultur Saison-Monate + Status (jetzt | endet_bald | bald | aus)
 *     chancen (nur Admin): Kulturen in Saison mit Bedarf von Cateren, aber ohne offenen Pool
 * Saisondaten: Freiland, Deutschland/NRW, Näherungswerte (aus routes/kennzahlen.js).
 */
const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { SAISON, MONATSNAMEN } = require('./kennzahlen');
const router = express.Router();

// Schreibvarianten/Synonyme nicht doppelt anzeigen
const UEBERSPRINGEN = new Set(['kuerbis', 'moehre', 'karotte', 'gruenkohl', 'kraeuter', 'porree', 'kopfsalat', 'zwetschge']);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const next = m => (m % 12) + 1;

function status(monate, m) {
  const jetzt = monate.includes(m);
  if (jetzt) return monate.includes(next(m)) ? 'jetzt' : 'endet_bald';
  if (monate.includes(next(m)) || monate.includes(next(next(m)))) return 'bald';
  return 'aus';
}

router.get('/', auth, async (req, res) => {
  try {
    const m = parseInt(req.query.monat) >= 1 && parseInt(req.query.monat) <= 12 ? parseInt(req.query.monat) : new Date().getMonth() + 1;
    const kalender = Object.keys(SAISON).filter(k => !UEBERSPRINGEN.has(k)).map(k => ({
      produkt: cap(k), key: k, monate: SAISON[k], status: status(SAISON[k], m),
    })).sort((a, b) => a.produkt.localeCompare(b.produkt, 'de'));

    const out = { monat: m, monatsname: MONATSNAMEN[m - 1], kalender };

    if (req.user.role === 'admin') {
      const [{ rows: pools }, { rows: bedarf }] = await Promise.all([
        db.query(`SELECT produkt FROM pools WHERE status = 'offen'`),
        db.query(`SELECT produkt, SUM(menge_pro_woche)::float AS menge, MAX(einheit) AS einheit, COUNT(DISTINCT caterer_id)::int AS caterer
                  FROM bedarf_prognosen WHERE aktiv = true GROUP BY produkt`).catch(() => ({ rows: [] })),
      ]);
      const hat = k => pools.some(p => String(p.produkt || '').toLowerCase().includes(k));
      out.chancen = [];
      for (const b of bedarf) {
        const p = String(b.produkt || '').toLowerCase();
        const key = Object.keys(SAISON).sort((a, c) => c.length - a.length).find(k => p.includes(k));
        if (!key || !SAISON[key].includes(m)) continue;
        if (hat(key)) continue;
        out.chancen.push({ produkt: b.produkt, menge_pro_woche: b.menge, einheit: b.einheit || 'kg', caterer: b.caterer,
          hinweis: `${b.produkt} ist im ${MONATSNAMEN[m - 1]} in Saison, ${b.caterer} ${b.caterer === 1 ? 'Abnehmer hat' : 'Abnehmer haben'} Bedarf, aber es gibt keinen offenen Pool.` });
      }
    }
    res.json(out);
  } catch (e) {
    console.error('[saisonplan]', e);
    res.status(500).json({ error: 'Saisonplan nicht verfügbar' });
  }
});

module.exports = router;
