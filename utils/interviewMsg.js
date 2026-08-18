/**
 * interviewMsg.js
 * بناء كل نصوص إشعار المتقدم بموعد المقابلة — في مكان واحد.
 *
 * ثلاث قنوات تشترك في نفس المصدر حتى لا تتناقض الصياغة بينها:
 *   • wa.me   — الرابط اليدوي في بطاقة المقابلة (خطة بديلة دائمة)
 *   • Chatwoot — متغيّرات قالب واتساب المعتمد (utils/chatwoot.js)
 *   • البريد   — نسخة HTML عربية + نسخة نصية (utils/mailer.js)
 */

const { arabicDate, localTime } = require('./slots');

// 05XXXXXXXX → 9665XXXXXXXX (صيغة wa.me — بلا +)
function toIntlPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^05\d{8}$/.test(digits)) return `966${digits.slice(1)}`;
  if (/^9665\d{8}$/.test(digits)) return digits;
  if (/^5\d{8}$/.test(digits)) return `966${digits}`;
  return digits;
}

// ─── المسمّى الوظيفي ─────────────────────────────────────────────────────────
//  لا يوجد عمود «وظيفة» في جدول المتقدمين — الطلب يأتي من صفحة وظيفة في
//  الموقع، فنشتق المسمّى من مسار صفحة الدخول المحفوظة (landing_page):
//    /jobs/<city>            → حارس أمن (الافتراضي)
//    /jobs/<city>/supervisor → مشرف أمن
//    /jobs/<city>/manager    → مدير أمن
//  الترتيب: قيمة صريحة اختارها الموظف ← الاشتقاق ← الافتراضي من الإعدادات.
const JOB_BY_SEGMENT = { '': 'حارس أمن', supervisor: 'مشرف أمن', manager: 'مدير أمن' };

