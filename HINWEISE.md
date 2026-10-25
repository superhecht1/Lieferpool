# Update 6 – Saisonplanung, Warengruppen, CSV, PWA-Hinweis
Keine Migration, keine neuen Umgebungsvariablen.

Ablage (public/ -> Projekt public/, backend/src/ -> Projekt src/):
- public/app.js, admin.html, caterer.html, erzeuger.html, sw.js, sw-caterer.js, sw-erzeuger.js (Cache v4)
- src/routes/kennzahlen.js (+ /warengruppen, exportiert SAISON), saisonplan.js (neu), abrechnung.js (+ /csv)
- src/server.js (Route /api/saisonplan)

Neu:
- Saison-Karte (Admin/Caterer: Übersicht, Erzeuger: Pools-Ansicht): jetzt/bald, Ganzjahreskalender; Admin zusätzlich Vorschläge für Pools mit Bedarf ohne offenen Pool.
- Caterer, Nachhaltigkeit: Warengruppen-Auswertung (kg-Anteile, pflanzlicher Anteil; Zuordnung nach Produktname, Näherung). KEINE DGE-Konformitätsaussage.
- Caterer, Lieferscheine: Monatsabrechnung auch als CSV (Excel/Buchhaltung; Semikolon, Dezimalkomma). Kein DATEV-Format.
- Installationshinweis (Android/Chrome-Button, iOS-Anleitung) auf den Rollenseiten, einmal wegklickbar.
