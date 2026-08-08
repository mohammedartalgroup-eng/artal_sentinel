/**
 * google.js
 * عميل خفيف لـ Google OAuth + Calendar (Free/Busy وأحداث Meet).
 *
 * لماذا fetch مباشرة بدل حزمة googleapis؟
 *   • خمسة نداءات REST فقط — الحزمة (~15MB وشجرة اعتماديات كبيرة) لا تُبرَّر.
 *   • صفر اعتماديات جديدة ⇒ لا حاجة إلى npm install يدوي على الخادم بعد النشر التلقائي.
 *   • Node 24 يوفّر fetch و AbortSignal.timeout، وسابقة hand-rolled موجودة في extCheck.js.
 *
 * ⚠️ عزل: هذا الملف لا يرمي عند التحميل إطلاقاً — كل تحقق من الإعدادات كسول
 *    داخل isConfigured()، حتى لا يمنع غياب متغير بيئة إقلاع النظام.
 */

const db = require('../database/db');
const { hasKey, encryptSecret, decryptSecret } = require('./crypto');

const AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO   = 'https://www.googleapis.com/oauth2/v3/userinfo';
const CAL        = 'https://www.googleapis.com/calendar/v3';
const CAL_ID     = 'primary';          // تقويم الحساب المتصل نفسه
const TIMEOUT_MS = 10000;

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
].join(' ');

// ─── أخطاء مصنّفة ────────────────────────────────────────────────────────────
class GoogleError extends Error {
  constructor(message, code = 'HTTP', status = null, body = null) {
    super(message);
    this.name = 'GoogleError';
    this.code = code;              // NOT_CONFIGURED | DISCONNECTED | HTTP | TIMEOUT | NO_MEET
    this.status = status;
    this.body = body;
  }
}

// ─── الإعداد ─────────────────────────────────────────────────────────────────
function isConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI &&
    hasKey()
  );
}

function requireConfigured() {
  if (!isConfigured()) {
    throw new GoogleError('تكامل Google غير مهيأ — راجع متغيرات البيئة', 'NOT_CONFIGURED');
  }
}

function buildAuthUrl(state) {
  requireConfigured();
  const p = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',          // بدونه لا يُرجع جوجل refresh_token عند إعادة الربط
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

// ─── نداء نموذج (form-urlencoded) لنقطة التوكن ───────────────────────────────
async function postForm(url, params) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new GoogleError('انتهت مهلة الاتصال بـ Google', 'TIMEOUT');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error || '';
    if (err === 'invalid_grant') {
      await markDisconnected();
      throw new GoogleError('انقطع الاتصال بحساب Google — أعد الربط من الإعدادات', 'DISCONNECTED', res.status, data);
    }
    throw new GoogleError(data?.error_description || err || `Google HTTP ${res.status}`, 'HTTP', res.status, data);
  }
  return data;
}

async function exchangeCode(code) {
  requireConfigured();
  const data = await postForm(TOKEN_URL, {
    code,
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
    grant_type:    'authorization_code',
  });
  if (!data.refresh_token) {
    throw new GoogleError(
      'لم يُرجع Google رمز تحديث — أزل صلاحية التطبيق من حساب Google ثم أعد الربط',
      'HTTP'
    );
  }
  return data;
}

