/**
 * docRules.js — قواعد المستندات: التطبيع، الاستخراج، والتحقق المحلي.
 *
 * هذا هو «الجزء الرخيص» في المعادلة: كل ما يستطيع الكود إثباته بنفسه لا
 * يُرسَل إلى نموذج ذكاء اصطناعي إطلاقاً. رقم هوية من عشرة أرقام يمرّ بـ
 * checksum، وIBAN يمرّ بـ mod-97 — هذه حقائق حسابية، والسؤال عنها نموذجاً
 * لغوياً هو دفع مقابل تخمين بدل يقين.
 *
 * صفر اعتماديات — regex وحساب فقط (نفس نهج utils/google.js).
 */

// ─── تطبيع النص ──────────────────────────────────────────────────────────────

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

// الأرقام العربية-الهندية والفارسية → لاتينية. Google Vision يرجعها كما هي
// في المستندات السعودية، وكل تحقق حسابي بعدها يفشل بلا هذا السطر.
function normalizeDigits(s) {
  return String(s == null ? '' : s).replace(/[٠-٩۰-۹]/g, ch => {
    const i = AR_DIGITS.indexOf(ch);
    return String(i >= 0 ? i : FA_DIGITS.indexOf(ch));
  });
}

/**
 * فكّ «الخانات»: النماذج الرسمية السعودية تطبع كل حرف/رقم في مربع مستقل
 * (العنوان الوطني، رقم الهوية في إثبات العنوان)، فيقرؤها OCR رموزاً متفرقة:
 *
 *    F J S G 4 5 3 3   →   FJSG4533
 *    3 6 3 6 9         →   36369
 *
 * بلا هذه الخطوة يلتقط أي مستخرج الحرف الأول ويظنّه القيمة كاملة — وهو ما كان
 * يحدث فعلاً. تُطبَّق قبل القواعد وقبل إرسال النص إلى النموذج اللغوي معاً.
 *
 * الشرط: ثلاثة رموز مفردة متتالية فأكثر — اثنان قد يكونان اختصاراً حقيقياً،
 * والكلمات العادية أطول من حرف واحد فلا تتأثر.
 */
function debox(input) {
  const isSingle = (t) => /^[A-Za-z0-9\u0660-\u0669]$/.test(t);

  // (أ) أسطر من رمز واحد متتالية → سطر واحد (خانات مرصوصة عمودياً)
  const merged = [];
  let run = [];
  const flushLines = () => {
    if (run.length >= 3) merged.push(run.join(''));
    else merged.push(...run);
    run = [];
  };
  for (const ln of String(input == null ? '' : input).split(/\r?\n/)) {
    const t = ln.trim();
    if (isSingle(t)) run.push(t);
    else { flushLines(); merged.push(ln); }
  }
  flushLines();

  // (ب) داخل السطر: سلسلة رموز مفردة مفصولة بمسافات → كلمة واحدة
  return merged.map(ln => {
    const out = [];
    let buf = [];
    const flush = () => {
      if (buf.length >= 3) out.push(buf.join(''));
      else out.push(...buf);
      buf = [];
    };
    for (const tok of ln.split(/\s+/)) {
      if (isSingle(tok)) buf.push(tok);
      else { flush(); out.push(tok); }
    }
    flush();
    return out.join(' ').trim();
  }).join('\n');
}

// تطبيع عام قبل أي بحث: فكّ الخانات، أرقام لاتينية، مسافات موحّدة، تشكيل محذوف.
function normalizeText(s) {
  return debox(normalizeDigits(s))
    .replace(/[ً-ْـ]/g, '')     // تشكيل وتطويل
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ');
}

// خلط OCR الشائع داخل سياق رقمي بحت: O↔0 و I/l↔1 و S↔5 و B↔8.
// ⚠️ تُستدعى فقط على حقل نعرف أنه أرقام — تطبيقها على نص عام يفسد الأسماء.
function digitsOnlyFix(s) {
  return normalizeDigits(s)
    .replace(/[OoQ]/g, '0')
    .replace(/[IilL|]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8')
    .replace(/\D/g, '');
}

// ─── مدقّقات حسابية ──────────────────────────────────────────────────────────

// رقم الهوية/الإقامة السعودي — Luhn على عشرة أرقام.
// الخانة الأولى: 1 = مواطن، 2 = مقيم. أي بداية أخرى ليست رقم هوية.
function saudiIdValid(v) {
  const d = normalizeDigits(v).replace(/\D/g, '');
  if (!/^[12]\d{9}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const n = Number(d[i]);
    if (i % 2 === 0) {
      const x = n * 2;
      sum += Math.floor(x / 10) + (x % 10);
    } else {
      sum += n;
    }
  }
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

// IBAN — mod-97 (ISO 13616). السعودي: SA + خانتا تحقق + 22 = 24 خانة.
function ibanValid(v) {
  const s = normalizeDigits(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^SA\d{22}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const val = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const dch of val) rem = (rem * 10 + Number(dch)) % 97;
  }
  return rem === 1;
}

// ─── التواريخ ────────────────────────────────────────────────────────────────

// هجري → ميلادي عبر تقويم أم القرى المدمج في Node (ICU كامل منذ v14).
// لماذا بحث بدل معادلة؟ لأن أم القرى جدول رصد لا صيغة رياضية — نقدّر اليوم
// تقريبياً ثم نمسح ±5 أيام حتى يطابق التنسيق العكسي. دقيق وبلا اعتمادية.
function hijriToGregorian(hy, hm, hd) {
  try {
    const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
      timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
    });
    const approx = Math.round((hy - 1) * 354.367 + (hm - 1) * 29.53 + hd);
    const base = Date.UTC(622, 6, 19) + approx * 86400000;
    for (let off = -5; off <= 5; off++) {
      const d = new Date(base + off * 86400000);
      const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
      if (Number(p.year) === hy && Number(p.month) === hm && Number(p.day) === hd) {
        return d.toISOString().slice(0, 10);
      }
    }
  } catch (e) { /* ICU ناقص — نُبقي القيمة الخام */ }
  return null;
}

