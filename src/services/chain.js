/**
 * chain.js – Smart Router: Mock oder Polygon-Produktion
 *
 * BLOCKCHAIN_ENABLED=true  → chain.production.js (echte Polygon-Transaktionen)
 * BLOCKCHAIN_ENABLED=false → Mock (generiert Pseudo-TxHashes, loggt in DB)
 */

if (process.env.BLOCKCHAIN_ENABLED === 'true') {
  module.exports = require('./chain.production');
} else {
  module.exports = require('./chain.mock');
}
