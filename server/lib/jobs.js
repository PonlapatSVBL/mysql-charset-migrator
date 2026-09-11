'use strict';
/**
 * The execution engine: runs a reviewed plan one step at a time, with
 * checksum verification around every rebuild, load-aware throttling, and a
 * rollback path that is prepared BEFORE the first ALTER runs.
 *
 * Everything is written to data/jobs/<id>.{json,ndjson} as it happens, so a
 * crash mid-run still leaves a complete audit trail and a usable rollback.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../../config');
const log = require('./logger');
const queries = require('./queries');
const checksum = require('./checksum');
const sqlgen = require('./sqlgen');
const session = require('../session');
const { q, qq } = require('./ident');

const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'rolled_back']);

function newId(prefix = 'job') {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${t}-${crypto.randomBytes(3).toString('hex')}`;
}

function backupTableName(tableName, stamp) {
  const base = `_csmig_${stamp}_${tableName}`;
  return base.length <= 64 ? base : base.slice(0, 64);
}

function persist(job) {
  const snap = snapshot(job, { includeSteps: true });
  log.writeJson(config.paths.jobs, job.id, {
    ...snap,
    plan: job.plan,
    connection: { host: job.connection.host, port: job.connection.port, user: job.connection.user },
  });
}

/** Wait until the server is quiet enough to start a rebuild. */
async function waitForQuiet(conn, job, stepId) {
  const runner = { ...config.runner, ...(job.options.runner || {}) };
  if (job.options.ignoreLoad) return { ok: true, skipped: true };
  for (let attempt = 0; attempt < runner.throttleMaxWaits; attempt++) {
    if (job.cancelRequested) return { ok: false, cancelled: true };
    let threadsRunning = 0;
    try {
      const [rows] = await conn.query("SHOW GLOBAL STATUS LIKE 'Threads_running'");
      threadsRunning = Number((rows[0] && rows[0].Value) || 0);
    } catch { /* status unavailable - do not block on it */ }
    let lagSec = null;
    for (const stmt of ['SHOW REPLICA STATUS', 'SHOW SLAVE STATUS']) {
      try {
        const [rows] = await conn.query(stmt);
        if (rows.length) {
          const v = rows[0].Seconds_Behind_Source ?? rows[0].Seconds_Behind_Master;
          lagSec = v === null ? null : Number(v);
        }
        break;
      } catch { /* try the other spelling */ }
    }
    const quiet = threadsRunning <= runner.maxThreadsRunning
      && (lagSec === null || lagSec <= runner.maxReplicaLagSec);
    if (quiet) return { ok: true, threadsRunning, lagSec, waitedMs: attempt * runner.throttleWaitMs };
    job.throttle = { since: job.throttle?.since || Date.now(), threadsRunning, lagSec };
    log.jobLog(job.id, 'throttle.wait', { stepId, threadsRunning, lagSec, attempt });
    await sleep(runner.throttleWaitMs);
  }
  return { ok: false, timedOut: true };
}

async function waitWhilePaused(job) {
  while (job.pauseRequested && !job.cancelRequested) {
    job.status = 'paused';
    await sleep(500);
  }
  if (!job.cancelRequested && job.status === 'paused') job.status = 'running';
}

/** mysqldump-based backup. The password is passed via MYSQL_PWD so it never
 *  appears in the process command line. */
