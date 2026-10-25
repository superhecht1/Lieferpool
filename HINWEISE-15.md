# Update 15 – Caterer-Rechnungen, Datenschutz, DATEV mit Vorsteuer
NEU Render-Variablen (Pflicht für Rechnungen): FIRMA_USTID ODER FIRMA_STEUERNR
Optional: FIRMA_NAME, FIRMA_STRASSE, FIRMA_ORT, FIRMA_IBAN, FIRMA_BIC, FIRMA_BANK, FIRMA_EMAIL
Dateien: backend/package.json (start: migrate_fix14 zuerst), backend/scripts/migrate_fix14.js, backend/src/server.js,
backend/src/routes/{caterer-rechnungen,datev}.js, public/{datenschutz,admin,caterer}.html, sw.js, sw-caterer.js
Rechnungen: fortlaufende Nr. RE-JJJJ-NNNNN, unveränderlich, Storno = Stornorechnung. Pfand NICHT auf der Rechnung.
DATEV: Wareneingangskonto nach Steuersatz (SKR03 7%=3300, 19%=3400).
Datenschutz: Stand aktualisiert (Cookies, Pfand, Rechnungen, Offline-Daten, DATEV, Speicherfristen). Bitte juristisch gegenlesen.
