import { api } from '../api.js';
import { work } from '../store.js';

// Which job this view is showing. Seeded from the table currently open in the
// workspace so "ดูงานเต็มหน้า" lands on the right one.
let lastJobId = (work.current && work.byTable[work.current] && work.byTable[work.current].jobId) || null;
import { navigate } from '../app.js';
import {
  $, $$, esc, num, pct, bytes, duration, note, chip, toast, applyDynamicStyles,
  confirmDialog, localTime, levelKind,
} from '../util.js';

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
      <h2>งานในรอบนี้</h2>
      <p class="hint">งานที่สร้างจากโปรเซสที่กำลังทำงานอยู่ ควบคุมได้ (หยุดชั่วคราว / ยกเลิก / rollback)</p>
      <div id="job-list">${live.length ? jobTable(live, false) : '<div class="empty">รอบนี้ยังไม่ได้รันอะไร ไปเลือกตารางที่หน้า “ตารางที่ต้องแปลง” แล้วทำตามขั้นตอนได้เลย</div>'}</div>
      <div class="row-tight">
        <div class="spacer"></div>
        <button class="btn-sm btn-ghost" id="job-goplan">→ ไปหน้าแผน &amp; รัน</button>
        <button class="btn-sm" id="job-reload">รีเฟรชรายการ</button>
      </div>
    </div>

    ${archived.length ? `
    <div class="card">
      <h2>งานจากการรันรอบก่อน (archive)</h2>
      <p class="hint">อ่านจากไฟล์ manifest ใน data/jobs โปรเซสที่รันงานเหล่านี้ปิดไปแล้ว จึงสั่งควบคุมไม่ได้</p>
      ${jobTable(archived, true)}
    </div>` : ''}

    <div class="card">
      <h2>รายละเอียดงาน</h2>
      <div id="job-detail">${selectedId ? '<div class="loading">กำลังโหลด…</div>' : '<div class="empty">เลือกงานเพื่อดูรายละเอียด</div>'}</div>
    </div>`;

  applyDynamicStyles(host);
  $('#job-goplan', host).addEventListener('click', () => navigate('plan'));
  $('#job-reload', host).addEventListener('click', () => render(host, { jobId: selectedId }));
  for (const b of $$('[data-job]', host)) {
    b.addEventListener('click', () => selectJob(host, b.dataset.job));
  }

  dispose();
  if (selectedId) await renderDetail(host);
}

/* ------------------------------------------------------------------- list */

function jobTable(rows, archivedTable) {
  if (!rows.length) return '<div class="empty">ไม่มีรายการ</div>';
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>id</th><th>สร้างเมื่อ</th><th>สถานะ</th><th>ความคืบหน้า</th>
      <th>เป้าหมาย</th><th>ตัวเลือก</th><th></th>
    </tr></thead>
    <tbody>${rows.map((j) => {
    const p = j.progress || {};
    const t = j.target || {};
    return `<tr class="${j.status === 'failed' ? 'row-crit' : j.status === 'cancelled' || j.status === 'rolled_back' ? 'row-warn' : ''}">
        <td class="mono">${esc(j.id)}</td>
        <td class="nowrap">${esc(localTime(j.createdAt))}</td>
        <td class="nowrap"><span class="status-dot ${dotClass(j.status)}"></span> ${statusChip(j.status)}</td>
        <td>
          <div class="hint nowrap">${num(p.doneSteps)}/${num(p.totalSteps)} ขั้น${p.failedSteps ? ` · ล้ม ${num(p.failedSteps)}` : ''}</div>
          <div class="progress"><span data-width="${Number(p.pct) || 0}"></span></div>
        </td>
        <td class="mono nowrap">${esc(t.charset || '—')}<br>${esc(t.collation || '')}</td>
        <td>${optionChips(j.options || {})}</td>
        <td class="nowrap">
          <button class="btn-sm" data-job="${esc(j.id)}">ดู</button>
          ${archivedTable ? chip('archive', 'chip-none') : ''}
        </td>
      </tr>`;
  }).join('')}</tbody>
  </table></div>`;
}

