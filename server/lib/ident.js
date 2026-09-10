'use strict';
/** Identifier quoting/validation. Everything that reaches a DDL string goes
 *  through here; values always go through placeholders instead. */

// MySQL allows almost anything inside backticks except NUL and the backtick
// itself (which is escaped by doubling). We additionally reject control chars.
function assertIdent(name, what = 'identifier') {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw new Error(`${what} ไม่ถูกต้อง`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`${what} มีอักขระควบคุมที่ไม่อนุญาต`);
  return name;
}

function q(name) {
  assertIdent(name);
  return '`' + name.replace(/`/g, '``') + '`';
}

function qq(schema, table) {
  return `${q(schema)}.${q(table)}`;
}

// Charset / collation names are identifiers-without-quotes in DDL, so they get
// a stricter whitelist.
function charsetName(name) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(String(name || ''))) throw new Error(`ชื่อ charset/collation ไม่ถูกต้อง: ${name}`);
  return String(name);
}

function sqlString(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\u0000/g, '\\0') + "'";
}

module.exports = { q, qq, assertIdent, charsetName, sqlString };
