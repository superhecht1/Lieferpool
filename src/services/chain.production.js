/**
 * chain.production.js – Echte Polygon-Blockchain Integration
 *
 * Voraussetzungen (Render Environment Variables):
 *   BLOCKCHAIN_ENABLED = true
 *   CONTRACT_ADDRESS   = 0x...  (nach Deploy)
 *   PRIVATE_KEY        = 0x...  (Wallet Private Key)
 *   RPC_URL            = https://polygon-rpc.com
 *
 * Verwendet ethers.js v6
 */

const { ethers } = require('ethers');
const path = require('path');
const fs   = require('fs');

// ABI laden (wird nach Deploy generiert)
let ABI = [];
const abiPath = path.join(__dirname, 'LieferPool.abi.json');
if (fs.existsSync(abiPath)) {
  ABI = require(abiPath);
} else {
  // Minimal-ABI falls Datei nicht vorhanden (Fallback)
  ABI = [
    'function createPool(bytes32,string,uint256,uint256,uint256) external',
    'function commitQuantity(bytes32,bytes32,bytes32,uint256) external',
    'function lockPool(bytes32) external',
    'function releasePayments(bytes32,bytes32,bytes32[],uint256[]) external',
    'function registerCertificate(bytes32,bytes32) external',
    'function verifyCertificate(bytes32,bytes32) external',
    'function getPool(bytes32) external view returns (tuple(bool,bool,string,uint256,uint256,uint256,uint256,uint256))',
    'event PoolCreated(bytes32 indexed,string,uint256,uint256,uint256)',
    'event QuantityCommitted(bytes32 indexed,bytes32 indexed,bytes32 indexed,uint256)',
    'event PoolLocked(bytes32 indexed,uint256,uint256)',
    'event PaymentsReleased(bytes32 indexed,bytes32 indexed,uint256,uint256)',
    'event CertificateRegistered(bytes32 indexed,bytes32,uint256)',
  ];
}

// ── Provider + Contract ────────────────────────────────────────
let _provider = null;
let _wallet   = null;
let _contract = null;

function getProvider() {
  if (!_provider) {
    const rpc = process.env.RPC_URL || 'https://polygon-rpc.com';
    _provider = new ethers.JsonRpcProvider(rpc);
  }
  return _provider;
}

function getWallet() {
  if (!_wallet) {
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error('PRIVATE_KEY nicht gesetzt');
    _wallet = new ethers.Wallet(pk, getProvider());
  }
  return _wallet;
}

function getContract() {
  if (!_contract) {
    const addr = process.env.CONTRACT_ADDRESS;
    if (!addr) throw new Error('CONTRACT_ADDRESS nicht gesetzt');
    _contract = new ethers.Contract(addr, ABI, getWallet());
  }
  return _contract;
}

// ── Hilfsfunktionen ────────────────────────────────────────────
// UUID → bytes32
function uuidToBytes32(uuid) {
  return '0x' + uuid.replace(/-/g, '').padEnd(64, '0');
}

// String → bytes32
function strToBytes32(str) {
  return ethers.encodeBytes32String(str.slice(0, 31));
}

// Gas-Optimierung: warte auf Bestätigung mit Timeout
async function sendTx(txPromise, label = 'TX') {
  try {
    const tx = await txPromise;
    console.log(`[chain] ${label} gesendet: ${tx.hash}`);
    const receipt = await Promise.race([
      tx.wait(1),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('TX Timeout (60s)')), 60000)
      ),
    ]);
    console.log(`[chain] ${label} bestätigt in Block ${receipt.blockNumber}`);
    return { txHash: tx.hash, blockNr: receipt.blockNumber };
  } catch (err) {
    console.error(`[chain] ${label} fehlgeschlagen:`, err.message);
    throw err;
  }
}

// ── Öffentliche Funktionen ─────────────────────────────────────

async function createPool(poolId, { produkt, menge_ziel, preis, deadline }) {
  const contract = getContract();
  const mengeGramm = Math.round(parseFloat(menge_ziel) * 1000); // kg → g
  const preisCent  = Math.round(parseFloat(preis) * 100);       // € → Cent
  const deadlineTs = Math.floor(new Date(deadline).getTime() / 1000);

  return sendTx(
    contract.createPool(
      uuidToBytes32(poolId),
      produkt.slice(0, 31),
      mengeGramm,
      preisCent,
      deadlineTs
    ),
    `createPool(${produkt})`
  );
}

async function commitQuantity(commitmentId, poolId, erzeugerId, menge) {
  const contract    = getContract();
  const mengeGramm  = Math.round(parseFloat(menge) * 1000);

  return sendTx(
    contract.commitQuantity(
      uuidToBytes32(commitmentId),
      uuidToBytes32(poolId),
      uuidToBytes32(erzeugerId),
      mengeGramm
    ),
    `commit(${menge}kg)`
  );
}

async function lockPool(poolId) {
  const contract = getContract();
  return sendTx(
    contract.lockPool(uuidToBytes32(poolId)),
    `lockPool`
  );
}

async function releasePayments(poolId, payouts) {
  const contract    = getContract();
  const lieferungId = uuidToBytes32(poolId + '-lief'); // Pseudo-ID
  const erzeugerIds = payouts.map(p => uuidToBytes32(p.erzeuger_id));
  const nettoArr    = payouts.map(p => Math.round(parseFloat(p.netto) * 100));

  return sendTx(
    contract.releasePayments(
      uuidToBytes32(poolId),
      lieferungId,
      erzeugerIds,
      nettoArr
    ),
    `releasePayments(${payouts.length} Erzeuger)`
  );
}

async function registerCertificate(erzeugerId, certHash) {
  const contract = getContract();
  const hash32   = typeof certHash === 'string' && certHash.startsWith('0x')
    ? certHash
    : '0x' + certHash.slice(0, 64).padEnd(64, '0');

  return sendTx(
    contract.registerCertificate(
      uuidToBytes32(erzeugerId),
      hash32
    ),
    `registerCert`
  );
}

async function verifyCertificate(erzeugerId, certHash) {
  const contract = getContract();
  const hash32   = '0x' + certHash.slice(0, 64).padEnd(64, '0');

  return sendTx(
    contract.verifyCertificate(uuidToBytes32(erzeugerId), hash32),
    `verifyCert`
  );
}

// Pool-Daten von Chain lesen (für Audit)
async function getPoolFromChain(poolId) {
  try {
    const contract = getContract();
    const data     = await contract.getPool(uuidToBytes32(poolId));
    return {
      exists:         data[0],
      locked:         data[1],
      produkt:        data[2],
      mengeZiel:      Number(data[3]) / 1000,  // g → kg
      mengeCommitted: Number(data[4]) / 1000,
      preis:          Number(data[5]) / 100,   // Cent → €
      deadline:       new Date(Number(data[6]) * 1000).toISOString(),
      createdAt:      new Date(Number(data[7]) * 1000).toISOString(),
    };
  } catch (err) {
    console.error('[chain] getPool fehlgeschlagen:', err.message);
    return null;
  }
}

module.exports = {
  createPool,
  commitQuantity,
  lockPool,
  releasePayments,
  registerCertificate,
  verifyCertificate,
  getPoolFromChain,
};
