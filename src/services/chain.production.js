/**
 * BLOCKCHAIN SERVICE (Produktiv)
 *
 * Tauscht den Mock in src/services/chain.js aus.
 * Voraussetzung: Contracts deployed, .env gesetzt.
 *
 * Verwendung:
 *   cp contracts/src/chain.production.js src/services/chain.js
 */

const { ethers } = require("ethers");
const db = require("../db");

// ----------------------------------------------------------------
// ABIs (minimale ABI – nur genutzte Funktionen)
// ----------------------------------------------------------------
const REGISTRY_ABI = [
  "function registerProducer(bytes32 did) external",
  "function verifyProducer(address producer) external",
  "function isEligible(address producer) external view returns (bool)",
  "function addCertificate(bytes32 docHash, string certType, uint256 validUntil) external",
];

const SUPPLY_POOL_ABI = [
  "function createPool(bytes32 poolId, string produkt, uint256 mengeZiel, uint256 preisProKg, uint256 deadline, uint8 toleranzPct, uint8 feePct) external",
  "function commitQuantity(bytes32 poolId, uint256 menge) external",
  "function lockPool(bytes32 poolId) external",
  "function getFuellstand(bytes32 poolId) external view returns (uint256)",
  "function getPool(bytes32 poolId) external view returns (tuple(bytes32,address,string,uint256,uint256,uint256,uint256,uint8,uint8,uint8,uint256))",
];

const DELIVERY_ABI = [
  "function confirmDelivery(bytes32 deliveryId, bytes32 poolId, uint256 mengeGeliefertG, uint8 qualitaet, bytes32 lieferscheinHash) external",
  "function releasePayouts(bytes32 deliveryId) external",
  "function getPayouts(bytes32 deliveryId) external view returns (tuple(address,uint256,uint256,uint256,uint256,uint256,uint256)[])",
  "function getTotalPayout(bytes32 deliveryId) external view returns (uint256, uint256)",
];

// ----------------------------------------------------------------
// Provider + Signer
// ----------------------------------------------------------------
let _provider, _wallet, _registry, _supplyPool, _delivery;

function getContracts() {
  if (_registry) return { registry: _registry, supplyPool: _supplyPool, delivery: _delivery };

  _provider  = new ethers.JsonRpcProvider(process.env.CHAIN_RPC_URL);
  _wallet    = new ethers.Wallet(process.env.CHAIN_PRIVATE_KEY, _provider);

  _registry  = new ethers.Contract(process.env.CONTRACT_PRODUCER_REGISTRY, REGISTRY_ABI,  _wallet);
  _supplyPool = new ethers.Contract(process.env.CONTRACT_SUPPLY_POOL,      SUPPLY_POOL_ABI, _wallet);
  _delivery  = new ethers.Contract(process.env.CONTRACT_DELIVERY,          DELIVERY_ABI,   _wallet);

  return { registry: _registry, supplyPool: _supplyPool, delivery: _delivery };
}

