import { api, state, setSession } from '../api.js';
import { $, esc, toast, note, collapse, applyDynamicStyles } from '../util.js';
import { navigate, refreshChrome } from '../app.js';
import { cache } from '../store.js';

export function render(host) {
  const s = state.session;
  const meta = state.meta || {};

  host.innerHTML = `
    <div class="grid grid-2">
      <div>
        <div class="card">
          <h2>ข้อมูลการเชื่อมต่อ</h2>
          <form id="connect-form" class="grid" autocomplete="off">
            <div class="row">
              <label class="field">
                <span>Host</span>
                <input name="host" required placeholder="127.0.0.1" value="${esc(s ? s.host : '127.0.0.1')}" autocomplete="off">
              </label>
              <label class="field">
                <span>Port</span>
                <input name="port" inputmode="numeric" value="${esc(s ? s.port : 3306)}" autocomplete="off">
              </label>
            </div>
            <div class="row">
              <label class="field">
                <span>Username</span>
                <input name="user" required placeholder="root" value="${esc(s ? s.user : '')}" autocomplete="off">
              </label>
              <label class="field">
                <span>Password</span>
                <input name="password" type="password" placeholder="••••••••" autocomplete="new-password">
              </label>
            </div>
            <div class="row">
              <label class="field">
                <span>Default database (ไม่จำเป็น)</span>
                <input name="database" placeholder="ปล่อยว่างเพื่อดูทุก schema" value="${esc(s && s.database ? s.database : '')}" autocomplete="off">
              </label>
              <label class="field">
                <span>TLS / SSL</span>
                <select name="ssl">
                  <option value="">ไม่ใช้</option>
                  <option value="on">ใช้ (ไม่ตรวจใบรับรอง)</option>
                  <option value="verify">ใช้ + ตรวจใบรับรอง</option>
                </select>
              </label>
            </div>
            <div class="row">
              <button type="submit" class="btn-primary" id="btn-connect">${s ? 'เชื่อมต่อใหม่' : 'เชื่อมต่อ'}</button>
              ${s ? '<button type="button" class="btn-ghost" id="btn-go">ไปหน้าภาพรวม →</button>' : ''}
              <div class="spacer"></div>
              <span class="hint" id="connect-status"></span>
            </div>
          </form>
        </div>

        ${s ? serverCard(s) : ''}
      </div>

      <div>
        ${note('warn', 'utf8mb3 เก็บได้ไม่ครบทุกตัวอักษร', `
          emoji และ CJK บางตัวเป็น 4 ไบต์ utf8mb3 เก็บไม่ได้ พอแปลงแล้วจะกลายเป็น <code>?</code> ถาวร
          ขั้นตรวจข้อมูลจะกันไว้ให้ก่อนถ้าเจอ`)}

        ${collapse('รหัสผ่านถูกเก็บยังไง', `<ul>
          <li>เปิดที่ <code>127.0.0.1</code> อย่างเดียว เครื่องอื่นเรียกไม่ได้</li>
          <li>ทุก request ต้องมี boot key ที่สุ่มใหม่ทุกครั้งที่สตาร์ท</li>
          <li>รหัสผ่านอยู่ใน RAM แบบเข้ารหัส ไม่ลงดิสก์ ไม่เก็บใน browser</li>
          <li>ไม่ใช้งาน ${Math.round((meta.idleTimeoutMs || 1800000) / 60000)} นาที session จะถูกล้างทิ้ง</li>
        </ul>`)}

        ${collapse('สิทธิ์ที่ user ต้องมี', `<div class="kv">
          <dt>อ่านโครงสร้าง</dt><dd>SELECT บน information_schema</dd>
          <dt>checksum</dt><dd>SELECT บนตารางที่จะตรวจ</dd>
          <dt>แปลง charset</dt><dd>ALTER (บวก CREATE/INSERT/DROP ถ้าให้ก๊อปตารางไว้)</dd>
          <dt>ดูโหลดเซิร์ฟเวอร์</dt><dd>PROCESS / REPLICATION CLIENT</dd>
        </div>`)}
      </div>
    </div>`;

  applyDynamicStyles(host);

  const form = $('#connect-form', host);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = $('#btn-connect', host);
    const status = $('#connect-status', host);
    btn.disabled = true;
    status.textContent = 'กำลังเชื่อมต่อ…';
    try {
      const view = await api.connect({
        host: fd.get('host').trim(),
        port: Number(fd.get('port')) || 3306,
        user: fd.get('user').trim(),
        password: fd.get('password') || '',
        database: (fd.get('database') || '').trim(),
        ssl: fd.get('ssl') || '',
      });
      // Clear the password field immediately; it is never needed again here.
      form.password.value = '';
      setSession(view);
      cache.schemas = null;
      cache.facets = null;
      cache.summary = null;
      refreshChrome();
      toast(`เชื่อมต่อสำเร็จ MySQL ${view.server.version}`, 'ok');
      navigate('overview');
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'err', 9000);
    } finally {
      btn.disabled = false;
    }
  });

  const go = $('#btn-go', host);
  if (go) go.addEventListener('click', () => navigate('overview'));
}

function serverCard(s) {
  const srv = s.server || {};
  const flags = [];
  if (srv.readOnly) flags.push('<span class="chip chip-warn">read_only = ON</span>');
  if (srv.replica) flags.push(`<span class="chip chip-warn">replica (lag ${esc(srv.replica.lagSec)}s)</span>`);
  if (!srv.canAlter) flags.push('<span class="chip chip-bad">ไม่พบสิทธิ์ ALTER</span>');
  else flags.push('<span class="chip chip-ok">มีสิทธิ์ ALTER</span>');
  return `
    <div class="card">
      <h2>เซิร์ฟเวอร์ที่เชื่อมต่ออยู่</h2>
      <div class="kv">
        <dt>version</dt><dd>${esc(srv.version)} ${esc(srv.versionComment || '')}</dd>
        <dt>hostname</dt><dd>${esc(srv.hostname)}</dd>
        <dt>current_user</dt><dd>${esc(srv.currentUser)}</dd>
        <dt>character_set_server</dt><dd>${esc(srv.charsetServer)}</dd>
        <dt>collation_server</dt><dd>${esc(srv.collationServer)}</dd>
        <dt>innodb row format</dt><dd>${esc(srv.rowFormat)}</dd>
        <dt>เชื่อมต่อเมื่อ</dt><dd>${esc(new Date(s.createdAt).toLocaleString('th-TH'))}</dd>
      </div>
      <div class="row-tight">${flags.join(' ')}</div>
    </div>`;
}
