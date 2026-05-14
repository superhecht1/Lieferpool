/**
 * payout.js – Auszahlungsberechnung + E-Mail Benachrichtigung
 */

const db    = require('../db');
const chain = require('./chain');
const email = require('./email');

const QUALITAETS_ABZUG = {
  A: 0, B: 0.05, C: 0.15, abgelehnt: 1.0,
};

async function calculateAndCreatePayouts(lieferung_id) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [lief] } = await client.query(`
      SELECT l.*, p.preis_pro_einheit, p.platform_fee_pct, p.menge_ziel, p.produkt, p.lieferwoche
      FROM lieferungen l JOIN pools p ON p.id = l.pool_id
      WHERE l.id = $1
    `, [lieferung_id]);

    if (!lief)                 throw new Error('Lieferung nicht gefunden');
    if (!lief.menge_geliefert) throw new Error('Menge geliefert fehlt');

    const abzugFaktor = QUALITAETS_ABZUG[lief.qualitaet] ?? 0;
    const feePct      = parseFloat(lief.platform_fee_pct) / 100;

    const { rows: commitments } = await client.query(`
      SELECT c.id, c.erzeuger_id, c.menge
      FROM commitments c WHERE c.pool_id = $1 AND c.status = 'aktiv'
    `, [lief.pool_id]);

    const total_committed = commitments.reduce((s,c) => s + parseFloat(c.menge), 0);
    const payouts = [];

    for (const c of commitments) {
      const anteil  = parseFloat(c.menge) / total_committed;
      const gelief  = parseFloat(lief.menge_geliefert) * anteil;
      const brutto  = gelief * parseFloat(lief.preis_pro_einheit);
      const abzug   = brutto * abzugFaktor;
      const fee     = brutto * feePct;
      const netto   = brutto - abzug - fee;

      const { rows: [az] } = await client.query(`
        INSERT INTO auszahlungen
          (commitment_id, lieferung_id, erzeuger_id, brutto, abzug_qualitaet, platform_fee, netto)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [c.id, lieferung_id, c.erzeuger_id,
          brutto.toFixed(2), abzug.toFixed(2), fee.toFixed(2), netto.toFixed(2)]);

      await client.query(
        `UPDATE commitments SET status = 'geliefert' WHERE id = $1`, [c.id]
      );

      payouts.push({ ...c, netto: parseFloat(netto.toFixed(2)), auszahlung_id: az.id, brutto, abzug, fee });
    }

    await client.query(`UPDATE pools SET status = 'geliefert' WHERE id = $1`, [lief.pool_id]);

    const { txHash } = await chain.releasePayments(lief.pool_id, payouts);

    await client.query(`
      UPDATE auszahlungen SET status = 'veranlasst', chain_tx = $1
      WHERE lieferung_id = $2
    `, [txHash, lieferung_id]);

    await client.query('COMMIT');

    // E-Mails nach Commit (nicht blockierend)
    _sendPayoutEmails(payouts, lief).catch(e => console.warn('[email payouts]', e.message));

    return { payouts, txHash };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function _sendPayoutEmails(payouts, lief) {
  for (const p of payouts) {
    try {
      const { rows: [detail] } = await db.query(`
        SELECT u.email, e.betrieb_name FROM erzeuger e
        JOIN users u ON u.id = e.user_id WHERE e.id = $1
      `, [p.erzeuger_id]);

      if (detail) {
        await email.sendAuszahlungVeranlasst({
          erzeugerEmail: detail.email,
          erzeugerName:  detail.betrieb_name,
          auszahlung: {
            ...p,
            abzug_qualitaet: p.abzug?.toFixed(2),
            platform_fee:    p.fee?.toFixed(2),
            netto:           p.netto?.toFixed(2),
            brutto:          p.brutto?.toFixed(2),
            produkt:         lief.produkt,
            lieferwoche:     lief.lieferwoche,
            menge:           (parseFloat(lief.menge_geliefert) * (parseFloat(p.menge) / payouts.reduce((s,x) => s + parseFloat(x.menge), 0))).toFixed(1),
          },
        });
      }
    } catch (emailErr) {
      console.warn(`[email payout erzeuger ${p.erzeuger_id}]`, emailErr.message);
    }
  }
}

module.exports = { calculateAndCreatePayouts };
