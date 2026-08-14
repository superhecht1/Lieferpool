/**
 * covalent.js – GoldRush/Covalent API Client für FrischKette
 * Lesezugriffe auf Polygon via strukturierte REST-API
 * Docs: https://www.covalenthq.com/docs/api/
 *
 * ENV: COVALENT_API_KEY (kostenlos: https://www.covalenthq.com/platform/)
 */

const CHAIN    = process.env.COVALENT_CHAIN || 'matic-mainnet'; // oder 'matic-mumbai'
const BASE_URL = 'https://api.covalenthq.com/v1';

function apiKey() {
  return process.env.COVALENT_API_KEY || '';
}

function authHeader() {
  const key = apiKey();
  if (!key) return {};
  // Basic Auth: API_KEY als Username, leeres Passwort
  return { 'Authorization': 'Basic ' + Buffer.from(key + ':').toString('base64') };
}

async function get(path) {
  const fetch = (await import('node-fetch')).default;
  const url   = `${BASE_URL}${path}`;
  const res   = await fetch(url, { headers: { ...authHeader(), 'Content-Type': 'application/json' } });
  const json  = await res.json();
  if (json.error) throw new Error(json.error_message || 'Covalent API Fehler');
  return json.data;
}

/**
 * Wallet-Balance (MATIC + Token)
 * Gibt nativen MATIC-Balance zurück
 */
async function getWalletBalance(walletAddress) {
  const data  = await get(`/${CHAIN}/address/${walletAddress}/balances_v2/`);
  const items = data.items || [];
  // Nativer MATIC-Token hat contract_ticker_symbol === 'MATIC' und contract_address null
  const matic = items.find(i => i.native_token === true || i.contract_ticker_symbol === 'MATIC');
  if (!matic) return '0.0000';
  const balance = parseFloat(matic.balance) / Math.pow(10, matic.contract_decimals || 18);
  return balance.toFixed(4);
}

/**
 * Aktuelle Block-Nummer
 */
async function getLatestBlock() {
  // Chain-Status über /chains/status/
  const fetch = (await import('node-fetch')).default;
  const res   = await fetch(`${BASE_URL}/chains/status/`, {
    headers: { ...authHeader(), 'Content-Type': 'application/json' }
  });
  const json = await res.json();
  const chains = json.data?.items || [];
  const poly   = chains.find(c => c.name === 'matic-mainnet' || c.chain_id === '137');
  return poly?.synced_block_height || poly?.latest_block_height || null;
}

/**
 * Einzelne TX prüfen — Status + Bestätigungen
 */
async function getTransaction(txHash) {
  try {
    const data = await get(`/${CHAIN}/transaction_v2/${txHash}/`);
    const tx   = data.items?.[0];
    if (!tx) return null;
    return {
      hash:         tx.tx_hash,
      blockNr:      tx.block_height,
      status:       tx.successful ? 'success' : 'failed',
      gasUsed:      tx.gas_spent,
      timestamp:    tx.block_signed_at,
      value:        tx.value,
      from:         tx.from_address,
      to:           tx.to_address,
      explorerUrl:  `https://polygonscan.com/tx/${tx.tx_hash}`,
    };
  } catch { return null; }
}

/**
 * Contract-Events vom LieferPool-Contract live abrufen
 */
async function getContractEvents(contractAddress, { startBlock, endBlock, pageSize = 50 } = {}) {
  if (!contractAddress) return [];
  try {
    let path = `/${CHAIN}/events/address/${contractAddress}/?page-size=${pageSize}`;
    if (startBlock) path += `&starting-block=${startBlock}`;
    if (endBlock)   path += `&ending-block=${endBlock}`;
    const data   = await get(path);
    const items  = data.items || [];
    return items.map(e => ({
      blockNr:    e.block_height,
      txHash:     e.tx_hash,
      timestamp:  e.block_signed_at,
      logOffset:  e.log_offset,
      name:       e.decoded?.name || 'UnknownEvent',
      params:     e.decoded?.params || [],
      raw:        e.raw_log_topics,
      explorerUrl:`https://polygonscan.com/tx/${e.tx_hash}`,
    }));
  } catch (err) {
    console.warn('[covalent] getContractEvents:', err.message);
    return [];
  }
}

/**
 * Wallet-Transaktionen (letzte N)
 */
async function getWalletTransactions(walletAddress, limit = 25) {
  try {
    const data  = await get(`/${CHAIN}/address/${walletAddress}/transactions_v3/`);
    const items = (data.items || []).slice(0, limit);
    return items.map(tx => ({
      hash:        tx.tx_hash,
      blockNr:     tx.block_height,
      timestamp:   tx.block_signed_at,
      status:      tx.successful ? 'success' : 'failed',
      value:       parseFloat(tx.value || 0) / 1e18,
      gasUsed:     tx.gas_spent,
      to:          tx.to_address,
      explorerUrl: `https://polygonscan.com/tx/${tx.tx_hash}`,
    }));
  } catch (err) {
    console.warn('[covalent] getWalletTransactions:', err.message);
    return [];
  }
}

/**
 * Status-Check: Ist Covalent konfiguriert?
 */
function isConfigured() {
  return !!apiKey() && !!process.env.CONTRACT_ADDRESS;
}

module.exports = {
  isConfigured,
  getWalletBalance,
  getLatestBlock,
  getTransaction,
  getContractEvents,
  getWalletTransactions,
  CHAIN,
};
