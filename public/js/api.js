// Transport layer. Two secrets live here and nowhere else:
//   bootKey   - taken from the launch URL, proves this page was opened by the
//               operator and not by another program or website on the machine
//   sessionId - opaque handle to the server-side credential vault
// The database password is posted once and never stored client-side.

import { toast } from './util.js';

const KEY_STORAGE = 'csmig.bootKey';
const SESSION_STORAGE = 'csmig.sessionId';

function readBootKey() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  if (fromUrl) {
    sessionStorage.setItem(KEY_STORAGE, fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem(KEY_STORAGE) || '';
}

export const state = {
  bootKey: readBootKey(),
  sessionId: sessionStorage.getItem(SESSION_STORAGE) || '',
  session: null,
  meta: null,
  facets: null,
  target: { charset: 'utf8mb3', collation: 'utf8mb3_general_ci' },
};

export function setSession(view) {
  state.session = view;
  state.sessionId = view ? view.sessionId : '';
  if (view) {
    sessionStorage.setItem(SESSION_STORAGE, view.sessionId);
    if (view.target) state.target = view.target;
  } else {
    sessionStorage.removeItem(SESSION_STORAGE);
  }
}

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload || {};
  }
}

async function request(method, path, { body, query, raw } = {}) {
  const url = new URL(path, location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) { if (v.length) url.searchParams.set(k, v.join(',')); }
      else url.searchParams.set(k, String(v));
    }
  }
  const headers = { 'X-App-Key': state.bootKey };
  if (state.sessionId) headers['X-Session-Id'] = state.sessionId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    mode: 'same-origin',
  });

  if (raw) {
    if (!res.ok) throw new ApiError(await res.text(), res.status);
    return res.text();
  }

  const text = await res.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text }; }

  if (!res.ok) {
    if (res.status === 401 && payload.needConnect) {
      setSession(null);
      window.dispatchEvent(new CustomEvent('csmig:session-lost'));
    }
    throw new ApiError(payload.error || `HTTP ${res.status}`, res.status, payload);
  }
  return payload;
}

export const api = {
  meta: () => request('GET', '/api/meta'),
  connect: (creds) => request('POST', '/api/connect', { body: creds }),
  session: () => request('GET', '/api/session'),
  disconnect: () => request('POST', '/api/disconnect', { body: {} }),

  schemas: () => request('GET', '/api/schemas'),
  facets: () => request('GET', '/api/facets'),
  summary: (query) => request('GET', '/api/summary', { query }),
  inventory: (query) => request('GET', '/api/inventory', { query }),
  inventoryCsvUrl: (query) => {
    const url = new URL('/api/inventory.csv', location.origin);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return url;
  },
  // The CSV/script endpoints need the boot key too, so they are fetched and
  // turned into a blob download rather than linked directly.
  download: async (url, filename) => {
    const text = await request('GET', url.pathname + url.search, { raw: true });
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`ดาวน์โหลด ${filename}`, 'ok');
  },

  /**
   * Binary download (the .xlsx export).
   *
   * It cannot be a plain <a href>: every /api call has to carry the boot key in
   * a header, and a link sends none. So the file is fetched, turned into a blob
   * and clicked locally - which also keeps the key out of the URL bar and out
   * of the browser's download history.
   */
  downloadFile: async (path, query, filename) => {
    const url = new URL(path, location.origin);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) { if (v.length) url.searchParams.set(k, v.join(',')); }
      else url.searchParams.set(k, String(v));
    }
    const headers = { 'X-App-Key': state.bootKey };
    if (state.sessionId) headers['X-Session-Id'] = state.sessionId;
    const res = await fetch(url, { headers, credentials: 'omit', cache: 'no-store', mode: 'same-origin' });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { message = (JSON.parse(await res.text()) || {}).error || message; } catch { /* not json */ }
      throw new ApiError(message, res.status);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  },

  tables: (query) => request('GET', '/api/tables', { query }),
  tableDetail: (schemaName, tableName) => request(
    'GET', `/api/tables/${encodeURIComponent(schemaName)}/${encodeURIComponent(tableName)}`
  ),

  preflight: (body) => request('POST', '/api/preflight', { body }),
  preflightGet: (id, full) => request('GET', `/api/preflight/${encodeURIComponent(id)}`, { query: { full: full ? 1 : '' } }),
  preflightList: () => request('GET', '/api/preflight'),
  preflightCancel: (id) => request('POST', `/api/preflight/${encodeURIComponent(id)}/cancel`, { body: {} }),

  checksum: (body) => request('POST', '/api/checksum', { body }),
  checksumGet: (id, full) => request('GET', `/api/checksum/${encodeURIComponent(id)}`, { query: { full: full ? 1 : '' } }),
  checksumList: () => request('GET', '/api/checksum'),
  checksumCancel: (id) => request('POST', `/api/checksum/${encodeURIComponent(id)}/cancel`, { body: {} }),
  checksumVerify: (id, body) => request('POST', `/api/checksum/${encodeURIComponent(id)}/verify`, { body: body || {} }),

  plan: (body) => request('POST', '/api/plan', { body }),
  planGet: (id) => request('GET', `/api/plan/${encodeURIComponent(id)}`),
  planScript: (id, direction) => request('GET', `/api/plan/${encodeURIComponent(id)}/script`, { query: { direction }, raw: true }),

  jobRun: (body) => request('POST', '/api/jobs', { body }),
  jobs: () => request('GET', '/api/jobs'),
  job: (id) => request('GET', `/api/jobs/${encodeURIComponent(id)}`),
  jobLog: (id) => request('GET', `/api/jobs/${encodeURIComponent(id)}/log`),
  jobCancel: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`, { body: {} }),
  jobPause: (id, paused) => request('POST', `/api/jobs/${encodeURIComponent(id)}/pause`, { body: { paused } }),
  jobRollback: (id, stepIds) => request('POST', `/api/jobs/${encodeURIComponent(id)}/rollback`, { body: { stepIds } }),

  auditDays: () => request('GET', '/api/audit'),
  audit: (day, limit) => request('GET', `/api/audit/${encodeURIComponent(day)}`, { query: { limit } }),
};

export { request };
