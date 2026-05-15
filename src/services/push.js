/**
 * push.js – Web Push Benachrichtigungen via VAPID
 *
 * Setup (einmalig lokal ausführen, Keys in .env speichern):
 *   node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys(); console.log(k)"
 *
 * .env:
 *   VAPID_PUBLIC_KEY=...
 *   VAPID_PRIVATE_KEY=...
 *   VAPID_SUBJECT=mailto:admin@lieferpool.de
 */

let webpush = null;

function getWebPush() {
  if (webpush) return webpush;
  try {
    webpush = require('web-push');
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@lieferpool.de',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
    } else {
      console.warn('[push] VAPID-Keys nicht konfiguriert – Push deaktiviert');
      webpush = null;
    }
  } catch (err) {
    console.warn('[push] web-push nicht installiert – Push deaktiviert');
    webpush = null;
  }
  return webpush;
}

/**
 * Sendet Push-Nachricht an einen Nutzer (alle seine Subscriptions)
 */
async function sendToUser(db, userId, payload) {
  const wp = getWebPush();
  if (!wp) return { skipped: true };

  const { rows: subs } = await db.query(
    `SELECT * FROM push_subscriptions WHERE user_id = $1`, [userId]
  );

  if (!subs.length) return { skipped: true, reason: 'no subscriptions' };

  const results = [];
  for (const sub of subs) {
    try {
      await wp.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 } // 24h TTL
      );
      results.push({ endpoint: sub.endpoint.slice(-20), ok: true });
    } catch (err) {
      // Subscription abgelaufen → löschen
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id])
          .catch(() => {});
      }
      results.push({ endpoint: sub.endpoint.slice(-20), ok: false, error: err.message });
    }
  }
  return { sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
}

/**
 * Tour-Zuweisung Benachrichtigung
 */
async function notifyTourZugewiesen(db, fahrerId, tour) {
  return sendToUser(db, fahrerId, {
    title: '🚚 Neue Tour zugewiesen',
    body:  `${tour.typ} · ${tour.startzeit ? tour.startzeit.slice(0,5) + ' Uhr' : 'Heute'} · ${tour.stopp_anzahl || '?'} Stopps`,
    icon:  '/icon-192.png',
    badge: '/icon-72.png',
    data:  { url: '/fahrer', tourId: tour.id },
    tag:   'tour-' + tour.id,
  });
}

/**
 * Generiert VAPID-Keys (nur einmalig nötig)
 */
function generateKeys() {
  const wp = require('web-push');
  return wp.generateVAPIDKeys();
}

module.exports = { sendToUser, notifyTourZugewiesen, generateKeys };
