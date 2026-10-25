/**
 * logistik.js – Logistikpartner (z. B. Bio-Großhändler als Fahrdienst), Lieferantentyp, Leistungsnachweis
 * Ablage: backend/src/routes/logistik.js · app.use('/api/logistik', require('./routes/logistik'));  (nur Admin)
 *   GET/POST /partner, PUT /partner/:id
 *   GET /fahrer, PUT /fahrer/:userId {logistikpartner_id|null}
 *   GET /lieferanten, PUT /lieferanten/:id {betriebs_typ: 'hof'|'grosshandel'}
 *   GET /leistungen?monat=YYYY-MM[&partner_id][&format=csv]  Leistungsnachweis (Touren/Stopps/Vergütung)
 * Der Partner fährt mit eigenen Fahrer-Konten in der Fahrer-App; der Nachweis dient seiner Rechnung an dich.
 */
const express = require('express');
const db = require('../db');
const { auth, role } = require('../middleware/auth');
const router = express.Router();
router.use(auth, role('admin'));

const TYPEN = ['grosshandel', 'spedition', 'sonstige'];
const satz = v => { const n = Number(String(v ?? 0).replace(',', '.')); return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) / 100 : null; };
const uuid = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));

router.get('/partner', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT p.*, (SELECT COUNT(*)::int FROM fahrer_profile fp WHERE fp.logistikpartner_id = p.id) AS fahrer_anzahl
      FROM logistikpartner p ORDER BY p.aktiv DESC, p.name`);
    res.json({ partner: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/partner', async (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  const typ = TYPEN.includes(b.typ) ? b.typ : 'grosshandel', t = satz(b.satz_pro_tour), s = satz(b.satz_pro_stopp);
  if (t === null || s === null) return res.status(400).json({ error: 'Ungültiger Satz' });
  try {
    const { rows: [p] } = await db.query(`INSERT INTO logistikpartner (name, typ, kontakt_email, ust_id, satz_pro_tour, satz_pro_stopp)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [name, typ, String(b.kontakt_email || '').slice(0, 255) || null, String(b.ust_id || '').slice(0, 20) || null, t, s]);
    res.status(201).json({ partner: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/partner/:id', async (req, res) => {
  if (!uuid(req.params.id)) return res.status(400).json({ error: 'Ungültige ID' });
  const b = req.body || {}, t = b.satz_pro_tour === undefined ? undefined : satz(b.satz_pro_tour), s = b.satz_pro_stopp === undefined ? undefined : satz(b.satz_pro_stopp);
  if (t === null || s === null) return res.status(400).json({ error: 'Ungültiger Satz' });
  try {
    const { rows: [p] } = await db.query(`UPDATE logistikpartner SET
        name = COALESCE($2, name), typ = COALESCE($3, typ), kontakt_email = COALESCE($4, kontakt_email), ust_id = COALESCE($5, ust_id),
        satz_pro_tour = COALESCE($6, satz_pro_tour), satz_pro_stopp = COALESCE($7, satz_pro_stopp), aktiv = COALESCE($8, aktiv)
      WHERE id=$1 RETURNING *`,
      [req.params.id, b.name ? String(b.name).trim().slice(0, 120) : null, TYPEN.includes(b.typ) ? b.typ : null,
       b.kontakt_email != null ? String(b.kontakt_email).slice(0, 255) : null, b.ust_id != null ? String(b.ust_id).slice(0, 20) : null,
       t ?? null, s ?? null, typeof b.aktiv === 'boolean' ? b.aktiv : null]);
    if (!p) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ partner: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fahrer', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT u.id, u.name, u.email, fp.logistikpartner_id, p.name AS partner_name
      FROM users u JOIN fahrer_profile fp ON fp.user_id = u.id LEFT JOIN logistikpartner p ON p.id = fp.logistikpartner_id
      WHERE u.role = 'fahrer' ORDER BY u.name`);
    res.json({ fahrer: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/fahrer/:userId', async (req, res) => {
  const pid = req.body?.logistikpartner_id || null;
  if (!uuid(req.params.userId) || (pid && !uuid(pid))) return res.status(400).json({ error: 'Ungültige ID' });
  try {
    const { rowCount } = await db.query(`UPDATE fahrer_profile SET logistikpartner_id=$2 WHERE user_id=$1`, [req.params.userId, pid]);
    if (!rowCount) return res.status(404).json({ error: 'Fahrer nicht gefunden' });
    res.json({ message: 'Zuordnung gespeichert' });
  } catch (e) { res.status(e.code === '23503' ? 400 : 500).json({ error: e.code === '23503' ? 'Partner nicht gefunden' : e.message }); }
});

router.get('/lieferanten', async (req, res) => {
  try { res.json({ lieferanten: (await db.query(`SELECT id, betrieb_name, betriebs_typ FROM erzeuger ORDER BY betrieb_name`)).rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/lieferanten/:id', async (req, res) => {
  const t = req.body?.betriebs_typ;
  if (!uuid(req.params.id) || !['hof', 'grosshandel'].includes(t)) return res.status(400).json({ error: 'betriebs_typ muss hof oder grosshandel sein' });
  try {
    const { rowCount } = await db.query(`UPDATE erzeuger SET betriebs_typ=$2 WHERE id=$1`, [req.params.id, t]);
    if (!rowCount) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ message: 'Gespeichert' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/leistungen', async (req, res) => {
  const monat = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.monat || '') ? req.query.monat : new Date().toISOString().slice(0, 7);
  const pid = uuid(req.query.partner_id) ? req.query.partner_id : null;
  try {
    const { rows } = await db.query(`
      SELECT p.id AS partner_id, p.name AS partner, p.satz_pro_tour::float AS satz_tour, p.satz_pro_stopp::float AS satz_stopp,
             t.id AS tour_id, t.datum, t.typ, u.name AS fahrer,
             COUNT(s.id) FILTER (WHERE s.status = 'abgeschlossen')::int AS stopps
      FROM touren t
      JOIN users u ON u.id = t.fahrer_id
      LEFT JOIN fahrer_profile fp ON fp.user_id = t.fahrer_id
      JOIN logistikpartner p ON p.id = COALESCE(t.logistikpartner_id, fp.logistikpartner_id)
      LEFT JOIN tour_stopps s ON s.tour_id = t.id
      WHERE t.status = 'abgeschlossen' AND to_char(t.datum, 'YYYY-MM') = $1 AND ($2::uuid IS NULL OR p.id = $2)
      GROUP BY p.id, p.name, p.satz_pro_tour, p.satz_pro_stopp, t.id, t.datum, t.typ, u.name
      ORDER BY p.name, t.datum, u.name`, [monat, pid]);
    const zeilen = rows.map(r => ({ ...r, betrag: Math.round((r.satz_tour + r.stopps * r.satz_stopp) * 100) / 100 }));
    const proPartner = {};
    for (const z of zeilen) {
      const a = proPartner[z.partner_id] ||= { partner_id: z.partner_id, partner: z.partner, touren: 0, stopps: 0, betrag: 0 };
      a.touren++; a.stopps += z.stopps; a.betrag = Math.round((a.betrag + z.betrag) * 100) / 100;
    }
    if (req.query.format === 'csv') {
      const t = v => { v = String(v ?? '').replace(/[\r\n;]+/g, ' '); if (/^[=+\-@\t]/.test(v)) v = "'" + v; return /"/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const n = v => Number(v).toFixed(2).replace('.', ',');
      const csv = ['Partner;Datum;Fahrer;Tourtyp;Stopps;Satz_Tour;Satz_Stopp;Betrag_netto',
        ...zeilen.map(z => [t(z.partner), new Date(z.datum).toLocaleDateString('de-DE'), t(z.fahrer), t(z.typ), z.stopps, n(z.satz_tour), n(z.satz_stopp), n(z.betrag)].join(';'))].join('\r\n') + '\r\n';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="leistungsnachweis_${monat}.csv"`);
      return res.send('﻿' + csv);
    }
    res.json({ monat, partner: Object.values(proPartner), touren: zeilen });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
