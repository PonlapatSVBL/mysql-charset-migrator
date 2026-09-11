# MySQL Charset Migrator

เครื่องมือ console แบบ local-only (Node.js + Express + mysql2) สำหรับ **สำรวจ (inventory) ตรวจสอบ (preflight/checksum) วางแผน รัน และ rollback** การเปลี่ยน `CHARACTER SET` / `COLLATION` ของ MySQL / MariaDB ทั้ง instance ไปเป็นเป้าหมาย `utf8mb3` / `utf8mb3_general_ci` โดยผู้ปฏิบัติงานเห็น DDL ทุกบรรทัดก่อนรัน มีการ throttle ตามโหลดเซิร์ฟเวอร์ มี checksum ที่ทนต่อการเปลี่ยน encoding เพื่อพิสูจน์ว่าข้อมูลไม่เปลี่ยน และมี audit trail แบบ append-only ที่ redact รหัสผ่านออกทุกบรรทัด

---

## ⚠️ คำเตือนสำคัญ — อ่านก่อนใช้งาน

> ### 1. `utf8mb4` → `utf8mb3` เป็นการแปลงแบบ **แคบลง (narrowing)** และ **กู้คืนไม่ได้**
>
> `utf8mb3` เก็บได้สูงสุด **3 ไบต์ต่ออักขระ** (BMP เท่านั้น) ส่วน `utf8mb4` เก็บได้ **4 ไบต์**
> อักขระ 4 ไบต์ทุกตัว — emoji, CJK Extension B–F, สัญลักษณ์ดนตรี, อักษรโบราณ —
> จะถูก MySQL **แทนด้วย `?` อย่างเงียบๆ และถาวร** เมื่อรัน `CONVERT TO CHARACTER SET utf8mb3`
>
> **`ALTER TABLE ... CONVERT TO CHARACTER SET utf8mb4` ย้อนกลับ ไม่คืนอักขระเดิม** —
> มันคืนได้แค่ "ความกว้าง" ของคอลัมน์ แต่ค่าที่กลายเป็น `?` แล้วก็ยังเป็น `?` ตลอดไป
> **มีเพียง backup เท่านั้น ที่กู้ข้อมูลกลับได้**
>
> ### 2. `utf8mb3` ถูกประกาศ **deprecated ตั้งแต่ MySQL 8.0.29**
>
> ทั้งชื่อ `utf8mb3` และ alias `utf8` (ที่หมายถึง utf8mb3 ใน MySQL 5.x/8.0) ถูกประกาศเลิกใช้
> และมีแผนถูกถอดออกจาก MySQL ในอนาคต การย้ายไป `utf8mb3` จึงควรทำเพื่อ
> **compatibility ระยะสั้น** กับ client / application เก่าเท่านั้น ไม่ใช่เป้าหมายระยะยาว
>
> ### สิ่งที่แอปนี้ทำเพื่อลดความเสี่ยง
>
> | กลไก | รายละเอียด |
> |---|---|
> | **Preflight gate (บังคับ)** | `POST /api/jobs` จะตอบ **HTTP 412** พร้อม code `preflight_required` ถ้าไม่ได้แนบ `preflightId` และตอบ `preflight_blocked` ถ้าผล preflight เป็น `gate: "block"` — ต้องส่ง `acknowledgeNoPreflight: true` / `forceDespiteBlock: true` อย่างจงใจเท่านั้นจึงจะข้ามได้ |
> | **สแกนหาแถวที่จะเสียหายจริง** | Preflight รัน round-trip `CONVERT` ต่อคอลัมน์ เพื่อ **นับแถวและดึงตัวอย่างค่า** ที่จะกลายเป็น `?` — ก่อนที่จะแตะข้อมูลจริงแม้แถวเดียว |
> | **Backup ต่อ step** | เลือกได้ `table_copy` (shadow table ใน DB) หรือ `mysqldump` (ไฟล์) โดย backup ถูกสร้าง **ก่อน** `ALTER` ทุกครั้ง |
> | **Checksum ก่อน/หลัง ทุก step** | ถ้า digest ไม่ตรง จะถือว่า step ล้มเหลว และเข้า auto-rollback ทันที |
> | **UI เตือนตลอด** | หน้า Preflight และ Plan แสดง risk code `lossy_narrowing` เป็นระดับ `critical` ทุกครั้งที่ตรวจพบ charset ที่กว้างกว่าเป้าหมาย |

---

## ติดตั้งและรัน

ต้องมี **Node.js >= 20** (ระบุใน `package.json` → `engines`)

```bash
npm install
npm start          # = node server/index.js
# หรือโหมดพัฒนา (auto-reload)
npm run dev        # = node --watch server/index.js
```

ตอนสตาร์ท เซิร์ฟเวอร์จะพิมพ์ banner ออก stdout พร้อม **URL ที่มี boot key ต่อท้าย** — ต้องใช้ URL นี้เปิด UI:

```text
────────────────────────────────────────────────────────────────────────
  MySQL Charset Migrator
  เป้าหมาย: utf8mb3 / utf8mb3_general_ci

  เปิด URL นี้ในเบราว์เซอร์ (ต้องมี key ต่อท้าย):
  http://127.0.0.1:7343/?key=Xk3p9QzR7mLtVw2bNc4hYs

  bind: 127.0.0.1:7343 (loopback เท่านั้น)
  logs: <repo>/data
  รหัสฐานข้อมูลถูกเก็บในหน่วยความจำแบบเข้ารหัสเท่านั้น ไม่เขียนลงดิสก์ ไม่ส่งออกนอกเครื่อง
────────────────────────────────────────────────────────────────────────
```

**boot key เป็นสิ่งจำเป็น**

- `GET /` ถูกกันด้วย `shellGuard` — ถ้าไม่มี `?key=` ที่ถูกต้อง จะได้ HTTP 401 พร้อมหน้า "🔒 ต้องใช้ boot key"
- หน้าเว็บอ่าน key จาก query string เก็บลง `sessionStorage` แล้วส่งไปกับทุก request ในหัวข้อ `X-App-Key`
- key ถูกสร้างใหม่ทุกครั้งที่ start (`crypto.randomBytes(18).toString('base64url')`) — **restart แล้ว key เดิมใช้ไม่ได้** ต้องเปิด URL ใหม่
- ตั้งค่าคงที่ได้ด้วย env `CSMIG_BOOT_KEY` (ใช้เฉพาะกรณีจำเป็น เช่น สคริปต์ทดสอบ)

ปิดด้วย `Ctrl+C` — handler `SIGINT` / `SIGTERM` จะเขียน audit `server.stop`, ปิด HTTP listener, แล้วเรียก `session.destroyAll()` เพื่อปิด pool และล้าง vault ก่อน `process.exit(0)`

---

## Security — 5 ชั้น ตามที่ implement จริง

### ชั้น 1 — bind loopback เท่านั้น

`server/index.js` เรียก `app.listen(config.port, config.host)` โดย `config.host` default `127.0.0.1`
ถ้า override ด้วย `CSMIG_HOST` ให้เป็นค่าอื่นที่ไม่ใช่ `127.0.0.1` / `localhost` / `::1` จะมี **คำเตือนพิมพ์ออก stderr** ว่าเครื่องอื่นในเครือข่ายอาจเข้าถึงได้ (แอปไม่ปฏิเสธการ bind แต่เตือน)
นอกจากนี้ `app.set('trust proxy', false)` และ `app.disable('x-powered-by')`

### ชั้น 2 — boot key บนทุก API call

`security.apiGuard` ถูก mount ที่ `app.use('/api', ...)` **ก่อน** router ทั้งหมด ทุก request ไป `/api/*` ต้องมีหัวข้อ `X-App-Key` ที่ตรงกับ `BOOT_KEY` โดยเทียบด้วย `crypto.timingSafeEqual` (เทียบความยาวก่อน แล้วจึง timing-safe) ถ้าไม่ตรง → HTTP 401
จุดประสงค์: แม้ listener จะอยู่บน localhost โปรแกรมอื่นบนเครื่องเดียวกันที่ไม่รู้ key ก็ **ขับ API นี้ไม่ได้**

> **ข้อจำกัดที่ต้องพูดตรงๆ:** `/assets/*` (ไฟล์ CSS/JS ของ UI) ถูก serve โดย **ไม่** ต้องมี boot key — ผ่านแค่ `hostGuard` ไฟล์เหล่านี้เป็น static asset ที่ไม่มีความลับใดๆ อยู่ภายใน แต่หมายความว่าโปรเซสอื่นบนเครื่องสามารถอ่าน source ของ UI ได้ (ไม่ใช่ข้อมูล ไม่ใช่ credential)

### ชั้น 3 — Host / Origin pinning

`security.hostGuard` รันก่อนทุก route:

- ตัด `:port` ออกจาก `Host` header แล้วต้องเท่ากับ `localhost` / `127.0.0.1` / `::1` / `config.host` ไม่งั้น → **HTTP 421**
- ถ้ามี `Origin` header ต้อง parse ได้และ host ผ่านเกณฑ์เดียวกัน ไม่งั้น → **HTTP 403**

กันการโจมตีแบบ **DNS rebinding** (เว็บภายนอกทำให้ชื่อโดเมนชี้กลับมา `127.0.0.1`) และ CSRF ข้าม origin
รวมกับข้อกำหนด custom header `X-App-Key` ทำให้ request แบบ simple/no-preflight จากหน้าเว็บอื่นทำไม่ได้เลย

**Rate limit** — fixed-window limiter เขียนเอง (`security.rateLimiter`, เคลียร์ Map ทุกครอบ window):

| ขอบเขต | window | max |
|---|---|---|
| `/api` ทั้งหมด | 60 วินาที | 600 requests |
| `/api/connect` | 60 วินาที | 10 requests |

### ชั้น 4 — CSP เข้มงวด (แอปไม่สามารถ "phone home" ได้)

Header ที่ตั้งใน `security.baseHeaders` ทุก response:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none';
  base-uri 'none'; frame-ancestors 'none'; object-src 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Permissions-Policy: geolocation=(), camera=(), microphone=(), usb=(), payment=()
Cache-Control: no-store, no-cache, must-revalidate, private
Pragma: no-cache
```

`default-src 'none'` + `connect-src 'self'` หมายถึง **ไม่มี CDN ไม่มี font ภายนอก ไม่มี beacon ไม่มี fetch/XHR/WebSocket ไปที่อื่นได้เลย** แม้ dependency ตัวใดจะพยายามส่งข้อมูลออก เบราว์เซอร์จะบล็อกให้
ฝั่ง client ยังเรียก `fetch` ด้วย `credentials: 'omit'`, `cache: 'no-store'`, `mode: 'same-origin'`, `referrerPolicy: 'no-referrer'`
`Cache-Control: no-store` ทุก response ทำให้ไม่มีอะไรลง disk cache ของเบราว์เซอร์

### ชั้น 5 — Credential vault (AES-256-GCM ในหน่วยความจำ) + redaction + idle timeout

`server/session.js`:

- `VAULT_KEY = crypto.randomBytes(32)` สร้างใหม่ **ทุกครั้งที่โปรเซสสตาร์ท** ไม่เคยเขียนลงที่ไหน
- รหัสผ่านถูก `seal()` ด้วย `aes-256-gcm` (IV 12 ไบต์สุ่มต่อครั้ง + auth tag) เก็บเป็น `{iv, ct, tag}` ใน object ของ session
- **ไม่มี API endpoint ใดคืนรหัสผ่าน** — `publicView()` ส่งออกแค่ `sessionId`, host, port, user, database, ssl, createdAt, idleTimeoutMs, `serverInfo`, target
- `revealPassword(session, reason)` เป็นทางเดียวที่ถอดรหัสได้ ใช้อยู่ที่เดียวคือ `jobs.dumpTable()` (mysqldump) และ **ทุกครั้งเขียน audit `session.credential.reveal` พร้อม `reason`**
- mysqldump ได้รหัสผ่านผ่าน **env `MYSQL_PWD`** ไม่ผ่าน command line — จึงไม่ปรากฏใน `ps` / Task Manager
- `destroy()` ปิด pool, ถอนรหัสผ่านออกจาก secret registry ของ logger, แล้ว `wipe()` เขียน 0 ทับ buffer `iv`/`ct`/`tag` และตั้ง `sealed = null`
- **Idle timeout** — sweeper `setInterval(..., 60_000).unref()` ทำลาย session ที่ `lastSeenAt` เก่ากว่า `CSMIG_IDLE_TIMEOUT_MS` (default 30 นาที) ด้วย reason `idle-timeout`
- `maxSessions: 4` (hardcoded) — เกินกว่านี้ `POST /api/connect` ตอบ HTTP 429

`server/lib/logger.js` — audit log แบบ append-only NDJSON, **ทุก record ผ่าน `redact()` ก่อนแตะดิสก์**:

1. **Secret registry** — `registerSecret(password)` จำค่าไว้ ทุก string ที่ log จะถูกแทน substring นั้นด้วย `«redacted:sha256:xxxxxxxxxxxx»` (fingerprint = 12 ตัวอักษรแรกของ sha256 hex) ทำให้ correlate log ได้โดยไม่เปิดเผยค่า — เงื่อนไข: ค่านั้นยาว >= 3 อักขระ
2. **ตัดตาม key name** — key ที่ตรง regex `^(pass|password|passwd|pwd|secret|token|auth|authorization|apikey|api_key|key|sealed.*)$` (case-insensitive) ถูกแทนด้วย `«redacted»` **โดยไม่ดูค่า**
3. **Belt-and-braces regex** — ล้าง DSN แบบ `mysql://user:pass@host` และ literal ท้าย `IDENTIFIED [WITH x] BY '...'`
4. `Buffer` → `«buffer:N»` (ไม่เคย dump เนื้อ), `Error` → เก็บแค่ `name/message/code/errno/sqlState`, จำกัดความลึก object ที่ 8 ชั้น
5. ไฟล์ทั้งหมดเขียนด้วย `mode: 0o600`

