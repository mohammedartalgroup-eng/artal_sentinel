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

// تطبيع عام قبل أي بحث: أرقام لاتينية، مسافات موحّدة، تشكيل محذوف.
function normalizeText(s) {
  return normalizeDigits(s)
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
      { key: 'id_number',   label: 'رقم الهوية / الإقامة', type: 'saudi_id', required: true },
      { key: 'name_ar',     label: 'الاسم كما في المستند',  type: 'name',     required: true },
      { key: 'nationality', label: 'الجنسية',               type: 'text',     required: false },
      { key: 'birth_date',  label: 'تاريخ الميلاد',         type: 'date',     required: false },
      { key: 'expiry_date', label: 'تاريخ الانتهاء',        type: 'date',     required: true },
    ],
    // كلمات تُثبت أن المستند من النوع المتوقَّع (ولو واحدة كفت)
    markers: ['هوية', 'الهوية الوطنية', 'إقامة', 'اقامة', 'رخصة إقامة', 'IDENTITY', 'RESIDENT', 'RESIDENCE'],
  },

  national_address: {
    label: 'العنوان الوطني',
    icon: 'home_pin',
    hint: 'ارفع صورة شهادة العنوان الوطني من تطبيق سبل أو أبشر.',
    fields: [
      { key: 'short_address',     label: 'الرمز المختصر',  type: 'short_address', required: true },
      { key: 'building_number',   label: 'رقم المبنى',     type: 'digits4',       required: true },
      { key: 'street',            label: 'الشارع',         type: 'text',          required: false },
      { key: 'district',          label: 'الحي',           type: 'text',          required: true },
      { key: 'city',              label: 'المدينة',        type: 'text',          required: true },
      { key: 'postal_code',       label: 'الرمز البريدي',  type: 'digits5',       required: true },
      { key: 'additional_number', label: 'الرقم الإضافي',  type: 'digits4',       required: false },
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
      { key: 'license_number', label: 'رقم الرخصة',     type: 'digits10', required: true },
      { key: 'expiry_date',    label: 'تاريخ الانتهاء', type: 'date',     required: true },
      { key: 'name_ar',        label: 'الاسم',          type: 'name',     required: false },
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
    put('nationality', afterLabel(lines, ['الجنسية', 'NATIONALITY'], { maxLen: 30 }), 0.85);
    put('expiry_date', afterLabel(lines, ['تاريخ الانتهاء', 'الانتهاء', 'EXPIRY', 'EXPIRES']), 0.85);
    put('birth_date', afterLabel(lines, ['تاريخ الميلاد', 'الميلاد', 'DATE OF BIRTH', 'BIRTH']), 0.85);
  }

  if (docType === 'national_address') {
    const sa = upper.match(/\b[A-Z]{4}\s?\d{4}\b/);
    put('short_address', sa && sa[0], 0.95);
    put('building_number', afterLabel(lines, ['رقم المبنى', 'BUILDING NO', 'BUILDING NUMBER']), 0.9);
    put('additional_number', afterLabel(lines, ['الرقم الإضافي', 'ADDITIONAL NO', 'ADDITIONAL NUMBER']), 0.9);
    put('postal_code', afterLabel(lines, ['الرمز البريدي', 'POSTAL CODE', 'ZIP']), 0.9);
    put('district', afterLabel(lines, ['الحي', 'DISTRICT'], { maxLen: 40 }), 0.85);
    put('city', afterLabel(lines, ['المدينة', 'CITY'], { maxLen: 40 }), 0.85);
    put('street', afterLabel(lines, ['الشارع', 'STREET'], { maxLen: 60 }), 0.8);
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
    put('license_number', cands.find(saudiIdValid) || cands[0] || afterLabel(lines, ['رقم الرخصة', 'LICENSE NO', 'LICENCE NO']), 0.9);
    put('expiry_date', afterLabel(lines, ['تاريخ الانتهاء', 'الانتهاء', 'EXPIRY', 'EXPIRES']), 0.85);
    put('name_ar', afterLabel(lines, ['الاسم', 'NAME']), 0.8);
  }

  if (lines.length < 3) warnings.push('نص المستند غير واضح — قد تحتاج صورة أوضح.');
  if (typeMatch === 'no') {
    warnings.push(`يبدو أن الصورة ليست ${DOC_TYPES[docType].label} — ربما ${DOC_TYPES[otherHit[0]].label}.`);
  }

  return { fields: out, warnings, typeMatch };
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

module.exports = {
  DOC_TYPES, DOC_KEYS, fieldDef,
  normalizeDigits, normalizeText, digitsOnlyFix, normalizeDate, hijriToGregorian,
  saudiIdValid, ibanValid,
  parse, validate, needsAi, missingRequired, reviewLevel,
};
