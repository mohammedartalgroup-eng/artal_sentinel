const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

// ─── Connection Pool ─────────────────────────────────────────────────────────

const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: '+00:00',
  decimalNumbers: true
});

// ─── Helper Methods ──────────────────────────────────────────────────────────

// جلب صف واحد
pool.get = async function (sql, params = []) {
  const [rows] = await this.execute(sql, params);
  return rows[0] || null;
};

// جلب جميع الصفوف
pool.all = async function (sql, params = []) {
  const [rows] = await this.execute(sql, params);
  return rows;
};

// تنفيذ INSERT / UPDATE / DELETE
pool.run = async function (sql, params = []) {
  const [result] = await this.execute(sql, params);
  return { insertId: result.insertId, affectedRows: result.affectedRows };
};

// تسجيل نشاط المتقدم
pool.logActivity = async function (applicantId, action, oldVal = null, newVal = null, userName = null) {
  await this.run(
    'INSERT INTO applicant_activity (applicant_id, action, old_value, new_value, user_name) VALUES (?, ?, ?, ?, ?)',
    [applicantId, action, oldVal, newVal, userName]
  );
};

// تسجيل تدقيق النظام (لا يُوقف العملية إن فشل)
pool.audit = async function (userId, username, action, targetType = null, targetId = null, targetName = null, details = null, ip = null) {
  try {
    await this.run(
      `INSERT INTO audit_log
         (user_id, username, action, target_type, target_id, target_name, details, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, username, action, targetType, targetId, targetName, details, ip]
    );
  } catch (e) {
    console.error('[Audit]', e.message);
  }
};

// جلب الإعدادات كـ object
pool.getSettings = async function () {
  const rows = await this.all('SELECT `key`, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
};

/**
 * كتابة عدة إعدادات دفعةً واحدة — استعلام واحد لا استعلام لكل مفتاح.
 *
 * ⚠️ لماذا دفعة؟ إطلاق عشرين UPDATE بالتوازي عبر Promise.all يفتح عشرين
 *    اتصالاً في آن واحد، وتُحدّ الاستضافة المشتركة الاتصالات المتزامنة لكل
 *    مستخدم فيسقط الحفظ كاملاً. استعلام واحد = اتصال واحد.
 *
 * وهو upsert لا UPDATE: مفتاح جديد لم تُنشئه كتلة الإعدادات الافتراضية
 * (لو تعطّلت مثلاً) كان UPDATE يتجاهله بصمت فيبدو الحفظ ناجحاً بلا أثر.
 */
pool.setSettings = async function (pairs) {
  const entries = Object.entries(pairs || {}).filter(([k]) => k);
  if (!entries.length) return 0;
  const placeholders = entries.map(() => '(?, ?)').join(', ');
  const params = entries.flatMap(([k, v]) => [String(k), String(v == null ? '' : v)]);
  const [r] = await this.query(
    'INSERT INTO settings (`key`, value) VALUES ' + placeholders +
    ' ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP',
    params
  );
  return r.affectedRows;
};

// ─── علم جاهزية مخطط المقابلات ───────────────────────────────────────────────
// ميزة المقابلات معزولة تماماً: إن فشل إنشاء جدولها يبقى العلم false وتُعطَّل الميزة
// وحدها، بينما يواصل خط الاستقطاب (التقديم + المتقدمون + المتابعة) عمله كالمعتاد.
pool.INTERVIEWS_SCHEMA_OK = false;

// ─── Schema ──────────────────────────────────────────────────────────────────

async function initialize() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS applicants (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        full_name     VARCHAR(200) NOT NULL,
        id_number     VARCHAR(10)  NOT NULL UNIQUE,
        phone         VARCHAR(10)  NOT NULL,
        age           TINYINT UNSIGNED,
        city          VARCHAR(60),
        has_car       TINYINT(1)   NOT NULL DEFAULT 0,
        has_license   TINYINT(1)   NOT NULL DEFAULT 0,
        cv_path       VARCHAR(255),
        id_image_path VARCHAR(255),
        status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
        rating        TINYINT      NOT NULL DEFAULT 0,
        created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status     (status),
        INDEX idx_city       (city),
        INDEX idx_created_at (created_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS applicant_notes (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        applicant_id INT          NOT NULL,
        content      TEXT         NOT NULL,
        type         VARCHAR(20)  NOT NULL DEFAULT 'note',
        created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (applicant_id) REFERENCES applicants(id) ON DELETE CASCADE,
        INDEX idx_applicant (applicant_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS applicant_activity (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        applicant_id INT          NOT NULL,
        action       VARCHAR(100) NOT NULL,
        old_value    VARCHAR(255),
        new_value    VARCHAR(255),
        created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (applicant_id) REFERENCES applicants(id) ON DELETE CASCADE,
        INDEX idx_applicant (applicant_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS settings (
        \`key\`      VARCHAR(50)   PRIMARY KEY,
        value        VARCHAR(1000) NOT NULL DEFAULT '',
        updated_at   DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        username      VARCHAR(50)  UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // ─── ترحيل: إضافة english, qualification, specialization
    const [enCols] = await conn.query("SHOW COLUMNS FROM applicants LIKE 'english'");
    if (enCols.length === 0) {
      await conn.query("ALTER TABLE applicants ADD COLUMN english TINYINT(1) DEFAULT NULL AFTER has_license");
      console.log('[DB] Migration: added column english');
    }
    const [quCols] = await conn.query("SHOW COLUMNS FROM applicants LIKE 'qualification'");
    if (quCols.length === 0) {
      await conn.query("ALTER TABLE applicants ADD COLUMN qualification VARCHAR(20) DEFAULT NULL AFTER english");
      console.log('[DB] Migration: added column qualification');
    }
    const [spCols] = await conn.query("SHOW COLUMNS FROM applicants LIKE 'specialization'");
    if (spCols.length === 0) {
      await conn.query("ALTER TABLE applicants ADD COLUMN specialization VARCHAR(100) DEFAULT NULL AFTER qualification");
      console.log('[DB] Migration: added column specialization');
    }

    // ─── ترحيل: إضافة gender إلى applicants إن لم يكن موجوداً
    const [gCols] = await conn.query("SHOW COLUMNS FROM applicants LIKE 'gender'");
    if (gCols.length === 0) {
      await conn.query("ALTER TABLE applicants ADD COLUMN gender VARCHAR(6) AFTER age");
      console.log('[DB] Migration: added column gender');
    }

    // ─── ترحيل: إضافة region و neighborhood إلى applicants إن لم تكونا موجودتين
    const [rCols] = await conn.query("SHOW COLUMNS FROM applicants LIKE 'region'");
    if (rCols.length === 0) {
      await conn.query("ALTER TABLE applicants ADD COLUMN region VARCHAR(60) AFTER city");
      console.log('[DB] Migration: added column region');
    }
    const [nCols] = await conn.query("SHOW COLUMNS FROM applicants LIKE 'neighborhood'");
    if (nCols.length === 0) {
      await conn.query("ALTER TABLE applicants ADD COLUMN neighborhood VARCHAR(100) AFTER region");
      console.log('[DB] Migration: added column neighborhood');
    }

    // ─── ترحيل: إضافة البريد الإلكتروني (اختياري) إلى applicants
    const [emCols] = await conn.query("SHOW COLUMNS FROM applicants LIKE 'email'");
    if (emCols.length === 0) {
      await conn.query("ALTER TABLE applicants ADD COLUMN email VARCHAR(120) DEFAULT NULL AFTER phone");
      console.log('[DB] Migration: added column email');
    }

    // ─── ترحيل: أعمدة مصدر الزيارة (من أين جاء المتقدم)
    const [srcCols] = await conn.query("SHOW COLUMNS FROM applicants LIKE 'source'");
    if (srcCols.length === 0) {
      await conn.query("ALTER TABLE applicants ADD COLUMN source VARCHAR(60) DEFAULT NULL");
      await conn.query("ALTER TABLE applicants ADD COLUMN referrer VARCHAR(255) DEFAULT NULL");
      await conn.query("ALTER TABLE applicants ADD COLUMN landing_page VARCHAR(255) DEFAULT NULL");
      await conn.query("ALTER TABLE applicants ADD INDEX idx_source (source)");
      console.log('[DB] Migration: added source/referrer/landing_page columns');
    }

    // ─── ترحيل: السماح بإعادة التقديم — تحويل قيد الهوية الفريد إلى فهرس عادي
    //     ⚠️ لا يحذف أي بيانات؛ يزيل قيد الفرادة فقط ويُبقي فهرساً للبحث السريع.
    try {
      const [uqIdx] = await conn.query("SHOW INDEX FROM applicants WHERE Column_name = 'id_number' AND Non_unique = 0");
      if (uqIdx.length) {
        await conn.query(`ALTER TABLE applicants DROP INDEX \`${uqIdx[0].Key_name}\``);
        const [normIdx] = await conn.query("SHOW INDEX FROM applicants WHERE Column_name = 'id_number' AND Non_unique = 1");
        if (!normIdx.length) await conn.query("ALTER TABLE applicants ADD INDEX idx_id_number (id_number)");
        console.log('[DB] Migration: id_number UNIQUE → normal index (allow re-applications)');
      }
    } catch (e) {
      console.error('[DB] Migration (id_number index):', e.message);
    }

    // ─── audit_log
    await conn.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        user_id     INT,
        username    VARCHAR(50)  NOT NULL,
        action      VARCHAR(50)  NOT NULL,
        target_type VARCHAR(20),
        target_id   INT,
        target_name VARCHAR(200),
        details     VARCHAR(500),
        ip          VARCHAR(45),
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id  (user_id),
        INDEX idx_created  (created_at),
        INDEX idx_action   (action)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // ─── ترحيل: إضافة role, is_active, last_login إلى admin_users
    const [roleCols] = await conn.query("SHOW COLUMNS FROM admin_users LIKE 'role'");
    if (roleCols.length === 0) {
      await conn.query("ALTER TABLE admin_users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'manager' AFTER username");
      console.log('[DB] Migration: added column role (existing users → manager)');
    }
    const [activeCols] = await conn.query("SHOW COLUMNS FROM admin_users LIKE 'is_active'");
    if (activeCols.length === 0) {
      await conn.query("ALTER TABLE admin_users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER role");
      console.log('[DB] Migration: added column is_active');
    }
    const [loginCols] = await conn.query("SHOW COLUMNS FROM admin_users LIKE 'last_login'");
    if (loginCols.length === 0) {
      await conn.query("ALTER TABLE admin_users ADD COLUMN last_login DATETIME DEFAULT NULL AFTER is_active");
      console.log('[DB] Migration: added column last_login');
    }

    // ─── ترحيل: إضافة حقول الفحص الخارجي إلى applicants
    const [extCols] = await conn.query("SHOW COLUMNS FROM applicants LIKE 'ext_check_done'");
    if (extCols.length === 0) {
      await conn.query(`
        ALTER TABLE applicants
          ADD COLUMN ext_check_done  TINYINT(1)   NOT NULL DEFAULT 0,
          ADD COLUMN ext_found       TINYINT(1)   DEFAULT NULL,
          ADD COLUMN ext_employee_id INT          DEFAULT NULL,
          ADD COLUMN ext_status      TINYINT(1)   DEFAULT NULL,
          ADD COLUMN ext_job_status  VARCHAR(50)  DEFAULT NULL,
          ADD COLUMN ext_checked_at  DATETIME     DEFAULT NULL
      `);
      console.log('[DB] Migration: added ext_check columns to applicants');
    }

    // ─── ترحيل: إضافة user_name إلى applicant_notes و applicant_activity
    const [anCols] = await conn.query("SHOW COLUMNS FROM applicant_notes LIKE 'user_name'");
    if (anCols.length === 0) {
      await conn.query("ALTER TABLE applicant_notes ADD COLUMN user_name VARCHAR(100) DEFAULT NULL AFTER type");
      console.log('[DB] Migration: added column user_name to applicant_notes');
    }

    // ─── ترحيل: إضافة updated_at إلى applicant_notes (لتتبع تعديل الملاحظات)
    const [anUpdCols] = await conn.query("SHOW COLUMNS FROM applicant_notes LIKE 'updated_at'");
    if (anUpdCols.length === 0) {
      await conn.query("ALTER TABLE applicant_notes ADD COLUMN updated_at DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP AFTER created_at");
      console.log('[DB] Migration: added column updated_at to applicant_notes');
    }
    const [aaCols] = await conn.query("SHOW COLUMNS FROM applicant_activity LIKE 'user_name'");
    if (aaCols.length === 0) {
      await conn.query("ALTER TABLE applicant_activity ADD COLUMN user_name VARCHAR(100) DEFAULT NULL AFTER new_value");
      console.log('[DB] Migration: added column user_name to applicant_activity');
    }

    // ─── ترحيل: إضافة full_name إلى admin_users
    const [fnCols] = await conn.query("SHOW COLUMNS FROM admin_users LIKE 'full_name'");
    if (fnCols.length === 0) {
      await conn.query("ALTER TABLE admin_users ADD COLUMN full_name VARCHAR(100) DEFAULT NULL AFTER username");
      console.log('[DB] Migration: added column full_name to admin_users');
    }

    // ─── ترحيل: فهارس الأعمدة المضافة بالترحيل ──────────────────────────────
    const idxChecks = [
      ['applicants',  'idx_region',         'ADD INDEX idx_region (region)'],
      ['applicants',  'idx_gender',         'ADD INDEX idx_gender (gender)'],
      ['applicants',  'idx_qualification',  'ADD INDEX idx_qualification (qualification)'],
      ['applicants',  'idx_status_created', 'ADD INDEX idx_status_created (status, created_at)'],
      ['audit_log',   'idx_username',       'ADD INDEX idx_username (username)'],
      ['audit_log',   'idx_target',         'ADD INDEX idx_target (target_type, target_id)'],
    ];
    for (const [table, name, ddl] of idxChecks) {
      const [idxRows] = await conn.query(
        'SELECT COUNT(*) as c FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
        [table, name]
      );
      if (idxRows[0].c === 0) {
        await conn.query(`ALTER TABLE ${table} ${ddl}`);
        console.log(`[DB] Migration: added index ${name} on ${table}`);
      }
    }

    // ─── ترحيل: تحويل اليوزرنيم الافتراضي إلى إيميل
    const [oldAdmin] = await conn.query("SELECT id FROM admin_users WHERE username = 'admin'");
    if (oldAdmin.length > 0) {
      await conn.query("UPDATE admin_users SET username = 'admin@artal.com' WHERE username = 'admin'");
      console.log('[DB] Migration: admin → admin@artal.com');
    }
    const [oldMgr] = await conn.query("SELECT id FROM admin_users WHERE username = 'artal_manager'");
    if (oldMgr.length > 0) {
      await conn.query("UPDATE admin_users SET username = 'manager@artal.com' WHERE username = 'artal_manager'");
      console.log('[DB] Migration: artal_manager → manager@artal.com');
    }

    // ─── الإعدادات الافتراضية
    const defaults = [
      ['phone',                  '+966 500 000 000'],
      ['whatsapp',               '+966 500 000 000'],
      ['email',                  'recruitment@artal.com'],
      ['address',                'الرياض، المملكة العربية السعودية'],
      ['maps_url',               ''],
      ['company_name',           'Artal Security Guards'],
      ['accepting_applications', 'true'],
    ];
    for (const [k, v] of defaults) {
      await conn.query(
        'INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)',
        [k, v]
      );
    }

    // ─── مستخدم أدمن افتراضي (نظام جديد تماماً)
    const [admins] = await conn.query('SELECT id FROM admin_users LIMIT 1');
    if (admins.length === 0) {
      const hash = await bcrypt.hash('admin123', 12);
      await conn.query(
        "INSERT INTO admin_users (username, full_name, password_hash) VALUES ('admin@artal.com', 'مدير النظام', ?)",
        [hash]
      );
      console.log('[DB] Default admin created — email: admin@artal.com (check .env or change via admin panel)');
    }

    // ─── ترحيل: إنشاء حساب مدير رئيسي وتحويل الحساب الأول إلى موظف
    const [mgrExists] = await conn.query("SELECT id FROM admin_users WHERE username = 'manager@artal.com'");
    if (mgrExists.length === 0) {
      const mgrHash = await bcrypt.hash('Artal@2025', 12);
      await conn.query(
        "INSERT INTO admin_users (username, full_name, role, is_active, password_hash) VALUES ('manager@artal.com', 'المدير الرئيسي', 'manager', 1, ?)",
        [mgrHash]
      );
      // تحويل الحساب الأول إلى موظف
      await conn.query("UPDATE admin_users SET role = 'employee' WHERE username = 'admin@artal.com'");
      console.log('[DB] Migration: manager@artal.com (manager) created — change password via admin panel');
      console.log('[DB] Migration: admin@artal.com demoted to employee');
    }

    console.log('[DB] MySQL connected & schema ready ✓');

    // ─── المقابلات الأونلاين (Google Meet) — كتلة معزولة ──────────────────────
    //  ⚠️ كل ما يخص المقابلات داخل try/catch لا يرمي أبداً: أي فشل هنا يُعطّل
    //     ميزة المقابلات وحدها ولا يمنع الموقع من الإقلاع (نموذج التقديم،
    //     المتقدمون، المتابعة، التقارير — كلها تبقى تعمل).
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS interviews (
          id              INT AUTO_INCREMENT PRIMARY KEY,
          applicant_id    INT NOT NULL,
          start_at        DATETIME NOT NULL,
          end_at          DATETIME NOT NULL,
          start_local     CHAR(16) NOT NULL,
          duration_min    SMALLINT UNSIGNED NOT NULL,
          slot_key        VARCHAR(20)  DEFAULT NULL,
          status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
          interviewers    VARCHAR(500) NOT NULL DEFAULT '',
          google_event_id VARCHAR(128) DEFAULT NULL,
          meet_link       VARCHAR(255) DEFAULT NULL,
          html_link       VARCHAR(500) DEFAULT NULL,
          created_by      VARCHAR(100) DEFAULT NULL,
          created_by_id   INT          DEFAULT NULL,
          cancelled_by    VARCHAR(100) DEFAULT NULL,
          cancel_reason   VARCHAR(255) DEFAULT NULL,
          last_error      VARCHAR(255) DEFAULT NULL,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (applicant_id) REFERENCES applicants(id) ON DELETE CASCADE,
          UNIQUE KEY uq_slot (slot_key),
          INDEX idx_applicant (applicant_id),
          INDEX idx_start     (start_at),
          INDEX idx_local     (start_local),
          INDEX idx_status    (status)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);

      // ملاحظات على التصميم:
      //  • start_at/end_at بتوقيت UTC وتُكتب دائماً بربط كائن Date من Node،
      //    ولا تُستخدم NOW()/CURRENT_TIMESTAMP لأوقات المقابلات إطلاقاً
      //    (توقيت خادم MySQL مجهول، بينما ربط Date يذهب ويعود UTC بدقة).
      //  • start_local نسخة نصية بتوقيت الرياض للفلترة المفهرسة والعرض البشري.
      //  • slot_key فريد = قفل الحجز المزدوج؛ الإلغاء يجعله NULL فيتحرر الموعد
      //    (MySQL يسمح بقيم NULL متعددة في الفهرس الفريد) دون حذف السجل.

      const ivIdx = [
        ['idx_start_status', 'ADD INDEX idx_start_status (start_at, status)'],
      ];
      for (const [name, ddl] of ivIdx) {
        const [rows] = await conn.query(
          'SELECT COUNT(*) as c FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
          ['interviews', name]
        );
        if (rows[0].c === 0) {
          await conn.query(`ALTER TABLE interviews ${ddl}`);
          console.log(`[DB] Migration: added index ${name} on interviews`);
        }
      }

      // المسمّى الوظيفي يُثبَّت على المقابلة وقت الجدولة: قالب واتساب يذكره،
      // وإعادة الإرسال بعد أسابيع يجب أن ترسل نفس النص الذي وافق عليه الموظف.
      const [ivJobCols] = await conn.query("SHOW COLUMNS FROM interviews LIKE 'job_title'");
      if (ivJobCols.length === 0) {
        await conn.query("ALTER TABLE interviews ADD COLUMN job_title VARCHAR(100) DEFAULT NULL");
        console.log('[DB] Migration: added column job_title to interviews');
      }

      const [ivErrCols] = await conn.query("SHOW COLUMNS FROM interviews LIKE 'last_error'");
      if (ivErrCols.length === 0) {
        await conn.query("ALTER TABLE interviews ADD COLUMN last_error VARCHAR(255) DEFAULT NULL");
        console.log('[DB] Migration: added column last_error to interviews');
      }

      // سجل إشعارات المتقدم (واتساب/بريد) — صف لكل محاولة إرسال.
      //  لماذا سجل مستقل بدل عمود في interviews؟ الإرسال يتكرر (جدولة، إعادة
      //  جدولة، إلغاء، إعادة إرسال يدوية) وكل محاولة لها قناة وحالة وسبب فشل
      //  خاص بها — والاحتفاظ بها كاملة هو ما يجيب «هل وصل المتقدم فعلاً؟».
      await conn.query(`
        CREATE TABLE IF NOT EXISTS interview_messages (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          interview_id INT NOT NULL,
          applicant_id INT NOT NULL,
          channel      VARCHAR(10)  NOT NULL,
          kind         VARCHAR(20)  NOT NULL,
          status       VARCHAR(12)  NOT NULL,
          target       VARCHAR(160) DEFAULT NULL,
          provider_ref VARCHAR(120) DEFAULT NULL,
          error        VARCHAR(255) DEFAULT NULL,
          created_by   VARCHAR(100) DEFAULT NULL,
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (interview_id) REFERENCES interviews(id) ON DELETE CASCADE,
          INDEX idx_iv        (interview_id),
          INDEX idx_applicant (applicant_id),
          INDEX idx_lookup    (interview_id, channel, id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);
      //  channel: whatsapp | email
      //  kind:    scheduled | rescheduled | cancelled
      //  status:  sent | failed | skipped   (skipped = لا رقم/بريد، أو القناة مطفأة)

      // رسائل قوالب غير مرتبطة بموعد (طلب استكمال بيانات …).
      //  لماذا جدول منفصل عن interview_messages؟ ذاك مفتاحه الأجنبي على
      //  interviews ويُحذف بحذفها، وهذه الرسائل تخصّ المتقدم نفسه ويجب أن
      //  تبقى في سجله حتى لو لم تُجدول له مقابلة قط.
      await conn.query(`
        CREATE TABLE IF NOT EXISTS applicant_messages (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          applicant_id INT NOT NULL,
          channel      VARCHAR(10)  NOT NULL,
          kind         VARCHAR(30)  NOT NULL,
          status       VARCHAR(12)  NOT NULL,
          target       VARCHAR(160) DEFAULT NULL,
          provider_ref VARCHAR(120) DEFAULT NULL,
          error        VARCHAR(255) DEFAULT NULL,
          created_by   VARCHAR(100) DEFAULT NULL,
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (applicant_id) REFERENCES applicants(id) ON DELETE CASCADE,
          INDEX idx_applicant (applicant_id),
          INDEX idx_kind      (applicant_id, kind, id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);

      // إعدادات المقابلات — 0=الأحد … 5=الجمعة … 6=السبت (الافتراضي: السبت–الخميس)
      const ivDefaults = [
        ['interviews_enabled',     'true'],
        ['interview_duration',     '15'],
        ['interview_work_days',    '0,1,2,3,4,6'],
        ['interview_start_hour',   '09:00'],
        ['interview_end_hour',     '17:00'],
        ['interview_buffer',       '0'],
        ['interview_lead_min',     '120'],
        ['interview_horizon_days', '14'],
        ['google_refresh_token',   ''],
        ['google_account_email',   ''],
        ['google_connected_at',    ''],
        ['google_token_status',    ''],
        ['google_oauth_state',     ''],

        // ── إشعار المتقدم ──────────────────────────────────────────────────
        //  واتساب يبدأ مطفأً عمداً: لا يعمل قبل اعتماد القالب في Twilio/Meta،
        //  وتفعيله قبل ذلك يعني فشلاً في كل جدولة.
        ['notify_whatsapp_enabled',  'false'],
        ['notify_email_enabled',     'true'],
        ['notify_applicant_attendee', 'true'],   // إضافة المتقدم لحضور حدث التقويم
        ['wa_params_shape',          'numbered'],
        ['default_job_title',        'حارس أمن'],
        ['wa_tpl_scheduled_name',    'artal_interview_invitation_ar_v2'],
        ['wa_tpl_scheduled_lang',    'ar'],
        ['wa_tpl_scheduled_cat',     'UTILITY'],
        ['wa_tpl_scheduled_vars',    'name,job,date,time,link'],
        ['wa_tpl_rescheduled_name',  ''],
        ['wa_tpl_rescheduled_lang',  'ar'],
        ['wa_tpl_rescheduled_cat',   'UTILITY'],
        ['wa_tpl_rescheduled_vars',  'name,date,time'],
        ['wa_tpl_cancelled_name',    ''],
        ['wa_tpl_cancelled_lang',    'ar'],
        ['wa_tpl_cancelled_cat',     'UTILITY'],
        ['wa_tpl_cancelled_vars',    'name,date,time'],

        // قالب طلب استكمال بيانات المرشح — مستقل عن المقابلات
        ['default_project_name',     ''],
        ['wa_tpl_inforeq_name',      'artal_candidate_info_request_ar'],
        ['wa_tpl_inforeq_lang',      'ar'],
        ['wa_tpl_inforeq_cat',       'UTILITY'],
        ['wa_tpl_inforeq_vars',      'name,job,project,region'],
      ];
      for (const [k, v] of ivDefaults) {
        await conn.query('INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)', [k, v]);
      }

      pool.INTERVIEWS_SCHEMA_OK = true;
      console.log('[DB] Interviews schema ready ✓');
    } catch (e) {
      console.error('[DB] Interviews schema failed — ميزة المقابلات معطّلة، وبقية النظام يعمل:', e.message);
    }
  } finally {
    conn.release();
  }
}

// تشغيل الـ initialization فور تحميل الوحدة
initialize().catch(err => {
  console.error('[DB] Initialization failed:', err.message);
  process.exit(1);
});

module.exports = pool;
