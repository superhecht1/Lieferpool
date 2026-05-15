// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * LieferPool.sol
 * Unveränderliches Audit-Log für regionale Lieferkooperativen.
 * Kein Geldfluss on-chain — nur kryptografisch gesicherte Nachweise.
 *
 * Deployed auf Polygon (MATIC) für günstige Gas-Gebühren.
 */
contract LieferPool {

    address public owner;

    // ── Events (on-chain Log) ──────────────────────────────────
    event PoolCreated(
        bytes32 indexed poolId,
        string  produkt,
        uint256 mengeZiel,
        uint256 preis,       // in Cent (EUR)
        uint256 deadline
    );

    event QuantityCommitted(
        bytes32 indexed commitmentId,
        bytes32 indexed poolId,
        bytes32 indexed erzeugerId,
        uint256 menge        // in Gramm
    );

    event PoolLocked(
        bytes32 indexed poolId,
        uint256 mengeCommitted,
        uint256 timestamp
    );

    event PaymentsReleased(
        bytes32 indexed poolId,
        bytes32 indexed lieferungId,
        uint256 totalNetto,  // in Cent
        uint256 count
    );

    event PayoutRecorded(
        bytes32 indexed erzeugerId,
        bytes32 indexed poolId,
        uint256 netto,       // in Cent
        uint256 timestamp
    );

    event CertificateRegistered(
        bytes32 indexed erzeugerId,
        bytes32 certHash,
        uint256 timestamp
    );

    event CertificateVerified(
        bytes32 indexed erzeugerId,
        bytes32 certHash,
        address verifiedBy,
        uint256 timestamp
    );

    // ── State ──────────────────────────────────────────────────
    struct Pool {
        bool    exists;
        bool    locked;
        string  produkt;
        uint256 mengeZiel;
        uint256 mengeCommitted;
        uint256 preis;
        uint256 deadline;
        uint256 createdAt;
    }

    struct Certificate {
        bytes32 certHash;
        bool    verified;
        uint256 timestamp;
    }

    mapping(bytes32 => Pool)          public pools;
    mapping(bytes32 => bool)          public commitments;
    mapping(bytes32 => Certificate[]) public certificates;

    modifier onlyOwner() {
        require(msg.sender == owner, "Nur Owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ── Pool erstellen ─────────────────────────────────────────
    function createPool(
        bytes32 poolId,
        string  calldata produkt,
        uint256 mengeZiel,
        uint256 preis,
        uint256 deadline
    ) external onlyOwner {
        require(!pools[poolId].exists, "Pool existiert bereits");
        pools[poolId] = Pool({
            exists:         true,
            locked:         false,
            produkt:        produkt,
            mengeZiel:      mengeZiel,
            mengeCommitted: 0,
            preis:          preis,
            deadline:       deadline,
            createdAt:      block.timestamp
        });
        emit PoolCreated(poolId, produkt, mengeZiel, preis, deadline);
    }

    // ── Menge zusagen ──────────────────────────────────────────
    function commitQuantity(
        bytes32 commitmentId,
        bytes32 poolId,
        bytes32 erzeugerId,
        uint256 menge
    ) external onlyOwner {
        require(pools[poolId].exists, "Pool nicht gefunden");
        require(!pools[poolId].locked, "Pool bereits gesperrt");
        require(!commitments[commitmentId], "Commitment bereits registriert");
        require(block.timestamp <= pools[poolId].deadline, "Deadline abgelaufen");

        commitments[commitmentId] = true;
        pools[poolId].mengeCommitted += menge;

        emit QuantityCommitted(commitmentId, poolId, erzeugerId, menge);
    }

    // ── Pool sperren (voll) ────────────────────────────────────
    function lockPool(bytes32 poolId) external onlyOwner {
        require(pools[poolId].exists, "Pool nicht gefunden");
        require(!pools[poolId].locked, "Bereits gesperrt");
        pools[poolId].locked = true;
        emit PoolLocked(poolId, pools[poolId].mengeCommitted, block.timestamp);
    }

    // ── Auszahlungen freigeben ─────────────────────────────────
    function releasePayments(
        bytes32          poolId,
        bytes32          lieferungId,
        bytes32[] calldata erzeugerIds,
        uint256[] calldata nettoBetraege  // in Cent
    ) external onlyOwner {
        require(pools[poolId].locked, "Pool nicht gesperrt");
        require(erzeugerIds.length == nettoBetraege.length, "Array-Länge stimmt nicht");

        uint256 total = 0;
        for (uint i = 0; i < erzeugerIds.length; i++) {
            total += nettoBetraege[i];
            emit PayoutRecorded(erzeugerIds[i], poolId, nettoBetraege[i], block.timestamp);
        }
        emit PaymentsReleased(poolId, lieferungId, total, erzeugerIds.length);
    }

    // ── Zertifikat registrieren ────────────────────────────────
    function registerCertificate(
        bytes32 erzeugerId,
        bytes32 certHash
    ) external onlyOwner {
        certificates[erzeugerId].push(Certificate({
            certHash:  certHash,
            verified:  false,
            timestamp: block.timestamp
        }));
        emit CertificateRegistered(erzeugerId, certHash, block.timestamp);
    }

    // ── Zertifikat verifizieren ────────────────────────────────
    function verifyCertificate(
        bytes32 erzeugerId,
        bytes32 certHash
    ) external onlyOwner {
        Certificate[] storage certs = certificates[erzeugerId];
        for (uint i = 0; i < certs.length; i++) {
            if (certs[i].certHash == certHash) {
                certs[i].verified = true;
                emit CertificateVerified(erzeugerId, certHash, msg.sender, block.timestamp);
                return;
            }
        }
        revert("Zertifikat nicht gefunden");
    }

    // ── View-Funktionen ────────────────────────────────────────
    function getPool(bytes32 poolId) external view returns (Pool memory) {
        return pools[poolId];
    }

    function getCertificates(bytes32 erzeugerId) external view returns (Certificate[] memory) {
        return certificates[erzeugerId];
    }

    function isCommitmentRegistered(bytes32 commitmentId) external view returns (bool) {
        return commitments[commitmentId];
    }

    // ── Owner übertragen ───────────────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Ungültige Adresse");
        owner = newOwner;
    }
}
