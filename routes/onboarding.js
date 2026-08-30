/**
 * onboarding.js — «استكمال ملف الموظف» (ميزة تجريبية تعمل جانبياً).
 *
 * تعمل بجوار نظام التوظيف لا داخله:
 *   • رابط عام مستقل      /onboarding/<token>        — لا علاقة له بـ /apply.
 *   • واجهة إدارية مستقلة  /admin/onboarding/view/:id — صفحة منفصلة يفتحها زر
 *     صغير في صفحة تفاصيل المتقدم.
 *   • جداول مستقلة، مجلد رفع مستقل، ولا كتابة إطلاقاً في جدول applicants.
 *
 * لماذا لا نكتب في applicants؟ لأن هذه بيانات مرشَّحة لم يعتمدها بشر بعد:
 * النموذج يقترح، والقواعد تتحقق، والمرشح يؤكّد، ثم يقرّر HR نقلها. حتى ذلك
 * الحين هي «بيانات رحلة» لا «بيانات موظف» — وخلط الاثنين هو ما يجعل أخطاء
 * الاستخراج تتسرّب إلى النظام الرسمي بلا رجعة.
 */

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const rateLimit = require('express-rate-limit');

const ob      = require('../database/onboarding-db');
const db      = ob.db;
const rules   = require('../utils/docRules');
const ocr     = require('../utils/visionOcr');
const ai      = require('../utils/aiExtract');
const { processDocument } = require('../utils/docPipeline');
const upload  = require('../middleware/onboardingUpload');
const emp     = require('../utils/employmentFields');
const artalsys = require('../utils/artalsys');
const payloadBuilder = require('../utils/employeePayload');
const docAccess = require('../utils/docAccess');   // نفس تدقيق مرفقات التوظيف

const OB_ROOT = upload.OB_ROOT;
const LINK_DAYS = 30;

const publicRouter = express.Router();
const adminRouter  = express.Router();

// السيدبار ودوال تنسيق التاريخ تأتي عادةً من وسيط داخل routes/admin.js، وهذا
// الراوتر يُركَّب مستقلاً حتى لا نلمس ذلك الملف — فنضبط نفس المتغيرات هنا.
const RYD = 'Asia/Riyadh';
adminRouter.use((req, res, next) => {
  res.locals.adminUser = req.session?.adminUser;
  res.locals.adminName = req.session?.adminName || req.session?.adminUser;
  res.locals.adminRole = req.session?.adminRole || 'employee';
  res.locals.fmtDate = (d) => d ? new Date(d).toLocaleDateString('ar-SA', { timeZone: RYD }) : '—';
  res.locals.fmtTime = (d) => d ? new Date(d).toLocaleTimeString('ar-SA', { timeZone: RYD, hour: '2-digit', minute: '2-digit' }) : '—';
  res.locals.fmtDateTime = (d) => d ? `${res.locals.fmtDate(d)} ${res.locals.fmtTime(d)}` : '—';
  next();
});

// مفتاح إيقاف كامل: ONBOARDING_ENABLED=false في .env يُطفئ الميزة بلا نشر كود.
function featureOn() {
  return ob.state.ok && process.env.ONBOARDING_ENABLED !== 'false';
}

// ─── أدوات مشتركة ────────────────────────────────────────────────────────────

function newToken() {
  return crypto.randomBytes(24).toString('base64url');   // 32 حرفاً
}

function requiredList(session) {
  const list = String(session.required_docs || '').split(',').filter(Boolean);
  return list.filter(t => rules.DOC_KEYS.includes(t));
}

// المستندات المطلوبة تُحسب من الوظيفة لا من قائمة ثابتة: رخصة القيادة تُطلب
// ممن سُجّل أنه يقودها فقط، وإجبار الجميع عليها يعطّل رحلة لا علاقة لها بها.
function defaultRequired(applicant) {
  // السيرة الذاتية والشهادة الدراسية اختياريتان: الأولى مرفقة بالطلب غالباً،
  // والثانية لا تُشترط لكل وظيفة. والصورة الشخصية مطلوبة — منها بطاقة العمل.
  const base = ['personal_photo', 'id_iqama', 'national_address', 'iban'];
  if (applicant?.has_license) base.push('driving_license');
  return base.join(',');
}

