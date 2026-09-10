// The work list. One row per table, and the only way into the migration
// workflow - which is what keeps the console honest about doing one table at
// a time.
import { api } from '../api.js';
import { cache, work, nextStep } from '../store.js';
import { navigate } from '../app.js';
import {
  $, $$, esc, num, bytes, chip, note, toast, debounce, applyDynamicStyles, chipField, wireChipFields,
} from '../util.js';

const ui = {
  filters: { schema: [], engine: [], q: '', status: 'todo' },
  page: 1,
  pageSize: 50,
  sort: 'size',
  dir: 'asc',
};

const STATUS = [
  { key: 'todo', label: 'ยังต้องแปลง', countKey: 'todo' },
  { key: 'rebuild', label: 'ต้องเขียนข้อมูลใหม่', countKey: 'rebuild' },
  { key: 'metadata_only', label: 'แก้แค่ default', countKey: 'metadataOnly' },
  { key: 'compliant', label: 'เรียบร้อยแล้ว', countKey: 'compliant' },
  { key: '', label: 'ทั้งหมด', countKey: 'all' },
];

export async function render(host, params) {
  if (params && params.schema) {
    ui.filters.schema = [params.schema];
    ui.page = 1;
  }
  if (!cache.schemas) cache.schemas = (await api.schemas()).schemas;
  if (!cache.facets) cache.facets = await api.facets();

  host.innerHTML = `
    <div class="card">
      <h2>เลือกตารางที่จะแปลง</h2>
      <p class="hint">ทำได้ทีละตาราง เริ่มจากตารางเล็กก่อนก็ได้</p>
      <div class="row" id="tl-filters">
        ${chipField('schema', 'schema', (cache.schemas || []).map((s) => s.schemaName), ui.filters.schema)}
        ${chipField('engine', 'engine', cache.facets.engines || [], ui.filters.engine)}
        <label class="field"><span>ชื่อตาราง</span>
          <input id="tl-q" value="${esc(ui.filters.q)}" placeholder="พิมพ์ชื่อที่จะหา" autocomplete="off"></label>
        <label class="field"><span>เรียงตาม</span>
          <select id="tl-sort">
            <option value="size:asc">เล็กไปใหญ่</option>
            <option value="size:desc">ใหญ่ไปเล็ก</option>
            <option value="pending:desc">ที่ต้องแปลงเยอะสุดก่อน</option>
            <option value="name:asc">ชื่อตาราง</option>
          </select></label>
      </div>
      <div class="segbar" id="tl-status"></div>
    </div>

    <div class="card">
      <div id="tl-body"><div class="loading">กำลังโหลด…</div></div>
      <div class="row-tight" id="tl-pager"></div>
    </div>`;

  $('#tl-sort', host).value = `${ui.sort}:${ui.dir}`;

  wireChipFields($('#tl-filters', host), {
    schema: { label: 'schema', options: (cache.schemas || []).map((s) => s.schemaName), chosen: ui.filters.schema },
    engine: { label: 'engine', options: cache.facets.engines || [], chosen: ui.filters.engine },
  }, () => { ui.page = 1; load(host); });

  $('#tl-q', host).addEventListener('input', debounce(() => {
    ui.filters.q = $('#tl-q', host).value.trim();
    ui.page = 1;
    load(host);
  }, 350));
  $('#tl-sort', host).addEventListener('change', () => {
    const [sort, dir] = $('#tl-sort', host).value.split(':');
    ui.sort = sort; ui.dir = dir; ui.page = 1;
    load(host);
  });

  await load(host);
}

function drawStatusBar(host, counts) {
  $('#tl-status', host).innerHTML = STATUS.map((s) => `
    <button class="seg ${ui.filters.status === s.key ? 'on' : ''}" data-status="${esc(s.key)}">
      ${esc(s.label)} <span class="seg-n">${num(counts[s.countKey])}</span>
    </button>`).join('');
  for (const b of $$('#tl-status button', host)) {
    b.addEventListener('click', () => {
      ui.filters.status = b.dataset.status;
      ui.page = 1;
      load(host);
    });
  }
}

/** Five dots showing how far this table has got through the workflow. */
function progressDots(key) {
  const st = work.byTable[key];
  if (!st) return '<span class="hint">—</span>';
  const done = [
    !!st.preflightId, !!st.checksumId, !!st.planId,
    st.jobStatus === 'done', st.verifyOk === true,
  ];
  const at = nextStep(st);
  return `<span class="dots" title="ทำไปแล้วกี่ขั้น">${done
    .map((d, i) => `<span class="dot ${d ? 'on' : ''} ${i + 1 === at && !d ? 'now' : ''}"></span>`).join('')}</span>`;
}

