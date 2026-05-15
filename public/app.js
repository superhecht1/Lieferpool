/**
 * app.js – Gemeinsame Hilfsfunktionen + Pool-Detail Modal + Mobile Nav + Push
 */

// ── Modal + Mobile Nav CSS ─────────────────────────────────────
(function injectCSS() {
  const style = document.createElement('style');
  style.textContent = `
    /* Modal */
    .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:500;display:flex;align-items:flex-start;justify-content:center;padding:2rem 1rem;overflow-y:auto;animation:fadeIn .15s ease}
    .modal{background:#fff;border-radius:12px;width:100%;max-width:780px;box-shadow:0 20px 60px rgba(0,0,0,.2);position:relative;animation:slideUp .2s ease}
    .modal-head{padding:1.25rem 1.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:1rem}
    .modal-title{font-weight:600;font-size:16px;flex:1;color:var(--text)}
    .modal-close{width:28px;height:28px;border-radius:50%;background:var(--bg3);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--text2);transition:all .15s;flex-shrink:0}
    .modal-close:hover{background:var(--border);color:var(--text)}
    .modal-body{padding:1.5rem}
    .modal-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:1.25rem}
    .modal-tab{padding:.6rem 1.1rem;font-size:12px;font-weight:500;cursor:pointer;border:none;background:none;color:var(--text3);border-bottom:2px solid transparent;transition:all .15s;font-family:'DM Sans',sans-serif}
    .modal-tab:hover{color:var(--text2)}
    .modal-tab.active{color:var(--green);border-bottom-color:var(--green)}
    .modal-tab-content{display:none}
    .modal-tab-content.active{display:block}
    .modal-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1.25rem}
    .modal-stat{background:var(--bg);border-radius:6px;padding:.875rem 1rem;border:1px solid var(--border)}
    .modal-stat-label{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--text3);margin-bottom:.25rem;font-family:'DM Mono',monospace}
    .modal-stat-val{font-size:18px;font-weight:300;color:var(--text)}
    .modal-stat-val.green{color:var(--green)}
    .modal-actions{display:flex;gap:.75rem;flex-wrap:wrap;padding-top:1.25rem;border-top:1px solid var(--border);margin-top:1.25rem}
    .pool-detail-bar{height:8px;background:var(--bg3);border-radius:4px;overflow:hidden;margin:.5rem 0}
    .pool-detail-bar-fill{height:100%;border-radius:4px;background:var(--green);transition:width .5s ease}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    @keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
    @media(max-width:560px){.modal-grid{grid-template-columns:1fr 1fr}}

    /* Mobile Nav */
    .hamburger{display:none;flex-direction:column;gap:4px;background:none;border:1px solid var(--border);padding:7px 9px;border-radius:var(--radius);cursor:pointer}
    .hamburger span{width:18px;height:2px;background:var(--text2);border-radius:1px;transition:all .2s}
    .nav-mobile-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200}
    .nav-mobile-panel{position:fixed;top:0;left:0;bottom:0;width:240px;background:#fff;z-index:201;transform:translateX(-100%);transition:transform .25s ease;border-right:1px solid var(--border);padding:1rem 0;overflow-y:auto}
    .nav-mobile-panel.open{transform:translateX(0)}
    .nav-mobile-panel .nav-btn{display:block;width:100%;text-align:left;padding:.75rem 1.25rem;border-radius:0;font-size:13px}
    .nav-mobile-logo{padding:.5rem 1.25rem 1rem;font-family:'DM Mono',monospace;font-size:14px;font-weight:500;border-bottom:1px solid var(--border);margin-bottom:.5rem}
    .nav-mobile-logo span{color:var(--green)}
    @media(max-width:768px){
      .hamburger{display:flex}
      .nav{display:none !important}
      .hdr-right .role-badge,.hdr-right span:not(.btn-logout){display:none}
    }

    /* Pool-Suche */
    .pool-search-wrap{position:relative;margin-bottom:1rem}
    .pool-search-input{width:100%;padding:8px 12px 8px 36px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);font-size:13px;color:var(--text);transition:border-color .15s}
    .pool-search-input:focus{outline:none;border-color:var(--green-dim);box-shadow:0 0 0 3px rgba(46,125,62,.1)}
    .pool-search-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--text3);font-size:14px;pointer-events:none}

    /* Push Banner */
    .push-banner{background:var(--green-bg);border:1px solid #b8dfc0;border-radius:var(--radius);padding:.75rem 1rem;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;font-size:13px}
  `;
  document.head.appendChild(style);
})();