โครงสร้างไฟล์ใต้ `data/` (อยู่ใน `.gitignore`):

```text
data/
├── audit/audit-YYYY-MM-DD.ndjson    audit trail รวมทุกเหตุการณ์ 1 ไฟล์ต่อวัน
├── jobs/<jobId>.json                 manifest ของ job (แผน + สถานะ + checksum + backup + rollback)
├── jobs/<jobId>.ndjson               event stream ของ job นั้น (เขียนคู่ขนานไปที่ audit ด้วย)
├── jobs/<jobId>-backup/<db>.<tbl>.sql  ไฟล์ผลลัพธ์ mysqldump (เฉพาะ backupStrategy = mysqldump)
├── snapshots/<taskId>.json           ผล preflight scan และ checksum snapshot
└── plans/<planId>.json               แผนที่สร้างไว้ + tableMeta ที่ใช้สร้างแผน
```

### สิ่งที่แอปนี้ **ไม่** ป้องกัน — ขอบเขตที่อยู่นอก threat model

พูดให้ตรงตามความจริงทางเทคนิค ไม่ overclaim:

- **mysql2 driver จำเป็นต้องเก็บรหัสผ่านไว้ใน process memory ตลอดอายุของ connection pool**
  `mysql.createPool({ password })` เก็บ `password` เป็น plaintext string ใน pool config เพราะต้องใช้ทำ authentication handshake ใหม่ทุกครั้งที่เปิด connection เพิ่มหรือ reconnect นี่คือข้อจำกัดของ protocol ไม่ใช่ของโค้ดนี้
- **สิ่งที่ vault ทำได้จริงคือ: ไม่ทำสำเนาเพิ่ม และไม่ persist**
  ค่ารหัสผ่านฉบับที่แอปนี้เก็บเอง (สำหรับ mysqldump) ถูก seal ด้วย AES-256-GCM ไม่วางเป็น plaintext ใน object ของ session, ไม่เคยถูกเขียนลงดิสก์, ไม่เคยอยู่ใน API response, ไม่เคยอยู่ในไฟล์ log, ไม่เคยอยู่ใน command line ของ subprocess และถูก zero-fill เมื่อ session ถูกทำลาย
- **ผู้โจมตีที่มีสิทธิ์อ่านหน่วยความจำของโปรเซสนี้ หรือ attach debugger / เรียก `process._debugProcess` / dump core ได้ — อยู่นอกขอบเขต** เขาจะเห็นทั้ง `VAULT_KEY` และ plaintext ใน pool config การเข้ารหัสในหน่วยความจำไม่ได้ป้องกันกรณีนี้ และไม่มีเครื่องมือ userspace ใดป้องกันได้
- **ผู้ที่รู้ boot key อยู่นอกขอบเขต** — ใครที่อ่าน terminal ของคุณ หรืออ่าน `sessionStorage` ของเบราว์เซอร์คุณได้ ก็ขับ API นี้ได้เท่ากับคุณ
- ไม่มี TLS ระหว่างเบราว์เซอร์กับแอป (loopback plaintext HTTP) — TLS ไปยัง **MySQL** ตั้งได้ที่ฟอร์ม connect (`ssl` = on / `verify`)
- ไม่มี authentication แบบหลายผู้ใช้ ไม่มี role, ไม่มี CSRF token แยก (พึ่ง Host/Origin + custom header)

---

## รูปแบบการทำงาน — ทีละ 1 ตาราง

**เครื่องมือนี้แปลงครั้งละ 1 ตารางเท่านั้น** ไม่ใช่ค่าที่ปรับได้ใน UI แต่บังคับที่ฝั่ง API:
`POST /api/preflight`, `/api/checksum`, `/api/plan` และ `/api/jobs` จะตอบ **HTTP 400 `one_table_at_a_time`**
ถ้าขอบเขตที่ส่งมา resolve ได้มากกว่า 1 ตาราง (ปิดได้ด้วย `CSMIG_ALLOW_BULK=1` — ไม่แนะนำ)

เหตุผล: การสแกน/แปลงทั้ง schema ในคำสั่งเดียวทำให้ผู้ใช้ไม่รู้ว่ากำลังเกิดอะไรขึ้น หยุดไม่ได้
และตารางเดียวที่มีปัญหาลากทั้งรอบล้มไปด้วย

**เส้นทางการใช้งานปกติ**

```text
#tables  ─ เลือกตาราง 1 ตัวจาก work list
   └→ #table/<schema>.<table>   ทุกอย่างเกิดในหน้านี้ 5 ขั้น ปลดล็อกตามลำดับ
        1. ตรวจข้อมูลก่อนแปลง (preflight)  → ผ่าน / เตือน / ห้ามรัน
        2. เก็บลายนิ้วมือข้อมูล (baseline checksum)
        3. สร้างคำสั่ง SQL (plan)          → ดู forward + rollback
        4. รันคำสั่ง ALTER (dry run → จริง)
        5. ยืนยันว่าข้อมูลไม่เปลี่ยน (verify)
```

ขั้นที่ยังทำไม่ได้จะถูกล็อกพร้อมบอกเหตุผล ขั้นที่เสร็จแล้วยุบเหลือบรรทัดสรุป
ความคืบหน้าต่อตารางเก็บใน `sessionStorage` (`public/js/store.js`) และแสดงเป็นจุด 5 จุดใน work list
ตัวเลือกที่ไม่ใช่การตัดสินใจหลักถูกพับไว้ใต้ "ตัวเลือกขั้นสูง" — ทางเดินปกติคือ **ปุ่มเดียวต่อขั้น**

---

## Feature tour — 6 เมนูใน UI

UI เป็น single-page ES module ไม่มี framework ไม่มี build step (`public/js/app.js` เป็น router แบบ hash-based)
route `#table/<schema>.<table>` ไม่มีในเมนู — เข้าจาก work list เท่านั้น เพราะต้องมีตารางเป็นบริบท

### 1. เชื่อมต่อ (`#connect`)

ฟอร์ม host / port / user / password / database / SSL → `POST /api/connect`
เมื่อเชื่อมต่อสำเร็จ `probe()` จะเก็บข้อมูลเซิร์ฟเวอร์แสดงในการ์ดข้าง sidebar:

| ค่า | ที่มา |
|---|---|
| `version`, `versionComment` | `VERSION()`, `@@version_comment` (ใช้แยก MariaDB ออกจาก MySQL) |
| `hostname` | `@@hostname` |
| `currentUser` | `CURRENT_USER()` |
| `charsetServer`, `collationServer` | `@@character_set_server`, `@@collation_server` |
| `readOnly` | `@@read_only` → ถ้า true `POST /api/jobs` แบบไม่ dry-run จะถูกปฏิเสธด้วย HTTP 409 |
| `rowFormat` | `@@innodb_default_row_format` (ใช้คำนวณเพดานความยาว index) |
| `replica` | `SHOW REPLICA STATUS` แล้ว fallback `SHOW SLAVE STATUS` → เก็บ `{role:'replica', lagSec}` |
| `canAlter` | boolean จาก `SHOW GRANTS` ว่ามี `ALL PRIVILEGES` หรือ `ALTER` |
| `grantCount` | **จำนวน** grant เท่านั้น — เนื้อ grant ไม่เคยออกจาก process เพราะอาจมี `IDENTIFIED BY` |

sessionId เป็น opaque handle 24 bytes base64url ส่งกลับไปกับทุก request ในหัวข้อ `X-Session-Id`

### 2. ภาพรวม / สัดส่วน (`#overview`)

เรียก `GET /api/summary` ซึ่งรวมยอดฝั่งเซิร์ฟเวอร์ทั้งหมด (ไม่ดึงแถวดิบมานับใน Node) แสดง:

- % คอลัมน์ข้อความและ % ตารางที่ตรงเป้าหมายแล้ว + ขนาดข้อมูลที่ต้อง rebuild (`pendingBytes`)
- donut/bar สัดส่วนตาม `byCharset`, `byCollation`, `byTableCollation`
- ตารางแยกตาม schema พร้อม `tablePct` / `columnPct` ต่อ schema
- `otherObjects` — จำนวน **views / routines / triggers / events** ที่ `CHARACTER_SET_CLIENT` หรือ `COLLATION_CONNECTION` (และ `DATABASE_COLLATION` ของ routine) ยังไม่ตรงเป้าหมาย ← **รายงานเท่านั้น ไม่แปลง** · query ชุดนี้ห่อ try/catch ไว้ ถ้า user ไม่มีสิทธิ์ `SHOW VIEW` / `EVENT` จะคืน `null` ทุกช่องพร้อม `error` และ dashboard แสดง `—` แทนที่จะทำให้หน้าพัง
- ปุ่ม CTA ไปยัง work list · รายละเอียดสัดส่วนตาม charset/collation ถูกพับไว้ใต้ `<details>` เพื่อให้หน้าแรกตอบคำถามเดียว: *เหลืออีกเท่าไหร่*
- คลิกชื่อ schema = กรอง work list ด้วย schema นั้น

### 3. ตาราง — work list (`#tables`) ← หน้าหลัก

`GET /api/tables` คืน **1 แถวต่อ 1 ตาราง** (ไม่ใช่ต่อคอลัมน์) พร้อมสถานะเทียบเป้าหมายที่คำนวณใน Node
เพื่อให้กฎ compliance อยู่ที่เดียวกับที่ planner ใช้จริง

| สถานะ | เงื่อนไข | ความหมาย |
|---|---|---|
| `rebuild` | มีคอลัมน์ข้อความที่ charset/collation ยังไม่ตรง | ต้องเขียนข้อมูลใหม่ทั้งตาราง |
| `metadata_only` | คอลัมน์ตรงหมดแล้ว แต่ `TABLE_COLLATION` ยังไม่ตรง | แก้ default อย่างเดียว ไม่ rebuild |
| `compliant` | ตรงทั้งคอลัมน์และ default | ไม่ต้องทำอะไร |

- ตัวกรอง schema / engine เป็น **chip แบบกด × ลบได้** (ดู `chipField` / `wireChipFields` ใน `util.js`) —
  ไม่ใช่ `<select multiple>` ที่ต้อง ctrl+click ถึงจะเอาออกได้