async function waitAndLog(tx, event_type, entity_id, entity_type, payload = {}) {
  const receipt = await tx.wait();
  const txHash  = receipt.hash;
  const blockNr = receipt.blockNumber;

  await db.query(
    `INSERT INTO chain_events (event_type, entity_id, entity_type, tx_hash, block_nr, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [event_type, entity_id, entity_type, txHash, blockNr, JSON.stringify(payload)]
  );

  return { txHash, blockNr };
}

// ----------------------------------------------------------------
// ProducerRegistry.registerProducer()
// ----------------------------------------------------------------
async function registerCertificate(erzeuger_id, cert_hash_hex) {
  const { registry } = getContracts();
  const docHash = ethers.hexlify(ethers.zeroPadValue("0x" + cert_hash_hex, 32));
  const tx = await registry.addCertificate(docHash, "Bio", Math.floor(Date.now() / 1000) + 365 * 86400);
  return waitAndLog(tx, "certificate_registered", erzeuger_id, "erzeuger", { cert_hash_hex });
}

// ----------------------------------------------------------------
// SupplyPool.createPool()
// ----------------------------------------------------------------
async function createPool(pool_id, { produkt, menge_ziel, preis, deadline }) {
  const { supplyPool } = getContracts();

  const poolIdBytes  = ethers.keccak256(ethers.toUtf8Bytes(pool_id));
  const mengeZielG   = BigInt(Math.round(parseFloat(menge_ziel) * 1000)); // kg → g
  const preisEurCent = BigInt(Math.round(parseFloat(preis) * 100));       // € → Cent
  const deadlineTs   = BigInt(Math.floor(new Date(deadline).getTime() / 1000));

  const tx = await supplyPool.createPool(
    poolIdBytes, produkt, mengeZielG, preisEurCent, deadlineTs, 5, 1
  );
  const result = await waitAndLog(tx, "pool_created", pool_id, "pool", { produkt, menge_ziel, preis });

  // Contract-Adresse in DB speichern
  await db.query(
    `UPDATE pools SET chain_contract = $1, chain_tx = $2 WHERE id = $3`,
    [process.env.CONTRACT_SUPPLY_POOL, result.txHash, pool_id]
  );

  return result;
}

// ----------------------------------------------------------------
// SupplyPool.commitQuantity()
// ----------------------------------------------------------------
async function commitQuantity(commitment_id, pool_id, erzeuger_id, menge) {
  const { supplyPool } = getContracts();

  const poolIdBytes = ethers.keccak256(ethers.toUtf8Bytes(pool_id));
  const mengeG      = BigInt(Math.round(parseFloat(menge) * 1000));

  const tx = await supplyPool.commitQuantity(poolIdBytes, mengeG);
  const result = await waitAndLog(tx, "quantity_committed", commitment_id, "commitment", {
    pool_id, erzeuger_id, menge,
  });

  await db.query(
    `UPDATE commitments SET chain_tx = $1 WHERE id = $2`,
    [result.txHash, commitment_id]
  );

  return result;
}

// ----------------------------------------------------------------
// SupplyPool.lockPool()
// ----------------------------------------------------------------
async function lockPool(pool_id) {
  const { supplyPool } = getContracts();
  const poolIdBytes = ethers.keccak256(ethers.toUtf8Bytes(pool_id));
  const tx = await supplyPool.lockPool(poolIdBytes);
  return waitAndLog(tx, "pool_locked", pool_id, "pool", {});
}

// ----------------------------------------------------------------
// DeliveryContract.confirmDelivery()
// ----------------------------------------------------------------
async function confirmDelivery(lieferung_id, pool_id, menge_geliefert, qualitaet) {
  const { delivery } = getContracts();

  const deliveryIdBytes     = ethers.keccak256(ethers.toUtf8Bytes(lieferung_id));
  const poolIdBytes         = ethers.keccak256(ethers.toUtf8Bytes(pool_id));
  const mengeGeliefertG     = BigInt(Math.round(parseFloat(menge_geliefert) * 1000));
  const qualitaetEnum       = { A: 0, B: 1, C: 2, abgelehnt: 3 }[qualitaet] ?? 0;
  const lieferscheinHashHex = ethers.keccak256(ethers.toUtf8Bytes(lieferung_id + menge_geliefert));

  const tx = await delivery.confirmDelivery(
    deliveryIdBytes, poolIdBytes, mengeGeliefertG, qualitaetEnum, lieferscheinHashHex
  );
  const result = await waitAndLog(tx, "delivery_confirmed", lieferung_id, "lieferung", {
    pool_id, menge_geliefert, qualitaet,
  });

  await db.query(
    `UPDATE lieferungen SET chain_tx = $1 WHERE id = $2`,
    [result.txHash, lieferung_id]
  );

  return result;
}

// ----------------------------------------------------------------
// DeliveryContract.releasePayments()
// ----------------------------------------------------------------
async function releasePayments(pool_id, payouts) {
  const { delivery } = getContracts();

  // Wir nehmen den ersten Delivery-Eintrag aus der DB
  const { rows: [lief] } = await db.query(
    `SELECT id FROM lieferungen WHERE pool_id = $1 LIMIT 1`, [pool_id]
  );
  if (!lief) throw new Error("Keine Lieferung für Pool gefunden");

  const deliveryIdBytes = ethers.keccak256(ethers.toUtf8Bytes(lief.id));
  const tx = await delivery.releasePayouts(deliveryIdBytes);

  return waitAndLog(tx, "payments_released", pool_id, "pool", {
    payouts_count: payouts.length,
    total: payouts.reduce((s, p) => s + p.netto, 0),
  });
}

module.exports = {
  registerCertificate,
  createPool,
  commitQuantity,
  lockPool,
  confirmDelivery,
  releasePayments,
};