// ── Auth-Guard ─────────────────────────────────────────────────
function requireAuth(expectedRole) {
  if (!Auth.isLoggedIn()) { window.location.href = '/login'; return false; }
  const user = Auth.getUser();
  if (expectedRole && user.role !== expectedRole && user.role !== 'admin') {
    const map = { erzeuger:'/erzeuger', caterer:'/caterer', fahrer:'/fahrer', admin:'/admin' };
    window.location.href = map[user.role] || '/login';
    return false;
  }
  return user;
}

// ── Mobile Nav ─────────────────────────────────────────────────
function renderHeader(activeView, navItems, onNav) {
  const user = Auth.getUser();
  const roleLabels = { erzeuger:'Erzeuger', caterer:'Caterer', admin:'Admin', fahrer:'Fahrer' };
  const hdr = document.getElementById('app-header');

  hdr.innerHTML = `
    <button class="hamburger" id="hamburger-btn" aria-label="Menü">
      <span></span><span></span><span></span>
    </button>
    <div class="logo">Liefer<span>Pool</span></div>
    <nav class="nav" id="main-nav">
      ${navItems.map(n => `<button class="nav-btn ${activeView===n.id?'active':''}" data-view="${n.id}">${n.label}</button>`).join('')}
    </nav>
    <div class="hdr-right">
      <span class="role-badge">${roleLabels[user?.role]||''}</span>
      <span style="font-size:12px;color:var(--text2)">${user?.name||''}</span>
      <button class="btn-logout" id="btn-logout">Abmelden</button>
    </div>

    <!-- Mobile Panel -->
    <div class="nav-mobile-overlay" id="nav-overlay"></div>
    <div class="nav-mobile-panel" id="nav-panel">
      <div class="nav-mobile-logo">Liefer<span>Pool</span></div>
      ${navItems.map(n => `<button class="nav-btn ${activeView===n.id?'active':''}" data-view="${n.id}">${n.label}</button>`).join('')}
    </div>
  `;

  // Desktop nav
  document.getElementById('main-nav').addEventListener('click', e => {
    const btn = e.target.closest('[data-view]');
    if (btn) { onNav(btn.dataset.view); updateActiveNav(btn.dataset.view); }
  });

  // Mobile hamburger
  const panel   = document.getElementById('nav-panel');
  const overlay = document.getElementById('nav-overlay');
  document.getElementById('hamburger-btn').addEventListener('click', () => {
    panel.classList.toggle('open');
    overlay.style.display = panel.classList.contains('open') ? 'block' : 'none';
  });
  overlay.addEventListener('click', () => {
    panel.classList.remove('open'); overlay.style.display = 'none';
  });
  panel.addEventListener('click', e => {
    const btn = e.target.closest('[data-view]');
    if (btn) {
      onNav(btn.dataset.view);
      updateActiveNav(btn.dataset.view);
      panel.classList.remove('open'); overlay.style.display = 'none';
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    try { await api.logout(Auth.getRefresh()); } catch {}
    Auth.clear(); window.location.href = '/login';
  });
}

function updateActiveNav(viewId) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewId));
}

// ── View Switcher ──────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  const el = document.getElementById('view-' + id);
  if (el) el.style.display = 'block';
  updateActiveNav(id);
}

// ── Formatierung ───────────────────────────────────────────────
function fmt(n, decimals = 2) { return parseFloat(n||0).toFixed(decimals).replace('.',','); }

