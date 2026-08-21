const express   = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const path       = require('path');
const db         = require('../database/db');
const rateLimit  = require('express-rate-limit');
const requireAuth    = require('../middleware/auth');
const requireManager = require('../middleware/requireManager');
const usersRouter    = require('./users');
const SA_REGIONS     = require('./regions').SA_REGIONS;
const { checkExternal } = require('../utils/extCheck');
const google         = require('../utils/google');   // لا يرمي عند التحميل — كل تحقق كسول
const mailer         = require('../utils/mailer');   // ولا هذان — صفر اعتماديات وتحقق كسول
const chatwoot       = require('../utils/chatwoot');
const crypto         = require('crypto');

// ─── Rate Limiter — تسجيل الدخول فقط ─────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 دقيقة minutes 
  max: 20,                     // 20 محاولة كحد أقصى  
  skipSuccessfulRequests: true, // لا تحسب المحاولات الناجحة  
  message: { error: 'تم تجاوز عدد المحاولات المسموح بها، حاول مرة أخرى بعد 15 دقيقة' },  // رسالة الخطأ عند تجاوز الحد
  standardHeaders: true,
  legacyHeaders:   false,
});

// ─── Status meta ──────────────────────────────────────────────────────────────
const STATUS_META = {
  pending:     { label: 'جديد',              color: 'blue' },
  reviewed:    { label: 'قيد المراجعة',      color: 'yellow' },
  shortlisted: { label: 'مرشح للمقابلة',    color: 'purple' },
  interviewed: { label: 'تمت المقابلة',      color: 'orange' },
  hired:       { label: 'تم التعيين',        color: 'green' },
  on_hold:     { label: 'احتياطي',           color: 'gray' },
  rejected:    { label: 'مرفوض',             color: 'red' },
};

const NOTE_TYPES = {
  note:       { label: 'ملاحظة',   icon: 'edit_note' },
  call:       { label: 'مكالمة',   icon: 'call' },
  interview:  { label: 'مقابلة',   icon: 'handshake' },
  follow_up:  { label: 'متابعة',   icon: 'notifications_active' },
};

// ─── المناطق الإدارية (ثابتة — التقسيم الإداري للمملكة العربية السعودية) ─────
const REGIONS = [
  'منطقة الرياض','منطقة مكة المكرمة','المنطقة الشرقية',
  'منطقة المدينة المنورة','منطقة القصيم','منطقة عسير',
  'منطقة تبوك','منطقة حائل','منطقة الحدود الشمالية',
  'منطقة جازان','منطقة نجران','منطقة الباحة','منطقة الجوف',
];

// ─── Login ────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin/dashboard');
  res.render('login', { error: null, next: req.query.next || '/admin/dashboard' });
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, next } = req.body;
    const user = await db.get('SELECT * FROM admin_users WHERE username = ?', [username]);
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.render('login', { error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة', next: next || '/admin/dashboard' });
    }
    if (!user.is_active) {
      return res.render('login', { error: 'هذا الحساب موقوف — تواصل مع المدير', next: next || '/admin/dashboard' });
    }
    req.session.adminId   = user.id;
    req.session.adminUser = user.username;          // البريد الإلكتروني
    req.session.adminName = user.full_name || user.username;
    req.session.adminRole = user.role || 'employee';

    await Promise.all([
      db.run('UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]),
      db.audit(user.id, user.username, 'login', 'system', null, null, null, req.ip),
    ]);

    res.redirect(next || '/admin/dashboard');
  } catch (err) {
    console.error('[Login POST]', err.message);
    res.render('login', { error: 'حدث خطأ — يرجى المحاولة مرة أخرى', next: req.body.next || '/admin/dashboard' });
  }
});

router.get('/logout', async (req, res) => {
  try {
    await db.audit(req.session.adminId, req.session.adminUser, 'logout', 'system', null, null, null, req.ip);
  } catch(_) {}
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ─── Google OAuth callback ───────────────────────────────────────────────────
//  ⚠️ يجب أن يبقى فوق requireAuth: الكوكي sameSite:'strict' لا تُرسَل في العودة
//     من accounts.google.com (تنقّل cross-site)، فلو كان خلف الحماية لارتد
//     المستخدم إلى صفحة الدخول وضاع الـ code. الحماية هنا قيمة state أحادية
//     الاستخدام محفوظة في قاعدة البيانات — وهي أقوى من فحص الجلسة الضمني.
const googleOauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15,
  standardHeaders: true, legacyHeaders: false,
});

router.get('/google/callback', googleOauthLimiter, async (req, res) => {
  try {
    if (req.query.error) return res.redirect('/admin/settings?google=denied');

    const s = await db.getSettings();
    const stored = String(s.google_oauth_state || '');
    // استهلاك أحادي: نُفرّغ القيمة قبل أي عملية أخرى
    await db.run("UPDATE settings SET value = '' WHERE `key` = 'google_oauth_state'");

    const [nonce, expiry] = stored.split('.');
    const given = String(req.query.state || '');
    const okLen = nonce && given.length === nonce.length;
    const okVal = okLen && crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(given));
    if (!okVal || !expiry || Date.now() > Number(expiry)) {
      return res.redirect('/admin/settings?google=state');
    }

    const tokens = await google.exchangeCode(String(req.query.code || ''));
    const email  = await google.fetchAccountEmail(tokens.access_token);
    await google.saveConnection({ refreshToken: tokens.refresh_token, email });

    await db.audit(null, email || 'google', 'google_connect', 'settings', null, null, email, req.ip);
    res.redirect('/admin/settings?google=connected');
  } catch (err) {
    console.error('[Google callback]', err.message);
    const code = /رمز تحديث/.test(err.message) ? 'norefresh' : 'error';
    res.redirect(`/admin/settings?google=${code}`);
  }
});

// ─── All routes below require auth ───────────────────────────────────────────
router.use(requireAuth);

// ─── خدمة ملفات المتقدمين — محمية بتسجيل الدخول ─────────────────────────────
const UPLOADS_ROOT = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');

