/**
 * chatwoot.js
 * عميل خفيف لـ Chatwoot Application API — إرسال قوالب واتساب المعتمدة
 * عبر صندوق Twilio المربوط في النسخة المستضافة ذاتياً.
 *
 * لماذا fetch مباشرة بدل حزمة؟ نفس منطق utils/google.js: أربعة نداءات REST
 * فقط، وصفر اعتماديات جديدة ⇒ لا npm install يدوي على الخادم بعد النشر.
 *
 * ⚠️ عزل: هذا الملف لا يرمي عند التحميل إطلاقاً — كل تحقق كسول داخل
 *    isConfigured()، حتى لا يمنع غياب متغير بيئة إقلاع النظام.
 *
 * ⚠️ قاعدة واتساب: خارج نافذة الـ 24 ساعة لا تمر إلا رسالة قالب معتمد
 *    (Approved). لذلك كل الإرسال هنا يمر عبر template_params — ولا نرسل
 *    رسالة حرّة أبداً.
 */

const TIMEOUT_MS = 12000;

class ChatwootError extends Error {
  constructor(message, code = 'HTTP', status = null, body = null) {
    super(message);
    this.name = 'ChatwootError';
    this.code = code;              // NOT_CONFIGURED | TIMEOUT | HTTP | NO_SOURCE
    this.status = status;
    this.body = body;
  }
}

// ─── الإعداد ─────────────────────────────────────────────────────────────────
const cfg = () => ({
  host:    String(process.env.CHATWOOT_HOST || '').trim().replace(/\/+$/, ''),
  account: String(process.env.CHATWOOT_ACCOUNT_ID || '').trim(),
  inbox:   parseInt(process.env.CHATWOOT_INBOX_ID, 10),
  token:   String(process.env.CHATWOOT_API_TOKEN || '').trim(),
});

function isConfigured() {
  const c = cfg();
  return Boolean(c.host && c.account && Number.isFinite(c.inbox) && c.inbox > 0 && c.token);
}

function requireConfigured() {
  if (!isConfigured()) {
    throw new ChatwootError('تكامل Chatwoot غير مهيأ — راجع متغيرات البيئة', 'NOT_CONFIGURED');
  }
}

// ملخّص آمن للعرض في صفحة الإعدادات — بلا أي جزء من الرمز السري
function status() {
  const c = cfg();
  return {
    configured: isConfigured(),
    host: c.host || '',
    account: c.account || '',
    inbox: Number.isFinite(c.inbox) ? c.inbox : null,
    hasToken: Boolean(c.token),
  };
}

// 05XXXXXXXX → +9665XXXXXXXX (صيغة E.164 التي يطلبها Chatwoot)
function toE164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (/^05\d{8}$/.test(d))   return `+966${d.slice(1)}`;
  if (/^5\d{8}$/.test(d))    return `+966${d}`;
  if (/^9665\d{8}$/.test(d)) return `+${d}`;
  if (/^009665\d{8}$/.test(d)) return `+${d.slice(2)}`;
  return d.length >= 10 ? `+${d}` : '';
}

