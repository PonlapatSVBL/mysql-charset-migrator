// Working through the queue nobody has time to click.
//
// The console refuses a scan, a plan or a job that covers more than one table,
// and that refusal is not negotiable - it is what keeps a bad table from taking
// a whole run with it. So this does not ask for a bulk operation. It drives the
// ordinary one-table flow, one table at a time, in the order the work list is
// already showing: preflight, baseline, plan, run, verify, next.
//
// Every safety property of doing it by hand therefore survives. Each table gets
// its own preflight gate, its own baseline, its own plan with its own risks,
// its own job with its own rollback. What is gone is only the clicking.
//
// The one thing a human was doing that this cannot do is READ the plan. So
// where an operator would have exercised judgement, this stops instead: a
// preflight that blocks, a baseline that failed, a plan carrying any critical
// risk, a column set that came back empty - all of them skip the table and
// record why. Nothing here forces, overrides or acknowledges anything away.
import { api, state } from './api.js';
import { tableBody, invalidateInventory } from './store.js';
import { scanFromResult, recommendedColumns } from './columns.js';

/** How long to wait between polls of a running task. */
const POLL_MS = 1500;

const num = (n) => Number(n || 0).toLocaleString('en-US');

export const auto = {
  running: false,
  stopping: false,
  limits: null,
  queue: [],        // { key, schemaName, tableName, sizeBytes, approxRows }
  results: [],      // { key, outcome, reason, ids }
  at: -1,           // index into queue currently being worked
  phase: '',        // what the current table is doing right now
  inflight: null,   // { kind: 'preflight'|'checksum'|'job', id } - for cancel
  startedAt: null,
  finishedAt: null,
};

let notify = () => {};

const OUTCOME = {
  converted: 'แปลงแล้ว',
  nothing: 'ไม่มีอะไรต้องทำ',
  skipped: 'ข้าม',
  failed: 'ล้มเหลว',
  attention: 'ต้องดูเอง',
};

export function outcomeLabel(o) {
  return OUTCOME[o] || o;
}

/** Which tables the limits let through, and why the rest are out. */
export function applyLimits(rows, limits) {
  const maxBytes = Number(limits.maxSizeMb) * 1024 * 1024;
  const maxRows = Number(limits.maxRows);
  const eligible = [];
  const excluded = [];
  for (const r of rows) {
    const tooBig = maxBytes > 0 && Number(r.sizeBytes || 0) > maxBytes;
    const tooMany = maxRows > 0 && Number(r.approxRows || 0) > maxRows;
    if (tooBig || tooMany) {
      excluded.push({
        ...r,
        reason: [tooBig ? 'ใหญ่เกินเพดาน' : '', tooMany ? 'แถวเกินเพดาน' : ''].filter(Boolean).join(' · '),
      });
    } else {
      eligible.push(r);
    }
  }
  return { eligible, excluded };
}

/**
 * The one critical risk a passing preflight has already answered.
 *
 * `lossy_narrowing` fires on every utf8mb4 -> utf8mb3 table, because that is
 * what this tool does: it says characters outside the target would become '?'
 * and that a scan should be run before trusting it. The scan HAS been run by
 * the time a plan exists here, and a gate of anything but 'block' is its
 * answer. Treating it as unresolved would skip every table on the instance,
 * which is not caution - it is the feature refusing to do its job.
 *
 * Nothing else is waived. index_too_long, row_too_large and
 * fk_charset_mismatch all mean MySQL will reject the statement, and no scan
 * speaks to any of them.
 */
const ANSWERED_BY_PREFLIGHT = new Set(['lossy_narrowing']);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Poll a task to a terminal state, or until the operator stops the run. */
async function awaitTask(kind, id, get) {
  auto.inflight = { kind, id };
  try {
    for (;;) {
      let task;
      try { task = await get(id, false); } catch { await sleep(POLL_MS); continue; }
      if (task.status !== 'running') return task;
      if (auto.stopping) return { ...task, stoppedByOperator: true };
      await sleep(POLL_MS);
    }
  } finally {
    auto.inflight = null;
  }
}

