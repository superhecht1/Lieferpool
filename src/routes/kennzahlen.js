// src/routes/kennzahlen.js – Bio-, Regional- und Abfallquote, Saisonwarnung, Export
const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

const HUB_LAT   = parseFloat(process.env.HUB_LAT || '50.9245');
const HUB_LON   = parseFloat(process.env.HUB_LON || '6.9195');
const RADIUS_KM = parseFloat(process.env.REGIONAL_RADIUS_KM || '150');
const BIO_ZIEL  = parseFloat(process.env.BIO_ZIEL_PROZENT || '30');
const BIO_TYPEN = ['Bio', 'Demeter', 'Naturland'];
const BEIRAT_TYPEN = ['Beirat']; // Beirat-geprüft nach Ökolandbau-Richtlinien, ohne Zertifizierung

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const num = v => (v === null || v === undefined || v === '') ? null : parseFloat(v);
const r1  = v => Math.round(v * 10) / 10;
const pct = (a, b) => b > 0 ? r1(a / b * 100) : null;

async function getCatererId(userId) {
  const { rows: [c] } = await db.query(`SELECT id FROM caterer WHERE user_id=$1`, [userId]);
  return c?.id || null;
}

// Zeitraum + Caterer-Scope aus Request ableiten
async function scope(req) {
  const von = /^\d{4}-\d{2}-\d{2}$/.test(req.query.von || '') ? req.query.von : `${new Date().getFullYear()}-01-01`;
  const bis = /^\d{4}-\d{2}-\d{2}$/.test(req.query.bis || '') ? req.query.bis : new Date().toISOString().slice(0, 10);
  let catererId = null;
  if (req.user.role === 'caterer') {
    catererId = await getCatererId(req.user.id);
    if (!catererId) return { von, bis, catererId: null, leer: true };
  } else if (req.query.caterer_id) {
    catererId = req.query.caterer_id;
  }
  return { von, bis, catererId };
}

