'use strict';
/**
 * Where one endpoint's evidence lives on disk.
 *
 * Everything this console writes - the audit trail, generated plans, preflight
 * and checksum snapshots, job manifests and their backups - is a statement
 * about ONE MySQL endpoint. A flat `data/` made that impossible to see: a uat
 * run and a prod run landed in the same pile, told apart only by opening the
 * files. Worse, nothing stopped a checksum baseline taken on uat from being
 * handed to a verify running against prod, and the digests would simply
 * disagree with no explanation of why.
 *
 * So artifacts are filed under the endpoint that produced them:
 *
 *   data/hosts/<host>_<port>/{audit,jobs,plans,snapshots}/
 *
 * `data/audit/` stays, holding what belongs to no endpoint: this process
 * starting and stopping, crashes, and connection attempts that never became a
 * session. Everything else is per-host, and every record now names its
 * endpoint inside itself as well, so a file that gets copied somewhere else
 * still says where it came from.
 *
 * The old flat `data/{jobs,plans,snapshots}` are read-only history. Nothing
 * new is written there and nothing is moved out of them: a plan or a snapshot
 * written before this change simply does not record which endpoint it came
 * from, and inventing an answer would be worse than admitting there isn't one.
 * Records served from there come back flagged `legacy` so a caller can say so
 * instead of implying a provenance it cannot prove.
 */
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const log = require('./logger');

const KINDS = ['audit', 'jobs', 'plans', 'snapshots'];

/**
 * One directory name per endpoint, stable across restarts and safe on every
 * filesystem we run on. Host names are lower-cased because DNS is
 * case-insensitive but Linux directories are not - `PROD.example.com` and
 * `prod.example.com` are the same server and must not become two piles.
 */
function slug(conn) {
  const host = String((conn && conn.host) || '').toLowerCase();
  const port = Number((conn && conn.port) || 0) || 3306;
  const safe = host.replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return `${safe || 'unknown-host'}_${port}`;
}

/** How an endpoint is named to a human, in errors and log lines. */
function label(conn) {
  if (!conn || !conn.host) return 'ไม่ทราบเครื่อง';
  return `${conn.user ? `${conn.user}@` : ''}${conn.host}:${Number(conn.port) || 3306}`;
}

/** The identity stamped into every record this console writes. */
function stamp(conn) {
  return conn && conn.host
    ? { host: conn.host, port: Number(conn.port) || 3306, user: conn.user || null }
    : null;
}

function sameEndpoint(a, b) {
  if (!a || !b || !a.host || !b.host) return false;
  return String(a.host).toLowerCase() === String(b.host).toLowerCase()
    && (Number(a.port) || 3306) === (Number(b.port) || 3306);
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`unknown store kind: ${kind}`);
  return kind;
}

/** The per-endpoint directory for one artifact kind, created on demand. */
function dir(conn, kind) {
  assertKind(kind);
  const d = path.join(config.paths.hosts, slug(conn), kind);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Where artifacts of this kind lived before the split. Never written to. */
function legacyDir(kind) {
  return config.paths[assertKind(kind)];
}

/** Every endpoint that has a directory on disk, newest activity first. */
function listHosts() {
  if (!fs.existsSync(config.paths.hosts)) return [];
  return fs.readdirSync(config.paths.hosts, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const base = path.join(config.paths.hosts, e.name);
      const m = /^(.*)_(\d+)$/.exec(e.name);
      let mtime = 0;
      for (const kind of KINDS) {
        try { mtime = Math.max(mtime, fs.statSync(path.join(base, kind)).mtimeMs); } catch { /* absent */ }
      }
      return { slug: e.name, host: m ? m[1] : e.name, port: m ? Number(m[2]) : null, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/* ------------------------------------------------------------------ write */

function writeJson(conn, kind, id, payload) {
  return log.writeJson(dir(conn, kind), id, { ...payload, connection: stamp(conn) });
}

/* ------------------------------------------------------------------- read */

/**
 * One record, looked up against THIS endpoint only.
 *
 * Returns `{ id, data, legacy }`, or null when this endpoint has never seen
 * that id. Scoping the lookup is the point: an id from another endpoint is not
 * found here, and `locate` below turns that into an error that says why rather
 * than a bare 404.
 */
function readJson(conn, kind, id) {
  const own = log.readJson(dir(conn, kind), id);
  if (own) return { id, data: own, legacy: false };
  const old = log.readJson(legacyDir(kind), id);
  if (old) return { id, data: old, legacy: true };
  return null;
}

function listJson(conn, kind) {
  const own = log.listJson(dir(conn, kind)).map((id) => ({ id, legacy: false }));
  const seen = new Set(own.map((e) => e.id));
  const old = log.listJson(legacyDir(kind)).filter((id) => !seen.has(id)).map((id) => ({ id, legacy: true }));
  return [...own, ...old];
}

/**
 * Find which endpoint an id actually belongs to, anywhere on disk.
 *
 * Only ever used to explain a miss. An operator who pastes a checksum id from
 * the uat window into the prod window deserves to be told that is what they
 * did - the alternative is two digests that disagree for reasons nobody can
 * reconstruct an hour later.
 */
function locate(kind, id) {
  assertKind(kind);
  for (const h of listHosts()) {
    const d = path.join(config.paths.hosts, h.slug, kind);
    if (fs.existsSync(path.join(d, `${id}.json`))) {
      return { conn: { host: h.host, port: h.port }, legacy: false };
    }
  }
  if (fs.existsSync(path.join(legacyDir(kind), `${id}.json`))) return { conn: null, legacy: true };
  return null;
}

/**
 * The error for an artifact that exists, but not here.
 *
 * Returns null when there is nothing to explain, so a caller can fall through
 * to its own "not found".
 */
function foreignError(conn, kind, id, what) {
  const found = locate(kind, id);
  if (!found || found.legacy) return null;
  if (sameEndpoint(found.conn, conn)) return null;
  return `${what} ${id} เก็บมาจาก ${label(found.conn)} ไม่ใช่ ${label(conn)} `
    + 'ใช้ข้ามเครื่องไม่ได้ เพราะมันเป็นหลักฐานของอีกฐานข้อมูลหนึ่ง';
}

// The logger writes endpoint-scoped lines through this resolver. Bound here,
// not required there, because store depends on logger and not the other way
// round.
log.bindStore(dir);

module.exports = {
  KINDS, slug, label, stamp, sameEndpoint,
  dir, legacyDir, listHosts,
  writeJson, readJson, listJson, locate, foreignError,
};
