'use strict';
const express = require('express');
const config = require('../../config');
const session = require('../session');
const log = require('../lib/logger');
const queries = require('../lib/queries');
const sqlgen = require('../lib/sqlgen');
const preflight = require('../lib/preflight');
const checksum = require('../lib/checksum');
const tasks = require('../lib/tasks');
const limits = require('../lib/limits');
const jobs = require('../lib/jobs');
const xlsx = require('../lib/xlsx');

const router = express.Router();

/* ------------------------------------------------------------------ helpers */

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireSession(req, res, next) {
  const id = req.headers['x-session-id'] || req.query.sessionId;
  const sess = id ? session.get(String(id)) : null;
  if (!sess) return res.status(401).json({ error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล หรือ session หมดอายุ', needConnect: true });
  req.sess = sess;
  next();
}

const listParam = (v) => {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
};

const isMariaDB = (sess) => /mariadb/i.test(sess.serverInfo.version + ' ' + (sess.serverInfo.versionComment || ''));

function resolveTarget(body = {}) {
  const charset = body.targetCharset || config.target.charset;
  const collation = body.targetCollation || config.target.collation;
  return { charset: String(charset), collation: String(collation) };
}

/* ------------------------------------------------------------- connection */

router.get('/meta', (req, res) => {
  res.json({
    target: config.target,
    systemSchemas: config.systemSchemas,
    runner: config.runner,
    scan: config.scan,
    workflow: config.workflow,
    idleTimeoutMs: config.session.idleTimeoutMs,
    notes: {
      utf8mb3Deprecated: 'utf8mb3 ถูกประกาศ deprecated ตั้งแต่ MySQL 8.0.29 และมีแผนถูกถอดในอนาคต — เหมาะกับงาน compatibility ระยะสั้น',
      narrowing: 'utf8mb4 → utf8mb3 เป็นการลดขอบเขตอักขระ ตัวอักษร 4 ไบต์ (emoji, CJK ส่วนขยาย) จะถูกแทนด้วย ? อย่างถาวร',
    },
  });
});

router.post('/connect', asyncHandler(async (req, res) => {
  const { host, port, user, password, database, ssl } = req.body || {};
  if (!host || !user) return res.status(400).json({ error: 'ต้องระบุ host และ user' });
  try {
    const sess = await session.create({ host: String(host), port, user: String(user), password: String(password || ''), database, ssl });
    res.json(session.publicView(sess));
  } catch (err) {
    log.audit('session.connect.failed', { host, user, error: err.message, code: err.code });
    res.status(err.status || 400).json({ error: `เชื่อมต่อไม่สำเร็จ: ${err.message}`, code: err.code });
  }
}));

router.get('/session', requireSession, (req, res) => res.json(session.publicView(req.sess)));

router.post('/disconnect', requireSession, asyncHandler(async (req, res) => {
  await session.destroy(req.sess.id, 'manual');
  res.json({ ok: true });
}));

/* -------------------------------------------------------------- inventory */

router.get('/schemas', requireSession, asyncHandler(async (req, res) => {
  res.json({ schemas: await queries.schemas(req.sess.pool) });
}));

router.get('/facets', requireSession, asyncHandler(async (req, res) => {
  res.json(await queries.facets(req.sess.pool));
}));

router.get('/summary', requireSession, asyncHandler(async (req, res) => {
  const target = resolveTarget(req.query);
  res.json(await queries.summary(req.sess.pool, target, listParam(req.query.schemas)));
}));

function inventoryFilters(query) {
  return {
    schema: listParam(query.schema),
    charset: listParam(query.charset),
    collation: listParam(query.collation),
    engine: listParam(query.engine),
    dataType: listParam(query.dataType),
    table: query.table || '',
    column: query.column || '',
    q: query.q || '',
    status: query.status || '',
    textOnly: query.textOnly === '1' || query.textOnly === 'true',
  };
}

router.get('/inventory', requireSession, asyncHandler(async (req, res) => {
  const target = resolveTarget(req.query);
  const data = await queries.inventory(req.sess.pool, {
    filters: inventoryFilters(req.query),
    target,
    page: req.query.page,
    pageSize: req.query.pageSize,
    sort: req.query.sort,
    dir: req.query.dir,
  });
  res.json({ ...data, target });
}));

router.get('/inventory.csv', requireSession, asyncHandler(async (req, res) => {
  const target = resolveTarget(req.query);
  const rows = await queries.inventoryAll(req.sess.pool, { filters: inventoryFilters(req.query), target });
  const cols = ['schemaName', 'tableName', 'columnName', 'ordinal', 'columnType', 'dataType',
    'columnCharset', 'columnCollation', 'tableCharset', 'tableCollation', 'schemaCharset',
    'schemaCollation', 'charMaxLen', 'octetLen', 'isNullable', 'columnKey', 'extra', 'engine',
    'rowFormat', 'approxRows', 'dataLength', 'indexLength', 'columnComment'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="charset-inventory-${Date.now()}.csv"`);
  res.write('﻿' + cols.join(',') + '\n');
  for (const r of rows) res.write(cols.map((c) => esc(r[c])).join(',') + '\n');
  res.end();
  log.audit('inventory.export', { sessionId: req.sess.id, rows: rows.length });
}));

/* ------------------------------------------------------------ table list */

router.get('/tables', requireSession, asyncHandler(async (req, res) => {
  const target = resolveTarget(req.query);
  const data = await queries.tableList(req.sess.pool, {
    target,
    filters: {
      schema: listParam(req.query.schema),
      engine: listParam(req.query.engine),
      q: req.query.q || '',
      status: req.query.status || '',
    },
    page: req.query.page,
    pageSize: req.query.pageSize,
    sort: req.query.sort,
    dir: req.query.dir,
  });
  res.json({ ...data, target });
}));

/**
 * The work list as a spreadsheet.
 *
 * Same filters as the on-screen list, but every matching row rather than the
 * current page - this is the artefact that gets attached to a change request or
 * mailed to whoever owns the biggest table, so a 50-row page would be the wrong
 * thing to hand over. Defaults to status=todo, because "which tables are not
 * yet on the target collation" is the question being asked.
 */
router.get('/export/tables.xlsx', requireSession, asyncHandler(async (req, res) => {
  const target = resolveTarget(req.query);
  const status = req.query.status === undefined ? 'todo' : String(req.query.status);
  const data = await queries.tableList(req.sess.pool, {
    target,
    filters: {
      schema: listParam(req.query.schema),
      engine: listParam(req.query.engine),
      q: req.query.q || '',
      status,
    },
    sort: req.query.sort || 'size',
    dir: req.query.dir || 'desc',
    all: true,
  });

  // Nothing in this app is allowed to be unbounded by accident (see
  // server/lib/limits.js). A workbook is built whole in memory, so a shared
  // host with a six-figure table count would be an OOM rather than a report -
  // and a silently truncated compliance audit is worse than a refusal.
  const MAX_ROWS = 100_000;
  if (data.rows.length > MAX_ROWS) {
    return res.status(413).json({
      error: `มี ${data.rows.length.toLocaleString('en-US')} ตารางที่ตรงกับตัวกรอง เกินเพดาน `
        + `${MAX_ROWS.toLocaleString('en-US')} แถวต่อไฟล์ — กรอง schema หรือสถานะให้แคบลงแล้วโหลดทีละส่วน`,
    });
  }

  const STATUS_TH = {
    rebuild: 'ต้องเขียนข้อมูลใหม่',
    metadata_only: 'แก้แค่ default ของตาราง',
    compliant: 'เรียบร้อยแล้ว',
  };
  const columns = [
    { key: 'schemaName', label: 'schema', width: 22 },
    { key: 'tableName', label: 'ตาราง', width: 34 },
    { key: 'engine', label: 'engine', width: 11 },
    { key: 'tableCharset', label: 'charset ของตาราง', width: 18 },
    { key: 'tableCollation', label: 'collation ของตาราง', width: 26 },
    { key: 'statusText', label: 'สถานะ', width: 22 },
    { key: 'columnsPending', label: 'คอลัมน์ที่ยังไม่ตรง', width: 18 },
    { key: 'textColumns', label: 'คอลัมน์ข้อความทั้งหมด', width: 20 },
    { key: 'approxRows', label: 'จำนวนแถว (ประมาณ)', width: 20 },
    { key: 'sizeBytes', label: 'ขนาด (ไบต์)', width: 16 },
    { key: 'sizeMB', label: 'ขนาด (MB)', width: 13 },
    { key: 'rowFormat', label: 'row format', width: 14 },
  ];
  const rows = data.rows.map((r) => ({
    ...r,
    statusText: STATUS_TH[r.status] || r.status,
    sizeMB: Math.round((r.sizeBytes / 1024 / 1024) * 100) / 100,
  }));

  const buf = xlsx.workbook({ sheetName: `ไม่ใช่ ${target.charset}`, columns, rows });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="charset-tables-${stamp}.xlsx"`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
  log.audit('tables.export', { sessionId: req.sess.id, rows: rows.length, status, target });
}));

/** Everything the single-table workspace needs, in one round trip. */
router.get('/tables/:schema/:table', requireSession, asyncHandler(async (req, res) => {
  const target = resolveTarget(req.query);
  const key = `${req.params.schema}.${req.params.table}`;
  const [meta] = await queries.tablesForPlan(req.sess.pool, {
    tables: [key], onlyNonCompliant: false, target,
  });
  if (!meta) return res.status(404).json({ error: `ไม่พบตาราง ${key}` });

  const textColumns = meta.columns.filter((c) => c.columnCharset);
  const pending = textColumns.filter((c) => c.columnCharset !== target.charset || c.columnCollation !== target.collation);
  const sizeBytes = Number(meta.dataLength || 0) + Number(meta.indexLength || 0);
  const checksumPlan = checksum.pickStrategy(meta, { strategy: 'auto' });

  res.json({
    target,
    table: meta,
    facts: {
      key,
      sizeBytes,
      approxRows: Number(meta.approxRows || 0),
      textColumns: textColumns.length,
      pendingColumns: pending.length,
      tableDefaultOk: meta.tableCollation === target.collation,
      needsRebuild: pending.length > 0,
      needsChange: pending.length > 0 || meta.tableCollation !== target.collation,
      // Tell the operator up front how the two slow steps will behave on THIS
      // table, instead of letting them discover it by waiting.
      scanPlan: {
        rowLimit: config.scan.defaultRowLimit,
        willSkip: sizeBytes > config.scan.defaultMaxScanBytes,
        maxScanBytes: config.scan.defaultMaxScanBytes,
      },
      checksumPlan,
    },
    pendingColumns: pending.map((c) => ({
      columnName: c.columnName, columnType: c.columnType, dataType: c.dataType,
      columnCharset: c.columnCharset, columnCollation: c.columnCollation,
      columnKey: c.columnKey, charMaxLen: c.charMaxLen,
    })),
  });
}));

/* --------------------------------------------------------------- preflight */

async function resolveScope(sess, body, target) {
  return queries.tablesForPlan(sess.pool, {
    schemas: listParam(body.schemas),
    tables: listParam(body.tables),
    onlyNonCompliant: body.onlyNonCompliant !== false,
    target,
  });
}

/**
 * The console works on exactly one table per operation.
 *
 * Scanning, planning or altering a whole schema in one shot is what made this
 * tool unusable: an operator could not tell what was happening, could not stop
 * it, and a single bad table took the entire run with it. Refusing it here -
 * rather than only in the UI - means no stale page or hand-rolled request can
 * start a bulk run by accident.
 *
 * Returns an error object to send, or null when the scope is acceptable.
 */
function bulkScopeError(tables, what) {
  if (!config.workflow.oneTableAtATime || tables.length <= 1) return null;
  return {
    error: `${what}ทำได้ทีละ 1 ตารางเท่านั้น — ขอบเขตที่เลือกมี ${tables.length} ตาราง `
      + `กรุณาเลือกตารางเดียวจากหน้า "ตาราง" แล้วทำทีละตาราง`,
    code: 'one_table_at_a_time',
    tableCount: tables.length,
    tables: tables.slice(0, 20).map((t) => `${t.schemaName}.${t.tableName}`),
  };
}

router.post('/preflight', requireSession, asyncHandler(async (req, res) => {
  const target = resolveTarget(req.body);
  const tables = await resolveScope(req.sess, req.body || {}, target);
  if (!tables.length) return res.status(400).json({ error: 'ไม่พบตารางที่ต้องแปลงในขอบเขตที่เลือก' });
  const bulk = bulkScopeError(tables, 'การสแกน Preflight ');
  if (bulk) return res.status(400).json(bulk);

  // `fullScan: true` is the only way to get an unbounded scan, and it has to
  // be asked for. Everything else lands on the configured default.
  const full = req.body.fullScan === true;
  const opts = {
    target,
    rowLimit: limits.rowLimit(req.body.rowLimit, { allowFull: full }),
    maxScanBytes: limits.maxScanBytes(req.body.maxScanBytes, { allowFull: full }),
    statementTimeoutSec: config.scan.statementTimeoutSec,
    checkUnique: req.body.checkUnique !== false,
    checkDoubleEncoding: req.body.checkDoubleEncoding !== false,
    sampleSize: req.body.sampleSize || 5,
  };
  const task = tasks.create('preflight', req.sess.id, {
    total: tables.length, target, tables: tables.length,
    table: tables.length === 1 ? `${tables[0].schemaName}.${tables[0].tableName}` : null,
    rowLimit: opts.rowLimit, maxScanBytes: opts.maxScanBytes,
  });
  opts.shouldAbort = () => task.cancelRequested;
  tasks.run(task, (onProgress) => preflight.scan(req.sess.pool, tables, opts, onProgress), config.paths.snapshots);
  res.status(202).json(tasks.view(task));
}));

router.get('/preflight/:id', requireSession, (req, res) => {
  const task = tasks.get(req.params.id);
  if (task) return res.json(tasks.view(task, req.query.full === '1'));
  const stored = log.readJson(config.paths.snapshots, req.params.id);
  if (!stored) return res.status(404).json({ error: 'ไม่พบผลการสแกน' });
  res.json({ id: stored.id, kind: stored.kind, status: 'done', createdAt: stored.createdAt, result: stored.result, summary: stored.result && stored.result.summary });
});

router.post('/preflight/:id/cancel', requireSession, (req, res) => {
  res.json({ ok: tasks.cancel(req.params.id) });
});

router.get('/preflight', requireSession, (req, res) => {
  res.json({ tasks: tasks.list('preflight'), archived: log.listJson(config.paths.snapshots).filter((f) => f.startsWith('preflight-')) });
});

/* ---------------------------------------------------------------- checksum */

router.post('/checksum', requireSession, asyncHandler(async (req, res) => {
  const target = resolveTarget(req.body);
  const tables = await resolveScope(req.sess, { ...req.body, onlyNonCompliant: req.body.onlyNonCompliant === true }, target);
  if (!tables.length) return res.status(400).json({ error: 'ไม่พบตารางในขอบเขตที่เลือก' });
  const bulk = bulkScopeError(tables, 'การทำ checksum ');
  if (bulk) return res.status(400).json(bulk);

  const opts = {
    mode: ['sha256', 'crc32', 'rowcount'].includes(req.body.mode) ? req.body.mode : 'sha256',
    deep: !!req.body.deep,
    // 'auto' reads the whole table when that is cheap and falls back to a
    // deterministic PK-ordered head sample when it is not.
    strategy: ['auto', 'full', 'pk_head', 'rowcount'].includes(req.body.strategy) ? req.body.strategy : 'auto',
    rowLimit: limits.rowLimit(req.body.rowLimit, { def: config.scan.checksumRowLimit }),
    statementTimeoutSec: config.scan.statementTimeoutSec,
    includeNative: !!req.body.includeNative,
  };
  const task = tasks.create('checksum', req.sess.id, {
    total: tables.length, mode: opts.mode, deep: opts.deep, strategy: opts.strategy, target,
    table: tables.length === 1 ? `${tables[0].schemaName}.${tables[0].tableName}` : null,
  });
  opts.shouldAbort = () => task.cancelRequested;
  tasks.run(task, (onProgress) => checksum.snapshot(req.sess.pool, tables, opts, onProgress), config.paths.snapshots);
  res.status(202).json(tasks.view(task));
}));

router.get('/checksum/:id', requireSession, (req, res) => {
  const task = tasks.get(req.params.id);
  if (task) return res.json(tasks.view(task, req.query.full === '1'));
  const stored = log.readJson(config.paths.snapshots, req.params.id);
  if (!stored) return res.status(404).json({ error: 'ไม่พบ snapshot' });
  res.json({ id: stored.id, kind: stored.kind, status: 'done', createdAt: stored.createdAt, result: stored.result });
});

router.post('/checksum/:id/cancel', requireSession, (req, res) => {
  res.json({ ok: tasks.cancel(req.params.id) });
});

router.get('/checksum', requireSession, (req, res) => {
  res.json({ tasks: tasks.list('checksum'), archived: log.listJson(config.paths.snapshots).filter((f) => f.startsWith('checksum-')) });
});

/** Re-run a stored snapshot and diff it - the "did anything change?" button. */
router.post('/checksum/:id/verify', requireSession, asyncHandler(async (req, res) => {
  const stored = tasks.get(req.params.id)?.result || (log.readJson(config.paths.snapshots, req.params.id) || {}).result;
  if (!stored) return res.status(404).json({ error: 'ไม่พบ snapshot ต้นทาง' });
  const keys = Object.keys(stored.tables);
  const target = resolveTarget(req.body);
  const tables = await queries.tablesForPlan(req.sess.pool, { tables: keys, onlyNonCompliant: false, target });
  // Re-run with the SAME strategy and row cap; comparing a head sample against
  // a full digest would be guaranteed to "fail".
  const opts = {
    mode: stored.mode,
    deep: stored.deep,
    strategy: stored.strategy || 'auto',
    rowLimit: stored.rowLimit || undefined,
    statementTimeoutSec: config.scan.statementTimeoutSec,
  };
  const task = tasks.create('checksum', req.sess.id, { total: tables.length, mode: opts.mode, deep: opts.deep, comparedWith: req.params.id });
  tasks.run(task, async (onProgress) => {
    const fresh = await checksum.snapshot(req.sess.pool, tables, opts, onProgress);
    const comparison = {};
    let mismatches = 0;
    for (const key of keys) {
      const cmp = checksum.compareChecksum(stored.tables[key], fresh.tables[key]);
      comparison[key] = cmp;
      if (!cmp.ok) mismatches += 1;
    }
    return {
      mode: opts.mode, deep: opts.deep, baseline: req.params.id, tables: fresh.tables, comparison,
      summary: { tables: keys.length, mismatches, ok: mismatches === 0 },
    };
  }, config.paths.snapshots);
  res.status(202).json(tasks.view(task));
}));

/* -------------------------------------------------------------------- plan */

router.post('/plan', requireSession, asyncHandler(async (req, res) => {
  const target = resolveTarget(req.body);
  const body = req.body || {};
  const tables = await resolveScope(req.sess, body, target);
  const bulk = bulkScopeError(tables, 'การสร้างแผน');
  if (bulk) return res.status(400).json(bulk);

  // ALTER DATABASE touches the whole schema, so in one-table-at-a-time mode it
  // is opt-in rather than the default it used to be.
  const wantSchemaDefaults = config.workflow.oneTableAtATime
    ? body.includeSchemaDefaults === true
    : body.includeSchemaDefaults !== false;
  const schemaRows = !wantSchemaDefaults
    ? []
    : (await queries.schemas(req.sess.pool)).filter((s) => {
      const scope = listParam(body.schemas);
      if (scope.length) return scope.includes(s.schemaName);
      return tables.some((t) => t.schemaName === s.schemaName);
    });

  const plan = sqlgen.buildPlan({
    tables,
    schemaRows,
    target,
    session: { host: req.sess.host, port: req.sess.port, user: req.sess.user },
    options: {
      strategy: body.strategy === 'convert_table' ? 'convert_table' : 'modify_columns',
      // Absent = every column that needs it. Present (even empty) = the
      // operator's explicit tick list, honoured as given.
      columns: Array.isArray(body.columns) ? body.columns.map(String) : undefined,
      includeSchemaDefaults: wantSchemaDefaults,
      includeTableDefaults: body.includeTableDefaults !== false,
      algorithm: ['DEFAULT', 'COPY', 'INPLACE'].includes(body.algorithm) ? body.algorithm : 'DEFAULT',
      lockMode: ['DEFAULT', 'SHARED', 'NONE', 'EXCLUSIVE'].includes(body.lockMode) ? body.lockMode : 'DEFAULT',
      disableFkChecks: !!body.disableFkChecks,
      skipBinlog: !!body.skipBinlog,
      order: ['size_asc', 'size_desc', 'name'].includes(body.order) ? body.order : 'size_asc',
      backupStrategy: ['none', 'table_copy', 'mysqldump'].includes(body.backupStrategy) ? body.backupStrategy : 'none',
      isMariaDB: isMariaDB(req.sess),
    },
  });

  const id = `plan-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;
  const tableMeta = Object.fromEntries(tables.map((t) => [`${t.schemaName}.${t.tableName}`, t]));
  log.writeJson(config.paths.plans, id, { id, createdAt: new Date().toISOString(), sessionId: req.sess.id, plan, tableMeta });
  log.audit('plan.created', { planId: id, sessionId: req.sess.id, steps: plan.steps.length, options: plan.options });
  res.json({ planId: id, plan });
}));

router.get('/plan/:id', requireSession, (req, res) => {
  const stored = log.readJson(config.paths.plans, req.params.id);
  if (!stored) return res.status(404).json({ error: 'ไม่พบแผน' });
  res.json({ planId: stored.id, plan: stored.plan, createdAt: stored.createdAt });
});

router.get('/plan/:id/script', requireSession, (req, res) => {
  const stored = log.readJson(config.paths.plans, req.params.id);
  if (!stored) return res.status(404).json({ error: 'ไม่พบแผน' });
  const direction = req.query.direction === 'rollback' ? 'rollback' : 'forward';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${stored.id}-${direction}.sql"`);
  }
  res.send(sqlgen.renderScript(stored.plan, direction));
});

/* -------------------------------------------------------------------- jobs */

router.post('/jobs', requireSession, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const stored = log.readJson(config.paths.plans, String(body.planId || ''));
  if (!stored) return res.status(404).json({ error: 'ไม่พบแผน — กรุณาสร้างแผนใหม่' });
  const planTables = new Set(stored.plan.steps.filter((st) => st.tableName)
    .map((st) => `${st.schemaName}.${st.tableName}`));
  if (config.workflow.oneTableAtATime && planTables.size > 1) {
    return res.status(400).json({
      error: `แผนนี้ครอบคลุม ${planTables.size} ตาราง — โหมดทีละตารางอนุญาตให้รันได้ครั้งละ 1 ตารางเท่านั้น`,
      code: 'one_table_at_a_time',
      tables: [...planTables].slice(0, 20),
    });
  }
  if (req.sess.serverInfo.readOnly && !body.dryRun) {
    return res.status(409).json({ error: 'เซิร์ฟเวอร์อยู่ในโหมด read_only — รัน ALTER ไม่ได้' });
  }

  // Preflight gate: refuse to run a lossy conversion unless explicitly forced.
  let preflightResult = null;
  if (body.preflightId) {
    const t = tasks.get(body.preflightId);
    preflightResult = t ? t.result : (log.readJson(config.paths.snapshots, body.preflightId) || {}).result;
  }
  if (!body.dryRun) {
    if (!preflightResult && body.acknowledgeNoPreflight !== true) {
      return res.status(412).json({
        error: 'ยังไม่ได้รัน Preflight scan สำหรับขอบเขตนี้ — การแปลงเป็น charset ที่แคบลงอาจทำข้อมูลหาย',
        code: 'preflight_required',
      });
    }
    if (preflightResult && preflightResult.gate === 'block' && body.forceDespiteBlock !== true) {
      return res.status(412).json({
        error: 'Preflight พบปัญหาระดับ critical (ข้อมูลจะหาย หรือ unique index จะซ้ำ) — แก้ไขข้อมูลก่อน หรือยืนยันด้วย forceDespiteBlock',
        code: 'preflight_blocked',
        summary: preflightResult.summary,
      });
    }
    // A passing gate is only meaningful for the tables it actually scanned.
    // Without this, a preflight over one small table would authorise a plan
    // covering the whole instance.
    if (preflightResult) {
      const scanned = new Set((preflightResult.tables || [])
        .filter((t) => t.scanned)
        .map((t) => `${t.schemaName}.${t.tableName}`));
      const uncovered = stored.plan.steps
        .filter((s) => !s.metadataOnly && s.tableName)
        .map((s) => `${s.schemaName}.${s.tableName}`)
        .filter((key) => !scanned.has(key));
      if (uncovered.length && body.acknowledgeUncoveredTables !== true) {
        return res.status(412).json({
          error: `แผนนี้มี ${uncovered.length} ตารางที่ Preflight ยังไม่ได้สแกน (หรือถูกข้ามเพราะใหญ่เกินเพดาน) — สแกนให้ครอบคลุมก่อน หรือยืนยันด้วย acknowledgeUncoveredTables`,
          code: 'preflight_scope_mismatch',
          uncovered: uncovered.slice(0, 50),
          uncoveredCount: uncovered.length,
        });
      }
      if (uncovered.length) {
        log.audit('job.preflight.scope_override', {
          sessionId: req.sess.id, planId: stored.id, preflightId: body.preflightId, uncoveredCount: uncovered.length,
        });
      }
    }
  }

  const job = jobs.create({
    sess: req.sess,
    plan: stored.plan,
    tableMeta: stored.tableMeta,
    preflightId: body.preflightId || null,
    snapshotId: body.snapshotId || null,
    options: {
      dryRun: !!body.dryRun,
      verifyChecksum: body.verifyChecksum !== false,
      backupStrategy: ['none', 'table_copy', 'mysqldump'].includes(body.backupStrategy) ? body.backupStrategy : (stored.plan.options.backupStrategy || 'none'),
      autoRollbackOnFailure: body.autoRollbackOnFailure !== false,
      rollbackAllOnFailure: !!body.rollbackAllOnFailure,
      preferFastRollback: body.preferFastRollback !== false,
      stopOnError: body.stopOnError !== false,
      ignoreLoad: !!body.ignoreLoad,
      disableFkChecks: !!stored.plan.options.disableFkChecks,
      skipBinlog: !!stored.plan.options.skipBinlog,
      checksum: {
        mode: ['sha256', 'crc32', 'rowcount'].includes(body.checksumMode) ? body.checksumMode : 'sha256',
        deep: !!body.checksumDeep,
        // 'auto' keeps the before/after digests affordable on a large table -
        // this pair runs inside the migration window, so an unbounded scan
        // here is downtime, not diligence.
        strategy: ['auto', 'full', 'pk_head', 'rowcount'].includes(body.checksumStrategy) ? body.checksumStrategy : 'auto',
        rowLimit: config.scan.checksumRowLimit,
        statementTimeoutSec: config.scan.statementTimeoutSec,
      },
      runner: body.runner || null,
      planId: stored.id,
      forced: body.forceDespiteBlock === true,
    },
  });
  jobs.start(job);
  res.status(202).json(jobs.snapshot(job, { includeSteps: true }));
}));

