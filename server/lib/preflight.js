'use strict';
/**
 * Data-level preflight checks - the part that decides whether a conversion is
 * safe to run at all.
 *
 *  1. lossy_conversion  characters that do not survive a round-trip through the
 *                       target charset (the utf8mb4 -> utf8mb3 emoji problem).
 *                       This is irreversible data loss, so it BLOCKS by default.
 *  2. unique_collision  values that are distinct under the current collation but
 *                       equal under the target one; the ALTER would fail with a
 *                       duplicate-key error halfway through.
 *  3. double_encoding   single-byte columns (latin1/tis620/...) whose bytes are
 *                       actually UTF-8 already. Converting them produces
 *                       mojibake even though no bytes are "lost".
 *
 * Every check is issued as its own statement wrapped in try/catch, so an
 * unsupported server feature degrades to "unavailable" instead of aborting.
 */
const { q, qq, charsetName, sqlString } = require('./ident');
const { needsColumnChange, bpc } = require('./sqlgen');
const limits = require('./limits');

const TEXT_TYPES = /^(char|varchar|tinytext|text|mediumtext|longtext|enum|set)$/i;
const SINGLE_BYTE = (cs) => bpc(cs) === 1;

/** utf8mb4-normalised value, binary-comparable. */
const norm = (col) => `(CONVERT(${q(col)} USING utf8mb4) COLLATE utf8mb4_bin)`;

/** The same value after a round-trip through the target charset. */
const roundTrip = (col, target) =>
  `(CONVERT(CONVERT(CONVERT(${q(col)} USING utf8mb4) USING ${charsetName(target.charset)}) USING utf8mb4) COLLATE utf8mb4_bin)`;

const lossyCondition = (col, target) =>
  `${q(col)} IS NOT NULL AND ${norm(col)} <> ${roundTrip(col, target)}`;

// Byte-aligned UTF-8 lead+continuation pair inside the hex dump of the raw
// bytes. Pure-ASCII regex, so it is safe on any charset/collation.
const DOUBLE_ENC_REGEX =
  '^([0-9A-F]{2})*(C[2-9A-F]|D[0-9A-F]|E[0-9A-F]|F[0-4])(8[0-9A-F]|9[0-9A-F]|A[0-9A-F]|B[0-9A-F])';

const doubleEncodedCondition = (col) =>
  `${q(col)} IS NOT NULL AND HEX(${q(col)}) REGEXP ${sqlString(DOUBLE_ENC_REGEX)}`;

function primaryKeyColumns(table) {
  const pk = (table.indexes || []).find((i) => i.indexName === 'PRIMARY');
  return pk ? pk.parts.map((p) => p.columnName) : [];
}

