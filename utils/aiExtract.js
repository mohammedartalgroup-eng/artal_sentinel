/**
 * aiExtract.js — واجهة مجرّدة لاستخراج الحقول من نص OCR بنموذج لغوي.
 *
 * ثلاث قواعد تحكم هذا الملف:
 *
 *  1) نصّ فقط، لا صور. Google قرأ الصورة أصلاً، وإرسالها ثانيةً إلى نموذج
 *     Vision يضاعف الكلفة مقابل معلومة نملكها. النموذج هنا يرتّب نصاً لا يقرأ.
 *
 *  2) أقلّ ما يمكن من السياق. نرسل: نوع المستند المتوقَّع + أسماء الحقول
 *     الناقصة + نص OCR. لا نرسل بيانات المتقدم الأخرى — أرخص وأسرع وأكثر
 *     خصوصية، ويقلّل الهلوسة لأن النموذج لا يجد ما «يستنتج» منه.
 *
 *  3) المزوّد تفصيلة قابلة للتبديل. النظام يستدعي extractDocumentFields فقط،
 *     ولا يعرف من خلفها: gemini أو openai أو anthropic — سطر واحد في .env.
 *
 * ⚠️ لا يرمي عند التحميل. غياب المفتاح = لا نموذج، والرحلة تكمل بالقواعد
 *    المحلية وتأكيد المرشح.
 */

const TIMEOUT_MS = 20000;
const MAX_OCR_CHARS = 6000;

// المزوّد ونموذجه — كلاهما من .env، والافتراضي نموذج نصي صغير ورخيص.
function provider() {
  return (process.env.AI_PROVIDER || 'gemini').toLowerCase();
}

function apiKey() {
  const p = provider();
  return process.env.AI_API_KEY
    || (p === 'gemini'    ? process.env.GEMINI_API_KEY    : '')
    || (p === 'openai'    ? process.env.OPENAI_API_KEY    : '')
    || (p === 'anthropic' ? process.env.ANTHROPIC_API_KEY : '')
    || '';
}

const DEFAULT_MODEL = {
  gemini:    'gemini-2.5-flash',
  openai:    'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
};

function model() {
  return process.env.AI_MODEL || DEFAULT_MODEL[provider()] || DEFAULT_MODEL.gemini;
}

function isConfigured() {
  return Boolean(apiKey()) && Boolean(DEFAULT_MODEL[provider()]);
}

// ─── بناء الطلب ──────────────────────────────────────────────────────────────

function buildPrompt(docLabel, fields, ocrText) {
  const list = fields.map(f => `- ${f.key} (${f.label})`).join('\n');
  return [
    'أنت مستخرج بيانات من نص مستند سعودي. أعد JSON فقط بلا أي شرح.',
    '',
    `نوع المستند المتوقَّع: ${docLabel}`,
    '',
    'الحقول المطلوبة:',
    list,
    '',
    'القواعد:',
    '- إن لم تجد قيمة حقل، اجعلها null. لا تخمّن ولا تُكمل من عندك.',
    '- انسخ القيمة كما وردت في النص (بلا إعادة صياغة).',
    '- المستندات الرسمية نماذج بخانات: إن وجدت قيمة مقسّمة إلى رموز متفرقة اجمعها في قيمة واحدة.',
    '- لا تخلط حقلاً بآخر: إن التصق رقم باسم الحي فالرقم ليس جزءاً من الاسم.',
    '- التواريخ: أعدها كما ظهرت، وسنطبّعها نحن.',
    '',
    'أعد بهذه الصيغة بالضبط:',
    '{"is_expected_document": true|false, "detected_type": "وصف قصير", "fields": {"key": "value|null"}, "warnings": ["..."]}',
    '',
    'نص OCR:',
    '"""',
    String(ocrText || '').slice(0, MAX_OCR_CHARS),
    '"""',
  ].join('\n');
}

// النموذج قد يغلّف JSON بسياج ```json — نقشّره بدل أن نفشل.
function parseJson(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

// ─── المزوّدون ───────────────────────────────────────────────────────────────

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent?key=${encodeURIComponent(apiKey())}`;
  const cfg = { temperature: 0, responseMimeType: 'application/json' };
  // ترتيب نصٍّ قرأه OCR ليس مهمة تفكير — و«التفكير» مفعّل افتراضياً في 2.5
  // ويُحاسَب عليه. إطفاؤه يقطع أغلب كلفة النداء بلا أثر على الدقة هنا.
  // مشروط بعائلة 2.5 لأن الموديلات الأقدم ترفض الحقل أصلاً.
  if (/^gemini-2\.5/.test(model())) cfg.thinkingConfig = { thinkingBudget: 0 };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: cfg,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Gemini HTTP ${res.status}`);
  return json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}

async function callOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: model(),
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `OpenAI HTTP ${res.status}`);
  return json?.choices?.[0]?.message?.content || '';
}

