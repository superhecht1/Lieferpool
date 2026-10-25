# Update 2 – Reihenfolge
1. Dateien in die gleichnamigen Ordner kopieren (package.json im Projekt-Hauptordner).
2. Schlüssel erzeugen und in Render als Umgebungsvariable setzen (FIELD_ENCRYPTION_KEY):
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   WICHTIG: Schlüssel zusätzlich sicher außerhalb von Render aufbewahren (Passwortmanager). Ohne ihn sind die IBAN nicht lesbar.
3. ADMIN_EMAIL und BREVO_API_KEY gesetzt lassen (Fehleralarm und Erinnerungen).
4. Deploy, dann Migrationen: npm run migrate:fix11 && npm run migrate:fix12
5. Test: APP_URL=https://deine-domain npm run test:smoke
