/**
 * netDiag.js — تشخيص الاتصال الخارجي من خادم التطبيق نفسه.
 *
 * السؤال الذي يجيب عنه: حين تفشل المزامنة أو إرسال القوالب «بانتهاء المهلة»،
 * هل العطل في خروج الطلبات من هذا الخادم، أم في الخادم الهدف؟ لا يمكن معرفة
 * ذلك من جهاز المطوّر (الهدف يرد عليه) ولا من رسالة التطبيق (كل فشل شبكي
 * يُطبع «انتهت المهلة»). لذلك يُفكَّك الطلب هنا إلى طبقاته ويُقاس كلٌّ على حدة:
 *
 *   DNS (lookup كما يفعل fetch + resolve4 مباشرة) → TCP:443 → TLS → HTTP
 *
 * وتُقارن الأهداف الفعلية (artalsys، Chatwoot) بأهداف مرجعية (Google، Wappi)
 * وعنوان الخروج (ipify): فشل الكل = الخادم لا يخرج أصلاً، فشل الهدفين فقط =
 * الهدفان (أو جدار ناريّ بينهما) يرفضان عنوان هذا الخادم.
 *
 * ⚠️ لا يطبع أي سر — أسماء الترويسات فقط. ولا يرمي: كل طبقة تعيد ok/خطأ.
 */

const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const STEP_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 10000;

const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

// الخطأ كما يراه النظام: الاسم والرمز (ENOTFOUND/ECONNREFUSED/ETIMEDOUT…) وسببه إن وُجد
function describeError(e) {
  // undici يغلّف فشل الاتصال في cause، وقد يكون AggregateError (محاولة لكل عنوان)
  let cause = e?.cause;
  if (cause && Array.isArray(cause.errors) && cause.errors.length) cause = cause.errors[0];
  // Node 24: سبب «fetch failed» خطأ عادي بلا code — الرمز في نص الرسالة فقط
  const fromText = String(cause?.message || e?.message || '').match(/\b(E[A-Z]{3,}|CERT_[A-Z_]+|UNABLE_[A-Z_]+|SELF_SIGNED[A-Z_]*)\b/)?.[1] || null;
  return {
    name: e?.name || 'Error',
    code: e?.code || cause?.code || fromText,
    errno: e?.errno ?? cause?.errno ?? null,
    syscall: e?.syscall || cause?.syscall || null,
    message: String(e?.message || e),
    cause: cause ? String(cause.message || cause) : null,
  };
}