// ── Kernberechnung ───────────────────────────────────────────
async function berechne({ von, bis, catererId }) {
  const params = [von, bis];
  let cf = '';
  if (catererId) { params.push(catererId); cf = `AND p.caterer_id = $3`; }

  // Eine Zeile je Lieferung × Erzeuger-Anteil (Menge anteilig nach Zusagen)
  const { rows } = await db.query(`
    SELECT l.id AS lieferung_id,
           COALESCE(l.lieferdatum, l.wareneingang_at::date, l.created_at::date) AS datum,
           l.menge_bestellt, l.menge_geliefert, l.qualitaet,
           p.produkt, p.einheit, p.preis_pro_einheit, p.caterer_id,
           c.firma_name, c.region AS c_region, c.lat AS c_lat, c.lon AS c_lon,
           cm.erzeuger_id, cm.menge AS zusage,
           SUM(cm.menge) OVER (PARTITION BY l.id) AS zusage_summe,
           e.betrieb_name, e.betriebs_typ, e.region AS e_region, e.lat AS e_lat, e.lon AS e_lon,
           EXISTS (
             SELECT 1 FROM zertifikate z
             WHERE z.erzeuger_id = e.id AND z.status = 'verified'
               AND z.typ = ANY($${params.length + 1})
               AND (z.gueltig_bis IS NULL
                    OR z.gueltig_bis >= COALESCE(l.lieferdatum, l.wareneingang_at::date, l.created_at::date))
           ) AS bio,
           EXISTS (
             SELECT 1 FROM zertifikate z
             WHERE z.erzeuger_id = e.id AND z.status = 'verified'
               AND z.typ = ANY($${params.length + 2})
               AND (z.gueltig_bis IS NULL
                    OR z.gueltig_bis >= COALESCE(l.lieferdatum, l.wareneingang_at::date, l.created_at::date))
           ) AS beirat
    FROM lieferungen l
    JOIN pools p        ON p.id = l.pool_id
    LEFT JOIN caterer c ON c.id = p.caterer_id
    JOIN commitments cm ON cm.pool_id = p.id
                       AND cm.status NOT IN ('storniert','zurueckgezogen','cancelled')
    JOIN erzeuger e     ON e.id = cm.erzeuger_id
    WHERE l.menge_geliefert IS NOT NULL
      AND COALESCE(l.lieferdatum, l.wareneingang_at::date, l.created_at::date) BETWEEN $1 AND $2
      ${cf}
  `, [...params, BIO_TYPEN, BEIRAT_TYPEN]);

  const sum = () => ({ kg: 0, eur: 0, beirat_kg: 0, bio_kg: 0, bio_eur: 0, reg_kg: 0, reg_eur: 0,
                       reg_bekannt_kg: 0, tkm: 0, km_gewichtet: 0, km_kg: 0 });
  const gesamt = sum(), proCat = {}, proProd = {}, proErz = {}, proMonat = {}, proTyp = {};

  for (const r of rows) {
    const share = num(r.zusage_summe) > 0 ? num(r.zusage) / num(r.zusage_summe) : 0;
    const menge = (num(r.menge_geliefert) || 0) * share;
    const wert  = menge * (num(r.preis_pro_einheit) || 0);
    const istKg = /^kg$/i.test(r.einheit || 'kg');
    const kg    = istKg ? menge : 0;

    // Entfernung Erzeuger → Hub → Caterer
    let regional = null, km = null;
    const eLat = num(r.e_lat), eLon = num(r.e_lon), cLat = num(r.c_lat), cLon = num(r.c_lon);
    if (eLat !== null && eLon !== null) {
      const direkt = (cLat !== null && cLon !== null) ? haversineKm(eLat, eLon, cLat, cLon) : null;
      const zumHub = haversineKm(eLat, eLon, HUB_LAT, HUB_LON);
      const vomHub = (cLat !== null && cLon !== null) ? haversineKm(HUB_LAT, HUB_LON, cLat, cLon) : 0;
      km = zumHub + vomHub;
      regional = (direkt !== null ? direkt : zumHub) <= RADIUS_KM;
    } else if (r.e_region && r.c_region) {
      regional = r.e_region.trim().toLowerCase() === r.c_region.trim().toLowerCase();
    }

    const add = (t) => {
      t.kg += kg; t.eur += wert;
      if (r.bio) { t.bio_kg += kg; t.bio_eur += wert; }
      else if (r.beirat) { t.beirat_kg += kg; }
      if (regional !== null) {
        t.reg_bekannt_kg += kg;
        if (regional) { t.reg_kg += kg; t.reg_eur += wert; }
      }
      if (km !== null && kg > 0) { t.tkm += km * kg / 1000; t.km_gewichtet += km * kg; t.km_kg += kg; }
    };
    add(gesamt);
    add(proCat[r.caterer_id] ||= Object.assign(sum(), { name: r.firma_name || '–', id: r.caterer_id }));
    add(proProd[r.produkt]   ||= Object.assign(sum(), { name: r.produkt }));
    add(proTyp[r.betriebs_typ || 'hof'] ||= Object.assign(sum(), { typ: r.betriebs_typ || 'hof' }));
    add(proErz[r.erzeuger_id]||= Object.assign(sum(), { name: r.betrieb_name || '–', bio: r.bio,
                                  hat_koord: eLat !== null }));
    const mk = String(r.datum instanceof Date ? r.datum.toISOString() : r.datum).slice(0, 7);
    add(proMonat[mk] ||= Object.assign(sum(), { monat: mk }));
  }

  // Lieferabweichung + Ausschuss (je Lieferung einmal, nicht je Anteil)
  const { rows: [lq] } = await db.query(`
    SELECT COALESCE(SUM(l.menge_bestellt),0)  AS bestellt,
           COALESCE(SUM(l.menge_geliefert),0) AS geliefert,
           COALESCE(SUM(CASE WHEN l.qualitaet='abgelehnt' THEN l.menge_geliefert END),0) AS abgelehnt
    FROM lieferungen l JOIN pools p ON p.id = l.pool_id
    WHERE l.menge_geliefert IS NOT NULL
      AND COALESCE(l.lieferdatum, l.wareneingang_at::date, l.created_at::date) BETWEEN $1 AND $2 ${cf}
  `, params);

  // Abfall-Meldungen
  const { rows: ab } = await db.query(`
    SELECT a.caterer_id, to_char(a.datum,'YYYY-MM') AS monat,
           SUM(a.menge_verbraucht) AS verbraucht, SUM(a.menge_entsorgt) AS entsorgt,
           SUM(a.menge_weitergegeben) AS weitergegeben
    FROM abfall_meldungen a
    WHERE a.datum BETWEEN $1 AND $2 ${catererId ? 'AND a.caterer_id = $3' : ''}
    GROUP BY a.caterer_id, to_char(a.datum,'YYYY-MM')
  `, params);
  let verbr = 0, entsorgt = 0, weiter = 0;
  for (const a of ab) {
    const v = num(a.verbraucht) || 0, e = num(a.entsorgt) || 0, w = num(a.weitergegeben) || 0;
    verbr += v; entsorgt += e; weiter += w;
    if (proCat[a.caterer_id]) { proCat[a.caterer_id].verbraucht = (proCat[a.caterer_id].verbraucht || 0) + v;
                                proCat[a.caterer_id].entsorgt   = (proCat[a.caterer_id].entsorgt   || 0) + e;
                                proCat[a.caterer_id].weitergegeben = (proCat[a.caterer_id].weitergegeben || 0) + w; }
    if (proMonat[a.monat])    { proMonat[a.monat].verbraucht = (proMonat[a.monat].verbraucht || 0) + v;
                                proMonat[a.monat].entsorgt   = (proMonat[a.monat].entsorgt   || 0) + e;
                                proMonat[a.monat].weitergegeben = (proMonat[a.monat].weitergegeben || 0) + w; }
  }

  const fin = t => ({
    ...t,
    kg: r1(t.kg), eur: Math.round(t.eur * 100) / 100,
    bio_quote_kg: pct(t.bio_kg, t.kg), bio_quote_eur: pct(t.bio_eur, t.eur),
    beirat_quote_kg: pct(t.beirat_kg, t.kg),
    bio_plus_beirat_quote_kg: pct(t.bio_kg + t.beirat_kg, t.kg),
    regional_quote_kg: pct(t.reg_kg, t.reg_bekannt_kg),
    daten_abdeckung_regional: pct(t.reg_bekannt_kg, t.kg),
    avg_transport_km: t.km_kg > 0 ? r1(t.km_gewichtet / t.km_kg) : null,
    tkm: Math.round(t.tkm * 100) / 100,
    abfall_quote: (t.verbraucht || t.entsorgt || t.weitergegeben) ? pct(t.entsorgt || 0, (t.verbraucht || 0) + (t.entsorgt || 0) + (t.weitergegeben || 0)) : null,
  });
  const liste = o => Object.values(o).map(fin).sort((a, b) => b.kg - a.kg);

  const bestellt = num(lq.bestellt), geliefert = num(lq.geliefert);
  return {
    zeitraum: { von, bis },
    ziele: { bio_prozent: BIO_ZIEL, regional_radius_km: RADIUS_KM },
    gesamt: {
      ...fin(gesamt),
      lieferabweichung_quote: bestellt > 0 ? pct(bestellt - geliefert, bestellt) : null,
      ausschuss_quote: geliefert > 0 ? pct(num(lq.abgelehnt), geliefert) : null,
      abfall_verbraucht: r1(verbr), abfall_entsorgt: r1(entsorgt), abfall_weitergegeben: r1(weiter),
      abfall_quote: (verbr + entsorgt + weiter) > 0 ? pct(entsorgt, verbr + entsorgt + weiter) : null,
      weitergabe_quote: (verbr + entsorgt + weiter) > 0 ? pct(weiter, verbr + entsorgt + weiter) : null,
      bio_ziel_erreicht: gesamt.kg > 0 ? (gesamt.bio_kg / gesamt.kg * 100) >= BIO_ZIEL : null,
    },
    caterer: liste(proCat),
    produkte: liste(proProd),
    erzeuger: liste(proErz),
    lieferanten_typ: liste(proTyp),
    monate: Object.values(proMonat).map(fin).sort((a, b) => a.monat.localeCompare(b.monat)),
  };
}

