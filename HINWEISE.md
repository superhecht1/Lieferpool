# Update 7 – Liefertag und Zeitfenster im Admin
Keine Migration (Spalten stammen aus migrate_fix10).
- public/admin.html, public/sw.js (Cache v5)
- src/routes/pools.js (PUT /:id/edit nimmt liefertag, zeitfenster_von/bis; Liefertag '' entfernt ihn)
Neu im Admin: Liefertag + Zeitfenster beim Anlegen eines Pools; Bearbeiten-Fenster (✏) war im HTML nicht vorhanden und wurde ergänzt, inkl. Liefertag/Zeitfenster.
Hinweis: Das Zeitfenster der Caterer-Seite war schon vorhanden.
