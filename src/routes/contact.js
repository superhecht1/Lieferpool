const express = require('express');
const router  = express.Router();
const db      = require('../db');

// POST /api/contact – Kontaktformular Landing Page
router.post('/', async (req, res) => {
  const { name, email, org, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, E-Mail und Nachricht erforderlich' });
  }

  try {
    // E-Mail an Admin
    const emailSvc = require('../services/email');
    await emailSvc.send({
      to: { email: process.env.ADMIN_EMAIL, name: 'FrischKette Admin' },
      subject: `FrischKette Demo-Anfrage von ${name}`,
      html: `
        <h2>Neue Demo-Anfrage</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>E-Mail:</strong> ${email}</p>
        <p><strong>Organisation:</strong> ${org||'—'}</p>
        <p><strong>Nachricht:</strong></p>
        <blockquote style="border-left:3px solid #c8912a;padding-left:1rem;color:#4a5244">${message.replace(/\n/g,'<br>')}</blockquote>
        <p style="margin-top:1rem"><a href="mailto:${email}">→ Direkt antworten</a></p>
      `,
    });

    // Bestätigungs-E-Mail an Anfragesteller
    await emailSvc.send({
      to: { email, name },
      subject: 'FrischKette – Deine Demo-Anfrage ist bei uns',
      html: `
        <h2>Danke, ${name}!</h2>
        <p>Wir haben deine Anfrage erhalten und melden uns innerhalb von 24 Stunden.</p>
        <p><strong>Deine Nachricht:</strong></p>
        <blockquote style="border-left:3px solid #c8912a;padding-left:1rem;color:#4a5244">${message.replace(/\n/g,'<br>')}</blockquote>
        <p>Bis gleich,<br>Das FrischKette Team</p>
      `,
    });

    res.json({ message: 'Anfrage gesendet' });
  } catch (err) {
    console.error('[contact]', err.message);
    res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden' });
  }
});

module.exports = router;
