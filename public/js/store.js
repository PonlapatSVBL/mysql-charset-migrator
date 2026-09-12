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
  endpoint: '',    // 'host:port' these records were made against
  current: null,   // 'schema.table' currently open in the workspace
  byTable: {},     // key -> { preflightId, checksumId, planId, jobId, verifyId }
};

export const cache = {
  schemas: null,
  facets: null,
  summary: null,
};

/**
 * Progress is filed per endpoint, and 'schema.table' is not enough to do that.
 *
 * Two servers in the same estate hold the same schema and table names - that
 * is what a uat copy IS - so a bucket keyed on the table alone hands the uat
 * planId and checksumId straight to the prod workspace the moment the operator
 * reconnects. The ids would then be refused by the server, which is the safety
 * net working; showing them at all is the bug.
 *
 * Buckets are kept rather than dropped so switching back and forth during one
 * migration window does not throw away a half-finished table.
 */
let buckets = {};

function persist() {
  try {
    const all = { ...buckets };
    if (work.endpoint) all[work.endpoint] = { current: work.current, byTable: work.byTable };
    sessionStorage.setItem(STORAGE, JSON.stringify({ endpoint: work.endpoint, buckets: all }));
  } catch { /* private mode / quota - progress is a convenience, not state of record */ }
}

(function restore() {
  try {
    const raw = sessionStorage.getItem(STORAGE);
    if (!raw) return;
    const saved = JSON.parse(raw);
    // A blob written before progress was filed per endpoint has no endpoint to
    // attribute it to, so it is not restored: guessing would put one server's
    // ids in another server's window, which is the whole thing being fixed.
    buckets = saved.buckets || {};
    work.endpoint = saved.endpoint || '';
    const mine = buckets[work.endpoint];
    if (mine) {
      work.current = mine.current || null;
      work.byTable = mine.byTable || {};
    }
  } catch { /* ignore a corrupt blob */ }
}());

/**
 * A run just changed the thing these describe.
 *
 * Schema lists, filter facets and the overview summary are all derived from
 * charsets and collations, which is exactly what a migration moves. Keeping
 * them across a completed job is how the overview goes on reporting work that
 * is already done.
 */
export function invalidateInventory() {
  cache.schemas = null;
  cache.facets = null;
  cache.summary = null;
}

/**
 * Point the workspace at one endpoint. Called from setSession(), which is the
 * only place the answer changes.
 */
export function useEndpoint(ep) {
  const key = ep ? `${ep.host}:${ep.port}` : '';
  if (key === work.endpoint) return;
  if (work.endpoint) buckets[work.endpoint] = { current: work.current, byTable: work.byTable };
  const mine = buckets[key] || { current: null, byTable: {} };
  work.endpoint = key;
  work.current = mine.current || null;
  work.byTable = mine.byTable || {};
  // Schema lists and summaries describe the endpoint too.
  invalidateInventory();
  persist();
}

/** Progress record for one table, created on first touch. */
export function tableState(key) {
  if (!work.byTable[key]) {
    work.byTable[key] = {
      preflightId: null, preflightGate: null, preflightAt: null,
      checksumId: null, checksumAt: null, checksumOk: null,
      planId: null, planAt: null,
      jobId: null, jobStatus: null,
      verifyId: null, verifyOk: null, verifyAppended: 0,
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
  // A baseline that failed leaves nothing to verify against, so it holds the
  // workflow here rather than letting a plan be built on top of it.
  if (!st.checksumId || st.checksumOk === false) return 2;
  if (!st.planId) return 3;
  if (!st.jobId || st.jobStatus !== 'done') return 4;
  return 5;
}