// أي صيغة تاريخ شائعة → YYYY-MM-DD ميلادي. سنة 13xx/14xx/15xx = هجري.
function normalizeDate(raw) {
  const s = normalizeDigits(raw).trim();
  const m = s.match(/(\d{1,4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,4})/);
  if (!m) return null;
  let a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
  let y, mo, d;
  if (String(m[1]).length === 4) { y = a; mo = b; d = c; }      // YYYY/MM/DD
  else { d = a; mo = b; y = c; }                                 // DD/MM/YYYY
  if (mo > 12 && d <= 12) { const t = mo; mo = d; d = t; }       // تبديل حذر
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  if (y >= 1300 && y <= 1600) return hijriToGregorian(y, mo, d);
  if (y >= 1900 && y <= 2100) {
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

// ─── تعريف المستندات ─────────────────────────────────────────────────────────
// الترتيب مقصود: الهوية أولاً لأن منها تبدأ الهوية القانونية للشخص، ثم العنوان
// والحساب البنكي، والرخصة أخيراً لأنها مشروطة بالوظيفة لا بالشخص.

const DOC_TYPES = {
  id_iqama: {
    label: 'الهوية / الإقامة',
    icon: 'badge',
    hint: 'صوّر وجه الهوية الوطنية أو الإقامة كاملاً — بلا انعكاس ضوء ولا أطراف مقطوعة.',
    fields: [
      { key: 'id_number',   label: 'رقم الهوية / الإقامة', type: 'saudi_id', required: true, cross: 'person_id' },
      { key: 'name_ar',     label: 'الاسم بالعربية',        type: 'name',     required: true, cross: 'name_ar' },
      // aiAssist: حقل غير مطلوب لكنه يستحق نداء النموذج إن عجزت القواعد عنه.
      // الاسم الإنجليزي يُطبع بتخطيط حرّ على البطاقة (سطر، فاصلة، حرف أوسط)،
      // فالتقاطه بقاعدة وحدها يفشل أحياناً — وتركه فارغاً يعني إدخالاً يدوياً.
      { key: 'name_en',     label: 'الاسم بالإنجليزية',     type: 'name_en',  required: false, aiAssist: true, cross: 'name_en' },
      { key: 'nationality', label: 'الجنسية',               type: 'text',     required: false },
      { key: 'birth_date',  label: 'تاريخ الميلاد',         type: 'date',     required: false, cross: 'birth_date' },
      { key: 'expiry_date', label: 'تاريخ الانتهاء',        type: 'date',     required: true },
    ],
    // كلمات تُثبت أن المستند من النوع المتوقَّع (ولو واحدة كفت)
    markers: ['هوية', 'الهوية الوطنية', 'إقامة', 'اقامة', 'رخصة إقامة', 'IDENTITY', 'RESIDENT', 'RESIDENCE'],
  },

  national_address: {
    label: 'العنوان الوطني',
    icon: 'home_pin',
    hint: 'ارفع صورة شهادة العنوان الوطني من تطبيق سبل أو أبشر.',
    // نموذج بخانات وعمودين لغويين: نصّ OCR منه مبعثر الترتيب بطبيعته، فلا
    // معنى لإنفاق نداء نموذج نصي على مُدخَل فاسد — نقفز إلى قراءة الصورة.
    visionFirst: true,
    fields: [
      // رقم الهوية مطبوع على الشهادة — نستخرجه لا لعرضه بل لإثبات أن العنوان لصاحب الملف
      { key: 'id_number',         label: 'رقم الهوية في الشهادة', type: 'saudi_id',      required: false, cross: 'person_id' },
      { key: 'short_address',     label: 'الرمز المختصر',         type: 'short_address', required: true },
      { key: 'building_number',   label: 'رقم المبنى',            type: 'digits4',       required: true },
      { key: 'street',            label: 'الشارع',                type: 'place',         required: false, aiAssist: true },
      { key: 'district',          label: 'الحي',                  type: 'place',         required: true },
      { key: 'city',              label: 'المدينة',               type: 'place',         required: true },
      { key: 'postal_code',       label: 'الرمز البريدي',         type: 'digits5',       required: true },
      // النموذج الرسمي يسمّيه «الرقم الفرعي / Secondary No.» لا «الإضافي»
      { key: 'additional_number', label: 'الرقم الفرعي',          type: 'digits4',       required: false, aiAssist: true },
    ],
    markers: ['العنوان الوطني', 'الرمز المختصر', 'الرقم الإضافي', 'NATIONAL ADDRESS', 'SHORT ADDRESS', 'ADDITIONAL NO'],
  },

  iban: {
    label: 'شهادة الآيبان',
    icon: 'account_balance',
    hint: 'ارفع شهادة الآيبان أو تعريف الحساب من تطبيق البنك — لا لقطة تحويل.',
    fields: [
      { key: 'iban',           label: 'رقم الآيبان',     type: 'iban', required: true },
      { key: 'bank_name',      label: 'البنك',           type: 'text', required: false },
      { key: 'account_holder', label: 'اسم صاحب الحساب', type: 'name', required: false },
    ],
    markers: ['ايبان', 'آيبان', 'IBAN', 'تعريف بالحساب', 'شهادة الحساب', 'ACCOUNT CERTIFICATE'],
  },

  driving_license: {
    label: 'رخصة القيادة',
    icon: 'directions_car',
    hint: 'صوّر وجه رخصة القيادة كاملاً.',
    fields: [
      // رقم الرخصة في السعودية هو رقم الهوية نفسه — ولهذا يُقارَن به (cross)
      { key: 'license_number', label: 'رقم الرخصة',        type: 'digits10', required: true,  cross: 'person_id' },
      { key: 'expiry_date',    label: 'تاريخ الانتهاء',    type: 'date',     required: true },
      { key: 'blood_type',     label: 'فصيلة الدم',        type: 'blood',    required: false, aiAssist: true },
      { key: 'birth_date',     label: 'تاريخ الميلاد',     type: 'date',     required: false, aiAssist: true, cross: 'birth_date' },
      { key: 'name_ar',        label: 'الاسم بالعربية',    type: 'name',     required: false, aiAssist: true, cross: 'name_ar' },
      { key: 'name_en',        label: 'الاسم بالإنجليزية', type: 'name_en',  required: false, aiAssist: true, cross: 'name_en' },
    ],
    markers: ['رخصة قيادة', 'رخصة القيادة', 'DRIVING LICENSE', 'DRIVING LICENCE', 'DRIVER LICENSE'],
  },
};

const DOC_KEYS = Object.keys(DOC_TYPES);

function fieldDef(docType, key) {
  return (DOC_TYPES[docType]?.fields || []).find(f => f.key === key) || null;
}

// ─── التحقق من قيمة حقل واحد ────────────────────────────────────────────────
// يرجع القيمة المُطبَّعة لا القيمة كما كُتبت: «SA03 8000 0000 6080» تُحفظ بلا
// مسافات، والتاريخ يُحفظ ISO — الواجهة تعرض الجميل، وقاعدة البيانات تخزّن الدقيق.

function validate(docType, key, raw) {
  const def = fieldDef(docType, key);
  if (!def) return { ok: false, value: null, error: 'حقل غير معروف' };

  const s = normalizeText(raw).trim();
  if (!s) {
    return def.required
      ? { ok: false, value: '', error: 'هذا الحقل مطلوب' }
      : { ok: true, value: '', error: null };
  }

  switch (def.type) {
    case 'saudi_id': {
      const d = digitsOnlyFix(s);
      if (d.length !== 10) return { ok: false, value: d, error: 'رقم الهوية يجب أن يكون 10 أرقام' };
      if (!/^[12]/.test(d))  return { ok: false, value: d, error: 'يبدأ رقم الهوية بـ 1 أو الإقامة بـ 2' };
      if (!saudiIdValid(d))  return { ok: false, value: d, error: 'رقم الهوية غير صحيح — راجع الأرقام' };
      return { ok: true, value: d, error: null };
    }
    case 'iban': {
      const v = normalizeDigits(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!/^SA/.test(v))        return { ok: false, value: v, error: 'الآيبان السعودي يبدأ بـ SA' };
      if (v.length !== 24)       return { ok: false, value: v, error: 'الآيبان يجب أن يكون 24 خانة' };
      if (!ibanValid(v))         return { ok: false, value: v, error: 'رقم الآيبان غير صحيح — راجع الأرقام' };
      return { ok: true, value: v, error: null };
    }
    case 'short_address': {
      const v = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!/^[A-Z]{4}\d{4}$/.test(v)) {
        return { ok: false, value: v, error: 'الرمز المختصر = 4 أحرف إنجليزية + 4 أرقام' };
      }
      return { ok: true, value: v, error: null };
    }
    case 'digits4':
    case 'digits5':
    case 'digits10': {
      const n = { digits4: 4, digits5: 5, digits10: 10 }[def.type];
      const d = digitsOnlyFix(s);
      if (d.length !== n) return { ok: false, value: d, error: `يجب أن يكون ${n} أرقام` };
      return { ok: true, value: d, error: null };
    }
    case 'date': {
      const iso = normalizeDate(s);
      if (!iso) return { ok: false, value: s, error: 'تاريخ غير مفهوم — استخدم يوم/شهر/سنة' };
      return { ok: true, value: iso, error: null };
    }
    case 'name': {
      const v = s.replace(/\s+/g, ' ').trim();
      if (v.length < 4) return { ok: false, value: v, error: 'الاسم قصير جداً' };
      return { ok: true, value: v, error: null };
    }
    case 'blood': {
      // OCR يخلط 8/B و0/O في رمز قصير كهذا — والسياق يجعل التصحيح آمناً
      const v = s.toUpperCase().replace(/\s+/g, '')
        .replace(/POSITIVE|POS/g, '+').replace(/NEGATIVE|NEG/g, '-')
        .replace(/8/g, 'B').replace(/0/g, 'O')
        .replace(/[^ABO+\-]/g, '');
      const m = v.match(/^(AB|A|B|O)([+\-])$/);
      if (!m) return { ok: false, value: v, error: 'فصيلة غير صالحة — مثل O+ أو AB-' };
      return { ok: true, value: m[1] + m[2], error: null };
    }
    case 'place': {
      // الحي في نموذج العنوان يلتصق به الرقم الفرعي أحياناً («Al Munaizlah 7927»)،
      // والحرف الواحد ليس اسم شارع — رفضه يفتح الباب للنموذج اللغوي أو للمرشح.
      const v = s.replace(/\s+/g, ' ').trim().replace(/[\s،,-]*\d[\d\s]*$/, '').trim();
      if (v.length < 3) return { ok: false, value: v, error: 'قيمة غير مفهومة — اكتبها يدوياً' };
      return { ok: true, value: v.slice(0, 120), error: null };
    }
    case 'name_en': {
      // حروف لاتينية فقط — الاسم الإنجليزي على الهوية يُكتب بفاصلة وحرف أوسط
      // (ALRUWAILI, SAUD ZAKI S) فنسمح بالفاصلة والنقطة والشرطة.
      const v = s.replace(/\s+/g, ' ').trim().replace(/[^A-Za-z ,.'-]/g, '').trim();
      if (v.length < 4) return { ok: false, value: v, error: 'الاسم الإنجليزي قصير جداً' };
      if (!/[A-Za-z]{2}/.test(v)) return { ok: false, value: v, error: 'يجب أن يكون بحروف إنجليزية' };
      return { ok: true, value: v, error: null };
    }
    default: {
      const v = s.replace(/\s+/g, ' ').trim();
      return { ok: true, value: v.slice(0, 200), error: null };
    }
  }
}

// ─── الاستخراج من نص OCR ─────────────────────────────────────────────────────
// الاستراتيجية: التقاط ما لا يحتمل اللبس (نمط حسابي فريد) ثم ما بعد تسمية
// صريحة. ما لا يُلتقط هنا يذهب إلى الذكاء الاصطناعي — لا تُخمّن القواعد أبداً.

const BANKS = [
  'مصرف الراجحي', 'الراجحي', 'البنك الأهلي السعودي', 'البنك الأهلي', 'الأهلي',
  'بنك الرياض', 'مصرف الإنماء', 'الإنماء', 'بنك البلاد', 'البلاد',
  'البنك السعودي الفرنسي', 'البنك العربي الوطني', 'البنك السعودي للاستثمار',
  'بنك الجزيرة', 'ساب', 'بنك ساب', 'سامبا', 'بنك الخليج الدولي', 'بنك الإمارات',
  'Al Rajhi', 'Alrajhi', 'Riyad Bank', 'Alinma', 'Albilad', 'SABB', 'SNB', 'ANB', 'BSF', 'Saudi National Bank',
];

// السطر الذي يلي تسمية معروفة (أو ما بعدها على نفس السطر)
function afterLabel(lines, labels, { maxLen = 80 } = {}) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const lab of labels) {
      const idx = line.toUpperCase().indexOf(lab.toUpperCase());
      if (idx === -1) continue;
      const tail = line.slice(idx + lab.length).replace(/^[\s:：.\-–]+/, '').trim();
      if (tail && tail.length <= maxLen) return tail;
      const next = (lines[i + 1] || '').trim();
      if (next && next.length <= maxLen) return next;
    }
  }
  return null;
}

