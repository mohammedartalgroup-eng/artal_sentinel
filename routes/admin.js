const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const requireAuth    = require('../middleware/auth');
const requireManager = require('../middleware/requireManager');
const usersRouter    = require('./users');
const SA_REGIONS     = require('./regions').SA_REGIONS;

// ─── Status meta ──────────────────────────────────────────────────────────────
const STATUS_META = {
  pending:     { label: 'جديد',              color: 'blue' },
  reviewed:    { label: 'قيد المراجعة',      color: 'yellow' },
  shortlisted: { label: 'مرشح للمقابلة',    color: 'purple' },
  interviewed: { label: 'تمت المقابلة',      color: 'orange' },
  hired:       { label: 'تم التعيين',        color: 'green' },
  on_hold:     { label: 'معلق',              color: 'gray' },
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

router.post('/login', async (req, res) => {
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

// متغيرات مشتركة لجميع views
router.use((req, res, next) => {
  res.locals.adminUser = req.session.adminUser;           // البريد الإلكتروني
  res.locals.adminName = req.session.adminName || req.session.adminUser;
  res.locals.adminRole = req.session.adminRole || 'employee';
  next();
});

// إدارة المستخدمين — للمديرين فقط
router.use('/users', requireManager, usersRouter);

// Root redirect
router.get('/', (req, res) => res.redirect('/admin/dashboard'));

// ─── Dashboard ────────────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const [
      total, pending, reviewed, shortlisted, interviewed, hired, on_hold, rejected,
      byCity, recent, trend
    ] = await Promise.all([
      db.get("SELECT COUNT(*) as c FROM applicants"),
      db.get("SELECT COUNT(*) as c FROM applicants WHERE status = 'pending'"),
      db.get("SELECT COUNT(*) as c FROM applicants WHERE status = 'reviewed'"),
      db.get("SELECT COUNT(*) as c FROM applicants WHERE status = 'shortlisted'"),
      db.get("SELECT COUNT(*) as c FROM applicants WHERE status = 'interviewed'"),
      db.get("SELECT COUNT(*) as c FROM applicants WHERE status = 'hired'"),
      db.get("SELECT COUNT(*) as c FROM applicants WHERE status = 'on_hold'"),
      db.get("SELECT COUNT(*) as c FROM applicants WHERE status = 'rejected'"),
      db.all(`
        SELECT city, COUNT(*) as count FROM applicants
        WHERE city IS NOT NULL GROUP BY city ORDER BY count DESC LIMIT 8
      `),
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
    ]);

    const stats = {
      total:       total?.c       || 0,
      pending:     pending?.c     || 0,
      reviewed:    reviewed?.c    || 0,
      shortlisted: shortlisted?.c || 0,
      interviewed: interviewed?.c || 0,
      hired:       hired?.c       || 0,
      on_hold:     on_hold?.c     || 0,
      rejected:    rejected?.c    || 0,
    };

    res.render('dashboard', {
      stats, byCity, recent, trend,
      STATUS_META, adminUser: req.session.adminUser
    });
  } catch (err) {
    console.error('[Dashboard GET]', err.message);
    res.status(500).send('خطأ في تحميل لوحة التحكم');
  }
});

// ─── Applicants List ──────────────────────────────────────────────────────────

