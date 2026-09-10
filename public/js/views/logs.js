// Audit trail viewer. Read-only: every line was already scrubbed by the
// server-side redaction filter, so nothing here needs further masking.

import { api } from '../api.js';
import {
  $, $$, esc, num, note, chip, toast, localTime, timeAgo,
  applyDynamicStyles, showModal, debounce, copyToClipboard, statCard,
  collapse,
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
  try {
    days = (await api.auditDays()).days || [];
  } catch (err) {
    host.innerHTML = intro() + note('crit', 'อ่านรายการไฟล์บันทึกไม่สำเร็จ', `
      ${esc(err.message)} ตรวจว่าเซิร์ฟเวอร์ยังทำงานอยู่ และมีสิทธิ์อ่านโฟลเดอร์
      <span class="mono">data/audit/</span> แล้วลองเปิดหน้านี้อีกครั้ง`);
    return;
  }

  if (!days.length) {
    host.innerHTML = intro() + `
      <div class="card">
        <h2>ไฟล์บันทึก</h2>
        <div class="empty">ยังไม่มีไฟล์บันทึก ระบบจะสร้าง
          <span class="mono">data/audit/audit-YYYY-MM-DD.ndjson</span> ให้อัตโนมัติเมื่อมีเหตุการณ์แรกเกิดขึ้น</div>
      </div>`;
    return;
  }

  if (!days.includes(ui.day)) ui.day = days[0];

  host.innerHTML = `
    ${intro()}

    <div class="card">
      <h2>เลือกไฟล์บันทึก</h2>
      <div class="row">
        <label class="field"><span>วันที่ (หนึ่งไฟล์ต่อวัน)</span>
          <select id="lg-day">
            ${days.map((d) => `<option value="${esc(d)}" ${d === ui.day ? 'selected' : ''}>${esc(dayLabel(d))}</option>`).join('')}
          </select></label>
        <label class="field"><span>จำนวนบรรทัดที่โหลด (นับจากท้ายไฟล์)</span>
          <select id="lg-limit">
            ${LIMITS.map((n) => `<option value="${n}" ${n === ui.limit ? 'selected' : ''}>${num(n)} บรรทัด</option>`).join('')}
          </select></label>
        <div class="field"><span>&nbsp;</span>
          <div class="row-tight">
            <button class="btn-primary btn-sm" id="lg-reload">⟳ โหลดใหม่</button>
            <button class="btn-ghost btn-sm" id="lg-export">⬇ ส่งออก NDJSON</button>
          </div>
        </div>
      </div>
      <p class="hint" id="lg-meta"></p>
    </div>

    <div class="grid grid-4" id="lg-stats"></div>

    <div class="card">
      <h2>ตัวกรอง (ทำงานในเบราว์เซอร์ ไม่แตะไฟล์)</h2>
      <div class="row">
        <label class="field"><span>ค้นหา (เทียบกับทุกฟิลด์ในบันทึก)</span>
          <input id="lg-q" value="${esc(ui.q)}" placeholder="เช่น ชื่อตาราง, jobId, ข้อความ error" autocomplete="off" spellcheck="false"></label>
        <div class="field"><span>&nbsp;</span>
          <label class="check"><input type="checkbox" id="lg-fail" ${ui.onlyFailed ? 'checked' : ''}> เฉพาะเหตุการณ์ที่ล้มเหลว</label>
        </div>
      </div>
      <div class="field">
        <span>หมวดเหตุการณ์ (จากคำนำหน้าที่พบในข้อมูลที่โหลด)</span>
        <div class="row-tight" id="lg-cats"></div>
      </div>
      <div class="row-tight">
        <button class="btn-sm" id="lg-all">เลือกทุกหมวด</button>
        <button class="btn-sm" id="lg-none">ไม่เลือกหมวดใด</button>
        <div class="spacer"></div>
        <span class="hint" id="lg-count"></span>
      </div>
    </div>

    <div class="card">
      <h2>เหตุการณ์ (ใหม่สุดอยู่บนสุด)</h2>
      <div id="lg-table"></div>
    </div>`;

  applyDynamicStyles(host);
  wire(host);
  await load(host);
}

