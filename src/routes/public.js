/**
 * public.js – öffentliche, anonyme Wirkungszahlen (ohne Anmeldung)
 * Ablage: src/routes/public.js · Einbinden: app.use('/api/public', require('./routes/public'));
 * Nur aktiv, wenn WIRKUNG_PUBLIC=true gesetzt ist (sonst 404). Es werden ausschließlich Summen/Quoten
 * des laufenden Jahres ausgegeben, keine Namen, Orte oder Einzelwerte. Antwort wird 1 h zwischengespeichert.
 */
const express = require('express');
const db = require('../db');
const { berechne } = require('./kennzahlen');
const router = express.Router();
let cache = null;

router.get('/wirkung', async (req, res) => {
  if (process.env.WIRKUNG_PUBLIC !== 'true') return res.status(404).json({ error: 'Nicht verfügbar' });
  try {
    if (cache && Date.now() - cache.t < 3600 * 1000) return res.json(cache.data);
    const jahr = new Date().getFullYear();
    const d = await berechne({ von: `${jahr}-01-01`, bis: new Date().toISOString().slice(0, 10), catererId: null });
    const g = d.gesamt;
    const { rows: [n] } = await db.query(`
      SELECT (SELECT COUNT(*) FROM erzeuger)::int AS erzeuger, (SELECT COUNT(*) FROM caterer)::int AS caterer`);
    const mind = v => (v >= 3 ? v : null);               // kleine Zahlen nicht einzeln ausweisen
    const data = {
      jahr,
      stand: new Date().toISOString().slice(0, 10),
      erzeuger: mind(n.erzeuger), caterer: mind(n.caterer),
      kg: g.kg === null ? null : Math.round(g.kg / 10) * 10,
      bio_quote: g.bio_quote_kg, regional_quote: g.regional_quote_kg, abfall_quote: g.abfall_quote,
      avg_transport_km: g.avg_transport_km,
      ziele: { bio_prozent: d.ziele.bio_prozent, regional_radius_km: d.ziele.regional_radius_km },
    };
    cache = { t: Date.now(), data };
    res.set('Cache-Control', 'public, max-age=900').json(data);
  } catch (e) { res.status(500).json({ error: 'Zahlen derzeit nicht verfügbar' }); }
});

module.exports = router;
