/**
 * notify.js
 * إشعار المتقدم بموعد مقابلته — واتساب (Chatwoot) وبريد (SMTP) معاً.
 *
 * ⚠️ العقد الأهم في هذا الملف: **لا يرمي أبداً**. يُنادى بعد أن يكون اجتماع
 *    Google قد أُنشئ فعلاً، فلا يجوز لفشل رسالة أن يُفشل الجدولة أو يحذف
 *    الاجتماع. كل قناة معزولة عن الأخرى، وكل محاولة تُسجَّل في
 *    interview_messages بحالتها وسبب فشلها — الفشل الصامت هو العدو هنا.
 *
 * القنوات تعمل بالتوازي لا بالتسلسل: زمن الاستجابة = أبطأ قناة، لا مجموعهما.
 */

const db       = require('../database/db');
const mailer   = require('./mailer');
const chatwoot = require('./chatwoot');
const M        = require('./interviewMsg');

const KINDS = ['scheduled', 'rescheduled', 'cancelled'];
const clip = (s, n = 255) => String(s == null ? '' : s).slice(0, n);

// ─── قراءة إعداد القالب لنوع إشعار معيّن ─────────────────────────────────────
function templateFor(settings, kind) {
  return {
    name:     String(settings[`wa_tpl_${kind}_name`] || '').trim(),
    language: String(settings[`wa_tpl_${kind}_lang`] || 'ar').trim(),
    category: String(settings[`wa_tpl_${kind}_cat`]  || 'UTILITY').trim(),
    vars:     String(settings[`wa_tpl_${kind}_vars`] || '').trim(),
    shape:    settings.wa_params_shape === 'structured' ? 'structured' : 'numbered',
  };
}

// خيارات بناء النص — مشتركة بين القناتين حتى لا يذكر البريد وظيفة والواتساب أخرى.
// المسمّى المثبَّت على المقابلة يغلب دائماً: إعادة الإرسال بعد أسابيع يجب أن
// ترسل نفس النص الذي وافق عليه الموظف وقت الجدولة، لا اشتقاقاً جديداً.
function msgOpts(interview, settings) {
  return {
    companyName: settings.company_name,
    reason: interview.reason,
    jobTitle: interview.jobTitle || '',
    settings,
  };
}

/**
 * يبني نص الرسالة من القالب المعتمد في Chatwoot نفسه، ويتحقق من عدد
 * المتغيّرات قبل الإرسال.
 *
 * لماذا من Chatwoot لا من نص مكتوب عندنا؟ لأن أي نسخة يدوية تتقادم لحظة
 * تعديل القالب في ميتا، فيقرأ الموظف نصاً ويصل المتقدم نصٌ آخر. وكذلك
 * يمنع الخطأ #132000 قبل وقوعه بدل تفسير رسالة غامضة بعده.
 *
 * لا يرمي: تعذّر القراءة يُرجع { ok:true } بالنص الاحتياطي، فانقطاع مؤقت
 * في Chatwoot لا يمنع محاولة الإرسال.
 *
 * @returns {{ok:boolean, reason?:string, content?:string}}
 */
async function resolveTemplateBody(tpl, params, fallbackText) {
  try {
    const found = await chatwoot.findTemplate(tpl.name, tpl.language);
    if (!found) {
      return {
        ok: false,
        reason: `القالب «${tpl.name}» غير موجود في قوالب Chatwoot — اضغط «Sync Templates» على صندوق واتساب بعد اعتماده في Twilio/Meta`,
      };
    }
    const need = chatwoot.templateVarCount(found);
    const have = Object.keys(params || {}).length;
    if (need !== have) {
      return {
        ok: false,
        reason: `عدد المتغيّرات لا يطابق القالب: يحتاج ${need} ونرسل ${have} — صحّح «ترتيب المتغيّرات» في الإعدادات`,
      };
    }
    return { ok: true, content: chatwoot.renderTemplate(found, params) };
  } catch (e) {
    console.error('[Notify] template lookup:', e.message);
    return { ok: true, content: fallbackText };   // انقطاع مؤقت — لا نمنع الإرسال
  }
}