router.get('/jobs', requireSession, (req, res) => {
  res.json({ jobs: jobs.list(), archived: jobs.listArchived() });
});

router.get('/jobs/:id', requireSession, (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) return res.json(jobs.snapshot(job, { includeSteps: req.query.steps !== '0' }));
  const archived = jobs.readArchived(req.params.id);
  if (!archived) return res.status(404).json({ error: 'ไม่พบ job' });
  res.json({ ...archived, archived: true });
});

router.get('/jobs/:id/log', requireSession, (req, res) => {
  res.json({ entries: log.readJobLog(req.params.id, Number(req.query.limit) || 3000) });
});

router.post('/jobs/:id/cancel', requireSession, (req, res) => {
  res.json({ ok: jobs.cancel(req.params.id) });
});

router.post('/jobs/:id/pause', requireSession, (req, res) => {
  res.json({ ok: jobs.pause(req.params.id, req.body && req.body.paused !== false) });
});

router.post('/jobs/:id/rollback', requireSession, asyncHandler(async (req, res) => {
  const out = await jobs.rollbackJob(req.params.id, { stepIds: req.body && req.body.stepIds });
  res.json(out);
}));

/* ------------------------------------------------------------------- audit */

router.get('/audit', requireSession, (req, res) => {
  res.json({ days: log.listAuditDays() });
});

router.get('/audit/:day', requireSession, (req, res) => {
  try {
    res.json({ entries: log.readAudit(req.params.day, Number(req.query.limit) || 1500) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* --------------------------------------------------------- error handling */

router.use((err, req, res, next) => {
  log.audit('api.error', { path: req.path, error: err });
  const status = err.status || (err.code && String(err.code).startsWith('ER_') ? 400 : 500);
  res.status(status).json({ error: err.message, code: err.code, sqlState: err.sqlState });
});

module.exports = { router, requireSession };
