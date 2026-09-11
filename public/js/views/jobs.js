import { api } from '../api.js';
import { work } from '../store.js';

// Which job this view is showing. Seeded from the table currently open in the
// workspace so "ดูงานเต็มหน้า" lands on the right one.
let lastJobId = (work.current && work.byTable[work.current] && work.byTable[work.current].jobId) || null;
import {
  $, $$, esc, num, pct, bytes, duration, note, chip, toast, applyDynamicStyles,
  confirmDialog, localTime, levelKind, collapse, setBusy,
} from '../util.js';
import { timeline, timelineLegend } from '../charts.js';

const LIVE = new Set(['queued', 'running', 'paused', 'rolling_back']);

let timer = null;
let selectedId = null;
let followLog = true;
let openSteps = new Set();
let ticking = false;

export function dispose() {
  clearInterval(timer);
  timer = null;
  ticking = false;
  setBusy(false);
}

export async function render(host, params = {}) {
  const data = await api.jobs();
  const live = data.jobs || [];
  const archived = data.archived || [];
  const all = [...live, ...archived];

  const wanted = params.jobId || lastJobId || (all[0] ? all[0].id : null);
  selectedId = all.some((j) => j.id === wanted) ? wanted : (all[0] ? all[0].id : null);
  if (selectedId) lastJobId = selectedId;

  host.innerHTML = `
    <div class="card">
      <h2>งาน</h2>
      <div id="job-list">${all.length ? jobTable(live, archived) : '<div class="empty">ยังไม่มีงาน</div>'}</div>
      <div class="row-tight"><div class="spacer"></div>
        <button class="btn-sm" id="job-reload">รีเฟรช</button></div>
    </div>

    <div class="card">
      <h2>รายละเอียด</h2>
      <div id="job-detail">${selectedId ? '<div class="loading">กำลังโหลด…</div>' : '<div class="empty">เลือกงาน</div>'}</div>
    </div>`;

  applyDynamicStyles(host);
  $('#job-reload', host).addEventListener('click', () => render(host, { jobId: selectedId }));
  for (const b of $$('[data-job]', host)) {
    b.addEventListener('click', () => selectJob(host, b.dataset.job));
  }

  dispose();
  if (selectedId) await renderDetail(host);
}

/* ------------------------------------------------------------------- list */

function jobTable(live, archived) {
  const rows = [...live.map((j) => [j, false]), ...archived.map((j) => [j, true])];
  return `<div class="table-wrap"><table>
    <thead><tr><th>id</th><th>เมื่อ</th><th>สถานะ</th><th>คืบหน้า</th></tr></thead>
    <tbody>${rows.map(([j, arch]) => {
    const p = j.progress || {};
    return `<tr data-job="${esc(j.id)}" class="${j.status === 'failed' ? 'row-crit' : j.status === 'cancelled' || j.status === 'rolled_back' ? 'row-warn' : ''}">
        <td class="mono">${esc(j.id)}</td>
        <td class="nowrap">${esc(localTime(j.createdAt))}</td>
        <td class="nowrap"><span class="status-dot ${dotClass(j.status)}"></span> ${statusChip(j.status)}${arch ? chip('archive', 'chip-none') : ''}</td>
        <td>
          <div class="hint nowrap">${num(p.doneSteps)}/${num(p.totalSteps)}${p.failedSteps ? ` · ล้ม ${num(p.failedSteps)}` : ''}</div>
          <div class="progress"><span data-width="${Number(p.pct) || 0}"></span></div>
        </td>
      </tr>`;
  }).join('')}</tbody>
  </table></div>`;
}

function statusChip(status) {
  const map = {
    done: 'chip-ok',
    failed: 'chip-bad',
    cancelled: 'chip-warn',
    rolled_back: 'chip-warn',
    rolling_back: 'chip-warn',
    running: 'chip-info',
    queued: 'chip-info',
    paused: 'chip-info',
  };
  return chip(status || '—', map[status] || '');
}

/** Only a few dot modifiers exist in the stylesheet; map everything onto them. */
function dotClass(status) {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'rolled_back' || status === 'rolling_back') return 'rolled_back';
  if (status === 'pending' || status === 'queued' || status === 'cancelled' || status === 'skipped_dry_run') return 'pending';
  return 'running';
}

/* ----------------------------------------------------------------- detail */

