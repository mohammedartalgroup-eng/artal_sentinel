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

// تسجيل نشاط
pool.logActivity = async function (applicantId, action, oldVal = null, newVal = null) {
  await this.run(
    'INSERT INTO applicant_activity (applicant_id, action, old_value, new_value) VALUES (?, ?, ?, ?)',
    [applicantId, action, oldVal, newVal]
  );
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

    await conn.query(`
      CREATE TABLE IF NOT EXISTS cities (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(60)  NOT NULL UNIQUE,
        sort_order INT          NOT NULL DEFAULT 0,
        created_at DATETIME     DEFAULT CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // ─── مدن افتراضية
    const defaultCities = [
      'الرياض','جدة','الدمام','مكة المكرمة','المدينة المنورة',
      'الطائف','القصيم','أبها','تبوك','حائل','أخرى'
    ];
    for (const [i, city] of defaultCities.entries()) {
      await conn.query(
        'INSERT IGNORE INTO cities (name, sort_order) VALUES (?, ?)',
        [city, i]
      );
    }

    // ─── الإعدادات الافتراضية
    const defaults = [
      ['phone',                  '+966 500 000 000'],
      ['email',                  'recruitment@artal.com'],
      ['address',                'الرياض، المملكة العربية السعودية'],
      ['company_name',           'Artal Security Guards'],
      ['accepting_applications', 'true'],
    ];
    for (const [k, v] of defaults) {
      await conn.query(
        'INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)',
        [k, v]
      );
    }

    // ─── مستخدم أدمن افتراضي
    const [admins] = await conn.query('SELECT id FROM admin_users LIMIT 1');
    if (admins.length === 0) {
      const hash = await bcrypt.hash('admin123', 12);
      await conn.query(
        'INSERT INTO admin_users (username, password_hash) VALUES (?, ?)',
        ['admin', hash]
      );
      console.log('[DB] Default admin created — username: admin / password: admin123');
    }

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
