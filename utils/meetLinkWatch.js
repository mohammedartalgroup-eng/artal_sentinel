/**
 * meetLinkWatch.js
 * ينتظر رابط Meet المتأخر في الخلفية، يحفظه، ثم يرسل إشعار الجدولة المؤجَّل.
 *
 * لماذا؟ Google ينشئ الاجتماع بعد الحدث بثوانٍ أحياناً، وطلب الجدولة لا يملك
 * أن ينتظر أكثر من ثوانٍ قليلة. الإشعار في notify.js يُؤجَّل حين يغيب الرابط
 * (لا دعوة بلا رابط)، وهذا الملف هو من يُكمل ذلك التأجيل: يستعلم عن الرابط
 * كل بضع ثوانٍ لدقائق، وحين يصل يحفظه ويرسل الإشعار بالبيانات نفسها.
 *
 * ⚠️ داخل العملية فقط: تُفقد المراقبة عند إعادة تشغيل الخادم، وهذا مقبول —
 *    زرّا «تحديث الرابط» و«إعادة الإرسال» في بطاقة المتقدم يبقيان طريقاً
 *    يدوياً، والشارات الرمادية تعرض السبب.
 *
 * ⚠️ لا يرمي أبداً، ولا يُعيق استجابة الجدولة: watchMeetLink تعود فوراً.
 */

const db     = require('../database/db');
const google = require('./google');
const notify = require('./notify');

const EVERY_MS  = 5000;
const MAX_TRIES = 36;                 // ≈ 3 دقائق — بعدها يُترك الأمر للموظف

const active = new Set();             // مقابلة واحدة = مراقب واحد
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run({ interview, applicant, settings, actor }) {
  const id = interview.id;

  for (let i = 1; i <= MAX_TRIES; i++) {
    await sleep(EVERY_MS);

    let ev;
    try { ev = await google.getEvent(interview.eventId); }
    catch (e) { continue; }                                   // انقطاع عابر — الدورة التالية

    if (ev.conferenceStatus === 'failure') {
      // لن يأتي رابط مهما انتظرنا — نثبّت السبب على المقابلة ليراه الموظف
      console.error(`[MeetWatch] #${id}: Google أعلن فشل إنشاء اجتماع Meet`);
      await db.run("UPDATE interviews SET last_error = ? WHERE id = ? AND status = 'scheduled'",
        ['Google لم يُنشئ اجتماع Meet لهذا الحدث', id]).catch(() => {});
      return;
    }
    if (!ev.meetLink) continue;

    // الحفظ مشروط بأن الرابط ما زال فارغاً والمقابلة قائمة: لو حدّثه الموظف
    // بزر «تحديث الرابط» أثناء الانتظار فقد انتقلت الملكية إليه — نتوقف بلا
    // إرسال كي لا يصل المتقدم إشعاران (هو سيعيد الإرسال بزره)
    const upd = await db.run(
      `UPDATE interviews SET meet_link = ?, html_link = COALESCE(?, html_link)
        WHERE id = ? AND status = 'scheduled' AND (meet_link IS NULL OR meet_link = '')`,
      [ev.meetLink, ev.htmlLink, id]
    );
    if (upd.affectedRows === 0) {
      console.log(`[MeetWatch] #${id}: الرابط حُفظ من مسار آخر أو أُلغيت المقابلة — لا إرسال`);
      return;
    }

    console.log(`[MeetWatch] #${id}: وصل رابط Meet بعد ${(i * EVERY_MS) / 1000}s — إرسال الإشعار المؤجَّل`);
    const delivery = await notify.notifyInterview({
      applicant, kind: 'scheduled', settings, actor,
      interview: { ...interview, meetLink: ev.meetLink, htmlLink: ev.htmlLink, pendingLink: false },
    });

    const summary = Object.entries(delivery).map(([ch, r]) => `${ch}:${r.status}`).join(' | ');
    try {
      await db.run(
        'INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
        [applicant.id, `وصل رابط Meet: ${ev.meetLink}\nأُرسل إشعار الموعد للمتقدم تلقائياً (${summary})`, 'interview', actor || null]
      );
      await db.logActivity(applicant.id, 'إشعار المقابلة', null, `تلقائي بعد وصول رابط Meet — ${summary}`.slice(0, 255), actor || null);
    } catch (e) { console.error('[MeetWatch] log:', e.message); }
    return;
  }

  console.error(`[MeetWatch] #${id}: انتهت المهلة (${(MAX_TRIES * EVERY_MS) / 1000}s) بلا رابط Meet — بانتظار الموظف`);
}

/**
 * يبدأ المراقبة ويعود فوراً.
 *
 * @param {object} a
 * @param {object} a.interview  كائن المقابلة كما يُمرَّر لـ notifyInterview + eventId
 * @param {object} a.applicant  { id, full_name, phone, email }
 * @param {object} a.settings   ناتج db.getSettings()
 * @param {string} [a.actor]    اسم الموظف — للسجل
 */
function watchMeetLink(a) {
  const id = a?.interview?.id;
  if (!id || !a.interview.eventId || active.has(id)) return;
  active.add(id);
  run(a)
    .catch(e => console.error(`[MeetWatch] #${id}:`, e.message))
    .finally(() => active.delete(id));
}

module.exports = { watchMeetLink, EVERY_MS, MAX_TRIES };
