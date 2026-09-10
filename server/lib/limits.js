'use strict';
/**
 * The scan governor.
 *
 * Every read-only scan in this app (preflight, checksum) used to accept
 * `rowLimit: null` and quietly turn into an unbounded full-table scan. On a
 * real database that is indistinguishable from a hang: no progress, no
 * timeout, no cancel. This module is the single place that decides how much
 * work a scan is allowed to do, so no call site can forget.
 *
 * Rules:
 *   - a missing / empty / invalid limit becomes the configured default,
 *     never "unlimited"
 *   - unlimited requires the caller to say so explicitly (`full: true`),
 *     and even then the statement timeout still applies
 *   - the limit is clamped, so a typo of 200000000000 cannot get through
 */
const config = require('../../config');

/**
 * @param {*} raw          whatever the client sent
 * @param {object} opts    { def, allowFull }
 * @returns {number|null}  row cap, or null for a deliberate full scan
 */
function rowLimit(raw, { def = config.scan.defaultRowLimit, allowFull = false } = {}) {
  if (raw === 'all' || raw === 0 || raw === '0') return allowFull ? null : def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), config.scan.maxRowLimit);
}

/** Size ceiling above which a table is skipped instead of scanned. */
function maxScanBytes(raw, { def = config.scan.defaultMaxScanBytes, allowFull = false } = {}) {
  if (raw === 'all' || raw === 0 || raw === '0') return allowFull ? null : def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.floor(n);
}

/**
 * Bound every statement on this connection.
 *
 * MySQL 5.7.8+ : max_execution_time, milliseconds, SELECT only.
 * MariaDB 10.1+: max_statement_time, seconds (double), applies more broadly.
 * Both are set inside try/catch: an old server just runs without the guard.
 */
async function applyStatementTimeout(conn, seconds = config.scan.statementTimeoutSec) {
  const sec = Number(seconds);
  if (!Number.isFinite(sec) || sec <= 0) return { applied: false };
  const applied = [];
  try {
    await conn.query(`SET SESSION max_execution_time = ${Math.round(sec * 1000)}`);
    applied.push('max_execution_time');
  } catch { /* not MySQL, or too old */ }
  try {
    await conn.query(`SET SESSION max_statement_time = ${sec}`);
    applied.push('max_statement_time');
  } catch { /* not MariaDB */ }
  return { applied: applied.length > 0, variables: applied, seconds: sec };
}

/** True when a scan was cut short by the row cap rather than reaching the end. */
function isPartial(scannedRows, limit) {
  return !!limit && Number(scannedRows) >= Number(limit);
}

/** Human-readable Thai description of the cap that was in force. */
function limitLabel(limit) {
  return limit ? `จำกัด ${Number(limit).toLocaleString('en-US')} แถวแรก` : 'ทั้งตาราง';
}

/**
 * Undo applyStatementTimeout before handing the connection back to the pool.
 *
 * This matters more than it looks. MySQL's max_execution_time only bounds
 * SELECTs, but MariaDB's max_statement_time bounds *everything* - including
 * DDL. Leaving 60s set on a pooled connection would mean a later ALTER on that
 * same connection gets killed an hour into a table rebuild. Session variables
 * outlive the query; the reset has to be explicit.
 */
async function clearStatementTimeout(conn) {
  for (const stmt of ['SET SESSION max_execution_time = 0', 'SET SESSION max_statement_time = 0']) {
    try { await conn.query(stmt); } catch { /* variable not supported here */ }
  }
}

module.exports = {
  rowLimit, maxScanBytes, applyStatementTimeout, clearStatementTimeout, isPartial, limitLabel,
};
