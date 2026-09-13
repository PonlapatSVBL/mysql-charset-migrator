# RUNBOOK — ขั้นตอนปฏิบัติการ migration CHARACTER SET / COLLATION

**เป้าหมาย:** `utf8mb3` / `utf8mb3_general_ci`
**เครื่องมือ:** MySQL Charset Migrator (ดู `README.md` สำหรับสถาปัตยกรรมและข้อจำกัด)

> ### ⚠️ อ่านก่อนเริ่มทุกครั้ง
> `utf8mb4` → `utf8mb3` เป็นการแปลงแบบ **narrowing** อักขระ 4 ไบต์ (emoji, CJK Extension, สัญลักษณ์ดนตรี) จะถูกแทนด้วย `?` **อย่างถาวร** และ `ALTER ... CONVERT TO utf8mb4` ย้อนกลับ **ไม่คืนอักขระเดิม**
> **มีเพียง backup เท่านั้นที่กู้ได้** — ถ้าคุณข้าม backup คุณกำลังตัดสินใจว่ายอมสูญเสียข้อมูลถ้าอะไรผิดพลาด
> `utf8mb3` ยังเป็น **deprecated ตั้งแต่ MySQL 8.0.29** — ยืนยันกับ stakeholder ว่านี่เป็นการย้ายเพื่อ compatibility ระยะสั้นที่จำเป็นจริง ไม่ใช่การเดินถอยหลังโดยไม่ได้ตั้งใจ

**ก่อนอื่น** — รันชุดตรวจสอบตัวเองให้ผ่านก่อนทุกครั้ง (ไม่ต้องมี DB):

```bash
npm run check     # static import check + 38 self-tests → ต้องได้ "38 passed, 0 failed"
```

ชุดนี้ครอบเฉพาะ pure logic แบบ offline — **ไม่มี end-to-end test เทียบ MySQL จริง** การรันจริงครั้งแรกต้องเป็น staging หรือสำเนาของ production (Phase 0.6)

---

## บทบาทและการแบ่งงาน (อ่านก่อน Phase 0)

งานนี้ **แบ่งตาม "คนละ phase" ไม่ได้** — Phase 4 (baseline) ถึง Phase 7 (verify) ต้องเป็นหน้าต่างเดียวที่ไม่มี write เข้าตารางในขอบเขตเลย และ session ของเครื่องมือผูกกับโปรเซสเดียว จึงแบ่งตาม **บทบาท** โดยมีคนจับคอนโซลคนเดียวตลอดงาน

### ข้อจำกัดที่บังคับวิธีแบ่ง (มาจากพฤติกรรมจริงของเครื่องมือ ไม่ใช่ความชอบ)

| ข้อจำกัด | ผลต่อการแบ่งงาน |
|---|---|
| boot key ถูกสร้างใหม่ทุกครั้งที่ start และ session/รหัสผ่านอยู่ในหน่วยความจำเท่านั้น | สลับคนจับคอนโซลกลางงาน = restart = job หายจากหน่วยความจำ (Abort criteria ข้อ 21) → **operator ต้องเป็นคนเดียวตั้งแต่ Phase 1 ถึง Phase 8** |
| `dumpTable()` ดึงรหัสผ่านจาก session | session หมดอายุ = backup ของ step ถัดไปล้ม (ข้อ 20) → operator ต้องนั่งเฝ้าจนจบ window |
| checksum ก่อน/หลังเทียบกันตรงๆ | ใครก็ตามที่เขียน DB ในขอบเขตระหว่าง Phase 4–7 จะทำให้ auto-rollback ทำงานโดยไม่จำเป็น (ข้อ 6, 19) → **ทุกบทบาทที่ไม่ใช่ operator ห้ามแตะ DB ช่วงนั้น** |
| `forceDespiteBlock` / `acknowledgeNoPreflight` ถูกบันทึกถาวรใน job manifest + audit | เป็นการยอมสูญเสียข้อมูลอย่างจงใจ → **ห้าม operator อนุมัติตัวเอง** |

### สามบทบาท

| บทบาท | หน้าที่หลัก | ห้ามทำ |
|---|---|---|
| **Operator** — ผู้ปฏิบัติงานหน้าคอนโซล | รันเครื่องมือ, สร้าง preflight / baseline / plan / job, เฝ้า job, สั่ง rollback | อนุมัติแผนของตัวเอง · ตัดสินขนาด window เอง |
| **Verifier** — ผู้ตรวจทาน (คู่ตรวจ) | ตรวจสิทธิ์และเนื้อที่ก่อนเริ่ม, ตีความ preflight finding, **อ่านทาน DDL ทุกบรรทัดในแผน**, ยืนยันผลหลังแปลง, ถือ abort criteria | กดปุ่มบนคอนโซล · แก้ข้อมูลใน scope ระหว่าง Phase 4–7 |
| **Perf owner** — เจ้าของเกณฑ์ performance | replica topology, ค่า throttle, ขนาด maintenance window, ตัดสินว่าตารางไหนใหญ่เกินจนต้องไปเส้น pt-osc / gh-ost | สั่งงานคอนโซลโดยตรง |

**ผู้รับผิดชอบรอบนี้** (เติมก่อนเริ่มทุกครั้ง):

| บทบาท | ชื่อ | ช่องทางติดต่อระหว่าง window |
|---|---|---|
| Operator | | |
| Verifier | | |
| Perf owner | | |

### ความรับผิดชอบต่อ phase

| Phase | Operator | Verifier | Perf owner |
|---|---|---|---|
| 0.1 สิทธิ์ DB user | — | **ทำ** | — |
| 0.2 เนื้อที่ดิสก์ | — | **ทำ** | ตรวจ |
| 0.3 replica topology | — | — | **ทำ** |
| 0.4 maintenance window | ให้ข้อมูลเวลาจากการซ้อม | ตรวจ | **ทำ / ตัดสิน** |
| 0.5 dump นิยาม view / routine / trigger / event | — | **ทำ** | — |
| 0.6 ซ้อมบน staging | **ทำ** (รันเหมือนจริงคนเดียว) | ตรวจผล | รับเวลาต่อ GB ไปคำนวณ window |
| 1 เชื่อมต่อ + อ่านภาพรวม | **ทำ** | ตรวจ chip เตือน (`read_only` / `replica` / ไม่พบ `ALTER`) | ตรวจ `pendingBytes` |
| 2 ลำดับตาราง | **ทำ** | ตรวจ | เสนอลำดับตามความเสี่ยงต่อโหลด |
| 3.1 รัน preflight | **ทำ** | — | — |
| 3.2 ตีความ finding | ร่วม | **ทำ / ตัดสิน** | — |
| 3.3 เกณฑ์ไปต่อ | — | **ตัดสิน** | — |
| 4 baseline checksum | **ทำ** | บันทึก `checksumId` | — |
| 5.1 สร้างแผน | **ทำ** | — | — |
| 5.2 อ่านทานแผน | ร่วม | **ทำ / ตัดสิน** | ตรวจเฉพาะตารางใหญ่ |
| 5.3 เลือก backup strategy | เสนอ | ตรวจ | **ตัดสิน** (ขึ้นกับเนื้อที่และเวลา) |
| 6.1 dry run | **ทำ** | ตรวจ DDL ที่ออกมา | — |
| 6.2 รันจริง | **ทำ คนเดียว** | เฝ้าจอ (ไม่สั่ง) | เฝ้า metric ฝั่ง DB |
| 6.3 เส้น pt-osc / gh-ost | รับคำสั่งไปรัน | ตรวจ | **ตัดสิน** |
| 7 ยืนยันผล | รัน query ที่ verifier สั่ง | **ทำ / ตัดสิน** | ตรวจ replica lag กลับสู่ปกติ |
| 8 rollback | **ทำ** | ยืนยันว่าครบ | — |
| 9.1 สร้าง object กลับ | ร่วม | **ทำ** (แบ่งตาม schema ได้) | — |
| 9.2–9.4 cleanup + default | **ทำ** | ตรวจ | ตรวจ config ฝั่ง server |
| 9.5 ปิดงาน | รวบรวมหลักฐาน | **ตรวจครบ** | รับเวลาจริงต่อ GB |

### Gate ที่ต้องมีสองคนเห็นชอบ (operator คนเดียวไม่พอ)

1. ผ่าน Phase 3.3 เมื่อ `gate` เป็น `warn` — operator + verifier
2. ใช้ `forceDespiteBlock` หรือ `acknowledgeNoPreflight` — operator + verifier + perf owner **และบันทึกเหตุผลเป็นลายลักษณ์อักษร**
3. เลือก `backupStrategy: none` บน production — ห้าม เว้นแต่มี snapshot ระดับ instance ที่ทดสอบ restore แล้ว (perf owner ยืนยัน)
4. เริ่ม Phase 6.2 — ต้องมี `preflightId` + `checksumId` + `planId` ครบ และ verifier ยืนยันว่า write หยุดแล้วจริง
5. สั่งรันต่อหลังเจอ checksum ไม่ตรง — **ห้ามทุกกรณีจนกว่าจะรู้สาเหตุ** (Abort ข้อ 13)

### งานที่ขนานกันได้ — เฉพาะก่อนเปิด window

- Phase 0.1–0.5 ทำพร้อมกันได้ทั้งสามคน (verifier ฝั่งสิทธิ์/เนื้อที่/object, perf owner ฝั่ง replica)
- Phase 0.6 ซ้อม staging — operator รันคนเดียว แต่ส่งเวลาต่อตารางให้ perf owner ทันทีที่ได้
- Phase 9.1 สร้าง view / routine / trigger / event กลับ — แบ่งตาม schema ได้ **หลัง** verify ผ่านแล้วเท่านั้น

### งานที่ห้ามแบ่ง

- **Phase 6.2 รันจริง** — คนอื่นดูจอได้ สั่งไม่ได้ และห้ามเปิด session ที่สองไปแตะ DB เด็ดขาด
- **Phase 4 ถึง 7** — ห้ามมี write ใดๆ เข้าตารางในขอบเขต รวมถึง query แก้ข้อมูลที่ verifier "แค่อยากลอง"

### ของที่ใช้ส่งต่อกัน (อย่าส่งงานกันด้วยปากเปล่า)

| ไฟล์ | ใครสร้าง | ใครอ่าน |
|---|---|---|
| `data/hosts/<host>_<port>/snapshots/preflight-*.json` | operator | verifier — ตีความ finding (3.2) |
| `data/hosts/<host>_<port>/snapshots/checksum-*.json` | operator | verifier — เทียบ baseline (7.2) |
| `data/hosts/<host>_<port>/plans/plan-*.json` | operator | verifier — อ่านทาน DDL (5.2), perf owner — ตารางใหญ่ (6.3) |
| `data/hosts/<host>_<port>/jobs/job-*.json` + `.ndjson` | เครื่องมือ | ทุกคน — สภาพจริงถ้าแอป restart (Abort ข้อ 21) |
| `data/hosts/<host>_<port>/audit/audit-*.ndjson` | เครื่องมือ | verifier — หลักฐานปิดงาน (9.5) |

อ้าง `preflightId` / `checksumId` / `planId` / `jobId` ในทุกการสื่อสารระหว่าง window

### สิทธิ์สั่ง abort

**ทุกบทบาทสั่งหยุดได้ ไม่ต้องขออนุมัติ** เมื่อเจอข้อใดข้อหนึ่งใน Abort criteria ท้ายเอกสารนี้
การกลับมารันต่อหลัง abort ต้องผ่าน Phase 3 ใหม่ทั้งชุด ไม่ใช่รันต่อจากจุดเดิม

---
## Phase 0 — Pre-checks (ก่อนแตะอะไรเลย)

### 0.1 ตรวจสิทธิ์ของ DB user

```sql
-- รันด้วย user ที่จะใช้กับเครื่องมือนี้
SHOW GRANTS FOR CURRENT_USER();
```

สิทธิ์ที่ **ต้องมี**:

| สิทธิ์ | ใช้ทำอะไร |
|---|---|
| `SELECT` (ทุก schema ในขอบเขต) | inventory, preflight, checksum |
| `ALTER` | `ALTER TABLE ... CONVERT TO` / `MODIFY COLUMN` |
| `ALTER` บน `*.*` หรือ schema-level | `ALTER DATABASE` (step `schema_default`) |
| `CREATE`, `INSERT`, `DROP` | จำเป็นถ้าใช้ `backupStrategy: table_copy` (`CREATE TABLE LIKE` + `INSERT SELECT` + `RENAME`) |
| `INDEX` | rebuild index ตอน `ALTER` |
| `LOCK TABLES`, `RELOAD` | จำเป็นสำหรับ `mysqldump` บางโหมด |
| `PROCESS` | อ่าน `Threads_running` — **ถ้าไม่มี throttle จะไม่ทำงานและจะไม่แจ้งเตือน** (ถือเป็น 0) |
| `REPLICATION CLIENT` | อ่าน `SHOW REPLICA STATUS` — ถ้าไม่มี การ throttle ตาม replica lag จะเงียบไป |

การ์ดข้าง sidebar ของ UI จะขึ้น chip แดง `ไม่พบสิทธิ์ ALTER` ถ้า `SHOW GRANTS` ไม่มี `ALTER` หรือ `ALL PRIVILEGES`

**ตรวจว่า instance ไม่ได้อยู่ read-only:**

```sql
SELECT @@read_only, @@super_read_only, @@innodb_read_only;
```

ถ้า `@@read_only = 1` เครื่องมือจะตอบ **HTTP 409** และปฏิเสธการรัน job ที่ไม่ใช่ dry-run

### 0.2 ตรวจเนื้อที่ดิสก์สำหรับ rebuild

`ALTER TABLE ... CONVERT TO CHARACTER SET` เป็น `ALGORITHM=COPY` — MySQL **สร้างตารางใหม่ทั้งใบข้างๆ** แล้วสลับ ดังนั้นต้องมีเนื้อที่ว่าง **อย่างน้อยเท่ากับตารางที่ใหญ่ที่สุดในขอบเขต** (ไม่ใช่ผลรวม) บวกพื้นที่ binlog/undo ที่โตขึ้น

```sql
-- ขนาดของตารางที่ใหญ่ที่สุดที่ยังไม่ตรงเป้าหมาย
SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE, TABLE_COLLATION,
       ROUND((DATA_LENGTH + INDEX_LENGTH)/1024/1024/1024, 2) AS gb
  FROM information_schema.TABLES
 WHERE TABLE_TYPE = 'BASE TABLE'
   AND TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
   AND TABLE_COLLATION <> 'utf8mb3_general_ci'
 ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
 LIMIT 20;

-- ผลรวมที่ต้อง rebuild (เท่ากับ pendingBytes ที่หน้าภาพรวมแสดง)
SELECT ROUND(SUM(DATA_LENGTH + INDEX_LENGTH)/1024/1024/1024, 2) AS total_gb
  FROM information_schema.TABLES
 WHERE TABLE_TYPE = 'BASE TABLE'
   AND TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
   AND TABLE_COLLATION <> 'utf8mb3_general_ci';
```

**ถ้าจะใช้ `backupStrategy: table_copy` ต้องบวกเนื้อที่เพิ่มอีกเท่าตารางที่ใหญ่ที่สุดด้วย** (shadow table อยู่ใน DB เดียวกัน)
ถ้าใช้ `mysqldump` เนื้อที่ไปกินที่ filesystem ของเครื่องที่รันแอปนี้ (`data/hosts/<host>_<port>/jobs/<jobId>-backup/`) ไม่ใช่ที่ DB server

```bash
# เนื้อที่ว่างของ datadir บน DB server
df -h "$(mysql -N -e 'SELECT @@datadir')"
# เนื้อที่ว่างของเครื่องที่รันแอป (ที่เก็บ mysqldump)
df -h .
```

### 0.3 ตรวจ replica topology

```sql
-- บน primary
SHOW REPLICAS;              -- MySQL 8.0.22+  (เดิม: SHOW SLAVE HOSTS)
SELECT @@log_bin, @@binlog_format, @@gtid_mode;

-- บนแต่ละ replica
SHOW REPLICA STATUS\G       -- ดู Seconds_Behind_Source, Replica_SQL_Running, Last_Error
```

ประเด็นที่ต้องตัดสินใจ:

- **`ALTER` จะไหลไป replica ทาง binlog** และ replica จะ rebuild ตารางเดียวกันด้วยตัวเอง → **lag จะพุ่งขึ้นเท่าเวลาที่ใช้ rebuild** เพราะ replica apply แบบ single-threaded ต่อ schema (ถ้าไม่ได้ตั้ง parallel replication)
- ให้ตั้ง `CSMIG_MAX_REPLICA_LAG` ให้ต่ำพอที่ระบบยอมรับได้ (default 30 วินาที) แอปจะรอก่อนเริ่มแต่ละตาราง แต่ **ไม่ได้รอระหว่างที่ `ALTER` กำลังรัน** — lag ที่เกิดขึ้นระหว่างนั้นควบคุมไม่ได้
- ถ้าไม่ต้องการส่ง `ALTER` ผ่าน binlog (เช่นจะไปรันบน replica แยกกันเอง) ใช้ตัวเลือก `skipBinlog` ในหน้า Plan ซึ่งจะเพิ่ม `SET SESSION sql_log_bin = 0` **ต้องระวังมาก — จะทำให้ schema ระหว่าง primary/replica ต่างกัน ต้องไปรันบน replica ด้วยมือทุกตัว**
- **ถ้ารันเครื่องมือนี้ชี้ไปที่ replica โดยตรง** อย่าลืมว่า replica มักตั้ง `read_only` → job จะถูกปฏิเสธด้วย 409

### 0.4 กำหนด maintenance window

ประเด็นสำคัญที่ต้องสื่อสาร:

- ตลอดช่วง `ALTER` แต่ละตาราง: **`SELECT` ผ่าน แต่ `INSERT`/`UPDATE`/`DELETE` จะค้างรอ** จนจบ (metadata lock) — สำหรับแอปพลิเคชันส่วนใหญ่นี่เท่ากับ downtime
- ประมาณเวลาแบบหยาบ: InnoDB rebuild ราว **1–5 นาที ต่อ GB** ขึ้นกับ I/O, จำนวน index, และโหลด — ใช้ `pendingBytes` จากหน้าภาพรวมคูณเข้าไป **แล้วเผื่อ 2 เท่า**
- ถ้าใช้ `backupStrategy: table_copy` ให้ **คูณเวลาสองเท่า** (copy + rebuild)
- ถ้าเวลาที่ได้ยาวกว่า window ที่มี → **ห้ามใช้ job runner ของแอปนี้** ให้ใช้คำสั่ง `pt-online-schema-change` / `gh-ost` ที่แผนสร้างให้ (ดู Phase 6.3)

**สำคัญมาก:** ตั้งแต่ตอนทำ baseline checksum (Phase 3) ไปจนถึงตอน verify (Phase 7) **ต้องไม่มี write เข้าตารางในขอบเขตเลย** — ไม่งั้น checksum ก่อน/หลังจะไม่ตรงกันเองโดยธรรมชาติ และ job จะ **auto-rollback โดยไม่จำเป็น** ให้หยุด application / ตั้ง read-only ที่ชั้นแอป / เพิกถอนสิทธิ์ write ของ app user ชั่วคราวก่อนเริ่ม

### 0.5 สำรอง object ที่แอปนี้ไม่แปลงให้ (views / routines / triggers / events)

