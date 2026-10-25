# Update 18 – Nutzerverwaltung im Admin (+ Fix Partner-Reiter)

- Admin → "👥 Nutzer": Liste mit Suche/Rollenfilter; Bearbeiten von Name, E-Mail, Aktiv-Status und Stammdaten (Erzeuger/Caterer: Betrieb/Firma, Anschrift, Telefon, Website, Beschreibung, USt-IdNr., Bank, IBAN neu setzen).
- Temporäres Passwort setzen (wird einmalig angezeigt, alle Sitzungen des Nutzers enden).
- Deaktivierte Konten: kein Login, kein Token-Refresh. Ein bereits ausgestelltes Zugriffstoken gilt bis zu seinem Ablauf weiter.
- Rolle ändern ist bewusst nicht möglich (Profile hängen an der Rolle). Eigenes Konto kann nicht deaktiviert werden.
- Änderungen stehen im Audit-Log (admin.user_geaendert / admin.user_passwort_gesetzt).
- Fix aus Update 16: Reiter "Partner" und "Logistik" teilten sich ID und Ladefunktion – Partner-Ansicht war nicht erreichbar.
- Keine Migration nötig. Enthält auch die Änderungen von Update 17 in admin.html (sw.js jetzt v16).
