const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// ─── مسار قاعدة البيانات ────────────────────────────────────────────────────
// على السيرفر: اضبط متغير البيئة DB_PATH لمسار خارج مجلد المشروع
//   مثال: DB_PATH=/var/artal-sentinel/artal.db
// محلياً: يستخدم مجلد data/ داخل المشروع تلقائياً
const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data');

const DB_PATH = process.env.DB_PATH
  ? process.env.DB_PATH
  : path.join(DATA_DIR, 'artal.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ─── Schema ────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS applicants (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name        TEXT    NOT NULL,
    id_number        TEXT    NOT NULL UNIQUE,
    phone            TEXT    NOT NULL,
    age              INTEGER,
    city             TEXT,
    has_car          INTEGER DEFAULT 0,
    has_license      INTEGER DEFAULT 0,
    cv_path          TEXT,
    id_image_path    TEXT,
    status           TEXT    NOT NULL DEFAULT 'pending',
    rating           INTEGER NOT NULL DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS applicant_notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant_id INTEGER NOT NULL,
    content      TEXT    NOT NULL,
    type         TEXT    NOT NULL DEFAULT 'note',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (applicant_id) REFERENCES applicants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS applicant_activity (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant_id INTEGER NOT NULL,
    action       TEXT    NOT NULL,
    old_value    TEXT,
    new_value    TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (applicant_id) REFERENCES applicants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_applicants_status     ON applicants(status);
  CREATE INDEX IF NOT EXISTS idx_applicants_city       ON applicants(city);
  CREATE INDEX IF NOT EXISTS idx_applicants_created_at ON applicants(created_at);
  CREATE INDEX IF NOT EXISTS idx_notes_applicant       ON applicant_notes(applicant_id);
  CREATE INDEX IF NOT EXISTS idx_activity_applicant    ON applicant_activity(applicant_id);
`);

// ─── Default Settings ───────────────────────────────────────────────────────

const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);

[
  ['phone',                   '+966 500 000 000'],
  ['email',                   'recruitment@artal.com'],
  ['address',                 'الرياض، المملكة العربية السعودية'],
  ['company_name',            'Artal Security Guards'],
  ['accepting_applications',  'true'],
].forEach(([k, v]) => insertSetting.run(k, v));

// ─── Default Admin ──────────────────────────────────────────────────────────

const adminExists = db.prepare('SELECT id FROM admin_users LIMIT 1').get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 12);
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)')
    .run('admin', hash);
  console.log('[DB] Default admin created — username: admin / password: admin123');
}

// ─── Helper: log activity ───────────────────────────────────────────────────

db.logActivity = function (applicantId, action, oldVal = null, newVal = null) {
  this.prepare(`
    INSERT INTO applicant_activity (applicant_id, action, old_value, new_value)
    VALUES (?, ?, ?, ?)
  `).run(applicantId, action, oldVal, newVal);
};

// ─── Helper: get settings map ──────────────────────────────────────────────

db.getSettings = function () {
  const rows = this.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
};

module.exports = db;