// ── Saisonkalender (Freiland, Deutschland/NRW; Näherungswerte) ─
const SAISON = {
  spargel:[4,5,6], erdbeere:[5,6,7], kirsche:[6,7], himbeere:[6,7,8,9], heidelbeer:[7,8,9],
  apfel:[8,9,10,11,12,1,2,3,4], birne:[8,9,10,11,12], pflaume:[8,9,10], zwetschge:[8,9,10],
  tomate:[7,8,9,10], gurke:[6,7,8,9], zucchini:[6,7,8,9,10], paprika:[8,9,10], aubergine:[8,9,10],
  salat:[5,6,7,8,9,10], kopfsalat:[5,6,7,8,9,10], feldsalat:[10,11,12,1,2,3], rucola:[4,5,6,7,8,9,10],
  radieschen:[4,5,6,7,8,9,10], kohlrabi:[5,6,7,8,9,10], blumenkohl:[6,7,8,9,10,11], brokkoli:[6,7,8,9,10,11],
  spinat:[4,5,6,9,10,11], mangold:[5,6,7,8,9,10], erbse:[6,7], bohne:[7,8,9,10],
  mais:[8,9,10], kürbis:[9,10,11,12], kuerbis:[9,10,11,12], 'rote bete':[6,7,8,9,10,11,12,1,2,3],
  möhre:[6,7,8,9,10,11,12,1,2,3,4], moehre:[6,7,8,9,10,11,12,1,2,3,4], karotte:[6,7,8,9,10,11,12,1,2,3,4],
  kartoffel:[6,7,8,9,10,11,12,1,2,3,4,5], zwiebel:[8,9,10,11,12,1,2,3,4,5,6,7],
  lauch:[9,10,11,12,1,2,3,4], porree:[9,10,11,12,1,2,3,4], weißkohl:[7,8,9,10,11,12,1,2,3],
  rotkohl:[9,10,11,12,1,2,3], wirsing:[9,10,11,12,1,2,3], grünkohl:[11,12,1,2], gruenkohl:[11,12,1,2],
  rosenkohl:[10,11,12,1,2], sellerie:[8,9,10,11,12,1,2,3], pastinake:[10,11,12,1,2,3],
  rhabarber:[4,5,6], knoblauch:[7,8,9,10,11,12,1,2,3], kräuter:[5,6,7,8,9,10], kraeuter:[5,6,7,8,9,10],
};
const MONATSNAMEN = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
function saisonPruefen(produkt, monat) {
  const p = String(produkt || '').toLowerCase();
  const key = Object.keys(SAISON).sort((a, b) => b.length - a.length).find(k => p.includes(k));
  if (!key) return null;
  return { key, in_saison: SAISON[key].includes(monat),
           monate: SAISON[key].map(m => MONATSNAMEN[m - 1]).join(', ') };
}

// ── Routen ───────────────────────────────────────────────────
router.get('/', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const s = await scope(req);
    if (s.leer) return res.json({ leer: true });
    res.json(await berechne(s));
  } catch (err) {
    console.error('[kennzahlen]', err);
    res.status(500).json({ error: 'Kennzahlen konnten nicht berechnet werden' });
  }
});

