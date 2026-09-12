import { api, state, setSession } from './api.js';
import { $, $$, esc, toast, isBusy, setBusy } from './util.js';

import * as connectView from './views/connect.js';
import * as overviewView from './views/overview.js';
import * as inventoryView from './views/inventory.js';
import * as tablesView from './views/tables.js';
import * as tableView from './views/table.js';
import * as autoView from './views/auto.js';
import * as jobsView from './views/jobs.js';
import * as logsView from './views/logs.js';

const ROUTES = {
  connect: { title: 'เชื่อมต่อฐานข้อมูล', view: connectView, open: true },
  overview: { title: 'ภาพรวม', view: overviewView },
  tables: { title: 'ตารางที่ต้องแปลง', view: tablesView },
  // Not in the sidebar: it is always entered from the work list, and it needs
  // a table to be about.
  table: { title: 'แปลงตาราง', view: tableView, hidden: true },
  // Also entered from the work list, and only meaningful with a queue behind it.
  auto: { title: 'รันอัตโนมัติ', view: autoView, hidden: true },
  inventory: { title: 'ค้นหาคอลัมน์', view: inventoryView },
  jobs: { title: 'งานที่รันไปแล้ว', view: jobsView },
  logs: { title: 'บันทึกการทำงาน', view: logsView },
};

let current = null;
// What the address bar said when the current view was mounted, so a back-button
// press that the busy lock refuses can be put back.
let lastHash = '';

/** '#table/shop.orders' -> { route: 'table', params: { key: 'shop.orders' } } */
function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const slash = raw.indexOf('/');
  if (slash < 0) return { route: raw, params: {} };
  return { route: raw.slice(0, slash), params: { key: decodeURIComponent(raw.slice(slash + 1)) } };
}

export function navigate(route, params) {
  if (!ROUTES[route]) route = 'connect';
  // A running task owns the page it started from until it ends or is cancelled.
  const busy = isBusy();
  if (busy && current && ROUTES[route] !== current) {
    toast(`${busy} — รอให้เสร็จ หรือกดยกเลิกก่อนออกจากหน้านี้`, 'warn');
    if (location.hash !== lastHash) location.hash = lastHash;
    return;
  }
  if (!ROUTES[route].open && !state.session) {
    toast('ต่อฐานข้อมูลก่อนนะ', 'warn');
    route = 'connect';
  }
  if (current && current.view.dispose) {
    try { current.view.dispose(); } catch { /* ignore */ }
  }
  const def = ROUTES[route];
  current = def;
  location.hash = route === 'table' && params && params.key
    ? `#table/${encodeURIComponent(params.key)}`
    : `#${route}`;
  lastHash = location.hash;
  $('#page-title').textContent = def.title;
  $('#topbar-actions').innerHTML = '';
  const navRoute = route === 'table' ? 'tables' : route;
  for (const el of $$('.nav-item')) {
    const on = el.dataset.route === navRoute;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  const host = $('#view');
  host.innerHTML = '<div class="loading">กำลังโหลด…</div>';
  Promise.resolve(def.view.render(host, params || {})).catch((err) => {
    host.innerHTML = `<div class="note note-crit"><strong>มีบางอย่างผิดพลาด</strong>${esc(err.message)}</div>`;
  });
}

export function refreshChrome() {
  const connected = !!state.session;
  for (const el of $$('.nav-item[data-needs-session]')) el.disabled = !connected;

  const card = $('#conn-card');
  if (!connected) {
    card.innerHTML = '<div class="conn-off">ยังไม่เชื่อมต่อ</div>';
    return;
  }
  const s = state.session;
  const srv = s.server || {};
  card.innerHTML = `
    <dl>
      <dt>host</dt><dd>${esc(s.host)}:${esc(s.port)}</dd>
      <dt>user</dt><dd>${esc(s.user)}</dd>
      <dt>server</dt><dd>${esc(srv.version || '?')}</dd>
      <dt>target</dt><dd>${esc(state.target.charset)}<br>${esc(state.target.collation)}</dd>
    </dl>
    ${srv.readOnly ? '<div class="chip chip-warn">read_only</div>' : ''}
    ${srv.replica ? '<div class="chip chip-warn">replica</div>' : ''}
    ${!srv.canAlter ? '<div class="chip chip-bad">ไม่พบสิทธิ์ ALTER</div>' : ''}
    <button class="btn-sm btn-ghost" data-act="disconnect" id="btn-disconnect">ตัดการเชื่อมต่อ</button>`;
  $('#btn-disconnect').addEventListener('click', async () => {
    try { await api.disconnect(); } catch { /* already gone */ }
    setSession(null);
    refreshChrome();
    navigate('connect');
    toast('ตัดการเชื่อมต่อแล้ว รหัสผ่านถูกลบออกจากหน่วยความจำแล้ว', 'ok');
  });
}

async function boot() {
  if (!state.bootKey) {
    $('#view').innerHTML = `<div class="note note-crit"><strong>ไม่มี boot key</strong>
      เปิดจาก URL ที่ขึ้นในเทอร์มินัล ตัวที่มี <code>?key=…</code> ต่อท้าย</div>`;
    return;
  }
  try {
    state.meta = await api.meta();
    state.target = state.meta.target;
    $('#target-label').textContent = `${state.target.charset} / ${state.target.collation}`;
  } catch (err) {
    $('#view').innerHTML = `<div class="note note-crit"><strong>ต่อเซิร์ฟเวอร์ไม่ได้</strong>${esc(err.message)}</div>`;
    return;
  }

  // Resume an existing server-side session after a page reload.
  if (state.sessionId) {
    try {
      setSession(await api.session());
    } catch {
      setSession(null);
    }
  }

  for (const el of $$('.nav-item')) {
    el.addEventListener('click', () => navigate(el.dataset.route));
  }
  window.addEventListener('csmig:session-lost', () => {
    setBusy(false);
    refreshChrome();
    toast('session หมดอายุแล้ว ต่อใหม่อีกครั้ง', 'warn');
    navigate('connect');
  });
  // Reload / close while a task runs: only the browser's own confirm can stop
  // those, and it needs both of these to fire.
  window.addEventListener('beforeunload', (e) => {
    if (!isBusy()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  window.addEventListener('hashchange', () => {
    const { route, params } = parseHash();
    if (route && ROUTES[route] && current !== ROUTES[route]) navigate(route, params);
  });

  refreshChrome();
  const { route, params } = parseHash();
  navigate(state.session ? (ROUTES[route] ? route : 'overview') : 'connect', params);
}

boot();