async function selectJob(host, id) {
  dispose();
  selectedId = id;
  lastJobId = id;
  openSteps = new Set();
  await renderDetail(host);
}

function startPoll(host) {
  if (timer) return;
  timer = setInterval(() => { renderDetail(host); }, 1500);
}

async function renderDetail(host) {
  const box = $('#job-detail', host);
  if (!box || !selectedId || ticking) return;
  ticking = true;
  let job;
  let entries = [];
  try {
    job = await api.job(selectedId);
    entries = (await api.jobLog(selectedId).catch(() => ({ entries: [] }))).entries || [];
  } catch (err) {
    dispose();
    box.innerHTML = `<div class="note note-crit"><strong>โหลดงานไม่ได้</strong>${esc(err.message)}</div>`;
    return;
  } finally {
    ticking = false;
  }

  box.innerHTML = detailHtml(job, entries);
  applyDynamicStyles(box);
  wireDetail(host, box, job);

  // Same rule as the workspace: hold the page while something is actually
  // executing, and let go while it is paused or queued.
  const jp = job.progress || {};
  setBusy(!job.archived && (job.status === 'running' || job.status === 'rolling_back'),
    job.status === 'rolling_back' ? 'กำลัง rollback' : 'กำลังแปลงตาราง', {
      detail: `ขั้น ${num(jp.doneSteps)}/${num(jp.totalSteps)} · ${esc(pct(jp.pct))}`,
      cancelText: 'หยุดงาน',
      onCancel: () => {
        api.jobCancel(job.id).catch(() => { /* already finishing */ });
        toast('สั่งหยุดแล้ว ขั้นที่กำลังรันจะทำต่อจนจบก่อน', 'warn', 9000);
      },
    });
  if (LIVE.has(job.status) && !job.archived) startPoll(host);
  else dispose();
}