function optionChips(o) {
  return [
    o.dryRun ? chip('dry run', 'chip-info') : '',
    chip(`backup: ${o.backupStrategy || 'none'}`, !o.backupStrategy || o.backupStrategy === 'none' ? 'chip-warn' : 'chip-ok'),
    o.verifyChecksum === false ? chip('ไม่ verify checksum', 'chip-bad') : chip('verify checksum', 'chip-ok'),
    o.forced ? chip('forced', 'chip-bad') : '',
  ].join(' ');
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
      <div class="stat ${job.status === 'done' ? 'ok' : job.status === 'failed' ? 'crit' : job.status === 'cancelled' || job.status === 'rolled_back' ? 'warn' : ''}">
        <div class="k">สถานะ</div><div class="v">${esc(job.status)}</div>
        <div class="sub">${esc(localTime(job.createdAt))}</div>
      </div>
      <div class="stat">
        <div class="k">ความคืบหน้า</div><div class="v">${num(p.doneSteps)}/${num(p.totalSteps)}</div>
        <div class="sub">${esc(pct(p.pct))}${p.failedSteps ? ` · ล้มเหลว ${num(p.failedSteps)} ขั้น` : ''}</div>
      </div>
      <div class="stat">
        <div class="k">ข้อมูลที่เขียนใหม่</div><div class="v">${esc(bytes(p.doneBytes))}</div>
        <div class="sub">จาก ${esc(bytes(p.totalBytes))} · ${esc(pct(p.bytePct))}</div>
      </div>
      <div class="stat">
        <div class="k">เวลาที่ใช้</div><div class="v">${esc(duration(elapsedMs(job)))}</div>
        <div class="sub">${job.startedAt ? `เริ่ม ${esc(localTime(job.startedAt))}` : 'ยังไม่เริ่ม'}${job.finishedAt ? ` · จบ ${esc(localTime(job.finishedAt))}` : ''}</div>
      </div>
    </div>

    <div class="progress-wrap">
      <span class="status-dot ${dotClass(job.status)}"></span>
      <div class="progress"><span data-width="${Number(p.pct) || 0}"></span></div>
      <span class="hint nowrap">${esc(pct(p.pct))} · ${num(p.doneSteps)}/${num(p.totalSteps)} ขั้น</span>
    </div>

    ${job.throttle ? note('warn', 'ตัวรันกำลังรอให้โหลดของเซิร์ฟเวอร์ลดลง', `
      ยังไม่เริ่ม rebuild ขั้นถัดไปจนกว่าเซิร์ฟเวอร์จะว่างพอ (ป้องกันการทำ production ช้า)
      <code>Threads_running = ${num(job.throttle.threadsRunning)}</code>
      · replica lag = <code>${job.throttle.lagSec === null || job.throttle.lagSec === undefined ? 'ไม่มี replica' : `${num(job.throttle.lagSec)} วินาที`}</code>
      · รอมาแล้ว ${esc(duration(Date.now() - Number(job.throttle.since || Date.now())))}`) : ''}

    ${isArchived
    ? note('info', 'งานย้อนหลัง', 'งานนี้รันจากรอบก่อนที่ปิดไปแล้ว ดูย้อนหลังได้อย่างเดียว สั่งหยุดหรือย้อนกลับไม่ได้ ถ้าจะย้อนจริงๆ ให้ใช้ SQL rollback ของแต่ละขั้นด้านล่าง')
    : `<div class="row-tight">
        <button class="btn-sm" id="job-pause" ${isLive && job.status !== 'rolling_back' ? '' : 'disabled'}>${job.paused ? '▶ ทำต่อ' : '⏸ หยุดชั่วคราว'}</button>
        <button class="btn-sm btn-danger" id="job-cancel" ${isLive && job.status !== 'rolling_back' ? '' : 'disabled'}>✕ ยกเลิกงาน</button>
        <div class="spacer"></div>
        <span class="hint">${isLive ? 'rollback ทำได้เมื่องานหยุดแล้ว' : 'rollback จะย้อนทุกขั้นที่สำเร็จ จากขั้นล่าสุดไปหาขั้นแรก'}</span>
        <button class="btn-sm btn-danger" id="job-rollback" ${isLive ? 'disabled' : ''}>↩ Rollback ทั้งงาน…</button>
      </div>`}

    <h4>ตัวเลือกและที่มาของงานนี้</h4>
    <div class="kv">
      <dt>target</dt><dd>${esc(t.charset)} / ${esc(t.collation)}</dd>
      <dt>preflight</dt><dd>${esc(job.preflightId || '— (ไม่ได้ผูก preflight)')}</dd>
      <dt>snapshot</dt><dd>${esc(job.snapshotId || '—')}</dd>
      <dt>connection</dt><dd>${esc((job.connection || {}).user)}@${esc((job.connection || {}).host)}:${esc((job.connection || {}).port)} · ${esc((job.connection || {}).server || '?')}</dd>
      ${Object.entries(o).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(fmtVal(v))}</dd>`).join('')}
    </div>

    <h4>ขั้นการทำงาน (${num(steps.length)})</h4>
    ${steps.length
    ? steps.map((s, i) => stepHtml(job, s, i, isArchived, isLive)).join('')
    : '<div class="empty">manifest นี้ไม่มีรายละเอียดขั้นการทำงาน</div>'}

    <h4>Log ของงาน (${num(entries.length)} รายการ)</h4>
    <div class="row-tight">
      <label class="check"><input type="checkbox" id="job-log-follow" ${followLog ? 'checked' : ''}> ติดตามอัตโนมัติ</label>
      <div class="spacer"></div>
      <span class="hint">เขียนแบบ NDJSON ที่ data/jobs/${esc(job.id)}.ndjson เรียงเก่า→ใหม่</span>
    </div>
    ${logPanel(entries)}`;
}

