// The single-table workspace.
//
// Everything an operator does to one table lives on this page, as five steps
// that unlock in order: check the data, fingerprint it, write the SQL, run it,
// prove nothing changed. Options that are not part of the decision are folded
// away behind "ตัวเลือกขั้นสูง"; the default path is one button per step.
import { api, state } from '../api.js';
import {
  work, tableState, setTableState, openTable, resetTable, splitKey, tableBody, nextStep,
} from '../store.js';
import { navigate } from '../app.js';
import {
  $, $$, esc, num, pct, bytes, duration, note, chip, toast, applyDynamicStyles, showModal,
  confirmDialog, copyToClipboard, levelKind, collapse, setBusy, isBusy,
} from '../util.js';

let key = null;
let detail = null;
let timers = [];

/**
 * Fetched payloads for the currently open table. Keyed by the id they came
 * from: re-running a step mints a new id, and a cache that ignored that would
 * happily show the previous run's verdict next to the new one's button.
 * The ids in the store are the record; this is only a fetch cache.
 */
const res = { preflight: null, checksum: null, plan: null, job: null, verify: null };

const cached = (slot, id) => (res[slot] && res[slot].id === id ? res[slot].data : null);
const cache = (slot, id, data) => { res[slot] = { id, data }; return data; };

export function dispose() {
  for (const t of timers) clearInterval(t);
  timers = [];
  setBusy(false);
}

// Every long-running thing on this page is polled, so "a poller is alive" is
// the same statement as "a task is running" - one place to lock the page from.
function poll(fn, ms = 1200, label = 'กำลังทำงาน') {
  const t = setInterval(fn, ms);
  timers.push(t);
  setBusy(true, label);
  fn();
  return t;
}

function stopPoll(t) {
  clearInterval(t);
  timers = timers.filter((x) => x !== t);
  if (!timers.length) setBusy(false);
}

/* ------------------------------------------------------------------ shell */

export async function render(host, params) {
  dispose();
  const wanted = (params && params.key) || work.current;
  if (!wanted) { navigate('tables'); return; }
  key = wanted;
  openTable(key);
  for (const k of Object.keys(res)) res[k] = null;

  const { schemaName, tableName } = splitKey(key);
  host.innerHTML = '<div class="loading">กำลังอ่านโครงสร้างตาราง…</div>';
  try {
    detail = await api.tableDetail(schemaName, tableName);
  } catch (err) {
    host.innerHTML = `${note('crit', 'เปิดตารางนี้ไม่ได้', esc(err.message))}
      <button class="btn-sm" id="tw-back">← กลับไปหน้ารายการ</button>`;
    $('#tw-back', host).addEventListener('click', () => navigate('tables'));
    return;
  }

  host.innerHTML = `
    <div class="card tw-head">
      <div class="row-tight">
        <button class="btn-sm btn-ghost" id="tw-back">← รายการตาราง</button>
        <div class="spacer"></div>
        <button class="btn-sm btn-ghost" id="tw-reset">เริ่มใหม่</button>
      </div>
      <h2 class="tw-title mono">${esc(schemaName)}.<strong>${esc(tableName)}</strong></h2>
      <div class="factstrip">
        <div><span class="k">ขนาด</span><span class="v">${bytes(detail.facts.sizeBytes)}</span></div>
        <div><span class="k">จำนวนแถว</span><span class="v">${num(detail.facts.approxRows)}</span></div>
        <div><span class="k">ต้องแปลง</span><span class="v ${detail.facts.pendingColumns ? 'bad' : 'ok'}">${num(detail.facts.pendingColumns)} / ${num(detail.facts.textColumns)}</span></div>
        <div><span class="k">collation</span><span class="v">${detail.facts.tableDefaultOk ? chip(detail.table.tableCollation, 'chip-ok') : chip(detail.table.tableCollation || '—', 'chip-bad')}</span></div>
      </div>
      ${detail.facts.needsChange
    ? ''
    : note('ok', 'ตารางนี้เรียบร้อยแล้ว', `คอลัมน์ข้อความกับ default ของตารางเป็น <code>${esc(state.target.charset)} / ${esc(state.target.collation)}</code> หมดแล้ว ไม่มีอะไรต้องทำ`)}
      ${detail.pendingColumns.length ? collapse(`คอลัมน์ที่จะเปลี่ยน (${detail.pendingColumns.length})`, `
        <div class="table-wrap"><table>
          <thead><tr><th>column</th><th>type</th><th>ตอนนี้เป็น</th><th>key</th></tr></thead>
          <tbody>${detail.pendingColumns.map((c) => `<tr>
            <td class="mono">${esc(c.columnName)}</td>
            <td class="mono">${esc(c.columnType)}</td>
            <td class="mono">${esc(c.columnCharset)} / ${esc(c.columnCollation)}</td>
            <td>${c.columnKey ? chip(c.columnKey, 'chip-info') : ''}</td></tr>`).join('')}</tbody>
        </table></div>`) : ''}
    </div>

    <div id="tw-steps"></div>`;

  $('#tw-back', host).addEventListener('click', () => navigate('tables'));
  $('#tw-reset', host).addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'เริ่มใหม่ตั้งแต่ขั้น 1',
      body: note('info', null, 'หน้านี้จะกลับไปเริ่มที่ขั้น 1 ผลสแกน baseline และแผนที่ทำไว้ยังอยู่ครบ ไม่ได้ถูกลบ'),
      confirmText: 'เริ่มใหม่',
    });
    if (!ok) return;
    // Resetting while a task runs would drop the lock and leave the runner
    // working on a table the page has stopped tracking.
    if (isBusy()) { toast(`${isBusy()} — รอให้เสร็จ หรือกดยกเลิกก่อน`, 'warn'); return; }
    resetTable(key);
    render(host, { key });
  });

  await drawSteps(host);
}

// A loader that writes state and asks for a redraw must converge on the second
// pass. This is a backstop, not the mechanism: it turns a future mistake into a
// visible stall instead of a blown stack.
let drawDepth = 0;

