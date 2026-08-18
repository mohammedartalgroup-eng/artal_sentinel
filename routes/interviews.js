/**
 * interviews.js
 * جدولة المقابلات الأونلاين عبر Google Meet.
 *
 * يُركَّب داخل routes/admin.js بعد requireAuth ووسيط res.locals، لذا كل المسارات
 * هنا محمية بتسجيل الدخول وتملك دوال التاريخ.
 *
 * ⚠️ عزل خط الاستقطاب: كل مسار هنا يمر بـ requireInterviews (علم المخطط + مفتاح
 *    الإيقاف)، ولا يُنادى Google إلا بفعل صريح من المستخدم — لا عند تحميل صفحة.
 */

const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const db        = require('../database/db');
const google    = require('../utils/google');
const S         = require('../utils/slots');
const notify    = require('../utils/notify');
const { buildWhatsAppText, buildWaUrl, isEmail, deriveJobTitle } = require('../utils/interviewMsg');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIPE = ['pending', 'reviewed', 'shortlisted', 'interviewed', 'hired'];

// ─── محدِّدات المعدل ─────────────────────────────────────────────────────────
const availabilityLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 60,
  message: { error: 'طلبات كثيرة — انتظر قليلاً' },
  standardHeaders: true, legacyHeaders: false,
});
const scheduleLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 20,
  message: { error: 'طلبات كثيرة — انتظر قليلاً' },
  standardHeaders: true, legacyHeaders: false,
});

// ─── بوابة الميزة ────────────────────────────────────────────────────────────
async function requireInterviews(req, res, next) {
  try {
    if (!db.INTERVIEWS_SCHEMA_OK) {
      return res.status(503).json({ error: 'ميزة المقابلات غير مهيأة على هذا الخادم', code: 'IV_OFF' });
    }
    const s = await db.getSettings();
    if (s.interviews_enabled !== 'true') {
      return res.status(503).json({ error: 'ميزة المقابلات موقوفة مؤقتاً', code: 'IV_OFF' });
    }
    req.ivSettings = s;
    next();
  } catch (err) {
    console.error('[Interview] gate', err.message);
    res.status(503).json({ error: 'ميزة المقابلات غير متاحة حالياً', code: 'IV_OFF' });
  }
}

// نسخة تعرض صفحة بدل JSON (لصفحة القائمة)
async function requireInterviewsPage(req, res, next) {
  try {
    const s = db.INTERVIEWS_SCHEMA_OK ? await db.getSettings() : null;
    if (!s || s.interviews_enabled !== 'true') {
      return res.status(503).render('interviews', {
        rows: [], counts: { today: 0, week: 0, upcoming: 0 }, interviewerList: [],
        filters: { range: 'upcoming', interviewer: '', status: '' },
        page: 1, totalPages: 1, total: 0, disabled: true, googleConn: null,
        adminUser: req.session.adminUser,
      });
    }
    req.ivSettings = s;
    next();
  } catch (err) {
    console.error('[Interview] gate(page)', err.message);
    res.status(500).send('خطأ في تحميل صفحة المقابلات');
  }
}

// ─── أدوات مشتركة ────────────────────────────────────────────────────────────
function mapGoogleError(err, res) {
  if (err instanceof google.GoogleError) {
    if (err.code === 'DISCONNECTED' || err.code === 'NOT_CONFIGURED') {
      return res.status(409).json({ error: err.message, code: 'GOOGLE_DISCONNECTED' });
    }
    return res.status(503).json({ error: 'تعذّر الاتصال بتقويم Google — حاول بعد قليل', code: 'GOOGLE_UNAVAILABLE' });
  }
  console.error('[Interview]', err.message);
  return res.status(500).json({ error: 'خطأ غير متوقع' });
}

async function activeInterviewers() {
  return db.all(
    "SELECT id, username, full_name FROM admin_users WHERE is_active = 1 ORDER BY COALESCE(full_name, username) ASC"
  );
}

// يتحقق أن كل إيميل يعود لمستخدم نشط — ويُعيد القائمة منظّفة
async function validateInterviewers(list) {
  const wanted = [...new Set((Array.isArray(list) ? list : [])
    .map(e => String(e || '').trim().toLowerCase()).filter(e => EMAIL_RE.test(e)))];
  if (!wanted.length) return { emails: [], rows: [] };
  const rows = (await activeInterviewers())
    .filter(u => wanted.includes(String(u.username || '').toLowerCase()));
  return { emails: rows.map(u => u.username), rows };
}

