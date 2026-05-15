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


async function sendWochenberichtEmail() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) { console.warn('[cron] ADMIN_EMAIL nicht gesetzt – kein Wochenbericht'); return; }

  try {
    const email = require('../services/email');
    const now   = new Date();
    const kw    = getKW(now);
    const seit  = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [pools, commits, lieferungen, azVeranlasst, azOffen, lager] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM pools WHERE created_at > $1`, [seit]),
      db.query(`SELECT COUNT(*) FROM commitments WHERE created_at > $1`, [seit]),
      db.query(`SELECT COUNT(*) FROM lieferungen WHERE wareneingang_at > $1`, [seit]),
      db.query(`SELECT COUNT(*),SUM(netto) FROM auszahlungen WHERE status='veranlasst' AND created_at > $1`, [seit]),
      db.query(`SELECT COUNT(*),SUM(netto) FROM auszahlungen WHERE status='ausstehend'`),
      db.query(`SELECT COUNT(*) FROM lager_positionen WHERE unterbestand = TRUE`).catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    await email.sendWochenbericht({
      adminEmail,
      stats: {
        kw, jahr: now.getFullYear(),
        neue_pools:           parseInt(pools.rows[0].count),
        neue_commitments:     parseInt(commits.rows[0].count),
        wareneingaenge:       parseInt(lieferungen.rows[0].count),
        auszahlungen_count:   parseInt(azVeranlasst.rows[0].count),
        auszahlungen_summe:   azVeranlasst.rows[0].sum || 0,
        offene_auszahlungen:  parseInt(azOffen.rows[0].count),
        offene_summe:         azOffen.rows[0].sum || 0,
        lager_alerts:         parseInt(lager.rows[0].count),
      },
    });
    console.log(`[cron] Wochenbericht gesendet an ${adminEmail}`);
  } catch (err) {
    console.error('[cron] Wochenbericht fehlgeschlagen:', err.message);
  }
}

function getKW(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day  = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
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
