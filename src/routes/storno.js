/**
 * Storno-Workflow für FrischKette
 * Behandelt Pool-Stornierungen + Auszahlungsrückbuchungen
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

// POST /api/storno/pool/:id – Pool stornieren mit vollständigem Workflow
router.post('/pool/:id', auth, role('admin'), async (req, res) => {
  const { grund, auszahlungen_stornieren = true } = req.body;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const { rows:[pool] } = await client.query(`SELECT * FROM pools WHERE id=$1`, [req.params.id]);
    if (!pool) throw new Error('Pool nicht gefunden');
    if (pool.status === 'storniert') throw new Error('Pool bereits storniert');

    // 1. Pool stornieren
    await client.query(`UPDATE pools SET status='storniert' WHERE id=$1`, [pool.id]);

    // 2. Alle aktiven Commitments zurückziehen
    const { rows: commits } = await client.query(`
      UPDATE commitments SET status='zurueckgezogen'
      WHERE pool_id=$1 AND status='aktiv'
      RETURNING erzeuger_id
    `, [pool.id]);

    // 3. Lieferscheine stornieren
    const { rows: liefer } = await client.query(`
      UPDATE lieferungen SET status='storniert'
      WHERE pool_id=$1 AND status NOT IN ('abgeschlossen')
      RETURNING id, lieferschein_nr
    `, [pool.id]);

    // 4. Auszahlungen stornieren (optional)
    let stornoAusz = [];
    if (auszahlungen_stornieren) {
      const { rows } = await client.query(`
        UPDATE auszahlungen SET status='storniert'
        WHERE lieferung_id IN (
          SELECT id FROM lieferungen WHERE pool_id=$1
        ) AND status IN ('ausstehend','berechnet')
        RETURNING id, erzeuger_id, netto
      `, [pool.id]);
      stornoAusz = rows;
    }

    await client.query('COMMIT');

    // 5. E-Mails an betroffene Erzeuger
    const email = require('../services/email');
    const erzIds = [...new Set(commits.map(c => c.erzeuger_id))];
    for (const erzId of erzIds) {
      const { rows:[erz] } = await db.query(`
        SELECT e.betrieb_name, u.email FROM erzeuger e JOIN users u ON u.id=e.user_id WHERE e.id=$1
      `, [erzId]);
      if (erz) {
        email.send({
          to: { email: erz.email, name: erz.betrieb_name },
          subject: `FrischKette: Pool storniert — ${pool.produkt} ${pool.lieferwoche}`,
          html: `<h2>Pool storniert</h2>
            <p>Der Pool für <strong>${pool.produkt} · ${pool.lieferwoche}</strong> wurde leider storniert.</p>
            ${grund ? `<p><strong>Grund:</strong> ${grund}</p>` : ''}
            <p>Ihre Zusage wurde automatisch zurückgezogen. Es entstehen keine Kosten für Sie.</p>`,
        }).catch(()=>{});
      }
    }

    res.json({
      message: 'Pool erfolgreich storniert',
      commits_zurueck: commits.length,
      lieferscheine_storniert: liefer.length,
      auszahlungen_storniert: stornoAusz.length,
    });
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/storno/preview/:poolId – Vorschau was beim Stornieren passiert
router.get('/preview/:poolId', auth, role('admin'), async (req, res) => {
  try {
    const { rows:[pool] } = await db.query(`SELECT * FROM pools WHERE id=$1`, [req.params.poolId]);
    if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });

    const [commits, liefer, ausz] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS anzahl, COALESCE(SUM(menge),0)::numeric AS menge_gesamt FROM commitments WHERE pool_id=$1 AND status='aktiv'`, [pool.id]),
      db.query(`SELECT COUNT(*)::int AS anzahl FROM lieferungen WHERE pool_id=$1 AND status NOT IN ('abgeschlossen','storniert')`, [pool.id]),
      db.query(`SELECT COUNT(*)::int AS anzahl, COALESCE(SUM(netto),0)::numeric(10,2) AS summe FROM auszahlungen WHERE lieferung_id IN (SELECT id FROM lieferungen WHERE pool_id=$1) AND status IN ('ausstehend','berechnet')`, [pool.id]),
    ]);

    res.json({
      pool: { produkt: pool.produkt, lieferwoche: pool.lieferwoche, status: pool.status },
      commitments:  commits.rows[0],
      lieferscheine: liefer.rows[0],
      auszahlungen:  ausz.rows[0],
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
