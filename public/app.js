/**
 * app.js – Gemeinsame Hilfsfunktionen + Pool-Detail Modal
 */

// ── Modal CSS (einmalig injizieren) ───────────────────────────
(function injectModalCSS() {
  const style = document.createElement('style');
  style.textContent = `
    .modal-overlay {
      position:fixed; inset:0; background:rgba(0,0,0,.45);
      z-index:500; display:flex; align-items:flex-start; justify-content:center;
      padding:2rem 1rem; overflow-y:auto;
      animation: fadeIn .15s ease;
    }
    .modal {
      background:#fff; border-radius:12px; width:100%; max-width:780px;
      box-shadow:0 20px 60px rgba(0,0,0,.2); position:relative;
      animation: slideUp .2s ease;
    }
    .modal-head {
      padding:1.25rem 1.5rem; border-bottom:1px solid var(--border);
      display:flex; align-items:center; gap:1rem;
    }
    .modal-title {
      font-weight:600; font-size:16px; flex:1; color:var(--text);
    }
    .modal-close {
      width:28px; height:28px; border-radius:50%;
      background:var(--bg3); border:none; cursor:pointer;
      display:flex; align-items:center; justify-content:center;
      font-size:14px; color:var(--text2); transition:all .15s; flex-shrink:0;
    }
    .modal-close:hover { background:var(--border); color:var(--text); }
    .modal-body { padding:1.5rem; }
    .modal-tabs {
      display:flex; gap:0; border-bottom:1px solid var(--border); margin-bottom:1.25rem;
    }
    .modal-tab {
      padding:.6rem 1.1rem; font-size:12px; font-weight:500;
      cursor:pointer; border:none; background:none;
      color:var(--text3); border-bottom:2px solid transparent;
      transition:all .15s; font-family:'DM Sans',sans-serif;
    }
    .modal-tab:hover { color:var(--text2); }
    .modal-tab.active { color:var(--green); border-bottom-color:var(--green); }
    .modal-tab-content { display:none; }
    .modal-tab-content.active { display:block; }
    .modal-grid {
      display:grid; grid-template-columns:repeat(3,1fr); gap:1rem; margin-bottom:1.25rem;
    }
    @media(max-width:560px){ .modal-grid { grid-template-columns:1fr 1fr; } }
    .modal-stat {
      background:var(--bg); border-radius:6px; padding:.875rem 1rem;
      border:1px solid var(--border);
    }
    .modal-stat-label {
      font-size:10px; letter-spacing:.06em; text-transform:uppercase;
      color:var(--text3); margin-bottom:.25rem; font-family:'DM Mono',monospace;
    }
    .modal-stat-val { font-size:18px; font-weight:300; color:var(--text); }
    .modal-stat-val.green { color:var(--green); }
    .modal-stat-val.amber { color:var(--amber); }
    .modal-actions {
      display:flex; gap:.75rem; flex-wrap:wrap;
      padding-top:1.25rem; border-top:1px solid var(--border); margin-top:1.25rem;
    }
    .pool-detail-bar {
      height:8px; background:var(--bg3); border-radius:4px; overflow:hidden;
      margin:.5rem 0;
    }
    .pool-detail-bar-fill {
      height:100%; border-radius:4px; background:var(--green);
      transition:width .5s ease;
    }
    @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
    @keyframes slideUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:none} }
  `;
  document.head.appendChild(style);
})();

// ── Auth-Guard ─────────────────────────────────────────────────
function requireAuth(expectedRole) {
  if (!Auth.isLoggedIn()) { window.location.href = '/login'; return false; }
  const user = Auth.getUser();
  if (expectedRole && user.role !== expectedRole && user.role !== 'admin') {
    window.location.href = user.role + '.html';
    return false;
  }
  return user;
}

