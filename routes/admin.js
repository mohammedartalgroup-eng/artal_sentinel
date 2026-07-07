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

// ─── Rate Limiter — تسجيل الدخول فقط ─────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 دقيقة
  max: 20,                     // 20 محاولة كحد أقصى
  skipSuccessfulRequests: true, // لا تحسب المحاولات الناجحة
  message: { error: 'تم تجاوز عدد المحاولات المسموح بها، حاول مرة أخرى بعد 15 دقيقة' },
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

router.get('/applicants', async (req, res) => {
  try {
    const {
      q = '', status = '', region = '', gender = '', english = '', qualification = '',
      has_car = '', has_license = '', ext_check = '',
      age_min = '', age_max = '', date_from = '', date_to = '',
      sort = 'created_at', order = 'desc', page = '1'
    } = req.query;

    const cities = parseCityList(req.query.city);

    const PAGE_SIZE = 20;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const offset = (pageNum - 1) * PAGE_SIZE;

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
    if (age_min) { conditions.push('age >= ?'); params.push(parseInt(age_min)); }
    if (age_max) { conditions.push('age <= ?'); params.push(parseInt(age_max)); }
    if (date_from) { conditions.push('created_at >= ?'); params.push(date_from + ' 00:00:00'); }
    if (date_to)   { conditions.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(date_to); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
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
      applicants, total, totalPages, pageNum,
      filters: { q, status, region, city: cities, gender, english, qualification, has_car, has_license, ext_check, age_min, age_max, date_from, date_to, sort, order },
      STATUS_META, REGIONS, SA_REGIONS, adminUser: req.session.adminUser
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

    const [notes, activity, priorApps] = await Promise.all([
      db.all('SELECT * FROM applicant_notes WHERE applicant_id = ? ORDER BY created_at DESC', [applicant.id]),
      db.all('SELECT * FROM applicant_activity WHERE applicant_id = ? ORDER BY created_at DESC', [applicant.id]),
      // تقديمات سابقة/أخرى بنفس رقم الهوية (نظرة كاملة للمرشّح) — لا تشمل هذا الطلب
      applicant.id_number
        ? db.all('SELECT id, status, rating, source, created_at FROM applicants WHERE id_number = ? AND id != ? ORDER BY created_at DESC', [applicant.id_number, applicant.id])
        : Promise.resolve([]),
    ]);

    res.render('applicant-detail', {
      applicant, notes, activity, priorApps,
      STATUS_META, NOTE_TYPES, adminUser: req.session.adminUser
    });
  } catch (err) {
    console.error('[Applicant Detail]', err.message);
    res.status(500).send('خطأ في تحميل بيانات المتقدم');
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
    await db.run('DELETE FROM applicants WHERE id = ?', [req.params.id]);
    await db.audit(req.session.adminId, req.session.adminUser, 'applicant_delete', 'applicant',
      req.params.id, applicant.full_name, null, req.ip);
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
    res.render('settings', { settings, success: req.query.saved, adminUser: req.session.adminUser });
  } catch (err) {
    console.error('[Settings GET]', err.message);
    res.status(500).send('خطأ في تحميل الإعدادات');
  }
});

router.post('/settings', requireManager, async (req, res) => {
  try {
    const allowed = ['phone', 'whatsapp', 'email', 'address', 'maps_url', 'company_name', 'accepting_applications'];
    const updates = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(db.run(
          'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE `key` = ?',
          [req.body[key], key]
        ));
      }
    }
    // checkbox — unchecked sends nothing, so default to false
    if (req.body.accepting_applications === undefined) {
      updates.push(db.run(
        'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE `key` = ?',
        ['false', 'accepting_applications']
      ));
    }

    await Promise.all(updates);
    await db.audit(req.session.adminId, req.session.adminUser, 'settings_update', 'settings', null, null, null, req.ip);
    res.redirect('/admin/settings?saved=1');
  } catch (err) {
    console.error('[Settings POST]', err.message);
    res.status(500).send('خطأ في حفظ الإعدادات');
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
