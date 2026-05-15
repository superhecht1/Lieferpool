/**
 * cron.js – Hintergrund-Jobs
 * Läuft alle 30 Minuten und schließt abgelaufene Pools automatisch
 */
const db = require('../db');

let cronInterval = null;

async function checkExpiredPools() {
  try {
    const { rows } = await db.query(`
      UPDATE pools
      SET status = 'abgebrochen', auto_closed = TRUE
      WHERE status = 'offen'
        AND deadline < NOW()
        AND auto_closed = FALSE
      RETURNING id, produkt, lieferwoche, menge_committed, menge_ziel
    `);

    if (rows.length > 0) {
      console.log(`[cron] ${rows.length} abgelaufene Pools geschlossen:`,
        rows.map(p => `${p.produkt} (${p.lieferwoche})`).join(', ')
      );

      // Commitments der abgebrochenen Pools auf 'zurueckgezogen' setzen
      for (const pool of rows) {
        await db.query(
          `UPDATE commitments SET status='zurueckgezogen' WHERE pool_id=$1 AND status='aktiv'`,
          [pool.id]
        );
      }
    }
  } catch (err) {
    console.error('[cron] Fehler beim Pool-Check:', err.message);
  }
}

async function checkFaelligeAuszahlungen() {
  // Auszahlungen die seit > 24h 'veranlasst' sind → als 'ausgezahlt' markieren
  // (In Produktion: echtes SEPA-Feedback, hier: Auto-Confirm nach 24h)
  try {
    const { rows } = await db.query(`
      UPDATE auszahlungen
      SET status = 'ausgezahlt', ausgezahlt_am = NOW()
      WHERE status = 'veranlasst'
        AND created_at < NOW() - INTERVAL '24 hours'
      RETURNING id
    `);
    if (rows.length > 0) {
      console.log(`[cron] ${rows.length} Auszahlungen auto-bestätigt`);
    }
  } catch (err) {
    console.error('[cron] Fehler beim Auszahlungs-Check:', err.message);
  }
}

function start() {
  if (cronInterval) return;
  console.log('[cron] Gestartet – prüft alle 30 Minuten');

  // Sofort einmal ausführen
  checkExpiredPools();
  checkFaelligeAuszahlungen();

  // Dann alle 30 Minuten
  cronInterval = setInterval(async () => {
    await checkExpiredPools();
    await checkFaelligeAuszahlungen();
  }, 30 * 60 * 1000);
}

function stop() {
  if (cronInterval) {
    clearInterval(cronInterval);
    cronInterval = null;
    console.log('[cron] Gestoppt');
  }
}

module.exports = { start, stop, checkExpiredPools };
