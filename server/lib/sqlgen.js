'use strict';
/**
 * Deterministic DDL generation: forward statements + the exact inverse for each.
 * Nothing here touches the database - a plan is pure data the operator reviews
 * before anything runs.
 */
const crypto = require('crypto');
const { q, qq, charsetName, sqlString } = require('./ident');

/** Max bytes per character, used for index/row-size growth checks. */
const BYTES_PER_CHAR = {
  ascii: 1, latin1: 1, latin2: 1, latin5: 1, latin7: 1, tis620: 1, cp1250: 1, cp1251: 1,
  cp1256: 1, cp1257: 1, cp850: 1, cp852: 1, cp866: 1, dec8: 1, hp8: 1, keybcs2: 1,
  koi8r: 1, koi8u: 1, macce: 1, macroman: 1, swe7: 1, geostd8: 1, greek: 1, hebrew: 1,
  armscii8: 1, binary: 1, big5: 2, gbk: 2, sjis: 2, euckr: 2, ucs2: 2, cp932: 2,
  gb2312: 2, ujis: 3, eucjpms: 3, utf16: 4, utf16le: 4, utf8: 3, utf8mb3: 3,
  utf8mb4: 4, utf32: 4, gb18030: 4,
};

const bpc = (cs) => BYTES_PER_CHAR[String(cs || '').toLowerCase()] ?? 4;

/**
 * The only charsets MySQL ships whose repertoire reaches past the Basic
 * Multilingual Plane. Everything else - latin1, tis620, big5, sjis, ucs2, the
 * lot - maps entirely inside the BMP, so it survives a trip into utf8mb3
 * intact even though the byte width changes.
 */
const ASTRAL_CHARSETS = new Set(['utf8mb4', 'utf16', 'utf16le', 'utf32', 'gb18030']);
const BMP_UNICODE_CHARSETS = new Set(['utf8', 'utf8mb3', 'ucs2']);

/**
 * Can every character `source` is able to hold also be stored in `target`?
 *
 * This asks about repertoires, not byte widths, and the two point opposite
 * ways: latin1 -> utf8mb3 triples the width per character and cannot lose one,
 * while utf8mb4 -> utf8mb3 narrows it and drops every emoji it meets.
 *
 * `binary` is never a subset of anything (its "characters" are arbitrary
 * bytes), and a name this module has never heard of is treated as unsafe on
 * purpose - the caller uses this to decide what to tick by default, so an
 * unknown charset must fall on the side that does nothing.
 */
function repertoireFits(source, target) {
  const s = String(source || '').toLowerCase();
  const t = String(target || '').toLowerCase();
  if (!s || !t || s === 'binary' || t === 'binary') return false;
  if (!(s in BYTES_PER_CHAR) || !(t in BYTES_PER_CHAR)) return false;
  if (s === t) return true;
  if (ASTRAL_CHARSETS.has(t)) return true;                  // holds all of Unicode
  if (BMP_UNICODE_CHARSETS.has(t)) return !ASTRAL_CHARSETS.has(s);
  return false;                                             // legacy target: only itself
}

const INDEXED_TEXT_TYPES = /^(char|varchar|tinytext|text|mediumtext|longtext|enum|set)$/i;

function indexByteLimit(table) {
  if (String(table.engine).toUpperCase() !== 'INNODB') return 1000; // MyISAM & friends
  const rf = String(table.rowFormat || '').toUpperCase();
  return (rf === 'COMPACT' || rf === 'REDUNDANT') ? 767 : 3072;
}

function stepId(kind, schemaName, tableName, extra = '') {
  const h = crypto.createHash('sha1').update([kind, schemaName, tableName, extra].join('')).digest('hex').slice(0, 8);
  return `${kind}-${h}`;
}

/** Is this column in scope for a charset change? `pick`, when given, is the
 *  operator's explicit column selection and narrows the scope to it. */
function needsColumnChange(col, target, pick = null) {
  if (!col.columnCharset) return false;
  if (pick && !pick.has(col.columnName)) return false;
  return col.columnCharset !== target.charset || col.columnCollation !== target.collation;
}

function isGenerated(col) {
  return !!(col.generationExpression && String(col.generationExpression).length > 0);
}

/** Rebuild a DEFAULT clause from information_schema, honouring MySQL 8
 *  expression defaults and MariaDB's already-quoted representation. */
