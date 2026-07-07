/* تتبّع مصدر أول زيارة (first-touch): من أين جاء المتقدّم.
   يُخزَّن في كوكي 30 يوماً، ويملأ حقول النموذج المخفية عند التقديم. */
(function () {
  var KEY = 'artal_attr';

  function getCookie(n) {
    var m = document.cookie.match('(^|;)\\s*' + n + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : null;
  }
  function setCookie(n, v, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 864e5);
    document.cookie = n + '=' + encodeURIComponent(v) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  }

  // ── 1) التقاط أول زيارة فقط (لا نغيّرها لاحقاً = نسب للمصدر الأول)
  if (!getCookie(KEY)) {
    var params = new URLSearchParams(location.search);
    var ref = document.referrer || '';
    var host = '';
    try { host = ref ? new URL(ref).hostname.replace(/^www\./, '') : ''; } catch (e) {}
    var utm = params.get('utm_source');
    var source;
    if (utm) source = utm.slice(0, 40);
    else if (!ref) source = 'مباشر';
    else if (/(^|\.)google\./.test(host)) source = 'بحث جوجل';
    else if (/(bing|yahoo|duckduckgo|yandex|ecosia)\./.test(host)) source = 'محرك بحث آخر';
    else if (/t\.me|telegram/.test(host)) source = 'تيليجرام';
    else if (/instagram/.test(host)) source = 'إنستقرام';
    else if (/(twitter|x\.com|t\.co)/.test(host)) source = 'X (تويتر)';
    else if (/(facebook|fb\.)/.test(host)) source = 'فيسبوك';
    else if (/snapchat|snap\./.test(host)) source = 'سناب شات';
    else if (/linkedin|lnkd/.test(host)) source = 'لينكدإن';
    else if (/(youtube|youtu\.be)/.test(host)) source = 'يوتيوب';
    else if (/tiktok/.test(host)) source = 'تيك توك';
    else if (/(whatsapp|wa\.me)/.test(host)) source = 'واتساب';
    else if (/artalsecurity\.com/.test(host)) source = 'الموقع الرئيسي';
    else source = host || 'أخرى';

    setCookie(KEY, JSON.stringify({
      source: source,
      referrer: ref.slice(0, 255),
      landing: (location.pathname + location.search).slice(0, 255)
    }), 30);
  }

  // ── 2) ملء حقول النموذج المخفية إن وُجدت (صفحة التقديم)
  function fill() {
    var raw = getCookie(KEY);
    if (!raw) return;
    var d; try { d = JSON.parse(raw); } catch (e) { return; }
    var set = function (id, v) { var el = document.getElementById(id); if (el) el.value = v || ''; };
    set('f-source', d.source);
    set('f-referrer', d.referrer);
    set('f-landing', d.landing);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  else fill();
})();
