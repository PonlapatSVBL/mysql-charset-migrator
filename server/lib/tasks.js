'use strict';
/** Tiny in-process task registry for the long-running read-only scans
 *  (preflight, checksum snapshot). Results are persisted; progress is polled. */
const crypto = require('crypto');
const log = require('./logger');

const tasks = new Map();

function newId(kind) {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${kind}-${t}-${crypto.randomBytes(3).toString('hex')}`;
}

function create(kind, sessionId, meta = {}) {
  const id = newId(kind);
  const task = {
    id, kind, sessionId, meta,
    status: 'running',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    progress: { done: 0, total: meta.total || 0, current: null },
    result: null,
    error: null,
    cancelRequested: false,
  };
  tasks.set(id, task);
  log.audit(`${kind}.start`, { taskId: id, sessionId, meta });
  return task;
}

function run(task, fn, persistDir) {
  task.promise = (async () => {
    try {
      task.result = await fn((done, total, current) => {
        task.progress = {
          done, total,
          current: current ? `${current.schemaName}.${current.tableName}` : null,
        };
      });
      task.status = task.result && task.result.cancelled ? 'cancelled' : 'done';
      if (persistDir) log.writeJson(persistDir, task.id, { id: task.id, kind: task.kind, createdAt: task.createdAt, meta: task.meta, result: task.result });
      log.audit(`${task.kind}.done`, { taskId: task.id, summary: task.result && task.result.summary });
    } catch (err) {
      task.status = 'failed';
      task.error = err.message;
      log.audit(`${task.kind}.failed`, { taskId: task.id, error: err.message });
    } finally {
      task.finishedAt = new Date().toISOString();
    }
  })();
  return task;
}

const get = (id) => tasks.get(id) || null;

/** Cooperative cancel: the scan loops check `cancelRequested` between tables,
 *  and the statement timeout bounds the table they are already inside. */
function cancel(id) {
  const task = tasks.get(id);
  if (!task || task.status !== 'running') return false;
  task.cancelRequested = true;
  log.audit(`${task.kind}.cancel`, { taskId: id });
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

const list = (kind) => [...tasks.values()]
  .filter((t) => !kind || t.kind === kind)
  .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  .map((t) => view(t));

module.exports = { create, run, get, list, view, cancel };
