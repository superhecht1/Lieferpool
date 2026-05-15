/**
 * deploy.js – LieferPool Smart Contract Deployment
 *
 * Testnet:  npx hardhat run scripts/deploy.js --network mumbai
 * Mainnet:  npx hardhat run scripts/deploy.js --network polygon
 * Lokal:    npx hardhat run scripts/deploy.js --network hardhat
 *
 * Nach dem Deploy:
 * 1. CONTRACT_ADDRESS in Render Environment Variables eintragen
 * 2. BLOCKCHAIN_ENABLED=true setzen
 */

const { ethers } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();

  console.log('='.repeat(50));
  console.log('LieferPool Contract Deployment');
  console.log('='.repeat(50));
  console.log('Network:   ', network.name, `(chainId: ${network.chainId})`);
  console.log('Deployer:  ', deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Balance:   ', ethers.formatEther(balance), 'MATIC');
  console.log('='.repeat(50));

  if (balance === 0n) {
    throw new Error('Wallet hat kein MATIC! Aufladen unter https://faucet.polygon.technology');
  }

  // Gas-Schätzung
  const factory  = await ethers.getContractFactory('LieferPool');
  const gasEstimate = await ethers.provider.estimateGas(
    await factory.getDeployTransaction()
  );
  const gasPrice = await ethers.provider.getFeeData();
  const cost     = gasEstimate * (gasPrice.gasPrice || 30000000000n);
  console.log('Geschätzte Gas-Kosten:', ethers.formatEther(cost), 'MATIC');

  if (cost > balance) {
    throw new Error(`Nicht genug MATIC. Benötigt: ${ethers.formatEther(cost)}, Vorhanden: ${ethers.formatEther(balance)}`);
  }

  // Deployment
  console.log('\nDeploye LieferPool Contract...');
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const tx      = contract.deploymentTransaction();

  console.log('='.repeat(50));
  console.log('✅ Contract deployed!');
  console.log('CONTRACT_ADDRESS:', address);
  console.log('TX Hash:         ', tx?.hash);
  console.log('='.repeat(50));

  // Explorer-Link
  const explorerMap = {
    137:   `https://polygonscan.com/address/${address}`,
    80001: `https://mumbai.polygonscan.com/address/${address}`,
  };
  if (explorerMap[Number(network.chainId)]) {
    console.log('PolygonScan:     ', explorerMap[Number(network.chainId)]);
  }

  console.log('\n📋 Jetzt in Render eintragen:');
  console.log(`   CONTRACT_ADDRESS  = ${address}`);
  console.log(`   BLOCKCHAIN_ENABLED = true`);
  console.log(`   PRIVATE_KEY        = (dein Wallet Private Key)`);
  console.log(`   RPC_URL            = https://polygon-rpc.com`);

  // ABI speichern für chain.production.js
  const fs       = require('fs');
  const artifact = require('../artifacts/contracts/LieferPool.sol/LieferPool.json');
  fs.writeFileSync(
    './src/services/LieferPool.abi.json',
    JSON.stringify(artifact.abi, null, 2)
  );
  console.log('\n✅ ABI gespeichert unter src/services/LieferPool.abi.json');
  console.log('='.repeat(50));
}

main().catch(err => {
  console.error('❌ Deploy fehlgeschlagen:', err.message);
  process.exit(1);
});
