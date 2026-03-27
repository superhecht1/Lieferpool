require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: "../.env" });

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    amoy: {
      url: process.env.POLYGON_AMOY_RPC || "https://rpc-amoy.polygon.technology",
      accounts: process.env.CHAIN_PRIVATE_KEY ? [process.env.CHAIN_PRIVATE_KEY] : [],
      chainId: 80002,
    },
    polygon: {
      url: process.env.POLYGON_RPC || "https://polygon-rpc.com",
      accounts: process.env.CHAIN_PRIVATE_KEY ? [process.env.CHAIN_PRIVATE_KEY] : [],
      chainId: 137,
    },
  },
  etherscan: {
    apiKey: { polygon: process.env.POLYGONSCAN_API_KEY || "", polygonAmoy: process.env.POLYGONSCAN_API_KEY || "" },
  },
};
