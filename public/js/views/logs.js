// Audit trail viewer. Read-only: every line was already scrubbed by the
// server-side redaction filter, so nothing here needs further masking.

import { api } from '../api.js';
import {
  $, $$, esc, num, note, chip, toast, localTime,
  applyDynamicStyles, showModal, debounce, copyToClipboard,
} from '../util.js';

const FAIL_RE = /(failed|error|blocked|mismatch)/i;
const LIMITS = [500, 1500, 5000];

// Explicit colours for the events the server actually emits; anything unknown
// falls through to the pattern rules in eventKind().
const EVENT_KIND = {
  'server.start': 'chip-ok',
  'server.stop': 'chip-warn',
  'session.connect': 'chip-ok',
  'session.connect.failed': 'chip-bad',
  'session.disconnect': 'chip-warn',
  'session.credential.reveal': 'chip-warn',
  'inventory.export': 'chip-info',
  'plan.created': 'chip-info',
  'preflight.start': 'chip-info',
  'preflight.done': 'chip-ok',
  'checksum.done': 'chip-ok',
  'job.created': 'chip-info',
  'job.finish': 'chip-ok',
  'step.start': 'chip-info',
  'step.done': 'chip-ok',
  'step.failed': 'chip-bad',
  'step.checksum.before': 'chip-info',
  'step.checksum.after': 'chip-info',
  'throttle.wait': 'chip-warn',
  'rollback.step.start': 'chip-warn',
  'rollback.step.done': 'chip-ok',
  'api.error': 'chip-bad',
};

function eventKind(event) {
  const e = String(event || '');
  if (EVENT_KIND[e]) return EVENT_KIND[e];
  if (/(failed|error)/i.test(e)) return 'chip-bad';
  if (/^throttle/i.test(e) || /warn/i.test(e)) return 'chip-warn';
  if (/(done|connect)/i.test(e)) return 'chip-ok';
  return 'chip-info';
}

const ui = { day: '', limit: 1500, q: '', onlyFailed: false, cats: new Set() };

let rows = [];   // enriched records, newest first
let shown = [];  // current filtered subset this is what the export writes

export function dispose() {
  rows = [];
  shown = [];
}

const dayLabel = (f) => String(f || '').replace(/^audit-/, '').replace(/\.ndjson$/, '');
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('th-TH', { hour12: false }) : '—');

export async function render(host) {
  let days = [];
  let endpoint = '';
  try {
    const r = await api.auditDays();
    days = r.days || [];
    endpoint = r.endpoint || '';
  } catch (err) {
    host.innerHTML = note('crit', 'อ่านรายการไฟล์บันทึกไม่สำเร็จ', esc(err.message));
    return;
  }

  if (!days.length) {
    host.innerHTML = '<div class="card"><div class="empty">ยังไม่มีไฟล์บันทึก</div></div>';
    return;
  }

  if (!days.includes(ui.day)) ui.day = days[0];

  host.innerHTML = `
    <div class="card">
      <div class="row">
        <label class="field"><span>วันที่</span>
          <select id="lg-day">
            ${days.map((d) => `<option value="${esc(d)}" ${d === ui.day ? 'selected' : ''}>${esc(dayLabel(d))}</option>`).join('')}
          </select></label>
        <label class="field"><span>บรรทัดท้ายไฟล์</span>
          <select id="lg-limit">
            ${LIMITS.map((n) => `<option value="${n}" ${n === ui.limit ? 'selected' : ''}>${num(n)}</option>`).join('')}
          </select></label>
        <label class="field"><span>ค้นหา</span>
          <input id="lg-q" value="${esc(ui.q)}" placeholder="ตาราง, jobId, error" autocomplete="off" spellcheck="false"></label>
      </div>
      <div class="row-tight">
        <label class="check"><input type="checkbox" id="lg-fail" ${ui.onlyFailed ? 'checked' : ''}> เฉพาะที่ล้มเหลว</label>
        <div class="spacer"></div>
        <span class="hint" id="lg-count"></span>
        <button class="btn-sm" id="lg-reload">⟳</button>
        <button class="btn-ghost btn-sm" id="lg-export">⬇ NDJSON</button>
      </div>
      <div class="row-tight" id="lg-cats"></div>
      <p class="hint" id="lg-meta"></p>
      <p class="hint">บันทึกแยกตามเครื่องปลายทาง กำลังดูของ <span class="mono">${esc(endpoint)}</span>
        รวมกับเหตุการณ์ระดับโปรเซส เช่น สตาร์ท/หยุดเซิร์ฟเวอร์ ซึ่งไม่ได้เป็นของเครื่องไหน</p>
    </div>

    <div class="card">
      <div id="lg-table"></div>
    </div>`;

  applyDynamicStyles(host);
  wire(host);
  await load(host);
}