function intro() {
  return collapse('บันทึกนี้เก็บอะไร', `
    รหัสผ่านไม่มีทางโผล่ในบันทึก ค่าลับถูกแทนด้วย <code>sha256:…</code>
    ที่เทียบได้ว่าเป็นค่าเดิมไหม แต่ย้อนกลับไม่ได้
    <ul>
      <li>NDJSON เขียนต่อท้ายอย่างเดียว วันละไฟล์ ที่ <span class="mono">data/audit/</span></li>
      <li>เหตุการณ์ของ job เขียนซ้ำอีกชุดที่ <span class="mono">data/jobs/&lt;jobId&gt;.ndjson</span></li>
    </ul>`);
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

  $('#lg-all', host).addEventListener('click', () => {
    ui.cats = new Set(rows.map((r) => r.prefix));
    for (const b of $$('[data-cat]', host)) b.checked = true;
    applyFilters(host);
  });
  $('#lg-none', host).addEventListener('click', () => {
    ui.cats = new Set();
    for (const b of $$('[data-cat]', host)) b.checked = false;
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
  const detail = JSON.stringify(rest);
  return {
    rec,
    event,
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
  $('#lg-stats', host).innerHTML = '';
  $('#lg-cats', host).innerHTML = '';
  $('#lg-count', host).textContent = '';

  let entries;
  try {
    entries = (await api.audit(ui.day, ui.limit)).entries || [];
  } catch (err) {
    rows = [];
    shown = [];
    $('#lg-meta', host).textContent = '';
    box.innerHTML = note('crit', 'อ่านไฟล์บันทึกไม่สำเร็จ', `
      ${esc(err.message)} ไฟล์ <span class="mono">${esc(ui.day)}</span> อาจถูกย้าย ลบ
      หรือไม่มีสิทธิ์อ่าน ลองเลือกวันอื่นหรือกด “โหลดใหม่”`);
    return;
  }

  rows = entries.map(enrich).reverse(); // API returns oldest-first
  ui.cats = new Set(rows.map((r) => r.prefix));

  $('#lg-meta', host).innerHTML = `
    ไฟล์ <span class="mono">data/audit/${esc(ui.day)}</span> โหลด ${num(rows.length)} บรรทัด
    ${rows.length >= ui.limit ? '(ครบเพดานที่เลือก อาจมีเหตุการณ์เก่ากว่านี้ในไฟล์ ลองเพิ่มจำนวนบรรทัด)' : ''}`;

  drawStats(host);
  drawCats(host);
  applyFilters(host);
}

function drawStats(host) {
  const failed = rows.filter((r) => r.failed).length;
  const jobs = new Set(rows.filter((r) => r.jobId).map((r) => r.jobId));
  const stamps = rows.map((r) => r.ts).filter(Boolean);
  const first = stamps.length ? stamps[stamps.length - 1] : '';
  const last = stamps.length ? stamps[0] : '';

  $('#lg-stats', host).innerHTML = `
    ${statCard({
    k: 'เหตุการณ์ทั้งหมดในวันนั้น',
    v: num(rows.length),
    sub: `จากไฟล์ <span class="mono">${esc(dayLabel(ui.day))}</span> (เพดาน ${num(ui.limit)} บรรทัด)`,
  })}
    ${statCard({
    k: 'เหตุการณ์ที่ล้มเหลว',
    v: num(failed),
    sub: failed ? 'เข้าเงื่อนไข failed / error / blocked / mismatch' : 'ไม่พบเหตุการณ์ล้มเหลวในช่วงที่โหลด',
    kind: failed ? 'crit' : 'ok',
    percent: rows.length ? (failed / rows.length) * 100 : 0,
    barKind: failed ? 'crit' : '',
  })}
    ${statCard({
    k: 'job ที่ปรากฏในบันทึก',
    v: num(jobs.size),
    sub: jobs.size ? 'นับจาก jobId ที่ไม่ซ้ำกัน' : 'ไม่มีเหตุการณ์ระดับ job ในวันนี้',
  })}
    ${statCard({
    k: 'ช่วงเวลา',
    v: stamps.length ? `${clock(first)} – ${clock(last)}` : '—',
    sub: stamps.length ? `เหตุการณ์ล่าสุด ${esc(timeAgo(last))}` : 'ยังไม่มีเวลาบันทึก',
  })}`;

  applyDynamicStyles($('#lg-stats', host));
}

function drawCats(host) {
  const box = $('#lg-cats', host);
  if (!box) return;
  const counts = new Map();
  for (const r of rows) counts.set(r.prefix, (counts.get(r.prefix) || 0) + 1);
  const cats = [...counts.keys()].sort();
  if (!cats.length) {
    box.innerHTML = '<span class="hint">ยังไม่มีหมวดเหตุการณ์ให้เลือก</span>';
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
    count.textContent = rows.length
      ? `แสดง ${num(shown.length)} จาก ${num(rows.length)} เหตุการณ์`
      : 'ไม่มีเหตุการณ์ให้กรอง';
  }

  const box = $('#lg-table', host);
  if (box) {
    box.innerHTML = table(shown);
    applyDynamicStyles(box);
  }
}

function table(list) {
  if (!rows.length) {
    return `<div class="empty">ไฟล์บันทึกของวันนี้ยังไม่มีเหตุการณ์ —
      เลือกวันอื่น หรือรอให้มีการเชื่อมต่อ / รัน job ครั้งถัดไป</div>`;
  }
  if (!list.length) {
    return '<div class="empty">ไม่มีเหตุการณ์ที่ตรงกับตัวกรอง ลองล้างคำค้น เลือกหมวดเพิ่ม หรือเอาตัวกรอง “เฉพาะเหตุการณ์ที่ล้มเหลว” ออก</div>';
  }
  return `<div class="table-wrap"><table>
    <thead><tr><th>เวลา</th><th>event</th><th>jobId</th><th>รายละเอียด</th><th></th></tr></thead>
    <tbody>${list.map((r, i) => `<tr class="${r.failed ? 'row-crit' : ''}">
      <td class="nowrap">${esc(localTime(r.ts))}<div class="hint nowrap">${esc(timeAgo(r.ts))}</div></td>
      <td class="nowrap">${chip(r.event, eventKind(r.event))}</td>
      <td class="mono nowrap">${r.jobId ? esc(r.jobId) : '—'}</td>
      <td class="mono trunc" title="${esc(r.detail || '{}')}">${esc(r.detail || '—')}</td>
      <td class="nowrap"><button class="btn-sm" data-idx="${i}">ดู</button></td>
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
    <div class="row-tight">
      <button class="btn-sm" id="lg-copy">คัดลอก JSON</button>
      <span class="hint">ค่าที่เป็นความลับถูกแทนด้วย «redacted» หรือ sha256: ก่อนเขียนลงไฟล์เรียบร้อยแล้ว</span>
    </div>`);
  const btn = $('#lg-copy');
  if (btn) btn.addEventListener('click', () => copyToClipboard(r.full));
}

// Same blob-download pattern as plan.js downloadScript(): build the anchor in
// JS (CSP forbids inline handlers) and revoke the object URL afterwards.
function exportNdjson() {
  if (!shown.length) {
    toast('ไม่มีเหตุการณ์ที่จะส่งออก', 'warn');
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