/** All five steps recorded as complete for this table. */
function finished(key) {
  const st = work.byTable[key];
  return !!(st && st.jobStatus === 'done' && st.verifyOk === true);
}

function openLabel(r) {
  if (finished(r.key)) return 'ดูผล';
  if (work.byTable[r.key] && work.byTable[r.key].preflightId) return 'ทำต่อ';
  return r.needsChange ? 'เริ่มทำ' : 'ดู';
}

function statusChip(r) {
  if (r.status === 'compliant') return chip('เรียบร้อยแล้ว', 'chip-ok');
  if (r.status === 'metadata_only') return chip('แก้แค่ default', 'chip-info');
  return chip(`ต้องแปลง ${num(r.columnsPending)} คอลัมน์`, 'chip-bad');
}

async function load(host) {
  const body = $('#tl-body', host);
  body.innerHTML = '<div class="loading">กำลังโหลด…</div>';
  let data;
  try {
    data = await api.tables({
      schema: ui.filters.schema,
      engine: ui.filters.engine,
      q: ui.filters.q,
      status: ui.filters.status,
      page: ui.page,
      pageSize: ui.pageSize,
      sort: ui.sort,
      dir: ui.dir,
    });
  } catch (err) {
    body.innerHTML = `<div class="note note-crit">${esc(err.message)}</div>`;
    return;
  }

  drawStatusBar(host, data.counts);

  if (!data.rows.length) {
    body.innerHTML = data.counts.todo === 0 && !ui.filters.q && !ui.filters.schema.length
      ? note('ok', 'ไม่เหลือแล้ว', 'ทุกตารางเรียบร้อยหมดแล้ว')
      : '<div class="empty">ไม่เจอตารางที่ตรงกับที่กรองไว้</div>';
    $('#tl-pager', host).innerHTML = '';
    return;
  }

  body.innerHTML = `
    <div class="table-wrap">
      <table class="worklist">
        <thead><tr>
          <th>ตาราง</th><th>สถานะ</th><th class="num">จำนวนแถว</th><th class="num">ขนาด</th>
          <th>ทำไปแล้ว</th><th></th>
        </tr></thead>
        <tbody>
          ${data.rows.map((r) => `
            <tr class="${r.needsRebuild ? 'row-warn' : ''}">
              <td><span class="mono t-schema">${esc(r.schemaName)}.</span><span class="mono t-name">${esc(r.tableName)}</span>
                  <div class="hint">${esc(r.engine || '?')} · ${esc(r.tableCollation || '—')}</div></td>
              <td>${statusChip(r)}</td>
              <td class="num">${num(r.approxRows)}</td>
              <td class="num nowrap">${bytes(r.sizeBytes)}</td>
              <td>${progressDots(r.key)}</td>
              <td><button class="btn-sm ${r.needsChange && !finished(r.key) ? 'btn-primary' : ''}" data-open="${esc(r.key)}">
                ${openLabel(r)} →</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const pages = Math.ceil(data.total / data.pageSize) || 1;
  $('#tl-pager', host).innerHTML = `
    <span class="hint">${num(data.total)} ตาราง ต้องเขียนใหม่รวม ${bytes(data.counts.pendingBytes)}</span>
    <div class="spacer"></div>
    <button class="btn-sm" data-page="${ui.page - 1}" ${ui.page <= 1 ? 'disabled' : ''}>‹ ก่อนหน้า</button>
    <span class="hint">หน้า ${ui.page} / ${pages}</span>
    <button class="btn-sm" data-page="${ui.page + 1}" ${ui.page >= pages ? 'disabled' : ''}>ถัดไป ›</button>`;

  applyDynamicStyles(host);
  for (const b of $$('[data-open]', body)) {
    b.addEventListener('click', () => navigate('table', { key: b.dataset.open }));
  }
  for (const b of $$('#tl-pager [data-page]', host)) {
    b.addEventListener('click', () => { ui.page = Number(b.dataset.page); load(host); });
  }
  if (data.counts.todo === 0 && ui.filters.status === 'todo') toast('ไม่เหลือตารางที่ต้องแปลงแล้ว', 'ok');
}
