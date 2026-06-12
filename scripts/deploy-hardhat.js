/**
 * deploy-hardhat.js – Hardhat Deploy Script
 * Verwendung: npx hardhat run scripts/deploy-hardhat.js --network polygon
 */
const hre = require('hardhat');
const fs  = require('fs');

async function main() {
  console.log('🚀 Deploye LieferPool auf', hre.network.name);
  const [deployer] = await hre.ethers.getSigners();
  console.log('👛 Deployer:', deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log('💰 Balance:', hre.ethers.formatEther(balance), 'MATIC');

  const LieferPool = await hre.ethers.getContractFactory('LieferPool');
  const contract   = await LieferPool.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log('✅ LieferPool deployed:', address);

  // ABI exportieren
  const artifact = await hre.artifacts.readArtifact('LieferPool');
  fs.writeFileSync(
    'src/services/LieferPool.abi.json',
    JSON.stringify(artifact.abi, null, 2)
  );
  console.log('📄 ABI gespeichert: src/services/LieferPool.abi.json');
  console.log('');
  console.log('➡ Render ENV setzen:');
  console.log(`   CONTRACT_ADDRESS=${address}`);
  console.log('   BLOCKCHAIN_ENABLED=true');
}

main().catch(err => { console.error(err); process.exit(1); });
