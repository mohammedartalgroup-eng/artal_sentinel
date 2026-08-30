/**
 * طبقة الوصول إلى بيانات المتقدمين ومرفقاتهم — عرضٌ مُدقَّق وتحميلٌ بسبب مكتوب.
 *
 * لماذا وحدة مستقلة؟ لأن ثلاثة مسارات تحتاجها: مرفقات طلب التوظيف في
 * routes/admin.js، ومستندات الاستكمال في routes/onboarding.js (وهي معزولة
 * عمداً)، وتصدير Excel. توحيد التحقق والتسجيل هنا يمنع أن ينسى أحدها
 * سطر التدقيق فيصير ثغرة صامتة في الرقابة.
 *
 * ⚠️ حدود ما يمكن ضمانه تقنياً: المتصفح يعرض الصورة فعلياً، ومن يعرضها
 *    يستطيع تصويرها بلقطة شاشة. لا يوجد «عرض بلا نسخ» حقيقي على الويب.
 *    ما تضمنه هذه الوحدة أمران فقط، وهما المطلوبان:
 *      ١) لا يمرّ فتحٌ ولا تحميلٌ دون صفٍّ باسم الموظف في audit_log.
 *      ٢) التحميل فعلٌ متعمَّد يكتب صاحبه سببه قبل أن يبدأ.
 */

const path = require('path');
const db   = require('../database/db');

// ─── أفعال الاطّلاع ───────────────────────────────────────────────────────────
// تُسجَّل في audit_log لكنها ليست «إنتاجية»: فتح ملف ليس إنجازاً كتغيير حالة.
// تقرير الأداء وصفحة المستخدمين يستثنيانها بهذه القائمة — ولولا ذلك لتضخّمت
// أرقام الموظف الذي يتصفّح كثيراً وينجز قليلاً.
const VIEW_ACTIONS = ['applicant_view', 'doc_view', 'doc_download'];
const VIEW_ACTIONS_SQL = VIEW_ACTIONS.map(a => `'${a}'`).join(',');

// أفعال لا تُحتسب في عدّادات الأداء إطلاقاً (اطّلاع + دخول/خروج)
const NON_WORK_ACTIONS_SQL = `'login','logout',${VIEW_ACTIONS_SQL}`;

// ─── سبب التحميل ──────────────────────────────────────────────────────────────
const REASON_MIN = 10;
const REASON_MAX = 300;   // عمود details هو VARCHAR(500) — نترك مساحة للبادئة

/**
 * تطبيع سبب التحميل والتحقق منه.
 * الحد الأدنى ليس تعجيزاً: «شغل» أو «.» ليست سبباً يُحاسَب عليه أحد لاحقاً.
 */
function normalizeReason(raw) {
  const reason = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!reason)                  return { ok: false, error: 'سبب التحميل مطلوب' };
  if (reason.length < REASON_MIN) return { ok: false, error: `اكتب سبباً واضحاً — ${REASON_MIN} أحرف على الأقل` };
  if (reason.length > REASON_MAX) return { ok: false, error: `السبب طويل — الحد ${REASON_MAX} حرفاً` };
  return { ok: true, reason };
}

// ─── التسجيل في سجل التدقيق ──────────────────────────────────────────────────

/**
 * تسجيل فعل اطّلاع مع كبح التكرار.
 *
 * لماذا الكبح؟ تحديث الصفحة أو رجوع المتصفح يفتح المسار مرة أخرى. لو سجّلنا
 * كل نداء لامتلأ السجل بصفوف متطابقة خلال ثوانٍ، ولصار عملياً غير قابل
 * للقراءة — وسجلٌّ لا يُقرأ لا يردع أحداً. نافذة قصيرة تحفظ المعنى:
 * «فلان اطّلع على هذا الملف في هذا الوقت» يبقى مسجَّلاً، والضجيج يسقط.
 *
 * الكبح للعرض وحده. التحميل يُسجَّل دائماً بلا استثناء — لأن كل نسخة تخرج
 * من النظام حدثٌ مستقل يجب أن يُرى.
 */
