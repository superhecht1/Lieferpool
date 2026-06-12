/**
 * deploy.js – LieferPool Smart Contract auf Polygon deployen
 *
 * Verwendung:
 *   PRIVATE_KEY=0x... RPC_URL=https://polygon-rpc.com node scripts/deploy.js
 *
 * Nach erfolgreichem Deploy:
 *   1. CONTRACT_ADDRESS auf Render setzen
 *   2. BLOCKCHAIN_ENABLED=true auf Render setzen
 *   3. LieferPool.abi.json in src/services/ ablegen (bereits vorhanden)
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

async function main() {
  const rpcUrl     = process.env.RPC_URL || 'https://polygon-rpc.com';
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY fehlt in .env');

  console.log('🔗 Verbinde mit RPC:', rpcUrl);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(privateKey, provider);

  console.log('👛 Wallet:', wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log('💰 Balance:', ethers.formatEther(balance), 'MATIC');

  if (balance < ethers.parseEther('0.01')) {
    console.warn('⚠ Wenig MATIC! Mindestens 0.01 MATIC für Gas empfohlen.');
  }

  // Solidity-Quellcode lesen und kompilieren
  // Für Produktion: npm install solc und kompilieren
  // Alternativ: Remix IDE nutzen und ABI+Bytecode manuell einfügen

  // Bytecode aus vorcompiliertem Artifact laden (falls vorhanden)
  const artifactPath = path.join(__dirname, '..', 'artifacts', 'LieferPool.json');
  let bytecode;

  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    bytecode = artifact.bytecode;
    console.log('📦 Artifact geladen');
  } else {
    console.log('⚠ Kein kompiliertes Artifact gefunden.');
    console.log('');
    console.log('Option 1 – Hardhat:');
    console.log('  npx hardhat compile');
    console.log('  node scripts/deploy.js');
    console.log('');
    console.log('Option 2 – Remix IDE:');
    console.log('  1. LieferPool.sol in Remix öffnen');
    console.log('  2. Kompilieren (Solidity 0.8.19)');
    console.log('  3. Deploy auf Polygon Mainnet oder Mumbai Testnet');
    console.log('  4. CONTRACT_ADDRESS in Render ENV setzen');
    console.log('');
    console.log('Option 3 – Hardhat deploy script:');
    console.log('  npx hardhat run scripts/deploy-hardhat.js --network polygon');
    process.exit(0);
  }

  // ABI laden
  const abi = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'LieferPool.abi.json'), 'utf8'
  ));

  console.log('\n🚀 Deploye LieferPool...');
  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();

  console.log('⏳ Warte auf Bestätigung...');
  const receipt = await contract.deploymentTransaction().wait(2);

  const address = await contract.getAddress();
  console.log('\n✅ LieferPool deployed!');
  console.log('📍 Contract Address:', address);
  console.log('🔗 TX Hash:', receipt.hash);
  console.log('🔢 Block:', receipt.blockNumber);
  console.log('⛽ Gas Used:', receipt.gasUsed.toString());
  console.log('');
  console.log('➡ Nächste Schritte:');
  console.log('   Render ENV setzen:');
  console.log(`   CONTRACT_ADDRESS=${address}`);
  console.log('   BLOCKCHAIN_ENABLED=true');
  console.log('   RPC_URL=' + rpcUrl);
  console.log('   PRIVATE_KEY=<dein-private-key>');
  console.log('');
  console.log('🔍 Polygonscan:', `https://polygonscan.com/address/${address}`);

  // In Datei schreiben
  fs.writeFileSync(
    path.join(__dirname, '..', '.contract-address'),
    address
  );
}

main().catch(err => {
  console.error('❌ Deploy fehlgeschlagen:', err.message);
  process.exit(1);
});