// هل يحمل هذا النص تاريخاً ميلادياً؟ (سنة بين 1900 و2100)
function isGregorianToken(t) {
  return (normalizeDigits(t).match(/\d{4}/g) || []).some(y => +y >= 1900 && +y <= 2100);
}

const DATE_RE = /\d{1,4}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{1,4}/g;

/**
 * تاريخ من منطقة التسمية — والميلادي يفوز على الهجري دائماً.
 *
 * ⚠️ لماذا؟ الهوية السعودية تطبع التاريخين معاً، وتحويلنا للهجري بجدول أم
 *    القرى قد يخالف تحويل الأحوال المدنية بيوم أو أربعة. ما دام الميلادي
 *    مطبوعاً على البطاقة فهو الحقيقة، ولا معنى لأن نحسب ما هو مكتوب أمامنا.
 */
function pickDate(lines, labels) {
  const zones = [];
  for (const lab of labels) {
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].toUpperCase().indexOf(lab.toUpperCase());
      if (idx === -1) continue;
      zones.push([lines[i].slice(idx + lab.length), lines[i + 1] || '', lines[i + 2] || ''].join(' '));
    }
  }
  const all = zones.flatMap(z => z.match(DATE_RE) || []);
  return all.find(isGregorianToken) || all[0] || null;
}

