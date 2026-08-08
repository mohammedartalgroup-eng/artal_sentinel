// ─── تشفير الأسرار المخزَّنة في قاعدة البيانات ───────────────────────────────
//  AES-256-GCM بمكتبة Node المدمجة — بلا أي اعتمادية جديدة.
//  الاستخدام الوحيد حالياً: google_refresh_token في جدول settings.
//  نسخ قاعدة البيانات (phpMyAdmin / Hostinger backups) روتينية، وهذا التوكن
//  يمنح وصولاً كاملاً لتقويم حساب الووركسبيس — فلا يُخزَّن نصاً صريحاً أبداً.
//
//  المفتاح: GOOGLE_ENC_KEY في .env — 64 حرفاً hex (32 بايت). للتوليد:
//    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const HEX64 = /^[0-9a-fA-F]{64}$/;

// هل المفتاح موجود وصالح؟ (لا يرمي — يُستخدم في فحوص التهيئة)
function hasKey() {
  return HEX64.test(process.env.GOOGLE_ENC_KEY || '');
}

function getKey() {
  const raw = process.env.GOOGLE_ENC_KEY || '';
  if (!HEX64.test(raw)) {
    throw new Error('GOOGLE_ENC_KEY مفقود أو غير صالح (يجب أن يكون 64 حرفاً hex)');
  }
  return Buffer.from(raw, 'hex');
}

const b64u = (buf) => buf.toString('base64url');

// نص صريح → 'v1.<iv>.<tag>.<ciphertext>' (base64url)
function encryptSecret(plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(ct)}`;
}

// العكس — يرمي إن عُبث بالقيمة (auth tag) أو تغيّر المفتاح
function decryptSecret(blob) {
  const parts = String(blob || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('صيغة القيمة المشفّرة غير صالحة');
  const [, iv, tag, ct] = parts;
  const decipher = crypto.createDecipheriv(ALG, getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { hasKey, encryptSecret, decryptSecret };