// المواعيد المحجوزة عندنا (حزام أمان فوق Free/Busy)
async function takenKeys(fromMs) {
  const rows = await db.all(
    "SELECT slot_key FROM interviews WHERE status IN ('pending','scheduled') AND slot_key IS NOT NULL AND start_at >= ?",
    [new Date(fromMs)]
  );
  return rows.map(r => r.slot_key);
}

/**
 * يكتب ملاحظة من نوع «مقابلة» في ملف المتقدم — بنفس أثر إضافتها يدوياً.
 *
 * ⚠️ سطر التدقيق ليس زخرفة: تقرير الأداء (routes/admin.js) يعدّ من audit_log
 *    حيث action='note_add' و details LIKE 'مقابلة:%'. بدونه تظهر الملاحظة في
 *    التايملاين لكن عمود «المقابلات» في التقرير يبقى صفراً. نفس صيغة السطر
 *    المستخدمة في مسار الملاحظات اليدوي: `${label}: ${أول 80 حرفاً}`.
 *
 * لا يرمي أبداً — تُنادى بعد إنشاء الحدث في Google فلا يجوز أن تُفشل الطلب.
 */
async function addInterviewNote(req, applicantId, applicantName, content) {
  try {
    await db.run(
      'INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
      [applicantId, content, 'interview', req.session.adminName || null]
    );
    await db.audit(req.session.adminId, req.session.adminUser, 'note_add', 'applicant',
      applicantId, applicantName || null, `مقابلة: ${content.replace(/\s+/g, ' ').trim().substring(0, 80)}`, req.ip);
  } catch (e) {
    console.error('[Interview] note:', e.message);
  }
}

function publicInterview(row, rowsByEmail = {}) {
  const startMs = new Date(row.start_at).getTime();
  return {
    id: row.id,
    startMs,
    endMs: new Date(row.end_at).getTime(),
    startLocal: row.start_local,
    dateLabel: S.arabicDate(startMs),
    timeLabel: S.localTime(startMs),
    durationMin: row.duration_min,
    jobTitle: row.job_title || '',
    meetLink: row.meet_link,
    htmlLink: row.html_link,
    status: row.status,
    pendingLink: !row.meet_link,
    interviewers: String(row.interviewers || '').split(',').filter(Boolean)
      .map(e => ({ email: e, name: rowsByEmail[e] || e })),
  };
}

/**
 * قائمة حضور حدث التقويم = المقابلون + المتقدم (إن كان لديه بريد صالح
 * والإعداد مفعّل). وجود المتقدم كـ attendee هو ما يجعل Google يرسل له دعوة
 * رسمية بمرفق .ics وتذكيرات تلقائية، ويحدّثها فوراً عند إعادة الجدولة.
 *
 * ⚠️ تُستخدم في الإنشاء **وفي إعادة الجدولة** معاً: أي patch يرسل قائمة
 *    حضور بلا المتقدم سيحذفه من الحدث بصمت ويلغي دعوته.
 */
function attendeeList(emails, applicant, settings) {
  const list = emails.map(email => ({ email }));
  const wanted = !settings || settings.notify_applicant_attendee !== 'false';
  const mail = String(applicant?.email || '').trim();
  if (wanted && isEmail(mail) && !emails.some(e => e.toLowerCase() === mail.toLowerCase())) {
    list.push({ email: mail, displayName: applicant.full_name || undefined, optional: false });
  }
  return list;
}