router.get('/files/:folder/:filename', (req, res) => {
  const { folder, filename } = req.params;

  // تحقق من المجلدات المسموح بها فقط
  if (!['cv', 'id_images'].includes(folder)) return res.status(403).end();

  // منع path traversal — السماح فقط بأحرف آمنة في اسم الملف
  if (!filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) return res.status(400).end();

  const filePath = path.join(UPLOADS_ROOT, folder, filename);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// متغيرات مشتركة لجميع views
const RYD = 'Asia/Riyadh';
router.use((req, res, next) => {
  res.locals.adminUser = req.session.adminUser;
  res.locals.adminName = req.session.adminName || req.session.adminUser;
  res.locals.adminRole = req.session.adminRole || 'employee';

  // دوال تنسيق التاريخ بتوقيت الرياض — متاحة في جميع EJS views
  res.locals.fmtDate     = (d) => d ? new Date(d).toLocaleDateString('ar-SA', { timeZone: RYD }) : '—';
  res.locals.fmtDateLong = (d) => d ? new Date(d).toLocaleDateString('ar-SA', { timeZone: RYD, year:'numeric', month:'long', day:'numeric' }) : '—';
  res.locals.fmtTime     = (d) => d ? new Date(d).toLocaleTimeString('ar-SA', { timeZone: RYD, hour:'2-digit', minute:'2-digit' }) : '—';
  res.locals.fmtDateTime = (d) => d ? `${res.locals.fmtDate(d)} ${res.locals.fmtTime(d)}` : '—';
  next();
});

// إدارة المستخدمين — للمديرين فقط
router.use('/users', requireManager, usersRouter);

// ─── مسارات المقابلات — تُركَّب داخل try/catch ────────────────────────────────
//  عزل: حتى خطأ في تحميل ملف المقابلات لا يمنع بقية لوحة التحكم من العمل.
try {
  router.use(require('./interviews'));
} catch (e) {
  console.error('[Interviews] تعذّر تحميل مسارات المقابلات — بقية اللوحة تعمل:', e.message);
}

// ─── ربط/فصل حساب Google (للمدير فقط) ───────────────────────────────────────
router.get('/google/connect', requireManager, googleOauthLimiter, async (req, res) => {
  try {
    if (!google.isConfigured()) return res.redirect('/admin/settings?google=notconfigured');
    const nonce = crypto.randomBytes(16).toString('hex');
    await db.run('UPDATE settings SET value = ? WHERE `key` = ?',
      [`${nonce}.${Date.now() + 10 * 60 * 1000}`, 'google_oauth_state']);
    res.redirect(google.buildAuthUrl(nonce));
  } catch (err) {
    console.error('[Google connect]', err.message);
    res.redirect('/admin/settings?google=error');
  }
});

router.post('/google/disconnect', requireManager, async (req, res) => {
  try {
    await google.disconnect();
    await db.audit(req.session.adminId, req.session.adminUser, 'google_disconnect', 'settings', null, null, null, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Google disconnect]', err.message);
    res.status(500).json({ error: 'تعذّر فصل الاتصال' });
  }
});

router.get('/google/status', requireManager, async (req, res) => {
  try {
    res.json(await google.getConnection());
  } catch (err) {
    res.status(500).json({ error: 'تعذّر قراءة حالة الاتصال' });
  }
});

// Root redirect
router.get('/', (req, res) => res.redirect('/admin/dashboard'));

// ─── Period meta helper ────────────────────────────────────────────────────────
function getPeriodMeta(period) {
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayStr = fmt(now);

  switch (period) {
    case 'today':
      return { sql: 'AND DATE(created_at) = ?', params: [todayStr], chartEnd: todayStr, chartDays: 1, label: 'اليوم' };

    case 'yesterday': {
      const yd = new Date(now); yd.setDate(yd.getDate() - 1);
      const s = fmt(yd);
      return { sql: 'AND DATE(created_at) = ?', params: [s], chartEnd: s, chartDays: 1, label: 'أمس' };
    }

    case '7d': {
      const s = new Date(now); s.setDate(s.getDate() - 6);
      return { sql: 'AND DATE(created_at) >= ?', params: [fmt(s)], chartEnd: todayStr, chartDays: 7, label: 'آخر 7 أيام' };
    }

    case '30d': {
      const s = new Date(now); s.setDate(s.getDate() - 29);
      return { sql: 'AND DATE(created_at) >= ?', params: [fmt(s)], chartEnd: todayStr, chartDays: 30, label: 'آخر 30 يوم' };
    }

    case 'this_month': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { sql: 'AND DATE(created_at) >= ?', params: [fmt(s)], chartEnd: todayStr, chartDays: now.getDate(), label: 'هذا الشهر' };
    }

    case 'last_month': {
      const fom  = new Date(now.getFullYear(), now.getMonth(), 1);
      const folm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lolm = new Date(now.getFullYear(), now.getMonth(), 0);
      return { sql: 'AND DATE(created_at) >= ? AND DATE(created_at) < ?', params: [fmt(folm), fmt(fom)], chartEnd: fmt(lolm), chartDays: lolm.getDate(), label: 'الشهر الماضي' };
    }

    case '3m': {
      const s = new Date(now); s.setMonth(s.getMonth() - 3);
      return { sql: 'AND DATE(created_at) >= ?', params: [fmt(s)], chartEnd: todayStr, chartDays: 14, label: 'آخر 3 أشهر' };
    }

    case 'this_year': {
      const s = new Date(now.getFullYear(), 0, 1);
      return { sql: 'AND DATE(created_at) >= ?', params: [fmt(s)], chartEnd: todayStr, chartDays: 14, label: 'هذا العام' };
    }

    default: // 'all'
      return { sql: '', params: [], chartEnd: todayStr, chartDays: 14, label: 'كل الوقت' };
  }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const VALID_PERIODS = ['today','yesterday','7d','30d','this_month','last_month','3m','this_year','all'];
    const period = VALID_PERIODS.includes(req.query.period) ? req.query.period : 'all';
    const pMeta  = getPeriodMeta(period);
    const p      = pMeta.params;

    const [statsRow, byCity, recent, trend, bySource] = await Promise.all([
      db.get(`
        SELECT
          COUNT(*)                           AS total,
          SUM(status = 'pending')            AS pending,
          SUM(status = 'reviewed')           AS reviewed,
          SUM(status = 'shortlisted')        AS shortlisted,
          SUM(status = 'interviewed')        AS interviewed,
          SUM(status = 'hired')              AS hired,
          SUM(status = 'on_hold')            AS on_hold,
          SUM(status = 'rejected')           AS rejected
        FROM applicants WHERE 1=1 ${pMeta.sql}
      `, p),
      db.all(`
        SELECT city, COUNT(*) as count FROM applicants
        WHERE city IS NOT NULL ${pMeta.sql} GROUP BY city ORDER BY count DESC LIMIT 8
      `, p),
      db.all(`
        SELECT id, full_name, city, status, created_at FROM applicants
        ORDER BY created_at DESC LIMIT 8
      `),
      db.all(`
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM applicants
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        GROUP BY DATE(created_at)
        ORDER BY day ASC
      `),
      db.all(`
        SELECT COALESCE(NULLIF(source, ''), 'غير معروف') AS source, COUNT(*) as count
        FROM applicants WHERE 1=1 ${pMeta.sql} GROUP BY source ORDER BY count DESC LIMIT 12
      `, p),
    ]);

    const stats = {
      total:       Number(statsRow?.total)       || 0,
      pending:     Number(statsRow?.pending)     || 0,
      reviewed:    Number(statsRow?.reviewed)    || 0,
      shortlisted: Number(statsRow?.shortlisted) || 0,
      interviewed: Number(statsRow?.interviewed) || 0,
      hired:       Number(statsRow?.hired)       || 0,
      on_hold:     Number(statsRow?.on_hold)     || 0,
      rejected:    Number(statsRow?.rejected)    || 0,
    };

    // ─── رسم بياني: المدن × الأيام ────────────────────────────────────────────
    let cityTrend = null;
    try {
        const rows = await db.all(`
          SELECT DATE(created_at) AS day,
                 COALESCE(NULLIF(city, ''), 'غير محدد') AS city,
                 COUNT(*) AS count
          FROM applicants
          WHERE 1=1 ${pMeta.sql}
          GROUP BY DATE(created_at), city
          ORDER BY day ASC
        `, p);

        // بناء قائمة الأيام بناءً على الفترة المختارة
        const days = [];
        const chartEndDate = new Date(pMeta.chartEnd + 'T00:00:00');
        for (let i = pMeta.chartDays - 1; i >= 0; i--) {
          const d = new Date(chartEndDate);
          d.setDate(chartEndDate.getDate() - i);
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          days.push(`${yyyy}-${mm}-${dd}`);
        }

        // تجميع إجمالي كل مدينة لاختيار الأعلى
        const cityTotals = {};
        rows.forEach(r => {
          cityTotals[r.city] = (cityTotals[r.city] || 0) + r.count;
        });
        const topCities = Object.entries(cityTotals)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([c]) => c);
        const topSet = new Set(topCities);

        // مصفوفة: كل مدينة → مصفوفة بعدد المتقدمين لكل يوم
        const matrix = {};
        topCities.forEach(c => { matrix[c] = new Array(days.length).fill(0); });
        matrix['أخرى'] = new Array(days.length).fill(0);

        rows.forEach(r => {
          // MySQL DATE() يعيد string أو Date — نوحّد
          const dayKey = r.day instanceof Date
            ? `${r.day.getFullYear()}-${String(r.day.getMonth()+1).padStart(2,'0')}-${String(r.day.getDate()).padStart(2,'0')}`
            : String(r.day).slice(0, 10);
          const idx = days.indexOf(dayKey);
          if (idx === -1) return;
          const bucket = topSet.has(r.city) ? r.city : 'أخرى';
          matrix[bucket][idx] += r.count;
        });

        // إزالة "أخرى" إذا كانت صفر كلياً
        const othersSum = matrix['أخرى'].reduce((a, b) => a + b, 0);
        if (othersSum === 0) delete matrix['أخرى'];

        // تسميات الأيام بالعربي (يوم + تاريخ مختصر)
        const dayLabels = days.map(d => {
          const dt = new Date(d + 'T00:00:00');
          return dt.toLocaleDateString('ar-SA', {
            timeZone: 'Asia/Riyadh', weekday: 'short', month: 'numeric', day: 'numeric'
          });
        });

        cityTrend = {
          days,
          dayLabels,
          cities: Object.keys(matrix),
          datasets: Object.entries(matrix).map(([city, data]) => ({ city, data })),
          totalInPeriod: rows.reduce((a, r) => a + r.count, 0),
        };
    } catch (e) {
      console.error('[cityTrend]', e.message);
      cityTrend = null;
    }

    res.render('dashboard', {
      stats, byCity, recent, trend, cityTrend, bySource,
      STATUS_META, adminUser: req.session.adminUser,
      activePeriod: period, periodLabel: pMeta.label,
    });
  } catch (err) {
    console.error('[Dashboard GET]', err.message);
    res.status(500).send('خطأ في تحميل لوحة التحكم');
  }
});

// ─── Applicants List ──────────────────────────────────────────────────────────

