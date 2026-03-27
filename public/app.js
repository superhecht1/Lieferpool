/**
 * app.js – Gemeinsame Hilfsfunktionen für alle Dashboards
 */

// Config – ggf. anpassen

// Auth-Guard: Wenn nicht eingeloggt → Login
function requireAuth(expectedRole) {
  if (!Auth.isLoggedIn()) {
    window.location.href = '/login';
    return false;
  }
  const user = Auth.getUser();
  if (expectedRole && user.role !== expectedRole && user.role !== 'admin') {
    window.location.href = user.role + '.html';
    return false;
  }
  return user;
}

// Header rendern
function renderHeader(activeView, navItems, onNav) {
  const user = Auth.getUser();
  const roleLabels = { erzeuger: 'Erzeuger', caterer: 'Caterer', admin: 'Admin' };

  const hdr = document.getElementById('app-header');
  hdr.innerHTML = `
    <div class="logo">Liefer<span>Pool</span></div>
    <nav class="nav" id="main-nav">
      ${navItems.map(n => `
        <button class="nav-btn ${activeView === n.id ? 'active' : ''}"
                data-view="${n.id}">${n.label}</button>
      `).join('')}
    </nav>
    <div class="hdr-right">
      <span class="role-badge">${roleLabels[user?.role] || ''}</span>
      <span style="font-size:12px;color:var(--text2)">${user?.name || ''}</span>
      <button class="btn-logout" id="btn-logout">Abmelden</button>
    </div>
  `;

  document.getElementById('main-nav').addEventListener('click', e => {
    const btn = e.target.closest('[data-view]');
    if (btn) onNav(btn.dataset.view);
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    Auth.clear();
    window.location.href = '/login';
  });
}

// View switcher
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  const el = document.getElementById('view-' + id);
  if (el) el.style.display = 'block';

  // Nav aktiv setzen
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === id);
  });
}

// Formatierung
function fmt(n, decimals = 2) {
  return parseFloat(n || 0).toFixed(decimals).replace('.', ',');
}

function fmtEur(eurCent) {
  return (parseInt(eurCent || 0) / 100).toFixed(2).replace('.', ',') + ' €';
}

function fmtKg(gramm) {
  return (parseInt(gramm || 0) / 1000).toFixed(0) + ' kg';
}

function poolPct(committed, ziel) {
  return Math.min(100, Math.round((committed / ziel) * 100));
}

function poolBarClass(pct) {
  return pct >= 100 ? '' : pct >= 50 ? '' : 'warn';
}

function statusBadge(status) {
  const map = {
    offen:        ['badge-amber', 'offen'],
    geschlossen:  ['badge-green', 'geschlossen'],
    geliefert:    ['badge-green', 'geliefert'],
    abgebrochen:  ['badge-red',   'abgebrochen'],
    aktiv:        ['badge-green', 'aktiv'],
    pending:      ['badge-amber', 'ausstehend'],
    verified:     ['badge-green', 'verifiziert'],
    rejected:     ['badge-red',   'abgelehnt'],
    veranlasst:   ['badge-amber', 'veranlasst'],
    ausgezahlt:   ['badge-green', 'ausgezahlt'],
    fehlgeschlagen:['badge-red',  'fehlgeschlagen'],
    ausstehend:   ['badge-gray',  'ausstehend'],
  };
  const [cls, label] = map[status] || ['badge-gray', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function poolBar(committed, ziel) {
  const pct = poolPct(committed, ziel);
  const cls = pct < 40 ? 'low' : pct < 80 ? 'warn' : '';
  return `
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2);font-family:'DM Mono',monospace;margin-top:6px">
      <span>${Math.round(committed)} / ${Math.round(ziel)} kg</span>
      <span>${pct}%</span>
    </div>
    <div class="progress-wrap">
      <div class="progress-bar ${cls}" style="width:${pct}%"></div>
    </div>
  `;
}

function chainInfo(txHash) {
  if (!txHash) return '';
  const short = txHash.slice(0, 10) + '...' + txHash.slice(-6);
  return `<div class="chain-info"><div class="chain-dot"></div>${short}</div>`;
}

function showAlert(containerId, type, msg) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

// Toast-ähnliche Meldung oben rechts
function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `alert alert-${type}`;
  t.style.cssText = 'position:fixed;top:64px;right:1rem;z-index:999;min-width:260px;animation:fadeIn .2s';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
