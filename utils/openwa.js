/**
 * openwa.js
 * عميل خفيف لـ OpenWA — بوابة واتساب مستضافة ذاتياً (whatsapp.intshar.sa)
 * مربوطة برقم واتساب عادي عبر واتساب ويب. مزوّد بديل لـ Chatwoot يُختار من
 * الإعدادات («مزوّد الإرسال»)، والرجوع إلى Chatwoot من المكان نفسه.
 *
 * الفرق الجوهري عن Chatwoot: لا قوالب معتمدة هنا — الرسالة نص حر. فنص القالب
 * المعتمد نفسه يُقرأ من Chatwoot ويُعبّأ ثم يُرسل نصاً (utils/notify.js)، فيصل
 * المتقدم الكلام ذاته أياً كان المزوّد.
 *
 * ⚠️ عزل: هذا الملف لا يرمي عند التحميل إطلاقاً — كل تحقق كسول داخل
 *    isConfigured()، حتى لا يمنع غياب متغير بيئة إقلاع النظام.
 */

const TIMEOUT_MS = 15000;
const netError = require('./netError');
const M = require('./interviewMsg');

class OpenWaError extends Error {
  constructor(message, code = 'HTTP', status = null) {
    super(message);
    this.name = 'OpenWaError';
    this.code = code;              // NOT_CONFIGURED | TIMEOUT | NETWORK | HTTP
    this.status = status;
  }
}

// ─── الإعداد ─────────────────────────────────────────────────────────────────
const cfg = () => ({
  base:    (String(process.env.OPENWA_BASE_URL || '').trim() || 'https://whatsapp.intshar.sa/api').replace(/\/+$/, ''),
  key:     String(process.env.OPENWA_API_KEY || '').trim(),
  session: String(process.env.OPENWA_SESSION_ID || '').trim(),
});

function isConfigured() {
  const c = cfg();
  return Boolean(c.key && c.session);
}

// ملخّص آمن للعرض في صفحة الإعدادات — بلا أي جزء من المفتاح
function status() {
  const c = cfg();
  return { configured: isConfigured(), base: c.base, session: c.session, hasKey: Boolean(c.key) };
}

