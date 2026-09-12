'use strict';
/** All information_schema reads. Read-only, parameterised, no DDL. */
const config = require('../../config');
const { qq } = require('./ident');

const SYS = config.systemSchemas;
const SYSPH = SYS.map(() => '?').join(',');

/** Schema-level defaults + rollup counts. */
async function schemas(pool) {
  const [rows] = await pool.query(
    `SELECT s.SCHEMA_NAME                AS schemaName,
            s.DEFAULT_CHARACTER_SET_NAME AS schemaCharset,
            s.DEFAULT_COLLATION_NAME     AS schemaCollation,
            COUNT(DISTINCT t.TABLE_NAME) AS tableCount,
            COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS sizeBytes,
            COALESCE(SUM(t.TABLE_ROWS), 0) AS approxRows
       FROM information_schema.SCHEMATA s
       LEFT JOIN information_schema.TABLES t
              ON t.TABLE_SCHEMA = s.SCHEMA_NAME AND t.TABLE_TYPE = 'BASE TABLE'
      WHERE s.SCHEMA_NAME NOT IN (${SYSPH})
      GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME
      ORDER BY s.SCHEMA_NAME`,
    SYS
  );
  return rows;
}

const COLUMN_SELECT = `
  SELECT c.TABLE_SCHEMA  AS schemaName,
         c.TABLE_NAME    AS tableName,
         c.COLUMN_NAME   AS columnName,
         c.ORDINAL_POSITION AS ordinal,
         c.COLUMN_TYPE   AS columnType,
         c.DATA_TYPE     AS dataType,
         c.CHARACTER_SET_NAME AS columnCharset,
         c.COLLATION_NAME     AS columnCollation,
         c.CHARACTER_MAXIMUM_LENGTH AS charMaxLen,
         c.CHARACTER_OCTET_LENGTH   AS octetLen,
         c.IS_NULLABLE   AS isNullable,
         c.COLUMN_DEFAULT AS columnDefault,
         c.EXTRA         AS extra,
         c.COLUMN_KEY    AS columnKey,
         c.COLUMN_COMMENT AS columnComment,
         c.GENERATION_EXPRESSION AS generationExpression,
         t.TABLE_COLLATION AS tableCollation,
         tc.CHARACTER_SET_NAME AS tableCharset,
         t.ENGINE        AS engine,
         t.TABLE_ROWS    AS approxRows,
         t.DATA_LENGTH   AS dataLength,
         t.INDEX_LENGTH  AS indexLength,
         t.ROW_FORMAT    AS rowFormat,
         t.CREATE_OPTIONS AS createOptions,
         s.DEFAULT_CHARACTER_SET_NAME AS schemaCharset,
         s.DEFAULT_COLLATION_NAME     AS schemaCollation
    FROM information_schema.COLUMNS c
    JOIN information_schema.TABLES  t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
    JOIN information_schema.SCHEMATA s ON s.SCHEMA_NAME = c.TABLE_SCHEMA
    LEFT JOIN information_schema.COLLATIONS tc ON tc.COLLATION_NAME = t.TABLE_COLLATION
   WHERE c.TABLE_SCHEMA NOT IN (${SYSPH})
     AND t.TABLE_TYPE = 'BASE TABLE'`;

const SORTABLE = {
  schema: 'c.TABLE_SCHEMA', table: 'c.TABLE_NAME', column: 'c.COLUMN_NAME',
  ordinal: 'c.ORDINAL_POSITION', type: 'c.COLUMN_TYPE', charset: 'c.CHARACTER_SET_NAME',
  collation: 'c.COLLATION_NAME', tableCollation: 't.TABLE_COLLATION',
  rows: 't.TABLE_ROWS', size: '(t.DATA_LENGTH + t.INDEX_LENGTH)', engine: 't.ENGINE',
};

/**
 * filters: { schema[], table, column, charset[], collation[], engine[], dataType[],
 *            textOnly, status, q }
 * status: 'compliant' | 'non_compliant' | 'no_charset'
 */