function wire(host) {
  $('#lg-day', host).addEventListener('change', (e) => { ui.day = e.target.value; load(host); });
  $('#lg-limit', host).addEventListener('change', (e) => { ui.limit = Number(e.target.value) || 1500; load(host); });
  $('#lg-reload', host).addEventListener('click', () => load(host));
  $('#lg-export', host).addEventListener('click', () => exportNdjson());

  const onSearch = debounce(() => { ui.q = $('#lg-q', host).value.trim().toLowerCase(); applyFilters(host); }, 350);
  $('#lg-q', host).addEventListener('input', onSearch);

  $('#lg-fail', host).addEventListener('change', (e) => { ui.onlyFailed = e.target.checked; applyFilters(host); });

  $('#lg-cats', host).addEventListener('change', (e) => {
    const cat = e.target.dataset ? e.target.dataset.cat : null;
    if (!cat) return;
    if (e.target.checked) ui.cats.add(cat); else ui.cats.delete(cat);
    applyFilters(host);
  });

  $('#lg-table', host).addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('[data-idx]') : null;
    if (!btn) return;
    const r = shown[Number(btn.dataset.idx)];
    if (r) openRecord(r);
  });
}

function enrich(rec) {
  const event = String(rec.event || (rec.raw !== undefined ? 'raw.unparsed' : '—'));
  const rest = { ...rec };
  delete rest.ts; delete rest.event; delete rest.jobId;
  delete rest.host; delete rest.port;
  const detail = JSON.stringify(rest);
  return {
    rec,
    event,
    // Absent on process-level events, and on every line written before logs
    // were split by endpoint.
    endpoint: rec.host ? `${rec.host}${rec.port ? `:${rec.port}` : ''}` : '',
    ts: rec.ts || '',
    jobId: rec.jobId || '',
    prefix: event.split('.')[0] || '—',
    failed: FAIL_RE.test(event),
    detail: detail === '{}' ? '' : detail,
    full: JSON.stringify(rec, null, 2),
    hay: JSON.stringify(rec).toLowerCase(),
  };
}

async function load(host) {
  const box = $('#lg-table', host);
  if (!box) return;
  box.innerHTML = '<div class="loading">กำลังโหลด…</div>';
  $('#lg-cats', host).innerHTML = '';
  $('#lg-count', host).textContent = '';

  let entries;
  try {
    entries = (await api.audit(ui.day, ui.limit)).entries || [];
  } catch (err) {
    rows = [];
    shown = [];
    $('#lg-meta', host).textContent = '';
    box.innerHTML = note('crit', `อ่าน ${esc(ui.day)} ไม่สำเร็จ`, esc(err.message));
    return;
  }

  rows = entries.map(enrich).reverse(); // API returns oldest-first
  ui.cats = new Set(rows.map((r) => r.prefix));

  drawMeta(host);
  drawCats(host);
  applyFilters(host);
}

