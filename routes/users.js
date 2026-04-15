const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const db       = require('../database/db');

// ─── قائمة المستخدمين ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.last_login, u.created_at,
             COUNT(a.id) AS action_count
      FROM admin_users u
      LEFT JOIN audit_log a ON a.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at ASC
    `);
    res.render('users', {
      users,
      currentUser: req.session.adminId,
      success: req.query.saved || null,
      error:   req.query.err   || null,
    });
  } catch (err) {
    console.error('[Users GET]', err.message);
    res.status(500).send('خطأ في تحميل المستخدمين');
  }
});

// ─── إنشاء مستخدم جديد ───────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/', async (req, res) => {
  try {
    const { email, full_name, password, role } = req.body;
    const emailTrim = (email || '').trim().toLowerCase();
    const nameTrim  = (full_name || '').trim();

    const errors = [];
    if (!emailTrim || !EMAIL_RE.test(emailTrim)) errors.push('يرجى إدخال بريد إلكتروني صحيح');
    if (!nameTrim  || nameTrim.length < 2)        errors.push('الاسم يجب أن يكون حرفين على الأقل');
    if (!password  || password.length < 8)        errors.push('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    if (role !== 'manager' && role !== 'employee') errors.push('الدور غير صالح');

    if (errors.length) return res.redirect(`/admin/users?err=${encodeURIComponent(errors[0])}`);

    const existing = await db.get('SELECT id FROM admin_users WHERE username = ?', [emailTrim]);
    if (existing) return res.redirect('/admin/users?err=' + encodeURIComponent('هذا البريد الإلكتروني مسجّل مسبقاً'));

    const hash = await bcrypt.hash(password, 12);
    const result = await db.run(
      "INSERT INTO admin_users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)",
      [emailTrim, nameTrim, role, hash]
    );

    await db.audit(
      req.session.adminId, req.session.adminUser,
      'user_create', 'user', result.insertId, nameTrim,
      `البريد: ${emailTrim} | الدور: ${role === 'manager' ? 'مدير' : 'موظف'}`,
      req.ip
    );

    res.redirect('/admin/users?saved=1');
  } catch (err) {
    console.error('[Users POST]', err.message);
    res.redirect('/admin/users?err=' + encodeURIComponent('حدث خطأ أثناء إنشاء المستخدم'));
  }
});

// ─── تعديل دور المستخدم وحالة التفعيل ──────────────────────────────────────
router.post('/:id/update', async (req, res) => {
  try {
    const { role, is_active, full_name } = req.body;
    const id = parseInt(req.params.id);

    // لا يمكن تعديل نفسك
    if (id === req.session.adminId)
      return res.redirect('/admin/users?err=' + encodeURIComponent('لا يمكنك تعديل حسابك من هنا'));

    const user = await db.get('SELECT username, full_name, role, is_active FROM admin_users WHERE id = ?', [id]);
    if (!user) return res.redirect('/admin/users?err=' + encodeURIComponent('المستخدم غير موجود'));

    const newRole    = (role === 'manager' || role === 'employee') ? role : user.role;
    const newActive  = is_active === '1' ? 1 : 0;
    const newName    = (full_name || '').trim() || user.full_name;

    await db.run(
      'UPDATE admin_users SET role = ?, is_active = ?, full_name = ? WHERE id = ?',
      [newRole, newActive, newName, id]
    );

    await db.audit(
      req.session.adminId, req.session.adminUser,
      'user_update', 'user', id, newName || user.username,
      `الدور: ${newRole === 'manager' ? 'مدير' : 'موظف'} | الحالة: ${newActive ? 'نشط' : 'موقوف'}`,
      req.ip
    );

    res.redirect('/admin/users?saved=2');
  } catch (err) {
    console.error('[Users Update]', err.message);
    res.redirect('/admin/users?err=' + encodeURIComponent('حدث خطأ أثناء التعديل'));
  }
});

// ─── إعادة تعيين كلمة المرور ────────────────────────────────────────────────
router.post('/:id/password', async (req, res) => {
  try {
    const id  = parseInt(req.params.id);
    const { new_password, confirm_password } = req.body;

    if (!new_password || new_password.length < 8)
      return res.redirect('/admin/users?err=' + encodeURIComponent('كلمة المرور يجب أن تكون 8 أحرف على الأقل'));
    if (new_password !== confirm_password)
      return res.redirect('/admin/users?err=' + encodeURIComponent('كلمتا المرور غير متطابقتين'));

    const user = await db.get('SELECT username FROM admin_users WHERE id = ?', [id]);
    if (!user) return res.redirect('/admin/users?err=' + encodeURIComponent('المستخدم غير موجود'));

    const hash = await bcrypt.hash(new_password, 12);
    await db.run('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hash, id]);

    await db.audit(
      req.session.adminId, req.session.adminUser,
      'password_reset', 'user', id, user.username,
      `إعادة تعيين كلمة مرور المستخدم ${user.username}`,
      req.ip
    );

    res.redirect('/admin/users?saved=3');
  } catch (err) {
    console.error('[Users Password]', err.message);
    res.redirect('/admin/users?err=' + encodeURIComponent('حدث خطأ أثناء تغيير كلمة المرور'));
  }
});

// ─── حذف مستخدم ──────────────────────────────────────────────────────────────
router.post('/:id/delete', async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (id === req.session.adminId)
      return res.redirect('/admin/users?err=' + encodeURIComponent('لا يمكنك حذف حسابك الحالي'));

    const user = await db.get('SELECT username FROM admin_users WHERE id = ?', [id]);
    if (!user) return res.redirect('/admin/users?err=' + encodeURIComponent('المستخدم غير موجود'));

    await db.run('DELETE FROM admin_users WHERE id = ?', [id]);

    await db.audit(
      req.session.adminId, req.session.adminUser,
      'user_delete', 'user', id, user.username,
      null, req.ip
    );

    res.redirect('/admin/users?saved=4');
  } catch (err) {
    console.error('[Users Delete]', err.message);
    res.redirect('/admin/users?err=' + encodeURIComponent('حدث خطأ أثناء الحذف'));
  }
});

module.exports = router;
