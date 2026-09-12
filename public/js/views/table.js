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
import { AUTO_PHASES, autoNext } from '../autorun.js';

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
  // Leaving the view kills the pollers the runner is awaiting, so its loop
  // would sit on a promise that never settles. Flag it as cancelled so the
  // next tick through the loop stops instead.
  if (auto) auto.cancelled = true;
  auto = null;
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
        ${detail.facts.needsChange ? '<button class="btn-sm" id="tw-auto-run">▶ รันทุกขั้นอัตโนมัติ</button>' : ''}
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

    <div id="tw-auto" class="autorun-dock"></div>
    <div id="tw-steps"></div>`;

  $('#tw-back', host).addEventListener('click', () => navigate('tables'));
  const autoBtn = $('#tw-auto-run', host);
  if (autoBtn) autoBtn.addEventListener('click', () => runAuto(host));
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

/* ---------------------------------------------------------------- autorun */

/**
 * The one-button run.
 *
 * It does not click the buttons - a step that finishes calls redraw(), which
 * replaces every node on the page, so a driver holding element references
 * would be driving corpses by step two. Instead each phase calls the same
 * `start*` function its button calls and awaits the promise that resolves once
 * the result has been written to the store. The store is the thing that
 * survives a redraw, so it is the thing the stop policy reads.
 *
 * Authorisation is taken once, up front. Every gate that would have escalated
 * to FORCE stops the run instead of being answered on the operator's behalf.
 */
let auto = null;

const PHASE_RUNNERS = {
  preflight: (host) => startPreflight(host, preflightOptions(host)),
  baseline: (host) => startBaseline(host, baselineOptions(host)),
  // Forced to the recommended column set, which is what the button pair
  // "ที่แนะนำ" + "สร้างคำสั่ง" produces. Backup and schema-default are read
  // from the step's own controls so an operator who set them keeps them.
  plan: (host) => startPlan(host, {
    strategy: 'modify_columns',
    columns: recommendedColumns(),
    backupStrategy: $('#pl-backup', host) ? $('#pl-backup', host).value : 'none',
    includeSchemaDefaults: $('#pl-schemadef', host) ? $('#pl-schemadef', host).checked : false,
    includeTableDefaults: true,
    order: 'size_asc',
  }),
  dryrun: (host) => startRun(host, true, { auto: true }),
  run: (host) => startRun(host, false, { auto: true }),
  verify: (host) => startVerify(host),
};

/** The flat snapshot autoNext() reads, assembled from the store plus what the
 *  phase just returned. Only the fields that phase can speak to are filled. */
function autoSnapshot(phase, outcome) {
  const st = tableState(key);
  const s = {
    cancelled: !!(auto && auto.cancelled),
    preflightGate: st.preflightGate,
    preflightScanned: st.preflightScanned,
    checksumOk: st.checksumOk,
    verifyOk: st.verifyOk,
  };
  if (phase === 'preflight' || phase === 'baseline' || phase === 'verify') {
    s.taskStatus = outcome ? outcome.status : 'failed';
  }
  if (phase === 'plan') {
    s.planId = outcome ? outcome.planId : null;
    s.planRebuilds = outcome && outcome.plan ? outcome.plan.summary.rebuilds : 0;
  }
  if (phase === 'dryrun') s.dryRunStatus = outcome;
  if (phase === 'run') s.jobStatus = outcome;
  return s;
}

/**
 * Did the phase itself finish?
 *
 * Deliberately separate from autoNext(): "the scan ran and found a blocker" and
 * "the scan fell over" are both stops, but only the second one is a failure of
 * that phase. Marking the first with a ✗ would tell the operator their preflight
 * broke when what actually happened is that it worked and said no.
 */
function phaseCompleted(phase, outcome) {
  if (phase === 'plan') return !!(outcome && outcome.planId);
  if (phase === 'dryrun' || phase === 'run') return outcome === 'done';
  return !!(outcome && outcome.status === 'done');
}

function renderAuto(host) {
  const box = $('#tw-auto', host);
  if (!box) return;
  // The dock class is what lifts the panel over the busy backdrop and pins it
  // to the top of the scroller, so the stop button stays reachable however far
  // down the steps the operator has scrolled. See .autorun-dock in app.css.
  box.className = `autorun-dock${auto && auto.running ? ' running' : ''}`;
  if (!auto) { box.innerHTML = ''; return; }
  const icon = { done: '✓', running: '•', stopped: '✗', pending: '' };
  const rows = AUTO_PHASES.map((p) => {
    const st = auto.phase[p.id] || 'pending';
    return `<li class="auto-row ${st}">
      <span class="auto-dot">${icon[st] || ''}</span>
      <span class="auto-label">${esc(p.label)}</span>
      <span class="hint">ขั้น ${p.step}</span>
    </li>`;
  }).join('');
  const done = auto.verdict && auto.verdict.code === 'finished';
  box.innerHTML = `
    <div class="card autorun${auto.running ? ' running' : ''}">
      <div class="row-tight">
        <strong>รันทุกขั้นอัตโนมัติ</strong>
        <div class="spacer"></div>
        ${auto.running
    ? '<button class="btn-sm btn-ghost" id="auto-stop">หยุดหลังขั้นที่กำลังทำ</button>'
    : '<button class="btn-sm btn-ghost" id="auto-dismiss">ปิด</button>'}
      </div>
      <ol class="auto-list">${rows}</ol>
      ${auto.verdict && !auto.running
    ? note(done ? 'ok' : auto.verdict.code === 'cancelled' ? 'warn' : 'crit',
      // note() escapes the heading itself; only the body half needs esc().
      auto.verdict.reason, esc(auto.verdict.hint || ''))
    : ''}
    </div>`;
  const stop = $('#auto-stop', box);
  if (stop) {
    stop.addEventListener('click', () => {
      auto.cancelled = true;
      stop.disabled = true;
      toast('จะหยุดหลังขั้นที่กำลังทำอยู่เสร็จ', 'warn');
    });
  }
  const dismiss = $('#auto-dismiss', box);
  if (dismiss) dismiss.addEventListener('click', () => { auto = null; renderAuto(host); });
}

async function runAuto(host) {
  // The page is unlocked in the gaps between phases, so isBusy() alone would
  // let a second click through and start a rival loop on the same table.
  if (auto && auto.running) { toast('ชุดอัตโนมัติกำลังทำงานอยู่แล้ว', 'warn'); return; }
  if (isBusy()) { toast(`${isBusy()} — รอให้เสร็จก่อน`, 'warn'); return; }
  const st0 = tableState(key);
  const cols = recommendedColumns();
  const ok = await confirmDialog({
    title: `รันทุกขั้นอัตโนมัติกับ ${key}`,
    body: `
      ${note('warn', null, `จะทำ 6 อย่างต่อกันเอง: ตรวจข้อมูล → เก็บ baseline → สร้างคำสั่งจากคอลัมน์
        "ที่แนะนำ" → ลองรัน → <strong>รันจริง</strong> → เทียบกับ baseline
        ยืนยันครั้งนี้ครั้งเดียว ระหว่างทางจะไม่ถามอีก`)}
      ${note('info', 'จะหยุดเองเมื่อ', `<ul>
        <li>ขั้น 1 บอกว่าข้อมูลจะเสีย หรือตารางถูกข้ามตอนสแกน (สองเคสนี้ต้องพิมพ์ FORCE จึงไม่ทำให้อัตโนมัติ)</li>
        <li>เก็บ baseline ไม่ได้ค่าที่เอาไปเทียบได้</li>
        <li>"ที่แนะนำ" ไม่ติ๊กคอลัมน์ไหนเลย</li>
        <li>ลองรันไม่ผ่าน หรือรันจริงจบไม่สวย</li></ul>`)}
      ${st0.preflightGate === 'block' || st0.preflightScanned === false
    ? note('crit', 'ผลตรวจรอบก่อนตีกลับไว้', 'จะสแกนใหม่ก่อน ถ้าผลใหม่ยังตีกลับ ระบบจะหยุดที่ขั้น 1')
    : ''}
      ${detail.pendingColumns.length && !cols.length
    ? note('warn', 'ตอนนี้ "ที่แนะนำ" ยังไม่ติ๊กคอลัมน์ไหนเลย',
      'ผลสแกนรอบใหม่อาจเปลี่ยนให้ ถ้ายังไม่ติ๊ก ระบบจะหยุดที่ขั้น 3 ไม่รันอะไรกับข้อมูล')
    : ''}`,
    confirmText: 'เริ่มรันทั้งชุด',
    danger: true,
    requireText: 'RUN',
  });
  if (!ok) return;

  // `run` is this loop's own handle on its state. dispose() drops the module's
  // `auto` when the operator navigates away mid-run; comparing against it is
  // how the loop learns that it is no longer the current run and stops writing
  // to a panel that belongs to another table.
  const run = { running: true, cancelled: false, phase: {}, verdict: null };
  auto = run;
  renderAuto(host);

  for (const p of AUTO_PHASES) {
    if (auto !== run) return;
    if (run.cancelled) { run.verdict = { code: 'cancelled', reason: 'ยกเลิกโดยผู้ใช้' }; break; }
    run.phase[p.id] = 'running';
    renderAuto(host);

    let outcome = null;
    try {
      outcome = await PHASE_RUNNERS[p.id](host);
    } catch (err) {
      if (auto !== run) return;
      run.phase[p.id] = 'stopped';
      run.verdict = { code: 'error', reason: `ขั้น "${p.label}" ล้มเหลว`, hint: err.message };
      break;
    }
    if (auto !== run) return;

    run.phase[p.id] = phaseCompleted(p.id, outcome) ? 'done' : 'stopped';
    const verdict = autoNext(p.id, autoSnapshot(p.id, outcome));
    if (verdict.go) {
      renderAuto(host);
      continue;
    }
    // Where the run stopped is readable from the rows that never left
    // 'pending', so the verdict below carries the reason rather than the place.
    run.verdict = verdict;
    break;
  }

  run.running = false;
  renderAuto(host);
  const v = run.verdict || { code: 'finished', reason: 'เสร็จครบทุกขั้น' };
  toast(v.reason, v.code === 'finished' ? 'ok' : v.code === 'cancelled' ? 'warn' : 'err', 12000);
}

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

/** Read the step's controls, falling back to the same defaults they render with. */
function preflightOptions(host) {
  const rows = $('#pf-rows', host) ? $('#pf-rows', host).value : '';
  const full = rows === 'full';
  return {
    rowLimit: full ? 0 : Number(rows) || undefined,
    fullScan: full,
    sampleSize: Number($('#pf-samples', host) ? $('#pf-samples', host).value : 5),
    checkUnique: $('#pf-unique', host) ? $('#pf-unique', host).checked : true,
    checkDoubleEncoding: $('#pf-double', host) ? $('#pf-double', host).checked : true,
  };
}

/**
 * Start step 1 and resolve with its terminal status.
 *
 * Split out of the click handler so the auto-runner drives the same code path
 * the button does. Everything that decides *what* to scan is a parameter, so
 * neither caller depends on the other's DOM being present.
 */
async function startPreflight(host, opts) {
  const btn = $('#pf-run', host);
  if (btn) btn.disabled = true;
  try {
    const task = await api.preflight(tableBody(key, opts));
    setTableState(key, {
      preflightId: task.id, preflightGate: null, preflightAt: task.createdAt,
      // The old verdict belongs to the old id; leaving it would let the
      // picker vouch for columns using a scan that has been superseded.
      preflightScanned: false, preflightCoverage: null, preflightRows: null, preflightColumns: {},
    });
    return await watchTask(host, 'preflight', task.id);
  } catch (err) {
    toast(err.message, 'err', 9000);
    if (btn) btn.disabled = false;
    return { status: 'failed', error: err.message };
  }
}

function wirePreflight(host) {
  const btn = $('#pf-run', host);
  if (!btn) return;
  btn.addEventListener('click', () => startPreflight(host, preflightOptions(host)));
  const cancel = $('#pf-cancel', host);
  if (cancel) {
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try { await api.preflightCancel(tableState(key).preflightId); toast('สั่งยกเลิกแล้ว เดี๋ยวจะหยุดให้', 'info'); } catch { /* already gone */ }
    });
  }
}

/**
 * Shared progress poller for the two long scans.
 *
 * Resolves with the task's terminal status once the result has been loaded and
 * the store has settled, so the auto-runner can await a phase rather than
 * racing the redraw it triggers. Callers that only want the side effects
 * ignore the promise, which is why nothing here rejects.
 */
function watchTask(host, kind, id) {
  return new Promise((resolve) => {
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
        resolve({ status: 'failed', error: task.error });
        return;
      }
      if (task.status === 'cancelled') {
        toast('ยกเลิกแล้ว', 'warn');
        resolve({ status: 'cancelled' });
        return;
      }
      // Resolve only after the loader has run: it is what writes the verdict
      // into the store, and the runner reads the store the instant we resolve.
      if (kind === 'preflight') await loadPreflight(host, id, true);
      else await loadChecksum(host, id, true);
      resolve({ status: 'done' });
    }, 1200, kind === 'preflight' ? 'กำลังตรวจข้อมูล' : 'กำลังเก็บ baseline');
  });
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
  // What the scan found, written where every step can read it.
  //
  // The plan step's column picker used to read this out of `res.preflight`,
  // the fetch cache that this function happens to fill. That made a column's
  // safety depend on whether step 1 had rendered yet in this pass - so the
  // picker could decide nothing was provably safe purely because it ran first,
  // and then quietly tick nothing. The store is synchronous, survives a
  // redraw and a page reload, and belongs to the table rather than to a view.
  //
  // `scanned: false` means the table was skipped, not cleared - the run step
  // has to know the difference.
  const scan = {
    preflightGate: r.gate,
    preflightScanned: !!(tb && tb.scanned),
    preflightCoverage: (tb && tb.coverage) || null,
    preflightRows: tb && tb.scannedRows !== undefined ? tb.scannedRows : null,
    preflightColumns: Object.fromEntries(((tb && tb.columns) || [])
      .map((c) => [c.columnName, { lossy: c.lossyRows, dbl: c.doubleEncodedRows }])),
  };
  const st0 = tableState(key);
  const stale = Object.keys(scan).some((k) => JSON.stringify(st0[k]) !== JSON.stringify(scan[k]));
  if (stale) {
    setTableState(key, scan);
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
  // An id is not a baseline. A digest that timed out is stored like any other
  // result and used to render as "เก็บแล้ว" in green, which is how a table with
  // no baseline reached the verify step and came back reading as corruption.
  const failed = st.checksumOk === false;
  const status = failed ? 'problem' : st.checksumId ? 'done' : (locked ? '' : 'ready');
  return step({
    n: 2,
    title: 'เก็บ baseline ไว้เทียบทีหลัง',
    sub: failed ? 'เก็บไม่สำเร็จ' : st.checksumId ? 'เก็บแล้ว' : 'ไว้เช็คตอนแปลงเสร็จว่าข้อมูลยังเหมือนเดิม',
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

function baselineOptions(host) {
  return {
    strategy: $('#cs-strategy', host) ? $('#cs-strategy', host).value : 'auto',
    mode: $('#cs-mode', host) ? $('#cs-mode', host).value : 'sha256',
    deep: $('#cs-deep', host) ? $('#cs-deep', host).checked : false,
  };
}

/** Start step 2 and resolve with its terminal status. See startPreflight. */
async function startBaseline(host, opts) {
  const btn = $('#cs-run', host);
  if (btn) btn.disabled = true;
  try {
    const task = await api.checksum(tableBody(key, opts));
    setTableState(key, { checksumId: task.id, checksumAt: task.createdAt, checksumOk: null, verifyId: null, verifyOk: null });
    return await watchTask(host, 'checksum', task.id);
  } catch (err) {
    toast(err.message, 'err', 9000);
    if (btn) btn.disabled = false;
    return { status: 'failed', error: err.message };
  }
}

function wireBaseline(host) {
  const btn = $('#cs-run', host);
  if (!btn) return;
  btn.addEventListener('click', () => startBaseline(host, baselineOptions(host)));
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
    r.legacy = !!task.legacy;
    cache('checksum', id, r);
  }
  const tb = r.tables[key];
  const ok = !!(tb && !tb.error && tb.digest !== null && tb.digest !== undefined);
  const st0 = tableState(key);
  if (st0.checksumOk !== ok) { setTableState(key, { checksumOk: ok }); redraw(); return; }
  if (!box) return;
  if (!tb) { box.innerHTML = note('warn', null, 'ใน snapshot นี้ไม่มีข้อมูลของตารางนี้'); return; }
  if (!ok) {
    box.innerHTML = `
      ${note('crit', 'เก็บ baseline ไม่สำเร็จ', `${esc(tb.error || 'ไม่ได้ค่า digest')}<br>`
        + 'ตารางนี้ยังไม่มีอะไรให้เทียบตอนแปลงเสร็จ — เก็บใหม่ด้วยวิธีที่เบากว่าใน '
        + '<strong>ตัวเลือกขั้นสูง</strong> เช่น “สุ่มดูแถวแรกๆ ตาม primary key” หรือ “นับแค่จำนวนแถว” '
        + 'ก่อนจะไปขั้นต่อไป')}
      <div class="row-tight"><div class="spacer"></div><span class="hint mono">${esc(id)}</span></div>`;
    if (announce) toast('เก็บ baseline ไม่สำเร็จ', 'err', 9000);
    return;
  }
  box.innerHTML = `
    ${note('ok', 'เก็บแล้ว', `${esc(strategyLabel(tb.strategy))} · ${tb.scannedRows !== undefined ? `${num(tb.scannedRows)} แถว` : `${num(tb.rowCount)} แถว`} · ${esc(duration(tb.durationMs))}`)}
    ${r.legacy ? note('warn', 'baseline เก่าก่อนแยกเครื่อง',
    'ไฟล์นี้ถูกเก็บตอนที่บันทึกยังไม่ได้แยกตามเครื่องปลายทาง จึงไม่มีอะไรยืนยันได้ว่ามาจากฐานข้อมูลเดียวกับที่ต่ออยู่ตอนนี้ '
    + 'ถ้าจะใช้เทียบผลหลังแปลง ควรเก็บ baseline ใหม่ที่ขั้น 2 ก่อน') : ''}
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
      <label class="field"><span>จะทำอะไรกับตารางนี้</span>
        <select id="pl-mode">
          <option value="columns" selected>แปลงข้อมูลเฉพาะคอลัมน์ที่ติ๊ก (แนะนำ)</option>
          <option value="table">แปลงทุกคอลัมน์ข้อความด้วย CONVERT TO ทั้งตาราง</option>
          <option value="defaults">แก้แค่ default ของ schema/ตาราง ไม่แตะข้อมูลเดิม</option>
        </select></label>
      <div id="pl-modenote"></div>
      <label class="check"><input type="checkbox" id="pl-schemadef">
        แก้ default ของ schema <span class="mono">${esc(splitKey(key).schemaName)}</span> ด้วย ตัวนี้กระทบทุกตารางที่จะสร้างใน schema นี้</label>
      ${detail.pendingColumns.length ? `
      <div class="field" id="pl-cols">
        <span>คอลัมน์ที่จะแปลง <span class="hint" id="pl-colcount"></span></span>
        <div class="collist" id="pl-collist"></div>
        <div class="row-tight">
          <button class="btn-sm btn-ghost" data-pick="safe">ที่แนะนำ</button>
          <button class="btn-sm btn-ghost" data-pick="keys">เฉพาะคีย์ / index</button>
          <button class="btn-sm btn-ghost" data-pick="all">ทั้งหมด</button>
          <button class="btn-sm btn-ghost" data-pick="none">ล้าง</button>
        </div>
        <div id="pl-colnote"></div>
      </div>` : ''}
      <div id="pl-advanced">${collapse('ตัวเลือกขั้นสูง', `
        <div class="row">
          <label class="field"><span>สำรองก่อนแปลง</span>
            <select id="pl-backup">
              <option value="none" selected>ไม่สำรอง (ย้อนได้แค่โครงสร้าง ไม่ได้ข้อมูล)</option>
              <option value="table_copy">ก๊อปตารางไว้ในฐานข้อมูล (ย้อนกลับเร็วสุด)</option>
              <option value="mysqldump">mysqldump ลงไฟล์</option>
            </select></label>
        </div>`)}</div>
      <div class="row-tight">
        <button class="btn-primary" id="pl-build">${st.planId ? 'สร้างใหม่' : 'สร้างคำสั่ง'}</button>
        <span class="hint" id="pl-status"></span>
      </div>
      <div id="pl-result">${st.planId ? '<div class="loading">กำลังโหลด…</div>' : ''}</div>`,
  });
}

/* ------------------------------------------ which columns tick themselves */

/**
 * What the latest scan of this table found, or null when there is no usable
 * one. Read from the store, not from a fetch cache: see loadPreflight().
 *
 * A scan that was superseded took its verdict with it - re-running step 1
 * clears these fields along with the gate - so this can only ever speak for
 * the id currently in the store.
 */
function lastScan() {
  const st = tableState(key);
  if (!st.preflightId || !st.preflightScanned) return null;
  return {
    coverage: st.preflightCoverage,
    scannedRows: st.preflightRows,
    columns: st.preflightColumns || {},
  };
}

/**
 * Why one column is, or is not, ticked for the operator.
 *
 * The old default ticked `*_id` and nothing else - right about what breaks
 * first (a join, once two collations drift apart) but far too narrow: it
 * missed the rest of every index, missed foreign keys, and left the table in a
 * mixed-charset state nobody asked for.
 *
 * Proof comes from exactly two places:
 *
 *  1. The charset. latin1, tis620, ucs2, utf8mb3 itself - none of them can
 *     hold anything the target cannot, whatever sits in the rows. That is the
 *     server's `lossless`, and it needs no scan at all.
 *  2. The scan, but only when it read every row. Zero lossy rows out of the
 *     first 200,000 of 40M is a sample; zero out of all of them is a proof.
 *
 * Demanding proof and nothing less was the first attempt, and it was wrong:
 * the default scan is capped at 200,000 rows, so on every table big enough to
 * care about, nothing was provable and the picker ticked nothing at all - worse
 * than the *_id rule it replaced, which at least ticked something.
 *
 * So there is a third tier, for a column the scan read and found clean without
 * reaching the end of the table. That is evidence, not proof, and it is enough
 * only for a column the schema wires into a key, an index or a foreign key.
 * Those hold identifiers - codes, statuses, keys - and an identifier that was
 * ever going to hold a character outside the target would almost certainly
 * have shown one in the 200,000 rows already read. Free text is the opposite
 * case, and free text is exactly where an emoji turns up on row 3,000,001, so
 * an unwired column stays clear until the scan reaches the end.
 *
 * A column the scan found lossy rows in is never ticked - nor one whose bytes
 * look double-encoded, where the conversion succeeds and quietly returns
 * mojibake - even when rule 1 would have allowed it.
 */
function columnSafety(c) {
  const tb = lastScan();
  const scan = tb ? tb.columns[c.columnName] : null;
  const tgt = state.target.charset;

  if (scan && scan.lossy > 0) {
    return { tick: false, tone: 'chip-bad', label: 'ตัวอักษรจะหาย',
      why: `สแกนเจอ ${num(scan.lossy)} แถวที่มีตัวอักษรซึ่ง ${tgt} เก็บไม่ได้ แปลงแล้วกลายเป็น '?' ถาวร` };
  }
  if (scan && scan.dbl > 0) {
    return { tick: false, tone: 'chip-warn', label: 'ไบต์น่าสงสัย',
      why: `สแกนเจอ ${num(scan.dbl)} แถวที่ไบต์ข้างในเป็น UTF-8 อยู่แล้ว แปลงตรงๆ จะได้ข้อความเพี้ยน` };
  }
  if (c.generated) {
    return { tick: false, tone: 'chip-warn', label: 'generated',
      why: 'generated column MySQL มักปฏิเสธการแปลง charset ต้อง drop แล้วสร้างใหม่เอง' };
  }
  if (c.lossless) {
    return { tick: true, proven: true, tone: 'chip-ok', label: 'ปลอดภัย',
      why: `${c.columnCharset} เก็บอะไรได้ ${tgt} ก็เก็บได้หมด ไม่ว่าข้างในจะเป็นข้อมูลอะไร` };
  }
  if (scan && scan.lossy === 0 && tb.coverage === 'full') {
    return { tick: true, proven: true, tone: 'chip-ok', label: 'สแกนครบแล้ว',
      why: `${c.columnCharset} กว้างกว่า ${tgt} แต่สแกนครบทั้งตารางแล้วไม่เจอตัวอักษรที่เก็บไม่ได้สักแถว` };
  }
  if (scan && scan.lossy === 0) {
    const reason = isWired(c) ? 'เป็นคีย์หรืออยู่ใน index จึงเก็บรหัส/สถานะ ไม่ใช่ข้อความอิสระ'
      : isShortCode(c) ? `เป็น ${c.dataType}(${num(c.charMaxLen)}) สั้นเกินกว่าจะถูกใช้เก็บข้อความอิสระ`
        : null;
    return {
      tick: !!reason,
      proven: false,
      tone: reason ? 'chip-warn' : 'chip-none',
      label: reason ? `สะอาดใน ${num(tb.scannedRows)} แถว` : 'ยังพิสูจน์ไม่ได้',
      why: `${c.columnCharset} กว้างกว่า ${tgt} สแกนไปแค่ ${num(tb.scannedRows)} แถวแรกแล้วยังไม่เจออะไร `
        + 'แต่แถวที่เหลือยังไม่ได้ดู '
        + (reason
          ? `ติ๊กให้เพราะคอลัมน์นี้${reason} ถ้าอยากได้ความแน่นอน ให้สแกนทั้งตารางที่ขั้น 1`
          : 'ไม่ติ๊กให้เพราะเป็นข้อความอิสระ ซึ่งเป็นที่ที่ emoji โผล่ได้ในแถวที่ยังไม่ได้ดู'),
    };
  }
  return { tick: false, proven: false, tone: 'chip-warn', label: 'ยังไม่ได้ตรวจ',
    why: `${c.columnCharset} กว้างกว่า ${tgt} และยังไม่มีผลสแกนของคอลัมน์นี้` };
}

/**
 * A field too narrow to be prose.
 *
 * Not because an emoji would not fit - one character fits anywhere - but
 * because of what a field this size is declared FOR. Nobody sizes a column at
 * twenty characters and then stores a sentence, a comment or a customer's
 * display name in it; they store a code, a status, a document number, a
 * currency or country abbreviation. That is the same content a key column
 * holds, so it earns the same treatment in the evidence tier: a clean capped
 * scan is enough for it, and a scan that found damage still vetoes it.
 *
 * `char` counts alongside `varchar` - the same shape, declared even more
 * deliberately. The longer types never reach this test: tinytext alone is 255.
 */
const SHORT_CODE_LEN = 20;

function isShortCode(c) {
  return /^(char|varchar)$/i.test(String(c.dataType || ''))
    && Number(c.charMaxLen) > 0
    && Number(c.charMaxLen) <= SHORT_CODE_LEN;
}

/**
 * The wiring a collation mismatch actually breaks: joins, lookups, FKs.
 *
 * `indexed` is the good signal - it counts every index the column appears in,
 * including the parts of a composite that COLUMN_KEY never mentions. But it
 * arrives from the server, and a browser gets fresh static files while the API
 * is still whatever the running process loaded at startup; a column that MySQL
 * itself marks PRI/UNI/MUL must not read as unwired just because the two ends
 * are a restart apart. So `columnKey` stands behind it, and the name behind
 * that.
 */
function isWired(c) {
  return !!(c.indexed
    || c.columnKey
    || (c.foreignKeyNames && c.foreignKeyNames.length)
    || /_id$/i.test(c.columnName));
}

function columnPickerRows() {
  return detail.pendingColumns.map((c) => {
    const s = columnSafety(c);
    const wiring = [
      c.columnKey ? chip(c.columnKey, 'chip-info') : (c.indexed ? chip('idx', 'chip-info') : ''),
      c.foreignKeyNames && c.foreignKeyNames.length ? chip('FK', 'chip-info') : '',
    ].join('');
    return `
      <label class="check" title="${esc(c.columnCharset)} / ${esc(c.columnCollation)} — ${esc(s.why)}">
        <input type="checkbox" data-col="${esc(c.columnName)}"${s.tick ? ' checked' : ''}>
        <span class="mono">${esc(c.columnName)}</span>
        <span class="hint mono trunc">${esc(c.columnType)}</span>
        ${wiring}${chip(s.label, s.tone)}
      </label>`;
  }).join('');
}

function wirePlan(host) {
  const btn = $('#pl-build', host);
  if (!btn) return;

  const mode = $('#pl-mode', host);
  const cols = $('#pl-cols', host);
  const list = $('#pl-collist', host);
  const count = $('#pl-colcount', host);
  const boxes = () => $$('#pl-collist input[data-col]', host);
  const picked = () => boxes().filter((b) => b.checked).map((b) => b.dataset.col);
  const colByName = (n) => detail.pendingColumns.find((x) => x.columnName === n);

  const MODE_NOTE = {
    columns: () => '',
    table: () => note('info', 'CONVERT TO ทั้งตาราง',
      'คำสั่งเดียวแปลงคอลัมน์ข้อความทุกคอลัมน์ของตารางนี้ รวมคอลัมน์ที่ยังพิสูจน์ไม่ได้ว่าจะไม่เสียตัวอักษรด้วย '
      + 'ให้ใช้ต่อเมื่อสแกนขั้น 1 ผ่านแบบดูครบทั้งตารางแล้วเท่านั้น'),
    defaults: () => note('info', 'แก้แค่ metadata ไม่เขียนข้อมูลใหม่',
      'จะได้แค่ <code>ALTER TABLE … DEFAULT CHARACTER SET</code> และ <code>ALTER DATABASE …</code> ถ้าติ๊กไว้ในตัวเลือกขั้นสูง '
      + 'ทำงานทันที ไม่ rebuild ไม่ล็อกการเขียน คอลัมน์เดิมยังเป็น charset/collation เดิมครบทุกคอลัมน์ '
      + `ตารางและคอลัมน์ที่สร้าง<strong>หลังจากนี้</strong>จะได้ <code>${esc(state.target.charset)} / ${esc(state.target.collation)}</code> เป็นค่าตั้งต้นเอง `
      + 'ข้อแลกเปลี่ยนคือตารางจะมี charset ปนกัน การ JOIN ระหว่างคอลัมน์เก่ากับคอลัมน์ใหม่ยังชนกันเรื่อง collation อยู่'),
  };

  const sync = () => {
    // The picker is honest only while MODIFY COLUMN does the work: CONVERT TO
    // rewrites every column whatever is ticked, and the metadata-only mode
    // rewrites none of them.
    if (cols) cols.hidden = mode.value !== 'columns';
    // Metadata-only has nothing to back up: rollback is the one ALTER that put
    // the old default back, and it never touched a row.
    const adv = $('#pl-advanced', host);
    if (adv) adv.hidden = mode.value === 'defaults';
    const mn = $('#pl-modenote', host);
    if (mn) mn.innerHTML = MODE_NOTE[mode.value]();
    if (count) count.textContent = `${picked().length}/${boxes().length}`;
  };

  /** Tick from scratch. Runs again when a scan result lands, because the scan
   *  is half of what decides which columns are safe. */
  const applyDefaults = () => {
    if (list) list.innerHTML = columnPickerRows();
    const verdicts = detail.pendingColumns.map((c) => columnSafety(c));
    const held = verdicts.filter((v) => !v.tick).length;
    const onEvidence = verdicts.filter((v) => v.tick && !v.proven).length;
    const tb = lastScan();
    const noteBox = $('#pl-colnote', host);
    if (noteBox) {
      // Two different things an operator needs to know, and they are not the
      // same sentence: what was left out, and what was ticked on evidence
      // rather than on proof. The second one is the riskier half, so it leads.
      const parts = [];
      if (onEvidence) {
        parts.push(note('warn', `ติ๊กให้ ${onEvidence} คอลัมน์จากการสุ่มตรวจ`,
          `สแกนล่าสุดดูไป ${num(tb ? tb.scannedRows : 0)} แถวแรก ไม่ครบทั้งตาราง แล้วไม่เจอตัวอักษรที่ `
          + `<code>${esc(state.target.charset)}</code> เก็บไม่ได้ คอลัมน์ที่ติ๊กให้เป็นคีย์ อยู่ใน index `
          + `หรือเป็น char/varchar ยาวไม่เกิน ${SHORT_CODE_LEN} ตัวอักษร จึงเก็บรหัสหรือสถานะ ไม่ใช่ข้อความอิสระ `
          + '— แต่แถวที่เหลือยังไม่ได้ดูจริงๆ '
          + 'ถ้าตารางนี้สำคัญ ให้กลับไปสแกนแบบดูครบทั้งตารางที่ขั้น 1 ก่อนรัน'));
      }
      if (held) {
        parts.push(note('info', `เว้นไว้ ${held} คอลัมน์`,
          !tb
            ? 'ยังไม่มีผลสแกนของตารางนี้ ไปที่ขั้น 1 แล้วสแกนก่อน ติ๊กเองได้ถ้ารู้ว่าข้อมูลข้างในปลอดภัย'
            : 'เป็นข้อความอิสระที่ยังพิสูจน์ไม่ได้ หรือสแกนแล้วเจอแถวที่จะเสียตัวอักษรจริง '
              + 'เปิดดูเหตุผลรายคอลัมน์ได้จากการชี้ค้างที่ชื่อคอลัมน์ ติ๊กเองได้ถ้ารู้ว่าข้อมูลข้างในปลอดภัย'));
      }
      noteBox.innerHTML = parts.join('');
    }
    sync();
  };

  mode.addEventListener('change', () => {
    // The point of this mode is that whatever gets created from here on is
    // born with the target default - which is the schema's job as much as the
    // table's. Tick it where the operator can see it happen and untick it.
    if (mode.value === 'defaults') {
      const sd = $('#pl-schemadef', host);
      if (sd) sd.checked = true;
    }
    sync();
  });
  if (cols) {
    // Delegated: applyDefaults swaps the rows out from under any listener
    // bound to an individual checkbox.
    cols.addEventListener('change', (e) => { if (e.target.matches('input[data-col]')) sync(); });
    cols.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      const how = b.dataset.pick;
      for (const box of boxes()) {
        const col = colByName(box.dataset.col);
        const safe = !!col && columnSafety(col).tick;
        box.checked = how === 'all' ? true
          : how === 'none' ? false
            : how === 'safe' ? safe
              : safe && isWired(col);
      }
      sync();
      // A pick that ticks nothing looks identical to a button that does
      // nothing. Say which it was.
      if (how !== 'none' && boxes().length && !picked().length) {
        const wired = detail.pendingColumns.filter(isWired).length;
        const tb = lastScan();
        const evidence = !tb
          ? ' — ยังไม่มีผลสแกนของตารางนี้ ไปสแกนที่ขั้น 1 ก่อน'
          : tb.coverage !== 'full'
            ? ` — สแกนล่าสุดดูไปแค่ ${num(tb.scannedRows)} แถวแรก ต้องสแกนครบทั้งตารางถึงจะพิสูจน์ได้`
            : '';
        toast((how === 'keys' && !wired
          ? 'ตารางนี้ไม่มีคอลัมน์ข้อความที่เป็นคีย์หรืออยู่ใน index'
          : how === 'keys'
            ? `มีคอลัมน์คีย์/index อยู่ ${wired} คอลัมน์ แต่ยังไม่มีอันไหนพิสูจน์ได้ว่าแปลงแล้วไม่เสียตัวอักษร`
            : `ยังไม่มีคอลัมน์ไหนพิสูจน์ได้ว่าแปลงเป็น ${state.target.charset} ได้โดยไม่เสียตัวอักษร`) + evidence,
        'warn', 9000);
      }
    });
  }
  applyDefaults();

  btn.addEventListener('click', () => {
    const m = mode.value;
    startPlan(host, {
      // Converting nothing is a real answer, not a missing one: an empty
      // column list is exactly what reduces the plan to the metadata-only
      // pair of ALTERs that the "defaults" mode promises.
      strategy: m === 'table' ? 'convert_table' : 'modify_columns',
      columns: m === 'columns' ? picked() : m === 'defaults' ? [] : undefined,
      backupStrategy: m === 'defaults' ? 'none' : $('#pl-backup', host).value,
      includeSchemaDefaults: $('#pl-schemadef', host).checked,
      includeTableDefaults: true,
      order: 'size_asc',
    });
  });
}

/**
 * The column list the "ที่แนะนำ" button would tick, computed without it.
 *
 * Same predicate the picker uses (`columnSafety().tick`), so the automated run
 * converts exactly the set an operator would see pre-ticked - no more. It reads
 * the scan out of the store, so it is only meaningful once step 1 has landed.
 */
function recommendedColumns() {
  return detail.pendingColumns.filter((c) => columnSafety(c).tick).map((c) => c.columnName);
}

/** Build the plan and resolve with it, or with null when the request failed. */
async function startPlan(host, body) {
  const btn = $('#pl-build', host);
  const status = $('#pl-status', host);
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'กำลังสร้างคำสั่ง…';
  try {
    const { planId, plan } = await api.plan(tableBody(key, body));
    setTableState(key, { planId, planAt: new Date().toISOString(), jobId: null, jobStatus: null });
    cache('plan', planId, plan);
    redraw();
    toast(`สร้างให้แล้ว ${plan.steps.length} คำสั่ง`, 'ok');
    return { planId, plan };
  } catch (err) {
    toast(err.message, 'err', 9000);
    return null;
  } finally {
    // Re-queried: redraw() above swaps these nodes out from under us.
    const b = $('#pl-build', host);
    if (b) b.disabled = false;
    const s = $('#pl-status', host);
    if (s) s.textContent = '';
  }
}

/**
 * The ready-to-run fix attached to a risk, when there is one.
 *
 * Printed in full rather than summarised: it names a constraint, two tables and
 * two column definitions that all have to match what is already in the
 * database, and an operator retyping any of that from a description is how a
 * NOT NULL or a DEFAULT goes missing.
 */
function repairScript(risk) {
  if (!risk.repair || !risk.repair.length) return '';
  return risk.repair.map((r, i) => `
    <div class="row-tight"><strong class="hint">คำสั่งแก้ ${esc(r.constraint)}</strong>
      <button class="btn-sm btn-ghost" data-copy-repair="${esc(risk.code)}-${i}">คัดลอก</button></div>
    <pre class="sql" id="repair-${esc(risk.code)}-${i}">${esc(r.sql)}</pre>`).join('');
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
          ${s.risks.map((r) => note(levelKind(r.level), r.code, esc(r.message) + repairScript(r))).join('')}
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
  for (const b of $$('[data-copy-repair]', box)) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const pre = $(`#repair-${b.dataset.copyRepair}`, box);
      if (pre) copyToClipboard(pre.textContent);
    });
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

