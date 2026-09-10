// Workflow state.
//
// The old model was a shared "scope" (a set of schemas + an optional table
// list) that every page mutated, so it was never obvious what the next button
// was about to touch. This one is table-centric: you pick exactly one table,
// and its five steps - preflight, baseline, plan, run, verify - carry their
// own ids. Nothing here can address more than one table at a time.

const STORAGE = 'csmig.work';

/** Per-table progress, keyed by 'schema.table'. */
export const work = {
  current: null,   // 'schema.table' currently open in the workspace
  byTable: {},     // key -> { preflightId, checksumId, planId, jobId, verifyId }
};

export const cache = {
  schemas: null,
  facets: null,
  summary: null,
};

function persist() {
  try {
    sessionStorage.setItem(STORAGE, JSON.stringify({ current: work.current, byTable: work.byTable }));
  } catch { /* private mode / quota - progress is a convenience, not state of record */ }
}

(function restore() {
  try {
    const raw = sessionStorage.getItem(STORAGE);
    if (!raw) return;
    const saved = JSON.parse(raw);
    work.current = saved.current || null;
    work.byTable = saved.byTable || {};
  } catch { /* ignore a corrupt blob */ }
}());

/** Progress record for one table, created on first touch. */
export function tableState(key) {
  if (!work.byTable[key]) {
    work.byTable[key] = {
      preflightId: null, preflightGate: null, preflightAt: null,
      checksumId: null, checksumAt: null,
      planId: null, planAt: null,
      jobId: null, jobStatus: null,
      verifyId: null, verifyOk: null,
    };
  }
  return work.byTable[key];
}

export function setTableState(key, patch) {
  const st = tableState(key);
  Object.assign(st, patch);
  persist();
  return st;
}

export function openTable(key) {
  work.current = key;
  tableState(key);
  persist();
}

export function resetTable(key) {
  delete work.byTable[key];
  persist();
}

/** Split 'schema.table' - schema names cannot contain a dot in MySQL, table
 *  names can, so only the first separator counts. */
export function splitKey(key) {
  const i = String(key).indexOf('.');
  return { schemaName: String(key).slice(0, i), tableName: String(key).slice(i + 1) };
}

/**
 * Request body for every scan/plan/run call: exactly one table, never a
 * schema. `onlyNonCompliant: false` because the table was chosen explicitly -
 * the server must not silently drop it.
 */
export function tableBody(key, extra = {}) {
  return { schemas: [], tables: [key], onlyNonCompliant: false, ...extra };
}

/** Which step the operator should be looking at next. */
export function nextStep(st) {
  if (!st.preflightId || st.preflightGate === null) return 1;
  if (!st.checksumId) return 2;
  if (!st.planId) return 3;
  if (!st.jobId || st.jobStatus !== 'done') return 4;
  return 5;
}
