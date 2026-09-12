// Where things stand overall.
//
// This page answers one question, and it is not "what percentage is done".
// Migration cost is bytes rewritten, and the byte distribution across tables is
// always a power law - so "96% of tables are done" routinely sits next to "18%
// of the bytes are done", and only the second number is the length of tonight's
// maintenance window. The treemap shows which tables that window is made of,
// and the bar chart underneath puts both measures on one axis so the gap
// between them cannot be read past.
import { api, state } from '../api.js';
import { cache } from '../store.js';
import { navigate } from '../app.js';
import {
  $, $$, esc, num, pct, bytes, note, chip, collapse,
} from '../util.js';
import { splitBars, treemap, donut, donutLegend, miniStack } from '../charts.js';

export async function render(host) {
  if (!cache.schemas) cache.schemas = (await api.schemas()).schemas;
  const d = await api.summary({});
  cache.summary = d;

  // The biggest outstanding tables, for the treemap. Cheap: one page of the
  // list the operator is about to click into anyway.
  let pending = [];
  try {
    const list = await api.tables({ status: 'todo', sort: 'size', dir: 'desc', page: 1, pageSize: 40 });
    pending = list.rows || [];
  } catch { pending = []; }

  draw(host, d, pending);
}

/**
 * Every size and row count on this page comes from information_schema, which on
 * MySQL 8 serves them from a cache up to `information_schema_stats_expiry`
 * seconds old - a day, by default. Sessions ask for 0 so the numbers are live,
 * but a server that refuses (no SUPER, a managed instance that pins it) would
 * otherwise leave the page looking authoritative while showing yesterday.
 *
 * Collation and charset are not statistics: those are dictionary columns and
 * are always current, so "how many tables are left" stays right either way.
 * It is the byte figures - the ones this page is built around - that drift.
 */
function staleStatsNote() {
  const expiry = (state.session && state.session.server && state.session.server.statsExpiry);
  if (!expiry) return '';   // 0 = live, null = server has no such cache
  return note('warn', 'ตัวเลขขนาดอาจไม่ใช่ของล่าสุด',
    `เซิร์ฟเวอร์นี้ยังตั้ง <code>information_schema_stats_expiry = ${num(expiry)}</code> วินาที `
    + 'ขนาดตารางและจำนวนแถวจึงอาจเก่าได้ถึงเท่านั้น ตารางที่เพิ่งแปลงเสร็จอาจยังโชว์ขนาดเดิมอยู่ '
    + '(จำนวนตาราง/คอลัมน์ที่เหลือไม่ได้รับผลกระทบ เพราะ collation ไม่ใช่ค่าสถิติ) '
    + 'สั่ง <code>ANALYZE TABLE</code> หรือให้สิทธิ์ session ตั้งค่านี้เป็น 0 เพื่อให้ตัวเลขสด');
}