function drawMeta(host) {
  const failed = rows.filter((r) => r.failed).length;
  const jobs = new Set(rows.filter((r) => r.jobId).map((r) => r.jobId)).size;
  const stamps = rows.map((r) => r.ts).filter(Boolean);
  $('#lg-meta', host).innerHTML = [
    `${num(rows.length)} บรรทัด`,
    failed ? `<strong>ล้ม ${num(failed)}</strong>` : '',
    jobs ? `${num(jobs)} job` : '',
    stamps.length ? `${clock(stamps[stamps.length - 1])}–${clock(stamps[0])}` : '',
    rows.length >= ui.limit ? 'ครบเพดาน — เพิ่มจำนวนบรรทัดเพื่อดูเก่ากว่านี้' : '',
  ].filter(Boolean).join(' · ');
}

function drawCats(host) {
  const box = $('#lg-cats', host);
  if (!box) return;
  const counts = new Map();
  for (const r of rows) counts.set(r.prefix, (counts.get(r.prefix) || 0) + 1);
  const cats = [...counts.keys()].sort();
  if (!cats.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = cats.map((c) => `
    <label class="check"><input type="checkbox" data-cat="${esc(c)}" ${ui.cats.has(c) ? 'checked' : ''}>
      <span class="mono">${esc(c)}</span> <span class="hint">${num(counts.get(c))}</span></label>`).join('');
}

function applyFilters(host) {
  shown = rows.filter((r) => {
    if (!ui.cats.has(r.prefix)) return false;
    if (ui.onlyFailed && !r.failed) return false;
    if (ui.q && !r.hay.includes(ui.q)) return false;
    return true;
  });

  const count = $('#lg-count', host);
  if (count) {
    count.textContent = rows.length ? `${num(shown.length)}/${num(rows.length)}` : '';
  }

  const box = $('#lg-table', host);
  if (box) {
    box.innerHTML = table(shown);
    applyDynamicStyles(box);
  }
}

function table(list) {
  if (!rows.length) return '<div class="empty">ไม่มีเหตุการณ์ในไฟล์นี้</div>';
  if (!list.length) return '<div class="empty">ไม่มีเหตุการณ์ที่ตรงกับตัวกรอง</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>เวลา</th><th>event</th><th>เครื่อง</th><th>jobId</th><th>รายละเอียด</th></tr></thead>
    <tbody>${list.map((r, i) => `<tr data-idx="${i}" class="${r.failed ? 'row-crit' : ''}">
      <td class="nowrap">${esc(localTime(r.ts))}</td>
      <td class="nowrap">${chip(r.event, eventKind(r.event))}</td>
      <td class="mono nowrap trunc" title="${esc(r.endpoint || 'ไม่ระบุ — เป็นเหตุการณ์ระดับโปรเซส หรือบรรทัดเก่าก่อนแยกเครื่อง')}">${esc(r.endpoint || '—')}</td>
      <td class="mono nowrap">${r.jobId ? esc(r.jobId) : '—'}</td>
      <td class="mono trunc" title="${esc(r.detail || '{}')}">${esc(r.detail || '—')}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function openRecord(r) {
  showModal(r.event, `
    <div class="row-tight">
      ${chip(r.event, eventKind(r.event))}
      ${r.jobId ? chip(r.jobId, 'chip-info') : ''}
      <span class="hint nowrap">${esc(localTime(r.ts))}</span>
    </div>
    <pre class="sql">${esc(r.full)}</pre>
    <button class="btn-sm" id="lg-copy">คัดลอก JSON</button>`);
  const btn = $('#lg-copy');
  if (btn) btn.addEventListener('click', () => copyToClipboard(r.full));
}

// Same blob-download pattern as plan.js downloadScript(): build the anchor in
// JS (CSP forbids inline handlers) and revoke the object URL afterwards.
function exportNdjson() {
  if (!shown.length) {
    toast('ไม่มีเหตุการณ์ให้ส่งออก', 'warn');
    return;
  }
  // Write back in file order (oldest first) so the export stays a valid slice.
  const text = `${[...shown].reverse().map((r) => JSON.stringify(r.rec)).join('\n')}\n`;
  const blob = new Blob([text], { type: 'application/x-ndjson;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `audit-${dayLabel(ui.day)}-filtered.ndjson`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  toast(`ส่งออก ${num(shown.length)} บรรทัด`, 'ok');
}
