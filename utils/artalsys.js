/**
 * artalsys.js — عميل الدفع إلى النظام الأساسي (artalsys.com).
 *
 * الاتجاه المعاكس لـ utils/extCheck.js: ذاك يسأل النظام الأساسي عن متقدم،
 * وهذا يسلّمه موظفاً جديداً بحصيلة رحلة الاستكمال.
 *
 * ⚠️ لا يرمي عند التحميل، وكل تحقق كسول. وغياب الإعداد يعني «زر المزامنة
 *    مخفي» لا «النظام معطّل» — كبقية تكاملات هذا المشروع.
 */

const TIMEOUT_MS = 20000;

function baseUrl() {
  return String(process.env.ARTALSYS_URL || 'https://artalsys.com').replace(/\/$/, '');
}

function isConfigured() {
  return Boolean(process.env.ARTALSYS_PUSH_SECRET) && process.env.ARTALSYS_SYNC_ENABLED !== 'false';
}

async function call(path, { method = 'GET', body = null, timeout = TIMEOUT_MS } = {}) {
  if (!isConfigured()) throw new Error('تكامل النظام الأساسي غير مهيأ');

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'X-Secret': process.env.ARTALSYS_PUSH_SECRET,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });

  // الطرف الآخر يردّ JSON في كل الحالات — وإن جاء HTML فهي صفحة خطأ من الخادم
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ليس JSON */ }

  if (!json) {
    throw new Error(`رد غير مفهوم من النظام الأساسي (HTTP ${res.status})`);
  }
  return { status: res.status, ok: res.ok, json };
}

// القوائم المغلقة (المسميات، المواقع) — تُخبَّأ خمس دقائق فهي شبه ثابتة
let optionsCache = { at: 0, data: null };

async function options({ fresh = false } = {}) {
  if (!fresh && optionsCache.data && Date.now() - optionsCache.at < 5 * 60 * 1000) {
    return optionsCache.data;
  }
  const r = await call('/api/hooks/onboarding/options');
  if (!r.ok) throw new Error(r.json?.error || `تعذّر جلب القوائم (HTTP ${r.status})`);
  optionsCache = { at: Date.now(), data: r.json };
  return r.json;
}

/**
 * دفع الموظف. dryRun = فحص كامل بلا إنشاء — تستدعيه الواجهة قبل عرض الزر.
 *
 * @returns {{status:number, ok:boolean, json:object}} الرد كما هو: 201 أُنشئ،
 *          409 تعارض (هوية أو جوال)، 422 بيانات ناقصة، 503 الاستقبال مطفأ.
 */
async function pushEmployee(payload, { dryRun = false } = {}) {
  return call(`/api/hooks/onboarding/employee${dryRun ? '?dry_run=1' : ''}`, {
    method: 'POST',
    body: payload,
    timeout: dryRun ? TIMEOUT_MS : 45000,
  });
}

/**
 * رفع مرفق واحد إلى ملف الموظف.
 *
 * ملف لكل نداء: حدود الرفع في الطرف الآخر معلومة (10MB للملف)، وفشل ملف لا
 * يُسقط البقية. و`sourceDocumentId` يمنع التكرار عند إعادة الضغط — الطرف الآخر
 * يفحصه ويرد المرفق القائم بدل إنشاء نسخة ثانية.
 */
async function uploadAttachment(employeeId, { buffer, fileName, mime, category, title, notes, sourceDocumentId }) {
  if (!isConfigured()) throw new Error('تكامل النظام الأساسي غير مهيأ');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), fileName);
  form.append('category', category);
  if (title) form.append('title', title);
  if (notes) form.append('notes', notes);
  if (sourceDocumentId != null) form.append('source_document_id', String(sourceDocumentId));

  const res = await fetch(`${baseUrl()}/api/hooks/onboarding/employee/${employeeId}/attachment`, {
    method: 'POST',
    headers: { 'X-Secret': process.env.ARTALSYS_PUSH_SECRET, Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* ليس JSON */ }
  if (!json) throw new Error(`رد غير مفهوم عند رفع المرفق (HTTP ${res.status})`);

  return { status: res.status, ok: res.ok, json };
}

module.exports = { isConfigured, baseUrl, options, pushEmployee, uploadAttachment };