/**
 * @param {object}  opts
 * @param {boolean} opts.auto  the run was authorised once, up front, by the
 *   one-button runner. It suppresses the per-run dialog - but ONLY for the
 *   plain `RUN` case. The two situations that escalate the dialog to `FORCE`
 *   are refused outright below rather than waved through: the runner is
 *   supposed to have stopped long before here, and if it ever does not, the
 *   answer is still no.
 * @returns {Promise<string|null>} the job's terminal status, or null when
 *   nothing was started.
 */
async function startRun(host, dryRun, { auto = false } = {}) {
  const st = tableState(key);
  let plan;
  try { plan = await fetchPlan(st.planId); } catch (err) { toast(err.message, 'err'); return null; }
  if (!plan) { toast('ยังไม่ได้สร้างคำสั่ง', 'warn'); return null; }

  // A preflight that skipped the table proves nothing. The server refuses the
  // run in that case unless the caller acknowledges it, so ask here rather
  // than letting the operator hit a 412 they cannot interpret.
  const unscanned = st.preflightScanned === false;
  const needsForce = st.preflightGate === 'block' || unscanned;

  if (auto && !dryRun && needsForce) {
    toast('หยุดไว้ก่อน: ตารางนี้ต้องยืนยันด้วยการพิมพ์ FORCE จึงรันอัตโนมัติให้ไม่ได้', 'err', 12000);
    return null;
  }

  if (!dryRun && !auto) {
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
    if (!ok) return null;
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
    return await watchJob(host, job.id, dryRun);
  } catch (err) {
    toast(err.message, 'err', 10000);
    return null;
  }
}