- แถบสถานะด้านบนเป็นปุ่มกรองพร้อมจำนวน (`ยังต้องแปลง` / `ต้อง rebuild` / `แก้ default อย่างเดียว` / `ตรงเป้าหมายแล้ว` / `ทั้งหมด`)
- เรียงตามขนาดจากเล็กไปใหญ่เป็นค่าเริ่มต้น — ตั้งใจให้ซ้อมกระบวนการกับตารางเล็กก่อน
- จุด 5 จุดต่อแถว = ความคืบหน้าของ 5 ขั้นสำหรับตารางนั้น

### 4. หน้าทำงานต่อตาราง (`#table/<schema>.<table>`)

`GET /api/tables/:schema/:table` คืนทุกอย่างที่หน้านี้ต้องใช้ในรอบเดียว: metadata ของตาราง, คอลัมน์ที่ต้องเปลี่ยน,
และ **แผนต้นทุนของ 2 ขั้นที่ช้า** (`facts.scanPlan`, `facts.checksumPlan`) เพื่อบอกล่วงหน้าว่าจะสแกนกี่แถว
และจะใช้วิธี checksum แบบไหน — แทนที่จะให้ผู้ใช้รู้ตอนนั่งรอ

รายละเอียดของแต่ละขั้นอยู่ในหัวข้อ 4.1–4.5 ด้านล่าง

### 5. รายการ inventory (`#inventory`) — หน้าอ้างอิง

ตารางระดับ **column** จาก `information_schema.COLUMNS × TABLES × SCHEMATA × COLLATIONS`

- ฟิลเตอร์: `schema[]`, `charset[]`, `collation[]`, `engine[]`, `dataType[]`, `table` (LIKE), `column` (LIKE), `q` (ค้นรวม 4 ฟิลด์), `textOnly`, และ `status` = `compliant` / `non_compliant` / `no_charset` (default ของ UI = `non_compliant` + `textOnly`)
- เรียงได้ตาม schema / table / column / ordinal / type / charset / collation / tableCollation / rows / size / engine (whitelist `SORTABLE`)
- แบ่งหน้า `pageSize` 1–1000 (default 100)
- **CSV export** — `GET /api/inventory.csv` ใช้ฟิลเตอร์ชุดเดียวกันโดยไม่แบ่งหน้า (cap 200,000 แถว) เขียน 23 คอลัมน์ นำหน้าด้วย UTF-8 BOM (`\uFEFF`) เพื่อให้ Excel อ่านภาษาไทยถูก ดาวน์โหลดฝั่ง client ทำผ่าน blob เพราะต้องแนบ boot key ใน header
- **Excel export ของ work list** — `GET /api/export/tables.xlsx` (ปุ่มอยู่หน้า "ตารางที่ต้องแปลง") ส่งทุกแถวที่ตรงฟิลเตอร์ปัจจุบัน ไม่ใช่เฉพาะหน้าที่เปิดอยู่ ตั้งต้นที่ `status=todo` คือตารางที่ยังไม่เป็น target charset/collation — ไฟล์เขียนเองใน `server/lib/xlsx.js` (zip + XML บน `zlib` ที่มากับ Node ไม่เพิ่ม dependency) ตรึงหัวตาราง + autofilter เลือก `.xlsx` แทน CSV เพราะ Excel บน Windows locale ไทยเดา encoding ของ CSV ผิดบ่อยจนรายงานเรื่อง charset กลายเป็น mojibake เสียเอง cap 100k แถว เกินแล้วตอบ 413 ให้กรองให้แคบลง

#### 4.1 Preflight — ตรวจข้อมูลก่อนแปลง

รัน 3 การตรวจ **ระดับข้อมูล** (read-only, `REPEATABLE READ`, ทีละตารางแบบ sequential, ทุกคำสั่งห่อ try/catch แยก)

| # | code | SQL predicate ที่ใช้จริง | ผลต่อ verdict |
|---|---|---|---|
| 1 | `lossy_conversion` | `col IS NOT NULL AND (CONVERT(col USING utf8mb4) COLLATE utf8mb4_bin) <> (CONVERT(CONVERT(CONVERT(col USING utf8mb4) USING utf8mb3) USING utf8mb4) COLLATE utf8mb4_bin)` — เทียบค่าต้นฉบับกับค่าที่ผ่าน round-trip เข้า charset เป้าหมายแล้วกลับมา | **`block`** |
| 2 | `unique_collision` | `SELECT COUNT(*) FROM (SELECT COUNT(*) __c FROM tbl WHERE <ทุกคอลัมน์ IS NOT NULL> GROUP BY CONVERT(col USING utf8mb3) COLLATE utf8mb3_general_ci, ... HAVING COUNT(*) > 1) __g` — ตรวจทุก UNIQUE index ที่มีคอลัมน์อยู่ในชุดที่จะเปลี่ยน (รองรับ prefix index ด้วย `LEFT(col, subPart)`) | **`block`** |
| 3 | `suspect_double_encoding` | `col IS NOT NULL AND HEX(col) REGEXP '^([0-9A-F]{2})*(C[2-9A-F]\|D[0-9A-F]\|E[0-9A-F]\|F[0-4])(8[0-9A-F]\|9[0-9A-F]\|A[0-9A-F]\|B[0-9A-F])'` — มองหาคู่ byte แบบ UTF-8 lead+continuation ในไบต์ดิบ ตรวจ**เฉพาะคอลัมน์ charset 1 ไบต์** (latin1, tis620, cp1252, ...) | **`warn`** |

**ขอบเขตการสแกนถูกจำกัดเสมอ (`server/lib/limits.js`)**

การสแกนแบบ *ไม่จำกัด* คือสาเหตุที่ preflight เคย "ค้าง" — ไม่มีความคืบหน้า ไม่มี timeout ยกเลิกไม่ได้
ตอนนี้ทุกทางเข้ามีเพดานเสมอ:

| เรื่อง | พฤติกรรม |
|---|---|
| ไม่ส่ง `rowLimit` มา / ส่งค่าว่าง / ส่งค่าที่อ่านไม่ออก | ใช้ `config.scan.defaultRowLimit` = **200,000 แถว** — ไม่เคยกลายเป็น unlimited |
| อยากสแกนทั้งตารางจริงๆ | ต้องส่ง `fullScan: true` มาโดยตรง (UI = ตัวเลือก "ทั้งตาราง") |
| ส่งค่าเว่อร์ เช่น `999999999999` | clamp ที่ `config.scan.maxRowLimit` = 50,000,000 |
| ทุก statement บน connection ที่สแกน | `max_execution_time` (MySQL) + `max_statement_time` (MariaDB) = `config.scan.statementTimeoutSec` = **60 วินาที** |
| ยกเลิกกลางคัน | `POST /api/preflight/:id/cancel` — ลูปเช็ค `cancelRequested` ระหว่างตาราง, statement timeout คุมตารางที่กำลังอ่านอยู่ |

**ทุกคำสั่งอ่านจาก row source เดียวกัน** — ไม่ใช่แค่คำสั่งนับ ก่อนหน้านี้ `rowLimit` คุมเฉพาะ query ที่นับ
ส่วนการดึงตัวอย่างและ `GROUP BY` ของ UNIQUE index ยังกวาดทั้งตารางอยู่ ซึ่งทำให้ preflight ที่ "จำกัดแถวแล้ว"
ยังรันเป็นชั่วโมงได้ ตอนนี้ `rowSource()` สร้างแหล่งเดียวให้ทั้ง 3 คำสั่ง:

```sql
-- มี primary key: เรียงตาม PK เพื่อให้สแกนซ้ำครอบคลุมแถวชุดเดิม
-- (InnoDB อ่าน clustered index ตามลำดับนี้อยู่แล้ว จึงไม่มีค่า sort เพิ่ม)
(SELECT * FROM `db`.`t` ORDER BY `id` LIMIT 200000) AS __src
-- ไม่จำกัดแถว: ใช้ตารางตรงๆ ไม่ห่อ derived table
-- (derived table ที่มี LIMIT เป็น non-mergeable MySQL จะ materialise ลง temp table)
`db`.`t`
```

- คอลัมน์ที่มีปัญหาจะถูกดึง **ตัวอย่าง** ต่อ (default 5 แถว, สูงสุด 50) พร้อม primary-key ของแถว, ค่าปัจจุบัน, `HEX()` และ **ค่าหลังแปลง (`afterValue`)** ให้เห็นชัดว่าอักขระไหนกลายเป็น `?`
- **ความซื่อสัตย์เรื่องความครอบคลุม** — เมื่อสแกนชนเพดาน ผลจะติด `truncated: true`, `coverage: 'partial'`
  และเพิ่ม finding `partial_scan` ระดับ warn · `gate` ของทั้งรอบจะเป็น `warn` ไม่ใช่ `pass`
  เพราะ "ไม่พบปัญหาใน 200,000 แถวแรก" ไม่เท่ากับ "ทั้งตารางปลอดภัย"
- เพดานขนาด `maxScanBytes` (default 5 GB) **ใช้เฉพาะกับการสแกนแบบไม่จำกัดแถว** — เมื่อมี row cap
  ต้นทุนถูกคุมด้วย cap อยู่แล้ว การข้ามตารางใหญ่จึงเป็นการแลกคำตอบบางส่วนที่ได้เร็วกับการไม่ได้คำตอบเลย
  ตารางที่ถูกข้ามได้ `verdict: 'unknown'`, `scanned: false` และหน้า run จะบังคับพิมพ์ `FORCE`
- คอลัมน์ที่ข้าม: ไม่ใช่ text type, ไม่ต้องเปลี่ยน charset, หรือเป็น **generated column**
- **gate ระดับ job**: `block` ถ้า verdict `block` / `warn` ถ้ามี `warn` **หรือสแกนไม่ครบ** / ไม่งั้น `pass`

#### 4.2 / 4.5 Checksum — baseline และ verify

พิสูจน์ว่า **ข้อมูลไม่เปลี่ยน** ข้าม encoding

**ทำไมต้อง normalize เป็น utf8mb4 ก่อน** — การแปลง `latin1` → `utf8mb3` เขียนไบต์ใหม่โดยชอบธรรม ดังนั้น `CHECKSUM TABLE` หรือ hash ระดับไบต์ใดๆ **จะเปลี่ยนแน่นอน** แม้ข้อมูลจะเหมือนเดิมเป๊ะ จึงไม่มีประโยชน์ในการยืนยัน ระบบนี้จึง `CONVERT(col USING utf8mb4) COLLATE utf8mb4_bin` ทุกค่าให้เป็น encoding กลางที่กว้างสุดก่อน แล้วจึง hash → digest จะ **เท่าเดิมเป๊ะถ้าการแปลงถูกต้อง** และเปลี่ยนทันทีที่มีอักขระใดถูกแทนหรือหาย

**การรวมผลแบบไม่ขึ้นกับลำดับแถว** — SHA-256 hex 64 ตัวของแต่ละแถวถูกตัดเป็น 4 ท่อน (`SUBSTRING(__h, 1|16|31|46, 15)`) แปลงเป็นเลขฐานสิบด้วย `CONV(...,16,10)` แล้วรวมด้วย `BIT_XOR` (2 ท่อนแรก) + `SUM` (2 ท่อนหลัง) ทั้งสอง operator นี้ **commutative** ทำให้ไม่ต้อง `ORDER BY` เลย → สแกน sequential ครั้งเดียวต่อตาราง ไม่สร้าง temp file ผลลัพธ์ pack เป็น string `x1-x2-s1-s2` (hex 16 หลักต่อท่อน) หรือ `'empty'` ถ้าตารางว่าง

**การ normalize ต่อชนิดข้อมูล**

| ชนิด | expression |
|---|---|
| `binary`/`varbinary`/`blob`/`geometry`/... | `HEX(col)` |
| `char`/`varchar`/`*text`/`enum`/`set`/`json` | `CONVERT(col USING utf8mb4)` |
| `float` / `double` | `CONVERT(FORMAT(col, 12) USING utf8mb4)` (กันปัญหาความละเอียดทศนิยม) |
| อื่นๆ ทั้งหมด | `CONVERT(CAST(col AS CHAR) USING utf8mb4)` |

`NULL` → sentinel `' <NULL> '` ต่อแถวรวมด้วย `CONCAT_WS('', ...)`

**mode = อัลกอริทึมที่ใช้ hash**