// ── Header ─────────────────────────────────────────────────────
function renderHeader(activeView, navItems, onNav) {
  const user = Auth.getUser();
  const roleLabels = { erzeuger:'Erzeuger', caterer:'Caterer', admin:'Admin', fahrer:'Fahrer' };
  const hdr = document.getElementById('app-header');
  hdr.innerHTML = `
    <div class="logo">Liefer<span>Pool</span></div>
    <nav class="nav" id="main-nav">
      ${navItems.map(n => `
        <button class="nav-btn ${activeView === n.id ? 'active' : ''}" data-view="${n.id}">${n.label}</button>
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
    Auth.clear(); window.location.href = '/login';
  });
}

// ── View Switcher ──────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  const el = document.getElementById('view-' + id);
  if (el) el.style.display = 'block';
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === id);
  });
}

// ── Formatierung ───────────────────────────────────────────────
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
function statusBadge(status) {
  const map = {
    offen:         ['badge-amber', 'offen'],
    geschlossen:   ['badge-green', 'geschlossen'],
    geliefert:     ['badge-green', 'geliefert'],
    abgebrochen:   ['badge-red',   'abgebrochen'],
    aktiv:         ['badge-green', 'aktiv'],
    pending:       ['badge-amber', 'ausstehend'],
    verified:      ['badge-green', 'verifiziert'],
    rejected:      ['badge-red',   'abgelehnt'],
    veranlasst:    ['badge-amber', 'veranlasst'],
    ausgezahlt:    ['badge-green', 'ausgezahlt'],
    fehlgeschlagen:['badge-red',   'fehlgeschlagen'],
    ausstehend:    ['badge-gray',  'ausstehend'],
    geplant:       ['badge-gray',  'geplant'],
    eingegangen:   ['badge-green', 'eingegangen'],
    abgelehnt:     ['badge-red',   'abgelehnt'],
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
  const short = txHash.slice(0,10) + '...' + txHash.slice(-6);
  return `<div class="chain-info"><div class="chain-dot"></div>${short}</div>`;
}

// ── Alerts + Toast ─────────────────────────────────────────────
function showAlert(containerId, type, msg) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}
function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `alert alert-${type}`;
  t.style.cssText = 'position:fixed;top:64px;right:1rem;z-index:999;min-width:260px;box-shadow:0 4px 12px rgba(0,0,0,.12)';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── POOL DETAIL MODAL ──────────────────────────────────────────
