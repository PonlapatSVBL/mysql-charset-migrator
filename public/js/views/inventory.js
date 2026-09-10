import { api, state } from '../api.js';
import { cache } from '../store.js';
import {
  $, $$, esc, num, bytes, chip, toast, debounce, applyDynamicStyles, showModal,
  chipField, wireChipFields,
} from '../util.js';

const ui = {
  filters: {
    schema: [], charset: [], collation: [], engine: [], dataType: [],
    table: '', column: '', q: '', status: 'non_compliant', textOnly: true,
  },
  page: 1,
  pageSize: 100,
  sort: 'schema',
  dir: 'asc',
};

const COLUMNS = [
  { key: 'schema', label: 'schema', get: (r) => `<span class="mono">${esc(r.schemaName)}</span>` },
  { key: 'table', label: 'table', get: (r) => `<span class="mono">${esc(r.tableName)}</span>` },
  { key: 'column', label: 'column', get: (r) => `<span class="mono">${esc(r.columnName)}</span>` },
  { key: 'ordinal', label: '#', get: (r) => `<span class="num">${esc(r.ordinal)}</span>`, cls: 'num' },
  { key: 'type', label: 'type', get: (r) => `<span class="mono trunc" title="${esc(r.columnType)}">${esc(r.columnType)}</span>` },
  { key: 'charset', label: 'column charset', get: (r, t) => statusChip(r.columnCharset, r.columnCharset === t.charset) },
  { key: 'collation', label: 'column collation', get: (r, t) => statusChip(r.columnCollation, r.columnCollation === t.collation) },
  { key: 'tableCollation', label: 'table default', get: (r, t) => statusChip(r.tableCollation, r.tableCollation === t.collation) },
  { key: null, label: 'schema default', get: (r, t) => statusChip(r.schemaCollation, r.schemaCollation === t.collation) },
  { key: null, label: 'len', get: (r) => `<span class="num">${r.charMaxLen === null ? '—' : num(r.charMaxLen)}</span>`, cls: 'num' },
  { key: null, label: 'null', get: (r) => (r.isNullable === 'YES' ? 'YES' : 'NO') },
  { key: null, label: 'key', get: (r) => (r.columnKey ? chip(r.columnKey, 'chip-info') : '') },
  { key: 'engine', label: 'engine', get: (r) => `<span class="mono">${esc(r.engine)}</span>` },
  { key: 'rows', label: 'rows≈', get: (r) => `<span class="num">${num(r.approxRows)}</span>`, cls: 'num' },
  { key: 'size', label: 'size', get: (r) => `<span class="num nowrap">${bytes(Number(r.dataLength || 0) + Number(r.indexLength || 0))}</span>`, cls: 'num' },
];

function statusChip(value, ok) {
  if (!value) return chip('—', 'chip-none');
  return chip(value, ok ? 'chip-ok' : 'chip-bad');
}

export async function render(host, params) {
  if (params && params.schema) {
    ui.filters.schema.length = 0;
    ui.filters.schema.push(params.schema);
    ui.page = 1;
  }
  if (!cache.schemas) cache.schemas = (await api.schemas()).schemas;
  if (!cache.facets) cache.facets = await api.facets();
  drawShell(host);
  await load(host);
}