function detailHtml(job, entries) {
  const p = job.progress || {};
  const o = job.options || {};
  const t = job.target || {};
  const steps = job.steps || [];
  const isArchived = !!job.archived;
  const isLive = LIVE.has(job.status);

  return `
    <div class="row-tight">
      <span class="hint mono">${esc(job.id)}</span>
      ${statusChip(job.status)}
      ${job.paused ? chip('หยุดชั่วคราว', 'chip-warn') : ''}
      ${isArchived ? chip('archive', 'chip-none') : ''}
      <div class="spacer"></div>
      <span class="hint mono">${esc(t.charset)} / ${esc(t.collation)}</span>
    </div>

    ${banner(job)}

    <div class="grid grid-4">
      <div class="stat">
        <div class="k">ขั้น</div><div class="v">${num(p.doneSteps)}/${num(p.totalSteps)}</div>
        <div class="sub">${p.failedSteps ? `ล้ม ${num(p.failedSteps)}` : ''}</div>
      </div>
      <div class="stat">
        <div class="k">เขียนใหม่</div><div class="v">${esc(bytes(p.doneBytes))}</div>
        <div class="sub">/ ${esc(bytes(p.totalBytes))}</div>
      </div>
      <div class="stat">
        <div class="k">เวลา</div><div class="v">${esc(duration(elapsedMs(job)))}</div>
        <div class="sub">${esc(localTime(job.startedAt))}</div>
      </div>
    </div>

    <div class="progress-wrap">
      <span class="status-dot ${dotClass(job.status)}"></span>
      <div class="progress"><span data-width="${Number(p.pct) || 0}"></span></div>
      <span class="hint nowrap">${esc(pct(p.pct))}</span>
    </div>

    ${stepTimeline(steps)}

    ${job.throttle ? note('warn', 'รอโหลดเซิร์ฟเวอร์ลดลง', `
      <code>Threads_running ${num(job.throttle.threadsRunning)}</code>
      · lag ${job.throttle.lagSec === null || job.throttle.lagSec === undefined ? '—' : `${num(job.throttle.lagSec)}s`}
      · รอมา ${esc(duration(Date.now() - Number(job.throttle.since || Date.now())))}`) : ''}

    ${isArchived
    ? note('info', 'งานจากรอบก่อน', 'ดูได้อย่างเดียว สั่งงานไม่ได้ ถ้าต้องย้อนให้ใช้ SQL rollback ในแต่ละขั้น')
    : `<div class="row-tight">
        <button class="btn-sm" id="job-pause" ${isLive && job.status !== 'rolling_back' ? '' : 'disabled'}>${job.paused ? '▶ ทำต่อ' : '⏸ พัก'}</button>
        <button class="btn-sm btn-danger" id="job-cancel" ${isLive && job.status !== 'rolling_back' ? '' : 'disabled'}>✕ ยกเลิก</button>
        <div class="spacer"></div>
        <button class="btn-sm btn-danger" id="job-rollback" ${isLive ? 'disabled' : ''}>↩ Rollback ทั้งงาน…</button>
      </div>`}

    ${collapse('ตัวเลือก', `<div class="kv">
      <dt>target</dt><dd>${esc(t.charset)} / ${esc(t.collation)}</dd>
      <dt>preflight</dt><dd>${esc(job.preflightId || '—')}</dd>
      <dt>snapshot</dt><dd>${esc(job.snapshotId || '—')}</dd>
      <dt>connection</dt><dd>${esc((job.connection || {}).user)}@${esc((job.connection || {}).host)}:${esc((job.connection || {}).port)} · ${esc((job.connection || {}).server || '?')}</dd>
      ${Object.entries(o).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(fmtVal(v))}</dd>`).join('')}
    </div>`)}

    <h4>ขั้นการทำงาน (${num(steps.length)})</h4>
    ${steps.length
    ? steps.map((s, i) => stepHtml(job, s, i, isArchived, isLive)).join('')
    : '<div class="empty">ไม่มีรายละเอียดขั้น</div>'}

    ${collapse(`Log (${num(entries.length)})`, `
      <label class="check"><input type="checkbox" id="job-log-follow" ${followLog ? 'checked' : ''}> ตามอัตโนมัติ</label>
      ${logPanel(entries)}`)}`;
}

/**
 * Where the maintenance window actually went.
 *
 * A single completion percentage answers "how far", never "why so long". Four
 * things run inside the window per table - the backup copy, the two checksum
 * passes, and the ALTER everyone estimated for - and on a big table the ALTER
 * is regularly less than half of it. Next time's estimate comes from this
 * chart, not from the percentage above it.
 */
function stepTimeline(steps) {
  const rows = steps
    .map((s) => {
      const segments = [
        { kind: 'backup', ms: Number(s.backupDurationMs) || 0, label: 'สำรองข้อมูล' },
        { kind: 'checksum', ms: Number((s.checksumBefore || {}).durationMs) || 0, label: 'checksum ก่อน' },
        { kind: 'alter', ms: Number(s.alterDurationMs) || 0, label: 'ALTER' },
        { kind: 'checksum', ms: Number((s.checksumAfter || {}).durationMs) || 0, label: 'checksum หลัง' },
      ];
      const measured = segments.reduce((a, x) => a + x.ms, 0);
      // Whatever the step spent outside the four measured phases: waiting for
      // the server to go quiet, SHOW CREATE TABLE, metadata verification.
      const wall = s.startedAt && s.finishedAt
        ? new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime() : 0;
      if (wall > measured) segments.push({ kind: 'other', ms: wall - measured, label: 'รอคิว / ตรวจ metadata' });
      return { label: `${s.tableName || s.schemaName || s.kind}`, segments };
    })
    .filter((r) => r.segments.some((s) => s.ms > 0));

  if (!rows.length) return '';
  return `<h4>เวลาที่ใช้ในแต่ละขั้น</h4>
    ${timeline(rows)}
    ${timelineLegend([
    { kind: 'backup', label: 'สำรองข้อมูล' },
    { kind: 'checksum', label: 'checksum ก่อน/หลัง' },
    { kind: 'alter', label: 'ALTER' },
    { kind: 'other', label: 'รอคิว / ตรวจ metadata' },
  ])}`;
}

function banner(job) {
  const p = job.progress || {};
  if (job.status === 'done') {
    return p.failedSteps
      ? note('warn', `จบแล้ว แต่ล้ม ${num(p.failedSteps)} ขั้น`, 'ตรวจแต่ละขั้นด้านล่าง แล้ว rollback เฉพาะขั้นที่มีปัญหา')
      : note('ok', 'เสร็จเรียบร้อย', `${num(p.doneSteps)} ขั้น`);
  }
  if (job.status === 'failed') {
    return note('crit', 'งานล้มเหลว', `<ul>
      <li>${esc(job.error || 'ไม่ทราบสาเหตุ')}</li>
      ${job.rollbackError ? `<li><strong>rollback ก็ล้มเหลว:</strong> ${esc(job.rollbackError)} ต้องเข้าไปตรวจฐานข้อมูลด้วยมือทันที</li>` : ''}
    </ul>`);
  }
  if (job.status === 'cancelled') {
    return note('warn', 'ยกเลิกแล้ว', 'ขั้นที่รันไปแล้วยังอยู่ในสภาพหลังแปลง กด Rollback ถ้าต้องคืนสภาพ');
  }
  if (job.status === 'rolled_back') {
    return note('warn', 'ย้อนกลับแล้ว', `${job.rollbackError ? `<strong>มี error ระหว่าง rollback:</strong> ${esc(job.rollbackError)}` : 'คืนสภาพตาม method ของแต่ละขั้น'}`);
  }
  return '';
}

function elapsedMs(job) {
  if (!job.startedAt) return 0;
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  return Math.max(0, end - new Date(job.startedAt).getTime());
}

function fmtVal(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'เปิด' : 'ปิด';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ------------------------------------------------------------------ steps */

function stepHtml(job, s, i, isArchived, isLive) {
  const canRollback = !isArchived && !isLive && (s.status === 'done' || s.status === 'failed');
  return `
    <details class="step" data-step="${esc(s.id)}" ${openSteps.has(s.id) ? 'open' : ''}>
      <summary>
        <span class="status-dot ${dotClass(s.status)}"></span>
        ${statusChip(s.status)}
        <span class="chip ${s.metadataOnly ? 'chip-info' : ''}">${esc(s.kind)}</span>
        <span class="step-title">${i + 1}. ${esc(s.title)}</span>
        ${s.verify ? (s.verify.ok ? chip('checksum ตรง', 'chip-ok') : chip('checksum ไม่ตรง', 'chip-bad')) : ''}
        ${s.status === 'backing_up' && s.backupProgress
    ? chip(`สำรองแล้ว ${num(s.backupProgress.rows)} แถว`, 'chip-info') : ''}
        ${s.alterDurationMs ? chip(duration(s.alterDurationMs)) : ''}
        ${s.estimate ? chip(bytes(s.estimate.bytes)) : ''}
      </summary>
      <div class="step-body">
        ${(s.risks || []).map((r) => note(levelKind(r.level), r.code, esc(r.message))).join('')}
        ${(s.findings || []).map((f) => note(levelKind(f.level), f.code, esc(f.message))).join('')}
        ${s.error ? note('crit', 'ขั้นนี้ล้มเหลว', esc(s.error)) : ''}
        ${(s.warnings || []).length ? note('warn', `MySQL warnings (${num(s.warnings.length)})`, `<ul>${s.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`) : ''}
        ${verifyBlock(s)}

        <div class="kv">
          <dt>ตาราง</dt><dd>${esc(s.schemaName)}${s.tableName ? `.${esc(s.tableName)}` : ''}</dd>
          <dt>เริ่ม / จบ</dt><dd>${esc(localTime(s.startedAt))} → ${esc(localTime(s.finishedAt))}</dd>
          <dt>ALTER</dt><dd>${esc(duration(s.alterDurationMs))}</dd>
          <dt>ประมาณการ</dt><dd>${s.estimate ? `${num(s.estimate.rows)} แถว · ${esc(bytes(s.estimate.bytes))}${s.estimate.rebuild ? ' · rebuild' : ''}` : '—'}</dd>
          ${s.throttle ? `<dt>รอโหลด</dt><dd>${s.throttle.skipped ? 'ข้าม (ignoreLoad)' : `${esc(duration(s.throttle.waitedMs))} · Threads_running ${num(s.throttle.threadsRunning)}`}</dd>` : ''}
        </div>

        <div class="row-tight"><strong class="hint">FORWARD</strong></div>
        <pre class="sql">${esc(s.sql)}</pre>
        <div class="row-tight"><strong class="hint">ROLLBACK</strong></div>
        <pre class="sql rollback">${esc((s.rollbackSql || []).join('\n'))}</pre>

        ${backupBlock(s)}
        ${metaVerifyBlock(s)}
        ${rollbackBlock(s)}
        ${s.createTableBefore ? collapse('SHOW CREATE TABLE ก่อนรัน', `<pre class="sql small">${esc(s.createTableBefore)}</pre>`) : ''}

        ${canRollback ? `<div class="row-tight">
          <div class="spacer"></div>
          <button class="btn-sm btn-danger" data-rollback-step="${esc(s.id)}">↩ Rollback เฉพาะขั้นนี้…</button>
        </div>` : ''}
      </div>
    </details>`;
}

function verifyBlock(s) {
  const b = s.checksumBefore;
  const a = s.checksumAfter;
  if (!b && !a && !s.verify) return '';
  const verdict = s.verify
    ? (s.verify.ok
      ? note('ok', 'ข้อมูลไม่เปลี่ยน', 'checksum และจำนวนแถวตรงกับก่อนแปลง')
      : note('crit', 'checksum ไม่ตรง ข้อมูลเปลี่ยน', `<ul>${(s.verify.issues || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          ${(s.verify.changedColumns || []).length ? `คอลัมน์ที่ข้อมูลเปลี่ยน: <code>${esc(s.verify.changedColumns.join(', '))}</code>` : ''}`))
    : note('info', 'ไม่ได้เทียบ checksum', 'metadata อย่างเดียว / dry run / ปิดการเทียบไว้');
  return `${verdict}
    <div class="kv">
      <dt>โหมด</dt><dd>${esc((b && b.mode) || (a && a.mode) || '—')}</dd>
      <dt>จำนวนแถว</dt><dd>${b ? num(b.rowCount) : '—'} → ${a ? num(a.rowCount) : '—'}</dd>
      <dt>แถวที่สแกน</dt><dd>${b ? num(b.scannedRows) : '—'} → ${a ? num(a.scannedRows) : '—'}</dd>
      <dt>digest ก่อน</dt><dd>${esc((b && b.digest) || '—')}</dd>
      <dt>digest หลัง</dt><dd>${esc((a && a.digest) || '—')}</dd>
      <dt>เวลาคำนวณ</dt><dd>${esc(duration(b && b.durationMs))} + ${esc(duration(a && a.durationMs))}</dd>
    </div>`;
}

function metaVerifyBlock(s) {
  if (!s.metaVerify) return '';
  const obs = s.metaVerify.observed || {};
  const body = `<div class="kv">${Object.entries(obs).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(fmtVal(v))}</dd>`).join('')}</div>`;
  return s.metaVerify.ok
    ? note('ok', 'metadata ตรงเป้าหมาย', body)
    : note('warn', 'metadata ยังไม่ตรงทั้งหมด', `อาจมีคอลัมน์ที่ตั้ง charset เฉพาะตัว หรือ table collation ไม่ถูกเปลี่ยน${body}`);
}

/**
 * A running copy used to look exactly like a hung one. The chunked load
 * reports after every chunk, so while the step says `backing_up` there is a
 * row count that moves.
 */
function backupProgressBlock(s) {
  const p = s.backupProgress;
  if (!p || s.status !== 'backing_up') return '';
  return `<div class="progress-wrap">
    <span class="status-dot running"></span>
    <div class="progress"><span data-width="${Number(p.pct) || 0}"></span></div>
    <span class="hint nowrap">สำรองแล้ว ${num(p.rows)}${p.approxRows ? ` / ~${num(p.approxRows)}` : ''} แถว</span>
  </div>`;
}

function backupBlock(s) {
  const b = s.backup;
  if (!b) return backupProgressBlock(s);
  const counted = b.sourceRowsExact === true;
  return note('info', `backup ก่อนรัน (${b.kind})`, `<div class="kv">
    ${b.backupTable ? `<dt>ตารางสำรอง</dt><dd>${esc(b.backupTable)}</dd>` : ''}
    ${b.file ? `<dt>ไฟล์</dt><dd>${esc(b.file)}</dd>` : ''}
    ${b.rows === undefined ? '' : `<dt>แถวที่สำรอง</dt><dd>${num(b.rows)}</dd>`}
    ${b.sourceRows === undefined || b.sourceRows === null ? '' : `<dt>แถวต้นทาง</dt><dd>${num(b.sourceRows)}${counted ? '' : ' (ประมาณ)'}</dd>`}
    ${b.chunked === undefined ? '' : `<dt>วิธีคัดลอก</dt><dd>${b.chunked
    ? `${num(b.chunks)} ชุด × ${num(b.chunkRows)} แถว (ตาม primary key)`
    : 'คำสั่งเดียว (ไม่มี primary key จึงยกเลิกกลางทางไม่ได้)'}</dd>`}
    ${(b.deferredIndexes || []).length ? `<dt>index ที่สร้างทีหลัง</dt><dd>${esc(b.deferredIndexes.join(', '))}</dd>` : ''}
    ${b.sizeBytes === undefined ? '' : `<dt>ขนาด</dt><dd>${esc(bytes(b.sizeBytes))}</dd>`}
    ${(b.restoreSql || []).length ? `<dt>คำสั่งคืนค่า</dt><dd>${esc(b.restoreSql.join(' '))}</dd>` : ''}
  </div>
  ${b.consistent === false ? note('warn', 'จำนวนแถวไม่ตรงกัน', 'ตารางสำรองมีแถวไม่เท่าต้นทาง น่าจะมี write เข้ามาระหว่างคัดลอก') : ''}`);
}

function rollbackBlock(s) {
  const r = s.rollback;
  if (!r) return '';
  const verdict = r.verify
    ? (r.verify.ok
      ? note('ok', 'rollback ยืนยันแล้ว', 'ข้อมูลตรงกับก่อนแปลง')
      : note('crit', 'rollback แล้วข้อมูลยังไม่ตรง', `<ul>${(r.verify.issues || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`))
    : '';
  return `
    <div class="row-tight"><strong class="hint">ROLLBACK ที่ทำแล้ว</strong>${chip(r.status || '—', r.status === 'done' ? 'chip-ok' : r.status === 'failed' || r.status === 'verify_failed' ? 'chip-bad' : 'chip-info')}${r.method ? chip(r.method, 'chip-info') : ''}</div>
    ${r.error ? note('crit', 'rollback ล้มเหลว', esc(r.error)) : ''}
    ${r.note ? note('warn', 'ข้อจำกัดของ rollback นี้', esc(r.note)) : ''}
    ${verdict}
    <div class="kv">
      <dt>เหตุผล</dt><dd>${esc(r.reason || '—')}</dd>
      <dt>เริ่ม / จบ</dt><dd>${esc(localTime(r.startedAt))} → ${esc(localTime(r.finishedAt))}</dd>
      ${r.checksumAfterRollback ? `<dt>digest หลัง rollback</dt><dd>${esc(r.checksumAfterRollback.digest)}</dd>` : ''}
    </div>
    ${(r.statements || []).map((st) => `<pre class="sql rollback">${esc(st.sql)}\n-- ${esc(duration(st.durationMs))}${(st.warnings || []).length ? ` · ${esc(st.warnings.join(' | '))}` : ''}</pre>`).join('')}`;
}

/* -------------------------------------------------------------------- log */

function logPanel(entries) {
  if (!entries.length) return '<div class="empty">ยังไม่มี log</div>';
  return `<div class="table-wrap" id="job-log-wrap"><table>
    <thead><tr><th>เวลา</th><th>event</th><th>รายละเอียด</th></tr></thead>
    <tbody>${entries.map((e) => {
    const { ts, event, jobId, raw, ...rest } = e;
    const detail = raw !== undefined ? String(raw) : (Object.keys(rest).length ? JSON.stringify(rest) : '');
    return `<tr>
        <td class="mono nowrap">${esc(localTime(ts))}</td>
        <td>${chip(event || 'raw', eventKind(event))}</td>
        <td class="mono trunc" title="${esc(detail)}">${esc(detail)}</td>
      </tr>`;
  }).join('')}</tbody>
  </table></div>`;
}

function eventKind(event) {
  const e = String(event || '');
  if (/fail|error|mismatch|cancel/.test(e)) return 'chip-bad';
  if (/warn|throttle|pause/.test(e)) return 'chip-warn';
  if (/done|finish/.test(e)) return 'chip-ok';
  return 'chip-info';
}

/* ------------------------------------------------------------------ wiring */

function wireDetail(host, box, job) {
  for (const d of $$('details.step', box)) {
    d.addEventListener('toggle', () => {
      if (d.open) openSteps.add(d.dataset.step);
      else openSteps.delete(d.dataset.step);
    });
  }

  const follow = $('#job-log-follow', box);
  if (follow) {
    follow.addEventListener('change', () => {
      followLog = follow.checked;
      if (followLog) tailLog(box);
    });
  }
  if (followLog) tailLog(box);

  const pause = $('#job-pause', box);
  if (pause) {
    pause.addEventListener('click', async () => {
      pause.disabled = true;
      try {
        await api.jobPause(job.id, !job.paused);
        toast(job.paused ? 'สั่งให้ทำงานต่อ' : 'สั่งหยุดแล้ว จะหยุดให้หลังจบขั้นที่กำลังรันอยู่', 'info');
      } catch (err) { toast(err.message, 'err', 9000); }
      await renderDetail(host);
    });
  }

  const cancel = $('#job-cancel', box);
  if (cancel) {
    cancel.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'ยกเลิกงานนี้?',
        body: `<p>ขั้นที่กำลังรันอยู่จะทำต่อจนจบ (ALTER หยุดกลางทางไม่ได้) แล้วงานจะหยุดโดยไม่รันขั้นที่เหลือ</p>
          <p>ตารางที่แปลงไปแล้วจะ <strong>ยังอยู่ในสภาพที่แปลงแล้ว</strong> ถ้าต้องการคืนสภาพเดิมต้องกด Rollback อีกครั้งหลังงานหยุด</p>`,
        confirmText: 'ยกเลิกงาน',
        cancelText: 'ไม่ต้อง',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.jobCancel(job.id);
        toast('ส่งคำสั่งยกเลิกแล้ว', 'warn');
      } catch (err) { toast(err.message, 'err', 9000); }
      await renderDetail(host);
    });
  }

  const rollback = $('#job-rollback', box);
  if (rollback) rollback.addEventListener('click', () => doRollback(host, job, null));

  for (const b of $$('[data-rollback-step]', box)) {
    b.addEventListener('click', () => doRollback(host, job, b.dataset.rollbackStep));
  }
}

