'use strict';
/**
 * Append-only NDJSON audit log with hard credential redaction.
 *
 * Rules enforced here:
 *  - every record passes through redact() before it touches the disk
 *  - any string registered as a secret is replaced by a stable fingerprint
 *    (sha256 prefix) so logs stay correlatable without ever revealing a value
 *  - keys that look credential-ish are dropped regardless of value
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');

const SECRET_KEYS = /^(pass|password|passwd|pwd|secret|token|auth|authorization|apikey|api_key|key|sealed.*)$/i;
const secrets = new Map(); // raw value -> fingerprint

for (const dir of Object.values(config.paths)) {
  fs.mkdirSync(dir, { recursive: true });
}

function fingerprint(value) {
  return 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/** Register a value that must never appear in any log line. */
function registerSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!secrets.has(value)) secrets.set(value, fingerprint(value));
  return secrets.get(value);
}

function forgetSecret(value) {
  if (typeof value === 'string') secrets.delete(value);
}

function scrubString(str) {
  let out = str;
  for (const [raw, fp] of secrets) {
    if (raw.length >= 3 && out.includes(raw)) out = out.split(raw).join(`«redacted:${fp}»`);
  }
  // Belt and braces: strip inline DSN passwords and IDENTIFIED BY literals.
  out = out.replace(/(mysql:\/\/[^:@\s]+:)[^@\s]+/gi, '$1«redacted»');
  out = out.replace(/(IDENTIFIED\s+(?:WITH\s+\S+\s+)?BY\s+)('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi, '$1«redacted»');
  return out;
}

function redact(value, depth = 0) {
  if (depth > 8) return '«depth-limit»';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message), code: value.code, errno: value.errno, sqlState: value.sqlState };
  }
  if (Buffer.isBuffer(value)) return `«buffer:${value.length}»`;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) { out[k] = '«redacted»'; continue; }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

const auditName = (when = new Date()) => `audit-${when.toISOString().slice(0, 10)}.ndjson`;

/**
 * The process-level audit file: startup, shutdown, crashes, and connection
 * attempts that never became a session. Events that belong to a database go to
 * that endpoint's own file instead - see auditFor().
 */
function auditFile(when = new Date()) {
  return path.join(config.paths.audit, auditName(when));
}

/**
 * How to find an endpoint's directory. Injected by server/lib/store.js at load
 * time rather than required here: store requires this module, and a logger
 * that could not write until the store was ready would lose the first lines of
 * every run. Until it is bound - and for anything with no endpoint - writes
 * fall back to the process-level file.
 */
let dirFor = null;
function bindStore(resolve) { dirFor = resolve; }

function hostAuditFile(conn, when = new Date()) {
  if (!dirFor || !conn || !conn.host) return auditFile(when);
  try {
    return path.join(dirFor(conn, 'audit'), auditName(when));
  } catch {
    return auditFile(when);
  }
}

