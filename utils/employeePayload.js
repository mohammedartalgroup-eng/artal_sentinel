/**
 * employeePayload.js — تحويل حصيلة رحلة الاستكمال إلى حمولة الموظف.
 *
 * ثلاثة مصادر تجتمع هنا:
 *   • حقول المستندات المؤكَّدة (onboarding_fields) — الهوية والعنوان والآيبان والرخصة
 *   • بيانات التوظيف التي أدخلها فريق الموارد البشرية (onboarding_employment)
 *   • سجل المتقدم نفسه (الجوال، المنطقة، الجنس) — ما سجّله يوم تقديمه
 *
 * ترتيب الأفضلية عند التعارض: المستند المؤكَّد يسبق سجل التقديم. المستند وثيقة
 * رسمية قرأها النظام وأكّدها صاحبها، وسجل التقديم نصٌّ كتبه بيده على عجل.
 */

const rules = require('./docRules');
const emp = require('./employmentFields');

/** أول قيمة صحيحة لحقل عبر المستندات، بترتيب ثقة المستند */
function fieldValue(fieldsByType, order, key) {
  for (const docType of order) {
    const row = fieldsByType?.[docType]?.[key];
    if (row && row.valid && String(row.value || '').trim()) return String(row.value).trim();
  }
  return null;
}

/**
 * @param {object} applicant  صف المتقدم
 * @param {object} fieldsByType  { docType: { fieldKey: row } }
 * @param {object} employment  صف onboarding_employment
 * @returns {{payload: object, missing: string[]}}
 */
function build({ applicant, fieldsByType, employment, sessionId }) {
  const ID = ['id_iqama', 'driving_license', 'national_address'];
  const NAMES = ['id_iqama', 'driving_license'];

  const nationalId = fieldValue(fieldsByType, ID, 'id_number')
    || fieldValue(fieldsByType, ['driving_license'], 'license_number')
    || (applicant?.id_number ? String(applicant.id_number) : null);

  const addr = fieldsByType?.national_address || {};
  const val = (o, k) => (o?.[k]?.valid && String(o[k].value || '').trim()) ? String(o[k].value).trim() : null;

  // الحي لا عمود له في جدول الموظفين — يُضمّ إلى الشارع بدل أن يضيع
  const street = val(addr, 'street');
  const district = val(addr, 'district');
  const streetLine = [street, district].filter(Boolean).join(' — ') || null;

  const payload = {
    onboarding: {
      session_id: sessionId || null,
      applicant_id: applicant?.id || null,
      source: 'jobs.artalsecurity.com',
    },

    person: {
      national_id: nationalId,
      name_ar: fieldValue(fieldsByType, NAMES, 'name_ar') || applicant?.full_name || null,
      name_en: fieldValue(fieldsByType, NAMES, 'name_en'),
      birth_date: fieldValue(fieldsByType, NAMES, 'birth_date'),
      national_id_expiry: fieldValue(fieldsByType, ['id_iqama'], 'expiry_date'),
      nationality: fieldValue(fieldsByType, ['id_iqama'], 'nationality'),
      blood_type: fieldValue(fieldsByType, ['driving_license'], 'blood_type'),
      gender: applicant?.gender || null,
      mobile_number: applicant?.phone || null,
      emergency_phone: employment?.emergency_phone || null,
      email: employment?.email || applicant?.email || null,
      marital_status: employment?.marital_status || null,
      qualification: employment?.qualification || null,
      specialization: employment?.specialization || null,
    },

    address: {
      region: applicant?.region || val(addr, 'city') || null,
      city: val(addr, 'city') || applicant?.city || null,
      street: streetLine,
      building_number: val(addr, 'building_number'),
      postal_code: val(addr, 'postal_code'),
    },

    bank: {
      iban: fieldValue(fieldsByType, ['iban'], 'iban'),
      bank_name: fieldValue(fieldsByType, ['iban'], 'bank_name'),
    },

    employment: {
      job_title: employment?.job_title || null,
      preferred_zone_name: employment?.preferred_zone_name || null,
      basic_salary: employment?.basic_salary ?? null,
      living_allowance: employment?.living_allowance ?? null,
      other_allowances: employment?.other_allowances ?? null,
      actual_start: asDate(employment?.actual_start),
      contract_start: asDate(employment?.contract_start),
      insurance_type: emp.insuranceTypeForSync(employment?.insurance_type),
      insurance_company: employment?.insurance_company || null,
    },
  };

  return { payload, missing: missingFor(payload) };
}