function publicLink(req, token) {
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/onboarding/${token}`;
}

async function loadDocs(sessionId) {
  const [docs, fields] = await Promise.all([
    db.all('SELECT * FROM onboarding_documents WHERE session_id = ? AND is_current = 1', [sessionId]),
    db.all('SELECT * FROM onboarding_fields WHERE session_id = ?', [sessionId]),
  ]);
  const byType = {};
  for (const d of docs) byType[d.doc_type] = d;
  const fieldsByType = {};
  for (const f of fields) (fieldsByType[f.doc_type] ||= {})[f.field_key] = f;
  return { byType, fieldsByType };
}

// حالة كل مستند كما تراها الواجهتان (المرشح وHR) — مصدر واحد للحقيقة.
function buildSteps(session, byType, fieldsByType, opts = {}) {
  const required = requiredList(session);
  return rules.DOC_KEYS.map(type => {
    const def = rules.DOC_TYPES[type];
    const doc = byType[type] || null;
    const saved = fieldsByType[type] || {};
    // السيرة الذاتية المرفقة بطلب التوظيف تُحتسب موجودة — لا معنى لأن نطلب من
    // المرشح رفع ما رفعه قبل أسبوع. ويبقى بوسعه استبدالها بنسخة محدَّثة.
    const existingUrl = (type === 'cv' && !doc && opts.cvUrl) ? opts.cvUrl : null;

    return {
      type,
      label: def.label,
      icon: def.icon,
      hint: def.hint,
      attachmentOnly: Boolean(def.attachmentOnly),
      existingUrl,
      required: required.includes(type),
      status: doc ? doc.status : 'pending',
      review: doc ? doc.review : null,
      warnings: doc?.warnings ? JSON.parse(doc.warnings || '[]') : [],
      docId: doc?.id || null,
      hasFile: Boolean(doc),
      fileName: doc?.original_name || null,
      aiUsed: Boolean(doc?.ai_used),
      aiVision: String(doc?.ai_provider || '').endsWith('-vision'),
      hrNote: doc?.hr_note || null,
      hrDecidedBy: doc?.hr_decided_by || null,
      hrDecidedAt: doc?.hr_decided_at || null,
      // النص الخام لا يُرسَل إلى صفحة المرشح: ضجيج لا يعنيه، وحجم بلا فائدة.
      // ولفريق التوظيف هو أداة التشخيص الأولى حين يخرج حقل خاطئاً.
      ocrText: opts.withOcr ? (doc?.ocr_text || null) : null,
      fields: def.fields.map(f => ({
        key: f.key, label: f.label, required: f.required, type: f.type,
        value: saved[f.key]?.value ?? '',
        raw: saved[f.key]?.raw_value ?? '',
        valid: saved[f.key] ? Boolean(saved[f.key].valid) : null,
        error: saved[f.key]?.error || null,
        source: saved[f.key]?.source || null,
        confidence: saved[f.key]?.confidence ?? null,
      })),
    };
  });
}

/**
 * الملف الموحّد: يجمع الحقول المشتركة من كل المستندات ويكشف الاختلافات.
 * يعتمد القيم المحفوظة (بما فيها ما صحّحه المرشح) لا نتيجة القراءة الأخيرة.
 */
function buildProfile(fieldsByType) {
  const entries = [];
  for (const [docType, fields] of Object.entries(fieldsByType || {})) {
    for (const [key, row] of Object.entries(fields)) {
      if (!row.valid) continue;
      entries.push({
        docType, key,
        value: row.value,
        source: row.source,
        confidence: Number(row.confidence || 0),
        userConfirmed: Boolean(row.user_confirmed),
      });
    }
  }
  return rules.consolidate(entries);
}

/** صف بيانات التوظيف للجلسة — يُنشأ فارغاً عند أول حفظ لا قبله */
async function loadEmployment(sessionId) {
  return db.get('SELECT * FROM onboarding_employment WHERE session_id = ?', [sessionId]).catch(() => null);
}

async function recomputeProgress(session) {
  const required = requiredList(session);
  const done = await db.all(
    "SELECT doc_type FROM onboarding_documents WHERE session_id = ? AND is_current = 1 AND status = 'confirmed'",
    [session.id]
  );
  const doneTypes = new Set(done.map(d => d.doc_type));
  const completed = required.filter(t => doneTypes.has(t)).length;
  const progress = required.length ? Math.round((completed / required.length) * 100) : 0;
  const status = progress >= 100 ? 'submitted' : 'in_progress';
  await db.run(
    'UPDATE onboarding_sessions SET progress = ?, status = ?, completed_at = ? WHERE id = ?',
    [progress, status, progress >= 100 ? new Date() : null, session.id]
  );
  return { progress, completed, total: required.length, status };
}

// كتابة حقل واحد — upsert لأن المرشح قد يصحّح نفس الحقل عشر مرات.
async function saveField(sessionId, docType, key, rawValue, source, confidence) {
  const v = rules.validate(docType, key, rawValue);
  await db.run(
    `INSERT INTO onboarding_fields (session_id, doc_type, field_key, raw_value, value, source, confidence, valid, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       raw_value = VALUES(raw_value), value = VALUES(value), source = VALUES(source),
       confidence = VALUES(confidence), valid = VALUES(valid), error = VALUES(error)`,
    [sessionId, docType, key, String(rawValue ?? '').slice(0, 255), String(v.value ?? '').slice(0, 255),
     source, confidence ?? null, v.ok ? 1 : 0, v.error]
  );
  return v;
}

// ─── حدود المعدل — الرابط عام، فالحماية ليست اختيارية ───────────────────────
const pageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false,
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40,
  message: { error: 'محاولات رفع كثيرة — انتظر قليلاً ثم أعد المحاولة' },
  standardHeaders: true, legacyHeaders: false,
});

// ─── التحقق من الرابط ────────────────────────────────────────────────────────

// مصدر واحد للحقيقة في صلاحية الرابط — تستخدمه الصفحة (فترد صفحة) وواجهات
// JSON (فترد رسالة)، فلا تتفرّع قواعد الانتهاء والإبطال في مكانين.
async function findSession(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return { code: 404, error: 'رابط غير صالح' };
  const s = await db.get('SELECT * FROM onboarding_sessions WHERE token = ?', [token]);
  if (!s) return { code: 404, error: 'رابط غير صالح' };
  if (s.revoked_at) return { code: 410, error: 'تم إيقاف هذا الرابط' };
  if (s.expires_at && new Date(s.expires_at) < new Date()) return { code: 410, error: 'انتهت صلاحية الرابط' };
  return { session: s };
}

async function resolveToken(req, res, next) {
  if (!featureOn()) return res.status(503).json({ error: 'الخدمة غير متاحة حالياً' });
  try {
    const r = await findSession(req.params.token);
    if (r.error) return res.status(r.code).json({ error: r.error });
    req.obSession = r.session;
    next();
  } catch (err) {
    console.error('[Onboarding token]', err.message);
    res.status(500).json({ error: 'خطأ في فتح الملف' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  الواجهة العامة — المرشح
// ═══════════════════════════════════════════════════════════════════════════

publicRouter.get('/:token', pageLimiter, async (req, res) => {
  if (!featureOn()) {
    return res.status(503).render('onboarding-error', {
      title: 'الخدمة غير متاحة', message: 'ميزة استكمال الملف غير مفعّلة حالياً.',
    });
  }
  try {
    const r = await findSession(req.params.token);
    if (r.error) {
      return res.status(r.code).render('onboarding-error', {
        title: r.code === 410 ? 'انتهت صلاحية الرابط' : 'رابط غير صالح',
        message: r.code === 410
          ? `${r.error} — تواصل مع فريق التوظيف لإرسال رابط جديد.`
          : 'تأكد من نسخ الرابط كاملاً، أو تواصل مع فريق التوظيف.',
      });
    }
    const s = r.session;
    const applicant = await db.get('SELECT id, full_name, phone, id_number, cv_path FROM applicants WHERE id = ?', [s.applicant_id]);
    if (!applicant) {
      return res.status(404).render('onboarding-error', { title: 'رابط غير صالح', message: 'لم نجد الملف المرتبط بهذا الرابط.' });
    }
    if (!s.opened_at) await db.run('UPDATE onboarding_sessions SET opened_at = NOW() WHERE id = ?', [s.id]);

    const { byType, fieldsByType } = await loadDocs(s.id);
    const steps = buildSteps(s, byType, fieldsByType, {
      cvUrl: applicant.cv_path ? `/onboarding/${s.token}/cv` : null,
    });
    const required = requiredList(s);
    const completed = steps.filter(st => st.required && st.status === 'confirmed').length;

    res.render('onboarding', {
      conflicts: buildProfile(fieldsByType).filter(g => g.conflict),
      token: s.token,
      firstName: String(applicant.full_name || '').split(' ')[0] || '',
      steps,
      progress: s.progress,
      completed,
      totalRequired: required.length,
      lastStep: s.last_step,
      autoRead: ocr.isConfigured(),
    });
  } catch (err) {
    console.error('[Onboarding page]', err.message);
    res.status(500).render('onboarding-error', { title: 'خطأ غير متوقع', message: 'يرجى إعادة المحاولة بعد قليل.' });
  }
});

// رفع مستند — الحفظ أولاً ثم القراءة. لو انقطع الاتصال بعد الرفع مباشرةً
// يبقى الملف والسجل، ويستأنف المرشح من حيث توقّف.
publicRouter.post('/:token/upload', uploadLimiter, resolveToken, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'تعذّر رفع الملف' });
    next();
  });
}, async (req, res) => {
  const s = req.obSession;
  try {
    const docType = String(req.body.doc_type || '');
    if (!rules.DOC_KEYS.includes(docType)) return res.status(400).json({ error: 'نوع مستند غير معروف' });
    if (!req.file) return res.status(400).json({ error: 'لم يصل أي ملف' });

    // النسخة السابقة تبقى في السجل للتدقيق ولا تُعتبر المستند الحالي.
    await db.run('UPDATE onboarding_documents SET is_current = 0 WHERE session_id = ? AND doc_type = ?', [s.id, docType]);

    const ins = await db.run(
      `INSERT INTO onboarding_documents
         (session_id, applicant_id, doc_type, status, file_name, original_name, mime, size_bytes)
       VALUES (?, ?, ?, 'uploaded', ?, ?, ?, ?)`,
      [s.id, s.applicant_id, docType, req.file.filename,
       String(req.file.originalname || '').slice(0, 250), req.file.mimetype, req.file.size]
    );
    await db.run('UPDATE onboarding_sessions SET last_step = ?, status = ? WHERE id = ?', [docType, 'in_progress', s.id]);

    const applicant = await db.get('SELECT id_number FROM applicants WHERE id = ?', [s.applicant_id]);
    const out = await processDocument({
      docType, filePath: path.join(OB_ROOT, String(s.applicant_id), req.file.filename),
      mime: req.file.mimetype, applicant,
    });

    await db.run(
      `UPDATE onboarding_documents SET status = 'extracted', review = ?, ocr_text = ?, ocr_provider = ?,
              ocr_conf = ?, ai_used = ?, ai_provider = ?, ai_model = ?, warnings = ?
         WHERE id = ?`,
      [out.review, out.ocrText, out.ocrProvider, out.ocrConf,
       out.aiUsed ? 1 : 0, out.aiProvider, out.aiModel,
       JSON.stringify(out.warnings.slice(0, 5)), ins.insertId]
    );

    // حقول الاستخراج تُكتب فوراً — «التالي» ليس هو الحفظ في هذه الرحلة.
    for (const [key, f] of Object.entries(out.fields)) {
      await saveField(s.id, docType, key, f.raw, f.source, f.confidence);
    }

    // إعادة رفع مستند سبق تأكيده تُنزله من «مكتمل» — والتقدّم يجب أن يتبعه فوراً،
    // وإلا رأى المرشح 100% على ملف صار ناقصاً.
    const p = await recomputeProgress(s);

    const { byType, fieldsByType } = await loadDocs(s.id);
    const cv = await db.get('SELECT cv_path FROM applicants WHERE id = ?', [s.applicant_id]);
    const step = buildSteps(s, byType, fieldsByType, {
      cvUrl: cv?.cv_path ? `/onboarding/${s.token}/cv` : null,
    }).find(x => x.type === docType);
    res.json({ ok: true, step, progress: p.progress, autoRead: ocr.isConfigured() });
  } catch (err) {
    console.error('[Onboarding upload]', err.message);
    res.status(500).json({ error: 'تعذّرت معالجة المستند — حاول مرة أخرى' });
  }
});

// حفظ حقل واحد فور تعديله (autosave) — لا انتظار لزر «التالي».
publicRouter.patch('/:token/field', pageLimiter, resolveToken, async (req, res) => {
  try {
    const { doc_type: docType, field, value } = req.body || {};
    if (!rules.DOC_KEYS.includes(String(docType))) return res.status(400).json({ error: 'نوع مستند غير معروف' });
    if (!rules.fieldDef(docType, String(field))) return res.status(400).json({ error: 'حقل غير معروف' });

    const v = await saveField(req.obSession.id, docType, String(field), String(value ?? ''), 'user', 1);
    await db.run('UPDATE onboarding_sessions SET last_step = ? WHERE id = ?', [docType, req.obSession.id]);

    // حقول تُشتق من هذا الحقل (الجنسية من رقم الهوية).
    //  • قيمة كتبها المرشح أو قرأها OCR لا يدهسها النظام أبداً.
    //  • أما ما كتبه النظام نفسه (source = rule) فهو ملك للاشتقاق: يُصحَّح إن
    //    تغيّر الرقم، ويُمحى إن صار الرقم إقامة (2…) فلا تبقى «سعودي» معلّقة.
    const also = [];
    if (v.ok) {
      const wanted = Object.fromEntries(
        rules.derivedFrom(docType, String(field), v.value).map(d => [d.key, d.value])
      );
      for (const key of rules.derivedKeys(docType, String(field))) {
        const cur = await db.get(
          'SELECT value, valid, source FROM onboarding_fields WHERE session_id = ? AND doc_type = ? AND field_key = ?',
          [req.obSession.id, docType, key]
        );
        const ownedByUser = cur && cur.source !== 'rule' && String(cur.value || '').trim();
        if (ownedByUser) continue;

        const next = wanted[key] ?? '';
        if (String(cur?.value || '') === next) continue;
        const dv = await saveField(req.obSession.id, docType, key, next, 'rule', next ? 1 : null);
        also.push({ key, value: dv.value, valid: dv.ok });
      }
    }

    res.json({ ok: true, value: v.value, valid: v.ok, error: v.error, also });
  } catch (err) {
    console.error('[Onboarding field]', err.message);
    res.status(500).json({ error: 'تعذّر الحفظ' });
  }
});

// تأكيد مستند — لا يمرّ إلا إذا اجتازت كل الحقول المطلوبة التحقق المحلي.
publicRouter.post('/:token/confirm', pageLimiter, resolveToken, async (req, res) => {
  try {
    const s = req.obSession;
    const docType = String(req.body?.doc_type || '');
    if (!rules.DOC_KEYS.includes(docType)) return res.status(400).json({ error: 'نوع مستند غير معروف' });

    const doc = await db.get(
      'SELECT * FROM onboarding_documents WHERE session_id = ? AND doc_type = ? AND is_current = 1',
      [s.id, docType]
    );
    if (!doc) return res.status(400).json({ error: 'ارفع المستند أولاً' });

    const rows = await db.all('SELECT * FROM onboarding_fields WHERE session_id = ? AND doc_type = ?', [s.id, docType]);
    const map = Object.fromEntries(rows.map(r => [r.field_key, { valid: Boolean(r.valid) }]));
    const missing = rules.missingRequired(docType, map);
    if (missing.length) {
      return res.status(422).json({
        error: 'بعض الحقول المطلوبة ناقصة أو غير صحيحة',
        missing,
      });
    }

    await db.run("UPDATE onboarding_fields SET user_confirmed = 1 WHERE session_id = ? AND doc_type = ?", [s.id, docType]);
    // مستند غير مقبول (أحمر) يبقى أحمر حتى بعد التأكيد — قرار قبوله لـ HR.
    await db.run(
      "UPDATE onboarding_documents SET status = 'confirmed', review = ? WHERE id = ?",
      [doc.review === 'red' ? 'red' : (doc.review || 'green'), doc.id]
    );

    const p = await recomputeProgress(s);
    const { fieldsByType } = await loadDocs(s.id);
    res.json({ ok: true, ...p, conflicts: buildProfile(fieldsByType).filter(g => g.conflict) });
  } catch (err) {
    console.error('[Onboarding confirm]', err.message);
    res.status(500).json({ error: 'تعذّر التأكيد' });
  }
});

// السيرة الذاتية المرفقة بطلب التوظيف — يعرضها صاحبها من داخل الرحلة.
//  تُخدَّم من مجلد التقديم لا من مجلد الاستكمال، ولا تُنسخ: نسخة واحدة تكفي،
//  والمرشح يرى ما رفعه فعلاً لا صورةً عنه.
publicRouter.get('/:token/cv', pageLimiter, resolveToken, async (req, res) => {
  try {
    const a = await db.get('SELECT cv_path FROM applicants WHERE id = ?', [req.obSession.applicant_id]);
    const name = a?.cv_path || '';
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return res.status(404).end();
    const CV_ROOT = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
    res.sendFile(path.join(CV_ROOT, 'cv', name), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  } catch (err) {
    res.status(500).end();
  }
});

// عرض الملف المرفوع لصاحبه (معاينة داخل الرحلة)
publicRouter.get('/:token/file/:docId', pageLimiter, resolveToken, async (req, res) => {
  try {
    const doc = await db.get('SELECT * FROM onboarding_documents WHERE id = ? AND session_id = ?',
      [req.params.docId, req.obSession.id]);
    if (!doc || !/^[A-Za-z0-9._-]+$/.test(doc.file_name)) return res.status(404).end();
    res.sendFile(path.join(OB_ROOT, String(doc.applicant_id), doc.file_name), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  } catch (err) {
    res.status(500).end();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  الواجهة الإدارية — HR
//  (تُركَّب خلف requireAuth في server.js — لا مسار هنا مفتوح للعموم)
// ═══════════════════════════════════════════════════════════════════════════

// ملخّص خفيف للبطاقة الصغيرة داخل صفحة تفاصيل المتقدم.
// تُستدعى من المتصفح: لو رجعت 503 أو 404 تُخفي البطاقة نفسها ولا يتغيّر شيء
// في الصفحة القائمة — وهذا هو سبب كونها fetch لا بيانات مُمرَّرة من الخادم.
adminRouter.get('/summary/:applicantId', async (req, res) => {
  if (!featureOn()) return res.status(503).json({ enabled: false });
  try {
    const s = await db.get(
      'SELECT * FROM onboarding_sessions WHERE applicant_id = ? ORDER BY id DESC LIMIT 1',
      [req.params.applicantId]
    );
    // هل زر «إرسال بواتساب» متاح؟ (Chatwoot مهيأ + اسم القالب محفوظ)
    const settings = await db.getSettings().catch(() => ({}));
    const waReady = require('../utils/waTemplates')
      .ready(settings, 'onboarding', require('../utils/chatwoot').isConfigured());

    if (!s) return res.json({ enabled: true, exists: false, waReady });

    const { byType, fieldsByType } = await loadDocs(s.id);
    const steps = buildSteps(s, byType, fieldsByType);
    const required = requiredList(s);
    res.json({
      enabled: true, exists: true, waReady,
      sessionId: s.id,
      status: s.status,
      progress: s.progress,
      revoked: Boolean(s.revoked_at),
      expired: Boolean(s.expires_at && new Date(s.expires_at) < new Date()),
      link: publicLink(req, s.token),
      openedAt: s.opened_at,
      completed: steps.filter(x => x.required && x.status === 'confirmed').length,
      totalRequired: required.length,
      needsReview: steps.filter(x => x.hasFile && x.review !== 'green').length,
      steps: steps.map(x => ({ type: x.type, label: x.label, required: x.required, status: x.status, review: x.review })),
    });
  } catch (err) {
    console.error('[Onboarding summary]', err.message);
    res.status(500).json({ enabled: false });
  }
});

// إنشاء الرابط (أو إرجاع الحالي إن كان ساري المفعول)
// إنشاء الجلسة أو إعادة استخدام السارية — يشترك فيها زر «إنشاء الرابط» وزر
// «إرسال بواتساب»، فلا يُنشئ الثاني رابطاً ثانياً يُبطل ما نسخه الموظف للتو.
async function ensureSession(req, applicant) {
  const live = await db.get(
    'SELECT * FROM onboarding_sessions WHERE applicant_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY id DESC LIMIT 1',
    [applicant.id]
  );
  if (live) return { token: live.token, reused: true };

  const token = newToken();
  const expires = new Date(Date.now() + LINK_DAYS * 86400000);
  await db.run(
    `INSERT INTO onboarding_sessions (applicant_id, token, status, required_docs, expires_at, created_by)
     VALUES (?, ?, 'not_started', ?, ?, ?)`,
    [applicant.id, token, defaultRequired(applicant), expires, req.session?.adminName || req.session?.adminUser || null]
  );
  // التدقيق يمرّ بنفس مسار النظام — إنشاء رابط يفتح ملفاً شخصياً حدثٌ يُسجَّل.
  db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'onboarding_link',
    'applicant', applicant.id, applicant.full_name, `صلاحية ${LINK_DAYS} يوماً`, req.ip).catch(() => {});
  return { token, reused: false };
}

adminRouter.post('/create/:applicantId', async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  try {
    const applicant = await db.get('SELECT id, full_name, phone, has_license FROM applicants WHERE id = ?', [req.params.applicantId]);
    if (!applicant) return res.status(404).json({ error: 'المتقدم غير موجود' });
    const { token, reused } = await ensureSession(req, applicant);
    res.json({ ok: true, link: publicLink(req, token), reused });
  } catch (err) {
    console.error('[Onboarding create]', err.message);
    res.status(500).json({ error: 'تعذّر إنشاء الرابط' });
  }
});

// إرسال الرابط للمرشح بقالب واتساب المعتمد.
//  لماذا مسار خاص بدل /admin/applicants/:id/wa-template العام؟ لأن متغيّر
//  {link} لا يكتبه موظف: يُولَّد هنا من جلسة الاستكمال. تمرير رابط من الواجهة
//  يعني أن أي أحد يستطيع إرسال أي رابط لمتقدم باسم الشركة — وهذا لا يُقبل.
const sendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 30,
  message: { error: 'طلبات كثيرة — انتظر قليلاً' },
  standardHeaders: true, legacyHeaders: false,
});

adminRouter.post('/send/:applicantId', sendLimiter, async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  try {
    const WT = require('../utils/waTemplates');
    const notify = require('../utils/notify');
    const chatwoot = require('../utils/chatwoot');
    const tpl = WT.get('onboarding');

    const applicant = await db.get(
      'SELECT id, full_name, phone, region, city, landing_page, has_license FROM applicants WHERE id = ?',
      [req.params.applicantId]
    );
    if (!applicant) return res.status(404).json({ error: 'المتقدم غير موجود' });
    if (!chatwoot.isConfigured()) return res.status(409).json({ error: 'تكامل Chatwoot غير مهيأ' });

    const settings = await db.getSettings();
    if (!WT.ready(settings, 'onboarding', true)) {
      return res.status(409).json({ error: 'لم يُحدَّد اسم قالب الاستكمال في الإعدادات' });
    }

    const { token, reused } = await ensureSession(req, applicant);
    const link = publicLink(req, token);
    const job = String(req.body?.job || '').trim().slice(0, 100);

    const r = await notify.sendApplicantTemplate({
      applicant, tplKey: 'onboarding', kind: 'onboarding',
      vars: { link, ...(job ? { jobTitle: job } : {}) },
      settings, actor: req.session?.adminName || req.session?.adminUser,
    });
    if (r.status !== 'sent') {
      return res.status(r.status === 'skipped' ? 409 : 502).json({ error: r.reason || 'تعذّر الإرسال' });
    }

    // يُسجَّل في ملف المتقدم كبقية المراسلات — حتى لا يُرسله موظف آخر مرتين.
    //  والرابط نفسه داخل الملاحظة عمداً: هو ما أُرسل فعلاً، ووجوده في السجل
    //  يعني أن أي موظف يفتح الملف بعد أسبوع يستطيع فتحه أو إعادة إرساله بلا
    //  البحث عنه في مكان آخر.
    const line = `${tpl.noteLabel} عبر واتساب${reused ? '' : ' (رابط جديد)'} — ${link}`;
    db.run('INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
      [applicant.id, line, 'follow_up', req.session?.adminName || null]).catch(e => console.error('[Onboarding send] note:', e.message));
    db.logActivity(applicant.id, tpl.noteLabel, null, `واتساب — ${link}`.slice(0, 255), req.session?.adminName || null)
      .catch(e => console.error('[Onboarding send] activity:', e.message));
    db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'onboarding_send',
      'applicant', applicant.id, applicant.full_name, line, req.ip).catch(() => {});

    res.json({ ok: true, link, sentTo: r.target });
  } catch (err) {
    console.error('[Onboarding send]', err.message);
    res.status(500).json({ error: 'خطأ غير متوقع' });
  }
});

adminRouter.post('/revoke/:sessionId', async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  try {
    await db.run('UPDATE onboarding_sessions SET revoked_at = NOW() WHERE id = ?', [req.params.sessionId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'تعذّر الإيقاف' });
  }
});

// الصفحة الإدارية الكاملة — البيانات والمرفقات الجديدة
adminRouter.get('/view/:applicantId', async (req, res) => {
  if (!featureOn()) return res.status(503).send('ميزة استكمال الملف غير مفعّلة');
  try {
    const applicant = await db.get('SELECT * FROM applicants WHERE id = ?', [req.params.applicantId]);
    if (!applicant) return res.status(404).send('المتقدم غير موجود');

    const s = await db.get('SELECT * FROM onboarding_sessions WHERE applicant_id = ? ORDER BY id DESC LIMIT 1', [applicant.id]);
    let steps = [], history = [], profile = [], employment = null;
    if (s) {
      employment = await loadEmployment(s.id);
      const { byType, fieldsByType } = await loadDocs(s.id);
      steps = buildSteps(s, byType, fieldsByType, {
        withOcr: true,
        cvUrl: applicant.cv_path ? `/admin/files/cv/${applicant.cv_path}` : null,
      });
      profile = buildProfile(fieldsByType);
      history = await db.all(
        'SELECT id, doc_type, status, review, original_name, created_at FROM onboarding_documents WHERE session_id = ? AND is_current = 0 ORDER BY id DESC',
        [s.id]
      );
    }
    res.render('onboarding-admin', {
      applicant, session: s, steps, history, profile,
      employment,
      artalsysReady: artalsys.isConfigured(),
      artalsysUrl: artalsys.baseUrl(),
      empFields: emp.FIELDS,
      empMissing: emp.missingRequired(employment || {}),
      link: s ? publicLink(req, s.token) : null,
      DOC_TYPES: rules.DOC_TYPES,
      engine: { ocr: ocr.isConfigured(), ai: ai.isConfigured(), aiProvider: ai.provider(), aiModel: ai.model() },
      waReady: require('../utils/waTemplates')
        .ready(await db.getSettings().catch(() => ({})), 'onboarding', require('../utils/chatwoot').isConfigured()),
    });
  } catch (err) {
    console.error('[Onboarding admin]', err.message);
    res.status(500).send('خطأ في تحميل ملف الاستكمال');
  }
});

// ─── مستندات الاستكمال — نفس قاعدة مرفقات التوظيف ────────────────────────────
//  هذه المستندات أحسّ من السيرة الذاتية: هوية وآيبان وشهادات. لا معنى لتدقيق
//  صارم على مرفقات الطلب وباب مفتوح هنا — فتمرّ بنفس الطبقة تماماً.
async function resolveObDoc(docId) {
  const doc = await db.get('SELECT * FROM onboarding_documents WHERE id = ?', [docId]);
  if (!doc || !/^[A-Za-z0-9._-]+$/.test(doc.file_name || '')) return null;
  const p = path.join(OB_ROOT, String(doc.applicant_id), doc.file_name);
  if (!fs.existsSync(p)) return null;
  const applicant = await db.get('SELECT id, full_name FROM applicants WHERE id = ?', [doc.applicant_id])
    .catch(() => null);
  return {
    doc, filePath: p,
    label: rules.DOC_TYPES[doc.doc_type]?.label || doc.doc_type,
    applicantId: doc.applicant_id,
    personName: applicant?.full_name || `متقدم #${doc.applicant_id}`,
  };
}

