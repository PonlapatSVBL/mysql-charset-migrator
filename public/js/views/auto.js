// The unattended run: its settings before it starts, its progress while it
// runs, and what it did afterwards.
//
// The settings are two numbers because those are the two that decide whether a
// table is safe to convert without anybody watching. Everything else about the
// run is the same flow the workspace performs by hand, and is not configurable
// here on purpose - an unattended run is not the place to loosen a rule.
import { api, state } from '../api.js';
import { navigate } from '../app.js';
import {
  $, $$, esc, num, bytes, duration, note, chip, toast, confirmDialog, setBusy, applyDynamicStyles,
} from '../util.js';
import { auto, startAuto, stopAuto, applyLimits, outcomeLabel, summarise, MAX_WORKERS } from '../auto.js';

// Deliberately modest. The row default is the preflight's own scan cap: below
// it every table is read end to end, so the column picker can PROVE each
// column rather than infer it - which is exactly the standard an unattended
// run should be held to.
const DEFAULTS = { maxRows: 200000, maxSizeMb: 500, backupStrategy: 'none', concurrency: 1 };

// One page of the work list is the queue, and the server caps a page at 500.
// A bigger queue is not a bigger run - it is a second run after this one.
const QUEUE_MAX = 500;

const ui = { ...DEFAULTS, filters: null };
let preview = { eligible: [], excluded: [] };

export function dispose() {
  setBusy(false);
}

export async function render(host, params = {}) {
  if (params.filters) ui.filters = params.filters;

  if (auto.running || auto.results.length) {
    drawRun(host);
    if (auto.running) watch(host);
    return;
  }

  host.innerHTML = `
    <div class="card">
      <h2>รันอัตโนมัติ</h2>
      <p class="hint">ไล่ทำตารางทีละตัวด้วยขั้นตอนเดิมทุกขั้น — ตรวจข้อมูล เก็บ baseline สร้างคำสั่ง รัน แล้วเทียบผล
        ตารางไหนติดปัญหาจะถูกข้ามแล้วไปตัวถัดไป ไม่มีการข้ามด่านความปลอดภัยใดๆ</p>
      <div class="row">
        <label class="field"><span>รันเฉพาะตารางที่แถวไม่เกิน</span>
          <input id="au-rows" type="number" min="0" step="1000" value="${ui.maxRows}"></label>
        <label class="field"><span>และขนาดไม่เกิน (MB)</span>
          <input id="au-mb" type="number" min="0" step="10" value="${ui.maxSizeMb}"></label>
        <label class="field"><span>ทำพร้อมกันกี่ตาราง</span>
          <select id="au-conc">
            ${Array.from({ length: MAX_WORKERS }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}
          </select></label>
        <label class="field"><span>สำรองก่อนแปลง</span>
          <select id="au-backup">
            <option value="none">ไม่สำรอง</option>
            <option value="table_copy">ก๊อปตารางไว้ในฐานข้อมูล</option>
          </select></label>
      </div>
      ${note('info', 'ทำพร้อมกันได้ แต่ ALTER ยังทีละตัว',
    `การสแกนกินเวลาส่วนใหญ่ของตารางเล็ก และสแกนพร้อมกันได้อย่างปลอดภัยเพราะเป็นการอ่านล้วน
       แต่ตอนเขียนข้อมูลจริง ระบบจะปล่อยให้ <strong>ทีละตารางเท่านั้น</strong> เข้า ALTER
       ตัวอื่นจะสแกนต่อไปแล้วรอคิว — การ rebuild สองตารางพร้อมกันคือวิธีทำให้เซิร์ฟเวอร์ล่ม
       ซึ่งเป็นเหตุผลเดียวกับที่ตัวรัน job ไม่เคยมี knob ปรับ concurrency`)}
      ${note('info', `ทำไมตั้งต้นที่ ${num(DEFAULTS.maxRows)} แถว`,
    `ต่ำกว่านี้ Preflight จะอ่าน<strong>ครบทุกแถว</strong> ตัวเลือกคอลัมน์จึงพิสูจน์ได้จริงว่าไม่มีตัวอักษรไหนหาย
       ไม่ใช่แค่สุ่มตรวจ — ตารางที่ใหญ่กว่านี้ควรทำเองทีละตัวจะดีกว่า`)}
      <div id="au-preview"><div class="loading">กำลังดูรายการ…</div></div>
      <div class="row-tight">
        <button class="btn-primary" id="au-start">เริ่มรันอัตโนมัติ</button>
        <button class="btn-sm btn-ghost" id="au-back">กลับไปหน้ารายการ</button>
      </div>
    </div>`;

  $('#au-backup', host).value = ui.backupStrategy;
  $('#au-conc', host).value = String(ui.concurrency);
  $('#au-conc', host).addEventListener('change', () => { ui.concurrency = Number($('#au-conc', host).value) || 1; });
  $('#au-back', host).addEventListener('click', () => navigate('tables'));
  for (const id of ['au-rows', 'au-mb']) {
    $(`#${id}`, host).addEventListener('change', () => loadPreview(host));
  }
  $('#au-backup', host).addEventListener('change', () => { ui.backupStrategy = $('#au-backup', host).value; });
  $('#au-start', host).addEventListener('click', () => begin(host));

  await loadPreview(host);
}