async function withTimeout(promise, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${label} timeout`), { code: 'STEP_TIMEOUT' })), STEP_TIMEOUT_MS); });
  try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

async function stepDnsLookup(host) {
  const t0 = process.hrtime.bigint();
  try {
    const r = await withTimeout(dns.lookup(host, { all: true }), 'lookup');
    return { ok: true, ms: ms(t0), addresses: r.map(a => `${a.address}/v${a.family}`) };
  } catch (e) { return { ok: false, ms: ms(t0), error: describeError(e) }; }
}

async function stepDnsResolve4(host) {
  const t0 = process.hrtime.bigint();
  try {
    const r = await withTimeout(dns.resolve4(host), 'resolve4');
    return { ok: true, ms: ms(t0), addresses: r };
  } catch (e) { return { ok: false, ms: ms(t0), error: describeError(e) }; }
}

function stepTcp(host, port) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host, port });
    const done = (out) => { sock.destroy(); resolve({ ms: ms(t0), ...out }); };
    sock.setTimeout(STEP_TIMEOUT_MS, () => done({ ok: false, error: { code: 'ETIMEDOUT', message: 'tcp connect timeout' } }));
    sock.once('connect', () => done({ ok: true, remote: `${sock.remoteAddress}:${sock.remotePort}`, local: sock.localAddress }));
    sock.once('error', (e) => done({ ok: false, error: describeError(e) }));
  });
}

function stepTls(host, port) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    // SNI بالاسم فقط — عنوان IP كـ servername مرفوض في RFC 6066 ويطبع تحذيراً
    const sock = tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }) });
    const done = (out) => { sock.destroy(); resolve({ ms: ms(t0), ...out }); };
    sock.setTimeout(STEP_TIMEOUT_MS, () => done({ ok: false, error: { code: 'ETIMEDOUT', message: 'tls handshake timeout' } }));
    sock.once('secureConnect', () => done({
      ok: true, protocol: sock.getProtocol(), authorized: sock.authorized,
      authError: sock.authorizationError ? String(sock.authorizationError) : null,
      certSubject: sock.getPeerCertificate()?.subject?.CN || null,
      certExpires: sock.getPeerCertificate()?.valid_to || null,
    }));
    sock.once('error', (e) => done({ ok: false, error: describeError(e) }));
  });
}

async function stepHttp(url, headers) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: 'manual' });
    const body = await res.text().catch(() => '');
    return {
      ok: true, ms: ms(t0), status: res.status,
      server: res.headers.get('server') || null,
      contentType: res.headers.get('content-type') || null,
      bodyHead: body.slice(0, 160),
    };
  } catch (e) { return { ok: false, ms: ms(t0), error: describeError(e) }; }
}

async function probe(target) {
  const u = new URL(target.url);
  const host = u.hostname;
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const t0 = process.hrtime.bigint();

  // الطبقات مستقلة عمداً: فشل DNS لا يمنع محاولة TCP على الاسم (قد ينجح عبر
  // محلّل آخر)، وفشل TLS لا يمنع HTTP — كلٌّ يحكي ما رآه
  const [lookup, resolve4, tcp, tlsStep, http] = await Promise.all([
    stepDnsLookup(host),
    stepDnsResolve4(host),
    stepTcp(host, port),
    u.protocol === 'https:' ? stepTls(host, port) : Promise.resolve({ ok: null, skipped: true }),
    stepHttp(target.url, target.headers || {}),
  ]);

  const expected = target.expectStatus ? http.ok && target.expectStatus.includes(http.status) : http.ok;
  return {
    name: target.name,
    role: target.role,
    url: `${u.origin}${u.pathname}`,
    headersSent: Object.keys(target.headers || {}),
    verdict: expected ? 'ok' : (http.ok ? 'unexpected_status' : (tcp.ok ? 'http_failed' : (lookup.ok ? 'tcp_failed' : 'dns_failed'))),
    totalMs: ms(t0),
    dnsLookup: lookup,
    dnsResolve4: resolve4,
    tcp,
    tls: tlsStep,
    http,
  };
}

function targets() {
  const list = [];

  const artalBase = String(process.env.ARTALSYS_URL || 'https://artalsys.com').replace(/\/$/, '');
  list.push({
    name: 'artalsys', role: 'target',
    url: `${artalBase}/api/employees/check-national-id?national_id=1000000000`,
    headers: { 'X-Secret': process.env.EXT_API_SECRET || 'artal@NID%2026', Accept: 'application/json' },
    expectStatus: [200],
  });

  const cwHost = String(process.env.CHATWOOT_HOST || '').trim().replace(/\/+$/, '');
  if (cwHost) {
    const acct = String(process.env.CHATWOOT_ACCOUNT_ID || '').trim();
    list.push({
      name: 'chatwoot', role: 'target',
      url: `${cwHost}/api/v1/accounts/${acct}/inboxes`,
      headers: { api_access_token: String(process.env.CHATWOOT_API_TOKEN || '').trim(), Accept: 'application/json' },
      expectStatus: [200],
    });
  }

  // مراجع: إنترنت عام لا علاقة له بخوادمنا. Google تستخدمه المقابلات (Meet)
  // فعلاً، وCloudflare/ipify يكشفان عنوان الخروج الذي يراه الهدف — وهو ما
  // يُدرج في القائمة البيضاء لجدار الهدف إن تبيّن أنه يحجبنا
  list.push({ name: 'googleapis', role: 'control', url: 'https://www.googleapis.com/discovery/v1/apis', expectStatus: [200] });
  list.push({ name: 'cloudflare', role: 'control', url: 'https://www.cloudflare.com/cdn-cgi/trace', expectStatus: [200] });
  list.push({ name: 'egress-ip', role: 'control', url: 'https://api.ipify.org/?format=json', expectStatus: [200] });

  return list;
}

/** تشغيل كل الفحوص بالتوازي — يكتمل خلال ~10 ثوانٍ حتى لو علّق كل شيء */
async function run() {
  const t0 = process.hrtime.bigint();
  const results = await Promise.all(targets().map(probe));

  const egress = results.find(r => r.name === 'egress-ip');
  let egressIp = null;
  try { egressIp = JSON.parse(egress?.http?.bodyHead || '{}').ip || null; } catch (e) { /* ليس JSON */ }

  const targetsOk = results.filter(r => r.role === 'target').every(r => r.verdict === 'ok');
  const controlsOk = results.filter(r => r.role === 'control').some(r => r.verdict === 'ok');
  const summary = targetsOk ? 'all_targets_reachable'
    : (controlsOk ? 'targets_blocked_but_internet_ok' : 'no_outbound_at_all');

  return {
    at: new Date().toISOString(),
    totalMs: ms(t0),
    summary,
    egressIp,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    proxyEnv: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
      .filter(k => process.env[k]).map(k => [k, process.env[k]])),
    dnsServers: (() => { try { return require('dns').getServers(); } catch (e) { return []; } })(),
    results,
  };
}

module.exports = { run, probe, targets };
