require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const PRIVATE_KEY  = process.env.PRIVATE_KEY  || '0x' + '0'.repeat(64);
const POLYGONSCAN_KEY = process.env.POLYGONSCAN_API_KEY || '';

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.19',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },

  networks: {
    // Lokales Hardhat Netzwerk (für Tests)
    hardhat: {
      chainId: 31337,
    },

    // Polygon Mumbai Testnet (Faucet: https://faucet.polygon.technology)
    mumbai: {
      url:      process.env.RPC_URL_MUMBAI || 'https://rpc-mumbai.maticvigil.com',
      accounts: [PRIVATE_KEY],
      chainId:  80001,
      gasPrice: 'auto',
    },

    // Polygon Mainnet
    polygon: {
      url:      process.env.RPC_URL || 'https://polygon-rpc.com',
      accounts: [PRIVATE_KEY],
      chainId:  137,
      gasPrice: 'auto',
    },
  },

  // Contract-Verifizierung auf PolygonScan
  etherscan: {
    apiKey: {
      polygonMumbai: POLYGONSCAN_KEY,
      polygon:       POLYGONSCAN_KEY,
    },
  },

  paths: {
    sources:   './contracts',
    tests:     './test',
    cache:     './cache',
    artifacts: './artifacts',
  },
};