| mode | พฤติกรรม |
|---|---|
| `sha256` (default) | `SHA2(rowExpr, 256)` ต่อแถว — ละเอียดที่สุด ช้าที่สุด |
| `crc32` | `LPAD(HEX(CRC32(rowExpr)), 64, '0')` — เร็วกว่ามาก แต่โอกาส collision สูงกว่า |
| `deep: true` | เพิ่ม `columnDigests` ต่อคอลัมน์ (เฉพาะ text/binary type) เพื่อระบุได้ว่า **คอลัมน์ไหน** เปลี่ยน |
| `includeNative: true` | เก็บ `CHECKSUM TABLE` ไว้เป็น **ข้อมูลอ้างอิงเท่านั้น** ค่านี้ *คาดว่าจะเปลี่ยน* และไม่เคยใช้ตัดสิน verdict (ข้าม engine `MEMORY`) |

**strategy = อ่านกี่แถว** (`pickStrategy` ใน `server/lib/checksum.js`)

digest แบบเต็มตารางบนตาราง 60 GB คือ full table scan + hash ทุกแถว และมันรัน **สองครั้งต่อตาราง**
ระหว่าง migration (ก่อนและหลัง ALTER) ซึ่งอยู่ในหน้าต่างที่ตารางเขียนไม่ได้ — การอ่านทั้งตารางตรงนั้น
คือ downtime ไม่ใช่ความรอบคอบ `auto` จึงลดระดับอย่างจงใจและบอกให้รู้ว่าลด

| strategy | เลือกเมื่อ | อ่านอะไร |
|---|---|---|
| `full` | ขนาด ≤ `config.scan.checksumFullMaxBytes` (2 GB) | ทั้งตาราง |
| `pk_head` | ใหญ่กว่านั้น **และ** มี primary key ที่ลำดับไม่เปลี่ยน | `ORDER BY <pk> LIMIT 200000` |
| `rowcount` | ใหญ่ และไม่มี PK แบบนั้น | `COUNT(*)` อย่างเดียว |

**ทำไม `LIMIT` เฉยๆ ใช้เทียบก่อน/หลังไม่ได้** — `LIMIT n` ที่ไม่มี `ORDER BY` ไม่รับประกันว่าจะได้แถวชุดเดิม
ก่อนและหลัง ALTER ที่ rebuild ตารางใหม่ทั้งก้อน digest สองค่าจึงเทียบกันไม่ได้ตั้งแต่ต้น (ของเดิมมี `rowLimit` แบบนี้)
`pk_head` เรียงตาม PK จึงอ่านแถวชุดเดิมแน่นอน

**เงื่อนไขของ PK ที่ใช้ได้** (`stablePkColumns`) — ทุกคอลัมน์ใน PRIMARY ต้อง **ไม่มี charset** และไม่เป็น prefix index
PK ที่เป็น text จะถูก **จัดลำดับใหม่** เมื่อเปลี่ยน collation แปลว่า "200,000 แถวแรก" หลังแปลงเป็นคนละชุดกับก่อนแปลง
ซึ่งจะรายงาน mismatch หลอกๆ — กรณีนี้จึงตกไปเป็น `rowcount` แทนที่จะโกหก

**`COUNT(*)` ก็เป็น full scan** บน InnoDB จึงจ่ายเฉพาะตอนที่คุ้ม: strategy `rowcount`, หรือ `full`
บนตารางที่ ≤ `config.scan.exactRowCountMaxBytes` (2 GB) นอกนั้นใช้ค่าประมาณจาก `information_schema`
แล้วติดธง `rowCountExact: false` ไว้ (การเปรียบเทียบจะไม่นับค่าประมาณที่ขยับเป็นความผิดปกติ)

**คอลัมน์ที่ถูกตัดออกจาก checksum**: **generated column** (`GENERATION_EXPRESSION` ไม่ว่าง) ทั้ง VIRTUAL และ STORED — เพราะเป็นค่าที่คำนวณมาจากคอลัมน์อื่น ถ้ารวมไว้ค่าที่ derive จะกลบการเปลี่ยนแปลงจริงของคอลัมน์ต้นทาง รายชื่อที่ตัดออกถูกบันทึกใน `columnsExcluded` ของ snapshot

**การเปรียบเทียบ** (`compareChecksum`) แจ้งไม่ผ่านเมื่อ: mode ไม่ตรง, **strategy ไม่ตรง**, **`rowLimit` ไม่ตรง**,
`rowCount` เปลี่ยน (เฉพาะเมื่อทั้งสองฝั่งนับจริง), `digest` ไม่ตรง, `columnDigests` ต่างกัน (ระบุชื่อคอลัมน์),
หรือมีคอลัมน์ใน `columnsIncluded` เดิมหายไปหลังแปลง

ผลลัพธ์มี `strength` + `caveat` ติดมาด้วยเสมอ เพื่อไม่ให้ "ผ่าน" ที่อ่อนถูกอ่านว่าแข็ง:

| strength | หมายความว่า |
|---|---|
| `full` | เทียบทุกแถวทุกคอลัมน์ |
| `sampled` | เทียบเฉพาะ N แถวแรกตาม PK — แถวที่เหลือไม่ได้ตรวจ |
| `rowcount_only` | เทียบแค่จำนวนแถว ไม่ได้ตรวจเนื้อข้อมูล |

ปุ่ม "verify" (`POST /api/checksum/:id/verify`) รัน snapshot ใหม่ด้วย **strategy และ `rowLimit` ชุดเดียวกับ baseline**
แล้ว diff คืน `summary.mismatches`

**หมายเหตุเรื่อง connection pool** — statement timeout ที่ตั้งไว้ตอนสแกนจะถูกล้าง (`clearStatementTimeout`)
ก่อนคืน connection เข้า pool เสมอ และ `sessionGuards()` ของตัวรัน job ก็สั่ง
`SET SESSION max_execution_time = 0` / `max_statement_time = 0` ซ้ำอีกชั้น
เพราะ **MariaDB บังคับ `max_statement_time` กับ DDL ด้วย** — timeout 60 วินาทีที่ตกค้างอยู่บน connection
จะฆ่า `ALTER` ที่รันมาเป็นชั่วโมงได้

#### 4.3 / 4.4 แผน & รัน

`POST /api/plan` สร้าง **plan เป็น data ล้วน ไม่แตะฐานข้อมูลเลย** เก็บลง `data/plans/<planId>.json`

**Plan step kinds ทั้ง 4 แบบ**

| kind | SQL ที่สร้าง | `metadataOnly` | rollbackSql |
|---|---|---|---|
| `schema_default` | `ALTER DATABASE \`db\` CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci;` | ✅ | `ALTER DATABASE` กลับเป็นค่าเดิม |
| `table_default` | `ALTER TABLE \`db\`.\`t\` DEFAULT CHARACTER SET ... COLLATE ...;` (ใช้เมื่อไม่มีคอลัมน์ข้อความต้องแปลง แต่ default ของตารางยังเก่า) | ✅ | คืน `DEFAULT CHARACTER SET` เดิม |
| `table_convert` | `ALTER TABLE \`db\`.\`t\` CONVERT TO CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci<suffix>;` | ❌ rebuild | `CONVERT TO` กลับ charset เดิมของตาราง **+ คำสั่ง `MODIFY COLUMN` เพิ่มเติมเพื่อคืนคอลัมน์ที่เคยมี charset ต่างจาก default ของตาราง** (เพราะ `CONVERT TO` จะรวบให้เหมือนกันหมด) |
| `column_modify` | `ALTER TABLE ... MODIFY COLUMN <นิยามเต็ม> CHARACTER SET ... COLLATE ..., ...<suffix>;` ทีละคอลัมน์ | ❌ rebuild | ชุด `MODIFY COLUMN` ที่ประกอบนิยามเดิมกลับ |

**2 strategies**

- **`convert_table`** (default, แนะนำ) — `CONVERT TO CHARACTER SET` ปล่อยให้ MySQL จัดการนิยามคอลัมน์เอง ปลอดภัยกว่าเพราะไม่ต้องประกอบ DDL ใหม่
- **`modify_columns`** — ประกอบนิยามคอลัมน์ขึ้นใหม่จาก `information_schema` (`columnDefinition()` รวม `COLUMN_TYPE`, charset/collate, `GENERATED ALWAYS AS`, NULL/NOT NULL, `DEFAULT` (จัดการทั้งแบบ MySQL 8 `DEFAULT_GENERATED` expression และรูปแบบ pre-quoted ของ MariaDB), `AUTO_INCREMENT`, `ON UPDATE CURRENT_TIMESTAMP`, `INVISIBLE`, `COMMENT`) ใช้เมื่อต้องการคงคอลัมน์ที่ตั้ง charset เฉพาะเอาไว้ — **ต้องอ่าน DDL ที่สร้างออกมาให้ครบก่อนรัน** (ดู "ข้อจำกัดที่ทราบ")

**Risk codes ทั้งหมดที่ `tableRisks()` ออก**

| code | level | เงื่อนไข |
|---|---|---|
| `lossy_narrowing` | critical | มีคอลัมน์ที่ charset ต้นทางกว้าง (bytes/char มากกว่า) กว่าเป้าหมาย |
| `unique_collation` | warn | มีคอลัมน์ `UNI` หรือ UNIQUE index ครอบคอลัมน์ที่จะเปลี่ยน collation |
| `partitioned` | warn | ตารางมี partition (ALTER จะ rebuild ทุก partition) |
| `fulltext` | warn | มี FULLTEXT index (สร้างใหม่หมด ผลค้นหาอาจเปลี่ยนตาม collation) |
| `fk_text_columns` | warn | มี foreign key บนคอลัมน์ข้อความ (charset ฝั่ง parent/child ต้องตรงกัน) |
| `generated_columns` | warn | มี generated column ที่เป็นข้อความในชุดที่จะเปลี่ยน |
| `index_too_long` | critical | ผลรวมไบต์ของ index เกินเพดาน (คำนวณเฉพาะกรณี **widening** — ดู "ข้อจำกัดที่ทราบ") |
| `row_too_large` | critical | ผลรวมความยาวคอลัมน์ข้อความเกิน 65,535 ไบต์ (widening เท่านั้น) |
| `large_table` | warn | `DATA_LENGTH + INDEX_LENGTH` > 5 GiB |
| `non_innodb` | info | engine ไม่ใช่ InnoDB |
| `metadata_only` | info | step แก้เฉพาะ metadata ไม่ rebuild |
| `mixed_charsets` | info | มีคอลัมน์ที่ charset ต่างจาก default ของตาราง (rollback มีคำสั่งคืนค่าไว้แล้ว) |

**`BYTES_PER_CHAR`** ตารางความกว้างสูงสุดต่ออักขระ ใช้ประเมินการโต/หดของ index และแถว:
1 ไบต์ — `ascii latin1 latin2 latin5 latin7 tis620 cp1250 cp1251 cp1256 cp1257 cp850 cp852 cp866 dec8 hp8 keybcs2 koi8r koi8u macce macroman swe7 geostd8 greek hebrew armscii8 binary` ·
2 ไบต์ — `big5 gbk sjis euckr ucs2 cp932 gb2312` ·
3 ไบต์ — `ujis eucjpms utf8 utf8mb3` ·
4 ไบต์ — `utf16 utf16le utf8mb4 utf32 gb18030` ·
**charset ที่ไม่รู้จัก → สมมติ 4 ไบต์** (ปลอดภัยฝั่งสูง)

**เพดานความยาว index (`indexByteLimit`)**: `767` ไบต์ ถ้า InnoDB + `ROW_FORMAT` COMPACT/REDUNDANT, `3072` ไบต์ ถ้า InnoDB row format อื่น (DYNAMIC/COMPRESSED), `1000` ไบต์ ถ้าไม่ใช่ InnoDB คอลัมน์ที่ไม่ใช่ text นับเหมาๆ 8 ไบต์

**`renderScript(plan, direction)`** สร้างสคริปต์ `.sql` ที่อ่านทานได้ — header ระบุ target / strategy / order / จำนวน step, ใส่ `SET SESSION foreign_key_checks = 0;` หัว-ท้ายถ้าเลือกไว้, แต่ละ step มี comment `-- [kind] title` ตามด้วย comment risk ทุกข้อ (`-- CRITICAL: ...`) แล้วจึงเป็น SQL
`direction=rollback` ใช้ `rollbackSql` และ **กลับลำดับ step** ดึงได้จาก `GET /api/plan/:id/script?direction=rollback&download=1`

