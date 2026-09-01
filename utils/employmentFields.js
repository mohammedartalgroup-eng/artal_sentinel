/**
 * employmentFields.js — بيانات التوظيف التي يُدخلها فريق الموارد البشرية.
 *
 * ما لا يوجد في مستندات المرشح ولا يجوز أن يكتبه بنفسه: الراتب وبدلاته،
 * المسمّى الوظيفي، الموقع، تواريخ العقد. تُدخل من صفحة الموارد البشرية وحدها،
 * ولا تظهر في رحلة المرشح إطلاقاً.
 *
 * ⚠️ القوائم المغلقة أدناه تطابق قيم النظام الأساسي (artalsys) حرفاً بحرف:
 *    JobTitle enum، MaritalStatus enum، InsuranceType enum. أي قيمة خارجها
 *    يرفضها الطرف الآخر عند المزامنة، فمنعها هنا أرحم من رفضٍ بعد الضغط.
 */

// App\Enums\JobTitle — القيمة هي النص العربي نفسه في النظام الأساسي
const JOB_TITLES = [
  'حارس أمن', 'مشرف أمن', 'مدير أمن', 'مشرف عمليات', 'مدير العمليات',
  'مسئول منطقة', 'معقب', 'اداري', 'محاسب', 'محاسب تحضير',
  'مهندس برمجيات', 'أخرى',
];

// App\Enums\MaritalStatus — تُخزَّن بالإنجليزية وتُعرض بالعربية
const MARITAL = [
  { value: 'single',   label: 'أعزب' },
  { value: 'married',  label: 'متزوج' },
  { value: 'divorced', label: 'مطلق' },
  { value: 'widowed',  label: 'أرمل' },
];

// المؤهل نص حر في النظام الأساسي (افتراضه «غير محدد») — نضبطه بقائمة لتوحيد
// الكتابة، ويبقى «أخرى» منفذاً لما لا يندرج تحتها.
const QUALIFICATIONS = [
  'غير محدد', 'ابتدائي', 'متوسط', 'ثانوي', 'دبلوم', 'بكالوريوس', 'ماجستير', 'دكتوراه', 'أخرى',
];

// App\Enums\InsuranceType — '' = بدون، 'commercial_record' = مشترك بالتأمينات.
// ⚠️ «بدون» قيمتها فارغة في النظام الأساسي، والفراغ عندنا يعني «لم يُحدَّد بعد».
//    فنمثّلها هنا بـ 'none' ونحوّلها إلى '' لحظة المزامنة — وإلا ظهر كل ملف لم
//    تُملأ فيه الخانة وكأن صاحبه بلا تأمين.
const INSURANCE = [
  { value: 'commercial_record', label: 'مشترك في التأمينات الاجتماعية' },
  { value: 'none',              label: 'بدون تأمين' },
];

/** قيمة نوع التأمين كما يفهمها النظام الأساسي */
const insuranceTypeForSync = (v) => (v === 'none' ? '' : (v || null));

/**
 * required: مطلوب قبل السماح بالمزامنة (لا قبل الحفظ — الحفظ جزئي دائماً،
 * فالموظف يملأ ما لديه اليوم ويكمل غداً).
 */
const FIELDS = [
  { key: 'job_title',           label: 'المسمّى الوظيفي',   type: 'select', options: JOB_TITLES, required: true,
    hint: 'قائمة مغلقة في النظام الأساسي — لا يُقبل غيرها' },
  { key: 'preferred_zone_name', label: 'الموقع المرشح',     type: 'text',   required: true, max: 120 },
  { key: 'basic_salary',        label: 'الراتب الأساسي',     type: 'money',  required: true },
  { key: 'living_allowance',    label: 'بدل السكن',          type: 'money',  required: false },
  { key: 'other_allowances',    label: 'بدلات أخرى',         type: 'money',  required: false },
  // اختياري: قد لا يكون الموعد محسوماً وقت الإضافة، والنظام الأساسي يستكمله
  { key: 'actual_start',        label: 'تاريخ المباشرة',     type: 'date',   required: false },
  { key: 'contract_start',      label: 'بداية العقد',        type: 'date',   required: false },
  { key: 'marital_status',      label: 'الحالة الاجتماعية',  type: 'choice', options: MARITAL, required: false },
  { key: 'qualification',       label: 'المؤهل',             type: 'select', options: QUALIFICATIONS, required: false },
  { key: 'specialization',      label: 'التخصص',             type: 'text',   required: false, max: 100 },
  { key: 'emergency_phone',     label: 'جوال الطوارئ',       type: 'phone',  required: false },
  { key: 'email',               label: 'البريد الإلكتروني',  type: 'email',  required: false, max: 120 },
  { key: 'insurance_type',      label: 'نوع التأمين',        type: 'choice', options: INSURANCE, required: false },
  { key: 'insurance_company',   label: 'شركة التأمين',       type: 'text',   required: false, max: 120 },
];

