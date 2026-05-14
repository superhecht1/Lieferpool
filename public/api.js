/**
 * api.js – Core + Hub + Flow Module
 */

const API_BASE = '/api';

const Auth = {
  getToken:   () => localStorage.getItem('lp_token'),
  setToken:   (t) => localStorage.setItem('lp_token', t),
  getUser:    () => JSON.parse(localStorage.getItem('lp_user') || 'null'),
  setUser:    (u) => localStorage.setItem('lp_user', JSON.stringify(u)),
  clear:      () => { localStorage.removeItem('lp_token'); localStorage.removeItem('lp_user'); },
  isLoggedIn: () => !!localStorage.getItem('lp_token'),
};

async function req(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = Auth.getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(API_BASE + path, {
    method, headers,
    body: body ? JSON.stringify(body) : null,
  });

  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { Auth.clear(); window.location.href = '/login'; return; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const get  = (path)       => req('GET',    path);
const post = (path, body) => req('POST',   path, body);
const put  = (path, body) => req('PUT',    path, body);
const del  = (path)       => req('DELETE', path);

const api = {
  // ── AUTH ──────────────────────────────────────────────────────
  login:    (email, password)             => post('/auth/login',    { email, password }),
  register: (email, password, role, name) => post('/auth/register', { email, password, role, name }),

  // ── POOLS ─────────────────────────────────────────────────────
  getPools:       (p = {})      => { const q = new URLSearchParams(p).toString(); return get('/pools' + (q ? '?' + q : '')); },
  getPool:        (id)          => get('/pools/' + id),
  createPool:     (data)        => post('/pools', data),
  commitQuantity: (id, menge)   => post('/pools/' + id + '/commit', { menge }),

  // ── ERZEUGER ──────────────────────────────────────────────────
  getErzeugerMe:         ()              => get('/erzeuger/me'),
  updateErzeuger:        (data)          => put('/erzeuger/me', data),
  addZertifikat:         (data)          => post('/erzeuger/zertifikate', data),
  getAuszahlungen:       ()              => get('/erzeuger/auszahlungen'),
  getAllErzeuger:         ()              => get('/erzeuger'),
  getPendingZertifikate: ()              => get('/erzeuger/zertifikate/pending'),
  setZertifikatStatus:   (id, status)    => put('/erzeuger/zertifikate/' + id + '/status', { status }),

  // ── LIEFERUNGEN ───────────────────────────────────────────────
  createLieferung:     (pool_id, lieferdatum)                  => post('/lieferungen', { pool_id, lieferdatum }),
  scanQR:              (qr)                                     => get('/lieferungen/scan/' + qr),
  confirmWareneingang: (id, menge_geliefert, qualitaet, notiz) => post('/lieferungen/' + id + '/wareneingang', { menge_geliefert, qualitaet, notiz }),

  // ── HUB: LAGER ────────────────────────────────────────────────
  getLager:           (p = {})   => { const q = new URLSearchParams(p).toString(); return get('/lager' + (q ? '?' + q : '')); },
  getLagerAlerts:     ()         => get('/lager/alerts'),
  getLagerBewegungen: (p = {})   => { const q = new URLSearchParams(p).toString(); return get('/lager/bewegungen' + (q ? '?' + q : '')); },
  lagerEingang:       (data)     => post('/lager/eingang', data),
  lagerAusgang:       (data)     => post('/lager/ausgang', data),
  lagerKorrektur:     (data)     => post('/lager/korrektur', data),
  setMindestbestand:  (id, m)    => put('/lager/' + id + '/mindestbestand', { mindestbestand: m }),

  // ── HUB: BEDARF ───────────────────────────────────────────────
  getBedarfPrognosen:   ()       => get('/bedarf'),
  getBedarfAggregiert:  ()       => get('/bedarf/aggregiert'),
  createBedarfPrognose: (data)   => post('/bedarf', data),
  updateBedarfPrognose: (id, d)  => put('/bedarf/' + id, d),
  deleteBedarfPrognose: (id)     => del('/bedarf/' + id),

  // ── FLOW: FAHRZEUGE ───────────────────────────────────────────
  getFahrzeuge:    ()             => get('/fahrzeuge'),
  createFahrzeug:  (data)         => post('/fahrzeuge', data),
  updateFahrzeug:  (id, data)     => put('/fahrzeuge/' + id, data),
  deleteFahrzeug:  (id)           => del('/fahrzeuge/' + id),

  // ── FLOW: TOUREN ──────────────────────────────────────────────
  getTouren:          (p = {})   => { const q = new URLSearchParams(p).toString(); return get('/touren' + (q ? '?' + q : '')); },
  getTourHeute:       (fahId)    => get('/touren/heute' + (fahId ? '?fahrer_id=' + fahId : '')),
  getTour:            (id)       => get('/touren/' + id),
  createTour:         (data)     => post('/touren', data),
  updateTour:         (id, data) => put('/touren/' + id, data),
  addStopp:           (id, data) => post('/touren/' + id + '/stopps', data),
  deleteStopp:        (tid, sid) => del('/touren/' + tid + '/stopps/' + sid),
  optimiereTour:      (id)       => post('/touren/' + id + '/optimieren', {}),
  startenTour:        (id)       => post('/touren/' + id + '/starten', {}),
  stopAnkommen:       (tid, sid) => post('/touren/' + tid + '/stopps/' + sid + '/ankommen', {}),
  stopAbschliessen:   (tid, sid, data) => post('/touren/' + tid + '/stopps/' + sid + '/abschliessen', data),
  stopUeberspringen:  (tid, sid, notiz) => post('/touren/' + tid + '/stopps/' + sid + '/ueberspringen', { notiz }),
  getFahrerListe:     ()         => get('/touren/fahrer/liste'),
};

window.api  = api;
window.Auth = Auth;
