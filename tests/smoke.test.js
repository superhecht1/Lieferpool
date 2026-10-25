/**
 * Smoke-Tests gegen einen laufenden Server (lokal oder Staging)
 * Ablage: tests/smoke.test.js · Aufruf: APP_URL=http://localhost:3000 npm run test:smoke
 * Optional (sonst werden die Rollen-Tests übersprungen):
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD, TEST_CATERER_EMAIL / TEST_CATERER_PASSWORD,
 *   TEST_ERZEUGER_EMAIL / TEST_ERZEUGER_PASSWORD
 * Admin mit 2FA: TEST_ADMIN_TOTP (aktueller 6-stelliger Code) setzen.
 * NIE gegen die Produktions-Datenbank mit echten Kundendaten laufen lassen, die Tests sind nur lesend,
 * aber die Test-Konten sollten eigene Konten sein.
 */
require('dotenv').config();
const BASE = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
let passed = 0, failed = 0, skipped = 0;

async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'fehlgeschlagen'); };
async function http(path, { token, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = {}; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text, headers: r.headers };
}
async function login(prefix) {
  const email = process.env[`TEST_${prefix}_EMAIL`], password = process.env[`TEST_${prefix}_PASSWORD`];
  if (!email || !password) return null;
  const r = await http('/api/auth/login', { method: 'POST', body: { email, password } });
  if (r.data.requires2fa) {
    const code = process.env[`TEST_${prefix}_TOTP`];
    if (!code) return null;
    const r2 = await http('/api/auth/2fa-complete', { method: 'POST', token: r.data.pendingToken, body: { code } });
    return r2.data.token || r2.data.accessToken || null;
  }
  return r.data.token || r.data.accessToken || null;
}

(async () => {
  console.log(`\n🧪 Smoke-Tests · ${BASE}\n`);

  console.log('Öffentlich:');
  for (const p of ['/', '/login', '/register', '/impressum', '/datenschutz', '/agb', '/style.css', '/app.js', '/api.js',
                   '/vendor/fonts.css', '/vendor/chart.umd.js', '/vendor/leaflet/leaflet.js', '/vendor/jsQR.js'])
    await test(`GET ${p} → 200`, async () => assert((await http(p)).status === 200, 'Status ' + (await http(p)).status));

  await test('Health-Check: DB ok', async () => { const r = await http('/health'); assert(r.status === 200 && r.data.db === 'ok'); });
  await test('Unbekannte API-Route → 404 JSON', async () => { const r = await http('/api/gibt-es-nicht'); assert(r.status === 404 && r.data.error); });
  await test('Geschützte Route ohne Token → 401', async () => assert((await http('/api/pools')).status === 401));
  await test('Login mit falschem Passwort → 401', async () => assert((await http('/api/auth/login', { method: 'POST', body: { email: 'x@x.de', password: 'falsch' } })).status === 401));
  await test('CSP lädt nichts von Google/CDNs', async () => {
    const csp = (await http('/')).headers.get('content-security-policy') || '';
    for (const bad of ['googleapis', 'gstatic', 'jsdelivr', 'unpkg']) assert(!csp.includes(bad), 'CSP enthält ' + bad);
  });
  await test('Seiten laden keine externen Skripte/Schriften', async () => {
    for (const p of ['/', '/login', '/admin', '/caterer', '/erzeuger', '/fahrer', '/datenschutz']) {
      const t = (await http(p)).text;
      assert(!/(fonts\.googleapis|cdn\.jsdelivr|unpkg\.com)/.test(t), p + ' lädt externe Ressourcen');
    }
  });

  const rollen = [
    ['ADMIN',    ['/api/pools', '/api/erzeuger', '/api/caterer', '/api/kennzahlen', '/api/nachrichten', '/api/reports/dashboard', '/api/monitoring/stats']],
    ['CATERER',  ['/api/pools', '/api/caterer/me', '/api/kennzahlen', '/api/nachrichten', '/api/lieferungen?limit=5']],
    ['ERZEUGER', ['/api/pools', '/api/erzeuger/me', '/api/nachrichten']],
  ];
  for (const [rolle, pfade] of rollen) {
    console.log(`\n${rolle}:`);
    const token = await login(rolle);
    if (!token) { console.log('  – übersprungen (keine Zugangsdaten in TEST_' + rolle + '_*)'); skipped++; continue; }
    await test('Login liefert Token', async () => assert(token.length > 20));
    for (const p of pfade) await test(`GET ${p} → 200`, async () => {
      const r = await http(p, { token }); assert(r.status === 200, 'Status ' + r.status + ' ' + (r.data.error || ''));
    });
    if (rolle !== 'ADMIN') await test('Admin-Route gesperrt (403)', async () => assert([401, 403].includes((await http('/api/monitoring/stats', { token })).status)));
    await test('IBAN wird nie verschlüsselt ausgeliefert', async () => {
      const r = await http(rolle === 'ERZEUGER' ? '/api/erzeuger/me' : rolle === 'CATERER' ? '/api/caterer/me' : '/api/erzeuger', { token });
      assert(!JSON.stringify(r.data).includes('enc:v1:'), 'enc:v1: in Antwort');
    });
  }

  console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen, ${skipped} Rollen übersprungen\n`);
  process.exit(failed ? 1 : 0);
})();