function parseCityList(raw) {
  if (Array.isArray(raw)) return raw.map(v => String(v).trim()).filter(Boolean);
  if (raw == null || raw === '') return [];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

// يبني شرط WHERE لقائمة المتقدمين من الفلاتر — مشترك بين عرض القائمة والتحديث الجماعي
// (بنفس المصدر يضمن أن "تحديد كل النتائج" يطابق تماماً ما يراه المستخدم في القائمة).
function buildApplicantFilter(src) {
  const {
    q = '', status = '', region = '', gender = '', english = '', qualification = '',
    has_car = '', has_license = '', ext_check = '', source = '',
    age_min = '', age_max = '', date_from = '', date_to = '',
  } = src;
  const cities = parseCityList(src.city);

  const conditions = [];
  const params = [];

  if (q) {
    conditions.push('(full_name LIKE ? OR id_number LIKE ? OR phone LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status)        { conditions.push('status = ?');        params.push(status); }
  if (region)        { conditions.push('region = ?');        params.push(region); }
  if (cities.length) {
    conditions.push(`city IN (${cities.map(() => '?').join(',')})`);
    params.push(...cities);
  }
  if (gender)        { conditions.push('gender = ?');        params.push(gender); }
  if (english !== '') { conditions.push('english = ?');      params.push(parseInt(english)); }
  if (qualification) { conditions.push('qualification = ?'); params.push(qualification); }
  if (has_car !== '')     { conditions.push('has_car = ?');     params.push(parseInt(has_car)); }
  if (has_license !== '') { conditions.push('has_license = ?'); params.push(parseInt(has_license)); }
  if (ext_check === 'found')      { conditions.push('ext_check_done = 1 AND ext_found = 1'); }
  else if (ext_check === 'not_found')  { conditions.push('ext_check_done = 1 AND (ext_found = 0 OR ext_found IS NULL)'); }
  else if (ext_check === 'unchecked')  { conditions.push('ext_check_done = 0'); }
  // فلترة بالمصدر (مُفهرس idx_source → سريع). 'غير معروف' = بلا مصدر مسجّل
  if (source === 'غير معروف')  { conditions.push("(source IS NULL OR source = '')"); }
  else if (source)             { conditions.push('source = ?'); params.push(source); }
  if (age_min) { conditions.push('age >= ?'); params.push(parseInt(age_min)); }
  if (age_max) { conditions.push('age <= ?'); params.push(parseInt(age_max)); }
  if (date_from) { conditions.push('created_at >= ?'); params.push(date_from + ' 00:00:00'); }
  if (date_to)   { conditions.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(date_to); }

  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    params,
    status,   // قيمة فلتر الحالة — يُستخدم لبوابة "جديد فقط"
  };
}

router.get('/applicants', async (req, res) => {
  try {
    const {
      q = '', status = '', region = '', gender = '', english = '', qualification = '',
      has_car = '', has_license = '', ext_check = '', source = '',
      age_min = '', age_max = '', date_from = '', date_to = '',
      sort = 'created_at', order = 'desc', page = '1', per_page = '20'
    } = req.query;

    const cities = parseCityList(req.query.city);

    // عدد العرض في الصفحة — قيم مسموحة فقط (تفادي LIMIT عشوائي)
    const PER_PAGE_OPTIONS = [20, 30, 50, 70, 100];
    const PAGE_SIZE = PER_PAGE_OPTIONS.includes(parseInt(per_page)) ? parseInt(per_page) : 20;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const offset = (pageNum - 1) * PAGE_SIZE;

    const { where, params } = buildApplicantFilter(req.query);
    const safeSort  = ['created_at', 'full_name', 'status', 'age', 'region', 'rating'].includes(sort) ? sort : 'created_at';
    const safeOrder = order === 'asc' ? 'ASC' : 'DESC';

    const [countRow, applicants] = await Promise.all([
      db.get(`SELECT COUNT(*) as c FROM applicants ${where}`, params),
      db.all(`
        SELECT id, full_name, id_number, phone, age, gender, region, city, neighborhood, has_car, has_license,
               english, qualification, specialization, status, rating, created_at,
               ext_check_done, ext_found
        FROM applicants ${where}
        ORDER BY ${safeSort} ${safeOrder}
        LIMIT ${PAGE_SIZE} OFFSET ${offset}
      `, params),
    ]);

    const total = Number(countRow?.c) || 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);

    // كشف المكرّرين: مَن سجّل بنفس رقم الهوية أكثر من مرة (شارة في القائمة)
    const repeatMap = {};
    const idNums = [...new Set(applicants.map(a => a.id_number).filter(Boolean))];
    if (idNums.length) {
      const rows = await db.all(
        `SELECT id_number, COUNT(*) AS cnt FROM applicants WHERE id_number IN (${idNums.map(() => '?').join(',')}) GROUP BY id_number HAVING cnt > 1`,
        idNums
      );
      rows.forEach(r => { repeatMap[r.id_number] = Number(r.cnt); });
    }
    applicants.forEach(a => { a.repeatCount = repeatMap[a.id_number] || 1; });

    res.render('applicants', {
      applicants, total, totalPages, pageNum, pageSize: PAGE_SIZE, perPageOptions: PER_PAGE_OPTIONS,
      filters: { q, status, region, city: cities, gender, english, qualification, has_car, has_license, ext_check, source, age_min, age_max, date_from, date_to, sort, order, per_page: PAGE_SIZE },
      STATUS_META, NOTE_TYPES, REGIONS, SA_REGIONS, adminUser: req.session.adminUser
    });
  } catch (err) {
    console.error('[Applicants GET]', err.message);
    res.status(500).send('خطأ في تحميل قائمة المتقدمين');
  }
});

// ─── Export Excel ─────────────────────────────────────────────────────────────

router.get('/applicants/export', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');

    const {
      q = '', status = '', region = '', gender = '', english = '', qualification = '',
      has_car = '', has_license = '',
      age_min = '', age_max = '', date_from = '', date_to = ''
    } = req.query;

    const cities = parseCityList(req.query.city);

    const conditions = [];
    const params = [];
    if (q) { conditions.push('(full_name LIKE ? OR id_number LIKE ? OR phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status)        { conditions.push('status = ?');        params.push(status); }
    if (region)        { conditions.push('region = ?');        params.push(region); }
    if (cities.length) {
      conditions.push(`city IN (${cities.map(() => '?').join(',')})`);
      params.push(...cities);
    }
    if (gender)        { conditions.push('gender = ?');        params.push(gender); }
    if (english !== '') { conditions.push('english = ?');      params.push(parseInt(english)); }
    if (qualification) { conditions.push('qualification = ?'); params.push(qualification); }
    if (has_car !== '')     { conditions.push('has_car = ?');     params.push(parseInt(has_car)); }
    if (has_license !== '') { conditions.push('has_license = ?'); params.push(parseInt(has_license)); }
    if (age_min) { conditions.push('age >= ?'); params.push(parseInt(age_min)); }
    if (age_max) { conditions.push('age <= ?'); params.push(parseInt(age_max)); }
    if (date_from) { conditions.push('created_at >= ?'); params.push(date_from + ' 00:00:00'); }
    if (date_to)   { conditions.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(date_to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = await db.all(`
      SELECT full_name, id_number, phone, age, gender, region, city, neighborhood,
             has_car, has_license, english, qualification, specialization, status, rating, created_at
      FROM applicants ${where} ORDER BY created_at DESC
    `, params);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Artal Sentinel';
    const ws = wb.addWorksheet('المتقدمون', { views: [{ rightToLeft: true }] });

    ws.columns = [
      { header: 'الاسم الرباعي',     key: 'full_name',    width: 28 },
      { header: 'رقم الهوية',        key: 'id_number',    width: 16 },
      { header: 'رقم الجوال',        key: 'phone',        width: 16 },
      { header: 'العمر',             key: 'age',          width: 8  },
      { header: 'الجنس',             key: 'gender',       width: 10 },
      { header: 'المنطقة',           key: 'region',       width: 22 },
      { header: 'المدينة',           key: 'city',         width: 16 },
      { header: 'الحي',              key: 'neighborhood', width: 18 },
      { header: 'يمتلك سيارة',       key: 'has_car',      width: 14 },
      { header: 'رخصة قيادة',        key: 'has_license',  width: 14 },
      { header: 'إنجليزية',          key: 'english',      width: 12 },
      { header: 'المؤهل',            key: 'qualification',width: 14 },
      { header: 'التخصص',            key: 'specialization',width: 20 },
      { header: 'الحالة',            key: 'status',       width: 18 },
      { header: 'التقييم',           key: 'rating',       width: 10 },
      { header: 'تاريخ التقديم',     key: 'created_at',   width: 20 },
    ];

    // Header style
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF001736' } };
    ws.getRow(1).alignment = { horizontal: 'center' };

    rows.forEach((r, i) => {
      const statusLabel = STATUS_META[r.status]?.label || r.status;
      ws.addRow({
        ...r,
        gender: r.gender === 'male' ? 'ذكر' : r.gender === 'female' ? 'أنثى' : '—',
        has_car: r.has_car ? 'نعم' : 'لا',
        has_license: r.has_license ? 'نعم' : 'لا',
        english: r.english == null ? '—' : r.english ? 'نعم' : 'لا',
        qualification: { none:'بدون مؤهل', primary:'ابتدائي', middle:'متوسط', high_school:'ثانوي', university:'جامعي' }[r.qualification] || (r.qualification || '—'),
        status: statusLabel,
        rating: '★'.repeat(r.rating) || '—',
      });
      if (i % 2 === 1) {
        ws.getRow(i + 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F6' } };
      }
    });

    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="artal_applicants_${date}.xlsx"`);
    await db.audit(req.session.adminId, req.session.adminUser, 'export', 'applicant', null, null,
      `تصدير ${rows.length} متقدم`, req.ip);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[Export]', err.message);
    res.status(500).send('خطأ في تصدير البيانات');
  }
});

// ─── Applicant Detail ─────────────────────────────────────────────────────────

router.get('/applicants/:id', async (req, res) => {
  try {
    const applicant = await db.get('SELECT * FROM applicants WHERE id = ?', [req.params.id]);
    if (!applicant) return res.status(404).send('المتقدم غير موجود');

    // إذا لم يُفحص بعد — شغّل الفحص في الخلفية (لا ينتظره)
    if (!applicant.ext_check_done && applicant.id_number) {
      checkExternal(applicant.id, applicant.id_number).catch(() => {});
    }

    // ⚠️ عزل: استعلامات المقابلات تحمل .catch خاصاً بها — لو غاب جدول interviews
    //    أو تعطّل استعلامه تظهر الصفحة كاملة بلا بطاقة المقابلة، ولا تسقط بـ 500.
    const [notes, activity, priorApps, ivRows, ivUsers, settings] = await Promise.all([
      db.all('SELECT * FROM applicant_notes WHERE applicant_id = ? ORDER BY created_at DESC', [applicant.id]),
      db.all('SELECT * FROM applicant_activity WHERE applicant_id = ? ORDER BY created_at DESC', [applicant.id]),
      // تقديمات سابقة/أخرى بنفس رقم الهوية (نظرة كاملة للمرشّح) — لا تشمل هذا الطلب
      applicant.id_number
        ? db.all('SELECT id, status, rating, source, created_at FROM applicants WHERE id_number = ? AND id != ? ORDER BY created_at DESC', [applicant.id_number, applicant.id])
        : Promise.resolve([]),
      db.INTERVIEWS_SCHEMA_OK
        ? db.all('SELECT * FROM interviews WHERE applicant_id = ? ORDER BY start_at DESC', [applicant.id]).catch(() => [])
        : Promise.resolve([]),
      db.all("SELECT id, username, full_name FROM admin_users WHERE is_active = 1 ORDER BY COALESCE(full_name, username) ASC").catch(() => []),
      db.getSettings().catch(() => ({})),
    ]);

    // بناء بيانات بطاقة المقابلة — أي خطأ هنا يُلغي البطاقة فقط
    let interviewsEnabled = false, activeInterview = null, waUrl = '', googleConnected = false;
    let delivery = {}, notifyChannels = { whatsapp: false, email: false }, jobTitleGuess = '';

    // طلب استكمال البيانات مستقل عن المقابلات — يُحسب خارج كتلتها حتى يبقى
    // الزر متاحاً لو تعطّلت ميزة المقابلات
    jobTitleGuess = require('../utils/interviewMsg').deriveJobTitle(applicant, settings);
    const WT = require('../utils/waTemplates');
    const waTemplates = {
      list: WT.available(settings, chatwoot.isConfigured()),
      fields: WT.FIELDS,
      defaults: {
        name: applicant.full_name || '',
        job: jobTitleGuess,
        region: applicant.region || '',
        city: applicant.city || '',
      },
    };
    try {
      interviewsEnabled = db.INTERVIEWS_SCHEMA_OK && settings.interviews_enabled === 'true';
      googleConnected   = Boolean(settings.google_refresh_token);
      const S = require('../utils/slots');
      const { buildWhatsAppText, buildWaUrl } = require('../utils/interviewMsg');
      const nameByEmail = Object.fromEntries(ivUsers.map(u => [u.username, u.full_name || u.username]));
      const live = ivRows.find(r => r.status === 'scheduled') || ivRows.find(r => r.status === 'pending');
      if (live) {
        const startMs = new Date(live.start_at).getTime();
        activeInterview = {
          id: live.id, startMs, startLocal: live.start_local,
          dateLabel: S.arabicDate(startMs), timeLabel: S.localTime(startMs),
          durationMin: live.duration_min, jobTitle: live.job_title || jobTitleGuess,
          meetLink: live.meet_link, htmlLink: live.html_link,
          status: live.status, pendingLink: !live.meet_link,
          interviewers: String(live.interviewers || '').split(',').filter(Boolean)
            .map(e => ({ email: e, name: nameByEmail[e] || e })),
        };
        waUrl = buildWaUrl(applicant.phone,
          buildWhatsAppText(applicant, activeInterview, { companyName: settings.company_name }));

        // آخر حالة إرسال لكل قناة — لشارات «أُرسل / فشل» وأزرار إعادة الإرسال
        delivery = await require('../utils/notify').deliveryFor(live.id);
        notifyChannels = {
          whatsapp: settings.notify_whatsapp_enabled === 'true' && require('../utils/chatwoot').isConfigured(),
          email:    settings.notify_email_enabled    === 'true' && require('../utils/mailer').isConfigured(),
        };
      }
    } catch (e) {
      console.error('[Interview] card build:', e.message);
      activeInterview = null;
    }

    res.render('applicant-detail', {
      applicant, notes, activity, priorApps,
      STATUS_META, NOTE_TYPES, adminUser: req.session.adminUser,
      interviewsEnabled, googleConnected, activeInterview, waUrl, delivery, notifyChannels, jobTitleGuess,
      waTemplates,
      interviewerList: ivUsers.filter(u => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.username || '')),
    });
  } catch (err) {
    console.error('[Applicant Detail]', err.message);
    res.status(500).send('خطأ في تحميل بيانات المتقدم');
  }
});

// ─── إرسال قالب واتساب يدوي للمتقدم ──────────────────────────────────────────
//  مسار واحد لكل قوالب utils/waTemplates.js — فعل يدوي صريح لا يمر بمفتاح
//  الإشعار التلقائي. يُسجَّل في applicant_messages وفي التايملاين ليرى الموظف
//  أنه أُرسل سابقاً فلا يُكرّره على المتقدم.
const waTplLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 40,
  message: { error: 'طلبات كثيرة — انتظر قليلاً' },
  standardHeaders: true, legacyHeaders: false,
});

// نص القالب المعتمد كما هو في Chatwoot — تقرأه النافذة عند فتحها لتعرض
// معاينة مطابقة للواقع بدل نسخة مكتوبة عندنا تتقادم بعد أي تعديل في ميتا.
router.get('/wa-template/:key/body', async (req, res) => {
  try {
    const WT = require('../utils/waTemplates');
    const tpl = WT.get(String(req.params.key || ''));
    if (!tpl) return res.status(404).json({ error: 'قالب غير معروف' });
    if (!chatwoot.isConfigured()) return res.status(409).json({ error: 'تكامل Chatwoot غير مهيأ' });

    const settings = await db.getSettings();
    const cfgTpl = require('../utils/notify').templateFor(settings, tpl.key);
    if (!cfgTpl.name) return res.status(409).json({ error: 'لم يُحدَّد اسم القالب في الإعدادات' });

    const found = await chatwoot.findTemplate(cfgTpl.name, cfgTpl.language);
    if (!found) {
      return res.status(409).json({
        error: `القالب «${cfgTpl.name}» غير موجود في قوالب Chatwoot — اضغط «Sync Templates» على صندوق واتساب`,
      });
    }

    res.json({
      ok: true,
      name: cfgTpl.name,
      body: String(found.body || ''),
      varOrder: cfgTpl.vars.split(',').map(x => x.trim()).filter(Boolean),
      varCount: chatwoot.templateVarCount(found),
    });
  } catch (err) {
    console.error('[WaTemplate body]', err.message);
    res.status(502).json({ error: 'تعذّر قراءة القالب من Chatwoot' });
  }
});

router.post('/applicants/:id/wa-template', waTplLimiter, async (req, res) => {
  try {
    const WT = require('../utils/waTemplates');
    const tpl = WT.get(String(req.body.template || ''));
    if (!tpl) return res.status(400).json({ error: 'قالب غير معروف' });

    const applicant = await db.get(
      'SELECT id, full_name, phone, region, city, landing_page FROM applicants WHERE id = ?', [req.params.id]
    );
    if (!applicant) return res.status(404).json({ error: 'المتقدم غير موجود' });

    const settings = await db.getSettings();
    const notify = require('../utils/notify');

    // لا يُقبل من الواجهة إلا ما أعلنه القالب — حتى لا يحقن نموذجٌ حقلَ قالبٍ آخر
    const vars = {};
    const MAP = { job: 'jobTitle', region: 'region', city: 'city' };
    for (const f of tpl.fields) {
      const raw = String(req.body[f] || '').trim().slice(0, WT.FIELDS[f]?.max || 100);
      if (raw) vars[MAP[f]] = raw;
    }

    const r = await notify.sendApplicantTemplate({
      applicant, tplKey: tpl.key, kind: tpl.kind, vars, settings,
      actor: req.session.adminName || req.session.adminUser,
    });

    if (r.status !== 'sent') {
      return res.status(r.status === 'skipped' ? 409 : 502).json({ error: r.reason || 'تعذّر الإرسال' });
    }

    const detail = tpl.fields
      .map(f => { const v = r.vars[f === 'job' ? 'job' : f]; return v ? `${WT.FIELDS[f].label}: ${v}` : null; })
      .filter(Boolean).join(' / ');
    const line = `${tpl.noteLabel} عبر واتساب${detail ? ` — ${detail}` : ''}`;

    try {
      await db.run(
        'INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
        [applicant.id, line, 'follow_up', req.session.adminName || null]
      );
    } catch (e) { console.error('[WaTemplate] note:', e.message); }

    try {
      await db.logActivity(applicant.id, tpl.noteLabel, null, 'واتساب', req.session.adminName || null);
    } catch (e) { console.error('[WaTemplate] activity:', e.message); }

    await db.audit(req.session.adminId, req.session.adminUser, 'wa_template', 'applicant',
      applicant.id, applicant.full_name, line, req.ip);

    res.json({ ok: true, sentTo: r.target, summary: line });
  } catch (err) {
    console.error('[WaTemplate]', err.message);
    res.status(500).json({ error: 'خطأ غير متوقع' });
  }
});

// ─── External System Check (manual / AJAX) ───────────────────────────────────

router.post('/applicants/:id/ext-check', async (req, res) => {
  try {
    const applicant = await db.get('SELECT id, id_number FROM applicants WHERE id = ?', [req.params.id]);
    if (!applicant) return res.status(404).json({ error: 'غير موجود' });

    await checkExternal(applicant.id, applicant.id_number);

    const updated = await db.get(
      'SELECT ext_check_done, ext_found, ext_employee_id, ext_status, ext_job_status, ext_checked_at FROM applicants WHERE id = ?',
      [req.params.id]
    );
    res.json({ ok: true, ...updated });
  } catch (err) {
    console.error('[ExtCheck POST]', err.message);
    res.status(500).json({ error: 'خطأ في الفحص' });
  }
});

// ─── Update Status ────────────────────────────────────────────────────────────

router.post('/applicants/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_META[status]) return res.status(400).json({ error: 'حالة غير صالحة' });

    const applicant = await db.get('SELECT status FROM applicants WHERE id = ?', [req.params.id]);
    if (!applicant) return res.status(404).json({ error: 'غير موجود' });

    await db.run(
      'UPDATE applicants SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, req.params.id]
    );

    const fullApplicant = await db.get('SELECT full_name FROM applicants WHERE id = ?', [req.params.id]);
    await Promise.all([
      db.logActivity(req.params.id, 'تغيير الحالة', STATUS_META[applicant.status]?.label, STATUS_META[status]?.label, req.session.adminName || null),
      db.audit(req.session.adminId, req.session.adminUser, 'status_change', 'applicant', req.params.id,
        fullApplicant?.full_name, `${STATUS_META[applicant.status]?.label} ← ${STATUS_META[status]?.label}`, req.ip),
    ]);

    res.json({ ok: true, status, label: STATUS_META[status].label });
  } catch (err) {
    console.error('[Status POST]', err.message);
    res.status(500).json({ error: 'خطأ في تحديث الحالة' });
  }
});

// ─── Bulk Update Status ───────────────────────────────────────────────────────

// حدّ أقصى وقائي — لتفادي عملية جماعية هائلة تُرهق القاعدة
const BULK_MAX = 2000;

router.post('/applicants/bulk-status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_META[status]) return res.status(400).json({ error: 'حالة غير صالحة' });

    // ── بوابة الأمان: الميزة لا تعمل إلا والفلتر مطبَّق على "جديد" (pending) ──
    // نُعيد بناء نفس شرط القائمة من الفلاتر المُرسَلة، ونتحقق أن status='pending'.
    const filterSrc = (req.body.filters && typeof req.body.filters === 'object') ? req.body.filters : {};
    const { where, params, status: filterStatus } = buildApplicantFilter(filterSrc);
    if (filterStatus !== 'pending') {
      return res.status(400).json({ error: 'التحديث الجماعي متاح فقط عندما يكون الفلتر مطبَّقاً على «جديد».' });
    }

    // الملاحظة إجبارية — تُسجَّل لكل متقدم كأن المستخدم دخل ملفه وأضافها
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (!note) return res.status(400).json({ error: 'الملاحظة مطلوبة' });
    if (note.length > 2000) return res.status(400).json({ error: 'الملاحظة طويلة جداً (الحد 2000 حرف)' });
    const noteType = NOTE_TYPES[req.body.note_type] ? req.body.note_type : 'note';

    // وضعان: تحديد كل النتائج (all=true) أو صفوف محدّدة بالمعرّفات (ids)
    const selectAll = req.body.all === true || req.body.all === 'true';
    let rows;

    if (selectAll) {
      // كل المتقدمين المطابقين للفلتر — مقيّدون بـ pending عبر الفلتر نفسه
      const countRow = await db.get(`SELECT COUNT(*) AS c FROM applicants ${where}`, params);
      const total = Number(countRow?.c) || 0;
      if (!total) return res.status(404).json({ error: 'لا يوجد متقدمون مطابقون' });
      if (total > BULK_MAX) {
        return res.status(400).json({ error: `النتائج (${total}) تتجاوز الحد الأقصى ${BULK_MAX}. ضيّق الفلتر أكثر.` });
      }
      rows = await db.all(`SELECT id, full_name, status FROM applicants ${where}`, params);
    } else {
      const ids = [...new Set(
        (Array.isArray(req.body.ids) ? req.body.ids : [])
          .map(v => parseInt(v))
          .filter(n => Number.isInteger(n) && n > 0)
      )];
      if (!ids.length) return res.status(400).json({ error: 'لم يتم تحديد أي متقدم' });
      if (ids.length > BULK_MAX) return res.status(400).json({ error: `الحد الأقصى ${BULK_MAX} متقدم في المرة الواحدة` });
      // نقيّد صراحةً بـ pending: حتى لو أُرسلت معرّفات لغير الجدد، لا تُمَس
      const ph = ids.map(() => '?').join(',');
      rows = await db.all(
        `SELECT id, full_name, status FROM applicants WHERE id IN (${ph}) AND status = 'pending'`,
        ids
      );
    }
    if (!rows.length) return res.status(404).json({ error: 'لا يوجد متقدمون مطابقون (بحالة «جديد»)' });

    const now = req.session.adminName || null;
    // معالجة على دفعات لتفادي استنفاد اتصالات القاعدة عند الأعداد الكبيرة
    const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

    // 1) الملاحظة أولاً — لكل متقدم مطابق
    for (const part of chunk(rows, 200)) {
      await db.run(
        `INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}`,
        part.flatMap(r => [r.id, note, noteType, now])
      );
      await db.run(
        `INSERT INTO audit_log (user_id, username, action, target_type, target_id, target_name, details, ip)
         VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        part.flatMap(r => [req.session.adminId, req.session.adminUser, 'note_add', 'applicant', r.id,
          r.full_name, `${NOTE_TYPES[noteType].label}: ${note.substring(0, 80)}`, req.ip])
      );
    }

    // 2) الحالة — فقط لمَن حالته مختلفة عن الهدف
    const changed = rows.filter(r => r.status !== status);
    if (changed.length) {
      for (const part of chunk(changed, 500)) {
        await db.run(
          `UPDATE applicants SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${part.map(() => '?').join(',')})`,
          [status, ...part.map(r => r.id)]
        );
      }
      for (const part of chunk(changed, 200)) {
        await db.run(
          `INSERT INTO applicant_activity (applicant_id, action, old_value, new_value, user_name) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
          part.flatMap(r => [r.id, 'تغيير الحالة', STATUS_META[r.status]?.label, STATUS_META[status]?.label, now])
        );
        await db.run(
          `INSERT INTO audit_log (user_id, username, action, target_type, target_id, target_name, details, ip)
           VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          part.flatMap(r => [req.session.adminId, req.session.adminUser, 'status_change', 'applicant', r.id,
            r.full_name, `${STATUS_META[r.status]?.label} ← ${STATUS_META[status]?.label} (تغيير جماعي)`, req.ip])
        );
      }
    } else {
      // لم تتغيّر حالة أحد (مثلاً الهدف = جديد) — نحدّث updated_at فقط لأثر الملاحظة
      for (const part of chunk(rows, 500)) {
        await db.run(
          `UPDATE applicants SET updated_at = CURRENT_TIMESTAMP WHERE id IN (${part.map(() => '?').join(',')})`,
          part.map(r => r.id)
        );
      }
    }

    res.json({
      ok: true, updated: changed.length, noted: rows.length,
      skipped: rows.length - changed.length, status, label: STATUS_META[status].label
    });
  } catch (err) {
    console.error('[Bulk Status POST]', err.message);
    res.status(500).json({ error: 'خطأ في التحديث الجماعي' });
  }
});

// ─── Update Rating ────────────────────────────────────────────────────────────

router.post('/applicants/:id/rating', async (req, res) => {
  try {
    const rating = parseInt(req.body.rating);
    if (isNaN(rating) || rating < 0 || rating > 5)
      return res.status(400).json({ error: 'تقييم غير صالح' });

    const applicant = await db.get('SELECT rating FROM applicants WHERE id = ?', [req.params.id]);
    if (!applicant) return res.status(404).json({ error: 'غير موجود' });

    await db.run(
      'UPDATE applicants SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [rating, req.params.id]
    );

    const ratedApplicant = await db.get('SELECT full_name FROM applicants WHERE id = ?', [req.params.id]);
    await Promise.all([
      db.logActivity(req.params.id, 'تحديث التقييم', `${applicant.rating} نجوم`, `${rating} نجوم`, req.session.adminName || null),
      db.audit(req.session.adminId, req.session.adminUser, 'rating_change', 'applicant', req.params.id,
        ratedApplicant?.full_name, `${applicant.rating}★ ← ${rating}★`, req.ip),
    ]);
    res.json({ ok: true, rating });
  } catch (err) {
    console.error('[Rating POST]', err.message);
    res.status(500).json({ error: 'خطأ في تحديث التقييم' });
  }
});

// ─── Add Note ─────────────────────────────────────────────────────────────────

router.post('/applicants/:id/notes', async (req, res) => {
  try {
    const { content, type } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'المحتوى مطلوب' });
    const noteType = NOTE_TYPES[type] ? type : 'note';

    const result = await db.run(
      'INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
      [req.params.id, content.trim(), noteType, req.session.adminName || null]
    );

    const noteApplicant = await db.get('SELECT full_name FROM applicants WHERE id = ?', [req.params.id]);
    await Promise.all([
      db.run('UPDATE applicants SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]),
      db.audit(req.session.adminId, req.session.adminUser, 'note_add', 'applicant', req.params.id,
        noteApplicant?.full_name, `${NOTE_TYPES[noteType].label}: ${content.trim().substring(0, 80)}`, req.ip),
    ]);

    const note = await db.get('SELECT * FROM applicant_notes WHERE id = ?', [result.insertId]);
    res.json({ ok: true, note: { ...note, typeLabel: NOTE_TYPES[noteType].label, typeIcon: NOTE_TYPES[noteType].icon } });
  } catch (err) {
    console.error('[Notes POST]', err.message);
    res.status(500).json({ error: 'خطأ في إضافة الملاحظة' });
  }
});