function defaultClause(col, opts = {}) {
  const raw = col.columnDefault;
  if (raw === null || raw === undefined) return null;
  const extra = String(col.extra || '');
  const type = String(col.dataType || '').toLowerCase();

  if (/^current_timestamp(\(\d*\))?$/i.test(String(raw).trim())) return `DEFAULT ${raw}`;
  if (/^(now|localtime|localtimestamp|utc_timestamp)(\(\d*\))?$/i.test(String(raw).trim())) return `DEFAULT ${raw}`;

  // MariaDB returns literals pre-quoted (including the string NULL).
  if (opts.isMariaDB) {
    if (String(raw).toUpperCase() === 'NULL') return 'DEFAULT NULL';
    return `DEFAULT ${raw}`;
  }
  if (/DEFAULT_GENERATED/i.test(extra)) return `DEFAULT (${raw})`;
  if (type === 'bit') return `DEFAULT ${/^b?'/i.test(raw) ? raw : `b'${raw}'`}`;
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)$/.test(type)) {
    return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(String(raw)) ? `DEFAULT ${raw}` : `DEFAULT ${sqlString(raw)}`;
  }
  return `DEFAULT ${sqlString(raw)}`;
}

/** Full column definition for MODIFY COLUMN, forcing an explicit charset. */
function columnDefinition(col, charset, collation, opts = {}) {
  const parts = [q(col.columnName), col.columnType];
  if (charset) {
    parts.push(`CHARACTER SET ${charsetName(charset)}`);
    if (collation) parts.push(`COLLATE ${charsetName(collation)}`);
  }
  const gen = isGenerated(col);
  if (gen) {
    const stored = /STORED/i.test(String(col.extra || ''));
    parts.push(`GENERATED ALWAYS AS (${col.generationExpression}) ${stored ? 'STORED' : 'VIRTUAL'}`);
  }
  if (col.isNullable === 'NO') parts.push('NOT NULL');
  else if (!gen) parts.push('NULL');

  if (!gen) {
    const def = defaultClause(col, opts);
    if (def) parts.push(def);
  }
  if (/auto_increment/i.test(String(col.extra || ''))) parts.push('AUTO_INCREMENT');
  const onUpdate = /on update (current_timestamp(?:\(\d*\))?)/i.exec(String(col.extra || ''));
  if (onUpdate) parts.push(`ON UPDATE ${onUpdate[1].toUpperCase()}`);
  if (/INVISIBLE/i.test(String(col.extra || ''))) parts.push('INVISIBLE');
  if (col.columnComment) parts.push(`COMMENT ${sqlString(col.columnComment)}`);
  return parts.join(' ');
}

/**
 * ALGORITHM / LOCK suffix, emitted verbatim as chosen by the operator.
 *
 * A charset conversion of an indexed column is always a table rebuild, so
 * MySQL only accepts ALGORITHM=COPY with LOCK=SHARED or stricter. We do NOT
 * silently rewrite the operator's choice - the plan is meant to be exactly
 * what runs - but `impossibleDdlRisk()` below flags combinations the server
 * will reject, so it shows up in review instead of failing mid-run.
 */
function alterSuffix(options) {
  const bits = [];
  if (options.algorithm && options.algorithm !== 'DEFAULT') bits.push(`ALGORITHM=${options.algorithm}`);
  if (options.lockMode && options.lockMode !== 'DEFAULT') bits.push(`LOCK=${options.lockMode}`);
  return bits.length ? `, ${bits.join(', ')}` : '';
}

/** Combinations MySQL rejects for a charset conversion, surfaced at plan time. */
function impossibleDdlRisk(options) {
  const risks = [];
  if (options.algorithm === 'INPLACE') {
    risks.push({
      level: 'critical', code: 'algorithm_impossible',
      message: 'ALGORITHM=INPLACE ใช้กับการแปลง charset ของคอลัมน์ไม่ได้ — MySQL จะปฏิเสธคำสั่งนี้ทันที (ต้องใช้ COPY หรือ DEFAULT)',
    });
  }
  if (options.lockMode === 'NONE') {
    risks.push({
      level: 'critical', code: 'lock_impossible',
      message: 'LOCK=NONE ใช้ไม่ได้เพราะการแปลง charset ต้อง rebuild ตาราง (ALGORITHM=COPY) — MySQL จะปฏิเสธ ถ้าต้องการ zero-downtime ให้ใช้ pt-online-schema-change / gh-ost',
    });
  }
  return risks;
}

/**
 * What happens to the two ends of a text foreign key.
 *
 * MySQL refuses an ALTER that would leave them incompatible:
 *
 *   Referencing column 'x' and referenced column 'x' in foreign key constraint
 *   'fk_y' are incompatible.
 *
 * and charset is part of "compatible". Converting one side alone therefore
 * fails outright - and so does converting the other side first, since either
 * order passes through the same mismatched intermediate state.
 *
 * `SET foreign_key_checks = 0` does NOT get past it. That variable turns off
 * row-level checking and lets DDL ignore dependency order, but the manual
 * carves this case out explicitly: an ALTER TABLE that would leave an
 * incompatible FOREIGN KEY column definition is refused whatever it is set to.
 * This module recommended it once; the operator tried it and got the same
 * error back, which is the only evidence that matters.
 *
 * What does work is taking the constraint out of the way: DROP FOREIGN KEY,
 * convert both columns, ADD CONSTRAINT again. So rather than describing that,
 * foreignKeyRepair() writes it out - the real constraint name, both column
 * definitions carried over field for field, and the original ON DELETE / ON
 * UPDATE rules restored.
 */
