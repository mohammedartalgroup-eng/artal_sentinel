/**
 * leads.js — «التوصيات»: مراسلة من ليس متقدماً بعد.
 *
 * تصلنا توصية بشخص ولدينا منه جواله، وربما اسمه. لا نُنشئ له طلباً بالنيابة
 * (الطلب يبدأ برقم هوية لا نملكه) ولا نرسل له رابط استكمال الوثائق (مرتبط
 * بمتقدم ويجمع هوية وآيبان لا يُطلبان ممن لم يتقدم). نرسل له دعوة فيها رابط
 * تقديم شخصي: يفتح نموذج التقديم نفسه معبّأً باسمه وجواله، ويكمل الباقي بنفسه
 * وبموافقته. حين يرسل، يُربط طلبه بالتوصية تلقائياً — بالرمز، أو بالجوال إن
 * تقدّم من الرابط العام — ويُسجَّل مصدره «توصية» فيظهر في تقارير المصادر.
 *
 * يُركَّب في server.js تحت /admin/leads خلف requireAuth. الدوال المصدّرة في
 * الأسفل يستعملها routes/apply.js للتعبئة والربط.
 */

const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');

const leadsDb = require('../database/leads-db');
const db      = leadsDb.db;

const router = express.Router();
const RYD = 'Asia/Riyadh';

const STATUS_LABEL = {
  new: 'جديدة', invited: 'أُرسلت الدعوة', opened: 'فُتح الرابط', applied: 'تقدّم', closed: 'مغلقة',
};
const OPEN = ['new', 'invited', 'opened'];   // ما زالت بانتظار صاحبها

// مفتاح إيقاف كامل: LEADS_ENABLED=false في .env يُطفئ الميزة بلا نشر كود.
function featureOn() {
  return leadsDb.state.ok && process.env.LEADS_ENABLED !== 'false';
}

const newToken = () => crypto.randomBytes(18).toString('base64url');   // 24 حرفاً

// 05XXXXXXXX كما في جدول المتقدمين — يقبل +966 والأرقام العربية ومسافات النسخ
function normPhone(v) {
  let s = String(v == null ? '' : v)
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/\D/g, '');
  if (s.startsWith('00966')) s = s.slice(5);
  if (s.startsWith('966')) s = s.slice(3);
  if (/^5\d{8}$/.test(s)) s = '0' + s;
  return s;
}
const validPhone = (p) => /^05\d{8}$/.test(p);

