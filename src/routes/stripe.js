/**
 * stripe.js – Plattformgebühr über Stripe einziehen
 *
 * Env:
 *   STRIPE_SECRET_KEY       = sk_live_... (oder sk_test_...)
 *   STRIPE_PUBLISHABLE_KEY  = pk_live_...
 *   STRIPE_WEBHOOK_SECRET   = whsec_...
 *   APP_URL                 = https://deine-app.onrender.com
 */

const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY nicht gesetzt');
  return require('stripe')(key);
}

// GET /api/stripe/config – Publishable Key für Frontend
router.get('/config', (req, res) => {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key) return res.status(503).json({ error: 'Stripe nicht konfiguriert' });
  res.json({ publishableKey: key });
});

// GET /api/stripe/status – Stripe-Status prüfen
router.get('/status', auth, role('admin'), async (req, res) => {
  try {
    const stripe  = getStripe();
    const balance = await stripe.balance.retrieve();
    res.json({
      configured: true,
      balance: {
        available: balance.available.map(b => ({ amount: b.amount / 100, currency: b.currency })),
        pending:   balance.pending.map(b => ({ amount: b.amount / 100, currency: b.currency })),
      },
    });
  } catch (err) {
    res.json({ configured: false, error: err.message });
  }
});

// GET /api/stripe/fees-pending – offene Gebühren anzeigen
router.get('/fees-pending', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        a.id, a.platform_fee, a.netto, a.status, a.stripe_fee_collected,
        e.betrieb_name, p.produkt, p.lieferwoche,
        a.created_at
      FROM auszahlungen a
      JOIN erzeuger e ON e.id = a.erzeuger_id
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p ON p.id = c.pool_id
      WHERE a.stripe_fee_collected = FALSE AND a.status IN ('veranlasst','ausgezahlt')
      ORDER BY a.created_at DESC
    `);

    const gesamt = rows.reduce((s, r) => s + parseFloat(r.platform_fee || 0), 0);
    res.json({ fees: rows, gesamt: gesamt.toFixed(2), count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/collect-fees – Checkout Session für Plattformgebühren erstellen
router.post('/collect-fees', auth, role('admin'), async (req, res) => {
  const { auszahlungs_ids } = req.body; // Optional: bestimmte IDs, sonst alle offen

  try {
    const stripe = getStripe();

    // Offene Gebühren laden
    let query = `
      SELECT a.id, a.platform_fee, e.betrieb_name, p.produkt
      FROM auszahlungen a
      JOIN erzeuger e ON e.id = a.erzeuger_id
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p ON p.id = c.pool_id
      WHERE a.stripe_fee_collected = FALSE AND a.status IN ('veranlasst','ausgezahlt')
    `;
    const params = [];
    if (auszahlungs_ids?.length) {
      params.push(auszahlungs_ids);
      query += ` AND a.id = ANY($1)`;
    }

    const { rows: fees } = await db.query(query, params);
    if (!fees.length) return res.status(400).json({ error: 'Keine offenen Gebühren' });

    const totalCents = Math.round(fees.reduce((s, f) => s + parseFloat(f.platform_fee || 0), 0) * 100);
    if (totalCents < 50) return res.status(400).json({ error: 'Betrag zu gering (min. 0,50 €)' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'sepa_debit'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name:        `LieferPool Plattformgebühren`,
            description: `${fees.length} Auszahlungen · Zeitraum: ${new Date().toLocaleDateString('de-DE')}`,
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      success_url: `${process.env.APP_URL}/admin?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/admin?stripe=cancelled`,
      metadata: {
        auszahlungs_ids: fees.map(f => f.id).join(','),
        count:           fees.length,
        total_euros:     (totalCents / 100).toFixed(2),
      },
    });

    // Session in DB speichern
    await db.query(`
      INSERT INTO stripe_sessions (stripe_session_id, auszahlung_ids, amount_cents)
      VALUES ($1, $2, $3)
    `, [session.id, fees.map(f => f.id), totalCents]);

    res.json({ sessionId: session.id, url: session.url, amount: totalCents / 100 });
  } catch (err) {
    console.error('[stripe]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/webhook – Stripe-Events verarbeiten
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[stripe webhook] Signatur-Fehler:', err.message);
    return res.status(400).json({ error: err.message });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      // Auszahlungs-IDs aus Metadaten
      const ids = session.metadata.auszahlungs_ids?.split(',').filter(Boolean);
      if (ids?.length) {
        await db.query(
          `UPDATE auszahlungen SET stripe_fee_collected = TRUE WHERE id = ANY($1)`,
          [ids]
        );
        await db.query(
          `UPDATE stripe_sessions SET status = 'paid' WHERE stripe_session_id = $1`,
          [session.id]
        );
        console.log(`[stripe] ${ids.length} Gebühren als eingezogen markiert`);
      }
    } catch (err) {
      console.error('[stripe webhook] DB-Fehler:', err.message);
    }
  }

  res.json({ received: true });
});

module.exports = router;
