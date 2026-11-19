const express = require('express');
const router = express.Router();
const db = require('../database/db');
const upload = require('../middleware/upload');
const { checkExternal } = require('../utils/extCheck');
const jobsCities = require('./jobs').CITIES;   // لسحابة روابط المدن في التذييل
const legal = require('../utils/legal');

// GET /apply — public application form
// «التوصيات»: رابط الدعوة الشخصي (/apply?ref=…) يعبّئ الاسم والجوال ويربط الطلب
// بتوصيته. يُحمَّل بحذر: غياب الميزة أو تعطّلها لا يمسّ التقديم العادي بحرف.
let leads = null;
try { leads = require('./leads'); } catch (e) { console.error('[Apply] ميزة التوصيات غير محمّلة:', e.message); }

router.get('/', async (req, res) => {
  try {
    // رابط دعوة شخصي؟ يُقرأ أولاً: الموظف المؤقت من لوحة العمليات يسجّل بياناته ولو كان
    // استقبال الطلبات متوقفاً — هو موظف يكمل ملفه لا باحث عن وظيفة.
    let invited = null;
    if (leads && req.query.ref) invited = await leads.byToken(String(req.query.ref)).catch(() => null);

    const setting = await db.get("SELECT value FROM settings WHERE `key` = 'accepting_applications'");
    if (setting && setting.value === 'false' && !invited?.ext_employee_id) {
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

    // رابط دعوة شخصي؟ نعبّئ الاسم والجوال ونسجّل أن الرابط فُتح فعلاً
    let prefill = {};
    if (invited) {
      prefill = { full_name: invited.full_name || '', phone: invited.phone, ref: invited.token };
      leads.markOpened(invited).catch(() => {});
    }
    res.render('apply', { cities: jobsCities, prefill });
  } catch (err) {
    console.error('[Apply GET]', err.message);
    res.render('apply', { cities: jobsCities });
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
      const { full_name, id_number, phone, email, age, gender, region, city, neighborhood, has_car, has_license, english, qualification, specialization, source, referrer, landing_page, consent } = req.body;

      // البريد الإلكتروني إلزامي — قناة تواصل ثابتة لا تتعطّل كالجوال
      const emailVal = email ? String(email).trim().toLowerCase() : '';

      // Basic validation
      const errors = [];
      if (!full_name || full_name.trim().length < 5)            errors.push('الاسم الرباعي مطلوب (5 أحرف على الأقل)');
      if (!id_number || !/^\d{10}$/.test(id_number.trim()))     errors.push('رقم الهوية يجب أن يكون 10 أرقام');
      if (!phone || !/^05\d{8}$/.test(phone.trim()))            errors.push('رقم الجوال غير صحيح');
      if (!emailVal)                                           errors.push('البريد الإلكتروني مطلوب');
      else if (emailVal.length > 120 || !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(emailVal))
        errors.push('البريد الإلكتروني غير صحيح');
      const ageInt = parseInt(age);
      // حدّ الـ23 شرط توظيف، والموظف المؤقت من لوحة العمليات موظف فعلاً يسجّل بياناته —
      // رفضه هنا يتركه بلا طريق لاستكمال ملفه. يكفيه السنّ النظامي للعمل.
      const invitedLead = leads ? await leads.byToken(String(req.body.lead_ref || '')).catch(() => null) : null;
      const minAge = invitedLead?.ext_employee_id ? 18 : 23;
      if (!age || isNaN(ageInt))         errors.push('يرجى إدخال العمر');
      else if (ageInt >= 100)            errors.push('العمر غير صحيح — يرجى إدخال عمرك وليس سنة ميلادك');
      else if (ageInt < minAge)          errors.push(`العمر يجب أن يكون ${minAge} سنة فأكبر`);
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
      // الموافقة تُتحقَّق في الخادم لا في المتصفح وحده: تحقق المتصفح يُتجاوَز
      // بإرسال الطلب مباشرةً، ولا يصح أن تدخل بيانات هوية بلا موافقة مسجّلة.
      if (consent !== 'yes')
        errors.push('يجب الاطّلاع على شروط الاستخدام وسياسة الخصوصية والموافقة عليهما قبل إرسال الطلب');

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

      // إعادة التقديم مسموحة: كل طلب يُسجَّل كصفّ جديد؛ لوحة الإدارة تربط
      // التقديمات المتعددة بنفس رقم الهوية وتعرض سجلّها (نظرة كاملة للمرشّح).

      const cvFile = req.files?.cv?.[0];
      const idFile = req.files?.id_image?.[0];

      // طلب إضافة من لوحة العمليات فُتح له سجل أساسي (اسم وهوية وجوال) ورفع عليه مرفقاته:
      // تسجيله الآن يُكمل ذلك السجل نفسه — صفّ ثانٍ كان سيفصل بياناته عن مستنداته.
      let stubId = null;
      if (leads) {
        try {
          const own = await leads.findForApplication({ token: String(req.body.lead_ref || ''), phone: phone.trim(), idNumber: id_number.trim() });
          if (own && own.hire_request_id) {
            const stub = await db.get(
              `SELECT a.* FROM applicants a JOIN onboarding_sessions s ON s.applicant_id = a.id
                WHERE s.hire_request_id = ? ORDER BY s.id DESC LIMIT 1`, [own.hire_request_id]
            );
            if (stub && require('./onboarding').isStubApplicant(stub)) stubId = stub.id;
          }
        } catch (e) {
          console.error('[Apply] stub lookup:', e.message);
        }
      }

      const result = stubId ? { insertId: stubId } : await db.run(
        `INSERT INTO applicants
          (full_name, id_number, phone, email, age, gender, region, city, neighborhood,
           has_car, has_license, english, qualification, specialization, cv_path, id_image_path,
           source, referrer, landing_page, consent_at, consent_ip, privacy_version, terms_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
        [
          full_name.trim(),
          id_number.trim(),
          phone.trim(),
          emailVal || null,
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
          source ? String(source).trim().slice(0, 60) : null,
          referrer ? String(referrer).trim().slice(0, 255) : null,
          landing_page ? String(landing_page).trim().slice(0, 255) : null,
          req.ip ? String(req.ip).slice(0, 45) : null,
          legal.PRIVACY.VERSION,
          legal.TERMS.VERSION,
        ]
      );

      if (stubId) {
        // رقم الهوية لا يُمسّ: عليه رُفعت المرفقات وبه أُنشئ الموظف — ما كتبه الآن يُقارَن أدناه
        await db.run(
          `UPDATE applicants
              SET full_name = ?, phone = ?, email = ?, age = ?, gender = ?, region = ?, city = ?, neighborhood = ?,
                  has_car = ?, has_license = ?, english = ?, qualification = ?, specialization = ?,
                  cv_path = COALESCE(?, cv_path), id_image_path = COALESCE(?, id_image_path),
                  consent_at = NOW(), consent_ip = ?, privacy_version = ?, terms_version = ?
            WHERE id = ?`,
          [
            full_name.trim(), phone.trim(), emailVal || null, ageInt, gender, region.trim(), city.trim(),
            neighborhood ? neighborhood.trim() : null,
            has_car === 'yes' ? 1 : 0, has_license === 'yes' ? 1 : 0, english === 'yes' ? 1 : 0,
            qualification, specialization ? specialization.trim() : null,
            cvFile ? cvFile.filename : null, idFile ? idFile.filename : null,
            req.ip ? String(req.ip).slice(0, 45) : null, legal.PRIVACY.VERSION, legal.TERMS.VERSION,
            stubId,
          ]
        );
        await db.logActivity(stubId, 'سجّل بياناته في نموذج التسجيل', null, null);
      } else {
        await db.logActivity(result.insertId, 'تقديم جديد', null, 'pending');
      }

      // طلب جاء عبر توصية؟ بالرمز من رابط الدعوة، أو بالجوال إن تقدّم من الرابط
      // العام. المصدر الحقيقي حينها «توصية» لا ما التقطه كوكي الزيارة الأولى.
      if (leads) {
        try {
          const lead = await leads.linkApplicant({
            token: String(req.body.lead_ref || ''), phone: phone.trim(), idNumber: id_number.trim(), applicantId: result.insertId,
          });
          if (lead && lead.ext_employee_id) {
            // موظف مؤقت من لوحة العمليات سجّل بياناته: هو موظف لا متقدم جديد — لا يدخل
            // طابور الفرز، ورحلة استكمال مستنداته تُفتح ويصله رابطها الآن (في الخلفية:
            // تسجيله تمّ، وأي تعثّر هنا يُرى في ملفه ويُعاد من زر الإرسال).
            await db.run("UPDATE applicants SET source = 'لوحة العمليات', referrer = ?, status = 'hired' WHERE id = ?",
              [`موظف مؤقت #${lead.ext_employee_id}`, result.insertId]);
            await db.logActivity(result.insertId, 'سجّل بياناته — موظف مؤقت من لوحة العمليات', 'pending', 'hired', 'النظام');
            if (lead.ext_national_id && lead.ext_national_id !== id_number.trim()) {
              await db.run('INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
                [result.insertId, `⚠️ رقم الهوية الذي كتبه (${id_number.trim()}) يختلف عمّا أدخلته لوحة العمليات (${lead.ext_national_id}) — يُراجع قبل تحديث ملفه`, 'follow_up', 'النظام']);
            }
            const addedBy = (String(lead.note || '').match(/أضافه ([^·]+)/) || [])[1];
            const onboarding = require('./onboarding');
            if (onboarding.featureOn()) onboarding.quickHire({
              employeeId: lead.ext_employee_id,
              // السجل الأساسي يحتفظ بهويته (عليها مرفقاته) — وإلا فما كتبه في النموذج
              nationalId: stubId ? (lead.ext_national_id || id_number.trim()) : id_number.trim(),
              fullName: full_name.trim(),
              phone: phone.trim(),
              addedBy: addedBy ? addedBy.trim() : null,
            }, req).catch(e => console.error('[Apply] quick-hire continue:', e.message));
          } else if (lead) {
            const by = lead.referred_by ? `توصية — ${lead.referred_by}` : 'توصية';
            await db.run('UPDATE applicants SET source = ?, referrer = ? WHERE id = ?',
              ['توصية', by.slice(0, 255), result.insertId]);
            await db.run(
              'INSERT INTO applicant_notes (applicant_id, content, type, user_name) VALUES (?, ?, ?, ?)',
              [result.insertId,
               `تقدّم عبر توصية${lead.referred_by ? ` من ${lead.referred_by}` : ''}${lead.note ? ` — ${lead.note}` : ''} (أضافها ${lead.created_by || 'النظام'})`,
               'note', 'النظام']
            );
            await db.logActivity(result.insertId, 'تقدّم عبر توصية', null, lead.referred_by || null, 'النظام');
          }
        } catch (e) {
          console.error('[Apply] lead link:', e.message);
        }
      }

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
