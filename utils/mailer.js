/**
 * mailer.js
 * إرسال البريد عبر SMTP — بمكتبة Node المدمجة، بلا أي اعتمادية خارجية.
 *
 * لماذا يدوياً بدل nodemailer؟ نفس سبب utils/google.js حرفياً:
 *   النشر على الخادم تلقائي (git pull + إعادة تشغيل) ولا يُشغَّل npm install،
 *   فأي حزمة جديدة لن تصل الخادم أبداً ويُعطَّل البريد بصمت. صفر اعتماديات
 *   ⇒ الميزة تعمل فور النشر بلا أي أمر يدوي.
 *
 * المدى المدعوم عمداً محدود: خادم SMTP واحد بمصادقة AUTH LOGIN — وهو ما
 * يلزم لـ Gmail/Workspace بكلمة مرور تطبيق. لا مرفقات ولا قوائم استلام.
 *
 * ⚠️ عزل: لا يرمي عند التحميل — كل تحقق كسول داخل isConfigured().
 */

const tls    = require('node:tls');
const net    = require('node:net');
const crypto = require('node:crypto');

const CONNECT_TIMEOUT = 10000;
const REPLY_TIMEOUT   = 20000;
const CRLF = '\r\n';

class SmtpError extends Error {
  constructor(message, code = 'SMTP', reply = null) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;              // CONFIG | TIMEOUT | AUTH | SMTP | NETWORK
    this.reply = reply;
  }
}

const cfg = () => ({
  host: String(process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
  port: parseInt(process.env.SMTP_PORT, 10) || 465,
  user: String(process.env.SMTP_USER || '').trim(),
  // كلمات مرور التطبيق تُنسخ من Google بمسافات كل أربعة أحرف — نزيلها بصمت
  pass: String(process.env.SMTP_PASS || '').replace(/\s+/g, ''),
  fromName: String(process.env.MAIL_FROM_NAME || 'أرتال للحراسات الأمنية').trim(),
});

function isConfigured() {
  const c = cfg();
  return Boolean(c.host && c.port && c.user && c.pass);
}

// ملخّص آمن لصفحة الإعدادات — بلا كلمة المرور
function status() {
  const c = cfg();
  return {
    configured: isConfigured(),
    installed: true,               // لا حزمة تُثبَّت — مدمج في Node
    loadError: null,
    host: c.host, port: c.port, user: c.user,
    hasPass: Boolean(c.pass),
    fromName: c.fromName,
  };
}

// ─── ترميز العناوين (RFC 2047) ───────────────────────────────────────────────
//  العربية في Subject و From لا تمر كما هي — تُرمَّز encoded-word، وكل كلمة
//  مرمَّزة يجب ألا تتجاوز 75 محرفاً فنقسّمها على حدود المحارف لا البايتات
//  (القسمة داخل محرف UTF-8 تُنتج مربعات سوداء في صندوق المستلم).
function encodeWord(str) {
  const s = String(str || '');
  if (!s) return '';
  if (!/[^\x20-\x7E]/.test(s)) return s;

  const PRE = '=?UTF-8?B?', SUF = '?=';
  const MAX_BYTES = Math.floor((75 - PRE.length - SUF.length) / 4) * 3;

  const parts = [];
  let cur = Buffer.alloc(0);
  for (const ch of s) {
    const b = Buffer.from(ch, 'utf8');
    if (cur.length + b.length > MAX_BYTES) { parts.push(cur); cur = Buffer.alloc(0); }
    cur = Buffer.concat([cur, b]);
  }
  if (cur.length) parts.push(cur);
  return parts.map(p => PRE + p.toString('base64') + SUF).join(CRLF + ' ');
}

const b64lines = (str) => (Buffer.from(str, 'utf8').toString('base64').match(/.{1,76}/g) || []).join(CRLF);

// RFC 5322: "Tue, 18 Aug 2026 13:05:00 +0000"
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function rfcDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONS[d.getUTCMonth()]} ${d.getUTCFullYear()} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