function foreignKeyRisks(table, target, changing, options = {}) {
  const risks = [];
  const changingNames = new Set(changing.map((c) => c.columnName));
  const blocked = [];
  const unknown = [];

  for (const f of table.foreignKeys || []) {
    const outbound = f.direction === 'outbound';
    const mine = outbound ? f.columnName : f.refColumn;
    if (!changingNames.has(mine)) continue;
    const theirCharset = outbound ? f.parentCharset : f.childCharset;
    const theirCollation = outbound ? f.parentCollation : f.childCollation;
    const theirType = outbound ? f.parentType : f.childType;
    const otherName = outbound
      ? `${f.refSchema}.${f.refTable}.${f.refColumn}`
      : `${f.schemaName}.${f.tableName}.${f.columnName}`;
    // No type at all means the counterpart could not be read - a column in a
    // schema this login cannot see, or metadata from before both ends were
    // fetched. Unknown is not the same as fine, and must not read as fine.
    if (!theirType) { unknown.push({ name: f.name, other: otherName }); continue; }
    // A non-text counterpart cannot disagree about a charset.
    if (!theirCharset) continue;
    if (theirCharset === target.charset && theirCollation === target.collation) continue;
    blocked.push({ name: f.name, column: mine, other: otherName, otherCharset: `${theirCharset} / ${theirCollation}` });
  }

  if (unknown.length) {
    risks.push({
      level: 'warn', code: 'fk_partner_unknown',
      message: `อ่าน charset ของอีกฝั่ง foreign key ไม่ได้ (${unknown.map((u) => `${u.name} → ${u.other}`).join(', ')}) `
        + 'อาจเป็นเพราะ user นี้มองไม่เห็น schema นั้น — ตรวจเองก่อนว่าอีกฝั่งเป็น charset อะไร '
        + 'ถ้าไม่ตรงกับ target MySQL จะปฏิเสธคำสั่งด้วย "are incompatible"',
      constraints: unknown.map((u) => u.name),
    });
  }

  if (blocked.length) {
    const lines = blocked.map((b) => `${b.name}: ${b.column} ↔ ${b.other} (${b.otherCharset})`).join(' · ');
    risks.push({
      level: 'critical',
      code: 'fk_charset_mismatch',
      message: `MySQL จะปฏิเสธคำสั่งนี้ด้วย "are incompatible" เพราะอีกฝั่งของ foreign key ยังเป็น charset เดิม (${lines}) `
        + 'การสลับลำดับไม่ช่วย เพราะไม่ว่าจะแปลงฝั่งไหนก่อนก็ผ่านสถานะที่สองฝั่งไม่ตรงกันเหมือนกัน '
        + 'และ SET foreign_key_checks = 0 ก็ไม่ช่วย — MySQL ยกเว้นกรณีนี้ไว้ตรงๆ ว่า ALTER TABLE '
        + 'ที่ทำให้นิยามคอลัมน์ของ foreign key ไม่เข้ากันจะถูกปฏิเสธไม่ว่าตั้งค่านี้ไว้เท่าไร '
        + 'ทางเดียวคือถอด constraint ออกก่อน แปลงทั้งสองฝั่ง แล้วใส่กลับ — คำสั่งเต็มอยู่ข้างล่าง',
      columns: blocked.map((b) => b.column),
      constraints: [...new Set(blocked.map((b) => b.name))],
      partners: [...new Set(blocked.map((b) => b.other))],
      repair: foreignKeyRepair(table, target, blocked, options),
    });
  }

  // Text FKs whose other end already matches: nothing will be rejected, but the
  // constraint is still worth naming - it is why the column cannot be left out.
  const settled = (table.foreignKeys || []).filter((f) => {
    const mine = f.direction === 'outbound' ? f.columnName : f.refColumn;
    const theirs = f.direction === 'outbound' ? f.parentCharset : f.childCharset;
    return changingNames.has(mine) && theirs
      && !blocked.some((b) => b.name === f.name) && !unknown.some((u) => u.name === f.name);
  });
  if (settled.length) {
    risks.push({
      level: 'info', code: 'fk_text_columns',
      message: `คอลัมน์ที่จะแปลงมี foreign key อยู่ (${[...new Set(settled.map((f) => f.name))].join(', ')}) `
        + `อีกฝั่งเป็น ${target.charset} / ${target.collation} อยู่แล้ว การแปลงรอบนี้จะทำให้สองฝั่งตรงกันพอดี`,
    });
  }
  return risks;
}