function tailLog(box) {
  const wrap = $('#job-log-wrap', box);
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

async function doRollback(host, job, stepId) {
  const steps = job.steps || [];
  const targets = stepId
    ? steps.filter((s) => s.id === stepId)
    : [...steps].reverse().filter((s) => s.status === 'done' || s.status === 'failed');
  if (!targets.length) { toast('ไม่มีขั้นที่ย้อนกลับได้', 'warn'); return; }

  const ok = await confirmDialog({
    title: stepId ? 'Rollback ขั้นนี้?' : `Rollback ${targets.length} ขั้น?`,
    body: `<p>ระบบจะย้อนกลับจากขั้นล่าสุดไปหาขั้นแรก โดยใช้สำเนาตาราง (RENAME) ถ้ามี ไม่งั้นใช้ inverse DDL
        แล้วเทียบ checksum กับค่าก่อนแปลงเพื่อยืนยัน</p>
      <div class="note note-crit"><strong>คำเตือน</strong>ถ้าอักขระถูกแทนด้วย <code>?</code> ไปแล้ว inverse DDL จะคืนได้แค่โครงสร้าง
        ข้อมูลต้อง restore จากไฟล์ backup ของขั้นนั้น</div>
      <div class="table-wrap"><table><thead><tr><th>ขั้น</th><th>สถานะ</th><th>backup</th></tr></thead>
      <tbody>${targets.map((s) => `<tr>
        <td class="mono">${esc(s.title)}</td>
        <td>${esc(s.status)}</td>
        <td class="mono">${esc(s.backup ? (s.backup.backupTable || s.backup.file || s.backup.kind) : 'ไม่มี')}</td>
      </tr>`).join('')}</tbody></table></div>`,
    confirmText: 'Rollback เดี๋ยวนี้',
    danger: true,
    requireText: 'ROLLBACK',
  });
  if (!ok) return;

  toast('เริ่ม rollback ห้ามปิดหน้านี้', 'warn', 9000);
  const pending = api.jobRollback(job.id, stepId ? [stepId] : undefined);
  startPoll(host); // status becomes rolling_back, so keep the panel live meanwhile
  try {
    await pending;
    toast('rollback เสร็จแล้ว ตรวจผล verify ในแต่ละขั้น', 'ok');
  } catch (err) {
    toast(`rollback ล้มเหลว: ${err.message}`, 'err', 12000);
  }
  await render(host, { jobId: job.id });
}
