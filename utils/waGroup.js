/**
 * waGroup.js
 * نسخة داخلية من موعد المقابلة إلى مجموعة واتساب عبر Wappi.pro.
 *
 * لماذا مزوّد ثانٍ بجانب Chatwoot؟ لأن قوالب واتساب المعتمدة تُرسل إلى رقم
 * متقدم واحد، ولا يمكن إرسال قالب إلى مجموعة. المجموعات لا تقبل إلا رسالة
 * حرّة، وهي مسموحة هنا لأن المستقبِل مجموعتنا الداخلية لا عميل.
 *
 * ⚠️ العقد: **لا يرمي أبداً**. تُستدعى بعد أن يكون قالب المتقدم قد أُرسل
 *    فعلاً، فلا يجوز لفشل نسخة داخلية أن يُفشل الجدولة أو يلوّن حالة قناة
 *    المتقدم بالفشل. كل خطأ يُبتلع ويُسجَّل.
 *
 * ⚠️ لا يرمي عند التحميل: كل تحقق كسول داخل isConfigured() حتى لا يمنع
 *    غياب متغيّر بيئة إقلاع النظام.
 */

const M = require('./interviewMsg');

const TIMEOUT_MS = 10000;

// ─── الإعداد ─────────────────────────────────────────────────────────────────
//  WAPPI_GROUP_CHAT_ID يقبل أكثر من وجهة مفصولة بفواصل — مجموعة العمليات
//  ومجموعة الإدارة مثلاً — ولا يلزم تعديل كود لإضافة ثالثة.
//
//  أسماء WAAPI_* مقبولة كمرادف قديم لئلا ينقطع الإرسال على خادم ضُبط قبل
//  تصحيح اسم المزوّد. الاسمان متشابهان لحرف واحد — فالمعتمد WAPPI_* وحده،
//  والقديم يزول متى نُظّف .env على الخادم.
const pick = (...names) => {
  for (const n of names) {
    const v = String(process.env[n] || '').trim();
    if (v) return v;
  }
  return '';
};

const cfg = () => ({
  base:    (pick('WAPPI_BASE_URL') || 'https://wappi.pro/api/sync').replace(/\/+$/, ''),
  profile: pick('WAPPI_PROFILE_ID', 'WAAPI_INSTANCE_ID'),
  token:   pick('WAPPI_TOKEN', 'WAAPI_TOKEN'),
  chats:   pick('WAPPI_GROUP_CHAT_ID', 'WAAPI_GROUP_CHAT_ID')
             .split(',').map(s => s.trim()).filter(Boolean).slice(0, 5),
});

function isConfigured() {
  const c = cfg();
  return Boolean(c.profile && c.token && c.chats.length);
}

// ملخّص آمن للعرض — بلا أي جزء من الرمز السري
function status() {
  const c = cfg();
  return {
    configured: isConfigured(),
    profile: c.profile || '',
    chats: c.chats,
    hasToken: Boolean(c.token),
  };
}

