const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');
const fs = require('fs');

// تحميل متغيرات البيئة من .env إن وُجد
try { require('dotenv').config(); } catch(e) { /* dotenv اختياري */ }

// Initialize DB — runs schema creation on first boot
require('./database/db');

const applyRouter = require('./routes/apply');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure upload directories exist
['uploads/cv', 'uploads/id_images'].forEach(dir => {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Session — stored in MySQL
const sessionStore = new MySQLStore({
  host:               process.env.DB_HOST || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  database:           process.env.DB_NAME,
  clearExpired:       true,
  checkExpirationInterval: 900000,   // 15 min
  expiration:         86400000,      // 24 h
  createDatabaseTable: true,
  charset:            'utf8mb4_unicode_ci',
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'artal-sentinel-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true },
}));

// Routes — before static so /apply accepting_applications check fires first
app.use('/apply', applyRouter);
app.use('/admin', adminRouter);

// Static fallback (for any other assets in public/)
app.use(express.static(path.join(__dirname, 'public')));

// Success page — dynamic contact info from DB
app.get('/success', async (req, res) => {
  try {
    const db = require('./database/db');
    const settings = await db.getSettings();
    res.render('success', { settings });
  } catch (err) {
    console.error('[Success]', err.message);
    res.render('success', { settings: {} });
  }
});

// Root — serve apply page directly (no redirect, URL stays clean)
app.get('/', async (req, res) => {
  try {
    const db = require('./database/db');
    const setting = await db.get("SELECT value FROM settings WHERE `key` = 'accepting_applications'");
    if (setting && setting.value === 'false') {
      return res.status(503).send(`
        <!DOCTYPE html>
        <html dir="rtl" lang="ar">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>أرطال للحراسة الأمنية</title>
          <link rel="icon" type="image/png" href="/images/icon.png">
          <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="min-h-screen flex items-center justify-center" style="background:#001736">
          <div class="text-center text-white p-8 max-w-md">
            <div class="text-6xl mb-6">🔒</div>
            <h1 class="text-2xl font-bold mb-4">التوظيف متوقف مؤقتاً</h1>
            <p class="text-slate-300">شكراً لاهتمامك بالانضمام إلى فريقنا.<br>نحن لا نستقبل طلبات حالياً — يرجى المراجعة لاحقاً.</p>
          </div>
        </body>
        </html>
      `);
    }
  } catch (err) {
    console.error('[Root GET]', err.message);
  }
  res.sendFile(path.join(__dirname, 'public', 'apply', 'index.html'));
});

// 404
app.use((req, res) => {
  res.status(404).send(`
    <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:4rem;background:#f8f9fb">
      <h2 style="color:#001736">404 — الصفحة غير موجودة</h2>
      <a href="/" style="color:#405f91">العودة للرئيسية</a>
    </body></html>
  `);
});

// Global error handler — يلتقط أي خطأ يصل عبر next(err) ويمنع انهيار العملية
app.use((err, req, res, next) => {
  console.error('[Express Error]', err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(500).send(`
    <html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:4rem;background:#fff5f5">
      <h2 style="color:#ba1a1a">حدث خطأ غير متوقع</h2>
      <p>يرجى المحاولة مرة أخرى.</p>
      <a href="/">العودة</a>
    </body></html>
  `);
});

// حماية العملية من الانهيار الكامل — يسجّل الخطأ بدلاً من الإيقاف
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason?.stack || reason);
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       Artal Sentinel — Running       ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  App:    http://localhost:${PORT}/         ║`);
  console.log(`  ║  Admin:  http://localhost:${PORT}/admin   ║`);
  console.log('  ║  Login:  admin / admin123            ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