async function dumpTable(job, step) {
  const dir = path.join(config.paths.jobs, `${job.id}-backup`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${step.schemaName}.${step.tableName}.sql`);
  const sess = session.get(job.sessionId);
  if (!sess) throw new Error('session หมดอายุ ไม่สามารถทำ backup ได้');
  const password = session.revealPassword(sess, `mysqldump backup for job ${job.id}`);
  const isMariaDB = /mariadb/i.test(`${sess.serverInfo.version} ${sess.serverInfo.versionComment || ''}`);
  const args = [
    `--host=${sess.host}`, `--port=${sess.port}`, `--user=${sess.user}`,
    '--single-transaction', '--quick', '--hex-blob', '--routines=false', '--triggers=false',
    '--default-character-set=binary',
    // Both of these are MySQL-only: MariaDB's mysqldump rejects them outright.
    ...(isMariaDB ? [] : ['--set-gtid-purged=OFF', '--column-statistics=0']),
    '--add-drop-table', `--result-file=${file}`,
    step.schemaName, step.tableName,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('mysqldump', args, {
      env: { ...process.env, MYSQL_PWD: password },
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(`เรียก mysqldump ไม่ได้: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        resolve({ kind: 'mysqldump', file, sizeBytes: size });
      } else {
        reject(new Error(`mysqldump ล้มเหลว (exit ${code}): ${stderr.slice(-500)}`));
      }
    });
  });
}

/**
 * In-database shadow copy. Rollback becomes an atomic RENAME.
 *
 * Two limitations the operator must know about (both are in RUNBOOK 8.3):
 *  - CREATE TABLE ... LIKE copies indexes but NOT foreign keys, so a restored
 *    table needs its FKs re-added. We capture the source DDL here so the
 *    constraints can be read back off the job manifest.
 *  - the copy is not serialised against concurrent writes; the ALTER that
 *    follows takes at least a SHARED lock, but writes landing between the
 *    INSERT..SELECT and the ALTER would not be in the backup. Run inside a
 *    maintenance window if the table is written to continuously.
 */
async function copyTable(conn, job, step) {
  const bak = backupTableName(step.tableName, job.stamp);
  const src = qq(step.schemaName, step.tableName);
  const dst = qq(step.schemaName, bak);
  await conn.query(`CREATE TABLE ${dst} LIKE ${src}`);
  await conn.query(`INSERT INTO ${dst} SELECT * FROM ${src}`);

  const [[c]] = await conn.query(`SELECT COUNT(*) AS n FROM ${dst}`);
  const [[srcRows]] = await conn.query(`SELECT COUNT(*) AS n FROM ${src}`);

  // Preserve the counter: CREATE ... LIKE keeps the definition but a fresh
  // table restarts AUTO_INCREMENT from the highest copied value + 1, which
  // would hand out ids that the original had already reserved.
  let autoIncrement = null;
  const [[aiRow]] = await conn.query(
    `SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [step.schemaName, step.tableName]);
  if (aiRow && aiRow.ai !== null && aiRow.ai !== undefined) {
    autoIncrement = Number(aiRow.ai);
    try { await conn.query(`ALTER TABLE ${dst} AUTO_INCREMENT = ${autoIncrement}`); } catch { /* not critical */ }
  }

  const meta = job.tableMeta[`${step.schemaName}.${step.tableName}`];
  const foreignKeys = (meta && meta.foreignKeys ? meta.foreignKeys : [])
    .filter((f) => f.direction === 'outbound');
  const badName = backupTableName(`bad_${step.tableName}`, job.stamp);
  return {
    kind: 'table_copy',
    backupTable: `${step.schemaName}.${bak}`,
    rows: Number(c.n),
    sourceRows: Number(srcRows.n),
    consistent: Number(c.n) === Number(srcRows.n),
    autoIncrement,
    foreignKeysNotCopied: foreignKeys.length,
    restoreSql: [
      `RENAME TABLE ${src} TO ${qq(step.schemaName, badName)}, ${dst} TO ${src};`,
    ],
    restoreNotes: 'CREATE TABLE ... LIKE ไม่คัดลอก foreign key และ trigger — หลัง RENAME ต้องเพิ่มกลับจาก createTableBefore ในไฟล์ manifest',
  };
}

async function runStatement(conn, sql) {
  const started = Date.now();
  const [result] = await conn.query(sql);
  let warnings = [];
  try {
    const [w] = await conn.query('SHOW WARNINGS');
    warnings = w.map((r) => `${r.Level} ${r.Code}: ${r.Message}`);
  } catch { /* ignore */ }
  return { durationMs: Date.now() - started, info: result && result.info, warnings };
}

function tableMetaFor(job, step) {
  return job.tableMeta[`${step.schemaName}.${step.tableName}`] || null;
}

async function verifyMetadata(conn, job, step) {
  const target = job.plan.target;
  if (step.kind === 'schema_default') {
    const [rows] = await conn.query(
      `SELECT DEFAULT_CHARACTER_SET_NAME cs, DEFAULT_COLLATION_NAME co
         FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [step.schemaName]);
    const r = rows[0] || {};
    return { ok: r.cs === target.charset && r.co === target.collation, observed: r };
  }
  const [rows] = await conn.query(
    `SELECT t.TABLE_COLLATION co,
            SUM(c.CHARACTER_SET_NAME IS NOT NULL) txt,
            SUM(c.CHARACTER_SET_NAME = ? AND c.COLLATION_NAME = ?) okCols
       FROM information_schema.TABLES t
       LEFT JOIN information_schema.COLUMNS c
              ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ?
      GROUP BY t.TABLE_COLLATION`,
    [target.charset, target.collation, step.schemaName, step.tableName]);
  const r = rows[0] || {};
  const txt = Number(r.txt || 0);
  const okCols = Number(r.okCols || 0);
  return {
    ok: r.co === target.collation && txt === okCols,
    observed: { tableCollation: r.co, textColumns: txt, compliantColumns: okCols },
  };
}