adminRouter.get('/file/:docId', async (req, res) => {
  if (!featureOn()) return res.status(503).end();
  try {
    const d = await resolveObDoc(req.params.docId);
    if (!d) return res.status(404).send('المستند غير موجود');
    res.render('doc-view', {
      docLabel:    d.label,
      personName:  d.personName,
      applicantId: d.applicantId,
      backUrl:     `/admin/onboarding/view/${d.applicantId}`,
      rawUrl:      `/admin/onboarding/file/${d.doc.id}/raw`,
      downloadUrl: `/admin/onboarding/file/${d.doc.id}/download`,
      auditUrl:    `/admin/audit?applicant_id=${d.applicantId}`,
      kind:        docAccess.viewerKind(d.doc.file_name),
    });
  } catch (err) {
    console.error('[Onboarding file view]', err.message);
    res.status(500).send('خطأ في فتح المستند');
  }
});

adminRouter.get('/file/:docId/raw', async (req, res) => {
  if (!featureOn()) return res.status(503).end();
  try {
    const d = await resolveObDoc(req.params.docId);
    if (!d) return res.status(404).end();
    await docAccess.logView(req, {
      action: 'doc_view', targetId: d.applicantId,
      targetName: d.personName, details: `استكمال — ${d.label}`,
    });
    docAccess.sendAs(res, d.filePath, { mode: 'inline' });
  } catch (err) {
    console.error('[Onboarding file raw]', err.message);
    if (!res.headersSent) res.status(500).end();
  }
});

const obDownloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60,
  message: { error: 'تحميلات كثيرة خلال وقت قصير — انتظر قليلاً' },
  standardHeaders: true, legacyHeaders: false,
});

adminRouter.post('/file/:docId/download', obDownloadLimiter, async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  try {
    const check = docAccess.normalizeReason(req.body?.reason);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const d = await resolveObDoc(req.params.docId);
    if (!d) return res.status(404).json({ error: 'المستند غير موجود' });

    await docAccess.logDownload(req, {
      targetId: d.applicantId, targetName: d.personName,
      docLabel: `استكمال — ${d.label}`, reason: check.reason,
    });

    const name = docAccess.downloadName(d.label, d.personName, d.doc.file_name);
    res.set('X-Filename', encodeURIComponent(name));
    docAccess.sendAs(res, d.filePath, { mode: 'attachment', filename: name });
  } catch (err) {
    console.error('[Onboarding file download]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'تعذّر التحميل' });
  }
});

// إعادة الاستخراج على الملف المحفوظ — بلا إعادة رفع.
//  قواعد الاستخراج تتحسّن مع الوقت (تصحيح التقاط التواريخ مثلاً)، والمستندات
//  المرفوعة قبلها تبقى تحمل قيماً قديمة. هذا الزر يعيد تشغيل المسار كاملاً على
//  نفس الصورة المحفوظة.
//
//  ⚠️ القاعدة الحاكمة: ما كتبه المرشح بيده (source = user) لا يُدهس أبداً — إنسان
//     صحّح آلة، وإعادة تشغيل الآلة لا تُلغي تصحيحه. وما جاء من قراءة آلية أو
//     نموذج أو قاعدة فهو ملك للاستخراج ويُحدَّث. ولا تُكتب قيمة جديدة إلا إن
//     اجتازت التحقق — فإعادة الاستخراج لا تستطيع أن تُفسد حقلاً صحيحاً.
const reextractLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 30,
  message: { error: 'طلبات كثيرة — انتظر قليلاً' },
  standardHeaders: true, legacyHeaders: false,
});