function eventSpec({ applicant, startMs, endMs, emails, interviewId, note, settings, interviewerNames, jobTitle }) {
  const desc = [
    'مقابلة توظيف أونلاين عبر Google Meet',
    `المتقدم: ${applicant.full_name}`,
    jobTitle ? `الوظيفة: ${jobTitle}` : null,
    `الجوال: ${applicant.phone || '—'}`,
    `رقم الطلب: #${applicant.id}`,
    // تُذكر الأسماء في الوصف لأن قائمة الحضور مخفية عن المدعوين (أدناه)
    interviewerNames ? `المقابلون: ${interviewerNames}` : null,
    note ? `ملاحظة: ${note}` : null,
  ].filter(Boolean).join('\n');

  return {
    summary: `مقابلة توظيف — ${applicant.full_name}`,
    description: desc,
    start: { dateTime: S.toRfc3339(startMs), timeZone: 'Asia/Riyadh' },
    end:   { dateTime: S.toRfc3339(endMs),   timeZone: 'Asia/Riyadh' },
    attendees: attendeeList(emails, applicant, settings),
    conferenceData: {
      createRequest: {
        requestId: `artal-${applicant.id}-${interviewId}-${startMs}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    // المتقدم مدعوّ خارجي — إخفاء قائمة الحضور يمنع تسريب بُرُد الموظفين إليه
    guestsCanSeeOtherGuests: false,
    reminders: { useDefault: true },
    extendedProperties: {
      private: { artal_applicant_id: String(applicant.id), artal_interview_id: String(interviewId) },
    },
  };
}

// ─── أ. الأوقات المتاحة ──────────────────────────────────────────────────────
router.get('/interviews/availability', requireInterviews, availabilityLimiter, async (req, res) => {
  try {
    const rules = S.parseRules(req.ivSettings);
    const conn = await google.getConnection();
    if (!conn.connected) {
      return res.status(409).json({ error: 'لم يتم ربط حساب Google بعد', code: 'GOOGLE_DISCONNECTED' });
    }

    const requested = String(req.query.interviewers || '').split(',').map(s => s.trim()).filter(Boolean);
    const { emails } = await validateInterviewers(requested);

    const now = Date.now();
    const p = S.localParts(now);
    const timeMinMs = S.fromLocal(p.y, p.mo, p.d);                       // بداية اليوم بتوقيت الرياض
    const timeMaxMs = timeMinMs + rules.horizonDays * 86400000;

    const calendarIds = [conn.email, ...emails].filter(Boolean);
    const { busy, errors } = await google.freeBusy({ timeMinMs, timeMaxMs, calendarIds });

    const days = S.computeSlots({ nowMs: now, rules, busy, taken: await takenKeys(timeMinMs) });

    const warnings = Object.keys(errors).map(
      email => `تعذّر قراءة تقويم ${email} — قد تظهر أوقات مشغولة كأنها متاحة`
    );

    res.json({ ok: true, tz: 'Asia/Riyadh', duration: rules.durationMin, generatedAt: now, days, warnings });
  } catch (err) {
    mapGoogleError(err, res);
  }
});

// ─── ب. جدولة مقابلة ─────────────────────────────────────────────────────────
router.post('/applicants/:id/interview', requireInterviews, scheduleLimiter, async (req, res) => {
  let insertId = null;
  try {
    const rules = S.parseRules(req.ivSettings);
    const slotKey = String(req.body.slotKey || '');
    if (!/^\d{12}$/.test(slotKey)) return res.status(400).json({ error: 'موعد غير صالح' });

    const startMs = S.keyToMs(slotKey);
    const endMs   = startMs + rules.durationMin * 60000;
    // الخادم يشتق الوقت من المفتاح ويعيد التحقق — نافذة بقيت مفتوحة لا تحجز موعداً منتهياً
    const invalid = S.validateSlot(startMs, rules, Date.now());
    if (invalid) return res.status(400).json({ error: invalid });

    const { emails, rows: ivRows } = await validateInterviewers(req.body.interviewers);
    if (!emails.length) return res.status(400).json({ error: 'اختر مقابلاً واحداً على الأقل' });
    if (emails.length > 5) return res.status(400).json({ error: 'الحد الأقصى خمسة مقابلين' });

    const applicant = await db.get('SELECT id, full_name, phone, email, status FROM applicants WHERE id = ?', [req.params.id]);
    if (!applicant) return res.status(404).json({ error: 'المتقدم غير موجود' });

    const nameByEmail = Object.fromEntries(ivRows.map(u => [u.username, u.full_name || u.username]));
    const namesText   = emails.map(e => nameByEmail[e] || e).join('، ');

    const existing = await db.get(
      "SELECT id FROM interviews WHERE applicant_id = ? AND status = 'scheduled'", [applicant.id]
    );
    if (existing) return res.status(409).json({ error: 'لدى هذا المتقدم مقابلة مجدولة بالفعل', code: 'ALREADY_SCHEDULED' });

    const note = String(req.body.note || '').trim().slice(0, 500);
    // قالب واتساب المعتمد يذكر الوظيفة، ولا عمود لها في جدول المتقدمين —
    // فيغلب اختيار الموظف، وإلا يُشتق من صفحة الوظيفة التي قدّم منها
    const jobTitle = String(req.body.jobTitle || '').trim().slice(0, 100)
      || deriveJobTitle(applicant, req.ivSettings);

    // 1) الصف هو القفل — يُؤخذ قبل نداء Google ويبقى محجوزاً طوال الرحلة
    try {
      const ins = await db.run(
        `INSERT INTO interviews
           (applicant_id, start_at, end_at, start_local, duration_min, slot_key, status, interviewers, job_title, created_by, created_by_id)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        [applicant.id, new Date(startMs), new Date(endMs), S.localStamp(startMs), rules.durationMin,
         slotKey, emails.join(','), jobTitle, req.session.adminName || null, req.session.adminId || null]
      );
      insertId = ins.insertId;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        console.log(`[Interview] slot conflict — ${slotKey}`);
        return res.status(409).json({ error: 'حُجز هذا الموعد للتو — اختر موعداً آخر', code: 'SLOT_TAKEN' });
      }
      throw e;
    }

    // 2) تأكيد أن الموعد ما زال خالياً في تقويم Google
    const conn = await google.getConnection();
    const { busy } = await google.freeBusy({
      timeMinMs: startMs - rules.bufferMin * 60000,
      timeMaxMs: endMs + rules.bufferMin * 60000,
      calendarIds: [conn.email, ...emails].filter(Boolean),
    });
    if (busy.some(b => startMs < b.end && endMs > b.start)) {
      await db.run('DELETE FROM interviews WHERE id = ?', [insertId]);
      return res.status(409).json({ error: 'أصبح هذا الموعد مشغولاً — اختر موعداً آخر', code: 'SLOT_TAKEN' });
    }

    // 3) إنشاء الحدث — بلا إعادة محاولة (تفادي اجتماع مكرر)
    let ev;
    try {
      ev = await google.createEvent(eventSpec({
        applicant, startMs, endMs, emails, interviewId: insertId, note,
        settings: req.ivSettings, interviewerNames: namesText, jobTitle,
      }));
    } catch (e) {
      if (e instanceof google.GoogleError && e.code === 'TIMEOUT') {
        // قد يكون الحدث أُنشئ فعلاً — نُبقي الصف للتسوية اليدوية
        await db.run('UPDATE interviews SET last_error = ? WHERE id = ?', ['timeout أثناء الإنشاء', insertId]);
        console.error(`[Interview] #${insertId} timeout أثناء إنشاء الحدث — بانتظار التسوية`);
        return res.status(503).json({
          error: 'انقطع الاتصال أثناء الإنشاء — قد يكون الموعد أُنشئ في التقويم. راجع صفحة المقابلات.',
          code: 'GOOGLE_TIMEOUT', interviewId: insertId,
        });
      }
      await db.run('DELETE FROM interviews WHERE id = ?', [insertId]);
      return mapGoogleError(e, res);
    }

    // 4) تثبيت النتيجة
    try {
      await db.run(
        `UPDATE interviews SET status = 'scheduled', google_event_id = ?, meet_link = ?, html_link = ?, last_error = NULL WHERE id = ?`,
        [ev.eventId, ev.meetLink, ev.htmlLink, insertId]
      );
    } catch (e) {
      try {
        await db.run(
          `UPDATE interviews SET status = 'scheduled', google_event_id = ?, meet_link = ?, html_link = ? WHERE id = ?`,
          [ev.eventId, ev.meetLink, ev.htmlLink, insertId]
        );
      } catch (e2) {
        console.error(`[Interview] ORPHAN EVENT ${ev.eventId} for applicant #${applicant.id} — DB update failed: ${e2.message}`);
        try { await google.deleteEvent(ev.eventId); } catch (_) {}
        return res.status(500).json({ error: 'تعذّر حفظ الموعد — أعد المحاولة' });
      }
    }
    console.log(`[Interview] #${insertId} created — event ${ev.eventId}, applicant #${applicant.id}`);

    // 5) الآثار الجانبية — كلٌ في try/catch مستقل: لا تُفشل الطلب بعد إنشاء الحدث
    const dateLabel = S.arabicDate(startMs);
    const timeLabel = S.localTime(startMs);

    let statusChanged = null;
    try {
      const ci = PIPE.indexOf(applicant.status);
      const ti = PIPE.indexOf('shortlisted');
      // on_hold و rejected فهرسهما -1 فتُترك دون مساس — الجدولة لا تُحيي مرفوضاً بصمت
      if (ci !== -1 && ci < ti) {
        await db.run('UPDATE applicants SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['shortlisted', applicant.id]);
        statusChanged = 'shortlisted';
        await db.logActivity(applicant.id, 'تغيير الحالة', 'تلقائي (جدولة مقابلة)', 'مرشح للمقابلة', req.session.adminName || null);
      }
    } catch (e) { console.error('[Interview] status transition:', e.message); }

    const lines = [
      `مقابلة أونلاين — ${dateLabel}، الساعة ${timeLabel} (${rules.durationMin} دقيقة)`,
      `المقابلون: ${namesText}`,
      ev.meetLink ? `رابط Meet: ${ev.meetLink}` : 'رابط Meet: قيد الإنشاء',
      note ? `ملاحظة: ${note}` : null,
    ].filter(Boolean);
    await addInterviewNote(req, applicant.id, applicant.full_name, lines.join('\n'));

    try {
      await db.logActivity(applicant.id, 'جدولة مقابلة', null, `${dateLabel} — ${timeLabel}`, req.session.adminName || null);
    } catch (e) { console.error('[Interview] activity:', e.message); }

    await db.audit(req.session.adminId, req.session.adminUser, 'interview_schedule', 'applicant',
      applicant.id, applicant.full_name, `${S.localStamp(startMs)} — ${emails.join(', ')}`, req.ip);

    const iv = {
      id: insertId, startMs, endMs, startLocal: S.localStamp(startMs), dateLabel, timeLabel,
      durationMin: rules.durationMin, jobTitle, meetLink: ev.meetLink, htmlLink: ev.htmlLink,
      status: 'scheduled', pendingLink: !ev.meetLink,
      interviewers: emails.map(e => ({ email: e, name: nameByEmail[e] || e })),
    };
    const waText = buildWhatsAppText(applicant, iv, { companyName: req.ivSettings.company_name });

    // إشعار المتقدم — القناتان بالتوازي. notifyInterview لا يرمي إطلاقاً، ونتيجته
    // تعود للواجهة فوراً حتى يعرف الموظف إن لم تصل الرسالة ويعيد الإرسال بزر.
    const delivery = await notify.notifyInterview({
      applicant, interview: iv, kind: 'scheduled',
      settings: req.ivSettings, actor: req.session.adminName || req.session.adminUser,
    });

    res.json({
      ok: true, interview: iv, statusChanged, delivery,
      whatsappUrl: buildWaUrl(applicant.phone, waText),
    });
  } catch (err) {
    if (insertId) { try { await db.run("DELETE FROM interviews WHERE id = ? AND status = 'pending'", [insertId]); } catch (_) {} }
    mapGoogleError(err, res);
  }
});

