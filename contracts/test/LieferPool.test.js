const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("LieferPool Smart Contracts", function () {
  let registry, supplyPool, delivery;
  let admin, caterer, producer1, producer2, producer3;

  const ADMIN_ROLE   = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const CATERER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CATERER_ROLE"));

  // Hilfsfunktionen
  const keccak = (str) => ethers.keccak256(ethers.toUtf8Bytes(str));
  const oneDay  = 86400;

  beforeEach(async () => {
    [admin, caterer, producer1, producer2, producer3] = await ethers.getSigners();

    const Registry   = await ethers.getContractFactory("ProducerRegistry");
    const SupplyPool = await ethers.getContractFactory("SupplyPool");
    const Delivery   = await ethers.getContractFactory("DeliveryContract");

    registry  = await Registry.deploy(admin.address);
    supplyPool = await SupplyPool.deploy(admin.address, await registry.getAddress());
    delivery  = await Delivery.deploy(admin.address, await supplyPool.getAddress());

    // DeliveryContract bekommt ADMIN_ROLE auf SupplyPool
    await supplyPool.grantRole(ADMIN_ROLE, await delivery.getAddress());

    // Caterer-Rolle
    await delivery.addCaterer(caterer.address);
    await supplyPool.grantRole(CATERER_ROLE, caterer.address);
  });

  // ================================================================
  // ProducerRegistry
  // ================================================================
  describe("ProducerRegistry", () => {
    it("Erzeuger kann sich registrieren", async () => {
      const did = keccak("uuid-producer-1");
      await registry.connect(producer1).registerProducer(did);

      const p = await registry.getProducer(producer1.address);
      expect(p.did).to.equal(did);
      expect(p.verified).to.be.false;
      expect(p.active).to.be.true;
    });

    it("Doppelte Registrierung wird abgelehnt", async () => {
      const did = keccak("uuid-p1");
      await registry.connect(producer1).registerProducer(did);
      await expect(
        registry.connect(producer1).registerProducer(did)
      ).to.be.revertedWith("Bereits registriert");
    });

    it("Admin kann Erzeuger verifizieren", async () => {
      await registry.connect(producer1).registerProducer(keccak("uuid-p1"));
      await registry.connect(admin).verifyProducer(producer1.address);

      const p = await registry.getProducer(producer1.address);
      expect(p.verified).to.be.true;
    });

    it("isEligible = false ohne gültiges Zertifikat", async () => {
      await registry.connect(producer1).registerProducer(keccak("uuid-p1"));
      await registry.connect(admin).verifyProducer(producer1.address);

      // Kein Zertifikat → nicht eligible
      expect(await registry.isEligible(producer1.address)).to.be.false;
    });

    it("isEligible = true mit gültigem Zertifikat", async () => {
      await registry.connect(producer1).registerProducer(keccak("uuid-p1"));
      await registry.connect(admin).verifyProducer(producer1.address);

      const futureTs = Math.floor(Date.now() / 1000) + 365 * oneDay;
      await registry.connect(producer1).addCertificate(
        keccak("cert-bio-001"), "Bio", futureTs
      );

      expect(await registry.isEligible(producer1.address)).to.be.true;
    });

    it("isEligible = false nach Sperrung", async () => {
      await registry.connect(producer1).registerProducer(keccak("uuid-p1"));
      await registry.connect(admin).verifyProducer(producer1.address);
      const futureTs = Math.floor(Date.now() / 1000) + 365 * oneDay;
      await registry.connect(producer1).addCertificate(keccak("cert-x"), "Bio", futureTs);

      await registry.connect(admin).suspendProducer(producer1.address);
      expect(await registry.isEligible(producer1.address)).to.be.false;
    });
  });

  // ================================================================
  // SupplyPool
  // ================================================================
  describe("SupplyPool", () => {
    const poolId = ethers.keccak256(ethers.toUtf8Bytes("pool-uuid-001"));
    let deadline;

    beforeEach(async () => {
      deadline = (await time.latest()) + 7 * oneDay;

      // Producer1 + Producer2 verifizieren
      for (const [p, uuid] of [[producer1, "p1"], [producer2, "p2"], [producer3, "p3"]]) {
        await registry.connect(p).registerProducer(keccak(uuid));
        await registry.connect(admin).verifyProducer(p.address);
        const futureTs = (await time.latest()) + 365 * oneDay;
        await registry.connect(p).addCertificate(keccak("cert-" + uuid), "Bio", futureTs);
      }
    });

    it("Admin kann Pool erstellen", async () => {
      await supplyPool.connect(admin).createPool(
        poolId, "Karotten Bio",
        1_000_000, // 1000 kg in Gramm
        180,       // 1,80 €/kg in EUR-Cent
        deadline, 5, 1
      );

      const pool = await supplyPool.getPool(poolId);
      expect(pool.produkt).to.equal("Karotten Bio");
      expect(pool.status).to.equal(0); // Open
    });

    it("Erzeuger kann Menge zusagen", async () => {
      await supplyPool.connect(admin).createPool(
        poolId, "Karotten Bio", 1_000_000, 180, deadline, 5, 1
      );

      await supplyPool.connect(producer1).commitQuantity(poolId, 300_000); // 300 kg
      const pool = await supplyPool.getPool(poolId);
      expect(pool.mengeCommitted).to.equal(300_000n);
    });

    it("Pool wird automatisch gesperrt bei Zielerreichung", async () => {
      await supplyPool.connect(admin).createPool(
        poolId, "Karotten Bio", 500_000, 180, deadline, 5, 1
      );

      await supplyPool.connect(producer1).commitQuantity(poolId, 300_000);
      await supplyPool.connect(producer2).commitQuantity(poolId, 200_000);

      const pool = await supplyPool.getPool(poolId);
      expect(pool.status).to.equal(1); // Locked
    });

    it("Kein Doppel-Commitment möglich", async () => {
      await supplyPool.connect(admin).createPool(
        poolId, "Karotten Bio", 1_000_000, 180, deadline, 5, 1
      );
      await supplyPool.connect(producer1).commitQuantity(poolId, 100_000);

      await expect(
        supplyPool.connect(producer1).commitQuantity(poolId, 50_000)
      ).to.be.revertedWith("Bereits committed");
    });

    it("Commitment-Rückzug funktioniert", async () => {
      await supplyPool.connect(admin).createPool(
        poolId, "Karotten Bio", 1_000_000, 180, deadline, 5, 1
      );
      await supplyPool.connect(producer1).commitQuantity(poolId, 200_000);
      await supplyPool.connect(producer1).withdrawCommitment(poolId);

      const pool = await supplyPool.getPool(poolId);
      expect(pool.mengeCommitted).to.equal(0n);
    });

    it("Commitment nach Deadline abgelehnt", async () => {
      await supplyPool.connect(admin).createPool(
        poolId, "Karotten Bio", 1_000_000, 180, deadline, 5, 1
      );
      await time.increaseTo(deadline + 1);

      await expect(
        supplyPool.connect(producer1).commitQuantity(poolId, 100_000)
      ).to.be.revertedWith("Deadline abgelaufen");
    });

    it("Nicht-verifizierter Erzeuger wird abgelehnt", async () => {
      const [,,,, stranger] = await ethers.getSigners();
      await supplyPool.connect(admin).createPool(
        poolId, "Karotten Bio", 1_000_000, 180, deadline, 5, 1
      );

      await expect(
        supplyPool.connect(stranger).commitQuantity(poolId, 100_000)
      ).to.be.revertedWith("Erzeuger nicht verifiziert");
    });
  });

  // ================================================================
  // DeliveryContract
  // ================================================================
  describe("DeliveryContract", () => {
    const poolId     = keccak("pool-delivery-test");
    const deliveryId = keccak("delivery-001");
    let deadline;

    beforeEach(async () => {
      deadline = (await time.latest()) + 7 * oneDay;

      // Erzeuger anlegen
      for (const [p, uuid] of [[producer1, "dp1"], [producer2, "dp2"]]) {
        await registry.connect(p).registerProducer(keccak(uuid));
        await registry.connect(admin).verifyProducer(p.address);
        const futureTs = (await time.latest()) + 365 * oneDay;
        await registry.connect(p).addCertificate(keccak("c-" + uuid), "Bio", futureTs);
      }

      // Pool anlegen und füllen (500 kg Ziel)
      await supplyPool.connect(admin).createPool(
        poolId, "Karotten Bio", 500_000, 180, deadline, 5, 1
      );
      await supplyPool.connect(producer1).commitQuantity(poolId, 300_000); // 300 kg
      await supplyPool.connect(producer2).commitQuantity(poolId, 200_000); // 200 kg
      // Pool sollte jetzt Locked sein
    });

    it("Caterer kann Wareneingang bestätigen", async () => {
      await delivery.connect(caterer).confirmDelivery(
        deliveryId, poolId,
        490_000,        // 490 kg geliefert
        0,              // Qualität A
        keccak("lieferschein-hash-001")
      );

      const d = await delivery.getDelivery(deliveryId);
      expect(d.mengeGeliefertG).to.equal(490_000n);
      expect(d.qualitaet).to.equal(0); // A
    });

    it("Auszahlungen werden korrekt berechnet (Qualität A)", async () => {
      // 490.000g geliefert, 180 EUR-Cent/kg, 1% Fee
      // Producer1: 300/500 Anteil
      //   anteilG  = 490000 * 300000 / 500000 = 294000g
      //   brutto   = 294000 * 180 / 1000 = 52920 EUR-Cent = 529,20 €
      //   fee      = 52920 * 1 / 100 = 529 EUR-Cent
      //   netto    = 52920 - 529 = 52391 EUR-Cent

      await delivery.connect(caterer).confirmDelivery(
        deliveryId, poolId, 490_000, 0, keccak("ls-001")
      );

      const payoutRecords = await delivery.getPayouts(deliveryId);
      expect(payoutRecords.length).to.equal(2);

      const p1Payout = payoutRecords.find(
        p => p.producer.toLowerCase() === producer1.address.toLowerCase()
      );
      expect(p1Payout).to.not.be.undefined;
      expect(p1Payout.nettoEurCent).to.be.gt(0n);

      // Anteil stimmt (300/500 = 60%)
      expect(p1Payout.mengeG).to.equal(294_000n); // 490000 * 0.6
    });

    it("Qualität B → 5% Abzug", async () => {
      await delivery.connect(caterer).confirmDelivery(
        deliveryId, poolId, 490_000,
        1,  // Qualität B
        keccak("ls-002")
      );

      const recs = await delivery.getPayouts(deliveryId);
      const p1 = recs.find(r => r.producer.toLowerCase() === producer1.address.toLowerCase());

      // Abzug muss > 0 sein
      expect(p1.abzugEurCent).to.be.gt(0n);
      // netto < brutto
      expect(p1.nettoEurCent).to.be.lt(p1.bruttoEurCent);
    });

    it("Qualität Rejected → netto = 0", async () => {
      await delivery.connect(caterer).confirmDelivery(
        deliveryId, poolId, 490_000,
        3,  // Rejected
        keccak("ls-003")
      );

      const recs = await delivery.getPayouts(deliveryId);
      for (const r of recs) {
        expect(r.nettoEurCent).to.equal(0n);
      }
    });

    it("Doppelter Wareneingang wird abgelehnt", async () => {
      await delivery.connect(caterer).confirmDelivery(
        deliveryId, poolId, 490_000, 0, keccak("ls-x")
      );

      await expect(
        delivery.connect(caterer).confirmDelivery(
          deliveryId, poolId, 490_000, 0, keccak("ls-y")
        )
      ).to.be.revertedWith("Lieferung bereits bestaetigt");
    });

    it("Admin kann Auszahlungen freigeben", async () => {
      await delivery.connect(caterer).confirmDelivery(
        deliveryId, poolId, 490_000, 0, keccak("ls-rel")
      );
      await delivery.connect(admin).releasePayouts(deliveryId);

      const d = await delivery.getDelivery(deliveryId);
      expect(d.payoutsReleased).to.be.true;
    });

    it("Gesamtauszahlung wird korrekt summiert", async () => {
      await delivery.connect(caterer).confirmDelivery(
        deliveryId, poolId, 490_000, 0, keccak("ls-sum")
      );

      const [brutto, netto] = await delivery.getTotalPayout(deliveryId);
      expect(brutto).to.be.gt(0n);
      expect(netto).to.be.lt(brutto); // Fee abgezogen
    });
  });
});
