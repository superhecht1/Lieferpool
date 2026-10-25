/**
 * alerts.js – Fehleralarm per E-Mail an den Admin (mit Drosselung)
 * Ablage: src/services/alerts.js
 * Benötigt ADMIN_EMAIL und BREVO_API_KEY. Ohne beides wird nur ins Log geschrieben.
 */
const email = require('./email');
const last = new Map();           // key -> Zeitstempel
const WINDOW_MS = 15 * 60 * 1000; // gleiche Meldung höchstens alle 15 Minuten

function scrub(s) {
  return String(s || '')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/([A-Z]{2}\d{2}[A-Z0-9]{10,30})/g, '[IBAN]')
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1***@')
    .replace(/enc:v1:[A-Za-z0-9+/=:]+/g, '[verschlüsselt]');
}

async function alertAdmin(title, err, ctx = {}) {
  try {
    const msg = scrub(err && (err.stack || err.message) || err);
    console.error(`[ALERT] ${title}:`, msg.split('\n')[0]);
    const to = process.env.ADMIN_EMAIL;
    if (!to) return;
    const key = title + '|' + msg.split('\n')[0];
    const now = Date.now();
    if (last.has(key) && now - last.get(key) < WINDOW_MS) return;
    last.set(key, now);
    if (last.size > 200) for (const [k, t] of last) if (now - t > WINDOW_MS) last.delete(k);
    const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    await email.send({
      to: [{ email: to, name: 'FrischKette Admin' }],
      subject: `⚠ FrischKette: ${title}`,
      html: `<h3>${esc(title)}</h3><p>${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}</p>
             <pre style="font-size:12px;white-space:pre-wrap">${esc(msg).slice(0, 3000)}</pre>
             <pre style="font-size:12px">${esc(scrub(JSON.stringify(ctx))).slice(0, 800)}</pre>`,
    });
  } catch (e) { console.error('[alerts] Versand fehlgeschlagen:', e.message); }
}

function install() {
  process.on('unhandledRejection', r => alertAdmin('Unbehandelte Promise-Ablehnung', r));
  process.on('uncaughtException', e => { alertAdmin('Unbehandelte Ausnahme', e).finally(() => setTimeout(() => process.exit(1), 1500)); });
}

module.exports = { alertAdmin, install };
