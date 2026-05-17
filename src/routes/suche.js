/**
 * Globale Suche für FrischKette Admin
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth, role } = require('../middleware/auth');

router.get('/', auth, role('admin'), async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ results: [] });

  const like = `%${q.toLowerCase()}%`;

  try {
    const [erzeuger, caterer, pools, lieferungen, touren] = await Promise.all([

      db.query(`SELECT 'erzeuger' AS typ, e.id, e.betrieb_name AS titel,
                  u.email AS sub, '/erzeuger?id='+e.id AS url
                FROM erzeuger e JOIN users u ON u.id=e.user_id
                WHERE LOWER(e.betrieb_name) LIKE $1 OR LOWER(u.email) LIKE $1
                LIMIT 5`, [like]),

      db.query(`SELECT 'caterer' AS typ, c.id, c.firma_name AS titel,
                  u.email AS sub, NULL AS url
                FROM caterer c JOIN users u ON u.id=c.user_id
                WHERE LOWER(c.firma_name) LIKE $1 OR LOWER(u.email) LIKE $1
                LIMIT 5`, [like]),

      db.query(`SELECT 'pool' AS typ, p.id,
                  (p.produkt || ' – ' || p.lieferwoche) AS titel,
                  p.status AS sub, NULL AS url
                FROM pools p
                WHERE LOWER(p.produkt) LIKE $1 OR LOWER(p.lieferwoche) LIKE $1
                LIMIT 5`, [like]),

      db.query(`SELECT 'lieferschein' AS typ, l.id,
                  l.lieferschein_nr AS titel,
                  (p.produkt || ' · ' || l.status) AS sub, NULL AS url
                FROM lieferungen l JOIN pools p ON p.id=l.pool_id
                WHERE LOWER(l.lieferschein_nr) LIKE $1 OR LOWER(l.qr_code) LIKE $1
                LIMIT 5`, [like]),

      db.query(`SELECT 'tour' AS typ, t.id, t.name AS titel,
                  (t.datum::text || ' · ' || t.status) AS sub, NULL AS url
                FROM touren t
                WHERE LOWER(t.name) LIKE $1
                LIMIT 5`, [like]),
    ]);

    const results = [
      ...erzeuger.rows,
      ...caterer.rows,
      ...pools.rows,
      ...lieferungen.rows,
      ...touren.rows,
    ];

    res.json({ results, count: results.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
