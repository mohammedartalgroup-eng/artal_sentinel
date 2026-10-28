/**
 * onboarding-db.js — مخطط «استكمال ملف الموظف» (ميزة تجريبية معزولة).
 *
 * ⚠️ العزل هو الشرط الأول لهذه الميزة:
 *   • ملف مستقل تماماً عن database/db.js — لا يُعدّل مخطط النظام القائم بحرف.
 *   • لا يرمي أبداً عند التحميل: أي فشل هنا يترك state.ok = false فتُعطَّل
 *     الميزة وحدها، ويواصل خط الاستقطاب (التقديم/المتقدمون/المقابلات) عمله.
 *   • لا مفاتيح أجنبية تُغيّر سلوك الجداول القائمة — العلاقة تُشير إلى
 *     applicants(id) بـ ON DELETE CASCADE فقط، أي حذف متقدم ينظّف ملفه.
 *
 * فصل الجداول الثلاثة مقصود (وهو جوهر الفكرة):
 *   onboarding_sessions   حالة الرحلة   — أين وصل المرشح وهل انتهى.
 *   onboarding_documents  المستند نفسه  — الملف + نص OCR + من قرأه.
 *   onboarding_fields     الحقول        — قيمة خام + قيمة مُطبَّعة + مصدرها.
 *
 * ولماذا onboarding_fields منفصل عن applicants؟ لأن الذكاء الاصطناعي لا يكتب
 * في بيانات المتقدم الرسمية أبداً: يقترح → تتحقق القواعد → يؤكّد المرشح →
 * عندها فقط (وبقرار بشري من HR) تُنقل القيمة إلى النظام الرسمي.
 */

const db = require('./db');

const state = { ok: false, error: null };