// ─── بناء الرسالة ────────────────────────────────────────────────────────────
function buildMime({ from, fromName, to, replyTo, subject, text, html }) {
  const boundary = 'artal_' + crypto.randomBytes(12).toString('hex');
  const domain = from.split('@')[1] || 'localhost';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;

  const headers = [
    `From: ${encodeWord(fromName)} <${from}>`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeWord(subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${rfcDate()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  // base64 للجزأين: يعبر أي خادم دون قلق من طول السطر أو ترميز 8-bit
  const body = [
    '', `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', b64lines(text || ''),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', b64lines(html || ''),
    `--${boundary}--`, '',
  ];

  return { messageId, data: headers.concat(body).join(CRLF) };
}

// ─── حوار SMTP ───────────────────────────────────────────────────────────────
/**
 * غلاف بسيط: كل أمر يُرسل ثم يُنتظر ردّ مكتمل. الردّ يكتمل عند سطر بصيغة
 * "250 نص" (مسافة) — بينما "250-نص" (شرطة) يعني أن هناك المزيد.
 */
function makeSession(socket) {
  let buf = '';
  let waiter = null;

  const feed = () => {
    if (!waiter) return;
    const m = buf.match(/^\d{3} [^\r\n]*\r\n/m);
    if (!m) return;
    const idx = buf.indexOf(m[0]) + m[0].length;
    const reply = buf.slice(0, idx);
    buf = buf.slice(idx);
    const w = waiter; waiter = null;
    clearTimeout(w.timer);
    w.resolve({ code: parseInt(reply.slice(0, 3), 10), text: reply.trim() });
  };

  socket.setEncoding('utf8');
  socket.on('data', (d) => { buf += d; feed(); });
  socket.on('error', (e) => {
    if (waiter) { clearTimeout(waiter.timer); const w = waiter; waiter = null; w.reject(new SmtpError(e.message, 'NETWORK')); }
  });
  socket.on('close', () => {
    if (waiter) { clearTimeout(waiter.timer); const w = waiter; waiter = null; w.reject(new SmtpError('أُغلق الاتصال قبل اكتمال الرد', 'NETWORK')); }
  });

  const read = () => new Promise((resolve, reject) => {
    waiter = { resolve, reject, timer: setTimeout(() => {
      waiter = null; reject(new SmtpError('انتهت مهلة انتظار رد الخادم', 'TIMEOUT'));
    }, REPLY_TIMEOUT) };
    feed();
  });

  /** يُرسل أمراً ويتحقق أن رمز الرد ضمن المتوقَّع، وإلا يرمي برسالة الخادم */
  const cmd = async (line, expect, { secret = false } = {}) => {
    if (line !== null) socket.write(line + CRLF);
    const r = await read();
    if (!expect.includes(r.code)) {
      const shown = secret ? '(بيانات دخول)' : String(line).slice(0, 40);
      throw new SmtpError(`رفض الخادم عند ${shown}: ${r.text}`, r.code === 535 ? 'AUTH' : 'SMTP', r);
    }
    return r;
  };

  return { read, cmd };
}

function connect({ host, port }) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(new SmtpError(`تعذّر الاتصال بـ ${host}:${port} — ${e.message}`, 'NETWORK'));
    // 465 = TLS ضمني من أول بايت. 587 = اتصال عادي ثم ترقية STARTTLS.
    const sock = port === 465
      ? tls.connect({ host, port, servername: host, timeout: CONNECT_TIMEOUT }, () => resolve(sock))
      : net.connect({ host, port, timeout: CONNECT_TIMEOUT }, () => resolve(sock));
    sock.once('error', onErr);
    sock.once('timeout', () => { sock.destroy(); onErr(new Error('انتهت مهلة الاتصال')); });
  });
}

function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners('data');
    const sec = tls.connect({ socket, servername: host }, () => resolve(sec));
    sec.once('error', (e) => reject(new SmtpError(`فشلت ترقية STARTTLS: ${e.message}`, 'NETWORK')));
  });
}

/**
 * يفتح جلسة مصادَقة جاهزة للإرسال ويُعيد { socket, session }.
 * المُنادي مسؤول عن إغلاق الـ socket.
 */
async function openAuthenticated() {
  const c = cfg();
  if (!isConfigured()) throw new SmtpError('إعدادات SMTP غير مكتملة', 'CONFIG');

  let socket = await connect(c);
  let S = makeSession(socket);
  const ehlo = `EHLO ${(c.user.split('@')[1] || 'localhost')}`;

  await S.cmd(null, [220]);                       // ترحيب الخادم
  await S.cmd(ehlo, [250]);

  if (c.port !== 465) {
    await S.cmd('STARTTLS', [220]);
    socket = await upgrade(socket, c.host);
    S = makeSession(socket);
    await S.cmd(ehlo, [250]);                     // إعادة EHLO إلزامية بعد الترقية
  }

  await S.cmd('AUTH LOGIN', [334]);
  await S.cmd(Buffer.from(c.user, 'utf8').toString('base64'), [334], { secret: true });
  await S.cmd(Buffer.from(c.pass, 'utf8').toString('base64'), [235], { secret: true });

  return { socket, session: S, cfg: c };
}

const quiet = (socket) => { try { socket.end(); } catch (_) {} try { socket.destroy(); } catch (_) {} };

/**
 * @param {{to:string, subject:string, html:string, text:string, replyTo?:string}} msg
 * @returns {{messageId:string, accepted:string[]}}
 */
async function sendMail({ to, subject, html, text, replyTo }) {
  const dest = String(to || '').trim();
  if (!dest) throw new SmtpError('لا يوجد مستلم', 'CONFIG');

  const { socket, session: S, cfg: c } = await openAuthenticated();
  try {
    const { messageId, data } = buildMime({
      from: c.user, fromName: c.fromName, to: dest,
      replyTo: replyTo || c.user, subject, text, html,
    });

    await S.cmd(`MAIL FROM:<${c.user}>`, [250]);
    await S.cmd(`RCPT TO:<${dest}>`, [250, 251]);
    await S.cmd('DATA', [354]);

    // dot-stuffing: سطر يبدأ بنقطة يُضاعَف وإلا فُسِّر كنهاية الرسالة
    const safe = data.replace(/\r\n\./g, '\r\n..');
    socket.write(safe + CRLF + '.' + CRLF);
    await S.cmd(null, [250]);

    try { await S.cmd('QUIT', [221]); } catch (_) { /* الرسالة قُبلت — الوداع تفصيل */ }
    return { messageId, accepted: [dest] };
  } finally {
    quiet(socket);
  }
}

// فحص المصادقة دون إرسال شيء — لزر «اختبار الاتصال»
async function verify() {
  const { socket, session: S } = await openAuthenticated();
  try { await S.cmd('QUIT', [221]); } catch (_) {}
  quiet(socket);
  return true;
}

// أُبقيت للتوافق — لا اتصال مخزَّناً بعد الآن (كل إرسال جلسة مستقلة)
function resetTransport() {}

module.exports = { SmtpError, isConfigured, status, sendMail, verify, resetTransport };