// ─── ج. إعادة الجدولة ────────────────────────────────────────────────────────
router.patch('/interviews/:iid', requireInterviews, scheduleLimiter, async (req, res) => {
  try {
    const rules = S.parseRules(req.ivSettings);
    const row = await db.get('SELECT * FROM interviews WHERE id = ?', [req.params.iid]);
    if (!row) return res.status(404).json({ error: 'المقابلة غير موجودة' });
    if (row.status !== 'scheduled') return res.status(409).json({ error: 'لا يمكن تعديل مقابلة غير مجدولة' });

    const slotKey = String(req.body.slotKey || '');
    if (!/^\d{12}$/.test(slotKey)) return res.status(400).json({ error: 'موعد غير صالح' });
    const startMs = S.keyToMs(slotKey);
    const endMs   = startMs + rules.durationMin * 60000;
    const invalid = S.validateSlot(startMs, rules, Date.now());
    if (invalid) return res.status(400).json({ error: invalid });

    let emails = String(row.interviewers || '').split(',').filter(Boolean);
    if (Array.isArray(req.body.interviewers) && req.body.interviewers.length) {
      const v = await validateInterviewers(req.body.interviewers);
      if (!v.emails.length) return res.status(400).json({ error: 'اختر مقابلاً واحداً على الأقل' });
      emails = v.emails;
    }

    // يُقرأ قبل patchEvent: قائمة الحضور المرسَلة تستبدل القديمة بالكامل، فلو
    // بُنيت بلا بريد المتقدم لحُذف من الحدث وأُلغيت دعوته بصمت
    const applicant = await db.get('SELECT id, full_name, phone, email FROM applicants WHERE id = ?', [row.applicant_id]);

    const prev = { slot_key: row.slot_key, start_at: row.start_at, end_at: row.end_at, start_local: row.start_local, interviewers: row.interviewers };

    // القفل أولاً: الفهرس الفريد يمنع التصادم مع حجز متزامن
    try {
      const upd = await db.run(
        `UPDATE interviews SET slot_key = ?, start_at = ?, end_at = ?, start_local = ?, duration_min = ?, interviewers = ?
         WHERE id = ? AND status = 'scheduled'`,
        [slotKey, new Date(startMs), new Date(endMs), S.localStamp(startMs), rules.durationMin, emails.join(','), row.id]
      );
      if (upd.affectedRows === 0) return res.status(409).json({ error: 'تغيّرت حالة المقابلة — حدّث الصفحة' });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'حُجز هذا الموعد للتو — اختر موعداً آخر', code: 'SLOT_TAKEN' });
      throw e;
    }

    try {
      // بلا conferenceData حتى يبقى رابط Meet كما هو (قد يكون أُرسل للمرشح)
      await google.patchEvent(row.google_event_id, {
        start: { dateTime: S.toRfc3339(startMs), timeZone: 'Asia/Riyadh' },
        end:   { dateTime: S.toRfc3339(endMs),   timeZone: 'Asia/Riyadh' },
        attendees: attendeeList(emails, applicant, req.ivSettings),
      });
    } catch (e) {
      await db.run(
        'UPDATE interviews SET slot_key = ?, start_at = ?, end_at = ?, start_local = ?, interviewers = ? WHERE id = ?',
        [prev.slot_key, prev.start_at, prev.end_at, prev.start_local, prev.interviewers, row.id]
      );
      return mapGoogleError(e, res);
    }

    const dateLabel = S.arabicDate(startMs);
    const timeLabel = S.localTime(startMs);

    try {
      await db.logActivity(row.applicant_id, 'إعادة جدولة مقابلة', prev.start_local, `${dateLabel} — ${timeLabel}`, req.session.adminName || null);
    } catch (e) { console.error('[Interview] reschedule activity:', e.message); }
    await addInterviewNote(req, row.applicant_id, applicant?.full_name,
      `مقابلة أونلاين — أُعيدت جدولتها إلى ${dateLabel}، الساعة ${timeLabel}`);

    await db.audit(req.session.adminId, req.session.adminUser, 'interview_reschedule', 'applicant',
      row.applicant_id, applicant?.full_name, `${prev.start_local} ← ${S.localStamp(startMs)}`, req.ip);

    const fresh = await db.get('SELECT * FROM interviews WHERE id = ?', [row.id]);
    const users = await activeInterviewers();
    const nameByEmail = Object.fromEntries(users.map(u => [u.username, u.full_name || u.username]));
    const iv = publicInterview(fresh, nameByEmail);
    const waText = buildWhatsAppText(applicant || {}, iv, { companyName: req.ivSettings.company_name });

    const delivery = applicant ? await notify.notifyInterview({
      applicant, interview: iv, kind: 'rescheduled',
      settings: req.ivSettings, actor: req.session.adminName || req.session.adminUser,
    }) : {};

    res.json({ ok: true, interview: iv, delivery, whatsappUrl: buildWaUrl(applicant?.phone, waText) });
  } catch (err) {
    mapGoogleError(err, res);
  }
});