async function awaitJob(id) {
  auto.inflight = { kind: 'job', id };
  const TERMINAL = new Set(['done', 'failed', 'cancelled', 'rolled_back']);
  try {
    for (;;) {
      let job;
      try { job = await api.job(id); } catch { await sleep(POLL_MS); continue; }
      if (TERMINAL.has(job.status)) return job;
      await sleep(POLL_MS);
    }
  } finally {
    auto.inflight = null;
  }
}

/**
 * One table, all five steps. Returns the record that goes in the report.
 *
 * Reads as a straight line on purpose: every early return is a decision a
 * person would otherwise have had to make, and naming them in order is the
 * clearest statement of what this will and will not do on its own.
 */
async function runOne(row) {
  const { schemaName, tableName, key } = row;
  const ids = {};
  const done = (outcome, reason) => ({ key, outcome, reason, ids });

  auto.phase = 'อ่านโครงสร้าง';
  notify();
  const detail = await api.tableDetail(schemaName, tableName);
  if (!detail.facts.needsChange) return done('nothing', 'ตารางนี้ตรง target อยู่แล้ว');

  // --- 1 preflight --------------------------------------------------------
  auto.phase = 'ตรวจข้อมูล';
  notify();
  const pf = await api.preflight(tableBody(key, {
    rowLimit: undefined, sampleSize: 5, checkUnique: true, checkDoubleEncoding: true,
  }));
  ids.preflightId = pf.id;
  const pfTask = await awaitTask('preflight', pf.id, api.preflightGet);
  if (pfTask.stoppedByOperator) return done('skipped', 'ผู้ใช้สั่งหยุดระหว่างสแกน');
  if (pfTask.status !== 'done') return done('skipped', `สแกนไม่สำเร็จ: ${pfTask.error || pfTask.status}`);

  const full = await api.preflightGet(pf.id, true);
  const result = full.result || {};
  if (result.gate === 'block') {
    return done('skipped', 'preflight บล็อก: ถ้าแปลงตอนนี้ข้อมูลจะเสียถาวร ต้องแก้ข้อมูลก่อน');
  }
  const scan = scanFromResult((result.tables || [])[0]);

  // --- 2 baseline ---------------------------------------------------------
  auto.phase = 'เก็บ baseline';
  notify();
  const cs = await api.checksum(tableBody(key, { mode: 'sha256', strategy: 'auto' }));
  ids.checksumId = cs.id;
  const csTask = await awaitTask('checksum', cs.id, api.checksumGet);
  if (csTask.stoppedByOperator) return done('skipped', 'ผู้ใช้สั่งหยุดระหว่างเก็บ baseline');
  if (csTask.status !== 'done') return done('skipped', `เก็บ baseline ไม่สำเร็จ: ${csTask.error || csTask.status}`);
  const csFull = await api.checksumGet(cs.id, true);
  const csTable = ((csFull.result || {}).tables || {})[key];
  if (!csTable || csTable.error || csTable.digest === null || csTable.digest === undefined) {
    // Without a baseline there is nothing to verify against afterwards, which
    // is most of the reason to trust an unattended run at all.
    return done('skipped', `เก็บ baseline ไม่สำเร็จ: ${(csTable && csTable.error) || 'ไม่ได้ค่า digest'}`);
  }

  // --- 3 plan -------------------------------------------------------------
  auto.phase = 'สร้างคำสั่ง';
  notify();
  const columns = recommendedColumns(detail.pendingColumns, scan, state.target.charset);
  if (!columns.length && detail.pendingColumns.length) {
    return done('skipped', 'ไม่มีคอลัมน์ไหนที่พิสูจน์ได้ว่าแปลงแล้วไม่เสียตัวอักษร');
  }
  const { planId, plan } = await api.plan(tableBody(key, {
    strategy: 'modify_columns',
    columns,
    backupStrategy: auto.limits.backupStrategy || 'none',
    includeSchemaDefaults: false,
    includeTableDefaults: true,
    order: 'size_asc',
  }));
  ids.planId = planId;
  if (!plan.steps.length) return done('nothing', 'แผนว่าง ไม่มีคำสั่งต้องรัน');
  const criticals = plan.steps
    .flatMap((s) => (s.risks || []).filter((r) => r.level === 'critical'))
    .filter((r) => !ANSWERED_BY_PREFLIGHT.has(r.code));
  if (criticals.length) {
    // Everything left is a statement that the ALTER will be rejected or will
    // lose data. Reading past one is exactly the judgement call this must not
    // make on its own.
    return done('skipped', `แผนมีความเสี่ยงระดับ critical: ${[...new Set(criticals.map((r) => r.code))].join(', ')}`);
  }

  // --- 4 run --------------------------------------------------------------
  auto.phase = 'กำลังแปลง';
  notify();
  const job = await api.jobRun({
    planId,
    preflightId: pf.id,
    snapshotId: cs.id,
    verifyChecksum: true,
    backupStrategy: auto.limits.backupStrategy || 'none',
    autoRollbackOnFailure: true,
    stopOnError: true,
  });
  ids.jobId = job.id;
  const finished = await awaitJob(job.id);
  if (finished.status !== 'done') {
    return done('failed', `งานจบแบบ ${finished.status}${finished.error ? `: ${finished.error}` : ''}`);
  }

  // --- 5 verify -----------------------------------------------------------
  auto.phase = 'เทียบกับ baseline';
  notify();
  const vf = await api.checksumVerify(cs.id, tableBody(key));
  ids.verifyId = vf.id;
  const vfTask = await awaitTask('checksum', vf.id, api.checksumGet);
  if (vfTask.status !== 'done') return done('attention', `เทียบผลไม่สำเร็จ: ${vfTask.error || vfTask.status}`);
  const vfFull = await api.checksumGet(vf.id, true);
  const cmp = ((vfFull.result || {}).comparison || {})[key];
  if (!cmp) return done('attention', 'ไม่มีผลเทียบของตารางนี้');
  if (cmp.comparable === false) return done('attention', `เทียบไม่ได้: ${(cmp.issues || []).join(' ')}`);
  if (!cmp.ok) {
    return done('attention', Number(cmp.appended) > 0
      ? `แปลงแล้ว แต่มีแถวเพิ่มมา ${num(cmp.appended)} แถวหลังเก็บ baseline`
      : `แปลงแล้ว แต่ข้อมูลไม่ตรงกับ baseline: ${(cmp.issues || []).join(' ')}`);
  }
  return done('converted', cmp.caveat || 'ข้อมูลตรงกับ baseline');
}

