'use strict';
/**
 * In-memory credential vault + per-session MySQL pool.
 *
 * Security posture (documented in README):
 *  - the password is accepted over loopback only, sealed with AES-256-GCM under
 *    a key generated fresh for this process and never written anywhere
 *  - it is never persisted, never returned by any API response, and is
 *    registered with the logger so it can never appear in a log line
 *  - sessions self-destruct on idle timeout; the sealed buffer is zero-filled
 */
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const config = require('../config');
const log = require('./lib/logger');

const VAULT_KEY = crypto.randomBytes(32);
const sessions = new Map();

function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

function unseal(box) {
  const d = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, box.iv);
  d.setAuthTag(box.tag);
  return Buffer.concat([d.update(box.ct), d.final()]).toString('utf8');
}

function wipe(box) {
  if (!box) return;
  for (const b of [box.iv, box.ct, box.tag]) if (Buffer.isBuffer(b)) b.fill(0);
}

async function probe(conn) {
  const [[ver]] = await conn.query(
    `SELECT VERSION() AS version, @@hostname AS hostname, @@character_set_server AS charsetServer,
            @@collation_server AS collationServer, @@read_only AS readOnly, @@version_comment AS comment,
            CURRENT_USER() AS currentUser, @@innodb_default_row_format AS rowFormat`
  );
  let grants = [];
  try {
    const [rows] = await conn.query('SHOW GRANTS');
    grants = rows.map((r) => Object.values(r)[0]);
  } catch { /* not fatal */ }
  let replica = null;
  try {
    const [rows] = await conn.query('SHOW REPLICA STATUS');
    if (rows.length) replica = { role: 'replica', lagSec: rows[0].Seconds_Behind_Source };
  } catch {
    try {
      const [rows] = await conn.query('SHOW SLAVE STATUS');
      if (rows.length) replica = { role: 'replica', lagSec: rows[0].Seconds_Behind_Master };
    } catch { /* ignore */ }
  }
  const canAlter = grants.some((g) => /ALL PRIVILEGES|\bALTER\b/i.test(g));
  return {
    version: ver.version,
    versionComment: ver.comment,
    hostname: ver.hostname,
    currentUser: ver.currentUser,
    charsetServer: ver.charsetServer,
    collationServer: ver.collationServer,
    readOnly: !!Number(ver.readOnly),
    rowFormat: ver.rowFormat,
    replica,
    canAlter,
    // never include grants verbatim if they contain IDENTIFIED BY - logger scrubs, but
    // we also keep them out of the API payload beyond the boolean above.
    grantCount: grants.length,
  };
}

async function create({ host, port, user, password, database, ssl }) {
  if (sessions.size >= config.session.maxSessions) {
    throw Object.assign(new Error('มี session เปิดอยู่มากเกินไป กรุณาปิด session เดิมก่อน'), { status: 429 });
  }
  const id = crypto.randomBytes(24).toString('base64url');
  const fp = log.registerSecret(password);

  const poolOptions = {
    host, port: Number(port) || 3306, user, password,
    database: database || undefined,
    waitForConnections: true,
    connectionLimit: config.pool.connectionLimit,
    queueLimit: 0,
    connectTimeout: config.pool.connectTimeoutMs,
    multipleStatements: false,      // hard-off: no statement stacking
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',             // client-side connection charset stays widest
    ssl: ssl ? { rejectUnauthorized: ssl === 'verify' } : undefined,
    enableKeepAlive: true,
  };

  const pool = mysql.createPool(poolOptions);
  let info;
  try {
    const conn = await pool.getConnection();
    try { info = await probe(conn); } finally { conn.release(); }
  } catch (err) {
    await pool.end().catch(() => {});
    log.forgetSecret(password);
    throw err;
  }

  const session = {
    id,
    pool,
    host, port: poolOptions.port, user,
    database: database || null,
    ssl: ssl || null,
    sealed: seal(password),
    passwordFingerprint: fp,
    serverInfo: info,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  sessions.set(id, session);
  log.auditFor(session, 'session.connect', {
    sessionId: id, host, port: session.port, user,
    passwordFingerprint: fp, serverVersion: info.version, readOnly: info.readOnly,
  });
  return session;
}

function get(id) {
  const s = sessions.get(id);
  if (!s) return null;
  s.lastSeenAt = Date.now();
  return s;
}

/** Reveal the password only to in-process consumers that genuinely need it
 *  (currently: mysqldump backups). Every call is audited. */
function revealPassword(session, reason) {
  log.auditFor(session, 'session.credential.reveal', { sessionId: session.id, reason });
  return unseal(session.sealed);
}

async function destroy(id, reason = 'manual') {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  try { await s.pool.end(); } catch { /* ignore */ }
  try { log.forgetSecret(unseal(s.sealed)); } catch { /* ignore */ }
  wipe(s.sealed);
  s.sealed = null;
  log.auditFor(s, 'session.disconnect', { sessionId: id, reason });
  return true;
}

function publicView(session) {
  return {
    sessionId: session.id,
    host: session.host,
    port: session.port,
    user: session.user,
    database: session.database,
    ssl: session.ssl,
    createdAt: new Date(session.createdAt).toISOString(),
    idleTimeoutMs: config.session.idleTimeoutMs,
    server: session.serverInfo,
    target: config.target,
  };
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeenAt > config.session.idleTimeoutMs) destroy(id, 'idle-timeout');
  }
}, 60_000);
sweeper.unref();

async function destroyAll(reason) {
  await Promise.all([...sessions.keys()].map((id) => destroy(id, reason)));
}

module.exports = { create, get, destroy, destroyAll, publicView, revealPassword, count: () => sessions.size };
