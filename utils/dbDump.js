/**
 * dbDump.js — نسخة احتياطية SQL لقاعدة البيانات من داخل التطبيق.
 *
 * لماذا من التطبيق لا mysqldump؟ الاستضافة المشتركة لا تتيح الأداة ولا وصولاً
 * خارجياً للقاعدة، والتطبيق هو الوحيد الذي يملك الاتصال. فيُبنى التصدير من
 * استعلامات عادية: SHOW CREATE TABLE ثم الصفوف دفعةً دفعة، ويُكتب مضغوطاً إلى
 * الاستجابة مباشرة — جدول من عشرات الآلاف لا يُحمَّل كله في الذاكرة.
 *
 * الناتج ملف .sql قياسي يُستعاد بـ `mysql db < file`: الجداول تُنشأ من تعريفها
 * الفعلي، وفحص المفاتيح الأجنبية معطَّل أثناء الاستعادة فلا يهمّ ترتيب الجداول.
 */

const db = require('../database/db');

const CHUNK = 500;

// كتابة تحترم ضغط التدفّق: لا نكدّس في الذاكرة إن كان العميل أبطأ من القاعدة
function writer(out) {
  return (s) => new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('انقطع الاتصال أثناء التصدير'));
    if (out.write(s)) return resolve();
    out.once('drain', resolve);
  });
}

/**
 * يكتب التصدير كاملاً إلى out (أي تدفّق قابل للكتابة — gzip غالباً).
 * @returns {Promise<Object<string, number>>} عدد الصفوف لكل جدول
 */
async function writeDump(out) {
  const w = writer(out);
  const [tables] = await db.query('SHOW TABLES');
  const names = tables.map(r => Object.values(r)[0]);

  await w(
    `-- Artal Sentinel — نسخة احتياطية ${new Date().toISOString()}\n` +
    `-- الاستعادة: mysql -u USER -p DBNAME < file.sql\n` +
    `SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n\n`
  );

  const counts = {};
  for (const t of names) {
    const [[create]] = await db.query(`SHOW CREATE TABLE \`${t}\``);
    await w(`DROP TABLE IF EXISTS \`${t}\`;\n${create['Create Table']};\n\n`);

    let offset = 0, n = 0;
    for (;;) {
      // ORDER BY 1 = العمود الأول وهو المفتاح الأساسي في كل جداولنا — ترتيب ثابت للدفعات
      const [rows] = await db.query(`SELECT * FROM \`${t}\` ORDER BY 1 LIMIT ${CHUNK} OFFSET ${offset}`);
      if (!rows.length) break;
      const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
      const values = rows
        .map(r => '(' + Object.values(r).map(v => db.escape(v)).join(', ') + ')')
        .join(',\n');
      await w(`INSERT INTO \`${t}\` (${cols}) VALUES\n${values};\n`);
      n += rows.length;
      offset += rows.length;
      if (rows.length < CHUNK) break;
    }
    counts[t] = n;
    await w('\n');
  }

  await w('SET FOREIGN_KEY_CHECKS=1;\n');
  return counts;
}

module.exports = { writeDump };