adminRouter.post('/doc/:docId/reextract', reextractLimiter, async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  try {
    const doc = await db.get('SELECT * FROM onboarding_documents WHERE id = ?', [req.params.docId]);
    if (!doc) return res.status(404).json({ error: 'المستند غير موجود' });
    if (!/^[A-Za-z0-9._-]+$/.test(doc.file_name)) return res.status(400).json({ error: 'اسم ملف غير صالح' });

    const filePath = path.join(OB_ROOT, String(doc.applicant_id), doc.file_name);
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'الملف الأصلي غير موجود على الخادم' });

    const applicant = await db.get('SELECT id_number FROM applicants WHERE id = ?', [doc.applicant_id]);
    const out = await processDocument({ docType: doc.doc_type, filePath, mime: doc.mime, applicant });

    const before = await db.all(
      'SELECT field_key, value, source FROM onboarding_fields WHERE session_id = ? AND doc_type = ?',
      [doc.session_id, doc.doc_type]
    );
    const prev = Object.fromEntries(before.map(f => [f.field_key, f]));

    const changed = [];
    for (const [key, f] of Object.entries(out.fields)) {
      if (!f.valid) continue;                              // لا تُفسد حقلاً بقيمة فاشلة
      if (prev[key]?.source === 'user') continue;          // تصحيح المرشح مقدَّس
      if (String(prev[key]?.value || '') === String(f.value)) continue;
      await saveField(doc.session_id, doc.doc_type, key, f.raw, f.source, f.confidence);
      changed.push({
        key,
        label: rules.fieldDef(doc.doc_type, key)?.label || key,
        from: prev[key]?.value || '',
        to: f.value,
      });
    }

    await db.run(
      `UPDATE onboarding_documents SET review = ?, ocr_text = ?, ocr_provider = ?, ocr_conf = ?,
              ai_used = ?, ai_provider = ?, ai_model = ?, warnings = ?
         WHERE id = ?`,
      [out.review, out.ocrText, out.ocrProvider, out.ocrConf,
       out.aiUsed ? 1 : 0, out.aiProvider, out.aiModel,
       JSON.stringify(out.warnings.slice(0, 5)), doc.id]
    );

    db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'onboarding_reextract',
      'applicant', doc.applicant_id, null,
      `${rules.DOC_TYPES[doc.doc_type]?.label || doc.doc_type} — ${changed.length} حقل تغيّر`, req.ip).catch(() => {});

    res.json({ ok: true, changed, review: out.review, aiUsed: out.aiUsed, ocrError: out.ocrError });
  } catch (err) {
    console.error('[Onboarding reextract]', err.message);
    res.status(500).json({ error: 'تعذّرت إعادة الاستخراج' });
  }
});

