/**
 * erinnerungen.js – automatische Erinnerungen (E-Mail + Push)
 * Ablage: src/services/erinnerungen.js · wird von cron.js stündlich aufgerufen.
 *  1) Pool-Deadline in ≤ 48 h und Pool noch nicht voll → Caterer
 *  2) Lieferung morgen → Caterer und beteiligte Erzeuger
 * Jede Erinnerung wird höchstens einmal gesendet (erinnerungen_log). Nutzer können in
 * notif_prefs E-Mail und/oder Push abschalten. Versand nur 07:00–20:00 Uhr (Europe/Berlin).
 */
const db = require('../db');
const email = require('./email');
let push = null; try { push = require('./push'); } catch { /* optional */ }

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const berlinHour = () => parseInt(new Intl.DateTimeFormat('de-DE', { hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date()), 10);

async function schonGesendet(key) {
  const { rowCount } = await db.query(`INSERT INTO erinnerungen_log (key) VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
  return rowCount === 0;
}

async function benachrichtige(userId, mail, titel, text, url) {
  const { rows: [pref] } = await db.query(`SELECT email_erinnerungen, push_erinnerungen FROM notif_prefs WHERE user_id=$1`, [userId]);
  const wantMail = pref ? pref.email_erinnerungen : true;
  const wantPush = pref ? pref.push_erinnerungen : true;
  if (wantMail && mail) {
    await email.send({
      to: [{ email: mail }], subject: titel,
      html: `<p>${esc(text)}</p><p><a href="${esc((process.env.APP_URL || '') + (url || '/login'))}">In FrischKette öffnen</a></p>
             <p style="font-size:12px;color:#777">Du kannst diese Erinnerungen in der App unter „Benachrichtigungen“ abschalten.</p>`,
    }).catch(e => console.warn('[erinnerung] Mail:', e.message));
  }
  if (wantPush && push) await push.sendToUser(db, userId, { title: titel, body: text, url: url || '/' }).catch(() => {});
}

async function poolDeadlines() {
  const { rows } = await db.query(`
    SELECT p.id, p.produkt, p.deadline, p.menge_ziel, p.menge_committed, u.id AS user_id, u.email
    FROM pools p JOIN caterer c ON c.id = p.caterer_id JOIN users u ON u.id = c.user_id
    WHERE p.status = 'offen' AND p.deadline > NOW() AND p.deadline <= NOW() + INTERVAL '48 hours'
      AND COALESCE(p.menge_committed,0) < COALESCE(p.menge_ziel,0)`);
  for (const p of rows) {
    if (await schonGesendet(`deadline:${p.id}`)) continue;
    const pct = p.menge_ziel > 0 ? Math.round(p.menge_committed / p.menge_ziel * 100) : 0;
    const frist = new Date(p.deadline).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' });
    await benachrichtige(p.user_id, p.email, `Pool „${p.produkt}“: Deadline naht`,
      `Der Pool „${p.produkt}“ ist erst zu ${pct} % gefüllt. Deadline: ${frist}.`, '/caterer');
  }
  return rows.length;
}

async function lieferungMorgen() {
  const { rows } = await db.query(`
    SELECT l.id, l.lieferschein_nr, p.id AS pool_id, p.produkt, p.zeitfenster_von, p.zeitfenster_bis,
           cu.id AS caterer_user, cu.email AS caterer_mail
    FROM lieferungen l JOIN pools p ON p.id = l.pool_id
    JOIN caterer c ON c.id = p.caterer_id JOIN users cu ON cu.id = c.user_id
    WHERE l.lieferdatum = (CURRENT_DATE + 1) AND l.status IN ('erstellt','unterwegs')`);
  for (const l of rows) {
    const fenster = l.zeitfenster_von ? ` (${String(l.zeitfenster_von).slice(0,5)}–${String(l.zeitfenster_bis || '').slice(0,5)} Uhr)` : '';
    const text = `Morgen: Lieferung „${l.produkt}“${fenster}, Lieferschein ${l.lieferschein_nr}.`;
    if (!(await schonGesendet(`lieferung:${l.id}:caterer`)))
      await benachrichtige(l.caterer_user, l.caterer_mail, `Lieferung morgen: ${l.produkt}`, text, '/caterer');
    const { rows: erz } = await db.query(`
      SELECT DISTINCT u.id, u.email FROM commitments cm JOIN erzeuger e ON e.id = cm.erzeuger_id JOIN users u ON u.id = e.user_id
      WHERE cm.pool_id = $1 AND cm.status = 'aktiv'`, [l.pool_id]);
    for (const e of erz) {
      if (await schonGesendet(`lieferung:${l.id}:${e.id}`)) continue;
      await benachrichtige(e.id, e.email, `Lieferung morgen: ${l.produkt}`, text, '/erzeuger');
    }
  }
  return rows.length;
}

async function run() {
  const h = berlinHour();
  if (h < 7 || h >= 20) return;
  try {
    const a = await poolDeadlines(), b = await lieferungMorgen();
    if (a || b) console.log(`[erinnerungen] geprüft: ${a} Pools, ${b} Lieferungen`);
    await db.query(`DELETE FROM erinnerungen_log WHERE created_at < NOW() - INTERVAL '30 days'`);
  } catch (e) { console.warn('[erinnerungen]', e.message); }
}

module.exports = { run };