async function log({ interviewId, applicantId, channel, kind, status, target, ref, error, actor }) {
  try {
    await db.run(
      `INSERT INTO interview_messages
         (interview_id, applicant_id, channel, kind, status, target, provider_ref, error, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [interviewId, applicantId, channel, kind, status,
       clip(target, 160), clip(ref, 120), clip(error), clip(actor, 100)]
    );
  } catch (e) {
    // السجل نفسه فشل — نطبع ولا نُفشل الإرسال الذي نجح
    console.error('[Notify] log:', e.message);
  }
}

// ─── قناة واتساب ─────────────────────────────────────────────────────────────
async function sendWhatsApp({ applicant, interview, kind, settings, actor }) {
  const out = { channel: 'whatsapp', status: 'skipped', reason: '' };

  if (settings.notify_whatsapp_enabled !== 'true') { out.reason = 'قناة واتساب مُطفأة من الإعدادات'; return out; }
  if (!chatwoot.isConfigured())                    { out.reason = 'تكامل Chatwoot غير مهيأ'; return out; }

  const phone = chatwoot.toE164(applicant.phone);
  if (!phone) { out.reason = 'لا يوجد رقم جوال صالح'; return out; }

  const tpl = templateFor(settings, kind);
  if (!tpl.name) { out.reason = `لم يُحدَّد قالب واتساب لإشعار «${kind}»`; return out; }

  const opts   = msgOpts(interview, settings);
  const vars   = M.messageVars(applicant, interview, opts);
  const params = M.buildProcessedParams(vars, tpl.vars, tpl.shape);
  const fallback = (M.WA_TEXT[kind] || M.buildWhatsAppText)(applicant, interview, opts);

  const body = await resolveTemplateBody(tpl, params, fallback);
  if (!body.ok) { out.reason = body.reason; return out; }

  try {
    const r = await chatwoot.sendTemplate({
      name: applicant.full_name, phone: applicant.phone, content: body.content,
      template: {
        name: tpl.name, language: tpl.language, category: tpl.category,
        processed_params: params,
      },
    });
    out.status = 'sent';
    out.ref = r.conversationId ? `conv:${r.conversationId}` : '';
    out.target = phone;
    console.log(`[Notify] whatsapp sent — interview #${interview.id}, conv ${r.conversationId}`);
  } catch (e) {
    out.status = 'failed';
    out.target = phone;
    out.reason = e.message || 'خطأ غير معروف';
    console.error(`[Notify] whatsapp FAILED — interview #${interview.id}: ${out.reason}`);
  }
  return out;
}

// ─── قناة البريد ─────────────────────────────────────────────────────────────
async function sendEmail({ applicant, interview, kind, settings, actor }) {
  const out = { channel: 'email', status: 'skipped', reason: '' };

  if (settings.notify_email_enabled !== 'true') { out.reason = 'قناة البريد مُطفأة من الإعدادات'; return out; }
  if (!mailer.isConfigured())                   { out.reason = 'إعدادات SMTP غير مكتملة'; return out; }

  const to = String(applicant.email || '').trim();
  if (!M.isEmail(to)) { out.reason = 'لا يوجد بريد إلكتروني للمتقدم'; return out; }

  const opts = { ...msgOpts(interview, settings), kind };
  try {
    const r = await mailer.sendMail({
      to,
      subject: M.buildEmailSubject(applicant, interview, opts),
      html:    M.buildEmailHtml(applicant, interview, opts),
      text:    M.buildEmailText(applicant, interview, opts),
    });
    out.status = 'sent';
    out.ref = r.messageId || '';
    out.target = to;
    console.log(`[Notify] email sent — interview #${interview.id} → ${to}`);
  } catch (e) {
    out.status = 'failed';
    out.target = to;
    out.reason = e.message || 'خطأ غير معروف';
    console.error(`[Notify] email FAILED — interview #${interview.id}: ${out.reason}`);
  }
  return out;
}

const SENDERS = { whatsapp: sendWhatsApp, email: sendEmail };

/**
 * يُرسل الإشعار على القنوات المطلوبة ويسجّل كل محاولة.
 * لا يرمي — يُرجع دائماً { whatsapp:{...}, email:{...} }.
 *
 * @param {object}   a
 * @param {object}   a.applicant   { id, full_name, phone, email }
 * @param {object}   a.interview   { id, startMs, durationMin, meetLink, interviewers, reason? }
 * @param {string}   a.kind        scheduled | rescheduled | cancelled
 * @param {object}   a.settings    ناتج db.getSettings()
 * @param {string}   [a.actor]     اسم الموظف — للسجل
 * @param {string[]} [a.channels]  الافتراضي: القناتان
 */
async function notifyInterview({ applicant, interview, kind, settings, actor, channels }) {
  const result = {};
  try {
    if (!KINDS.includes(kind)) kind = 'scheduled';
    const list = (Array.isArray(channels) && channels.length ? channels : ['whatsapp', 'email'])
      .filter(ch => SENDERS[ch]);

    const settled = await Promise.allSettled(
      list.map(ch => SENDERS[ch]({ applicant, interview, kind, settings, actor }))
    );

    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      const r = settled[i].status === 'fulfilled'
        ? settled[i].value
        : { channel: ch, status: 'failed', reason: settled[i].reason?.message || 'خطأ غير متوقع' };
      result[ch] = r;

      await log({
        interviewId: interview.id, applicantId: applicant.id, channel: ch, kind,
        status: r.status, target: r.target, ref: r.ref, error: r.reason, actor,
      });
    }
  } catch (e) {
    console.error('[Notify] orchestrator:', e.message);   // الحزام الأخير — لا يخرج خطأ من هنا
  }
  return result;
}