async function drawSteps(host) {
  const box = $('#tw-steps', host);
  if (!box) return;
  if (drawDepth > 4) {
    console.warn('csmig: step redraw did not settle - stopping to avoid a loop');
    return;
  }
  drawDepth += 1;
  setTimeout(() => { drawDepth = 0; }, 0);
  const st = tableState(key);
  const at = nextStep(st);
  box.innerHTML = [
    stepPreflight(st, at),
    stepBaseline(st, at),
    stepPlan(st, at),
    stepRun(st, at),
    stepVerify(st, at),
  ].join('');
  applyDynamicStyles(box);
  wirePreflight(host);
  wireBaseline(host);
  wirePlan(host);
  wireRun(host);
  wireVerify(host);

  // Re-hydrate whatever this table already finished, so a page reload, a
  // re-render or a trip to another view never leaves a step stuck on its
  // "กำลังโหลด…" placeholder. Each loader serves from cache when the id is
  // unchanged, so this costs a request only when something actually moved.
  if (st.preflightId) loadPreflight(host, st.preflightId);
  if (st.checksumId) loadChecksum(host, st.checksumId);
  if (st.planId) loadPlan(host, st.planId);
  if (st.jobId) loadJob(host, st.jobId);
  if (st.verifyId) loadVerify(host, st.verifyId);
}

const redraw = () => drawSteps($('#view'));

/** One step shell. `state` drives the badge and whether the body is open. */
function step({ n, title, sub, status, locked, lockReason, body }) {
  const badge = {
    done: '<span class="stepno done">✓</span>',
    problem: '<span class="stepno problem">!</span>',
    running: '<span class="stepno running">•</span>',
  }[status] || `<span class="stepno${locked ? ' locked' : ' ready'}">${n}</span>`;
  return `
    <details class="card stepcard ${status}${locked ? ' locked' : ''}" ${locked || status === 'done' ? '' : 'open'} data-step="${n}">
      <summary>
        ${badge}
        <span class="step-h">
          <strong>${esc(title)}</strong>
          <span class="hint">${sub || ''}</span>
        </span>
      </summary>
      <div class="stepbody">
        ${locked ? note('info', 'ยังกดไม่ได้', esc(lockReason || 'ทำขั้นก่อนหน้าให้เสร็จก่อน')) : body}
      </div>
    </details>`;
}

/* ------------------------------------------------------------- 1 preflight */

function scanPlanLine() {
  const rows = detail.facts.approxRows;
  const cap = (state.meta && state.meta.scan && state.meta.scan.defaultRowLimit) || 200000;
  if (!rows || rows <= cap) return `${num(rows)} แถว ดูครบทั้งตาราง`;
  return `${num(rows)} แถว จะดูให้ <strong>${num(cap)} แถวแรก</strong> (${(cap / rows * 100).toFixed(1)}%)`;
}