// ─── Delete Note ──────────────────────────────────────────────────────────────

router.delete('/applicants/:id/notes/:nid', async (req, res) => {
  try {
    const delNote = await db.get('SELECT content FROM applicant_notes WHERE id = ?', [req.params.nid]);
    await db.run('DELETE FROM applicant_notes WHERE id = ? AND applicant_id = ?', [req.params.nid, req.params.id]);
    const delApplicant = await db.get('SELECT full_name FROM applicants WHERE id = ?', [req.params.id]);
    await db.audit(req.session.adminId, req.session.adminUser, 'note_delete', 'applicant', req.params.id,
      delApplicant?.full_name, delNote?.content?.substring(0, 80), req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Notes DELETE]', err.message);
    res.status(500).json({ error: 'خطأ في حذف الملاحظة' });
  }
});

// ─── Delete Activity Entry ────────────────────────────────────────────────────

router.delete('/applicants/:id/activity/:aid', async (req, res) => {
  try {
    const entry = await db.get(
      'SELECT action, new_value FROM applicant_activity WHERE id = ? AND applicant_id = ?',
      [req.params.aid, req.params.id]
    );
    if (!entry) return res.status(404).json({ error: 'الإدخال غير موجود' });

    await db.run('DELETE FROM applicant_activity WHERE id = ? AND applicant_id = ?', [req.params.aid, req.params.id]);

    const actApplicant = await db.get('SELECT full_name FROM applicants WHERE id = ?', [req.params.id]);
    await db.audit(req.session.adminId, req.session.adminUser, 'activity_delete', 'applicant', req.params.id,
      actApplicant?.full_name, `حذف سجل: ${entry.action}${entry.new_value ? ' — ' + entry.new_value.substring(0, 50) : ''}`, req.ip);

    res.json({ ok: true });
  } catch (err) {
    console.error('[Activity DELETE]', err.message);
    res.status(500).json({ error: 'خطأ في حذف الإدخال' });
  }
});

