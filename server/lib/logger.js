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

function auditFile(when = new Date()) {
  const day = when.toISOString().slice(0, 10);
  return path.join(config.paths.audit, `audit-${day}.ndjson`);
}

function writeLine(file, record) {
  const line = JSON.stringify(redact(record)) + '\n';
  try {
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[logger] cannot write ${file}: ${err.message}\n`);
  }
}

/** Write an audit event. `event` is a dotted name, e.g. "session.connect". */
function audit(event, data = {}) {
  const record = { ts: new Date().toISOString(), event, ...data };
  writeLine(auditFile(), record);
  return record;
}

/** Per-job NDJSON stream (kept next to the job manifest). */
function jobLog(jobId, event, data = {}) {
  const record = { ts: new Date().toISOString(), jobId, event, ...data };
  writeLine(path.join(config.paths.jobs, `${jobId}.ndjson`), record);
  writeLine(auditFile(), record);
  return record;
}

function readJobLog(jobId, limit = 5000) {
  const file = path.join(config.paths.jobs, `${jobId}.ndjson`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

function listAuditDays() {
  if (!fs.existsSync(config.paths.audit)) return [];
  return fs.readdirSync(config.paths.audit).filter((f) => f.endsWith('.ndjson')).sort().reverse();
}

function readAudit(day, limit = 2000) {
  const file = path.join(config.paths.audit, day.endsWith('.ndjson') ? day : `audit-${day}.ndjson`);
  if (!path.resolve(file).startsWith(path.resolve(config.paths.audit))) throw new Error('invalid audit path');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
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
  audit, jobLog, readJobLog, listAuditDays, readAudit,
  redact, registerSecret, forgetSecret, fingerprint,
  writeJson, readJson, listJson,
};