// انتظار جاهزية المخطط الأساسي — db.js يشغّل تهيئته عند التحميل بشكل غير
// متزامن، وإنشاء جدول يشير إلى applicants قبل وجوده يفشل على قاعدة جديدة.
async function waitForApplicants(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const [rows] = await db.query("SHOW TABLES LIKE 'applicants'");
      if (rows.length) return true;
    } catch (e) { /* القاعدة لم تجهز بعد */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function init() {
  if (!await waitForApplicants()) {
    throw new Error('جدول applicants غير جاهز — تُعطَّل ميزة الاستكمال');
  }

  const conn = await db.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS onboarding_sessions (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        applicant_id  INT          NOT NULL,
        token         VARCHAR(64)  NOT NULL,
        status        VARCHAR(20)  NOT NULL DEFAULT 'not_started',
        required_docs VARCHAR(255) NOT NULL DEFAULT '',
        progress      TINYINT UNSIGNED NOT NULL DEFAULT 0,
        last_step     VARCHAR(40)  DEFAULT NULL,
        expires_at    DATETIME     DEFAULT NULL,
        revoked_at    DATETIME     DEFAULT NULL,
        opened_at     DATETIME     DEFAULT NULL,
        completed_at  DATETIME     DEFAULT NULL,
        created_by    VARCHAR(100) DEFAULT NULL,
        created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (applicant_id) REFERENCES applicants(id) ON DELETE CASCADE,
        UNIQUE KEY uq_token (token),
        INDEX idx_applicant (applicant_id),
        INDEX idx_status    (status)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    // status: not_started | in_progress | submitted
    // الرابط السري يُخزَّن نصاً صريحاً عمداً: HR يحتاج إعادة إرساله للمرشح بعد
    // أيام، ومن يصل إلى قاعدة البيانات يرى بيانات المتقدم كاملة أصلاً — فالتجزئة
    // هنا تكلفة تشغيلية بلا مكسب أمني حقيقي. الحماية = صلاحية زمنية + إبطال يدوي.

    await conn.query(`
      CREATE TABLE IF NOT EXISTS onboarding_documents (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        session_id    INT          NOT NULL,
        applicant_id  INT          NOT NULL,
        doc_type      VARCHAR(30)  NOT NULL,
        status        VARCHAR(20)  NOT NULL DEFAULT 'uploaded',
        review        VARCHAR(10)  NOT NULL DEFAULT 'yellow',
        is_current    TINYINT(1)   NOT NULL DEFAULT 1,
        file_name     VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) DEFAULT NULL,
        mime          VARCHAR(60)  DEFAULT NULL,
        size_bytes    INT UNSIGNED DEFAULT NULL,
        ocr_text      MEDIUMTEXT   DEFAULT NULL,
        ocr_provider  VARCHAR(30)  DEFAULT NULL,
        ocr_conf      DECIMAL(4,3) DEFAULT NULL,
        ai_used       TINYINT(1)   NOT NULL DEFAULT 0,
        ai_provider   VARCHAR(20)  DEFAULT NULL,
        ai_model      VARCHAR(60)  DEFAULT NULL,
        warnings      TEXT         DEFAULT NULL,
        hr_note       VARCHAR(255) DEFAULT NULL,
        created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
        INDEX idx_session (session_id, doc_type),
        INDEX idx_current (session_id, is_current),
        INDEX idx_applicant (applicant_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    // status: uploaded → extracted → confirmed   (rejected = مستند غير مقبول)
    // review: green (تم التحقق) | yellow (يحتاج مراجعة) | red (غير مقبول)
    // is_current: إعادة الرفع لا تحذف النسخة السابقة — تُنزلها إلى 0 ليبقى
    //             سجل تدقيق كامل لما رفعه المرشح فعلاً في كل محاولة.

    await conn.query(`
      CREATE TABLE IF NOT EXISTS onboarding_fields (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        session_id     INT          NOT NULL,
        doc_type       VARCHAR(30)  NOT NULL,
        field_key      VARCHAR(40)  NOT NULL,
        raw_value      VARCHAR(255) DEFAULT NULL,
        value          VARCHAR(255) DEFAULT NULL,
        source         VARCHAR(10)  NOT NULL DEFAULT 'ocr',
        confidence     DECIMAL(4,3) DEFAULT NULL,
        valid          TINYINT(1)   DEFAULT NULL,
        error          VARCHAR(160) DEFAULT NULL,
        user_confirmed TINYINT(1)   NOT NULL DEFAULT 0,
        updated_at     DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
        UNIQUE KEY uq_field (session_id, doc_type, field_key)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    // source: ocr | ai | user  — «من قال هذه القيمة» سؤال تدقيقي لا تجميلي:
    //         قيمة مصدرها user تعني إنساناً صحّح آلة، وهي إشارة لتحسين القواعد.

    // ترحيل: أثر قرار فريق التوظيف على المستند.
    //  «مقبول» كان يضبط review فقط، وهي قيمة يضبطها الاستخراج الآلي أيضاً —
    //  فلا يمكن تمييز «أخضر لأن القراءة نظيفة» من «أخضر لأن إنساناً اعتمده».
    //  والفرق حاسم: قرار الإنسان وحده يفتح باب الإضافة لنظام الموظفين.
    const [hrCols] = await conn.query("SHOW COLUMNS FROM onboarding_documents LIKE 'hr_decided_at'");
    if (hrCols.length === 0) {
      await conn.query(`
        ALTER TABLE onboarding_documents
          ADD COLUMN hr_decided_at DATETIME     DEFAULT NULL,
          ADD COLUMN hr_decided_by VARCHAR(100) DEFAULT NULL
      `);
      console.log('[DB] Migration: added hr_decided_at/by to onboarding_documents');
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS onboarding_employment (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        session_id          INT          NOT NULL,
        applicant_id        INT          NOT NULL,
        job_title           VARCHAR(60)  DEFAULT NULL,
        preferred_zone_name VARCHAR(120) DEFAULT NULL,
        basic_salary        DECIMAL(10,2) DEFAULT NULL,
        living_allowance    DECIMAL(10,2) DEFAULT NULL,
        other_allowances    DECIMAL(10,2) DEFAULT NULL,
        actual_start        DATE         DEFAULT NULL,
        contract_start      DATE         DEFAULT NULL,
        marital_status      VARCHAR(10)  DEFAULT NULL,
        qualification       VARCHAR(60)  DEFAULT NULL,
        specialization      VARCHAR(100) DEFAULT NULL,
        emergency_phone     VARCHAR(20)  DEFAULT NULL,
        email               VARCHAR(120) DEFAULT NULL,
        insurance_type      VARCHAR(30)  DEFAULT NULL,
        insurance_company   VARCHAR(120) DEFAULT NULL,
        ext_employee_id     INT          DEFAULT NULL,
        sync_status         VARCHAR(20)  DEFAULT NULL,
        sync_error          VARCHAR(255) DEFAULT NULL,
        synced_at           DATETIME     DEFAULT NULL,
        updated_by          VARCHAR(100) DEFAULT NULL,
        created_at          DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at          DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
        UNIQUE KEY uq_session (session_id),
        INDEX idx_applicant (applicant_id),
        INDEX idx_ext (ext_employee_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    // بيانات التوظيف التي يُدخلها فريق الموارد البشرية — راتب وبدلات ومسمّى
    // وموقع. لا تظهر في رحلة المرشح إطلاقاً، ولا تُكتب في جدول applicants.
    //
    // sync_status: pending | created | duplicate | failed
    //   duplicate = الهوية مسجّلة موظفاً مسبقاً، ومعها ext_employee_id لسجله —
    //   فتبقى مزامنة المرفقات إليه قراراً يدوياً لا نتيجةً تلقائية للرفض.

    // اسم الوثيقة عند المزامنة — يحدّده موظف الاستقطاب، وإلا فاسم النوع
    const [titleCols] = await conn.query("SHOW COLUMNS FROM onboarding_documents LIKE 'sync_title'");
    if (titleCols.length === 0) {
      await conn.query('ALTER TABLE onboarding_documents ADD COLUMN sync_title VARCHAR(190) DEFAULT NULL');
      console.log('[DB] Migration: added sync_title to onboarding_documents');
    }

    const [attCols] = await conn.query("SHOW COLUMNS FROM onboarding_employment LIKE 'attachments_synced_at'");
    if (attCols.length === 0) {
      await conn.query('ALTER TABLE onboarding_employment ADD COLUMN attachments_synced_at DATETIME DEFAULT NULL');
      console.log('[DB] Migration: added attachments_synced_at to onboarding_employment');
    }

    // إعدادات قالب واتساب الخاص بالميزة — تُكتب هنا لا في db.js حتى تبقى
    // الميزة قابلة للحذف كاملةً بحذف ملفاتها. INSERT IGNORE = لا تدهس تعديلاً
    // أجراه المدير من صفحة الإعدادات.
    const tplDefaults = [
      ['wa_tpl_onboarding_name', 'artal_onboarding_link_ar'],
      ['wa_tpl_onboarding_lang', 'ar'],
      ['wa_tpl_onboarding_cat',  'UTILITY'],
      ['wa_tpl_onboarding_vars', 'name,job,link'],
      // قالب «طلب بيانات إضافية»: الاسم يبقى فارغاً حتى يُعتمد في ميتا ويُكتب
      // من الإعدادات — وإلى ذلك الحين يُرسَل الطلب بقالب رابط الاستكمال.
      ['wa_tpl_extra_docs_name', ''],
      ['wa_tpl_extra_docs_lang', 'ar'],
      ['wa_tpl_extra_docs_cat',  'UTILITY'],
      ['wa_tpl_extra_docs_vars', 'name,docs,link'],
    ];
    for (const [k, v] of tplDefaults) {
      await conn.query('INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)', [k, v]);
    }

    state.ok = true;
    console.log('[DB] Onboarding schema ready ✓');
  } finally {
    conn.release();
  }
}

// ─── ترحيل: مستندات يتيمة في رحلة قديمة ─────────────────────────────────────
//  قبل إصدار 2026-10-28، إيقاف الرابط ثم «إرسال» أو «طلب بيانات إضافية» كان يفتح
//  رحلة جديدة فارغة وتبقى المستندات معلّقة بالقديمة التي لا تُعرض — فبدا للموظف
//  أن كل ما رُفع ضاع. الآن الرحلة الميتة تُحيا بدل أن تُستبدل، وهذا الترحيل يضمّ
//  ما سبق أن تيتّم: إن كانت آخر رحلة بلا مستند واحد وقبلها رحلة فيها مستندات،
//  تُنقل المستندات والحقول وبيانات التوظيف إلى الأخيرة ويُدمج المطلوب ويُعاد حساب
//  التقدّم. يُشغَّل مع كل إقلاع ولا يفعل شيئاً إن لم يجد — وآمن مع نسختين تعملان
//  معاً: قفل الصفّين ثم إعادة الفحص داخل المعاملة.
async function adoptOrphanDocs() {
  const rules = require('../utils/docRules');
  let pairs = [];
  try {
    pairs = await db.all(`
      SELECT l.id AS latest_id, p.id AS prev_id
        FROM onboarding_sessions l
        JOIN onboarding_sessions p ON p.applicant_id = l.applicant_id AND p.id < l.id
       WHERE l.id = (SELECT MAX(id) FROM onboarding_sessions WHERE applicant_id = l.applicant_id)
         AND p.id = (SELECT MAX(x.id) FROM onboarding_sessions x
                      WHERE x.applicant_id = l.applicant_id AND x.id < l.id
                        AND EXISTS (SELECT 1 FROM onboarding_documents d WHERE d.session_id = x.id))
         AND NOT EXISTS (SELECT 1 FROM onboarding_documents d WHERE d.session_id = l.id)`);
  } catch (e) {
    console.error('[Onboarding] adopt scan:', e.message);
    return;
  }

  for (const pr of pairs) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[latest]] = await conn.query('SELECT * FROM onboarding_sessions WHERE id = ? FOR UPDATE', [pr.latest_id]);
      const [[prev]]   = await conn.query('SELECT * FROM onboarding_sessions WHERE id = ? FOR UPDATE', [pr.prev_id]);
      const [[{ n }]]  = await conn.query('SELECT COUNT(*) AS n FROM onboarding_documents WHERE session_id = ?', [pr.latest_id]);
      if (!latest || !prev || n > 0) { await conn.rollback(); continue; }   // سبقتنا النسخة الأخرى

      await conn.query('UPDATE onboarding_documents SET session_id = ? WHERE session_id = ?', [latest.id, prev.id]);
      // الحقول: عند تعارض على نفس الحقل يبقى ما في الأخيرة (الأحدث) ويُهمل القديم
      await conn.query('UPDATE IGNORE onboarding_fields SET session_id = ? WHERE session_id = ?', [latest.id, prev.id]);
      await conn.query('DELETE FROM onboarding_fields WHERE session_id = ?', [prev.id]);
      const [[empLatest]] = await conn.query('SELECT id FROM onboarding_employment WHERE session_id = ?', [latest.id]);
      if (!empLatest) {
        await conn.query('UPDATE onboarding_employment SET session_id = ? WHERE session_id = ?', [latest.id, prev.id]);
      }

      const want = new Set([...String(prev.required_docs || '').split(','), ...String(latest.required_docs || '').split(',')].filter(Boolean));
      const required = rules.DOC_KEYS.filter(k => want.has(k));
      const [done] = await conn.query(
        "SELECT doc_type FROM onboarding_documents WHERE session_id = ? AND is_current = 1 AND status = 'confirmed'", [latest.id]
      );
      const doneSet = new Set(done.map(d => d.doc_type));
      const completed = required.filter(t => doneSet.has(t)).length;
      const progress = required.length ? Math.round((completed / required.length) * 100) : 0;
      await conn.query(
        'UPDATE onboarding_sessions SET required_docs = ?, progress = ?, status = ?, completed_at = ? WHERE id = ?',
        [required.join(','), progress, progress >= 100 ? 'submitted' : 'in_progress', progress >= 100 ? new Date() : null, latest.id]
      );
      await conn.query(
        'INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
        [latest.applicant_id, `ضُمّت مستندات رحلة الاستكمال السابقة (#${prev.id}) إلى الرابط الحالي — لم يضع شيء`, 'note', 'النظام']
      );
      await conn.commit();
      console.log(`[Onboarding] adopt: applicant #${latest.applicant_id} — session #${prev.id} → #${latest.id} (${progress}%)`);
    } catch (e) {
      await conn.rollback().catch(() => {});
      console.error('[Onboarding] adopt failed:', e.message);
    } finally {
      conn.release();
    }
  }
}

// لا await ولا process.exit — الفشل يُسجَّل ويُعطِّل الميزة وحدها.
init()
  .then(adoptOrphanDocs)
  .catch(err => {
    state.error = err.message;
    console.error('[DB] Onboarding schema failed — ميزة الاستكمال معطّلة، وبقية النظام يعمل:', err.message);
  });

module.exports = { state, db };
