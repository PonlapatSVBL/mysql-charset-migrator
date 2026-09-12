// What it is safe to convert, and on what evidence.
//
// Lives here rather than in the workspace view because two callers have to
// reach the same verdict: the operator ticking columns by hand, and the
// automatic runner working through a queue nobody is watching. A second copy
// of these rules would be a second answer to "will this lose a character", and
// only one of them would get fixed.
import { num } from './util.js';

/**
 * A field too narrow to be prose.
 *
 * Not because an emoji would not fit - one character fits anywhere - but
 * because of what a field this size is declared FOR. Nobody sizes a column at
 * twenty characters and then stores a sentence, a comment or a customer's
 * display name in it; they store a code, a status, a document number, a
 * currency or country abbreviation. That is the same content a key column
 * holds, so it earns the same treatment in the evidence tier: a clean capped
 * scan is enough for it, and a scan that found damage still vetoes it.
 *
 * `char` counts alongside `varchar` - the same shape, declared even more
 * deliberately. The longer types never reach this test: tinytext alone is 255.
 */
export const SHORT_CODE_LEN = 20;

export function isShortCode(c) {
  return /^(char|varchar)$/i.test(String(c.dataType || ''))
    && Number(c.charMaxLen) > 0
    && Number(c.charMaxLen) <= SHORT_CODE_LEN;
}

export function isWired(c) {
  return !!(c.indexed
    || c.columnKey
    || (c.foreignKeyNames && c.foreignKeyNames.length)
    || /_id$/i.test(c.columnName));
}

export function columnSafety(c, tb, targetCharset) {
  const scan = tb ? (tb.columns || {})[c.columnName] : null;
  const tgt = targetCharset;

  if (scan && scan.lossy > 0) {
    return { tick: false, tone: 'chip-bad', label: 'ตัวอักษรจะหาย',
      why: `สแกนเจอ ${num(scan.lossy)} แถวที่มีตัวอักษรซึ่ง ${tgt} เก็บไม่ได้ แปลงแล้วกลายเป็น '?' ถาวร` };
  }
  if (scan && scan.dbl > 0) {
    return { tick: false, tone: 'chip-warn', label: 'ไบต์น่าสงสัย',
      why: `สแกนเจอ ${num(scan.dbl)} แถวที่ไบต์ข้างในเป็น UTF-8 อยู่แล้ว แปลงตรงๆ จะได้ข้อความเพี้ยน` };
  }
  if (c.generated) {
    return { tick: false, tone: 'chip-warn', label: 'generated',
      why: 'generated column MySQL มักปฏิเสธการแปลง charset ต้อง drop แล้วสร้างใหม่เอง' };
  }
  if (c.lossless) {
    return { tick: true, proven: true, tone: 'chip-ok', label: 'ปลอดภัย',
      why: `${c.columnCharset} เก็บอะไรได้ ${tgt} ก็เก็บได้หมด ไม่ว่าข้างในจะเป็นข้อมูลอะไร` };
  }
  if (scan && scan.lossy === 0 && tb.coverage === 'full') {
    return { tick: true, proven: true, tone: 'chip-ok', label: 'สแกนครบแล้ว',
      why: `${c.columnCharset} กว้างกว่า ${tgt} แต่สแกนครบทั้งตารางแล้วไม่เจอตัวอักษรที่เก็บไม่ได้สักแถว` };
  }
  if (scan && scan.lossy === 0) {
    const reason = isWired(c) ? 'เป็นคีย์หรืออยู่ใน index จึงเก็บรหัส/สถานะ ไม่ใช่ข้อความอิสระ'
      : isShortCode(c) ? `เป็น ${c.dataType}(${num(c.charMaxLen)}) สั้นเกินกว่าจะถูกใช้เก็บข้อความอิสระ`
        : null;
    return {
      tick: !!reason,
      proven: false,
      tone: reason ? 'chip-warn' : 'chip-none',
      label: reason ? `สะอาดใน ${num(tb.scannedRows)} แถว` : 'ยังพิสูจน์ไม่ได้',
      why: `${c.columnCharset} กว้างกว่า ${tgt} สแกนไปแค่ ${num(tb.scannedRows)} แถวแรกแล้วยังไม่เจออะไร `
        + 'แต่แถวที่เหลือยังไม่ได้ดู '
        + (reason
          ? `ติ๊กให้เพราะคอลัมน์นี้${reason} ถ้าอยากได้ความแน่นอน ให้สแกนทั้งตารางที่ขั้น 1`
          : 'ไม่ติ๊กให้เพราะเป็นข้อความอิสระ ซึ่งเป็นที่ที่ emoji โผล่ได้ในแถวที่ยังไม่ได้ดู'),
    };
  }
  return { tick: false, proven: false, tone: 'chip-warn', label: 'ยังไม่ได้ตรวจ',
    why: `${c.columnCharset} กว้างกว่า ${tgt} และยังไม่มีผลสแกนของคอลัมน์นี้` };
}

/**
 * The scan verdict in the shape columnSafety wants, from a preflight result.
 *
 * The workspace keeps this in the table's own state; the runner has the result
 * in hand and never stores it. Same shape either way.
 */
export function scanFromResult(tb) {
  if (!tb || !tb.scanned) return null;
  return {
    coverage: tb.coverage,
    scannedRows: tb.scannedRows,
    columns: Object.fromEntries((tb.columns || [])
      .map((c) => [c.columnName, { lossy: c.lossyRows, dbl: c.doubleEncodedRows }])),
  };
}

/** The columns the picker ticks by itself, for one table. */
export function recommendedColumns(pendingColumns, scan, targetCharset) {
  return pendingColumns.filter((c) => columnSafety(c, scan, targetCharset).tick).map((c) => c.columnName);
}