**คำสั่ง online schema change** ทุก step ที่ต้อง rebuild จะแนบคำสั่งพร้อมคัดลอกไว้ใน `step.tooling`:

```bash
# pt-online-schema-change
pt-online-schema-change --alter "CONVERT TO CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci" \
  D=mydb,t=mytable --host=127.0.0.1 --port=3306 --user=root --ask-pass \
  --max-load Threads_running=40 --critical-load Threads_running=80 \
  --chunk-time=0.5 --set-vars lock_wait_timeout=5 \
  --no-drop-old-table --alter-foreign-keys-method=auto --execute

# gh-ost
gh-ost --database="mydb" --table="mytable" \
  --alter="CONVERT TO CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci" \
  --host="127.0.0.1" --port=3306 --user="root" --ask-pass \
  --max-load=Threads_running=40 --critical-load=Threads_running=80 \
  --chunk-size=1000 --initially-drop-ghost-table --allow-on-master --execute
```

ทั้งสองคำสั่งใช้ `--ask-pass` — **รหัสผ่านไม่เคยถูกฝังในคำสั่งที่แสดง**

### 6. งาน / Rollback (`#jobs`)

`POST /api/jobs` สร้างและเริ่ม job จาก `planId` ที่บันทึกไว้

**Step lifecycle** (`jobs.executeStep`) — สถานะไต่ไปตามลำดับนี้ และ `persist(job)` เขียนลงดิสก์ทุกครั้งที่เปลี่ยน:

```text
pending
  → running        (เขียน audit step.start พร้อม SQL เต็ม)
  → [throttle]     รอจนเซิร์ฟเวอร์ว่าง (ข้ามถ้า metadataOnly)
  → บันทึก SHOW CREATE TABLE ก่อนแปลง (createTableBefore)
  → backing_up     (ถ้า backupStrategy ≠ none และไม่ใช่ metadataOnly)
  → checksum_before
  → altering       (รัน step.sql แล้วเก็บ SHOW WARNINGS)
  → checksum_after → compareChecksum → ถ้าไม่ตรง throw (checksumMismatch)
  → verifyMetadata (อ่าน information_schema ยืนยัน collation/columns ตรงเป้าหมาย)
  → done  |  failed
```

`verifyMetadata` ไม่ทำให้ step ล้มเหลว — ถ้าไม่ตรงจะบันทึก finding `meta_not_target` ระดับ warn

**Throttling (`waitForQuiet`)** ก่อนทุก step ที่ต้อง rebuild:

- อ่าน `SHOW GLOBAL STATUS LIKE 'Threads_running'` → ต้อง `<= maxThreadsRunning` (default **40**)
- อ่าน `SHOW REPLICA STATUS` แล้ว fallback `SHOW SLAVE STATUS` → ถ้ามี replica ค่า `Seconds_Behind_Source`/`Seconds_Behind_Master` ต้อง `<= maxReplicaLagSec` (default **30** วินาที) — ถ้าเป็น `NULL` (replication หยุด) จะ**ไม่**บล็อก
- ยังไม่ว่าง → เขียน `throttle.wait` แล้ว `sleep(throttleWaitMs = 2000)` วนได้สูงสุด `throttleMaxWaits = 150` ครั้ง ≈ **5 นาที** เกินกว่านั้น step ล้มเหลวด้วยข้อความว่าโหลดสูงเกินเกณฑ์นานเกินกำหนด
- ถ้าอ่าน status ไม่ได้ (ไม่มีสิทธิ์ `PROCESS`/`REPLICATION CLIENT`) จะ **ไม่** บล็อก — ถือเป็น 0 / null
- `options.ignoreLoad: true` ปิด throttle ทั้งหมด

**Session guards** (`sqlgen.sessionGuards`) รันครั้งเดียวก่อน step แรกบน connection ที่ใช้รันจริง — ถ้าคำสั่งใดล้มเหลวจะบันทึก `guard.failed` แล้วรันต่อ:

```sql
SET SESSION lock_wait_timeout = 30;
SET SESSION innodb_lock_wait_timeout = 30;
SET SESSION foreign_key_checks = 0;      -- ถ้า disableFkChecks
SET SESSION sql_log_bin = 0;             -- ถ้า skipBinlog
SET SESSION max_execution_time = <ms>;   -- ถ้า CSMIG_STMT_TIMEOUT > 0
```

**Backup strategies ทั้ง 3**

| strategy | วิธี | rollback | ข้อควรรู้ |
|---|---|---|---|
| `none` | ไม่ backup | ใช้ inverse DDL เท่านั้น | เร็วสุด แต่ **กู้อักขระที่กลายเป็น `?` ไม่ได้เลย** |
| `table_copy` | `CREATE TABLE \`db\`.\`_csmig_<stamp>_<tbl>\` LIKE \`db\`.\`tbl\`` แล้ว `INSERT INTO ... SELECT * FROM ...` แล้วนับแถวยืนยัน | **`RENAME TABLE` สลับกลับแบบ atomic** (เร็วและครบที่สุด) | ใช้เนื้อที่ใน DB เท่าตารางเดิม; ชื่อ backup ถูกตัดที่ 64 อักขระ |
| `mysqldump` | `spawn('mysqldump', ...)` เขียนไป `data/jobs/<jobId>-backup/<db>.<tbl>.sql` | ใช้ inverse DDL แล้วแนบ note ชี้ path ไฟล์ให้ restore ด้วยมือ | ส่งรหัสผ่านผ่าน env `MYSQL_PWD` (ไม่โผล่ใน `ps`); ต้องมี `mysqldump` ใน `PATH` |

**วิธีคัดลอกของ `table_copy`** (`server/lib/jobs.js` → `copyTable()`) ออกแบบมาให้ตารางใหญ่ไม่ล้มทั้งเซิร์ฟเวอร์

- **แบ่งชุดตาม primary key** ชุดละ `runner.copyChunkRows` แถว (ตั้งต้น 50,000 ปรับด้วย `CSMIG_COPY_CHUNK_ROWS`) เดินด้วย keyset cursor `WHERE (pk) > (last) ORDER BY pk LIMIT n` แทนที่จะเป็นคำสั่งเดียวคลุมทั้งตาราง — undo ไม่บวมค้างจนกว่าจะจบ, มี % ให้ดู, และ**กดยกเลิกได้ระหว่างชุด** ตารางที่ไม่มี primary key (หรือ PK เป็น prefix) ตกกลับไปใช้คำสั่งเดียวและรายงานว่า `chunked: false`
- **สร้าง secondary index ทีหลัง** ดรอป index ตอนตารางยังว่าง โหลดเสร็จค่อย `ADD INDEX` รอบเดียว (sorted build) แทนการแทรก B-tree แบบสุ่มทีละแถวต่อ index ต่อแถว — index ที่สร้างกลับให้เหมือนเดิมเป๊ะไม่ได้ (functional, fulltext, spatial, hash, invisible) จะ **ไม่ถูกแตะ** และโหลดแบบช้าตามเดิม เพราะตารางสำรองที่ index ไม่เหมือนต้นฉบับแย่กว่า backup ที่ช้า หลังสร้างเสร็จมีการเทียบรายชื่อ index ก่อน/หลัง ถ้าขาดจะ **ล้มทั้ง step** ก่อนที่ `ALTER` จะแตะข้อมูล
- **ไม่นับ `COUNT(*)` โดยไม่จำเป็น** จำนวนแถวที่คัดลอกได้มาจากผลรวม `affectedRows` ของแต่ละชุดอยู่แล้ว ส่วนฝั่งต้นทางนับจริงเฉพาะตารางที่เล็กกว่า `scan.exactRowCountMaxBytes` (2 GB) ตารางใหญ่ใช้ค่าประมาณจาก information_schema และตั้ง `sourceRowsExact: false` กับ `consistent: null` — ค่าประมาณต้องไม่อ่านเหมือนคำตัดสิน
- **ล้มแล้วเก็บกวาด** ถ้าคัดลอกล้มหรือถูกยกเลิกกลางทาง ตารางสำรองที่ค้างจะถูก `DROP` ทิ้ง ตารางครึ่งใบที่ใช้ชื่อแบบ backup อันตรายกว่าไม่มี backup เพราะอาจมีคน `RENAME` มันกลับเข้าไป
- **คอลัมน์ generated ถูกระบุชื่อออกจาก INSERT** `INSERT INTO t SELECT *` ล้มทันทีบนตารางที่มี generated column ตัวคัดลอกจึงไล่ชื่อคอลัมน์ที่เก็บค่าได้จริงแทน `*`

flag ของ mysqldump ที่ใช้: `--single-transaction --quick --hex-blob --routines=false --triggers=false --default-character-set=binary --add-drop-table`
บน **MySQL** เพิ่ม `--set-gtid-purged=OFF --column-statistics=0` ให้ด้วย; บน **MariaDB** สอง flag นี้ถูกตัดออกอัตโนมัติเพราะ `mysqldump` ของ MariaDB ตอบ `unknown option`
`--default-character-set=binary` สำคัญมาก — ทำให้ dump เก็บไบต์ดิบ ไม่ให้ client แปลง charset ระหว่างทาง

**Rollback methods ทั้ง 2**

| method | เมื่อไหร่ | ทำอะไร |
|---|---|---|
| `table_copy_swap` | มี backup แบบ `table_copy` และ `preferFastRollback !== false` | `RENAME TABLE db.tbl TO db._csmig_<stamp>_bad_<tbl>, db._csmig_<stamp>_<tbl> TO db.tbl;` — atomic ตารางเดิมถูกเก็บไว้ในชื่อ `bad_` เพื่อชันสูตร |
| `inverse_ddl` | กรณีอื่นทั้งหมด | รัน `step.rollbackSql` ทุกคำสั่ง ถ้าเกิด `checksumMismatch` หรือ backup เป็น mysqldump จะแนบ `note` เตือนว่า **inverse DDL คืนโครงสร้างได้ แต่ถ้าอักขระถูกแทนด้วย `?` แล้วต้อง restore จากไฟล์** พร้อม path ของไฟล์ |

หลัง rollback ทุกครั้ง ถ้ามี `checksumBefore` อยู่ ระบบจะรัน checksum ใหม่แล้ว `compareChecksum` เพื่อยืนยันว่ากลับสภาพเดิมจริง — ถ้าไม่ตรงจะได้สถานะ `verify_failed`

**Auto-rollback** — เมื่อ step ล้มเหลวและ `autoRollbackOnFailure !== false` (default เปิด) ระบบจะ rollback **step นั้น** ทันที ถ้าตั้ง `rollbackAllOnFailure: true` ด้วย จะ cascade rollback ทุก step ที่ `done` แล้วในลำดับย้อนกลับ และสถานะ job จะเป็น `rolled_back` แทน `failed`
`stopOnError !== false` (default) หยุดทั้ง job ทันทีเมื่อ step ใดล้มเหลว

**Manual rollback** — `POST /api/jobs/:id/rollback` (job ต้องอยู่ในสถานะ terminal: `done` / `failed` / `cancelled` / `rolled_back`) เลือก step ได้ด้วย `stepIds[]` ถ้าไม่ระบุจะ rollback ทุก step ที่สถานะ `done` หรือ `failed` **ในลำดับย้อนกลับ**

**pause / resume / cancel** — `POST /api/jobs/:id/pause {paused}` (job หยุดที่ขอบ step ไม่ตัดกลาง `ALTER`), `POST /api/jobs/:id/cancel` (ตั้ง `cancelRequested` ซึ่งถูกเช็คก่อนแต่ละ step และในลูป throttle)

