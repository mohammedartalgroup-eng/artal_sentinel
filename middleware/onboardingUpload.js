/**
 * onboardingUpload.js — استقبال مستندات «استكمال الملف».
 *
 * منفصل عن middleware/upload.js عمداً: ذاك يخدم نموذج التقديم بحقوله الثابتة
 * (cv / id_image) وحدوده، وأي تعديل عليه يمسّ مسار التوظيف القائم. هذا يكتب
 * في مجلد مستقل تماماً — uploads/onboarding/<applicant_id>/ — فلا يختلط ملف
 * تجريبي بمرفقات النظام الرسمية، ويمكن حذف المجلد كله لو أُلغيت التجربة.
 *
 * ⚠️ يعتمد على req.obSession التي يضعها resolveToken قبله — بلا جلسة صالحة
 *    لا يُكتب أي ملف على القرص.
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOAD_ROOT = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
const OB_ROOT = path.join(UPLOAD_ROOT, 'onboarding');

const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.pdf'];

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const sess = req.obSession;
    if (!sess) return cb(new Error('جلسة غير صالحة'));
    const dest = path.join(OB_ROOT, String(sess.applicant_id));
    try {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (err) {
      cb(new Error(`تعذّر حفظ الملف — تحقق من صلاحيات المجلد: ${dest}`));
    }
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const type = String(req.body.doc_type || 'doc').replace(/[^a-z_]/g, '');
    cb(null, `${type}_${req.obSession.applicant_id}_${Date.now()}${ext}`);
  },
});

const IMAGES = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED.includes(ext)) {
    return cb(new Error('نوع الملف غير مدعوم — استخدم صورة (JPG/PNG) أو PDF'));
  }
  // الصورة الشخصية تُطبع على بطاقة العمل — ملف PDF لا يصلح لها.
  // (doc_type يصل قبل الملف في نموذج الرفع، فهو متاح هنا)
  const type = String(req.body.doc_type || '');
  if (type === 'personal_photo' && !IMAGES.includes(ext)) {
    return cb(new Error('الصورة الشخصية يجب أن تكون صورة (JPG أو PNG) لا ملف PDF'));
  }
  cb(null, true);
}

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});
module.exports.OB_ROOT = OB_ROOT;