function writeLine(file, record) {
  const line = JSON.stringify(redact(record)) + '\n';
  try {
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[logger] cannot write ${file}: ${err.message}\n`);
  }
}

/**
 * Write a process-level audit event. `event` is a dotted name, e.g.
 * "server.start". Anything that happened to a database belongs in auditFor().
 */
function audit(event, data = {}) {
  const record = { ts: new Date().toISOString(), event, ...data };
  writeLine(auditFile(), record);
  return record;
}

/**
 * Write an audit event that belongs to one endpoint.
 *
 * The host and port go into the line as well as deciding which file it lands
 * in: a log line that has been copied out of its directory must still say
 * which database it is talking about.
 */
function auditFor(conn, event, data = {}) {
  if (!conn || !conn.host) return audit(event, data);
  const record = {
    ts: new Date().toISOString(), event,
    host: conn.host, port: Number(conn.port) || 3306,
    ...data,
  };
  writeLine(hostAuditFile(conn), record);
  return record;
}

function jobStreamDir(conn) {
  if (!dirFor || !conn || !conn.host) return config.paths.jobs;
  try { return dirFor(conn, 'jobs'); } catch { return config.paths.jobs; }
}

/**
 * Per-job NDJSON stream, kept next to the job manifest and mirrored into that
 * endpoint's audit trail. Takes the job rather than just its id, because the
 * stream has to land beside the manifest - which lives under the job's own
 * endpoint, not in one shared pile.
 */
function jobLog(job, event, data = {}) {
  const id = typeof job === 'string' ? job : job.id;
  const conn = typeof job === 'string' ? null : job.connection;
  const record = {
    ts: new Date().toISOString(), jobId: id, event,
    ...(conn && conn.host ? { host: conn.host, port: Number(conn.port) || 3306 } : {}),
    ...data,
  };
  writeLine(path.join(jobStreamDir(conn), `${id}.ndjson`), record);
  writeLine(conn && conn.host ? hostAuditFile(conn) : auditFile(), record);
  return record;
}

function readLines(file, limit) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

function readJobLog(job, limit = 5000) {
  const id = typeof job === 'string' ? job : job.id;
  const conn = typeof job === 'string' ? null : job.connection;
  // The pre-split flat directory is the fallback, so a job that ran before
  // endpoints were separated still opens in the viewer.
  for (const dir of [jobStreamDir(conn), config.paths.jobs]) {
    const file = path.join(dir, `${id}.ndjson`);
    if (fs.existsSync(file)) return readLines(file, limit);
  }
  return [];
}

const AUDIT_NAME = /^audit-\d{4}-\d{2}-\d{2}\.ndjson$/;

function daysIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => AUDIT_NAME.test(f));
}

/**
 * The days that have a log, for one endpoint plus the process-level trail.
 *
 * The two are offered as one list on purpose: "what happened on 12 Sep" is a
 * single question, and a restart in the middle of a migration is part of its
 * answer.
 */
function listAuditDays(conn) {
  const days = new Set(daysIn(config.paths.audit));
  if (dirFor && conn && conn.host) {
    try { for (const d of daysIn(dirFor(conn, 'audit'))) days.add(d); } catch { /* none yet */ }
  }
  return [...days].sort().reverse();
}

/**
 * Is this line from the process-level file safe to show while connected to
 * `conn`?
 *
 * The process file is not purely process-level: everything written before logs
 * were split by endpoint is still sitting in it, including one server's plans,
 * jobs and steps. Merging it wholesale is how the uat run reappears in the
 * prod window - the complaint that produced this function.
 *
 * A line qualifies only when it belongs to no session (server.start/stop,
 * crashes, api.error with no session) and either names no database or names
 * this one. Pre-split session lines carry a sessionId and nothing else, which
 * is precisely the shape that cannot be attributed - so they stay hidden.
 */
function isProcessLevel(line, conn) {
  if (!line || typeof line !== 'object') return false;
  if (line.sessionId || line.jobId || line.taskId || line.planId) return false;
  if (!line.host) return true;
  return !!conn && String(line.host).toLowerCase() === String(conn.host || '').toLowerCase();
}

function readAudit(conn, day, limit = 2000) {
  const name = String(day).endsWith('.ndjson') ? String(day) : `audit-${day}.ndjson`;
  // The name is matched whole rather than resolved-and-prefix-checked: it is
  // now used against several directories, and one pattern that admits nothing
  // but a dated filename beats repeating a traversal check per directory.
  if (!AUDIT_NAME.test(name)) throw new Error('invalid audit path');

  const lines = readLines(path.join(config.paths.audit, name), limit)
    .filter((l) => isProcessLevel(l, conn));
  if (dirFor && conn && conn.host) {
    try { lines.push(...readLines(path.join(dirFor(conn, 'audit'), name), limit)); } catch { /* none yet */ }
  }
  // Merged, then re-capped: the limit means "the last N lines of that day",
  // whichever of the two files each line came from.
  lines.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return lines.slice(-limit);
}

function writeJson(dir, id, payload) {
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(redact(payload), null, 2), { encoding: 'utf8', mode: 0o600 });
  return file;
}

function readJson(dir, id) {
  const file = path.join(dir, `${id}.json`);
  if (!path.resolve(file).startsWith(path.resolve(dir))) throw new Error('invalid path');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

module.exports = {
  audit, auditFor, jobLog, readJobLog, listAuditDays, readAudit, bindStore,
  redact, registerSecret, forgetSecret, fingerprint,
  writeJson, readJson, listJson,
};
