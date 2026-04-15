// Protect all /admin routes (except /admin/login)
module.exports = function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) return next();
  res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
};
