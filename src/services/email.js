/**
 * email.js – Brevo Transaktions-E-Mail Service
 * Env: BREVO_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME
 */

const FROM_EMAIL = process.env.EMAIL_FROM      || 'noreply@lieferpool.de';
const FROM_NAME  = process.env.EMAIL_FROM_NAME || 'LieferPool';
const API_KEY    = process.env.BREVO_API_KEY;

// ----------------------------------------------------------------
// Basis-Versand via Brevo API
// ----------------------------------------------------------------
async function send({ to, subject, html }) {
  if (!API_KEY) {
    console.warn('[email] BREVO_API_KEY nicht gesetzt – E-Mail nicht versendet:', subject);
    return { skipped: true };
  }

  const body = {
    sender:   { name: FROM_NAME, email: FROM_EMAIL },
    to:       Array.isArray(to) ? to : [{ email: to }],
    subject,
    htmlContent: html,
  };

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key':       API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[email] Brevo Fehler:', err);
      return { error: err };
    }

    return { sent: true };
  } catch (err) {
    console.error('[email] Netzwerkfehler:', err.message);
    return { error: err.message };
  }
}

// ----------------------------------------------------------------
// HTML-Template Basis
// ----------------------------------------------------------------
function template(title, content) {
  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<style>
  body{font-family:-apple-system,sans-serif;background:#f4f5f2;margin:0;padding:32px 16px}
  .wrap{max-width:580px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #dde0d8}
  .head{background:#0d1f15;padding:28px 32px}
  .logo{font-size:18px;font-weight:600;color:#fff;letter-spacing:.04em}
  .logo span{color:#7ab648}
  .body{padding:32px}
  h1{font-size:20px;font-weight:600;color:#1a1d17;margin:0 0 16px}
  p{font-size:14px;color:#4a5244;line-height:1.7;margin:0 0 12px}
  .box{background:#f4f5f2;border-radius:6px;padding:16px 20px;margin:20px 0}
  .box-row{display:flex;justify-content:space-between;font-size:13px;color:#4a5244;margin-bottom:6px}
  .box-row:last-child{margin:0;font-weight:600;color:#1a1d17}
  .btn{display:inline-block;background:#2e7d3e;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600;margin-top:20px}
  .foot{padding:20px 32px;border-top:1px solid #dde0d8;font-size:12px;color:#8a9484}
</style></head>
<body>
<div class="wrap">
  <div class="head"><div class="logo">Liefer<span>Pool</span></div></div>
  <div class="body">${content}</div>
  <div class="foot">LieferPool · Regionale Lieferkooperative · Diese E-Mail wurde automatisch generiert.</div>
</div>
</body></html>`;
}

// ----------------------------------------------------------------
// E-Mail: Pool voll → Caterer
// ----------------------------------------------------------------
async function sendPoolVoll({ catererEmail, catererName, pool }) {
  return send({
    to: { email: catererEmail, name: catererName },
    subject: `Pool gefüllt: ${pool.produkt} – ${pool.lieferwoche}`,
    html: template('Pool gefüllt', `
      <h1>Dein Pool ist gefüllt ✓</h1>
      <p>Gute Nachricht, <strong>${catererName}</strong>! Die Mindestmenge für deinen Pool wurde erreicht.</p>
      <div class="box">
        <div class="box-row"><span>Produkt</span><span>${pool.produkt}</span></div>
        <div class="box-row"><span>Lieferwoche</span><span>${pool.lieferwoche}</span></div>
        <div class="box-row"><span>Menge committet</span><span>${Math.round(pool.menge_committed)} kg</span></div>
        <div class="box-row"><span>Erzeuger:innen</span><span>${pool.erzeuger_count || '—'}</span></div>
      </div>
      <p>Der nächste Schritt ist die Erstellung eines Lieferscheins durch den Food Hub.</p>
      <a href="${process.env.APP_URL || 'https://lieferpool.onrender.com'}/caterer" class="btn">Zum Dashboard</a>
    `),
  });
}

// ----------------------------------------------------------------
// E-Mail: Auszahlung veranlasst → Erzeuger
// ----------------------------------------------------------------
async function sendAuszahlungVeranlasst({ erzeugerEmail, erzeugerName, auszahlung }) {
  return send({
    to: { email: erzeugerEmail, name: erzeugerName },
    subject: `Auszahlung veranlasst: ${auszahlung.netto} €`,
    html: template('Auszahlung veranlasst', `
      <h1>Deine Auszahlung ist unterwegs 💰</h1>
      <p>Hallo <strong>${erzeugerName}</strong>, für deine Lieferung wurde eine Auszahlung per SEPA Instant veranlasst.</p>
      <div class="box">
        <div class="box-row"><span>Produkt</span><span>${auszahlung.produkt || '—'}</span></div>
        <div class="box-row"><span>Lieferwoche</span><span>${auszahlung.lieferwoche || '—'}</span></div>
        <div class="box-row"><span>Gelieferte Menge</span><span>${auszahlung.menge || '—'} kg</span></div>
        <div class="box-row"><span>Brutto</span><span>${parseFloat(auszahlung.brutto).toFixed(2)} €</span></div>
        <div class="box-row"><span>Qualitätsabzug</span><span>−${parseFloat(auszahlung.abzug_qualitaet||0).toFixed(2)} €</span></div>
        <div class="box-row"><span>Plattformfee (1%)</span><span>−${parseFloat(auszahlung.platform_fee||0).toFixed(2)} €</span></div>
        <div class="box-row"><span>Netto (SEPA Instant)</span><span>${parseFloat(auszahlung.netto).toFixed(2)} €</span></div>
      </div>
      <p>Der Betrag wird innerhalb von Sekunden auf dein hinterlegtes Konto überwiesen.</p>
      <a href="${process.env.APP_URL || 'https://lieferpool.onrender.com'}/erzeuger" class="btn">Zum Dashboard</a>
    `),
  });
}

// ----------------------------------------------------------------
// E-Mail: Zertifikat verifiziert → Erzeuger
// ----------------------------------------------------------------
async function sendZertifikatVerifiziert({ erzeugerEmail, erzeugerName, zertifikat }) {
  return send({
    to: { email: erzeugerEmail, name: erzeugerName },
    subject: `Zertifikat bestätigt: ${zertifikat.typ}`,
    html: template('Zertifikat bestätigt', `
      <h1>Zertifikat verifiziert ✓</h1>
      <p>Hallo <strong>${erzeugerName}</strong>, dein Zertifikat wurde erfolgreich geprüft und bestätigt.</p>
      <div class="box">
        <div class="box-row"><span>Typ</span><span>${zertifikat.typ}</span></div>
        <div class="box-row"><span>Nummer</span><span>${zertifikat.zert_nummer}</span></div>
        <div class="box-row"><span>Gültig bis</span><span>${zertifikat.gueltig_bis?.split('T')[0] || '—'}</span></div>
      </div>
      <p>Du kannst jetzt Mengen in offenen Pools zusagen.</p>
      <a href="${process.env.APP_URL || 'https://lieferpool.onrender.com'}/erzeuger" class="btn">Pools ansehen</a>
    `),
  });
}

// ----------------------------------------------------------------
// E-Mail: Zertifikat abgelehnt → Erzeuger
// ----------------------------------------------------------------
async function sendZertifikatAbgelehnt({ erzeugerEmail, erzeugerName, zertifikat }) {
  return send({
    to: { email: erzeugerEmail, name: erzeugerName },
    subject: `Zertifikat abgelehnt: ${zertifikat.typ}`,
    html: template('Zertifikat abgelehnt', `
      <h1>Zertifikat konnte nicht bestätigt werden</h1>
      <p>Hallo <strong>${erzeugerName}</strong>, dein eingereichte Zertifikat wurde leider abgelehnt.</p>
      <div class="box">
        <div class="box-row"><span>Typ</span><span>${zertifikat.typ}</span></div>
        <div class="box-row"><span>Nummer</span><span>${zertifikat.zert_nummer}</span></div>
      </div>
      <p>Bitte reiche ein gültiges Zertifikat erneut ein oder kontaktiere uns bei Fragen.</p>
      <a href="${process.env.APP_URL || 'https://lieferpool.onrender.com'}/erzeuger" class="btn">Erneut einreichen</a>
    `),
  });
}

// ----------------------------------------------------------------
// E-Mail: Neuer Pool offen → alle Erzeuger
// ----------------------------------------------------------------
async function sendNeuerPool({ erzeugerEmails, pool }) {
  if (!erzeugerEmails?.length) return;
  return send({
    to: erzeugerEmails.map(e => ({ email: e.email, name: e.name })),
    subject: `Neuer Pool: ${pool.produkt} – ${pool.lieferwoche}`,
    html: template('Neuer Pool', `
      <h1>Neuer Lieferpool verfügbar</h1>
      <p>Ein neuer Pool wurde erstellt. Du kannst jetzt deine Menge zusagen.</p>
      <div class="box">
        <div class="box-row"><span>Produkt</span><span>${pool.produkt}</span></div>
        <div class="box-row"><span>Lieferwoche</span><span>${pool.lieferwoche}</span></div>
        <div class="box-row"><span>Mindestmenge</span><span>${Math.round(pool.menge_ziel)} kg</span></div>
        <div class="box-row"><span>Preis</span><span>${parseFloat(pool.preis_pro_einheit).toFixed(2)} €/kg</span></div>
        <div class="box-row"><span>Deadline</span><span>${new Date(pool.deadline).toLocaleDateString('de-DE')}</span></div>
      </div>
      <a href="${process.env.APP_URL || 'https://lieferpool.onrender.com'}/erzeuger" class="btn">Menge zusagen</a>
    `),
  });
}

// ----------------------------------------------------------------
// E-Mail: Wareneingang bestätigt → Erzeuger
// ----------------------------------------------------------------
async function sendWareneingangBestaetigt({ erzeugerEmail, erzeugerName, lieferung }) {
  return send({
    to: { email: erzeugerEmail, name: erzeugerName },
    subject: `Wareneingang bestätigt: ${lieferung.produkt}`,
    html: template('Wareneingang bestätigt', `
      <h1>Lieferung erfolgreich bestätigt ✓</h1>
      <p>Hallo <strong>${erzeugerName}</strong>, deine Lieferung wurde vom Caterer bestätigt.</p>
      <div class="box">
        <div class="box-row"><span>Produkt</span><span>${lieferung.produkt}</span></div>
        <div class="box-row"><span>Menge bestätigt</span><span>${lieferung.menge_geliefert} kg</span></div>
        <div class="box-row"><span>Qualität</span><span>${lieferung.qualitaet}</span></div>
      </div>
      <p>Die Auszahlung wird jetzt berechnet und veranlasst.</p>
    `),
  });
}

module.exports = {
  send,
  sendPoolVoll,
  sendAuszahlungVeranlasst,
  sendZertifikatVerifiziert,
  sendZertifikatAbgelehnt,
  sendNeuerPool,
  sendWareneingangBestaetigt,
};
