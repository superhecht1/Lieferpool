# Update 12 – Pfandsystem
- backend/package.json (start führt migrate_fix13 aus: neue Spalte + Kistenkonto neu aufgebaut)
- backend/scripts/migrate_fix13.js, backend/src/routes/{pfand,touren,lieferungen}.js, backend/src/services/erinnerungen.js
- public/{caterer,fahrer,admin}.html, sw*.js
Neu: Fahrer bucht Leergut beim Stopp; Kistenkonto je Caterer; Caterer-Ansicht "Pfand" + druckbarer Kontoauszug; Erinnerung bei Kisten > 14 Tage; CSV-Export nur noch mit Admin-Login (Cookie).
Hinweis: Pfand-Steuerbehandlung mit Steuerberatung klären. Storno einer Lieferung bucht Pfand nicht automatisch zurück.