function drawShell(host) {
  const f = cache.facets;
  host.innerHTML = `
    <div class="card">
      <h2>ตัวกรอง</h2>
      <div class="row" id="f-chips">
        ${chipField('schema', 'schema', (cache.schemas || []).map((s) => s.schemaName), ui.filters.schema)}
        ${chipField('charset', 'column charset', f.charsets, ui.filters.charset)}
        ${chipField('collation', 'column collation', f.collations, ui.filters.collation)}
        ${chipField('dataType', 'data type', f.dataTypes, ui.filters.dataType)}
        ${chipField('engine', 'engine', f.engines, ui.filters.engine)}
      </div>
      <div class="row">
        <label class="field"><span>ค้นหาทั้งหมด</span><input id="f-q" value="${esc(ui.filters.q)}" placeholder="พิมพ์คำที่จะหา" autocomplete="off"></label>
        <label class="field"><span>ชื่อตาราง</span><input id="f-table" value="${esc(ui.filters.table)}" placeholder="มีคำว่า" autocomplete="off"></label>
        <label class="field"><span>ชื่อคอลัมน์</span><input id="f-column" value="${esc(ui.filters.column)}" placeholder="มีคำว่า" autocomplete="off"></label>
        <label class="field"><span>สถานะ</span>
          <select id="f-status">
            <option value="">ทั้งหมด</option>
            <option value="non_compliant">ยังต้องแปลง</option>
            <option value="compliant">เรียบร้อยแล้ว</option>
            <option value="no_charset">ไม่มี charset เช่น ตัวเลข blob</option>
          </select>
        </label>
        <label class="field"><span>ต่อหน้า</span>
          <select id="f-pagesize">
            ${[50, 100, 250, 500, 1000].map((n) => `<option value="${n}" ${ui.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
        <div class="field">
          <span>&nbsp;</span>
          <label class="check"><input type="checkbox" id="f-textonly" ${ui.filters.textOnly ? 'checked' : ''}> เอาเฉพาะคอลัมน์ที่มี charset</label>
        </div>
      </div>
      <div class="row-tight">
        <button class="btn-primary btn-sm" id="btn-apply">กรอง</button>
        <button class="btn-sm btn-ghost" id="btn-reset">ล้างทั้งหมด</button>
        <button class="btn-sm" id="btn-csv">⬇ โหลด CSV ตามที่กรองไว้</button>
        <div class="spacer"></div>
        <span class="hint" id="result-count"></span>
      </div>
    </div>

    <div class="card">
      <div id="table-host"><div class="loading">กำลังโหลด…</div></div>
      <div class="row-tight" id="pager"></div>
    </div>`;

  $('#f-status', host).value = ui.filters.status;

  // The chip fields mutate ui.filters.* in place, so `apply` only has to pick
  // up the free-text and single-choice controls.
  wireChipFields($('#f-chips', host), {
    schema: { label: 'schema', options: (cache.schemas || []).map((x) => x.schemaName), chosen: ui.filters.schema },
    charset: { label: 'column charset', options: f.charsets, chosen: ui.filters.charset },
    collation: { label: 'column collation', options: f.collations, chosen: ui.filters.collation },
    dataType: { label: 'data type', options: f.dataTypes, chosen: ui.filters.dataType },
    engine: { label: 'engine', options: f.engines, chosen: ui.filters.engine },
  }, () => { ui.page = 1; load(host); });

  const apply = () => {
    ui.filters.q = $('#f-q', host).value.trim();
    ui.filters.table = $('#f-table', host).value.trim();
    ui.filters.column = $('#f-column', host).value.trim();
    ui.filters.status = $('#f-status', host).value;
    ui.filters.textOnly = $('#f-textonly', host).checked;
    ui.pageSize = Number($('#f-pagesize', host).value);
    ui.page = 1;
    load(host);
  };

  $('#btn-apply', host).addEventListener('click', apply);
  $('#f-q', host).addEventListener('input', debounce(apply, 450));
  $('#btn-reset', host).addEventListener('click', () => {
    for (const k of ['schema', 'charset', 'collation', 'engine', 'dataType']) ui.filters[k].length = 0;
    Object.assign(ui.filters, { table: '', column: '', q: '', status: '', textOnly: true });
    ui.page = 1;
    drawShell(host);
    load(host);
  });
  $('#btn-csv', host).addEventListener('click', () => {
    const url = api.inventoryCsvUrl(query());
    api.download(url, `charset-inventory-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`)
      .catch((err) => toast(err.message, 'err'));
  });
}

function query() {
  return {
    ...ui.filters,
    textOnly: ui.filters.textOnly ? 1 : '',
    page: ui.page,
    pageSize: ui.pageSize,
    sort: ui.sort,
    dir: ui.dir,
  };
}

async function load(host) {
  const tableHost = $('#table-host', host);
  tableHost.innerHTML = '<div class="loading">กำลังโหลด…</div>';
  let data;
  try {
    data = await api.inventory(query());
  } catch (err) {
    tableHost.innerHTML = `<div class="note note-crit">${esc(err.message)}</div>`;
    return;
  }
  const t = data.target || state.target;
  $('#result-count', host).textContent = `เจอ ${num(data.total)} คอลัมน์ · หน้า ${data.page}`;

  if (!data.rows.length) {
    tableHost.innerHTML = '<div class="empty">ไม่เจอคอลัมน์ที่ตรงกับที่กรองไว้</div>';
    $('#pager', host).innerHTML = '';
    return;
  }

  tableHost.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>
          ${COLUMNS.map((c) => `<th class="${c.cls || ''} ${c.key ? 'sortable' : ''}" ${c.key ? `data-sort="${c.key}"` : ''}>
            ${esc(c.label)}${ui.sort === c.key ? (ui.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('')}
          <th></th>
        </tr></thead>
        <tbody>
          ${data.rows.map((r, i) => {
    const bad = r.columnCharset && (r.columnCharset !== t.charset || r.columnCollation !== t.collation);
    return `<tr class="${bad ? 'row-warn' : ''}">
              ${COLUMNS.map((c) => `<td class="${c.cls || ''}">${c.get(r, t)}</td>`).join('')}
              <td><button class="btn-sm btn-ghost" data-row="${i}">ดู</button></td>
            </tr>`;
  }).join('')}
        </tbody>
      </table>
    </div>`;

  const pages = Math.ceil(data.total / data.pageSize) || 1;
  $('#pager', host).innerHTML = `
    <button class="btn-sm" data-page="1" ${data.page === 1 ? 'disabled' : ''}>« หน้าแรก</button>
    <button class="btn-sm" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>‹ ก่อนหน้า</button>
    <span class="hint">หน้า ${data.page} / ${pages}</span>
    <button class="btn-sm" data-page="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>ถัดไป ›</button>
    <button class="btn-sm" data-page="${pages}" ${data.page >= pages ? 'disabled' : ''}>หน้าสุดท้าย »</button>`;

  applyDynamicStyles(host);

  for (const th of $$('th[data-sort]', host)) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (ui.sort === key) ui.dir = ui.dir === 'asc' ? 'desc' : 'asc';
      else { ui.sort = key; ui.dir = 'asc'; }
      load(host);
    });
  }
  for (const b of $$('#pager button[data-page]', host)) {
    b.addEventListener('click', () => { ui.page = Number(b.dataset.page); load(host); });
  }
  for (const b of $$('button[data-row]', host)) {
    b.addEventListener('click', () => showDetail(data.rows[Number(b.dataset.row)], t));
  }
}

function showDetail(r, t) {
  const rows = [
    ['schema', r.schemaName], ['table', r.tableName], ['column', r.columnName],
    ['ordinal position', r.ordinal], ['column type', r.columnType], ['data type', r.dataType],
    ['column charset', r.columnCharset || '—'], ['column collation', r.columnCollation || '—'],
    ['table charset', r.tableCharset || '—'], ['table collation', r.tableCollation || '—'],
    ['schema charset', r.schemaCharset], ['schema collation', r.schemaCollation],
    ['character max length', r.charMaxLen === null ? '—' : num(r.charMaxLen)],
    ['character octet length', r.octetLen === null ? '—' : num(r.octetLen)],
    ['nullable', r.isNullable], ['default', r.columnDefault === null ? 'NULL' : r.columnDefault],
    ['extra', r.extra || '—'], ['key', r.columnKey || '—'],
    ['generation expression', r.generationExpression || '—'],
    ['comment', r.columnComment || '—'],
    ['engine', r.engine], ['row format', r.rowFormat],
    ['rows (approx)', num(r.approxRows)],
    ['data length', bytes(r.dataLength)], ['index length', bytes(r.indexLength)],
    ['create options', r.createOptions || '—'],
  ];
  const ok = r.columnCharset === t.charset && r.columnCollation === t.collation;
  showModal(`${r.schemaName}.${r.tableName}.${r.columnName}`, `
    <div class="note note-${ok ? 'ok' : 'warn'}">${ok
    ? 'คอลัมน์นี้เรียบร้อยแล้ว'
    : `ต้องแปลงเป็น <code>${esc(t.charset)} / ${esc(t.collation)}</code>`}</div>
    <div class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</div>`);
}