function banner(job) {
  const p = job.progress || {};
  if (job.status === 'done') {
    return p.failedSteps
      ? note('warn', `งานจบแล้ว แต่มี ${num(p.failedSteps)} ขั้นที่ล้มเหลว`, 'ตรวจแต่ละขั้นด้านล่าง และพิจารณา rollback เฉพาะขั้นที่มีปัญหา')
      : note('ok', 'เสร็จเรียบร้อย', `รันครบ ${num(p.doneSteps)} ขั้น ไม่มีขั้นไหนล้มเหลว`);
  }
  if (job.status === 'failed') {
    return note('crit', 'งานล้มเหลว', `<ul>
      <li>${esc(job.error || 'ไม่ทราบสาเหตุ')}</li>
      ${job.rollbackError ? `<li><strong>rollback ก็ล้มเหลว:</strong> ${esc(job.rollbackError)} ต้องเข้าไปตรวจฐานข้อมูลด้วยมือทันที</li>` : ''}
    </ul>`);
  }
  if (job.status === 'cancelled') {
    return note('warn', 'ยกเลิกโดยผู้ใช้', 'ขั้นที่รันไปแล้วยังเป็นสภาพหลังแปลงอยู่ ถ้าจะเอากลับเป็นแบบเดิมให้กด Rollback');
  }
  if (job.status === 'rolled_back') {
    return note('warn', 'ย้อนกลับแล้ว (rolled back)', `ขั้นที่ย้อนกลับถูกคืนสภาพตาม method ที่ระบุในแต่ละขั้น
      ${job.rollbackError ? `<br><strong>มีข้อผิดพลาดระหว่าง rollback:</strong> ${esc(job.rollbackError)}` : ''}`);
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
          <dt>เวลา ALTER</dt><dd>${esc(duration(s.alterDurationMs))}</dd>
          <dt>ประมาณการ</dt><dd>${s.estimate ? `${num(s.estimate.rows)} แถว · ${esc(bytes(s.estimate.bytes))} · rebuild: ${s.estimate.rebuild ? 'ใช่' : 'ไม่'}` : '—'}</dd>
          ${s.throttle ? `<dt>รอโหลดลด</dt><dd>${s.throttle.skipped ? 'ข้ามการรอ (ignoreLoad)' : `${esc(duration(s.throttle.waitedMs))} · Threads_running ${num(s.throttle.threadsRunning)}`}</dd>` : ''}
        </div>

        <div class="row-tight"><strong class="hint">FORWARD</strong></div>
        <pre class="sql">${esc(s.sql)}</pre>
        <div class="row-tight"><strong class="hint">ROLLBACK (เตรียมไว้ก่อนรัน)</strong></div>
        <pre class="sql rollback">${esc((s.rollbackSql || []).join('\n'))}</pre>

        ${backupBlock(s)}
        ${metaVerifyBlock(s)}
        ${rollbackBlock(s)}
        ${s.createTableBefore ? `
          <div class="row-tight"><strong class="hint">SHOW CREATE TABLE ก่อนรัน</strong></div>
          <pre class="sql small">${esc(s.createTableBefore)}</pre>` : ''}

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
      ? note('ok', 'ยืนยันแล้ว: ข้อมูลไม่เปลี่ยน', 'ค่าและจำนวนแถวหลังแปลง ตรงกับก่อนแปลงทุกตัว (แปลงเป็น utf8mb4 ก่อน hash เลยไม่ขึ้นกับ encoding)')
      : note('crit', 'checksum ไม่ตรงกันหลังแปลง ข้อมูลเปลี่ยน', `<ul>${(s.verify.issues || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          ${(s.verify.changedColumns || []).length ? `คอลัมน์ที่ข้อมูลเปลี่ยน: <code>${esc(s.verify.changedColumns.join(', '))}</code>` : ''}`))
    : note('info', 'ไม่มีผลเทียบ checksum', 'ขั้นนี้ไม่ได้เทียบ checksum เพราะเป็น metadata อย่างเดียว หรือเป็นการลองรัน หรือปิดการเทียบไว้');
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
    : note('warn', 'metadata ยังไม่ตรงเป้าหมายทั้งหมด', `อาจมีคอลัมน์ที่ตั้ง charset ไว้เฉพาะตัว หรือ table collation ไม่ถูกเปลี่ยน${body}`);
}