**Persistence** — `data/jobs/<id>.json` ถูกเขียนใหม่ทุกครั้งที่สถานะเปลี่ยน (สร้าง job / step เปลี่ยนสถานะ / backup เสร็จ / rollback) จึงมี manifest ที่ใช้ rollback ได้แม้โปรเซสจะ crash กลางทาง คู่กับ event stream `data/jobs/<id>.ndjson`
**Job object อยู่ในหน่วยความจำเท่านั้น** — restart แล้ว job จะไม่ถูกโหลดกลับมาเป็น object ที่รันหรือ rollback ได้ `jobs.listArchived()` อ่าน JSON เก่ามาแสดงแบบ **read-only** (`archived: true`)

### 7. Logs / Audit (`#logs`)

- `GET /api/audit` คืนรายชื่อไฟล์รายวัน, `GET /api/audit/:day` อ่านได้สูงสุด 1,500 บรรทัดล่าสุด (default) — path ถูกตรวจว่าอยู่ใต้ `data/audit` เท่านั้น กัน path traversal
- `GET /api/jobs/:id/log` อ่าน NDJSON ของ job (สูงสุด 3,000 บรรทัดล่าสุด default)
- ทุกบรรทัดผ่าน redaction เดียวกันตอนเขียน — log ที่แสดงจึงไม่มีรหัสผ่านอยู่แล้วโดยโครงสร้าง

**Audit events ที่มี**: `server.start`, `server.stop`, `process.unhandledRejection`, `process.uncaughtException`, `session.connect`, `session.connect.failed`, `session.disconnect`, `session.credential.reveal`, `inventory.export`, `tables.export`, `preflight.start|done|failed`, `checksum.start|done|failed`, `plan.created`, `job.created`, `api.error` และ job events: `job.start`, `job.finish`, `job.error`, `job.cancel.requested`, `job.pause`, `job.resume`, `step.start`, `step.backup.start|done`, `step.backup.indexes.deferred`, `step.backup.unchunked`, `step.backup.cleanup|cleanup.failed`, `step.checksum.before|after`, `step.warnings`, `step.done`, `step.failed`, `step.meta.mismatch`, `throttle.wait`, `guard.failed`, `rollback.step.start|done|failed`, `rollback.job.start|finish`

---

## API endpoints

ทุก endpoint ต้องมี header `X-App-Key: <boot key>` ทุก endpoint ยกเว้น `/api/meta` และ `/api/connect` ต้องมี `X-Session-Id` ด้วย (หรือ query `?sessionId=`)

| Method | Path | หน้าที่ |
|---|---|---|
| `GET` | `/` | หน้า UI (ต้องมี `?key=<boot key>` ไม่งั้น 401) |
| `GET` | `/assets/*` | static CSS/JS ของ UI (ไม่ต้องมี boot key) |
| `GET` | `/api/meta` | charset เป้าหมาย, system schemas, ค่า runner, idle timeout, และข้อความเตือนเรื่อง narrowing / utf8mb3 deprecated |
| `POST` | `/api/connect` | สร้าง session + pool (`{host, port, user, password, database, ssl}`) → คืน `publicView` |
| `GET` | `/api/session` | ข้อมูล session ปัจจุบัน (ใช้ resume หลัง reload หน้า) |
| `POST` | `/api/disconnect` | ทำลาย session, ปิด pool, wipe vault |
| `GET` | `/api/schemas` | รายชื่อ schema + default charset/collation + จำนวนตาราง/ขนาด/แถวประมาณ |
| `GET` | `/api/facets` | ค่า distinct สำหรับ dropdown (charsets, collations, engines, dataTypes) + `information_schema.COLLATIONS` ทั้งหมด |
| `GET` | `/api/summary` | รวมยอดทั้ง instance/scope: สัดส่วนตาม charset/collation, ต่อ schema, และ `otherObjects` (views/routines/triggers/events) |
| `GET` | `/api/inventory` | ตาราง column แบบแบ่งหน้า + ฟิลเตอร์ + เรียง |
| `GET` | `/api/inventory.csv` | export CSV (UTF-8 BOM) ใช้ฟิลเตอร์เดียวกัน ไม่แบ่งหน้า cap 200k แถว |
| `GET` | `/api/tables` | **work list** — 1 แถวต่อตาราง + สถานะ (`rebuild` / `metadata_only` / `compliant`) + ยอดรวมต่อสถานะ |
| `GET` | `/api/export/tables.xlsx` | work list เป็นไฟล์ Excel ใช้ฟิลเตอร์เดียวกัน ไม่แบ่งหน้า ตั้งต้น `status=todo` (cap 100k แถว เกินแล้วตอบ 413) |
| `GET` | `/api/tables/:schema/:table` | ทุกอย่างที่หน้าทำงานต่อตารางต้องใช้: metadata, คอลัมน์ที่ต้องเปลี่ยน, `scanPlan`, `checksumPlan` |
| `POST` | `/api/preflight` | เริ่ม preflight scan (async) → **HTTP 202** + task view |
| `GET` | `/api/preflight` | รายการ task ที่รันอยู่ + ผลที่เก็บไว้ใน `data/snapshots` |
| `GET` | `/api/preflight/:id` | สถานะ/ความคืบหน้า (ใส่ `?full=1` เพื่อเอาผลเต็ม) — ถ้าไม่อยู่ในหน่วยความจำจะอ่านจากไฟล์ |
| `POST` | `/api/preflight/:id/cancel` | ขอยกเลิกการสแกน (เช็คระหว่างตาราง + statement timeout คุมตารางที่กำลังอ่าน) |
| `POST` | `/api/checksum` | เริ่มทำ checksum snapshot (async) → **HTTP 202** |
| `GET` | `/api/checksum` | รายการ snapshot ที่รันอยู่ + ที่เก็บไว้ |
| `GET` | `/api/checksum/:id` | สถานะ/ผลของ snapshot (`?full=1`) |
| `POST` | `/api/checksum/:id/cancel` | ขอยกเลิกการคำนวณ |
| `POST` | `/api/checksum/:id/verify` | รัน snapshot ใหม่บนตารางชุดเดิมแล้ว diff กับ baseline → **HTTP 202** |
| `POST` | `/api/plan` | สร้างแผน (ไม่แตะ DB) → `{planId, plan}` และบันทึกลง `data/plans` |
| `GET` | `/api/plan/:id` | อ่านแผนที่บันทึกไว้ |
| `GET` | `/api/plan/:id/script` | แผนในรูปสคริปต์ `.sql` (`?direction=forward\|rollback`, `?download=1`) |
| `POST` | `/api/jobs` | สร้างและเริ่ม job จาก `planId` → **HTTP 202** — **มี preflight gate ตรงนี้** |
| `GET` | `/api/jobs` | รายการ job ในหน่วยความจำ + job ที่ archive ไว้บนดิสก์ |
| `GET` | `/api/jobs/:id` | รายละเอียด job + ทุก step (`?steps=0` เพื่อตัด step ออก) |
| `GET` | `/api/jobs/:id/log` | event stream NDJSON ของ job (`?limit=`) |
| `POST` | `/api/jobs/:id/pause` | `{paused: true\|false}` หยุด/ไปต่อที่ขอบ step |
| `POST` | `/api/jobs/:id/cancel` | ขอยกเลิก (ตรวจก่อนแต่ละ step และในลูป throttle) |
| `POST` | `/api/jobs/:id/rollback` | rollback แบบสั่งเอง (`{stepIds?: []}`) job ต้องอยู่สถานะ terminal |
| `GET` | `/api/audit` | รายชื่อไฟล์ audit รายวัน |
| `GET` | `/api/audit/:day` | อ่าน audit ของวันนั้น (`?limit=`) |

### Preflight gate ที่ `POST /api/jobs`

```text
ถ้า serverInfo.readOnly และไม่ใช่ dryRun            → 409 "เซิร์ฟเวอร์อยู่ในโหมด read_only"
ถ้า dryRun                                          → ข้าม gate ทั้งหมด
ถ้าไม่มี preflightResult และ acknowledgeNoPreflight ≠ true
                                                    → 412 code: "preflight_required"
ถ้า preflightResult.gate === 'block' และ forceDespiteBlock ≠ true
                                                    → 412 code: "preflight_blocked" (+ summary)
ถ้ามีตาราง rebuild ที่ preflight ไม่ได้สแกน และ acknowledgeUncoveredTables ≠ true
                                                    → 412 code: "preflight_scope_mismatch" (+ uncovered[], uncoveredCount)
```

`options.forced` ถูกบันทึกเป็น `true` ใน job manifest และ audit `job.created` เมื่อใช้ `forceDespiteBlock` — ทำให้การข้าม gate ตรวจสอบย้อนหลังได้

```bash
# ตัวอย่างเรียก job ปกติ (ผ่าน gate ด้วย preflightId)
curl -s http://127.0.0.1:7343/api/jobs \
  -H "X-App-Key: $CSMIG_KEY" -H "X-Session-Id: $SID" \
  -H 'Content-Type: application/json' \
  -d '{"planId":"plan-20260910120000-a1b2c3",
       "preflightId":"preflight-20260910115000-ab12cd",
       "backupStrategy":"table_copy",
       "verifyChecksum":true,
       "dryRun":false}'
```

---

## ข้อจำกัดที่ทราบ

1. **views / stored routines / triggers / events ถูก *รายงาน* แต่ *ไม่แปลงอัตโนมัติ***
   `GET /api/summary` นับ object ที่ `CHARACTER_SET_CLIENT` / `COLLATION_CONNECTION` (และ `DATABASE_COLLATION` ของ routines) ไม่ตรงเป้าหมาย และแสดงในหน้าภาพรวมเป็นตัวเลข `otherObjects` เท่านั้น
   **ไม่มี plan step ชนิดใดแตะ object เหล่านี้เลย** เพราะ metadata charset ของมันถูกตรึงตอน `CREATE` ต้อง **drop แล้ว create ใหม่** ด้วย connection ที่ตั้ง `character_set_client` / `collation_connection` เป็นค่าเป้าหมาย ซึ่งเป็นงานที่ต้องทำด้วยมือ (ดูขั้นตอนใน `RUNBOOK.md`)

2. **การแปลง charset ต้องใช้ `ALGORITHM=COPY` เสมอ — ตารางจะอ่านได้แต่เขียนไม่ได้ตลอดช่วง `ALTER`**
   `CONVERT TO CHARACTER SET` และ `MODIFY COLUMN` ที่เปลี่ยน charset เป็น operation ที่ต้อง rebuild ทั้งตาราง MySQL ไม่รองรับ `ALGORITHM=INPLACE` และ **`LOCK=NONE` เป็นไปไม่ได้** สำหรับกรณีนี้ ตารางจะติด metadata lock ระดับ shared — SELECT ผ่าน แต่ INSERT/UPDATE/DELETE ค้างรอจนจบ ซึ่งอาจกินเวลาหลายชั่วโมงบนตารางใหญ่
   หน้า Plan ยังปล่อยให้เลือก `ALGORITHM=INPLACE` และ `LOCK=NONE` ได้ และ `alterSuffix()` จะ **ต่อค่าที่เลือกลง DDL ตรงๆ ไม่เขียนทับสิ่งที่ผู้ใช้เลือก** (เจตนา: แผนต้องเป็นสิ่งที่รันจริงเป๊ะๆ) แต่ `impossibleDdlRisk()` จะแนบ risk ระดับ **critical** (`algorithm_impossible` / `lock_impossible`) ลงทุก step ที่ต้อง rebuild เพื่อให้เห็นตอน review ไม่ใช่ไปเจอ error ตอนรันกลางทาง
   **ต้องการ zero downtime → ใช้คำสั่ง `pt-online-schema-change` / `gh-ost` ที่แผนสร้างมาให้ในช่อง `tooling` ของแต่ละ step** แอปนี้ **ไม่ได้รัน** เครื่องมือทั้งสองให้ มันแค่สร้างคำสั่งให้คัดลอกไปรันเอง — และ job/checksum/rollback ของแอปจะไม่รู้เรื่องการรันนอกแอปนั้นด้วย

