// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./SupplyPool.sol";

/**
 * @title DeliveryContract
 * @notice Verarbeitet Wareneingänge und berechnet anteilige Auszahlungen.
 *
 * Wichtig: Dieser Contract hält KEIN Geld (kein Escrow in ETH/Token).
 * Er dient als unveränderlicher Abrechnungsnachweis.
 * Die Geldflüsse laufen parallel via SEPA Instant im Backend –
 * der Contract liefert die rechtssichere Berechnungsgrundlage.
 *
 * Qualitätsstufen:
 *   A → kein Abzug
 *   B → 5% Abzug
 *   C → 15% Abzug
 *   R → abgelehnt, 0 Auszahlung
 */
contract DeliveryContract is AccessControl, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE     = keccak256("ADMIN_ROLE");
    bytes32 public constant CATERER_ROLE   = keccak256("CATERER_ROLE");

    SupplyPool public immutable supplyPool;

    // ---------------------------------------------------------------
    // ENUMS & STRUCTS
    // ---------------------------------------------------------------
    enum QualityGrade { A, B, C, Rejected }

    struct Delivery {
        bytes32      deliveryId;       // keccak256(backendUUID)
        bytes32      poolId;
        uint256      mengeBestelltG;   // in Gramm
        uint256      mengeGeliefertG;  // in Gramm
        QualityGrade qualitaet;
        bytes32      lieferscheinHash; // SHA-256 des Lieferscheins
        uint256      confirmedAt;
        address      confirmedBy;      // Caterer-Adresse
        bool         payoutsReleased;
    }

    struct PayoutRecord {
        address  producer;
        uint256  mengeG;          // tatsächlich gelieferter Anteil in Gramm
        uint256  bruttoEurCent;
        uint256  abzugEurCent;
        uint256  feeEurCent;
        uint256  nettoEurCent;
        uint256  recordedAt;
    }

    // ---------------------------------------------------------------
    // STATE
    // ---------------------------------------------------------------
    mapping(bytes32 => Delivery)       public deliveries;
    mapping(bytes32 => PayoutRecord[]) public payouts;   // deliveryId → Auszahlungen
    mapping(bytes32 => bool)           public poolDelivered;

    // Qualitätsabzüge in Basispunkten (100 = 1%)
    uint16 public abzugB = 500;   // 5%
    uint16 public abzugC = 1500;  // 15%

    // ---------------------------------------------------------------
    // EVENTS
    // ---------------------------------------------------------------
    event DeliveryConfirmed(
        bytes32 indexed deliveryId,
        bytes32 indexed poolId,
        uint256 mengeGeliefertG,
        QualityGrade qualitaet,
        bytes32 lieferscheinHash,
        address confirmedBy
    );
    event PayoutsCalculated(
        bytes32 indexed deliveryId,
        uint256 producerCount,
        uint256 gesamtNettoEurCent
    );
    event PayoutsReleased(bytes32 indexed deliveryId, uint256 timestamp);
    event QualityAbzugUpdated(uint16 abzugB, uint16 abzugC);

    // ---------------------------------------------------------------
    // CONSTRUCTOR
    // ---------------------------------------------------------------
    constructor(address admin, address supplyPoolAddress) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        supplyPool = SupplyPool(supplyPoolAddress);
    }

    // ---------------------------------------------------------------
    // WARENEINGANG
    // ---------------------------------------------------------------

    /**
     * @notice Caterer bestätigt Wareneingang – triggert Auszahlungsberechnung.
     *
     * @param deliveryId        keccak256(backendUUID)
     * @param poolId            Zugehöriger Pool
     * @param mengeGeliefertG   Tatsächlich gelieferte Menge in Gramm
     * @param qualitaet         0=A, 1=B, 2=C, 3=Rejected
     * @param lieferscheinHash  SHA-256 des Lieferscheins
     */
    function confirmDelivery(
        bytes32      deliveryId,
        bytes32      poolId,
        uint256      mengeGeliefertG,
        QualityGrade qualitaet,
        bytes32      lieferscheinHash
    ) external onlyRole(CATERER_ROLE) nonReentrant {
        require(deliveries[deliveryId].confirmedAt == 0, "Lieferung bereits bestaetigt");
        require(!poolDelivered[poolId],                  "Pool bereits abgerechnet");

        SupplyPool.Pool memory pool = supplyPool.getPool(poolId);
        require(pool.createdAt > 0, "Pool nicht gefunden");
        // Pool muss locked sein (Mindestmenge erreicht)
        // SupplyPool.PoolStatus.Locked == 1
        require(uint8(pool.status) == 1, "Pool nicht gesperrt");

        // Toleranzprüfung
        uint256 toleranzMin = pool.mengeZiel * (100 - pool.toleranzPct) / 100;
        if (qualitaet != QualityGrade.Rejected) {
            require(
                mengeGeliefertG >= toleranzMin,
                "Liefermenge unterschreitet Toleranz"
            );
        }

        deliveries[deliveryId] = Delivery({
            deliveryId:       deliveryId,
            poolId:           poolId,
            mengeBestelltG:   pool.mengeCommitted,
            mengeGeliefertG:  mengeGeliefertG,
            qualitaet:        qualitaet,
            lieferscheinHash: lieferscheinHash,
            confirmedAt:      block.timestamp,
            confirmedBy:      msg.sender,
            payoutsReleased:  false
        });

        poolDelivered[poolId] = true;

        emit DeliveryConfirmed(
            deliveryId, poolId, mengeGeliefertG,
            qualitaet, lieferscheinHash, msg.sender
        );

        // Sofort Auszahlungen berechnen
        _calculatePayouts(deliveryId, pool);
    }

    // ---------------------------------------------------------------
    // AUSZAHLUNGSBERECHNUNG (intern)
    // ---------------------------------------------------------------

    function _calculatePayouts(bytes32 deliveryId, SupplyPool.Pool memory pool)
        internal
    {
        Delivery storage d = deliveries[deliveryId];
        SupplyPool.Commitment[] memory cms = supplyPool.getCommitments(pool.poolId);

        uint256 totalCommitted = pool.mengeCommitted;
        uint256 gesamtNetto = 0;
        uint256 abzugBps = _qualitaetsAbzug(d.qualitaet);

        for (uint256 i = 0; i < cms.length; i++) {
            SupplyPool.Commitment memory c = cms[i];
            if (c.withdrawn) continue;

            // Anteiliger Anteil an gelieferter Menge
            uint256 anteilG = (d.mengeGeliefertG * c.menge) / totalCommitted;

            // Brutto in EUR-Cent: (Gramm / 1000) × Preis/kg
            uint256 brutto = (anteilG * pool.preisProKg) / 1000;

            // Qualitätsabzug
            uint256 abzug = (brutto * abzugBps) / 10000;

            // Plattformfee auf Brutto nach Abzug
            uint256 basis = brutto - abzug;
            uint256 fee   = (basis * pool.platformFeePct) / 100;

            uint256 netto = basis - fee;
            gesamtNetto  += netto;

            if (d.qualitaet == QualityGrade.Rejected) {
                // Rejected → alle Felder 0, trotzdem Datensatz für Audit
                payouts[deliveryId].push(PayoutRecord({
                    producer:       c.producer,
                    mengeG:         anteilG,
                    bruttoEurCent:  0,
                    abzugEurCent:   0,
                    feeEurCent:     0,
                    nettoEurCent:   0,
                    recordedAt:     block.timestamp
                }));
            } else {
                payouts[deliveryId].push(PayoutRecord({
                    producer:       c.producer,
                    mengeG:         anteilG,
                    bruttoEurCent:  brutto,
                    abzugEurCent:   abzug,
                    feeEurCent:     fee,
                    nettoEurCent:   netto,
                    recordedAt:     block.timestamp
                }));
            }
        }

        emit PayoutsCalculated(deliveryId, cms.length, gesamtNetto);
    }

    /**
     * @notice Admin markiert Auszahlungen als veranlasst (nach SEPA-Transfer).
     */
    function releasePayouts(bytes32 deliveryId)
        external
        onlyRole(ADMIN_ROLE)
        nonReentrant
    {
        Delivery storage d = deliveries[deliveryId];
        require(d.confirmedAt > 0,    "Lieferung nicht bestaetigt");
        require(!d.payoutsReleased,   "Bereits freigegeben");

        d.payoutsReleased = true;

        // Pool als geliefert markieren
        supplyPool.markDelivered(d.poolId);

        emit PayoutsReleased(deliveryId, block.timestamp);
    }

    // ---------------------------------------------------------------
    // ADMIN
    // ---------------------------------------------------------------

    function addCaterer(address caterer) external onlyRole(ADMIN_ROLE) {
        _grantRole(CATERER_ROLE, caterer);
    }

    function removeCaterer(address caterer) external onlyRole(ADMIN_ROLE) {
        _revokeRole(CATERER_ROLE, caterer);
    }

    /**
     * @notice Admin passt Qualitätsabzüge an (in Basispunkten).
     */
    function setQualityAbzuege(uint16 _abzugB, uint16 _abzugC)
        external
        onlyRole(ADMIN_ROLE)
    {
        require(_abzugB <= 2000 && _abzugC <= 5000, "Abzug zu hoch");
        abzugB = _abzugB;
        abzugC = _abzugC;
        emit QualityAbzugUpdated(_abzugB, _abzugC);
    }

    // ---------------------------------------------------------------
    // VIEWS
    // ---------------------------------------------------------------

    function getDelivery(bytes32 deliveryId)
        external
        view
        returns (Delivery memory)
    {
        return deliveries[deliveryId];
    }

    function getPayouts(bytes32 deliveryId)
        external
        view
        returns (PayoutRecord[] memory)
    {
        return payouts[deliveryId];
    }

    function getPayoutForProducer(bytes32 deliveryId, address producer)
        external
        view
        returns (PayoutRecord memory record, bool found)
    {
        PayoutRecord[] storage recs = payouts[deliveryId];
        for (uint256 i = 0; i < recs.length; i++) {
            if (recs[i].producer == producer) {
                return (recs[i], true);
            }
        }
        return (record, false);
    }

    function getTotalPayout(bytes32 deliveryId)
        external
        view
        returns (uint256 gesamtBrutto, uint256 gesamtNetto)
    {
        PayoutRecord[] storage recs = payouts[deliveryId];
        for (uint256 i = 0; i < recs.length; i++) {
            gesamtBrutto += recs[i].bruttoEurCent;
            gesamtNetto  += recs[i].nettoEurCent;
        }
    }

    // ---------------------------------------------------------------
    // INTERNAL
    // ---------------------------------------------------------------

    function _qualitaetsAbzug(QualityGrade g) internal view returns (uint256) {
        if (g == QualityGrade.A)        return 0;
        if (g == QualityGrade.B)        return abzugB;
        if (g == QualityGrade.C)        return abzugC;
        if (g == QualityGrade.Rejected) return 10000; // 100%
        return 0;
    }
}