/**
 * Work the queue. Resolves when the queue is exhausted or the operator stops.
 *
 * A table that throws is a skipped table, not a stopped run - that is the
 * whole point of the feature, and the reason every failure lands in `results`
 * rather than in a rejected promise.
 */
export async function startAuto({ queue, limits }, onChange) {
  if (auto.running) return;
  notify = onChange || (() => {});
  Object.assign(auto, {
    running: true,
    stopping: false,
    limits,
    queue,
    results: [],
    at: -1,
    phase: '',
    inflight: null,
    startedAt: Date.now(),
    finishedAt: null,
  });
  notify();

  try {
    for (let i = 0; i < queue.length; i++) {
      if (auto.stopping) break;
      auto.at = i;
      auto.phase = '';
      notify();
      let record;
      try {
        record = await runOne(queue[i]);
      } catch (err) {
        record = { key: queue[i].key, outcome: 'failed', reason: err.message, ids: {} };
      }
      auto.results.push(record);
      notify();
    }
  } finally {
    auto.at = -1;
    auto.phase = '';
    auto.running = false;
    auto.finishedAt = Date.now();
    // The run changed charsets across the instance; every derived list is stale.
    invalidateInventory();
    notify();
  }
}

/** Ask the run to stop. The table in flight finishes or is cancelled first. */
export async function stopAuto({ cancelCurrent = false } = {}) {
  auto.stopping = true;
  notify();
  if (!cancelCurrent || !auto.inflight) return;
  const { kind, id } = auto.inflight;
  try {
    if (kind === 'preflight') await api.preflightCancel(id);
    else if (kind === 'checksum') await api.checksumCancel(id);
    else if (kind === 'job') await api.jobCancel(id);
  } catch { /* already finishing on its own */ }
}

export function summarise(results) {
  const by = { converted: 0, nothing: 0, skipped: 0, failed: 0, attention: 0 };
  for (const r of results) by[r.outcome] = (by[r.outcome] || 0) + 1;
  return by;
}