router.get('/saison-warnungen', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const monat = parseInt(req.query.monat) || (new Date().getMonth() + 1);
    let where = 'WHERE bp.aktiv = true', params = [];
    if (req.user.role === 'caterer') {
      const cid = await getCatererId(req.user.id);
      if (!cid) return res.json({ warnungen: [] });
      params.push(cid); where += ' AND bp.caterer_id = $1';
    }
    const { rows } = await db.query(
      `SELECT bp.id, bp.produkt, bp.menge_pro_woche, bp.einheit, c.firma_name
       FROM bedarf_prognosen bp JOIN caterer c ON c.id = bp.caterer_id ${where}`, params);
    const warnungen = [];
    for (const r of rows) {
      const s = saisonPruefen(r.produkt, monat);
      if (s && !s.in_saison) warnungen.push({ ...r, saison: s.monate,
        hinweis: `${r.produkt} hat regional im ${MONATSNAMEN[monat - 1]} keine Freilandsaison (Saison: ${s.monate}).` });
    }
    res.json({ monat, warnungen });
  } catch (err) {
    console.error('[kennzahlen/saison]', err);
    res.status(500).json({ error: 'Fehler' });
  }
});

router.get('/saison', auth, (req, res) => {
  const s = saisonPruefen(req.query.produkt, parseInt(req.query.monat) || (new Date().getMonth() + 1));
  res.json(s || { unbekannt: true });
});

