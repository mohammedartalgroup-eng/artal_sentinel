const multer = require('multer');
const path = require('path');
const fs = require('fs');

// على السيرفر: اضبط UPLOADS_PATH لمسار خارج مجلد المشروع
// مثال: UPLOADS_PATH=/var/artal-sentinel/uploads
const UPLOAD_ROOT = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');

// Storage engine — separate folders per file type
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const folder = file.fieldname === 'cv' ? 'cv' : 'id_images';
    const dest = path.join(UPLOAD_ROOT, folder);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    // id_number + timestamp for uniqueness and traceability
    const id = (req.body.id_number || 'unknown').replace(/\D/g, '');
    cb(null, `${file.fieldname}_${id}_${Date.now()}${ext}`);
  }
});

// File type validation
function fileFilter(req, file, cb) {
  if (file.fieldname === 'cv') {
    const allowed = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    return cb(new Error('السيرة الذاتية يجب أن تكون PDF أو DOC'));
  }
  if (file.fieldname === 'id_image') {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    return cb(new Error('صورة الهوية يجب أن تكون JPG أو PNG'));
  }
  cb(null, false);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
    files: 2
  }
});

module.exports = upload;
