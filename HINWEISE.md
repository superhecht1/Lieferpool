# Update 8 – Sicherheitscheck + Zugriffs-Fixes
Ablage: scripts/security-check.js · .github/workflows/security.yml · package.json (Hauptordner, neues Script "security")
Backend: src/routes/print.js, src/routes/lieferungen.js

Behoben:
- print.js: /lieferung/:id nur für Admin oder den Caterer, dem der Pool gehört; /tour/:id nur Admin oder zugewiesener Fahrer (vorher: jeder Eingeloggte mit der ID).
- lieferungen.js: QR-Code-Pfad validiert; Standard-Domain auf lieferpool.onrender.com (vorher falsche Domain, wenn APP_URL fehlt).

Nutzung:
- Im Repo: Actions -> Sicherheitscheck -> Run workflow (läuft zusätzlich wöchentlich).
- Lokal: npm run security  |  npm run security -- --env (prüft zusätzlich JWT_SECRET, FIELD_ENCRYPTION_KEY, NODE_ENV).
- WICHTIG: In Render APP_URL=https://lieferpool.onrender.com setzen.
Der Check ist eine Heuristik und ersetzt keinen Penetrationstest.