// ─── قوالب واتساب غير المرتبطة بمقابلة ───────────────────────────────────────
/**
 * إرسال قالب معتمد لمتقدم مباشرة (طلب استكمال بيانات …) وتسجيله في
 * applicant_messages. لا يرمي — يُعيد { status, reason } دائماً.
 *
 * ⚠️ لا يفحص notify_whatsapp_enabled عمداً: ذاك المفتاح يحكم الإشعار
 *    التلقائي عند الجدولة، بينما هذا فعل يدوي صريح من الموظف بضغطة زر.
 *
 * @param {object} a
 * @param {object} a.applicant  { id, full_name, phone, region, landing_page }
 * @param {string} a.tplKey     مفتاح إعدادات القالب (مثل 'screening')
 * @param {string} a.kind       اسم النوع في السجل (مثل 'screening')
 * @param {object} [a.vars]     تجاوزات المتغيّرات { jobTitle, region, city }
 */
async function sendApplicantTemplate({ applicant, tplKey, kind, vars = {}, settings, actor }) {
  // المحاولة في دالة داخلية ليصل كل مسار — بما فيه الخروج المبكر — إلى
  // التسجيل أدناه. الـ return المباشر كان يتخطّى السجل ويُخفي محاولات skipped.
  const attempt = async (out) => {
    if (!chatwoot.isConfigured()) { out.reason = 'تكامل Chatwoot غير مهيأ'; return; }

    const phone = chatwoot.toE164(applicant.phone);
    if (!phone) { out.reason = 'لا يوجد رقم جوال صالح'; return; }
    out.target = phone;

    const tpl = templateFor(settings, tplKey);
    if (!tpl.name) { out.reason = 'لم يُحدَّد اسم القالب في الإعدادات'; return; }

    const opts = { companyName: settings.company_name, settings, ...vars };
    const v = M.messageVars(applicant, null, opts);

    // متغيّر فارغ يرفضه واتساب — نوقف قبل الإرسال برسالة مفهومة بدل خطأ Meta الغامض
    const needed = String(tpl.vars || '').split(',').map(x => x.trim()).filter(Boolean);
    const empty = needed.filter(k => !String(v[k] ?? '').trim());
    if (empty.length) {
      out.reason = `متغيّرات ناقصة: ${empty.map(k => M.VAR_LABELS[k] || k).join('، ')}`;
      return;
    }

    const params = M.buildProcessedParams(v, tpl.vars, tpl.shape);
    const fallback = (M.WA_TEXT[kind] || M.buildScreeningText)(applicant, null, opts);

    const body = await resolveTemplateBody(tpl, params, fallback);
    if (!body.ok) { out.reason = body.reason; return; }

    const r = await chatwoot.sendTemplate({
      name: applicant.full_name, phone: applicant.phone, content: body.content,
      template: {
        name: tpl.name, language: tpl.language, category: tpl.category,
        processed_params: params,
      },
    });
    out.status = 'sent';
    out.ref = r.conversationId ? `conv:${r.conversationId}` : '';
    out.vars = v;
    console.log(`[Notify] ${kind} sent — applicant #${applicant.id}, conv ${r.conversationId}`);
  };

  const out = { status: 'skipped', reason: '' };
  try {
    await attempt(out);
  } catch (e) {
    out.status = 'failed';
    out.reason = e.message || 'خطأ غير معروف';
    console.error(`[Notify] ${kind} FAILED — applicant #${applicant.id}: ${out.reason}`);
  }

  try {
    await db.run(
      `INSERT INTO applicant_messages
         (applicant_id, channel, kind, status, target, provider_ref, error, created_by)
       VALUES (?, 'whatsapp', ?, ?, ?, ?, ?, ?)`,
      [applicant.id, kind, out.status, clip(out.target, 160), clip(out.ref, 120),
       clip(out.reason), clip(actor, 100)]
    );
  } catch (e) { console.error('[Notify] applicant log:', e.message); }

  return out;
}

/**
 * آخر حالة لكل قناة في مقابلة — لعرض شارات «أُرسل / فشل» في بطاقة المتقدم.
 * لا يرمي: أي خطأ يُرجع كائناً فارغاً فتختفي الشارات وحدها.
 */
async function deliveryFor(interviewId) {
  try {
    const rows = await db.all(
      `SELECT m.channel, m.kind, m.status, m.target, m.error, m.created_at
         FROM interview_messages m
         JOIN (SELECT channel, MAX(id) AS id FROM interview_messages
                WHERE interview_id = ? GROUP BY channel) last
           ON last.id = m.id`,
      [interviewId]
    );
    return Object.fromEntries(rows.map(r => [r.channel, r]));
  } catch (e) {
    console.error('[Notify] deliveryFor:', e.message);
    return {};
  }
}

module.exports = { notifyInterview, sendApplicantTemplate, deliveryFor, templateFor, KINDS };
