'use strict';
const path = require('path');

// All values are local-only knobs. Nothing here is ever transmitted anywhere
// except the MySQL host the operator types into the UI.
module.exports = {
  // Loopback only. Refuse to bind a public interface unless the operator
  // explicitly overrides it (and is warned at startup).
  host: process.env.CSMIG_HOST || '127.0.0.1',
  port: Number(process.env.CSMIG_PORT || 7343),

  // Migration target
  target: {
    charset: process.env.CSMIG_TARGET_CHARSET || 'utf8mb3',
    collation: process.env.CSMIG_TARGET_COLLATION || 'utf8mb3_general_ci',
  },

  // Schemas never touched / never inventoried for migration
  systemSchemas: ['information_schema', 'performance_schema', 'mysql', 'sys'],

  // Session handling
  session: {
    idleTimeoutMs: Number(process.env.CSMIG_IDLE_TIMEOUT_MS || 30 * 60 * 1000),
    maxSessions: 4,
  },

  // Connection pool per session
  pool: {
    connectionLimit: Number(process.env.CSMIG_POOL_LIMIT || 4),
    connectTimeoutMs: 15000,
  },

  // Safety defaults for the ALTER runner. Steps always run one at a time, on a
  // single connection - there is deliberately no concurrency knob, because two
  // concurrent table rebuilds is exactly how a migration takes a server down.
  runner: {
    lockWaitTimeoutSec: 30,
    // pause before each ALTER while the server is busier than this
    maxThreadsRunning: Number(process.env.CSMIG_MAX_THREADS_RUNNING || 40),
    maxReplicaLagSec: Number(process.env.CSMIG_MAX_REPLICA_LAG || 30),
    throttleWaitMs: 2000,
    throttleMaxWaits: 150,
    // Emitted as max_execution_time on the RUNNER's connection. MySQL applies
    // it to read queries only, so it does not abort a long ALTER (no
    // server-side timeout exists for DDL - use lock_wait_timeout + KILL).
    // The read-only scans have their own, separate budget: `scan` below.
    statementTimeoutSec: Number(process.env.CSMIG_STMT_TIMEOUT || 0), // 0 = no limit
  },

  // Read-only scan governor. Nothing here may be left "unlimited" by accident:
  // every scan entry point falls back to these numbers when the caller sends
  // nothing, and going unbounded requires an explicit opt-in from the UI.
  scan: {
    // Preflight
    defaultRowLimit: Number(process.env.CSMIG_SCAN_ROWS || 200000),
    maxRowLimit: 50_000_000,
    defaultMaxScanBytes: Number(process.env.CSMIG_SCAN_MAX_BYTES || 5 * 1024 ** 3),
    // Applied as max_execution_time / max_statement_time on the scan session so
    // one pathological table cannot pin the connection forever.
    statementTimeoutSec: Number(process.env.CSMIG_SCAN_TIMEOUT || 60),

    // Checksum
    checksumRowLimit: Number(process.env.CSMIG_CHECKSUM_ROWS || 200000),
    // Above this size a full-table digest is replaced by a deterministic
    // PK-ordered head sample (see server/lib/checksum.js).
    checksumFullMaxBytes: Number(process.env.CSMIG_CHECKSUM_FULL_MAX_BYTES || 2 * 1024 ** 3),
    // Exact COUNT(*) is itself a full scan on InnoDB - skip it above this size.
    exactRowCountMaxBytes: Number(process.env.CSMIG_EXACT_COUNT_MAX_BYTES || 2 * 1024 ** 3),
  },

  // The console deliberately works on ONE table at a time. Scanning, planning
  // and altering a whole schema in a single shot is how an operator loses a
  // morning (or a database), so the API refuses it outright.
  workflow: {
    oneTableAtATime: process.env.CSMIG_ALLOW_BULK !== '1',
  },

  paths: {
    data: path.join(__dirname, 'data'),
    audit: path.join(__dirname, 'data', 'audit'),
    jobs: path.join(__dirname, 'data', 'jobs'),
    snapshots: path.join(__dirname, 'data', 'snapshots'),
    plans: path.join(__dirname, 'data', 'plans'),
  },
};
