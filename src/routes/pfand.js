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

/**
 * Rückgabe atomar buchen (Lieferung + Bewegung + Kistenkonto des Caterers).
 * Wirft Error mit .status=400, wenn mehr Kisten zurückgegeben werden als offen sind.
 */
async function bucheRueckgabe({ lieferungId, kisten, notiz, userId, quelle = 'admin' }) {
  kisten = parseInt(kisten);
  if (!Number.isInteger(kisten) || kisten < 1) { const e = new Error('Ungültige Kistenzahl'); e.status = 400; throw e; }
  const { rows: [lief] } = await db.query(
    `UPDATE lieferungen SET pfand_kisten_zurueck = COALESCE(pfand_kisten_zurueck,0) + $1
     WHERE id=$2 AND COALESCE(pfand_kisten_zurueck,0) + $1 <= pfand_kisten_geliefert RETURNING *`,
    [kisten, lieferungId]);
  if (!lief) {
    const { rows: [l0] } = await db.query(`SELECT pfand_kisten_geliefert g, COALESCE(pfand_kisten_zurueck,0) z FROM lieferungen WHERE id=$1`, [lieferungId]);
    const e = new Error(l0 ? `Nicht mehr Kisten zurückgeben als offen (noch ${l0.g - l0.z})` : 'Lieferung nicht gefunden');
    e.status = l0 ? 400 : 404; throw e;
  }
  const betrag = kisten * parseFloat(lief.pfand_pro_kiste);
  const { rows: [pool] } = await db.query(`SELECT caterer_id FROM pools WHERE id=$1`, [lief.pool_id]);
  if (pool?.caterer_id) {
    await db.query(`INSERT INTO pfand_bewegungen (lieferung_id, entity_type, entity_id, bewegung_typ, kisten_anzahl, pfand_betrag, notiz, created_by)
                    VALUES ($1,'caterer',$2,'rueckgabe',$3,$4,$5,$6)`,
      [lieferungId, pool.caterer_id, kisten, betrag, [quelle, notiz].filter(Boolean).join(': ') || null, userId || null]);
    await kontoBuchen(pool.caterer_id, -kisten, -betrag);
  }
  return { lief, betrag, offen: lief.pfand_kisten_geliefert - lief.pfand_kisten_zurueck };
}

async function kontoBuchen(catererId, kistenDelta, betragDelta) {
  await db.query(`INSERT INTO pfand_konten (entity_type, entity_id, kisten_saldo, pfand_saldo) VALUES ('caterer',$1,$2,$3)
                  ON CONFLICT (entity_type, entity_id) DO UPDATE
                  SET kisten_saldo = pfand_konten.kisten_saldo + $2, pfand_saldo = pfand_konten.pfand_saldo + $3, updated_at = NOW()`,
    [catererId, kistenDelta, betragDelta]);
}

/** Ausgabe beim Anlegen einer Lieferung (aus lieferungen.js) */
async function bucheAusgabe({ lieferungId, catererId, kisten, preis, userId }) {
  if (!catererId || !(kisten > 0)) return;
  const betrag = kisten * preis;
  await db.query(`INSERT INTO pfand_bewegungen (lieferung_id, entity_type, entity_id, bewegung_typ, kisten_anzahl, pfand_betrag, created_by)
                  VALUES ($1,'caterer',$2,'ausgabe',$3,$4,$5)`, [lieferungId, catererId, kisten, betrag, userId || null]);
  await kontoBuchen(catererId, kisten, betrag);
}