function deriveJobTitle(applicant, settings = {}) {
  const explicit = String(applicant?.job_title || '').trim();
  if (explicit) return explicit;

  const m = String(applicant?.landing_page || '').match(/\/jobs\/[^/?#]+(?:\/([^/?#]+))?/);
  if (m) {
    const seg = String(m[1] || '').toLowerCase();
    if (JOB_BY_SEGMENT[seg] !== undefined) return JOB_BY_SEGMENT[seg];
  }
  return String(settings.default_job_title || '').trim() || 'حارس أمن';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const isEmail = (v) => EMAIL_RE.test(String(v || '').trim());

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ─── مجموعة المتغيّرات المشتركة ──────────────────────────────────────────────
/**
 * @param {{full_name?:string}} applicant
 * @param {{startMs:number, durationMin:number, meetLink?:string, interviewers?:{name:string}[]}} interview
 * @param {{companyName?:string, reason?:string}} [opts]
 */
function messageVars(applicant, interview, opts = {}) {
  // القوالب غير المرتبطة بمقابلة (طلب استكمال بيانات مثلاً) تُنادى بلا موعد،
  // فحقول التاريخ والوقت تبقى فارغة بدل أن ينهار البنّاء على startMs مفقود.
  const iv = interview || {};
  const has = Number.isFinite(iv.startMs);
  const settings = opts.settings || {};
  const date = has ? arabicDate(iv.startMs) : '';
  const time = has ? localTime(iv.startMs) : '';

  return {
    name:     String(applicant?.full_name || '').trim(),
    company:  opts.companyName || 'أرتال للحراسات الأمنية',
    job:      String(opts.jobTitle || '').trim() || deriveJobTitle(applicant, settings),
    project:  String(opts.project || '').trim() || String(settings.default_project_name || '').trim(),
    region:   String(opts.region  || '').trim() || String(applicant?.region || '').trim(),
    city:     String(applicant?.city || '').trim(),
    date,
    time,
    datetime: has ? `${date} الساعة ${time}` : '',
    duration: String(iv.durationMin || ''),
    link:     iv.meetLink || '',
    interviewers: (iv.interviewers || []).map(p => p.name || p.email).join('، '),
    reason:   String(opts.reason || '').trim(),
  };
}

const VAR_LABELS = {
  name: 'اسم المتقدم', company: 'اسم الشركة', job: 'المسمّى الوظيفي',
  project: 'المشروع', region: 'المنطقة', city: 'المدينة',
  date: 'التاريخ', time: 'الوقت', datetime: 'التاريخ والوقت',
  duration: 'المدة بالدقائق', link: 'رابط Meet',
  interviewers: 'أسماء المقابلين', reason: 'سبب الإلغاء',
};

/**
 * قيمة متغيّر داخل قالب واتساب لا يجوز أن تحوي سطراً جديداً أو تباً أو أربع
 * مسافات متتالية — ترفضها Meta بخطأ غامض. والقيمة الفارغة تُرفض كذلك، فنضع
 * شرطة مكانها بدل إسقاط المتغيّر (عدد المتغيّرات يجب أن يطابق القالب تماماً).
 */
function sanitizeParam(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return s || '—';
}

/**
 * يبني processed_params بالشكل الذي يفهمه إصدار Chatwoot لديك.
 *
 * @param {object} vars      ناتج messageVars
 * @param {string} varsOrder قائمة مفصولة بفواصل ترتّب المتغيّرات: "name,date,time,link"
 *                           فتصبح {{1}}=name و{{2}}=date …
 * @param {'numbered'|'structured'} shape
 */
function buildProcessedParams(vars, varsOrder, shape = 'numbered') {
  const keys = String(varsOrder || '').split(',').map(s => s.trim()).filter(Boolean);
  const values = keys.map(k => sanitizeParam(vars[k]));
  if (shape === 'structured') return { body: values, header: [], buttons: [] };
  return Object.fromEntries(values.map((v, i) => [String(i + 1), v]));
}

// ─── واتساب: النص المُعرَّض ──────────────────────────────────────────────────
//  يُستخدم لرابط wa.me اليدوي، وكـ content في Chatwoot (ما يراه الوكيل في
//  صندوقه). النص الفعلي الذي يصل المتقدم هو نص القالب المعتمد.
function buildWhatsAppText(applicant, interview, opts = {}) {
  const v = messageVars(applicant, interview, opts);
  const lines = [
    `مرحباً ${v.name}،`,
    `تمت جدولة مقابلة توظيف معك في ${v.company}.`,
    '',
    `📅 التاريخ: ${v.date}`,
    `🕐 الوقت: ${v.time} (بتوقيت السعودية)`,
    `⏱️ المدة: ${v.duration} دقيقة`,
  ];
  if (interview.meetLink) {
    lines.push('', `🔗 رابط المقابلة عبر Google Meet:`, interview.meetLink);
  }
  lines.push('', 'نرجو الانضمام قبل الموعد بخمس دقائق من مكان هادئ وبإنترنت مستقر.', 'بالتوفيق.');
  return lines.join('\n');
}

function buildRescheduleText(applicant, interview, opts = {}) {
  const v = messageVars(applicant, interview, opts);
  const lines = [
    `مرحباً ${v.name}،`,
    `تم تعديل موعد مقابلتك في ${v.company}.`,
    '',
    `📅 الموعد الجديد: ${v.date}`,
    `🕐 الوقت: ${v.time} (بتوقيت السعودية)`,
  ];
  if (interview.meetLink) lines.push('', '🔗 رابط المقابلة:', interview.meetLink);
  lines.push('', 'نعتذر عن أي إزعاج، ونشكر تفهّمك.');
  return lines.join('\n');
}

function buildCancelText(applicant, interview, opts = {}) {
  const v = messageVars(applicant, interview, opts);
  const lines = [
    `مرحباً ${v.name}،`,
    `نفيدك بإلغاء موعد المقابلة المقرر ${v.date} الساعة ${v.time} في ${v.company}.`,
  ];
  if (v.reason) lines.push('', `السبب: ${v.reason}`);
  lines.push('', 'سنتواصل معك لاحقاً لتحديد موعد بديل. شكراً لتفهّمك.');
  return lines.join('\n');
}

// النص المُعرَّض لطلب استكمال البيانات (ما يظهر للوكيل في Chatwoot).
// النص الفعلي الذي يصل المتقدم هو نص القالب المعتمد.
function buildInfoRequestText(applicant, _interview, opts = {}) {
  const v = messageVars(applicant, null, opts);
  return [
    `السلام عليكم ${v.name}،`,
    'معك شركة أرتال للحراسات الأمنية.',
    `نرغب في استكمال بياناتك للنظر في ترشيحك لوظيفة ${v.job}`
      + `${v.project ? ` ضمن مشروع ${v.project}` : ''}${v.region ? ` في منطقة ${v.region}` : ''}.`,
    '',
    'نرجو الإجابة عن أسئلة: مكان السكن، العمر، حالتك الوظيفية،',
    'الحالة الصحية، والتسجيل في التأمينات.',
  ].join('\n');
}

const WA_TEXT = {
  scheduled:   buildWhatsAppText,
  rescheduled: buildRescheduleText,
  cancelled:   buildCancelText,
  info_request: buildInfoRequestText,
};

function buildWaUrl(phone, text) {
  const p = toIntlPhone(phone);
  if (!p) return '';
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

// ─── البريد الإلكتروني ───────────────────────────────────────────────────────
const C = { navy: '#001736', blue: '#405f91', bg: '#f2f4f6', line: '#e0e3e5', mute: '#43474f' };

function row(label, value) {
  return `<tr>
    <td style="padding:9px 0;font-size:13px;color:${C.mute};white-space:nowrap;">${esc(label)}</td>
    <td style="padding:9px 0 9px 16px;font-size:14px;color:${C.navy};font-weight:700;">${value}</td>
  </tr>`;
}

/**
 * قالب بريد واحد لكل الحالات — الاختلاف في العنوان والفقرة الافتتاحية فقط.
 * كُتب بجداول وأنماط سطرية عمداً: Gmail وOutlook يتجاهلان <style> و flex.
 */
function buildEmailHtml(applicant, interview, opts = {}) {
  const kind = opts.kind || 'scheduled';
  const v = messageVars(applicant, interview, opts);
  const cancelled = kind === 'cancelled';

  const intro = {
    scheduled:   `يسعدنا إبلاغك بأنه تمت جدولة مقابلة توظيف أونلاين معك في <strong>${esc(v.company)}</strong>.`,
    rescheduled: `نفيدك بأنه تم <strong>تعديل موعد</strong> مقابلتك في ${esc(v.company)}. الموعد الجديد كما يلي:`,
    cancelled:   `نفيدك بأنه تم <strong>إلغاء</strong> موعد المقابلة المقرر معك في ${esc(v.company)}.`,
  }[kind];

  const rows = [
    v.job && !cancelled ? row('الوظيفة', esc(v.job)) : '',
    row('التاريخ', esc(v.date)),
    row('الوقت', `<span dir="ltr">${esc(v.time)}</span> <span style="font-weight:400;color:${C.mute};font-size:12px;">(بتوقيت السعودية)</span>`),
    cancelled ? '' : row('المدة', `${esc(v.duration)} دقيقة`),
    v.interviewers && !cancelled ? row('المقابلون', esc(v.interviewers)) : '',
    cancelled && v.reason ? row('السبب', esc(v.reason)) : '',
  ].filter(Boolean).join('');

  const cta = (!cancelled && v.link) ? `
      <tr><td style="padding:22px 0 6px;">
        <a href="${esc(v.link)}" style="display:inline-block;background:${C.navy};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 30px;border-radius:12px;">
          الدخول إلى المقابلة
        </a>
      </td></tr>
      <tr><td style="padding:6px 0 0;font-size:12px;color:${C.mute};">
        أو انسخ الرابط: <span dir="ltr" style="color:${C.blue};word-break:break-all;">${esc(v.link)}</span>
      </td></tr>` : '';

  const tips = cancelled ? `
      <p style="margin:20px 0 0;font-size:13px;color:${C.mute};line-height:1.9;">
        سنتواصل معك لاحقاً لتحديد موعد بديل. شكراً لتفهّمك.
      </p>` : `
      <div style="margin-top:24px;background:${C.bg};border-radius:12px;padding:16px 18px;">
        <div style="font-size:13px;font-weight:700;color:${C.navy};margin-bottom:8px;">قبل المقابلة</div>
        <div style="font-size:13px;color:${C.mute};line-height:2;">
          • انضم قبل الموعد بخمس دقائق.<br>
          • اختر مكاناً هادئاً وتأكد من استقرار الإنترنت.<br>
          • جهّز هويتك الوطنية وتأكد من عمل الكاميرا والمايكروفون.
        </div>
      </div>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v.company)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl"
         style="max-width:580px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Tahoma,Arial,'Segoe UI',sans-serif;">
    <tr><td style="background:${C.navy};padding:24px 28px;">
      <div style="color:#ffffff;font-size:17px;font-weight:700;">${esc(v.company)}</div>
      <div style="color:#9fb3d6;font-size:12px;margin-top:4px;">إدارة التوظيف</div>
    </td></tr>
    <tr><td style="padding:28px;">
      <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:${C.navy};">مرحباً ${esc(v.name)}،</p>
      <p style="margin:0 0 18px;font-size:14px;color:${C.mute};line-height:1.9;">${intro}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="border-top:1px solid ${C.line};border-bottom:1px solid ${C.line};">
        ${rows}
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0">${cta}</table>
      ${tips}
    </td></tr>
    <tr><td style="background:#fafbfc;border-top:1px solid ${C.line};padding:16px 28px;font-size:11px;color:#8b9199;line-height:1.8;">
      هذه رسالة آلية من نظام التوظيف — يمكنك الرد عليها مباشرة للتواصل معنا.
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function buildEmailText(applicant, interview, opts = {}) {
  const kind = opts.kind || 'scheduled';
  return (WA_TEXT[kind] || buildWhatsAppText)(applicant, interview, opts);
}

function buildEmailSubject(applicant, interview, opts = {}) {
  const v = messageVars(applicant, interview, opts);
  const kind = opts.kind || 'scheduled';
  if (kind === 'cancelled')   return `إلغاء موعد المقابلة — ${v.company}`;
  if (kind === 'rescheduled') return `تعديل موعد مقابلتك — ${v.date} الساعة ${v.time}`;
  return `موعد مقابلتك مع ${v.company} — ${v.date} الساعة ${v.time}`;
}

module.exports = {
  toIntlPhone, isEmail, deriveJobTitle,
  messageVars, VAR_LABELS, buildProcessedParams, sanitizeParam,
  buildWhatsAppText, buildRescheduleText, buildCancelText, buildInfoRequestText, WA_TEXT, buildWaUrl,
  buildEmailHtml, buildEmailText, buildEmailSubject,
};
