// Shared helpers. No inline styles or inline event handlers anywhere: the page
// runs under a strict CSP (script-src 'self'; style-src 'self'; connect-src 'self').

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const num = (v) => Number(v || 0).toLocaleString('en-US');
export const pct = (v) => `${Number(v || 0).toFixed(v >= 99.995 || v === 0 ? 0 : 2)}%`;

export function bytes(v) {
  const n = Number(v || 0);
  if (n === 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function duration(ms) {
  const n = Number(ms || 0);
  if (!n) return '—';
  if (n < 1000) return `${n} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)} วินาทีที่แล้ว`;
  if (d < 3600) return `${Math.floor(d / 60)} นาทีที่แล้ว`;
  if (d < 86400) return `${Math.floor(d / 3600)} ชม.ที่แล้ว`;
  return new Date(iso).toLocaleString('th-TH');
}

export const localTime = (iso) => (iso ? new Date(iso).toLocaleString('th-TH', { hour12: false }) : '—');

/** CSP blocks style="" attributes, so every dynamic size/colour is applied
 *  through the CSSOM after the markup lands. */
export function applyDynamicStyles(root = document) {
  for (const el of $$('[data-width]', root)) el.style.width = `${Math.min(Math.max(Number(el.dataset.width) || 0, 0), 100)}%`;
  for (const el of $$('[data-bg]', root)) el.style.background = el.dataset.bg;
  for (const el of $$('[data-color]', root)) el.style.color = el.dataset.color;

}

export function toast(message, kind = 'info', timeout = 5200) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), timeout);
  return el;
}

/**
 * Promise-based confirm dialog. `body` is trusted HTML built by our own views.
 * With `collect: true` it resolves `{ ok, values }`, where `values` is a
 * snapshot of every id'd input/select inside the dialog taken BEFORE the modal
 * is torn down (reading them afterwards would find a detached tree).
 */
export function confirmDialog({ title, body, confirmText = 'ยืนยัน', cancelText = 'ยกเลิก', danger = false, requireText = null, collect = false }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <h3>${esc(title)}</h3>
          <div class="modal-body">${body || ''}</div>
          ${requireText ? `<label class="field"><span>พิมพ์ <code>${esc(requireText)}</code> เพื่อยืนยัน</span>
            <input id="confirm-text" autocomplete="off" spellcheck="false"></label>` : ''}
          <div class="modal-actions">
            <button data-act="cancel" class="btn-ghost">${esc(cancelText)}</button>
            <button data-act="ok" class="${danger ? 'btn-danger' : 'btn-primary'}" ${requireText ? 'disabled' : ''}>${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
    applyDynamicStyles(root);
    const ok = $('[data-act="ok"]', root);
    const input = $('#confirm-text', root);
    if (input) {
      input.addEventListener('input', () => { ok.disabled = input.value.trim() !== requireText; });
      input.focus();
    }
    const snapshot = () => {
      const values = {};
      for (const el of $$('input[id], select[id], textarea[id]', root)) {
        values[el.id] = el.type === 'checkbox' ? el.checked : el.value;
      }
      return values;
    };
    const done = (v) => {
      const values = collect ? snapshot() : null;
      root.innerHTML = '';
      resolve(collect ? { ok: v, values } : v);
    };
    ok.addEventListener('click', () => done(true));
    $('[data-act="cancel"]', root).addEventListener('click', () => done(false));
    root.firstElementChild.addEventListener('click', (e) => { if (e.target === root.firstElementChild) done(false); });
  });
}

