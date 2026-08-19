/**
 * waTemplates.js
 * سجل قوالب واتساب اليدوية — تلك التي يرسلها الموظف بضغطة زر من صفحة المتقدم،
 * تمييزاً عن إشعارات المقابلة التلقائية (utils/notify.js → KINDS).
 *
 * إضافة قالب معتمد جديد = مدخلة واحدة هنا. الزر في صفحة المتقدم، وخانات
 * الإعدادات، والتحقق من المدخلات — كلها تُبنى من هذا السجل تلقائياً.
 *
 * fields = ما يعبّئه الموظف قبل الإرسال (نص حر دائماً، مع تعبئة مسبقة).
 *          بقية المتغيّرات تُشتق من ملف المتقدم (الاسم، المدينة، المنطقة…).
 * الترتيب الفعلي للمتغيّرات يأتي من الإعدادات لا من هنا، فيبقى قابلاً
 * للتصحيح دون نشر جديد إن اختلف القالب المعتمد عمّا توقّعناه.
 */

const TEMPLATES = {
  inforeq: {
    key: 'inforeq',
    kind: 'info_request',
    label: 'طلب استكمال البيانات',
    icon: 'quiz',
    title: 'طلب استكمال البيانات',
    desc: 'رسالة واتساب تطلب من المتقدم بيانات السكن والعمر والحالة الوظيفية والصحية والتأمينات.',
    settingsLabel: 'طلب استكمال بيانات المرشح',
    settingsHint: 'زر يدوي في صفحة المتقدم — مستقل عن المقابلات ولا يتأثر بمفتاح الإرسال التلقائي',
    fields: ['job', 'project', 'region'],
    noteLabel: 'طلب استكمال بيانات',
  },
  screening: {
    key: 'screening',
    kind: 'screening',
    label: 'التحقق من الجاهزية',
    icon: 'how_to_reg',
    title: 'التحقق من جاهزية المتقدم',
    desc: 'تُعرض على المتقدم شروط الوظيفة (التفرّغ، الحالة الصحية، امتلاك سيارة) مع زرَّي «نعم، أنا جاهز» و«لا أرغب حالياً» — وتصل إجابته كرسالة في محادثة واتساب.',
    settingsLabel: 'التحقق من جاهزية المتقدم (التنقيب)',
    settingsHint: 'لمخاطبة من سجّل سابقاً عند البحث عن مرشح مناسب — يحمل زرَّي رد سريع',
    fields: ['city'],
    noteLabel: 'التحقق من الجاهزية',
  },
};

// وصف الحقول التي يعبّئها الموظف — مصدر التعبئة المسبقة واسم الحقل في الواجهة
const FIELDS = {
  job:     { label: 'الوظيفة', max: 100, placeholder: 'حارس أمن' },
  project: { label: 'المشروع', max: 100, placeholder: 'اسم المشروع' },
  region:  { label: 'المنطقة', max: 60,  placeholder: 'المنطقة' },
  city:    { label: 'المدينة', max: 60,  placeholder: 'المدينة' },
};

const keys = () => Object.keys(TEMPLATES);
const get  = (k) => TEMPLATES[k] || null;

/** القوالب الجاهزة للاستخدام: Chatwoot مهيأ + اسم القالب محفوظ في الإعدادات */
function available(settings, chatwootReady) {
  if (!chatwootReady) return [];
  return keys()
    .filter(k => String(settings[`wa_tpl_${k}_name`] || '').trim())
    .map(k => TEMPLATES[k]);
}

module.exports = { TEMPLATES, FIELDS, keys, get, available };
