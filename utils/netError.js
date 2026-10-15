/**
 * netError.js — تسمية فشل fetch باسمه الحقيقي.
 *
 * fetch في Node يرمي نوعين لا يفرّق بينهما المستخدم: TimeoutError من
 * AbortSignal.timeout، وTypeError «fetch failed» يخفي السبب في cause
 * (ENOTFOUND, ECONNREFUSED, ECONNRESET, ETIMEDOUT, شهادة…). كانت كل عملائنا
 * تطبع «انتهت المهلة» لأي منهما، فكان الخطأ بلا أثر يُتتبّع. هذه الدالة تعيد
 * الرمز والوصف العربي والتفصيل الخام، ليُكتب في السجل ويُعرض للموظف.
 */

const LABELS = {
  TIMEOUT:      'انتهت المهلة ولم يصل رد',
  ENOTFOUND:    'تعذّر حلّ اسم الخادم (DNS)',
  EAI_AGAIN:    'تعذّر حلّ اسم الخادم مؤقتاً (DNS)',
  ECONNREFUSED: 'الخادم يرفض الاتصال',
  ECONNRESET:   'انقطع الاتصال أثناء الطلب',
  ETIMEDOUT:    'لم يستجب الخادم لطلب الاتصال',
  EHOSTUNREACH: 'لا مسار إلى الخادم',
  ENETUNREACH:  'الشبكة غير متاحة',
  EPIPE:        'انقطع الاتصال أثناء الإرسال',
  CERT:         'شهادة TLS غير صالحة',
  ABORTED:      'أُلغي الطلب',
  // undici (محرّك fetch) له مهلاته الخاصة قبل مهلتنا: الاتصال 10 ثوانٍ افتراضياً
  UND_ERR_CONNECT_TIMEOUT: 'لم يستجب الخادم لطلب الاتصال (TCP)',
  UND_ERR_HEADERS_TIMEOUT: 'قبل الخادم الاتصال ولم يرسل رداً',
  UND_ERR_BODY_TIMEOUT:    'توقف الخادم أثناء إرسال الرد',
  UND_ERR_SOCKET:          'انقطع الاتصال أثناء الطلب',
};

/**
 * @param {Error} e خطأ fetch (أو أي خطأ شبكي)
 * @returns {{ code: string, label: string, detail: string, isTimeout: boolean }}
 */
function describe(e) {
  let cause = e?.cause;
  if (cause && Array.isArray(cause.errors) && cause.errors.length) cause = cause.errors[0];

  const text = String(cause?.message || e?.message || e || '');
  // code قد يكون رقماً (DOMException: TimeoutError.code = 23) — لا يُعتدّ إلا بالنصّي
  const str = (v) => (typeof v === 'string' && v ? v : null);
  let code = str(e?.code) || str(cause?.code) || null;

  if (!code) {
    if (e?.name === 'TimeoutError') code = 'TIMEOUT';
    else if (e?.name === 'AbortError') code = 'ABORTED';
    else code = text.match(/\b(E[A-Z]{3,}|EAI_AGAIN)\b/)?.[1] || null;
  }
  if (code && /^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS_CERT)/.test(code)) code = 'CERT';
  if (code === 'ABORT_ERR' && e?.name === 'TimeoutError') code = 'TIMEOUT';
  if (!code) code = 'NETWORK';

  const label = LABELS[code] || 'خطأ شبكي';
  return { code, label, detail: text.slice(0, 160), isTimeout: code === 'TIMEOUT' };
}

/** سطر جاهز للسجل: «انتهت المهلة ولم يصل رد بعد 12003ms (TIMEOUT: The operation was aborted…)» */
function line(e, startedAt) {
  const d = describe(e);
  const took = startedAt ? ` بعد ${Date.now() - startedAt}ms` : '';
  return `${d.label}${took} (${d.code}: ${d.detail})`;
}

module.exports = { describe, line };