// حفظ بيانات التوظيف — الحفظ جزئي دائماً: يملأ الموظف ما لديه اليوم ويكمل غداً،
// ولا تُشترط الحقول المطلوبة إلا عند المزامنة مع النظام الأساسي.
adminRouter.post('/employment/:applicantId', async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  try {
    const s = await db.get(
      'SELECT * FROM onboarding_sessions WHERE applicant_id = ? ORDER BY id DESC LIMIT 1',
      [req.params.applicantId]
    );
    if (!s) return res.status(404).json({ error: 'لا توجد جلسة استكمال لهذا المتقدم' });

    // لا نقبل من الواجهة إلا ما أعلنه السجل — لا حقل خارج القائمة يصل الجدول
    const values = {};
    const errors = {};
    for (const key of emp.KEYS) {
      if (!(key in (req.body || {}))) continue;
      const v = emp.validate(key, req.body[key]);
      if (!v.ok) { errors[key] = v.error; continue; }
      values[key] = v.value;
    }
    if (Object.keys(errors).length) return res.status(422).json({ error: 'قيم غير صالحة', errors });

    const cols = Object.keys(values);
    const actor = req.session?.adminName || req.session?.adminUser || null;

    if (cols.length) {
      const insertCols = ['session_id', 'applicant_id', ...cols, 'updated_by'];
      const params = [s.id, s.applicant_id, ...cols.map(c => values[c]), actor];
      await db.run(
        `INSERT INTO onboarding_employment (${insertCols.map(c => `\`${c}\``).join(', ')})
         VALUES (${insertCols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${[...cols, 'updated_by'].map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')}`,
        params
      );
    }

    const row = await loadEmployment(s.id);
    res.json({ ok: true, missing: emp.missingRequired(row || {}), employment: row });
  } catch (err) {
    console.error('[Onboarding employment]', err.message);
    res.status(500).json({ error: 'تعذّر حفظ بيانات التوظيف' });
  }
});

