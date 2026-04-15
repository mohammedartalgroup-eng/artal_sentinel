// يتحقق أن المستخدم الحالي مدير — للمسارات المحمية
module.exports = function requireManager(req, res, next) {
  if (req.session && req.session.adminRole === 'manager') return next();
  // طلبات API (fetch)
  if (req.xhr || (req.headers.accept || '').includes('application/json')) {
    return res.status(403).json({ error: 'غير مصرح — هذا الإجراء للمديرين فقط' });
  }
  // طلبات صفحات عادية — أعد توجيهه للوحة التحكم مع رسالة
  res.redirect('/admin/dashboard?err=403');
};
