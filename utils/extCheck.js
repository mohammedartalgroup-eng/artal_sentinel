/**
 * extCheck.js
 * التحقق من وجود المتقدم في النظام الخارجي (artalsys.com)
 * Fire-and-forget — لا تؤثر أبداً على أداء النظام الحالي
 */

const https = require('https');
const db    = require('../database/db');

const EXT_HOSTNAME = 'artalsys.com';
const EXT_PATH     = '/api/employees/check-national-id';
const EXT_SECRET   = 'artal@NID%2026';
const TIMEOUT_MS   = 8000;

/**
 * يستعلم عن رقم الهوية في النظام الخارجي ويحفظ النتيجة في DB.
 * آمن تماماً — يُبتلع أي خطأ شبكي أو timeout ولا يرمي استثناء.
 *
 * @param {number} applicantId   - id المتقدم في جدول applicants
 * @param {string} idNumber      - رقم الهوية الوطنية (10 أرقام)
 */
async function checkExternal(applicantId, idNumber) {
  return new Promise((resolve) => {
    const path    = `${EXT_PATH}?national_id=${encodeURIComponent(idNumber)}`;
    const options = {
      hostname : EXT_HOSTNAME,
      path,
      method   : 'GET',
      headers  : { 'X-Secret': EXT_SECRET },
      timeout  : TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', async () => {
        try {
          if (res.statusCode === 401) {
            console.error('[ExtCheck] Unauthorized — تحقق من المفتاح السري');
            return resolve();
          }

          const data = JSON.parse(body);

          if (data.found) {
            await db.run(
              `UPDATE applicants
               SET ext_check_done  = 1,
                   ext_found       = 1,
                   ext_employee_id = ?,
                   ext_status      = ?,
                   ext_job_status  = ?,
                   ext_checked_at  = NOW()
               WHERE id = ?`,
              [data.id, data.status ?? null, data.job_status ?? null, applicantId]
            );
            console.log(`[ExtCheck] #${applicantId}: موجود في النظام الخارجي (emp_id=${data.id})`);
          } else {
            await db.run(
              `UPDATE applicants
               SET ext_check_done  = 1,
                   ext_found       = 0,
                   ext_employee_id = NULL,
                   ext_status      = NULL,
                   ext_job_status  = NULL,
                   ext_checked_at  = NOW()
               WHERE id = ?`,
              [applicantId]
            );
            console.log(`[ExtCheck] #${applicantId}: غير موجود في النظام الخارجي`);
          }
          resolve();
        } catch (e) {
          console.error('[ExtCheck] خطأ في تحليل الرد:', e.message);
          resolve();
        }
      });
    });

    req.on('error',   (e) => { console.error('[ExtCheck] خطأ شبكي:', e.message); resolve(); });
    req.on('timeout', ()  => { console.error('[ExtCheck] انتهت المهلة'); req.destroy(); resolve(); });
    req.end();
  });
}

module.exports = { checkExternal };
