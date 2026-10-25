/**
 * tourenvorschlag.js – automatischer Tourenvorschlag für einen Liefertag
 * Ablage: src/services/tourenvorschlag.js
 * Nimmt alle offenen Lieferungen mit lieferdatum = Datum (ohne bestehende Tour), bildet je Lieferung
 * Abholstopps bei den zusagenden Erzeugern und einen Auslieferstopp beim Caterer, teilt nach
 * Zuladung der Fahrzeuge in Touren und ordnet die Stopps per Nearest-Neighbor ab Hub.
 */
const db = require('../db');
const HUB = () => ({ lat: parseFloat(process.env.HUB_LAT || '50.9245'), lon: parseFloat(process.env.HUB_LON || '6.9195') });

function km(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const hasPos = s => s.lat !== null && s.lat !== undefined && s.lon !== null && s.lon !== undefined && isFinite(+s.lat) && isFinite(+s.lon);

function nearestNeighbor(stops, start) {
  const rest = stops.filter(hasPos).map(s => ({ ...s, lat: +s.lat, lon: +s.lon }));
  const ohne = stops.filter(s => !hasPos(s));
  const out = []; let cur = start;
  while (rest.length) {
    let bi = 0, bd = Infinity;
    rest.forEach((s, i) => { const d = km(cur, s); if (d < bd) { bd = d; bi = i; } });
    const n = rest.splice(bi, 1)[0]; out.push(n); cur = n;
  }
  return [...out, ...ohne];
}

function routeKm(stops, hub) {
  let cur = hub, total = 0;
  for (const s of stops) { if (!hasPos(s)) continue; total += km(cur, { lat: +s.lat, lon: +s.lon }); cur = { lat: +s.lat, lon: +s.lon }; }
  return Math.round((total + km(cur, hub)) * 10) / 10;
}

async function schlageVor(datum) {
  const hub = HUB();
  const { rows: liefs } = await db.query(`
    SELECT l.id AS lieferung_id, l.lieferschein_nr, COALESCE(l.menge_bestellt, p.menge_committed, 0) AS kg,
           p.id AS pool_id, p.produkt, p.zeitfenster_von, p.zeitfenster_bis,
           c.id AS caterer_id, c.firma_name, c.adresse, c.plz, c.ort, c.lat, c.lon
    FROM lieferungen l JOIN pools p ON p.id = l.pool_id JOIN caterer c ON c.id = p.caterer_id
    WHERE l.lieferdatum = $1 AND l.status NOT IN ('storniert','geliefert')
      AND NOT EXISTS (SELECT 1 FROM tour_stopps ts WHERE ts.lieferung_id = l.id)`, [datum]);
  const { rows: fz } = await db.query(`SELECT COALESCE(MAX(max_zuladung_kg), 0) AS cap FROM fahrzeuge WHERE aktiv = TRUE`);
  const cap = parseFloat(fz[0]?.cap) > 0 ? parseFloat(fz[0].cap) : 500;

  const hinweise = [];
  if (!liefs.length) return { datum, touren: [], hinweise: ['Keine offenen Lieferungen für dieses Datum (oder bereits in einer Tour).'], kapazitaet_kg: cap };

  // Lieferungen entlang einer Kette ab Hub sortieren, dann nach Zuladung aufteilen
  const sortiert = nearestNeighbor(liefs.map(l => ({ ...l, lat: l.lat, lon: l.lon })), hub);
  const gruppen = []; let akt = { liefs: [], kg: 0 };
  for (const l of sortiert) {
    const kg = parseFloat(l.kg) || 0;
    if (akt.liefs.length && akt.kg + kg > cap) { gruppen.push(akt); akt = { liefs: [], kg: 0 }; }
    akt.liefs.push(l); akt.kg += kg;
  }
  if (akt.liefs.length) gruppen.push(akt);

  const touren = [];
  for (const g of gruppen) {
    const abholungen = [];
    for (const l of g.liefs) {
      const { rows: cms } = await db.query(`
        SELECT cm.menge, e.id AS erzeuger_id, e.betrieb_name, e.adresse, e.plz, e.ort, e.lat, e.lon
        FROM commitments cm JOIN erzeuger e ON e.id = cm.erzeuger_id
        WHERE cm.pool_id = $1 AND cm.status = 'aktiv'`, [l.pool_id]);
      for (const c of cms) abholungen.push({
        typ: 'abholung', erzeuger_id: c.erzeuger_id, name: c.betrieb_name,
        adresse: [c.adresse, [c.plz, c.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        lat: c.lat, lon: c.lon, produkt: l.produkt, menge_geplant_kg: parseFloat(c.menge) || 0 });
    }
    const pickups = nearestNeighbor(abholungen, hub);
    const lastPick = [...pickups].reverse().find(hasPos);
    const startDeliv = lastPick ? { lat: +lastPick.lat, lon: +lastPick.lon } : hub;
    const lieferungenStops = nearestNeighbor(g.liefs.map(l => ({
      typ: 'auslieferung', caterer_id: l.caterer_id, lieferung_id: l.lieferung_id, name: l.firma_name,
      adresse: [l.adresse, [l.plz, l.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      lat: l.lat, lon: l.lon, produkt: l.produkt, menge_geplant_kg: parseFloat(l.kg) || 0,
      zeitfenster: l.zeitfenster_von ? `${String(l.zeitfenster_von).slice(0, 5)}–${String(l.zeitfenster_bis || '').slice(0, 5)}` : null })), startDeliv);
    const stopps = [...pickups, ...lieferungenStops].map((s, i) => ({ ...s, reihenfolge: i + 1 }));
    const ohne = stopps.filter(s => !hasPos(s)).length;
    if (ohne) hinweise.push(`${ohne} Stopp(s) ohne Koordinaten (am Ende eingereiht) – bitte Adresse/Geocoding prüfen.`);
    touren.push({
      gesamt_kg: Math.round(g.kg), strecke_km: routeKm(stopps, hub), anzahl_stopps: stopps.length,
      e_lastenrad_ok: routeKm(stopps, hub) < 25 && g.kg <= 120, stopps });
  }
  return { datum, kapazitaet_kg: cap, touren, hinweise: [...new Set(hinweise)] };
}

async function uebernehmen(datum, touren, userId) {
  const client = await db.connect(); const ids = [];
  try {
    await client.query('BEGIN');
    for (const [i, t] of touren.entries()) {
      const { rows: [tour] } = await client.query(
        `INSERT INTO touren (datum, typ, startzeit, notiz, created_by) VALUES ($1,'gemischt',$2,$3,$4) RETURNING id`,
        [datum, '06:30', `Automatischer Vorschlag (Tour ${i + 1}/${touren.length})`, userId]);
      const hub = HUB();
      for (const s of t.stopps) {
        await client.query(`
          INSERT INTO tour_stopps (tour_id, reihenfolge, typ, name, adresse, lat, lng, distanz_hub_km, produkt, menge_geplant_kg, erzeuger_id, caterer_id, lieferung_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [tour.id, s.reihenfolge, s.typ, s.name, s.adresse || null, hasPos(s) ? s.lat : null, hasPos(s) ? s.lon : null,
           hasPos(s) ? Math.round(km(hub, { lat: +s.lat, lon: +s.lon }) * 100) / 100 : null,
           s.produkt || null, s.menge_geplant_kg || null, s.erzeuger_id || null, s.caterer_id || null, s.lieferung_id || null]);
      }
      ids.push(tour.id);
    }
    await client.query('COMMIT');
    return ids;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

module.exports = { schlageVor, uebernehmen, nearestNeighbor, routeKm };