// ─── نداء عام ────────────────────────────────────────────────────────────────
//  لا إعادة محاولة لأي POST: إعادة بعد انقطاع قد تُرسل الرسالة مرتين.
async function owfetch(path, { method = 'GET', body, op = '', timeoutMs = TIMEOUT_MS } = {}) {
  if (!isConfigured()) throw new OpenWaError('تكامل OpenWA غير مهيأ — راجع متغيرات البيئة', 'NOT_CONFIGURED');
  const c = cfg();
  let res;
  const t0 = Date.now();
  try {
    res = await fetch(`${c.base}/sessions/${encodeURIComponent(c.session)}${path}`, {
      method,
      headers: { 'X-API-Key': c.key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const d = netError.describe(e);
    console.error(`[OpenWA] ${op || method} ${path.split('?')[0]} — ${netError.line(e, t0)}`);
    throw new OpenWaError(`تعذّر الاتصال بـ OpenWA: ${d.label}`, d.isTimeout ? 'TIMEOUT' : 'NETWORK');
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const raw = data?.message;
    const msg = (Array.isArray(raw) ? raw.join('، ') : raw) || data?.error || `OpenWA HTTP ${res.status}`;
    console.error(`[OpenWA] HTTP ${res.status} ${op} — ${msg}`);
    throw new OpenWaError(String(msg), 'HTTP', res.status);
  }
  return data;
}

// 05XXXXXXXX → 9665XXXXXXXX@c.us (معرّف المحادثة في واتساب ويب)
function chatIdFor(phone) {
  const d = M.toIntlPhone(phone);
  return d.length >= 10 ? `${d}@c.us` : '';
}

/** حالة جلسة الرقم — للإعدادات: هل artal متصل الآن؟ مهلة قصيرة: تُنتظر عند فتح الصفحة */
async function session() {
  const s = await owfetch('', { op: 'session', timeoutMs: 5000 });
  return { status: String(s?.status || ''), phone: String(s?.phone || ''), name: String(s?.pushName || s?.name || '') };
}

// ─── إعادة المحاولة ──────────────────────────────────────────────────────────
//  OpenWA خادم واحد ورقم عبر واتساب ويب: انقطاعات قصيرة متوقعة (إعادة اتصال
//  الجلسة، ضغط لحظي). نعيد بصمت مرتين على الأكثر، والموظف لا يرى إلا النتيجة.
//
//  ⚠️ قبل كل إعادة نسأل OpenWA: هل خرجت الرسالة فعلاً؟ انتهاء المهلة لا يعني
//     أن الإرسال لم يتم — قد يكون أرسل ثم تأخر رده. بلا هذا الفحص تصل المتقدم
//     رسالتان.
//  السقف الزمني يحمي الموظف من انتظار طويل: المهلات المتتالية تأخذ محاولتين
//  لا ثلاثاً، والأخطاء السريعة (رفض اتصال، 5xx) تأخذ الثلاث.
const SEND_TIMEOUT_MS = 12000;
const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = [2000, 5000];
const RETRY_BUDGET_MS = 25000;   // لا تبدأ محاولة جديدة بعد هذا الزمن من الأولى

const isRetryable = (e) => ['TIMEOUT', 'NETWORK'].includes(e.code) || [408, 425, 429].includes(e.status) || e.status >= 500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// السبب بلغة الموظف — النص التقني يبقى في سجل الاستقرار (detail)
function explain(e) {
  if (e.code === 'NOT_CONFIGURED') return 'تكامل OpenWA غير مهيأ — أبلغ المدير';
  if (e.code === 'TIMEOUT') return 'خادم واتساب (OpenWA) لم يرد في الوقت';
  if (e.code === 'NETWORK') return 'تعذّر الوصول إلى خادم واتساب (OpenWA)';
  if (e.status === 401 || e.status === 403) return 'مفتاح OpenWA مرفوض — أبلغ المدير';
  if (e.status === 404) return 'رقم الإرسال غير موجود في OpenWA — أبلغ المدير';
  if (/not\s*(ready|connected)|disconnected/i.test(e.message)) return 'رقم واتساب الإرسال غير متصل الآن — أبلغ المدير ليعيد ربطه';
  if (e.status === 429) return 'OpenWA يطلب التمهّل — إرسال كثير في وقت قصير';
  if (e.status >= 500) return 'خادم واتساب (OpenWA) متعطل مؤقتاً';
  return `رفض OpenWA الرسالة: ${e.message}`;
}

/** رسالة خرجت فعلاً منذ لحظة الإرسال بالنص نفسه؟ — رقمها، أو null */
async function findSent(chatId, text, since) {
  const data = await owfetch(`/messages?chatId=${encodeURIComponent(chatId)}&limit=10`, { op: 'findSent', timeoutMs: 5000 });
  const want = String(text).trim();
  const hit = (data?.messages || []).find(m =>
    m?.direction === 'outgoing' &&
    String(m.body || '').trim() === want &&
    Number(m.timestamp || 0) * 1000 >= since - 5000);
  return hit?.waMessageId ? String(hit.waMessageId) : null;
}

/**
 * إرسال رسالة نصية — مع إعادة محاولة آمنة من التكرار.
 *
 * يرمي OpenWaError برسالة عربية مفهومة للموظف، ومعها attempts وdetail (النص
 * التقني الأصلي) لسجل الاستقرار.
 *
 * @returns {{provider:'openwa', messageId:string, chatId:string, since:number, attempts:number, lastError:object|null}}
 *          يمرّ كما هو إلى messageStatus — ونفس دور ناتج chatwoot.sendTemplate.
 *          lastError = خطأ محاولة سابقة تجاوزتها الإعادة (للسجل وحده)
 */
async function sendText({ phone, text }) {
  const chatId = chatIdFor(phone);
  if (!chatId) throw new OpenWaError('رقم جوال غير صالح', 'HTTP');
  const since = Date.now();
  let lastError = null;

  for (let attempt = 1; ; attempt++) {
    try {
      const r = await owfetch('/messages/send-text', {
        method: 'POST', op: `sendText#${attempt}`, body: { chatId, text }, timeoutMs: SEND_TIMEOUT_MS,
      });
      if (!r?.messageId) throw new OpenWaError('لم يُرجع OpenWA رقم الرسالة', 'NO_ID');
      return { provider: 'openwa', messageId: String(r.messageId), chatId, since, attempts: attempt, lastError };
    } catch (e) {
      lastError = { code: e.status ? `HTTP_${e.status}` : (e.code || 'ERROR'), detail: e.message };
      const wait = RETRY_WAIT_MS[attempt - 1] || 0;
      const canRetry = isRetryable(e) && attempt < MAX_ATTEMPTS && Date.now() - since + wait < RETRY_BUDGET_MS;
      if (!canRetry) {
        const tail = attempt > 1 ? ` — جُرّب الإرسال ${attempt} مرات. أعد المحاولة بعد دقائق، وإن تكرر فأبلغ المدير` : '';
        const err = new OpenWaError(`${explain(e)}${tail}`, e.code, e.status);
        Object.assign(err, { attempts: attempt, detail: e.message });
        throw err;
      }

      await sleep(wait);
      const already = await findSent(chatId, text, since).catch(() => null);
      if (already) {
        console.log(`[OpenWA] attempt ${attempt} failed (${lastError.code}) but the message was sent — no resend`);
        return { provider: 'openwa', messageId: already, chatId, since, attempts: attempt, lastError };
      }
      console.warn(`[OpenWA] attempt ${attempt} failed (${lastError.code}: ${e.message}) — retrying`);
    }
  }
}

/**
 * حالة الرسالة بعد الإرسال — بنفس مفردات Chatwoot (sent/delivered/read/failed)
 * فيعمل فحص التسليم المؤجَّل في notify.js على المزوّدين بلا تفرقة.
 * @returns {{status:string, error:string}|null}  null = لم نعثر على الرسالة
 */
async function messageStatus({ messageId, chatId }) {
  if (!messageId || !chatId) return null;
  const data = await owfetch(`/messages?chatId=${encodeURIComponent(chatId)}&limit=20`, { op: 'messageStatus' });
  const msg = (data?.messages || []).find(m => String(m?.waMessageId) === String(messageId));
  if (!msg) return null;
  return { status: String(msg.status || ''), error: String(msg.metadata?.error || '').trim() };
}

module.exports = { OpenWaError, isConfigured, status, chatIdFor, session, sendText, messageStatus };