async function executeStep(conn, job, step) {
  step.status = 'running';
  step.startedAt = nowIso();
  log.jobLog(job.id, 'step.start', { stepId: step.id, kind: step.kind, table: step.tableName, sql: step.sql });
  persist(job);

  const meta = tableMetaFor(job, step);
  const wantChecksum = job.options.verifyChecksum !== false && !step.metadataOnly && meta;

  try {
    if (!step.metadataOnly) {
      const quiet = await waitForQuiet(conn, job, step.id);
      job.throttle = null;
      if (!quiet.ok) {
        throw new Error(quiet.cancelled ? 'ยกเลิกโดยผู้ใช้ระหว่างรอโหลดลด'
          : 'เซิร์ฟเวอร์ยังโหลดสูงเกินเกณฑ์นานเกินกำหนด — หยุดเพื่อไม่ให้กระทบ performance');
      }
      step.throttle = quiet;
    }

    // 1. capture the authoritative "before" DDL
    if (step.tableName) {
      step.createTableBefore = await queries.showCreateTable(conn, step.schemaName, step.tableName);
    }

    // 2. backup (prepared before any mutation)
    if (!step.metadataOnly && job.options.backupStrategy && job.options.backupStrategy !== 'none') {
      step.status = 'backing_up';
      log.jobLog(job.id, 'step.backup.start', { stepId: step.id, strategy: job.options.backupStrategy });
      // Timed because the backup runs inside the maintenance window too, and
      // on a large table it is routinely as long as the ALTER it protects.
      const backupStarted = Date.now();
      step.backup = job.options.backupStrategy === 'mysqldump'
        ? await dumpTable(job, step)
        : await copyTable(conn, job, step);
      step.backupDurationMs = Date.now() - backupStarted;
      log.jobLog(job.id, 'step.backup.done', { stepId: step.id, backup: step.backup, durationMs: step.backupDurationMs });
    }

    // 3. checksum before
    if (wantChecksum) {
      step.status = 'checksum_before';
      step.checksumBefore = await checksum.tableChecksum(conn, meta, job.options.checksum || {});
      log.jobLog(job.id, 'step.checksum.before', { stepId: step.id, digest: step.checksumBefore.digest, rowCount: step.checksumBefore.rowCount, durationMs: step.checksumBefore.durationMs });
    }

    // 4. the ALTER itself
    step.status = 'altering';
    const exec = await runStatement(conn, step.sql);
    step.alterDurationMs = exec.durationMs;
    step.warnings = exec.warnings;
    if (exec.warnings.length) log.jobLog(job.id, 'step.warnings', { stepId: step.id, warnings: exec.warnings });

    // 5. checksum after + verdict
    if (wantChecksum) {
      step.status = 'checksum_after';
      step.checksumAfter = await checksum.tableChecksum(conn, meta, job.options.checksum || {});
      step.verify = checksum.compareChecksum(step.checksumBefore, step.checksumAfter);
      log.jobLog(job.id, 'step.checksum.after', {
        stepId: step.id, digest: step.checksumAfter.digest, rowCount: step.checksumAfter.rowCount,
        ok: step.verify.ok, issues: step.verify.issues,
      });
      if (!step.verify.ok) {
        const err = new Error(`checksum ไม่ตรงกันหลังแปลง: ${step.verify.issues.join(' | ')}`);
        err.checksumMismatch = true;
        throw err;
      }
    }

    // 6. metadata verification
    step.metaVerify = await verifyMetadata(conn, job, step);
    if (!step.metaVerify.ok) {
      log.jobLog(job.id, 'step.meta.mismatch', { stepId: step.id, observed: step.metaVerify.observed });
      step.findings = [{ level: 'warn', code: 'meta_not_target', message: 'metadata หลังรันยังไม่ตรงเป้าหมายทั้งหมด (อาจมีคอลัมน์ที่ตั้ง charset ไว้เฉพาะ)' }];
    }

    step.status = 'done';
    step.finishedAt = nowIso();
    job.progress.doneBytes += step.estimate.bytes;
    job.progress.doneSteps += 1;
    log.jobLog(job.id, 'step.done', { stepId: step.id, alterDurationMs: step.alterDurationMs, verify: step.verify ? step.verify.ok : null });
  } catch (err) {
    step.status = 'failed';
    step.finishedAt = nowIso();
    step.error = err.message;
    step.checksumMismatch = !!err.checksumMismatch;
    job.progress.failedSteps += 1;
    log.jobLog(job.id, 'step.failed', { stepId: step.id, error: err.message, checksumMismatch: step.checksumMismatch });
    throw err;
  } finally {
    persist(job);
  }
}