function stepPreflight(st, at) {
  const gate = st.preflightGate;
  // A scan is in flight exactly when an id exists but no verdict has landed.
  const status = st.preflightId && gate === null ? 'running'
    : gate === 'block' ? 'problem' : gate ? 'done' : 'ready';
  const cap = (state.meta && state.meta.scan && state.meta.scan.defaultRowLimit) || 200000;
  return step({
    n: 1,
    title: 'ตรวจข้อมูลก่อนแปลง',
    sub: gate ? verdictText(gate) : 'ดูว่ามีตัวอักษรไหนจะหาย หรือค่าไหนจะซ้ำกันบ้าง',
    status,
    body: `
      <p class="hint">${scanPlanLine()}</p>
      ${collapse('ตัวเลือกขั้นสูง', `
        <div class="row">
          <label class="field"><span>ดูกี่แถว</span>
            <select id="pf-rows">
              <option value="50000">50,000 แถวแรก (เร็วสุด)</option>
              <option value="${cap}" selected>${num(cap)} แถวแรก (ค่าตั้งต้น)</option>
              <option value="1000000">1,000,000 แถวแรก (ละเอียดขึ้น)</option>
              <option value="full">ทั้งตาราง (ตารางใหญ่จะนานมาก)</option>
            </select></label>
          <label class="field"><span>เก็บตัวอย่างกี่แถว</span>
            <select id="pf-samples">${[3, 5, 10, 20].map((n) => `<option ${n === 5 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <div class="field"><span>&nbsp;</span>
            <label class="check"><input type="checkbox" id="pf-unique" checked> เช็ค UNIQUE index ด้วย</label>
            <label class="check"><input type="checkbox" id="pf-double" checked> เช็ค double-encoding ด้วย</label>
          </div>
        </div>`)}
      <div class="row-tight">
        <button class="btn-primary" id="pf-run">${st.preflightId ? 'ตรวจอีกครั้ง' : 'เริ่มตรวจ'}</button>
        <button class="btn-sm btn-ghost" id="pf-cancel" disabled>ยกเลิก</button>
      </div>
      <div id="pf-progress"></div>
      <div id="pf-result">${st.preflightId ? '<div class="loading">กำลังโหลดผลรอบล่าสุด…</div>' : ''}</div>`,
  });
}

const verdictText = (gate) => (gate === 'block' ? 'มีปัญหา ต้องแก้ก่อน'
  : gate === 'warn' ? 'ผ่าน แต่มีเรื่องต้องดู' : 'ผ่าน');

function wirePreflight(host) {
  const btn = $('#pf-run', host);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const rows = $('#pf-rows', host) ? $('#pf-rows', host).value : '';
    const full = rows === 'full';
    btn.disabled = true;
    try {
      const task = await api.preflight(tableBody(key, {
        rowLimit: full ? 0 : Number(rows) || undefined,
        fullScan: full,
        sampleSize: Number($('#pf-samples', host) ? $('#pf-samples', host).value : 5),
        checkUnique: $('#pf-unique', host) ? $('#pf-unique', host).checked : true,
        checkDoubleEncoding: $('#pf-double', host) ? $('#pf-double', host).checked : true,
      }));
      setTableState(key, { preflightId: task.id, preflightGate: null, preflightAt: task.createdAt });
      watchTask(host, 'preflight', task.id);
    } catch (err) {
      toast(err.message, 'err', 9000);
      btn.disabled = false;
    }
  });
  const cancel = $('#pf-cancel', host);
  if (cancel) {
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try { await api.preflightCancel(tableState(key).preflightId); toast('สั่งยกเลิกแล้ว เดี๋ยวจะหยุดให้', 'info'); } catch { /* already gone */ }
    });
  }
}

/** Shared progress poller for the two long scans. */
function watchTask(host, kind, id) {
  const prefix = kind === 'preflight' ? 'pf' : 'cs';
  const get = kind === 'preflight' ? api.preflightGet : api.checksumGet;
  const btn0 = $(`#${prefix}-cancel`, host);
  if (btn0) btn0.disabled = false;

  const cancelTask = () => {
    const cancel = kind === 'preflight' ? api.preflightCancel : api.checksumCancel;
    cancel(id).catch(() => { /* already gone */ });
    toast('สั่งยกเลิกแล้ว เดี๋ยวจะหยุดให้', 'info');
  };

  const t = poll(async () => {
    let task;
    try { task = await get(id, false); } catch { return; }
    // Re-query every tick: a step re-render swaps these nodes out, and writing
    // to a detached one would silently freeze the progress bar.
    const progressBox = $(`#${prefix}-progress`, host);
    const cancelBtn = $(`#${prefix}-cancel`, host);
    if (cancelBtn) cancelBtn.disabled = task.status !== 'running';
    const p = task.progress || { done: 0, total: 0 };
    const elapsed = Date.now() - new Date(task.createdAt).getTime();
    if (task.status === 'running') {
      setBusy(true, kind === 'preflight' ? 'กำลังตรวจข้อมูล' : 'กำลังเก็บ baseline', {
        detail: `${p.total ? `${num(p.done)}/${num(p.total)} · ` : ''}ผ่านไป ${duration(elapsed)}`,
        onCancel: cancelTask,
      });
    }
    if (progressBox) {
      progressBox.innerHTML = `
        <div class="progress-wrap">
          <span class="status-dot ${task.status === 'running' ? 'running' : task.status}"></span>
          <div class="progress"><span data-width="${p.total ? (p.done / p.total) * 100 : 40}"></span></div>
          <span class="hint nowrap">${task.status === 'running' ? `กำลังตรวจ ${duration(elapsed)}` : task.status}</span>
        </div>`;
      applyDynamicStyles(progressBox);
    }
    if (task.status === 'running') return;

    stopPoll(t);
    if (progressBox) progressBox.innerHTML = '';
    const runBtn = $(`#${prefix}-run`, host);
    if (runBtn) runBtn.disabled = false;

    if (task.status === 'failed') {
      toast(`${kind === 'preflight' ? 'ตรวจไม่สำเร็จ' : 'ทำ checksum ไม่สำเร็จ'}: ${task.error}`, 'err', 9000);
      return;
    }
    if (task.status === 'cancelled') { toast('ยกเลิกแล้ว', 'warn'); return; }
    if (kind === 'preflight') await loadPreflight(host, id, true);
    else await loadChecksum(host, id, true);
  }, 1200, kind === 'preflight' ? 'กำลังตรวจข้อมูล' : 'กำลังเก็บ baseline');
}

async function loadPreflight(host, id, announce = false) {
  const box = $('#pf-result', host);
  let r = cached('preflight', id);
  if (!r) {
    let task;
    try { task = await api.preflightGet(id, true); } catch (err) {
      if (box) box.innerHTML = `<div class="note note-crit">${esc(err.message)}</div>`;
      return;
    }
    if (task.status === 'running') { watchTask(host, 'preflight', id); return; }
    r = task.result;
    if (!r) { if (box) box.innerHTML = `<div class="note note-crit">${esc(task.error || 'ไม่มีผลลัพธ์')}</div>`; return; }
    cache('preflight', id, r);
  }

  const tb = (r.tables || [])[0];
  const st0 = tableState(key);
  // `scanned: false` means the table was skipped, not cleared - the run step
  // has to know the difference.
  if (st0.preflightGate !== r.gate || st0.preflightScanned !== !!(tb && tb.scanned)) {
    setTableState(key, { preflightGate: r.gate, preflightScanned: !!(tb && tb.scanned) });
    redraw();
    return;
  }
  if (!box || !tb) return;

  const lossy = tb.columns.reduce((a, c) => a + (c.lossyRows || 0), 0);
  const dbl = tb.columns.reduce((a, c) => a + (c.doubleEncodedRows || 0), 0);
  const dup = tb.uniqueIndexes.reduce((a, u) => a + (u.dupGroups || 0), 0);

  const head = r.gate === 'block'
    ? note('crit', 'ยังแปลงไม่ได้', 'ถ้าแปลงตอนนี้ข้อมูลจะเสียถาวร หรือไม่ก็ ALTER พังกลางทาง กดดูรายละเอียดแล้วไปแก้ข้อมูลก่อน')
    : r.gate === 'warn'
      ? note('warn', 'ผ่าน แต่มีเรื่องต้องดู', tb.truncated
        ? `ดูไป ${num(tb.scannedRows)} แถวแรกแล้วยังไม่เจออะไร ที่เหลือยังไม่ได้ดู`
        : 'ไม่มีข้อมูลที่จะหาย แต่มีบางอย่างที่ควรเปิดดูเอง')
      : note('ok', 'ผ่าน', `ดูครบ ${num(tb.scannedRows)} แถว ไม่มีตัวอักษรที่จะหาย และไม่มีค่าซ้ำใน UNIQUE index`);

  box.innerHTML = `
    ${head}
    <div class="factstrip">
      <div><span class="k">ตัวอักษรจะหาย</span><span class="v ${lossy ? 'bad' : 'ok'}">${num(lossy)}</span></div>
      <div><span class="k">ค่าซ้ำใน UNIQUE</span><span class="v ${dup ? 'bad' : 'ok'}">${num(dup)}</span></div>
      <div><span class="k">น่าจะ double-encode</span><span class="v ${dbl ? 'warn' : 'ok'}">${num(dbl)}</span></div>
    </div>
    <div class="row-tight">
      <span class="hint">ดูไป ${num(tb.scannedRows)} แถว · ${esc(duration(tb.durationMs))} · <span class="mono">${esc(id)}</span></span>
      <div class="spacer"></div>
      <button class="btn-sm" id="pf-detail">ดูรายละเอียด</button>
    </div>`;
  $('#pf-detail', box).addEventListener('click', () => showTableDetail(tb, r.target));
  if (announce) toast(r.gate === 'block' ? 'ตรวจเสร็จ เจอปัญหาที่ต้องแก้ก่อน' : 'ตรวจเสร็จแล้ว', r.gate === 'block' ? 'err' : 'ok');
}

function showTableDetail(tb, target) {
  const findings = tb.findings.length
    ? tb.findings.map((f) => note(levelKind(f.level), f.code, esc(f.message))).join('')
    : note('ok', null, 'เท่าที่ดู ไม่เจอปัญหา');
  const cols = tb.columns.map((c) => `
    <tr class="${c.lossyRows ? 'row-crit' : c.doubleEncodedRows ? 'row-warn' : ''}">
      <td class="mono">${esc(c.columnName)}</td><td class="mono">${esc(c.dataType)}</td>
      <td class="mono">${esc(c.charset)} / ${esc(c.collation)}</td>
      <td class="num">${c.lossyRows === null ? '?' : num(c.lossyRows)}</td>
      <td class="num">${c.doubleEncodedRows === null ? '—' : num(c.doubleEncodedRows)}</td>
    </tr>`).join('');
  const samples = tb.columns.filter((c) => c.samples && c.samples.length).map((c) => `
    <h4 class="mono">${esc(c.columnName)}</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>คีย์</th><th>ค่าตอนนี้</th><th>ค่าหลังแปลง</th></tr></thead>
      <tbody>${c.samples.map((sm) => `<tr>
        <td class="mono">${esc(Object.entries(sm.id || {}).map(([k2, v]) => `${k2}=${v}`).join(', ') || '—')}</td>
        <td>${esc(sm.value)}</td><td>${esc(sm.afterValue)}</td></tr>`).join('')}</tbody>
    </table></div>`).join('');
  const uniques = tb.uniqueIndexes.length ? `
    <h4>UNIQUE index</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>index</th><th>คอลัมน์</th><th class="num">กลุ่มที่ซ้ำ</th><th class="num">แถวเกิน</th></tr></thead>
      <tbody>${tb.uniqueIndexes.map((u) => `<tr class="${u.dupGroups ? 'row-crit' : ''}">
        <td class="mono">${esc(u.indexName)}</td><td class="mono">${esc(u.columns.join(', '))}</td>
        <td class="num">${u.dupGroups === null ? esc(u.error || '?') : num(u.dupGroups)}</td>
        <td class="num">${u.extraRows === null ? '—' : num(u.extraRows)}</td></tr>`).join('')}</tbody>
    </table></div>` : '';
  showModal(`${tb.schemaName}.${tb.tableName}`, `
    ${findings}
    ${tb.skippedReason ? note('info', 'ตารางนี้ถูกข้าม', esc(tb.skippedReason)) : ''}
    <h4>คอลัมน์ที่จะเปลี่ยนเป็น ${esc(target.charset)} / ${esc(target.collation)}</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>column</th><th>type</th><th>ปัจจุบัน</th><th class="num">ตัวอักษรจะหาย</th><th class="num">dbl-enc</th></tr></thead>
      <tbody>${cols || '<tr><td colspan="5" class="hint">ไม่มีคอลัมน์ที่ต้องเปลี่ยน</td></tr>'}</tbody>
    </table></div>
    ${uniques}
    ${samples ? `<h4>ตัวอย่างแถวที่มีปัญหา</h4>${samples}` : ''}`);
}

/* -------------------------------------------------------------- 2 baseline */

function stepBaseline(st, at) {
  const locked = at < 2;
  const plan = detail.facts.checksumPlan || {};
  const status = st.checksumId ? 'done' : (locked ? '' : 'ready');
  return step({
    n: 2,
    title: 'เก็บ baseline ไว้เทียบทีหลัง',
    sub: st.checksumId ? 'เก็บแล้ว' : 'ไว้เช็คตอนแปลงเสร็จว่าข้อมูลยังเหมือนเดิม',
    status,
    locked,
    lockReason: 'ทำขั้น 1 ให้เสร็จก่อน',
    body: `
      <p class="hint">จะใช้วิธี <strong>${esc(strategyLabel(plan.strategy))}</strong></p>
      ${plan.strategy === 'rowcount' ? note('warn', 'เช็คได้แค่จำนวนแถว', 'ตารางนี้ไม่มี primary key ที่ลำดับคงเดิมหลังเปลี่ยน collation ถ้าอยากเช็คเนื้อข้อมูลด้วย ให้เลือก “อ่านทั้งตาราง” ในตัวเลือกขั้นสูง') : ''}
      ${collapse('ตัวเลือกขั้นสูง', `
        <div class="row">
          <label class="field"><span>อ่านแค่ไหน</span>
            <select id="cs-strategy">
              <option value="auto" selected>ให้เลือกให้ (${esc(strategyLabel(plan.strategy))})</option>
              <option value="full">อ่านทั้งตาราง (แม่นสุด ช้าสุด)</option>
              <option value="pk_head">สุ่มดูแถวแรกๆ ตาม primary key</option>
              <option value="rowcount">นับแค่จำนวนแถว</option>
            </select></label>
          <label class="field"><span>วิธี hash</span>
            <select id="cs-mode">
              <option value="sha256" selected>sha256 (แม่นสุด)</option>
              <option value="crc32">crc32 (เร็วกว่า แต่มีโอกาสชนกัน)</option>
            </select></label>
          <div class="field"><span>&nbsp;</span>
            <label class="check"><input type="checkbox" id="cs-deep"> แยกเก็บทีละคอลัมน์ ช้ากว่าแต่บอกได้ว่าคอลัมน์ไหนเพี้ยน</label>
          </div>
        </div>`)}
      <div class="row-tight">
        <button class="btn-primary" id="cs-run">${st.checksumId ? 'เก็บใหม่อีกครั้ง' : 'เก็บ baseline'}</button>
        <button class="btn-sm btn-ghost" id="cs-cancel" disabled>ยกเลิก</button>
      </div>
      <div id="cs-progress"></div>
      <div id="cs-result">${st.checksumId ? '<div class="loading">กำลังโหลด…</div>' : ''}</div>`,
  });
}

const strategyLabel = (s) => ({
  full: 'อ่านทั้งตาราง', pk_head: 'สุ่มดูแถวแรกๆ ตาม primary key', rowcount: 'นับแค่จำนวนแถว',
}[s] || 'เลือกให้อัตโนมัติ');

function wireBaseline(host) {
  const btn = $('#cs-run', host);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const task = await api.checksum(tableBody(key, {
        strategy: $('#cs-strategy', host) ? $('#cs-strategy', host).value : 'auto',
        mode: $('#cs-mode', host) ? $('#cs-mode', host).value : 'sha256',
        deep: $('#cs-deep', host) ? $('#cs-deep', host).checked : false,
      }));
      setTableState(key, { checksumId: task.id, checksumAt: task.createdAt, verifyId: null, verifyOk: null });
      watchTask(host, 'checksum', task.id);
    } catch (err) {
      toast(err.message, 'err', 9000);
      btn.disabled = false;
    }
  });
  const cancel = $('#cs-cancel', host);
  if (cancel) {
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try { await api.checksumCancel(tableState(key).checksumId); } catch { /* already gone */ }
    });
  }
}