3. **strategy `modify_columns` ประกอบนิยามคอลัมน์ขึ้นใหม่จาก `information_schema` — ต้องอ่านทานก่อนรัน**
   `columnDefinition()` ประกอบ `COLUMN_TYPE` + charset/collate + generated expression + NULL/NOT NULL + `DEFAULT` + `AUTO_INCREMENT` + `ON UPDATE` + `INVISIBLE` + `COMMENT` ขึ้นมาเอง จุดที่เปราะที่สุดคือ **`DEFAULT`** เพราะ `information_schema.COLUMNS.COLUMN_DEFAULT` มีความหมายต่างกันระหว่าง MySQL 8 (`DEFAULT_GENERATED` ใน `EXTRA` = expression default) กับ MariaDB (คืนค่าที่ quote มาแล้ว รวมทั้ง string `NULL`) โค้ดจัดการทั้งสองเคสแล้วแต่ยังมีเคสที่หลุดได้ (เช่น spatial SRID, `CHECK` constraint ระดับคอลัมน์, `COMPRESSED` ของ MariaDB, generated column ที่ต้อง drop/recreate)
   **ให้ดาวน์โหลด forward script (`GET /api/plan/:id/script`) มาเทียบกับ `SHOW CREATE TABLE` ทีละบรรทัดก่อนรันทุกครั้ง** ถ้าไม่มั่นใจให้ใช้ `convert_table` ซึ่งปล่อยให้ MySQL จัดการนิยามเอง

4. **DDL rollback คืนโครงสร้างได้ แต่คืนอักขระที่กลายเป็น `?` ไม่ได้ — มีเพียง backup เท่านั้นที่กู้ได้**
   `rollbackSql` เป็น inverse DDL ที่ถูกต้อง (`CONVERT TO` กลับ charset เดิม + `MODIFY COLUMN` คืนคอลัมน์ที่ charset ต่างจาก default) มันคืน **schema** ให้เหมือนก่อนรันได้ทุกไบต์ แต่ข้อมูลที่ MySQL แทนด้วย `?` ตอน narrowing conversion **หายไปแล้วอย่างถาวรในระดับ SQL** — ไม่มี inverse ทางคณิตศาสตร์
   ทางกู้ที่ใช้ได้จริงมีสองทาง: `table_copy` (rollback ด้วย `RENAME TABLE` = ครบและเร็วที่สุด) หรือ `mysqldump` (restore ไฟล์ด้วยมือ) ถ้าเลือก `backupStrategy: 'none'` **ยอมรับล่วงหน้าว่าถ้าอักขระหาย จะไม่มีทางกู้**
   โค้ดใน `rollbackStep()` แนบ `note` เตือนเรื่องนี้ทุกครั้งที่ rollback ด้วย `inverse_ddl` และเกิด `checksumMismatch`

5. **ไม่มี end-to-end test เทียบฐานข้อมูลจริง** — `npm run check` (54 self-test + static import check) ครอบเฉพาะ pure logic แบบ offline ทุกเส้นทางที่ต้องต่อ MySQL จริง (รัน `ALTER`, backup, throttle, rollback, ความต่างของ `information_schema` ระหว่างเวอร์ชัน/vendor) **ไม่ถูกทดสอบอัตโนมัติ** การรันจริงครั้งแรกต้องเป็น staging หรือสำเนาของ production เท่านั้น

6. **ค่าเริ่มต้นของ preflight และ checksum คือการ *สุ่มตรวจ* ไม่ใช่การรับประกัน**
   เพดาน 200,000 แถวถูกเลือกเพื่อให้ขั้นตอนเดินหน้าได้จริงบนตารางขนาดหลายสิบ GB
   ซึ่งแปลว่า **ผล "ผ่าน" ที่ค่าเริ่มต้นครอบคลุมแค่ส่วนหัวของตาราง** ระบบบอกเรื่องนี้ทุกที่ที่บอกได้
   (`truncated`, `coverage: 'partial'`, finding `partial_scan`, `gate` เป็น `warn` ไม่ใช่ `pass`,
   และ `strength` / `caveat` ในผลเทียบ checksum) แต่ **การตัดสินใจว่าเท่านี้พอไหมเป็นของผู้ใช้**
   สำหรับตารางที่ยอมให้ข้อมูลเสียไม่ได้ ต้องเลือก "ทั้งตาราง" / `full` เอง

7. **preflight gate ตรวจ scope แล้ว แต่ตรวจได้เท่าที่ preflight สแกนสำเร็จ**
   `POST /api/jobs` เทียบรายชื่อตารางใน `preflightResult.tables` (เฉพาะที่ `scanned === true`) กับทุก step ที่ต้อง rebuild ถ้ามีตารางที่ยังไม่ถูกสแกน — รวมถึงตารางที่ถูก **ข้ามเพราะเกิน `maxScanBytes`** — จะตอบ **412 `preflight_scope_mismatch`** พร้อมรายชื่อ ต้องส่ง `acknowledgeUncoveredTables: true` เพื่อข้าม และการข้ามจะถูกบันทึกเป็น audit `job.preflight.scope_override`
   ข้อจำกัดที่เหลือ: gate ไม่ได้ตรวจว่า preflight ถูกรันด้วย **target charset เดียวกัน** กับแผน และไม่ได้ตรวจว่าข้อมูลเปลี่ยนไปหลังสแกนหรือยัง — ถ้าสแกนไว้นานแล้วควรสแกนใหม่

8. **การตรวจ `index_too_long` / `row_too_large` ทำงานเฉพาะกรณี widening**
   ใน `tableRisks()` การคำนวณความยาว index และขนาดแถวอยู่ใน `if (widening)` ซึ่งประเมิน **ต่อคอลัมน์** ไม่ใช่ต่อ target:
   - ต้นทาง `utf8mb4` (4 ไบต์) → `utf8mb3` (3) = narrowing → ไม่ตรวจ (และไม่จำเป็น เพราะ index หดลง)
   - ต้นทาง `latin1` / `tis620` / `cp1251` (1 ไบต์) → `utf8mb3` (3) = **widening → ตรวจ** ซึ่งเป็นเคสหลักของฐานข้อมูลไทยรุ่นเก่า `varchar(300)` บน `tis620` ที่มี index จะกลายเป็น 900 ไบต์ และชนเพดาน 767 ไบต์ของ `ROW_FORMAT=COMPACT`
   สรุป: ถ้า instance เป็น utf8mb4 ล้วน risk สองตัวนี้จะไม่ทำงาน (ถูกต้องแล้ว) แต่ถ้ามีคอลัมน์ charset ไบต์เดียวปนอยู่ มันจะทำงานและสำคัญมาก

9. **`table_copy` backup ไม่ใช่ snapshot ที่ consistent และไม่คัดลอก foreign key / trigger**
   การคัดลอกแบ่งเป็นหลายชุด แต่ละชุดคือ transaction ของตัวเอง จึงยิ่งไม่ใช่ snapshot ณ เวลาเดียว ถ้ามี write เข้ามาระหว่าง copy สำเนาจะไม่ตรงกับตารางต้นฉบับ ณ เวลาใดเวลาหนึ่ง — โค้ดจึงรายงาน `backup.rows`, `backup.sourceRows`, `backup.sourceRowsExact` และ `backup.consistent` ไว้ใน manifest ให้ตรวจได้ (`consistent` เป็น `null` เมื่อตารางใหญ่เกินกว่าจะนับต้นทางจริง) และคัดลอกค่า `AUTO_INCREMENT` ตามต้นฉบับให้ (`CREATE ... LIKE` จะรีเซ็ตตัวนับ ทำให้แจก id ซ้ำที่เคยจ่ายไปแล้ว)
   สิ่งที่ยัง **ไม่** คัดลอกให้: foreign key และ trigger — จำนวน FK ที่หายไปรายงานเป็น `backup.foreignKeysNotCopied` และ DDL ต้นฉบับเก็บไว้ใน `step.createTableBefore` สำหรับสร้างกลับ (ขั้นตอนอยู่ใน `RUNBOOK.md` 8.3) ต้องรันในช่วง maintenance window ที่ไม่มี write หรือใช้ `mysqldump --single-transaction` แทน
   ชื่อ backup table `_csmig_<stamp>_<tbl>` ถูก **ตัดที่ 64 อักขระ** ตารางที่ชื่อยาวมากๆ อาจได้ชื่อ backup ที่ชนกัน

10. **ไม่มี endpoint สำหรับลบ backup table `_csmig_*`** — ต้องทำด้วย SQL เอง (ดูขั้นตอน cleanup ใน `RUNBOOK.md`) แอปไม่ลบให้อัตโนมัติโดยเจตนา เพื่อไม่ให้ทำลายทางกู้ข้อมูลไปเอง

10. **job ที่รันอยู่จะหายเมื่อ restart** — `jobs` เป็น `Map` ในหน่วยความจำ manifest บนดิสก์ยังอยู่ครบ แต่โหลดกลับมาเป็น job ที่ pause/cancel/rollback ผ่าน API ไม่ได้ ต้อง rollback ด้วยมือจาก `rollbackSql` ใน `data/jobs/<id>.json` หรือจาก rollback script

11. **`CSMIG_STMT_TIMEOUT` ไม่ได้จำกัดเวลาของ `ALTER`** — มันสร้าง `SET SESSION max_execution_time` ซึ่ง MySQL บังคับใช้กับ **`SELECT` ระดับ top-level เท่านั้น** ไม่ใช้กับ DDL ค่านี้จึงจำกัดได้แค่ query ของ checksum/preflight ไม่ใช่ตัว `ALTER` เอง

12. **ไม่มีตัวเลือกรัน ALTER แบบขนาน** — step รันแบบ sequential โดยโครงสร้าง (ลูป `for` เดียวบน connection เดียว) และ **จงใจไม่มี knob ให้ปรับ** เพราะการ rebuild ตารางใหญ่สองตารางพร้อมกันเป็นวิธีที่ทำให้เซิร์ฟเวอร์ล่มได้ตรงที่สุด ถ้าต้องการขนานจริงให้แยกรันหลาย instance ของแอปต่อ shard เอง

13. ~~`--column-statistics=0` ไม่รองรับบน MariaDB~~ — **แก้แล้ว**: `dumpTable()` ตรวจ MariaDB จาก `serverInfo.version`/`versionComment` แล้วตัด `--column-statistics=0` และ `--set-gtid-purged=OFF` (ทั้งคู่เป็น flag ของ MySQL เท่านั้น) ออกอัตโนมัติ

14. **การเปรียบเทียบ checksum ก่อน/หลัง ทำในช่วงที่มี write เข้ามาไม่ได้** — `checksum_before` และ `checksum_after` ถูกอ่านคนละเวลา ถ้าแอปพลิเคชันยัง write อยู่ digest จะต่างกันแม้การแปลงถูกต้องสมบูรณ์ และ job จะ **auto-rollback โดยไม่จำเป็น** ต้องรันในช่วงที่ปิด write เท่านั้น

15. **`otherObjects` ในหน้าภาพรวมอาจเป็น `null`** — การนับ views/routines/triggers/events ต้องมีสิทธิ์ `SHOW VIEW` / `EVENT` ถ้า user ไม่มี query ชุดนี้จะถูก catch แล้วคืน `null` ทุกช่อง (พร้อม `error` message) และ dashboard แสดง `—` แทนที่จะพัง — **`—` ไม่ได้แปลว่า "ไม่มี object ที่ต้องจัดการ"** ต้องไปตรวจด้วยมือ (ดู `RUNBOOK.md` Phase 0.5)

16. ไม่มี lint config, ไม่มี CI, ไม่มี Dockerfile ในโปรเจกต์นี้ (มี self-test — ดู "การตรวจสอบตัวเอง")

---

## โครงสร้างโปรเจกต์

