/**
 * visionOcr.js — قراءة المستند بـ Google Cloud Vision (REST مباشرة).
 *
 * دور Google هنا محدود عمداً: يقرأ الحروف ولا «يفهم» الوثيقة. الفهم وظيفة
 * docRules.js أولاً، ثم aiExtract.js عند اللبس فقط. هذا الفصل هو ما يجعل
 * التكلفة قابلة للتنبؤ: نداء OCR واحد ثابت السعر لكل مستند، ونداء نموذج
 * لغوي في الحالات القليلة الغامضة فقط.
 *
 * لماذا fetch بدل @google-cloud/vision؟ نداء REST واحد لا يبرّر حزمة بعشرات
 * الميغابايت وشجرة اعتماديات تحتاج npm install يدوياً بعد كل نشر تلقائي —
 * نفس المبرّر المعتمد في utils/google.js.
 *
 * ⚠️ لا يرمي عند التحميل، وكل تحقق كسول: غياب المفتاح يعني «لا OCR» لا
 *    «النظام معطّل» — المرشح يُدخل الحقول يدوياً والرحلة تكمل.
 */

const fs = require('fs/promises');

const IMG_URL   = 'https://vision.googleapis.com/v1/images:annotate';
const FILE_URL  = 'https://vision.googleapis.com/v1/files:annotate';
const TIMEOUT_MS = 20000;

function isConfigured() {
  return Boolean(process.env.GOOGLE_VISION_API_KEY);
}

async function post(url, body) {
  const res = await fetch(`${url}?key=${encodeURIComponent(process.env.GOOGLE_VISION_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error?.message || `Vision HTTP ${res.status}`);
  }
  return json;
}

/**
 * يقرأ ملفاً من القرص ويُرجع { text, confidence, provider }.
 * يرجع null إذا لم يكن المفتاح مضبوطاً — والمُستدعي يتعامل مع null كمسار عادي.
 * يرمي فقط عند فشل نداء مضبوط (شبكة/حصة) ليُسجَّل السبب في المستند.
 */
async function readDocument(filePath, mime) {
  if (!isConfigured()) return null;

  const buf = await fs.readFile(filePath);
  const content = buf.toString('base64');
  const isPdf = String(mime || '').includes('pdf');

  if (isPdf) {
    // files:annotate يقبل PDF مضمَّناً — نقرأ أول صفحتين فقط: شهادات البنك
    // والعنوان الوطني كلها صفحة واحدة، وقراءة الزائد تكلفة بلا فائدة.
    const json = await post(FILE_URL, {
      requests: [{
        inputConfig: { content, mimeType: 'application/pdf' },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['ar', 'en'] },
        pages: [1, 2],
      }],
    });
    const pages = json?.responses?.[0]?.responses || [];
    const text = pages.map(p => p?.fullTextAnnotation?.text || '').join('\n').trim();
    const conf = pages[0]?.fullTextAnnotation?.pages?.[0]?.confidence ?? null;
    return { text, confidence: conf, provider: 'google_vision_pdf' };
  }

  const json = await post(IMG_URL, {
    requests: [{
      image: { content },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: ['ar', 'en'] },
    }],
  });
  const r = json?.responses?.[0] || {};
  if (r.error) throw new Error(r.error.message || 'Vision error');
  return {
    text: (r.fullTextAnnotation?.text || '').trim(),
    confidence: r.fullTextAnnotation?.pages?.[0]?.confidence ?? null,
    provider: 'google_vision',
  };
}

module.exports = { isConfigured, readDocument };