// ─── Edit Note ────────────────────────────────────────────────────────────────

router.patch('/applicants/:id/notes/:nid', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'المحتوى فارغ' });

    const note = await db.get(
      'SELECT * FROM applicant_notes WHERE id = ? AND applicant_id = ?',
      [req.params.nid, req.params.id]
    );
    if (!note) return res.status(404).json({ error: 'الملاحظة غير موجودة' });

    await db.run(
      'UPDATE applicant_notes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [content.trim(), req.params.nid]
    );

    const editApplicant = await db.get('SELECT full_name FROM applicants WHERE id = ?', [req.params.id]);
    await db.audit(req.session.adminId, req.session.adminUser, 'note_edit', 'applicant', req.params.id,
      editApplicant?.full_name, `${note.content.substring(0, 60)} ← ${content.trim().substring(0, 60)}`, req.ip);

    res.json({ ok: true, content: content.trim() });
  } catch (err) {
    console.error('[Notes PATCH]', err.message);
    res.status(500).json({ error: 'خطأ في تعديل الملاحظة' });
  }
});

// ─── Delete Applicant ─────────────────────────────────────────────────────────

router.delete('/applicants/:id', requireManager, async (req, res) => {
  try {
    const applicant = await db.get('SELECT full_name FROM applicants WHERE id = ?', [req.params.id]);
    if (!applicant) return res.status(404).json({ error: 'غير موجود' });

    // الـ FK يحذف صفوف المقابلات تلقائياً (CASCADE) لكنه يترك أحداث Google يتيمة —
    // نحاول حذفها أولاً بأفضل جهد. ⚠️ فشل Google لا يمنع حذف المتقدم أبداً.
    let removedEvents = 0;
    if (db.INTERVIEWS_SCHEMA_OK) {
      try {
        const live = await db.all(
          "SELECT id, google_event_id FROM interviews WHERE applicant_id = ? AND status = 'scheduled' AND google_event_id IS NOT NULL",
          [req.params.id]
        );
        for (const iv of live) {
          try { await google.deleteEvent(iv.google_event_id); removedEvents++; }
          catch (e) { console.error(`[Interview] تعذّر حذف حدث ${iv.google_event_id} عند حذف المتقدم:`, e.message); }
        }
      } catch (e) {
        console.error('[Interview] تنظيف أحداث Google قبل الحذف:', e.message);
      }
    }

    await db.run('DELETE FROM applicants WHERE id = ?', [req.params.id]);
    await db.audit(req.session.adminId, req.session.adminUser, 'applicant_delete', 'applicant',
      req.params.id, applicant.full_name, removedEvents ? `حُذفت ${removedEvents} مقابلة من تقويم Google` : null, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Applicant DELETE]', err.message);
    res.status(500).json({ error: 'خطأ في حذف المتقدم' });
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────

router.get('/settings', requireManager, async (req, res) => {
  try {
    const settings = await db.getSettings();
    // لا يُمرَّر السر إلى القالب إطلاقاً (حتى لا يسرّبه قالب مستقبلي بالخطأ)
    const hasToken = Boolean(settings.google_refresh_token);
    delete settings.google_refresh_token;
    delete settings.google_oauth_state;

    res.render('settings', {
      settings, success: req.query.saved, adminUser: req.session.adminUser,
      googleMsg: req.query.google || '',
      googleConn: {
        configured:  google.isConfigured(),
        connected:   hasToken,
        email:       settings.google_account_email || '',
        connectedAt: settings.google_connected_at || '',
        status:      settings.google_token_status || '',
      },
      interviewsReady: db.INTERVIEWS_SCHEMA_OK,
      settingsError: req.query.err || '',
      mailStatus: mailer.status(),
      chatwootStatus: chatwoot.status(),
      msgVars: require('../utils/interviewMsg').VAR_LABELS,
      waTemplateList: Object.values(require('../utils/waTemplates').TEMPLATES),
    });
  } catch (err) {
    console.error('[Settings GET]', err.message);
    res.status(500).send('خطأ في تحميل الإعدادات');
  }
});

// التحقق من قيم قواعد المقابلات — يُرجع رسالة خطأ أو null
function validateInterviewSettings(b) {
  if (b.interview_duration !== undefined && ![10, 15, 20, 30].includes(parseInt(b.interview_duration, 10))) {
    return 'مدة المقابلة يجب أن تكون 10 أو 15 أو 20 أو 30 دقيقة';
  }
  if (b.interview_work_days !== undefined) {
    const days = String(b.interview_work_days).split(',').filter(x => x !== '');
    if (!days.length) return 'اختر يوم عمل واحداً على الأقل';
    if (days.some(d => !/^[0-6]$/.test(d))) return 'أيام العمل غير صالحة';
  }
  const HH = /^\d{1,2}:\d{2}$/;
  if (b.interview_start_hour !== undefined && !HH.test(b.interview_start_hour)) return 'صيغة ساعة البداية غير صالحة';
  if (b.interview_end_hour   !== undefined && !HH.test(b.interview_end_hour))   return 'صيغة ساعة النهاية غير صالحة';
  if (b.interview_start_hour && b.interview_end_hour) {
    const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
    if (toMin(b.interview_end_hour) <= toMin(b.interview_start_hour)) return 'ساعة النهاية يجب أن تكون بعد ساعة البداية';
  }
  const range = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi; };
  if (b.interview_buffer       !== undefined && !range(b.interview_buffer, 0, 60))        return 'الفاصل بين المقابلات: 0 إلى 60 دقيقة';
  if (b.interview_lead_min     !== undefined && !range(b.interview_lead_min, 0, 10080))   return 'أقل مهلة للحجز: 0 إلى 10080 دقيقة';
  if (b.interview_horizon_days !== undefined && !range(b.interview_horizon_days, 1, 60))  return 'عدد الأيام المعروضة: 1 إلى 60 يوماً';
  return null;
}

// التحقق من إعداد قوالب واتساب — يُرجع رسالة خطأ أو null
const TPL_KEYS = () => [...require('../utils/notify').KINDS, ...require('../utils/waTemplates').keys()];

function validateNotifySettings(b) {
  const VARS = Object.keys(require('../utils/interviewMsg').VAR_LABELS);
  const CATS = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
  for (const kind of TPL_KEYS()) {
    const nameKey = `wa_tpl_${kind}_name`;
    if (b[nameKey] !== undefined && String(b[nameKey]).trim()) {
      // أسماء قوالب واتساب: حروف صغيرة وأرقام وشرطة سفلية فقط
      if (!/^[a-z0-9_]{1,512}$/.test(String(b[nameKey]).trim())) {
        return `اسم القالب «${b[nameKey]}» غير صالح — يُسمح بحروف إنجليزية صغيرة وأرقام وشرطة سفلية فقط`;
      }
    }
    const langKey = `wa_tpl_${kind}_lang`;
    if (b[langKey] !== undefined && String(b[langKey]).trim() && !/^[a-z]{2}(_[A-Z]{2})?$/.test(String(b[langKey]).trim())) {
      return `رمز اللغة «${b[langKey]}» غير صالح — مثال: ar أو en_US`;
    }
    const catKey = `wa_tpl_${kind}_cat`;
    if (b[catKey] !== undefined && String(b[catKey]).trim() && !CATS.includes(String(b[catKey]).trim())) {
      return 'تصنيف القالب يجب أن يكون UTILITY أو MARKETING أو AUTHENTICATION';
    }
    const varsKey = `wa_tpl_${kind}_vars`;
    if (b[varsKey] !== undefined) {
      const bad = String(b[varsKey]).split(',').map(s => s.trim()).filter(Boolean).filter(v => !VARS.includes(v));
      if (bad.length) return `متغيّرات غير معروفة: ${bad.join('، ')}`;
    }
  }
  if (b.wa_params_shape !== undefined && !['numbered', 'structured'].includes(b.wa_params_shape)) {
    return 'شكل المتغيّرات غير صالح';
  }
  return null;
}

router.post('/settings', requireManager, async (req, res) => {
  try {
    // القسم يحدد المفاتيح المسموح كتابتها — حتى لا يمس نموذجٌ مفاتيحَ نموذج آخر
    // (مثلاً: حفظ قواعد المقابلات كان سيُطفئ accepting_applications بالخطأ).
    const SECTIONS = ['interviews', 'notifications'];
    const section = SECTIONS.includes(req.body.form_section) ? req.body.form_section : 'contact';
    // تُجمع القيم ثم تُكتب دفعةً واحدة — لا استعلام متوازٍ لكل مفتاح
    const updates = {};
    const set = (key, value) => { updates[key] = value; };

    if (section === 'contact') {
      const allowed = ['phone', 'whatsapp', 'email', 'address', 'maps_url', 'company_name', 'accepting_applications'];
      for (const key of allowed) {
        if (req.body[key] !== undefined) set(key, req.body[key]);
      }
      // checkbox — unchecked sends nothing, so default to false
      if (req.body.accepting_applications === undefined) set('accepting_applications', 'false');
    } else if (section === 'notifications') {
      const invalid = validateNotifySettings(req.body);
      if (invalid) return res.redirect('/admin/settings?err=' + encodeURIComponent(invalid) + '#notify');

      const allowed = ['wa_params_shape', 'default_job_title'];
      for (const kind of TPL_KEYS()) {
        allowed.push(`wa_tpl_${kind}_name`, `wa_tpl_${kind}_lang`, `wa_tpl_${kind}_cat`, `wa_tpl_${kind}_vars`);
      }
      for (const key of allowed) {
        if (req.body[key] !== undefined) set(key, String(req.body[key]).trim());
      }
      for (const flag of ['notify_whatsapp_enabled', 'notify_email_enabled', 'notify_applicant_attendee']) {
        set(flag, req.body[flag] === undefined ? 'false' : 'true');
      }
    } else {
      const invalid = validateInterviewSettings(req.body);
      if (invalid) return res.redirect('/admin/settings?err=' + encodeURIComponent(invalid));

      const allowed = ['interview_duration', 'interview_work_days', 'interview_start_hour',
                       'interview_end_hour', 'interview_buffer', 'interview_lead_min', 'interview_horizon_days'];
      for (const key of allowed) {
        if (req.body[key] !== undefined) set(key, String(req.body[key]));
      }
      set('interviews_enabled', req.body.interviews_enabled === undefined ? 'false' : 'true');
    }

    await db.setSettings(updates);
    await db.audit(req.session.adminId, req.session.adminUser, 'settings_update', 'settings', null, null,
      `${section} (${Object.keys(updates).length} مفتاحاً)`, req.ip);
    const anchor = { interviews: '#interviews', notifications: '#notify' }[section] || '';
    res.redirect(`/admin/settings?saved=1${anchor}`);
  } catch (err) {
    console.error('[Settings POST]', err.message);
    // الصفحة للمدير وحده — إظهار سبب الفشل يوفّر جولة كاملة في سجل الخادم
    res.redirect('/admin/settings?err=' + encodeURIComponent(`تعذّر الحفظ — ${err.message}`.slice(0, 200)));
  }
});

// ─── اختبار قناة الإشعار ──────────────────────────────────────────────────────
//  يُرسل رسالة على بيانات مقابلة وهمية إلى وجهة يحددها المدير — الطريقة
//  الوحيدة للتأكد من كلمة مرور التطبيق ومن اعتماد قالب واتساب قبل استخدامهما
//  على متقدم حقيقي.
const notifyTestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 10,
  message: { error: 'محاولات كثيرة — انتظر قليلاً' },
  standardHeaders: true, legacyHeaders: false,
});