```text
mysql-charset-migrator/
├── package.json               deps: express ^4.21.2, mysql2 ^3.11.5 · scripts: start, dev · engines: node >=20
├── config.js                  ค่าคอนฟิกทั้งหมด (host/port, target charset, session, pool, runner, paths)
├── .gitignore                 กัน node_modules/, data/, *.log, .env ออกจาก git
├── README.md                  ไฟล์นี้
├── RUNBOOK.md                 ขั้นตอนปฏิบัติการทีละข้อสำหรับรัน migration จริง
│
├── server/
│   ├── index.js               Express bootstrap: mount middleware, serve shell + assets, พิมพ์ boot URL, graceful shutdown
│   ├── security.js            CSP + security headers, hostGuard (Host/Origin), apiGuard/shellGuard (boot key), rateLimiter
│   ├── session.js             AES-256-GCM credential vault, per-session mysql2 pool, probe() เก็บข้อมูลเซิร์ฟเวอร์, idle sweeper
│   └── routes/
│       └── api.js             REST API ทั้งหมด + preflight gate (412) + error handler
│   └── lib/
│       ├── ident.js           quote/validate identifier (backtick escaping), whitelist ชื่อ charset, escape string literal
│       ├── logger.js          NDJSON audit log แบบ append-only + redact() + secret registry + อ่าน/เขียน JSON ใต้ data/
│       ├── limits.js          scan governor: บังคับเพดานแถว/ขนาด, statement timeout (ตั้งและล้าง), ตรวจว่าสแกนครบไหม
│       ├── queries.js         ทุก read ต่อ information_schema (schemas, inventory, summary, facets, tablesForPlan, tableList)
│       ├── sqlgen.js          สร้าง plan/DDL/inverse DDL, tableRisks, BYTES_PER_CHAR, indexByteLimit, renderScript, pt-osc/gh-ost
│       ├── preflight.js       3 การตรวจระดับข้อมูล (lossy / unique collision / double-encoding) + rowSource ที่มีเพดานเสมอ + gate
│       ├── checksum.js        digest ที่ normalize เป็น utf8mb4 + รวมผลแบบ order-independent + pickStrategy (full/pk_head/rowcount)
│       ├── tasks.js           registry งาน read-only ที่รันนาน (preflight/checksum) พร้อม progress + cancel + persist ผล
│       └── jobs.js            execution engine: step lifecycle, throttle, backup, checksum verify, auto/manual rollback, persist
│
├── public/
│   ├── index.html             SPA shell: sidebar 6 เมนู, topbar, container ของ view (โหลด app.js เป็น ES module)
│   ├── css/app.css            สไตล์ทั้งหมด (ไม่มี framework ไม่มี build step)
│   └── js/
│       ├── app.js             hash router (รองรับ `#table/<schema>.<table>`), refreshChrome(), boot sequence
│       ├── api.js             transport: แนบ X-App-Key/X-Session-Id, จัดการ 401 session-lost, blob download
│       ├── store.js           ความคืบหน้า 5 ขั้น **ต่อตาราง** (persist ลง sessionStorage) + tableBody() ที่ส่งได้ทีละตารางเท่านั้น
│       ├── util.js            DOM helper, escape, format, toast, modal, donut/bar, chipField (ตัวกรองแบบกด × ลบได้), collapse
│       └── views/
│           ├── connect.js     ฟอร์มเชื่อมต่อ + แสดงผล probe() + ปุ่มตัดการเชื่อมต่อ
│           ├── overview.js    dashboard สัดส่วนแบบย่อ + CTA ไป work list
│           ├── tables.js      work list 1 แถวต่อตาราง + ตัวกรอง chip + จุดความคืบหน้า 5 จุด
│           ├── table.js       หน้าทำงานต่อตาราง — 5 ขั้นที่ปลดล็อกตามลำดับ (preflight → baseline → plan → run → verify)
│           ├── inventory.js   ตาราง column + ฟิลเตอร์ chip/เรียง/แบ่งหน้า + CSV export (หน้าอ้างอิง)
│           ├── jobs.js        ติดตาม job ที่รัน, ความคืบหน้า/throttle, pause/cancel, rollback
│           └── logs.js        ดู audit trail รายวัน + event log ของ job
│
└── data/                      สร้างอัตโนมัติตอนสตาร์ท (mode 0600) · อยู่ใน .gitignore
    ├── audit/                 audit-YYYY-MM-DD.ndjson
    ├── jobs/                  <jobId>.json, <jobId>.ndjson, <jobId>-backup/
    ├── snapshots/             ผล preflight และ checksum snapshot
    └── plans/                 แผนที่สร้างไว้ + tableMeta
```

---

## Configuration

env var ทั้งหมดที่ `config.js` และ `security.js` อ่าน:

| Env var | ค่า default | ผลกระทบ |
|---|---|---|
| `CSMIG_HOST` | `127.0.0.1` | interface ที่ bind — ค่าอื่นที่ไม่ใช่ loopback จะมีคำเตือนออก stderr และเปิดให้เครื่องอื่นเข้าถึงได้ |
| `CSMIG_PORT` | `7343` | พอร์ต HTTP |
| `CSMIG_TARGET_CHARSET` | `utf8mb3` | charset เป้าหมายเริ่มต้น (override ต่อ request ได้ด้วย `targetCharset` ใน body/query) |
| `CSMIG_TARGET_COLLATION` | `utf8mb3_general_ci` | collation เป้าหมายเริ่มต้น (override ด้วย `targetCollation`) |
| `CSMIG_IDLE_TIMEOUT_MS` | `1800000` (30 นาที) | ไม่มี request เข้ามาเกินนี้ → session ถูกทำลาย, pool ปิด, vault ถูก wipe |
| `CSMIG_POOL_LIMIT` | `4` | `connectionLimit` ของ mysql2 pool ต่อ session |
| `CSMIG_MAX_THREADS_RUNNING` | `40` | เพดาน `Threads_running` ที่ยอมให้เริ่ม rebuild — สูงกว่านี้ job จะรอ |
| `CSMIG_MAX_REPLICA_LAG` | `30` | เพดาน replica lag (วินาที) ที่ยอมให้เริ่ม rebuild |
| `CSMIG_STMT_TIMEOUT` | `0` (ไม่จำกัด) | timeout ของ connection ที่ **รัน job** > 0 → `SET SESSION max_execution_time = <ค่า × 1000>` **หมายเหตุ: MySQL ใช้กับ `SELECT` เท่านั้น ไม่จำกัดเวลา `ALTER`** · การสแกนอ่านอย่างเดียวใช้ `CSMIG_SCAN_TIMEOUT` แยกต่างหาก |
| `CSMIG_SCAN_ROWS` | `200000` | เพดานแถวเริ่มต้นของ preflight เมื่อผู้เรียกไม่ระบุ — **ไม่มีทางกลายเป็น unlimited โดยบังเอิญ** |
| `CSMIG_SCAN_MAX_BYTES` | `5368709120` (5 GB) | ขนาดที่เกินแล้วจะข้ามตาราง **เฉพาะการสแกนแบบไม่จำกัดแถว** |
| `CSMIG_SCAN_TIMEOUT` | `60` | วินาที → `max_execution_time` (MySQL) + `max_statement_time` (MariaDB) บน connection ที่ใช้สแกน · ถูกล้างก่อนคืน connection เข้า pool |
| `CSMIG_CHECKSUM_ROWS` | `200000` | จำนวนแถวของ strategy `pk_head` |
| `CSMIG_CHECKSUM_FULL_MAX_BYTES` | `2147483648` (2 GB) | ใหญ่กว่านี้ `auto` จะเลิกอ่านทั้งตาราง |
| `CSMIG_EXACT_COUNT_MAX_BYTES` | `2147483648` (2 GB) | ใหญ่กว่านี้ข้าม `COUNT(*)` ใช้ค่าประมาณแทน |
| `CSMIG_ALLOW_BULK` | ไม่ตั้ง (= บังคับทีละตาราง) | `=1` ปิดการบังคับ 1 ตารางต่อ 1 operation — **ไม่แนะนำ** |
| `CSMIG_BOOT_KEY` | สุ่มใหม่ทุก start (18 bytes base64url) | ตั้ง boot key คงที่ (ใช้เฉพาะเมื่อจำเป็น เช่น automation — ค่าคงที่ลดความปลอดภัยของชั้นที่ 2) |

ค่าที่ **hardcoded ใน `config.js`** ไม่มี env var (แก้ไฟล์เท่านั้น):

| Key | ค่า | หมายเหตุ |
|---|---|---|
| `systemSchemas` | `['information_schema','performance_schema','mysql','sys']` | ไม่ถูก inventory และไม่ถูกแปลงเลย |
| `session.maxSessions` | `4` | เกินกว่านี้ `/api/connect` ตอบ 429 |
| `pool.connectTimeoutMs` | `15000` | timeout ตอนเปิด connection |
| _(ไม่มี knob ปรับ concurrency)_ | — | step รัน sequential โดยโครงสร้าง — จงใจไม่ให้ปรับ |
| `runner.lockWaitTimeoutSec` | `30` | ใช้ตั้ง `lock_wait_timeout` + `innodb_lock_wait_timeout` ต่อ session ที่รัน job |
| `runner.throttleWaitMs` | `2000` | เวลารอต่อรอบเมื่อเซิร์ฟเวอร์โหลดสูง |
| `runner.throttleMaxWaits` | `150` | จำนวนรอบสูงสุด (150 × 2 วินาที ≈ 5 นาที) เกินกว่านี้ step ล้มเหลว |
| `paths.*` | `data/`, `data/audit/`, `data/jobs/`, `data/snapshots/`, `data/plans/` | สร้างอัตโนมัติตอน `require` logger |

ค่า `runner` ยัง override ได้ต่อ job ด้วย field `runner` ใน body ของ `POST /api/jobs` (merge ทับ `config.runner`)

---

## การตรวจสอบตัวเอง

โปรเจกต์มีสคริปต์ตรวจสอบสองตัวที่รันได้ **โดยไม่ต้องมีฐานข้อมูล** ให้รันก่อนใช้งานจริงทุกครั้ง (และหลังแก้โค้ดทุกครั้ง)

```bash
npm run selftest    # = node scripts/selftest.js
npm run check       # = node scripts/check-imports.js && node scripts/selftest.js
```

### `npm run selftest` — `scripts/selftest.js`

38 unit test แบบ offline ครอบ logic ที่เป็น pure function ทั้งหมด:

| กลุ่มที่ทดสอบ | ตรวจอะไร |
|---|---|
| plan / rollback inversion | `rollbackSql` ที่สร้างขึ้นย้อน `sql` ได้จริง ทั้ง `convert_table`, `column_modify`, `schema_default`, `table_default` และเคส `mixed_charsets` |
| risk codes ทั้ง 8 | แต่ละเงื่อนไขใน `tableRisks()` ออก code และ level ที่ถูกต้อง |
| index byte limits | `indexByteLimit()` คืน 767 / 3072 / 1000 ตาม engine และ `ROW_FORMAT` และการคำนวณความยาว index ถูกต้อง |
| MariaDB default quoting | `defaultClause()` แยกกรณี MySQL 8 (`DEFAULT_GENERATED` expression) ออกจาก MariaDB (ค่า pre-quoted) ได้ |
| checksum expression | `columnExpr()` / `rowExpr()` ประกอบ SQL ที่ normalize เป็น utf8mb4 ถูกต้องต่อชนิดข้อมูล และ generated column ถูกตัดออกจริง |
| preflight predicates | predicate ของ `lossy_conversion` / `doubleEncodedCondition` ตรงตามที่ออกแบบ |
| log redaction | secret ที่ register ถูกแทนด้วย fingerprint ทุกที่, key ที่หน้าตาเหมือน credential ถูกทิ้งโดยไม่ดูค่า, DSN password และ `IDENTIFIED BY` literal ถูกล้าง, `Error` ถูก flatten โดยยังเก็บ `sqlState` |

### `npm run check` — เพิ่ม static link-check

`scripts/check-imports.js` ตรวจว่า **ทุก named import ใน `public/js/**` ถูก export จริงจากไฟล์ต้นทาง** — จับ typo และ export ที่ถูกลบทิ้งได้ก่อน runtime (UI ไม่มี build step จึงไม่มี bundler ช่วยจับให้) แล้วจึงรัน self-test ต่อ

### สิ่งที่สคริปต์เหล่านี้ **ไม่** ครอบ

**ไม่มี end-to-end test เทียบกับ MySQL จริง** — ทุกอย่างที่ต้องต่อฐานข้อมูล (การรัน `ALTER` จริง, backup, throttle, rollback, การอ่าน `information_schema` ของแต่ละเวอร์ชัน/vendor) ไม่ได้ถูกทดสอบอัตโนมัติเลย
**การรันจริงครั้งแรกจึงต้องเป็น staging หรือสำเนาของ production เท่านั้น** อย่าใช้ production เป็นการซ้อมครั้งแรก (ดู `RUNBOOK.md` Phase 0.6)