function deadlineCountdown(deadline) {
  if (!deadline) return '';
  const diff = new Date(deadline) - new Date();
  if (diff <= 0) return '<span class="badge badge-red">Abgelaufen</span>';
  const days  = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 7)  return `<span class="pool-meta">${new Date(deadline).toLocaleDateString('de-DE')}</span>`;
  if (days > 0)  return `<span class="badge badge-amber">⏱ ${days}d ${hours}h</span>`;
  return `<span class="badge badge-red">⏱ Noch ${hours}h!</span>`;
}
function poolPct(committed, ziel) { return Math.min(100, Math.round((committed/ziel)*100)); }
function statusBadge(status) {
  const map = {
    offen:['badge-amber','offen'], geschlossen:['badge-green','geschlossen'], geliefert:['badge-green','geliefert'],
    abgebrochen:['badge-red','abgebrochen'], aktiv:['badge-green','aktiv'], pending:['badge-amber','ausstehend'],
    verified:['badge-green','verifiziert'], rejected:['badge-red','abgelehnt'], veranlasst:['badge-amber','veranlasst'],
    ausgezahlt:['badge-green','ausgezahlt'], fehlgeschlagen:['badge-red','fehlgeschlagen'],
    ausstehend:['badge-gray','ausstehend'], geplant:['badge-gray','geplant'], eingegangen:['badge-green','eingegangen'],
    abgelehnt:['badge-red','abgelehnt'], gestartet:['badge-amber','gestartet'],
    abgeschlossen:['badge-green','abgeschlossen'], uebersprungen:['badge-gray','übersprungen'],
  };
  const [cls, label] = map[status] || ['badge-gray', status];
  return `<span class="badge ${cls}">${label}</span>`;
}
function poolBar(committed, ziel) {
  const pct = poolPct(committed, ziel);
  const cls = pct < 40 ? 'low' : pct < 80 ? 'warn' : '';
  return `
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2);font-family:'DM Mono',monospace;margin-top:6px">
      <span>${Math.round(committed)} / ${Math.round(ziel)} kg</span><span>${pct}%</span>
    </div>
    <div class="progress-wrap"><div class="progress-bar ${cls}" style="width:${pct}%"></div></div>
  `;
}
function chainInfo(txHash) {
  if (!txHash) return '';
  return `<div class="chain-info"><div class="chain-dot"></div>${txHash.slice(0,10)}...${txHash.slice(-6)}</div>`;
}

// ── Pool-Suche ────────────────────────────────────────────────
function createPoolSearch(containerId, pools, renderFn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const wrap = document.createElement('div');
  wrap.className = 'pool-search-wrap';
  wrap.innerHTML = `
    <span class="pool-search-icon">🔍</span>
    <input class="pool-search-input" placeholder="Pool suchen (Produkt, Region, KW)...">
  `;
  container.prepend(wrap);
  wrap.querySelector('input').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    const filtered = pools.filter(p =>
      p.produkt?.toLowerCase().includes(q) ||
      p.region?.toLowerCase().includes(q) ||
      p.lieferwoche?.toLowerCase().includes(q)
    );
    renderFn(filtered);
  });
}

// ── Alerts + Toast ─────────────────────────────────────────────
function showAlert(containerId, type, msg) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
  setTimeout(() => { if (el) el.innerHTML = ''; }, 5000);
}
function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `alert alert-${type}`;
  t.style.cssText = 'position:fixed;top:64px;right:1rem;z-index:999;min-width:260px;box-shadow:0 4px 12px rgba(0,0,0,.12)';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Push Notifications ─────────────────────────────────────────
