const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const requireAuth = require('../middleware/auth');

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

const CITIES = ['الرياض', 'جدة', 'الدمام', 'مكة المكرمة', 'المدينة المنورة', 'الطائف', 'القصيم', 'أبها', 'تبوك', 'حائل', 'أخرى'];

// ─── Login ────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin/dashboard');
  res.render('login', { error: null, next: req.query.next || '/admin/dashboard' });
});

router.post('/login', (req, res) => {
  const { username, password, next } = req.body;
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة', next: next || '/admin/dashboard' });
  }
  req.session.adminId = user.id;
  req.session.adminUser = user.username;
  res.redirect(next || '/admin/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ─── All routes below require auth ───────────────────────────────────────────
router.use(requireAuth);

// Root redirect
router.get('/', (req, res) => res.redirect('/admin/dashboard'));

// ─── Dashboard ────────────────────────────────────────────────────────────────

router.get('/dashboard', (req, res) => {
  const stats = {
    total:       db.prepare("SELECT COUNT(*) as c FROM applicants").get().c,
    pending:     db.prepare("SELECT COUNT(*) as c FROM applicants WHERE status='pending'").get().c,
    reviewed:    db.prepare("SELECT COUNT(*) as c FROM applicants WHERE status='reviewed'").get().c,
    shortlisted: db.prepare("SELECT COUNT(*) as c FROM applicants WHERE status='shortlisted'").get().c,
    interviewed: db.prepare("SELECT COUNT(*) as c FROM applicants WHERE status='interviewed'").get().c,
    hired:       db.prepare("SELECT COUNT(*) as c FROM applicants WHERE status='hired'").get().c,
    on_hold:     db.prepare("SELECT COUNT(*) as c FROM applicants WHERE status='on_hold'").get().c,
    rejected:    db.prepare("SELECT COUNT(*) as c FROM applicants WHERE status='rejected'").get().c,
  };

  const byCity = db.prepare(`
    SELECT city, COUNT(*) as count FROM applicants
    WHERE city IS NOT NULL GROUP BY city ORDER BY count DESC LIMIT 8
  `).all();

  const recent = db.prepare(`
    SELECT id, full_name, city, status, created_at FROM applicants
    ORDER BY created_at DESC LIMIT 8
  `).all();

  // Last 7 days trend
  const trend = db.prepare(`
    SELECT DATE(created_at) as day, COUNT(*) as count
    FROM applicants
    WHERE created_at >= DATE('now', '-6 days')
    GROUP BY DATE(created_at)
    ORDER BY day ASC
  `).all();

  res.render('dashboard', {
    stats, byCity, recent, trend,
    STATUS_META, adminUser: req.session.adminUser
  });
});

// ─── Applicants List ──────────────────────────────────────────────────────────

router.get('/applicants', (req, res) => {
  const {
    q = '', status = '', city = '', has_car = '', has_license = '',
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
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (city)   { conditions.push('city = ?');   params.push(city); }
  if (has_car !== '')     { conditions.push('has_car = ?');     params.push(parseInt(has_car)); }
  if (has_license !== '') { conditions.push('has_license = ?'); params.push(parseInt(has_license)); }
  if (age_min) { conditions.push('age >= ?'); params.push(parseInt(age_min)); }
  if (age_max) { conditions.push('age <= ?'); params.push(parseInt(age_max)); }
  if (date_from) { conditions.push("DATE(created_at) >= ?"); params.push(date_from); }
  if (date_to)   { conditions.push("DATE(created_at) <= ?"); params.push(date_to); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const safeSort  = ['created_at', 'full_name', 'status', 'age', 'city', 'rating'].includes(sort) ? sort : 'created_at';
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';

  const total = db.prepare(`SELECT COUNT(*) as c FROM applicants ${where}`).get(...params).c;
  const applicants = db.prepare(`
    SELECT id, full_name, id_number, phone, age, city, has_car, has_license,
           status, rating, created_at
    FROM applicants ${where}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `).all(...params);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  res.render('applicants', {
    applicants, total, totalPages, pageNum,
    filters: { q, status, city, has_car, has_license, age_min, age_max, date_from, date_to, sort, order },
    STATUS_META, CITIES, adminUser: req.session.adminUser
  });
});

// ─── Export Excel ─────────────────────────────────────────────────────────────

router.get('/applicants/export', async (req, res) => {
  const ExcelJS = require('exceljs');

  const {
    q = '', status = '', city = '', has_car = '', has_license = '',
    age_min = '', age_max = '', date_from = '', date_to = ''
  } = req.query;

  const conditions = [];
  const params = [];
  if (q) { conditions.push('(full_name LIKE ? OR id_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (city)   { conditions.push('city = ?');   params.push(city); }
  if (has_car !== '')     { conditions.push('has_car = ?');     params.push(parseInt(has_car)); }
  if (has_license !== '') { conditions.push('has_license = ?'); params.push(parseInt(has_license)); }
  if (age_min) { conditions.push('age >= ?'); params.push(parseInt(age_min)); }
  if (age_max) { conditions.push('age <= ?'); params.push(parseInt(age_max)); }
  if (date_from) { conditions.push("DATE(created_at) >= ?"); params.push(date_from); }
  if (date_to)   { conditions.push("DATE(created_at) <= ?"); params.push(date_to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT full_name, id_number, phone, age, city,
           has_car, has_license, status, rating, created_at
    FROM applicants ${where} ORDER BY created_at DESC
  `).all(...params);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Artal Sentinel';
  const ws = wb.addWorksheet('المتقدمون', { views: [{ rightToLeft: true }] });

  ws.columns = [
    { header: 'الاسم الرباعي',     key: 'full_name',    width: 28 },
    { header: 'رقم الهوية',        key: 'id_number',    width: 16 },
    { header: 'رقم الجوال',        key: 'phone',        width: 16 },
    { header: 'العمر',             key: 'age',          width: 8  },
    { header: 'المدينة',           key: 'city',         width: 16 },
    { header: 'يمتلك سيارة',       key: 'has_car',      width: 14 },
    { header: 'رخصة قيادة',        key: 'has_license',  width: 14 },
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
      has_car: r.has_car ? 'نعم' : 'لا',
      has_license: r.has_license ? 'نعم' : 'لا',
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
  await wb.xlsx.write(res);
  res.end();
});

// ─── Applicant Detail ─────────────────────────────────────────────────────────

router.get('/applicants/:id', (req, res) => {
  const applicant = db.prepare('SELECT * FROM applicants WHERE id = ?').get(req.params.id);
  if (!applicant) return res.status(404).send('المتقدم غير موجود');

  const notes = db.prepare(`
    SELECT * FROM applicant_notes WHERE applicant_id = ? ORDER BY created_at DESC
  `).all(applicant.id);

  const activity = db.prepare(`
    SELECT * FROM applicant_activity WHERE applicant_id = ? ORDER BY created_at DESC
  `).all(applicant.id);

  res.render('applicant-detail', {
    applicant, notes, activity,
    STATUS_META, NOTE_TYPES, adminUser: req.session.adminUser
  });
});

// ─── Update Status ────────────────────────────────────────────────────────────

router.post('/applicants/:id/status', (req, res) => {
  const { status } = req.body;
  if (!STATUS_META[status]) return res.status(400).json({ error: 'حالة غير صالحة' });

  const applicant = db.prepare('SELECT status FROM applicants WHERE id = ?').get(req.params.id);
  if (!applicant) return res.status(404).json({ error: 'غير موجود' });

  db.prepare('UPDATE applicants SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, req.params.id);

  db.logActivity(
    req.params.id,
    'تغيير الحالة',
    STATUS_META[applicant.status]?.label,
    STATUS_META[status]?.label
  );

  res.json({ ok: true, status, label: STATUS_META[status].label });
});

// ─── Update Rating ────────────────────────────────────────────────────────────

router.post('/applicants/:id/rating', (req, res) => {
  const rating = parseInt(req.body.rating);
  if (isNaN(rating) || rating < 0 || rating > 5)
    return res.status(400).json({ error: 'تقييم غير صالح' });

  const applicant = db.prepare('SELECT rating FROM applicants WHERE id = ?').get(req.params.id);
  if (!applicant) return res.status(404).json({ error: 'غير موجود' });

  db.prepare('UPDATE applicants SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(rating, req.params.id);

  db.logActivity(req.params.id, 'تحديث التقييم', `${applicant.rating} نجوم`, `${rating} نجوم`);
  res.json({ ok: true, rating });
});

// ─── Add Note ─────────────────────────────────────────────────────────────────

router.post('/applicants/:id/notes', (req, res) => {
  const { content, type } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'المحتوى مطلوب' });
  const noteType = NOTE_TYPES[type] ? type : 'note';

  const result = db.prepare(`
    INSERT INTO applicant_notes (applicant_id, content, type) VALUES (?, ?, ?)
  `).run(req.params.id, content.trim(), noteType);

  db.logActivity(req.params.id, `إضافة ${NOTE_TYPES[noteType].label}`, null, content.trim().substring(0, 60));

  // Update applicant updated_at
  db.prepare('UPDATE applicants SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

  const note = db.prepare('SELECT * FROM applicant_notes WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ok: true, note: { ...note, typeLabel: NOTE_TYPES[noteType].label, typeIcon: NOTE_TYPES[noteType].icon } });
});

// ─── Delete Note ──────────────────────────────────────────────────────────────

router.delete('/applicants/:id/notes/:nid', (req, res) => {
  db.prepare('DELETE FROM applicant_notes WHERE id = ? AND applicant_id = ?')
    .run(req.params.nid, req.params.id);
  res.json({ ok: true });
});

// ─── Delete Applicant ─────────────────────────────────────────────────────────

router.delete('/applicants/:id', (req, res) => {
  const applicant = db.prepare('SELECT full_name FROM applicants WHERE id = ?').get(req.params.id);
  if (!applicant) return res.status(404).json({ error: 'غير موجود' });
  db.prepare('DELETE FROM applicants WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  const settings = db.getSettings();
  res.render('settings', { settings, success: req.query.saved, adminUser: req.session.adminUser });
});

router.post('/settings', (req, res) => {
  const allowed = ['phone', 'email', 'address', 'company_name', 'accepting_applications'];
  const update = db.prepare(`
    UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?
  `);
  const tx = db.transaction(() => {
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        update.run(req.body[key], key);
      }
    }
    // checkbox — unchecked sends nothing, so default to false
    if (req.body.accepting_applications === undefined) {
      update.run('false', 'accepting_applications');
    }
  });
  tx();
  res.redirect('/admin/settings?saved=1');
});

router.post('/settings/password', (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const settings = db.getSettings();

  const admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.session.adminId);
  if (!bcrypt.compareSync(current_password, admin.password_hash)) {
    return res.render('settings', { settings, success: null, passwordError: 'كلمة المرور الحالية غير صحيحة', adminUser: req.session.adminUser });
  }
  if (new_password.length < 8) {
    return res.render('settings', { settings, success: null, passwordError: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل', adminUser: req.session.adminUser });
  }
  if (new_password !== confirm_password) {
    return res.render('settings', { settings, success: null, passwordError: 'كلمتا المرور غير متطابقتين', adminUser: req.session.adminUser });
  }
  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, req.session.adminId);
  res.redirect('/admin/settings?saved=2');
});

module.exports = router;
