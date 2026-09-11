// Inline SVG charts. No library and no style="" anywhere: every colour is a
// class that app.css resolves, so a chart follows the theme and stays inside
// the page's CSP (style-src 'self' — an inline style attribute would be
// dropped silently, which is why util.js has applyDynamicStyles at all).
//
// SVG presentation attributes (x, width) are attributes rather than styles, so
// a chart is a plain markup string with no post-render wiring.
import { esc, num, bytes, pct } from './util.js';

/** Slice colours for categorical breakdowns, matched to .sl-0..9 in app.css. */
export const SLICES = 10;

const round = (n) => Math.round(n * 100) / 100;
const frame = (w, h, body, cls = '') =>
  `<svg class="chart ${cls}" viewBox="0 0 ${w} ${h}" width="100%" role="img" preserveAspectRatio="xMidYMid meet">${body}</svg>`;

/**
 * SVG text scales with the viewport, which is the one thing that makes a
 * hand-rolled chart look broken: the same 15px label renders at 22px in a
 * maximised window and at 7px on a phone. The wrapper bounds both ends - a
 * max-width so the type stops growing, a min-width plus a scroll so it stops
 * shrinking - and is only applied to the charts that actually carry text.
 */
const scroller = (svg) => `<div class="chart-scroll">${svg}</div>`;

/* ------------------------------------------------------------ split bars */

/**
 * Several measures of the same migration on one shared 0-100% scale.
 *
 * Stacking them is the whole point: "96% of tables" and "18% of bytes" are the
 * same database, and only the second number is the length of tonight's
 * maintenance window. Two separate progress bars let you read the flattering
 * one and stop; one axis makes the gap between them the first thing you see.
 *
 * rows: [{ label, done, total, unit, kind }]
 */