async function loadChecksum(host, id, announce = false) {
  const box = $('#cs-result', host);
  let r = cached('checksum', id);
  if (!r) {
    let task;
    try { task = await api.checksumGet(id, true); } catch (err) {
      if (box) box.innerHTML = `<div class="note note-crit">${esc(err.message)}</div>`;
      return;
    }
    if (task.status === 'running') { watchTask(host, 'checksum', id); return; }
    r = task.result;
    if (!r) { if (box) box.innerHTML = `<div class="note note-crit">${esc(task.error || 'ไม่มีผลลัพธ์')}</div>`; return; }
    cache('checksum', id, r);
  }
  const tb = r.tables[key];
  if (!box) return;
  if (!tb) { box.innerHTML = note('warn', null, 'ใน snapshot นี้ไม่มีข้อมูลของตารางนี้'); return; }
  box.innerHTML = `
    ${note('ok', 'เก็บแล้ว', `${esc(strategyLabel(tb.strategy))} · ${tb.scannedRows !== undefined ? `${num(tb.scannedRows)} แถว` : `${num(tb.rowCount)} แถว`} · ${esc(duration(tb.durationMs))}`)}
    <div class="row-tight">
      <span class="hint mono trunc" title="${esc(tb.digest)}">${esc(tb.digest)}</span>
      <div class="spacer"></div>
      <span class="hint mono">${esc(id)}</span>
    </div>`;
  if (announce) { toast('เก็บ baseline แล้ว', 'ok'); redraw(); }
}