// POST /api/pfand/rueckgabe – Pfandkisten zurückgeben (Admin)
router.post('/rueckgabe', auth, role('admin'), async (req, res) => {
  const { lieferung_id, kisten_zurueck, notiz } = req.body;
  if (!lieferung_id || !kisten_zurueck) return res.status(400).json({ error: 'lieferung_id und kisten_zurueck erforderlich' });
  try {
    const r = await bucheRueckgabe({ lieferungId: lieferung_id, kisten: kisten_zurueck, notiz, userId: req.user.id, quelle: 'Admin' });
    res.json({ message: `${parseInt(kisten_zurueck)} Kisten zurückgebucht · Pfand: ${r.betrag.toFixed(2)} €`,
               pfand_offen: r.offen * parseFloat(r.lief.pfand_pro_kiste) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// GET /api/pfand/konten – Admin: Kistenkonto je Caterer
router.get('/konten', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.firma_name, k.kisten_saldo, k.pfand_saldo,
             (SELECT MIN(l.lieferdatum) FROM lieferungen l JOIN pools p ON p.id=l.pool_id
              WHERE p.caterer_id=c.id AND l.pfand_kisten_geliefert > COALESCE(l.pfand_kisten_zurueck,0)) AS aeltestes_offen
      FROM pfand_konten k JOIN caterer c ON c.id=k.entity_id
      WHERE k.entity_type='caterer' ORDER BY k.kisten_saldo DESC`);
    res.json({ konten: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function catererFuer(req) {
  if (req.user.role === 'admin') return req.query.caterer_id || null;
  const { rows: [c] } = await db.query(`SELECT id FROM caterer WHERE user_id=$1`, [req.user.id]);
  return c?.id || null;
}

// GET /api/pfand/mein – Caterer: eigenes Konto, offene Lieferungen, Verlauf
router.get('/mein', auth, role('caterer', 'admin'), async (req, res) => {
  try {
    const cid = await catererFuer(req);
    if (!cid) return res.status(404).json({ error: 'Kein Caterer-Profil' });
    const [konto, offen, verlauf] = await Promise.all([
      db.query(`SELECT kisten_saldo, pfand_saldo FROM pfand_konten WHERE entity_type='caterer' AND entity_id=$1`, [cid]),
      db.query(`SELECT l.id, l.lieferschein_nr, l.lieferdatum, p.produkt, l.pfand_kisten_geliefert,
                       COALESCE(l.pfand_kisten_zurueck,0) AS pfand_kisten_zurueck, l.pfand_pro_kiste, l.pfand_offen
                FROM lieferungen l JOIN pools p ON p.id=l.pool_id
                WHERE p.caterer_id=$1 AND l.pfand_kisten_geliefert > COALESCE(l.pfand_kisten_zurueck,0)
                ORDER BY l.lieferdatum`, [cid]),
      db.query(`SELECT b.created_at, b.bewegung_typ, b.kisten_anzahl, b.pfand_betrag, b.notiz, l.lieferschein_nr
                FROM pfand_bewegungen b LEFT JOIN lieferungen l ON l.id=b.lieferung_id
                WHERE b.entity_type='caterer' AND b.entity_id=$1 ORDER BY b.created_at DESC LIMIT 50`, [cid]),
    ]);
    res.json({ konto: konto.rows[0] || { kisten_saldo: 0, pfand_saldo: 0 }, offen: offen.rows, verlauf: verlauf.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pfand/kontoauszug – druckbarer Pfand-Kontoauszug (Caterer: eigener, Admin: ?caterer_id=)
router.get('/kontoauszug', auth, role('caterer', 'admin'), async (req, res) => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  try {
    const cid = await catererFuer(req);
    if (!cid) return res.status(404).send('Kein Caterer-Profil');
    const { rows: [cat] } = await db.query(`SELECT firma_name FROM caterer WHERE id=$1`, [cid]);
    const { rows } = await db.query(`
      SELECT b.created_at, b.bewegung_typ, b.kisten_anzahl, b.pfand_betrag, l.lieferschein_nr
      FROM pfand_bewegungen b LEFT JOIN lieferungen l ON l.id=b.lieferung_id
      WHERE b.entity_type='caterer' AND b.entity_id=$1 ORDER BY b.created_at`, [cid]);
    let k = 0, e = 0;
    const zeilen = rows.map(r => {
      const sign = r.bewegung_typ === 'ausgabe' ? 1 : -1;
      k += sign * r.kisten_anzahl; e += sign * parseFloat(r.pfand_betrag);
      return `<tr><td>${new Date(r.created_at).toLocaleDateString('de-DE')}</td><td>${esc(r.lieferschein_nr || '—')}</td>
        <td>${sign > 0 ? 'Ausgabe' : 'Rückgabe'}</td><td style="text-align:right">${sign * r.kisten_anzahl}</td>
        <td style="text-align:right">${(sign * parseFloat(r.pfand_betrag)).toFixed(2)} €</td>
        <td style="text-align:right">${k}</td><td style="text-align:right">${e.toFixed(2)} €</td></tr>`;
    }).join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="de"><meta charset="utf-8"><title>Pfand-Kontoauszug</title>
<style>body{font:14px system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#111}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}th{background:#f3f3f3}
.s{margin:1rem 0;font-size:16px}.n{color:#666;font-size:12px;margin-top:1.5rem}@media print{button{display:none}}</style>
<h1>Pfand-Kontoauszug</h1><div>${esc(cat?.firma_name || '')} · Stand ${new Date().toLocaleDateString('de-DE')}</div>
<div class="s"><b>Offene Kisten: ${k}</b> · Pfand offen: <b>${e.toFixed(2)} €</b></div>
<table><thead><tr><th>Datum</th><th>Lieferschein</th><th>Vorgang</th><th style="text-align:right">Kisten</th><th style="text-align:right">Betrag</th><th style="text-align:right">Saldo Kisten</th><th style="text-align:right">Saldo €</th></tr></thead><tbody>${zeilen || '<tr><td colspan="7">Keine Bewegungen</td></tr>'}</tbody></table>
<p class="n">Pfand ist ein durchlaufender Posten und wird getrennt von den Warenpreisen geführt. Steuerliche Behandlung bitte mit der Steuerberatung abstimmen.</p>
<button onclick="print()">Drucken</button></html>`);
  } catch (err) { res.status(500).send('Fehler: ' + esc(err.message)); }
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
router.get('/export-csv', auth, role('admin'), async (req, res) => {
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
router.bucheRueckgabe = bucheRueckgabe;
router.bucheAusgabe = bucheAusgabe;
