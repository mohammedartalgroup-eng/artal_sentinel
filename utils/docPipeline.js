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

  // دمج ناتج أي نموذج في النتيجة — لا يدهس قيمة صحيحة التقطتها القواعد.
  const mergeAi = (out, conf) => {
    result.aiUsed = true;
    result.aiProvider = out.provider;
    result.aiModel = out.model;
    for (const [k, raw] of Object.entries(out.fields)) {
      const v = rules.validate(docType, k, raw);
      if (result.fields[k]?.valid) continue;
      if (!v.ok && result.fields[k]) continue;      // لا نستبدل خطأً بخطأ
      result.fields[k] = { raw: String(raw), value: v.value, valid: v.ok, error: v.error, confidence: conf, source: 'ai' };
    }
    if (out.isExpected === false && result.typeMatch !== 'yes') {
      // القواعد قد تكون سبقته إلى نفس الاستنتاج — لا نكرّره على المرشح
      if (result.typeMatch !== 'no') {
        result.warnings.push(`يبدو أن الصورة ليست ${def.label}${out.detectedType ? ` — ${out.detectedType}` : ''}.`);
      }
      result.typeMatch = 'no';
    }
    // تحذيرات النموذج قد تأتي بالإنجليزية — والمرشح يقرأ العربية وحدها،
    // فنقبل ما غلبت عليه العربية لا ما ورد فيه حرف عربي عرضاً.
    result.warnings.push(...out.warnings.filter(w => {
      const ar = (w.match(/[\u0600-\u06FF]/g) || []).length;
      const la = (w.match(/[A-Za-z]/g) || []).length;
      return ar > la;
    }));
  };

  const askFor = (keys) => def.fields.filter(f => keys.includes(f.key)).map(f => ({ key: f.key, label: f.label }));

  // (3-أ) نموذج نصي — إلا في النماذج التي نعرف أن نصّها مبعثر أصلاً
  if (missing.length && ai.isConfigured() && !def.visionFirst) {
    try {
      // النص المُفكوك من الخانات لا الخام: النموذج يهلوس على «F J S G 4 5 3 3»
      // ويرجع أول رمز، بينما «FJSG4533» قيمة لا لبس فيها.
      const out = await ai.extractDocumentFields(def.label, askFor(missing), rules.debox(text));
      if (out) mergeAi(out, 0.75);
    } catch (e) {
      result.aiError = e.message;
      console.error('[Onboarding AI]', docType, e.message);
    }
  }

  // (3-ب) الملاذ الأخير: الصورة نفسها إلى النموذج متعدد الوسائط.
  //  يعمل فقط إن بقي حقل مطلوب ناقصاً بعد كل ما سبق — أو مباشرةً في النماذج
  //  ذات الخانات. أرخص من نداء OCR نفسه، لكنه يبقى آخر الدرجات لأن كل درجة
  //  قبله أسرع وأثبت.
  const stillMissing = [...new Set([
    ...rules.missingRequired(docType, result.fields),
    ...missingAssist.filter(k => !result.fields[k]?.valid),
  ])];
  if (stillMissing.length && ai.supportsVision() && filePath) {
    try {
      const out = await ai.extractFromImage(def.label, askFor(stillMissing), filePath, mime);
      if (out) {
        // قراءة الصورة تفوق قراءة نصٍّ مبعثر — فتدهس قيمة نصية فاشلة التحقق
        for (const k of stillMissing) if (result.fields[k] && !result.fields[k].valid) delete result.fields[k];
        mergeAi(out, 0.85);
      }
    } catch (e) {
      result.aiError = e.message;
      console.error('[Onboarding AI vision]', docType, e.message);
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

  // تكرار التحذير نفسه من مصدرين (قواعد + نموذج) يربك المرشح بلا فائدة
  result.warnings = [...new Set(result.warnings)];

  result.review = rules.reviewLevel(docType, result.fields, result.typeMatch);
  if ((result.mismatch || parsed.expired) && result.review === 'green') result.review = 'yellow';

  return result;
}

module.exports = { processDocument };