แอปนี้ **รายงานแต่ไม่แปลง** object เหล่านี้ (ดู `README.md` → ข้อจำกัดที่ทราบ #1) ต้อง **dump นิยามเก็บไว้ก่อน** เพราะขั้นตอน cleanup ใน Phase 9 จะต้อง drop/recreate

ขั้นนี้ต้องมีสิทธิ์ `SHOW VIEW` และ `EVENT` — ถ้าไม่มี หน้าภาพรวมของแอปจะแสดง `otherObjects` เป็น `—` (query ถูก catch แล้วคืน `null`) และคุณจะ **ไม่เห็นว่ามี object ค้างอยู่** ให้รัน SQL ข้างล่างด้วย user ที่มีสิทธิ์ครบเสมอ:

```bash
# นิยาม routines + triggers + events (ไม่เอาข้อมูล) — เก็บไว้เป็นต้นฉบับ
mysqldump --host=127.0.0.1 --user=root -p \
  --no-data --no-create-info --routines --triggers --events \
  --skip-add-drop-table --databases mydb > pre-migration-objects.sql

# นิยาม view ทั้งหมด (โครงสร้างเท่านั้น)
mysqldump --host=127.0.0.1 --user=root -p --no-data --databases mydb > pre-migration-schema.sql
```

```sql
-- รายการ object ที่ metadata charset ยังไม่ตรงเป้าหมาย (ตรงกับ otherObjects ในหน้าภาพรวม)
SELECT 'VIEW' AS kind, TABLE_SCHEMA AS db, TABLE_NAME AS name,
       CHARACTER_SET_CLIENT, COLLATION_CONNECTION
  FROM information_schema.VIEWS
 WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
   AND (CHARACTER_SET_CLIENT <> 'utf8mb3' OR COLLATION_CONNECTION <> 'utf8mb3_general_ci')
UNION ALL
SELECT 'ROUTINE', ROUTINE_SCHEMA, ROUTINE_NAME, CHARACTER_SET_CLIENT, COLLATION_CONNECTION
  FROM information_schema.ROUTINES
 WHERE ROUTINE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
   AND (CHARACTER_SET_CLIENT <> 'utf8mb3' OR COLLATION_CONNECTION <> 'utf8mb3_general_ci'
        OR DATABASE_COLLATION <> 'utf8mb3_general_ci')
UNION ALL
SELECT 'TRIGGER', TRIGGER_SCHEMA, TRIGGER_NAME, CHARACTER_SET_CLIENT, COLLATION_CONNECTION
  FROM information_schema.TRIGGERS
 WHERE TRIGGER_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
   AND (CHARACTER_SET_CLIENT <> 'utf8mb3' OR COLLATION_CONNECTION <> 'utf8mb3_general_ci')
UNION ALL
SELECT 'EVENT', EVENT_SCHEMA, EVENT_NAME, CHARACTER_SET_CLIENT, COLLATION_CONNECTION
  FROM information_schema.EVENTS
 WHERE EVENT_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
   AND (CHARACTER_SET_CLIENT <> 'utf8mb3' OR COLLATION_CONNECTION <> 'utf8mb3_general_ci');
```

### 0.6 ซ้อมบน staging ก่อนเสมอ

รัน Phase 1–9 ทั้งชุดบนสำเนาของ production ก่อน จับเวลาจริงของแต่ละตาราง แล้วนำเวลานั้นมาคำนวณ window จริง — **ห้ามใช้ production เป็นการซ้อมครั้งแรก**

---

## Phase 1 — เริ่มเครื่องมือและเชื่อมต่อ

1. **สตาร์ทแอป** บนเครื่องของผู้ปฏิบัติงาน (ไม่ใช่บน DB server ถ้าเลี่ยงได้ — แต่ต้องใกล้พอที่ latency ไม่กวน)

   ```bash
   npm install
   npm start
   ```

2. **คัดลอก URL ที่มี boot key** จาก terminal เปิดในเบราว์เซอร์:

   ```text
   http://127.0.0.1:7343/?key=<boot key>
   ```

   ถ้าเปิด `http://127.0.0.1:7343/` เฉยๆ จะได้หน้า 401 "🔒 ต้องใช้ boot key" — นี่คือพฤติกรรมที่ถูกต้อง
   **boot key เปลี่ยนทุกครั้งที่ restart** ถ้า restart กลางงานต้องเปิด URL ใหม่ และ session เดิมหายไป (ต้อง connect ใหม่ + สร้าง job ใหม่)

3. **ปรับ threshold ก่อนสตาร์ท** ถ้าต้องการ (ต้องตั้งเป็น env ก่อน `npm start`):

   ```bash
   CSMIG_MAX_THREADS_RUNNING=20 CSMIG_MAX_REPLICA_LAG=10 CSMIG_IDLE_TIMEOUT_MS=7200000 npm start
   ```

   ตั้ง `CSMIG_IDLE_TIMEOUT_MS` ให้ยาวกว่าความยาว window ที่คาด (default 30 นาที) — **ถ้า session หมดอายุกลาง job ที่กำลัง backup ด้วย mysqldump จะล้มเหลว** เพราะ `dumpTable()` ต้องดึงรหัสผ่านจาก session

4. **หน้า "เชื่อมต่อ"** กรอก host / port / user / password / (database ถ้าต้องการล็อก) / SSL
   ตรวจการ์ดข้าง sidebar หลังเชื่อมต่อ:
   - `server` — เวอร์ชันตรงกับที่คาดหรือไม่ (MariaDB vs MySQL มีผลต่อการประกอบ `DEFAULT` clause ใน strategy `modify_columns`)
   - chip `read_only` — ถ้าขึ้น จะรัน job ไม่ได้
   - chip `replica` — ถ้าขึ้น แปลว่าชี้ไปที่ replica ให้ทบทวนว่าตั้งใจไหม
   - chip `ไม่พบสิทธิ์ ALTER` — ต้องแก้สิทธิ์ก่อน

5. **หน้า "ภาพรวม / สัดส่วน"** อ่านตัวเลขฐาน จดไว้:
   - จำนวนคอลัมน์ / ตารางที่ยังไม่ตรงเป้าหมาย
   - `pendingBytes` (ขนาดข้อมูลที่ต้อง rebuild) → ใช้ประมาณเวลาและเนื้อที่
   - `otherObjects` — views/routines/triggers/events ที่ต้องจัดการเองใน Phase 9
     **ถ้าช่องนี้แสดง `—`** แปลว่า user ไม่มีสิทธิ์ `SHOW VIEW` / `EVENT` แล้ว query ถูก catch ไว้ (คืน `null`) — **ไม่ใช่ว่าไม่มี object ที่ต้องจัดการ** ให้กลับไปรัน SQL ใน Phase 0.5 ด้วย user ที่มีสิทธิ์

---

## Phase 2 — วางลำดับตาราง (ordering)

**เครื่องมือนี้แปลงครั้งละ 1 ตารางเท่านั้น** ไม่มี scope แบบหลายตารางให้เลือกอีกแล้ว
API จะปฏิเสธ (`HTTP 400 one_table_at_a_time`) ถ้าขอบเขตที่ส่งมา resolve ได้เกิน 1 ตาราง
งานของ Phase นี้จึงไม่ใช่การเลือกก้อน แต่คือ **จัดลำดับว่าจะไล่ตารางไหนก่อนหลัง**

ไปที่เมนู **ตาราง — เลือกและแปลง** (`#tables`) ใช้ตัวกรอง (chip กด × ลบได้) และแถบสถานะด้านบน
เพื่อทำรายการตารางที่ต้องทำ แล้วไล่ทีละตัว

**หลักการจัดลำดับ:**

1. **เริ่มจากตารางเล็กที่สุดเสมอ** — work list เรียงจากเล็กไปใหญ่ให้เป็นค่าเริ่มต้น
   ตารางแรกคือการซ้อมกระบวนการ ไม่ใช่การทำงานให้เสร็จ
2. **ตารางที่มี foreign key บนคอลัมน์ข้อความ ต้องแปลงให้ครบทั้ง parent และ child ก่อนเปิดใช้งานจริง** —
   MySQL บังคับให้ charset/collation ของสองฝั่งตรงกัน ถ้าแปลงข้างเดียว FK จะพัง
   หน้า plan จะขึ้น risk `fk_text_columns` พร้อมชื่อ constraint ให้เห็น
   **เพราะทำได้ทีละตาราง ช่วงระหว่างสองตารางจึงมีหน้าต่างที่ FK ยังไม่สอดคล้องกัน** —
   วางคู่ parent/child ให้ติดกันใน maintenance window เดียว และอย่าปิด window จนกว่าจะครบคู่
   หา FK ที่เกี่ยวข้องด้วย:

   ```sql
   SELECT k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME,
          k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
          c.CHARACTER_SET_NAME, c.COLLATION_NAME
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.COLUMNS c
       ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME
      AND c.COLUMN_NAME = k.COLUMN_NAME
    WHERE k.REFERENCED_TABLE_NAME IS NOT NULL
      AND c.CHARACTER_SET_NAME IS NOT NULL
      AND k.TABLE_SCHEMA = 'mydb';
   ```

3. **ตารางใหญ่ (> 5 GB) ไว้ท้ายสุด** — plan จะขึ้น risk `large_table` ให้ ตารางเหล่านี้ควรไปเส้น pt-osc/gh-ost (Phase 6.3)
4. กรองด้วยแถบสถานะ **"ยังต้องแปลง"** (ค่าเริ่มต้น) เพื่อไม่ให้ตารางที่ตรงเป้าหมายแล้วมารบกวนสายตา
5. ใช้หน้า **ค้นหาคอลัมน์** (`#inventory`) + **CSV export** ทำ checklist ของ column ที่จะเปลี่ยนไว้เป็นหลักฐานก่อน-หลัง — ตั้งฟิลเตอร์ `status = non_compliant` + `textOnly` แล้วกด export

**บันทึกไว้:** รายชื่อ `db.table` ทั้งหมดของรอบนี้พร้อมลำดับที่จะทำ
ความคืบหน้าต่อตารางแสดงเป็นจุด 5 จุดใน work list และเก็บใน `sessionStorage` ของเบราว์เซอร์
— **ปิดแท็บแล้วหาย** ให้จดรายการไว้นอกเครื่องมือด้วย

---

## Phase 3 — รัน Preflight และตีความผล

### 3.1 รัน

เปิดตารางจาก work list → **ขั้นที่ 1 "ตรวจข้อมูลก่อนแปลง"** → กด **เริ่มตรวจ**

หน้าจะบอกล่วงหน้าว่าจะตรวจกี่แถวจากทั้งหมดกี่แถว (คิดเป็นกี่ %) ก่อนที่คุณจะกด

**ค่าเริ่มต้นถูกจำกัดไว้เสมอ** — ไม่มีทางที่การกดปุ่มโดยไม่แตะอะไรจะกลายเป็นสแกนไม่จำกัด:

| ตัวเลือก (ใต้ "ตัวเลือกขั้นสูง") | ค่าเริ่มต้น | คำแนะนำ |
|---|---|---|
| จำนวนแถวที่ตรวจ | **200,000 แถวแรก** (เรียงตาม primary key) | ใช้สำรวจ/ตัดสินใจได้ดี แต่ **ไม่ใช่การรับประกันทั้งตาราง** |
| | `50,000` | ตอนไล่ดูเร็วๆ ว่ามีปัญหาแบบไหนบ้าง |
| | `1,000,000` | ก่อนแปลงจริงบนตารางที่สำคัญ |
| | `ทั้งตาราง` | **คำตอบที่แน่นอนที่สุด** — ใช้กับตารางเล็ก หรือเมื่อมี window ยาวพอ |
| ตรวจ UNIQUE index ซ้ำ | เปิด | ปิดเฉพาะเมื่อรู้ว่าไม่มี unique index บนคอลัมน์ข้อความ |
| ตรวจ double-encoding | เปิด | เปิดไว้ |
| ตัวอย่างต่อคอลัมน์ | 5 | เพิ่มได้ถึง 50 |

**เพดานพวกนี้บังคับที่ฝั่ง server** (`server/lib/limits.js`) การเรียก API ตรงโดยไม่ส่ง `rowLimit`
ก็ยังได้ 200,000 ไม่ใช่ไม่จำกัด · จะสแกนทั้งตารางต้องส่ง `fullScan: true` มาโดยเจตนา

**อ่านผลให้ถูก — "ผ่าน" แบบสแกนบางส่วนไม่เท่ากับ "ผ่าน" แบบสแกนครบ**
เมื่อสแกนชนเพดาน ผลจะติดธง `truncated: true` เพิ่ม finding `partial_scan` และ **`gate` จะเป็น `warn` ไม่ใช่ `pass`**
หน้าจอจะเขียนตรงๆ ว่า *"ตรวจ N แถวแรกแล้วไม่พบปัญหา — แถวที่เหลือยังไม่ได้ตรวจ"*
ถ้าจะใช้ผลนี้เป็นใบเบิกทางสำหรับ production ให้สแกนทั้งตาราง

การสแกนเป็น **read-only** ทั้งหมด (`REPEATABLE READ`) และมี **statement timeout 60 วินาที** ต่อคำสั่ง
(`max_execution_time` / `max_statement_time`) กับปุ่ม **ยกเลิก** ที่ใช้ได้จริง — ค้างแล้วหยุดได้
แต่ก็ยังกิน I/O ได้มาก ให้รันในช่วงที่โหลดต่ำ

เมื่อเสร็จ **จด `preflightId`** ไว้ (รูปแบบ `preflight-YYYYMMDDHHMMSS-xxxxxx`) — ต้องใช้เปิด gate ตอนสร้าง job
และผลถูกเก็บถาวรที่ `data/hosts/<host>_<port>/snapshots/<id>.json` — แยกตามเครื่อง จึงเอา baseline ของอีกเครื่องมาเทียบไม่ได้ ถ้าลองจะได้ error ที่บอกชื่อทั้งสองเครื่อง

### 3.2 ตีความ finding และวิธีแก้ทีละกรณี

#### A. `lossy_conversion` → verdict `block` (ระดับ critical)

**หมายความว่า:** มีแถวที่มีอักขระซึ่ง **เก็บใน `utf8mb3` ไม่ได้** ถ้าแปลงตอนนี้จะกลายเป็น `?` และกู้ไม่ได้
ตรวจพบด้วย predicate: `CONVERT(col USING utf8mb4) <> CONVERT(CONVERT(CONVERT(col USING utf8mb4) USING utf8mb3) USING utf8mb4)`

**ต้องทำอย่างไร — ห้าม force ผ่านโดยไม่ทำข้อใดข้อหนึ่งต่อไปนี้:**

1. **ดูตัวอย่างก่อน** — กด "ดูรายละเอียด / ตัวอย่างข้อมูล" ในขั้นที่ 1 จะเห็น primary key ของแถว, ค่าปัจจุบัน, `HEX()` ของไบต์ดิบ และ **`afterValue`** = ค่าที่จะได้หลังแปลง เทียบสองค่าจะเห็นชัดว่าอักขระไหนกลายเป็น `?`

2. **ดึงรายการแถวที่จะเสียหายทั้งหมดออกมาก่อน** (ใช้ SQL ตัวเดียวกับที่ preflight ใช้):

   ```sql
   -- แทน mydb.mytbl / mycol / id ตามจริง
   SELECT id, mycol,
          HEX(mycol) AS raw_hex,
          CONVERT(CONVERT(CONVERT(mycol USING utf8mb4) USING utf8mb3) USING utf8mb4) AS after_convert
     FROM mydb.mytbl
    WHERE mycol IS NOT NULL
      AND (CONVERT(mycol USING utf8mb4) COLLATE utf8mb4_bin)
       <> (CONVERT(CONVERT(CONVERT(mycol USING utf8mb4) USING utf8mb3) USING utf8mb4) COLLATE utf8mb4_bin);
   ```

   **บันทึกผลนี้เก็บไว้เป็นไฟล์** (นี่คือหลักฐานเดียวว่าข้อมูลอะไรจะหาย)

3. **เลือกทางแก้ 1 ใน 4 ทาง:**

   | ทาง | ทำอย่างไร | เมื่อไหร่เหมาะ |
   |---|---|---|
   | **ถอด scope ออก** | เอาตาราง/schema นั้นออกจาก scope ไม่แปลงมัน | คอลัมน์นั้นจำเป็นต้องรองรับ emoji จริง — ทางที่ถูกต้องที่สุดในหลายกรณี |
   | **ล้างอักขระที่เกินขอบเขตทิ้งอย่างจงใจ** | `UPDATE` แทนอักขระ 4 ไบต์ด้วยค่าที่ยอมรับได้ **หลังจากได้อนุมัติจากเจ้าของข้อมูลเป็นลายลักษณ์อักษร** | อักขระเหล่านั้นเป็น noise (emoji ใน comment) และธุรกิจยอมรับได้ |
   | **ย้ายไปคอลัมน์สำรอง** | เพิ่มคอลัมน์ `mycol_utf8mb4 LONGTEXT CHARACTER SET utf8mb4` copy ค่าเดิมเก็บไว้ แล้วค่อยแปลงคอลัมน์หลัก | ต้องเก็บค่าเดิมไว้อ้างอิงแต่ระบบหลักต้องใช้ utf8mb3 |
   | **ยกเลิกการ migration ตารางนั้น** | รายงานกลับไปว่าเป้าหมาย utf8mb3 ใช้กับตารางนี้ไม่ได้ | ข้อมูลจำเป็นและไม่มีใครยอมให้หาย |

   ตัวอย่างการล้างอักขระอย่างจงใจ (**ทำหลัง backup แล้วเท่านั้น** และรันแบบ batch เพื่อไม่ให้ล็อกยาว):

   ```sql
   -- 1) backup คอลัมน์ก่อน
   CREATE TABLE mydb._presanitize_mytbl AS
     SELECT id, mycol FROM mydb.mytbl
      WHERE mycol IS NOT NULL
        AND (CONVERT(mycol USING utf8mb4) COLLATE utf8mb4_bin)
         <> (CONVERT(CONVERT(CONVERT(mycol USING utf8mb4) USING utf8mb3) USING utf8mb4) COLLATE utf8mb4_bin);

   -- 2) แทนค่าด้วยผลลัพธ์ของการแปลง (คือยอมรับ '?' อย่างเปิดเผย ไม่ให้ ALTER ทำเงียบๆ)
   UPDATE mydb.mytbl
      SET mycol = CONVERT(CONVERT(CONVERT(mycol USING utf8mb4) USING utf8mb3) USING utf8mb4)
    WHERE id IN (SELECT id FROM mydb._presanitize_mytbl)
    LIMIT 1000;    -- วนซ้ำจนหมด
   ```

4. **รัน Preflight ใหม่** ต้องได้ `gate: pass` (หรือ `warn`) ก่อนไปต่อ

#### B. `unique_collision` → verdict `block` (ระดับ critical)

**หมายความว่า:** มีค่าที่ตอนนี้ **ต่างกัน** ภายใต้ collation เดิม แต่จะ **เท่ากัน** ภายใต้ `utf8mb3_general_ci` → `ALTER` จะล้มเหลวกลางทางด้วย duplicate-key error (หรือแย่กว่า: `ALTER` สำเร็จบางตารางแล้วค้าง)
สาเหตุที่พบบ่อย: `utf8mb4_bin`/`utf8mb4_0900_as_cs` (case/accent sensitive) → `utf8mb3_general_ci` (case/accent insensitive) ทำให้ `'Foo'` = `'foo'` = `'FOO'` และ `'e'` = `'é'`

**ต้องทำอย่างไร:**

1. **ดึงกลุ่มที่จะซ้ำออกมา** (คือ query เดียวกับที่ preflight รัน — สมมติ index `uk_email` บนคอลัมน์ `email`):

   ```sql
   SELECT CONVERT(email USING utf8mb3) COLLATE utf8mb3_general_ci AS collided_key,
          COUNT(*) AS n,
          GROUP_CONCAT(id ORDER BY id)    AS ids,
          GROUP_CONCAT(email ORDER BY id) AS original_values
     FROM mydb.users
    WHERE email IS NOT NULL
    GROUP BY CONVERT(email USING utf8mb3) COLLATE utf8mb3_general_ci
   HAVING COUNT(*) > 1
    ORDER BY n DESC;
   ```

   สำหรับ **composite unique index** ให้ list ทุกคอลัมน์ใน `GROUP BY` และ **prefix index** ใช้ `LEFT(col, <subPart>)` ห่ออีกชั้น เหมือนที่ `preflight.js` ทำ

2. **แก้ข้อมูลก่อน retry** เลือกอย่างใดอย่างหนึ่งต่อกลุ่ม:

   ```sql
   -- ทาง (ก) รวมระเบียน: ย้าย child rows ไปหา row ที่จะเก็บไว้ แล้วลบตัวซ้ำ
   UPDATE mydb.orders SET user_id = 1001 WHERE user_id = 1002;
   DELETE FROM mydb.users WHERE id = 1002;

   -- ทาง (ข) ทำให้ค่าต่างกันจริงภายใต้ collation ใหม่
   UPDATE mydb.users SET email = CONCAT(email, '.dup2') WHERE id = 1002;

   -- ทาง (ค) ถ้าข้อจำกัด unique ไม่จำเป็นอีกแล้ว — ถอด index ออกก่อนแปลง
   ALTER TABLE mydb.users DROP INDEX uk_email;
   -- ...รัน migration... แล้วค่อยสร้างกลับถ้าต้องการ (จะสร้างกลับไม่ได้ถ้ายังมีค่าซ้ำ)
   ```

   **ทาง (ค) เป็นการเปลี่ยน business constraint** ต้องได้อนุมัติจากเจ้าของระบบ ไม่ใช่การตัดสินใจของ DBA คนเดียว

3. **รัน Preflight ใหม่** จนกว่า `uniqueCollisions = 0`

#### C. `suspect_double_encoding` → verdict `warn`

**หมายความว่า:** พบคอลัมน์ที่ประกาศเป็น charset **1 ไบต์** (`latin1`, `tis620`, `cp1252`, ...) แต่ไบต์ที่เก็บอยู่ **เป็น UTF-8 อยู่แล้ว** (ตรวจจากรูปแบบ lead byte + continuation byte ใน `HEX()`) นี่คืออาการคลาสสิกของแอปที่เขียน UTF-8 ลงคอลัมน์ latin1 ผ่าน connection charset latin1

**อันตรายคือ:** `CONVERT TO CHARACTER SET utf8mb3` จะ **ตีความไบต์เดิมว่าเป็น latin1 แล้วแปลงอีกชั้น** ผลลัพธ์คือ **mojibake** (`สวัสดี` → `à¸ªà¸§à¸±à¸ªà¸”à¸µ`) — ไม่มี byte ไหนหาย แต่ข้อความอ่านไม่ออก และ checksum ก่อน/หลังจะ **ผ่าน** (เพราะไบต์ถูก normalize เป็น utf8mb4 ทั้งสองรอบด้วยการตีความเดียวกัน) → **checksum จับกรณีนี้ไม่ได้ นี่คือเหตุผลที่การตรวจนี้มีอยู่**

**ต้องทำอย่างไร — ห้ามใช้ `CONVERT TO` ตรงๆ กับคอลัมน์เหล่านี้** ใช้ทางแปลงผ่าน `BINARY` แทน (2 ขั้น เพื่อให้ MySQL ไม่ตีความไบต์ซ้ำ):

1. **ยืนยันก่อนว่า double-encoded จริง**:

   ```sql
   SELECT id, mycol,
          HEX(mycol) AS raw_hex,
          CONVERT(CAST(CONVERT(mycol USING latin1) AS BINARY) USING utf8mb4) AS reinterpreted
     FROM mydb.mytbl
    WHERE mycol IS NOT NULL
      AND HEX(mycol) REGEXP '^([0-9A-F]{2})*(C[2-9A-F]|D[0-9A-F]|E[0-9A-F]|F[0-4])(8[0-9A-F]|9[0-9A-F]|A[0-9A-F]|B[0-9A-F])'
    LIMIT 20;
   ```

   ถ้าคอลัมน์ `reinterpreted` **อ่านออกเป็นภาษาไทย/ภาษาอื่นถูกต้อง** → double-encoded ยืนยันแล้ว
   ถ้า `reinterpreted` กลายเป็นขยะ แต่ `mycol` เดิมอ่านออก → **false positive** (ข้อมูล latin1 จริงที่มีตัวอักษร accent ต่อกันโดยบังเอิญ) ให้ผ่านต่อได้ตามปกติ

2. **ถ้ายืนยันแล้ว — แปลงผ่าน BINARY ด้วยมือ ก่อนรัน migration** (ทำตารางเดียวต่อครั้ง หลัง backup):

   ```sql
   -- backup ตารางก่อน (บังคับ)
   CREATE TABLE mydb._preconv_mytbl LIKE mydb.mytbl;
   INSERT INTO mydb._preconv_mytbl SELECT * FROM mydb.mytbl;

   -- ขั้น 1: บอก MySQL ว่า "อย่าตีความ ให้ถือเป็นไบต์ดิบ"
   ALTER TABLE mydb.mytbl
     MODIFY mycol VARBINARY(255);              -- ใช้ BLOB/LONGBLOB สำหรับ TEXT type

   -- ขั้น 2: บอกว่าไบต์ดิบเหล่านั้นคือ utf8mb3 (ไม่มีการแปลงไบต์เกิดขึ้น)
   ALTER TABLE mydb.mytbl
     MODIFY mycol VARCHAR(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci;

   -- ยืนยัน
   SELECT id, mycol FROM mydb.mytbl LIMIT 20;   -- ต้องอ่านออกถูกต้อง
   ```

   **ข้อควรระวังเรื่องความยาว:** ขั้นที่ 1 เปลี่ยนหน่วยจาก "อักขระ" เป็น "ไบต์" — `VARCHAR(255) CHARACTER SET latin1` = 255 ไบต์ พอดี แต่ถ้าไบต์ที่เก็บอยู่เป็น UTF-8 ที่ยาวกว่าอักขระ **ขั้นที่ 2 อาจ truncate** ให้ขยายความยาวไปเลย (เช่น `VARCHAR(255)` → `VARCHAR(255)` ยังพอ แต่ถ้าไม่มั่นใจให้ใช้ `TEXT`) ตรวจก่อนด้วย `SELECT MAX(LENGTH(mycol)), MAX(CHAR_LENGTH(mycol)) FROM mydb.mytbl;`

3. **หลังแก้เสร็จ รัน Preflight ใหม่** — คอลัมน์นั้นควรไม่ปรากฏใน finding อีก (และจะกลายเป็น `compliant` แล้ว จึงหลุดออกจาก scope โดยอัตโนมัติ)

#### D. `scan_failed` / `scan_error` / `verdict: unknown`

การสแกนไม่สำเร็จ (สิทธิ์ไม่พอ, ตาราง corrupt, `maxScanBytes` เกิน, query timeout) → **`gate` ไม่ block แต่ก็ไม่ได้ยืนยันว่าปลอดภัย**
**อย่าถือว่า `unknown` = ปลอดภัย** ต้องหาสาเหตุแล้วสแกนซ้ำ ถ้าสแกนไม่ได้จริง ให้ถอดตารางนั้นออกจาก scope หรือรัน SQL ในข้อ A ด้วยมือบนตารางนั้น

### 3.3 เกณฑ์ไปต่อ

| `gate` | ทำอะไรต่อ |
|---|---|
| `pass` | ✅ ไปต่อ Phase 4 |
| `warn` | ⚠️ อ่าน finding ทุกข้อ ถ้ามี `suspect_double_encoding` ที่ยังไม่แก้ — **หยุด กลับไปข้อ C** ถ้าเป็น false positive ที่ตรวจแล้ว → ไปต่อได้ (แต่บันทึกเหตุผลไว้) |
| `block` | 🛑 **หยุด** แก้ข้อมูลตามข้อ A / B ให้จบก่อน แล้วรัน Preflight ใหม่ — `POST /api/jobs` จะปฏิเสธด้วย **412 `preflight_blocked`** จนกว่าจะแก้ (การใช้ `forceDespiteBlock: true` เป็นการยอมสูญเสียข้อมูลอย่างจงใจ และถูกบันทึกเป็น `options.forced: true` ใน job manifest กับ audit `job.created` ตลอดไป) |
| `unknown` | 🛑 หยุด หาสาเหตุก่อน (ข้อ D) |

---

## Phase 4 — สร้าง baseline checksum snapshot

**ขั้นที่ 2 "เก็บลายนิ้วมือข้อมูล (baseline)"** ในหน้าตาราง → กด **เก็บ baseline**

นี่คือหลักฐานว่าข้อมูล **ไม่เปลี่ยน** หลังแปลง `CHECKSUM TABLE` ใช้ไม่ได้กับงานนี้
เพราะการเปลี่ยน charset เขียนไบต์ใหม่โดยชอบธรรม — ระบบนี้จึงแปลงทุกค่าเป็น utf8mb4 ก่อนแล้วค่อย hash
digest จึงเท่าเดิมเป๊ะเมื่อแปลงถูกต้อง (รายละเอียดใน `README.md`)

### 4.1 ระบบเลือกวิธีให้ตามขนาดตาราง

หน้าจอจะบอกไว้ก่อนกดว่าจะใช้วิธีไหนและเพราะอะไร:

| strategy | เลือกเมื่อ | อ่านอะไร | ความแรงของหลักฐาน |
|---|---|---|---|
| `full` | ตาราง ≤ 2 GB | ทั้งตาราง | เต็ม — ทุกแถวทุกคอลัมน์ |
| `pk_head` | > 2 GB **และ** มี primary key ที่ลำดับไม่เปลี่ยน | `ORDER BY <pk> LIMIT 200000` | สุ่มตรวจ — แถวที่เหลือไม่ได้ตรวจ |
| `rowcount` | > 2 GB และไม่มี PK แบบนั้น | `COUNT(*)` | อ่อน — รู้แค่จำนวนแถว |

**ทำไมต้อง `ORDER BY <pk>`** — `LIMIT` เฉยๆ ไม่รับประกันว่าจะได้แถวชุดเดิมก่อนและหลัง ALTER
ที่ rebuild ตารางใหม่ทั้งก้อน สอง digest จึงเทียบกันไม่ได้ตั้งแต่ต้น การเรียงตาม PK ทำให้เทียบได้จริง

**ทำไม PK ที่เป็น text ถึงใช้ไม่ได้** — เปลี่ยน collation แล้ว **ลำดับเปลี่ยน** แปลว่า "200,000 แถวแรก"
หลังแปลงเป็นคนละชุดกับก่อนแปลง จะรายงาน mismatch หลอกๆ ระบบจึงตกไปเป็น `rowcount` แทนที่จะโกหก

### 4.2 เมื่อไหร่ควรฝืนใช้ `full`

`auto` ให้คำตอบที่ **เร็วพอจะทำจริงได้** สำหรับตารางใหญ่ แต่ไม่ใช่หลักฐานเต็ม
ให้เลือก **"อ่านทั้งตาราง"** ในตัวเลือกขั้นสูงเมื่อ:

- ตารางนั้นเป็น system of record ที่ยอมให้ข้อมูลเสียแม้แถวเดียวไม่ได้
- preflight เจอ `suspect_double_encoding` (แปลว่าเนื้อข้อมูลไม่ได้สม่ำเสมอทั้งตาราง — การสุ่มหัวตารางอาจพลาด)
- มี maintenance window ยาวพอ และวัดเวลาจาก dry run มาแล้ว

ถ้าได้ `rowcount` เพราะไม่มี PK ที่เสถียร ให้ตัดสินใจอย่างใดอย่างหนึ่งก่อนไปต่อ:
เลือก `full`, เพิ่ม surrogate PK แบบตัวเลขให้ตารางก่อน, หรือรับความเสี่ยงไว้อย่างเป็นลายลักษณ์อักษร

### 4.3 บันทึก

- **จด `checksumId`** (`checksum-YYYYMMDDHHMMSS-xxxxxx`) — ผลอยู่ที่ `data/snapshots/<id>.json`
- ขั้นที่ 5 (verify) จะรันใหม่ด้วย **strategy และจำนวนแถวชุดเดียวกัน** โดยอัตโนมัติ
  การเทียบ digest แบบเต็มกับแบบสุ่มถือเป็น mismatch เสมอ ไม่ใช่ "ผ่าน"
- ผลเทียบทุกครั้งจะบอก `strength` (`full` / `sampled` / `rowcount_only`) ติดมาด้วย
  — อย่ารายงาน "ข้อมูลตรงกัน" โดยไม่รายงานว่าตรวจครอบคลุมแค่ไหน

---

## Phase 5 — สร้างและอ่านทานแผน

### 5.1 สร้างแผน

(**ขั้นที่ 3 "สร้างคำสั่ง SQL"** ในหน้าตาราง — แผนจะครอบคลุมตารางนี้ตารางเดียวเสมอ
`ALTER DATABASE` ที่กระทบทั้ง schema เป็น opt-in ใต้ตัวเลือกขั้นสูง ไม่ใช่ค่าเริ่มต้นอีกต่อไป)

หน้า **แผน & รัน** → ตั้งค่า:

| ตัวเลือก | ค่าที่แนะนำ | เหตุผล |
|---|---|---|
| **วิธีแปลง (strategy)** | **`convert_table`** | `CONVERT TO CHARACTER SET` ปล่อยให้ MySQL จัดการนิยามคอลัมน์เอง ไม่ต้องเชื่อ DDL ที่แอปประกอบขึ้น ใช้ `modify_columns` เฉพาะเมื่อต้องคงคอลัมน์ที่ตั้ง charset เฉพาะไว้ **และอ่านทาน DDL ทุกบรรทัดแล้ว** |
| **ลำดับ (order)** | **`size_asc`** (เล็ก → ใหญ่) | ตารางเล็กจบก่อน ได้ข้อมูลจริงเรื่องเวลาและความถูกต้องก่อนจะเสี่ยงกับตารางใหญ่ |
| **ALGORITHM** | **`DEFAULT`** | ปล่อยให้ MySQL เลือก — จะได้ `COPY` เสมอสำหรับ charset conversion ถ้าเลือก `INPLACE` แผนจะขึ้น risk critical `algorithm_impossible` ทุก step (แอปไม่เขียนทับค่าที่เลือกให้ แต่เตือนตอน review) และ `ALTER` จะ error ตอนรันจริง |
| **LOCK** | **`DEFAULT`** | `LOCK=NONE` เป็นไปไม่ได้กับ charset conversion — เลือกไปก็ error |
| `includeSchemaDefaults` | เปิด | เพิ่ม step `schema_default` (`ALTER DATABASE`) — metadata-only ทำงานทันที ไม่ rebuild |
| `includeTableDefaults` | เปิด | เพิ่ม step `table_default` สำหรับตารางที่ข้อมูลตรงแล้วแต่ default ยังเก่า — metadata-only |
| `disableFkChecks` | **ปิด** ถ้าเป็นไปได้ | เปิดเมื่อมี FK บนคอลัมน์ข้อความและต้องแปลงหลายตารางในรอบเดียว จะเพิ่ม `SET SESSION foreign_key_checks = 0` — **ต้องตรวจ integrity ด้วยมือหลังจบ** |
| `skipBinlog` | **ปิด** | เปิดแล้ว schema ระหว่าง primary/replica จะต่างกัน ต้องไปรันบน replica ทุกตัวเอง |
| `backupStrategy` | ดู Phase 5.3 | |

จด **`planId`** (`plan-YYYYMMDDHHMMSS-xxxxxx`) — เก็บที่ `data/plans/<id>.json` พร้อม `tableMeta` ที่ใช้สร้าง

### 5.2 อ่านทานแผน — สิ่งที่ต้องดูทีละข้อ

**ดาวน์โหลด forward script และ rollback script เก็บไว้ก่อน:**

```bash
KEY=<boot key>; SID=<session id>; PLAN=<planId>
BASE=http://127.0.0.1:7343

curl -s "$BASE/api/plan/$PLAN/script?direction=forward" \
  -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" > "$PLAN-forward.sql"
curl -s "$BASE/api/plan/$PLAN/script?direction=rollback" \
  -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" > "$PLAN-rollback.sql"
```

(หรือกดปุ่มดาวน์โหลดในหน้า Plan — จะได้ไฟล์เดียวกัน) **เก็บสองไฟล์นี้ไว้นอกเครื่องที่รันแอป** — ถ้าโปรเซสหาย นี่คือทางกู้ที่เหลืออยู่

**checklist การอ่านทาน:**

1. **จำนวน step ตรงกับที่คาดไหม** — `summary.steps`, `summary.rebuilds`, `summary.metadataOnly` เทียบกับ scope ที่เลือก ถ้ามี step เกินมา แปลว่า scope กว้างกว่าที่คิด
2. **risk `critical` ทุกข้อ** — `lossy_narrowing` ควร**หายไปแล้ว**ถ้าแก้ Preflight ครบ (หรือคงอยู่แต่เข้าใจแล้วว่าเป็นการ narrowing ที่ยอมรับ) `index_too_long` / `row_too_large` ต้องแก้ก่อนรันแน่นอน
3. **risk `unique_collation`** — ต้องมั่นใจว่า Preflight สแกน unique index ครบและได้ `uniqueCollisions = 0`
4. **risk `fk_text_columns`** — ตรวจว่าตารางฝั่ง parent และ child อยู่ใน step ชุดเดียวกันครบ
5. **risk `partitioned`** — ALTER จะ rebuild ทุก partition คูณเวลาไปตามจำนวน partition
6. **risk `fulltext`** — ผลการค้นหาอาจเปลี่ยนตาม collation ใหม่ ต้องแจ้งทีมแอปพลิเคชัน
7. **risk `generated_columns`** — MySQL อาจปฏิเสธการแปลง ต้องเตรียม drop/recreate generated column ด้วยมือ
8. **ถ้าใช้ `modify_columns`: เทียบ DDL กับของจริงทีละบรรทัด**

   ```sql
   SHOW CREATE TABLE mydb.mytbl\G
   ```

   เทียบกับ `MODIFY COLUMN` ใน forward script — ดูเฉพาะจุด: `DEFAULT` (ค่าเดิมยังอยู่ครบ? expression default ถูก wrap ด้วยวงเล็บ?), `AUTO_INCREMENT`, `ON UPDATE CURRENT_TIMESTAMP`, `COMMENT`, generated column (`STORED` vs `VIRTUAL`), `INVISIBLE`
   ถ้ามีจุดใดไม่ตรง **เปลี่ยนไปใช้ `convert_table`**
9. **อ่าน `rollbackSql` ของทุก step** — ตรวจว่ามันจะพา schema กลับไปสภาพเดิมจริง (`convert_table` จะมีคำสั่งเสริม `MODIFY COLUMN` สำหรับคอลัมน์ที่ charset ต่างจาก default ของตาราง — risk `mixed_charsets`)

### 5.3 เลือก backup strategy และเหตุผล

| strategy | เลือกเมื่อ | ข้อดี | ข้อเสีย / เงื่อนไข |
|---|---|---|---|
| **`table_copy`** | **ค่าเริ่มต้นที่แนะนำสำหรับ production** ตารางไม่เกินครึ่งของเนื้อที่ว่าง | rollback เป็น **`RENAME TABLE` แบบ atomic** — เร็วที่สุด ครบที่สุด และ **เป็นทางเดียวที่กู้อักขระที่กลายเป็น `?` ได้ทันที** | ใช้เนื้อที่ใน DB เท่าตารางเดิม · `CREATE TABLE LIKE` + `INSERT SELECT` **ไม่ consistent ถ้ามี write เข้ามาระหว่าง copy** และ **ไม่คัดลอก foreign key** → ต้องรันตอนไม่มี write เท่านั้น · ชื่อ backup ถูกตัดที่ 64 อักขระ |
| **`mysqldump`** | เนื้อที่ใน DB ไม่พอ แต่มีเนื้อที่บน filesystem ของเครื่องที่รันแอป · ต้องเก็บ backup ไว้ยาว | ได้ไฟล์ที่ย้ายออกไปเก็บที่อื่นได้ · ใช้ `--single-transaction` จึง consistent · `--default-character-set=binary` เก็บไบต์ดิบไม่ให้ client แปลง | ช้ากว่ามาก · rollback **ไม่อัตโนมัติ** — ต้อง restore ไฟล์ด้วยมือ · ต้องมี `mysqldump` ใน `PATH` · ใช้กับ MariaDB ได้ (แอปตัด flag เฉพาะ MySQL `--column-statistics=0` / `--set-gtid-purged=OFF` ออกให้อัตโนมัติ) · ต้องมี session ที่ยังไม่หมดอายุ (ต้องดึงรหัสผ่านจาก vault) |
| **`none`** | dry run · staging ที่ทิ้งได้ · ตารางที่มี backup ระดับ instance ครอบอยู่แล้วและตรวจสอบมาแล้วว่า restore ได้ | เร็วที่สุด | **ถ้าอักขระกลายเป็น `?` = สูญหายถาวร กู้ไม่ได้เลย** — inverse DDL คืนได้แค่โครงสร้าง |

**ห้ามใช้ `none` บน production โดยไม่มี snapshot ระดับ instance / storage ที่ทดสอบ restore แล้ว**

ทางเลือกที่แข็งแรงกว่าทั้งสามข้อ: ทำ **snapshot ของ storage / filesystem** ทั้ง instance ก่อนเริ่ม แล้วใช้ `table_copy` เป็นชั้นเร็ว

---

## Phase 6 — Dry run แล้วรันจริง

### 6.1 Dry run (บังคับ)

(**ขั้นที่ 4 "รันคำสั่ง ALTER"** → ปุ่ม *ทดลองรัน*, จากนั้นปุ่ม *รันจริง*
ระบบจะขอให้พิมพ์ `RUN` เพื่อยืนยัน — หรือ `FORCE` ถ้า preflight ขึ้น block หรือข้ามการสแกนตารางนี้ไป)

หน้า Plan → เปิด **dry run** แล้วสั่งรัน (หรือ API):

```bash
curl -s "$BASE/api/jobs" \
  -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" -H 'Content-Type: application/json' \
  -d "{\"planId\":\"$PLAN\",\"dryRun\":true}"
```

dry run จะ:

- **ข้าม preflight gate ทั้งหมด** (โดยเจตนา — dry run ไม่แตะข้อมูล) และข้ามการเช็ค `read_only`
- ตั้งทุก step เป็น `skipped_dry_run` — **ไม่รัน SQL ใดๆ ไม่ backup ไม่ทำ checksum**
- สร้าง job manifest, ลำดับ step, และ audit trail ครบ

**สิ่งที่ dry run ยืนยันได้:** แผนโหลดได้, ลำดับ step ถูก, session ยังใช้ได้, job persistence เขียนไฟล์ได้
**สิ่งที่ dry run ยืนยัน *ไม่* ได้:** ว่า SQL จะรันผ่าน, ว่าเวลาจะเท่าไหร่, ว่า backup จะสำเร็จ — **ต้องซ้อมบน staging ด้วยการรันจริง (Phase 0.6) เท่านั้น**

### 6.2 รันจริง

**เช็คลิสต์นาทีสุดท้ายก่อนกดรัน:**

- [ ] write ทั้งหมดหยุดแล้ว (application หยุด / app user ถูกถอนสิทธิ์ write)
- [ ] `preflightId` มีอยู่ และผลเป็น `pass` หรือ `warn` ที่เข้าใจแล้ว
- [ ] `checksumId` (baseline) มีอยู่
- [ ] forward + rollback script ดาวน์โหลดเก็บไว้นอกเครื่องแล้ว
- [ ] `backupStrategy` เลือกแล้ว และเนื้อที่พอ
- [ ] `CSMIG_IDLE_TIMEOUT_MS` ยาวกว่า window
- [ ] มีคนเฝ้าหน้า "งานที่รัน" และหน้า Logs ตลอด
- [ ] มีอีกหน้าต่างเปิด `mysql` client ค้างไว้สำหรับตรวจสอบด่วน

```bash
curl -s "$BASE/api/jobs" \
  -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" -H 'Content-Type: application/json' \
  -d "{\"planId\":\"$PLAN\",
       \"preflightId\":\"$PREFLIGHT_ID\",
       \"snapshotId\":\"$CHECKSUM_ID\",
       \"backupStrategy\":\"table_copy\",
       \"verifyChecksum\":true,
       \"checksumMode\":\"sha256\",
       \"autoRollbackOnFailure\":true,
       \"rollbackAllOnFailure\":false,
       \"preferFastRollback\":true,
       \"stopOnError\":true,
       \"dryRun\":false}"
```

ถ้าได้ **412** ให้อ่าน `code`:

| code | ความหมาย | ทำอะไร |
|---|---|---|
| `preflight_required` | ไม่ได้แนบ `preflightId` | **กลับไป Phase 3** — อย่าใช้ `acknowledgeNoPreflight: true` เพื่อลัด |
| `plan_risk_blocked` | แผนมี risk ระดับ `critical` ที่ preflight ตอบให้ไม่ได้ — `fk_charset_mismatch`, `index_too_long`, `row_too_large`, `algorithm_impossible`, `lock_impossible` (ดูรายการเต็มใน `risks[]` ของ response) | อ่าน `risks[].message` แล้ว **แก้ต้นเหตุก่อน** (กรณี FK: รันชุดคำสั่งซ่อมที่หน้าแผนพิมพ์ให้ — drop constraint → แปลงทั้งสองฝั่ง → add กลับ) จากนั้น **สร้างแผนใหม่** เพราะแผนเดิมเก็บสภาพ ณ ตอนสร้างไว้ `forceDespiteRisks: true` = ยอมให้ MySQL ปฏิเสธคำสั่ง (หรือยอมเสียข้อมูล) อย่างจงใจ ถูกบันทึกเป็น `options.forcedRisks` ใน job manifest และ audit `job.plan_risk.override` |
| `preflight_blocked` | ผล preflight เป็น `gate: block` | **กลับไป Phase 3.2** แก้ข้อมูล แล้วรัน preflight ใหม่ — `forceDespiteBlock: true` = ยอมสูญเสียข้อมูลอย่างจงใจและถูกบันทึกถาวร |
| `preflight_scope_mismatch` | แผนมีตารางที่ต้อง rebuild แต่ preflight ไม่ได้สแกน (มักเกิดจากตารางที่ถูกข้ามเพราะเกิน `maxScanBytes` หรือ scope ของ preflight แคบกว่าของแผน) | ดูรายชื่อใน `uncovered[]` แล้ว **รัน Preflight ใหม่ให้ครอบคลุม** (ถ้าเป็นตารางใหญ่ ให้เพิ่มเพดาน หรือใช้ `rowLimit` เพื่อสแกนแบบสุ่มตัวอย่างแทนการข้าม) การใช้ `acknowledgeUncoveredTables: true` = รันตารางที่ไม่รู้ว่ามีข้อมูลจะหายหรือไม่ และถูกบันทึกเป็น audit `job.preflight.scope_override` |

ถ้าได้ **409** = `@@read_only = 1` บนเซิร์ฟเวอร์ (กลับไป Phase 0.1)

**สิ่งที่ต้องเฝ้าดูระหว่างรัน** (หน้า "งานที่รัน" poll ให้อยู่แล้ว):

| สัญญาณ | ความหมาย | ทำอะไร |
|---|---|---|
| `throttle` ปรากฏพร้อม `threadsRunning` สูง | job รอให้เซิร์ฟเวอร์ว่างก่อนเริ่ม step ถัดไป | ปกติ — แต่ถ้าค้างนานใกล้ 5 นาที (150 × 2 วินาที) step จะล้มเหลว ให้ลดโหลดฝั่งอื่น หรือ pause job |
| `throttle` พร้อม `lagSec` สูง | replica lag เกินเกณฑ์ | รอให้ replica ตาม — หรือถ้ายอมรับได้ ให้ปรับ `CSMIG_MAX_REPLICA_LAG` (ต้อง restart) หรือส่ง `runner` override ใน job ถัดไป |
| step ค้างที่ `altering` นาน | `ALTER` กำลัง rebuild อยู่ | ปกติ ตรวจความคืบหน้าจริงฝั่ง DB (ดูคำสั่งข้างล่าง) — **ห้าม kill** |
| `step.warnings` มีข้อความ | `SHOW WARNINGS` หลัง `ALTER` มีอะไร | **อ่านทุกครั้ง** — warning เรื่อง data truncated คือสัญญาณข้อมูลหาย |
| `step.meta.mismatch` | metadata หลังรันยังไม่ตรงเป้าหมายครบ | ไม่ทำให้ step ล้มเหลว (เป็น warn) มักเกิดจากคอลัมน์ที่ตั้ง charset เฉพาะ — ตรวจด้วยมือหลังจบ |

ตรวจความคืบหน้าฝั่ง DB:

```sql
-- ALTER กำลังทำอะไรอยู่
SELECT ID, USER, DB, COMMAND, TIME, STATE, LEFT(INFO, 120) AS info
  FROM information_schema.PROCESSLIST
 WHERE COMMAND <> 'Sleep' ORDER BY TIME DESC;

-- ความคืบหน้าแบบละเอียด (ต้องเปิด instrument ไว้)
SELECT stmt.THREAD_ID, stmt.SQL_TEXT, st.WORK_COMPLETED, st.WORK_ESTIMATED
  FROM performance_schema.events_stages_current st
  JOIN performance_schema.events_statements_current stmt USING (THREAD_ID);

-- ใครกำลังรอ metadata lock อยู่ (คือ write ที่ถูกบล็อก)
SELECT * FROM performance_schema.metadata_locks WHERE LOCK_STATUS = 'PENDING';
```

**pause / cancel:**

```bash
curl -s "$BASE/api/jobs/$JOB/pause"  -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" \
  -H 'Content-Type: application/json' -d '{"paused":true}'
curl -s "$BASE/api/jobs/$JOB/cancel" -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" \
  -H 'Content-Type: application/json' -d '{}'
```

ทั้งสองมีผลที่ **ขอบ step เท่านั้น** — `ALTER` ที่กำลังรันจะรันจนจบไม่ถูกตัดกลาง (นี่คือพฤติกรรมที่ปลอดภัย: การตัด `ALTER ... COPY` กลางทางทำให้ MySQL ต้อง rollback การ copy ทั้งหมดเอง)

### 6.3 ทางเลือกสำหรับตารางใหญ่ — pt-osc / gh-ost

ถ้าเวลา rebuild ยาวกว่า window ที่มี **อย่าใช้ job runner ของแอปนี้** ให้คัดลอกคำสั่งจากช่อง `tooling` ของ step นั้นในหน้า Plan (แอปสร้างคำสั่งให้แต่ **ไม่ได้รันให้** — และ checksum/rollback ของแอปจะไม่รู้เรื่องการรันนอกแอป)

```bash
# ทดสอบก่อนด้วย --dry-run แล้วค่อยเปลี่ยนเป็น --execute
pt-online-schema-change --alter "CONVERT TO CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci" \
  D=mydb,t=mytable --host=127.0.0.1 --port=3306 --user=root --ask-pass \
  --max-load Threads_running=40 --critical-load Threads_running=80 \
  --chunk-time=0.5 --set-vars lock_wait_timeout=5 \
  --no-drop-old-table --alter-foreign-keys-method=auto --dry-run
```

`--no-drop-old-table` ทำให้ตารางเดิมยังอยู่ในชื่อ `_mytable_old` = backup ในตัว **ให้ลบเองหลังยืนยันเสร็จ**
**ยังต้องรัน Preflight ของแอปนี้ก่อนเสมอ** — pt-osc/gh-ost ไม่ตรวจ lossy conversion หรือ unique collision ให้ มันจะแปลงและทำข้อมูลหายอย่างเงียบๆ เหมือนกัน (ที่แย่กว่าคือมันจะเจอ duplicate key ตอน copy chunk แล้วล้มกลางทาง)
หลังรันเสร็จ กลับมาใช้หน้า Checksum ของแอปนี้ verify (Phase 7) ได้ตามปกติ

---

## Phase 7 — ยืนยันผลด้วย checksum

### 7.1 ตรวจผล checksum ต่อ step (อัตโนมัติ)

ถ้า `verifyChecksum: true` (default) job runner ได้ทำให้แล้วทุก step: checksum ก่อน → `ALTER` → checksum หลัง → `compareChecksum`
**ถ้า digest ไม่ตรง step จะถือว่าล้มเหลวและเข้า auto-rollback ทันที** ดูผลได้ที่หน้า "งานที่รัน" ต่อ step (`checksumBefore`, `checksumAfter`, `verify.ok`, `verify.issues`) หรือ:

```bash
curl -s "$BASE/api/jobs/$JOB" -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" \
  | python -m json.tool | grep -A3 '"verify"'
```

### 7.2 ยืนยันเทียบ baseline

วิธีปกติคือ **ขั้นที่ 5 "ยืนยันว่าข้อมูลไม่เปลี่ยน"** ในหน้าตาราง → กด **เทียบกับ baseline**
ระบบจะคำนวณใหม่ด้วย strategy และจำนวนแถวชุดเดียวกับ baseline แล้ว diff ให้

**อ่านคำเตือนที่ติดมากับผล** — "ข้อมูลตรงกับ baseline" ที่มาพร้อม
*"ตรวจเฉพาะ N แถวแรกตาม primary key"* คือหลักฐานแบบสุ่มตรวจ ไม่ใช่หลักฐานเต็มตาราง
ให้บันทึกข้อความนี้ลงรายงานตามจริง

เรียกผ่าน API ได้เช่นกัน:

หน้า **Checksum** → เลือก snapshot baseline จาก Phase 4 → กด **verify** (หรือ API):

```bash
curl -s "$BASE/api/checksum/$CHECKSUM_ID/verify" \
  -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" -H 'Content-Type: application/json' -d '{}'
# → 202 + taskId ; poll ด้วย GET /api/checksum/<taskId>?full=1
```

ระบบจะรัน snapshot ใหม่บนตารางชุดเดิม ด้วย `mode` และ `deep` เดิม แล้ว diff ทีละตาราง คืน `summary.mismatches` และ `summary.ok`

**ตีความผล:**

| ผล | ความหมาย | ทำอะไร |
|---|---|---|
| `summary.ok = true` | ✅ digest ทุกตารางเท่าเดิมเป๊ะ — **ข้อมูลไม่เปลี่ยนแม้แต่อักขระเดียว** (นี่คือคุณสมบัติของ checksum ที่ normalize เป็น utf8mb4 ก่อน) | ไปต่อ Phase 7.3 |
| `digest ไม่ตรงกัน` | 🛑 มีอักขระถูกแทน/หาย | ถ้า snapshot เป็น `deep` จะมี `changedColumns` ระบุคอลัมน์ให้ → ไป Phase 8 (rollback) ทันที |
| `จำนวนแถวเปลี่ยน` | 🛑 มี row หายหรือเพิ่ม | ถ้าไม่ได้หยุด write จริงนี่คือสาเหตุที่พบบ่อยสุด · ถ้าหยุด write แล้วยังเปลี่ยน = ข้อมูลหายจริง → rollback |
| `โหมด checksum ไม่ตรงกัน` | เทียบผิดคู่ | เลือก baseline ให้ถูก แล้ว verify ใหม่ |
| `คอลัมน์หายไปหลังแปลง` | 🛑 schema เปลี่ยนเกินที่คาด | ตรวจ `SHOW CREATE TABLE` เทียบ `createTableBefore` ที่ job เก็บไว้ → rollback |

> **สิ่งที่ checksum จับไม่ได้ — ต้องตรวจด้วยตา:**
> **mojibake จาก double-encoding** (ดู Phase 3.2 ข้อ C) ไม่มีไบต์หาย และการ normalize เป็น utf8mb4 ตีความไบต์แบบเดียวกันทั้งก่อนและหลัง → digest **ผ่าน** แม้ข้อความอ่านไม่ออก
> **ต้อง `SELECT` ตัวอย่างข้อมูลจริงจากคอลัมน์ที่มีภาษาไทย/ภาษาอื่น มาอ่านด้วยตาทุกครั้ง:**
>
> ```sql
> SELECT id, mycol FROM mydb.mytbl WHERE mycol REGEXP '[^ -~]' LIMIT 30;
> ```

### 7.3 ยืนยัน metadata

```sql
-- ต้องได้ 0 แถว: คอลัมน์ข้อความที่ยังไม่ตรงเป้าหมาย
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = 'mydb'
   AND CHARACTER_SET_NAME IS NOT NULL
   AND NOT (CHARACTER_SET_NAME = 'utf8mb3' AND COLLATION_NAME = 'utf8mb3_general_ci');

-- ต้องได้ 0 แถว: ตารางที่ default ยังไม่ตรง
SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_COLLATION
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'mydb' AND TABLE_TYPE = 'BASE TABLE'
   AND TABLE_COLLATION <> 'utf8mb3_general_ci';

-- schema default
SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
  FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'mydb';
```

หรือเปิดหน้า **ภาพรวม** ใหม่ — ควรขึ้นกล่องเขียว "ครบตามเป้าหมายแล้ว"

### 7.4 ตรวจ integrity ที่ระบบไม่ตรวจให้

```sql
-- ถ้าใช้ disableFkChecks — ต้องตรวจ orphan row ด้วยมือ (ทำต่อทุก FK ใน scope)
SELECT c.id FROM mydb.child c
  LEFT JOIN mydb.parent p ON p.code = c.parent_code
 WHERE c.parent_code IS NOT NULL AND p.code IS NULL;

-- ตารางที่มี FULLTEXT — ทดสอบ query ค้นหาจริงว่าผลยังถูก
SELECT COUNT(*) FROM mydb.articles WHERE MATCH(body) AGAINST('คำค้นทดสอบ' IN NATURAL LANGUAGE MODE);

-- ตรวจสุขภาพตารางหลัง rebuild
ANALYZE TABLE mydb.mytbl;
CHECK  TABLE mydb.mytbl;
```

รัน smoke test ของแอปพลิเคชันจริง — โดยเฉพาะ query ที่ใช้ `ORDER BY` / `GROUP BY` / `JOIN` บนคอลัมน์ข้อความ เพราะ **collation ที่เปลี่ยนทำให้ลำดับการเรียงและการเทียบเท่าเปลี่ยน** (`utf8mb4_0900_ai_ci` → `utf8mb3_general_ci` ให้ผลการเรียงไม่เหมือนกัน) และอาจทำให้ query ที่ `JOIN` ข้าม collation เกิด **"Illegal mix of collations"** ถ้าแปลงไม่ครบทุกตารางที่เกี่ยวข้อง

---

## Phase 8 — เมื่อ step ล้มเหลว: rollback

### 8.1 พฤติกรรม auto-rollback (เกิดขึ้นเองแล้ว)

เมื่อ step ล้มเหลว (SQL error, checksum ไม่ตรง, throttle timeout, session หลุด) และ `autoRollbackOnFailure !== false` (default เปิด):

1. ระบบ rollback **step ที่ล้มเหลวนั้น** ทันที เลือก method:
   - **`table_copy_swap`** ถ้ามี backup แบบ `table_copy` และ `preferFastRollback !== false` → `RENAME TABLE db.tbl TO db._csmig_<stamp>_bad_<tbl>, db._csmig_<stamp>_<tbl> TO db.tbl;` (atomic; ตารางที่แปลงเสียถูกเก็บไว้ในชื่อ `bad_` เพื่อชันสูตร **อย่าลบทันที**)
   - **`inverse_ddl`** กรณีอื่น → รัน `step.rollbackSql` ทุกคำสั่ง
2. ถ้าตั้ง `rollbackAllOnFailure: true` จะ **cascade** rollback ทุก step ที่ `done` แล้วในลำดับย้อนกลับ และสถานะ job จะเป็น `rolled_back`
3. หลัง rollback ระบบรัน checksum ใหม่แล้วเทียบกับ `checksumBefore` → ถ้าไม่ตรงจะได้สถานะ **`verify_failed`** (นี่คือสัญญาณร้ายแรง: rollback ทำงานแต่ข้อมูลไม่กลับ)
4. `stopOnError !== false` (default) → job หยุดทั้งหมดทันที ไม่ทำ step ที่เหลือ

**ทุกอย่างถูกบันทึกใน `data/jobs/<jobId>.json` และ `.ndjson`** — อ่านได้ที่หน้า Logs หรือ `GET /api/jobs/:id/log`

> **จุดที่ต้องเข้าใจให้ชัด:** `inverse_ddl` คืน **โครงสร้าง** ได้ครบทุกไบต์ แต่ **ไม่คืนอักขระที่กลายเป็น `?`** โค้ดจะแนบ `rollback.note` บอกเรื่องนี้พร้อม path ของไฟล์ backup (ถ้ามี) ถ้า `backupStrategy: none` และ checksum ไม่ตรง → **ข้อมูลนั้นสูญหายถาวรแล้ว** ต้องกู้จาก backup ระดับ instance

### 8.2 Manual rollback ผ่าน API

job ต้องอยู่ในสถานะ terminal (`done` / `failed` / `cancelled` / `rolled_back`) — ถ้ายังรันอยู่ให้ cancel ก่อนแล้วรอ

```bash
# rollback ทุก step ที่สถานะ done หรือ failed (ลำดับย้อนกลับ)
curl -s "$BASE/api/jobs/$JOB/rollback" \
  -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" -H 'Content-Type: application/json' -d '{}'

# rollback เฉพาะ step ที่เลือก
curl -s "$BASE/api/jobs/$JOB/rollback" \
  -H "X-App-Key: $KEY" -H "X-Session-Id: $SID" -H 'Content-Type: application/json' \
  -d '{"stepIds":["alter-1a2b3c4d","alter-5e6f7a8b"]}'
```

### 8.3 Manual rollback ด้วยมือ — `RENAME TABLE` swap สำหรับ backup แบบ `table_copy`

ใช้เมื่อ: แอปหยุดทำงาน / restart ทำให้ job หายจากหน่วยความจำ / API rollback ล้มเหลว

```sql
-- 1) หาชื่อ backup table
SELECT TABLE_SCHEMA, TABLE_NAME,
       ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,1) AS mb, TABLE_ROWS
  FROM information_schema.TABLES
 WHERE TABLE_NAME LIKE '\_csmig\_%'
 ORDER BY TABLE_SCHEMA, TABLE_NAME;
-- รูปแบบชื่อ: _csmig_<YYYYMMDDHHMMSS>_<tablename>

-- 2) ตรวจก่อนสลับ — จำนวนแถวและตัวอย่างข้อมูลต้องดูถูกต้อง
SELECT COUNT(*) FROM mydb.`_csmig_20260910143022_mytbl`;
SELECT COUNT(*) FROM mydb.mytbl;
SELECT * FROM mydb.`_csmig_20260910143022_mytbl` LIMIT 10;

-- 3) สลับกลับแบบ atomic (คำสั่งเดียวกับที่ jobs.js รัน)
RENAME TABLE mydb.mytbl                              TO mydb.`_csmig_20260910143022_bad_mytbl`,
             mydb.`_csmig_20260910143022_mytbl`       TO mydb.mytbl;

-- 4) ยืนยัน
SHOW CREATE TABLE mydb.mytbl\G
SELECT COUNT(*) FROM mydb.mytbl;
SELECT id, mycol FROM mydb.mytbl WHERE mycol REGEXP '[^ -~]' LIMIT 20;
```

**ข้อควรระวังหลัง swap:**

- `CREATE TABLE ... LIKE` **ไม่คัดลอก foreign key** → ตารางที่ได้กลับมาจะ **ไม่มี FK** ต้องสร้างคืนจาก `createTableBefore` ที่ job เก็บไว้ (`data/jobs/<jobId>.json`) หรือจาก `pre-migration-schema.sql`:

  ```sql
  ALTER TABLE mydb.mytbl
    ADD CONSTRAINT fk_mytbl_parent FOREIGN KEY (parent_code) REFERENCES mydb.parent(code);
  ```

- `AUTO_INCREMENT` counter: แอปคัดลอกค่าจากต้นฉบับให้ตอนสร้าง backup แล้ว (ดู `backup.autoIncrement` ใน manifest) แต่ถ้ามี insert เข้ามาหลัง copy ค่านี้จะถอยหลัง → ตรวจและตั้งใหม่:

  ```sql
  SELECT MAX(id) FROM mydb.mytbl;
  ALTER TABLE mydb.mytbl AUTO_INCREMENT = <MAX(id) + 1>;
  ```

- **trigger ไม่ถูกคัดลอกไปตารางใหม่** ต้องสร้างคืนจาก `pre-migration-objects.sql`
- **เก็บตาราง `_csmig_*_bad_*` ไว้จนกว่าจะยืนยันทุกอย่างเสร็จ** — นั่นคือหลักฐานว่าเกิดอะไรขึ้น

### 8.4 Manual rollback — restore จากไฟล์ `mysqldump`

ไฟล์อยู่ที่ `data/jobs/<jobId>-backup/<schema>.<table>.sql` (dump ด้วย `--add-drop-table` จึงมี `DROP TABLE IF EXISTS` อยู่ในไฟล์แล้ว)

```bash
JOBID=job-20260910143000-a1b2c3
ls -lh "data/jobs/$JOBID-backup/"

# 1) ตรวจไฟล์ก่อน — มี DROP + CREATE + INSERT ครบไหม ไฟล์ไม่ถูกตัดกลาง
head -50 "data/jobs/$JOBID-backup/mydb.mytbl.sql"
tail -5  "data/jobs/$JOBID-backup/mydb.mytbl.sql"   # ต้องจบด้วย -- Dump completed

# 2) เก็บตารางปัจจุบันไว้ก่อนเขียนทับ (สำคัญมาก)
mysql --host=127.0.0.1 --user=root -p -e \
  "RENAME TABLE mydb.mytbl TO mydb.mytbl_before_restore;"

# 3) restore — ต้องใช้ --default-character-set=binary ให้ตรงกับที่ dump มา
#    ถ้าไม่ใส่ client จะแปลง charset ระหว่างทางแล้วข้อมูลเพี้ยน
mysql --host=127.0.0.1 --user=root -p \
  --default-character-set=binary mydb < "data/jobs/$JOBID-backup/mydb.mytbl.sql"

# 4) ยืนยัน
mysql --host=127.0.0.1 --user=root -p -e "
  SHOW CREATE TABLE mydb.mytbl\G
  SELECT COUNT(*) FROM mydb.mytbl;
  SELECT COUNT(*) FROM mydb.mytbl_before_restore;
  SELECT id, mycol FROM mydb.mytbl WHERE mycol REGEXP '[^ -~]' LIMIT 20;"
```

**หมายเหตุ:** dump ใช้ `--routines=false --triggers=false` → **trigger และ routine ไม่อยู่ในไฟล์** ต้องกู้จาก `pre-migration-objects.sql` แยก
เมื่อยืนยันว่า restore ถูกต้องแล้ว จึงลบ `mydb.mytbl_before_restore`

### 8.5 Manual rollback — จาก rollback script

ถ้าไม่มี backup ใดๆ (`backupStrategy: none`) ทางเหลือคือ inverse DDL:

```bash
# ตรวจก่อน แล้วค่อยรัน
less "$PLAN-rollback.sql"
mysql --host=127.0.0.1 --user=root -p < "$PLAN-rollback.sql"
```

สคริปต์นี้กลับลำดับ step ให้แล้ว **แต่คืนได้แค่โครงสร้าง** อักขระที่กลายเป็น `?` ไม่กลับมา

---

## Phase 9 — Post-migration cleanup

**ทำหลัง Phase 7 ยืนยันผ่านครบถ้วน และหลังเปิด application กลับมาใช้งานปกติแล้วอย่างน้อย 1 รอบธุรกิจเต็ม** (แนะนำ 24–72 ชั่วโมง)

### 9.1 สร้าง views / routines / triggers / events กลับ (แอปไม่ทำให้)

metadata charset ของ object เหล่านี้ถูกตรึงตอน `CREATE` — **ต้อง drop แล้ว create ใหม่** ด้วย connection ที่ตั้ง charset เป้าหมาย

```sql
-- ตรวจว่ายังเหลืออะไร (query เดียวกับ Phase 0.5)
SELECT 'VIEW' kind, TABLE_SCHEMA db, TABLE_NAME name, CHARACTER_SET_CLIENT, COLLATION_CONNECTION
  FROM information_schema.VIEWS
 WHERE TABLE_SCHEMA = 'mydb'
   AND (CHARACTER_SET_CLIENT <> 'utf8mb3' OR COLLATION_CONNECTION <> 'utf8mb3_general_ci');
```

```bash
# วิธีที่ปลอดภัยกว่าการแก้ทีละตัว: dump นิยามออกมา แล้ว load กลับด้วย connection charset ที่ถูก
mysqldump --host=127.0.0.1 --user=root -p \
  --no-data --no-create-info --routines --triggers --events \
  --skip-add-drop-table --databases mydb > objects-current.sql

# ลบ object เดิม (ใช้รายการจาก query ข้างบน) เช่น
mysql --user=root -p -e "
  DROP VIEW IF EXISTS mydb.v_orders;
  DROP TRIGGER IF EXISTS mydb.trg_orders_ai;
  DROP PROCEDURE IF EXISTS mydb.sp_recalc;"

# โหลดกลับด้วย connection charset = utf8mb3 → metadata ใหม่จะเป็น utf8mb3
mysql --host=127.0.0.1 --user=root -p \
  --default-character-set=utf8mb3 mydb < objects-current.sql
```

```sql
-- ตรวจว่าตรงเป้าหมายแล้ว (ต้องได้ 0 แถวจาก query ตรวจข้างบน)
-- และทดสอบว่า view/routine ยังทำงานถูก
SELECT * FROM mydb.v_orders LIMIT 5;
CALL mydb.sp_recalc();
```

**สำหรับ view โดยเฉพาะ** ยังต้องตรวจว่า collation ของคอลัมน์ที่ view คืนออกมาตรงกับตารางฐานแล้ว ไม่งั้น query ที่ `JOIN` view กับตารางจะเจอ "Illegal mix of collations":

```sql
CREATE TEMPORARY TABLE _t AS SELECT * FROM mydb.v_orders LIMIT 0;
SELECT COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
  FROM information_schema.COLUMNS WHERE TABLE_NAME = '_t';
```

### 9.2 ลบ backup table `_csmig_*` (ไม่มี API ให้ — ต้องทำเอง)

```sql
-- 1) list ทั้งหมดก่อน พร้อมขนาดที่จะคืนมา
SELECT TABLE_SCHEMA, TABLE_NAME,
       ROUND((DATA_LENGTH+INDEX_LENGTH)/1024/1024,1) AS mb, TABLE_ROWS, CREATE_TIME
  FROM information_schema.TABLES
 WHERE TABLE_NAME LIKE '\_csmig\_%'
 ORDER BY CREATE_TIME;

-- 2) สร้างคำสั่ง DROP อัตโนมัติ (อ่านทานก่อนรัน — อย่า copy ไปรันทันที)
SELECT GROUP_CONCAT(
         CONCAT('DROP TABLE IF EXISTS `', TABLE_SCHEMA, '`.`', TABLE_NAME, '`;')
         SEPARATOR '\n') AS drop_script
  FROM information_schema.TABLES
 WHERE TABLE_NAME LIKE '\_csmig\_%';

-- 3) ลบทีละตาราง (ไม่ลบเป็นชุดใหญ่ — DROP ตารางใหญ่ทำให้ I/O พุ่ง)
DROP TABLE IF EXISTS mydb.`_csmig_20260910143022_mytbl`;
```

**ลำดับความสำคัญของการเก็บไว้:**

| ชื่อ | ความหมาย | ลบเมื่อไหร่ |
|---|---|---|
| `_csmig_<stamp>_<tbl>` | shadow backup ที่ยังไม่ถูกใช้ (migration สำเร็จ) | **ลบได้หลังยืนยัน 24–72 ชั่วโมง** |
| `_csmig_<stamp>_bad_<tbl>` | ตารางที่แปลงเสียแล้วถูกสลับออกด้วย rollback | **เก็บไว้จนกว่า post-mortem จะเสร็จ** — นี่คือหลักฐาน |
| `_presanitize_*` / `_preconv_*` | ตารางที่คุณสร้างเองใน Phase 3 | ลบหลังยืนยันว่าไม่ต้องอ้างอิงอีก |
| `*_before_restore` | ตารางที่เก็บไว้ก่อน restore | ลบหลังยืนยัน restore ถูกต้อง |

### 9.3 ลบ / archive backup files

```bash
# ตรวจขนาดก่อน
du -sh data/jobs/*-backup/

# ย้ายไปเก็บที่ปลอดภัยพร้อม manifest ก่อนลบ (แนะนำ)
tar czf "migration-backup-$(date +%Y%m%d).tar.gz" data/jobs/*-backup/ data/plans/ data/snapshots/
# ...ย้าย tarball ไป archive แล้วจึงลบ
rm -rf data/jobs/*-backup/
```

**เก็บถาวรไว้:** `data/audit/*.ndjson`, `data/jobs/*.json`, `data/plans/*.json`, `data/snapshots/*.json` — ไฟล์เหล่านี้เล็กและเป็น audit trail ที่ redact รหัสผ่านแล้ว ใช้อ้างอิงย้อนหลังได้

### 9.4 ตั้งค่า default ให้ไม่ถอยกลับ

```ini
# my.cnf — ให้ตารางใหม่และ connection ใหม่ตรงเป้าหมายโดย default
[mysqld]
character-set-server = utf8mb3
collation-server     = utf8mb3_general_ci

[client]
default-character-set = utf8mb3
```

ต้องอัปเดต connection string ของ application ให้ตรงด้วย (JDBC `characterEncoding`, PHP `mysqli::set_charset`, Python `charset=`, Node `charset:`) ไม่งั้นจะได้ mojibake รอบใหม่จากทางฝั่ง client

### 9.5 ปิดงาน

- [ ] ตัดการเชื่อมต่อในหน้า UI (ปุ่ม "ตัดการเชื่อมต่อ") — pool ปิด, vault ถูก wipe, เขียน audit `session.disconnect`
- [ ] `Ctrl+C` ปิดแอป (เขียน audit `server.stop` + `destroyAll`)
- [ ] คืนสิทธิ์ write ให้ app user / เปิด application กลับ
- [ ] เก็บชุดหลักฐาน: `preflightId`, `checksumId`, `planId`, `jobId`, CSV inventory ก่อน/หลัง, forward+rollback script, ผล verify
- [ ] บันทึกเวลาจริงที่ใช้ต่อ GB ไว้ใช้ประมาณรอบถัดไป

---

## Abort criteria — หยุดทันทีเมื่อเจอข้อใดข้อหนึ่ง

**หยุดก่อนเริ่ม (ห้ามรัน job):**

1. Preflight ให้ `gate: block` และยังไม่ได้แก้ข้อมูลตามต้นเหตุ (`lossy_conversion` / `unique_collision`)
2. Preflight มี `verdict: unknown` บนตารางที่อยู่ใน scope และยังหาสาเหตุไม่ได้
3. พบ `suspect_double_encoding` ที่ยืนยันแล้วว่าเป็นของจริง และยังไม่ได้แปลงผ่าน `BINARY`
4. เนื้อที่ดิสก์ว่างน้อยกว่า **2 เท่า** ของตารางที่ใหญ่ที่สุดใน scope (หรือ 3 เท่าถ้าใช้ `table_copy`)
5. ไม่มี backup ที่ทดสอบ restore แล้ว และ `backupStrategy` = `none`
6. write ยังไม่ถูกหยุด — checksum verification จะให้ผลเท็จและ auto-rollback โดยไม่จำเป็น
7. ไม่มี `preflightId` (`412 preflight_required`) — แก้โดยรัน preflight ไม่ใช่โดยใส่ `acknowledgeNoPreflight`
8. `@@read_only = 1` หรือกำลังชี้ไปที่ replica โดยไม่ได้ตั้งใจ
9. เวลาที่ประมาณได้ยาวกว่า maintenance window — เปลี่ยนไปเส้น pt-osc/gh-ost
10. ยังไม่ได้ซ้อมบน staging ด้วยข้อมูลขนาดจริง
11. Plan มี risk `critical` ที่ยังไม่ได้อธิบายและรับทราบทุกข้อ
12. `npm run check` ยังไม่ผ่าน 38/38 (มีอะไรพังในระดับ logic — อย่ารันบนข้อมูลจริง)

**หยุดกลางทาง (cancel job แล้วประเมิน):**

13. **checksum ไม่ตรงบน step ใดก็ตาม** — job หยุดเองแล้วถ้า `stopOnError` เปิด **อย่าสั่งรันต่อจนกว่าจะรู้สาเหตุ**
14. **rollback ได้สถานะ `verify_failed`** — rollback ทำงานแต่ข้อมูลไม่กลับสภาพเดิม **นี่คือเหตุร้ายแรงสุด** หยุดทุกอย่าง ไป restore จาก backup ระดับ instance
15. `step.warnings` มี warning เรื่อง truncated / invalid character
16. replica lag พุ่งจนกระทบ read replica ที่ใช้งาน production
17. throttle ค้างเกิน 5 นาทีซ้ำๆ หลายตาราง — เซิร์ฟเวอร์ไม่ว่างพอ ให้เลื่อน window
18. `ALTER` ตารางเดียวกินเวลาเกิน 2 เท่าที่ประมาณไว้ (สงสัย I/O saturate / lock contention)
19. **มี write หลุดเข้ามาระหว่าง migration** — ข้อมูลที่เขียนหลัง backup จะหายถ้าต้อง rollback
20. session หมดอายุกลาง job (mysqldump backup ของ step ถัดไปจะล้ม) — cancel แล้วเชื่อมต่อใหม่ ตั้ง `CSMIG_IDLE_TIMEOUT_MS` ให้ยาวกว่า window
21. แอปหรือเครื่องที่รันแอป restart กลางทาง — job หายจากหน่วยความจำ ต้องประเมินสภาพจาก `data/jobs/<id>.json` แล้ว rollback ด้วยมือ (Phase 8.3–8.5) **ห้ามสร้าง job ใหม่ทับสภาพที่ไม่รู้แน่**
22. พบ mojibake ในการ `SELECT` ตรวจด้วยตาแม้ checksum จะผ่าน