// ─── د. الإلغاء ──────────────────────────────────────────────────────────────
router.post('/interviews/:iid/cancel', requireInterviews, async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM interviews WHERE id = ?', [req.params.iid]);
    if (!row) return res.status(404).json({ error: 'المقابلة غير موجودة' });
    if (row.status === 'cancelled') return res.json({ ok: true });

    const reason = String(req.body.reason || '').trim().slice(0, 255);
    const force  = req.body.force === true && req.session.adminRole === 'manager';

    if (row.google_event_id) {
      try {
        await google.deleteEvent(row.google_event_id);
      } catch (e) {
        if (!force) {
          return res.status(503).json({
            error: 'تعذّر حذف الحدث من تقويم Google. يمكن للمدير الإلغاء محلياً.',
            code: 'GOOGLE_UNAVAILABLE', canForce: true,
          });
        }
        await db.run('UPDATE interviews SET last_error = ? WHERE id = ?', [`فشل حذف حدث Google: ${e.message}`.slice(0, 255), row.id]);
        console.error(`[Interview] #${row.id} أُلغيت محلياً رغم فشل Google — event ${row.google_event_id}`);
      }
    }

    // slot_key = NULL يحرّر الموعد للحجز مجدداً دون حذف السجل
    await db.run(
      `UPDATE interviews SET status = 'cancelled', slot_key = NULL, cancelled_by = ?, cancel_reason = ?
       WHERE id = ? AND status IN ('pending','scheduled')`,
      [req.session.adminName || null, reason || null, row.id]
    );

    const applicant = await db.get('SELECT id, full_name, phone, email FROM applicants WHERE id = ?', [row.applicant_id]);
    try {
      await db.logActivity(row.applicant_id, 'إلغاء مقابلة', row.start_local, reason || 'بدون سبب', req.session.adminName || null);
    } catch (e) { console.error('[Interview] cancel activity:', e.message); }
    const startedMs = new Date(row.start_at).getTime();
    await addInterviewNote(req, row.applicant_id, applicant?.full_name,
      `أُلغيت مقابلة ${S.arabicDate(startedMs)} الساعة ${S.localTime(startedMs)}${reason ? ` — السبب: ${reason}` : ''}`);

    await db.audit(req.session.adminId, req.session.adminUser, 'interview_cancel', 'applicant',
      row.applicant_id, applicant?.full_name, `${row.start_local}${reason ? ` — ${reason}` : ''}`, req.ip);

    // إشعار الإلغاء اختياري — المتقدم يستقبل إلغاء Google تلقائياً بصفته مدعوّاً،
    // وهذا يضيف رسالة عربية واضحة بالسبب
    const delivery = applicant ? await notify.notifyInterview({
      applicant,
      interview: {
        id: row.id, startMs: startedMs, durationMin: row.duration_min,
        jobTitle: row.job_title || '', meetLink: null, interviewers: [], reason,
      },
      kind: 'cancelled',
      settings: req.ivSettings, actor: req.session.adminName || req.session.adminUser,
    }) : {};

    res.json({ ok: true, delivery });
  } catch (err) {
    mapGoogleError(err, res);
  }
});

