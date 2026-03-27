// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ProducerRegistry
 * @notice Verwaltet Erzeuger-Identitäten und ihre Zertifikat-Hashes on-chain.
 *
 * Jeder Erzeuger bekommt eine DID (dezentrale ID aus dem Backend).
 * Zertifikate (Bio, QS, Demeter) werden als SHA-256-Hashes gespeichert –
 * die eigentlichen Dokumente bleiben off-chain (DSGVO-konform).
 *
 * Rollen:
 *   ADMIN_ROLE   – kann Erzeuger verifizieren / sperren
 *   DEFAULT_ADMIN_ROLE – Vertragsinhaber (Deployer)
 */
contract ProducerRegistry is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ---------------------------------------------------------------
    // STRUCTS
    // ---------------------------------------------------------------
    struct Producer {
        bytes32 did;          // keccak256(uuid) aus dem Backend
        bool    verified;     // Admin hat Zertifikate geprüft
        bool    active;       // false = gesperrt
        uint256 registeredAt;
        uint256 verifiedAt;
    }

    struct Certificate {
        bytes32 docHash;      // SHA-256 des Originaldokuments
        string  certType;     // "Bio" | "QS" | "Demeter" | "Hygiene"
        uint256 validUntil;   // Unix timestamp
        bool    revoked;
        uint256 issuedAt;
    }

    // ---------------------------------------------------------------
    // STATE
    // ---------------------------------------------------------------
    mapping(address => Producer)                public producers;
    mapping(address => Certificate[])           public certificates;
    mapping(bytes32 => address)                 public didToAddress;

    uint256 public totalProducers;
    uint256 public totalVerified;

    // ---------------------------------------------------------------
    // EVENTS
    // ---------------------------------------------------------------
    event ProducerRegistered(address indexed producer, bytes32 did, uint256 at);
    event ProducerVerified(address indexed producer, address indexed by, uint256 at);
    event ProducerSuspended(address indexed producer, address indexed by);
    event CertificateAdded(address indexed producer, bytes32 docHash, string certType, uint256 validUntil);
    event CertificateRevoked(address indexed producer, uint256 certIndex, address by);

    // ---------------------------------------------------------------
    // CONSTRUCTOR
    // ---------------------------------------------------------------
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------
    // ERZEUGER-VERWALTUNG
    // ---------------------------------------------------------------

    /**
     * @notice Erzeuger registriert sich selbst.
     * @param did  keccak256(backendUUID) – eindeutiger Identifier
     */
    function registerProducer(bytes32 did) external {
        require(producers[msg.sender].registeredAt == 0, "Bereits registriert");
        require(didToAddress[did] == address(0), "DID bereits vergeben");

        producers[msg.sender] = Producer({
            did:          did,
            verified:     false,
            active:       true,
            registeredAt: block.timestamp,
            verifiedAt:   0
        });

        didToAddress[did] = msg.sender;
        totalProducers++;

        emit ProducerRegistered(msg.sender, did, block.timestamp);
    }

    /**
     * @notice Admin verifiziert einen Erzeuger (nach Dokumentenprüfung off-chain).
     */
    function verifyProducer(address producer) external onlyRole(ADMIN_ROLE) {
        require(producers[producer].registeredAt > 0, "Erzeuger nicht gefunden");
        require(!producers[producer].verified, "Bereits verifiziert");

        producers[producer].verified   = true;
        producers[producer].verifiedAt = block.timestamp;
        totalVerified++;

        emit ProducerVerified(producer, msg.sender, block.timestamp);
    }

    /**
     * @notice Admin sperrt einen Erzeuger (z. B. bei Zertifikatsverlust).
     */
    function suspendProducer(address producer) external onlyRole(ADMIN_ROLE) {
        require(producers[producer].active, "Bereits gesperrt");
        producers[producer].active = false;
        emit ProducerSuspended(producer, msg.sender);
    }

    // ---------------------------------------------------------------
    // ZERTIFIKATE
    // ---------------------------------------------------------------

    /**
     * @notice Erzeuger reicht Zertifikat-Hash ein (Dokument bleibt off-chain).
     * @param docHash    SHA-256 des Originaldokuments (bytes32)
     * @param certType   "Bio" | "QS" | "Demeter" | "Hygiene"
     * @param validUntil Unix timestamp Ablaufdatum
     */
    function addCertificate(
        bytes32 docHash,
        string  calldata certType,
        uint256 validUntil
    ) external {
        require(producers[msg.sender].registeredAt > 0, "Nicht registriert");
        require(validUntil > block.timestamp, "Ablaufdatum in der Vergangenheit");

        certificates[msg.sender].push(Certificate({
            docHash:    docHash,
            certType:   certType,
            validUntil: validUntil,
            revoked:    false,
            issuedAt:   block.timestamp
        }));

        emit CertificateAdded(msg.sender, docHash, certType, validUntil);
    }

    /**
     * @notice Admin widerruft ein einzelnes Zertifikat.
     */
    function revokeCertificate(address producer, uint256 index)
        external
        onlyRole(ADMIN_ROLE)
    {
        require(index < certificates[producer].length, "Index ungueltig");
        certificates[producer][index].revoked = true;
        emit CertificateRevoked(producer, index, msg.sender);
    }

    // ---------------------------------------------------------------
    // VIEWS
    // ---------------------------------------------------------------

    /**
     * @notice Prüft, ob ein Erzeuger am Pool teilnehmen darf.
     */
    function isEligible(address producer) external view returns (bool) {
        Producer memory p = producers[producer];
        if (!p.verified || !p.active) return false;

        // mindestens 1 gültiges, nicht widerrufenes Zertifikat
        Certificate[] memory certs = certificates[producer];
        for (uint256 i = 0; i < certs.length; i++) {
            if (!certs[i].revoked && certs[i].validUntil > block.timestamp) {
                return true;
            }
        }
        return false;
    }

    function getCertificates(address producer)
        external
        view
        returns (Certificate[] memory)
    {
        return certificates[producer];
    }

    function getProducer(address producer)
        external
        view
        returns (Producer memory)
    {
        return producers[producer];
    }
}