// ─── نداء الإرسال ────────────────────────────────────────────────────────────
//  بلا إعادة محاولة عمداً: Wappi ترسل فعلياً قبل أن ترد أحياناً، وإعادة بعد
//  timeout تعني رسالتين في المجموعة عن موعد واحد.
//
//  ⚠️ ترويسة Authorization بلا بادئة Bearer — هكذا يطلبها Wappi، وإضافتها
//     تُرجع 401 بلا تفسير واضح.
async function sendMessage(recipient, body) {
  const c = cfg();
  if (!isConfigured()) throw new Error('تكامل Wappi غير مهيأ');

  let res;
  try {
    res = await fetch(`${c.base}/message/send?profile_id=${encodeURIComponent(c.profile)}`, {
      method: 'POST',
      headers: {
        Authorization: c.token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ recipient, body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (_) {
    throw new Error('انتهت مهلة الاتصال بـ Wappi');
  }

  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}

  const detail = String(data?.detail || data?.message || data?.error || text || '')
    .replace(/\s+/g, ' ').slice(0, 160);
  if (!res.ok) throw new Error(`Wappi ${res.status}${detail ? `: ${detail}` : ''}`);

  // Wappi ترد بـ 200 وحالة error في الجسم أحياناً — الفشل الصامت هو العدو.
  // نرفض ما أُعلن فشله صراحةً فقط، لا ما لم نتعرّف عليه: قيمة نجاح جديدة من
  // المزوّد يجب ألّا تُقرأ فشلاً وتُغرق السجل بأخطاء وهمية.
  const st = String(data?.status || '').toLowerCase();
  if (st === 'error' || st === 'failed') throw new Error(`Wappi ${st}${detail ? `: ${detail}` : ''}`);

  const id = data?.task_id || data?.message_id || data?.id || '';
  return { id: String(id || '') };
}

// ─── نص المجموعة ─────────────────────────────────────────────────────────────
//  رسالة داخلية لا يراها المتقدم: تحمل الجوال والمنطقة ومَن جدول الموعد —
//  وهي المعلومات التي يسأل عنها فريق العمليات في المجموعة أصلاً.
const HEAD = {
  scheduled:   '🗓️ *موعد مقابلة جديد*',
  rescheduled: '🔁 *تعديل موعد مقابلة*',
  cancelled:   '❌ *إلغاء موعد مقابلة*',
};

function buildGroupText({ vars, phone, interview = {}, kind = 'scheduled', actor = '' }) {
  const v = vars || {};
  const cancelled = kind === 'cancelled';
  const intl = M.toIntlPhone(phone);

  const lines = [
    HEAD[kind] || HEAD.scheduled,
    '',
    `👤 الاسم: ${v.name || '—'}`,
    intl ? `📱 الجوال: +${intl}` : null,
    v.job ? `💼 الوظيفة: ${v.job}` : null,
    v.city ? `📍 المدينة: ${v.city}` : null,
    interview.candidateSite ? `🏢 الموقع المرشح: ${interview.candidateSite}` : null,
    '',
    `📅 التاريخ: ${v.date || '—'}`,
    `🕐 الوقت: ${v.time || '—'} (بتوقيت السعودية)`,
    cancelled ? null : (v.duration ? `⏱️ المدة: ${v.duration} دقيقة` : null),
    cancelled ? null : (v.interviewers ? `👥 المقابلون: ${v.interviewers}` : null),
    cancelled ? null : (v.link ? `🔗 رابط Meet: ${v.link}` : null),
    cancelled && v.reason ? `📝 السبب: ${v.reason}` : null,
    '',
    actor ? `بواسطة: ${actor}` : null,
  ].filter(l => l !== null);

  // تنظيف الأسطر الفارغة المتتالية الناتجة عن حقول غائبة
  return lines.filter((l, i) => !(l === '' && lines[i - 1] === '')).join('\n').trim();
}

/**
 * يرسل نسخة الموعد إلى كل مجموعة مضبوطة. **لا يرمي إطلاقاً.**
 *
 * @param {object} a
 * @param {object} a.vars    ناتج interviewMsg.messageVars — نفس القيم التي بُني بها قالب المتقدم
 * @param {string} a.phone   جوال المتقدم كما هو في قاعدة البيانات
 * @param {object} [a.interview]
 * @param {string} [a.kind]  scheduled | rescheduled | cancelled
 * @param {string} [a.actor] اسم الموظف
 * @returns {Promise<Array<{chatId:string, status:'sent'|'failed'|'skipped', ref?:string, reason?:string}>>}
 */
async function notifyGroup({ vars, phone, interview, kind, actor }) {
  if (!isConfigured()) return [];

  const message = buildGroupText({ vars, phone, interview, kind, actor });
  const chats = cfg().chats;

  const settled = await Promise.allSettled(chats.map(id => sendMessage(id, message)));

  return chats.map((chatId, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      console.log(`[WaGroup] sent — ${chatId}${s.value.id ? ` (${s.value.id})` : ''}`);
      return { chatId, status: 'sent', ref: s.value.id };
    }
    const reason = s.reason?.message || 'خطأ غير معروف';
    console.error(`[WaGroup] FAILED — ${chatId}: ${reason}`);
    return { chatId, status: 'failed', reason };
  });
}

module.exports = { isConfigured, status, sendMessage, buildGroupText, notifyGroup };
