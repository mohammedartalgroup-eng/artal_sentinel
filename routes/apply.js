const express = require('express');
const router = express.Router();
const db = require('../database/db');
const upload = require('../middleware/upload');
const { checkExternal } = require('../utils/extCheck');

// GET /apply — public application form
router.get('/', async (req, res) => {
  try {
    const setting = await db.get("SELECT value FROM settings WHERE `key` = 'accepting_applications'");
    if (setting && setting.value === 'false') {
      return res.status(503).send(`
        <!DOCTYPE html>
        <html dir="rtl" lang="ar">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>أرتال للحراسة الأمنية</title>
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
    res.render('apply');
  } catch (err) {
    console.error('[Apply GET]', err.message);
    res.render('apply');
  }
});

// POST /apply — process application submission
router.post('/', (req, res) => {
  // تشغيل multer يدوياً لنتمكن من التقاط أخطائه (حجم الملف، النوع، إلخ)
  upload.fields([{ name: 'cv', maxCount: 1 }, { name: 'id_image', maxCount: 1 }])(req, res, async (uploadErr) => {
    // خطأ multer — نوع ملف خاطئ أو تجاوز الحجم
    if (uploadErr) {
      console.error('[Apply Upload]', uploadErr.message);
      return res.status(400).send(`
        <!DOCTYPE html><html dir="rtl" lang="ar">
        <head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script></head>
        <body class="p-8 bg-red-50">
          <div class="max-w-md mx-auto bg-white p-6 rounded-xl shadow">
            <h2 class="text-red-700 font-bold text-lg mb-4">خطأ في رفع الملف</h2>
            <p class="text-red-600">${uploadErr.message}</p>
            <a href="/apply" class="mt-6 block text-center bg-blue-900 text-white py-3 rounded-lg">العودة للنموذج</a>
          </div>
        </body></html>
      `);
    }

    try {
      const { full_name, id_number, phone, age, gender, region, city, neighborhood, has_car, has_license, english, qualification, specialization } = req.body;

      // Basic validation
      const errors = [];
      if (!full_name || full_name.trim().length < 5)            errors.push('الاسم الرباعي مطلوب (5 أحرف على الأقل)');
      if (!id_number || !/^\d{10}$/.test(id_number.trim()))     errors.push('رقم الهوية يجب أن يكون 10 أرقام');
      if (!phone || !/^05\d{8}$/.test(phone.trim()))            errors.push('رقم الجوال غير صحيح');
      const ageInt = parseInt(age);
      if (!age || isNaN(ageInt))         errors.push('يرجى إدخال العمر');
      else if (ageInt >= 100)            errors.push('العمر غير صحيح — يرجى إدخال عمرك وليس سنة ميلادك');
      else if (ageInt <= 22)             errors.push('العمر يجب أن يكون 23 سنة فأكبر');
      if (!region || !region.trim())                            errors.push('المنطقة الإدارية مطلوبة');
      if (!city || !city.trim())                                errors.push('المدينة أو المحافظة مطلوبة');
      if (!neighborhood || !neighborhood.trim())                errors.push('اسم الحي مطلوب');
      if (gender !== 'male' && gender !== 'female')              errors.push('يرجى تحديد الجنس');
      if (english !== 'yes' && english !== 'no')                 errors.push('يرجى تحديد إجادة اللغة الإنجليزية');
      const validQuals = ['none','primary','middle','high_school','university'];
      if (!qualification || !validQuals.includes(qualification)) errors.push('يرجى اختيار المؤهل العلمي');
      if (has_car !== 'yes' && has_car !== 'no')                errors.push('يرجى تحديد ما إذا كنت تمتلك سيارة');
      if (has_license !== 'yes' && has_license !== 'no')        errors.push('يرجى تحديد ما إذا كان لديك رخصة قيادة');
      if (!req.files?.cv?.[0])                                  errors.push('السيرة الذاتية مطلوبة');
      if (!req.files?.id_image?.[0])                            errors.push('صورة الهوية الوطنية مطلوبة');

      if (errors.length) {
        return res.status(400).send(`
          <!DOCTYPE html><html dir="rtl" lang="ar">
          <head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script></head>
          <body class="p-8 bg-red-50">
            <div class="max-w-md mx-auto bg-white p-6 rounded-xl shadow">
              <h2 class="text-red-700 font-bold text-lg mb-4">يرجى تصحيح الأخطاء التالية:</h2>
              <ul class="list-disc pr-5 text-red-600 space-y-1">
                ${errors.map(e => `<li>${e}</li>`).join('')}
              </ul>
              <a href="/apply" class="mt-6 block text-center bg-blue-900 text-white py-3 rounded-lg">العودة للنموذج</a>
            </div>
          </body></html>
        `);
      }

      // Check duplicate ID
      const existing = await db.get(
        'SELECT id FROM applicants WHERE id_number = ?',
        [id_number.trim()]
      );
      if (existing) {
        return res.status(409).send(`
          <!DOCTYPE html><html dir="rtl" lang="ar">
          <head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script></head>
          <body class="p-8 bg-amber-50">
            <div class="max-w-md mx-auto bg-white p-6 rounded-xl shadow text-center">
              <div class="text-4xl mb-4">⚠️</div>
              <h2 class="font-bold text-lg mb-2">تم تسجيل طلبك مسبقاً</h2>
              <p class="text-slate-500 mb-6">رقم الهوية المدخل موجود بالفعل في قاعدة بياناتنا.</p>
              <a href="/apply" class="bg-blue-900 text-white px-6 py-3 rounded-lg">العودة</a>
            </div>
          </body></html>
        `);
      }

      const cvFile = req.files?.cv?.[0];
      const idFile = req.files?.id_image?.[0];

      const result = await db.run(
        `INSERT INTO applicants
          (full_name, id_number, phone, age, gender, region, city, neighborhood,
           has_car, has_license, english, qualification, specialization, cv_path, id_image_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          full_name.trim(),
          id_number.trim(),
          phone.trim(),
          ageInt,
          gender,
          region.trim(),
          city.trim(),
          neighborhood ? neighborhood.trim() : null,
          has_car === 'yes' ? 1 : 0,
          has_license === 'yes' ? 1 : 0,
          english === 'yes' ? 1 : 0,
          qualification,
          specialization ? specialization.trim() : null,
          cvFile ? cvFile.filename : null,
          idFile ? idFile.filename : null,
        ]
      );

      await db.logActivity(result.insertId, 'تقديم جديد', null, 'pending');

      // فحص النظام الخارجي في الخلفية — لا ينتظره ولا يؤثر على التسجيل
      checkExternal(result.insertId, id_number.trim()).catch(() => {});

      res.redirect('/success');
    } catch (err) {
      console.error('[Apply POST]', err.message);
      res.status(500).send(`
        <!DOCTYPE html><html dir="rtl"><body style="text-align:center;padding:4rem;font-family:sans-serif">
          <h2 style="color:#ba1a1a">حدث خطأ أثناء إرسال الطلب</h2>
          <p>يرجى المحاولة مرة أخرى أو التواصل مع الإدارة.</p>
          <a href="/apply">العودة</a>
        </body></html>
      `);
    }
  });
});

module.exports = router;
