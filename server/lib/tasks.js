'use strict';
/** Tiny in-process task registry for the long-running read-only scans
 *  (preflight, checksum snapshot). Results are persisted; progress is polled. */
const crypto = require('crypto');
const log = require('./logger');
const store = require('./store');

const tasks = new Map();

function newId(kind) {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${kind}-${t}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * `sess` is the session the scan runs against. The task keeps its endpoint,
 * not just the session id, because the result outlives the session: it is
 * filed under that endpoint and must never be read back against another one.
 */
function create(kind, sess, meta = {}) {
  const id = newId(kind);
  const task = {
    id, kind, sessionId: sess.id, connection: store.stamp(sess), meta,
    status: 'running',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    progress: { done: 0, total: meta.total || 0, current: null },
    result: null,
    error: null,
    cancelRequested: false,
  };
  tasks.set(id, task);
  log.auditFor(sess, `${kind}.start`, { taskId: id, sessionId: sess.id, meta });
  return task;
}

/** `persist` files the result under the task's own endpoint. */
function run(task, fn, persist = false) {
  task.promise = (async () => {
    try {
      task.result = await fn((done, total, current) => {
        task.progress = {
          done, total,
          current: current ? `${current.schemaName}.${current.tableName}` : null,
        };
      });
      task.status = task.result && task.result.cancelled ? 'cancelled' : 'done';
      if (persist) {
        store.writeJson(task.connection, 'snapshots', task.id, {
          id: task.id, kind: task.kind, createdAt: task.createdAt, meta: task.meta, result: task.result,
        });
      }
      log.auditFor(task.connection, `${task.kind}.done`, { taskId: task.id, summary: task.result && task.result.summary });
    } catch (err) {
      task.status = 'failed';
      task.error = err.message;
      log.auditFor(task.connection, `${task.kind}.failed`, { taskId: task.id, error: err.message });
    } finally {
      task.finishedAt = new Date().toISOString();
    }
  })();
  return task;
}

/**
 * A task, but only when it belongs to `conn`.
 *
 * The registry is per-process, not per-endpoint. Without this check an id from
 * the uat window resolves out of memory in the prod window and never reaches
 * the on-disk scoping at all - which is the exact mix-up filing artifacts per
 * host exists to prevent. `conn` is omitted only by callers that already hold
 * the task and are not answering a request.
 */
function get(id, conn) {
  const task = tasks.get(id) || null;
  if (!task) return null;
  if (conn && !store.sameEndpoint(task.connection, conn)) return null;
  return task;
}

/** Cooperative cancel: the scan loops check `cancelRequested` between tables,
 *  and the statement timeout bounds the table they are already inside. */
function cancel(id, conn) {
  const task = get(id, conn);
  if (!task || task.status !== 'running') return false;
  task.cancelRequested = true;
  log.auditFor(task.connection, `${task.kind}.cancel`, { taskId: id });
  return true;
}

function view(task, includeResult = false) {
  if (!task) return null;
  const base = {
    id: task.id, kind: task.kind, status: task.status, createdAt: task.createdAt,
    finishedAt: task.finishedAt, progress: task.progress, error: task.error, meta: task.meta,
  };
  if (includeResult) base.result = task.result;
  else if (task.result && task.result.summary) base.summary = task.result.summary;
  return base;
}

/** Running and finished tasks for one endpoint. Same reason as get(). */
const list = (kind, conn) => [...tasks.values()]
  .filter((t) => (!kind || t.kind === kind) && (!conn || store.sameEndpoint(t.connection, conn)))
  .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  .map((t) => view(t));

module.exports = { create, run, get, list, view, cancel };
