/**
 * api.js – Zentrale Backend-Kommunikation
 * Frontend und Backend laufen auf demselben Server/Port.
 * API_BASE ist relativ → kein Cross-Origin, kein CORS-Problem.
 */

const API_BASE = '/api';

// ---- Token-Verwaltung ----
const Auth = {
  getToken:  ()  => localStorage.getItem('lp_token'),
  setToken:  (t) => localStorage.setItem('lp_token', t),
  getUser:   ()  => JSON.parse(localStorage.getItem('lp_user') || 'null'),
  setUser:   (u) => localStorage.setItem('lp_user', JSON.stringify(u)),
  clear:     ()  => { localStorage.removeItem('lp_token'); localStorage.removeItem('lp_user'); },
  isLoggedIn:()  => !!localStorage.getItem('lp_token'),
};

// ---- HTTP-Helfer ----
async function req(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = Auth.getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    Auth.clear();
    window.location.href = '/login';
    return;
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const get  = (path)       => req('GET',  path);
const post = (path, body) => req('POST', path, body);
const put  = (path, body) => req('PUT',  path, body);

const api = {
  login:    (email, password)          => post('/auth/login',    { email, password }),
  register: (email, password, role, name) => post('/auth/register', { email, password, role, name }),

  getPools:         (params = {})      => { const q = new URLSearchParams(params).toString(); return get('/pools' + (q ? '?' + q : '')); },
  getPool:          (id)               => get('/pools/' + id),
  createPool:       (data)             => post('/pools', data),
  commitQuantity:   (poolId, menge)    => post('/pools/' + poolId + '/commit', { menge }),

  getErzeugerMe:    ()                 => get('/erzeuger/me'),
  updateErzeuger:   (data)             => put('/erzeuger/me', data),
  addZertifikat:    (data)             => post('/erzeuger/zertifikate', data),
  getAuszahlungen:  ()                 => get('/erzeuger/auszahlungen'),
  getAllErzeuger:    ()                 => get('/erzeuger'),
  getPendingZertifikate: ()            => get('/erzeuger/zertifikate/pending'),
  setZertifikatStatus: (id, status)    => put('/erzeuger/zertifikate/' + id + '/status', { status }),

  createLieferung:     (pool_id, lieferdatum) => post('/lieferungen', { pool_id, lieferdatum }),
  scanQR:              (qr)            => get('/lieferungen/scan/' + qr),
  confirmWareneingang: (id, menge_geliefert, qualitaet, notiz) =>
    post('/lieferungen/' + id + '/wareneingang', { menge_geliefert, qualitaet, notiz }),
};

window.api  = api;
window.Auth = Auth;