async function registerPushNotifications(containerId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  // Service Worker registrieren
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('[push] SW Registrierung fehlgeschlagen:', err.message);
    return;
  }

  // VAPID Key holen
  let vapidKey;
  try {
    const data = await api.getVapidKey();
    vapidKey = data.publicKey;
  } catch { return; } // Push nicht konfiguriert

  // Schon subscribed?
  const sw   = await navigator.serviceWorker.ready;
  const existing = await sw.pushManager.getSubscription();
  if (existing) return; // bereits aktiv

  // Banner anzeigen
  const container = document.getElementById(containerId);
  if (!container) return;
  const banner = document.createElement('div');
  banner.className = 'push-banner';
  banner.innerHTML = `
    <span>🔔 Benachrichtigungen für neue Touren aktivieren?</span>
    <div style="display:flex;gap:.5rem">
      <button class="btn btn-primary btn-sm" id="btn-push-allow">Aktivieren</button>
      <button class="btn btn-sm" id="btn-push-deny">Nein danke</button>
    </div>
  `;
  container.prepend(banner);

  banner.querySelector('#btn-push-deny').addEventListener('click', () => banner.remove());
  banner.querySelector('#btn-push-allow').addEventListener('click', async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { banner.remove(); return; }

      const sub = await sw.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      await api.pushSubscribe({ endpoint: sub.endpoint, keys: { p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))), auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')))) } });
      banner.innerHTML = '<span style="color:var(--green)">✓ Benachrichtigungen aktiviert</span>';
      setTimeout(() => banner.remove(), 3000);
    } catch (err) {
      banner.innerHTML = `<span style="color:var(--red)">Fehler: ${err.message}</span>`;
      setTimeout(() => banner.remove(), 4000);
    }
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── POOL DETAIL MODAL ──────────────────────────────────────────
async function showPoolDetail(poolId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'pool-modal-overlay';
  overlay.innerHTML = `
    <div class="modal" id="pool-modal">
      <div class="modal-head">
        <div class="modal-title" id="modal-pool-title"><span class="spinner"></span> Lade...</div>
        <div id="modal-pool-status"></div>
        <button class="modal-close" id="modal-close-btn">✕</button>
      </div>
      <div class="modal-body" id="modal-pool-body">
        <div style="text-align:center;padding:2rem"><div class="spinner"></div></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target===overlay) closePoolModal(); });
  document.getElementById('modal-close-btn').addEventListener('click', closePoolModal);

  try {
    const { pool, commitments } = await api.getPool(poolId);
    const isAdmin = Auth.getUser()?.role === 'admin';
    const isErzeuger = Auth.getUser()?.role === 'erzeuger';

    let lieferungen = [];
    try {
      const lr = await fetch(`/api/lieferungen?pool_id=${poolId}`, { headers:{'Authorization':'Bearer '+Auth.getToken()} });
      if (lr.ok) { const d = await lr.json(); lieferungen = d.lieferungen||[]; }
    } catch {}

    let auszahlungen = [];
    if (isAdmin) {
      try {
        const ar = await fetch(`/api/auszahlungen?limit=200`, { headers:{'Authorization':'Bearer '+Auth.getToken()} });
        if (ar.ok) {
          const d = await ar.json();
          const ids = new Set(commitments.map(c => c.id));
          auszahlungen = (d.auszahlungen||[]).filter(a => ids.has(a.commitment_id));
        }
      } catch {}
    }

    const pct         = poolPct(pool.menge_committed, pool.menge_ziel);
    const wertGesamt  = parseFloat(pool.menge_committed) * parseFloat(pool.preis_pro_einheit);
    const totalMenge  = commitments.reduce((s,c) => s + parseFloat(c.menge||0), 0);

    document.getElementById('modal-pool-title').textContent = pool.produkt;
    document.getElementById('modal-pool-status').innerHTML  = statusBadge(pool.status);

    document.getElementById('modal-pool-body').innerHTML = `
      <div class="modal-grid">
        <div class="modal-stat"><div class="modal-stat-label">Region</div><div class="modal-stat-val">${pool.region}</div></div>
        <div class="modal-stat"><div class="modal-stat-label">Lieferwoche</div><div class="modal-stat-val">${pool.lieferwoche}</div></div>
        <div class="modal-stat"><div class="modal-stat-label">Preis</div><div class="modal-stat-val">${fmt(pool.preis_pro_einheit)} €/kg</div></div>
        <div class="modal-stat"><div class="modal-stat-label">Deadline</div><div class="modal-stat-val" style="font-size:14px">${new Date(pool.deadline).toLocaleDateString('de-DE')}</div></div>
        <div class="modal-stat"><div class="modal-stat-label">Warenwert</div><div class="modal-stat-val green">${fmt(wertGesamt)} €</div></div>
        <div class="modal-stat"><div class="modal-stat-label">Erzeuger:innen</div><div class="modal-stat-val">${commitments.length}</div></div>
      </div>

      <div style="margin-bottom:1.25rem">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);font-family:'DM Mono',monospace;margin-bottom:6px">
          <span>${Math.round(pool.menge_committed)} kg von ${Math.round(pool.menge_ziel)} kg</span>
          <span style="font-weight:600;color:${pct>=100?'var(--green)':pct>=50?'var(--amber)':'var(--red)'}">${pct}%</span>
        </div>
        <div class="pool-detail-bar">
          <div class="pool-detail-bar-fill" style="width:${pct}%;background:${pct>=100?'var(--green)':pct>=50?'var(--amber)':'var(--red)'}"></div>
        </div>
      </div>

      <div class="modal-tabs">
        <button class="modal-tab active" data-tab="commitments">Erzeuger:innen (${commitments.length})</button>
        <button class="modal-tab" data-tab="lieferungen">Lieferungen (${lieferungen.length})</button>
        ${isAdmin ? `<button class="modal-tab" data-tab="auszahlungen">Auszahlungen (${auszahlungen.length})</button>` : ''}
      </div>

      <div class="modal-tab-content active" id="tab-commitments">
        ${commitments.length ? `
          <table class="tbl">
            <thead><tr>
              <th>Betrieb</th><th>Region</th><th>Menge</th><th>Anteil</th>
              ${isAdmin||!isErzeuger ? '<th>Erw. Erlös</th>' : ''}
              <th>Status</th>
            </tr></thead>
            <tbody>
              ${commitments.map(c => {
                const anteil = totalMenge>0 ? (parseFloat(c.menge)/totalMenge*100).toFixed(1) : 0;
                const erloes = parseFloat(c.menge)*parseFloat(pool.preis_pro_einheit)*0.99;
                return `<tr>
                  <td style="font-weight:500">${isErzeuger && c.betrieb_name !== Auth.getUser()?.name ? c.betrieb_name.split(' ')[0]+'...' : c.betrieb_name||'—'}</td>
                  <td class="pool-meta">${c.region||'—'}</td>
                  <td style="font-family:'DM Mono',monospace">${fmt(c.menge,0)} kg</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <div style="width:60px;height:4px;background:var(--bg3);border-radius:2px;overflow:hidden">
                        <div style="width:${anteil}%;height:100%;background:var(--green);border-radius:2px"></div>
                      </div>
                      <span class="pool-meta">${anteil}%</span>
                    </div>
                  </td>
                  ${isAdmin||!isErzeuger ? `<td style="font-family:'DM Mono',monospace;color:var(--green)">${fmt(erloes)} €</td>` : ''}
                  <td>${statusBadge(c.status)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
          <div style="margin-top:.75rem;padding:.75rem 1rem;background:var(--bg);border-radius:6px;display:flex;justify-content:space-between;font-size:13px">
            <span style="color:var(--text2)">Gesamtwert (brutto)</span>
            <span style="font-weight:600;font-family:'DM Mono',monospace">${fmt(wertGesamt)} €</span>
          </div>
        ` : '<p style="color:var(--text3);font-size:13px">Noch keine Zusagen</p>'}
      </div>

      <div class="modal-tab-content" id="tab-lieferungen">
        ${lieferungen.length ? `
          <table class="tbl">
            <thead><tr><th>Nr.</th><th>QR</th><th>Bestellt</th><th>Geliefert</th><th>Qualität</th><th>Status</th></tr></thead>
            <tbody>
              ${lieferungen.map(l=>`<tr>
                <td class="pool-meta">${l.lieferschein_nr}</td>
                <td><span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--green)">${l.qr_code}</span></td>
                <td class="pool-meta">${fmt(l.menge_bestellt,0)} kg</td>
                <td style="font-weight:500">${l.menge_geliefert?fmt(l.menge_geliefert,0)+' kg':'—'}</td>
                <td>${l.qualitaet?statusBadge(l.qualitaet):'—'}</td>
                <td>${statusBadge(l.status)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        ` : '<p style="color:var(--text3);font-size:13px">Noch keine Lieferungen</p>'}
      </div>

      ${isAdmin ? `
      <div class="modal-tab-content" id="tab-auszahlungen">
        ${auszahlungen.length ? `
          <table class="tbl">
            <thead><tr><th>Betrieb</th><th>Brutto</th><th>Netto</th><th>Status</th></tr></thead>
            <tbody>
              ${auszahlungen.map(a=>`<tr>
                <td style="font-weight:500">${a.betrieb_name||'—'}</td>
                <td class="pool-meta">${fmt(a.brutto)} €</td>
                <td style="font-family:'DM Mono',monospace;color:var(--green);font-weight:500">${fmt(a.netto)} €</td>
                <td>${statusBadge(a.status)}</td>
              </tr>`).join('')}
              <tr style="background:var(--bg)">
                <td style="font-weight:600">Gesamt</td>
                <td style="font-weight:600;font-family:'DM Mono',monospace">${fmt(auszahlungen.reduce((s,a)=>s+parseFloat(a.brutto),0))} €</td>
                <td style="font-weight:600;font-family:'DM Mono',monospace;color:var(--green)">${fmt(auszahlungen.reduce((s,a)=>s+parseFloat(a.netto),0))} €</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        ` : '<p style="color:var(--text3);font-size:13px">Noch keine Auszahlungen</p>'}
      </div>` : ''}

      ${isAdmin ? `
      <div class="modal-actions">
        ${pool.status==='geschlossen'?`<button class="btn btn-primary" id="modal-btn-lieferschein">+ Lieferschein</button>`:''}
        ${pool.status==='offen'?`<button class="btn" id="modal-btn-close">Pool schließen</button>`:''}
        ${['offen','geschlossen'].includes(pool.status)?`<button class="btn btn-danger" id="modal-btn-abort">Abbrechen</button>`:''}
        <button class="btn btn-sm" onclick="closePoolModal()">Schließen</button>
      </div>` : ''}
    `;

    // Tab-Switching
    document.querySelectorAll('.modal-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-'+btn.dataset.tab)?.classList.add('active');
      });
    });

    // Admin-Aktionen
    document.getElementById('modal-btn-lieferschein')?.addEventListener('click', async e => {
      const btn = e.target; btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
      try {
        const { lieferung } = await api.createLieferung(pool.id, null);
        toast(`Lieferschein ${lieferung.lieferschein_nr} · QR: ${lieferung.qr_code}`);
        closePoolModal();
      } catch (err) { btn.textContent='+Lieferschein'; btn.disabled=false; toast(err.message,'error'); }
    });
    document.getElementById('modal-btn-close')?.addEventListener('click', async () => {
      if (!confirm('Pool manuell schließen?')) return;
      try { await api.updatePoolStatus(pool.id,'geschlossen'); toast('Pool geschlossen'); closePoolModal(); }
      catch (err) { toast(err.message,'error'); }
    });
    document.getElementById('modal-btn-abort')?.addEventListener('click', async () => {
      if (!confirm('Pool wirklich abbrechen? Alle Commitments werden zurückgezogen.')) return;
      try { await api.updatePoolStatus(pool.id,'abgebrochen'); toast('Pool abgebrochen','error'); closePoolModal(); }
      catch (err) { toast(err.message,'error'); }
    });

  } catch (err) {
    document.getElementById('modal-pool-body').innerHTML = `<div class="alert alert-error">${err.message}</div>`;
  }
}

function closePoolModal() {
  document.getElementById('pool-modal-overlay')?.remove();
}

// Globale Pool-Click Delegation (für data-pool-id Elemente)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-pool-id]');
  if (el && e.target.tagName!=='BUTTON' && !e.target.closest('button')) {
    const id = el.dataset.poolId;
    if (id) showPoolDetail(id);
  }
});