// ═══ المزامنة مع النظام الأساسي ═══════════════════════════════════════════
//
// خطوتان لا واحدة: «فحص» يمرّ بكل شيء بلا إنشاء، ثم «إضافة». الفحص يستدعي
// dry_run في الطرف الآخر فيرى الموظف النتيجة كاملة — بما فيها تعارض الهوية أو
// الجوال — قبل أن يضغط زر الإضافة، لا بعده.

async function syncContext(applicantId, req) {
  const applicant = await db.get('SELECT * FROM applicants WHERE id = ?', [applicantId]);
  if (!applicant) return { error: 'المتقدم غير موجود', code: 404 };

  const s = await db.get('SELECT * FROM onboarding_sessions WHERE applicant_id = ? ORDER BY id DESC LIMIT 1', [applicantId]);
  if (!s) return { error: 'لا توجد جلسة استكمال لهذا المتقدم', code: 400 };

  const { byType, fieldsByType } = await loadDocs(s.id);
  const employment = await loadEmployment(s.id);
  const built = payloadBuilder.build({ applicant, fieldsByType, employment, sessionId: s.id });

  // عوائق محلية تُشرح بالعربية قبل أي نداء خارجي — أرخص وأوضح من رفض بعيد
  const blockers = [
    ...payloadBuilder.docBlockers(s, byType),
    ...built.missing.map(label => `بيان ناقص: ${label}`),
  ];

  return { applicant, session: s, employment, payload: built.payload, blockers };
}

adminRouter.get('/sync-preview/:applicantId', async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  try {
    const ctx = await syncContext(req.params.applicantId, req);
    if (ctx.error) return res.status(ctx.code).json({ error: ctx.error });

    const out = {
      ok: true,
      configured: artalsys.isConfigured(),
      blockers: ctx.blockers,
      payload: ctx.payload,
      employment: ctx.employment,
    };

    if (ctx.blockers.length || !artalsys.isConfigured()) return res.json(out);

    // فحص عن بُعد — لا يكتب شيئاً في النظام الأساسي
    const r = await artalsys.pushEmployee(ctx.payload, { dryRun: true });
    res.json({ ...out, remote: { status: r.status, ...r.json } });
  } catch (err) {
    console.error('[Onboarding sync-preview]', err.message);
    res.status(502).json({ error: err.message });
  }
});

adminRouter.post('/sync/:applicantId', sendLimiter, async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  if (!artalsys.isConfigured()) return res.status(409).json({ error: 'تكامل النظام الأساسي غير مهيأ' });

  try {
    const ctx = await syncContext(req.params.applicantId, req);
    if (ctx.error) return res.status(ctx.code).json({ error: ctx.error });
    if (ctx.blockers.length) return res.status(422).json({ error: 'الملف غير مكتمل', blockers: ctx.blockers });

    const r = await artalsys.pushEmployee(ctx.payload);
    const employeeId = r.json?.employee_id || r.json?.conflicts?.national_id?.employee_id || null;

    // نُسجّل نتيجة كل محاولة — الرفض معلومة تُحفظ لا رسالة تختفي بإغلاق النافذة
    const status = r.status === 201 ? 'created' : (r.status === 409 ? 'duplicate' : 'failed');
    const errText = r.status === 201 ? null
      : String(r.json?.error || 'تعذّرت الإضافة').slice(0, 250);

    await db.run(
      `UPDATE onboarding_employment
          SET ext_employee_id = ?, sync_status = ?, sync_error = ?, synced_at = ?
        WHERE session_id = ?`,
      [employeeId, status, errText, r.status === 201 ? new Date() : null, ctx.session.id]
    );

    const label = r.status === 201
      ? `أُضيف إلى نظام الموظفين — رقم ${employeeId}`
      : `تعذّرت الإضافة إلى نظام الموظفين — ${errText}`;

    db.run('INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
      [ctx.applicant.id, label, 'follow_up', req.session?.adminName || null]).catch(() => {});
    db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'onboarding_sync',
      'applicant', ctx.applicant.id, ctx.applicant.full_name, label.slice(0, 500), req.ip).catch(() => {});

    res.status(r.status === 201 ? 200 : r.status).json({
      ok: r.status === 201,
      status,
      employee_id: employeeId,
      remote: r.json,
    });
  } catch (err) {
    console.error('[Onboarding sync]', err.message);
    res.status(502).json({ error: err.message });
  }
});

