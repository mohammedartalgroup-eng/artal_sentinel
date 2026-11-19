/**
 * leads-db.js — مخطط «التوصيات»: أشخاص لدينا جوالهم (واسمهم ربما) ولم يتقدموا بعد.
 *
 * لماذا جدول مستقل لا صفّ متقدم ناقص؟ لأن المتقدم في هذا النظام يبدأ برقم هوية:
 * إلزامي، عشرة أرقام، وعليه يُبنى فحص النظام الخارجي والتقارير وملف الاستكمال.
 * الموصى به لا نملك منه إلا جواله — وحشره في applicants بهوية مؤقتة يفسد كل ما
 * يُبنى على الهوية. التوصية تعيش هنا حتى يتقدّم صاحبها بنفسه من رابطه الشخصي،
 * فيُربط طلبه بها ويصير متقدماً بالمسار المعتاد.
 *
 * نفس عزل onboarding-db.js: لا يرمي عند التحميل، وفشله يعطّل الميزة وحدها.
 */

const db = require('./db');

const state = { ok: false, error: null };

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
    throw new Error('جدول applicants غير جاهز — تُعطَّل ميزة التوصيات');
  }

  const conn = await db.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        phone            VARCHAR(10)  NOT NULL,
        full_name        VARCHAR(200) DEFAULT NULL,
        referred_by      VARCHAR(120) DEFAULT NULL,
        note             VARCHAR(500) DEFAULT NULL,
        token            VARCHAR(64)  NOT NULL,
        status           VARCHAR(20)  NOT NULL DEFAULT 'new',
        close_reason     VARCHAR(120) DEFAULT NULL,
        applicant_id     INT          DEFAULT NULL,
        invite_count     TINYINT UNSIGNED NOT NULL DEFAULT 0,
        invited_at       DATETIME     DEFAULT NULL,
        last_send_status VARCHAR(12)  DEFAULT NULL,
        last_send_error  VARCHAR(255) DEFAULT NULL,
        opened_at        DATETIME     DEFAULT NULL,
        applied_at       DATETIME     DEFAULT NULL,
        closed_at        DATETIME     DEFAULT NULL,
        created_by       VARCHAR(100) DEFAULT NULL,
        created_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_token (token),
        INDEX idx_phone (phone),
        INDEX idx_status (status),
        INDEX idx_applicant (applicant_id),
        FOREIGN KEY (applicant_id) REFERENCES applicants(id) ON DELETE SET NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    // status: new (أُضيفت) | invited (أُرسلت الدعوة) | opened (فُتح الرابط)
    //         | applied (تقدّم — مربوطة بطلب) | closed (أُغلقت بسبب)
    // token: رمز رابط التقديم الشخصي /apply?ref=… — يُخزَّن صريحاً كرابط الاستكمال:
    //        الموظف يعيد إرساله بعد أيام، والحماية هي قِصر العمر لا التجزئة.

    // موظف أضافته لوحة العمليات مؤقتاً في نظام الموظفين وليس له طلب عندنا: يدخل هنا
    // كتوصية ويُدعى ليسجّل بنفسه (وبموافقته)، ثم تُفتح له رحلة الاستكمال حين يسجّل.
    //   ext_employee_id / ext_national_id: رقمه وهويته هناك — بهما يُربط طلبه بملفه
    //   reminded_at: تذكير واحد إن لم يسجّل بعد أيام
    const quickHireCols = [
      ['ext_employee_id', 'INT DEFAULT NULL'],
      ['ext_national_id', 'VARCHAR(10) DEFAULT NULL'],
      ['reminded_at',     'DATETIME DEFAULT NULL'],
      // طلب إضافة ينتظر مرفقاته الأساسية: رقم الطلب في نظام الموظفين، وسطر المرحلة المعروض
      ['hire_request_id', 'INT DEFAULT NULL'],
      ['stage',           'VARCHAR(120) DEFAULT NULL'],
    ];
    for (const [name, def] of quickHireCols) {
      const [cols] = await conn.query('SHOW COLUMNS FROM leads LIKE ?', [name]);
      if (cols.length === 0) {
        await conn.query(`ALTER TABLE leads ADD COLUMN ${name} ${def}`);
        console.log(`[DB] Migration: added ${name} to leads`);
      }
    }
    const [extIdx] = await conn.query("SHOW INDEX FROM leads WHERE Key_name = 'idx_ext_employee'");
    if (extIdx.length === 0) {
      await conn.query('ALTER TABLE leads ADD INDEX idx_ext_employee (ext_employee_id)');
    }

    // قالب واتساب الخاص بالميزة — الاسم فارغ حتى يُعتمد في ميتا ويُكتب من الإعدادات.
    // INSERT IGNORE = لا تدهس تعديلاً أجراه المدير من صفحة الإعدادات.
    const tplDefaults = [
      ['wa_tpl_invite_name', ''],
      ['wa_tpl_invite_lang', 'ar'],
      ['wa_tpl_invite_cat',  'UTILITY'],
      ['wa_tpl_invite_vars', 'name,link'],
      // دعوة الموظف المؤقت (من لوحة العمليات) — فارغ حتى يُعتمد قالبها؛ وحتى ذلك تُرسل «دعوة للتقديم»
      ['wa_tpl_invite_employee_name', ''],
      ['wa_tpl_invite_employee_lang', 'ar'],
      ['wa_tpl_invite_employee_cat',  'UTILITY'],
      ['wa_tpl_invite_employee_vars', 'name,link'],
    ];
    // نص «دعوة موظف مؤقت» في النسخة المحفوظة — INSERT IGNORE: لا يكتب فوق ما زامنه Chatwoot
    const WT = require('../utils/waTemplates');
    const inv = WT.get('invite_employee');
    // جدول النسخة المحفوظة يُنشئه db.js بعد applicants — ننتظره حتى لا تفوت البذرة
    let hasStore = false;
    for (let i = 0; i < 40 && !hasStore; i++) {
      const [t] = await conn.query("SHOW TABLES LIKE 'wa_templates'");
      hasStore = t.length > 0;
      if (!hasStore) await new Promise(r => setTimeout(r, 500));
    }
    if (inv?.defaultName && hasStore) {
      const body = inv.preview.join ? inv.preview : String(inv.preview);
      const text = String(body).replace('{name}', '{{1}}').replace('{link}', '{{2}}');
      await conn.query(
        'INSERT IGNORE INTO wa_templates (name, language, inbox_id, data) VALUES (?, ?, NULL, ?)',
        [inv.defaultName, 'ar', JSON.stringify({
          name: inv.defaultName, language: 'ar', status: 'local', body: text,
          components: [{ type: 'BODY', text }, { type: 'FOOTER', text: inv.previewFooter }],
        })]
      ).catch(e => console.error('[DB] seed invite_employee text:', e.message));
    }

    for (const [k, v] of tplDefaults) {
      await conn.query('INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)', [k, v]);
    }

    state.ok = true;
    console.log('[DB] Leads schema ready ✓');
  } finally {
    conn.release();
  }
}

