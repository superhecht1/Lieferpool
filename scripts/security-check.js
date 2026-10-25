#!/usr/bin/env node
/**
 * security-check.js – statische Sicherheitsprüfung (Heuristik, ersetzt keinen Pentest)
 * Ablage: scripts/security-check.js · Aufruf: npm run security  (im Projekt-Hauptordner)
 *   --env   zusätzlich Umgebungsvariablen prüfen (JWT_SECRET, FIELD_ENCRYPTION_KEY, DATABASE_URL, NODE_ENV)
 * Prüft: Routen ohne auth, SQL mit Textverkettung, fest eingetragene Geheimnisse, helmet/Rate-Limit/CORS.
 * Exit-Code 1 bei WARNUNG.
 */
const fs = require('fs'), path = require('path');
const ROOT = process.cwd();
let warn = 0, info = 0;
const W = (m) => { warn++; console.log('  ✗ WARNUNG  ' + m); };
const I = (m) => { info++; console.log('  ·  hinweis ' + m); };
const OK = (m) => console.log('  ✓ ' + m);
const walk = (d, ext) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.name === 'node_modules' || e.name === 'vendor' || e.name.startsWith('.') ? [] :
  e.isDirectory() ? walk(path.join(d, e.name), ext) : ext.some(x => e.name.endsWith(x)) ? [path.join(d, e.name)] : []) : [];
const rel = f => path.relative(ROOT, f);
const lineOf = (s, i) => s.slice(0, i).split('\n').length;

// Routen, die bewusst ohne Login erreichbar sind (Datei:Pfad-Muster)
const OEFFENTLICH = [/auth\.js:.*\/(login|register|setup|refresh|forgot|reset|vapid|verify|logout|csrf)/i, /public\.js:/, /contact\.js:/, /stripe\.js:.*webhook/i,
  /monitoring\.js:.*(health|ping)/i, /einladungen\.js:.*(\/:token|annehmen|pruefen)/i,
  /auth\.js:.*2fa-complete/i /* eigene Prüfung per Zwischen-Token */, /lieferungen\.js:GET \/qr/i /* nur QR-Bild einer URL */, /stripe\.js:GET \/config/i /* nur öffentlicher Schlüssel */, /pfand\.js:GET \/export-csv/i /* prüft Admin-Token selbst */];

console.log('\n── 1. Routen ohne Authentifizierung ──');
const routeFiles = walk(path.join(ROOT, 'src', 'routes'), ['.js']);
if (!routeFiles.length) I('src/routes nicht gefunden – im Projekt-Hauptordner ausführen');
let offen = 0;
for (const f of routeFiles) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2\s*,([\s\S]*?)(?:async\s*)?\(\s*req\s*,\s*res/g;
  let m;
  while ((m = re.exec(s))) {
    const [, meth, , p, mids] = m;
    if (/\bauth\b|authenticate|requireAuth|verifyToken|\w*Auth\b/.test(mids)) continue;
    const key = path.basename(f) + ':' + meth.toUpperCase() + ' ' + p;
    if (OEFFENTLICH.some(r => r.test(key))) { offen++; continue; }
    (meth === 'get' ? I : W)(`${rel(f)}:${lineOf(s, m.index)}  ${meth.toUpperCase()} ${p} ist ohne Login erreichbar`);
  }
}
for (const f of routeFiles) {
  const t = fs.readFileSync(f, 'utf8'); const m = /req\.query\.(token|_t)\b/.exec(t);
  if (m) I(`${rel(f)}:${lineOf(t, m.index)}  Login-Token in der URL (landet in Verlauf/Logs) – nur für Downloads per window.open vertretbar`);
}
OK(`${offen} bewusst öffentliche Routen (Login, Webhook, Kontakt, Wirkung …) übersprungen`);

console.log('\n── 2. SQL mit Textverkettung (mögliche Injection) ──');
const SICHER = /^(tab|condition|catererId \? '[^']*' : ''|where|cf|extra|filter|filters\.join\([^)]*\)|and|order|t|tabelle|table|col|spalte|\$\{?\w*idx\w*\}?|limitIdx|offsetIdx|params\.length\s*\+\s*\d|filterParams\.length\s*\+\s*\d|\w+\.length)$/i;
const codeFiles = [...walk(path.join(ROOT, 'src'), ['.js']), ...walk(path.join(ROOT, 'scripts'), ['.js'])];
let sqlHits = 0;
for (const f of codeFiles) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /\.query\(\s*`([\s\S]*?)`/g; let m;
  while ((m = re.exec(s))) {
    const bad = [...m[1].matchAll(/(?<!\$)\$\{([^}]*)\}/g)].map(x => x[1].trim()).filter(x => !SICHER.test(x));
    if (bad.length) { sqlHits++; I(`${rel(f)}:${lineOf(s, m.index)}  Platzhalter im SQL-Text: \${${bad.join('}, ${')}} – prüfen, dass keine Nutzereingabe`); }
  }
}
if (!sqlHits) OK('keine auffälligen Verkettungen');

