/**
 * hooks.js — استقبال إشعارات التوظيف من نظام أرتال (artalsys.com)
 *
 * الغرض: عندما يُضاف موظف جديد في نظام الشركة، يُخطر هذا المسار فيبحث عن
 * رقم هويته بين المتقدمين، وإن وُجد يعلّمه بنفس الحقول التي يملؤها
 * الفحص القائم (utils/extCheck.js) — فلا يُتواصل معه لاحقاً وهو موظف.
 *
 * ضمانات:
 *  • لا يُنشئ أي متقدم ولا يحذف أي صف — تحديث أعمدة ext_* فقط.
 *  • لا يلمس متقدماً معلَّماً سلفاً (ext_found = 1) — إعادة الإرسال بلا أثر.
 *  • لا يغيّر حالة المتقدم (status) — تبقى كما ضبطها موظف التوظيف.
 *  • أي خطأ في صف واحد لا يُسقط بقية الدفعة.
 */

const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const db        = require('../database/db');

const router = express.Router();

// نفس سرّ الفحص القائم — ما لم يُعيَّن سرّ مستقل للـ hooks
const SECRET      = process.env.HOOK_API_SECRET || process.env.EXT_API_SECRET || 'artal@NID%2026';
const MAX_BATCH   = 500;
const SYSTEM_USER = 'النظام (مزامنة)';

// ─── حد المعدل ────────────────────────────────────────────────────────────────
// 200 طلب / 15 دقيقة — الترحيل التاريخي كله 10 طلبات، والتشغيل اليومي 1–2.
const hooksLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'rate_limited' },
});

// ─── المصادقة ─────────────────────────────────────────────────────────────────
function secretMatches(provided) {
  const given    = Buffer.from(String(provided ?? ''), 'utf8');
  const expected = Buffer.from(SECRET, 'utf8');
  if (given.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(given, expected); } catch { return false; }
}