function backupBlock(s) {
  const b = s.backup;
  if (!b) return '';
  return note('info', `backup ก่อนรัน (${b.kind})`, `<div class="kv">
    ${b.backupTable ? `<dt>ตารางสำรอง</dt><dd>${esc(b.backupTable)}</dd>` : ''}
    ${b.file ? `<dt>ไฟล์</dt><dd>${esc(b.file)}</dd>` : ''}
    ${b.rows === undefined ? '' : `<dt>แถวที่สำรอง</dt><dd>${num(b.rows)}</dd>`}
    ${b.sizeBytes === undefined ? '' : `<dt>ขนาด</dt><dd>${esc(bytes(b.sizeBytes))}</dd>`}
    ${(b.restoreSql || []).length ? `<dt>คำสั่งคืนค่า</dt><dd>${esc(b.restoreSql.join(' '))}</dd>` : ''}
  </div>`);
}

function rollbackBlock(s) {
  const r = s.rollback;
  if (!r) return '';
  const verdict = r.verify
    ? (r.verify.ok
      ? note('ok', 'rollback ยืนยันแล้ว', 'ค่าหลัง rollback ตรงกับตอนก่อนแปลง ข้อมูลกลับมาเหมือนเดิมแล้ว')
      : note('crit', 'rollback แล้วข้อมูลยังไม่ตรงกับก่อนแปลง', `<ul>${(r.verify.issues || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`))
    : '';
  return `
    <div class="row-tight"><strong class="hint">ROLLBACK ที่ทำไปแล้ว</strong>${chip(r.status || '—', r.status === 'done' ? 'chip-ok' : r.status === 'failed' || r.status === 'verify_failed' ? 'chip-bad' : 'chip-info')}${r.method ? chip(r.method, 'chip-info') : ''}</div>
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
  if (!entries.length) return '<div class="empty">ยังไม่มี log ของงานนี้</div>';
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
