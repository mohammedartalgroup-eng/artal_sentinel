const express = require('express');
const router = express.Router();

// صفحات هبوط المدن لمحركات البحث — كل مدينة على /jobs/<slug>
const CITIES = require('../data/seo-cities');

// GET /jobs/:slug — يعرض صفحة المدينة، وإن لم توجد المدينة يمرّر للـ 404
router.get('/:slug', (req, res, next) => {
  const city = CITIES.find(c => c.slug === req.params.slug);
  if (!city) return next();
  // cache على مستوى المتصفح/الـ CDN — المحتوى ثابت (التواريخ تتجدّد يومياً)
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.render('city-jobs', { city, cities: CITIES });
});

module.exports = router;