router.post('/settings/notify-test', requireManager, notifyTestLimiter, async (req, res) => {
  const M = require('../utils/interviewMsg');
  try {
    const channel = req.body.channel === 'whatsapp' ? 'whatsapp' : 'email';
    const target  = String(req.body.target || '').trim();
    if (!target) return res.status(400).json({ error: 'أدخل وجهة الاختبار' });

    const settings = await db.getSettings();
    const demoApplicant = {
      id: 0, full_name: req.session.adminName || 'اختبار',
      phone: channel === 'whatsapp' ? target : '',
      email: channel === 'email' ? target : '',
    };
    const demoInterview = {
      id: 0, startMs: Date.now() + 86400000, durationMin: parseInt(settings.interview_duration, 10) || 15,
      meetLink: 'https://meet.google.com/test-demo-link',
      interviewers: [{ name: req.session.adminName || 'المقابل' }],
    };
    const opts = { companyName: settings.company_name };

    if (channel === 'email') {
      if (!M.isEmail(target)) return res.status(400).json({ error: 'بريد إلكتروني غير صالح' });
      if (!mailer.isConfigured()) return res.status(409).json({ error: 'إعدادات SMTP غير مكتملة — راجع ملف .env' });
      await mailer.sendMail({
        to: target,
        subject: `[اختبار] ${M.buildEmailSubject(demoApplicant, demoInterview, opts)}`,
        html: M.buildEmailHtml(demoApplicant, demoInterview, { ...opts, kind: 'scheduled' }),
        text: M.buildEmailText(demoApplicant, demoInterview, { ...opts, kind: 'scheduled' }),
      });
    } else {
      if (!chatwoot.isConfigured()) return res.status(409).json({ error: 'تكامل Chatwoot غير مهيأ — راجع ملف .env' });
      const tpl = require('../utils/notify').templateFor(settings, 'scheduled');
      if (!tpl.name) return res.status(409).json({ error: 'لم يُحدَّد اسم قالب واتساب لإشعار الجدولة' });
      const vars = M.messageVars(demoApplicant, demoInterview, opts);
      await chatwoot.sendTemplate({
        name: demoApplicant.full_name, phone: target,
        content: M.buildWhatsAppText(demoApplicant, demoInterview, opts),
        template: {
          name: tpl.name, language: tpl.language, category: tpl.category,
          processed_params: M.buildProcessedParams(vars, tpl.vars, tpl.shape),
        },
      });
    }

    await db.audit(req.session.adminId, req.session.adminUser, 'notify_test', 'settings',
      null, null, `${channel} → ${target}`, req.ip);
    res.json({ ok: true, message: 'أُرسلت رسالة الاختبار — تحقق من الوجهة' });
  } catch (err) {
    console.error('[Notify test]', err.message);
    res.status(502).json({ error: err.message || 'فشل الإرسال' });
  }
});