const DEDUPE_MIN = parseInt(process.env.ACCESS_DEDUPE_MIN) || 10;

async function logView(req, { action, targetId, targetName, details = null, windowMin = DEDUPE_MIN }) {
  const win = Math.max(0, parseInt(windowMin) || 0);
  try {
    if (win > 0) {
      // فحص التكرار بالاسم لا بالمعرّف: الجلسة قد تحمل adminId فارغاً في
      // حالات نادرة، والاسم موجود دائماً (العمود NOT NULL).
      const dup = await db.get(
        `SELECT id FROM audit_log
          WHERE username = ? AND action = ? AND target_type = 'applicant' AND target_id = ?
            AND (details <=> ?)
            AND created_at > (NOW() - INTERVAL ${win} MINUTE)
          LIMIT 1`,
        [req.session.adminUser, action, targetId, details]
      );
      if (dup) return false;
    }
  } catch (e) {
    // فشل فحص التكرار لا يُسقط التسجيل — الأسوأ صفٌّ مكرر، لا صفٌّ ضائع
    console.error('[Access dedupe]', e.message);
  }
  await db.audit(
    req.session.adminId, req.session.adminUser, action,
    'applicant', targetId, targetName, details, req.ip
  );
  return true;
}

/** تسجيل تحميل — بلا كبح، ومع السبب في التفاصيل */
async function logDownload(req, { targetId, targetName, docLabel, reason }) {
  await db.audit(
    req.session.adminId, req.session.adminUser, 'doc_download',
    'applicant', targetId, targetName,
    `${docLabel} — السبب: ${reason}`.slice(0, 500), req.ip
  );
}

// ─── ترويسات الخدمة ──────────────────────────────────────────────────────────
// no-store مقصودة: بدونها يبقى المرفق في ذاكرة القرص المؤقتة للمتصفح بعد
// خروج الموظف من النظام، فيُفتح من الكاش بلا مرور بمسارٍ يُدقّق.
const NO_STORE = {
  'Cache-Control':          'no-store, no-cache, must-revalidate, private',
  'Pragma':                 'no-cache',
  'Expires':                '0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag':           'noindex, nofollow, noarchive',
  'Referrer-Policy':        'no-referrer',
};

/** ترويسة Content-Disposition تدعم الاسم العربي (RFC 5987) */
function disposition(mode, filename) {
  if (!filename) return mode;
  const ascii = String(filename).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * إرسال الملف بوضع صريح: inline للعرض، attachment للتحميل.
 * التصريح مهمّ — بدونه يقرر المتصفح وحده، وقد ينزّل ما أردناه عرضاً.
 */
function sendAs(res, filePath, { mode = 'inline', filename = null } = {}) {
  res.set(NO_STORE);
  res.set('Content-Disposition', disposition(mode, filename));
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

// محارف ممنوعة في أسماء الملفات على ويندوز وماك — والشرطة المائلة تحديداً
// تظهر في تسميات مثل «الهوية / الإقامة» فتُنتج اسماً مكسوراً عند الحفظ.
function safePart(v, max) {
  return String(v || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** اسم ملف عربي مفهوم عند التحميل بدل cv_1012345678_1776237395847.pdf */
function downloadName(label, personName, storedName) {
  const ext  = path.extname(String(storedName || '')).toLowerCase();
  const what = safePart(label, 60);
  const who  = safePart(personName, 60);
  return `${what}${who ? ' - ' + who : ''}${ext}`;
}

/** هل يُعرض داخل المتصفح أم يحتاج تنزيلاً؟ (doc/docx لا يعرضها متصفح) */
function viewerKind(storedName) {
  const ext = path.extname(String(storedName || '')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  return 'other';
}

module.exports = {
  VIEW_ACTIONS, VIEW_ACTIONS_SQL, NON_WORK_ACTIONS_SQL,
  REASON_MIN, REASON_MAX, DEDUPE_MIN,
  normalizeReason, logView, logDownload,
  sendAs, downloadName, viewerKind, disposition,
};
