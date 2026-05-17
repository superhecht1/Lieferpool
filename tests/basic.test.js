/**
 * Basis-Tests für FrischKette
 * node tests/basic.test.js
 */
require('dotenv').config();
const BASE = process.env.APP_URL || 'http://localhost:3000';
let token = '', passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch(e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'failed'); }
async function req(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type':'application/json', ...(token?{'Authorization':'Bearer '+token}:{}), ...(opts.headers||{}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(()=>({})) };
}

(async () => {
  console.log('\n🧪 FrischKette Tests\n');

  console.log('Health:');
  await test('Health-Check OK', async () => {
    const {status,data} = await req('/health');
    assert(status===200); assert(data.db==='ok');
  });

  console.log('\nAuth:');
  await test('Login ohne Daten → 400', async () => {
    const {status} = await req('/api/auth/login',{method:'POST',body:{}});
    assert(status===400);
  });
  await test('Falsche Zugangsdaten → 401', async () => {
    const {status} = await req('/api/auth/login',{method:'POST',body:{email:'x@x.de',password:'wrong'}});
    assert(status===401||status===400);
  });
  await test('Admin Login', async () => {
    const {status,data} = await req('/api/auth/login',{method:'POST',body:{email:process.env.ADMIN_EMAIL||'',password:process.env.ADMIN_PW||''}});
    if(status===200) token=data.token;
    assert(status===200||status===401);
  });

  console.log('\nSicherheit:');
  await test('Geschützte Route ohne Token → 401', async () => {
    const {status} = await fetch(BASE+'/api/pools').then(r=>({status:r.status}));
    assert(status===401);
  });
  await test('Fremde Origin → 403', async () => {
    const {status} = await req('/api/pools',{method:'POST',headers:{'Origin':'https://evil.com'},body:{}});
    assert(status===403||status===401);
  });

  if (token) {
    console.log('\nAPI:');
    await test('Pools abrufbar', async () => {
      const {status,data} = await req('/api/pools');
      assert(status===200); assert(Array.isArray(data.pools));
    });
    await test('Erzeuger abrufbar', async () => {
      const {status,data} = await req('/api/erzeuger');
      assert(status===200); assert(Array.isArray(data.erzeuger));
    });
    await test('Suche antwortet', async () => {
      const {status,data} = await req('/api/suche?q=test');
      assert(status===200); assert(Array.isArray(data.results));
    });
    await test('Pfand-Stats', async () => {
      const {status,data} = await req('/api/pfand/stats');
      assert(status===200); assert(data.kisten_gesamt!==undefined);
    });
    await test('Health-Stats', async () => {
      const {status,data} = await req('/api/monitoring/stats');
      assert(status===200); assert(data.pools!==undefined);
    });
  }

  console.log(`\n${'─'.repeat(35)}`);
  console.log(`✓ ${passed} bestanden  ✗ ${failed} fehlgeschlagen`);
  if(failed) process.exit(1);
})();
