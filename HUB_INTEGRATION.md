# LieferPool – Hub Modul Integration

## Was dazukommt

### Neue Tabellen (migrate_hub.js)
| Tabelle | Inhalt |
|---------|--------|
| `lager_positionen` | Aktueller Bestand pro Produkt + Region |
| `lager_bewegungen` | Jede Ein-/Ausbuchung mit Quelle |
| `bedarf_prognosen` | Wöchentlicher Bedarf je Caterer × Produkt |

### Neue Routes
| Route | Rolle | Funktion |
|-------|-------|----------|
| `GET /api/lager` | admin, caterer | Bestandsübersicht |
| `GET /api/lager/alerts` | admin | Unterbestand-Positionen |
| `GET /api/lager/bewegungen` | admin, caterer | Buchungshistorie |
| `POST /api/lager/eingang` | admin | Manueller Wareneingang |
| `POST /api/lager/ausgang` | admin, caterer | Warenausgang buchen |
| `POST /api/lager/korrektur` | admin | Inventurkorrektur |
| `PUT /api/lager/:id/mindestbestand` | admin | Mindestbestand setzen |
| `GET /api/bedarf` | caterer, admin | Bedarfsprognosen |
| `GET /api/bedarf/aggregiert` | admin | Gesamtbedarf je Produkt |
| `POST /api/bedarf` | caterer | Neue Prognose anlegen |
| `PUT /api/bedarf/:id` | caterer, admin | Prognose aktualisieren |
| `DELETE /api/bedarf/:id` | caterer, admin | Prognose deaktivieren |

### Automatik: Wareneingang → Lagerbuchung
Wenn `POST /api/lieferungen/:id/wareneingang` aufgerufen wird,
bucht das System automatisch eine `lager_bewegungen`-Zeile und
erhöht den Bestand in `lager_positionen`.

---

## Integration in bestehendes Projekt

### 1. Migration ausführen
```bash
node scripts/migrate_hub.js
```

### 2. Neue Route-Dateien kopieren
```
src/routes/lager.js    → in dein src/routes/
src/routes/bedarf.js   → in dein src/routes/
```

### 3. server.js aktualisieren
```js
// Nach den bestehenden Routes einfügen:
app.use('/api/lager',  require('./routes/lager'));
app.use('/api/bedarf', require('./routes/bedarf'));
```

### 4. lieferungen.js ersetzen
Ersetze `src/routes/lieferungen.js` mit der neuen Version.
Einzige Änderung: `bucheWareneingang()` wird nach Bestätigung aufgerufen.

### 5. api.js aktualisieren
Füge die neuen Hub-Calls aus der mitgelieferten `api.js` in deine bestehende ein:
- `getLager`, `getLagerAlerts`, `getLagerBewegungen`
- `lagerEingang`, `lagerAusgang`, `lagerKorrektur`, `setMindestbestand`
- `getBedarfPrognosen`, `getBedarfAggregiert`
- `createBedarfPrognose`, `updateBedarfPrognose`, `deleteBedarfPrognose`

### 6. Frontend-Views einbauen

**admin.html:**
- NAV: `{ id: 'lager', label: 'Lager' }` hinzufügen
- View-Block aus `admin_lager_view.html` einfügen
- `loadView()`: `if (v === 'lager') loadLager();` ergänzen
- JavaScript-Block aus `admin_lager_view.html` in den `<script>`-Block kopieren

**caterer.html:**
- NAV: `{ id: 'bedarf-prognose', label: 'Bedarfsprognose' }` hinzufügen
- View-Block aus `caterer_bedarf_view.html` einfügen
- `loadView()`: `if (v === 'bedarf-prognose') loadBedarfPrognose();` ergänzen
- JavaScript-Block aus `caterer_bedarf_view.html` in den `<script>`-Block kopieren

---

## Datenfluss Hub-Modul

```
Caterer legt Bedarfsprognose an
    ↓
Admin sieht aggregierten Bedarf (GET /api/bedarf/aggregiert)
    ↓
Admin erstellt Pool auf Basis des Bedarfs
    ↓
Erzeuger committen Mengen
    ↓
Lieferung bestätigt (POST /api/lieferungen/:id/wareneingang)
    ├── Auszahlungen berechnet (payout.js) ← unverändert
    └── Lagerbuchung automatisch           ← NEU
            ↓
        lager_positionen.bestand += menge_geliefert
        lager_bewegungen Eintrag erstellt
    ↓
Admin bucht Ausgang beim Ausliefern an Abnehmer
(POST /api/lager/ausgang)
```

---

## package.json – neues Script ergänzen
```json
"scripts": {
  "migrate:hub": "node scripts/migrate_hub.js"
}
```