// ─── هـ. تحديث رابط Meet المتأخر ─────────────────────────────────────────────
router.post('/interviews/:iid/refresh-link', requireInterviews, async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM interviews WHERE id = ?', [req.params.iid]);
    if (!row || !row.google_event_id) return res.status(404).json({ error: 'المقابلة غير موجودة' });

    const ev = await google.getEvent(row.google_event_id);
    if (!ev.meetLink) return res.status(409).json({ error: 'الرابط لم يجهز بعد — أعد المحاولة بعد قليل' });

    await db.run('UPDATE interviews SET meet_link = ?, html_link = ? WHERE id = ?', [ev.meetLink, ev.htmlLink, row.id]);
    res.json({ ok: true, meetLink: ev.meetLink });
  } catch (err) {
    mapGoogleError(err, res);
  }
});

// ─── و. إعادة إرسال الإشعار للمتقدم ──────────────────────────────────────────
//  الشبكة تتقطع وقوالب واتساب تُرفض — فبدل «حاول جدولة أخرى» يعيد الموظف
//  الإرسال وحده. القناة اختيارية: بلا تحديد تُعاد المحاولة على القناتين.
const notifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20,
  message: { error: 'طلبات كثيرة — انتظر قليلاً' },
  standardHeaders: true, legacyHeaders: false,
});

