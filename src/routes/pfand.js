/**
 * Pfandkisten-Verwaltung für FrischKette
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

// GET /api/pfand/uebersicht – Admin: alle offenen Pfandstände
router.get('/uebersicht', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        l.id, l.lieferschein_nr, l.pfand_kisten_geliefert,
        l.pfand_kisten_zurueck, l.pfand_pro_kiste,
        l.pfand_gesamt, l.pfand_offen,
        l.lieferdatum, l.status,
        p.produkt, p.lieferwoche,
        e.betrieb_name, eu.email AS erzeuger_email,
        c.firma_name,  cu.email AS caterer_email
      FROM lieferungen l
      JOIN pools p    ON p.id = l.pool_id
      LEFT JOIN erzeuger e ON e.id = (
        SELECT c2.erzeuger_id FROM commitments c2
        WHERE c2.pool_id = p.id AND c2.status='aktiv' LIMIT 1
      )
      LEFT JOIN users eu ON eu.id = e.user_id
      LEFT JOIN caterer c ON c.id = p.caterer_id
      LEFT JOIN users cu ON cu.id = c.user_id
      WHERE l.pfand_kisten_geliefert > 0
        AND l.pfand_kisten_zurueck < l.pfand_kisten_geliefert
      ORDER BY l.lieferdatum DESC
    `);
    res.json({ offene_pfande: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/pfand/rueckgabe – Pfandkisten zurückgeben
router.post('/rueckgabe', auth, role('admin'), async (req, res) => {
  const { lieferung_id, kisten_zurueck, notiz } = req.body;
  if (!lieferung_id || !kisten_zurueck) {
    return res.status(400).json({ error: 'lieferung_id und kisten_zurueck erforderlich' });
  }

  try {
    const { rows:[lief] } = await db.query(
      `SELECT * FROM lieferungen WHERE id=$1`, [lieferung_id]
    );
    if (!lief) return res.status(404).json({ error: 'Lieferung nicht gefunden' });

    const neuZurueck = (lief.pfand_kisten_zurueck || 0) + parseInt(kisten_zurueck);
    if (neuZurueck > lief.pfand_kisten_geliefert) {
      return res.status(400).json({
        error: `Nicht mehr Kisten zurückgeben als geliefert (max. ${lief.pfand_kisten_geliefert})`
      });
    }

    await db.query(
      `UPDATE lieferungen SET pfand_kisten_zurueck=$1 WHERE id=$2`,
      [neuZurueck, lieferung_id]
    );

    // Bewegung loggen
    const pfandBetrag = parseInt(kisten_zurueck) * parseFloat(lief.pfand_pro_kiste);
    await db.query(`
      INSERT INTO pfand_bewegungen (lieferung_id, entity_type, entity_id, bewegung_typ, kisten_anzahl, pfand_betrag, notiz, created_by)
      VALUES ($1, 'caterer', (SELECT caterer_id FROM pools WHERE id=$2), 'rueckgabe', $3, $4, $5, $6)
    `, [lieferung_id, lief.pool_id, kisten_zurueck, pfandBetrag, notiz||null, req.user.id]);

    res.json({
      message: `${kisten_zurueck} Kisten zurückgebucht · Pfand: ${pfandBetrag.toFixed(2)} €`,
      pfand_offen: (lief.pfand_kisten_geliefert - neuZurueck) * parseFloat(lief.pfand_pro_kiste),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pfand/stats – Schnellübersicht für Admin-Dashboard
router.get('/stats', auth, role('admin'), async (req, res) => {
  try {
    const { rows:[stats] } = await db.query(`
      SELECT
        COUNT(*)::int                                          AS lieferungen_mit_pfand,
        COALESCE(SUM(pfand_kisten_geliefert),0)::int          AS kisten_gesamt,
        COALESCE(SUM(pfand_kisten_zurueck),0)::int            AS kisten_zurueck,
        COALESCE(SUM(pfand_kisten_geliefert - pfand_kisten_zurueck),0)::int AS kisten_offen,
        COALESCE(SUM(pfand_offen),0)::numeric(10,2)           AS pfand_offen_gesamt
      FROM lieferungen
      WHERE pfand_kisten_geliefert > 0
    `);
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/pfand/alle – Alle Lieferungen mit Pfand (auch vollständig abgeglichen)
router.get('/alle', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT l.id, l.lieferschein_nr, l.pfand_kisten_geliefert,
             l.pfand_kisten_zurueck, l.pfand_pro_kiste,
             l.pfand_gesamt, l.pfand_offen,
             l.lieferdatum, l.status,
             p.produkt, p.lieferwoche,
             e.betrieb_name, eu.email AS erzeuger_email,
             c.firma_name,  cu.email AS caterer_email
      FROM lieferungen l
      JOIN pools p    ON p.id = l.pool_id
      LEFT JOIN erzeuger e  ON e.id  = (
        SELECT cm.erzeuger_id FROM commitments cm
        WHERE cm.pool_id=p.id AND cm.status='aktiv' LIMIT 1
      )
      LEFT JOIN users eu ON eu.id = e.user_id
      LEFT JOIN caterer c  ON c.id  = p.caterer_id
      LEFT JOIN users cu ON cu.id = c.user_id
      WHERE l.pfand_kisten_geliefert > 0
      ORDER BY l.lieferdatum DESC
    `);
    res.json({ alle_pfande: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pfand/bewegungen – Bewegungshistorie
router.get('/bewegungen', auth, role('admin'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const { rows } = await db.query(`
      SELECT pb.*, l.lieferschein_nr,
             u.name AS gebucht_von
      FROM pfand_bewegungen pb
      LEFT JOIN lieferungen l ON l.id = pb.lieferung_id
      LEFT JOIN users u       ON u.id = pb.created_by
      ORDER BY pb.created_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ bewegungen: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pfand/export-csv – CSV-Export
router.get('/export-csv', async (req, res) => {
  const jwt = require('jsonwebtoken');
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Token fehlt' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Kein Zugriff' });
  } catch { return res.status(401).json({ error: 'Ungültiger Token' }); }

  try {
    const { rows } = await db.query(`
      SELECT l.lieferschein_nr, p.produkt, p.lieferwoche,
             l.lieferdatum::text, l.pfand_kisten_geliefert,
             l.pfand_kisten_zurueck, l.pfand_pro_kiste::text,
             l.pfand_gesamt::text, l.pfand_offen::text,
             e.betrieb_name, c.firma_name, l.status
      FROM lieferungen l
      JOIN pools p ON p.id=l.pool_id
      LEFT JOIN erzeuger e ON e.id=(SELECT cm.erzeuger_id FROM commitments cm WHERE cm.pool_id=p.id AND cm.status='aktiv' LIMIT 1)
      LEFT JOIN caterer c ON c.id=p.caterer_id
      WHERE l.pfand_kisten_geliefert > 0
      ORDER BY l.lieferdatum DESC
    `);

    const headers = ['Lieferschein','Produkt','KW','Lieferdatum','Kisten geliefert','Kisten zurück','Pfand/Kiste','Pfand gesamt','Pfand offen','Erzeuger','Caterer','Status'];
    const csv = [headers.join(';'),
      ...rows.map(r => [r.lieferschein_nr,r.produkt,r.lieferwoche,r.lieferdatum,
        r.pfand_kisten_geliefert,r.pfand_kisten_zurueck,r.pfand_pro_kiste,
        r.pfand_gesamt,r.pfand_offen,r.betrieb_name||'',r.firma_name||'',r.status
      ].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(';'))
    ].join('\n');

    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="pfand-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send('﻿' + csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
