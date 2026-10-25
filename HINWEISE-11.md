# Update 11 – XSS-Schutz Admin + Caterer
Ziele: public/admin.html, public/caterer.html, public/app.js, public/sw.js, public/sw-caterer.js, public/sw-erzeuger.js
Alle Felder aus der API werden jetzt escaped (esc/jsq/safeUrl). Fuzz-Test (Stub-Backend): Admin 0, Caterer 0 Treffer.
Nach Deploy: einmal hart neu laden (SW-Cache wurde erhöht).
