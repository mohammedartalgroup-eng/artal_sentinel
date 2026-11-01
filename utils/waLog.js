/**
 * waLog.js
 * سجل استقرار مزوّدي واتساب (Chatwoot وOpenWA) — وإحصائيته في الإعدادات.
 *
 * السؤال الذي يجيب عنه: من يرسل من الموظفين لا يخبر المدير بكل تعثّر، فهل
 * كان المزوّد مستقراً؟ كم رسالة خرجت من أول مرة، وكم احتاجت إعادة، وكم فشلت،
 * وكم رُفضت بعد الإرسال، وبأي زمن.
 *
 * صف لكل عملية إرسال (لا لكل محاولة) في wa_send_log. سجلات المتقدم
 * (interview_messages/applicant_messages) تبقى كما هي — تلك تجيب «هل وصل هذا
 * المتقدم؟»، وهذا يجيب «هل يُعتمد على المزوّد؟».
 *
 * ⚠️ لا يرمي أبداً: تعطّل السجل لا يجوز أن يُفشل إرسالاً نجح.
 */

const db = require('../database/db');

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

/** @returns {Promise<number|null>} رقم الصف — يحتاجه markDelivery */
async function record({ provider, kind, outcome, attempts = 1, errorCode, error, latencyMs, ref }) {
  try {
    const r = await db.run(
      `INSERT INTO wa_send_log (provider, kind, outcome, attempts, error_code, error, latency_ms, ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [provider, clip(kind, 30), outcome, Math.min(Number(attempts) || 1, 99),
       clip(errorCode, 30), clip(error, 255), Number.isFinite(latencyMs) ? Math.round(latencyMs) : null, clip(ref, 120)]
    );
    return r.insertId || null;
  } catch (e) {
    console.error('[WaLog] record:', e.message);
    return null;
  }
}

/** حكم التسليم من الفحص المؤجَّل — failed لا يُكتب فوقه (الرفض حكم نهائي) */
async function markDelivery(id, status) {
  if (!id || !['delivered', 'read', 'failed'].includes(status)) return;
  try {
    await db.run(
      "UPDATE wa_send_log SET delivery = ? WHERE id = ? AND (delivery IS NULL OR delivery <> 'failed')",
      [status, id]
    );
  } catch (e) {
    console.error('[WaLog] markDelivery:', e.message);
  }
}

// ─── الإحصائية ───────────────────────────────────────────────────────────────
//  الفترات ثوابت عندنا لا مدخلات — فتُكتب في نص الاستعلام بلا خطر حقن.
const PERIODS = [
  { key: 'day',   label: 'آخر 24 ساعة', hours: 24 },
  { key: 'week',  label: 'آخر 7 أيام',  hours: 24 * 7 },
  { key: 'month', label: 'آخر 30 يوماً', hours: 24 * 30 },
];

const num = (v) => Number(v) || 0;

/**
 * @returns {Promise<{periods:Array, issues:Array, errorCodes:Array}|null>} null = الجدول غير متاح
 */
async function stats() {
  try {
    const periods = [];
    for (const p of PERIODS) {
      const rows = await db.all(
        `SELECT provider,
                COUNT(*)                                          AS total,
                SUM(outcome = 'sent' AND error_code IS NULL)      AS first_try,
                SUM(outcome = 'sent' AND error_code IS NOT NULL)  AS after_retry,
                SUM(outcome = 'failed')                           AS failed,
                SUM(delivery = 'failed')                          AS rejected,
                SUM(delivery IN ('delivered', 'read'))            AS delivered,
                ROUND(AVG(CASE WHEN outcome = 'sent' THEN latency_ms END)) AS avg_ms,
                MAX(latency_ms)                                   AS max_ms
           FROM wa_send_log
          WHERE created_at >= NOW() - INTERVAL ${p.hours} HOUR
          GROUP BY provider`
      );
      periods.push({
        ...p,
        providers: rows.map(r => {
          const total = num(r.total);
          const ok = num(r.first_try) + num(r.after_retry) - num(r.rejected);
          return {
            provider: r.provider, total,
            firstTry: num(r.first_try), afterRetry: num(r.after_retry),
            failed: num(r.failed), rejected: num(r.rejected), delivered: num(r.delivered),
            successPct: total ? Math.round((ok / total) * 1000) / 10 : null,
            avgMs: r.avg_ms == null ? null : num(r.avg_ms), maxMs: r.max_ms == null ? null : num(r.max_ms),
          };
        }),
      });
    }

    // كل ما ليس نجاحاً نظيفاً من أول مرة — مادة المراجعة. «نجاح بخطأ» يشمل
    // محاولة انتهت مهلتها ثم تبيّن أن رسالتها خرجت (فلم تُعد) — تعثّر وإن لم يتكرر الإرسال
    const issues = await db.all(
      `SELECT id, provider, kind, outcome, attempts, error_code, error, latency_ms, delivery, created_at
         FROM wa_send_log
        WHERE created_at >= NOW() - INTERVAL 720 HOUR
          AND (outcome = 'failed' OR error_code IS NOT NULL OR delivery = 'failed')
        ORDER BY id DESC LIMIT 20`
    );

    const errorCodes = await db.all(
      `SELECT provider, error_code, COUNT(*) AS n
         FROM wa_send_log
        WHERE created_at >= NOW() - INTERVAL 720 HOUR AND error_code IS NOT NULL
        GROUP BY provider, error_code ORDER BY n DESC LIMIT 10`
    );

    return { periods, issues, errorCodes: errorCodes.map(r => ({ ...r, n: num(r.n) })) };
  } catch (e) {
    console.error('[WaLog] stats:', e.message);
    return null;
  }
}

module.exports = { record, markDelivery, stats };