async function safeQuery(conn, sql, params) {
  try {
    const [rows] = await conn.query(sql, params);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

/**
 * A bounded, deterministic row source for one table.
 *
 * Every statement this module issues reads from here, not from the base table.
 * Before, only the aggregate scan honoured `rowLimit` while the sample lookups
 * and the UNIQUE group-by still swept the whole table - which is why a capped
 * preflight could still run for an hour on a big table.
 *
 * The cap is applied in primary-key order when there is a usable primary key,
 * so re-running a preflight covers exactly the same rows (InnoDB reads the
 * clustered index in that order anyway, so it costs nothing).
 */
function rowSource(fqn, table, rowLimit) {
  if (!rowLimit) return fqn;
  const pk = primaryKeyColumns(table);
  const order = pk.length ? ` ORDER BY ${pk.map(q).join(', ')}` : '';
  return `(SELECT * FROM ${fqn}${order} LIMIT ${Number(rowLimit)}) AS __src`;
}

/**
 * opts: { target, rowLimit, checkUnique, checkDoubleEncoding, sampleSize,
 *         maxScanBytes, shouldAbort }
 *
 * `rowLimit` and `maxScanBytes` are normalised by server/lib/limits.js before
 * they get here; a caller that passes nothing gets the configured defaults,
 * never an unbounded scan.
 */
async function scanTable(conn, table, opts) {
  const target = opts.target;
  const started = Date.now();
  const fqn = qq(table.schemaName, table.tableName);
  const sampleSize = Math.min(Math.max(Number(opts.sampleSize) || 5, 1), 50);
  const rowLimit = opts.rowLimit || null;
  const src = rowSource(fqn, table, rowLimit);

  const result = {
    schemaName: table.schemaName,
    tableName: table.tableName,
    engine: table.engine,
    approxRows: table.approxRows,
    sizeBytes: table.dataLength + table.indexLength,
    scanned: true,
    skippedReason: null,
    rowLimit,
    coverage: rowLimit ? 'partial' : 'full',
    columns: [],
    uniqueIndexes: [],
    findings: [],
    verdict: 'ok',
  };

  // The size ceiling only makes sense for an unbounded scan. Once a row cap is
  // in force the cost is bounded by the cap, not by the table - skipping a big
  // table then would trade a fast partial answer for no answer at all.
  const sizeBytes = table.dataLength + table.indexLength;
  if (!rowLimit && opts.maxScanBytes && sizeBytes > opts.maxScanBytes) {
    result.scanned = false;
    result.coverage = 'none';
    result.skippedReason = `ตารางขนาด ${(sizeBytes / 1024 ** 3).toFixed(2)} GB ใหญ่กว่าเพดานสแกน `
      + `${(opts.maxScanBytes / 1024 ** 3).toFixed(2)} GB และเลือกสแกนแบบไม่จำกัดแถว — ข้ามการสแกน `
      + `(ใช้แบบจำกัดจำนวนแถวแทน จะสแกนได้เร็วโดยไม่ต้องข้าม)`;
    result.verdict = 'unknown';
    result.durationMs = Date.now() - started;
    return result;
  }

  const changing = table.columns.filter(
    (c) => needsColumnChange(c, target) && TEXT_TYPES.test(String(c.dataType))
      && !(c.generationExpression && String(c.generationExpression).length)
  );
  if (!changing.length) {
    result.durationMs = Date.now() - started;
    return result;
  }

  // --- one scan for every lossy/double-encoding counter -----------------
  const selects = [];
  const meta = [];
  changing.forEach((col, i) => {
    selects.push(`SUM(${lossyCondition(col.columnName, target)}) AS lossy_${i}`);
    meta.push({ col, key: `lossy_${i}`, kind: 'lossy' });
    if (opts.checkDoubleEncoding !== false && SINGLE_BYTE(col.columnCharset)) {
      selects.push(`SUM(${doubleEncodedCondition(col.columnName)}) AS dbl_${i}`);
      meta.push({ col, key: `dbl_${i}`, kind: 'double' });
    }
  });

  // `src` is the base table when the scan is deliberately unbounded, and a
  // LIMITed derived table otherwise. A derived table with LIMIT is
  // non-mergeable and gets materialised - which is what we want when capping,
  // and exactly what we must avoid on a true full-table scan.
  const scan = await safeQuery(conn, `SELECT COUNT(*) AS __n, ${selects.join(', ')} FROM ${src}`);

  const perColumn = new Map(changing.map((c) => [c.columnName, {
    columnName: c.columnName,
    dataType: c.columnType,
    charset: c.columnCharset,
    collation: c.columnCollation,
    lossyRows: null,
    doubleEncodedRows: null,
    samples: [],
    error: null,
  }]));

  if (!scan.ok) {
    for (const c of perColumn.values()) c.error = scan.error;
    result.findings.push({ level: 'warn', code: 'scan_failed', message: `สแกนข้อมูลไม่สำเร็จ: ${scan.error}` });
    result.verdict = 'unknown';
  } else {
    const row = scan.rows[0];
    result.scannedRows = Number(row.__n);
    result.truncated = limits.isPartial(result.scannedRows, rowLimit);
    if (!result.truncated) result.coverage = 'full';
    for (const m of meta) {
      const n = Number(row[m.key] || 0);
      const entry = perColumn.get(m.col.columnName);
      if (m.kind === 'lossy') entry.lossyRows = n;
      else entry.doubleEncodedRows = n;
    }

    // --- samples for the columns that actually have problems -------------
    const pk = primaryKeyColumns(table);
    for (const entry of perColumn.values()) {
      if (!entry.lossyRows && !entry.doubleEncodedRows) continue;
      const idSel = pk.length ? pk.map((c) => `${q(c)} AS __pk_${c.replace(/\W/g, '_')}`) : [];
      const cond = entry.lossyRows
        ? lossyCondition(entry.columnName, target)
        : doubleEncodedCondition(entry.columnName);
      const sampleSql =
        `SELECT ${[...idSel,
          `LEFT(CONVERT(${q(entry.columnName)} USING utf8mb4), 120) AS __value`,
          `LEFT(HEX(${q(entry.columnName)}), 240) AS __hex`,
          `LEFT(CONVERT(${roundTrip(entry.columnName, target)} USING utf8mb4), 120) AS __afterValue`,
        ].join(', ')} FROM ${src} WHERE ${cond} LIMIT ${sampleSize}`;
      const s = await safeQuery(conn, sampleSql);
      if (s.ok) {
        entry.samples = s.rows.map((r) => {
          const id = {};
          for (const [k, v] of Object.entries(r)) if (k.startsWith('__pk_')) id[k.slice(5)] = v;
          return { id, value: r.__value, hex: r.__hex, afterValue: r.__afterValue };
        });
      }
    }
  }

  result.columns = [...perColumn.values()];

  const lossyTotal = result.columns.reduce((a, c) => a + (c.lossyRows || 0), 0);
  const dblTotal = result.columns.reduce((a, c) => a + (c.doubleEncodedRows || 0), 0);
  if (lossyTotal > 0) {
    result.verdict = 'block';
    result.findings.push({
      level: 'critical', code: 'lossy_conversion',
      message: `พบ ${lossyTotal.toLocaleString()} แถวที่มีอักขระซึ่งเก็บใน ${target.charset} ไม่ได้ — ถ้าแปลงตอนนี้จะกลายเป็น '?' และกู้คืนไม่ได้`,
      columns: result.columns.filter((c) => c.lossyRows > 0).map((c) => ({ columnName: c.columnName, rows: c.lossyRows })),
    });
  }
  if (dblTotal > 0) {
    if (result.verdict !== 'block') result.verdict = 'warn';
    result.findings.push({
      level: 'warn', code: 'suspect_double_encoding',
      message: `พบ ${dblTotal.toLocaleString()} แถวในคอลัมน์ charset ไบต์เดียว ที่ไบต์ข้างในดูเหมือนเป็น UTF-8 อยู่แล้ว — การแปลงตรงๆ จะได้ข้อความเพี้ยน (mojibake) ควรใช้วิธีแปลงผ่าน BINARY`,
      columns: result.columns.filter((c) => c.doubleEncodedRows > 0).map((c) => ({ columnName: c.columnName, rows: c.doubleEncodedRows })),
    });
  }

  // Be explicit that a capped scan proves nothing about the rows it never
  // read. A clean verdict on 200k of 40M rows is a sample, not a guarantee.
  if (result.truncated) {
    result.findings.push({
      level: 'warn',
      code: 'partial_scan',
      message: `สแกนเพียง ${Number(result.scannedRows).toLocaleString('en-US')} แถวแรก `
        + `(ตารางมีประมาณ ${Number(table.approxRows || 0).toLocaleString('en-US')} แถว) — `
        + `ผลนี้เป็นการสุ่มตรวจ ไม่ใช่การรับประกันทั้งตาราง`,
    });
  }

  // --- unique-index collision under the target collation ----------------
  if (opts.checkUnique !== false) {
    const uniques = (table.indexes || []).filter((i) =>
      i.unique && i.parts.some((p) => {
        const col = table.columns.find((c) => c.columnName === p.columnName);
        return col && changing.includes(col);
      }));
    for (const index of uniques) {
      const exprs = [];
      let usable = true;
      for (const part of index.parts) {
        const col = table.columns.find((c) => c.columnName === part.columnName);
        if (!col) { usable = false; break; }
        if (col.columnCharset) {
          const base = part.subPart ? `LEFT(${q(col.columnName)}, ${Number(part.subPart)})` : q(col.columnName);
          exprs.push(`CONVERT(${base} USING ${charsetName(target.charset)}) COLLATE ${charsetName(target.collation)}`);
        } else {
          exprs.push(q(col.columnName));
        }
      }
      if (!usable) continue;
      const notNull = index.parts.map((p) => `${q(p.columnName)} IS NOT NULL`).join(' AND ');
      const sql =
        `SELECT COUNT(*) AS dupGroups, COALESCE(SUM(__c) - COUNT(*), 0) AS extraRows FROM (
           SELECT COUNT(*) AS __c FROM ${src} WHERE ${notNull}
            GROUP BY ${exprs.join(', ')} HAVING COUNT(*) > 1) AS __g`;
      const r = await safeQuery(conn, sql);
      const entry = {
        indexName: index.indexName,
        columns: index.parts.map((p) => p.columnName),
        dupGroups: r.ok ? Number(r.rows[0].dupGroups) : null,
        extraRows: r.ok ? Number(r.rows[0].extraRows) : null,
        error: r.ok ? null : r.error,
      };
      if (entry.dupGroups > 0) {
        const dupSql =
          `SELECT ${exprs.map((e, i) => `${e} AS __k${i}`).join(', ')}, COUNT(*) AS __c
             FROM ${src} WHERE ${notNull}
            GROUP BY ${exprs.join(', ')} HAVING COUNT(*) > 1 LIMIT ${sampleSize}`;
        const d = await safeQuery(conn, dupSql);
        if (d.ok) entry.samples = d.rows;
        result.verdict = 'block';
        result.findings.push({
          level: 'critical', code: 'unique_collision',
          message: `UNIQUE index ${index.indexName} จะมีค่าซ้ำ ${entry.dupGroups.toLocaleString()} กลุ่ม (${entry.extraRows.toLocaleString()} แถวเกิน) เมื่อใช้ ${target.collation} — ALTER จะล้มเหลวกลางทาง ต้องแก้ข้อมูลก่อน`,
        });
      }
      result.uniqueIndexes.push(entry);
    }
  }

  result.durationMs = Date.now() - started;
  return result;
}

/** Sequential scan over a table set, reporting progress as it goes. */
async function scan(pool, tables, opts, onProgress) {
  const conn = await pool.getConnection();
  const out = {
    target: opts.target,
    startedAt: new Date().toISOString(),
    options: {
      rowLimit: opts.rowLimit || null,
      maxScanBytes: opts.maxScanBytes || null,
      statementTimeoutSec: opts.statementTimeoutSec || null,
      checkUnique: opts.checkUnique !== false,
      checkDoubleEncoding: opts.checkDoubleEncoding !== false,
    },
    tables: [],
  };
  try {
    // Read-only, consistent, and explicitly gentle on the server.
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    out.options.timeout = await limits.applyStatementTimeout(conn, opts.statementTimeoutSec);
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      if (opts.shouldAbort && opts.shouldAbort()) {
        out.cancelled = true;
        break;
      }
      try {
        out.tables.push(await scanTable(conn, t, opts));
      } catch (err) {
        out.tables.push({
          schemaName: t.schemaName, tableName: t.tableName, scanned: false,
          coverage: 'none',
          verdict: 'unknown', findings: [{ level: 'warn', code: 'scan_error', message: err.message }],
          columns: [], uniqueIndexes: [],
        });
      }
      if (onProgress) onProgress(i + 1, tables.length, t);
    }
  } finally {
    // Never hand a time-limited connection back to the pool - a later ALTER
    // could inherit it (see limits.clearStatementTimeout).
    await limits.clearStatementTimeout(conn);
    conn.release();
  }
  out.finishedAt = new Date().toISOString();
  out.summary = {
    tables: out.tables.length,
    blocked: out.tables.filter((t) => t.verdict === 'block').length,
    warned: out.tables.filter((t) => t.verdict === 'warn').length,
    unknown: out.tables.filter((t) => t.verdict === 'unknown').length,
    ok: out.tables.filter((t) => t.verdict === 'ok').length,
    lossyRows: out.tables.reduce((a, t) => a + t.columns.reduce((b, c) => b + (c.lossyRows || 0), 0), 0),
    doubleEncodedRows: out.tables.reduce((a, t) => a + t.columns.reduce((b, c) => b + (c.doubleEncodedRows || 0), 0), 0),
    uniqueCollisions: out.tables.reduce((a, t) => a + t.uniqueIndexes.reduce((b, u) => b + (u.dupGroups || 0), 0), 0),
  };
  out.summary.partial = out.tables.filter((t) => t.truncated).length;
  out.coverage = out.summary.unknown || out.summary.partial ? 'partial' : 'full';
  out.gate = out.summary.blocked > 0
    ? 'block'
    : (out.summary.warned > 0 || out.coverage === 'partial' ? 'warn' : 'pass');
  return out;
}

module.exports = { scan, scanTable, lossyCondition, doubleEncodedCondition, rowSource };
