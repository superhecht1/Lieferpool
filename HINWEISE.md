# Update 9 – Sitzung per httpOnly-Cookie + verschlüsselte Offline-Daten (Fahrer)
Keine Migration, keine neuen Umgebungsvariablen. Reihenfolge egal: Backend und public/ zusammen deployen.

Ablage:
- public/: api.js, login.html, register.html, fahrer.html, sw.js, sw-caterer.js, sw-erzeuger.js, sw-fahrer.js (Caches neu)
- src/middleware/cookieauth.js (NEU), src/middleware/csrf.js (ersetzt), src/routes/auth.js (ersetzt), src/server.js (ersetzt)

Was sich ändert
1) Sitzung: Das Login-Token liegt nicht mehr in localStorage, sondern in httpOnly-Cookies (lp_at, lp_rt; SameSite=Strict, Secure unter HTTPS).
   - JavaScript auf der Seite kann sie nicht lesen (schützt vor Token-Diebstahl per XSS).
   - Der Server übersetzt das Cookie in den Authorization-Header; middleware/auth.js bleibt unverändert.
   - API-Clients/Tests mit echtem "Authorization: Bearer <token>" funktionieren weiter (Login-Antwort enthält das Token weiterhin).
   - Alle bestehenden Nutzer müssen sich EINMAL neu anmelden.
   - Logout löscht Cookies + Refresh-Tokens serverseitig, auch bei abgelaufenem Access-Token.
2) Origin-Prüfung (csrf.js) strenger: exakter Vergleich statt "beginnt mit" (Lücke: https://deine-domain.evil.com wäre durchgegangen);
   Cookie-Sitzungen ohne Origin/Referer werden bei schreibenden Requests abgelehnt.
   Setze in Render APP_URL=https://lieferpool.onrender.com (oder CORS_ORIGIN), sonst gilt nur der Host der Anfrage selbst.
3) Fahrer-App: Warteschlange und Tour-Snapshots werden mit AES-GCM verschlüsselt (Schlüssel nicht exportierbar), Daten älter als 36 h werden nicht mehr geladen,
   beim Abmelden werden Daten UND Schlüssel gelöscht. Sind beim Abmelden noch Aktionen ungesendet und es gibt kein Netz, fragt die App nach.
