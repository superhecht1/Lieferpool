# Update 5 – Offline-Modus Fahrer
Dateien: public/fahrer.html, public/sw-fahrer.js (Cache v4). Keine Migration, kein Backend-Update.

- Touren und geöffnete Tour werden auf dem Gerät gespeichert (IndexedDB) – Tour einmal mit Netz öffnen.
- Ohne Netz: Stopp bestätigen/überspringen, Tour starten/beenden -> Warteschlange, Anzeige im roten Banner.
- Sobald Netz da ist (oder per Tipp auf das Banner, sonst alle 60 s): automatische Übertragung in Reihenfolge.
- GPS-Tracking pausiert ohne Netz (keine Nachlieferung).
- Vom Server abgelehnte Aktionen werden verworfen und gemeldet.