router.post('/settings/password', requireManager, async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    const [settings, admin] = await Promise.all([
      db.getSettings(),
      db.get('SELECT * FROM admin_users WHERE id = ?', [req.session.adminId]),
    ]);

    if (!admin || !await bcrypt.compare(current_password, admin.password_hash)) {
      return res.render('settings', { settings, success: null, passwordError: 'كلمة المرور الحالية غير صحيحة', adminUser: req.session.adminUser });
    }
    if (new_password.length < 8) {
      return res.render('settings', { settings, success: null, passwordError: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل', adminUser: req.session.adminUser });
    }
    if (new_password !== confirm_password) {
      return res.render('settings', { settings, success: null, passwordError: 'كلمتا المرور غير متطابقتين', adminUser: req.session.adminUser });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await db.run('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hash, req.session.adminId]);
    await db.audit(req.session.adminId, req.session.adminUser, 'password_change', 'user',
      req.session.adminId, req.session.adminUser, 'تغيير كلمة المرور الشخصية', req.ip);
    res.redirect('/admin/settings?saved=2');
  } catch (err) {
    console.error('[Password POST]', err.message);
    res.status(500).send('خطأ في تغيير كلمة المرور');
  }
});

// ─── Audit Log ────────────────────────────────────────────────────────────────

router.get('/audit', async (req, res) => {
  try {
    const { user = '', action = '', date_from = '', date_to = '', applicant_id = '', page = '1' } = req.query;
    const PAGE_SIZE = 50;
    const pageNum   = Math.max(1, parseInt(page) || 1);
    const offset    = (pageNum - 1) * PAGE_SIZE;

    const conditions = [];
    const params     = [];
    if (user)          { conditions.push('a.username = ?');              params.push(user); }
    if (action)        { conditions.push('a.action = ?');                params.push(action); }
    if (date_from)     { conditions.push('a.created_at >= ?');                         params.push(date_from + ' 00:00:00'); }
    if (date_to)       { conditions.push('a.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(date_to); }
    if (applicant_id)  { conditions.push('a.target_id = ?');             params.push(applicant_id); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // جلب اسم المتقدم إذا كان الفلتر نشطاً
    let applicantName = '';
    if (applicant_id) {
      const ap = await db.get('SELECT full_name FROM applicants WHERE id = ?', [applicant_id]);
      applicantName = ap?.full_name || '';
    }

    const [countRow, logs, users] = await Promise.all([
      db.get(`SELECT COUNT(*) as c FROM audit_log a ${where}`, params),
      db.all(`SELECT a.* FROM audit_log a ${where} ORDER BY a.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`, params),
      db.all('SELECT DISTINCT username FROM audit_log ORDER BY username ASC'),
    ]);

    const total      = Number(countRow?.c) || 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);

    res.render('audit', {
      logs, users, total, totalPages, pageNum,
      filters: { user, action, date_from, date_to, applicant_id },
      applicantName,
    });
  } catch (err) {
    console.error('[Audit GET]', err.message);
    res.status(500).send('خطأ في تحميل سجل التدقيق');
  }
});

// ─── Employee Performance ─────────────────────────────────────────────────────

router.get('/performance', async (req, res) => {
  try {
    const { period = '30', date_from = '', date_to = '' } = req.query;

    let fromDate, toDate;
    const now = new Date();
    if (date_from && date_to) {
      fromDate = date_from;
      toDate   = date_to;
    } else {
      const days = parseInt(period) || 30;
      const from = new Date(now);
      from.setDate(now.getDate() - days + 1);
      fromDate = from.toISOString().split('T')[0];
      toDate   = now.toISOString().split('T')[0];
    }

    const periodDays = Math.max(1,
      Math.round((new Date(toDate) - new Date(fromDate)) / 86400000) + 1
    );

    const employees = await db.all(`
      SELECT
        u.id,
        u.username,
        u.full_name,
        u.role,
        u.is_active,
        u.last_login,
        COUNT(CASE WHEN a.action NOT IN ('login','logout') THEN 1 END)
          AS total_actions,
        COUNT(DISTINCT CASE WHEN a.action NOT IN ('login','logout') THEN DATE(a.created_at) END)
          AS active_days,
        COUNT(CASE WHEN a.action = 'status_change'  THEN 1 END)
          AS status_changes,
        COUNT(CASE WHEN a.action = 'note_add'       THEN 1 END)
          AS notes_total,
        COUNT(CASE WHEN a.action = 'note_add' AND a.details LIKE 'مكالمة:%' THEN 1 END)
          AS calls,
        COUNT(CASE WHEN a.action = 'note_add' AND a.details LIKE 'مقابلة:%' THEN 1 END)
          AS interviews,
        COUNT(CASE WHEN a.action = 'note_add' AND a.details LIKE 'متابعة:%' THEN 1 END)
          AS follow_ups,
        COUNT(CASE WHEN a.action = 'rating_change'  THEN 1 END)
          AS ratings_given,
        COUNT(DISTINCT CASE WHEN a.target_type = 'applicant' THEN a.target_id END)
          AS unique_applicants,
        MAX(CASE WHEN a.action NOT IN ('login','logout') THEN a.created_at END)
          AS last_action_at,
        ov.overall_last_action
      FROM admin_users u
      LEFT JOIN audit_log a
        ON a.user_id = u.id
        AND a.created_at >= ? AND a.created_at < DATE_ADD(?, INTERVAL 1 DAY)
      LEFT JOIN (
        SELECT user_id, MAX(created_at) AS overall_last_action
        FROM audit_log
        WHERE action NOT IN ('login','logout')
        GROUP BY user_id
      ) ov ON ov.user_id = u.id
      WHERE u.role IN ('employee', 'manager')
      GROUP BY u.id, u.username, u.full_name, u.role, u.is_active, u.last_login, ov.overall_last_action
      ORDER BY total_actions DESC
    `, [fromDate, toDate]);

    // تحويل وإثراء البيانات
    const nowTs = Date.now();
    const enriched = employees.map(e => {
      const ta           = Number(e.total_actions);
      const calls        = Number(e.calls);
      const interviews   = Number(e.interviews);
      const follow_ups   = Number(e.follow_ups);
      const notes_total  = Number(e.notes_total);
      const overallLast  = e.overall_last_action ? new Date(e.overall_last_action) : null;
      const daysSince    = overallLast
        ? Math.floor((nowTs - overallLast.getTime()) / 86400000)
        : null;

      return {
        ...e,
        total_actions:     ta,
        active_days:       Number(e.active_days),
        status_changes:    Number(e.status_changes),
        notes_total,
        calls,
        interviews,
        follow_ups,
        plain_notes:       Math.max(0, notes_total - calls - interviews - follow_ups),
        ratings_given:     Number(e.ratings_given),
        unique_applicants: Number(e.unique_applicants),
        days_since_overall: daysSince,
      };
    });

    const totalTeamActions    = enriched.reduce((s, e) => s + e.total_actions,     0);
    const totalTeamApplicants = enriched.reduce((s, e) => s + e.unique_applicants,  0);
    const maxActions          = enriched.length ? enriched[0].total_actions : 1; // sorted desc

    enriched.forEach(e => {
      e.action_share = totalTeamActions > 0
        ? Math.round(e.total_actions / totalTeamActions * 100)
        : 0;
      e.bar_pct = maxActions > 0
        ? Math.round(e.total_actions / maxActions * 100)
        : 0;
    });

    res.render('performance', {
      employees: enriched,
      periodDays,
      totalTeamActions,
      totalTeamApplicants,
      filters: { period, date_from, date_to },
      fromDate,
      toDate,
    });
  } catch (err) {
    console.error('[Performance GET]', err.message);
    res.status(500).send('خطأ في تحميل تقرير الأداء');
  }
});

module.exports = router;
