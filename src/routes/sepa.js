/**
 * sepa.js – SEPA-Überweisung (pain.001 XML) Generator
 *
 * Generiert eine SEPA-Überweisungsdatei die direkt in Online-Banking
 * importiert werden kann (alle deutschen Banken unterstützen pain.001).
 *
 * Endpunkte:
 *   GET /api/sepa/export?ids=id1,id2  → pain.001 XML Download
 *   POST /api/sepa/mark-exported       → Auszahlungen als veranlasst markieren
 */

const express = require('express');
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

const router = express.Router();

// Konfiguration aus .env
const EIGENE_IBAN = process.env.SEPA_IBAN   || 'DE00000000000000000000';
const EIGENE_BIC  = process.env.SEPA_BIC    || 'XXXXXXXX';
const KONTOINHABER= process.env.SEPA_NAME   || 'LieferPool';

function xmlEscape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generatePain001(payments, msgId) {
  const now       = new Date();
  const dateStr   = now.toISOString().slice(0, 19);
  const ctrlSum   = payments.reduce((s, p) => s + parseFloat(p.netto), 0).toFixed(2);
  const txCount   = payments.length;

  const transactions = payments.map((p, i) => `
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>LP-${msgId}-${String(i+1).padStart(3,'0')}</EndToEndId>
        </PmtId>
        <Amt>
          <InstdAmt Ccy="EUR">${parseFloat(p.netto).toFixed(2)}</InstdAmt>
        </Amt>
        <CdtrAgt>
          <FinInstnId>
            <BIC>${xmlEscape(p.bic || 'NOTPROVIDED')}</BIC>
          </FinInstnId>
        </CdtrAgt>
        <Cdtr>
          <Nm>${xmlEscape(p.betrieb_name)}</Nm>
        </Cdtr>
        <CdtrAcct>
          <Id>
            <IBAN>${xmlEscape(p.iban.replace(/\s/g,''))}</IBAN>
          </Id>
        </CdtrAcct>
        <RmtInf>
          <Ustrd>LieferPool Auszahlung ${xmlEscape(p.produkt || '')} ${xmlEscape(p.lieferwoche || '')}</Ustrd>
        </RmtInf>
      </CdtTrfTxInf>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.003.03"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${msgId}</MsgId>
      <CreDtTm>${dateStr}</CreDtTm>
      <NbOfTxs>${txCount}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <InitgPty>
        <Nm>${xmlEscape(KONTOINHABER)}</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${msgId}-PMT</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${txCount}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <PmtTpInf>
        <SvcLvl>
          <Cd>SEPA</Cd>
        </SvcLvl>
      </PmtTpInf>
      <ReqdExctnDt>${now.toISOString().slice(0,10)}</ReqdExctnDt>
      <Dbtr>
        <Nm>${xmlEscape(KONTOINHABER)}</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>${EIGENE_IBAN.replace(/\s/g,'')}</IBAN>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <BIC>${EIGENE_BIC}</BIC>
        </FinInstnId>
      </DbtrAgt>
      ${transactions}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;
}

// GET /api/sepa/export – SEPA-XML generieren und herunterladen
router.get('/export', auth, role('admin'), async (req, res) => {
  try {
    const { ids, status = 'ausstehend' } = req.query;

    let query = `
      SELECT
        a.id, a.netto, a.commitment_id,
        e.betrieb_name, e.iban, e.bank_name,
        p.produkt, p.lieferwoche
      FROM auszahlungen a
      JOIN erzeuger e    ON e.id = a.erzeuger_id
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p       ON p.id = c.pool_id
      WHERE a.stripe_fee_collected = FALSE OR a.stripe_fee_collected IS NULL
    `;
    const params = [];

    if (ids) {
      const idList = ids.split(',').filter(Boolean);
      params.push(idList);
      query += ` AND a.id = ANY($${params.length})`;
    } else {
      params.push(status);
      query += ` AND a.status = $${params.length}`;
    }

    query += ' AND e.iban IS NOT NULL AND e.iban != \'\'';

    const { rows: payments } = await db.query(query, params);

    if (!payments.length) {
      return res.status(400).json({ error: 'Keine Auszahlungen mit IBAN gefunden' });
    }

    // Welche haben keine IBAN?
    const withoutIBAN = await db.query(`
      SELECT e.betrieb_name FROM auszahlungen a
      JOIN erzeuger e ON e.id = a.erzeuger_id
      WHERE a.status = 'ausstehend' AND (e.iban IS NULL OR e.iban = '')
    `);
    if (withoutIBAN.rows.length > 0) {
      console.warn('[sepa] Ohne IBAN (nicht exportiert):',
        withoutIBAN.rows.map(r => r.betrieb_name).join(', '));
    }

    const msgId = 'LP-' + Date.now().toString(36).toUpperCase();
    const xml   = generatePain001(payments, msgId);
    const total = payments.reduce((s, p) => s + parseFloat(p.netto), 0);

    // Als veranlasst markieren
    const paymentIds = payments.map(p => p.id);
    await db.query(
      `UPDATE auszahlungen SET status='veranlasst' WHERE id = ANY($1)`,
      [paymentIds]
    );

    const filename = `sepa-${new Date().toISOString().slice(0,10)}-${payments.length}x.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    console.log(`[sepa] ${payments.length} Zahlungen · ${total.toFixed(2)} € · ${filename}`);
    res.send(xml);

  } catch (err) {
    console.error('[sepa]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sepa/preview – Vorschau ohne Download
router.get('/preview', auth, role('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        a.id, a.netto, a.status,
        e.betrieb_name,
        CASE WHEN e.iban IS NOT NULL AND e.iban != '' THEN true ELSE false END AS hat_iban,
        p.produkt, p.lieferwoche
      FROM auszahlungen a
      JOIN erzeuger e    ON e.id = a.erzeuger_id
      JOIN commitments c ON c.id = a.commitment_id
      JOIN pools p       ON p.id = c.pool_id
      WHERE a.status = 'ausstehend'
      ORDER BY a.netto DESC
    `);

    const mitIBAN  = rows.filter(r => r.hat_iban);
    const ohneIBAN = rows.filter(r => !r.hat_iban);
    const total    = mitIBAN.reduce((s, r) => s + parseFloat(r.netto), 0);

    res.json({
      gesamt_zahlungen: rows.length,
      exportierbar:     mitIBAN.length,
      ohne_iban:        ohneIBAN.length,
      total_euros:      total.toFixed(2),
      zahlungen:        mitIBAN,
      ohne_iban_liste:  ohneIBAN.map(r => r.betrieb_name),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
