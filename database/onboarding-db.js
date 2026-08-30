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

    // إعدادات قالب واتساب الخاص بالميزة — تُكتب هنا لا في db.js حتى تبقى
    // الميزة قابلة للحذف كاملةً بحذف ملفاتها. INSERT IGNORE = لا تدهس تعديلاً
    // أجراه المدير من صفحة الإعدادات.
    const tplDefaults = [
      ['wa_tpl_onboarding_name', 'artal_onboarding_link_ar'],
      ['wa_tpl_onboarding_lang', 'ar'],
      ['wa_tpl_onboarding_cat',  'UTILITY'],
      ['wa_tpl_onboarding_vars', 'name,job,link'],
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

// لا await ولا process.exit — الفشل يُسجَّل ويُعطِّل الميزة وحدها.
init().catch(err => {
  state.error = err.message;
  console.error('[DB] Onboarding schema failed — ميزة الاستكمال معطّلة، وبقية النظام يعمل:', err.message);
});

module.exports = { state, db };
