const API_BASE = '/api';
const TIMEOUT_MS = 30000; // 30 Sekunden globaler Timeout

const Auth = {
  getToken:      () => localStorage.getItem('lp_token'),
  setToken:      (t) => localStorage.setItem('lp_token', t),
  getUser:       () => JSON.parse(localStorage.getItem('lp_user') || 'null'),
  setUser:       (u) => localStorage.setItem('lp_user', JSON.stringify(u)),
  getRefresh:    () => localStorage.getItem('lp_refresh'),
  setRefresh:    (t) => localStorage.setItem('lp_refresh', t),
  clear:         () => {
    localStorage.removeItem('lp_token');
    localStorage.removeItem('lp_user');
    localStorage.removeItem('lp_refresh');
  },
  isLoggedIn: () => !!localStorage.getItem('lp_token'),
};

// Globales Timeout via AbortController
function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

let isRefreshing  = false;
let refreshWaiters = [];

async function refreshAccessToken() {
  const refreshToken = Auth.getRefresh();
  if (!refreshToken) throw new Error('Kein Refresh-Token');
  const res  = await fetchWithTimeout(API_BASE + '/auth/refresh', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ refreshToken }),
  });
  if (!res.ok) throw new Error('Refresh fehlgeschlagen');
  const data = await res.json();
  Auth.setToken(data.token);
  Auth.setRefresh(data.refreshToken);
  return data.token;
}