/** Roll one completed (or half-failed) step back. */
async function rollbackStep(conn, job, step, reason) {
  const entry = { stepId: step.id, startedAt: nowIso(), reason, statements: [], status: 'running' };
  step.rollback = entry;
  log.jobLog(job.id, 'rollback.step.start', { stepId: step.id, reason });
  try {
    // A shadow copy is the fastest and most complete route: swap it back in.
    if (step.backup && step.backup.kind === 'table_copy' && job.options.preferFastRollback !== false) {
      for (const sql of step.backup.restoreSql) {
        const r = await runStatement(conn, sql);
        entry.statements.push({ sql, durationMs: r.durationMs, warnings: r.warnings });
      }
      entry.method = 'table_copy_swap';
    } else {
      for (const sql of step.rollbackSql) {
        const r = await runStatement(conn, sql);
        entry.statements.push({ sql, durationMs: r.durationMs, warnings: r.warnings });
      }
      entry.method = 'inverse_ddl';
      if (step.checksumMismatch || (step.backup && step.backup.kind === 'mysqldump')) {
        entry.note = 'inverse DDL คืนโครงสร้างได้ แต่ถ้าอักขระถูกแทนด้วย "?" ไปแล้ว ต้อง restore จากไฟล์ backup: '
          + (step.backup && step.backup.file ? step.backup.file : 'ไม่มีไฟล์ backup ในรอบนี้');
      }
    }
    const meta = tableMetaFor(job, step);
    if (meta && step.checksumBefore) {
      entry.checksumAfterRollback = await checksum.tableChecksum(conn, meta, job.options.checksum || {});
      entry.verify = checksum.compareChecksum(step.checksumBefore, entry.checksumAfterRollback);
    }
    entry.status = entry.verify && !entry.verify.ok ? 'verify_failed' : 'done';
    step.status = 'rolled_back';
    entry.finishedAt = nowIso();
    log.jobLog(job.id, 'rollback.step.done', { stepId: step.id, method: entry.method, verify: entry.verify ? entry.verify.ok : null });
  } catch (err) {
    entry.status = 'failed';
    entry.error = err.message;
    entry.finishedAt = nowIso();
    log.jobLog(job.id, 'rollback.step.failed', { stepId: step.id, error: err.message });
    throw err;
  } finally {
    persist(job);
  }
  return entry;
}

