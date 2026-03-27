// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ProducerRegistry.sol";

/**
 * @title SupplyPool
 * @notice Bündelt Mengen-Commitments mehrerer Erzeuger zu einem Großangebot.
 *
 * Ablauf:
 *   1. Caterer (Admin) erstellt Pool via createPool()
 *   2. Erzeuger sagen Mengen zu via commitQuantity()
 *   3. Wenn menge_committed >= menge_ziel → Pool wird automatisch geschlossen
 *   4. DeliveryContract.confirmDelivery() triggert Auszahlungen
 *
 * Preise & Auszahlungen in EUR-Cent (uint), kein Float.
 */
contract SupplyPool is AccessControl, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE    = keccak256("ADMIN_ROLE");
    bytes32 public constant CATERER_ROLE  = keccak256("CATERER_ROLE");

    ProducerRegistry public immutable registry;

    // ---------------------------------------------------------------
    // ENUMS & STRUCTS
    // ---------------------------------------------------------------
    enum PoolStatus { Open, Locked, Delivered, Cancelled }

    struct Pool {
        bytes32     poolId;           // keccak256(backendUUID)
        address     caterer;
        string      produkt;
        uint256     mengeZiel;        // in Gramm (kg × 1000, kein Float)
        uint256     mengeCommitted;
        uint256     preisProKg;       // EUR-Cent pro kg (z. B. 180 = 1,80 €)
        uint256     deadline;         // Unix timestamp
        uint8       toleranzPct;      // ±Toleranz in Prozent (z. B. 5)
        uint8       platformFeePct;   // Plattformfee in Prozent (z. B. 1)
        PoolStatus  status;
        uint256     createdAt;
    }

    struct Commitment {
        address  producer;
        uint256  menge;       // in Gramm
        uint256  committedAt;
        bool     withdrawn;
    }

    // ---------------------------------------------------------------
    // STATE
    // ---------------------------------------------------------------
    mapping(bytes32 => Pool)               public pools;
    mapping(bytes32 => Commitment[])       public commitments;
    mapping(bytes32 => mapping(address => uint256)) public producerIndex; // poolId → producer → index+1

    bytes32[] public allPoolIds;

    // ---------------------------------------------------------------
    // EVENTS
    // ---------------------------------------------------------------
    event PoolCreated(bytes32 indexed poolId, address caterer, string produkt, uint256 mengeZiel, uint256 deadline);
    event QuantityCommitted(bytes32 indexed poolId, address indexed producer, uint256 menge, uint256 totalCommitted);
    event PoolLocked(bytes32 indexed poolId, uint256 totalCommitted);
    event PoolCancelled(bytes32 indexed poolId, string reason);
    event CommitmentWithdrawn(bytes32 indexed poolId, address indexed producer, uint256 menge);

    // ---------------------------------------------------------------
    // CONSTRUCTOR
    // ---------------------------------------------------------------
    constructor(address admin, address registryAddress) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        registry = ProducerRegistry(registryAddress);
    }

    // ---------------------------------------------------------------
    // POOL-VERWALTUNG
    // ---------------------------------------------------------------

    /**
     * @notice Caterer / Admin erstellt einen neuen Lieferpool.
     * @param poolId       keccak256(backendUUID)
     * @param produkt      Produktbezeichnung
     * @param mengeZiel    Mindestmenge in Gramm
     * @param preisProKg   EUR-Cent pro kg
     * @param deadline     Unix timestamp bis wann Commitments möglich sind
     * @param toleranzPct  Toleranz in Prozent (0–20)
     * @param feePct       Plattformfee in Prozent (0–5)
     */
    function createPool(
        bytes32         poolId,
        string calldata produkt,
        uint256         mengeZiel,
        uint256         preisProKg,
        uint256         deadline,
        uint8           toleranzPct,
        uint8           feePct
    ) external onlyRole(ADMIN_ROLE) {
        require(pools[poolId].createdAt == 0, "Pool existiert bereits");
        require(mengeZiel > 0,              "Mindestmenge muss > 0 sein");
        require(deadline > block.timestamp, "Deadline muss in der Zukunft liegen");
        require(toleranzPct <= 20,          "Toleranz max 20%");
        require(feePct <= 5,                "Fee max 5%");

        pools[poolId] = Pool({
            poolId:         poolId,
            caterer:        msg.sender,
            produkt:        produkt,
            mengeZiel:      mengeZiel,
            mengeCommitted: 0,
            preisProKg:     preisProKg,
            deadline:       deadline,
            toleranzPct:    toleranzPct,
            platformFeePct: feePct,
            status:         PoolStatus.Open,
            createdAt:      block.timestamp
        });

        allPoolIds.push(poolId);
        emit PoolCreated(poolId, msg.sender, produkt, mengeZiel, deadline);
    }

    /**
     * @notice Erzeuger sagt Menge zu.
     * @param poolId  Ziel-Pool
     * @param menge   Menge in Gramm
     */
    function commitQuantity(bytes32 poolId, uint256 menge)
        external
        nonReentrant
    {
        Pool storage pool = pools[poolId];

        require(pool.createdAt > 0,                  "Pool nicht gefunden");
        require(pool.status == PoolStatus.Open,       "Pool nicht offen");
        require(block.timestamp <= pool.deadline,     "Deadline abgelaufen");
        require(menge > 0,                            "Menge muss > 0 sein");
        require(registry.isEligible(msg.sender),      "Erzeuger nicht verifiziert");
        require(producerIndex[poolId][msg.sender] == 0, "Bereits committed");

        commitments[poolId].push(Commitment({
            producer:    msg.sender,
            menge:       menge,
            committedAt: block.timestamp,
            withdrawn:   false
        }));

        producerIndex[poolId][msg.sender] = commitments[poolId].length; // index+1

        pool.mengeCommitted += menge;

        emit QuantityCommitted(poolId, msg.sender, menge, pool.mengeCommitted);

        // Auto-Lock wenn Ziel erreicht
        if (pool.mengeCommitted >= pool.mengeZiel) {
            pool.status = PoolStatus.Locked;
            emit PoolLocked(poolId, pool.mengeCommitted);
        }
    }

    /**
     * @notice Erzeuger zieht Commitment zurück (nur solange Pool offen).
     */
    function withdrawCommitment(bytes32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        require(pool.status == PoolStatus.Open, "Rueckzug nicht mehr moeglich");

        uint256 idx = producerIndex[poolId][msg.sender];
        require(idx > 0, "Kein Commitment gefunden");

        Commitment storage c = commitments[poolId][idx - 1];
        require(!c.withdrawn, "Bereits zurueckgezogen");

        uint256 menge = c.menge;
        c.withdrawn = true;
        pool.mengeCommitted -= menge;
        producerIndex[poolId][msg.sender] = 0;

        emit CommitmentWithdrawn(poolId, msg.sender, menge);
    }

    /**
     * @notice Admin sperrt Pool manuell (z. B. Notfall).
     */
    function lockPool(bytes32 poolId) external onlyRole(ADMIN_ROLE) {
        Pool storage pool = pools[poolId];
        require(pool.status == PoolStatus.Open, "Pool ist nicht offen");
        pool.status = PoolStatus.Locked;
        emit PoolLocked(poolId, pool.mengeCommitted);
    }

    /**
     * @notice Admin bricht Pool ab (z. B. Deadline verpasst, kein Quorum).
     */
    function cancelPool(bytes32 poolId, string calldata reason)
        external
        onlyRole(ADMIN_ROLE)
    {
        Pool storage pool = pools[poolId];
        require(
            pool.status == PoolStatus.Open || pool.status == PoolStatus.Locked,
            "Pool kann nicht abgebrochen werden"
        );
        pool.status = PoolStatus.Cancelled;
        emit PoolCancelled(poolId, reason);
    }

    /**
     * @notice Nur DeliveryContract darf den Pool als geliefert markieren.
     */
    function markDelivered(bytes32 poolId) external onlyRole(ADMIN_ROLE) {
        require(pools[poolId].status == PoolStatus.Locked, "Pool nicht gesperrt");
        pools[poolId].status = PoolStatus.Delivered;
    }

    // ---------------------------------------------------------------
    // VIEWS
    // ---------------------------------------------------------------

    function getPool(bytes32 poolId) external view returns (Pool memory) {
        return pools[poolId];
    }

    function getCommitments(bytes32 poolId)
        external
        view
        returns (Commitment[] memory)
    {
        return commitments[poolId];
    }

    function getCommitmentCount(bytes32 poolId) external view returns (uint256) {
        return commitments[poolId].length;
    }

    /**
     * @notice Berechnet erwarteten Erlös eines Erzeugers (in EUR-Cent).
     */
    function expectedPayout(bytes32 poolId, address producer)
        external
        view
        returns (uint256 brutto, uint256 fee, uint256 netto)
    {
        Pool storage pool = pools[poolId];
        uint256 idx = producerIndex[poolId][producer];
        require(idx > 0, "Kein Commitment");

        Commitment storage c = commitments[poolId][idx - 1];
        // Menge in kg (Gramm / 1000), Preis in EUR-Cent/kg
        brutto = (c.menge * pool.preisProKg) / 1000;
        fee    = (brutto * pool.platformFeePct) / 100;
        netto  = brutto - fee;
    }

    function getFuellstand(bytes32 poolId)
        external
        view
        returns (uint256 pct)
    {
        Pool storage pool = pools[poolId];
        if (pool.mengeZiel == 0) return 0;
        pct = (pool.mengeCommitted * 100) / pool.mengeZiel;
    }
}