function requireSecret(req, res, next) {
  if (!secretMatches(req.get('X-Secret'))) {
    console.warn('[Hooks] رفض طلب — سرّ غير مطابق', req.ip);
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// ─── تحقّق من صحة صف الموظف ───────────────────────────────────────────────────
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const nationalId = String(raw.national_id ?? '').trim();
  if (!/^\d{10}$/.test(nationalId)) return null;

  const employeeId = Number.parseInt(raw.employee_id, 10);
  if (!Number.isInteger(employeeId) || employeeId <= 0) return null;

  // status قد يصل 1/0/true/false/null — نطبّعه إلى 1/0 أو null
  let status = null;
  if (raw.status !== null && raw.status !== undefined && raw.status !== '') {
    status = Number(raw.status) ? 1 : 0;
  }

  const jobStatus = raw.job_status ? String(raw.job_status).trim().slice(0, 50) : null;

  return { nationalId, employeeId, status, jobStatus };
}

// ─── تعليم متقدم واحد (كل تقديماته) ──────────────────────────────────────────
/**
 * @param {{nationalId:string, employeeId:number, status:?number, jobStatus:?string}} entry
 * @param {Array<{id:number, full_name:string, ext_check_done:number, ext_found:?number}>} rows
 *        كل صفوف المتقدمين بهذا رقم الهوية
 * @returns {Promise<{outcome:'flagged'|'already'|'none', rows:number}>}
 */
async function markApplicants(entry, rows) {
  if (!rows.length) return { outcome: 'none', rows: 0 };

  const pending = rows.filter(r => !r.ext_found);
  if (!pending.length) return { outcome: 'already', rows: 0 };

  // لقطة قبل التحديث — الوصف يجب أن يعكس الحالة السابقة لا اللاحقة
  const snapshot = pending.map(r => ({
    id: r.id,
    fullName: r.full_name,
    previous: r.ext_check_done ? 'غير موجود في النظام' : 'لم يُفحص',
  }));

  // 1) التعليم — نفس أعمدة extCheck.js تماماً، وعلى كل تقديماته لا صفّ واحد.
  //    شرط ext_found يجعل العملية idempotent: إعادة الإرسال تحدّث 0 صف.
  await db.run(
    `UPDATE applicants
        SET ext_check_done  = 1,
            ext_found       = 1,
            ext_employee_id = ?,
            ext_status      = ?,
            ext_job_status  = ?,
            ext_checked_at  = NOW()
      WHERE id_number = ?
        AND (ext_found IS NULL OR ext_found = 0)`,
    [entry.employeeId, entry.status, entry.jobStatus, entry.nationalId]
  );

  // 2) السجلّات — منفصلة عن التعليم عمداً: فشل التسجيل لا يُلغي التعليم،
  //    والتعليم يمنع تكرار السطور عند إعادة الإرسال.
  try {
    const placeholders = snapshot.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const params = snapshot.flatMap(r => [
      r.id,
      'مطابقة مع نظام أرتال',
      r.previous,
      `موظف #${entry.employeeId}`,
      SYSTEM_USER,
    ]);

    await db.run(
      `INSERT INTO applicant_activity (applicant_id, action, old_value, new_value, user_name)
       VALUES ${placeholders}`,
      params
    );

    const suffix = snapshot.length > 1 ? ` (${snapshot.length} تقديمات)` : '';
    await db.audit(
      null, SYSTEM_USER, 'sync_hired', 'applicant',
      snapshot[0].id, snapshot[0].fullName,
      `تم توظيفه في نظام أرتال — الموظف #${entry.employeeId}${suffix}`,
      null
    );
  } catch (e) {
    console.error('[Hooks] تعذّر تسجيل النشاط:', e.message);
  }

  return { outcome: 'flagged', rows: snapshot.length };
}

// ─── POST /api/hooks/employees-hired ─────────────────────────────────────────
// يقبل موظفاً واحداً أو دفعة حتى 500.
router.post('/employees-hired', hooksLimiter, requireSecret, async (req, res) => {
  try {
    const body = req.body || {};
    const list = Array.isArray(body.employees)
      ? body.employees
      : (body.national_id ? [body] : null);

    if (!Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty_payload' });
    }
    if (list.length > MAX_BATCH) {
      return res.status(413).json({ ok: false, error: 'batch_too_large', max: MAX_BATCH });
    }

    // تطبيع + إسقاط الصفوف غير الصالحة (لا تُسقط الدفعة)
    const entries = [];
    let invalid = 0;
    for (const raw of list) {
      const entry = normalizeEntry(raw);
      if (entry) entries.push(entry); else invalid++;
    }

    if (!entries.length) {
      return res.json({ ok: true, received: list.length, invalid, flagged: 0, already_flagged: 0, not_applicants: 0, applicants_updated: 0 });
    }

    // استعلام واحد لكل الدفعة — يتفادى 500 رحلة إلى القاعدة
    const ids = [...new Set(entries.map(e => e.nationalId))];
    const rows = await db.all(
      `SELECT id, id_number, full_name, ext_check_done, ext_found
         FROM applicants
        WHERE id_number IN (${ids.map(() => '?').join(',')})`,
      ids
    );

    const byNationalId = new Map();
    for (const row of rows) {
      if (!byNationalId.has(row.id_number)) byNationalId.set(row.id_number, []);
      byNationalId.get(row.id_number).push(row);
    }

    let flagged = 0, already = 0, none = 0, updatedRows = 0, failed = 0;

    for (const entry of entries) {
      const applicantRows = byNationalId.get(entry.nationalId) || [];
      try {
        const result = await markApplicants(entry, applicantRows);
        if (result.outcome === 'flagged') {
          flagged++;
          updatedRows += result.rows;
        } else if (result.outcome === 'already') {
          already++;
        } else {
          none++;
        }
      } catch (e) {
        // صف واحد يفشل — البقية تكمل
        failed++;
        console.error(`[Hooks] فشل تعليم ${entry.nationalId}:`, e.message);
      }
    }

    const summary = {
      ok: true,
      received: list.length,
      invalid,
      flagged,                       // أشخاص عُلِّموا الآن
      already_flagged: already,      // كانوا معلَّمين سلفاً
      not_applicants: none,          // لا سجلّ لهم في موقع التقديم
      applicants_updated: updatedRows,
      failed,
    };

    // سطر تدقيق واحد للدفعات فقط — حتى لا يمتلئ السجل بسطر لكل موظف يومي
    if (list.length > 1) {
      try {
        await db.audit(
          null, SYSTEM_USER, 'sync_batch', 'applicant', null, null,
          `دفعة مزامنة: ${list.length} موظف — عُلِّم ${flagged}، معلَّم سلفاً ${already}، بلا تقديم ${none}`,
          null
        );
      } catch { /* السجل ثانوي */ }
    }

    console.log('[Hooks] employees-hired', JSON.stringify(summary));
    return res.json(summary);
  } catch (err) {
    console.error('[Hooks] خطأ غير متوقع:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ─── GET /api/hooks/health ───────────────────────────────────────────────────
// فحص اتصال بسيط — يستخدمه نظام أرتال للتأكد قبل الترحيل التاريخي.
router.get('/health', hooksLimiter, requireSecret, async (req, res) => {
  try {
    const row = await db.get('SELECT COUNT(*) AS c FROM applicants WHERE ext_found = 1');
    return res.json({ ok: true, flagged_applicants: Number(row?.c) || 0 });
  } catch (err) {
    console.error('[Hooks] health:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
