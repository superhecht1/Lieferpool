/**
 * vorlagenJob.js – wiederkehrende Pools aus Vorlagen
 * Ablage: src/services/vorlagenJob.js · täglich aus cron.js
 * Für jede aktive Vorlage wird der Pool für den nächsten Liefertag (Wochentag der Vorlage) angelegt,
 * sofern es dafür (Caterer + Produkt + Lieferwoche) noch keinen gibt und die Deadline in der Zukunft liegt.
 * Voraussetzung: migrate_fix10 (Spalten liefertag, zeitfenster_von/bis).
 */
const db = require('../db');
const TAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function getKW(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { kw: Math.ceil((((d - y1) / 86400000) + 1) / 7), jahr: d.getUTCFullYear() };
}

// Nächster Liefertermin (immer in der Zukunft, 1–7 Tage) + Deadline
function termin(wochentag, deadlineTage = 3, ab = new Date()) {
  const lieferung = new Date(ab.getFullYear(), ab.getMonth(), ab.getDate());
  const diff = ((parseInt(wochentag) - lieferung.getDay() + 7) % 7) || 7;
  lieferung.setDate(lieferung.getDate() + diff);
  const deadline = new Date(lieferung);
  deadline.setDate(deadline.getDate() - (parseInt(deadlineTage) || 3));
  deadline.setHours(18, 0, 0, 0);
  const { kw, jahr } = getKW(lieferung);
  return { lieferung, deadline, lieferwoche: `KW ${String(kw).padStart(2, '0')}/${jahr}`, liefertag: TAGE[lieferung.getDay()] };
}

async function poolAusVorlage(v) {
  const t = termin(v.wochentag, v.deadline_tage);
  const { rows: [vorhanden] } = await db.query(
    `SELECT id FROM pools WHERE caterer_id=$1 AND produkt=$2 AND lieferwoche=$3 AND status <> 'abgebrochen' LIMIT 1`,
    [v.caterer_id, v.produkt, t.lieferwoche]);
  if (vorhanden) return { pool: null, grund: 'existiert', ...t };
  if (t.deadline <= new Date()) return { pool: null, grund: 'deadline-vorbei', ...t };
  const liefertag = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'].includes(t.liefertag) ? t.liefertag : null;
  const { rows: [pool] } = await db.query(`
    INSERT INTO pools (caterer_id, produkt, menge_ziel, preis_pro_einheit, lieferwoche, deadline, notiz, status, liefertag)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'offen',$8) RETURNING *`,
    [v.caterer_id, v.produkt, v.menge_ziel, v.preis_pro_einheit, t.lieferwoche, t.deadline.toISOString(), v.notiz || null, liefertag]);
  return { pool, ...t };
}

async function createDuePools() {
  try {
    const { rows } = await db.query(`SELECT * FROM pool_vorlagen WHERE aktiv = TRUE`);
    let n = 0;
    for (const v of rows) {
      try { const r = await poolAusVorlage(v); if (r.pool) n++; }
      catch (e) { console.warn('[vorlagen] Vorlage', v.id, e.message); }
    }
    if (n) console.log(`[vorlagen] ${n} Pool(s) aus Vorlagen angelegt`);
  } catch (e) { console.warn('[vorlagen]', e.message); }
}

module.exports = { createDuePools, poolAusVorlage, termin };
