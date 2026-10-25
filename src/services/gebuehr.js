/**
 * gebuehr.js – zentrale Servicegebühr (Vermittlungsmodell)
 * Ablage: backend/src/services/gebuehr.js
 * Hofseite:   GEBUEHR_HOF_PROZENT    (Standard 2,5) → Abzug bei der Erzeuger-Auszahlung (pools.platform_fee_pct)
 * Küchenseite: GEBUEHR_KUECHE_PROZENT (Standard 2,5) → eigene Zeile auf der Caterer-Rechnung, Satz GEBUEHR_KUECHE_MWST (Standard 19)
 * Der Prozentsatz wird beim Anlegen eines Pools bzw. beim Erstellen einer Rechnung festgeschrieben.
 */
const zahl = (v, d) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n >= 0 && n <= 50 ? n : d; };
module.exports = {
  hofProzent:    () => zahl(process.env.GEBUEHR_HOF_PROZENT, 2.5),
  kuecheProzent: () => zahl(process.env.GEBUEHR_KUECHE_PROZENT, 2.5),
  kucheMwst:     () => { const s = zahl(process.env.GEBUEHR_KUECHE_MWST, 19); return [0, 7, 19].includes(s) ? s : 19; },
};
