const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // 1. ProducerRegistry
  console.log("1/3 Deploying ProducerRegistry...");
  const Registry = await ethers.getContractFactory("ProducerRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("   ProducerRegistry:", registryAddr);

  // 2. SupplyPool
  console.log("2/3 Deploying SupplyPool...");
  const SupplyPool = await ethers.getContractFactory("SupplyPool");
  const supplyPool = await SupplyPool.deploy(deployer.address, registryAddr);
  await supplyPool.waitForDeployment();
  const supplyPoolAddr = await supplyPool.getAddress();
  console.log("   SupplyPool:", supplyPoolAddr);

  // 3. DeliveryContract
  console.log("3/3 Deploying DeliveryContract...");
  const Delivery = await ethers.getContractFactory("DeliveryContract");
  const delivery = await Delivery.deploy(deployer.address, supplyPoolAddr);
  await delivery.waitForDeployment();
  const deliveryAddr = await delivery.getAddress();
  console.log("   DeliveryContract:", deliveryAddr);

  // DeliveryContract braucht ADMIN_ROLE auf SupplyPool
  // (damit er markDelivered() aufrufen kann)
  console.log("\nSetup Rollen...");
  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  await supplyPool.grantRole(ADMIN_ROLE, deliveryAddr);
  console.log("   DeliveryContract hat ADMIN_ROLE auf SupplyPool");

  // Ausgabe für .env
  console.log("\n====================================================");
  console.log("In dein Backend .env eintragen:");
  console.log("====================================================");
  console.log(`CONTRACT_PRODUCER_REGISTRY=${registryAddr}`);
  console.log(`CONTRACT_SUPPLY_POOL=${supplyPoolAddr}`);
  console.log(`CONTRACT_DELIVERY=${deliveryAddr}`);
  console.log(`CHAIN_RPC_URL=<dein RPC>`);
  console.log(`CHAIN_PRIVATE_KEY=<admin private key>`);
  console.log("====================================================");

  return { registryAddr, supplyPoolAddr, deliveryAddr };
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