async function withGuardedConnection(job, fn) {
  const sess = session.get(job.sessionId);
  if (!sess) throw new Error('session หมดอายุ กรุณาเชื่อมต่อใหม่');
  const conn = await sess.pool.getConnection();
  try {
    for (const stmt of sqlgen.sessionGuards(job.options, { ...config.runner, ...(job.options.runner || {}) })) {
      try { await conn.query(stmt); } catch (err) { log.jobLog(job.id, 'guard.failed', { stmt, error: err.message }); }
    }
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = nowIso();
  log.jobLog(job.id, 'job.start', { options: job.options, steps: job.steps.length, target: job.plan.target });
  try {
    await withGuardedConnection(job, async (conn) => {
      for (const step of job.steps) {
        if (job.cancelRequested) { job.status = 'cancelled'; break; }
        await waitWhilePaused(job);
        if (job.cancelRequested) { job.status = 'cancelled'; break; }
        if (job.options.dryRun) {
          step.status = 'skipped_dry_run';
          job.progress.doneSteps += 1;
          continue;
        }
        try {
          await executeStep(conn, job, step);
        } catch (err) {
          const shouldRollback = job.options.autoRollbackOnFailure !== false;
          if (shouldRollback) {
            try {
              await rollbackStep(conn, job, step, `auto: ${err.message}`);
              for (const prior of [...job.steps].reverse()) {
                if (prior === step || prior.status !== 'done') continue;
                if (job.options.rollbackAllOnFailure) await rollbackStep(conn, job, prior, 'auto: cascade');
              }
            } catch (rbErr) {
              job.rollbackError = rbErr.message;
            }
          }
          if (job.options.stopOnError !== false) {
            job.status = job.options.rollbackAllOnFailure ? 'rolled_back' : 'failed';
            job.error = err.message;
            return;
          }
        }
      }
      if (job.status === 'running') {
        job.status = job.progress.failedSteps > 0 ? 'failed' : 'done';
      }
    });
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    log.jobLog(job.id, 'job.error', { error: err.message });
  } finally {
    job.finishedAt = nowIso();
    log.jobLog(job.id, 'job.finish', { status: job.status, progress: job.progress, error: job.error || null });
    persist(job);
  }
}

function create({ sess, plan, tableMeta, options, preflightId, snapshotId }) {
  const id = newId();
  const steps = plan.steps.map((s) => ({
    ...s,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    error: null,
  }));
  const job = {
    id,
    sessionId: sess.id,
    connection: { host: sess.host, port: sess.port, user: sess.user, server: sess.serverInfo.version },
    stamp: new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14),
    plan,
    steps,
    tableMeta: tableMeta || {},
    options: {
      dryRun: false,
      verifyChecksum: true,
      backupStrategy: 'none',
      autoRollbackOnFailure: true,
      rollbackAllOnFailure: false,
      preferFastRollback: true,
      stopOnError: true,
      ignoreLoad: false,
      checksum: { mode: 'sha256', deep: false },
      ...options,
    },
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    status: 'queued',
    error: null,
    preflightId: preflightId || null,
    snapshotId: snapshotId || null,
    cancelRequested: false,
    pauseRequested: false,
    throttle: null,
    progress: {
      totalSteps: steps.length,
      doneSteps: 0,
      failedSteps: 0,
      totalBytes: steps.reduce((a, s) => a + (s.estimate ? s.estimate.bytes : 0), 0),
      doneBytes: 0,
    },
  };
  jobs.set(id, job);
  log.audit('job.created', { jobId: id, sessionId: sess.id, steps: steps.length, options: job.options });
  persist(job);
  return job;
}