// Abfall / Verbrauch melden
router.get('/abfall', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const params = []; let where = '';
    if (req.user.role === 'caterer') {
      const cid = await getCatererId(req.user.id);
      if (!cid) return res.json({ meldungen: [] });
      params.push(cid); where = 'WHERE a.caterer_id = $1';
    }
    const { rows } = await db.query(
      `SELECT a.*, c.firma_name FROM abfall_meldungen a JOIN caterer c ON c.id = a.caterer_id
       ${where} ORDER BY a.datum DESC, a.created_at DESC LIMIT 200`, params);
    res.json({ meldungen: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Fehler beim Laden' }); }
});

router.post('/abfall', auth, role('caterer'), async (req, res) => {
  const { produkt, datum, menge_verbraucht = 0, menge_entsorgt = 0, menge_weitergegeben = 0, weitergegeben_an, grund, lieferung_id } = req.body || {};
  const v = parseFloat(menge_verbraucht), e = parseFloat(menge_entsorgt), w = parseFloat(menge_weitergegeben);
  if (!(v >= 0) || !(e >= 0) || !(w >= 0) || (v + e + w) <= 0) return res.status(400).json({ error: 'Mengen ungültig' });
  if (datum && !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return res.status(400).json({ error: 'Datum ungültig' });
  try {
    const cid = await getCatererId(req.user.id);
    if (!cid) return res.status(400).json({ error: 'Caterer-Profil fehlt' });
    const { rows: [m] } = await db.query(
      `INSERT INTO abfall_meldungen (caterer_id, lieferung_id, produkt, datum, menge_verbraucht, menge_entsorgt, menge_weitergegeben, weitergegeben_an, grund)
       VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7,$8,$9) RETURNING *`,
      [cid, lieferung_id || null, produkt || null, datum || null, v, e, w, w > 0 ? (weitergegeben_an || null) : null, grund || null]);
    res.status(201).json({ meldung: m });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Speichern fehlgeschlagen' }); }
});

router.delete('/abfall/:id', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const cid = req.user.role === 'caterer' ? await getCatererId(req.user.id) : null;
    const { rowCount } = cid
      ? await db.query(`DELETE FROM abfall_meldungen WHERE id=$1 AND caterer_id=$2`, [req.params.id, cid])
      : await db.query(`DELETE FROM abfall_meldungen WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ message: 'Gelöscht' });
  } catch (err) { res.status(500).json({ error: 'Löschen fehlgeschlagen' }); }
});

// Koordinaten per Nominatim (OpenStreetMap) nachtragen – Admin, 1 Anfrage/Sekunde
router.post('/geocode', auth, role('admin'), async (req, res) => {
  const out = { erzeuger: 0, caterer: 0, fehlgeschlagen: 0 };
  try {
    for (const tab of ['erzeuger', 'caterer']) {
      const { rows } = await db.query(
        `SELECT id, adresse, plz, ort FROM ${tab} WHERE lat IS NULL AND (plz IS NOT NULL OR ort IS NOT NULL) LIMIT 40`);
      for (const r of rows) {
        const q = [r.adresse, r.plz, r.ort, 'Deutschland'].filter(Boolean).join(', ');
        const qs = new URLSearchParams({ q, format: 'json', limit: '1' });
        try {
          const resp = await fetch('https://nominatim.openstreetmap.org/search?' + qs, {
            headers: { 'User-Agent': 'LieferPool/1.0 (superhecht.ai)' } });
          const j = resp.ok ? await resp.json() : [];
          if (j[0]) {
            await db.query(`UPDATE ${tab} SET lat=$1, lon=$2 WHERE id=$3`, [j[0].lat, j[0].lon, r.id]);
            out[tab]++;
          } else out.fehlgeschlagen++;
        } catch { out.fehlgeschlagen++; }
        await new Promise(r => setTimeout(r, 1100));
      }
    }
    res.json(out);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Geocoding fehlgeschlagen', ...out }); }
});

// ── Export XLSX ──────────────────────────────────────────────
router.get('/export.xlsx', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const s = await scope(req);
    if (s.leer) return res.status(404).json({ error: 'Kein Caterer-Profil' });
    const d = await berechne(s);
    const XLSX = require('xlsx');
    const g = d.gesamt;
    const wb = XLSX.utils.book_new();
    const add = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);

    add('Zusammenfassung', [
      ['LieferPool – Nachhaltigkeitsbericht'],
      ['Zeitraum', `${d.zeitraum.von} bis ${d.zeitraum.bis}`],
      [],
      ['Kennzahl', 'Wert', 'Ziel / Hinweis'],
      ['Gelieferte Menge (kg)', g.kg],
      ['Wareneinsatz (€)', g.eur],
      ['Bio-Quote nach Menge (%)', g.bio_quote_kg, `Ziel ${d.ziele.bio_prozent} %`],
      ['Bio-Quote nach Wert (%)', g.bio_quote_eur],
      ['Beirat-geprüft, ohne Zertifikat (%)', g.beirat_quote_kg, 'Ökolandbau-Richtlinien, Kontrolle über Beirat'],
      ['Bio + Beirat gesamt (%)', g.bio_plus_beirat_quote_kg],
      [`Regionalquote (≤ ${d.ziele.regional_radius_km} km, %)`, g.regional_quote_kg, `Datenabdeckung ${g.daten_abdeckung_regional ?? '–'} %`],
      ['Ø Transportweg Erzeuger→Hub→Abnehmer (km)', g.avg_transport_km],
      ['Tonnenkilometer', g.tkm],
      ['Abfallquote (%)', g.abfall_quote, 'Entsorgt / (Verbraucht + Entsorgt + Weitergegeben)'],
      ['Weitergabequote (%)', g.weitergabe_quote, 'an Tafel, Foodsharing, Café, Kompost'],
      ['Lieferabweichung (%)', g.lieferabweichung_quote, 'Bestellt vs. geliefert'],
      ['Ausschuss / abgelehnt (%)', g.ausschuss_quote],
    ]);
    const kopf = ['Name','Menge kg','Wert €','Bio %','Regional %','Ø km','tkm'];
    const zeile = t => [t.name, t.kg, t.eur, t.bio_quote_kg, t.regional_quote_kg, t.avg_transport_km, t.tkm];
    add('Pro Caterer', [[...kopf, 'Abfallquote %'], ...d.caterer.map(t => [...zeile(t), t.abfall_quote])]);
    add('Pro Produkt', [kopf, ...d.produkte.map(zeile)]);
    add('Pro Erzeuger', [[...kopf, 'Bio-zertifiziert'], ...d.erzeuger.map(t => [...zeile(t), t.bio ? 'ja' : 'nein'])]);
    add('Lieferantentyp', [['Typ','Menge kg','Wert €','Bio %','Regional %','Ø km','tkm'],
      ...(d.lieferanten_typ || []).map(t => [t.typ === 'grosshandel' ? 'Großhandel' : 'Regionale Höfe', t.kg, t.eur, t.bio_quote_kg, t.regional_quote_kg, t.avg_transport_km, t.tkm])]);
    add('Monatsverlauf', [['Monat','Menge kg','Bio %','Regional %','Abfall %'],
      ...d.monate.map(t => [t.monat, t.kg, t.bio_quote_kg, t.regional_quote_kg, t.abfall_quote])]);
    add('Methodik', [
      ['Bio: Erzeuger mit gültigem, verifiziertem Zertifikat (Bio, Demeter, Naturland) zum Lieferdatum.'],
      ['Mengen je Lieferung werden anteilig nach den Zusagen der Erzeuger zugerechnet.'],
      [`Regional: Luftlinie Erzeuger–Abnehmer ≤ ${d.ziele.regional_radius_km} km (ohne Koordinaten: gleiche Region).`],
      ['Transportweg: Luftlinie Erzeuger→Hub→Abnehmer, gewichtet nach Menge; tatsächliche Fahrstrecke ist höher.'],
      ['Mengenquoten beziehen sich nur auf Positionen in kg; Wertquoten auf alle Positionen.'],
      ['Abfallquote basiert auf freiwilligen Meldungen der Abnehmer.'],
    ]);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="nachhaltigkeit_${d.zeitraum.von}_${d.zeitraum.bis}.xlsx"`);
    res.send(buf);
  } catch (err) { console.error('[kennzahlen/xlsx]', err); res.status(500).json({ error: 'Export fehlgeschlagen' }); }
});

// ── Export PDF ───────────────────────────────────────────────
router.get('/export.pdf', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const s = await scope(req);
    if (s.leer) return res.status(404).json({ error: 'Kein Caterer-Profil' });
    const d = await berechne(s);
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="nachhaltigkeit_${d.zeitraum.von}_${d.zeitraum.bis}.pdf"`);
    doc.pipe(res);
    const g = d.gesamt, f = v => (v === null || v === undefined) ? '–' : String(v).replace('.', ',');

    doc.fontSize(20).fillColor('#2e7d3e').text('Nachhaltigkeitsbericht', { align: 'left' });
    doc.fontSize(10).fillColor('#555').text(`LieferPool · Zeitraum ${d.zeitraum.von} bis ${d.zeitraum.bis}`);
    doc.moveDown(1).fillColor('#000');

    const kpi = [
      ['Bio-Quote (Menge)', f(g.bio_quote_kg) + ' %', `Ziel ${d.ziele.bio_prozent} % · + Beirat ${f(g.beirat_quote_kg)} %`],
      ['Regionalquote', f(g.regional_quote_kg) + ' %', `max. ${d.ziele.regional_radius_km} km`],
      ['Abfallquote', f(g.abfall_quote) + ' %', 'laut Meldungen'],
      ['Ø Transportweg', f(g.avg_transport_km) + ' km', `${f(g.tkm)} tkm`],
      ['Gelieferte Menge', f(g.kg) + ' kg', `${f(g.eur)} € Wareneinsatz`],
      ['Lieferabweichung', f(g.lieferabweichung_quote) + ' %', `Ausschuss ${f(g.ausschuss_quote)} %`],
    ];
    let y = doc.y;
    kpi.forEach((k, i) => {
      const x = 50 + (i % 3) * 170, yy = y + Math.floor(i / 3) * 70;
      doc.roundedRect(x, yy, 160, 60, 6).strokeColor('#cfd8cf').stroke();
      doc.fontSize(8).fillColor('#666').text(k[0], x + 8, yy + 8, { width: 144 });
      doc.fontSize(16).fillColor('#1b5e20').text(k[1], x + 8, yy + 22, { width: 144 });
      doc.fontSize(8).fillColor('#666').text(k[2], x + 8, yy + 44, { width: 144 });
    });
    doc.y = y + 150; doc.x = 50;

    // Zielerreichung
    const ziel = [
      ['Bio-Anteil (Menge)', g.bio_quote_kg, `mind. ${d.ziele.bio_prozent} %`, g.bio_quote_kg !== null && g.bio_quote_kg >= d.ziele.bio_prozent],
      ['Regionalanteil', g.regional_quote_kg, 'mind. 50 %', g.regional_quote_kg !== null && g.regional_quote_kg >= 50],
      ['Abfallquote', g.abfall_quote, 'max. 10 %', g.abfall_quote !== null && g.abfall_quote <= 10],
    ];
    doc.fontSize(12).fillColor('#000').text('Zielerreichung').moveDown(.3);
    ziel.forEach(z => {
      const yy = doc.y;
      doc.circle(56, yy + 6, 4).fill(z[1] === null ? '#bbb' : (z[3] ? '#2e7d3e' : '#c6922a'));
      doc.fillColor('#000').fontSize(9).text(`${z[0]}: ${f(z[1])} %  (Ziel ${z[2]})`, 68, yy, { width: 470 });
      doc.y = yy + 15;
    });
    doc.x = 50; doc.moveDown(.8);

    // Verlaufsdiagramm (Bio / Regional / Abfall je Monat)
    if (d.monate && d.monate.length >= 2) {
      if (doc.y > 560) doc.addPage();
      doc.fontSize(12).fillColor('#000').text('Verlauf je Monat').moveDown(.4);
      const cx = 70, cy = doc.y + 4, cw = 460, ch = 110;
      doc.rect(cx, cy, cw, ch).strokeColor('#cfd8cf').stroke();
      [0, 25, 50, 75, 100].forEach(p => {
        const yy = cy + ch - (p / 100) * ch;
        doc.moveTo(cx, yy).lineTo(cx + cw, yy).strokeColor('#eee').stroke();
        doc.fontSize(7).fillColor('#888').text(p + '%', 40, yy - 3, { width: 26, align: 'right', lineBreak: false });
      });
      const n = d.monate.length;
      const serien = [['bio_quote_kg', '#2e7d3e', 'Bio'], ['regional_quote_kg', '#2b6cb0', 'Regional'], ['abfall_quote', '#c0392b', 'Abfall']];
      serien.forEach(([key, col]) => {
        let started = false;
        d.monate.forEach((m, i) => {
          const v = m[key]; if (v === null || v === undefined) { started = false; return; }
          const px = cx + (n === 1 ? cw / 2 : (i / (n - 1)) * cw), py = cy + ch - Math.max(0, Math.min(100, v)) / 100 * ch;
          if (!started) { doc.moveTo(px, py); started = true; } else doc.lineTo(px, py);
        });
        doc.lineWidth(1.5).strokeColor(col).stroke();
        d.monate.forEach((m, i) => {
          const v = m[key]; if (v === null || v === undefined) return;
          doc.circle(cx + (n === 1 ? cw / 2 : (i / (n - 1)) * cw), cy + ch - Math.max(0, Math.min(100, v)) / 100 * ch, 2).fill(col);
        });
      });
      doc.lineWidth(1);
      d.monate.forEach((m, i) => {
        if (n > 12 && i % 2) return;
        doc.fontSize(7).fillColor('#666').text(String(m.monat).slice(2), cx + (n === 1 ? cw / 2 : (i / (n - 1)) * cw) - 14, cy + ch + 4, { width: 28, align: 'center', lineBreak: false });
      });
      let lx = cx;
      serien.forEach(([, col, name]) => { doc.rect(lx, cy + ch + 20, 8, 8).fill(col); doc.fillColor('#333').fontSize(8).text(name, lx + 12, cy + ch + 20, { lineBreak: false }); lx += 80; });
      doc.x = 50; doc.y = cy + ch + 42;
    }

    const tabelle = (titel, spalten, zeilen) => {
      if (doc.y > 680) doc.addPage();
      doc.x = 50;
      doc.fontSize(12).fillColor('#000').text(titel, 50, doc.y).moveDown(.4);
      const w = (495) / spalten.length;
      const row = (cells, bold) => {
        if (doc.y > 760) doc.addPage();
        const yy = doc.y;
        doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica');
        cells.forEach((c, i) => doc.text(String(c ?? '–'), 50 + i * w, yy, { width: w - 4, ellipsis: true, lineBreak: false }));
        doc.y = yy + 14;
      };
      row(spalten, true);
      zeilen.slice(0, 25).forEach(z => row(z, false));
      doc.font('Helvetica').moveDown(1);
    };
    tabelle('Abnehmer', ['Name','kg','Bio %','Regional %','Ø km','Abfall %'],
      d.caterer.map(t => [t.name, f(t.kg), f(t.bio_quote_kg), f(t.regional_quote_kg), f(t.avg_transport_km), f(t.abfall_quote)]));
    tabelle('Produkte', ['Produkt','kg','Bio %','Regional %','Ø km','tkm'],
      d.produkte.map(t => [t.name, f(t.kg), f(t.bio_quote_kg), f(t.regional_quote_kg), f(t.avg_transport_km), f(t.tkm)]));
    tabelle('Monatsverlauf', ['Monat','kg','Bio %','Regional %','Abfall %'],
      d.monate.map(t => [t.monat, f(t.kg), f(t.bio_quote_kg), f(t.regional_quote_kg), f(t.abfall_quote)]));

    doc.fontSize(8).fillColor('#666').text(
      'Methodik: Bio = verifiziertes Zertifikat (Bio, Demeter, Naturland) zum Lieferdatum; Mengen anteilig nach Zusagen. ' +
      `Regional = Luftlinie Erzeuger–Abnehmer max. ${d.ziele.regional_radius_km} km. Transportweg = Luftlinie Erzeuger→Hub→Abnehmer (Näherung). ` +
      'Abfallquote basiert auf Meldungen der Abnehmer. Quoten in kg beziehen sich nur auf Positionen in kg.',
      50, doc.y, { width: 495 });
    doc.end();
  } catch (err) {
    console.error('[kennzahlen/pdf]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Export fehlgeschlagen' });
  }
});

// ── Warengruppen-Auswertung (Näherung nach Produktname) ─────
const GRUPPEN = [
  ['Gemüse',      /salat|tomate|gurke|zucchini|paprika|aubergine|kohl|brokkoli|spinat|mangold|möhre|moehre|karotte|rote bete|lauch|porree|zwiebel|knoblauch|sellerie|pastinake|radieschen|rettich|kürbis|kuerbis|erbse|bohne|mais|spargel|rucola|fenchel|kräuter|kraeuter|gemüse|gemuese/i, true],
  ['Obst',        /apfel|äpfel|birne|pflaume|zwetschge|kirsche|erdbeere|himbeere|heidelbeer|beere|rhabarber|obst|traube|pfirsich|aprikose/i, true],
  ['Kartoffeln & Getreide', /kartoffel|getreide|mehl|hafer|roggen|weizen|dinkel|nudel|reis|brot|graupen|grieß|gries/i, true],
  ['Hülsenfrüchte & Nüsse', /linse|kichererbse|sojabohne|nuss|nüsse|walnuss|haselnuss/i, true],
  ['Milch & Milchprodukte', /milch|joghurt|quark|käse|kaese|butter|sahne|skyr/i, false],
  ['Eier',        /\bei\b|eier/i, false],
  ['Fleisch & Wurst', /fleisch|rind|schwein|huhn|hähnchen|haehnchen|pute|lamm|wurst|schinken|speck|hack/i, false],
  ['Fisch',       /fisch|lachs|forelle|karpfen|hering/i, false],
];
function gruppeVon(produkt) {
  const p = String(produkt || '');
  for (const [name, re, pflanzlich] of GRUPPEN) if (re.test(p)) return { name, pflanzlich };
  return { name: 'Sonstiges', pflanzlich: null };
}
// ── DGE-Orientierung Schulverpflegung (Referenzwerte) ──────
// Quelle: Anforderungen einer kommunalen Musterausschreibung (Berlin 2023, Leistungsbeschreibung Ziff. 1.4/1.5), die den
// DGE-Qualitätsstandard für die Schulverpflegung zugrunde legt. Maßgeblich ist der aktuelle DGE-Qualitätsstandard selbst.
const DGE = {
  quelle: 'Musterausschreibung Schulmittagessen Berlin 2023 (Ziff. 1.4/1.5), angelehnt an den DGE-Qualitätsstandard für die Schulverpflegung',
  hinweis: 'Orientierungswerte – kein Zertifikat. Verbindlich ist der aktuelle DGE-Qualitätsstandard (dge.de).',
  haeufigkeit: [   // je 5 bzw. 20 Verpflegungstage
    { key: 'getreide', name: 'Getreide, Getreideprodukte, Kartoffeln', je: 5, min: 5 },
    { key: 'vollkorn', name: '… davon Vollkornprodukte', je: 5, min: 1 },
    { key: 'gemuese',  name: 'Gemüse (inkl. Hülsenfrüchte)', je: 5, min: 5 },
    { key: 'huelsen',  name: '… davon Hülsenfrüchte', je: 5, min: 1 },
    { key: 'obst',     name: 'Obst', je: 5, min: 2 },
    { key: 'kerne',    name: 'Ölsaaten und Kerne', je: 5, min: 1 },
    { key: 'milch',    name: 'Milch und Milchprodukte', je: 5, min: 2 },
    { key: 'frittiert',name: 'Frittierte/panierte Produkte', je: 5, max: 1 },
    { key: 'fleisch',  name: 'Fleisch inkl. Erzeugnisse', je: 20, max: 4 },
    { key: 'fisch',    name: 'Fisch', je: 20, min: 4 },
    { key: 'fettfisch',name: '… davon fettreicher Fisch', je: 20, min: 2 },
    { key: 'suess',    name: 'Süße Hauptgerichte', je: 20, max: 2 },
  ],
  mengen_5_tage_g: [   // pro Person und 5 Verpflegungstage; [Klasse 1–4, ab Klasse 5]
    { name: 'Kartoffeln, Reis, Teigwaren, Getreide', klasse1_4: 600, ab5: 650, art: 'min' },
    { name: 'Gemüse', klasse1_4: 900, ab5: 1000, art: 'min' },
    { name: '… davon Hülsenfrüchte', klasse1_4: 140, ab5: 150, art: 'min' },
    { name: 'Obst', klasse1_4: 150, ab5: 150, art: 'min' },
    { name: 'Ölsaaten und Kerne', klasse1_4: 25, ab5: 25, art: 'min' },
    { name: 'Milch und Milchprodukte (inkl. Käse)', klasse1_4: 200, ab5: 200, art: 'min' },
    { name: 'Rapsöl, Sojaöl, Olivenöl, Leinöl', klasse1_4: 30, ab5: 30, art: 'min' },
    { name: 'Fisch', klasse1_4: 45, ab5: 50, art: 'min' },
    { name: 'Fleisch und Fleischerzeugnisse', klasse1_4: 60, ab5: 70, art: 'max' },
  ],
};
router.get('/dge-regeln', auth, role('admin', 'caterer'), (req, res) => res.json(DGE));

router.get('/warengruppen', auth, role('admin', 'caterer'), async (req, res) => {
  try {
    const sc = await scope(req);
    if (sc.leer) return res.json({ leer: true });
    const params = [sc.von, sc.bis]; let cf = '';
    if (sc.catererId) { params.push(sc.catererId); cf = 'AND p.caterer_id = $3'; }
    const { rows } = await db.query(`
      SELECT p.produkt, SUM(COALESCE(l.menge_geliefert, 0))::float AS kg
      FROM lieferungen l JOIN pools p ON p.id = l.pool_id
      WHERE l.status = 'eingegangen'
        AND COALESCE(l.wareneingang_at::date, l.lieferdatum, l.created_at::date) BETWEEN $1 AND $2 ${cf}
      GROUP BY p.produkt`, params);
    const map = {}; let gesamt = 0, pflanz = 0, bekannt = 0;
    for (const r of rows) {
      const g = gruppeVon(r.produkt);
      map[g.name] = (map[g.name] || 0) + r.kg; gesamt += r.kg;
      if (g.pflanzlich !== null) { bekannt += r.kg; if (g.pflanzlich) pflanz += r.kg; }
    }
    const gruppen = Object.entries(map).map(([name, kg]) => ({ name, kg: r1(kg), anteil: pct(kg, gesamt) })).sort((a, b) => b.kg - a.kg);
    res.json({ zeitraum: { von: sc.von, bis: sc.bis }, gesamt_kg: r1(gesamt), gruppen,
      pflanzlich_anteil: pct(pflanz, bekannt),
      hinweis: 'Zuordnung nach Produktnamen, Näherung. Mengen in kg; Ausweis von Portionen nach DGE-Qualitätsstandard ist damit nicht möglich.' });
  } catch (err) {
    console.error('[kennzahlen/warengruppen]', err);
    res.status(500).json({ error: 'Auswertung nicht möglich' });
  }
});

module.exports = router;
module.exports.berechne = berechne;
module.exports.SAISON = SAISON;
module.exports.saisonPruefen = saisonPruefen;
module.exports.MONATSNAMEN = MONATSNAMEN;