// ─── تنظيف دوري ──────────────────────────────────────────────────────────────
//  جوال شخص لم يتقدم لا مبرر لبقائه عندنا طويلاً — وصلنا من طرف ثالث لا منه:
//   • توصية أُرسلت دعوتها ولم يستجب صاحبها 30 يوماً تُغلق تلقائياً بسببها.
//   • توصية غير محوَّلة (مغلقة أو لم تُرسل أصلاً) تُحذف بعد 90 يوماً من إضافتها.
//  ما تحوّل إلى طلب يبقى — صار جزءاً من ملف متقدم له سياسته الخاصة.
async function cleanup() {
  try {
    const a = await db.run(
      `UPDATE leads SET status = 'closed', close_reason = 'لم يستجب خلال 30 يوماً', closed_at = NOW()
        WHERE status IN ('invited', 'opened') AND invited_at < NOW() - INTERVAL 30 DAY
          AND ext_employee_id IS NULL AND hire_request_id IS NULL`
    );
    // الموظف المؤقت من لوحة العمليات مستثنى من الإغلاق والحذف: هو موظف فعلاً وملفه
    // ينتظر الاستكمال — لا يُسقَط بصمت، يبقى ظاهراً حتى يسجّل أو يُغلق بقرار.
    const b = await db.run(
      `DELETE FROM leads WHERE status <> 'applied' AND created_at < NOW() - INTERVAL 90 DAY
          AND ext_employee_id IS NULL AND hire_request_id IS NULL`
    );
    if (a.affectedRows || b.affectedRows) {
      console.log(`[Leads] تنظيف: أُغلق ${a.affectedRows} — حُذف ${b.affectedRows}`);
    }
  } catch (e) {
    console.error('[Leads] cleanup:', e.message);
  }
}

// لا await ولا process.exit — الفشل يُسجَّل ويُعطِّل الميزة وحدها.
init()
  .then(() => {
    setTimeout(cleanup, 60 * 1000).unref();
    setInterval(cleanup, 24 * 3600 * 1000).unref();
  })
  .catch(err => {
    state.error = err.message;
    console.error('[DB] Leads schema failed — ميزة التوصيات معطّلة، وبقية النظام يعمل:', err.message);
  });

module.exports = { state, db };