/** Resolves with the job's terminal status. See watchTask for why. */
function watchJob(host, id, dryRun = false) {
  return new Promise((resolve) => {
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
        resolve(job.status);
      }
    }, 1200, runLabel(dryRun));
  });
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

/** Start step 5 and resolve with its terminal status. See startPreflight. */
async function startVerify(host) {
  const st = tableState(key);
  const btn = $('#vf-run', host);
  if (btn) btn.disabled = true;
  let task;
  try {
    task = await api.checksumVerify(st.checksumId, {});
  } catch (err) {
    toast(err.message, 'err', 9000);
    if (btn) btn.disabled = false;
    return { status: 'failed', error: err.message };
  }
  setTableState(key, { verifyId: task.id, verifyOk: null });
  return new Promise((resolve) => {
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
      const b = $('#vf-run', host);
      if (b) b.disabled = false;
      // Same ordering rule as watchTask: the verdict reaches the store inside
      // loadVerify, so resolve after it, not before.
      await loadVerify(host, task.id, true);
      resolve({ status: x.status });
    }, 1200, 'กำลังเทียบกับ baseline');
    setBusy(true, 'กำลังเทียบกับ baseline', {
      onCancel: () => {
        api.checksumCancel(task.id).catch(() => { /* already gone */ });
        toast('สั่งยกเลิกแล้ว', 'info');
      },
    });
  });
}