async function showPoolDetail(poolId) {
  // Overlay erstellen
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

  // Schließen per Click auf Overlay oder X
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closePoolModal();
  });
  document.getElementById('modal-close-btn').addEventListener('click', closePoolModal);

  try {
    const { pool, commitments } = await api.getPool(poolId);

    // Lieferungen für diesen Pool holen
    let lieferungen = [];
    try {
      const lRes = await fetch(`/api/lieferungen?pool_id=${poolId}`, {
        headers: { 'Authorization': 'Bearer ' + Auth.getToken() }
      });
      if (lRes.ok) { const d = await lRes.json(); lieferungen = d.lieferungen || []; }
    } catch(e) {}

    // Auszahlungen nur für Admin laden
    let auszahlungen = [];
    if (Auth.getUser()?.role === 'admin') {
      try {
        const azRes = await fetch(`/api/auszahlungen?limit=200`, {
          headers: { 'Authorization': 'Bearer ' + Auth.getToken() }
        });
        if (azRes.ok) {
          const d = await azRes.json();
          const cmtIds = new Set(commitments.map(c => c.id));
          auszahlungen = (d.auszahlungen || []).filter(a => cmtIds.has(a.commitment_id));
        }
      } catch(e) {}
    }

    const pct = poolPct(pool.menge_committed, pool.menge_ziel);
    const wertGesamt = parseFloat(pool.menge_committed) * parseFloat(pool.preis_pro_einheit);
    const totalCommitted = commitments.reduce((s,c) => s + parseFloat(c.menge || 0), 0);
    const isAdmin = Auth.getUser()?.role === 'admin';

    document.getElementById('modal-pool-title').textContent = pool.produkt;
    document.getElementById('modal-pool-status').innerHTML = statusBadge(pool.status);

    document.getElementById('modal-pool-body').innerHTML = `
      <!-- Kennzahlen -->
      <div class="modal-grid">
        <div class="modal-stat">
          <div class="modal-stat-label">Region</div>
          <div class="modal-stat-val">${pool.region}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Lieferwoche</div>
          <div class="modal-stat-val">${pool.lieferwoche}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Preis</div>
          <div class="modal-stat-val">${fmt(pool.preis_pro_einheit)} €/kg</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Deadline</div>
          <div class="modal-stat-val" style="font-size:14px">${new Date(pool.deadline).toLocaleDateString('de-DE')}</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Warenwert</div>
          <div class="modal-stat-val green">${fmt(wertGesamt)} €</div>
        </div>
        <div class="modal-stat">
          <div class="modal-stat-label">Erzeuger:innen</div>
          <div class="modal-stat-val">${commitments.length}</div>
        </div>
      </div>

      <!-- Füllstand -->
      <div style="margin-bottom:1.25rem">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);font-family:'DM Mono',monospace;margin-bottom:6px">
          <span>${Math.round(pool.menge_committed)} kg von ${Math.round(pool.menge_ziel)} kg</span>
          <span style="font-weight:600;color:${pct>=100?'var(--green)':pct>=50?'var(--amber)':'var(--red)'}">${pct}%</span>
        </div>
        <div class="pool-detail-bar">
          <div class="pool-detail-bar-fill" style="width:${pct}%;background:${pct>=100?'var(--green)':pct>=50?'var(--amber)':'var(--red)'}"></div>
        </div>
      </div>

      <!-- Tabs -->
      <div class="modal-tabs">
        <button class="modal-tab active" data-tab="commitments">Erzeuger:innen (${commitments.length})</button>
        <button class="modal-tab" data-tab="lieferungen">Lieferungen (${lieferungen.length})</button>
        <button class="modal-tab" data-tab="auszahlungen">Auszahlungen (${auszahlungen.length})</button>
      </div>

      <!-- Tab: Commitments -->
      <div class="modal-tab-content active" id="tab-commitments">
        ${commitments.length ? `
          <table class="tbl">
            <thead><tr>
              <th>Betrieb</th><th>Region</th><th>Menge</th><th>Anteil</th>
              <th>Erw. Erlös</th><th>Status</th>
            </tr></thead>
            <tbody>
              ${commitments.map(c => {
                const anteil = totalCommitted > 0 ? (parseFloat(c.menge) / totalCommitted * 100).toFixed(1) : 0;
                const erloes = parseFloat(c.menge) * parseFloat(pool.preis_pro_einheit) * 0.99;
                return `<tr>
                  <td style="font-weight:500">${c.betrieb_name || '—'}</td>
                  <td class="pool-meta">${c.region || '—'}</td>
                  <td style="font-family:'DM Mono',monospace">${fmt(c.menge,0)} kg</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <div style="width:60px;height:4px;background:var(--bg3);border-radius:2px;overflow:hidden">
                        <div style="width:${anteil}%;height:100%;background:var(--green);border-radius:2px"></div>
                      </div>
                      <span class="pool-meta">${anteil}%</span>
                    </div>
                  </td>
                  <td style="font-family:'DM Mono',monospace;color:var(--green)">${fmt(erloes)} €</td>
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

      <!-- Tab: Lieferungen -->
      <div class="modal-tab-content" id="tab-lieferungen">
        ${lieferungen.length ? `
          <table class="tbl">
            <thead><tr><th>Nr.</th><th>QR-Code</th><th>Bestellt</th><th>Geliefert</th><th>Qualität</th><th>Status</th><th>Datum</th></tr></thead>
            <tbody>
              ${lieferungen.map(l => `<tr>
                <td class="pool-meta">${l.lieferschein_nr}</td>
                <td><span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--green)">${l.qr_code}</span></td>
                <td class="pool-meta">${fmt(l.menge_bestellt,0)} kg</td>
                <td style="font-weight:500">${l.menge_geliefert ? fmt(l.menge_geliefert,0)+' kg' : '—'}</td>
                <td>${l.qualitaet ? statusBadge(l.qualitaet) : '—'}</td>
                <td>${statusBadge(l.status)}</td>
                <td class="pool-meta">${l.wareneingang_at ? new Date(l.wareneingang_at).toLocaleDateString('de-DE') : '—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        ` : '<p style="color:var(--text3);font-size:13px">Noch keine Lieferungen</p>'}
      </div>

      <!-- Tab: Auszahlungen -->
      <div class="modal-tab-content" id="tab-auszahlungen">
        ${auszahlungen.length ? `
          <table class="tbl">
            <thead><tr><th>Betrieb</th><th>Brutto</th><th>Abzüge</th><th>Netto</th><th>Status</th></tr></thead>
            <tbody>
              ${auszahlungen.map(a => `<tr>
                <td style="font-weight:500">${a.betrieb_name || '—'}</td>
                <td class="pool-meta">${fmt(a.brutto)} €</td>
                <td class="pool-meta" style="color:var(--red)">−${fmt(parseFloat(a.abzug_qualitaet||0)+parseFloat(a.platform_fee||0))} €</td>
                <td style="font-family:'DM Mono',monospace;font-weight:500;color:var(--green)">${fmt(a.netto)} €</td>
                <td>${statusBadge(a.status)}</td>
              </tr>`).join('')}
              <tr style="background:var(--bg)">
                <td style="font-weight:600">Gesamt</td>
                <td style="font-weight:600;font-family:'DM Mono',monospace">${fmt(auszahlungen.reduce((s,a)=>s+parseFloat(a.brutto),0))} €</td>
                <td></td>
                <td style="font-weight:600;font-family:'DM Mono',monospace;color:var(--green)">${fmt(auszahlungen.reduce((s,a)=>s+parseFloat(a.netto),0))} €</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        ` : '<p style="color:var(--text3);font-size:13px">Noch keine Auszahlungen</p>'}
      </div>

      <!-- Aktionen -->
      ${isAdmin ? `
        <div class="modal-actions">
          ${pool.status === 'geschlossen' ? `
            <button class="btn btn-primary" id="modal-btn-lieferschein" data-pool-id="${pool.id}">
              + Lieferschein erstellen
            </button>
          ` : ''}
          <button class="btn btn-sm" onclick="closePoolModal()">Schließen</button>
        </div>
      ` : ''}
    `;

    // Tab-Switching
    document.querySelectorAll('.modal-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const content = document.getElementById('tab-' + btn.dataset.tab);
        if (content) content.classList.add('active');
      });
    });

    // Lieferschein Button
    document.getElementById('modal-btn-lieferschein')?.addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
      try {
        const { lieferung } = await api.createLieferung(pool.id, null);
        toast(`Lieferschein ${lieferung.lieferschein_nr} erstellt · QR: ${lieferung.qr_code}`);
        closePoolModal();
      } catch (err) {
        btn.textContent = '+ Lieferschein erstellen'; btn.disabled = false;
        toast(err.message, 'error');
      }
    });

  } catch (err) {
    document.getElementById('modal-pool-body').innerHTML =
      `<div class="alert alert-error">${err.message}</div>`;
  }
}

function closePoolModal() {
  const overlay = document.getElementById('pool-modal-overlay');
  if (overlay) overlay.remove();
}

// Pool-Klick überall verfügbar machen
// Delegation: data-pool-id auf jedem klickbaren Pool-Element
document.addEventListener('click', e => {
  const el = e.target.closest('[data-pool-id]');
  // Nur wenn kein Button-Kind geklickt wurde
  if (el && e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
    const id = el.dataset.poolId;
    if (id) showPoolDetail(id);
  }
});