function applyLink(req, token) {
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/apply?ref=${token}`;
}

// السيدبار ودوال التاريخ — نفس ما يضبطه routes/admin.js لصفحاته (الراوتر مركّب مستقلاً)
router.use((req, res, next) => {
  res.locals.adminUser = req.session?.adminUser;
  res.locals.adminName = req.session?.adminName || req.session?.adminUser;
  res.locals.adminRole = req.session?.adminRole || 'employee';
  res.locals.fmtDate = (d) => d ? new Date(d).toLocaleDateString('ar-SA', { timeZone: RYD }) : '—';
  res.locals.fmtDateTime = (d) => d
    ? `${new Date(d).toLocaleDateString('ar-SA', { timeZone: RYD })} ${new Date(d).toLocaleTimeString('ar-SA', { timeZone: RYD, hour: '2-digit', minute: '2-digit' })}`
    : '—';
  next();
});

router.use((req, res, next) => {
  if (featureOn()) return next();
  if (req.method === 'GET') return res.status(503).send('ميزة التوصيات غير مفعّلة');
  res.status(503).json({ error: 'ميزة التوصيات غير مفعّلة' });
});

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60,
  message: { error: 'طلبات كثيرة — انتظر قليلاً' },
  standardHeaders: true, legacyHeaders: false,
});

const actorOf = (req) => req.session?.adminName || req.session?.adminUser || null;

// ─── الصفحة ──────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const filter = String(req.query.status || '');
    const q = String(req.query.q || '').trim().slice(0, 60);
    const where = [];
    const params = [];
    if (STATUS_LABEL[filter]) { where.push('l.status = ?'); params.push(filter); }
    if (q) {
      where.push('(l.phone LIKE ? OR l.full_name LIKE ? OR l.referred_by LIKE ?)');
      params.push(`%${normPhone(q) || q}%`, `%${q}%`, `%${q}%`);
    }

    const rows = await db.all(
      `SELECT l.*, a.full_name AS applicant_name, a.status AS applicant_status
         FROM leads l LEFT JOIN applicants a ON a.id = l.applicant_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY l.id DESC LIMIT 300`,
      params
    );
    const counts = Object.fromEntries(
      (await db.all('SELECT status, COUNT(*) AS n FROM leads GROUP BY status')).map(r => [r.status, Number(r.n)])
    );

    const settings = await db.getSettings().catch(() => ({}));
    const WT = require('../utils/waTemplates');
    const chatwoot = require('../utils/chatwoot');

    res.render('leads', {
      leads: rows.map(l => ({ ...l, link: applyLink(req, l.token), statusLabel: STATUS_LABEL[l.status] || l.status })),
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      filter, q,
      STATUS_LABEL,
      waReady: WT.ready(settings, 'invite', chatwoot.isConfigured()),
    });
  } catch (err) {
    console.error('[Leads page]', err.message);
    res.status(500).send('خطأ في تحميل التوصيات');
  }
});

// ─── إضافة توصية ─────────────────────────────────────────────────────────────
router.post('/', writeLimiter, async (req, res) => {
  try {
    const phone = normPhone(req.body?.phone);
    if (!validPhone(phone)) return res.status(400).json({ error: 'رقم الجوال غير صحيح — 05 ثم ثمانية أرقام' });
    const fullName   = String(req.body?.full_name   || '').trim().slice(0, 200) || null;
    const referredBy = String(req.body?.referred_by || '').trim().slice(0, 120) || null;
    const note       = String(req.body?.note        || '').trim().slice(0, 500) || null;

    // التكرار قبل الإضافة: متقدم بنفس الجوال فلا توصية بل ملفه؛ وتوصية مفتوحة
    // بنفس الجوال فهي نفسها — لا نرسل لشخص دعوتين باسمين مختلفين.
    const applicant = await db.get(
      'SELECT id, full_name, status FROM applicants WHERE phone = ? ORDER BY id DESC LIMIT 1', [phone]
    );
    if (applicant) return res.status(409).json({ error: 'هذا الجوال مسجّل متقدماً بالفعل', applicant });

    const open = await db.get(
      `SELECT id, full_name, status FROM leads WHERE phone = ? AND status IN (?, ?, ?) ORDER BY id DESC LIMIT 1`,
      [phone, ...OPEN]
    );
    if (open) return res.status(409).json({ error: 'توجد توصية مفتوحة بهذا الجوال', lead: open });

    const ins = await db.run(
      'INSERT INTO leads (phone, full_name, referred_by, note, token, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [phone, fullName, referredBy, note, newToken(), actorOf(req)]
    );
    db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'lead_create',
      'lead', ins.insertId, fullName || phone, referredBy ? `توصية من ${referredBy}` : null, req.ip).catch(() => {});
    res.status(201).json({ ok: true, id: ins.insertId });
  } catch (err) {
    console.error('[Leads create]', err.message);
    res.status(500).json({ error: 'تعذّرت الإضافة' });
  }
});

async function loadLead(req, res) {
  const lead = await db.get('SELECT * FROM leads WHERE id = ?', [req.params.id]);
  if (!lead) { res.status(404).json({ error: 'التوصية غير موجودة' }); return null; }
  return lead;
}

// ─── إرسال الدعوة ────────────────────────────────────────────────────────────
//  الرابط يُولَّد هنا لا في المتصفح — نفس مبدأ رابط الاستكمال: لا أحد يرسل
//  أي رابط باسم الشركة من واجهة.
router.post('/:id/send', writeLimiter, async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    if (!OPEN.includes(lead.status)) {
      return res.status(409).json({ error: lead.status === 'applied' ? 'صاحب التوصية تقدّم بالفعل' : 'التوصية مغلقة — أعد فتحها أولاً' });
    }

    const notify   = require('../utils/notify');
    const chatwoot = require('../utils/chatwoot');
    const WT       = require('../utils/waTemplates');
    if (!chatwoot.isConfigured()) return res.status(409).json({ error: 'تكامل Chatwoot غير مهيأ' });
    const settings = await db.getSettings();
    if (!WT.ready(settings, 'invite', true)) {
      return res.status(409).json({ error: 'لم يُحدَّد اسم قالب «دعوة للتقديم» في الإعدادات' });
    }

    const link = applyLink(req, lead.token);
    const r = await notify.deliverTemplate({
      // اسم جهة الاتصال في Chatwoot حين لا نعرف الاسم: «موصى به + الجوال» لا فراغ
      recipient: { full_name: lead.full_name || `موصى به ${lead.phone}`, phone: lead.phone },
      tplKey: 'invite', kind: 'invite',
      vars: { name: lead.full_name || 'عزيزنا المرشح', link },
      settings,
    });

    if (r.status !== 'sent') {
      await db.run('UPDATE leads SET last_send_status = ?, last_send_error = ? WHERE id = ?',
        [r.status, String(r.reason || '').slice(0, 255), lead.id]);
      return res.status(r.status === 'skipped' ? 409 : 502).json({ error: r.reason || 'تعذّر الإرسال' });
    }

    await db.run(
      `UPDATE leads SET status = IF(status = 'new', 'invited', status), invite_count = invite_count + 1,
              invited_at = NOW(), last_send_status = 'sent', last_send_error = NULL WHERE id = ?`,
      [lead.id]
    );
    // الرفض المتأخر (قالب مرفوض، حد يومي) يأتي بعد ثوانٍ — يُكتب على التوصية نفسها
    if (r.track) {
      notify.watchDelivery(r.track, async (reason) => {
        await db.run("UPDATE leads SET last_send_status = 'failed', last_send_error = ? WHERE id = ? AND last_send_status = 'sent'",
          [String(reason || '').slice(0, 255), lead.id]);
      });
    }
    db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'lead_invite',
      'lead', lead.id, lead.full_name || lead.phone, `${WT.get('invite').noteLabel} عبر واتساب — ${link}`, req.ip).catch(() => {});

    res.json({ ok: true, sentTo: r.target, link });
  } catch (err) {
    console.error('[Leads send]', err.message);
    res.status(500).json({ error: 'خطأ غير متوقع' });
  }
});

// ─── إغلاق / إعادة فتح / حذف ─────────────────────────────────────────────────
router.post('/:id/close', writeLimiter, async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    if (!OPEN.includes(lead.status)) return res.status(409).json({ error: 'التوصية ليست مفتوحة' });
    const reason = String(req.body?.reason || '').trim().slice(0, 120) || 'أُغلقت يدوياً';
    await db.run("UPDATE leads SET status = 'closed', close_reason = ?, closed_at = NOW() WHERE id = ?", [reason, lead.id]);
    db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'lead_close',
      'lead', lead.id, lead.full_name || lead.phone, reason, req.ip).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[Leads close]', err.message);
    res.status(500).json({ error: 'تعذّر الإغلاق' });
  }
});

router.post('/:id/reopen', writeLimiter, async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    if (lead.status !== 'closed') return res.status(409).json({ error: 'التوصية ليست مغلقة' });
    // تعود إلى آخر مرحلة بلغتها فعلاً، لا إلى البداية
    const back = lead.opened_at ? 'opened' : (lead.invite_count > 0 ? 'invited' : 'new');
    await db.run('UPDATE leads SET status = ?, close_reason = NULL, closed_at = NULL WHERE id = ?', [back, lead.id]);
    res.json({ ok: true, status: back });
  } catch (err) {
    console.error('[Leads reopen]', err.message);
    res.status(500).json({ error: 'تعذّرت إعادة الفتح' });
  }
});

// الحذف لمن لم يتقدم فقط — ما ارتبط بطلب صار جزءاً من ملف متقدم
router.post('/:id/delete', writeLimiter, async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    if (lead.status === 'applied') return res.status(409).json({ error: 'توصية تحوّلت إلى طلب لا تُحذف' });
    await db.run('DELETE FROM leads WHERE id = ?', [lead.id]);
    db.audit(req.session?.adminId, req.session?.adminUser || 'system', 'lead_delete',
      'lead', lead.id, lead.full_name || lead.phone, null, req.ip).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[Leads delete]', err.message);
    res.status(500).json({ error: 'تعذّر الحذف' });
  }
});

// ═══ ما يستعمله نموذج التقديم (routes/apply.js) ═════════════════════════════

/** التوصية التي يحملها رابط الدعوة — ما لم تتحوّل إلى طلب بعد */
async function byToken(token) {
  if (!featureOn() || !/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  return db.get("SELECT * FROM leads WHERE token = ? AND status <> 'applied'", [token]);
}

/** أول فتح للرابط — «فُتح الرابط» تخبر الموظف أن الدعوة وصلت ولو لم يُكمل */
async function markOpened(lead) {
  if (!lead || lead.opened_at) return;
  await db.run(
    "UPDATE leads SET opened_at = NOW(), status = IF(status IN ('new', 'invited'), 'opened', status) WHERE id = ?",
    [lead.id]
  );
}

/**
 * ربط طلب جديد بتوصيته: بالرمز من رابط الدعوة أولاً، وإلا بالجوال إن تقدّم من
 * الرابط العام — فلا تضيع نسبة التوصية لمن فضّل البحث عن الموقع بنفسه.
 * @returns {Promise<object|null>} التوصية المربوطة، أو null إن لم توجد
 */
async function linkApplicant({ token, phone, applicantId }) {
  if (!featureOn() || !applicantId) return null;
  let lead = token ? await byToken(token) : null;
  if (!lead && phone) {
    lead = await db.get(
      "SELECT * FROM leads WHERE phone = ? AND status <> 'applied' ORDER BY id DESC LIMIT 1", [normPhone(phone)]
    );
  }
  if (!lead) return null;
  await db.run(
    "UPDATE leads SET status = 'applied', applicant_id = ?, applied_at = NOW(), close_reason = NULL, closed_at = NULL WHERE id = ?",
    [applicantId, lead.id]
  );
  return lead;
}

module.exports = router;
module.exports.byToken = byToken;
module.exports.markOpened = markOpened;
module.exports.linkApplicant = linkApplicant;
module.exports.featureOn = featureOn;