export function splitBars(rows, { caption = '' } = {}) {
  const W = 1000;
  const TOP = 16;
  const ROW = 64;
  const H = TOP + rows.length * ROW + 20;
  const parts = [];

  // gridlines first, so every bar sits on top of its own scale
  for (const t of [0, 25, 50, 75, 100]) {
    const x = round((t / 100) * W);
    parts.push(`<line class="ch-grid" x1="${x}" y1="${TOP - 6}" x2="${x}" y2="${TOP + rows.length * ROW - 10}"/>`);
    parts.push(`<text class="ch-axis" x="${x}" y="${H - 4}" text-anchor="${t === 0 ? 'start' : t === 100 ? 'end' : 'middle'}">${t}%</text>`);
  }

  rows.forEach((r, i) => {
    const total = Number(r.total) || 0;
    const done = Number(r.done) || 0;
    const p = total > 0 ? (done / total) * 100 : 100;
    const y = TOP + i * ROW;
    const fmt = r.unit === 'bytes' ? bytes : num;
    const kind = r.kind || (p >= 99.995 ? 'ok' : 'pending');
    parts.push(`
      <text class="ch-name" x="0" y="${y + 13}">${esc(r.label)}</text>
      <text class="ch-big ch-big-${kind}" x="${W}" y="${y + 18}" text-anchor="end">${esc(pct(p))}</text>
      <rect class="ch-track" x="0" y="${y + 28}" width="${W}" height="12" rx="6"/>
      <rect class="ch-${kind}" x="0" y="${y + 28}" width="${round(Math.max(p, 0) / 100 * W)}" height="12" rx="6"/>
      <text class="ch-foot" x="0" y="${y + 56}">เรียบร้อยแล้ว ${esc(fmt(done))}</text>
      <text class="ch-foot" x="${W}" y="${y + 56}" text-anchor="end">ยังเหลือ ${esc(fmt(Math.max(total - done, 0)))}</text>`);
  });

  return `<figure class="chart-fig">${scroller(frame(W, H, parts.join(''), 'chart-split'))}
    ${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

/* --------------------------------------------------------------- treemap */

/**
 * Squarified treemap (Bruls, Huizing & van Wijk 2000).
 *
 * Slice-and-dice is half the code but produces slivers, and a sliver is an
 * unreadable, unclickable rectangle — which defeats the only reason this chart
 * is here: to let the operator see, and then click, the three tables that are
 * ninety percent of their night.
 */
function squarify(values, x, y, w, h) {
  const out = [];
  const items = values.map((v, i) => ({ v: Math.max(Number(v) || 0, 0), i }));
  const sum = items.reduce((a, b) => a + b.v, 0);
  if (!sum || w <= 0 || h <= 0) return items.map(() => null);
  const scale = (w * h) / sum;
  for (const it of items) it.area = it.v * scale;
  const rest = items.slice().sort((a, b) => b.area - a.area);

  const worst = (row, side) => {
    const s = row.reduce((a, b) => a + b.area, 0);
    if (!s || !side) return Infinity;
    const mx = Math.max(...row.map((r) => r.area));
    const mn = Math.min(...row.map((r) => r.area));
    if (!mn) return Infinity;
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };

  let cx = x; let cy = y; let cw = w; let ch = h;
  let row = [];
  while (rest.length || row.length) {
    const side = Math.min(cw, ch);
    const next = rest[0];
    if (next && (!row.length || worst([...row, next], side) <= worst(row, side))) {
      row.push(rest.shift());
      continue;
    }
    // lay the finished row along the short side
    const s = row.reduce((a, b) => a + b.area, 0);
    const thick = side ? s / side : 0;
    let off = 0;
    for (const it of row) {
      const len = s ? (it.area / s) * side : 0;
      out[it.i] = cw <= ch
        ? { x: cx + off, y: cy, w: len, h: thick }
        : { x: cx, y: cy + off, w: thick, h: len };
      off += len;
    }
    if (cw <= ch) { cy += thick; ch -= thick; } else { cx += thick; cw -= thick; }
    row = [];
  }
  return out;
}

/**
 * items: [{ key, tableName, value, kind }]
 *
 * Area is bytes, because bytes are what the ALTER has to rewrite. A treemap of
 * table counts would draw a 40 GB table the same size as an empty one, which
 * is exactly the mistake this chart exists to stop.
 */
export function treemap(items, { height = 340, max = 40, unit = 'bytes' } = {}) {
  const W = 1000;
  const kept = items.filter((i) => Number(i.value) > 0).slice(0, max);
  if (!kept.length) return '';
  const fmt = unit === 'bytes' ? bytes : num;
  const boxes = squarify(kept.map((i) => i.value), 0, 0, W, height);
  const total = kept.reduce((a, i) => a + Number(i.value), 0);

  const cells = kept.map((it, i) => {
    const b = boxes[i];
    if (!b || b.w < 1 || b.h < 1) return '';
    const label = String(it.tableName || it.key);
    const share = total ? (Number(it.value) / total) * 100 : 0;
    // Text only where it fits; a clipped label reads worse than no label.
    const showName = b.w > 74 && b.h > 28;
    const showSize = b.w > 74 && b.h > 46;
    return `<g class="tm-cell tm-${it.kind || 'pending'}" tabindex="0" role="button"
        data-open="${esc(it.key)}" aria-label="${esc(it.key)} ${esc(fmt(it.value))}">
      <title>${esc(it.key)} — ${esc(fmt(it.value))} (${esc(pct(share))} ของที่เหลือ)</title>
      <rect x="${round(b.x)}" y="${round(b.y)}" width="${round(b.w)}" height="${round(b.h)}" rx="4"/>
      ${showName ? `<text class="tm-name" x="${round(b.x + 10)}" y="${round(b.y + 20)}"
        textLength="${round(Math.min(label.length * 7.2, b.w - 20))}" lengthAdjust="spacingAndGlyphs">${esc(label)}</text>` : ''}
      ${showSize ? `<text class="tm-val" x="${round(b.x + 10)}" y="${round(b.y + 37)}">${esc(fmt(it.value))}</text>` : ''}
    </g>`;
  }).join('');

  return scroller(frame(W, height, cells, 'chart-treemap'));
}

/* ----------------------------------------------------------------- donut */

function arc(cx, cy, r, r2, a0, a1) {
  const p = (rr, a) => [round(cx + rr * Math.cos(a)), round(cy + rr * Math.sin(a))];
  const big = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(r, a0); const [x1, y1] = p(r, a1);
  const [x2, y2] = p(r2, a1); const [x3, y3] = p(r2, a0);
  return `M${x0} ${y0}A${r} ${r} 0 ${big} 1 ${x1} ${y1}L${x2} ${y2}A${r2} ${r2} 0 ${big} 0 ${x3} ${y3}Z`;
}

/**
 * slices: [{ label, value, target }] — the slice matching the migration target
 * is drawn green, the rest take a categorical colour. Parts of one whole with
 * one dominant slice is the single shape a donut reads well.
 */
export function donut(slices, { centerLabel = '', centerSub = '' } = {}) {
  const S = 260;
  const c = S / 2;
  const total = slices.reduce((a, s) => a + (Number(s.value) || 0), 0);
  if (!total) return '<div class="empty">ไม่มีข้อมูล</div>';
  let a = -Math.PI / 2;
  const paths = slices.map((s, i) => {
    const frac = (Number(s.value) || 0) / total;
    const a1 = a + frac * Math.PI * 2;
    const d = arc(c, c, 118, 76, a, Math.min(a1, a + Math.PI * 2 - 0.0001));
    a = a1;
    return `<path class="dn-slice ${s.target ? 'dn-target' : `sl-${i % SLICES}`}" d="${d}">
      <title>${esc(s.label)} — ${esc(num(s.value))} (${esc(pct(frac * 100))})</title></path>`;
  }).join('');
  return frame(S, S, `${paths}
    <text class="dn-center" x="${c}" y="${c + 1}" text-anchor="middle">${esc(centerLabel)}</text>
    <text class="dn-sub" x="${c}" y="${c + 21}" text-anchor="middle">${esc(centerSub)}</text>`, 'chart-donut');
}

/** Legend rows that pair with donut(): same order, same colours. */
export function donutLegend(slices) {
  const total = slices.reduce((a, s) => a + (Number(s.value) || 0), 0) || 1;
  return `<ul class="dn-legend">${slices.map((s, i) => `
    <li><span class="dn-key ${s.target ? 'dn-target' : `sl-${i % SLICES}`}"></span>
      <span class="dn-name" title="${esc(s.label)}">${esc(s.label || '(none)')}</span>
      <span class="dn-num">${esc(num(s.value))}</span>
      <span class="dn-pct">${esc(pct((Number(s.value) || 0) / total * 100))}</span></li>`).join('')}</ul>`;
}

/* ------------------------------------------------------------ mini stack */

/**
 * One row of a small-multiples bar chart: done and pending on a scale shared
 * with every other row in the table, so bar length means size rather than
 * percentage. A per-row percentage bar draws a 4 GB schema and a 4 MB one
 * exactly the same.
 */
export function miniStack(done, pending, max) {
  const W = 150;
  const scale = max > 0 ? W / max : 0;
  const d = round(Math.max(Number(done) || 0, 0) * scale);
  const p = round(Math.max(Number(pending) || 0, 0) * scale);
  return frame(W, 14, `
    <rect class="ch-rail" x="0" y="5" width="${W}" height="4" rx="2"/>
    ${d > 0.4 ? `<rect class="ch-ok" x="0" y="2" width="${d}" height="10" rx="2"/>` : ''}
    ${p > 0.4 ? `<rect class="ch-pending" x="${d}" y="2" width="${p}" height="10" rx="2"/>` : ''}`, 'chart-mini');
}

/* -------------------------------------------------------------- timeline */

const msLabel = (v) => (v < 1000 ? `${Math.round(v)}ms`
  : v < 60000 ? `${(v / 1000).toFixed(1)}s`
    : `${Math.floor(v / 60000)}m ${Math.round((v % 60000) / 1000)}s`);

/**
 * Where the maintenance window actually went, per step, on one time axis.
 *
 * The ALTER is the part everyone estimates. The backup copy and the two
 * checksum passes run inside the same window and are routinely half of it, and
 * a single percentage bar hides that completely.
 *
 * rows: [{ label, segments: [{ kind, ms, label }] }]
 */
export function timeline(rows) {
  const W = 1000;
  const LABEL = 220;
  const ROW = 30;
  const TOP = 18;
  const plot = W - LABEL - 60;
  const totalOf = (r) => r.segments.reduce((a, s) => a + (Number(s.ms) || 0), 0);
  const maxMs = Math.max(...rows.map(totalOf), 1);
  const H = TOP + rows.length * ROW + 18;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const x = round(LABEL + t * plot);
    return `<line class="ch-grid" x1="${x}" y1="${TOP - 8}" x2="${x}" y2="${TOP + rows.length * ROW - 8}"/>
      <text class="ch-axis" x="${x}" y="${H - 4}" text-anchor="${t === 0 ? 'start' : t === 1 ? 'end' : 'middle'}">${msLabel(t * maxMs)}</text>`;
  }).join('');

  const bars = rows.map((r, i) => {
    const y = TOP + i * ROW;
    let x = LABEL;
    const segs = r.segments.filter((s) => Number(s.ms) > 0).map((s) => {
      const w = round(((Number(s.ms) || 0) / maxMs) * plot);
      const rect = `<rect class="tl-${s.kind}" x="${round(x)}" y="${y}" width="${Math.max(w, 1.5)}" height="15" rx="2">
        <title>${esc(s.label)} — ${esc(msLabel(Number(s.ms)))}</title></rect>`;
      x += w;
      return rect;
    }).join('');
    return `<text class="ch-name tl-label" x="0" y="${y + 12}">${esc(r.label)}</text>${segs}
      <text class="ch-foot" x="${round(Math.min(x + 8, W - 2))}" y="${y + 12}">${esc(msLabel(totalOf(r)))}</text>`;
  }).join('');

  return scroller(frame(W, H, grid + bars, 'chart-timeline'));
}

/** Legend for timeline(): the four things that consume a maintenance window. */
export function timelineLegend(kinds) {
  return `<ul class="tl-legend">${kinds.map((k) => `
    <li><span class="tl-key tl-${k.kind}"></span>${esc(k.label)}</li>`).join('')}</ul>`;
}