router.post('/interviews/:iid/notify', requireInterviews, notifyLimiter, async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM interviews WHERE id = ?', [req.params.iid]);
    if (!row) return res.status(404).json({ error: 'المقابلة غير موجودة' });
    if (row.status === 'pending') return res.status(409).json({ error: 'لم تكتمل هذه المقابلة بعد — سوّها أولاً' });

    const applicant = await db.get('SELECT id, full_name, phone, email FROM applicants WHERE id = ?', [row.applicant_id]);
    if (!applicant) return res.status(404).json({ error: 'المتقدم غير موجود' });

    const one = ['whatsapp', 'email'].includes(req.body.channel) ? [req.body.channel] : null;
    const kind = row.status === 'cancelled' ? 'cancelled' : 'scheduled';

    const users = await activeInterviewers();
    const nameByEmail = Object.fromEntries(users.map(u => [u.username, u.full_name || u.username]));

    const delivery = await notify.notifyInterview({
      applicant, interview: publicInterview(row, nameByEmail), kind,
      settings: req.ivSettings, actor: req.session.adminName || req.session.adminUser,
      channels: one,
    });

    await db.audit(req.session.adminId, req.session.adminUser, 'interview_notify', 'applicant',
      applicant.id, applicant.full_name,
      Object.entries(delivery).map(([ch, r]) => `${ch}:${r.status}`).join(' | '), req.ip);

    res.json({ ok: true, delivery });
  } catch (err) {
    console.error('[Interview] notify:', err.message);
    res.status(500).json({ error: 'تعذّر إرسال الإشعار' });
  }
});

// ─── ز. تسوية صف معلّق بعد انقطاع الشبكة ─────────────────────────────────────
router.post('/interviews/:iid/reconcile', requireInterviews, async (req, res) => {
  try {
    const row = await db.get('SELECT * FROM interviews WHERE id = ?', [req.params.iid]);
    if (!row) return res.status(404).json({ error: 'المقابلة غير موجودة' });
    if (row.status !== 'pending') return res.json({ ok: true, status: row.status });

    const startMs = new Date(row.start_at).getTime();
    const found = await google.findEventByInterviewId(row.id, startMs - 86400000, startMs + 86400000);

    if (found) {
      await db.run(
        "UPDATE interviews SET status = 'scheduled', google_event_id = ?, meet_link = ?, html_link = ?, last_error = NULL WHERE id = ?",
        [found.eventId, found.meetLink, found.htmlLink, row.id]
      );
      return res.json({ ok: true, status: 'scheduled', adopted: true });
    }

    await db.run('DELETE FROM interviews WHERE id = ? AND status = ?', [row.id, 'pending']);
    res.json({ ok: true, status: 'removed' });
  } catch (err) {
    mapGoogleError(err, res);
  }
});

