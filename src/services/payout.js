/**
 * AUSZAHLUNGS-SERVICE
 *
 * Berechnet anteilige Auszahlungen je Erzeuger nach Liefereingang.
 * Regel:
 *   brutto        = gelieferter_anteil × preis
 *   qualitätsabzug = brutto × abzugFaktor(qualitaet)
 *   platform_fee  = brutto × platform_fee_pct / 100
 *   netto         = brutto − qualitätsabzug − platform_fee
 */

const db = require('../db');
const chain = require('./chain');

const QUALITAETS_ABZUG = {
  A: 0,
  B: 0.05,   // 5% Abzug
  C: 0.15,   // 15% Abzug
  abgelehnt: 1.0,
};

async function calculateAndCreatePayouts(lieferung_id) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lieferung + Pool laden
    const { rows: [lief] } = await client.query(`
      SELECT l.*, p.preis_pro_einheit, p.platform_fee_pct, p.menge_ziel
      FROM lieferungen l
      JOIN pools p ON p.id = l.pool_id
      WHERE l.id = $1
    `, [lieferung_id]);

    if (!lief) throw new Error('Lieferung nicht gefunden');
    if (!lief.menge_geliefert) throw new Error('Menge geliefert fehlt');

    const abzugFaktor = QUALITAETS_ABZUG[lief.qualitaet] ?? 0;
    const feePct = parseFloat(lief.platform_fee_pct) / 100;

    // Alle aktiven Commitments für diesen Pool
    const { rows: commitments } = await client.query(`
      SELECT c.id, c.erzeuger_id, c.menge
      FROM commitments c
      WHERE c.pool_id = $1 AND c.status = 'aktiv'
    `, [lief.pool_id]);

    const total_committed = commitments.reduce((s, c) => s + parseFloat(c.menge), 0);
    const payouts = [];

    for (const c of commitments) {
      const anteil = parseFloat(c.menge) / total_committed;
      const geliefert = parseFloat(lief.menge_geliefert) * anteil;
      const brutto = geliefert * parseFloat(lief.preis_pro_einheit);
      const abzug = brutto * abzugFaktor;
      const fee = brutto * feePct;
      const netto = brutto - abzug - fee;

      const { rows: [az] } = await client.query(`
        INSERT INTO auszahlungen
          (commitment_id, lieferung_id, erzeuger_id, brutto, abzug_qualitaet, platform_fee, netto)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [c.id, lieferung_id, c.erzeuger_id,
          brutto.toFixed(2), abzug.toFixed(2), fee.toFixed(2), netto.toFixed(2)]);

      // Commitment als geliefert markieren
      await client.query(
        `UPDATE commitments SET status = 'geliefert' WHERE id = $1`,
        [c.id]
      );

      payouts.push({ ...c, netto: parseFloat(netto.toFixed(2)), auszahlung_id: az.id });
    }

    // Pool schließen
    await client.query(
      `UPDATE pools SET status = 'geliefert' WHERE id = $1`,
      [lief.pool_id]
    );

    // On-chain Auszahlung auslösen
    const { txHash } = await chain.releasePayments(lief.pool_id, payouts);

    // Alle Auszahlungen als veranlasst markieren
    await client.query(`
      UPDATE auszahlungen SET status = 'veranlasst', chain_tx = $1
      WHERE lieferung_id = $2
    `, [txHash, lieferung_id]);

    await client.query('COMMIT');
    return { payouts, txHash };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { calculateAndCreatePayouts };
