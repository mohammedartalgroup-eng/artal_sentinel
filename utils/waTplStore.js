/**
 * waTplStore.js
 * نسخة محفوظة عندنا من نصوص قوالب واتساب المعتمدة — مأخوذة من Chatwoot.
 *
 * لماذا؟ OpenWA يرسل نصاً حراً يجب أن يطابق القالب المعتمد. كان النص يُقرأ من
 * Chatwoot لحظة الإرسال، فإن توقف Chatwoot خرجت الرسالة بالنص الاحتياطي المكتوب
 * في الكود — كلام غير القالب. الآن يُحفظ النص في قاعدة البيانات مع كل قراءة
 * ناجحة من Chatwoot ومن زر «مزامنة القوالب» في الإعدادات، فيرسل OpenWA منه
 * ولو كان Chatwoot متوقفاً، وتبقى الرسالة واحدة أياً كان المزوّد.
 *
 * ⚠️ لا يرمي إلا sync() — وحدها تحتاج Chatwoot، والمستدعي يعرض سبب فشلها.
 */

const db = require('../database/db');
const chatwoot = require('./chatwoot');

const nameOf = (t) => String(t?.name || t?.friendly_name || '').trim();

/** يحفظ قوالب Chatwoot (كما تُرجعها listTemplates/findTemplate) — @returns عدد المحفوظ */
async function save(list, inboxId) {
  const rows = (list || [])
    .filter(t => nameOf(t) && String(t.body || '').trim())
    .map(t => [
      nameOf(t).slice(0, 191),
      String(t.language || '').trim().slice(0, 10),
      Number(inboxId) || null,
      JSON.stringify({
        name: nameOf(t), language: String(t.language || '').trim(), status: String(t.status || ''),
        body: String(t.body), components: Array.isArray(t.components) ? t.components : [],
      }),
    ]);
  if (!rows.length) return 0;
  try {
    await db.run(
      'INSERT INTO wa_templates (name, language, inbox_id, data) VALUES ' + rows.map(() => '(?, ?, ?, ?)').join(', ') +
      ' ON DUPLICATE KEY UPDATE inbox_id = VALUES(inbox_id), data = VALUES(data), synced_at = CURRENT_TIMESTAMP',
      rows.flat()
    );
    return rows.length;
  } catch (e) {
    console.error('[WaTplStore] save:', e.message);
    return 0;
  }
}

/** القالب المحفوظ بالاسم — واللغة المطلوبة أولاً إن تعدّدت. null = غير محفوظ */
async function find(name, language) {
  try {
    const row = await db.get(
      'SELECT data, synced_at FROM wa_templates WHERE name = ? ORDER BY (language = ?) DESC LIMIT 1',
      [String(name || '').trim(), String(language || '').trim()]
    );
    return row ? { ...JSON.parse(row.data), syncedAt: row.synced_at } : null;
  } catch (e) {
    console.error('[WaTplStore] find:', e.message);
    return null;
  }
}

/** ملخّص المحفوظ — لصفحة الإعدادات */
async function list() {
  try {
    return await db.all('SELECT name, language, inbox_id, synced_at FROM wa_templates ORDER BY name');
  } catch (e) {
    console.error('[WaTplStore] list:', e.message);
    return [];
  }
}

/** مزامنة كل قوالب الصندوق من Chatwoot الآن — يرمي ChatwootError إن تعذّر الوصول */
async function sync(inboxId) {
  const all = await chatwoot.listTemplates({ fresh: true, inbox: inboxId });
  return { saved: await save(all, inboxId), found: all.length };
}

module.exports = { save, find, list, sync };
