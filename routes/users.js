const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const db       = require('../database/db');

// ─── قائمة المستخدمين ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT u.id, u.username, u.role, u.is_active, u.last_login, u.created_at,
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
router.post('/', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const errors = [];
    if (!username || username.trim().length < 3) errors.push('اسم المستخدم يجب أن يكون 3 أحرف على الأقل');
    if (!password || password.length < 8)        errors.push('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    if (role !== 'manager' && role !== 'employee') errors.push('الدور غير صالح');

    if (errors.length) return res.redirect(`/admin/users?err=${encodeURIComponent(errors[0])}`);

    const existing = await db.get('SELECT id FROM admin_users WHERE username = ?', [username.trim()]);
    if (existing) return res.redirect('/admin/users?err=' + encodeURIComponent('اسم المستخدم مستخدم مسبقاً'));

    const hash = await bcrypt.hash(password, 12);
    const result = await db.run(
      "INSERT INTO admin_users (username, role, password_hash) VALUES (?, ?, ?)",
      [username.trim(), role, hash]
    );

    await db.audit(
      req.session.adminId, req.session.adminUser,
      'user_create', 'user', result.insertId, username.trim(),
      `دور: ${role === 'manager' ? 'مدير' : 'موظف'}`,
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
    const { role, is_active } = req.body;
    const id = parseInt(req.params.id);

    // لا يمكن تعديل نفسك
    if (id === req.session.adminId)
      return res.redirect('/admin/users?err=' + encodeURIComponent('لا يمكنك تعديل حسابك من هنا'));

    const user = await db.get('SELECT username, role, is_active FROM admin_users WHERE id = ?', [id]);
    if (!user) return res.redirect('/admin/users?err=' + encodeURIComponent('المستخدم غير موجود'));

    const newRole     = (role === 'manager' || role === 'employee') ? role : user.role;
    const newActive   = is_active === '1' ? 1 : 0;

    await db.run(
      'UPDATE admin_users SET role = ?, is_active = ? WHERE id = ?',
      [newRole, newActive, id]
    );

    await db.audit(
      req.session.adminId, req.session.adminUser,
      'user_update', 'user', id, user.username,
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
