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
  connectionLimit: 10,
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

    // ─── ترحيل: إضافة user_name إلى applicant_notes و applicant_activity
    const [anCols] = await conn.query("SHOW COLUMNS FROM applicant_notes LIKE 'user_name'");
    if (anCols.length === 0) {
      await conn.query("ALTER TABLE applicant_notes ADD COLUMN user_name VARCHAR(100) DEFAULT NULL AFTER type");
      console.log('[DB] Migration: added column user_name to applicant_notes');
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
      console.log('[DB] Default admin created — email: admin@artal.com / password: admin123');
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
      console.log('[DB] Migration: manager@artal.com (manager) created — password: Artal@2025');
      console.log('[DB] Migration: admin@artal.com demoted to employee');
    }

    // ─── استيراد المستخدمين من النظام القديم (INSERT IGNORE — آمن للتكرار)
    const LEGACY_USERS = [
      { name: 'manger',               email: 'manger@gmail.com',             hash: '$2y$12$x0v/iiDFDMm8VAO4qD6vw.tNNm9DaE40uS0uxKHO22u1gvLFrn5se' },
      { name: 'hr',                   email: 'hr@demo.com',                  hash: '$2y$12$Uuppebnomy6CgljJmXgWQO7xBNKEZQ5VoKTDe9zrEQoMgvHDP7GJe' },
      { name: 'manager',              email: 'manager@demo.com',             hash: '$2y$12$zThUSPbfEwN08VDcKX.gwenPsJdmdb464jUqYiXYP3ScPHUIVMZsq' },
      { name: 'developer',            email: 'dev@artalgroup.net',           hash: '$2y$12$cyiMebnqV8VBn2/HxhP4.uM/wlZuwPtwFkd.GQFClAM4EBfmpfYJG' },
      { name: 'عامر بن حمد الطلحي',  email: 'hr@artalgroup.net',            hash: '$2y$12$zVNSFG2IMdVcYWuLiK7Qw.FslFOUx.xyDoxjaIsYmxuUZ165IqeLS' },
      { name: 'mohammed Nour',        email: 'legal2@artalgroup.net',        hash: '$2y$12$CzdAliRtFOd7TgPyjGDKEucDpXuCjMCGAMduqftsCPsQQpJ/MepOi' },
      { name: 'Hossam',               email: 'hradmin@artalgroup.net',       hash: '$2y$12$x95Bi3NqNJ4M2HWAlBOLK.bwX/wX7lAiikN8QI6szeuSXmMyn1aH6' },
      { name: 'Abdulrahman AlSarhan', email: 'admin2@artalgroup.net',        hash: '$2y$12$/j1HN/XOGBKk0GEr9y4N/eKWqGHQsY3mEJY7CNTgFInMRYGzwuI2O' },
      { name: 'magdy',                email: 'legal@artalgroup.net',         hash: '$2y$12$zqYMgxIshyRZ/3Oqwe0iOuHosAbU1ja.SJk/I4m6TN0bor93WtcJm' },
      { name: 'احمد طه',              email: 'hradmin2@artalgroup.net',      hash: '$2y$12$AWKRITBoN5lH9oKkIzoo0uCOuHvfjqh4mkXZIuBfd2qtyDZHGUlVy' },
      { name: 'sultan',               email: 'sultan@artalgroup.net',        hash: '$2y$12$RIdty6ZYhtvKXTDR5ZLRXejv11WuaK9EkyKnKiGxGbCbIvQGzz2Nu' },
      { name: 'Mahmoud',              email: 'mahmoud@artalgroup.net',       hash: '$2y$12$jT/iEPDZ2H57jbghY59bzO4WYYS9ZcMVNfyEw9fU8x3RiSFUpTpHu' },
      { name: 'security',             email: 'security@artalgroup.net',      hash: '$2y$12$Em3nTeIOPLVT1JqUeIZ.yumVSbl6xW1i//QAoXhgrIUe9HDHhkxK' },
      { name: 'مصطفى مجدي',           email: 'account3@artalgroup.net',      hash: '$2y$12$L0o.k7Cob3ArHWlZG7XKsOX0K/pK.RFyTWPorqQKdkuCWEAnPTJcq' },
      { name: 'هشام جودة',            email: 'coordinator@artalgroup.net',   hash: '$2y$12$i1GkUKSZ90jJ.W7.HIW8H.ihESSc35dl4CTRS3TxxvhoGAVS3yRwW' },
      { name: 'Mahmoud Mosbah',       email: 'hr2@artalgroup.net',           hash: '$2y$12$/mRuPvO882SYdCkVFZQ4Fup0KqGBO2OLmDDHnl7V/rxHNCbp6.KvW' },
      { name: 'ايمن',                 email: 'hrd@artalgroup.net',           hash: '$2y$12$yJpq4GpEFVP8SgelmsPVMe03WYsWG0T7hiQqZeVYXqbVMp6oFYmw2' },
      { name: 'احمد الدسوقي',         email: 'ai3350091@gmail.com',          hash: '$2y$12$.VNqGqZCMht8xZcpjCiCae.92BBUojFV5SkHdtzW9q5p.GcVF7iqe' },
      { name: 'احمد سامي',            email: 'ahmedsamy432002@gmail.com',    hash: '$2y$12$hXEdJcj187J299e1Q8iHUeG5s/sY1hoCxbU8jYRYuVFQ9IvjnHtPC' },
      { name: 'سامي',                 email: 'equips@artalgroup.net',        hash: '$2y$12$zGBVvg.R4cpYW1SoI070vOfIqarYfgGlugX3pA5rqETT12eOeqCUy' },
      { name: 'احمد عاشور',           email: 'ahmedgassan578@gmail.com',     hash: '$2y$12$yovdcQ.1S6KcgujxT4mU6uJc1ZK6SDiW6MCjIDqWltlIpYY5sXmay' },
      { name: 'محمد عيد',             email: 'madogwely123456789@gmail.com', hash: '$2y$12$gD2g18oEcf.a6vc6yoyeK.aLlQ0XQIl2MSx2AEx.a.tFBi7aAxKKW' },
      { name: 'najem',                email: 'najem@artalgroup.net',         hash: '$2y$12$7n5GuVqoalIsoVPsDtW5v.b9sxlScIaNJhXx1Sa1yQ4ouDgd9O8Aq' },
      { name: 'محمد عوض',             email: 'mohamedawadacc96@gmail.com',   hash: '$2y$12$ctgbxfk0O0AREs/P2EzWSO1Vs63Gd/1s.9VkRbqWyyU5mKVQGILB6' },
    ];
    let legacyImported = 0;
    for (const u of LEGACY_USERS) {
      const [r] = await conn.query(
        'INSERT IGNORE INTO admin_users (username, full_name, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?)',
        [u.email.toLowerCase(), u.name.trim(), u.hash, 'employee', 1]
      );
      if (r.affectedRows > 0) legacyImported++;
    }
    if (legacyImported > 0)
      console.log(`[DB] Legacy import: ${legacyImported} user(s) imported from old system`);

    console.log('[DB] MySQL connected & schema ready ✓');
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