function readLimits(host) {
  ui.maxRows = Math.max(0, Number($('#au-rows', host).value) || 0);
  ui.maxSizeMb = Math.max(0, Number($('#au-mb', host).value) || 0);
  ui.backupStrategy = $('#au-backup', host) ? $('#au-backup', host).value : 'none';
  const conc = $('#au-conc', host);
  if (conc) ui.concurrency = Math.min(Math.max(Number(conc.value) || 1, 1), MAX_WORKERS);
  return {
    maxRows: ui.maxRows, maxSizeMb: ui.maxSizeMb,
    backupStrategy: ui.backupStrategy, concurrency: ui.concurrency,
  };
}

/**
 * The queue, shown before it runs.
 *
 * Same filters the work list had, same order - smallest first - so what starts
 * is what the operator was just looking at, and the cheap tables go first.
 */
async function loadPreview(host) {
  const box = $('#au-preview', host);
  if (!box) return;
  const limits = readLimits(host);
  box.innerHTML = '<div class="loading">กำลังดูรายการ…</div>';
  let rows = [];
  try {
    const f = ui.filters || {};
    const list = await api.tables({
      schema: f.schema, engine: f.engine, q: f.q,
      status: 'todo', sort: 'size', dir: 'asc', page: 1, pageSize: QUEUE_MAX,
    });
    rows = list.rows || [];
    preview.more = Math.max(Number(list.total || 0) - rows.length, 0);
  } catch (err) {
    box.innerHTML = note('crit', 'อ่านรายการตารางไม่ได้', esc(err.message));
    return;
  }
  const more = preview.more || 0;
  preview = applyLimits(rows, limits);
  preview.more = more;

  const totalBytes = preview.eligible.reduce((a, r) => a + Number(r.sizeBytes || 0), 0);
  box.innerHTML = `
    <div class="factstrip">
      <div><span class="k">จะรัน</span><span class="v ${preview.eligible.length ? 'ok' : ''}">${num(preview.eligible.length)} ตาราง</span></div>
      <div><span class="k">ข้ามเพราะเกินเพดาน</span><span class="v">${num(preview.excluded.length)} ตาราง</span></div>
      <div><span class="k">ขนาดรวม</span><span class="v">${bytes(totalBytes)}</span></div>
    </div>
    ${preview.eligible.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>ตาราง</th><th class="num">แถว</th><th class="num">ขนาด</th></tr></thead>
        <tbody>${preview.eligible.slice(0, 12).map((r) => `<tr>
          <td class="mono">${esc(r.key)}</td>
          <td class="num">${num(r.approxRows)}</td>
          <td class="num">${esc(bytes(r.sizeBytes))}</td></tr>`).join('')}</tbody>
      </table></div>
      ${preview.eligible.length > 12 ? `<p class="hint">แสดง 12 จาก ${num(preview.eligible.length)} ตาราง เรียงจากเล็กไปใหญ่</p>` : ''}
      ${preview.more ? note('info', `ยังมีอีก ${num(preview.more)} ตารางที่ไม่ได้เข้าคิวรอบนี้`,
    `คิวหนึ่งรอบรับได้ ${num(QUEUE_MAX)} ตาราง พอรอบนี้จบแล้วกดรันอีกครั้ง รายการที่เหลือจะเข้าคิวต่อเอง`) : ''}
    ` : note('warn', 'ไม่มีตารางที่เข้าเกณฑ์', 'ลองเพิ่มเพดานแถวหรือขนาด หรือกลับไปปรับตัวกรองที่หน้ารายการ')}`;
}

async function begin(host) {
  const limits = readLimits(host);
  if (!preview.eligible.length) { toast('ไม่มีตารางที่เข้าเกณฑ์', 'warn'); return; }
  if (state.session && state.session.server && state.session.server.readOnly) {
    toast('เซิร์ฟเวอร์อยู่ในโหมด read_only — รัน ALTER ไม่ได้', 'err', 9000);
    return;
  }
  const ok = await confirmDialog({
    title: `รันอัตโนมัติ ${preview.eligible.length} ตาราง (พร้อมกัน ${limits.concurrency})?`,
    body: `<p>จะไล่ทำทีละตารางด้วยขั้นตอนเดิมครบทุกขั้น และ <strong>เขียนข้อมูลจริง</strong></p>
      <p>ตารางที่ Preflight บล็อก เก็บ baseline ไม่สำเร็จ หรือแผนมีความเสี่ยงระดับ critical
         จะถูกข้ามและรายงานไว้ ไม่มีการบังคับรันข้ามด่านใดๆ</p>
      <div class="note note-warn"><strong>ระหว่างรันอย่าปิดหน้านี้</strong>
        หยุดได้ตลอด ตารางที่กำลังทำจะทำต่อจนจบขั้นของมันก่อน</div>`,
    confirmText: 'เริ่มรัน',
    danger: true,
    requireText: 'RUN',
  });
  if (!ok) return;

  startAuto({ queue: preview.eligible, limits }, () => { drawRun(host); });
  watch(host);
}

/** Hold the page while the run owns it, the same way a single task does. */
function watch(host) {
  setBusy(true, 'กำลังรันอัตโนมัติ', {
    detail: `${num(auto.results.length)}/${num(auto.queue.length)} ตาราง`,
    cancelText: 'หยุด',
    onCancel: () => {
      stopAuto();
      toast('จะหยุดหลังตารางนี้จบ', 'warn', 7000);
    },
  });
  const t = setInterval(() => {
    if (!auto.running) {
      clearInterval(t);
      setBusy(false);
      drawRun(host);
      const by = summarise(auto.results);
      toast(`จบแล้ว: แปลง ${by.converted} · ข้าม ${by.skipped} · ล้ม ${by.failed}`,
        by.failed ? 'warn' : 'ok', 12000);
      return;
    }
    setBusy(true, 'กำลังรันอัตโนมัติ', {
      detail: `${num(auto.results.length)}/${num(auto.queue.length)} ตาราง${auto.active.length > 1 ? ` · ทำอยู่ ${auto.active.length}` : ''}`,
      cancelText: 'หยุด',
      onCancel: () => { stopAuto(); toast('จะหยุดหลังตารางนี้จบ', 'warn', 7000); },
    });
    drawRun(host);
  }, 1000);
}

const TONE = {
  converted: 'chip-ok', nothing: 'chip-none', skipped: 'chip-warn',
  failed: 'chip-bad', attention: 'chip-warn',
};

let lastPaint = '';

function drawRun(host) {
  // Nothing moves between two polls of the same step, so only repaint when
  // something an operator can see has actually changed. Otherwise the results
  // table scrolls itself back to the top under them once a second.
  const signature = [
    auto.running, auto.stopping, auto.results.length, auto.altering,
    auto.active.map((a) => `${a.key}:${a.phase}`).join(','),
  ].join('|');
  if (signature === lastPaint && host.querySelector('#au-results')) return;
  lastPaint = signature;
  const by = summarise(auto.results);
  const pct = auto.queue.length ? (auto.results.length / auto.queue.length) * 100 : 0;

  host.innerHTML = `
    <div class="card">
      <div class="row-tight">
        <h2>${auto.running ? 'กำลังรันอัตโนมัติ' : 'รันอัตโนมัติเสร็จแล้ว'}</h2>
        <div class="spacer"></div>
        <span class="hint">${esc(duration((auto.finishedAt || Date.now()) - (auto.startedAt || Date.now())))}</span>
      </div>
      <div class="progress-wrap">
        <span class="status-dot ${auto.running ? 'running' : 'done'}"></span>
        <div class="progress"><span data-width="${pct}"></span></div>
        <span class="hint nowrap">${num(auto.results.length)}/${num(auto.queue.length)}</span>
      </div>
      ${auto.limits && auto.limits.concurrency > 1
    ? `<p class="hint">ทำพร้อมกัน ${num(auto.limits.concurrency)} ตาราง · ALTER ทีละตัว</p>` : ''}
      ${auto.active.length ? `<ul class="worklines">${auto.active.map((a) => `
        <li><span class="status-dot ${a.key === auto.altering ? 'running' : 'pending'}"></span>
          <span class="mono">${esc(a.key)}</span>
          <span class="hint">${esc(a.phase || 'รอเริ่ม')}</span>
          ${a.key === auto.altering ? chip('กำลังเขียนข้อมูล', 'chip-warn') : ''}</li>`).join('')}</ul>` : ''}
      ${auto.stopping && auto.running ? note('warn', 'สั่งหยุดแล้ว', 'จะหยุดหลังตารางนี้จบ') : ''}
      <div class="factstrip">
        <div><span class="k">แปลงแล้ว</span><span class="v ok">${num(by.converted)}</span></div>
        <div><span class="k">ไม่ต้องทำ</span><span class="v">${num(by.nothing)}</span></div>
        <div><span class="k">ข้าม</span><span class="v ${by.skipped ? 'warn' : ''}">${num(by.skipped)}</span></div>
        <div><span class="k">ต้องดูเอง</span><span class="v ${by.attention ? 'warn' : ''}">${num(by.attention)}</span></div>
        <div><span class="k">ล้มเหลว</span><span class="v ${by.failed ? 'bad' : ''}">${num(by.failed)}</span></div>
      </div>
      <div class="row-tight">
        ${auto.running
    ? `<button class="btn-sm btn-danger" id="au-stop-now">หยุดเดี๋ยวนี้ (ยกเลิกงานที่ค้างอยู่)</button>`
    : `<button class="btn-sm" id="au-again">ตั้งค่าแล้วรันอีกครั้ง</button>
       <button class="btn-sm btn-ghost" id="au-back2">กลับไปหน้ารายการ</button>`}
      </div>
    </div>

    <div class="card">
      <h2>ผลรายตาราง</h2>
      ${auto.results.length ? `<div class="table-wrap" id="au-results"><table>
        <thead><tr><th>ตาราง</th><th>ผล</th><th>เหตุผล</th><th>งาน</th></tr></thead>
        <tbody>${[...auto.results].reverse().map((r) => `<tr class="${r.outcome === 'failed' ? 'row-crit' : r.outcome === 'skipped' || r.outcome === 'attention' ? 'row-warn' : ''}">
          <td class="mono">${esc(r.key)}</td>
          <td class="nowrap">${chip(outcomeLabel(r.outcome), TONE[r.outcome] || '')}</td>
          <td>${esc(r.reason)}</td>
          <td class="mono nowrap">${r.ids.jobId ? `<button class="btn-sm btn-ghost" data-job="${esc(r.ids.jobId)}">ดูงาน</button>` : '—'}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty" id="au-results">ยังไม่มีผล</div>'}
    </div>`;

  applyDynamicStyles(host);
  const stopNow = $('#au-stop-now', host);
  if (stopNow) {
    stopNow.addEventListener('click', async () => {
      stopNow.disabled = true;
      await stopAuto({ cancelCurrent: true });
      toast('สั่งยกเลิกงานที่ค้างอยู่แล้ว', 'warn');
    });
  }
  const again = $('#au-again', host);
  if (again) {
    again.addEventListener('click', () => {
      auto.results = [];
      auto.queue = [];
      render(host, {});
    });
  }
  const back = $('#au-back2', host);
  if (back) back.addEventListener('click', () => navigate('tables'));
  for (const b of $$('[data-job]', host)) {
    b.addEventListener('click', () => navigate('jobs', { jobId: b.dataset.job }));
  }
}