console.log('\n── 3. Fest eingetragene Geheimnisse ──');
const alle = [...codeFiles, ...walk(path.join(ROOT, 'public'), ['.js', '.html']), ...['.env', 'render.yaml', 'package.json'].map(x => path.join(ROOT, x)).filter(fs.existsSync)];
const MUSTER = [[/sk_live_[A-Za-z0-9]{10,}/, 'Stripe Live-Key'], [/whsec_[A-Za-z0-9]{10,}/, 'Stripe Webhook-Secret'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'Privater Schlüssel'],
  [/xkeysib-[a-z0-9-]{20,}/i, 'Brevo API-Key'], [/postgres(ql)?:\/\/[^\s:'"]+:[^\s@'"]{4,}@/, 'Datenbank-URL mit Passwort'], [/(JWT_SECRET|FIELD_ENCRYPTION_KEY)\s*[:=]\s*['"][^'"$]{16,}['"]/, 'Geheimnis im Code']];
let sec = 0;
for (const f of alle) {
  if (/security-check|\.test\.js$/.test(f)) continue;
  const s = fs.readFileSync(f, 'utf8');
  for (const [re, name] of MUSTER) { const m = re.exec(s); if (m) { sec++; W(`${rel(f)}:${lineOf(s, m.index)}  ${name}`); } }
}
if (fs.existsSync(path.join(ROOT, '.env')) && !/\.env/.test(fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '')) W('.env existiert, steht aber nicht in .gitignore');
if (!sec) OK('keine Treffer');

console.log('\n── 4. Server-Härtung ──');
const sv = path.join(ROOT, 'src', 'server.js');
if (fs.existsSync(sv)) {
  const s = fs.readFileSync(sv, 'utf8');
  /helmet\(/.test(s) ? OK('helmet aktiv') : W('helmet fehlt');
  /rateLimit\(/.test(s) ? OK('Rate-Limit vorhanden') : W('Rate-Limit fehlt');
  /cors\(\s*\)/.test(s) || /origin\s*:\s*['"]\*['"]/.test(s) ? W('CORS erlaubt alle Herkünfte') : OK('CORS nicht pauschal offen');
  /unsafe-eval/.test(s) ? W("CSP erlaubt 'unsafe-eval'") : OK("CSP ohne 'unsafe-eval'");
  /trust proxy/.test(s) ? OK('trust proxy gesetzt (Rate-Limit nach echter IP)') : I('trust proxy nicht gesetzt – hinter Render zählt das Rate-Limit sonst die Proxy-IP');
} else I('src/server.js nicht gefunden');

if (process.argv.includes('--env')) {
  console.log('\n── 5. Umgebungsvariablen ──');
  const e = process.env;
  (e.JWT_SECRET || '').length >= 32 ? OK('JWT_SECRET ≥ 32 Zeichen') : W('JWT_SECRET fehlt oder ist kürzer als 32 Zeichen');
  /^[0-9a-f]{64}$/i.test(e.FIELD_ENCRYPTION_KEY || '') ? OK('FIELD_ENCRYPTION_KEY gültig (64 Hex)') : W('FIELD_ENCRYPTION_KEY fehlt oder ist kein 64-stelliger Hex-Wert');
  e.NODE_ENV === 'production' ? OK('NODE_ENV=production') : W('NODE_ENV ist nicht "production"');
  /sslmode=|ssl=true/.test(e.DATABASE_URL || '') ? OK('DATABASE_URL erzwingt SSL') : I('DATABASE_URL ohne sslmode');
  e.ADMIN_EMAIL ? OK('ADMIN_EMAIL gesetzt') : I('ADMIN_EMAIL fehlt (Alarm-Mails aus)');
}

console.log(`\nErgebnis: ${warn} Warnung(en), ${info} Hinweis(e)\n`);
process.exit(warn ? 1 : 0);