/**
 * مزامنة المرفقات إلى ملف موظف قائم.
 *
 * تعمل في حالتين: بعد الإضافة الناجحة، أو حين تكون الهوية مسجّلة موظفاً مسبقاً
 * — وحينها لا نُنشئ شيئاً ولا نعدّل بياناته، بل نضيف وثائقه فقط، وبنقرة صريحة
 * من الموظف لا كأثر تلقائي للرفض.
 *
 * ملف لكل نداء: فشل واحد لا يُسقط البقية، والنتيجة تُعرض ملفاً ملفاً.
 */
adminRouter.post('/sync-attachments/:applicantId', sendLimiter, async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  if (!artalsys.isConfigured()) return res.status(409).json({ error: 'تكامل النظام الأساسي غير مهيأ' });

  try {
    const applicant = await db.get('SELECT * FROM applicants WHERE id = ?', [req.params.applicantId]);
    if (!applicant) return res.status(404).json({ error: 'المتقدم غير موجود' });

    const s = await db.get('SELECT * FROM onboarding_sessions WHERE applicant_id = ? ORDER BY id DESC LIMIT 1', [applicant.id]);
    if (!s) return res.status(400).json({ error: 'لا توجد جلسة استكمال' });

    const employment = await loadEmployment(s.id);
    const employeeId = Number(req.body?.employee_id || employment?.ext_employee_id || 0);
    if (!employeeId) return res.status(422).json({ error: 'لا يوجد رقم موظف — أضف الموظف أولاً أو حدّد رقمه' });

    const docs = await db.all(
      'SELECT * FROM onboarding_documents WHERE session_id = ? AND is_current = 1 ORDER BY id ASC',
      [s.id]
    );

    const nationalId = applicant.id_number;
    const results = [];

    for (const doc of docs) {
      const label = rules.DOC_TYPES[doc.doc_type]?.label || doc.doc_type;
      try {
        if (!/^[A-Za-z0-9._-]+$/.test(doc.file_name || '')) throw new Error('اسم ملف غير صالح');
        const filePath = path.join(OB_ROOT, String(doc.applicant_id), doc.file_name);
        const buffer = await fs.promises.readFile(filePath);

        const r = await artalsys.uploadAttachment(employeeId, {
          buffer,
          fileName: doc.original_name || doc.file_name,
          mime: doc.mime,
          category: payloadBuilder.categoryFor(doc.doc_type, nationalId),
          title: `${label} — ${nationalId || applicant.full_name}`,
          notes: 'مزامنة من منصة استكمال البيانات',
          sourceDocumentId: doc.id,
        });

        results.push({
          doc: label,
          ok: r.ok,
          duplicate: Boolean(r.json?.duplicate),
          attachment_id: r.json?.attachment_id || null,
          error: r.ok ? null : (r.json?.error || `HTTP ${r.status}`),
        });
      } catch (e) {
        results.push({ doc: label, ok: false, error: e.message });
      }
    }

    // السيرة الذاتية المرفقة بطلب التوظيف — ليست في مستندات الرحلة لكنها ملفه
    if (applicant.cv_path && !docs.some(d => d.doc_type === 'cv')) {
      try {
        const CV_ROOT = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
        const buffer = await fs.promises.readFile(path.join(CV_ROOT, 'cv', applicant.cv_path));
        const r = await artalsys.uploadAttachment(employeeId, {
          buffer,
          fileName: applicant.cv_path,
          mime: applicant.cv_path.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
          category: 'cv',
          title: `السيرة الذاتية — ${nationalId || applicant.full_name}`,
          notes: 'مرفقة بطلب التوظيف',
          sourceDocumentId: null,
        });
        results.push({ doc: 'السيرة الذاتية (من الطلب)', ok: r.ok, attachment_id: r.json?.attachment_id || null, error: r.ok ? null : (r.json?.error || `HTTP ${r.status}`) });
      } catch (e) {
        results.push({ doc: 'السيرة الذاتية (من الطلب)', ok: false, error: e.message });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    const line = `مزامنة المرفقات إلى الموظف #${employeeId} — ${okCount} من ${results.length}`;

    await db.run(
      'UPDATE onboarding_employment SET ext_employee_id = ?, attachments_synced_at = NOW() WHERE session_id = ?',
      [employeeId, s.id]
    ).catch(() => {});

    db.run('INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
      [applicant.id, line, 'follow_up', req.session?.adminName || null]).catch(() => {});
    db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'onboarding_attachments',
      'applicant', applicant.id, applicant.full_name, line, req.ip).catch(() => {});

    res.json({ ok: okCount === results.length, employee_id: employeeId, results });
  } catch (err) {
    console.error('[Onboarding sync-attachments]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// قرار HR على مستند — الاستثناءات وحدها تصل إلى إنسان، وهذا مكان تسجيلها.
adminRouter.post('/doc/:docId/review', async (req, res) => {
  if (!featureOn()) return res.status(503).json({ error: 'الميزة غير مفعّلة' });
  try {
    const review = String(req.body?.review || '');
    if (!['green', 'yellow', 'red'].includes(review)) return res.status(400).json({ error: 'قيمة غير صالحة' });
    const note = String(req.body?.note || '').slice(0, 250) || null;
    const doc = await db.get('SELECT * FROM onboarding_documents WHERE id = ?', [req.params.docId]);
    if (!doc) return res.status(404).json({ error: 'المستند غير موجود' });

    // نُسجّل «من قرّر ومتى» لا الحالة وحدها: أخضرُ الاستخراج الآلي وأخضرُ قرار
    // الإنسان يبدوان سواءً في عمود review، والفرق بينهما هو ما يفتح باب الإضافة.
    await db.run(
      'UPDATE onboarding_documents SET review = ?, hr_note = ?, hr_decided_at = NOW(), hr_decided_by = ? WHERE id = ?',
      [review, note, req.session?.adminName || req.session?.adminUser || null, doc.id]
    );
    db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'onboarding_review',
      'applicant', doc.applicant_id, null, `${rules.DOC_TYPES[doc.doc_type]?.label || doc.doc_type} → ${review}`, req.ip).catch(() => {});
    res.json({ ok: true, review });
  } catch (err) {
    console.error('[Onboarding review]', err.message);
    res.status(500).json({ error: 'تعذّر الحفظ' });
  }
});

module.exports = { publicRouter, adminRouter, featureOn };