// ─── ح. صفحة المقابلات ───────────────────────────────────────────────────────
const PAGE_SIZE = 50;

router.get('/interviews', requireInterviewsPage, async (req, res) => {
  try {
    const range       = ['today', 'week', 'upcoming', 'past', 'all'].includes(req.query.range) ? req.query.range : 'upcoming';
    const interviewer = String(req.query.interviewer || '').trim();
    const status      = ['scheduled', 'cancelled', 'pending'].includes(req.query.status) ? req.query.status : '';
    const page        = Math.max(1, parseInt(req.query.page, 10) || 1);

    // حدود المدى تُحسب في Node وتُمرَّر كمعاملات — لا CURDATE()/NOW() إطلاقاً
    const now = Date.now();
    const p = S.localParts(now);
    const dayStart = S.fromLocal(p.y, p.mo, p.d);
    const where = [];
    const params = [];

    if (range === 'today') {
      where.push('start_local >= ? AND start_local < ?');
      params.push(S.localStamp(dayStart), S.localStamp(dayStart + 86400000));
    } else if (range === 'week') {
      where.push('start_local >= ? AND start_local < ?');
      params.push(S.localStamp(dayStart), S.localStamp(dayStart + 7 * 86400000));
    } else if (range === 'upcoming') {
      where.push('start_at >= ?'); params.push(new Date(now));
    } else if (range === 'past') {
      where.push('start_at < ?');  params.push(new Date(now));
    }
    if (status) { where.push('i.status = ?'); params.push(status); }
    if (interviewer && EMAIL_RE.test(interviewer)) { where.push('FIND_IN_SET(?, i.interviewers)'); params.push(interviewer); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = (range === 'past') ? 'DESC' : 'ASC';

    const countRow = await db.get(`SELECT COUNT(*) AS c FROM interviews i ${whereSql}`, params);
    const total = countRow?.c || 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const offset = (Math.min(page, totalPages) - 1) * PAGE_SIZE;

    const rows = await db.all(
      `SELECT i.*, a.full_name, a.phone, a.status AS applicant_status
         FROM interviews i
         JOIN applicants a ON a.id = i.applicant_id
         ${whereSql}
        ORDER BY i.start_at ${order}
        LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params
    );

    const users = await activeInterviewers();
    const nameByEmail = Object.fromEntries(users.map(u => [u.username, u.full_name || u.username]));

    const [todayRow, weekRow, upRow] = await Promise.all([
      db.get("SELECT COUNT(*) AS c FROM interviews WHERE status='scheduled' AND start_local >= ? AND start_local < ?",
        [S.localStamp(dayStart), S.localStamp(dayStart + 86400000)]),
      db.get("SELECT COUNT(*) AS c FROM interviews WHERE status='scheduled' AND start_local >= ? AND start_local < ?",
        [S.localStamp(dayStart), S.localStamp(dayStart + 7 * 86400000)]),
      db.get("SELECT COUNT(*) AS c FROM interviews WHERE status='scheduled' AND start_at >= ?", [new Date(now)]),
    ]);

    res.render('interviews', {
      rows: rows.map(r => ({
        ...r,
        _dateLabel: S.arabicDate(new Date(r.start_at).getTime()),
        _timeLabel: S.localTime(new Date(r.start_at).getTime()),
        _past: new Date(r.start_at).getTime() < now,
        _names: String(r.interviewers || '').split(',').filter(Boolean).map(e => nameByEmail[e] || e),
      })),
      counts: { today: todayRow?.c || 0, week: weekRow?.c || 0, upcoming: upRow?.c || 0 },
      interviewerList: users.filter(u => EMAIL_RE.test(u.username || '')),
      filters: { range, interviewer, status },
      page: Math.min(page, totalPages), totalPages, total,
      disabled: false,
      googleConn: await google.getConnection().catch(() => null),
      adminUser: req.session.adminUser,
    });
  } catch (err) {
    console.error('[Interviews page]', err.message);
    res.status(500).send('خطأ في تحميل صفحة المقابلات');
  }
});

module.exports = router;
