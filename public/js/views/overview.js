// Where things stand overall. Deliberately thin: the detail lives one click
// away in the work list, and the long charset/collation breakdowns are folded
// away so the first screen answers one question - how much is left?
import { api, state } from '../api.js';
import { cache } from '../store.js';
import { navigate } from '../app.js';
import {
  $, $$, esc, num, pct, bytes, note, bar, chip,
  applyDynamicStyles, paletteColor, collapse,
} from '../util.js';

export async function render(host) {
  if (!cache.schemas) cache.schemas = (await api.schemas()).schemas;
  const d = await api.summary({});
  cache.summary = d;
  draw(host, d);
}

function draw(host, d) {
  const t = state.target;
  const oo = d.otherObjects || {};
  const ooCounts = Object.entries(oo).filter(([k, v]) => k !== 'error' && typeof v === 'number');
  const otherTotal = ooCounts.reduce((a, [, v]) => a + v, 0);
  const done = d.columns.pending === 0 && d.tables.pending === 0;

  // Headline and call to action are the same thought, so they are one card.
  host.innerHTML = `
    <div class="card cta">
      <div>
        <h2>${done ? 'ครบแล้ว' : `ยังเหลือ ${num(d.tables.pending)} ตาราง`}</h2>
        <p class="hint">${done
    ? `ทุกตารางเป็น <code>${esc(t.charset)} / ${esc(t.collation)}</code> หมดแล้ว`
    : `${num(d.columns.pending)} คอลัมน์ ยังไม่เป็น <code>${esc(t.charset)} / ${esc(t.collation)}</code>
       ต้องเขียนข้อมูลใหม่ราวๆ <strong>${bytes(d.tables.pendingBytes)}</strong>`}</p>
      </div>
      ${done ? '' : '<button class="btn-primary" id="ov-go">ไปเลือกตาราง →</button>'}
    </div>

    <div class="card">
      <div class="progress-rows">
        ${progressRow('ตาราง', d.tables.compliant, d.tables.pending, d.tables.compliantPct)}
        ${progressRow('คอลัมน์ข้อความ', d.columns.compliant, d.columns.pending, d.columns.compliantPct)}
      </div>
    </div>

    <div class="card">
      <h2>แยกตาม schema</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>schema</th><th>default ของ schema</th><th class="num">ตาราง</th>
            <th>ที่เรียบร้อยแล้ว</th><th class="num">ขนาด</th></tr></thead>
          <tbody>
            ${d.schemas.rows.map((s) => `<tr>
              <td class="mono"><button class="btn-sm btn-ghost" data-schema="${esc(s.schemaName)}">${esc(s.schemaName)}</button></td>
              <td class="mono">${chip(`${s.schemaCharset} / ${s.schemaCollation}`, s.schemaCollation === t.collation ? 'chip-ok' : 'chip-bad')}</td>
              <td class="num">${num(s.tables)}</td>
              <td>${num(s.compliantTables)} <span class="hint">(${pct(s.tablePct)})</span>${bar(s.tablePct, s.tablePct >= 99.99 ? 'ok' : s.tablePct > 0 ? 'warn' : 'crit')}</td>
              <td class="num nowrap">${bytes(s.sizeBytes)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    ${collapse('ดูสัดส่วนตาม charset กับ collation', `
      <div class="grid grid-2">
        <div>
          <h4>ตาม CHARACTER SET</h4>
          <p class="hint">จาก ${num(d.columns.text)} คอลัมน์</p>
          ${breakdown(d.byCharset, 'charset', 'columns', t.charset)}
        </div>
        <div>
          <h4>ตาม COLLATION</h4>
          <p class="hint">จาก ${num(d.columns.text)} คอลัมน์</p>
          ${breakdown(d.byCollation, 'collation', 'columns', t.collation)}
        </div>
      </div>`)}

    ${otherTotal ? note('warn', 'อย่าลืมของที่ไม่ใช่ตาราง', `
      view / routine / trigger / event ที่ charset ไม่ตรงมีอีก ${num(otherTotal)} ตัว
      การแปลงตารางไม่ได้แก้ให้ ต้อง <code>DROP</code> แล้วสร้างใหม่เอง`) : ''}`;

  applyDynamicStyles(host);
  const go = $('#ov-go', host);
  if (go) go.addEventListener('click', () => navigate('tables'));
  for (const b of $$('[data-schema]', host)) {
    b.addEventListener('click', () => navigate('tables', { schema: b.dataset.schema }));
  }
}

/** One labelled bar. Stacked, these share a baseline and a scale, so the two
 *  numbers can be read against each other at a glance. */
function progressRow(name, done, pending, percent) {
  return `
    <div class="prow">
      <div class="prow-head">
        <span class="prow-name">${esc(name)}</span>
        <span class="prow-pct">${pct(percent)}</span>
      </div>
      <div class="prow-bar"><span class="${pending === 0 ? 'complete' : ''}" data-width="${percent}"></span></div>
      <div class="prow-foot">
        <span>เรียบร้อยแล้ว <b>${num(done)}</b></span>
        <span>ยังต้องแปลง <b>${num(pending)}</b></span>
      </div>
    </div>`;
}

function breakdown(rows, keyField, countField, targetValue) {
  if (!rows.length) return '<div class="empty">ไม่มีข้อมูล</div>';
  return `<div class="legend">
    ${rows.map((r, i) => {
    const isTarget = r[keyField] === targetValue;
    const color = isTarget ? 'var(--ok)' : paletteColor(i + 1);
    return `<div class="legend-row">
        <span class="legend-dot" data-bg="${color}"></span>
        <span class="legend-name" title="${esc(r[keyField])}">${esc(r[keyField] || '(none)')}</span>
        <span class="legend-val">${num(r[countField])}</span>
        <span class="legend-pct">${pct(r.pct)}</span>
      </div>
      <div class="bar ${isTarget ? 'ok' : ''}"><span data-width="${r.pct}" data-bg="${color}"></span></div>`;
  }).join('')}
  </div>`;
}