function draw(host, d, pending) {
  const t = state.target;
  const oo = d.otherObjects || {};
  const otherTotal = Object.entries(oo)
    .filter(([k, v]) => k !== 'error' && typeof v === 'number')
    .reduce((a, [, v]) => a + v, 0);
  const done = d.columns.pending === 0 && d.tables.pending === 0;
  const doneBytes = Math.max(d.tables.sizeBytes - d.tables.pendingBytes, 0);

  const cells = pending.map((r) => ({
    key: r.key,
    tableName: r.tableName,
    value: r.sizeBytes,
    kind: r.needsRebuild ? 'pending' : 'meta',
  }));
  const shown = cells.filter((c) => c.value > 0);
  const shownBytes = shown.reduce((a, c) => a + c.value, 0);
  const heaviest = shown.length ? shown[0] : null;

  host.innerHTML = `
    ${staleStatsNote()}
    <div class="card">
      <div class="cta">
        <div>
          <h2>${done ? 'ครบแล้ว' : 'Treemap: งานที่เหลือ ตามขนาดตาราง'}</h2>
        </div>
        ${done ? '' : '<button class="btn-primary" id="ov-go">ไปเลือกตาราง</button>'}
      </div>

      ${shown.length ? `
      ${treemap(shown, { height: shown.length <= 6 ? 220 : 340 })}
      <p class="hint">${num(shown.length)}/${num(d.tables.pending)} ตาราง ·
        เขียนใหม่ ${bytes(d.tables.pendingBytes)}${heaviest
    ? ` · ตัวใหญ่สุด ${pct((heaviest.value / (shownBytes || 1)) * 100)}` : ''}${cells.some((c) => c.kind === 'meta')
    ? ' · ช่องจาง = แก้แค่ default' : ''}</p>` : ''}
    </div>

    <div class="card">
      <h2>ความคืบหน้า</h2>
      ${splitBars([
    { label: 'ตาราง', done: d.tables.compliant, total: d.tables.total },
    { label: 'คอลัมน์ข้อความ', done: d.columns.compliant, total: d.columns.text },
    { label: 'ขนาดข้อมูล', done: doneBytes, total: d.tables.sizeBytes, unit: 'bytes' },
  ], { caption: divergenceNote(d, doneBytes) })}
    </div>

    <div class="card">
      <h2>แยกตาม schema</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>schema</th><th>default ของ schema</th><th class="num">ตาราง</th>
            <th>ที่เรียบร้อยแล้ว</th><th class="num">ขนาด</th></tr></thead>
          <tbody>
            ${schemaRows(d, t)}
          </tbody>
        </table>
      </div>
    </div>

    ${collapse('สัดส่วนตาม charset / collation', `
      <div class="grid grid-2">
        <div>
          <h4>ตาม CHARACTER SET</h4>
          ${breakdown(d.byCharset, 'charset', t.charset, d.columns.text)}
        </div>
        <div>
          <h4>ตาม COLLATION</h4>
          ${breakdown(d.byCollation, 'collation', t.collation, d.columns.text)}
        </div>
      </div>`)}

    ${otherTotal ? note('warn', 'อย่าลืมของที่ไม่ใช่ตาราง', `
      view / routine / trigger / event ที่ charset ไม่ตรงมีอีก ${num(otherTotal)} ตัว
      การแปลงตารางไม่ได้แก้ให้ ต้อง <code>DROP</code> แล้วสร้างใหม่เอง`) : ''}`;

  const go = $('#ov-go', host);
  if (go) go.addEventListener('click', () => navigate('tables'));
  for (const b of $$('[data-schema]', host)) {
    b.addEventListener('click', () => navigate('tables', { schema: b.dataset.schema }));
  }
  // Treemap cells are <g> elements, so they need an explicit keyboard path -
  // a focusable SVG group fires no click on Enter the way a <button> would.
  for (const cell of $$('.tm-cell', host)) {
    const open = () => navigate('table', { key: cell.dataset.open });
    cell.addEventListener('click', open);
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }
}

/**
 * The caption exists to say the uncomfortable thing out loud when the two
 * measures disagree: finishing most of the tables is not the same as finishing
 * most of the work, and the second number is the one that decides the window.
 */
function divergenceNote(d, doneBytes) {
  const tablePct = d.tables.compliantPct;
  const bytePct = d.tables.sizeBytes ? (doneBytes / d.tables.sizeBytes) * 100 : 100;
  if (d.tables.pending === 0) return 'ทุกตารางถึงเป้าหมายแล้ว';
  if (tablePct - bytePct < 12) return 'จำนวนตารางกับปริมาณข้อมูลเดินไปด้วยกัน ประเมินเวลาจากตัวไหนก็ได้';
  return `ทำไปแล้ว ${pct(tablePct)} ของจำนวนตาราง แต่เพิ่ง ${pct(bytePct)} ของปริมาณข้อมูล —
    เวลาที่เหลือให้ดูจากแถวล่าง ตารางใหญ่ไม่กี่ตัวคือเวลาเกือบทั้งหมด`;
}

function schemaRows(d, t) {
  return d.schemas.rows.map((s) => `<tr>
    <td class="mono"><button class="btn-sm btn-ghost" data-schema="${esc(s.schemaName)}">${esc(s.schemaName)}</button></td>
    <td class="mono">${chip(`${s.schemaCharset} / ${s.schemaCollation}`, s.schemaCollation === t.collation ? 'chip-ok' : 'chip-bad')}</td>
    <td class="num">${num(s.tables)}</td>
    <td>${miniStack(s.compliantTables, s.tables)}
        <div class="hint">${num(s.compliantTables)} / ${num(s.tables)} (${pct(s.tablePct)})</div></td>
    <td class="num nowrap">${bytes(s.sizeBytes)}</td>
  </tr>`).join('');
}

function breakdown(rows, keyField, targetValue, totalColumns) {
  if (!rows.length) return '<div class="empty">ไม่มีข้อมูล</div>';
  const slices = rows.map((r) => ({
    label: r[keyField] || '(none)',
    value: r.columns,
    target: r[keyField] === targetValue,
  }));
  const onTarget = slices.find((s) => s.target);
  const share = onTarget && totalColumns ? (onTarget.value / totalColumns) * 100 : 0;
  return `${donut(slices, {
    centerLabel: pct(share),
    centerSub: 'ถึงเป้าหมาย',
  })}${donutLegend(slices)}
  <p class="hint">จาก ${num(totalColumns)} คอลัมน์ข้อความ</p>`;
}
