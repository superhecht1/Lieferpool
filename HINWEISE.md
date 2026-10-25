# Update 10 – Erzeuger-Dashboard überarbeitet
Keine Migration. Ablage: public/ -> public/, backend/src/routes/erzeuger.js -> src/routes/erzeuger.js

Sicherheit
- Pool-, Produkt-, Nachrichten- und Zertifikatstexte werden escaped (vorher konnte ein Pool-Name mit HTML-Code im Dashboard Skripte ausführen; die CSP erlaubt inline-Skripte).
- showAlert() in app.js escaped jetzt zentral (wirkt auch in Admin und Caterer).
- Lieferschein-QR kommt vom eigenen Server statt von api.qrserver.com (kein Datenabfluss an Dritte).

Fehler behoben
- Nach einer Zusage blieb das Formular versteckt (nur Seite neu laden half) -> Knopf "Weitere Zusage".
- Plattformgebühr war fest auf 1 % gerechnet -> jetzt je Pool (platform_fee_pct).
- Tote Funktionen entfernt (doppeltes Drucken, Pool-Suche ohne Elemente, nie aufgerufener Deadline-Alert).

Neu
- Kennzahlen: erwarteter Erlös der aktiven Zusagen, nächste Lieferung (statt Geliefert/Zertifikate).
- Karte "Meine Woche": was wann bereitzustellen ist (Liefertag + Zeitfenster), Pools mit Deadline < 48 h, fehlendes Zertifikat/IBAN/Standort.
- Offene Pools: Liefertag, Zeitfenster, Deadline, "Menge zusagen →" springt mit vorausgewähltem Pool in die Zusage; volle Pools zuletzt.
- Saison-Karte nach unten verschoben.
