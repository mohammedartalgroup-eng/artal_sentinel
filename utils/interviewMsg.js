/**
 * interviewMsg.js
 * بناء نصوص وروابط مشاركة موعد المقابلة.
 *
 * مصمَّم ليُعاد استخدامه كما هو عند بناء الإرسال التلقائي لاحقاً
 * (WhatsApp Cloud API / SMS): المُرسِل المستقبلي يستورد buildWhatsAppText
 * ولا يحتاج تعديلها.
 */

const { arabicDate, localTime } = require('./slots');

// 05XXXXXXXX → 9665XXXXXXXX (صيغة wa.me)
function toIntlPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^05\d{8}$/.test(digits)) return `966${digits.slice(1)}`;
  if (/^9665\d{8}$/.test(digits)) return digits;
  if (/^5\d{8}$/.test(digits)) return `966${digits}`;
  return digits;
}

/**
 * @param {{full_name?:string}} applicant
 * @param {{startMs:number, durationMin:number, meetLink?:string}} interview
 * @param {{companyName?:string}} [opts]
 */
function buildWhatsAppText(applicant, interview, opts = {}) {
  const company = opts.companyName || 'أرتال للحراسات الأمنية';
  const name = (applicant?.full_name || '').trim();
  const lines = [
    `مرحباً ${name}،`,
    `تمت جدولة مقابلة توظيف معك في ${company}.`,
    '',
    `📅 التاريخ: ${arabicDate(interview.startMs)}`,
    `🕐 الوقت: ${localTime(interview.startMs)} (بتوقيت السعودية)`,
    `⏱️ المدة: ${interview.durationMin} دقيقة`,
  ];
  if (interview.meetLink) {
    lines.push('', `🔗 رابط المقابلة عبر Google Meet:`, interview.meetLink);
  }
  lines.push('', 'نرجو الانضمام قبل الموعد بخمس دقائق من مكان هادئ وبإنترنت مستقر.', 'بالتوفيق.');
  return lines.join('\n');
}

function buildWaUrl(phone, text) {
  const p = toIntlPhone(phone);
  if (!p) return '';
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

module.exports = { toIntlPhone, buildWhatsAppText, buildWaUrl };