/** The plan payload, cached against its own id. */
async function fetchPlan(planId) {
  const hit = cached('plan', planId);
  if (hit) return hit;
  return cache('plan', planId, (await api.planGet(planId)).plan);
}

/* ------------------------------------------------------------------ 3 plan */

function stepPlan(st, at) {
  const locked = at < 3;
  return step({
    n: 3,
    title: 'สร้างคำสั่ง SQL',
    sub: st.planId ? 'สร้างแล้ว' : 'ดูคำสั่งจริงกับคำสั่งย้อนกลับก่อนรัน',
    status: st.planId ? 'done' : (locked ? '' : 'ready'),
    locked,
    lockReason: 'เก็บ baseline ที่ขั้น 2 ก่อน',
    body: `
      ${collapse('ตัวเลือกขั้นสูง', `
        <div class="row">
          <label class="field"><span>วิธีแปลง</span>
            <select id="pl-strategy">
              <option value="convert_table" selected>CONVERT TO CHARACTER SET ทั้งตาราง (แนะนำ)</option>
              <option value="modify_columns">MODIFY COLUMN ทีละคอลัมน์</option>
            </select></label>
          <label class="field"><span>สำรองก่อนแปลง</span>
            <select id="pl-backup">
              <option value="table_copy" selected>ก๊อปตารางไว้ในฐานข้อมูล (ย้อนกลับเร็วสุด)</option>
              <option value="mysqldump">mysqldump ลงไฟล์</option>
              <option value="none">ไม่สำรอง (ย้อนได้แค่โครงสร้าง ไม่ได้ข้อมูล)</option>
            </select></label>
          <div class="field"><span>&nbsp;</span>
            <label class="check"><input type="checkbox" id="pl-schemadef"> แก้ default ของ schema ด้วย ตัวนี้กระทบทั้ง schema</label>
          </div>
        </div>`)}
      <div class="row-tight">
        <button class="btn-primary" id="pl-build">${st.planId ? 'สร้างใหม่' : 'สร้างคำสั่ง'}</button>
        <span class="hint" id="pl-status"></span>
      </div>
      <div id="pl-result">${st.planId ? '<div class="loading">กำลังโหลด…</div>' : ''}</div>`,
  });
}

function wirePlan(host) {
  const btn = $('#pl-build', host);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    $('#pl-status', host).textContent = 'กำลังสร้างคำสั่ง…';
    try {
      const { planId, plan } = await api.plan(tableBody(key, {
        strategy: $('#pl-strategy', host).value,
        backupStrategy: $('#pl-backup', host).value,
        includeSchemaDefaults: $('#pl-schemadef', host).checked,
        includeTableDefaults: true,
        order: 'size_asc',
      }));
      setTableState(key, { planId, planAt: new Date().toISOString(), jobId: null, jobStatus: null });
      cache('plan', planId, plan);
      redraw();
      toast(`สร้างให้แล้ว ${plan.steps.length} คำสั่ง`, 'ok');
    } catch (err) {
      toast(err.message, 'err', 9000);
    } finally {
      btn.disabled = false;
      const s = $('#pl-status', host);
      if (s) s.textContent = '';
    }
  });
}

