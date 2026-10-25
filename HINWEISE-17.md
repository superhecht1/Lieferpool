# Update 17 – Servicegebühr 5 % (2,5 % Hof + 2,5 % Küche)

- Hof: Abzug bei der Auszahlung (bestehendes Feld `platform_fee_pct`), jetzt 2,5 % statt 1 %. Neue Pools bekommen den Wert vom Server; Caterer können ihn nicht mehr selbst setzen (vorher möglich!). Alte Pools mit 1 % ohne Auszahlung werden per Migration angehoben.
- Küche: eigene Zeile "Servicegebühr 2,5 % (netto)" auf der Caterer-Rechnung, Umsatzsteuer 19 % auf die Gebühr, Ware weiter mit 7 %. Prozentsatz wird je Rechnung festgeschrieben, Storno kehrt ihn um.
- Optionale Render-Variablen: GEBUEHR_HOF_PROZENT (2.5), GEBUEHR_KUECHE_PROZENT (2.5), GEBUEHR_KUECHE_MWST (19).
- Neu in `npm start`: scripts/migrate_fix16.js. Danach Redeploy, Seiten neu laden (SW-Cache v14 / erzeuger v9).
- Offen für die Steuerberatung: Rechnungsstellung bei Vermittlung (Rechnung der Höfe bzw. Gutschriftverfahren), USt auf die Hof-Gebühr, Hinweis in AGB.

## Ergänzt
- Admin → Rechnungen an Caterer: Zeile "Servicegebühr <Monat>" mit Einnahmen Küchen + Höfe (neuer Endpoint GET /api/caterer-rechnungen/gebuehren?monat=YYYY-MM).
- AGB § 6 beschreibt die Servicegebühr (5 %, je 2,5 %) – bitte rechtlich prüfen lassen.
- sw.js jetzt v15.
