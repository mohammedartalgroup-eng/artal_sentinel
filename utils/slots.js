/**
 * slots.js
 * حساب المواعيد المتاحة — دوال نقية بلا قاعدة بيانات ولا شبكة (قابلة للاختبار بأي TZ للخادم).
 *
 * الرياض UTC+3 طوال العام (لا توقيت صيفي منذ 1990) ⇒ كل التحويلات حساب ثابت،
 * بلا مكتبة تواريخ وبلا اعتماد على ICU.
 * لو اعتُمد توقيت صيفي يوماً ما: تُستبدل localParts() وحدها بـ
 * Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Riyadh', ... }).formatToParts ولا يتغير شيء آخر.
 */

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const pad = n => String(n).padStart(2, '0');

// مكوّنات الوقت المحلي (الرياض) من طابع زمني UTC — dow: 0=الأحد … 6=السبت
function localParts(ms) {
  const d = new Date(ms + RIYADH_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay(),
  };
}
function fromLocal(y, mo, d, h = 0, mi = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, 0) - RIYADH_OFFSET_MS;
}
function localDate(ms)  { const p = localParts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; }
function localTime(ms)  { const p = localParts(ms); return `${pad(p.h)}:${pad(p.mi)}`; }
function localStamp(ms) { return `${localDate(ms)} ${localTime(ms)}`; }            // start_local
function slotKey(ms)    { return localStamp(ms).replace(/[-: ]/g, ''); }           // 'YYYYMMDDHHMM'
function keyToMs(key) {
  return fromLocal(+key.slice(0, 4), +key.slice(4, 6), +key.slice(6, 8), +key.slice(8, 10), +key.slice(10, 12));
}
// RFC3339 بإزاحة ثابتة — يقرؤه Google كما نقصده تماماً
function toRfc3339(ms) { return `${localDate(ms)}T${localTime(ms)}:00+03:00`; }

// أسماء عربية مكتوبة يدوياً — لا تعتمد على بناء ICU للخادم
const AR_DAYS   = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
function arabicDate(ms)      { const p = localParts(ms); return `${AR_DAYS[p.dow]} ${p.d} ${AR_MONTHS[p.mo - 1]} ${p.y}`; }
function arabicDateShort(ms) { const p = localParts(ms); return `${AR_DAYS[p.dow]} ${p.d}/${p.mo}`; }

// ─── قواعد المواعيد من جدول settings ─────────────────────────────────────────
const DURATIONS = [10, 15, 20, 30];
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// يحترم القيمة 0 الصريحة (بعكس ‎||‎ التي تعتبرها غائبة)
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

function parseHour(str, fallbackH, fallbackM) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
  if (!m) return { h: fallbackH, m: fallbackM };
  return { h: clamp(+m[1], 0, 23), m: clamp(+m[2], 0, 59) };
}

function parseRules(s = {}) {
  const duration = DURATIONS.includes(+s.interview_duration) ? +s.interview_duration : 15;
  const days = String(s.interview_work_days ?? '0,1,2,3,4,6')
    .split(',').map(x => parseInt(x, 10)).filter(n => n >= 0 && n <= 6);
  const start = parseHour(s.interview_start_hour, 9, 0);
  const end   = parseHour(s.interview_end_hour, 17, 0);
  return {
    durationMin: duration,
    workDays:    days.length ? [...new Set(days)] : [0, 1, 2, 3, 4, 6],
    startH: start.h, startM: start.m,
    endH:   end.h,   endM:   end.m,
    bufferMin:   clamp(num(s.interview_buffer, 0), 0, 60),
    leadMin:     clamp(num(s.interview_lead_min, 120), 0, 10080),
    horizonDays: clamp(num(s.interview_horizon_days, 14), 1, 60),
  };
}

// دمج الفترات المتداخلة/المتلاصقة
function mergeBusy(intervals) {
  const list = intervals
    .filter(b => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const b of list) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ start: b.start, end: b.end });
  }
  return out;
}

/**
 * @param {Object}   o
 * @param {number}   o.nowMs
 * @param {Object}   o.rules  ناتج parseRules
 * @param {{start:number,end:number}[]} o.busy  فترات مشغولة (UTC ms)
 * @param {string[]} [o.taken] مفاتيح مواعيد محجوزة عندنا (interviews.slot_key)
 * @returns {{date:string,label:string,labelShort:string,slots:{key:string,time:string,startMs:number,endMs:number}[]}[]}
 */
function computeSlots({ nowMs, rules, busy = [], taken = [] }) {
  // الفاصل خاصية الاجتماعات القائمة لا الشبكة: نُوسّع كل فترة انشغال من الطرفين
  const buf = rules.bufferMin * 60000;
  const blocked = mergeBusy(busy).map(b => ({ start: b.start - buf, end: b.end + buf }));

  const earliest = nowMs + rules.leadMin * 60000;
  const takenSet = new Set(taken);
  const durMs = rules.durationMin * 60000;

  const today = localParts(nowMs);
  const days = [];

  for (let i = 0; i < rules.horizonDays; i++) {
    const dayBase = fromLocal(today.y, today.mo, today.d) + i * 86400000;   // دقيق: لا توقيت صيفي
    const dp = localParts(dayBase);
    if (!rules.workDays.includes(dp.dow)) continue;

    const dayStart = dayBase + (rules.startH * 60 + rules.startM) * 60000;
    const dayEnd   = dayBase + (rules.endH   * 60 + rules.endM)   * 60000;

    const slots = [];
    for (let cur = dayStart; cur + durMs <= dayEnd; cur += durMs) {
      const end = cur + durMs;
      if (cur < earliest) continue;
      const key = slotKey(cur);
      if (takenSet.has(key)) continue;
      if (blocked.some(b => cur < b.end && end > b.start)) continue;
      slots.push({ key, time: localTime(cur), startMs: cur, endMs: end });
    }

    days.push({
      date: localDate(dayBase),
      label: arabicDate(dayBase),
      labelShort: arabicDateShort(dayBase),
      slots,
    });
  }
  return days;
}

// هل هذا الموعد صالح وفق القواعد؟ (إعادة تحقق من جهة الخادم — لا نثق بوقت العميل)
function validateSlot(startMs, rules, nowMs) {
  const p = localParts(startMs);
  if (!rules.workDays.includes(p.dow)) return 'الموعد في يوم عطلة';
  const dayBase = fromLocal(p.y, p.mo, p.d);
  const dayStart = dayBase + (rules.startH * 60 + rules.startM) * 60000;
  const dayEnd   = dayBase + (rules.endH   * 60 + rules.endM)   * 60000;
  const durMs = rules.durationMin * 60000;
  if (startMs < dayStart || startMs + durMs > dayEnd) return 'الموعد خارج ساعات العمل';
  if ((startMs - dayStart) % durMs !== 0) return 'الموعد لا يطابق شبكة المواعيد';
  if (startMs < nowMs + rules.leadMin * 60000) return 'لم يعد هذا الموعد متاحاً — اختر وقتاً لاحقاً';
  if (startMs > nowMs + rules.horizonDays * 86400000) return 'الموعد أبعد من المدى المسموح';
  return null;
}

module.exports = {
  RIYADH_OFFSET_MS, AR_DAYS, AR_MONTHS, DURATIONS,
  localParts, fromLocal, localDate, localTime, localStamp,
  slotKey, keyToMs, toRfc3339, arabicDate, arabicDateShort,
  parseRules, mergeBusy, computeSlots, validateSlot,
};
