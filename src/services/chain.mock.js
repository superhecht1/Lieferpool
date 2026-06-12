/**
 * chain.mock.js – Blockchain-Mock für Entwicklung/Staging
 * Generiert realistische Pseudo-TxHashes, persistiert Events in DB.
 */
const db = require('../db');

function mockTx() {
  const chars = '0123456789abcdef';
  let hash = '0x';
  for (let i = 0; i < 64; i++) hash += chars[Math.floor(Math.random() * 16)];
  return { txHash: hash, blockNr: Math.floor(Math.random() * 1_000_000 + 40_000_000) };
}

async function logEvent(eventType, entityId, entityType, txHash, blockNr, payload = {}) {
  try {
    await db.query(
      `INSERT INTO chain_events (event_type, entity_id, entity_type, tx_hash, block_nr, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventType, entityId, entityType, txHash, blockNr, JSON.stringify(payload)]
    );
  } catch (err) {
    console.warn('[chain.mock] logEvent fehlgeschlagen:', err.message);
  }
}

async function createPool(poolId, { produkt, menge_ziel, preis, deadline } = {}) {
  const r = mockTx();
  try { await db.query(`UPDATE pools SET chain_tx=$1 WHERE id=$2`, [r.txHash, poolId]); } catch {}
  await logEvent('pool_created', poolId, 'pool', r.txHash, r.blockNr, { produkt, menge_ziel, preis, deadline });
  console.log(`[chain.mock] createPool ${produkt} → ${r.txHash}`);
  return r;
}

async function commitQuantity(commitmentId, poolId, erzeugerId, menge) {
  const r = mockTx();
  try { await db.query(`UPDATE commitments SET chain_tx=$1 WHERE id=$2`, [r.txHash, commitmentId]); } catch {}
  await logEvent('quantity_committed', commitmentId, 'commitment', r.txHash, r.blockNr, { poolId, erzeugerId, menge });
  console.log(`[chain.mock] commitQuantity ${menge}kg → ${r.txHash}`);
  return r;
}

async function lockPool(poolId) {
  const r = mockTx();
  await logEvent('pool_locked', poolId, 'pool', r.txHash, r.blockNr, {});
  console.log(`[chain.mock] lockPool → ${r.txHash}`);
  return r;
}

async function confirmDelivery(lieferungId, poolId, mengeGeliefert, qualitaet) {
  const r = mockTx();
  try { await db.query(`UPDATE lieferungen SET chain_tx=$1 WHERE id=$2`, [r.txHash, lieferungId]); } catch {}
  await logEvent('delivery_confirmed', lieferungId, 'lieferung', r.txHash, r.blockNr, { poolId, mengeGeliefert, qualitaet });
  console.log(`[chain.mock] confirmDelivery ${mengeGeliefert}kg → ${r.txHash}`);
  return r;
}

async function releasePayments(poolId, payouts = []) {
  const r = mockTx();
  try {
    for (const p of payouts) {
      await db.query(`UPDATE auszahlungen SET chain_tx=$1 WHERE id=$2`, [r.txHash, p.id]);
    }
  } catch {}
  await logEvent('payments_released', poolId, 'pool', r.txHash, r.blockNr, { count: payouts.length, total: payouts.reduce((s, p) => s + parseFloat(p.netto || 0), 0) });
  console.log(`[chain.mock] releasePayments ${payouts.length} Erzeuger → ${r.txHash}`);
  return r;
}

async function registerCertificate(erzeugerId, certHash) {
  const r = mockTx();
  await logEvent('certificate_registered', erzeugerId, 'erzeuger', r.txHash, r.blockNr, { certHash });
  console.log(`[chain.mock] registerCertificate → ${r.txHash}`);
  return r;
}

async function verifyCertificate(erzeugerId, certHash) {
  const r = mockTx();
  await logEvent('certificate_verified', erzeugerId, 'erzeuger', r.txHash, r.blockNr, { certHash });
  console.log(`[chain.mock] verifyCertificate → ${r.txHash}`);
  return r;
}

async function getPoolFromChain(poolId) {
  // Mock gibt DB-Daten zurück
  try {
    const { rows: [p] } = await db.query(`SELECT * FROM pools WHERE id=$1`, [poolId]);
    if (!p) return null;
    return {
      exists: true, locked: p.status === 'geschlossen',
      produkt: p.produkt, mengeZiel: parseFloat(p.menge_ziel),
      mengeCommitted: parseFloat(p.menge_committed || 0),
      preis: parseFloat(p.preis_pro_einheit), mockMode: true,
    };
  } catch { return null; }
}

module.exports = {
  createPool, commitQuantity, lockPool,
  confirmDelivery, releasePayments,
  registerCertificate, verifyCertificate,
  getPoolFromChain,
};