/** عمود DATE يعود كائن تاريخ من MySQL — والطرف الآخر ينتظر YYYY-MM-DD */
function asDate(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  try { return new Date(v).toISOString().slice(0, 10); } catch (e) { return null; }
}

/** ما يمنع المزامنة — نفس شروط الطرف الآخر، نفحصها هنا لنشرحها بالعربية قبل النداء */
function missingFor(payload) {
  const out = [];
  if (!payload.person.national_id) out.push('رقم الهوية');
  if (!payload.person.name_ar) out.push('الاسم بالعربية');
  if (!payload.person.mobile_number) out.push('رقم الجوال');
  if (!payload.employment.job_title) out.push('المسمّى الوظيفي');
  if (!payload.employment.preferred_zone_name) out.push('الموقع المرشح');
  if (payload.employment.basic_salary === null) out.push('الراتب الأساسي');
  return out;
}

/**
 * المستندات المطلوبة التي تمنع الإضافة، ولكلٍّ سببه.
 *
 * ما الذي يجعل مستنداً «جاهزاً»؟ أحد أمرين، لا أحدهما فقط:
 *   • أكّده المرشح ولم يُرفض في المراجعة، أو
 *   • اعتمده فريق التوظيف صراحةً (قرار إنسان يسبق تأكيد المرشح ويغني عنه).
 *
 * و«أخضر» وحدها لا تكفي: الاستخراج الآلي يمنحها لكل قراءة نظيفة قبل أن يراها
 * أحد — فنشترط أثر قرار بشري (hr_decided_at) لا لون الشارة.
 */
function docBlockers(session, byType) {
  const required = String(session?.required_docs || '').split(',').filter(Boolean);
  const out = [];

  for (const type of required) {
    const label = rules.DOC_TYPES[type]?.label || type;
    const doc = byType?.[type];

    // وجود المرفق يكفي: الوثيقة المرفوعة هي الأصل، وتأكيد المرشح واعتماد فريق
    // التوظيف مراجعةٌ تجري على مهل ولا تُعطّل إضافة موظف بين يديك ملفه.
    // ولا يمنع إلا الغياب أو الرفض الصريح.
    if (!doc) { out.push(`مستند لم يُرفع: ${label}`); continue; }
    if (doc.review === 'red') { out.push(`مستند مرفوض في المراجعة: ${label}`); continue; }
  }

  return out;
}

/**
 * تصنيف الوثيقة في النظام الأساسي لكل مستند عندنا.
 *
 * الهوية تتفرّع بحسب أول رقم: 1 مواطن ← «هوية»، 2 مقيم ← «إقامة». وهو تفريعٌ
 * يفهمه أرشيف الموظفين ولا يفهمه اسم مستند واحد عندنا.
 */
function categoryFor(docType, nationalId) {
  if (docType === 'id_iqama') {
    return String(nationalId || '').startsWith('2') ? 'iqama' : 'national_id';
  }
  return {
    personal_photo: 'personal_photo',
    national_address: 'national_address',
    iban: 'bank_iban',
    driving_license: 'driving_license',
    cv: 'cv',
    education_certificate: 'educational_certificate',
  }[docType] || 'other';
}

module.exports = { build, missingFor, docBlockers, categoryFor };