function wireVerify(host) {
  const btn = $('#vf-run', host);
  if (!btn) return;
  btn.addEventListener('click', () => startVerify(host));
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
  // "Could not be compared" is not "did not match", and the difference decides
  // whether an operator rolls a working migration back.
  const incomparable = cmp.comparable === false;
  box.innerHTML = ok
    ? note('ok', 'ข้อมูลยังเหมือนเดิม', cmp.caveat
      ? `ค่าและจำนวนแถวเท่าเดิม <strong>แต่ดูแค่บางส่วน:</strong> ${esc(cmp.caveat)}`
      : 'ค่าและจำนวนแถวเท่าเดิมทุกตัว การแปลงไม่ได้ทำให้ตัวอักษรไหนเปลี่ยน')
    : incomparable
      ? note('warn', 'เทียบไม่ได้ ไม่ใช่ว่าข้อมูลเปลี่ยน', `<ul>${cmp.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        <strong>ยังไม่มีเหตุผลให้ย้อนกลับ</strong> — สิ่งที่ขาดคือ baseline ที่ใช้เทียบได้
        กลับไปขั้น 2 เก็บใหม่ด้วยวิธีที่เบากว่า แล้วค่อยมาเทียบอีกครั้ง`)
      : appended
        ? note('warn', `มีแถวเพิ่มมา ${num(appended)} แถวหลังเก็บ baseline`, `
          ตารางนี้ยังรับ write อยู่ระหว่างที่ทำงาน การเทียบแบบนับแถวจึงบอกได้แค่ว่าจำนวนแถวขยับ
          ไม่ได้บอกว่าข้อมูลเดิมเปลี่ยน${jobVerdictLine()}`)
        : note('crit', 'ข้อมูลไม่ตรงกับ baseline', `<ul>${cmp.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
          ถ้าจะย้อนกลับ ไปที่หน้า “งานที่รันไปแล้ว”`);
  if (announce) {
    toast(ok ? 'เรียบร้อย ข้อมูลยังเหมือนเดิม'
      : incomparable ? 'เทียบไม่ได้ เพราะ baseline เก็บไม่สำเร็จ'
        : appended ? `มีแถวเพิ่มมา ${num(appended)} แถวหลัง baseline`
          : 'ข้อมูลไม่ตรงกับ baseline', ok ? 'ok' : incomparable || appended ? 'warn' : 'err', 9000);
  }
}