router.get('/applicants', async (req, res) => {
  try {
    const {
      q = '', status = '', region = '', city = '', gender = '', english = '', qualification = '',
      has_car = '', has_license = '',
      age_min = '', age_max = '', date_from = '', date_to = '',
      sort = 'created_at', order = 'desc', page = '1'
    } = req.query;

    const PAGE_SIZE = 20;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const offset = (pageNum - 1) * PAGE_SIZE;

    const conditions = [];
    const params = [];

    if (q) {
      conditions.push('(full_name LIKE ? OR id_number LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (status)        { conditions.push('status = ?');        params.push(status); }
    if (region)        { conditions.push('region = ?');        params.push(region); }
    if (city)          { conditions.push('city = ?');          params.push(city); }
    if (gender)        { conditions.push('gender = ?');        params.push(gender); }
    if (english !== '') { conditions.push('english = ?');      params.push(parseInt(english)); }
    if (qualification) { conditions.push('qualification = ?'); params.push(qualification); }
    if (has_car !== '')     { conditions.push('has_car = ?');     params.push(parseInt(has_car)); }
    if (has_license !== '') { conditions.push('has_license = ?'); params.push(parseInt(has_license)); }
    if (age_min) { conditions.push('age >= ?'); params.push(parseInt(age_min)); }
    if (age_max) { conditions.push('age <= ?'); params.push(parseInt(age_max)); }
    if (date_from) { conditions.push('DATE(created_at) >= ?'); params.push(date_from); }
    if (date_to)   { conditions.push('DATE(created_at) <= ?'); params.push(date_to); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const safeSort  = ['created_at', 'full_name', 'status', 'age', 'region', 'rating'].includes(sort) ? sort : 'created_at';
    const safeOrder = order === 'asc' ? 'ASC' : 'DESC';

    const [countRow, applicants] = await Promise.all([
      db.get(`SELECT COUNT(*) as c FROM applicants ${where}`, params),
      db.all(`
        SELECT id, full_name, id_number, phone, age, gender, region, city, neighborhood, has_car, has_license,
               english, qualification, specialization, status, rating, created_at
        FROM applicants ${where}
        ORDER BY ${safeSort} ${safeOrder}
        LIMIT ${PAGE_SIZE} OFFSET ${offset}
      `, params),
    ]);

    const total = Number(countRow?.c) || 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);

    res.render('applicants', {
      applicants, total, totalPages, pageNum,
      filters: { q, status, region, city, gender, english, qualification, has_car, has_license, age_min, age_max, date_from, date_to, sort, order },
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

    const conditions = [];
    const params = [];
    if (q) { conditions.push('(full_name LIKE ? OR id_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (status)        { conditions.push('status = ?');        params.push(status); }
    if (region)        { conditions.push('region = ?');        params.push(region); }
    if (gender)        { conditions.push('gender = ?');        params.push(gender); }
    if (english !== '') { conditions.push('english = ?');      params.push(parseInt(english)); }
    if (qualification) { conditions.push('qualification = ?'); params.push(qualification); }
    if (has_car !== '')     { conditions.push('has_car = ?');     params.push(parseInt(has_car)); }
    if (has_license !== '') { conditions.push('has_license = ?'); params.push(parseInt(has_license)); }
    if (age_min) { conditions.push('age >= ?'); params.push(parseInt(age_min)); }
    if (age_max) { conditions.push('age <= ?'); params.push(parseInt(age_max)); }
    if (date_from) { conditions.push('DATE(created_at) >= ?'); params.push(date_from); }
    if (date_to)   { conditions.push('DATE(created_at) <= ?'); params.push(date_to); }
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

    const [notes, activity] = await Promise.all([
      db.all('SELECT * FROM applicant_notes WHERE applicant_id = ? ORDER BY created_at DESC', [applicant.id]),
      db.all('SELECT * FROM applicant_activity WHERE applicant_id = ? ORDER BY created_at DESC', [applicant.id]),
    ]);

    res.render('applicant-detail', {
      applicant, notes, activity,
      STATUS_META, NOTE_TYPES, adminUser: req.session.adminUser
    });
  } catch (err) {
    console.error('[Applicant Detail]', err.message);
    res.status(500).send('خطأ في تحميل بيانات المتقدم');
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
      db.logActivity(req.params.id, `إضافة ${NOTE_TYPES[noteType].label}`, null, content.trim().substring(0, 60), req.session.adminName || null),
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
    const { user = '', action = '', date_from = '', date_to = '', page = '1' } = req.query;
    const PAGE_SIZE = 50;
    const pageNum   = Math.max(1, parseInt(page) || 1);
    const offset    = (pageNum - 1) * PAGE_SIZE;

    const conditions = [];
    const params     = [];
    if (user)      { conditions.push('a.username = ?');              params.push(user); }
    if (action)    { conditions.push('a.action = ?');                params.push(action); }
    if (date_from) { conditions.push('DATE(a.created_at) >= ?');     params.push(date_from); }
    if (date_to)   { conditions.push('DATE(a.created_at) <= ?');     params.push(date_to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [countRow, logs, users] = await Promise.all([
      db.get(`SELECT COUNT(*) as c FROM audit_log a ${where}`, params),
      db.all(`SELECT a.* FROM audit_log a ${where} ORDER BY a.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`, params),
      db.all('SELECT DISTINCT username FROM audit_log ORDER BY username ASC'),
    ]);

    const total      = Number(countRow?.c) || 0;
    const totalPages = Math.ceil(total / PAGE_SIZE);

    res.render('audit', {
      logs, users, total, totalPages, pageNum,
      filters: { user, action, date_from, date_to },
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
        (SELECT MAX(al2.created_at) FROM audit_log al2
         WHERE al2.user_id = u.id AND al2.action NOT IN ('login','logout'))
          AS overall_last_action
      FROM admin_users u
      LEFT JOIN audit_log a
        ON a.user_id = u.id
        AND DATE(a.created_at) >= ? AND DATE(a.created_at) <= ?
      WHERE u.role = 'employee'
      GROUP BY u.id
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