// سطور «ليست اسماً» على وجه الهوية/الإقامة — تُستبعد قبل التقاط الاسم اللاتيني
const EN_STOP = [
  'KINGDOM', 'SAUDI', 'ARABIA', 'IDENTITY', 'NATIONAL', 'CARD', 'RESIDENT', 'RESIDENCE',
  'PERMIT', 'MINISTRY', 'INTERIOR', 'DATE', 'BIRTH', 'EXPIRY', 'EXPIRES', 'ISSUE',
  'NATIONALITY', 'OCCUPATION', 'SEX', 'MALE', 'FEMALE', 'PLACE', 'NUMBER', 'SERIAL',
];

/** الاسم اللاتيني: أطول سطر لاتيني خالٍ من الأرقام وكلمات الترويسة */
function pickLatinName(lines) {
  const cands = lines
    .map(l => l.replace(/[^A-Za-z ,.'-]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(l => l.length >= 6 && l.length <= 60)
    .filter(l => (l.match(/[A-Za-z]/g) || []).length >= 5)
    .filter(l => !EN_STOP.some(w => l.toUpperCase().includes(w)))
    .filter(l => (l.match(/ /g) || []).length >= 1);   // اسم من كلمتين فأكثر
  return cands.sort((a, b) => b.length - a.length)[0] || null;
}

const AR_STOP = [
  'المملكة', 'العربية', 'السعودية', 'الهوية', 'الوطنية', 'الإقامة', 'اقامة', 'رخصة',
  'تاريخ', 'الميلاد', 'الانتهاء', 'الرقم', 'مكان', 'الجنسية', 'وزارة', 'الداخلية',
  'الأحوال', 'المدنية', 'بطاقة', 'صالحة', 'المهنة', 'الصلاحية',
];

/** اسم عربي بلا تسمية — أطول سطر عربي ليس من كلمات الترويسة */
function pickArabicName(lines) {
  const cands = lines
    .filter(l => (l.match(/[ء-ي]/g) || []).length >= 6)
    .filter(l => !/\d/.test(l))
    .filter(l => !AR_STOP.some(w => l.includes(w)))
    .filter(l => (l.match(/ /g) || []).length >= 1)
    .map(l => l.trim());
  return cands.sort((a, b) => b.length - a.length)[0] || null;
}

/**
 * الجنسية المشتقة من رقم الهوية: الخانة الأولى 1 = مواطن سعودي.
 * بطاقة الهوية الوطنية لا تحمل حقل «الجنسية» أصلاً، فالاشتقاق هنا ليس تخميناً
 * بل قراءة لما يعنيه الرقم نفسه. الإقامة (2) تُترك لما هو مكتوب عليها.
 */
function nationalityFromId(idValue) {
  const d = normalizeDigits(idValue || '').replace(/\D/g, '');
  return /^1\d{9}$/.test(d) && saudiIdValid(d) ? 'سعودي' : null;
}

// سطور هي «تسميات» لا قيم — النماذج الرسمية ثنائية اللغة تطبع التسمية مرتين
// (عربي ثم إنجليزي) قبل القيمة، فأخذُ السطر التالي أعمى يلتقط «Building No.»
// ويحوّلها digitsOnlyFix إلى رقم وهمي. هذه القائمة تمنع ذلك.
const LABEL_LINES = [
  'building no', 'building number', 'street', 'district', 'city', 'postal code', 'zip',
  'secondary no', 'secondary number', 'additional no', 'additional number', 'short address',
  'name', 'id no', 'id number', 'reg date', 'address details', 'address holder details',
  'proof number', 'original date', 'expiration date', 'national address', 'address proof',
  'kingdom of saudi arabia', 'date of birth', 'dob', 'doe', 'expiry date', 'nationality',
  'sex', 'occupation', 'to verify', 'iban', 'account name', 'customer name',
  'الشارع', 'الحي', 'المدينة', 'الرمز البريدي', 'الرمزي البريدي', 'رقم المبنى', 'الرقم الفرعي',
  'الرقم الاضافي', 'الرقم الإضافي', 'العنوان المختصر', 'الاسم', 'رقم الهوية', 'رقم الاقامة',
  'رقم الإقامة', 'تاريخ التسجيل', 'تفاصيل العنوان', 'بيانات صاحب العنوان', 'العنوان الوطني',
  'اثبات عنوان', 'إثبات عنوان', 'المملكة العربية السعودية', 'رقم الاثبات', 'رقم الإثبات',
  'تاريخ الاصدار', 'تاريخ الإصدار', 'تاريخ الانتهاء', 'الجنسية', 'تاريخ الميلاد', 'مكان الميلاد',
  'الرقم', 'للتحقق', 'وزارة الداخلية', 'الهوية الوطنية',
];

const cleanKey = (t) => String(t == null ? '' : t)
  .toLowerCase().replace(/[.:：\-–_,]/g, '').replace(/\s+/g, ' ').trim();

function isLabelLine(t) {
  const k = cleanKey(t);
  return !k || LABEL_LINES.some(l => k === cleanKey(l));
}

const hasArabic = (t) => /[\u0600-\u06FF]/.test(String(t || ''));

/**
 * قيمة حقل من منطقة التسمية — تتخطّى سطور التسميات وتفحص عدة سطور بعدها.
 *
 * @param {number} opts.digits  عدد الأرقام المتوقَّع بالضبط (0 = حقل نصي)
 * @param {boolean} opts.preferArabic  النسخة العربية أفيد لفريق عربي حين تتوفر الاثنتان
 */
function pickValue(lines, labels, { digits = 0, min = 3, lookahead = 3, preferArabic = false } = {}) {
  const cands = [];
  for (const lab of labels) {
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].toUpperCase().indexOf(lab.toUpperCase());
      if (idx === -1) continue;
      const tail = lines[i].slice(idx + lab.length).replace(/^[\s:：.\-–]+/, '').trim();
      if (tail) cands.push(tail);
      for (let k = 1; k <= lookahead; k++) if (lines[i + k]) cands.push(lines[i + k].trim());
    }
  }

  const ok = [];
  for (const c of cands) {
    if (isLabelLine(c)) continue;
    if (digits) {
      const d = normalizeDigits(c).replace(/\D/g, '');
      if (d.length === digits) ok.push(d);
      continue;
    }
    if (c.length >= min && c.length <= 120) ok.push(c);
  }
  if (!ok.length) return null;
  return (preferArabic && ok.find(hasArabic)) || ok[0];
}

function parse(docType, rawText) {
  const text = normalizeText(rawText || '');
  const upper = text.toUpperCase();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = {};
  const warnings = [];

  const put = (key, value, confidence = 0.9) => {
    if (value == null || value === '') return;
    if (out[key]) return;                       // أول التقاط يفوز (الأدق أولاً)
    const v = validate(docType, key, value);
    out[key] = { raw: String(value).trim(), value: v.value, valid: v.ok, error: v.error, confidence };
  };

  // للقيم المشتقة بيقين حسابي — تدهس ما التقطه النص لأنها ليست تخميناً
  const put2 = (key, value, confidence, source) => {
    const v = validate(docType, key, value);
    out[key] = { raw: String(value).trim(), value: v.value, valid: v.ok, error: v.error, confidence, source };
  };

  // هل المستند من النوع المتوقَّع؟
  const markers = DOC_TYPES[docType]?.markers || [];
  const hitMarker = markers.some(m => upper.includes(m.toUpperCase()));
  const otherHit = DOC_KEYS.filter(k => k !== docType)
    .filter(k => (DOC_TYPES[k].markers || []).some(m => upper.includes(m.toUpperCase())));
  let typeMatch = hitMarker ? 'yes' : (lines.length < 3 ? 'unknown' : (otherHit.length ? 'no' : 'unknown'));

  if (docType === 'id_iqama') {
    // رقم هوية صحيح checksum = يقين لا يحتاج تسمية
    const cands = (text.match(/\d[\d\s-]{8,14}\d/g) || [])
      .map(x => x.replace(/\D/g, '')).filter(x => x.length === 10);
    put('id_number', cands.find(saudiIdValid) || afterLabel(lines, ['رقم الهوية', 'رقم الإقامة', 'ID NUMBER', 'IQAMA']), 0.97);
    put('name_ar', afterLabel(lines, ['الاسم', 'اسم', 'NAME']), 0.8);
    put('name_ar', pickArabicName(lines), 0.7);      // احتياط: مستند بلا تسمية
    put('name_en', pickLatinName(lines), 0.85);
    put('nationality', afterLabel(lines, ['الجنسية', 'NATIONALITY'], { maxLen: 30 }), 0.85);
    // التسميات اللاتينية أولاً: DOB/DOE تحملان الميلادي على الهوية السعودية
    put('expiry_date', pickDate(lines, ['DOE', 'EXPIRY', 'EXPIRES', 'تاريخ الانتهاء', 'الانتهاء']), 0.9);
    put('birth_date',  pickDate(lines, ['DOB', 'DATE OF BIRTH', 'BIRTH', 'تاريخ الميلاد', 'الميلاد']), 0.9);
    // الجنسية من الرقم — تُكتب فقط إن لم يجدها الاستخراج على المستند
    const natFromId = nationalityFromId(out.id_number?.value);
    if (natFromId && !out.nationality?.valid) put2('nationality', natFromId, 1, 'rule');
  }

  if (docType === 'national_address') {
    const sa = upper.match(/\b[A-Z]{4}\s?\d{4}\b/);
    put('short_address', sa && sa[0], 0.95);
    put('short_address', pickValue(lines, ['العنوان المختصر', 'SHORT ADDRESS'], { min: 8 }), 0.9);
    put('building_number',   pickValue(lines, ['رقم المبنى', 'BUILDING NO', 'BUILDING NUMBER'], { digits: 4 }), 0.9);
    put('additional_number', pickValue(lines, ['الرقم الفرعي', 'الرقم الإضافي', 'SECONDARY NO', 'SECONDARY NUMBER', 'ADDITIONAL NO', 'ADDITIONAL NUMBER'], { digits: 4 }), 0.9);
    put('postal_code',       pickValue(lines, ['الرمز البريدي', 'الرمزي البريدي', 'POSTAL CODE', 'ZIP'], { digits: 5 }), 0.9);
    put('district', pickValue(lines, ['الحي', 'DISTRICT'], { preferArabic: true }), 0.85);
    put('city',     pickValue(lines, ['المدينة', 'CITY'],  { preferArabic: true }), 0.85);
    put('street',   pickValue(lines, ['الشارع', 'STREET'], { preferArabic: true }), 0.8);
  }

  if (docType === 'iban') {
    const m = upper.replace(/[^A-Z0-9\n]/g, ' ').match(/SA[\s]?(?:\d[\s]?){22}/);
    const cand = m && m[0].replace(/\s/g, '');
    put('iban', cand && ibanValid(cand) ? cand : (cand || afterLabel(lines, ['IBAN', 'الآيبان', 'ايبان'])), 0.97);
    const bank = BANKS.find(b => upper.includes(b.toUpperCase()));   // الشهادات تُطبع بأحرف كبيرة غالباً
    put('bank_name', bank, 0.9);
    put('account_holder', afterLabel(lines, ['اسم العميل', 'اسم صاحب الحساب', 'ACCOUNT NAME', 'CUSTOMER NAME']), 0.8);
  }

  if (docType === 'driving_license') {
    const cands = (text.match(/\d[\d\s-]{8,14}\d/g) || [])
      .map(x => x.replace(/\D/g, '')).filter(x => x.length === 10);
    put('license_number', cands.find(saudiIdValid) || cands[0] || pickValue(lines, ['رقم الرخصة', 'الرقم', 'LICENSE NO', 'LICENCE NO', 'NO.'], { digits: 10 }), 0.9);
    // التسميات اللاتينية أولاً (Exp/DOB تحملان الميلادي بجوار الهجري)
    put('expiry_date', pickDate(lines, ['EXP', 'EXPIRY', 'EXPIRES', 'تاريخ الانتهاء', 'الانتهاء']), 0.9);
    put('birth_date',  pickDate(lines, ['DOB', 'DATE OF BIRTH', 'تاريخ الميلاد', 'الميلاد']), 0.9);
    put('name_ar', afterLabel(lines, ['الاسم', 'NAME']), 0.8);
    put('name_ar', pickArabicName(lines), 0.7);
    put('name_en', pickLatinName(lines), 0.85);
    // فصيلة الدم: الرمز يسبق التسمية عادةً في التخطيط العربي («B+ فصيلة الدم»)،
    // فلا ينفع «السطر التالي». نلتقطه بنمطه من سطر التسمية نفسه، ثم من النص كله.
    // 8 و0 مقبولان لأن OCR يخلطهما بـ B وO في رمز من حرفين — والتحقق يصحّحهما.
    const bloodLine = lines.find(l => /(فصيلة|فصيله)\s*الدم|BLOOD/i.test(l));
    put('blood_type',
      (bloodLine && (bloodLine.match(/(AB|A|B|O|8|0)\s?[+\-]/i) || [])[0])
      || (text.match(/(?:^|\s)(AB|A|B|O)\s?[+\-](?=\s|$)/i) || [])[0], 0.9);
  }

  // شهادة العنوان الوطني لها صلاحية مطبوعة — المنتهية لا تصلح لملف موظف،
  // ولا نرفضها آلياً بل نرفعها إلى «يحتاج مراجعة» ليقرر فريق التوظيف.
  let expired = false;
  if (docType === 'national_address') {
    const raw = pickValue(lines, ['تاريخ الانتهاء', 'EXPIRATION DATE', 'EXPIRY DATE'], { min: 6 });
    const iso = raw && normalizeDate(raw);
    if (iso && iso < new Date().toISOString().slice(0, 10)) {
      expired = true;
      warnings.push(`شهادة العنوان منتهية الصلاحية (${iso}) — اطلب شهادة حديثة.`);
    }
  }

  if (lines.length < 3) warnings.push('نص المستند غير واضح — قد تحتاج صورة أوضح.');
  if (typeMatch === 'no') {
    warnings.push(`يبدو أن الصورة ليست ${DOC_TYPES[docType].label} — ربما ${DOC_TYPES[otherHit[0]].label}.`);
  }

  return { fields: out, warnings, typeMatch, expired };
}

// ─── بوابة الذكاء الاصطناعي ─────────────────────────────────────────────────
// لا يُستدعى النموذج إلا إذا بقي حقل مطلوب مفقوداً أو فاشل التحقق. صورة نظيفة
// من تطبيق البنك تمرّ بلا أي مكالمة خارجية — وهذا هو المقصود.

function missingRequired(docType, fields) {
  return (DOC_TYPES[docType]?.fields || [])
    .filter(f => f.required)
    .filter(f => !fields[f.key] || !fields[f.key].valid)
    .map(f => f.key);
}

function needsAi(docType, parsed) {
  return missingRequired(docType, parsed.fields).length > 0;
}

// أخضر / أصفر / أحمر — ثلاث حالات فقط. النِسَب المئوية للثقة معلومة تقنية
// تبقى في قاعدة البيانات ولا تُعرض للمرشح.
function reviewLevel(docType, fields, typeMatch) {
  if (typeMatch === 'no') return 'red';
  return missingRequired(docType, fields).length === 0 ? 'green' : 'yellow';
}

// ═══ المقارنة بين المستندات ═══════════════════════════════════════════════
//
// الهوية والرخصة وشهادة العنوان تحمل بيانات مشتركة (الرقم، الاسمان، الميلاد).
// اتفاقها تأكيدٌ مجاني على صحة القراءة، واختلافها إشارة إلى واحد من ثلاثة:
// خطأ قراءة، أو مستند لشخص آخر، أو بيانات قديمة. لا نرجّح بصمت في الحالتين
// الأخيرتين — نعرض الاختلاف ليقرّر إنسان.

const CROSS_LABELS = {
  person_id:  'رقم الهوية',
  name_ar:    'الاسم بالعربية',
  name_en:    'الاسم بالإنجليزية',
  birth_date: 'تاريخ الميلاد',
};

// ثقة المستند: الهوية هي المرجع، ثم الرخصة (تصدرها الداخلية أيضاً)، ثم غيرها.
const DOC_TRUST = { id_iqama: 30, driving_license: 20, national_address: 10, iban: 5 };
// ومصدر القيمة أهم من المستند: ما أكّده إنسان يسبق أي قراءة آلية.
const SOURCE_SCORE = { user: 100, ocr: 20, rule: 15, ai: 10 };

// تطبيع الأسماء للمقارنة وحدها — لا يُحفظ ولا يُعرض.
function nameKey(v) {
  return normalizeText(v).toLowerCase()
    .replace(/[أإآا]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

// تشابه بمجموعات الكلمات: OCR يسقط كلمة أو يقلب حرفاً، والاسم يبقى هو الاسم.
function nameSimilar(a, b) {
  const A = new Set(nameKey(a).split(' ').filter(w => w.length > 1));
  const B = new Set(nameKey(b).split(' ').filter(w => w.length > 1));
  if (!A.size || !B.size) return false;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(A.size, B.size) >= 0.6;
}

/**
 * يوحّد الحقول المشتركة عبر المستندات.
 * @param {Array} entries [{docType, key, value, source, confidence, userConfirmed}]
 * @returns [{cross, label, chosen, conflict, values[]}]
 */
function consolidate(entries) {
  const groups = {};
  for (const e of entries) {
    const def = fieldDef(e.docType, e.key);
    if (!def?.cross) continue;
    if (!String(e.value ?? '').trim()) continue;
    (groups[def.cross] ||= []).push({
      ...e,
      docLabel: DOC_TYPES[e.docType]?.label || e.docType,
      fieldLabel: def.label,
    });
  }

  return Object.entries(groups).map(([cross, vals]) => {
    const scored = vals
      .map(v => ({
        ...v,
        score: (SOURCE_SCORE[v.source] || 0)
             + (DOC_TRUST[v.docType] || 0)
             + (v.userConfirmed ? 50 : 0)
             + Number(v.confidence || 0),
      }))
      .sort((a, b) => b.score - a.score);

    const chosen = scored[0];
    const isName = cross === 'name_ar' || cross === 'name_en';
    const same = (v) => isName ? nameSimilar(v.value, chosen.value) : String(v.value) === String(chosen.value);
    const conflict = scored.length > 1 && scored.some(v => !same(v));

    return { cross, label: CROSS_LABELS[cross] || cross, chosen, conflict, values: scored };
  }).sort((a, b) => Number(b.conflict) - Number(a.conflict));
}

/**
 * حقول تُشتق تلقائياً بعد تغيّر حقل آخر (تعديل يدوي أو استخراج).
 * يُرجع [{key, value}] — والمُستدعي يقرّر متى يكتبها (لا يدهس قيمة كتبها المرشح).
 */
const DERIVES = { id_iqama: { id_number: ['nationality'] } };

/** ما الحقول التي «يملكها» هذا الحقل — ليعرف المُستدعي ما يجب تنظيفه إن بطل الاشتقاق */
function derivedKeys(docType, key) {
  return DERIVES[docType]?.[key] || [];
}

function derivedFrom(docType, key, value) {
  if (docType === 'id_iqama' && key === 'id_number') {
    const nat = nationalityFromId(value);
    if (nat) return [{ key: 'nationality', value: nat }];
  }
  return [];
}

module.exports = {
  DOC_TYPES, DOC_KEYS, fieldDef, derivedFrom, derivedKeys, nationalityFromId,
  normalizeDigits, normalizeText, debox, digitsOnlyFix, normalizeDate, hijriToGregorian,
  saudiIdValid, ibanValid,
  parse, validate, needsAi, missingRequired, reviewLevel,
  consolidate, nameSimilar, CROSS_LABELS,
};
