// The stop policy for the one-button run.
//
// Kept in its own module, free of DOM and of `api`, for two reasons: the rule
// that decides whether an automated run may touch the database is the riskiest
// thing on this page, and a rule buried in a click handler is a rule nobody can
// test. scripts/selftest.js imports this file directly and exercises every
// branch below without a browser or a database.
//
// The runner in views/table.js owns *doing* the work; this file only ever
// answers "given what just landed, may the next phase start?".

/**
 * The six actions behind the five visible steps. Step 4 is two phases: the
 * dry run and the real one, and the runner has to be able to stop between them.
 */
export const AUTO_PHASES = [
  { id: 'preflight', step: 1, label: 'ตรวจข้อมูลก่อนแปลง' },
  { id: 'baseline', step: 2, label: 'เก็บ baseline' },
  { id: 'plan', step: 3, label: 'สร้างคำสั่ง SQL' },
  { id: 'dryrun', step: 4, label: 'ลองรันดูก่อน ไม่แตะฐานข้อมูล' },
  { id: 'run', step: 4, label: 'รันจริง' },
  { id: 'verify', step: 5, label: 'เทียบกับ baseline' },
];

const go = () => ({ go: true });
const stop = (code, reason, hint = '') => ({ go: false, code, reason, hint });

/**
 * May the phase after `phase` start?
 *
 * `s` is a flat snapshot of the table's stored state plus the terminal status
 * of whatever the phase just ran:
 *
 *   taskStatus      'done' | 'failed' | 'cancelled'   (preflight, baseline)
 *   preflightGate   'pass' | 'warn' | 'block' | null
 *   preflightScanned bool - false means the table was skipped, not cleared
 *   checksumOk      bool
 *   planId          string | null
 *   planRebuilds    number - steps in the plan that rewrite data
 *   dryRunStatus    job status of the dry run
 *   jobStatus       job status of the real run
 *   verifyOk        bool
 *
 * A missing field is never read as permission. Every phase requires a positive
 * verdict to continue, so an unexpected shape stops the run instead of
 * carrying it into an ALTER.
 */
export function autoNext(phase, s = {}) {
  if (s.cancelled) return stop('cancelled', 'ยกเลิกโดยผู้ใช้');

  switch (phase) {
    case 'preflight':
      if (s.taskStatus === 'cancelled') return stop('cancelled', 'ยกเลิกโดยผู้ใช้');
      if (s.taskStatus === 'failed') {
        return stop('preflight_failed', 'ตรวจข้อมูลไม่สำเร็จ', 'ดูข้อความที่ขั้น 1 แล้วลองใหม่');
      }
      // The two cases the manual path answers by demanding the operator type
      // FORCE. An automated run is exactly the situation where nobody is
      // reading the warning, so it hands the decision back instead.
      if (s.preflightGate === 'block') {
        return stop('preflight_block', 'ขั้น 1 เจอปัญหาที่ทำให้ข้อมูลเสียถาวร',
          'ไปแก้ข้อมูลก่อน หรือถ้ายืนยันจริงๆ ให้กดรันเองที่ขั้น 4 (ต้องพิมพ์ FORCE)');
      }
      if (s.preflightScanned === false) {
        return stop('preflight_skipped', 'ตารางนี้ถูกข้ามตอนสแกน ยังไม่มีอะไรยืนยันว่าไม่มีตัวอักษรหาย',
          'ตั้งค่าสแกนใหม่ที่ขั้น 1 หรือกดรันเองที่ขั้น 4 (ต้องพิมพ์ FORCE)');
      }
      if (s.preflightGate !== 'pass' && s.preflightGate !== 'warn') {
        return stop('preflight_no_verdict', 'ยังไม่ได้ผลตรวจที่ใช้ตัดสินใจได้');
      }
      return go();

    case 'baseline':
      if (s.taskStatus === 'cancelled') return stop('cancelled', 'ยกเลิกโดยผู้ใช้');
      if (s.taskStatus === 'failed') {
        return stop('baseline_failed', 'เก็บ baseline ไม่สำเร็จ', 'ดูข้อความที่ขั้น 2 แล้วลองใหม่');
      }
      // Same gate the step list uses: without a baseline there is nothing to
      // prove the conversion by afterwards, so the run must not start.
      if (s.checksumOk !== true) {
        return stop('baseline_failed', 'ไม่ได้ค่า baseline ที่เอาไปเทียบได้',
          'ลองเก็บใหม่ด้วยวิธีที่เบากว่าใน "ตัวเลือกขั้นสูง" ของขั้น 2');
      }
      return go();

    case 'plan':
      if (!s.planId) return stop('plan_failed', 'สร้างคำสั่งไม่สำเร็จ');
      // "ที่แนะนำ" ticking nothing is a real answer, and it reduces the plan to
      // metadata-only ALTERs. Running that unattended would report success
      // without a single character having been converted, so say so instead.
      if (!s.planRebuilds) {
        return stop('plan_empty', 'ไม่มีคอลัมน์ไหนที่ "ที่แนะนำ" ติ๊กให้',
          'แผนนี้จะแก้แค่ default ไม่แปลงข้อมูลเลย เลือกคอลัมน์เองที่ขั้น 3 แล้วรันต่อ');
      }
      return go();

    case 'dryrun':
      if (s.dryRunStatus !== 'done') {
        return stop('dryrun_failed', `ลองรันแล้วไม่ผ่าน (${s.dryRunStatus || 'ไม่ทราบสถานะ'})`,
          'ยังไม่ได้แตะฐานข้อมูล ดูรายละเอียดที่ขั้น 4');
      }
      return go();

    case 'run':
      if (s.jobStatus !== 'done') {
        return stop('run_failed', `รันจริงจบแบบ ${s.jobStatus || 'ไม่ทราบสถานะ'}`,
          'ดูรายละเอียดที่ขั้น 4 หรือหน้า "งานที่รันไปแล้ว"');
      }
      return go();

    case 'verify':
      // Terminal either way: the runner has nothing left to start. The code is
      // what decides how the summary reads - and "could not compare" is not
      // the same finding as "the data changed", so they stay apart here too.
      if (s.taskStatus === 'cancelled') return stop('cancelled', 'ยกเลิกโดยผู้ใช้');
      if (s.taskStatus === 'failed') {
        return stop('verify_failed', 'แปลงเสร็จแล้ว แต่เทียบกับ baseline ไม่สำเร็จ',
          'ตารางถูกแปลงไปแล้ว สิ่งที่ขาดคือผลเทียบ — กดเทียบใหม่ที่ขั้น 5 ได้');
      }
      return s.verifyOk === true
        ? stop('finished', 'เสร็จครบทุกขั้น ข้อมูลยังเหมือนเดิม')
        : stop('verify_mismatch', 'แปลงเสร็จแล้ว แต่เทียบกับ baseline ไม่ผ่าน',
          'ดูรายละเอียดที่ขั้น 5 ก่อนตัดสินใจย้อนกลับ');

    default:
      return stop('unknown_phase', `ไม่รู้จักขั้นตอน ${phase}`);
  }
}