/**
 * The script that actually gets a text foreign key across.
 *
 * Written out rather than described, because every part of it has to match
 * what is already in the database: the constraint's real name, its columns in
 * ORDINAL_POSITION order, both column definitions carried over field for field
 * (a MODIFY that forgets NOT NULL or a DEFAULT is a data bug, not a typo), and
 * the original ON DELETE / ON UPDATE rules. RESTRICT is left implicit because
 * that is what MySQL reports for a constraint that never named a rule.
 *
 * The two MODIFY statements are deliberately separate: between them the two
 * ends disagree, and MySQL only tolerates that while no constraint is looking.
 */
function foreignKeyRepair(table, target, blocked, options = {}) {
  const tgtCharset = charsetName(target.charset);
  const tgtCollation = charsetName(target.collation);
  const byName = new Map();
  for (const f of table.foreignKeys || []) {
    if (!blocked.some((b) => b.name === f.name)) continue;
    const key = `${f.schemaName}.${f.tableName}.${f.name}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }

  const scripts = [];
  for (const [key, rows] of byName) {
    const parts = [...rows].sort((a, b) => (Number(a.ordinal) || 0) - (Number(b.ordinal) || 0));
    const head = parts[0];
    const childFqn = qq(head.schemaName, head.tableName);
    const parentFqn = qq(head.refSchema, head.refTable);
    // Emitted verbatim from REFERENTIAL_CONSTRAINTS rather than filtered down to
    // "the interesting ones". RESTRICT and NO ACTION behave identically and are
    // both valid syntax, and which of the two MySQL reports for a constraint
    // that named neither varies by version - so echoing what the server says
    // rebuilds the behaviour it has, instead of the behaviour we assumed.
    const rule = (kind, r) => (r ? ` ON ${kind} ${r}` : '');

    const lines = [
      `-- ${key}`,
      '-- 1) ถอด constraint ออกก่อน สองฝั่งจึงจะเป็นคนละ charset ชั่วคราวได้',
      `ALTER TABLE ${childFqn} DROP FOREIGN KEY ${q(head.name)};`,
      '',
      `-- 2) แปลงทั้งสองฝั่งให้เป็น ${tgtCharset} / ${tgtCollation}`,
    ];
    for (const f of parts) {
      const child = fkColumn(f, 'child');
      const parent = fkColumn(f, 'parent');
      if (child.columnCharset) {
        lines.push(`ALTER TABLE ${childFqn} MODIFY COLUMN ${columnDefinition(child, tgtCharset, tgtCollation, options)};`);
      }
      if (parent.columnCharset) {
        lines.push(`ALTER TABLE ${parentFqn} MODIFY COLUMN ${columnDefinition(parent, tgtCharset, tgtCollation, options)};`);
      }
    }
    lines.push(
      '',
      '-- 3) ใส่ constraint กลับ พร้อมกฎเดิม',
      `ALTER TABLE ${childFqn} ADD CONSTRAINT ${q(head.name)}`,
      `  FOREIGN KEY (${parts.map((f) => q(f.columnName)).join(', ')})`,
      `  REFERENCES ${parentFqn} (${parts.map((f) => q(f.refColumn)).join(', ')})`
        + `${rule('DELETE', head.deleteRule)}${rule('UPDATE', head.updateRule)};`
    );
    scripts.push({ constraint: head.name, sql: lines.join('\n') });
  }
  return scripts;
}

/** One side of a foreign key, shaped like a normal column row. */
function fkColumn(f, side) {
  const pick = (k) => f[`${side}${k}`];
  return {
    columnName: side === 'child' ? f.columnName : f.refColumn,
    columnType: pick('Type'),
    dataType: pick('DataType'),
    columnCharset: pick('Charset'),
    columnCollation: pick('Collation'),
    isNullable: pick('Nullable'),
    columnDefault: pick('Default'),
    extra: pick('Extra') || '',
    columnComment: pick('Comment') || '',
    generationExpression: pick('Generation') || '',
  };
}

/** Static (metadata-only) risk flags for one table. */
function tableRisks(table, target, pick = null, options = {}) {
  const risks = [];
  const changing = table.columns.filter((c) => needsColumnChange(c, target, pick));
  const srcWidths = [...new Set(changing.map((c) => bpc(c.columnCharset)))];
  const targetWidth = bpc(target.charset);
  const widening = srcWidths.some((w) => w < targetWidth);
  const narrowing = srcWidths.some((w) => w > targetWidth);

  if (narrowing) {
    risks.push({
      level: 'critical', code: 'lossy_narrowing',
      message: `แปลงจาก charset ที่กว้างกว่า (${changing.filter((c) => bpc(c.columnCharset) > targetWidth).map((c) => c.columnCharset).filter((v, i, a) => a.indexOf(v) === i).join(', ')}) มาเป็น ${target.charset} — อักขระที่เกินขอบเขตจะกลายเป็น '?' อย่างถาวร ต้องรัน Preflight scan ก่อน`,
    });
  }
  if (table.partitions > 0) {
    risks.push({ level: 'warn', code: 'partitioned', message: `ตารางมี ${table.partitions} partition — ALTER จะ rebuild ทุก partition ใช้เวลานาน` });
  }
  if (table.indexes.some((i) => String(i.indexType).toUpperCase() === 'FULLTEXT')) {
    risks.push({ level: 'warn', code: 'fulltext', message: 'มี FULLTEXT index — จะถูกสร้างใหม่ทั้งหมด และผลการค้นหาอาจเปลี่ยนตาม collation ใหม่' });
  }
  risks.push(...foreignKeyRisks(table, target, changing, options));
  const genText = changing.filter(isGenerated);
  if (genText.length) {
    risks.push({ level: 'warn', code: 'generated_columns', message: `มี generated column ที่เป็นข้อความ (${genText.map((c) => c.columnName).join(', ')}) — MySQL อาจปฏิเสธการแปลง ต้อง drop/recreate` });
  }
  if (changing.some((c) => c.columnKey === 'UNI') || table.indexes.some((i) => i.unique && i.parts.some((p) => {
    const col = table.columns.find((c) => c.columnName === p.columnName);
    return col && needsColumnChange(col, target, pick);
  }))) {
    risks.push({ level: 'warn', code: 'unique_collation', message: 'มี UNIQUE index บนคอลัมน์ที่จะเปลี่ยน collation — ค่าที่เคยต่างกันอาจกลายเป็นค่าซ้ำ ทำให้ ALTER ล้มเหลว (ตรวจได้ในหน้า Preflight)' });
  }

  if (widening) {
    const limit = indexByteLimit(table);
    for (const index of table.indexes) {
      let bytes = 0;
      let touches = false;
      for (const part of index.parts) {
        const col = table.columns.find((c) => c.columnName === part.columnName);
        if (!col) continue;
        const isText = INDEXED_TEXT_TYPES.test(col.dataType);
        const chars = part.subPart || col.charMaxLen || 0;
        if (isText) {
          const width = needsColumnChange(col, target, pick) ? targetWidth : bpc(col.columnCharset);
          if (needsColumnChange(col, target, pick)) touches = true;
          bytes += Number(chars) * width;
        } else {
          bytes += 8;
        }
      }
      if (touches && bytes > limit) {
        risks.push({
          level: 'critical', code: 'index_too_long',
          message: `index ${index.indexName} จะยาว ~${bytes} ไบต์ เกินขอบเขต ${limit} ไบต์ (${table.engine}/${table.rowFormat}) — ต้องลดความยาวคอลัมน์หรือใช้ prefix index ก่อน`,
        });
      }
    }
    let rowBytes = 0;
    for (const col of table.columns) {
      if (!INDEXED_TEXT_TYPES.test(col.dataType) || /text$/i.test(col.dataType)) continue;
      const width = needsColumnChange(col, target, pick) ? targetWidth : bpc(col.columnCharset);
      rowBytes += Number(col.charMaxLen || 0) * width;
    }
    if (rowBytes > 65535) {
      risks.push({ level: 'critical', code: 'row_too_large', message: `ผลรวมความยาวคอลัมน์ข้อความ ~${rowBytes} ไบต์ เกินขอบเขตแถว 65,535 ไบต์ — MySQL จะปฏิเสธ หรือเปลี่ยนชนิดคอลัมน์เป็น TEXT เอง` });
    }
  }

  const sizeBytes = table.dataLength + table.indexLength;
  if (sizeBytes > 5 * 1024 ** 3) {
    risks.push({ level: 'warn', code: 'large_table', message: `ตารางขนาด ~${(sizeBytes / 1024 ** 3).toFixed(1)} GB — ALTER แบบ COPY จะล็อกการเขียนนาน แนะนำใช้ pt-online-schema-change / gh-ost (มีคำสั่งให้คัดลอกในแผน)` });
  }
  if (String(table.engine).toUpperCase() !== 'INNODB') {
    risks.push({ level: 'info', code: 'non_innodb', message: `engine = ${table.engine} — ALTER จะล็อกทั้งตาราง และ CHECKSUM/rollback มีข้อจำกัดต่างจาก InnoDB` });
  }
  return risks;
}

/**
 * The one critical risk a passing preflight has already answered.
 *
 * `lossy_narrowing` fires on every utf8mb4 -> utf8mb3 table, because that is
 * what this tool does: it says characters outside the target would become '?'
 * and that a scan should be run before trusting it. A preflight whose gate is
 * anything but 'block' IS that answer. Treating it as unresolved would refuse
 * every table on the instance, which is not caution - it is the feature
 * refusing to do its job.
 *
 * Nothing else is waived. index_too_long, row_too_large, fk_charset_mismatch,
 * algorithm_impossible and lock_impossible all mean MySQL will reject the
 * statement outright, and no amount of scanning rows speaks to any of them.
 */
const ANSWERED_BY_PREFLIGHT = new Set(['lossy_narrowing']);

/**
 * The critical risks in a plan that nothing has answered.
 *
 * This is the list that stops a run, so it lives here rather than in each
 * caller: the unattended runner used to keep its own copy of the rule while
 * the API kept none, which is how a plan carrying a fk_charset_mismatch - the
 * repair script already written out beside it - was handed to MySQL anyway and
 * came back rejected.
 *
 * Computed from the steps every time rather than read off a stored field, so a
 * plan written before this existed is judged by today's rule.
 */
function blockingRisks(plan) {
  const out = [];
  for (const s of (plan && plan.steps) || []) {
    for (const r of s.risks || []) {
      if (r.level !== 'critical' || ANSWERED_BY_PREFLIGHT.has(r.code)) continue;
      out.push({
        code: r.code,
        message: r.message,
        step: s.id,
        table: s.tableName ? `${s.schemaName}.${s.tableName}` : null,
      });
    }
  }
  return out;
}

function ptOscCommand(table, target, session) {
  const alter = `CONVERT TO CHARACTER SET ${target.charset} COLLATE ${target.collation}`;
  return [
    'pt-online-schema-change',
    `--alter "${alter}"`,
    `D=${table.schemaName},t=${table.tableName}`,
    `--host=${session.host} --port=${session.port} --user=${session.user} --ask-pass`,
    '--max-load Threads_running=40 --critical-load Threads_running=80',
    '--chunk-time=0.5 --set-vars lock_wait_timeout=5',
    '--no-drop-old-table --alter-foreign-keys-method=auto',
    '--execute',
  ].join(' ');
}

function ghostCommand(table, target, session) {
  return [
    'gh-ost',
    `--database="${table.schemaName}" --table="${table.tableName}"`,
    `--alter="CONVERT TO CHARACTER SET ${target.charset} COLLATE ${target.collation}"`,
    `--host="${session.host}" --port=${session.port} --user="${session.user}" --ask-pass`,
    '--max-load=Threads_running=40 --critical-load=Threads_running=80',
    '--chunk-size=1000 --initially-drop-ghost-table --allow-on-master --execute',
  ].join(' ');
}

/**
 * Build the migration plan.
 *
 * options: {
 *   strategy: 'convert_table' | 'modify_columns',
 *   columns: string[] - with modify_columns, the exact columns to touch
 *                       (omit for "every column that needs it"),
 *   includeSchemaDefaults, includeTableDefaults,
 *   algorithm: 'DEFAULT'|'COPY'|'INPLACE', lockMode: 'DEFAULT'|'SHARED'|'NONE',
 *   disableFkChecks, order: 'size_asc'|'size_desc'|'name',
 *   backupStrategy: 'none'|'table_copy'|'mysqldump',
 *   isMariaDB
 * }
 */
function buildPlan({ tables, schemaRows = [], target, options = {}, session = {} }) {
  const opts = {
    strategy: 'modify_columns',
    includeSchemaDefaults: true,
    includeTableDefaults: true,
    algorithm: 'DEFAULT',
    lockMode: 'DEFAULT',
    disableFkChecks: false,
    order: 'size_asc',
    backupStrategy: 'none',
    isMariaDB: false,
    ...options,
  };
  const tgtCharset = charsetName(target.charset);
  const tgtCollation = charsetName(target.collation);
  const suffix = alterSuffix(opts);
  const steps = [];
  // An explicit selection only means anything per column; CONVERT TO rewrites
  // the whole table whatever we list. An empty array is a real answer ("none"),
  // so the filter keys off Array.isArray, not on length.
  const pick = opts.strategy === 'modify_columns' && Array.isArray(opts.columns)
    ? new Set(opts.columns) : null;

  if (opts.includeSchemaDefaults) {
    for (const s of schemaRows) {
      if (s.schemaCollation === tgtCollation && s.schemaCharset === tgtCharset) continue;
      steps.push({
        id: stepId('schema', s.schemaName, ''),
        kind: 'schema_default',
        schemaName: s.schemaName,
        tableName: null,
        title: `Schema default: ${s.schemaName}`,
        metadataOnly: true,
        sql: `ALTER DATABASE ${q(s.schemaName)} CHARACTER SET ${tgtCharset} COLLATE ${tgtCollation};`,
        rollbackSql: [`ALTER DATABASE ${q(s.schemaName)} CHARACTER SET ${charsetName(s.schemaCharset)} COLLATE ${charsetName(s.schemaCollation)};`],
        before: { charset: s.schemaCharset, collation: s.schemaCollation },
        after: { charset: tgtCharset, collation: tgtCollation },
        risks: [],
        estimate: { rows: 0, bytes: 0, rebuild: false },
      });
    }
  }

  const sorted = [...tables].sort((a, b) => {
    if (opts.order === 'name') return `${a.schemaName}.${a.tableName}`.localeCompare(`${b.schemaName}.${b.tableName}`);
    const sa = a.dataLength + a.indexLength;
    const sb = b.dataLength + b.indexLength;
    return opts.order === 'size_desc' ? sb - sa : sa - sb;
  });

  for (const table of sorted) {
    const changing = table.columns.filter((c) => needsColumnChange(c, target, pick));
    const skipped = pick ? table.columns.filter((c) => needsColumnChange(c, target)).length - changing.length : 0;
    const tableDefaultWrong = table.tableCollation !== tgtCollation;
    if (!changing.length && !tableDefaultWrong) continue;

    const fqn = qq(table.schemaName, table.tableName);
    const risks = [...tableRisks(table, target, pick, opts), ...impossibleDdlRisk(opts)];
    if (skipped > 0) {
      risks.push({
        level: 'warn',
        code: 'partial_columns',
        message: `เลือกแปลงบางคอลัมน์ อีก ${skipped} คอลัมน์ที่ยังไม่ตรง target จะถูกข้ามไว้ ตารางนี้จะมี charset ปนกันจนกว่าจะแปลงครบ`,
      });
    }
    const sizeBytes = table.dataLength + table.indexLength;
    // Columns whose charset differs from their table default must be restored
    // individually on rollback, otherwise CONVERT TO would flatten them.
    const oddballs = table.columns.filter((c) => c.columnCharset && c.columnCollation !== table.tableCollation);

    if (!changing.length && tableDefaultWrong && opts.includeTableDefaults) {
      // Data is already fine; only the table's default for future columns is stale.
      steps.push({
        id: stepId('tabledefault', table.schemaName, table.tableName),
        kind: 'table_default',
        schemaName: table.schemaName,
        tableName: table.tableName,
        title: `Table default only: ${table.schemaName}.${table.tableName}`,
        metadataOnly: true,
        sql: `ALTER TABLE ${fqn} DEFAULT CHARACTER SET ${tgtCharset} COLLATE ${tgtCollation};`,
        rollbackSql: [`ALTER TABLE ${fqn} DEFAULT CHARACTER SET ${charsetName(table.tableCharset || 'utf8mb4')} COLLATE ${charsetName(table.tableCollation)};`],
        before: { charset: table.tableCharset, collation: table.tableCollation },
        after: { charset: tgtCharset, collation: tgtCollation },
        columns: [],
        risks: [{ level: 'info', code: 'metadata_only', message: 'ไม่มีคอลัมน์ข้อความที่ต้องแปลง — คำสั่งนี้แก้เฉพาะ metadata ทำงานทันที ไม่ rebuild ข้อมูล' }],
        estimate: { rows: table.approxRows, bytes: sizeBytes, rebuild: false },
        tooling: {},
      });
      continue;
    }

    const columnMeta = changing.map((c) => ({
      columnName: c.columnName, columnType: c.columnType, dataType: c.dataType,
      from: { charset: c.columnCharset, collation: c.columnCollation },
      to: { charset: tgtCharset, collation: tgtCollation },
      generated: isGenerated(c), columnKey: c.columnKey,
    }));

    let sql;
    const rollbackSql = [];

    if (opts.strategy === 'modify_columns') {
      const clauses = changing.map((c) => `  MODIFY COLUMN ${columnDefinition(c, tgtCharset, tgtCollation, opts)}`);
      if (tableDefaultWrong && opts.includeTableDefaults) clauses.unshift(`  DEFAULT CHARACTER SET ${tgtCharset} COLLATE ${tgtCollation}`);
      sql = `ALTER TABLE ${fqn}\n${clauses.join(',\n')}${suffix};`;
      const back = changing.map((c) => `  MODIFY COLUMN ${columnDefinition(c, c.columnCharset, c.columnCollation, opts)}`);
      if (tableDefaultWrong && opts.includeTableDefaults) {
        back.unshift(`  DEFAULT CHARACTER SET ${charsetName(table.tableCharset || 'utf8mb4')} COLLATE ${charsetName(table.tableCollation)}`);
      }
      rollbackSql.push(`ALTER TABLE ${fqn}\n${back.join(',\n')}${suffix};`);
    } else {
      sql = `ALTER TABLE ${fqn} CONVERT TO CHARACTER SET ${tgtCharset} COLLATE ${tgtCollation}${suffix};`;
      rollbackSql.push(`ALTER TABLE ${fqn} CONVERT TO CHARACTER SET ${charsetName(table.tableCharset || 'utf8mb4')} COLLATE ${charsetName(table.tableCollation)}${suffix};`);
      if (oddballs.length) {
        const back = oddballs.map((c) => `  MODIFY COLUMN ${columnDefinition(c, c.columnCharset, c.columnCollation, opts)}`);
        rollbackSql.push(`ALTER TABLE ${fqn}\n${back.join(',\n')}${suffix};`);
        risks.push({
          level: 'info', code: 'mixed_charsets',
          message: `ตารางนี้มีคอลัมน์ที่ตั้ง charset ต่างจาก default ของตาราง (${oddballs.map((c) => c.columnName).join(', ')}) — CONVERT TO จะรวบให้เหมือนกันทั้งหมด แผน rollback ได้ใส่คำสั่งคืนค่าเดิมไว้แล้ว`,
        });
      }
    }

    steps.push({
      id: stepId('alter', table.schemaName, table.tableName),
      kind: opts.strategy === 'modify_columns' ? 'column_modify' : 'table_convert',
      schemaName: table.schemaName,
      tableName: table.tableName,
      title: `${table.schemaName}.${table.tableName} (${changing.length} คอลัมน์)`,
      metadataOnly: false,
      sql,
      rollbackSql,
      before: { charset: table.tableCharset, collation: table.tableCollation },
      after: { charset: tgtCharset, collation: tgtCollation },
      columns: columnMeta,
      risks,
      estimate: { rows: table.approxRows, bytes: sizeBytes, rebuild: true },
      engine: table.engine,
      rowFormat: table.rowFormat,
      tooling: {
        ptOsc: ptOscCommand(table, { charset: tgtCharset, collation: tgtCollation }, session),
        ghOst: ghostCommand(table, { charset: tgtCharset, collation: tgtCollation }, session),
      },
    });
  }

  const counts = steps.reduce((acc, s) => {
    acc[s.kind] = (acc[s.kind] || 0) + 1;
    if (!s.metadataOnly) { acc.rebuildBytes += s.estimate.bytes; acc.rebuildRows += s.estimate.rows; }
    for (const r of s.risks) acc.risk[r.level] = (acc.risk[r.level] || 0) + 1;
    return acc;
  }, { rebuildBytes: 0, rebuildRows: 0, risk: {} });

  return {
    target: { charset: tgtCharset, collation: tgtCollation },
    options: opts,
    steps,
    summary: {
      steps: steps.length,
      tables: steps.filter((s) => s.tableName).length,
      schemas: steps.filter((s) => s.kind === 'schema_default').length,
      metadataOnly: steps.filter((s) => s.metadataOnly).length,
      rebuilds: steps.filter((s) => !s.metadataOnly).length,
      ...counts,
    },
  };
}

/** Session-level guards emitted before the first ALTER of a run. */
function sessionGuards(options, runner) {
  // Clear any statement timeout a previous scan left on this pooled
  // connection first. MariaDB applies max_statement_time to DDL, so an
  // inherited 60s would abort a long rebuild mid-flight.
  const stmts = ['SET SESSION max_execution_time = 0', 'SET SESSION max_statement_time = 0',
    `SET SESSION lock_wait_timeout = ${Number(runner.lockWaitTimeoutSec) || 30}`,
    `SET SESSION innodb_lock_wait_timeout = ${Number(runner.lockWaitTimeoutSec) || 30}`];
  if (options.disableFkChecks) stmts.push('SET SESSION foreign_key_checks = 0');
  if (options.skipBinlog) stmts.push('SET SESSION sql_log_bin = 0');
  if (Number(runner.statementTimeoutSec) > 0) {
    stmts.push(`SET SESSION max_execution_time = ${Number(runner.statementTimeoutSec) * 1000}`);
  }
  return stmts;
}

/** Render the plan as a reviewable .sql script. */
function renderScript(plan, direction = 'forward') {
  const head = [
    `-- mysql-charset-migrator :: ${direction === 'forward' ? 'FORWARD' : 'ROLLBACK'} script`,
    `-- target: ${plan.target.charset} / ${plan.target.collation}`,
    `-- strategy: ${plan.options.strategy}   order: ${plan.options.order}`,
    `-- steps: ${plan.steps.length}`,
    '-- ตรวจสอบให้ครบถ้วนก่อนรัน และรัน Preflight + Checksum ก่อนทุกครั้ง',
    '',
  ];
  if (plan.options.disableFkChecks) head.push('SET SESSION foreign_key_checks = 0;', '');
  const body = [];
  const steps = direction === 'forward' ? plan.steps : [...plan.steps].reverse();
  for (const s of steps) {
    body.push(`-- [${s.kind}] ${s.title}`);
    for (const r of s.risks) body.push(`--   ${r.level.toUpperCase()}: ${r.message}`);
    if (direction === 'forward') body.push(s.sql);
    else body.push(...s.rollbackSql);
    body.push('');
  }
  if (plan.options.disableFkChecks) body.push('SET SESSION foreign_key_checks = 1;');
  return [...head, ...body].join('\n');
}

module.exports = {
  buildPlan, renderScript, columnDefinition, defaultClause, tableRisks,
  needsColumnChange, sessionGuards, alterSuffix, impossibleDdlRisk, bpc, indexByteLimit,
  repertoireFits, ANSWERED_BY_PREFLIGHT, blockingRisks,
};
