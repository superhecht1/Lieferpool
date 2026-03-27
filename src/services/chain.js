/**
 * BLOCKCHAIN SERVICE
 *
 * Aktuell: Mock-Implementierung (gibt sofort zurück)
 * Produktiv: Austausch gegen echten ethers.js / web3 Aufruf
 *
 * Alle Funktionen geben { txHash, blockNr } zurück –
 * das Interface bleibt gleich egal ob Mock oder echte Chain.
 */

const db = require('../db');

// Mock-TX generieren
function mockTx() {
  return '0x' + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

function mockBlock() {
  return Math.floor(4800000 + Math.random() * 100000);
}

async function logChainEvent(event_type, entity_id, entity_type, tx_hash, block_nr, payload = {}) {
  await db.query(
    `INSERT INTO chain_events (event_type, entity_id, entity_type, tx_hash, block_nr, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [event_type, entity_id, entity_type, tx_hash, block_nr, JSON.stringify(payload)]
  );
}

// ----------------------------------------------------------------
// ProducerRegistry.registerProducer()
// Speichert Zertifikat-Hash on-chain
// ----------------------------------------------------------------
async function registerCertificate(erzeuger_id, cert_hash) {
  // TODO: ethers.js → ProducerRegistry.verifyProducer(did, certHash)
  const txHash = mockTx();
  const blockNr = mockBlock();

  await logChainEvent('certificate_registered', erzeuger_id, 'erzeuger', txHash, blockNr, {
    cert_hash,
  });

  return { txHash, blockNr };
}

// ----------------------------------------------------------------
// SupplyPool.createPool()
// ----------------------------------------------------------------
async function createPool(pool_id, { produkt, menge_ziel, preis, deadline }) {
  // TODO: ethers.js → SupplyPool.createPool(poolId, minQty, deadline)
  const txHash = mockTx();
  const blockNr = mockBlock();

  await db.query(
    `UPDATE pools SET chain_contract = $1, chain_tx = $2 WHERE id = $3`,
    ['0xPool' + pool_id.slice(0, 8), txHash, pool_id]
  );

  await logChainEvent('pool_created', pool_id, 'pool', txHash, blockNr, {
    produkt, menge_ziel, preis, deadline,
  });

  return { txHash, blockNr };
}

// ----------------------------------------------------------------
// SupplyPool.commitQuantity()
// ----------------------------------------------------------------
async function commitQuantity(commitment_id, pool_id, erzeuger_id, menge) {
  // TODO: ethers.js → SupplyPool.commitQuantity(poolId, producerDid, qty)
  const txHash = mockTx();
  const blockNr = mockBlock();

  await db.query(
    `UPDATE commitments SET chain_tx = $1 WHERE id = $2`,
    [txHash, commitment_id]
  );

  await logChainEvent('quantity_committed', commitment_id, 'commitment', txHash, blockNr, {
    pool_id, erzeuger_id, menge,
  });

  return { txHash, blockNr };
}

// ----------------------------------------------------------------
// SupplyPool.lockPool() – wenn Mindestmenge erreicht
// ----------------------------------------------------------------
async function lockPool(pool_id) {
  // TODO: ethers.js → SupplyPool.lockPool(poolId)
  const txHash = mockTx();
  const blockNr = mockBlock();

  await logChainEvent('pool_locked', pool_id, 'pool', txHash, blockNr, {});
  return { txHash, blockNr };
}

// ----------------------------------------------------------------
// DeliveryContract.confirmDelivery()
// ----------------------------------------------------------------
async function confirmDelivery(lieferung_id, pool_id, menge_geliefert, qualitaet) {
  // TODO: ethers.js → DeliveryContract.confirmDelivery(poolId, qty, qualityLevel)
  const txHash = mockTx();
  const blockNr = mockBlock();

  await db.query(
    `UPDATE lieferungen SET chain_tx = $1 WHERE id = $2`,
    [txHash, lieferung_id]
  );

  await logChainEvent('delivery_confirmed', lieferung_id, 'lieferung', txHash, blockNr, {
    pool_id, menge_geliefert, qualitaet,
  });

  return { txHash, blockNr };
}

// ----------------------------------------------------------------
// DeliveryContract.releasePayments()
// ----------------------------------------------------------------
async function releasePayments(pool_id, payouts) {
  // payouts = [{ erzeuger_id, commitment_id, netto }, ...]
  // TODO: ethers.js → DeliveryContract.releasePayments(poolId, addresses, amounts)
  const txHash = mockTx();
  const blockNr = mockBlock();

  await logChainEvent('payments_released', pool_id, 'pool', txHash, blockNr, {
    payouts_count: payouts.length,
    total: payouts.reduce((s, p) => s + p.netto, 0),
  });

  return { txHash, blockNr };
}

module.exports = {
  registerCertificate,
  createPool,
  commitQuantity,
  lockPool,
  confirmDelivery,
  releasePayments,
};