function buildFilters(filters, target) {
  const where = [];
  const params = [];
  const inList = (col, values) => {
    const arr = (Array.isArray(values) ? values : [values]).filter((v) => v !== undefined && v !== null && v !== '');
    if (!arr.length) return;
    where.push(`${col} IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  };
  inList('c.TABLE_SCHEMA', filters.schema);
  inList('c.CHARACTER_SET_NAME', filters.charset);
  inList('c.COLLATION_NAME', filters.collation);
  inList('t.ENGINE', filters.engine);
  inList('c.DATA_TYPE', filters.dataType);
  if (filters.table) { where.push('c.TABLE_NAME LIKE ?'); params.push(`%${filters.table}%`); }
  if (filters.column) { where.push('c.COLUMN_NAME LIKE ?'); params.push(`%${filters.column}%`); }
  if (filters.textOnly) where.push('c.CHARACTER_SET_NAME IS NOT NULL');
  if (filters.q) {
    where.push('(c.TABLE_SCHEMA LIKE ? OR c.TABLE_NAME LIKE ? OR c.COLUMN_NAME LIKE ? OR c.COLUMN_TYPE LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like, like);
  }
  if (filters.status === 'compliant') {
    where.push('c.CHARACTER_SET_NAME = ? AND c.COLLATION_NAME = ?');
    params.push(target.charset, target.collation);
  } else if (filters.status === 'non_compliant') {
    where.push('c.CHARACTER_SET_NAME IS NOT NULL AND NOT (c.CHARACTER_SET_NAME = ? AND c.COLLATION_NAME = ?)');
    params.push(target.charset, target.collation);
  } else if (filters.status === 'no_charset') {
    where.push('c.CHARACTER_SET_NAME IS NULL');
  }
  return { where, params };
}

async function inventory(pool, opts) {
  const { filters = {}, target, page = 1, pageSize = 100, sort = 'schema', dir = 'asc' } = opts;
  const { where, params } = buildFilters(filters, target);
  const whereSql = where.length ? ` AND ${where.join(' AND ')}` : '';
  const orderCol = SORTABLE[sort] || SORTABLE.schema;
  const orderDir = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(Number(pageSize) || 100, 1), 1000);
  const pageNo = Math.max(Number(page) || 1, 1);
  const offset = (pageNo - 1) * limit;

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
      WHERE c.TABLE_SCHEMA NOT IN (${SYSPH}) AND t.TABLE_TYPE='BASE TABLE'${whereSql}`,
    [...SYS, ...params]
  );

  const [rows] = await pool.query(
    `${COLUMN_SELECT}${whereSql}
      ORDER BY ${orderCol} ${orderDir}, c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
      LIMIT ? OFFSET ?`,
    [...SYS, ...params, limit, offset]
  );

  return { rows, total: Number(countRows[0].total), page: pageNo, pageSize: limit };
}

/** Streamed variant used for CSV export (no pagination, capped). */
async function inventoryAll(pool, opts) {
  const { filters = {}, target, cap = 200000 } = opts;
  const { where, params } = buildFilters(filters, target);
  const whereSql = where.length ? ` AND ${where.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `${COLUMN_SELECT}${whereSql} ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION LIMIT ?`,
    [...SYS, ...params, cap]
  );
  return rows;
}

/** Whole-instance rollup for the dashboard. Aggregated server-side so it stays
 *  cheap on instances with hundreds of thousands of columns. */
async function summary(pool, target, scopeSchemas) {
  const scope = Array.isArray(scopeSchemas) ? scopeSchemas.filter(Boolean) : [];
  const scoped = scope.length > 0;
  const ph = scoped ? scope.map(() => '?').join(',') : '';
  const cScope = scoped ? ` AND c.TABLE_SCHEMA IN (${ph})` : '';
  const tScope = scoped ? ` AND t.TABLE_SCHEMA IN (${ph})` : '';
  const sScope = scoped ? ` AND s.SCHEMA_NAME IN (${ph})` : '';
  const sp = scoped ? scope : [];

  const [colTotals] = await pool.query(
    `SELECT COUNT(*) AS columnsTotal,
            SUM(c.CHARACTER_SET_NAME IS NOT NULL) AS textColumns,
            SUM(c.CHARACTER_SET_NAME = ? AND c.COLLATION_NAME = ?) AS compliantColumns,
            SUM(c.CHARACTER_SET_NAME = ?) AS targetCharsetColumns
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
      WHERE c.TABLE_SCHEMA NOT IN (${SYSPH}) AND t.TABLE_TYPE='BASE TABLE'${cScope}`,
    [target.charset, target.collation, target.charset, ...SYS, ...sp]
  );

  const [byCharset] = await pool.query(
    `SELECT c.CHARACTER_SET_NAME AS charset, COUNT(*) AS columns,
            COUNT(DISTINCT CONCAT(c.TABLE_SCHEMA,'.',c.TABLE_NAME)) AS tables
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
      WHERE c.TABLE_SCHEMA NOT IN (${SYSPH}) AND t.TABLE_TYPE='BASE TABLE'
        AND c.CHARACTER_SET_NAME IS NOT NULL${cScope}
      GROUP BY c.CHARACTER_SET_NAME ORDER BY columns DESC`,
    [...SYS, ...sp]
  );

  const [byCollation] = await pool.query(
    `SELECT c.COLLATION_NAME AS collation, c.CHARACTER_SET_NAME AS charset, COUNT(*) AS columns
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
      WHERE c.TABLE_SCHEMA NOT IN (${SYSPH}) AND t.TABLE_TYPE='BASE TABLE'
        AND c.COLLATION_NAME IS NOT NULL${cScope}
      GROUP BY c.COLLATION_NAME, c.CHARACTER_SET_NAME ORDER BY columns DESC`,
    [...SYS, ...sp]
  );

  const [tableTotals] = await pool.query(
    `SELECT COUNT(*) AS tablesTotal,
            SUM(t.TABLE_COLLATION = ?) AS compliantTables,
            COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS sizeBytes,
            COALESCE(SUM(CASE WHEN t.TABLE_COLLATION <> ? THEN t.DATA_LENGTH + t.INDEX_LENGTH ELSE 0 END), 0) AS pendingBytes
       FROM information_schema.TABLES t
      WHERE t.TABLE_SCHEMA NOT IN (${SYSPH}) AND t.TABLE_TYPE='BASE TABLE'${tScope}`,
    [target.collation, target.collation, ...SYS, ...sp]
  );

  const [byTableCollation] = await pool.query(
    `SELECT t.TABLE_COLLATION AS collation, COUNT(*) AS tables,
            COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH),0) AS sizeBytes
       FROM information_schema.TABLES t
      WHERE t.TABLE_SCHEMA NOT IN (${SYSPH}) AND t.TABLE_TYPE='BASE TABLE'${tScope}
      GROUP BY t.TABLE_COLLATION ORDER BY tables DESC`,
    [...SYS, ...sp]
  );

  const [schemaRows] = await pool.query(
    `SELECT s.SCHEMA_NAME AS schemaName,
            s.DEFAULT_CHARACTER_SET_NAME AS schemaCharset,
            s.DEFAULT_COLLATION_NAME AS schemaCollation,
            (SELECT COUNT(*) FROM information_schema.TABLES t1
              WHERE t1.TABLE_SCHEMA=s.SCHEMA_NAME AND t1.TABLE_TYPE='BASE TABLE') AS tables,
            (SELECT COUNT(*) FROM information_schema.TABLES t2
              WHERE t2.TABLE_SCHEMA=s.SCHEMA_NAME AND t2.TABLE_TYPE='BASE TABLE'
                AND t2.TABLE_COLLATION = ?) AS compliantTables,
            (SELECT COUNT(*) FROM information_schema.COLUMNS c1
               JOIN information_schema.TABLES t3
                 ON t3.TABLE_SCHEMA=c1.TABLE_SCHEMA AND t3.TABLE_NAME=c1.TABLE_NAME
              WHERE c1.TABLE_SCHEMA=s.SCHEMA_NAME AND t3.TABLE_TYPE='BASE TABLE'
                AND c1.CHARACTER_SET_NAME IS NOT NULL) AS textColumns,
            (SELECT COUNT(*) FROM information_schema.COLUMNS c2
               JOIN information_schema.TABLES t4
                 ON t4.TABLE_SCHEMA=c2.TABLE_SCHEMA AND t4.TABLE_NAME=c2.TABLE_NAME
              WHERE c2.TABLE_SCHEMA=s.SCHEMA_NAME AND t4.TABLE_TYPE='BASE TABLE'
                AND c2.CHARACTER_SET_NAME = ? AND c2.COLLATION_NAME = ?) AS compliantColumns,
            (SELECT COALESCE(SUM(t5.DATA_LENGTH+t5.INDEX_LENGTH),0) FROM information_schema.TABLES t5
              WHERE t5.TABLE_SCHEMA=s.SCHEMA_NAME AND t5.TABLE_TYPE='BASE TABLE') AS sizeBytes
       FROM information_schema.SCHEMATA s
      WHERE s.SCHEMA_NAME NOT IN (${SYSPH})${sScope}
      ORDER BY s.SCHEMA_NAME`,
    [target.collation, target.charset, target.collation, ...SYS, ...sp]
  );

  // VIEWS/ROUTINES/EVENTS need extra grants (SHOW VIEW, EVENT). Losing this
  // rollup must not take the whole dashboard down, so it degrades to nulls.
  let otherObjects = [{
    viewsNonCompliant: null, routinesNonCompliant: null,
    triggersNonCompliant: null, eventsNonCompliant: null,
  }];
  try {
    [otherObjects] = await pool.query(
      `SELECT
       (SELECT COUNT(*) FROM information_schema.VIEWS v
         WHERE v.TABLE_SCHEMA NOT IN (${SYSPH})
           AND (v.CHARACTER_SET_CLIENT <> ? OR v.COLLATION_CONNECTION <> ?)) AS viewsNonCompliant,
       (SELECT COUNT(*) FROM information_schema.ROUTINES r
         WHERE r.ROUTINE_SCHEMA NOT IN (${SYSPH})
           AND (r.CHARACTER_SET_CLIENT <> ? OR r.COLLATION_CONNECTION <> ? OR r.DATABASE_COLLATION <> ?)) AS routinesNonCompliant,
       (SELECT COUNT(*) FROM information_schema.TRIGGERS g
         WHERE g.TRIGGER_SCHEMA NOT IN (${SYSPH})
           AND (g.CHARACTER_SET_CLIENT <> ? OR g.COLLATION_CONNECTION <> ?)) AS triggersNonCompliant,
       (SELECT COUNT(*) FROM information_schema.EVENTS e
         WHERE e.EVENT_SCHEMA NOT IN (${SYSPH})
           AND (e.CHARACTER_SET_CLIENT <> ? OR e.COLLATION_CONNECTION <> ?)) AS eventsNonCompliant`,
      [...SYS, target.charset, target.collation,
        ...SYS, target.charset, target.collation, target.collation,
        ...SYS, target.charset, target.collation,
        ...SYS, target.charset, target.collation]
    );
  } catch (err) {
    otherObjects[0].error = err.message;
  }

  const ct = colTotals[0];
  const tt = tableTotals[0];
  const num = (v) => Number(v || 0);
  const pct = (a, b) => (b ? Number(((a / b) * 100).toFixed(2)) : 0);
  const compliantSchemas = schemaRows.filter((s) => s.schemaCollation === target.collation).length;

  return {
    target,
    columns: {
      total: num(ct.columnsTotal),
      text: num(ct.textColumns),
      compliant: num(ct.compliantColumns),
      targetCharsetOnly: num(ct.targetCharsetColumns),
      pending: num(ct.textColumns) - num(ct.compliantColumns),
      compliantPct: pct(num(ct.compliantColumns), num(ct.textColumns)),
    },
    tables: {
      total: num(tt.tablesTotal),
      compliant: num(tt.compliantTables),
      pending: num(tt.tablesTotal) - num(tt.compliantTables),
      compliantPct: pct(num(tt.compliantTables), num(tt.tablesTotal)),
      sizeBytes: num(tt.sizeBytes),
      pendingBytes: num(tt.pendingBytes),
    },
    schemas: {
      total: schemaRows.length,
      compliant: compliantSchemas,
      compliantPct: pct(compliantSchemas, schemaRows.length),
      rows: schemaRows.map((s) => ({
        schemaName: s.schemaName,
        schemaCharset: s.schemaCharset,
        schemaCollation: s.schemaCollation,
        tables: num(s.tables),
        compliantTables: num(s.compliantTables),
        textColumns: num(s.textColumns),
        compliantColumns: num(s.compliantColumns),
        sizeBytes: num(s.sizeBytes),
        tablePct: pct(num(s.compliantTables), num(s.tables)),
        columnPct: pct(num(s.compliantColumns), num(s.textColumns)),
      })),
    },
    byCharset: byCharset.map((r) => ({
      charset: r.charset, columns: num(r.columns), tables: num(r.tables),
      pct: pct(num(r.columns), num(ct.textColumns)),
    })),
    byCollation: byCollation.map((r) => ({
      collation: r.collation, charset: r.charset, columns: num(r.columns),
      pct: pct(num(r.columns), num(ct.textColumns)),
    })),
    byTableCollation: byTableCollation.map((r) => ({
      collation: r.collation, tables: num(r.tables), sizeBytes: num(r.sizeBytes),
      pct: pct(num(r.tables), num(tt.tablesTotal)),
    })),
    otherObjects: Object.fromEntries(Object.entries(otherObjects[0])
      .map(([k, v]) => [k, k === 'error' ? v : (v === null ? null : num(v))])),
  };
}

/** Distinct values for the filter dropdowns. */
async function facets(pool) {
  const [charsets] = await pool.query(
    `SELECT DISTINCT CHARACTER_SET_NAME AS v FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA NOT IN (${SYSPH}) AND CHARACTER_SET_NAME IS NOT NULL ORDER BY v`, SYS);
  const [collations] = await pool.query(
    `SELECT DISTINCT COLLATION_NAME AS v FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA NOT IN (${SYSPH}) AND COLLATION_NAME IS NOT NULL ORDER BY v`, SYS);
  const [engines] = await pool.query(
    `SELECT DISTINCT ENGINE AS v FROM information_schema.TABLES
      WHERE TABLE_SCHEMA NOT IN (${SYSPH}) AND ENGINE IS NOT NULL ORDER BY v`, SYS);
  const [dataTypes] = await pool.query(
    `SELECT DISTINCT DATA_TYPE AS v FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA NOT IN (${SYSPH}) AND CHARACTER_SET_NAME IS NOT NULL ORDER BY v`, SYS);
  const [supported] = await pool.query(
    `SELECT COLLATION_NAME AS collation, CHARACTER_SET_NAME AS charset, IS_DEFAULT AS isDefault
       FROM information_schema.COLLATIONS ORDER BY CHARACTER_SET_NAME, COLLATION_NAME`);
  return {
    charsets: charsets.map((r) => r.v),
    collations: collations.map((r) => r.v),
    engines: engines.map((r) => r.v),
    dataTypes: dataTypes.map((r) => r.v),
    supported,
  };
}

/** Table-level detail (columns + indexes + FKs + partitions) needed to build a plan. */
/**
 * The work list: one row per table, with everything needed to decide "do I
 * have to touch this one, and how expensive will it be?".
 *
 * This is the table-centric replacement for driving the app off a
 * column-level inventory. The console migrates one table at a time, so the
 * list of tables - not the list of 40,000 columns - is the thing an operator
 * actually navigates.
 */
async function tableList(pool, opts) {
  const { target, filters = {}, page = 1, pageSize = 50, sort = 'name', dir = 'asc' } = opts;
  const where = [`t.TABLE_SCHEMA NOT IN (${SYSPH})`, `t.TABLE_TYPE='BASE TABLE'`];
  const params = [...SYS];

  const schemaList = (filters.schema || []).filter(Boolean);
  if (schemaList.length) {
    where.push(`t.TABLE_SCHEMA IN (${schemaList.map(() => '?').join(',')})`);
    params.push(...schemaList);
  }
  const engineList = (filters.engine || []).filter(Boolean);
  if (engineList.length) {
    where.push(`t.ENGINE IN (${engineList.map(() => '?').join(',')})`);
    params.push(...engineList);
  }
  if (filters.q) {
    where.push(`(t.TABLE_NAME LIKE ? OR t.TABLE_SCHEMA LIKE ?)`);
    params.push(`%${filters.q}%`, `%${filters.q}%`);
  }

  const [rows] = await pool.query(
    `SELECT t.TABLE_SCHEMA AS schemaName, t.TABLE_NAME AS tableName, t.ENGINE AS engine,
            t.TABLE_COLLATION AS tableCollation, tc.CHARACTER_SET_NAME AS tableCharset,
            t.TABLE_ROWS AS approxRows, t.DATA_LENGTH AS dataLength, t.INDEX_LENGTH AS indexLength,
            t.ROW_FORMAT AS rowFormat,
            COALESCE(cc.textColumns, 0)      AS textColumns,
            COALESCE(cc.compliantColumns, 0) AS compliantColumns,
            COALESCE(cc.totalColumns, 0)     AS totalColumns
       FROM information_schema.TABLES t
       LEFT JOIN information_schema.COLLATIONS tc ON tc.COLLATION_NAME = t.TABLE_COLLATION
       LEFT JOIN (
            SELECT c.TABLE_SCHEMA AS s, c.TABLE_NAME AS n,
                   COUNT(*) AS totalColumns,
                   SUM(c.CHARACTER_SET_NAME IS NOT NULL) AS textColumns,
                   SUM(c.CHARACTER_SET_NAME = ? AND c.COLLATION_NAME = ?) AS compliantColumns
              FROM information_schema.COLUMNS c
             WHERE c.TABLE_SCHEMA NOT IN (${SYSPH})
             GROUP BY c.TABLE_SCHEMA, c.TABLE_NAME
       ) cc ON cc.s = t.TABLE_SCHEMA AND cc.n = t.TABLE_NAME
      WHERE ${where.join(' AND ')}`,
    [target.charset, target.collation, ...SYS, ...params]
  );

  // Compliance is decided here rather than in SQL so the rule stays in one
  // place and matches what the planner will actually do.
  const enriched = rows.map((r) => {
    const textColumns = Number(r.textColumns || 0);
    const compliantColumns = Number(r.compliantColumns || 0);
    const columnsPending = textColumns - compliantColumns;
    const tableDefaultOk = r.tableCollation === target.collation;
    return {
      ...r,
      key: `${r.schemaName}.${r.tableName}`,
      textColumns,
      compliantColumns,
      columnsPending,
      sizeBytes: Number(r.dataLength || 0) + Number(r.indexLength || 0),
      approxRows: Number(r.approxRows || 0),
      tableDefaultOk,
      needsRebuild: columnsPending > 0,
      needsChange: columnsPending > 0 || !tableDefaultOk,
      status: columnsPending > 0 ? 'rebuild' : (tableDefaultOk ? 'compliant' : 'metadata_only'),
    };
  });

  const status = filters.status || '';
  const filtered = enriched.filter((r) => {
    if (status === 'todo') return r.needsChange;
    if (status === 'rebuild') return r.status === 'rebuild';
    if (status === 'metadata_only') return r.status === 'metadata_only';
    if (status === 'compliant') return r.status === 'compliant';
    return true;
  });

  const cmp = {
    name: (a, b) => a.key.localeCompare(b.key),
    size: (a, b) => a.sizeBytes - b.sizeBytes,
    rows: (a, b) => a.approxRows - b.approxRows,
    pending: (a, b) => a.columnsPending - b.columnsPending,
  }[sort] || ((a, b) => a.key.localeCompare(b.key));
  filtered.sort((a, b) => (dir === 'desc' ? -cmp(a, b) : cmp(a, b)));

  const size = Math.min(Math.max(Number(pageSize) || 50, 10), 500);
  const pageNo = Math.max(Number(page) || 1, 1);
  return {
    total: filtered.length,
    page: pageNo,
    pageSize: size,
    counts: {
      all: enriched.length,
      todo: enriched.filter((r) => r.needsChange).length,
      rebuild: enriched.filter((r) => r.status === 'rebuild').length,
      metadataOnly: enriched.filter((r) => r.status === 'metadata_only').length,
      compliant: enriched.filter((r) => r.status === 'compliant').length,
      pendingBytes: enriched.filter((r) => r.needsRebuild).reduce((a, r) => a + r.sizeBytes, 0),
    },
    // `all` is for the export, which has to hand over every matching row rather
    // than the page the operator happens to be looking at.
    rows: opts.all ? filtered : filtered.slice((pageNo - 1) * size, pageNo * size),
  };
}

async function tablesForPlan(pool, opts) {
  const { schemas: scopeSchemas = [], tables = [], onlyNonCompliant = true, target } = opts;
  const where = [`t.TABLE_SCHEMA NOT IN (${SYSPH})`, `t.TABLE_TYPE='BASE TABLE'`];
  const params = [...SYS];
  if (scopeSchemas.length) {
    where.push(`t.TABLE_SCHEMA IN (${scopeSchemas.map(() => '?').join(',')})`);
    params.push(...scopeSchemas);
  }
  if (tables.length) {
    where.push(`CONCAT(t.TABLE_SCHEMA,'.',t.TABLE_NAME) IN (${tables.map(() => '?').join(',')})`);
    params.push(...tables);
  }
  const [rows] = await pool.query(
    `SELECT t.TABLE_SCHEMA AS schemaName, t.TABLE_NAME AS tableName, t.ENGINE AS engine,
            t.TABLE_COLLATION AS tableCollation, tc.CHARACTER_SET_NAME AS tableCharset,
            t.TABLE_ROWS AS approxRows, t.DATA_LENGTH AS dataLength, t.INDEX_LENGTH AS indexLength,
            t.ROW_FORMAT AS rowFormat, t.CREATE_OPTIONS AS createOptions,
            s.DEFAULT_CHARACTER_SET_NAME AS schemaCharset, s.DEFAULT_COLLATION_NAME AS schemaCollation
       FROM information_schema.TABLES t
       JOIN information_schema.SCHEMATA s ON s.SCHEMA_NAME = t.TABLE_SCHEMA
       LEFT JOIN information_schema.COLLATIONS tc ON tc.COLLATION_NAME = t.TABLE_COLLATION
      WHERE ${where.join(' AND ')}
      ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME`,
    params
  );
  if (!rows.length) return [];

  const keys = rows.map((r) => `${r.schemaName}.${r.tableName}`);
  const keyPh = keys.map(() => '?').join(',');

  const [cols] = await pool.query(
    `SELECT c.TABLE_SCHEMA AS schemaName, c.TABLE_NAME AS tableName, c.COLUMN_NAME AS columnName,
            c.ORDINAL_POSITION AS ordinal, c.COLUMN_TYPE AS columnType, c.DATA_TYPE AS dataType,
            c.CHARACTER_SET_NAME AS columnCharset, c.COLLATION_NAME AS columnCollation,
            c.CHARACTER_MAXIMUM_LENGTH AS charMaxLen, c.IS_NULLABLE AS isNullable,
            c.COLUMN_DEFAULT AS columnDefault, c.EXTRA AS extra, c.COLUMN_KEY AS columnKey,
            c.COLUMN_COMMENT AS columnComment, c.GENERATION_EXPRESSION AS generationExpression
       FROM information_schema.COLUMNS c
      WHERE CONCAT(c.TABLE_SCHEMA,'.',c.TABLE_NAME) IN (${keyPh})
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`,
    keys
  );

  const [idx] = await pool.query(
    `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, INDEX_NAME AS indexName,
            NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS columnName,
            SUB_PART AS subPart, INDEX_TYPE AS indexType
       FROM information_schema.STATISTICS
      WHERE CONCAT(TABLE_SCHEMA,'.',TABLE_NAME) IN (${keyPh})
      ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    keys
  );

  // Both sides' charset and collation come back with the constraint. MySQL
  // rejects an ALTER that leaves the two ends of a text foreign key
  // incompatible, so a plan cannot be judged without knowing what the OTHER
  // table's column is - and that table is usually not in this query's scope.
  const [fks] = await pool.query(
    `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_SCHEMA AS schemaName, k.TABLE_NAME AS tableName,
            k.COLUMN_NAME AS columnName, k.REFERENCED_TABLE_SCHEMA AS refSchema,
            k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refColumn,
            k.ORDINAL_POSITION AS ordinal,
            rc.DELETE_RULE AS deleteRule, rc.UPDATE_RULE AS updateRule,
            cc.CHARACTER_SET_NAME AS childCharset, cc.COLLATION_NAME AS childCollation,
            cc.COLUMN_TYPE AS childType, cc.DATA_TYPE AS childDataType,
            cc.IS_NULLABLE AS childNullable, cc.COLUMN_DEFAULT AS childDefault,
            cc.EXTRA AS childExtra, cc.COLUMN_COMMENT AS childComment,
            cc.GENERATION_EXPRESSION AS childGeneration,
            pc.CHARACTER_SET_NAME AS parentCharset, pc.COLLATION_NAME AS parentCollation,
            pc.COLUMN_TYPE AS parentType, pc.DATA_TYPE AS parentDataType,
            pc.IS_NULLABLE AS parentNullable, pc.COLUMN_DEFAULT AS parentDefault,
            pc.EXTRA AS parentExtra, pc.COLUMN_COMMENT AS parentComment,
            pc.GENERATION_EXPRESSION AS parentGeneration
       FROM information_schema.KEY_COLUMN_USAGE k
       LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND rc.TABLE_NAME = k.TABLE_NAME
       LEFT JOIN information_schema.COLUMNS cc
         ON cc.TABLE_SCHEMA = k.TABLE_SCHEMA AND cc.TABLE_NAME = k.TABLE_NAME
        AND cc.COLUMN_NAME = k.COLUMN_NAME
       LEFT JOIN information_schema.COLUMNS pc
         ON pc.TABLE_SCHEMA = k.REFERENCED_TABLE_SCHEMA AND pc.TABLE_NAME = k.REFERENCED_TABLE_NAME
        AND pc.COLUMN_NAME = k.REFERENCED_COLUMN_NAME
      WHERE k.REFERENCED_TABLE_NAME IS NOT NULL
        AND (CONCAT(k.TABLE_SCHEMA,'.',k.TABLE_NAME) IN (${keyPh})
          OR CONCAT(k.REFERENCED_TABLE_SCHEMA,'.',k.REFERENCED_TABLE_NAME) IN (${keyPh}))
      ORDER BY k.CONSTRAINT_SCHEMA, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [...keys, ...keys]
  );

  const [parts] = await pool.query(
    `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, COUNT(*) AS partitions
       FROM information_schema.PARTITIONS
      WHERE PARTITION_NAME IS NOT NULL
        AND CONCAT(TABLE_SCHEMA,'.',TABLE_NAME) IN (${keyPh})
      GROUP BY TABLE_SCHEMA, TABLE_NAME`,
    keys
  );

  const byKey = new Map(rows.map((r) => [`${r.schemaName}.${r.tableName}`, {
    ...r,
    approxRows: Number(r.approxRows || 0),
    dataLength: Number(r.dataLength || 0),
    indexLength: Number(r.indexLength || 0),
    columns: [], indexes: [], foreignKeys: [], partitions: 0,
  }]));
  for (const c of cols) {
    const t = byKey.get(`${c.schemaName}.${c.tableName}`);
    if (t) t.columns.push(c);
  }
  const idxMap = new Map();
  for (const i of idx) {
    const k = `${i.schemaName}.${i.tableName}`;
    if (!idxMap.has(k)) idxMap.set(k, new Map());
    const m = idxMap.get(k);
    if (!m.has(i.indexName)) {
      m.set(i.indexName, { indexName: i.indexName, unique: !Number(i.nonUnique), indexType: i.indexType, parts: [] });
    }
    m.get(i.indexName).parts.push({ columnName: i.columnName, subPart: i.subPart == null ? null : Number(i.subPart) });
  }
  for (const [k, m] of idxMap) {
    const t = byKey.get(k);
    if (t) t.indexes = [...m.values()];
  }
  for (const f of fks) {
    const child = byKey.get(`${f.schemaName}.${f.tableName}`);
    if (child) child.foreignKeys.push({ ...f, direction: 'outbound' });
    const parent = byKey.get(`${f.refSchema}.${f.refTable}`);
    if (parent) parent.foreignKeys.push({ ...f, direction: 'inbound' });
  }
  for (const p of parts) {
    const t = byKey.get(`${p.schemaName}.${p.tableName}`);
    if (t) t.partitions = Number(p.partitions);
  }

  let list = [...byKey.values()];
  if (onlyNonCompliant) {
    list = list.filter((t) =>
      t.tableCollation !== target.collation ||
      t.columns.some((c) => c.columnCharset && (c.columnCharset !== target.charset || c.columnCollation !== target.collation)));
  }
  return list;
}

async function showCreateTable(conn, schemaName, tableName) {
  const [rows] = await conn.query(`SHOW CREATE TABLE ${qq(schemaName, tableName)}`);
  const r = rows[0] || {};
  return r['Create Table'] || r['Create View'] || null;
}

module.exports = {
  schemas, inventory, inventoryAll, summary, facets, tablesForPlan, tableList,
  showCreateTable, buildFilters, SORTABLE,
};