function start(job) {
  if (job.status !== 'queued') throw new Error(`job อยู่ในสถานะ ${job.status} เริ่มใหม่ไม่ได้`);
  job.promise = runJob(job);
  return job;
}

async function rollbackJob(jobId, { stepIds } = {}) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('ไม่พบ job');
  if (!TERMINAL.has(job.status)) throw new Error('job ยังทำงานอยู่ — หยุดก่อนจึงจะ rollback ได้');
  job.status = 'rolling_back';
  log.jobLog(job.id, 'rollback.job.start', { stepIds: stepIds || 'all-completed' });
  const targets = [...job.steps].reverse().filter((s) =>
    (s.status === 'done' || s.status === 'failed') && (!stepIds || stepIds.includes(s.id)));
  const results = [];
  try {
    await withGuardedConnection(job, async (conn) => {
      for (const step of targets) {
        results.push(await rollbackStep(conn, job, step, 'manual'));
      }
    });
    job.status = 'rolled_back';
  } catch (err) {
    job.status = 'failed';
    job.error = `rollback ล้มเหลว: ${err.message}`;
    throw err;
  } finally {
    log.jobLog(job.id, 'rollback.job.finish', { status: job.status, rolledBack: results.length });
    persist(job);
  }
  return { job: snapshot(job, { includeSteps: true }), results };
}

function snapshot(job, { includeSteps = false } = {}) {
  const base = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error || null,
    rollbackError: job.rollbackError || null,
    options: job.options,
    target: job.plan.target,
    progress: {
      ...job.progress,
      pct: job.progress.totalSteps ? Number(((job.progress.doneSteps / job.progress.totalSteps) * 100).toFixed(1)) : 0,
      bytePct: job.progress.totalBytes ? Number(((job.progress.doneBytes / job.progress.totalBytes) * 100).toFixed(1)) : 0,
    },
    throttle: job.throttle,
    paused: !!job.pauseRequested,
    preflightId: job.preflightId,
    snapshotId: job.snapshotId,
    connection: job.connection,
  };
  if (!includeSteps) return base;
  base.steps = job.steps.map((s) => ({
    id: s.id, kind: s.kind, title: s.title, schemaName: s.schemaName, tableName: s.tableName,
    status: s.status, metadataOnly: s.metadataOnly, sql: s.sql, rollbackSql: s.rollbackSql,
    startedAt: s.startedAt, finishedAt: s.finishedAt, alterDurationMs: s.alterDurationMs,
    backupDurationMs: s.backupDurationMs,
    error: s.error, warnings: s.warnings, risks: s.risks, estimate: s.estimate,
    checksumBefore: s.checksumBefore, checksumAfter: s.checksumAfter, verify: s.verify,
    metaVerify: s.metaVerify, backup: s.backup, rollback: s.rollback,
    createTableBefore: s.createTableBefore, findings: s.findings,
  }));
  return base;
}

const get = (id) => jobs.get(id) || null;
const list = () => [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((j) => snapshot(j));

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelRequested = true;
  job.pauseRequested = false;
  log.jobLog(id, 'job.cancel.requested', {});
  return true;
}

function pause(id, paused) {
  const job = jobs.get(id);
  if (!job) return false;
  job.pauseRequested = !!paused;
  log.jobLog(id, paused ? 'job.pause' : 'job.resume', {});
  return true;
}

/** Jobs persisted by an earlier process run, for the log viewer. */
function listArchived() {
  return log.listJson(config.paths.jobs)
    .filter((id) => !jobs.has(id))
    .map((id) => {
      const j = log.readJson(config.paths.jobs, id);
      return j ? { ...j, steps: undefined, archived: true } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function readArchived(id) {
  return log.readJson(config.paths.jobs, id);
}

module.exports = {
  create, start, get, list, cancel, pause, snapshot, rollbackJob,
  listArchived, readArchived, backupTableName,
};