// الأرقام العربية-الهندية تصل من لوحة مفاتيح الجوال — نُعيد استخدام المطبّع
// نفسه المستخدم في قراءة المستندات بدل نسخة ثانية تتفرّع عنه.
const { normalizeDigits } = require('./docRules');

const KEYS = FIELDS.map(f => f.key);
const def = (key) => FIELDS.find(f => f.key === key) || null;

// ─── التحقق ──────────────────────────────────────────────────────────────────

function validate(key, raw) {
  const f = def(key);
  if (!f) return { ok: false, value: null, error: 'حقل غير معروف' };

  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, value: null, error: null };   // الفراغ مسموح دائماً عند الحفظ

  switch (f.type) {
    case 'money': {
      // الفواصل تُزال والإشارة تبقى: حذف السالب يحوّل «-5» إلى 5 فيمرّ خطأً.
      // ونصٌّ بلا رقم («abc») يصير سلسلة فارغة فتقرؤه Number صفراً — نرفضه صراحةً.
      const cleaned = normalizeDigits(s).replace(/[^\d.-]/g, '');
      if (!/\d/.test(cleaned)) return { ok: false, value: null, error: 'مبلغ غير صالح' };
      const n = Number(cleaned);
      if (!Number.isFinite(n) || n < 0) return { ok: false, value: null, error: 'مبلغ غير صالح' };
      if (n > 999999) return { ok: false, value: null, error: 'مبلغ كبير بشكل غير معقول' };
      return { ok: true, value: n.toFixed(2), error: null };
    }
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, value: null, error: 'التاريخ بصيغة سنة-شهر-يوم' };
      if (Number.isNaN(Date.parse(s))) return { ok: false, value: null, error: 'تاريخ غير صالح' };
      return { ok: true, value: s, error: null };
    }
    case 'phone': {
      const d = normalizeDigits(s).replace(/\D/g, '');
      const m = d.match(/^(?:966|0)?(5\d{8})$/);
      if (!m) return { ok: false, value: null, error: 'جوال سعودي غير صالح (05XXXXXXXX)' };
      return { ok: true, value: '0' + m[1], error: null };
    }
    case 'email': {
      if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(s)) return { ok: false, value: null, error: 'بريد غير صالح' };
      return { ok: true, value: s.slice(0, 120), error: null };
    }
    case 'select': {
      if (!f.options.includes(s)) return { ok: false, value: null, error: 'قيمة خارج القائمة المعتمدة' };
      return { ok: true, value: s, error: null };
    }
    case 'choice': {
      if (!f.options.some(o => o.value === s)) return { ok: false, value: null, error: 'قيمة خارج القائمة المعتمدة' };
      return { ok: true, value: s, error: null };
    }
    default:
      return { ok: true, value: s.slice(0, f.max || 255), error: null };
  }
}

/** الحقول المطلوبة الناقصة — بوابة زر المزامنة */
function missingRequired(row) {
  return FIELDS.filter(f => f.required)
    .filter(f => {
      const v = row?.[f.key];
      return v === null || v === undefined || String(v).trim() === '';
    })
    .map(f => ({ key: f.key, label: f.label }));
}

module.exports = { FIELDS, KEYS, def, validate, missingRequired, insuranceTypeForSync,
  JOB_TITLES, MARITAL, QUALIFICATIONS, INSURANCE };
