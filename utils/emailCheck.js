/**
 * emailCheck.js
 * كشف بسيط للأخطاء الشائعة في بريد المتقدم قبل أن يرتدّ البريد لاحقاً
 * بـ «Delivery Status Notification (Failure)»: gmal.com، hotmail.con، gmail.co …
 *
 * لا اتصال بالشبكة ولا ضمان لوجود الصندوق — مجرّد مقارنة النطاق بمزوّدين
 * معروفين. نطاق شركة غير معروف لا يُعلَّم؛ فقط ما يبدو خطأً إملائياً واضحاً.
 */

// الأكثر شيوعاً أولاً — عند التعادل في المسافة يفوز الأسبق في القائمة
const KNOWN = [
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com',
  'live.com', 'outlook.sa', 'msn.com', 'googlemail.com', 'ymail.com',
  'rocketmail.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com',
  'proton.me', 'mail.com', 'zoho.com', 'gmx.com', 'yandex.com', 'yandex.ru',
  'windowslive.com', 'hotmail.co.uk', 'yahoo.co.uk',
];
const KNOWN_SET = new Set(KNOWN);

// مزوّدون لهم نسخ إقليمية حقيقية (hotmail.fr, yahoo.co.in …) فلا نعلّمها
const REGIONAL = new Set(['hotmail', 'outlook', 'live', 'yahoo', 'msn']);

// امتدادات هي بوضوح خطأ في كتابة com
const TLD_TYPO = new Set(['con', 'cm', 'comm', 'om', 'vom', 'xom', 'cpm', 'ocm', 'coom', 'cim', 'cok', 'col', 'cmo', 'c', 'co']);

const SHAPE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

/** مسافة Damerau–Levenshtein (OSA): الإبدال بين حرفين متجاورين يُحسب خطأً واحداً */
function distance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i].concat(Array(n).fill(0)));
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** أقرب نطاق معروف للنطاق المكتوب، أو null إن لم يكن قريباً بما يكفي */
function closestKnown(domain) {
  const limit = domain.length >= 8 ? 2 : 1;
  let best = null, bestDist = Infinity;
  for (const k of KNOWN) {
    const dist = distance(domain, k);
    if (dist < bestDist) { best = k; bestDist = dist; }
  }
  return bestDist > 0 && bestDist <= limit ? best : null;
}

/**
 * @param {string} raw
 * @returns {{email:string, valid:boolean, warn:boolean, reason:string, suggestion:string}}
 */
function check(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const out = { email, valid: false, warn: false, reason: '', suggestion: '' };
  if (!email) return out;

  if (!SHAPE.test(email)) {
    out.warn = true;
    out.reason = 'صيغة البريد الإلكتروني غير صحيحة';
    return out;
  }
  out.valid = true;

  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (KNOWN_SET.has(domain)) return out;

  const dot = domain.indexOf('.');
  const name = domain.slice(0, dot);
  const tld = domain.slice(dot + 1);
  const flag = (suggestDomain) => {
    out.warn = true;
    out.suggestion = `${local}@${suggestDomain}`;
    out.reason = `يبدو أن النطاق «${domain}» خطأ إملائي`;
    return out;
  };

  // الاسم معروف والامتداد خطأ في كتابة com → مباشرة
  if (TLD_TYPO.has(tld)) {
    const fix = KNOWN.find(k => k.startsWith(name + '.')) || `${name}.com`;
    if (KNOWN_SET.has(fix)) return flag(fix);
  }

  // نسخة إقليمية حقيقية لمزوّد كبير (hotmail.fr, yahoo.co.in) — سليمة
  if (REGIONAL.has(name) && /^([a-z]{2}|(co|com|net|org)\.[a-z]{2})$/.test(tld)) return out;

  // اسم مزوّد معروف لكن بامتداد غريب (gmail.sa, icloud.co.uk) → النسخة المعروفة
  const byName = KNOWN.find(k => k.startsWith(name + '.'));
  if (byName) return flag(byName);

  // خطأ إملائي في اسم المزوّد نفسه (gmal, hotmal, outlok …)
  const near = closestKnown(domain);
  if (near) return flag(near);

  return out;
}

module.exports = { check, KNOWN };