async function loadPlan(host, planId) {
  const box = $('#pl-result', host);
  if (!box) return;
  let plan;
  try { plan = await fetchPlan(planId); } catch (err) {
    box.innerHTML = `<div class="note note-crit">${esc(err.message)}</div>`;
    return;
  }
  if (!plan.steps.length) {
    box.innerHTML = note('ok', 'ไม่มีอะไรต้องทำ', 'ตารางนี้เรียบร้อยอยู่แล้ว');
    return;
  }
  const criticals = plan.steps.flatMap((s) => s.risks.filter((r) => r.level === 'critical').map((r) => ({ s, r })));
  box.innerHTML = `
    ${criticals.length
    ? note('crit', 'มีเรื่องร้ายแรงต้องดูก่อน', `<ul>${criticals.slice(0, 8).map((c) => `<li>${esc(c.r.message)}</li>`).join('')}</ul>`)
    : note('ok', `${plan.steps.length} คำสั่ง`, `จะเขียนข้อมูลใหม่ราวๆ ${bytes(plan.summary.rebuildBytes)} ระหว่างที่รัน ตารางนี้อ่านได้แต่เขียนไม่ได้`)}
    ${plan.steps.map((s, i) => `
      <details class="step">
        <summary><span class="chip ${s.metadataOnly ? 'chip-info' : ''}">${esc(s.kind)}</span>
          <span class="step-title">${i + 1}. ${esc(s.title)}</span>
          ${s.metadataOnly ? chip('metadata only', 'chip-ok') : chip(bytes(s.estimate.bytes))}</summary>
        <div class="step-body">
          ${s.risks.map((r) => note(levelKind(r.level), r.code, esc(r.message))).join('')}
          <div class="row-tight"><strong class="hint">FORWARD</strong>
            <button class="btn-sm btn-ghost" data-copy="${i}">คัดลอก</button></div>
          <pre class="sql">${esc(s.sql)}</pre>
          <div class="row-tight"><strong class="hint">ROLLBACK</strong></div>
          <pre class="sql rollback">${esc(s.rollbackSql.join('\n'))}</pre>
          ${s.tooling && s.tooling.ptOsc ? `<div class="row-tight"><strong class="hint">อีกทางเลือก รันแบบไม่ล็อกการเขียน</strong></div>
            <pre class="sql small">${esc(s.tooling.ptOsc)}</pre>` : ''}
        </div>
      </details>`).join('')}
    <div class="row-tight">
      <button class="btn-sm" id="pl-dl">⬇ โหลด .sql</button>
      <span class="hint mono">${esc(planId)}</span>
    </div>`;
  for (const b of $$('[data-copy]', box)) {
    b.addEventListener('click', (e) => { e.preventDefault(); copyToClipboard(plan.steps[Number(b.dataset.copy)].sql); });
  }
  $('#pl-dl', box).addEventListener('click', async () => {
    try {
      const text = await api.planScript(planId, 'forward');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      a.download = `${planId}-forward.sql`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ------------------------------------------------------------------- 4 run */

function stepRun(st, at) {
  const locked = at < 4;
  const blocked = st.preflightGate === 'block';
  const status = st.jobStatus === 'done' ? 'done'
    : st.jobStatus === 'running' ? 'running'
      : st.jobStatus ? 'problem' : (locked ? '' : 'ready');
  return step({
    n: 4,
    title: 'รันคำสั่ง ALTER',
    sub: st.jobStatus ? `สถานะงาน: ${st.jobStatus}` : 'ลองรันดูก่อนได้ แล้วค่อยรันจริง',
    status,
    locked,
    lockReason: 'สร้างคำสั่งที่ขั้น 3 ก่อน',
    body: `
      ${blocked ? note('crit', 'ขั้น 1 บอกว่ายังไม่ควรรัน', 'รันตอนนี้ข้อมูลจะเสียถาวร ไปแก้ข้อมูลแล้วตรวจใหม่ก่อน ถ้ายืนยันจริงๆ เดี๋ยวจะให้พิมพ์ FORCE') : ''}
      ${collapse('ตัวเลือกขั้นสูง', `
        <div class="row">
          <div class="field"><span>&nbsp;</span>
            <label class="check"><input type="checkbox" id="rn-verify" checked> ทำ checksum ก่อน/หลัง แล้วเอามาเทียบ</label>
            <label class="check"><input type="checkbox" id="rn-autorb" checked> ถ้า checksum ไม่ตรง ให้ย้อนกลับอัตโนมัติ</label>
            <label class="check"><input type="checkbox" id="rn-ignoreload"> ไม่ต้องรอให้เซิร์ฟเวอร์ว่าง (ไม่แนะนำ)</label>
          </div>
        </div>`)}
      <div class="row-tight">
        <button class="btn-sm" id="rn-dry">ลองรันดูก่อน ไม่แตะฐานข้อมูล</button>
        <button class="btn-primary" id="rn-go">รันจริง…</button>
        <div class="spacer"></div>
        ${st.jobId ? `<button class="btn-sm btn-ghost" id="rn-open">เปิดดูแบบเต็มหน้า →</button>` : ''}
      </div>
      <div id="rn-result">${st.jobId ? '<div class="loading">กำลังโหลดสถานะ…</div>' : ''}</div>`,
  });
}

function wireRun(host) {
  const dry = $('#rn-dry', host);
  if (dry) dry.addEventListener('click', () => startRun(host, true));
  const go = $('#rn-go', host);
  if (go) go.addEventListener('click', () => startRun(host, false));
  const open = $('#rn-open', host);
  if (open) open.addEventListener('click', () => navigate('jobs', { jobId: tableState(key).jobId }));
}

async function startRun(host, dryRun) {
  const st = tableState(key);
  let plan;
  try { plan = await fetchPlan(st.planId); } catch (err) { toast(err.message, 'err'); return; }
  if (!plan) { toast('ยังไม่ได้สร้างคำสั่ง', 'warn'); return; }

  // A preflight that skipped the table proves nothing. The server refuses the
  // run in that case unless the caller acknowledges it, so ask here rather
  // than letting the operator hit a 412 they cannot interpret.
  const unscanned = st.preflightScanned === false;

  if (!dryRun) {
    const ok = await confirmDialog({
      title: `รันจริงกับตาราง ${key}`,
      body: `
        ${note('warn', null, `จะรัน ${num(plan.steps.length)} คำสั่งกับ <code>${esc(key)}</code>
          เขียนข้อมูลใหม่ราวๆ ${bytes(plan.summary.rebuildBytes)}
          ระหว่างนั้นตารางนี้ <strong>อ่านได้ แต่เขียนไม่ได้</strong>`)}
        ${st.preflightGate === 'block'
    ? note('crit', 'ขั้น 1 ตีกลับไว้', 'ข้อมูลจะเสียถาวร และย้อนกลับไม่ได้')
    : unscanned
      ? note('crit', 'ขั้น 1 ยังไม่ได้ดูข้อมูลจริง', 'ตารางนี้ถูกข้ามตอนตรวจ ยังไม่มีอะไรยืนยันว่าไม่มีตัวอักษรหาย')
      : ''}`,
      confirmText: 'รันจริง',
      danger: true,
      requireText: st.preflightGate === 'block' || unscanned ? 'FORCE' : 'RUN',
    });
    if (!ok) return;
  }

  const payload = {
    planId: st.planId,
    dryRun,
    preflightId: st.preflightId,
    snapshotId: st.checksumId,
    backupStrategy: plan.options.backupStrategy,
    verifyChecksum: $('#rn-verify', host) ? $('#rn-verify', host).checked : true,
    checksumStrategy: 'auto',
    autoRollbackOnFailure: $('#rn-autorb', host) ? $('#rn-autorb', host).checked : true,
    stopOnError: true,
    ignoreLoad: $('#rn-ignoreload', host) ? $('#rn-ignoreload', host).checked : false,
    forceDespiteBlock: st.preflightGate === 'block',
    acknowledgeUncoveredTables: unscanned,
  };

  try {
    const job = await api.jobRun(payload);
    if (!dryRun) setTableState(key, { jobId: job.id, jobStatus: job.status });
    else setTableState(key, { jobId: job.id, jobStatus: null });
    watchJob(host, job.id, dryRun);
  } catch (err) {
    toast(err.message, 'err', 10000);
  }
}

function watchJob(host, id, dryRun = false) {
  const t = poll(async () => {
    let job;
    try { job = await api.job(id); } catch { return; }
    renderJob(host, job, dryRun);
    // A paused job is executing nothing, so the page need not be held - and
    // holding it would trap the operator on a page that is waiting for them.
    const p = job.progress || {};
    setBusy(job.status === 'running' || job.status === 'rolling_back', runLabel(dryRun), {
      detail: `ขั้น ${num(p.doneSteps)}/${num(p.totalSteps)} · ${esc(pct(p.pct))}`,
      cancelText: 'หยุดงาน',
      onCancel: () => {
        api.jobCancel(job.id).catch(() => { /* already finishing */ });
        toast('สั่งหยุดแล้ว ขั้นที่กำลังรันจะทำต่อจนจบก่อน', 'warn', 9000);
      },
    });
    if (['done', 'failed', 'cancelled', 'rolled_back'].includes(job.status)) {
      stopPoll(t);
      if (!dryRun) setTableState(key, { jobStatus: job.status });
      toast(job.status === 'done'
        ? (dryRun ? 'ลองรันเสร็จแล้ว' : 'รันเสร็จแล้ว')
        : `งานจบแบบ ${job.status}`, job.status === 'done' ? 'ok' : 'err');
      if (!dryRun) redraw();
    }
  }, 1200, runLabel(dryRun));
}

const runLabel = (dryRun) => (dryRun ? 'กำลังลองรัน' : 'กำลังแปลงตาราง');

async function loadJob(host, id) {
  try {
    const job = await api.job(id);
    if (job.status === 'running' || job.status === 'paused') watchJob(host, id);
    else renderJob(host, job);
  } catch { /* archived job outside this session */ }
}

function renderJob(host, job, dryRun = false) {
  const box = $('#rn-result', host);
  if (!box) return;
  cache('job', job.id, job);
  const steps = job.steps || [];
  box.innerHTML = `
    <div class="row-tight">
      <span class="status-dot ${job.status === 'running' ? 'running' : job.status}"></span>
      <strong>${dryRun ? 'ลองรัน' : 'รันจริง'}: ${esc(job.status)}</strong>
      <span class="hint mono">${esc(job.id)}</span>
      <div class="spacer"></div>
      ${job.status === 'running' ? '<button class="btn-sm btn-ghost" id="rn-cancel">หยุดงาน</button>' : ''}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>ขั้น</th><th>สถานะ</th><th class="num">เวลาที่ใช้</th><th>checksum</th></tr></thead>
      <tbody>${steps.map((s) => `<tr class="${s.status === 'failed' ? 'row-crit' : ''}">
        <td>${esc(s.title)}</td>
        <td>${chip(s.status, s.status === 'done' ? 'chip-ok' : s.status === 'failed' ? 'chip-bad' : 'chip-info')}</td>
        <td class="num nowrap">${esc(duration(s.alterDurationMs))}</td>
        <td>${s.verify ? (s.verify.ok ? chip('ตรงกัน', 'chip-ok') : chip('ไม่ตรง', 'chip-bad')) : '—'}
            ${s.verify && s.verify.caveat ? `<div class="hint">${esc(s.verify.caveat)}</div>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${job.error ? note('crit', 'เกิดข้อผิดพลาด', esc(job.error)) : ''}`;
  const cancel = $('#rn-cancel', box);
  if (cancel) cancel.addEventListener('click', async () => { await api.jobCancel(job.id); toast('สั่งหยุดแล้ว', 'info'); });
}

/**
 * The step-5 baseline is whatever was fingerprinted at step 2, which can be
 * minutes older than the ALTER. The pair that actually brackets the ALTER is
 * the one the runner took itself, so when the baseline only drifted, say what
 * that pair found.
 */
function jobVerdictLine() {
  const j = res.job && res.job.data;
  const st = tableState(key);
  if (!j || j.id !== st.jobId) return '';
  const s = (j.steps || []).find((x) => `${x.schemaName}.${x.tableName}` === key);
  if (!s || !s.verify) return '';
  const b = s.checksumBefore || {};
  const a = s.checksumAfter || {};
  const counts = b.rowCount !== undefined && a.rowCount !== undefined
    ? ` (${num(b.rowCount)} → ${num(a.rowCount)})` : '';
  return `<br>คู่ที่คร่อม ALTER จริงคือของตัวรันเอง ตอนนั้น${s.verify.ok
    ? `<strong>ตรงกัน</strong>${counts}` : `<strong>ไม่ตรงกัน</strong>${counts}`}`;
}

/* ---------------------------------------------------------------- 5 verify */

function stepVerify(st, at) {
  const locked = at < 5;
  const appended = Number(st.verifyAppended) || 0;
  const status = st.verifyOk === true ? 'done'
    : appended ? 'warn'
      : st.verifyOk === false ? 'problem' : (locked ? '' : 'ready');
  return step({
    n: 5,
    title: 'เช็คว่าข้อมูลยังเหมือนเดิม',
    sub: st.verifyOk === true ? 'ตรงกับ baseline'
      : appended ? `มีแถวเพิ่ม ${num(appended)} แถวหลังเก็บ baseline`
        : st.verifyOk === false ? 'ไม่ตรงกับ baseline' : 'เอาค่าตอนนี้ไปเทียบกับ baseline',
    status,
    locked,
    lockReason: 'รันจริงที่ขั้น 4 ให้ผ่านก่อน',
    body: `
      <div class="row-tight"><button class="btn-primary" id="vf-run">เทียบกับ baseline</button></div>
      <div id="vf-progress"></div>
      <div id="vf-result">${st.verifyId ? '<div class="loading">กำลังโหลด…</div>' : ''}</div>`,
  });
}

function wireVerify(host) {
  const btn = $('#vf-run', host);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const st = tableState(key);
    btn.disabled = true;
    try {
      const task = await api.checksumVerify(st.checksumId, {});
      setTableState(key, { verifyId: task.id, verifyOk: null });
      const t = poll(async () => {
        let x;
        try { x = await api.checksumGet(task.id, false); } catch { return; }
        const box = $('#vf-progress', host);
        if (box) {
          box.innerHTML = `<div class="progress-wrap"><span class="status-dot ${x.status === 'running' ? 'running' : x.status}"></span>
            <span class="hint">${x.status === 'running' ? 'กำลังคำนวณ' : x.status}</span></div>`;
        }
        if (x.status === 'running') return;
        stopPoll(t);
        if (box) box.innerHTML = '';
        btn.disabled = false;
        loadVerify(host, task.id, true);
      }, 1200, 'กำลังเทียบกับ baseline');
      setBusy(true, 'กำลังเทียบกับ baseline', {
        onCancel: () => {
          api.checksumCancel(task.id).catch(() => { /* already gone */ });
          toast('สั่งยกเลิกแล้ว', 'info');
        },
      });
    } catch (err) {
      toast(err.message, 'err', 9000);
      btn.disabled = false;
    }
  });
}

async function loadVerify(host, id, announce = false) {
  const box = $('#vf-result', host);
  let r = cached('verify', id);
  if (!r) {
    let task;
    try { task = await api.checksumGet(id, true); } catch { return; }
    if (task.status === 'running') return;
    r = task.result;
    if (!r || !r.comparison) { if (box) box.innerHTML = `<div class="note note-crit">${esc(task.error || 'ไม่มีผลลัพธ์')}</div>`; return; }
    cache('verify', id, r);
  }
  const cmp = r.comparison[key] || null;
  if (!cmp) {
    // The baseline covered a different table. Say so instead of silently
    // treating "no verdict" as a verdict.
    if (box) box.innerHTML = note('warn', 'baseline อันนี้ไม่มีตารางนี้อยู่', 'กลับไปเก็บ baseline ของตารางนี้ก่อน แล้วค่อยมาเทียบ');
    return;
  }
  // Normalise before comparing: the stored value is always a boolean, so an
  // undefined here would never match and the redraw below would never settle.
  const ok = !!cmp.ok;
  const appended = Number(cmp.appended) || 0;
  const stNow = tableState(key);
  if (stNow.verifyOk !== ok || (Number(stNow.verifyAppended) || 0) !== appended) {
    setTableState(key, { verifyOk: ok, verifyAppended: appended });
    redraw();
    return;
  }
  if (!box) return;
  box.innerHTML = ok
    ? note('ok', 'ข้อมูลยังเหมือนเดิม', cmp.caveat
      ? `ค่าและจำนวนแถวเท่าเดิม <strong>แต่ดูแค่บางส่วน:</strong> ${esc(cmp.caveat)}`
      : 'ค่าและจำนวนแถวเท่าเดิมทุกตัว การแปลงไม่ได้ทำให้ตัวอักษรไหนเปลี่ยน')
    : appended
      ? note('warn', `มีแถวเพิ่มมา ${num(appended)} แถวหลังเก็บ baseline`, `
        ตารางนี้ยังรับ write อยู่ระหว่างที่ทำงาน การเทียบแบบนับแถวจึงบอกได้แค่ว่าจำนวนแถวขยับ
        ไม่ได้บอกว่าข้อมูลเดิมเปลี่ยน${jobVerdictLine()}`)
      : note('crit', 'ข้อมูลไม่ตรงกับ baseline', `<ul>${cmp.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        ถ้าจะย้อนกลับ ไปที่หน้า “งานที่รันไปแล้ว”`);
  if (announce) {
    toast(ok ? 'เรียบร้อย ข้อมูลยังเหมือนเดิม'
      : appended ? `มีแถวเพิ่มมา ${num(appended)} แถวหลัง baseline`
        : 'ข้อมูลไม่ตรงกับ baseline', ok ? 'ok' : appended ? 'warn' : 'err', 9000);
  }
}