async function callAnthropic(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model(),
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Anthropic HTTP ${res.status}`);
  return (json?.content || []).map(c => c.text || '').join('');
}

const CALLERS = { gemini: callGemini, openai: callOpenAI, anthropic: callAnthropic };

/**
 * @param {string} docLabel   اسم المستند بالعربية (للسياق فقط)
 * @param {Array}  fields     [{key,label}] — الحقول الناقصة وحدها
 * @param {string} ocrText    نص Google Vision
 * @returns {Promise<null|{fields, isExpected, detectedType, warnings, provider, model}>}
 */
async function extractDocumentFields(docLabel, fields, ocrText) {
  if (!isConfigured() || !fields.length || !String(ocrText || '').trim()) return null;

  const raw = await CALLERS[provider()](buildPrompt(docLabel, fields, ocrText));
  const data = parseJson(raw);
  if (!data) throw new Error('رد النموذج ليس JSON صالحاً');

  const clean = {};
  for (const f of fields) {
    const v = data.fields?.[f.key];
    if (v != null && String(v).trim() && String(v).toLowerCase() !== 'null') {
      clean[f.key] = String(v).trim();
    }
  }
  return {
    fields: clean,
    isExpected: data.is_expected_document !== false,
    detectedType: data.detected_type || null,
    warnings: Array.isArray(data.warnings) ? data.warnings.slice(0, 3).map(String) : [],
    provider: provider(),
    model: model(),
  };
}

// ═══ الملاذ الأخير: الصورة نفسها إلى النموذج ══════════════════════════════
//
// النماذج الرسمية ذات الخانات (شهادة العنوان الوطني) تخرج من OCR نصاً مبعثر
// الترتيب: الحروف مرصوصة في مربعات، والعمودان العربي والإنجليزي يتداخلان.
// لا القواعد ولا نموذج نصي ينقذان نصاً فاسداً — كلاهما يعمل على مُدخَل خاطئ.
//
// والمفاجأة أن هذا الملاذ ليس الأغلى: صورة إلى Gemini Flash أرخص من نداء
// Google Vision OCR نفسه. فالترتيب «الأرخص أولاً» يبقى صحيحاً، وهذه الدرجة
// تُستدعى فقط حين تعجز الدرجات قبلها عن حقل مطلوب.

const VISION_PROVIDERS = ['gemini'];
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

function supportsVision() {
  return isConfigured() && VISION_PROVIDERS.includes(provider());
}

function buildImagePrompt(docLabel, fields) {
  const list = fields.map(f => `- ${f.key} (${f.label})`).join('\n');
  return [
    'استخرج بيانات هذا المستند السعودي الرسمي. أعد JSON فقط بلا أي شرح.',
    '',
    `نوع المستند المتوقَّع: ${docLabel}`,
    '',
    'الحقول المطلوبة:',
    list,
    '',
    'القواعد:',
    '- المستند نموذج بخانات: كل حرف أو رقم في مربع مستقل. اقرأ الخانات متتاليةً كقيمة واحدة.',
    '- النموذج ثنائي اللغة: لا تخلط التسمية بالقيمة، ولا حقلاً بحقل مجاور.',
    '- لأسماء الأماكن (الحي، المدينة، الشارع) أعد النسخة العربية إن وُجدت.',
    '- التواريخ: أعد الميلادي إن طُبع بجوار الهجري.',
    '- إن لم تجد قيمة حقل، اجعلها null. لا تخمّن.',
    '',
    'أعد بهذه الصيغة بالضبط:',
    '{"is_expected_document": true|false, "detected_type": "وصف قصير", "fields": {"key": "value|null"}, "warnings": ["..."]}',
  ].join('\n');
}

/**
 * يقرأ الصورة/الـPDF مباشرةً بالنموذج متعدد الوسائط.
 * @returns نفس شكل extractDocumentFields، مع vision: true
 */
async function extractFromImage(docLabel, fields, filePath, mime) {
  if (!supportsVision() || !fields.length) return null;

  const fs = require('fs/promises');
  const buf = await fs.readFile(filePath);
  if (buf.length > MAX_IMAGE_BYTES) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent?key=${encodeURIComponent(apiKey())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mime || 'image/jpeg', data: buf.toString('base64') } },
          { text: buildImagePrompt(docLabel, fields) },
        ],
      }],
      // «التفكير» مفعّل هنا عمداً — قراءة نموذج بخانات مهمة استدلال لا نسخ،
      // وهذه آخر محاولة قبل أن نطلب من المرشح الإدخال يدوياً.
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Gemini vision HTTP ${res.status}`);

  const raw = json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const data = parseJson(raw);
  if (!data) throw new Error('رد النموذج (صورة) ليس JSON صالحاً');

  const clean = {};
  for (const f of fields) {
    const v = data.fields?.[f.key];
    if (v != null && String(v).trim() && String(v).toLowerCase() !== 'null') clean[f.key] = String(v).trim();
  }
  return {
    fields: clean,
    isExpected: data.is_expected_document !== false,
    detectedType: data.detected_type || null,
    warnings: Array.isArray(data.warnings) ? data.warnings.slice(0, 3).map(String) : [],
    provider: `${provider()}-vision`,
    model: model(),
    vision: true,
  };
}

module.exports = { isConfigured, provider, model, extractDocumentFields, supportsVision, extractFromImage };
