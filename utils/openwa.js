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

/**
 * إرسال رسالة نصية.
 * @returns {{provider:'openwa', messageId:string, chatId:string, since:number}}
 *          يمرّ كما هو إلى messageStatus — ونفس دور ناتج chatwoot.sendTemplate
 */
async function sendText({ phone, text }) {
  const chatId = chatIdFor(phone);
  if (!chatId) throw new OpenWaError('رقم جوال غير صالح', 'HTTP');
  const since = Date.now();
  const r = await owfetch('/messages/send-text', { method: 'POST', op: 'sendText', body: { chatId, text } });
  if (!r?.messageId) throw new OpenWaError('لم يُرجع OpenWA رقم الرسالة — لم يتأكد الإرسال', 'HTTP');
  return { provider: 'openwa', messageId: String(r.messageId), chatId, since };
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