async function fetchAccountEmail(accessToken) {
  try {
    const res = await fetch(USERINFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    return data?.email || '';
  } catch (_) {
    return '';                    // الإيميل معلومة عرض فقط — لا تُفشل الربط
  }
}

// ─── تخزين الاتصال ───────────────────────────────────────────────────────────
async function setSetting(key, value) {
  await db.run('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE `key` = ?', [value, key]);
}

async function markDisconnected() {
  tokenCache = { token: null, expMs: 0 };
  try { await setSetting('google_token_status', 'invalid'); } catch (_) {}
}

async function saveConnection({ refreshToken, email }) {
  await setSetting('google_refresh_token', encryptSecret(refreshToken));
  await setSetting('google_account_email', email || '');
  // وقت الربط يُكتب من Node لا بـ NOW() — توقيت خادم MySQL مجهول
  await setSetting('google_connected_at', new Date().toISOString());
  await setSetting('google_token_status', 'ok');
  tokenCache = { token: null, expMs: 0 };
}

async function getConnection() {
  const s = await db.getSettings();
  return {
    configured:  isConfigured(),
    connected:   Boolean(s.google_refresh_token),
    email:       s.google_account_email || '',
    connectedAt: s.google_connected_at || '',
    status:      s.google_token_status || '',
  };
}

async function disconnect() {
  const s = await db.getSettings();
  if (s.google_refresh_token) {
    try {
      const token = decryptSecret(s.google_refresh_token);
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      console.error('[Google] revoke تعذّر (سنتابع الفصل محلياً):', e.message);
    }
  }
  for (const k of ['google_refresh_token', 'google_account_email', 'google_connected_at', 'google_token_status']) {
    await setSetting(k, '');
  }
  tokenCache = { token: null, expMs: 0 };
}

// ─── رمز الوصول: كاش داخل العملية (عملية ويب واحدة) ──────────────────────────
let tokenCache = { token: null, expMs: 0 };
let refreshInflight = null;        // يمنع تجديدين متزامنين يحرقان منحة التحديث

async function getAccessToken() {
  requireConfigured();
  if (tokenCache.token && Date.now() < tokenCache.expMs - 60_000) return tokenCache.token;
  if (refreshInflight) return refreshInflight;

  refreshInflight = (async () => {
    const s = await db.getSettings();
    if (!s.google_refresh_token) {
      throw new GoogleError('لم يتم ربط حساب Google بعد', 'DISCONNECTED');
    }
    let refreshToken;
    try {
      refreshToken = decryptSecret(s.google_refresh_token);
    } catch (e) {
      await markDisconnected();
      throw new GoogleError('تعذّر فك تشفير رمز Google — أعد الربط من الإعدادات', 'DISCONNECTED');
    }
    const data = await postForm(TOKEN_URL, {
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    });
    tokenCache = { token: data.access_token, expMs: Date.now() + (data.expires_in || 3600) * 1000 };
    if (s.google_token_status !== 'ok') { try { await setSetting('google_token_status', 'ok'); } catch (_) {} }
    console.log(`[Google] token refreshed (expires in ${data.expires_in || 3600}s)`);
    return tokenCache.token;
  })().finally(() => { refreshInflight = null; });

  return refreshInflight;
}

// ─── نداء عام على Calendar API ───────────────────────────────────────────────
//  idempotent:true فقط للنداءات الآمنة (freeBusy / GET). لا يُعاد POST /events
//  أبداً — إعادة بعد timeout قد تُنشئ اجتماعاً مكرراً.
async function gfetch(url, { method = 'GET', body, idempotent = false, retried = false, op = '' } = {}) {
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new GoogleError('انتهت مهلة الاتصال بـ Google', 'TIMEOUT');
  }

  if (res.status === 401 && !retried) {
    tokenCache = { token: null, expMs: 0 };
    return gfetch(url, { method, body, idempotent, retried: true, op });
  }
  if ((res.status === 429 || res.status >= 500) && idempotent && !retried) {
    await new Promise(r => setTimeout(r, 700));
    return gfetch(url, { method, body, idempotent, retried: true, op });
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Google HTTP ${res.status}`;
    console.error(`[Google] HTTP ${res.status} ${op} — ${msg}`);
    throw new GoogleError(msg, 'HTTP', res.status, data);
  }
  return data;
}

// ─── Free/Busy ───────────────────────────────────────────────────────────────
/**
 * @returns {{busy: {start:number,end:number}[], errors: Object<string,string>}}
 */
async function freeBusy({ timeMinMs, timeMaxMs, calendarIds }) {
  const ids = [...new Set(calendarIds.filter(Boolean))].slice(0, 20);
  const data = await gfetch(`${CAL}/freeBusy`, {
    method: 'POST',
    idempotent: true,
    op: 'freeBusy',
    body: {
      timeMin: new Date(timeMinMs).toISOString(),
      timeMax: new Date(timeMaxMs).toISOString(),
      timeZone: 'Asia/Riyadh',
      items: ids.map(id => ({ id })),
    },
  });

  const busy = [];
  const errors = {};
  for (const [id, cal] of Object.entries(data?.calendars || {})) {
    if (cal.errors?.length) errors[id] = cal.errors[0].reason || 'error';
    for (const b of cal.busy || []) {
      busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
    }
  }
  return { busy, errors };
}

// ─── الأحداث ─────────────────────────────────────────────────────────────────
function extractMeet(data) {
  return data?.hangoutLink
    || data?.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri
    || null;
}

const shape = (data) => ({
  eventId:  data?.id || null,
  meetLink: extractMeet(data),
  htmlLink: data?.htmlLink || null,
});

async function getEvent(eventId) {
  const data = await gfetch(
    `${CAL}/calendars/${encodeURIComponent(CAL_ID)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1`,
    { idempotent: true, op: 'getEvent' }
  );
  return shape(data);
}

/**
 * إنشاء حدث مع اجتماع Meet.
 * conferenceDataVersion=1 إلزامي وإلا يُتجاهل طلب الاجتماع بصمت.
 * إنشاء الاجتماع غير متزامن، فإن لم يجهز الرابط نستعلم عنه بضع مرات.
 */
async function createEvent(spec) {
  const data = await gfetch(
    `${CAL}/calendars/${encodeURIComponent(CAL_ID)}/events?conferenceDataVersion=1&sendUpdates=all`,
    { method: 'POST', body: spec, op: 'createEvent' }   // ← بلا إعادة محاولة عمداً
  );
  let out = shape(data);
  if (!out.meetLink && out.eventId) {
    for (const wait of [400, 900, 1800]) {
      await new Promise(r => setTimeout(r, wait));
      try {
        const again = await getEvent(out.eventId);
        if (again.meetLink) { out = again; break; }
      } catch (_) { /* الرابط ثانوي — لا نُفشل الجدولة بسببه */ }
    }
  }
  return { ...out, pendingLink: !out.meetLink };
}

// إعادة الجدولة — بلا conferenceData حتى يبقى رابط Meet كما هو
async function patchEvent(eventId, spec) {
  const data = await gfetch(
    `${CAL}/calendars/${encodeURIComponent(CAL_ID)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=all`,
    { method: 'PATCH', body: spec, op: 'patchEvent' }
  );
  return shape(data);
}

async function deleteEvent(eventId) {
  try {
    await gfetch(
      `${CAL}/calendars/${encodeURIComponent(CAL_ID)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: 'DELETE', op: 'deleteEvent' }
    );
  } catch (e) {
    if (e.code === 'HTTP' && (e.status === 404 || e.status === 410)) return;  // محذوف أصلاً
    throw e;
  }
}

// البحث عن حدث بمعرّف المقابلة (تسوية بعد انقطاع الشبكة أثناء الإنشاء)
async function findEventByInterviewId(interviewId, timeMinMs, timeMaxMs) {
  const q = new URLSearchParams({
    privateExtendedProperty: `artal_interview_id=${interviewId}`,
    timeMin: new Date(timeMinMs).toISOString(),
    timeMax: new Date(timeMaxMs).toISOString(),
    conferenceDataVersion: '1',
    maxResults: '5',
  });
  const data = await gfetch(
    `${CAL}/calendars/${encodeURIComponent(CAL_ID)}/events?${q.toString()}`,
    { idempotent: true, op: 'findEvent' }
  );
  const ev = (data?.items || []).find(e => e.status !== 'cancelled');
  return ev ? shape(ev) : null;
}

module.exports = {
  GoogleError,
  isConfigured,
  buildAuthUrl,
  exchangeCode,
  fetchAccountEmail,
  saveConnection,
  getConnection,
  disconnect,
  getAccessToken,
  freeBusy,
  createEvent,
  getEvent,
  patchEvent,
  deleteEvent,
  findEventByInterviewId,
};
