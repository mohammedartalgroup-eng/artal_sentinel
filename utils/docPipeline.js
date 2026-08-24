/**
 * docPipeline.js — المسار الكامل لمستند واحد.
 *
 *   الملف → Google Vision → تطبيع → قواعد محلية → (نموذج لغوي عند اللبس) → تحقق → مقارنة → نتيجة
 *
 * الترتيب هو الفكرة كلها: الأرخص أولاً، والأغلى لا يُستدعى إلا إذا فشل ما قبله.
 * كل مرحلة تُرجع ما استطاعت ولا تُسقِط المرحلة التالية — فشل OCR لا يمنع
 * الإدخال اليدوي، وفشل النموذج لا يمنع عرض ما التقطته القواعد.
 */

const ocr   = require('./visionOcr');
const ai    = require('./aiExtract');
const rules = require('./docRules');

async function processDocument({ docType, filePath, mime, applicant }) {
  const def = rules.DOC_TYPES[docType];
  const result = {
    ocrText: null, ocrProvider: null, ocrConf: null, ocrError: null,
    fields: {}, warnings: [], typeMatch: 'unknown',
    aiUsed: false, aiProvider: null, aiModel: null, aiError: null,
    review: 'yellow',
  };

  // ── 1) القراءة ─────────────────────────────────────────────────────────────
  let text = '';
  try {
    const r = await ocr.readDocument(filePath, mime);
    if (r) {
      text = r.text || '';
      result.ocrText = text;
      result.ocrProvider = r.provider;
      result.ocrConf = r.confidence;
    }
  } catch (e) {
    // خطأ القراءة يُسجَّل ولا يُنهي المسار: المرشح سيُدخل الحقول بنفسه.
    result.ocrError = e.message;
    console.error('[Onboarding OCR]', docType, e.message);
  }

  if (!text.trim()) {
    result.warnings.push(
      ocr.isConfigured()
        ? 'لم نتمكن من قراءة المستند تلقائياً — أدخل البيانات يدوياً أو أعد التصوير بإضاءة أفضل.'
        : 'القراءة التلقائية غير مفعّلة حالياً — أدخل البيانات يدوياً.'
    );
    return result;
  }

  // ── 2) القواعد المحلية ─────────────────────────────────────────────────────
  const parsed = rules.parse(docType, text);
  // المصدر الافتراضي «قراءة آلية» — إلا ما جاء بمصدره (قيمة مشتقة بقاعدة مثلاً)
  result.fields = Object.fromEntries(
    Object.entries(parsed.fields).map(([k, v]) => [k, { source: 'ocr', ...v }])
  );
  result.warnings.push(...parsed.warnings);
  result.typeMatch = parsed.typeMatch;

  // ── 3) النموذج اللغوي — للناقص وحده ────────────────────────────────────────
  //  المطلوب الناقص + الحقول المُعلَّمة aiAssist (اختيارية لكن تركها فارغة يعني
  //  إدخالاً يدوياً على المرشح). ما عداها لا يستدعي النموذج إطلاقاً.
  const missingReq = rules.missingRequired(docType, result.fields);
  const missingAssist = def.fields
    .filter(f => f.aiAssist && !f.required)
    .filter(f => !result.fields[f.key]?.valid)
    .map(f => f.key);
  const missing = [...new Set([...missingReq, ...missingAssist])];
  if (missing.length && ai.isConfigured()) {
    try {
      const askFor = def.fields.filter(f => missing.includes(f.key)).map(f => ({ key: f.key, label: f.label }));
      // النص المُفكوك من الخانات لا الخام: النموذج يهلوس على «F J S G 4 5 3 3»
      // ويرجع أول رمز، بينما «FJSG4533» قيمة لا لبس فيها.
      const out = await ai.extractDocumentFields(def.label, askFor, rules.debox(text));
      if (out) {
        result.aiUsed = true;
        result.aiProvider = out.provider;
        result.aiModel = out.model;
        for (const [k, raw] of Object.entries(out.fields)) {
          const v = rules.validate(docType, k, raw);
          // النموذج لا يدهس قيمة صحيحة التقطتها القواعد — يملأ الفراغ فقط.
          if (result.fields[k]?.valid) continue;
          result.fields[k] = { raw: String(raw), value: v.value, valid: v.ok, error: v.error, confidence: 0.75, source: 'ai' };
        }
        if (out.isExpected === false && result.typeMatch !== 'yes') {
          result.typeMatch = 'no';
          result.warnings.push(`يبدو أن الصورة ليست ${def.label}${out.detectedType ? ` — ${out.detectedType}` : ''}.`);
        }
        result.warnings.push(...out.warnings);
      }
    } catch (e) {
      result.aiError = e.message;
      console.error('[Onboarding AI]', docType, e.message);
    }
  }

  // ── 3.5) المشتقات — بعد استقرار القيم أياً كان مصدرها ──────────────────────
  for (const [key, f] of Object.entries({ ...result.fields })) {
    if (!f.valid) continue;
    for (const d of rules.derivedFrom(docType, key, f.value)) {
      if (result.fields[d.key]?.valid) continue;      // لا نلغي قيمة صحيحة قائمة
      const v = rules.validate(docType, d.key, d.value);
      result.fields[d.key] = { raw: d.value, value: v.value, valid: v.ok, error: v.error, confidence: 1, source: 'rule' };
    }
  }

  // ── 4) المقارنة مع بيانات الطلب ────────────────────────────────────────────
  // رقم هوية مختلف عن رقم الطلب ليس خطأ مطبعياً بالضرورة — قد يكون مستند شخص
  // آخر. لا نرفض تلقائياً، بل نرفعه إلى «يحتاج مراجعة» ليقرر HR.
  const idField = docType === 'id_iqama' ? result.fields.id_number : null;
  if (idField?.valid && applicant?.id_number && idField.value !== String(applicant.id_number)) {
    result.warnings.push('رقم الهوية في المستند لا يطابق الرقم المسجّل في طلب التوظيف.');
    result.mismatch = true;
  }

  result.review = rules.reviewLevel(docType, result.fields, result.typeMatch);
  if ((result.mismatch || parsed.expired) && result.review === 'green') result.review = 'yellow';

  return result;
}

module.exports = { processDocument };