async function req(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token   = Auth.getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let res;
  try {
    res = await fetchWithTimeout(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Zeitüberschreitung – Server antwortet nicht (>30s)');
    }
    throw err;
  }

  // 401 → Token abgelaufen → Auto-Refresh
  if (res.status === 401 && Auth.getRefresh() && !path.includes('/auth/refresh')) {
    if (isRefreshing) {
      // Warten bis Refresh fertig
      return new Promise((resolve, reject) => {
        refreshWaiters.push({ resolve, reject, method, path, body });
      });
    }
    isRefreshing = true;
    try {
      await refreshAccessToken();
      isRefreshing = false;
      // Wartende Requests wiederholen
      const waiters = refreshWaiters.splice(0);
      waiters.forEach(w => req(w.method, w.path, w.body).then(w.resolve).catch(w.reject));
      // Eigenen Request wiederholen
      return req(method, path, body);
    } catch {
      isRefreshing = false;
      Auth.clear();
      window.location.href = '/login';
      return;
    }
  }

  // 429 → Rate-Limit
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After');
    const msg = retryAfter
      ? `Zu viele Anfragen – bitte ${retryAfter}s warten`
      : 'Zu viele Anfragen – kurz warten und nochmal versuchen';
    showRateLimitBanner(msg);
    throw new Error(msg);
  }

  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { Auth.clear(); window.location.href = '/login'; return; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Rate-Limit Banner (temporär einblenden)
function showRateLimitBanner(msg) {
  let banner = document.getElementById('rate-limit-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'rate-limit-banner';
    banner.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:9999;
      background:#b5780a;color:#fff;padding:.75rem 1.25rem;
      font-size:13px;font-weight:500;text-align:center;
      box-shadow:0 2px 8px rgba(0,0,0,.2);
    `;
    document.body.prepend(banner);
  }
  banner.textContent = '⚠ ' + msg;
  clearTimeout(banner._timeout);
  banner._timeout = setTimeout(() => banner.remove(), 8000);
}

const get  = (path)       => req('GET',    path);
const post = (path, body) => req('POST',   path, body);
const put  = (path, body) => req('PUT',    path, body);
const del  = (path)       => req('DELETE', path);

const api = {
  // AUTH
  login:           (email, password)              => post('/auth/login',    { email, password }),
  register:        (email, password, role, name)  => post('/auth/register', { email, password, role, name }),
  setup:           (email, password, name)        => post('/auth/setup',    { email, password, name }),
  logout:          (refreshToken)                 => post('/auth/logout',   { refreshToken }),
  changePassword:  (current_password, new_password) => post('/auth/change-password', { current_password, new_password }),
  fixZertifikate:  ()                             => post('/auth/fix-zertifikate', {}),
  getVapidKey:     ()                             => get('/auth/vapid-public-key'),
  pushSubscribe:   (sub)                          => post('/auth/push-subscribe', sub),
  pushUnsubscribe: (endpoint)                     => del('/auth/push-subscribe'),
  createFahrer:    (data)                         => post('/auth/admin/create-fahrer', data),
  getFahrerList:   ()                             => get('/auth/fahrer-list'),

  // POOLS
  getPools:       (p = {})     => { const q = new URLSearchParams(p).toString(); return get('/pools' + (q ? '?' + q : '')); },
  getPool:        (id)         => get('/pools/' + id),
  createPool:     (data)       => post('/pools', data),
  updatePoolStatus:(id, status, grund) => put('/pools/' + id + '/status', { status, grund }),
  commitQuantity: (id, menge)  => post('/pools/' + id + '/commit', { menge }),
  withdrawCommit: (id)         => del('/pools/' + id + '/commit'),
  updateCommit:   (id, menge)  => req('PUT', '/pools/' + id + '/commit', { menge }),

  // ERZEUGER
  getErzeugerMe:         ()           => get('/erzeuger/me'),
  updateErzeuger:        (data)       => put('/erzeuger/me', data),
  addZertifikat:         (data)       => post('/erzeuger/zertifikate', data),
  getAuszahlungen:       ()           => get('/erzeuger/auszahlungen'),
  getAllErzeuger:         ()           => get('/erzeuger'),
  getPendingZertifikate: ()           => get('/erzeuger/zertifikate/pending'),
  setZertifikatStatus:   (id, status) => put('/erzeuger/zertifikate/' + id + '/status', { status }),

  // LIEFERUNGEN
  createLieferung:     (pool_id, lieferdatum)                     => post('/lieferungen', { pool_id, lieferdatum }),
  scanQR:              (qr)                                        => get('/lieferungen/scan/' + qr),
  confirmWareneingang: (id, menge_geliefert, qualitaet, notiz)    => post('/lieferungen/' + id + '/wareneingang', { menge_geliefert, qualitaet, notiz }),

  // LAGER
  getLager:           (p = {})  => { const q = new URLSearchParams(p).toString(); return get('/lager' + (q ? '?' + q : '')); },
  getLagerAlerts:     ()        => get('/lager/alerts'),
  getLagerBewegungen: (p = {})  => { const q = new URLSearchParams(p).toString(); return get('/lager/bewegungen' + (q ? '?' + q : '')); },
  lagerEingang:       (data)    => post('/lager/eingang', data),
  lagerAusgang:       (data)    => post('/lager/ausgang', data),
  lagerKorrektur:     (data)    => post('/lager/korrektur', data),
  setMindestbestand:  (id, m)   => put('/lager/' + id + '/mindestbestand', { mindestbestand: m }),

  // BEDARF
  getBedarfPrognosen:   ()      => get('/bedarf'),
  getBedarfAggregiert:  ()      => get('/bedarf/aggregiert'),
  createBedarfPrognose: (data)  => post('/bedarf', data),
  updateBedarfPrognose: (id, d) => put('/bedarf/' + id, d),
  deleteBedarfPrognose: (id)    => del('/bedarf/' + id),

  // FAHRZEUGE
  getFahrzeuge:   ()         => get('/fahrzeuge'),
  createFahrzeug: (data)     => post('/fahrzeuge', data),
  updateFahrzeug: (id, data) => put('/fahrzeuge/' + id, data),
  deleteFahrzeug: (id)       => del('/fahrzeuge/' + id),

  // TOUREN
  getTouren:        (p = {})   => { const q = new URLSearchParams(p).toString(); return get('/touren' + (q ? '?' + q : '')); },
  getTourHeute:     (fId)      => get('/touren/heute' + (fId ? '?fahrer_id=' + fId : '')),
  getTour:          (id)       => get('/touren/' + id),
  createTour:       (data)     => post('/touren', data),
  updateTour:       (id, data) => put('/touren/' + id, data),
  addStopp:         (id, data) => post('/touren/' + id + '/stopps', data),
  deleteStopp:      (tid, sid) => del('/touren/' + tid + '/stopps/' + sid),
  optimiereTour:    (id)       => post('/touren/' + id + '/optimieren', {}),
  startenTour:      (id)       => post('/touren/' + id + '/starten', {}),
  stopAnkommen:     (tid, sid) => post('/touren/' + tid + '/stopps/' + sid + '/ankommen', {}),
  stopAbschliessen: (tid, sid, data) => post('/touren/' + tid + '/stopps/' + sid + '/abschliessen', data),
  stopUeberspringen:(tid, sid, notiz) => post('/touren/' + tid + '/stopps/' + sid + '/ueberspringen', { notiz }),
  getFahrerListe:   ()         => get('/touren/fahrer/liste'),

  // AUSZAHLUNGEN
  getAllAuszahlungen:   (p = {}) => { const q = new URLSearchParams(p).toString(); return get('/auszahlungen' + (q ? '?' + q : '')); },
  setAuszahlungStatus: (id, status) => put('/auszahlungen/' + id + '/status', { status }),
  bulkVeranlassen:     ()       => post('/auszahlungen/bulk-veranlassen', {}),
  bulkAusgezahlt:      ()       => post('/auszahlungen/bulk-ausgezahlt', {}),

  // REPORTS
  reportsDashboard:        ()      => get('/reports/dashboard'),
  downloadAuszahlungenCSV: (p={}) => { const q=new URLSearchParams(p).toString(); window.open(API_BASE+'/reports/auszahlungen.csv'+(q?'?'+q:''),'_blank'); },
  downloadPoolsCSV:        ()      => window.open(API_BASE+'/reports/pools.csv','_blank'),
  downloadLieferungenCSV:  ()      => window.open(API_BASE+'/reports/lieferungen.csv','_blank'),
  openAbrechnung:          (id, params={}) => { const q=new URLSearchParams(params).toString(); window.open(API_BASE+'/reports/abrechnung/'+id+(q?'?'+q:''),'_blank'); },
};

window.api  = api;
window.Auth = Auth;