// ─── نداء عام ────────────────────────────────────────────────────────────────
//  idempotent:true فقط للقراءة. لا يُعاد POST /messages أبداً — إعادة بعد
//  timeout قد تُرسل رسالتين للمتقدم (ويُحاسَب عليهما في Twilio).
async function cwfetch(path, { method = 'GET', body, idempotent = false, retried = false, op = '' } = {}) {
  requireConfigured();
  const c = cfg();
  let res;
  try {
    res = await fetch(`${c.host}/api/v1/accounts/${c.account}${path}`, {
      method,
      headers: { api_access_token: c.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ChatwootError('انتهت مهلة الاتصال بـ Chatwoot', 'TIMEOUT');
  }

  if ((res.status === 429 || res.status >= 500) && idempotent && !retried) {
    await new Promise(r => setTimeout(r, 700));
    return cwfetch(path, { method, body, idempotent, retried: true, op });
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.message || data?.error || data?.errors?.[0] || `Chatwoot HTTP ${res.status}`;
    console.error(`[Chatwoot] HTTP ${res.status} ${op} — ${msg}`);
    throw new ChatwootError(String(msg), 'HTTP', res.status, data);
  }
  return data;
}

// الاستجابات تختلف بين الإصدارات: payload قد تكون الكائن نفسه أو { contact: {...} }
const unwrapContact = (d) => d?.payload?.contact || d?.payload || d || null;

function sourceIdFor(contact, inboxId) {
  const boxes = contact?.contact_inboxes || [];
  const mine = boxes.find(b => Number(b?.inbox?.id ?? b?.inbox_id) === Number(inboxId));
  return mine?.source_id || null;
}

// ─── القوالب المتزامنة ───────────────────────────────────────────────────────
//  Chatwoot يحتفظ بنسخة من قوالب Twilio المعتمدة على الصندوق نفسه، وتُحدَّث
//  بزر «Sync Templates». نقرأها لسببين:
//   • بناء نص الرسالة من القالب المعتمد نفسه بدل نسخة مكتوبة يدوياً تتقادم.
//   • التحقق من عدد المتغيّرات قبل الإرسال، فلا نقع في الخطأ #132000.
//  قالب غير مزامَن ⇒ يرفضه Chatwoot بـ «Template not found»، ونكشفه مبكراً
//  برسالة عربية تشرح الحل بدل خطأ غامض بعد الإرسال.

let tplCache = { at: 0, list: null };
const TPL_TTL_MS = 5 * 60 * 1000;

async function listTemplates({ fresh = false } = {}) {
  if (!fresh && tplCache.list && Date.now() - tplCache.at < TPL_TTL_MS) return tplCache.list;
  const c = cfg();
  const data = await cwfetch(`/inboxes/${c.inbox}`, { idempotent: true, op: 'inbox' });
  const box = data?.payload || data || {};
  const list = box?.content_templates?.templates || [];
  tplCache = { at: Date.now(), list };
  return list;
}

const tplName = (t) => String(t?.name || t?.friendly_name || '').trim();

/** يبحث بالاسم واللغة — واللغة اختيارية لأن بعض الحسابات تسجّل لغة واحدة فقط */
async function findTemplate(name, language, opts = {}) {
  const want = String(name || '').trim();
  if (!want) return null;
  const list = await listTemplates(opts);
  const byName = list.filter(t => tplName(t) === want);
  if (!byName.length) return null;
  const lang = String(language || '').trim();
  return byName.find(t => String(t.language || '').trim() === lang) || byName[0];
}

/** عدد المتغيّرات الفريدة في نص القالب — مصدر الحقيقة لعدّ processed_params */
function templateVarCount(tpl) {
  const found = String(tpl?.body || '').match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  return new Set(found.map(x => x.replace(/\D/g, ''))).size;
}

/** نص القالب بعد تعبئة {{n}} من processed_params — هو ما يصل المتقدم فعلاً */
function renderTemplate(tpl, params) {
  const p = params || {};
  return String(tpl?.body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => (p[n] != null ? p[n] : m));
}

// ─── جهة الاتصال ─────────────────────────────────────────────────────────────
/**
 * يبحث عن جهة الاتصال بالرقم، وينشئها إن لم توجد، ويضمن ارتباطها بصندوقنا.
 * @returns {{contactId:number, sourceId:string}}
 */
async function ensureContact({ name, phone }) {
  const c = cfg();
  const e164 = toE164(phone);
  if (!e164) throw new ChatwootError('رقم جوال غير صالح لصيغة E.164', 'HTTP');

  // 1) بحث — نتجنّب إنشاء نسخة مكرّرة لجهة اتصال موجودة
  let contact = null;
  try {
    const found = await cwfetch(`/contacts/search?q=${encodeURIComponent(e164)}`, {
      idempotent: true, op: 'searchContact',
    });
    const list = found?.payload || [];
    contact = list.find(x => toE164(x?.phone_number) === e164) || null;
  } catch (e) {
    if (e.code === 'TIMEOUT') throw e;   // انقطاع شبكة — لا نُنشئ نسخة مكرّرة على العمياء
    console.error('[Chatwoot] search:', e.message);
  }

  // 2) إنشاء عند الحاجة — التعارض (رقم موجود) يُعالَج ببحث ثانٍ لا بخطأ
  if (!contact) {
    try {
      const created = await cwfetch('/contacts', {
        method: 'POST', op: 'createContact',
        body: { inbox_id: c.inbox, name: String(name || '').trim() || e164, phone_number: e164 },
      });
      contact = unwrapContact(created);
    } catch (e) {
      if (e.status !== 422) throw e;
      const again = await cwfetch(`/contacts/search?q=${encodeURIComponent(e164)}`, {
        idempotent: true, op: 'searchContact(retry)',
      });
      contact = (again?.payload || []).find(x => toE164(x?.phone_number) === e164) || null;
      if (!contact) throw e;
    }
  }

  const contactId = contact?.id;
  if (!contactId) throw new ChatwootError('تعذّر تحديد جهة الاتصال في Chatwoot', 'HTTP');

  // 3) source_id هو مفتاح المحادثة في هذا الصندوق تحديداً — قد يغيب إن أُنشئت
  //    جهة الاتصال سابقاً من صندوق آخر، فنربطها بصندوقنا صراحةً
  let sourceId = sourceIdFor(contact, c.inbox);
  if (!sourceId) {
    const linked = await cwfetch(`/contacts/${contactId}/contact_inboxes`, {
      method: 'POST', op: 'linkInbox', body: { inbox_id: c.inbox },
    });
    sourceId = linked?.source_id || linked?.payload?.source_id || null;
  }
  if (!sourceId) throw new ChatwootError('تعذّر ربط جهة الاتصال بصندوق واتساب', 'NO_SOURCE');

  return { contactId, sourceId };
}

// ─── المحادثة ────────────────────────────────────────────────────────────────
// نُعيد استخدام محادثة مفتوحة إن وُجدت — كل إشعار في محادثة جديدة يُغرق
// صندوق الوكلاء بمحادثات لمتقدم واحد.
async function findOpenConversation(contactId) {
  const c = cfg();
  try {
    const data = await cwfetch(`/contacts/${contactId}/conversations`, {
      idempotent: true, op: 'listConversations',
    });
    const list = data?.payload || data || [];
    const mine = (Array.isArray(list) ? list : [])
      .filter(cv => Number(cv?.inbox_id) === Number(c.inbox) && cv?.status !== 'resolved');
    mine.sort((a, b) => (b?.id || 0) - (a?.id || 0));
    return mine[0]?.id || null;
  } catch (e) {
    console.error('[Chatwoot] conversations:', e.message);
    return null;                 // الفشل هنا يعني «أنشئ محادثة جديدة» لا إفشال الإرسال
  }
}

/**
 * إرسال رسالة قالب واتساب معتمد.
 *
 * @param {object}  a
 * @param {string}  a.name      اسم المتقدم (لإنشاء جهة الاتصال)
 * @param {string}  a.phone     جوال المتقدم بأي صيغة محلية
 * @param {string}  a.content   النص المُعرَّض — ما يظهر داخل Chatwoot للوكلاء
 * @param {object}  a.template  { name, language, category, processed_params }
 * @returns {{conversationId:number, messageId:number|null}}
 */
async function sendTemplate({ name, phone, content, template }) {
  requireConfigured();
  const c = cfg();
  if (!template?.name || !template?.language) {
    throw new ChatwootError('قالب واتساب غير مكتمل الإعداد (الاسم أو اللغة)', 'NOT_CONFIGURED');
  }

  const { contactId, sourceId } = await ensureContact({ name, phone });

  const template_params = {
    name:     template.name,
    category: template.category || 'UTILITY',
    language: template.language,
    processed_params: template.processed_params || {},
  };

  const existing = await findOpenConversation(contactId);
  if (existing) {
    const msg = await cwfetch(`/conversations/${existing}/messages`, {
      method: 'POST', op: 'sendMessage',
      body: { content, message_type: 'outgoing', template_params },
    });
    return { conversationId: existing, messageId: msg?.id || null };
  }

  // محادثة + رسالة في نداء واحد — يقلّل فرصة بقاء محادثة فارغة عند الانقطاع
  const conv = await cwfetch('/conversations', {
    method: 'POST', op: 'createConversation',
    body: {
      source_id: sourceId,
      inbox_id: c.inbox,
      contact_id: contactId,
      status: 'open',
      message: { content, template_params },
    },
  });
  return { conversationId: conv?.id || null, messageId: null };
}

module.exports = {
  ChatwootError, isConfigured, status, toE164, ensureContact, sendTemplate,
  listTemplates, findTemplate, templateVarCount, renderTemplate,
};