export function showModal(title, bodyHtml) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-actions"><button data-act="close" class="btn-ghost">ปิด</button></div>
      </div>
    </div>`;
  applyDynamicStyles(root);
  const close = () => { root.innerHTML = ''; };
  $('[data-act="close"]', root).addEventListener('click', close);
  root.firstElementChild.addEventListener('click', (e) => { if (e.target === root.firstElementChild) close(); });
}

/** Categorical series colours for charset / collation breakdowns. Tuned for the
 *  light surface: mid-dark and saturated, so a legend dot and a 4px bar both
 *  stay legible on white. Ordered for maximum separation between neighbours. */
const PALETTE = ['#6d28d9', '#0f766e', '#b45309', '#be123c', '#1d4ed8', '#15803d', '#a21caf', '#475569', '#c2410c', '#4d7c0f'];
export const paletteColor = (i) => PALETTE[i % PALETTE.length];

export function bar(percent, kind = '') {
  return `<div class="bar ${kind}"><span data-width="${Number(percent) || 0}"></span></div>`;
}

export function statCard({ k, v, sub, kind = '', percent = null, barKind = '' }) {
  return `<div class="stat ${kind}">
    <div class="k">${esc(k)}</div>
    <div class="v">${esc(v)}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
    ${percent !== null ? bar(percent, barKind) : ''}
  </div>`;
}

export function chip(text, kind = '') {
  return `<span class="chip ${kind}">${esc(text)}</span>`;
}

export function note(kind, strong, html) {
  return `<div class="note note-${kind}">${strong ? `<strong>${esc(strong)}</strong>` : ''}${html}</div>`;
}

export function levelKind(level) {
  return level === 'critical' ? 'crit' : level === 'warn' ? 'warn' : level === 'info' ? 'info' : 'ok';
}

/** Multi-select helper: read selected values. */
export const selected = (el) => (el ? [...el.selectedOptions].map((o) => o.value) : []);

/* ------------------------------------------------------------ chip filter */

/**
 * A multi-value filter you can actually un-pick.
 *
 * `<select multiple>` needs ctrl+click to deselect, which is why picking a
 * filter here used to be a one-way door. This renders an "add" dropdown plus
 * one removable chip per chosen value, so every selection has a visible × and
 * removing is the same gesture as adding.
 *
 * `chosen` is the live array from the caller's filter model; wireChipFields
 * mutates it in place and re-renders, so the caller never has to sync state.
 */
export function chipField(id, label, options, chosen) {
  const remaining = options.filter((o) => !chosen.includes(o));
  return `<div class="field chipfield" data-chipfield="${esc(id)}"
               data-chip-label="${esc(label)}">${chipFieldInner(id, label, options, chosen, remaining)}</div>`;
}

function chipFieldInner(id, label, options, chosen, remaining) {
  return `
    <span>${esc(label)}${chosen.length ? ` <span class="hint">(${chosen.length})</span>` : ''}</span>
    <select data-chip-add ${remaining.length ? '' : 'disabled'} aria-label="เพิ่มตัวกรอง ${esc(label)}">
      <option value="">${remaining.length ? '+ เลือกเพิ่ม…' : 'เลือกครบแล้ว'}</option>
      ${remaining.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
    </select>
    <div class="chips" data-chip-list>${chosen
    .map((v) => `<span class="chip chip-sel">${esc(v)}<button type="button" class="chip-x"
        data-chip-remove="${esc(v)}" title="เอา ${esc(v)} ออก" aria-label="เอา ${esc(v)} ออก">×</button></span>`).join('')
    + (chosen.length > 1 ? `<button type="button" class="chip-clear" data-chip-clear>ล้างหมด</button>` : '')
}</div>`;
}

/**
 * @param {HTMLElement} host
 * @param {object} fields  { fieldId: { options: string[], chosen: string[], label } }
 * @param {function} onChange called after every add/remove
 */
export function wireChipFields(host, fields, onChange) {
  for (const el of $$('[data-chipfield]', host)) {
    const id = el.dataset.chipfield;
    const def = fields[id];
    if (!def) continue;

    const redraw = () => {
      const remaining = def.options.filter((o) => !def.chosen.includes(o));
      el.innerHTML = chipFieldInner(id, def.label || id, def.options, def.chosen, remaining);
      bind();
    };
    const bind = () => {
      const add = $('[data-chip-add]', el);
      if (add) {
        add.addEventListener('change', () => {
          const v = add.value;
          if (!v) return;
          if (!def.chosen.includes(v)) def.chosen.push(v);
          redraw();
          onChange(id);
        });
      }
      for (const b of $$('[data-chip-remove]', el)) {
        b.addEventListener('click', () => {
          const i = def.chosen.indexOf(b.dataset.chipRemove);
          if (i >= 0) def.chosen.splice(i, 1);
          redraw();
          onChange(id);
        });
      }
      const clear = $('[data-chip-clear]', el);
      if (clear) {
        clear.addEventListener('click', () => {
          def.chosen.length = 0;
          redraw();
          onChange(id);
        });
      }
    };
    bind();
  }
}

/** Collapsible block. Long explanations belong behind one of these, not on
 *  screen by default - the console is for doing the work, not reading about
 *  it. */
export function collapse(summary, html, open = false) {
  return `<details class="explain"${open ? ' open' : ''}>
    <summary>${esc(summary)}</summary>
    <div class="explain-body">${html}</div>
  </details>`;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast('คัดลอกแล้ว', 'ok', 1800), () => toast('คัดลอกไม่สำเร็จ', 'err'));
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('คัดลอกแล้ว', 'ok', 1800); } catch { toast('คัดลอกไม่สำเร็จ', 'err'); }
  ta.remove();
}
