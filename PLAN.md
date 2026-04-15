# Artal Sentinel — خطة التنفيذ ومتابعة العمل

## نظرة عامة
نظام إدارة التوظيف لشركة حراسات أرطال — يعمل كـ CRM متخصص للتوظيف.

---

## هيكل المشروع
```
artal_sentinel/
├── server.js                   ← نقطة الدخول الرئيسية
├── package.json
├── PLAN.md                     ← هذا الملف
├── DESIGN.md                   ← نظام التصميم
├── data/                       ← قاعدة البيانات (تُنشأ تلقائياً)
│   └── artal.db
├── database/
│   └── db.js                   ← إعداد SQLite + الجداول
├── middleware/
│   ├── auth.js                 ← حماية لوحة الأدمن
│   └── upload.js               ← رفع الملفات (Multer)
├── routes/
│   ├── apply.js                ← API استقبال الطلبات العامة
│   └── admin.js                ← كل مسارات لوحة التحكم
├── views/                      ← قوالب EJS
│   ├── partials/
│   │   └── sidebar.ejs
│   ├── login.ejs
│   ├── success.ejs             ← صفحة النجاح (ديناميكية)
│   ├── dashboard.ejs
│   ├── applicants.ejs
│   ├── applicant-detail.ejs    ← واجهة CRM
│   └── settings.ejs
├── public/
│   └── apply/
│       └── index.html          ← نموذج التقديم العام
└── uploads/
    ├── cv/
    └── id_images/
```

---

## قاعدة البيانات

### جدول `applicants`
| الحقل | النوع | الوصف |
|-------|------|-------|
| id | INTEGER PK | الرقم التسلسلي |
| full_name | TEXT | الاسم الرباعي |
| id_number | TEXT UNIQUE | رقم الهوية |
| phone | TEXT | رقم الجوال |
| age | INTEGER | العمر |
| city | TEXT | مقر السكن |
| has_car | INTEGER (0/1) | يمتلك سيارة |
| has_license | INTEGER (0/1) | يمتلك رخصة |
| cv_path | TEXT | مسار ملف السيرة الذاتية |
| id_image_path | TEXT | مسار صورة الهوية |
| status | TEXT | الحالة (أنظر الأدناه) |
| rating | INTEGER (0-5) | تقييم المتقدم |
| created_at | DATETIME | تاريخ التقديم |
| updated_at | DATETIME | آخر تحديث |

### حالات المتقدم (Pipeline)
```
pending → reviewed → shortlisted → interviewed → hired
                                               → on_hold
                                               → rejected
```
| الحالة | العربية | اللون |
|--------|---------|-------|
| pending | جديد | أزرق |
| reviewed | قيد المراجعة | أصفر |
| shortlisted | مرشح للمقابلة | بنفسجي |
| interviewed | تمت المقابلة | برتقالي |
| hired | تم التعيين | أخضر |
| on_hold | معلق | رمادي |
| rejected | مرفوض | أحمر |

### جدول `applicant_notes`
| الحقل | النوع | الوصف |
|-------|------|-------|
| id | INTEGER PK | |
| applicant_id | FK | |
| content | TEXT | نص الملاحظة |
| type | TEXT | note / call / interview / follow_up |
| created_at | DATETIME | |

### جدول `applicant_activity`
سجل تلقائي لكل تغيير في الحالة أو التقييم.

### جدول `settings`
| key | value |
|-----|-------|
| phone | رقم الهاتف |
| email | البريد الإلكتروني |
| address | العنوان |
| company_name | اسم الشركة |
| accepting_applications | true/false |

### جدول `admin_users`
مستخدمو لوحة التحكم مع كلمات مرور مشفرة (bcrypt).

---

## المسارات (Routes)

### العامة (Public)
| Method | Path | الوصف |
|--------|------|-------|
| GET | / | تحويل لـ /apply |
| GET | /apply | نموذج التقديم |
| POST | /apply | إرسال الطلب |
| GET | /success | صفحة النجاح (ديناميكية) |

### لوحة التحكم (Admin — محمية بجلسة)
| Method | Path | الوصف |
|--------|------|-------|
| GET | /admin | تحويل للـ dashboard |
| GET | /admin/login | صفحة تسجيل الدخول |
| POST | /admin/login | معالجة الدخول |
| GET | /admin/logout | تسجيل الخروج |
| GET | /admin/dashboard | الإحصائيات |
| GET | /admin/applicants | قائمة المتقدمين + فلترة |
| GET | /admin/applicants/export | تصدير Excel |
| GET | /admin/applicants/:id | تفاصيل المتقدم (CRM) |
| POST | /admin/applicants/:id/status | تحديث الحالة |
| POST | /admin/applicants/:id/rating | تحديث التقييم |
| POST | /admin/applicants/:id/notes | إضافة ملاحظة |
| DELETE | /admin/applicants/:id/notes/:nid | حذف ملاحظة |
| DELETE | /admin/applicants/:id | حذف المتقدم |
| GET | /admin/settings | صفحة الإعدادات |
| POST | /admin/settings | حفظ الإعدادات |
| POST | /admin/settings/password | تغيير كلمة المرور |

---

## خيارات الفلترة في قائمة المتقدمين
- `q` — بحث بالاسم أو رقم الهوية
- `status` — تصفية بالحالة
- `city` — تصفية بالمدينة
- `has_car` — يمتلك سيارة (0/1)
- `has_license` — يمتلك رخصة (0/1)
- `age_min` / `age_max` — نطاق العمر
- `date_from` / `date_to` — نطاق تاريخ التقديم
- `sort` — ترتيب (created_at / name / status)
- `order` — asc / desc
- `page` — رقم الصفحة (20 لكل صفحة)

---

## تقدم التنفيذ

| الملف | الحالة |
|-------|--------|
| PLAN.md | ✅ مكتمل |
| package.json | ✅ مكتمل |
| server.js | ✅ مكتمل |
| database/db.js | ✅ مكتمل |
| middleware/auth.js | ✅ مكتمل |
| middleware/upload.js | ✅ مكتمل |
| routes/apply.js | ✅ مكتمل |
| routes/admin.js | ✅ مكتمل |
| views/partials/sidebar.ejs | ✅ مكتمل |
| views/login.ejs | ✅ مكتمل |
| views/success.ejs | ✅ مكتمل |
| views/dashboard.ejs | ✅ مكتمل |
| views/applicants.ejs | ✅ مكتمل |
| views/applicant-detail.ejs | ✅ مكتمل |
| views/settings.ejs | ✅ مكتمل |
| public/apply/index.html | ✅ مكتمل |

---

## سجل التغييرات
- **2026-04-14**: اكتمل بناء النظام الكامل وتم اختبار جميع المسارات بنجاح.
  - رُفّع better-sqlite3 من v9 إلى v11 لدعم Node.js v24
  - تم تصحيح ترتيب الـ middleware في server.js لضمان عمل فحص استقبال الطلبات

---

## بيانات الدخول الافتراضية
```
URL:      http://localhost:3000/admin
Username: admin
Password: admin123
```
**يجب تغيير كلمة المرور فور أول دخول من صفحة الإعدادات.**

---

## تشغيل النظام
```bash
cd artal_sentinel
npm install
node server.js
# أو للتطوير:
npm run dev
```
