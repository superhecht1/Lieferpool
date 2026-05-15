const db = require('../db');
let cronInterval = null;
let pingInterval = null;

function startSelfPing() {
  const appUrl = process.env.APP_URL;
  if (!appUrl) { console.warn('[cron] APP_URL nicht gesetzt'); return; }
  pingInterval = setInterval(async () => {
    try { await fetch(appUrl + '/health', { signal: AbortSignal.timeout(10000) }); }
    catch (err) { console.warn('[ping] fehlgeschlagen:', err.message); }
  }, 14 * 60 * 1000);
  console.log('[cron] Self-Ping →', appUrl);
}

async function checkExpiredPools() {
  try {
    const { rows } = await db.query(
      `UPDATE pools SET status='abgebrochen',auto_closed=TRUE
       WHERE status='offen' AND deadline<NOW() AND auto_closed=FALSE RETURNING id,produkt`
    );
    if (rows.length > 0) {
      console.log(`[cron] ${rows.length} Pools geschlossen`);
      for (const p of rows)
        await db.query(`UPDATE commitments SET status='zurueckgezogen' WHERE pool_id=$1 AND status='aktiv'`,[p.id]);
    }
  } catch (err) { console.error('[cron] Pool-Check:', err.message); }
}

async function checkFaelligeAuszahlungen() {
  try {
    const { rowCount } = await db.query(
      `UPDATE auszahlungen SET status='ausgezahlt',ausgezahlt_am=NOW()
       WHERE status='veranlasst' AND created_at<NOW()-INTERVAL '24 hours'`
    );
    if (rowCount > 0) console.log(`[cron] ${rowCount} Auszahlungen auto-bestätigt`);
  } catch (err) { console.error('[cron] AZ-Check:', err.message); }
}

async function cleanupTokens() {
  try { await db.query(`DELETE FROM refresh_tokens WHERE expires_at<NOW()`); }
  catch (err) { console.error('[cron] Token-Cleanup:', err.message); }
}

function start() {
  if (cronInterval) return;
  checkExpiredPools(); checkFaelligeAuszahlungen(); cleanupTokens();
  cronInterval = setInterval(() => { checkExpiredPools(); checkFaelligeAuszahlungen(); }, 30*60*1000);
  setInterval(cleanupTokens, 24*60*60*1000);
  startSelfPing();
  console.log('[cron] Alle Jobs gestartet');
}
function stop() {
  if (cronInterval) { clearInterval(cronInterval); cronInterval = null; }
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
}
module.exports = { start, stop, checkExpiredPools };
