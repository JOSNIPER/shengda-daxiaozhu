/* 达小助 · APK 内置数据层
   ------------------------------------------------------------------
   网页版靠电脑上的 bridge.py 代登录（手机浏览器不许跨域、不许混合内容）。
   APK 里没有电脑，所以这套逻辑跟着 App 一起装进手机：

     Java 侧  Android.req(...)      只负责「发 HTTP + 带 cookie」这一件事
     本文件   登录 / 抓页面 / 解析    全部在这里，纯 JS，逻辑和 eams.py 一一对应

   为什么不让 Java 也解析 HTML：WebView 里有 DOMParser，表格按表头名字取列
   比正则稳得多，而且解析逻辑只维护一份（eams.py 是参照基准，两边有对照测试）。

   🔴 对外暴露的 `NativeApi.handle(path, body)` 必须和 bridge.py 的 /api 契约
     完全一致，否则 app.js 里那句 `api()` 就得写两套分支。
     契约见 bridge.py 的 do_GET / do_POST。
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  // 网页版没有 Android 桥，直接不加载（同一个 app.js 两边共用）
  if (!window.Android || typeof window.Android.req !== 'function') return;

  // 🔴 达小助改造（W3）：BASE 只作「相对路径」兜底 —— Kingo 段一律发绝对地址。
  var BASE = 'https://jw.shengda.edu.cn:8090';
  var UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

  // 两次请求之间的最小间隔（毫秒）。别把学校服务器打疼 ——
  // 和 eams.py 的 POLITE_DELAY 保持一致，别单方面调小。
  var POLITE_MS = 1200;
  var lastReq = 0;

  // 🔴 达小助改造（W3）：教务请求一律发**绝对地址**（升达 CAS/门户/青果三台主机）。
  //    BASE 兜底已改 jw.shengda；原生层按响应头 charset 解码，GBK 表格不再乱码。

  // ------------------------------------------------------------------ 达小助配置（W3）
  /* 单一真源 = app/config/shengda.json。构建时由 build_apk.py 的 stage_assets
     把该文件拷成 assets/web/config.json；运行时 fetch 本地 config.json，
     失败则退回下面这份**内置副本**（与 shengda.json 同步维护，
     _setup/check_track_parity.py 会比对两者防漂移）。
     🔴 2026-11-03 校内 HAR 实测后重写：本校不走 DataTable.jsp，
     课表/成绩各自是独立 jsp，menucode 也是实测值（S20301 / S40303）。 */
  var CFG_DEFAULT = {
    cas: {
      base: 'https://cas.shengda.edu.cn/lyuapServer',
      portal: 'https://my.shengda.edu.cn/',
      tickets_path: '/v1/tickets',
      kaptcha_path: '/kaptcha'
    },
    jw: {
      base: 'https://jw.shengda.edu.cn:8090',
      cas_service: 'http://jw.shengda.edu.cn:8090/caslogin',
      home_path: '/frame/homes.action',
      menu_context_path: '/frame/normalusemenu/getBreadcrumbsInfoNew.action',
      droplist_path: '/frame/droplist/getDropLists.action',
      term_path: '/jw/common/showYearTerm.action',
      data_table_path: '/taglib/DataTable.jsp',
      polite_delay_sec: 0.35
    },
    pages: {
      timetable: {
        kind: 'kbt', path: '/student/wsxk.xskcb10319.jsp', menucode: 'S20301',
        params_b64: 'xn={xn}&xq={xq}&xh={xh}'
      },
      score: {
        kind: 'stuckcj', path: '/student/xscj.stuckcj.jsp',
        data_path: '/student/xscj.stuckcj_data.jsp', menucode: 'S40303',
        body: {
          sjxz: 'sjxz1', ysyx: 'yxcj', zx: '1', fx: '1', wz: '0',
          btnExport: '导出', ysyxS: 'on', sjxzS: 'on', zxC: 'on',
          fxC: 'on', xsjd: '1'
        }
      },
      exam: { kind: 'unsupported' },
      free_room: { kind: 'unsupported' },
      profile: { kind: 'from_kbt' }
    },
    column_map: { timetable: {}, score: {}, exam: {}, free_room: {}, profile: {} },
    timetable: { unit_count: null },
    semester: { total_weeks: null },
    free_room: { max_periods: null },
    chaoxing: { fid: null },
    update: { page_base: 'https://johan.ccwu.cc/daxiaozhu', github_user: 'TBD-github-user', enabled: false }
  };

  var CFG = CFG_DEFAULT;
  (function loadCfg() {
    try {
      fetch('config.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && j.jw && j.pages) CFG = j; })
        .catch(function () { /* 用内置副本 */ });
    } catch (e) { /* 用内置副本 */ }
  })();

  function cfgUrl(u) { return String(u || '').replace(/\/+$/, ''); }

  /* 🔴 域名硬白名单 —— 三个请求出口（http / pfHttp / cxHttp）共用的一道闸。
   *
   *  为什么要有它：底座是从郑航改来的，代码里还残留着郑航门户、公告站、
   *  找回密码这些外部地址。只要有一条路径忘了停用，用户输进去的学号密码
   *  就发到**别的学校**的服务器上去了。红线是「凭据只在本机与本校之间流动」，
   *  这种事不能靠「我记得停用了」，得在发出去之前拦一道。
   *
   *  白名单是**从 CFG 现算**的，不是写死的域名 —— 这样 config.json 指向
   *  内网 mock（W6 调试包）时照样放行，换成正式域名也不用改这段代码。
   *  学习通按 *.chaoxing.com 整段放行：它的子域有 passport2 / mooc1 /
   *  mooc2-ans / mobilelearn 四五个，逐个列反而容易漏。
   */
  function hostOf(u) {
    var m = /^https?:\/\/([^\/?#:]+)/i.exec(String(u || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function allowHosts() {
    var hs = [];
    function add(u) { var h = hostOf(u); if (h && hs.indexOf(h) < 0) hs.push(h); }
    add(CFG.cas && CFG.cas.base);
    add(CFG.cas && CFG.cas.portal);
    add(CFG.jw && CFG.jw.base);
    add(CFG.jw && CFG.jw.cas_service);
    return hs;
  }

  /** 放行就原样返回 url（相对路径仍然交给原生拼 BASE），否则抛错。 */
  function guardUrl(url) {
    var s = String(url || '');
    // 相对路径 = 拼在教务 BASE 上发的，按 BASE 的域名判定
    var host = /^https?:\/\//i.test(s) ? hostOf(s) : hostOf(CFG.jw && CFG.jw.base);
    if (!host) throw new Error('已拦截：请求地址解析不出域名');
    var hs = allowHosts();
    for (var i = 0; i < hs.length; i++) if (hs[i] === host) return s;
    if (/(^|\.)chaoxing\.com$/i.test(host)) return s;
    throw new Error('已拦截：' + host + ' 不在本校白名单内（凭据不会发往第三方）');
  }

  // ------------------------------------------------------------------ 工具

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }

  /** SHA-1，输出小写十六进制。
   *
   *  为什么自己写：教务系统把密码算成 SHA1('<salt>-' + 明文)，而 WebView 里
   *  crypto.subtle 只对「安全上下文」开放，还不支持同步调用 —— 登录流程是
   *  一串同步判断，用异步 digest 会把代码拧成一团。这 40 行是标准实现，
   *  有单测对照 Python 的 hashlib 结果。
   */
  function sha1hex(str) {
    var bytes = utf8Bytes(str);
    var ml = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // 长度按 64 位大端追加（JS 里用两个 32 位拼）
    var hi = Math.floor(ml / 0x100000000);
    var lo = ml >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var w = new Array(80);
    var i, j, a, b, c, d, e, f, k, t;

    for (i = 0; i < bytes.length; i += 64) {
      for (j = 0; j < 16; j++) {
        w[j] = (bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) |
               (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3];
      }
      for (j = 16; j < 80; j++) {
        t = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
        w[j] = (t << 1) | (t >>> 31);
      }
      a = h0; b = h1; c = h2; d = h3; e = h4;
      for (j = 0; j < 80; j++) {
        if (j < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
      h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }

    function hex(x) {
      // >>> 0 之后再补 8 位，否则负数会输出成 "-1f..."
      return ('00000000' + (x >>> 0).toString(16)).slice(-8);
    }
    return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
  }

  // ------------------------------------------------------------------ HTTP

  var seq = 0;
  var waiting = {};

  /** Java 侧网络请求完成后回调进来（见 MainActivity 的 __nativeDone）。 */
  window.__nativeDone = function (id, json) {
    var p = waiting[id];
    if (!p) return;
    delete waiting[id];
    try {
      p.resolve(JSON.parse(json));
    } catch (e) {
      p.reject(new Error('App 内部通信出错了，请重试'));
    }
  };

  /** 发一个请求。method: 'GET'|'POST'；path 以 / 开头；body 是已编码的表单串。
   *
   *  🔴 必须走异步：Android.req 是阻塞的，直接在 JS 线程上同步调用会把
   *     整个界面冻住 —— 登录加同步要十来秒，转圈动画都不动，看着就是死机。
   *
   *  gapMs：两次请求之间至少隔多久。默认 POLITE_MS（1.2 秒），那是为了
   *     别把**同一个**教务系统打疼。校园公告是 6 个不同域名的公开静态页，
   *     一次抓 6 个还各等 1.2 秒就是七秒多的白等，所以那边传小值。
   */
  function http(method, path, body, referer, gapMs, headers) {
    return new Promise(function (resolve, reject) {
      try { guardUrl(path); } catch (e) { reject(e); return; }
      var polite = gapMs == null ? POLITE_MS : gapMs;
      var gap = Date.now() - lastReq;
      var wait = gap < polite ? polite - gap : 0;
      setTimeout(function () {
        var id = ++seq;
        waiting[id] = { resolve: resolve, reject: reject };
        try {
          if (headers && typeof Android.req2 === 'function') {
            Android.req2(id, method, path, body || '', referer || '', JSON.stringify(headers));
          } else {
            Android.req(id, method, path, body || '', referer || '');
          }
        } catch (e) {
          delete waiting[id];
          reject(new Error('原生请求失败：' + e));
        }
        lastReq = Date.now();
      }, wait);
    });
  }

  function form(obj) {
    return Object.keys(obj).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] == null ? '' : obj[k]);
    }).join('&');
  }

  // ------------------------------------------------------------------ HTML 表格

  /** 单元格文字。`<br>` 要变成换行 —— 教务系统拿它分隔多行内容
   *  （比如一个格子里排两个上课时间），拍平成一串就分不开了。 */
  function cellText(td) {
    var c = td.cloneNode(true);
    var brs = c.querySelectorAll('br');
    for (var i = 0; i < brs.length; i++) {
      brs[i].parentNode.replaceChild(document.createTextNode('\n'), brs[i]);
    }
    return (c.textContent || '').replace(/[ \t\r\f\v\u00a0]+/g, ' ').trim();
  }

  /** 页面里所有表格 → [ [ [cell, ...], ... ], ... ]，等价于 eams.parse_tables。
   *  table.rows 不含嵌套表格的行，正好和 Python 那份 HTMLParser 的行为一致。 */
  function tablesOf(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var ts = doc.querySelectorAll('table');
    var out = [];
    for (var i = 0; i < ts.length; i++) {
      var rows = [];
      var rs = ts[i].rows;
      for (var r = 0; r < rs.length; r++) {
        var cells = [];
        for (var c = 0; c < rs[r].cells.length; c++) cells.push(cellText(rs[r].cells[c]));
        rows.push(cells);
      }
      out.push(rows);
    }
    return out;
  }

  // ------------------------------------------------------------------ 课表解析

  function splitJsArgs(src) {
    var out = [], cur = '', quote = null;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (quote) {
        if (c === '\\') { cur += src.substr(i, 2); i++; continue; }
        if (c === quote) quote = null;
        cur += c;
      } else if (c === '"' || c === "'") {
        quote = c; cur += c;
      } else if (c === ',') {
        out.push(cur.trim()); cur = '';
      } else {
        cur += c;
      }
    }
    if (cur) out.push(cur.trim());
    return out;
  }

  function unquote(tok) {
    tok = (tok || '').trim();
    if (tok.length >= 2 && tok[0] === tok[tok.length - 1] && (tok[0] === '"' || tok[0] === "'")) {
      return tok.slice(1, -1);
    }
    return tok;
  }

  /** 算 `index = 2*unitCount+6;` 这种式子。
   *
   *  不用 eval：页面内容来自学校服务器，哪怕只是算术式，也没必要给一条
   *  执行代码的路。这里手写一个只认 数字 + - * ( ) 的递归下降求值器。
   *  字符集不合法（比如 `units*i+j` 这种模板残留）一律返回 null —— 和
   *  eams._eval_index 的判据一致。
   */
  function evalIndex(expr, unit) {
    var src = String(expr).replace(/unitCount/g, String(unit)).replace(/\s+/g, '');
    if (!/^[0-9*+\-()]+$/.test(src)) return null;
    var i = 0;
    function peek() { return src[i]; }
    function number() {
      var st = i;
      while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
      return i > st ? parseInt(src.slice(st, i), 10) : NaN;
    }
    function factor() {
      // 一元负号：教务系统偶尔给 `index = -1;` 这种（表示「没排进格子」），
      // 解析成 -1 交给调用方过滤，别在这里就丢掉 —— 和 eams._eval_index 保持一致。
      if (peek() === '-') { i++; return -factor(); }
      if (peek() === '+') { i++; return factor(); }
      if (peek() === '(') { i++; var v = exprSum(); if (peek() === ')') i++; return v; }
      return number();
    }
    function term() {
      var v = factor();
      while (peek() === '*') { i++; v *= factor(); }
      return v;
    }
    function exprSum() {
      var v = term();
      while (peek() === '+' || peek() === '-') {
        var op = src[i]; i++;
        var r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    var val = exprSum();
    if (i !== src.length || !isFinite(val)) return null;
    return Math.trunc(val);
  }

  function parseTimetable(html) {
    var m = /unitCount\s*=\s*(\d+)/.exec(html);
    var unitCount = m ? parseInt(m[1], 10) : 10;

    // 🔴 学期周次范围来自 `table0.marshalTable(2, 1, 24)`，不是「最后一门课的周次」。
    //    郑航实测最后一门只排到第 18 周，而学期有 24 周 —— 取后者会让周次
    //    选择器翻不到第 19 周以后，后半个学期的课直接看不见。
    var weekStart = 1, weekEnd = 0;
    var mw = /marshalTable\s*\(\s*\d+\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(html);
    if (mw) { weekStart = parseInt(mw[1], 10); weekEnd = parseInt(mw[2], 10); }

    var events = [], actSpans = [], mm;
    var actRe = /new\s+TaskActivity\(([\s\S]*?)\)\s*;/g;
    while ((mm = actRe.exec(html)) !== null) {
      events.push({ pos: mm.index, kind: 'act', payload: mm[1] });
      actSpans.push({ start: mm.index, end: mm.index + mm[0].length });
    }
    var idxRe = /index\s*=\s*([^;]+);/g;
    while ((mm = idxRe.exec(html)) !== null) {
      events.push({ pos: mm.index, kind: 'idx', payload: mm[1] });
    }
    events.sort(function (a, b) {
      return (a.pos - b.pos) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
    });

    // 教师名不是字面量，而是 actTeacherName.join(',')。每个活动前面紧挨着一段
    // `var actTeachers = [{id:..,name:"徐璐",lab:false}];`。
    // 只能按「上一个活动结束 → 本活动开始」切片去找，全局搜会张冠李戴。
    var teacherOf = {};
    var prevEnd = 0;
    actSpans.forEach(function (sp) {
      var chunk = html.slice(prevEnd, sp.start);
      var last = null, m2;
      var tRe = /actTeachers\s*=\s*\[([\s\S]*?)\]\s*;/g;
      while ((m2 = tRe.exec(chunk)) !== null) last = m2[1];
      if (last != null) {
        var names = [], nRe = /name:\s*"([^"]*)"/g, nm;
        while ((nm = nRe.exec(last)) !== null) names.push(nm[1]);
        // 去重但保序（dict.fromkeys 的等价写法）
        var seen = {}, uniq = [];
        names.forEach(function (n) {
          if (n && !seen[n]) { seen[n] = 1; uniq.push(n); }
        });
        teacherOf[sp.start] = uniq.join(',');
      }
      prevEnd = sp.end;
    });

    var raw = [], cur = null;
    events.forEach(function (ev) {
      if (ev.kind === 'act') {
        var args = splitJsArgs(ev.payload);
        if (args.length < 7) { cur = null; return; }
        var bits = unquote(args[6]);
        // 🔴 位图下标**就是周次本身**（第 0 位恒为 0）。按 i+1 算会整体偏一周。
        var weeks = [];
        for (var i = 0; i < bits.length; i++) if (bits[i] === '1' && i >= 1) weeks.push(i);
        var full = unquote(args[3]);
        var nm2 = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(full);
        cur = {
          name: (nm2 ? nm2[1] : full).trim(),
          code: (nm2 ? nm2[2] : '').trim(),
          teacher: teacherOf[ev.pos] != null ? teacherOf[ev.pos] : unquote(args[1]),
          room: unquote(args[5]),
          weeks: weeks,
          slots: [],
        };
        raw.push(cur);
        return;
      }
      if (!cur) return;
      var idx = evalIndex(ev.payload, unitCount);
      if (idx == null || idx < 0) return;
      var day = Math.floor(idx / unitCount), period = idx % unitCount;
      if (day >= 0 && day < 7 && period >= 0 && period < unitCount) {
        var dup = cur.slots.some(function (s) { return s.day === day && s.period === period; });
        if (!dup) cur.slots.push({ day: day, period: period });
      }
    });

    // 「停课」是调课记录，不是真上课，别画到格子里
    raw.forEach(function (c) { if (c.room === '停课') c.slots = []; });

    // 同一门课（同名/同教师/同教室/同周次）合并
    var merged = {}, order = [];
    raw.forEach(function (c) {
      if (!c.slots.length) return;
      var key = [c.name, c.code, c.teacher, c.room, c.weeks.join(',')].join('\u0001');
      if (merged[key]) {
        c.slots.forEach(function (s) {
          var dup = merged[key].slots.some(function (x) { return x.day === s.day && x.period === s.period; });
          if (!dup) merged[key].slots.push(s);
        });
      } else {
        merged[key] = c;
        order.push(key);
      }
    });

    var courses = order.map(function (k) { return merged[k]; });
    courses.sort(function (a, b) {
      return (a.slots[0].day - b.slots[0].day) || (a.slots[0].period - b.slots[0].period);
    });

    var maxWeek = 0;
    courses.forEach(function (c) {
      if (c.weeks.length) maxWeek = Math.max(maxWeek, Math.max.apply(null, c.weeks));
    });
    var totalWeeks = Math.max(weekEnd, maxWeek);

    // 学期名从课程序号里推：26271.MK00001A.001 → 2026-2027 学年第 1 学期
    var semester = '';
    for (var ci = 0; ci < courses.length; ci++) {
      var sm = /^(\d{2})(\d{2})(\d)\./.exec(courses[ci].code);
      if (sm) {
        semester = '20' + sm[1] + '-20' + sm[2] + ' 学年第 ' + sm[3] + ' 学期';
        break;
      }
    }

    return {
      unitCount: unitCount,
      courses: courses,
      totalWeeks: totalWeeks,
      weekStart: weekStart,
      semester: semester,
    };
  }

  // ------------------------------------------------------------------ 成绩 / 学籍 / 考试

  function parseGrades(html) {
    var tables = tablesOf(html);
    var summary = [], detail = [];
    tables.forEach(function (rows) {
      rows.forEach(function (r) {
        if (r.length === 5 && /^\d{4}-\d{4}$/.test(r[0] || '')) {
          summary.push({ year: r[0], term: r[1], count: r[2], credits: r[3], gpa: r[4] });
        } else if (r.length >= 10 && /^\d{4}-\d{4}/.test(r[0] || '')) {
          detail.push({
            term: r[0], code: r[1], seq: r[2], name: r[3], category: r[4],
            nature: r[5], credit: r[6], score: r[7], final: r[8], gpa: r[9],
          });
        }
      });
    });
    var overall = null;
    tables.forEach(function (rows) {
      rows.forEach(function (r) {
        if ((r[0] || '').indexOf('在校') >= 0 && r.length === 4) {
          overall = { count: r[1], credits: r[2], gpa: r[3] };
        } else if ((r[0] || '').indexOf('在校') >= 0 && r.length === 5) {
          overall = { count: r[2], credits: r[3], gpa: r[4] };
        }
      });
    });
    return { summary: summary, overall: overall, courses: detail };
  }

  var PROFILE_KEYS = {
    '学号': 'studentId', '姓名': 'name', '性别': 'gender', '年级': 'grade',
    '院系': 'dept', '专业': 'major', '方向': 'direction', '所属班级': 'className',
    '所属校区': 'campus', '学籍状态': 'status', '学历层次': 'level',
    '学制': 'duration', '入校时间': 'enrolledAt', '毕业时间': 'graduateAt',
  };

  function parseProfile(html) {
    // 表格是「一行塞两对」的布局：['学号：','2507…','姓名：','王…','']
    // ⇒ 必须按 2 步长走，只看 [0]/[1] 会漏掉一半字段。
    var out = {};
    tablesOf(html).forEach(function (rows) {
      rows.forEach(function (r) {
        for (var i = 0; i < r.length - 1; i += 2) {
          var key = (r[i] || '').trim().replace(/[：:]$/, '');
          var val = (r[i + 1] || '').trim();
          if (PROFILE_KEYS[key] && val && val !== '*' && !out[PROFILE_KEYS[key]]) {
            out[PROFILE_KEYS[key]] = val;
          }
        }
      });
    });
    return out;
  }

  var EXAM_COLS = {
    '课程序号': 'code', '课程名称': 'name', '考试类别': 'category', '考试形式': 'form',
    '考试周次与星期': 'weekText', '考试日期': 'date', '考试安排': 'arrange',
    '考试地点': 'room', '考场座位号': 'seat', '考试情况': 'status', '其它说明': 'note',
  };

  function parseExams(html) {
    var tables = tablesOf(html);
    for (var t = 0; t < tables.length; t++) {
      var rows = tables[t];
      if (!rows.length) continue;
      var head = rows[0].map(function (c) { return (c || '').trim(); });
      if (head.indexOf('考试日期') < 0 && head.indexOf('考试地点') < 0) continue;

      // 按表头名字定位列，不按下标 —— 列顺序变了也不会错位
      var idx = {};
      head.forEach(function (name, i) {
        var k = EXAM_COLS[name];
        if (k && idx[k] == null) idx[k] = i;
      });

      var out = [];
      for (var r = 1; r < rows.length; r++) {
        var row = rows[r];
        var any = row.some(function (c) { return (c || '').trim(); });
        if (!any) continue;
        var rec = {};
        Object.keys(idx).forEach(function (k) {
          var i = idx[k];
          rec[k] = i < row.length ? (row[i] || '').trim() : '';
        });
        // 课程名都没有的行是空壳（学校空表里就是这种），丢掉
        if (!rec.name) continue;
        out.push(rec);
      }
      return { exams: out, published: out.length > 0 };
    }
    return { exams: [], published: false };
  }

  function parseExamPage(html) {
    var sid = '';
    var m = /stdExamTable!examTable\.action\?[^"']*semester\.id=(\d+)/.exec(html);
    if (m) sid = m[1];

    var batches = [];
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var sel = doc.querySelector('select[name="examBatch.id"]');
    if (sel) {
      var opts = sel.querySelectorAll('option');
      for (var i = 0; i < opts.length; i++) {
        batches.push({ id: (opts[i].getAttribute('value') || '').trim(),
                       name: (opts[i].textContent || '').trim() });
      }
    }
    return { semesterId: sid, batches: batches };
  }

  /** 学期下拉：`<option value="297">2026-2027学年1学期</option>`。
   *  只留纯数字 value（学期 id），空 value 的「请选择」占位项丢掉 ——
   *  否则界面上会多一个点不动的空按钮。 */
  function parseSemesterList(html) {
    var out = [], seen = {};
    var re = /<option[^>]*value="(\d+)"[^>]*>([^<]*)<\/option>/g, m;
    while ((m = re.exec(html)) !== null) {
      var sid = m[1], name = (m[2] || '').trim();
      if (!name || seen[sid]) continue;
      seen[sid] = 1;
      out.push({ id: sid, name: name });
    }
    return out;
  }

  // ------------------------------------------------------------------ 客户端

  /** 空闲教室结果表：`table.gridtable` 的 tbody，6 列。
   *  序号 / 名称 / 教学楼 / 校区 / 教室设备配置 / 容量
   *
   *  🔴 第一行经常是 **`停课`**（没有教学楼、容量 0）—— 那是学校塞的状态行，
   *     不是教室。不能画成教室，也不能一声不吭删掉：单独放进 notice，
   *     界面在「没查到教室」时可以说清楚这是学校给的标记。 */
  function parseFreeRooms(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var body = doc.querySelector('table.gridtable tbody') || doc.querySelector('tbody');
    if (!body) return { rooms: [], notice: [], raw: 0 };
    var trs = body.querySelectorAll('tr');
    var rooms = [], notice = [], raw = 0;
    for (var i = 0; i < trs.length; i++) {
      var tds = trs[i].querySelectorAll('td');
      if (tds.length < 6) continue;
      raw++;
      var name = (tds[1].textContent || '').trim().replace(/\s+/g, ' ');
      var building = (tds[2].textContent || '').trim().replace(/\s+/g, ' ');
      var campus = (tds[3].textContent || '').trim().replace(/\s+/g, ' ');
      var kind = (tds[4].textContent || '').trim().replace(/\s+/g, ' ');
      var cap = (tds[5].textContent || '').trim();
      if (!name) continue;
      if (name === '停课' || (!building && !kind && (cap === '' || cap === '0'))) {
        if (notice.indexOf(name) < 0) notice.push(name);
        continue;
      }
      var n = parseInt(cap, 10);
      // 🔴 字段名必须和 Python 版（eams.parse_free_rooms）一模一样：
      //    这里以前叫 kind，界面读的是 type —— 网页版有类型、APK 里是空的，
      //    而且不报错，只是「教室类型」那一栏悄悄不显示。
      rooms.push({ name: name, building: building, campus: campus, type: kind,
                   capacity: isNaN(n) ? 0 : n });
    }
    return { rooms: rooms, notice: notice, raw: raw };
  }

  /** 空闲教室查询表单里的三个下拉：教室类型 / 校区 / 教学楼。 */
  function parseRoomOptions(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    function opts(name) {
      var sel = doc.querySelector('select[name="' + name + '"]');
      if (!sel) return [];
      var out = [], seen = {};
      var os = sel.querySelectorAll('option');
      for (var i = 0; i < os.length; i++) {
        var id = (os[i].getAttribute('value') || '').trim();
        var nm = (os[i].textContent || '').trim();
        if (!id || !nm || seen[id]) continue;
        seen[id] = 1;
        out.push({ id: id, name: nm });
      }
      return out;
    }
    return {
      types: opts('classroom.type.id'),
      campuses: opts('classroom.campus.id'),
      buildings: opts('classroom.building.id'),
    };
  }

  // ------------------------------------------------------------------ 培养计划

  function numOf(s) {
    var v = parseFloat(String(s == null ? '' : s).replace(/[^\d.]/g, ''));
    return isNaN(v) ? 0 : v;
  }

  /** 培养计划（/eams/myPlan.action）。
   *
   *  表一是课程清单，表二是「替代课程」对照。
   *
   *  🔴 列数**不固定**，这是这个解析器唯一难的地方：
   *     大多数行是 15 列，但「个性化课程」下面还有一层子分类（专业选修课），
   *     那种行是 16 列 —— 前面多一格，后面全错位一格。
   *     按固定下标取的话，会把学分读成课程名、把学期标记读成必修，
   *     **而且一个字都不会报错**。
   *     ⇒ 一律从右往左取：末三列固定是「是否必修 / 开课学院 / 备注」，
   *       再往左 8 列是「建议修读学期」的 1~8 打勾，再往左才是 学分 / 名称 / 代码。
   *
   *  还有一类行要跳过：
   *     `[分类, '学分小计', 学分, 8个学期值, ...]`  14 列
   *     `['全程总计', 学分, 8个学期值, ...]`        13 列
   *     这两类不是课程，但同样是表格里的 <tr>。
   */
  function parsePlan(html) {
    var out = {
      total: 0,          // 全程总计（164）
      cats: [],          // [{name, credit}]  各类小计 + 「应修学分」那类
      courses: [],       // 计划里的每一门课
      subs: [],          // [{from:{code,name,credit}, to:{...}}] 替代课程
      specials: [],      // [{cat,name,credit,note}] 美育/四史这类子要求
      found: false,
    };
    var tables = tablesOf(html);
    var gotHeader = false;

    for (var ti = 0; ti < tables.length; ti++) {
      var rows = tables[ti];
      for (var ri = 0; ri < rows.length; ri++) {
        var c = rows[ri];
        if (!c || !c.length) continue;

        // 表头：分类 / 课程代码 / 课程名称 / 学分 …
        if (!gotHeader && c[0] === '分类' && c[1] === '课程代码') {
          gotHeader = true;
          continue;
        }
        // 表头下面那行「1 2 3 4 5 6 7 8」是学期序号，不是课程
        if (c[0] === '1' && c[1] === '2' && c[7] === '8') continue;

        // 全程总计
        if (c[0] === '全程总计') {
          out.total = numOf(c[1]);
          out.found = true;
          continue;
        }
        // 各类小计
        if (c[1] === '学分小计') {
          var cname = (c[0] || '').trim();
          if (cname) out.cats.push({ name: cname, credit: numOf(c[2]) });
          continue;
        }
        // 「应修学分」这一行**出现在不同深度**，不能按第几列找：
        //   [通识选修课, 应修学分, 4, …]                              ← 顶层分类的额度
        //   [个性化课程, 专业选修课, 应修学分, 4, …]                   ← 子分类
        //   [个性化课程, 特色选修课, 航空智能信息处理方向, 应修学分, …]  ← 再深一层
        // 顶层那条**是分类学分的来源之一**：郑航的通识选修课只给额度、不列课，
        // 所以它没有「学分小计」行。少了它，各类加起来是 160 而总计写 164，
        // 界面上看起来像算漏了。子分类那几条只是细分，父分类已经含了，不重复加。
        var iEq = c.indexOf('应修学分');
        if (iEq > 0) {
          var path = c.slice(0, iEq).join(' / ').trim();
          var eq = numOf(c[iEq + 1]);
          if (iEq === 1) out.cats.push({ name: path, credit: eq });
          else out.specials.push({ cat: path, name: '应修学分', credit: eq, note: '' });
          continue;
        }
        // 「美育专项 2」「四史专项 1」这类：**某个分类下面的子要求**，
        // 学分已经算在父分类的小计里了，再加一遍就重复。
        // 但也不能扔 —— 单独存着，将来可以提示「这个专项还差几分」。
        if (c.length === 14 && c[1] && !/^\d/.test(c[1]) && /^[\d.]+$/.test((c[2] || '').trim())) {
          out.specials.push({
            cat: (c[0] || '').trim(),
            name: c[1],
            credit: numOf(c[2]),
            note: (c[c.length - 1] || '').trim(),
          });
          continue;
        }

        // 替代课程表：序号 / 原课程 / 替代课程
        if (c.length === 3 && /^\d+$/.test((c[0] || '').trim())) {
          var a = splitCourseCell(c[1]), b = splitCourseCell(c[2]);
          if (a && b) out.subs.push({ from: a, to: b });
          continue;
        }

        // 课程行：至少要有 学分+8个学期+必修+学院+备注 = 12 列，再往左才是代码和名称
        if (c.length < 14) continue;
        var n = c.length;
        var code = (c[n - 14] || '').trim();
        if (!/^[0-9A-Za-z]+$/.test(code)) continue;   // 认不出代码就当不是课程行

        var name = (c[n - 13] || '').replace(/^\s*\d+\s+/, '').trim();
        if (!name) continue;

        var terms = [];
        for (var k = 0; k < 8; k++) {
          if ((c[n - 11 + k] || '').indexOf('√') >= 0) terms.push(k + 1);
        }
        out.courses.push({
          code: code,
          name: name,
          credit: numOf(c[n - 12]),
          cat: c.slice(0, n - 14).join(' / ').trim(),
          terms: terms,
          required: (c[n - 3] || '').indexOf('是') >= 0,
          dept: (c[n - 2] || '').trim(),
          note: (c[n - 1] || '').trim(),
        });
        out.found = true;
      }
    }
    return out;
  }

  /** 「KB008B 线性代数 (2.5)」→ {code, name, credit}。认不出返回 null。 */
  function splitCourseCell(s) {
    var m = /^(\S+)\s+(.+?)\s*[（(]\s*([\d.]+)\s*[)）]\s*$/.exec(String(s || '').trim());
    if (!m) return null;
    return { code: m[1], name: m[2].trim(), credit: numOf(m[3]) };
  }

  // ------------------------------------------------------------------ 该办的事

  /** 页面正文（去脚本、去样式、压空白）。 */
  function plainText(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var junk = doc.querySelectorAll('script, style');
    for (var i = 0; i < junk.length; i++) {
      if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    }
    var t = doc.body ? doc.body.textContent : '';
    return String(t).replace(/[\s\u00a0]+/g, ' ').trim();
  }

  /** 某个 <select> 里的选项（去掉空 value 的占位项）。 */
  function selectOptions(html, name) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var sel = doc.querySelector('select[name="' + name + '"]');
    if (!sel) return null;          // null = 页面里压根没这个下拉
    var out = [];
    var os = sel.querySelectorAll('option');
    for (var i = 0; i < os.length; i++) {
      var id = (os[i].getAttribute('value') || '').trim();
      var nm = (os[i].textContent || '').trim();
      if (!id || !nm) continue;
      out.push({ id: id, name: nm });
    }
    return out;
  }

  /** 选课（/eams/stdElectCourse.action）。
   *
   *  🔴 只认「明确的关门话」，认不出就报 unknown。
   *     反过来「没看到关门话 ⇒ 开着」是危险的：页面改版、被踢回登录页、
   *     甚至加载失败，都会让那个判断变成「选课开了」的假警报。
   *     用户兴冲冲点进教务系统发现没开，这软件就不可信了。
   */
  function parseElect(html) {
    var t = plainText(html);
    var m = /现在未到选课时间[^！!。]*/.exec(t);
    if (m) return { state: 'closed', text: '还没到选课时间', detail: m[0] };
    if (/选课已结束|已过选课时间|选课时间已过/.test(t)) {
      return { state: 'closed', text: '选课已经结束', detail: '' };
    }
    if (/选课/.test(t)) {
      return { state: 'unknown', text: '状态没认出来，去教务系统看看', detail: t.slice(0, 100) };
    }
    return { state: 'unknown', text: '页面没认出选课内容', detail: t.slice(0, 100) };
  }

  /** 免听（/eams/teach/freeListen/freeListenApply.action）。
   *
   *  判据是 `select[name=freeListenSwitchId]` 里有没有批次 ——
   *  实测「2026-2027-1正常免听」「2026-2027-1重修免听」两个。
   *  下拉在、批次有 ⇒ 现在能申请；下拉在、没批次 ⇒ 这学期没开。
   *  下拉都不在 ⇒ 页面结构变了，报 unknown 而不是「没开」。
   */
  function parseFreeListen(html) {
    var opts = selectOptions(html, 'freeListenSwitchId');
    if (opts === null) {
      return { state: 'unknown', text: '页面里没找到免听批次', detail: '' };
    }
    var list = opts.filter(function (o) { return o.id; });
    if (!list.length) return { state: 'closed', text: '这学期没有免听批次', detail: '' };
    return {
      state: 'open',
      text: list.map(function (o) { return o.name; }).join('、'),
      detail: '',
    };
  }

  /** 免修（/eams/exemptionApplyNew.action）。
   *
   *  ⚠️ 这个页面只有「免修类型」下拉（考核/替代/退役复学/主辅修四种），
   *     **那是固定的类型，不代表现在能申请**。没有可靠的开关信号，
   *     所以状态一律报 unknown，只把有哪几种类型摆出来。
   *     与其猜一个「已开放」让用户白跑一趟，不如直说「要去教务系统看」。
   */
  function parseExemption(html) {
    var opts = selectOptions(html, 'type.id');
    if (opts === null) {
      return { state: 'unknown', text: '页面里没找到免修类型', detail: '' };
    }
    var list = opts.filter(function (o) { return o.id; });
    if (!list.length) return { state: 'closed', text: '没有可申请的免修类型', detail: '' };
    return {
      state: 'unknown',
      text: '有 ' + list.length + ' 种免修类型，开没开要去教务系统看',
      detail: list.map(function (o) { return o.name; }).join('、'),
    };
  }

  /** 量化评教（/eams/quality/stdEvaluateNew.action）。
   *
   *  ⚠️ 这个页面**没抓到过样本**（2026-10-20 只从首页菜单里看到入口）。
   *     所以这里只认两种最不容易误判的信号：
   *       正文里出现「已评」「评价完成」⇒ 已评完
   *       正文里出现「待评」「未评」+ 数字  ⇒ 有课要评
   *     其余一律 unknown。**不许**因为「没看到待评」就说已评完 ——
   *     那正是「没读到」被说成「没有」的经典翻车方式。
   */
  function parseEvaluate(html) {
    var t = plainText(html);
    // 「本学期评价已完成」「评价已完成」「已完成评价」几种写法都见过，
    // 但**没抓到过真样本**，所以这里宽一点、误判方向选「不确定」。
    if (/已评完|评价已?完成|已完成评价/.test(t) && !/待评|未评/.test(t)) {
      return { state: 'closed', text: '看起来已经评完了', detail: t.slice(0, 100) };
    }
    if (/待评|未评/.test(t)) {
      return { state: 'open', text: '有课等着评', detail: t.slice(0, 100) };
    }
    return { state: 'unknown', text: '状态没认出来，去教务系统看看', detail: t.slice(0, 100) };
  }

  /** 一次把「该办的事」全查一遍。
   *
   *  为什么单独一个接口、不塞进 /api/sync：
   *    这四页要打四次教务系统，学校有「别点太快」的守卫，串起来要十几秒。
   *    每次同步都白等十几秒，为了一个一学期才变几次的状态，不值当。
   *  所以：点一下才查，查完界面自己缓存。
   *
   *  🔴 任何一页取失败都**只影响它自己**，别让整块变成「全都未知」——
   *     同时也要把失败原因写进那一项，不能安静地显示成「没开放」。
   */
  async function todo() {
    // 🔴 达小助改造（W3）：郑航 TODO_DEFS 那四个 /eams/*.action 端点随 EAMS 废弃。
    //   青果的开放状态查询端点待抓包。返回**空列表 + note**，note 必须和
    //   kingo.py 的 todo() 逐字一致（W5 对账在盯）——没有 note 时界面会退化成
    //   「这次四项都没有新消息」，那是把「没适配」说成「没开放」（红线 20）。
    return { items: [],
             note: '本校教务的选课/评教状态还没接入，暂不查询这四类事项。' };
  }

  var idsCache = '';
  // 当前会话是不是已经登录过（切学期查考试时复用，别每次都重登）
  var loggedIn = false;
  // 登录的是哪个学号。用来判断「已登录同一个账号」—— 见 login() 开头那段。
  var loggedUser = '';
  // 考试列表页是否访问过 —— 学期下拉接口依赖它（见 semesters()）
  var examPageSeen = false;
  // 这个会话里有没有「project 上下文」—— 空闲教室依赖它（见 ensureProject）
  var projectReady = false;

  /* kind='auth' 表示「学号密码不对」—— 这是唯一一种用户重输一次就能解决的失败。
     界面据此弹「重新输入密码」，网络问题不该让人白输一遍。 */
  function EamsError(msg, kind) {
    this.name = 'EamsError'; this.message = msg; this.kind = kind || '';
  }
  EamsError.prototype = Object.create(Error.prototype);

  /** 清掉教务系统的会话 cookie（Java 侧见 NativeBridge.clearCookies）。 */
  function clearCookies() {
    try {
      if (typeof Android.clearCookies === 'function') return !!Android.clearCookies();
    } catch (e) { /* 老版本原生没有这个方法，当成清不掉 */ }
    return false;
  }

  /** 会话还活着吗？
   *
   *  用一个「必须登录才拿得到」的页面探一下，只认里面那行 ids，不解析内容。
   *  用它来分辨「没拿到加盐值」到底是「已经登录了」还是「真出问题了」。
   */
  async function sessionAlive() {
    // 🔴 达小助改造（W3）：探活改问青果会话（有 JSESSIONID 且能进首页）。
    try {
      var r = await http('GET', cfgUrl(CFG.jw.base) + CFG.jw.home_path, '', '', 0);
      return (r.status || 0) === 200 && !/无效访问请求|凭证已失效/.test(r.body || '');
    } catch (e) {
      return false;
    }
  }

  /* ================================================================
     青果 KINGOSOFT 教务段（W3，镜像 kingo.py KingoClient）
     ----------------------------------------------------------------
     方法集与返回结构对齐 eams 老段（doSync / NativeApi.handle 不改），
     两轨以 config/shengda.json 为单一真源。写端点一律不发（红线护栏）。 */

  var kingoReady = false;        // 教务会话（换票+菜单上下文+预热）建好没
  var kingoCtx = null;           // showYearTerm 给的 xn/xqM/xqName
  var kingoKbtHead = null;       // 课表页头部（学号/姓名/班级），profile 复用
  var WRITE_RE = /(saveElectiveCourse|cancelElectiveCourse|getTempDeskey|getTempNowtime|electiveCourseForm|pingjia|evaluate|doXk)/i;

  /** 唯一出口：写端点特征 URL 一律拒绝发出。 */
  async function kingoReq(method, url, body, referer, headers) {
    if (WRITE_RE.test(url)) throw new EamsError('达小助是只读客户端，该操作(写)不被允许');
    // 🔴 浏览器对同源 POST 一律带 Origin + Referer（HAR 实测）。
    //    少这两个头时青果可能回「无效访问请求」——它按来源页判菜单上下文。
    var h = {};
    for (var k in (headers || {})) h[k] = headers[k];
    if (h.Origin == null) h.Origin = cfgUrl(CFG.jw.base);
    // 浏览器这些接口都是 jQuery 的 $.ajax 发的，一律带这个头（HAR 核对过）。
    // 少它时青果可能直接判成「无效访问请求」。
    if (method === 'POST' && h['X-Requested-With'] == null) {
      h['X-Requested-With'] = 'XMLHttpRequest';
    }
    if (!referer) referer = CFG.jw.home_path;
    return http(method, url, body || '', referer, Math.round((CFG.jw.polite_delay_sec || 0.35) * 1000), h);
  }

  /** CAS 票据 cookie 读取：先问原生 java.net 罐，再兜 WebView 罐。 */
  function kingoCk(name, baseUrl) {
    // baseUrl 缺省 = CAS 域（CASTGC 在那边）；查教务的 JSESSIONID 必须传 jw 域，
    // 否则永远读到空 —— 2026-11-03 的诊断信息就是这么误报的。
    var base = (baseUrl || cfgUrl(CFG.cas.base)) + '/';
    try {
      if (typeof Android.cookie === 'function') {
        var v = String(Android.cookie(base, name) || '');
        if (v) return v;
      }
      if (typeof Android.webCookie === 'function') {
        return String(Android.webCookie(base, name) || '');
      }
    } catch (e) { /* 读不到当没有 */ }
    return '';
  }

  /** REST 换票：POST /v1/tickets/{TGT} → ST → GET caslogin?ticket=ST。
   *  返回一句给人看的进展（失败时拼进报错）。
   *  🔴 不看「有没有 JSESSIONID」：票据无效时 caslogin 回 500 却照样发 cookie，
   *  那个会话是空壳，拿它取数只会得到「凭证已失效」。 */
  async function casExchange() {
    var tgt = kingoCk('CASTGC');
    if (!tgt) return '没有 CASTGC';
    var service = CFG.jw.cas_service;
    try {
      var r = await kingoReq('POST', cfgUrl(CFG.cas.base) + CFG.cas.tickets_path +
                             '/' + encodeURIComponent(tgt),
                             form({ service: service }), CFG.cas.portal);
      var m = /(ST-[A-Za-z0-9._\-]+)/.exec(String(r.body || ''));
      if (!m) return '换票 HTTP ' + (r.status || '?') + '（没给 ST）';
      var joiner = service.indexOf('?') >= 0 ? '&' : '?';
      var g = await kingoReq('GET', service + joiner + 'ticket=' + m[1]);
      return '换票 ' + (r.status || '?') + ' → caslogin ' + (g.status || '?');
    } catch (e) {
      return '换票失败（' + ((e && e.message) || e) + '）';
    }
  }

  /** 浏览器路径：带 CASTGC 直接访问教务，让 CAS 自己把票送回来。 */
  async function casRedirect() {
    try {
      var g = await kingoReq('GET', CFG.jw.cas_service);
      return '直连 caslogin ' + (g.status || '?');
    } catch (e) {
      return '直连 caslogin 失败（' + ((e && e.message) || e) + '）';
    }
  }

  async function ensureKingoSession(force) {
    if (kingoReady && !force) return;
    if (!loggedIn) throw new EamsError('还没登录', 'auth');
    // 🔴 这里不判断会话成没成 —— 判据是「能不能真取到数据」（见 kingoContext）。
    //    之前靠 cookie/状态码猜，把「CAS 登录页 200 + 空壳 JSESSIONID」当成了成功。
    if (!kingoCk('CASTGC')) {
      throw new EamsError('登录成功但票据没存住（CASTGC 为空），请重试一次', 'auth');
    }
    await casExchange();
    await kingoMenu();
    await kingoWarmup();
    kingoReady = true;
  }

  async function kingoMenu(pageKey) {
    var mc = pageKey ? ((CFG.pages[pageKey] || {}).menucode || '') : '';
    if (!mc || mc.indexOf('TBD') === 0) return;   // 没配置不发，绝不猜
    await kingoReq('POST', cfgUrl(CFG.jw.base) + CFG.jw.menu_context_path + '?menucode=' + encodeURIComponent(mc),
                   '', CFG.jw.home_path);
  }

  async function kingoWarmup() {
    // 按浏览器顺序预访问：首页 → 下拉字典（把学生身份绑进会话，缺了报"不是本人"）
    try {
      await kingoReq('GET', cfgUrl(CFG.jw.base) + CFG.jw.home_path, '', CFG.jw.base + '/');
      await kingoReq('POST', cfgUrl(CFG.jw.base) + CFG.jw.droplist_path, '', CFG.jw.home_path);
    } catch (e) { /* 尽力而为，真实请求判活 */ }
  }

  /** 双重编码 JSON：{"status":"200","result":"{…}"}；解不开返回 {} 不抛。 */
  function kingoJson(text) {
    var p = null;
    try { p = JSON.parse(String(text || '')); } catch (e) { return {}; }
    if (p && typeof p.result === 'string') {
      try { var inner = JSON.parse(p.result); if (inner && typeof inner === 'object') p.result = inner; }
      catch (e) { /* result 不是 JSON 就原样留着 */ }
    }
    return (p && typeof p === 'object') ? p : {};
  }

  async function kingoContext() {
    // 🔴 2026-11-03 HAR 实测：本校的学期上下文是
    //   POST /jw/common/showYearTerm.action（无 body）→
    //   {"xn":"2026","xqM":"0","xqName":"第一学期","userCode":"…",…}
    //   这个调用同时是「会话到底成没成」的判据：拿到 xn 才算登录成功。
    //
    //   失败时自动换路重试（最多三轮），并把每轮结果记下来：
    //     ① 直接调（走 REST 换票建出来的会话）
    //     ② 失败 → 浏览器路径重新建会话（带 CASTGC 直连 caslogin）
    //     ③ 还失败 → 重做一次 REST 换票（CASTGC 可能是刚种上的）
    if (kingoCtx) return kingoCtx;
    var path = CFG.jw.term_path || '';
    if (!path) throw new EamsError('学期上下文端点没配置（config 的 jw.term_path）');
    var notes = [];
    for (var attempt = 0; attempt < 3; attempt++) {
      var r = await kingoReq('POST', cfgUrl(CFG.jw.base) + path, '', CFG.jw.home_path);
      var ctx = kingoJson(r.body);
      if (ctx && ctx.xn) { kingoCtx = ctx; return kingoCtx; }
      notes.push('第' + (attempt + 1) + '次 HTTP ' + (r.status || '?') + '/' +
                 String(r.body || '').length + '字节');
      if (attempt === 0) notes.push(await casRedirect());
      else if (attempt === 1) notes.push(await casExchange());
    }
    throw new EamsError('学期上下文没打开（' + notes.join(' · ') + '）', 'auth');
  }

  /** 学期总周数。本校没有权威端点：config 写了就用它，否则交给课表实测最大值兜底。 */
  async function kingoTotalWeeks() {
    var forced = parseInt((CFG.semester || {}).total_weeks, 10);
    if (isFinite(forced) && forced >= 10 && forced <= 40) return forced;
    return null;
  }

  /** '2026' + '第一学期' → '2026-2027学年第一学期'。 */
  function kingoSemesterName(ctx) {
    var xn = String((ctx || {}).xn || '');
    var name = String((ctx || {}).xqName || '');
    if (!/^\d{4}$/.test(xn)) return name;
    var y = parseInt(xn, 10);
    return name ? (y + '-' + (y + 1) + '学年' + name) : (y + '-' + (y + 1) + '学年');
  }

  /** 会话失效/频控统一判定（**先排频控**——频控页也含"无效访问请求"字样）。 */
  function kingoGuard(text, what) {
    var t = String(text || '');
    if (/请求太过频繁|请求过于频繁/.test(t)) {
      throw new EamsError('学校服务器提示请求太频繁，请等一会儿再刷新');
    }
    if (/凭证已失效|无效访问请求|无效的访问请求/.test(t)) {
      throw new EamsError(what + '没打开，可能登录态过期了', 'auth');
    }
  }

  /** DataTable.jsp 一页 → [{青果列名:文本}]（head_ 表头定列、trN_ 行内 id 优先）。
   *  🔴 用 querySelectorAll 而不是 table.rows/cells —— 后者是 WebView 才有的
   *     便利 API，Node/linkedom 侧没实现；前两个 DOM 方法到哪都在，
   *     W5 对拍测试才能真跑到这一段。 */
  function kingoParseTable(htmlText, mapping) {
    var doc = new DOMParser().parseFromString(htmlText || '', 'text/html');
    var out = [];
    var tables = doc.querySelectorAll('table');
    for (var ti = 0; ti < tables.length; ti++) {
      var trs = tables[ti].querySelectorAll('tr');
      if (!trs.length) continue;
      var heads = [];
      var hcells = trs[0].querySelectorAll('td,th');
      for (var hi = 0; hi < hcells.length; hi++) {
        var hid = (hcells[hi].getAttribute('id') || '').replace(/^head_/, '');
        heads.push(hid);
      }
      var hasHead = false;
      for (var x = 0; x < heads.length; x++) if (heads[x]) { hasHead = true; break; }
      if (!hasHead) continue;
      for (var ri = 1; ri < trs.length; ri++) {
        var cells = trs[ri].querySelectorAll('td,th');
        if (cells.length < 2) continue;
        var entry = {}, any = false;
        for (var ci = 0; ci < heads.length && ci < cells.length; ci++) {
          var cid = heads[ci];
          if (!cid) continue;
          var rid = (cells[ci].getAttribute('id') || '').replace(/^tr\d+_/, '');
          var key = rid || cid;
          var val = cellText(cells[ci]);
          entry[mapping && mapping[key] ? mapping[key] : key] = val;
          if (val) any = true;
        }
        if (any) out.push(entry);
      }
      if (out.length) break;   // 第一张有数据的表就是目标（DataTable 单表页）
    }
    return out;
  }

  /* ---- 课表格子：青果 skxq/skjc/zc 三列 → slots/weeks ----------------
   *  🔴 必须与 table_parser.shape_courses（Python 轨）逐条一致 ——
   *     两轨同一账号必须给出同一张课表，W5 对拍在盯这一条。
   *  认不出格式就**整批**退回原样行：少画一门课的课表比原始行列表更害人。 */
  var DAY_CN = { '一': 0, '二': 1, '三': 2, '四': 3, '五': 4, '六': 5, '日': 6, '天': 6 };

  function kgPick(row, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = row[keys[i]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  }

  function kgNorm(s) {
    return String(s).replace(/，/g, ',').replace(/、/g, ',')
      .replace(/[－–—]/g, '-').replace(/~/g, '-');
  }

  function kgParseDay(v) {
    var m = /^(?:星期|周|礼拜)?\s*([一二三四五六日天1-7])\s*$/.exec(v);
    if (!m) return null;
    var c = m[1];
    if (/^[0-9]$/.test(c)) {
      var n = parseInt(c, 10);
      return n === 7 ? 6 : n - 1;          // 周日有的学校写 7
    }
    return DAY_CN[c];
  }

  function kgParsePeriods(v, unitCount) {
    var s = kgNorm(v).replace(/第/g, '').replace(/节/g, '').trim();
    if (!s) return null;
    var out = [];
    var parts = s.split(',');
    for (var i = 0; i < parts.length; i++) {
      var m = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(parts[i].trim());
      if (!m) return null;
      var a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
      if (a < 1 || b < a || b > unitCount) return null;
      for (var p = a; p <= b; p++) if (out.indexOf(p - 1) < 0) out.push(p - 1);
    }
    if (!out.length) return null;
    out.sort(function (x, y) { return x - y; });
    return out;
  }

  function kgParseWeeks(v) {
    var s = kgNorm(v).replace(/第/g, '').replace(/周/g, '');
    var parity = null;
    var pm = /[（(]\s*(单|双)\s*[)）]/.exec(s);
    if (pm) {
      parity = pm[1] === '单' ? 1 : 0;
      s = s.slice(0, pm.index) + s.slice(pm.index + pm[0].length);
    }
    var out = [];
    var parts = s.split(',');
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (!t) continue;
      var m = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(t);
      if (!m) return null;
      var a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
      if (a < 1 || b < a) return null;
      for (var w = a; w <= b; w++) if (out.indexOf(w) < 0) out.push(w);
    }
    if (!out.length) return null;
    if (parity !== null) {                 // 双周 = 偶数周（2,4,6…）
      out = out.filter(function (w) { return w % 2 === parity; });
    }
    out.sort(function (x, y) { return x - y; });
    return out.length ? out : null;
  }

  function kingoShapeCourses(rows, unitCount) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var name = kgPick(r, ['name', 'kcm', '课程名']);
      var day = kgParseDay(kgPick(r, ['day', 'skxq', '上课星期']));
      var periods = kgParsePeriods(kgPick(r, ['periods', 'skjc', '上课节次']), unitCount);
      var weeks = kgParseWeeks(kgPick(r, ['weeks_text', 'weeks', 'zc', '周次']));
      if (!name || day === null || !periods || !weeks) return null;
      var slots = [];
      for (var p = 0; p < periods.length; p++) slots.push({ day: day, period: periods[p] });
      out.push({
        code: kgPick(r, ['code', 'kcdm', '课程代码', 'kch', '课程号']) || name,
        name: name,
        teacher: kgPick(r, ['teacher', 'skjs', '任课教师']),
        room: kgPick(r, ['room', 'cdmc', '上课地点']),
        weeks: weeks,
        slots: slots,
      });
    }
    return out;
  }

  async function kingoFetch(pageKey, extraParams) {
    var conf = (CFG.pages || {})[pageKey] || {};
    var tid = conf.tableId || '';
    if (!tid || tid.indexOf('TBD') === 0) {
      throw new EamsError(pageKey + '还没适配本校系统（等抓包确认入口）');
    }
    await ensureKingoSession();
    await kingoMenu(pageKey);
    var params = { tableId: tid, fre: '1' };
    var ctx = await kingoContext().catch(function () { return {}; });
    var keys = ['xn', 'xqM', 'kcfw', 'lcid', 'nj', 'zydm', 'yxbdm'];
    for (var i = 0; i < keys.length; i++) {
      if (ctx[keys[i]] != null && ctx[keys[i]] !== '') params[keys[i]] = ctx[keys[i]];
    }
    if (extraParams) for (var k in extraParams) params[k] = extraParams[k];
    var r = await kingoReq('POST', cfgUrl(CFG.jw.base) + CFG.jw.data_table_path,
                           form(params), conf.preheat_path || CFG.jw.home_path);
    kingoGuard(r.body, pageKey + '数据');
    return kingoParseTable(r.body, (CFG.column_map || {})[pageKey] || {});
  }
  /* ============== 青果段结束 ============== */

  /* ---------------- CAS 登录失败原因（2026-11-03 新增） ----------------
   * 🔴 升达 CAS 登录失败时**照样返回 HTTP 200**，真正原因只在 data.code 里。
   *    以前只看「响应体里有没有 TGT-」，于是界面只能回一句「登录没成功（200）」——
   *    用户根本分不清是密码错、验证码错还是学号不存在。实测到的两个码：
   *      NOUSER    —— 账号不存在（验证码和密码格式都过了才到这一步）
   *      CODEFALSE —— 验证码为空/错/过期（它在最前面校验，会掩盖密码错误）
   *    其它码不猜，原样回显让人能反馈。
   */
  var CAS_CODE_HINTS = {
    NOUSER: '学号不存在，核对一下再输',
    CODEFALSE: '验证码错了或过期了，换一张重新算'
  };

  function casFailure(text) {
    var s = String(text || '');
    var i = s.indexOf('{');
    if (i < 0) return null;
    var j = null;
    try { j = JSON.parse(s.slice(i)); } catch (e) { return null; }
    if (!j || typeof j !== 'object') return null;
    var d = j.data;
    if (!d || typeof d !== 'object') return null;
    var code = d.code ? String(d.code).trim() : '';
    if (!code) return null;
    var hint = CAS_CODE_HINTS[code.toUpperCase()] || '';
    return {
      code: code,
      kind: code.toUpperCase() === 'CODEFALSE' ? 'code' : 'auth',
      message: hint ? hint + '（' + code + '）'
                    : '登录被拒绝（服务端返回 ' + code + '，请把这条反馈给开发者）'
    };
  }

  /** 从登录响应里取 TGT。前端是 `if (o.data.tgt) c=o.data.tgt; else c=o.data`。 */
  function casTgt(text, location) {
    var s = String(text || '');
    var i = s.indexOf('{');
    if (i >= 0) {
      try {
        var j = JSON.parse(s.slice(i));
        if (j && typeof j === 'object') {
          var cands = [j.tgt];
          var d = j.data;
          if (typeof d === 'string') cands.push(d);
          else if (d && typeof d === 'object') { cands.push(d.tgt); if (typeof d.data === 'string') cands.push(d.data); }
          for (var k = 0; k < cands.length; k++) {
            if (typeof cands[k] === 'string') {
              var m0 = /TGT-[A-Za-z0-9_.\-]+/.exec(cands[k]);
              if (m0) return m0[0];
            }
          }
        }
      } catch (e) { /* 落到下面的正则 */ }
    }
    var m = /TGT-[A-Za-z0-9_.\-]+/.exec(s) || /TGT-[A-Za-z0-9_.\-]+/.exec(String(location || ''));
    return m ? m[0] : '';
  }

  /** 密码 → CAS 要的 RSA 密文（算法在 NativeBridge.casRsa，理由见那边的注释）。 */
  function casRsa(pwd) {
    if (typeof Android.casRsa !== 'function') {
      throw new EamsError('这个版本的 APK 还不支持加密登录，请更新到最新版', 'auth');
    }
    var enc = String(Android.casRsa(pwd) || '');
    if (!enc) {
      // 🔴 加密失败**不许**拿明文顶上去：服务端只认密文，发明文等于拿错密码去撞，
      //    撞够次数就锁号。宁可这次登不上。
      throw new EamsError('密码加密失败，请重试（这次没有发出密码）', 'auth');
    }
    return enc;
  }

  /* ---------------- 验证码（2026-11-03 新增） ----------------
   * 学校 /loginType 返回 isVerifyCode=1 ⇒ **第一次登录就要验证码**。
   * uid 只活在内存里（Java 侧拿不到、页面也拿不到），取一次用一次：
   * 这样「同一张图重放两次」在结构上就不可能发生。 */
  var captchaUid = '';

  function takeCaptchaUid() {
    var u = captchaUid;
    captchaUid = '';   // 一次性
    return u;
  }

  /** 取一张验证码。返回 {img: 'data:image/png;base64,…', ttl}。 */
  async function fetchCaptcha() {
    var cas = cfgUrl(CFG.cas.base);
    var url = cas + (CFG.cas.kaptcha_path || '/kaptcha') +
              '?_t=' + Date.now() + '&uid=';
    var r = await http('GET', url, '', cas + '/login', 0, {
      'Accept': 'application/json, text/plain, */*',
    });
    var j = null;
    try { j = JSON.parse(String(r.body || '')); } catch (e) { j = null; }
    if (!j || !j.uid || !j.content) {
      throw new EamsError('验证码没取到，可能登录页改版了');
    }
    captchaUid = String(j.uid);
    return { img: String(j.content), ttl: Number(j.timeout) || 30 };
  }

  async function login(username, password, code, uid) {
    // 🔴 达小助改造（W3）：升达走统一 CAS，**镜像 kingo.py KingoClient.login**。
    //   ① POST {cas}/v1/tickets（表单编码+小写键+loginType）→ 拿 TGT；
    //   ② 🔴 CASTGC 是门户前端 JS 自己写进 cookie 的，服务器不 Set-Cookie ——
    //      必须手动种进原生 CookieStore（Android.setCookie），否则免密续期永不生效。
    //   ③ 失败**绝不重试**：错 5 次锁号、且会触发滑块验证码（红线）。
    //   ④ 2026-11-03 修复：密码必须 RSA 加密、且第一次登录就要带验证码
    //      （学校 /loginType 返回 isVerifyCode=1）。不带的话服务端回 CODEFALSE，
    //      界面只能显示「登录没成功（200）」——就是用户报的那个错。
    if (loggedIn && loggedUser === username) return;
    var cas = cfgUrl(CFG.cas.base);
    var form0 = {
      username: username,
      password: casRsa(password),
      service: CFG.cas.portal,
      loginType: ''
    };
    // 字段名就是 id / code（不是 captcha / verifyCode），与学校前端一致。
    if (uid) { form0.id = uid; form0.code = code || ''; }
    var r = await http('POST', cas + CFG.cas.tickets_path, form(form0),
                       CFG.cas.portal, 0, {
      'Origin': cas.split('/lyuapServer')[0],
      'Referer': cas + '/login?service=' + encodeURIComponent(CFG.cas.portal),
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/plain, */*',
    });
    var body = String(r.body || '');
    // 先判业务失败码，再找 TGT —— 顺序反了就只能给出没用的「登录没成功」。
    var bad = casFailure(body);
    if (bad) throw new EamsError(bad.message, bad.kind);
    var tgt = casTgt(body, r.location || r.url || '');
    if (!tgt) {
      // 不自动重试。走到这里说明服务端既没给原因码、也没给票据 ——
      // 通常意味着登录页改版了。**不要**只甩一个 HTTP 状态码给用户。
      throw new EamsError('登录没成功：服务端没给原因也没给票据（HTTP ' +
                          (r.status || '网络') + '），可能登录页改版了', 'auth');
    }
    // 🔴 手动种 CASTGC（域名取 CAS 主机名）
    try {
      var casHost = cas.split('/')[2];
      if (typeof Android.setCookie === 'function') {
        Android.setCookie(cas + '/', 'CASTGC=' + tgt + '; Path=/; Domain=' + casHost);
      }
    } catch (e) { /* 种不上就这一次用不了免密续期，下次登录照常 */ }
    loggedIn = true;
    loggedUser = username;
    kingoReady = false;   // 教务会话要重新建
  }

  /** 保证有会话：没登录就用本机存的凭据登一次。 */
  async function ensureLogin() {
    if (loggedIn) return;
    var c = loadCred();
    if (!c) throw new EamsError('还没绑定账号');
    await login(c.u, c.p);
  }

  async function withLogin(fn) {
    await ensureLogin();
    try {
      return await fn();
    } catch (e) {
      if (e && e.kind === 'auth') throw e;
      // 🔴 达小助改造（W3）：CAS 账密本身不会过期，要清的是**教务会话**——
      //   强制重新换票+菜单上下文，而不是把登录状态整个扔掉。
      kingoReady = false;
      kingoCtx = null;
      try { return await fn(); } catch (e2) {
        if (e2 && e2.kind === 'auth') {
          // 换票救不回来 ⇒ CASTGC 真死了 ⇒ 才需要人重新输一次密码
          loggedIn = false; loggedUser = '';
        }
        throw e2;
      }
    }
  }

  /* ============ 课表 / 成绩页面解析（2026-11-03 校内 HAR 实测） ============
     本校**不用 DataTable.jsp**：课表、成绩各是一张独立 jsp 页面。
     Python 轨见 table_parser.parse_kbt_timetable / parse_stuckcj，
     两轨输出必须逐字段一致（W5 对拍盯这个）。 */

  /** 折叠空白、去零宽、&nbsp; 当普通空格 —— 与 Python 的 clean_cell 同规则。 */
  function normText(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** '1-4,6-16 双' → 偶数周；'1-16 单' → 奇数周；'14,16' → [14,16]。
   *  🔴 单/双必须**先记下来再从串里删**：直接剔非数字会让单周课也出现在双周。 */
  function weekNumbers(spec) {
    var s = String(spec || '');
    var even = s.indexOf('双') >= 0;
    var odd = s.indexOf('单') >= 0;
    s = s.replace(/[^\d,\-]/g, ' ');
    var seen = {};
    s.trim().split(/[,\s]+/).forEach(function (t) {
      if (!t) return;
      if (t.indexOf('-') >= 0) {
        var p = t.split('-');
        var a = parseInt(p[0], 10), b = parseInt(p[1], 10);
        if (isFinite(a) && isFinite(b)) {
          for (var w = a; w <= b; w++) seen[w] = 1;
        }
      } else if (/^\d+$/.test(t)) {
        seen[parseInt(t, 10)] = 1;
      }
    });
    var out = Object.keys(seen).map(Number).sort(function (x, y) { return x - y; });
    if (even) out = out.filter(function (w) { return w % 2 === 0; });
    else if (odd) out = out.filter(function (w) { return w % 2 === 1; });
    return out;
  }

  /** 纯 ASCII 的 base64（课表 params 只有 xn=..&xq=..&xh=..，不会有中文）。 */
  function b64ascii(str) {
    var T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var s = String(str), out = '';
    for (var i = 0; i < s.length; i += 3) {
      var c1 = s.charCodeAt(i);
      var has2 = i + 1 < s.length, has3 = i + 2 < s.length;
      var c2 = has2 ? s.charCodeAt(i + 1) : 0;
      var c3 = has3 ? s.charCodeAt(i + 2) : 0;
      out += T.charAt(c1 >> 2);
      out += T.charAt(((c1 & 3) << 4) | (c2 >> 4));
      out += has2 ? T.charAt(((c2 & 15) << 2) | (c3 >> 6)) : '=';
      out += has3 ? T.charAt(c3 & 63) : '=';
    }
    return out;
  }

  /** 把格子里每个「有课的 div」拆成 课程名/教师/周次[节次]/地点 四段。 */
  function kbtDivParts(div) {
    var parts = [], cur = '';
    for (var n = div.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && String(n.nodeName).toLowerCase() === 'br') {
        parts.push(cur); cur = '';
      } else {
        cur += n.textContent || '';
      }
    }
    parts.push(cur);
    return parts.map(normText).filter(Boolean);
  }

  /** 课表页 → {head, courses[], totalWeeks, unitCount, empty}（契约与 Python 一致）。 */
  function parseKbtTimetable(htmlText) {
    var doc = new DOMParser().parseFromString(String(htmlText || ''), 'text/html');
    var flat = normText(doc.body ? doc.body.textContent : '');
    var head = {};
    var m;
    if ((m = /学号[：:]\s*([0-9A-Za-z]+)/.exec(flat))) head.studentId = m[1];
    if ((m = /姓名[：:]\s*(\S+)/.exec(flat))) head.name = m[1];
    if ((m = /所在班级[：:]\s*(\S+)/.exec(flat))) head.clazz = m[1];
    if ((m = /课程门数[：:]\s*(\d+)/.exec(flat))) head.courseCount = parseInt(m[1], 10);
    if ((m = /课程学分[：:]\s*([\d.]+)/.exec(flat))) head.credits = m[1];

    var merged = {}, order = [];
    var trs = doc.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      var tds = trs[i].children;
      if (!tds || tds.length < 7) continue;
      var days = [];
      for (var k = tds.length - 7; k < tds.length; k++) days.push(tds[k]);
      if (normText(days[0].textContent).indexOf('星期') >= 0) continue;   // 表头行
      for (var day = 0; day < 7; day++) {
        var divs = days[day].querySelectorAll('div');
        for (var d = 0; d < divs.length; d++) {
          var style = divs[d].getAttribute('style') || '';
          if (style.indexOf('padding-bottom') < 0) continue;              // 空格子
          var parts = kbtDivParts(divs[d]);
          if (parts.length < 2) continue;
          var name = parts[0];
          var teacher = parts[1];
          var spec = parts[2] || '';
          var room = parts[3] || '';
          var pm = /\[(\d+)-(\d+)\]/.exec(spec);
          var periods = [];
          if (pm) {
            var a = parseInt(pm[1], 10), b = parseInt(pm[2], 10);
            if (a >= 1 && a <= b && b <= 30) {
              for (var p = a; p <= b; p++) periods.push(p);
            }
          }
          var weeks = weekNumbers(spec.split('[')[0]);
          var key = name + '|' + teacher + '|' + room + '|' + weeks.join(',');
          if (!merged[key]) {
            merged[key] = { code: name, name: name, teacher: teacher,
                            room: room, weeks: weeks, slots: [] };
            order.push(key);
          }
          var e = merged[key];
          for (var q = 0; q < periods.length; q++) {
            var slot = { day: day, period: periods[q] - 1 };
            var dup = false;
            for (var z = 0; z < e.slots.length; z++) {
              if (e.slots[z].day === slot.day && e.slots[z].period === slot.period) { dup = true; break; }
            }
            if (!dup) e.slots.push(slot);
          }
        }
      }
    }

    var courses = [];
    for (var oi = 0; oi < order.length; oi++) {
      var c = merged[order[oi]];
      c.slots.sort(function (x, y) { return (x.day - y.day) || (x.period - y.period); });
      if (c.slots.length && c.weeks.length) courses.push(c);
    }
    var maxWeek = 0, maxPeriod = 0;
    for (var ci = 0; ci < courses.length; ci++) {
      maxWeek = Math.max(maxWeek, Math.max.apply(null, courses[ci].weeks));
      for (var si = 0; si < courses[ci].slots.length; si++) {
        maxPeriod = Math.max(maxPeriod, courses[ci].slots[si].period + 1);
      }
    }
    return { head: head, courses: courses,
             totalWeeks: maxWeek || null,
             unitCount: Math.max(10, maxPeriod),
             empty: courses.length === 0 };
  }

  /** 成绩页 → [{term,kch,kcm,xf,cj,jd,hdjd,xfdj,ksxz,ksfs,bz}]。 */
  function parseStuckcj(htmlText) {
    var doc = new DOMParser().parseFromString(String(htmlText || ''), 'text/html');
    var trs = doc.querySelectorAll('tr');
    var term = '', out = [];
    for (var i = 0; i < trs.length; i++) {
      var kids = trs[i].children, cells = [];
      for (var k = 0; k < kids.length; k++) cells.push(normText(kids[k].textContent));
      if (cells.length === 1 && cells[0].indexOf('学年学期') >= 0) {
        var seg = cells[0].split(/[：:]/);
        term = seg[seg.length - 1].trim();
        continue;
      }
      if (cells.length >= 12 && /^\d+$/.test(cells[0])) {
        var raw = cells[1], code = '', cname = raw;
        var mm = /^\[([0-9A-Za-z]+)\]\s*([\s\S]*)$/.exec(raw);
        if (mm) { code = mm[1]; cname = mm[2]; }
        out.push({ term: term, kch: code, kcm: cname,
                   xf: cells[2], lb: cells[4], ksxz: cells[5], ksfs: cells[6],
                   cj: cells[7], hdjd: cells[8], jd: cells[9],
                   xfdj: cells[10], bz: cells[11] });
      }
    }
    return out;
  }

  /** 「2024-2025学年第一学期」→ {year:'2024-2025', no:1}。与 kingo._split_term 同规则。 */
  function splitTerm(text) {
    var m = /(\d{4}-\d{4})\s*学年\s*第?([一二三四])学期/.exec(String(text || ''));
    if (!m) return { year: '', no: 0 };
    var map = { '一': 1, '二': 2, '三': 3, '四': 4 };
    return { year: m[1], no: map[m[2]] || 0 };
  }

  /** 加权平均绩点 = Σ(绩点×学分)/Σ学分；非数字绩点（良好/合格）跳过。 */
  function gpaOf(rows) {
    var tc = 0, tn = 0;
    for (var i = 0; i < rows.length; i++) {
      var jd = parseFloat(rows[i].gpa != null ? rows[i].gpa : rows[i].jd);
      var xf = parseFloat(rows[i].credit != null ? rows[i].credit : rows[i].xf);
      if (!isFinite(jd) || !isFinite(xf) || xf <= 0) continue;
      tc += jd * xf; tn += xf;
    }
    if (!tn) return null;
    return Math.round(tc / tn * 100) / 100;
  }

  async function timetable(semesterId, semesterName) {
    // 🔴 2026-11-03 重写：本校课表是独立 jsp 页面
    //   GET /student/wsxk.xskcb10319.jsp?params=<base64("xn=..&xq=..&xh=..")>
    //   会话类错误向上抛（withLogin 靠它重登一次再试）。
    var conf = (CFG.pages || {}).timetable || {};
    var path = conf.path || '';
    if (!path) throw new EamsError('课表入口没配置（config 的 pages.timetable.path）');
    await ensureKingoSession();
    // 🔴 顺序必须和浏览器一致（HAR 实测）：首页 → showYearTerm → 菜单 → 目标页。
    //    先设菜单上下文再调 showYearTerm，青果按「当前上下文」校验会回 1098。
    var ctx = await kingoContext();
    await kingoMenu('timetable');
    var tpl = conf.params_b64 || 'xn={xn}&xq={xq}&xh={xh}';
    var raw = tpl.replace('{xn}', ctx.xn || '')
                 .replace('{xq}', ctx.xqM == null ? '0' : ctx.xqM)
                 .replace('{xh}', loggedUser || '');
    var r = await kingoReq('GET', cfgUrl(CFG.jw.base) + path + '?params=' +
                           encodeURIComponent(b64ascii(raw)), '', CFG.jw.home_path);
    kingoGuard(r.body, '课表');
    var res = parseKbtTimetable(r.body);

    var tw = (await kingoTotalWeeks().catch(function () { return null; })) || res.totalWeeks;
    var out = {
      unitCount: res.unitCount,
      courses: res.courses,
      totalWeeks: tw, weekStart: 1,
      semester: kingoSemesterName(ctx) || semesterName || '',
      shape: 'slots',
    };
    if (res.empty) out.empty = true;
    kingoKbtHead = res.head;    // 学籍复用，省一次请求
    return out;
  }

  async function grades() {
    // 🔴 两步：① GET 检索页（成绩数据页认它的会话上下文）② POST 数据页。
    var conf = (CFG.pages || {}).score || {};
    var path = conf.path || '', dataPath = conf.data_path || '';
    if (!path || !dataPath) {
      return { summary: [], overall: null, courses: [],
               error: '成绩入口没配置（config 的 pages.score）' };
    }
    var rows;
    try {
      await ensureKingoSession();
      await kingoContext();          // 同上：先拿学期上下文，再动菜单
      await kingoMenu('score');
      // 🔴 变量别叫 form：本文件顶层有个 form() 拼表单体的函数，重名会被遮蔽
      var formPage = await kingoReq('GET', cfgUrl(CFG.jw.base) + path +
                                    '?menucode=' + encodeURIComponent(conf.menucode || ''),
                                    '', CFG.jw.home_path);
      kingoGuard(formPage.body, '成绩检索页');
      var ctx = await kingoContext();
      var body = scoreBody(conf, ctx);
      var r = await kingoReq('POST', cfgUrl(CFG.jw.base) + dataPath, form(body),
                             path);
      kingoGuard(r.body, '成绩');
      rows = parseStuckcj(r.body);
    } catch (e) {
      return { summary: [], overall: null, courses: [],
               error: (e && e.message) || String(e) };
    }
    // 🔴 界面契约（app.js renderGrades 读这些键）：
    //   summary [{year, term, count, credits, gpa}]
    //   overall {gpa, credits, count}
    //   courses [{term:"2024-2025 1", code, name, credit, score, gpa,
    //             category, nature, examType}]
    // 0.1.5：examType = ksfs（考核方式，值「考试」/「考查」），课程页分组要用。
    var courses = [], seen = [];
    rows.forEach(function (r) {
      var st = splitTerm(r.term || '');
      if (st.year && seen.indexOf(r.term) < 0) seen.push(r.term);
      courses.push({
        term: st.year ? (st.year + ' ' + st.no) : (r.term || ''),
        code: r.kch || '', name: r.kcm || '',
        credit: r.xf || '', score: r.cj || '', gpa: r.jd || '',
        category: r.lb || '', nature: r.ksxz || '', examType: r.ksfs || ''
      });
    });
    var summary = seen.map(function (t) {
      var st = splitTerm(t);
      var key = st.year + ' ' + st.no;
      var sub = courses.filter(function (c) { return c.term === key; });
      var cr = 0;
      sub.forEach(function (c) { var v = parseFloat(c.credit); if (isFinite(v)) cr += v; });
      return { year: st.year, term: st.no, count: sub.length,
               credits: Math.round(cr * 10) / 10, gpa: gpaOf(sub) };
    });
    var totalCr = 0;
    courses.forEach(function (c) { var v = parseFloat(c.credit); if (isFinite(v)) totalCr += v; });
    return { summary: summary,
             overall: { gpa: gpaOf(courses), credits: Math.round(totalCr * 10) / 10,
                        count: courses.length },
             terms: summary.map(function (x) { return x.year + ' ' + x.term; }),
             courses: courses, shape: 'table', empty: courses.length === 0 };
  }

  /** 成绩数据页提交体：config 里放语义不明的开关，年级/学年从学号和上下文推。 */
  function scoreBody(conf, ctx) {
    var base = {};
    var src = conf.body || {};
    for (var k in src) base[k] = src[k];
    var xn = String(ctx.xn || '');
    var nj = String(loggedUser || '').slice(0, 4);
    var sub = { xn: xn, xn1: /^\d+$/.test(xn) ? String(parseInt(xn, 10) + 1) : '',
                xq: String(ctx.xqM == null ? '0' : ctx.xqM),
                nj: nj, rxnj: nj, menucode_current: conf.menucode || '' };
    for (var k2 in base) {
      if (String(base[k2]).indexOf('{') >= 0) {
        base[k2] = String(base[k2]).replace(/\{(\w+)\}/g, function (s0, name) {
          return sub[name] == null ? s0 : sub[name];
        });
      }
    }
    ['xn', 'xn1', 'xq', 'nj', 'rxnj', 'menucode_current'].forEach(function (k3) {
      if (base[k3] == null && sub[k3]) base[k3] = sub[k3];
    });
    return base;
  }

  async function profile() {
    // 🔴 2026-11-03：本校「学籍档案」页没抓过，但**课表页头部就带
    //   学号/姓名/所在班级**，够「我的」页显示主体信息。
    //   学院/专业/年级尽量从班级名拆（「2024级软件工程本科2班」→ 2024/软件工程），
    //   拆不出就留空 —— 宁可空着，不编。
    var head = kingoKbtHead;
    if (!head) {
      try { await timetable(); } catch (e) { head = null; }
      head = kingoKbtHead;
    }
    if (!head) {
      if (!loggedUser) return {};
      return { studentId: loggedUser };
    }
    var p = { studentId: head.studentId || '', name: head.name || '' };
    var clazz = head.clazz || '';
    if (clazz) {
      p.clazz = clazz;
      var m = /^(\d{4})级(.+?)(?:本科|专科|专升本)?(\d+)班$/.exec(clazz);
      if (m) { p.grade = m[1]; p.major = m[2]; }
      else {
        var m2 = /^(\d{4})级/.exec(clazz);
        if (m2) p.grade = m2[1];
      }
    }
    if (head.credits) p.credits = head.credits;
    return p;
  }

  /** 培养计划。青果端点未确认（阶段2顺路抓不到就维持 error）。 */
  async function plan() {
    throw new EamsError('青果版培养计划端点未配置（待抓包）');
  }

  /** 考试安排。`semesterId` 为空 = 教务系统默认（当前学期）。
   *  🔴 学校没排考时**不是错误**：返回空列表 + published=false，
   *     界面照实说「还没发布」，别把「没数据」伪装成「没有考试」。 */
  async function exams(semesterId) {
    // 🔴 2026-11-03：用户明确「考试不用管」，本校入口未抓。
    //   如实返回未适配，不编数据 —— 界面照实说，别假装「没有考试」。
    return { exams: [], published: false,
             error: '考试安排还没适配本校系统' };
  }

  /** 全部学期：来源是成绩页返回的「学年学期」分段（实测一次给全 4 个）。 */
  async function semesters() {
    try {
      var g = await grades();
      return (g.terms || []).map(function (t) { return { id: t, name: t }; });
    } catch (e) {
      return [];
    }
  }

  // ------------------------------------------------------------------ 空闲教室
  // 🔴 达小助改造（W3）：青果版见下方 roomOptions/freeRooms ——
  //    郑航的 project 上下文坑与 grid 分页坑随 EAMS 一起废弃，
  //    青果对应的前置是「菜单上下文 + 预热」（ensureKingoSession 已做）。

  async function roomOptions() {
    // 🔴 达小助改造（W3）：青果空闲教室下拉。真实 select name 待抓包，
    //   未配置 menucode 时报可操作错误（镜像 kingo.room_options）。
    var conf = (CFG.pages || {}).free_room || {};
    var mc = conf.menucode || '';
    if (!mc || mc.indexOf('TBD') === 0) {
      throw new EamsError('空闲教室的 menucode 还没配置（等校内抓包）');
    }
    await ensureKingoSession();
    await kingoMenu('free_room');
    return { types: [], campuses: [], buildings: [] };
  }

  async function freeRooms(o) {
    o = o || {};
    var day = String(o.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new EamsError('要查哪一天？日期不能空');
    var p1 = Number(o.periodBegin), p2 = Number(o.periodEnd);
    var mx = CFG.free_room && CFG.free_room.max_periods;   // 升达节数上限待抓包确认
    if (mx && !(p1 >= 1 && p1 <= p2 && p2 <= mx)) {
      throw new EamsError('节次要在 1~' + mx + ' 之间，且开始不晚于结束');
    }
    if (!(p1 >= 1 && p1 <= p2)) throw new EamsError('节次范围不对');
    var rows = await kingoFetch('free_room', {
      date: day, pb: p1, pe: p2,
      building: o.buildingId || '', campus: o.campusId || '',
      type: o.typeId || '', seats: o.seats || '', name: o.name || '' });
    // 列名→契约键同样待抓包核对；先按中文列名映射并标 raw
    var rooms = rows.map(function (r) {
      return { name: r['教室名称'] || '', building: r['教学楼'] || '',
               campus: r['校区'] || '', type: r['教室类型'] || '',
               capacity: parseInt(String(r['容量'] || '').replace(/\D/g, ''), 10) || 0 };
    });
    var notice = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i]['备注'] === '停课') notice.push('停课');
    }
    var pageSize = o.pageSize || 1000;
    return { rooms: rooms, notice: notice, raw: rows.length, shape: 'raw',
             dateBegin: day, dateEnd: day, periodBegin: p1, periodEnd: p2,
             truncated: rows.length >= pageSize };
  }

  // ------------------------------------------------------------------ 凭据

  function loadCred() {
    try {
      var raw = Android.loadCred();
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (d && d.u && d.p) return { u: d.u, p: d.p };
    } catch (e) { /* 解不开就当没绑 */ }
    return null;
  }

  // ------------------------------------------------------------------ 应用内下载

  /* 下载更新（Java 侧见 UpdateDownloader）。网页版没有这个对象，所以每个方法
     调用前都要现查 —— 别在模块加载时缓存成常量，那样网页版里永远是 undefined。

     🔴 这里只做「解 JSON + 兜异常」，不掺业务逻辑：要不要重试、校验不过怎么办，
        全在 app.js 里，网页版和 APK 共用同一套判断。 */
  function updRaw() {
    return (window.AndroidUpdate && typeof window.AndroidUpdate.start === 'function')
      ? window.AndroidUpdate : null;
  }

  function updJson(s) {
    try { return JSON.parse(String(s || '')); }
    catch (e) { return { ok: false, error: 'App 内部通信出错了，请重试' }; }
  }

  var UpdApi = {
    /** 有没有应用内下载能力（网页版没有）。 */
    available: function () { return !!updRaw(); },

    /** 入队下载 → {ok, id} 或 {ok:false, error} */
    start: function (url, name) {
      var a = updRaw();
      if (!a) return { ok: false, error: '这个版本不支持应用内下载' };
      try { return updJson(a.start(String(url || ''), String(name || ''))); }
      catch (e) { return { ok: false, error: '调用原生下载出错：' + e }; }
    },

    /** 查进度 → {ok, status, bytes, total, reason} */
    state: function (id) {
      var a = updRaw();
      if (!a) return { ok: false, error: '这个版本不支持应用内下载' };
      try { return updJson(a.state(id)); }
      catch (e) { return { ok: false, error: '查下载进度出错：' + e }; }
    },

    /** 算已下载文件的 sha256；读不到返回空串（≠「算出来不一样」）。 */
    sha256: function (id) {
      var a = updRaw();
      if (!a) return '';
      try { return String(a.sha256(id) || ''); }
      catch (e) { return ''; }
    },

    /** 拉起安装器：'' 成功 / 'need-permission' 缺授权 / 其余是原因 */
    install: function (id) {
      var a = updRaw();
      if (!a) return 'fail: 这个版本不支持应用内安装';
      try { return String(a.install(id) || ''); }
      catch (e) { return 'fail: ' + e; }
    },

    canInstall: function () {
      var a = updRaw();
      if (!a) return false;
      try { return !!a.canInstall(); } catch (e) { return false; }
    },

    openInstallSettings: function () {
      var a = updRaw();
      if (!a) return;
      try { a.installSettings(); } catch (e) { /* 有些 ROM 没这个页面 */ }
    },

    cancel: function (id) {
      var a = updRaw();
      if (!a) return;
      try { a.cancel(id); } catch (e) { /* 取消失败也不影响界面 */ }
    },
  };

  // ------------------------------------------------------------------ 对外契约

  /** 整份同步。**失败会强制真登一次再重来**，见下面的注释。 */
  async function doSync(user, pwd, code) {
    try {
      return await doSyncOnce(user, pwd, code);
    } catch (e) {
      // 密码错是「用户重输一次就能解决」的，重试纯属白等。
      // 🔴 验证码错(kind='code')更不能重试：每失败一次都在动学校的错误计数器，
      //    错 5 次锁号 —— 这是红线，2026-11-03 明确加进来。
      if (e && (e.kind === 'auth' || e.kind === 'code')) throw e;
      // 🔴 为什么要这一层：
      //    login() 开头有个短路 —— 「已经登录着同一个账号就直接用现成会话」。
      //    这个短路是对的（不然拿不到加盐值），但它有个前提没被验证：
      //    本地以为的「已登录」，服务器那边可能早就过期了。
      //    这时 profile()/timetable() 会报「可能登录态过期了」，
      //    而用户看到的是「明明登录过了，一刷新就失败」。
      //    所以失败一次就把会话彻底丢掉，真登一次再来。
      //    只重试一次：第二次还失败说明真有别的问题，如实报错。
      loggedIn = false;
      loggedUser = '';
      idsCache = '';
      examPageSeen = false;
      projectReady = false;
      clearCookies();
      return await doSyncOnce(user, pwd, code);
    }
  }

  async function doSyncOnce(user, pwd, code) {
    idsCache = '';
    examPageSeen = false;
    projectReady = false;
    await login(user, pwd, code, takeCaptchaUid());
    var prof = await profile();
    var tt = await timetable();
    // 成绩单独兜一层，理由同 Python 版 Service.sync：没有成绩不是错误，
    // 解析失败也不能把整次绑定连课表一起带走。
    var gr;
    try {
      gr = await grades();
    } catch (e) {
      gr = {
        summary: [], overall: null, courses: [],
        error: (e && e.message) || String(e),
      };
    }
    var ex;
    // 考试表单独兜一层：万一考试页结构变了，不能把整个同步拖垮
    try {
      ex = await exams();
    } catch (e) {
      ex = { exams: [], published: false, error: (e && e.message) || String(e) };
    }
    // 学期列表是「考试页能选学期」的前提，属于附加信息：
    // 取不到照样交出考试数据，只把原因写进 semestersError，界面照实说。
    try {
      ex.semesters = await semesters();
    } catch (e) {
      ex.semesters = [];
      ex.semestersError = (e && e.message) || String(e);
    }
    // 培养计划同理：它只影响「学分进度」那一块。取不到不能让整次同步失败，
    // 但**也不能安静地变成「没有培养计划」** —— 那会把「没读到」说成
    // 「学校没给你排计划」，学生看了会以为出了大事。原因原样带回去。
    var pl;
    try {
      pl = await plan();
    } catch (e) {
      pl = {
        total: 0, cats: [], courses: [], subs: [], specials: [],
        error: (e && e.message) || String(e),
      };
    }
    return {
      ok: true,
      syncedAt: Math.floor(Date.now() / 1000),
      profile: prof,
      semester: tt.semester,
      unitCount: tt.unitCount,
      totalWeeks: tt.totalWeeks,
      courses: tt.courses,
      grades: gr,
      exams: ex,
      plan: pl,
    };
  }

  // ------------------------------------------------------------- 校园公告
  //
  // 网页版走 bridge.py 的 notice.py；APK 里没有 Python，所以这一份是它的
  // **逐条对照实现**。两边返回的 JSON 必须一模一样（app.js 只认一套）：
  //   {ok, at, cached, total, items:[{title,url,date,source,dept,keep,tier,tags,drop}],
  //    failed:[{source,status,count}], sources:N}
  //
  // 🔴 公告跟教务系统那套**完全无关**：六个源都是学校各部门的公开网页，
  //    不需要登录、不需要 cookie、也不能带任何凭据。
  //    所以这里一律用很小的请求间隔 —— 1.2 秒那是为了别把同一个教务系统
  //    打疼，而这里是 6 个不同域名各一次。

  var NOTICE_GAP = 220;
  var NOTICE_TTL = 30 * 60 * 1000;
  var noticeCache = { at: 0, data: null };

  // 选源时先看栏目还在不在更新：教务处「教务通知」「教学通知」都停在 2023 年，
  // 停更栏目留着只会让公告栏看起来像坏了。
  // 🔴 达小助改造（W4 停用 / W6 清源）：公告路由已停用（见 NativeApi.handle），
  //   这份郑航六部门源表已从文件里删掉 —— 留着它，任何一条漏停的路径
  //   都会拿用户的手机去访问别的学校的站。升达公告站与链接形状待阶段2抓包，
  //   届时在这里填本校源。郑航原表见 vendor/hangyuantong/web/native.js:1497。
  var NOTICE_SOURCES = [];
  // 详情只允许抓校内域名。否则 ?u=http://evil/... 就成了
  // 「让用户的手机替我访问内网」的一个洞。
  var NOTICE_HOSTS = ['shengda.edu.cn'];

  var N_DROP = [
    ['附小', ['附小', '附属小学', '幼儿园']],
    ['值班表', ['值班表']],
    ['会议新闻', ['工作会议', '教学例会', '工作例会', '见面交流会', '座谈会',
                  '调研交流', '来校调研']],
    ['采购招标', ['采购公告', '中标', '招标', '询价']],
    ['党建公示', ['代表候选人', '党支部', '党委会', '民主生活会', '述职']],
    ['继续教育', ['继续教育招生', '成人教育招生', '自考招生']]
  ];
  var N_IMPACT = ['割接', '停水', '停电', '断网', '封楼', '封闭', '闭馆', '维修',
                  '检修', '调休', '停课', '暂停开放', '交通管制', '禁行', '施工',
                  '停运', '临时调整'];
  var N_ACTION = ['报名', '缴费', '申报', '提交', '补办', '办理', '确认', '注册',
                  '选课', '转专业', '分流', '评教', '申请', '领取', '资格审核',
                  '资格审查', '学籍异动', '毕业论文', '实习', '学业警示', '学生证',
                  '医保', '参保', '团籍', '推优'];
  var N_ACTIVITY = ['校庆', '庆典', '晚会', '比赛', '竞赛', '讲座', '报告会', '展览',
                    '文化节', '运动会', '演出', '招募', '社团', '升旗', '论坛',
                    '沙龙', '典礼', '开放日', '发放', '餐券', '福利', '月饼', '慰问',
                    '志愿服务', '社会实践', '表彰'];
  var N_COHORT = ['新生', '毕业生', '本科生', '团员', '党员', '实习生', '在校生',
                  '学生', '同学', '2026级', '2027届', '2026届', '2025级', '全校师生'];

  function nHasAny(title, kws) {
    for (var i = 0; i < kws.length; i++) if (title.indexOf(kws[i]) >= 0) return true;
    return false;
  }

  /** 与 notice.py 的 classify() 同规则，返回 {keep, tier, tags, drop}。
   *  层级：impact / action / activity / other / drop。 */
  function nClassify(title) {
    for (var i = 0; i < N_DROP.length; i++) {
      if (nHasAny(title, N_DROP[i][1])) {
        return { keep: false, tier: 'drop', tags: [], drop: N_DROP[i][0] };
      }
    }
    if (nHasAny(title, N_IMPACT)) return { keep: true, tier: 'impact', tags: ['影响出行'], drop: '' };
    if (nHasAny(title, N_ACTION)) return { keep: true, tier: 'action', tags: ['要办事'], drop: '' };
    if (nHasAny(title, N_ACTIVITY)) return { keep: true, tier: 'activity', tags: ['活动'], drop: '' };
    // 「学生 / 同学」这类受众词只用来兜住剩下的，不单独打标签 ——
    // 打上去等于每条都挂一个「学生」，等于没分类。
    return { keep: true, tier: 'other', tags: [], drop: '' };
  }

  function nPad2(n) { return (n < 10 ? '0' : '') + n; }

  var N_DATE_RE = /(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/;

  function nUnescape(s) {
    var t = document.createElement('textarea');
    t.innerHTML = String(s == null ? '' : s);
    return t.value;
  }

  /** 去标签 + 反转义 + 去首尾空白。和 notice.py 的 _clean() 同义。 */
  function nCleanText(s) {
    return nUnescape(String(s == null ? '' : s).replace(/<[^>]+>/g, '')).trim();
  }

  function nFmtDate(m) {
    return m[1] + '-' + nPad2(+m[2]) + '-' + nPad2(+m[3]);
  }

  /** 链接附近的日期。**先看链接后面，再看前面** —— 顺序不能反。
   *  校级站的列表是 `<li><a …>标题</a><span>2026-10-09</span></li>`，
   *  先看前面的话窗口左边会命中**上一条**的日期，整列日期集体错位一行，
   *  而且看上去完全正常（每条都有日期、格式也对）。 */
  function nDateAround(html, start, end) {
    var m = N_DATE_RE.exec(nCleanText(html.slice(end, end + 300)));
    if (!m) m = N_DATE_RE.exec(nCleanText(html.slice(Math.max(0, start - 300), start)));
    return m ? nFmtDate(m) : '';
  }

  function nAbsUrl(href, base) {
    try { return new URL(href, base).href; } catch (e) { return ''; }
  }

  /** 列表页 → 条目。按**链接形状**找（/info/数字/数字.htm），不按容器找：
   *  六个部门站的模板不一样，按容器写要写六个解析器。
   *
   *  🔴 这里刻意用正则扫原始 HTML，而不是 DOMParser —— 必须和 notice.py 的
   *     parse_list 是**同一个算法**。用 DOM 的「往上找祖先」写法看着更漂亮，
   *     但它和 Python 取日期的边界不一样（实测校级站 6/9 条日期不一致），
   *     结果就是「网页版日期对、手机上错一行」，而且两边都不报错。
   */
  function nParseList(html, base) {
    var re = /href="([^"]*?info\/\d+\/\d+\.htm)"/gi;
    var out = [], seen = {};
    var m;
    while ((m = re.exec(html)) !== null) {
      var url = nAbsUrl(m[1], base);
      if (!url || seen[url]) continue;
      var tail = html.slice(m.index, m.index + 400);
      var tm = /title="([^"]{4,120})"/.exec(tail);
      var title;
      if (tm) {
        title = nCleanText(tm[1]);
      } else {
        var am = /<a[^>]*>([\s\S]*?)<\/a>/i.exec(tail);
        title = am ? nCleanText(am[1]) : '';
      }
      if (title.length < 5) continue;
      seen[url] = 1;
      out.push({ title: title, url: url, date: nDateAround(html, m.index, m.index + m[0].length) });
    }
    return out;
  }

  /** 正文 → 纯文本，块级元素之间补换行。
   *  🔴 必须保留换行：后面抠「时间 / 地点」全靠一行一行的结构，
   *     textContent 拍平成一整行之后，所有标签都黏在一起。 */
  function nStripBody(html) {
    var s = String(html || '')
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>|<\/h\d>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    return nUnescape(s);
  }

  var N_PAIR_SRC = '([\\u4e00-\\u9fa5]{2,8})[：:]\\s*([^：:]{1,60}?)(?=\\s+[\\u4e00-\\u9fa5]{2,8}[：:]|$)';
  // 「发布时间」「更新时间」「浏览次数」不是活动时间。教务处的页面把这两件事
  // 写在同一行（发布时间：2026-10-20文章来源：实践教学科），只按「标签里有
  // 『时间』」去取，会把**发布日期**当成活动时间显示出来 —— 比不显示更坏。
  var N_SKIP_LABEL = ['发布', '更新', '浏览'];

  function nPickPair(lines, want) {
    for (var i = 0; i < lines.length; i++) {
      var re = new RegExp(N_PAIR_SRC, 'g');
      var m;
      while ((m = re.exec(lines[i])) !== null) {
        var skip = false;
        for (var k = 0; k < N_SKIP_LABEL.length; k++) {
          if (m[1].indexOf(N_SKIP_LABEL[k]) >= 0) { skip = true; break; }
        }
        if (skip) continue;
        for (var w = 0; w < want.length; w++) {
          if (m[1].indexOf(want[w]) >= 0) return m[2].trim();
        }
      }
    }
    return '';
  }

  function nGrabNext(lines, labels, span) {
    span = span || 3;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.length > 24) continue;
      var skip = false;
      for (var k = 0; k < N_SKIP_LABEL.length; k++) {
        if (l.indexOf(N_SKIP_LABEL[k]) >= 0) { skip = true; break; }
      }
      if (skip) continue;
      var hit = false;
      for (var w = 0; w < labels.length; w++) if (l.indexOf(labels[w]) >= 0) { hit = true; break; }
      if (!hit) continue;
      var buf = [];
      for (var n = i + 1; n <= i + span && n < lines.length; n++) {
        if (/^[一二三四五六七八九十]+、/.test(lines[n])) break;
        buf.push(lines[n]);
      }
      if (buf.length) return buf.join(' ').slice(0, 140);
    }
    return '';
  }

  // 正文从哪一句开始：不同部门模板不一样，教务处直接就是「各学院：」，
  // 少了这一项那一大批通知的摘要会整篇为空。
  var N_BODY_START = /(各有关单位|各部门|各单位|各学院|各系|各教学单位|各二级学院|全校师生|全体学生|各位同学|同学们)/;
  var N_BODY_END = /(下一条|上一条|关闭窗口|版权所有|ICP备|浏览次数)/;

  function nParseArticle(html) {
    var raw = nStripBody(html).split('\n');
    var lines = [];
    for (var i = 0; i < raw.length; i++) {
      var t = raw[i].replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '');
      if (t) lines.push(t);
    }

    var dept = '', pub = '';
    for (var j = 0; j < lines.length && j < 400; j++) {
      var m = /(?:日期|发布时间|发布日期)[：:]\s*(20\d{2}-\d{2}-\d{2})/.exec(lines[j]);
      if (m) pub = m[1];
      var m2 = /(?:作者|文章来源|来源)[：:]\s*(\S{2,30})/.exec(lines[j]);
      if (m2 && !dept) dept = m2[1];
      if (pub && dept) break;
    }

    var when = nPickPair(lines, ['时间']) ||
               nGrabNext(lines, ['活动时间', '举办时间', '会议时间', '报名时间', '活动日期', '时间']);
    var where = nPickPair(lines, ['地点', '场地']) ||
                nGrabNext(lines, ['活动地点', '举办地点', '会议地点', '活动场地', '地点']);
    if (!when) {
      for (var k = 0; k < lines.length; k++) {
        var m3 = /\d{1,2}\s*月\s*\d{1,2}\s*日[^\n]{0,40}?\d{1,2}\s*[:：]\s*\d{2}/.exec(lines[k]);
        if (m3) { when = m3[0].slice(0, 140); break; }
      }
    }

    // 正文摘要：跳过导航（前面几十行全是栏目名），从问候语之后取。
    // ⚠️ 不能光看「句子里有没有『各单位』」—— 正文中间会出现
    //    「（二）各单位组织讲解」这种句子，一匹配就从那儿开始截。
    var body = [], started = false;
    for (var a = 0; a < lines.length; a++) {
      if (!started) {
        if (N_BODY_START.test(lines[a]) && (lines[a].length <= 30 || /^(各|全体|各位)/.test(lines[a]))) {
          started = true;
        }
        continue;
      }
      if (N_BODY_END.test(lines[a])) break;
      if (lines[a].length >= 8) body.push(lines[a]);
      if (body.join('').length > 500) break;
    }

    if (!body.length) {
      // 兜底：从「发布时间 / 文章来源」那行之后开始，至少别让界面
      // 显示成「这篇文章没有正文」。
      var metaI = -1;
      for (var b = 0; b < lines.length; b++) {
        if (/(发布时间|文章来源|发布日期|日期[：:])/.test(lines[b])) { metaI = b; break; }
      }
      if (metaI >= 0) {
        for (var c = metaI + 1; c < lines.length; c++) {
          if (N_BODY_END.test(lines[c])) break;
          if (lines[c].length >= 8) body.push(lines[c]);
          if (body.join('').length > 500) break;
        }
      }
    }

    return { publish: pub, dept: dept, when: when, where: where,
             summary: body.join('\n').slice(0, 500) };
  }

  async function nFetchList(limit, force) {
    var now = Date.now();
    if (!force && noticeCache.data && now - noticeCache.at < NOTICE_TTL) {
      var copy = JSON.parse(JSON.stringify(noticeCache.data));
      copy.cached = true;
      return copy;
    }

    var all = [], failed = [];
    for (var i = 0; i < NOTICE_SOURCES.length; i++) {
      var name = NOTICE_SOURCES[i][0];
      var url = NOTICE_SOURCES[i][1];
      var dept = NOTICE_SOURCES[i][2];
      var r = null;
      // 单个源失败绝不能拖垮整体：6 个源坏 1 个，另外 5 个照样要出内容。
      try { r = await http('GET', url, '', '', NOTICE_GAP); } catch (e) { r = null; }
      var items = (r && r.status === 200) ? nParseList(r.body, url) : [];
      if (!r || r.status !== 200 || !items.length) {
        // 🔴 失败要往上报，不能安静地少一块 —— 否则「今天只有 3 条」
        //    看不出是「真的只有 3 条」还是「5 个源没取到」。
        failed.push({ source: name, status: (r && r.status) || 0, count: items.length });
      }
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        it.source = name;
        it.dept = dept;
        var cls = nClassify(it.title);
        it.keep = cls.keep;
        it.tier = cls.tier;
        it.tags = cls.tags;
        it.drop = cls.drop;
        all.push(it);
      }
    }

    var uniq = [], seen = {};
    for (var k = 0; k < all.length; k++) {
      var key = all[k].url.split('/info/').pop();
      if (seen[key]) continue;
      seen[key] = 1;
      uniq.push(all[k]);
    }
    uniq.sort(function (x, y) {
      return String(y.date || '0000').localeCompare(String(x.date || '0000'));
    });

    var kept = [];
    for (var q = 0; q < uniq.length; q++) if (uniq[q].keep) kept.push(uniq[q]);

    var data = {
      ok: true,
      at: Math.floor(now / 1000),
      cached: false,
      total: uniq.length,
      items: kept.slice(0, limit),
      failed: failed,
      sources: NOTICE_SOURCES.length - failed.length
    };
    noticeCache = { at: now, data: data };
    return JSON.parse(JSON.stringify(data));
  }

  async function nFetchDetail(url) {
    var host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) { host = ''; }
    var okHost = false;
    for (var i = 0; i < NOTICE_HOSTS.length; i++) {
      var h = NOTICE_HOSTS[i];
      if (host === h || host.slice(-(h.length + 1)) === '.' + h) { okHost = true; break; }
    }
    if (!okHost) return { ok: false, error: '只能查看校内站点的通知' };

    var r = null;
    try { r = await http('GET', url, '', '', NOTICE_GAP); } catch (e) {
      return { ok: false, error: '打开通知失败：' + e };
    }
    if (!r || r.status !== 200) {
      return { ok: false, error: '通知没打开，过一会儿再试' };
    }
    var d = nParseArticle(r.body);
    d.ok = true;
    d.url = url;
    return d;
  }

  // ------------------------------------------------------------- 智慧门户
  //
  // 与 bridge.py 的 portal.py 一一对应，逻辑必须一致（有对照测试）。
  // 三条硬规矩照抄，别绕过：
  //   1. 🔴 绝不自动识别验证码 —— 门户错 5 次锁号，而「识别错了」和
  //      「密码打错了」在服务器那边是同一个计数器。
  //   2. 🔴 判据是「需要登录的接口返回 200」，不是「cookie 在不在」。
  //   3. 🔴 过期就说过期，不把「没读到」显示成「没有数据」。
  //
  // 门户是「门票 + 身份证」两层：
  //   customsid + Authorization（rhmh 域）= 门票，几小时作废
  //   CASTGC（sfrz 域）= 身份证，拿它 POST /v1/tickets/{TGT} 就能换新门票，
  //   不用密码也不用验证码。所以日常刷新是零成本的。
  //
  // ⚠️ 这里的 `tgt`（身份证）存在 localStorage 里，**不用 cookie**：
  //   换票靠的是 URL 里那个 TGT 本身，不需要它变成 cookie。
  //   而 `Authorization` 是服务器 Set-Cookie 下发的，JS 读不到，
  //   只能通过 Android.cookie() 从原生的 CookieStore 里取。

  // 🔴 达小助改造（W4）：一卡通/门户段停用 —— PF.SF/RH/SERVICE、CARD id、RSA modulus
  //   全是郑航系统的实测值，对升达无效。pfLogin/pfCard/pfApps 不再被路由调用
  //   （card/apps 已返回「未适配」）。升达门户 my.shengda.edu.cn 的会话机制不同
  //   （走 CASTGC），待阶段2抓包确认后重写这一段。下面常量保留仅作历史参照。
  var PF = {
    // 🔴 达小助改造（W6）：郑航那套门户地址、卡 id、RSA 公钥全部**清空**。
    //   留着它们没有任何用处（四条门户路由都已停用），但只要还在文件里，
    //   哪天有人照着 pfLogin 接一条新路由，就会把学生的账密送到别的学校去。
    //   要恢复这一段：底座原文在 vendor/hangyuantong/web/native.js。
    SF: '',
    RH: '',
    SERVICE: '',
    CARD: '',
    KEY: 'hyPortal',
    // 上次「保活」的时间戳（毫秒）。见 pfKeepAlive。
    TOUCH: 'hyPortal.touchAt',
    EXP: 65537,
    // 门户 app.js 里的 public_exponent / modulus 两个字面量（已清空，见上）
    N: '',
  };

  var pfCap = null;          // {uid, at} 验证码是一次性的，只活在这台手机的内存里
  var pfMod = null;

  function pfModulus() {
    if (!pfMod) pfMod = BigInt('0x' + PF.N);
    return pfMod;
  }

  /** 大整数模幂。e=65537 = 2^16+1，其实只有 17 轮，快到可以忽略。 */
  function pfModPow(b, e, n) {
    var r = 1n;
    b = b % n;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % n;
      b = (b * b) % n;
      e >>= 1n;
    }
    return r;
  }

  /** 门户要求的密码加密。
   *
   *  ⚠️ **不是**标准 PKCS#1 v1.5。门户用的是老版 jsbn（标志是
   *     `setMaxDigits(131)` 加三参数 `RSAKey(e, "", n)`），它把密码字节
   *     按**小端**当整数用、末尾补 0 到分组长度，然后直接 pow(m, e, n)，
   *     没有任何随机填充。
   *     我一开始按标准 PKCS#1（大端 + 随机填充）写，服务器回 PASSERROR
   *     （密码错）—— 而它分不清「解不开」和「密码不对」，看着就像密码记错了。
   *     现在的实现和浏览器发出去的密文**逐字节一致**（portal.py 里同一份逻辑）。
   */
  function pfRsa(text) {
    var bytes = utf8Bytes(String(text));
    if (bytes.length > 126) throw new Error('密码太长了');
    var m = 0n;
    for (var i = bytes.length - 1; i >= 0; i--) m = (m << 8n) | BigInt(bytes[i]);
    var hex = pfModPow(m, BigInt(PF.EXP), pfModulus()).toString(16);
    while (hex.length < 256) hex = '0' + hex;
    return hex;
  }

  function pfState() {
    try { return JSON.parse(localStorage.getItem(PF.KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function pfSaveState(st) {
    try { localStorage.setItem(PF.KEY, JSON.stringify(st || {})); }
    catch (e) { /* 存不下就只活这一次，不影响本次使用 */ }
  }

  /** 门票（JWT）。服务器用 Set-Cookie 下发，JS 自己读不到，只能问原生。 */
  function pfJwt() {
    try {
      if (!window.Android || typeof Android.cookie !== 'function') return '';
      return String(Android.cookie(PF.RH + '/', 'Authorization') || '');
    } catch (e) { return ''; }
  }

  /* ---------------- 门户密码：存本机，过期重登只剩一道验证码 ----------------
   *
   * 为什么要存：门户那张 CASTGC（身份证）撑不过 7.2 小时，过期只能重新登录，
   * 而登录要「密码 + 算术验证码」。密码留在本机之后，人只需要算那道题 ——
   * 验证码不能自动识别（错 5 次锁号），所以这是能省的最大值。
   *
   * 🔴 密码走原生 CredStore（Android Keystore，和教务那份同一套机制），
   *    **绝不进 localStorage** —— 那里是明文，一个 `localStorage.getItem` 就拿到了。
   * 🔴 也绝不放进任何 HTTP 响应体（/api/portal/status 只回「存的是哪个学号」）。
   */
  function pfCredLoad() {
    try {
      if (!window.Android || typeof Android.loadPortalCred !== 'function') return null;
      var s = String(Android.loadPortalCred() || '');
      if (!s) return null;
      var o = JSON.parse(s);
      return (o && o.u && o.p) ? { u: String(o.u), p: String(o.p) } : null;
    } catch (e) { return null; }
  }

  /** 存门户密码。
   *
   *  返回：'' = 存好了（Keystore）；'soft' = 存好了但走的是备用加密方式；
   *        'fail: xxx' = 没存上，xxx 是原因；'none' = 这个壳没有这个能力。
   *
   *  🔴 必须把原生给的**原因**带回去。以前这里把返回值丢掉了，存失败时
   *     界面上一句提示都没有 —— 用户只会觉得「它根本没记住密码」，
   *     而真正的原因（密钥库不可用 / 写文件失败）永远看不到，也没法自救。
   */
  function pfCredSave(u, p) {
    try {
      if (!window.Android || typeof Android.savePortalCred !== 'function') return 'none';
      return String(Android.savePortalCred(String(u || ''), String(p || '')) || '');
    } catch (e) {
      return 'fail: 调用原生保存出错（' + ((e && e.message) || e) + '）';
    }
  }

  function pfCredClear() {
    try {
      if (window.Android && typeof Android.clearPortalCred === 'function') Android.clearPortalCred();
    } catch (e) { /* 清不掉也只能这样 */ }
  }

  /** 本机门户密码的状态："none" 没存过 / "ok" 存着且解得开 /
   *  "broken" 存着但解不开（系统密钥库被重置过）。空串 = 这个壳没这能力。
   *
   *  为什么要单独问一次：`saved` 只回答「能不能用」，回答不了
   *  「是从来没存过，还是存过但坏了」—— 这两种情况给用户的话不一样。 */
  function pfCredState() {
    try {
      if (!window.Android || typeof Android.portalCredState !== 'function') return '';
      return String(Android.portalCredState() || '');
    } catch (e) { return ''; }
  }

  /** 门户错误码（PASSERROR / CODEFALSE / …）。认不出来就是空串 ——
   *  「不知道」和「不是密码错」必须分开，调用方靠它决定要不要删本机密码。 */
  function pfCode(j) {
    if (!j || typeof j !== 'object') return '';
    var nodes = [j.data, j.meta, j];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || typeof n !== 'object') continue;
      var c = String(n.code || '');
      if (c) return c;
    }
    return '';
  }

  /** 只有这几种才允许把本机那份密码删掉。CODEFALSE（验证码算错）不在此列 ——
   *  手滑一次就把密码删了，用户下次还得重输，等于白存。 */
  var PF_PWD_BAD = ['PASSERROR', 'NOUSER', 'USERLOCK'];

  /** 从 JWT 里取学号。用正则而不是 JSON.parse —— payload 是 base64，
   *  要先做 UTF-8 解码，而学号是纯数字，正则够用且不会因为编码炸掉。 */
  function pfSub(jwt) {
    try {
      var p = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      var m = /"sub"\s*:\s*"([^"]*)"/.exec(atob(p));
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  function pfHeaders(jwt, json) {
    var h = {
      authorization: jwt || '',
      accept: 'application/json, text/plain, */*',
      languagetype: 'zh',
      'x-requested-with': 'XMLHttpRequest',
      referer: PF.RH + '/',
      origin: PF.RH,
    };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  /** 门户请求。
   *
   *  不走 http()：那个每次要等 POLITE_MS（1.2 秒）—— 那是为了别把脆弱的
   *  教务系统打疼。门户不脆，而且一卡通要翻 3 页，每页等 1.2 秒就是四秒白等。
   *  仍然复用同一套 id/回调通道，所以 window.__nativeDone 不用改。
   */
  function pfHttp(method, url, body, headers) {
    return new Promise(function (resolve, reject) {
      try { guardUrl(url); } catch (e0) { reject(e0); return; }
      var id = ++seq;
      waiting[id] = { resolve: resolve, reject: reject };
      try {
        if (window.Android && typeof Android.req2 === 'function') {
          Android.req2(id, method, url, body || '', '',
                       headers ? JSON.stringify(headers) : '');
        } else {
          // 老壳没有 req2（不带自定义头）。门户接口会 401，但不会崩，
          // 而且 status 那边会如实说「没连上」。
          Android.req(id, method, url, body || '', '');
        }
      } catch (e) {
        delete waiting[id];
        reject(new Error('原生请求失败：' + e));
      }
    });
  }

  function pfExpired(msg) {
    var e = new Error(msg || '门票过期');
    e.expired = true;
    return e;
  }

  /** 用身份证换门票。成功 true；身份证也过期了 false。 */
  async function pfRenew() {
    var st = pfState();
    if (!st.tgt) return false;
    var r = null;
    try {
      r = await pfHttp('POST', PF.SF + '/v1/tickets/' + encodeURIComponent(st.tgt),
                       form({ service: PF.SERVICE }));
    } catch (e) { throw new Error('连不上学校门户，检查一下网络'); }
    var ticket = (r && r.status === 200) ? String(r.body || '').trim() : '';
    if (ticket.indexOf('ST-') !== 0) return false;      // 身份证也过期了
    await pfHttp('GET', PF.SERVICE + '?ticket=' + encodeURIComponent(ticket));
    await pfHttp('GET', PF.RH + '/');
    return !!pfJwt();
  }

  /** 手上有没有「身份证」（TGT）。两条来源，顺序不能反。
   *
   *  ① 本机存的 `st.tgt` —— CAS REST 登录时服务端把 TGT 放在**响应体**里，
   *     我们一直是把它当字符串存的（见 PF 常量上面那段注释）。
   *  ② 罐子里的 `CASTGC` cookie —— **只有「在 WebView 里手动登录过一次」才有**。
   *     CAS 的登录页会把 TGT 写进这张 cookie，它的值就是 TGT，可以直接用。
   *
   *  🔴 为什么必须两条都认（2026-10-27 用户真机截图）：
   *     APK 的登录走 REST，**根本不会产生 CASTGC 这张 cookie**。
   *     而 `WebActivity` 判断「有没有登录态」看的偏偏就是它 ⇒ 永远判成过期，
   *     于是每点一个办事入口都弹一句「门户登录已过期」，然后真的落在登录页。
   *     假话说了太多次，就没人再信那句提示了。
   */
  /** 手上所有可能是「身份证」（TGT）的值，**按新鲜度排好序**。
   *
   *  三条来源，顺序不能反：
   *   ① WebView 罐里的 `CASTGC` —— 用户在 App 内的网页里登录过才有，最新鲜
   *   ② 本机存的 `st.tgt` —— REST 登录时服务端把 TGT 放在**响应体**里
   *   ③ Java 罐里的 `CASTGC` —— 换过票 / 手动登过之后回灌进来的
   *
   *  🔴 为什么返回**列表**而不是一个值（2026-10-28 用户第三次报「还要重登」）：
   *     以前这里挑第一个「以 `TGT-` 开头」的返回，挑不到就当「本机没凭据」。
   *     问题是「CASTGC 的值长什么样」是**服务端的实现细节**：
   *       · Apereo CAS 原版：`TGT-1234-abcd-cas01`，`TGT-` 前缀成立
   *       · 学校这套 lyuapServer：可能带自己的前缀，或者干脆是另一套编号
   *     一旦前缀对不上，代码就静默判成「没有凭据」⇒ 不换票 ⇒ 裸开 ⇒
   *     落回登录页。表现和「真的过期了」一模一样，而用户其实一直登着。
   *
   *     ⇒ 现在**不猜格式**：只要 cookie 里有个非空值就当候选，
   *       拿去换票，换到了就说明它真是 TGT（服务端说了算，不是我们说了算）。
   *
   *  ⚠️ 探测路径要给全：`Android.cookie` / `Android.webCookie` 底层是
   *     `CookieStore.get(uri)` / `CookieManager.getCookie(url)`，**只返回
   *     Path 是 uri 路径前缀的 cookie**。CASTGC 的 Path 可能是 `/lyuapServer`、
   *     `/lyuapServer/login`，也可能是 `/`。少写一条就少一次机会，而且不报错。
   */
  function pfTgtCands() {
    var out = [];
    var st = pfState();
    var casBase = cfgUrl(CFG.cas.base);            // .../lyuapServer
    var casRoot = casBase.replace(/\/lyuapServer.*$/, '') || casBase;
    var cands = [casBase + '/', casBase + '/login', casRoot + '/'];

    function add(v, from) {
      v = String(v || '').trim();
      // 空值不候选：那通常是服务端下发的「删掉这条」
      if (!v) return;
      for (var i = 0; i < out.length; i++) {
        if (out[i].v === v) return;        // 同一个值被两条路径问到，只留一份
      }
      out.push({ v: v, from: from });
    }

    // ---- 1) WebView 罐（最新鲜） ----
    // 🔴 优先用 `webCookieLike`（按**前缀**取），不是 `webCookie`（精确名字）。
    //    票 cookie 的名字是服务端实现细节：Apereo 原版叫 CASTGC，学校这套
    //    lyuapServer 完全可能叫 CASTGC_xxx。精确匹配对不上就返回空串，
    //    而空串和「确实没登录」长得一模一样 —— 这是最坑的那种失败。
    try {
      if (window.Android && typeof Android.webCookieLike === 'function') {
        for (var wi = 0; wi < cands.length; wi++) {
          var got = String(Android.webCookieLike(cands[wi], 'CASTGC') || '');
          if (!got) continue;
          var lines = got.split('\n');
          for (var li = 0; li < lines.length; li++) add(lines[li], 'web');
        }
      } else if (window.Android && typeof Android.webCookie === 'function') {
        // 老壳（没有 webCookieLike）退回精确匹配 —— 有总比没有强
        for (var wj = 0; wj < cands.length; wj++) {
          add(Android.webCookie(cands[wj], 'CASTGC'), 'web');
        }
      }
    } catch (e) { /* 读不到就往下走 */ }

    // ---- 2) 我们自己存的那张（门户登录成功后写进来的） ----
    add(st.tgt, 'store');

    // ---- 3) Java 罐 ----
    try {
      if (window.Android && typeof Android.cookie === 'function') {
        for (var ci = 0; ci < cands.length; ci++) {
          add(Android.cookie(cands[ci], 'CASTGC'), 'java');
        }
      }
    } catch (e) { /* 读不到就当没有，下面会如实说「没有身份证」 */ }

    return out;
  }

  /** 第一个候选。给只想要「有没有凭据」的调用方用（`pfRenew` 等）。
   *
   *  ⚠️ 别拿它做「有没有登录态」的判断 —— 那是 `pfTgtCands().length > 0`。
   */
  function pfTgt() {
    var list = pfTgtCands();
    if (!list.length) return '';
    var v = list[0].v;
    var st = pfState();
    // 值没变就别重写：pfTgt 每次点功能都会调一次，白写盘没意义
    if (st.tgt !== v && list[0].from !== 'store') pfSaveState({ tgt: v });
    return v;
  }

  /** 保活：把门户会话「摸」一下，别让它闲到过期（2026-10-28）。
   *
   * ================================================================
   * 为什么加这个（用户第三次说「智慧门户还是要重复登录」）
   * ================================================================
   * 门户的会话大约 7.2 小时不用就作废（见 app.js 里 loadCampus 上面那段）。
   * 作废之后**没法自动重登**：学校的登录接口要验证码，而验证码只能人算
   * （红线：绝不自动识别）。所以「过期」对用户就等于「再输一次密码 + 算一道题」。
   *
   * 以前 App 的策略是「尽量不碰门户」（省流量、省得每次进页面都等），
   * 于是它**永远**是闲到过期的那一个 —— 一天要重登好几次。
   *
   * 这里换个思路：**偶尔摸一下**。CAS 的 TGT 通常是滑动过期（每次用就续上），
   * 只要在窗口内用一次，会话就一直活着。
   *
   * ================================================================
   * 四条纪律
   * ================================================================
   * 1. **最多每 2 小时一次**（`PF.TOUCH` 记账）。再多就是拿用户的流量换心安。
   * 2. **先记账再发请求**。反过来的话，一次网络失败会让它每次进页面都重试，
   *    等于把「省流量」变成「烧流量」。
   * 3. **后台跑，不 await、不弹任何提示**。保活失败是**无害**的：
   *    真过期了，后面 card/apps 会如实说 needLogin，用户照样知道。
   *    这里弹一句「续期失败」只会让人以为坏了。
   * 4. **没有身份证就别试**。省一次必然 404 的请求。
   *
   * ⚠️ 「学校 CAS 是不是滑动过期」我这边**验不了**（要真机 + 抓包）。
   *    如果是绝对过期（到点就死，用不用都一样），这个保活不会有坏处，
   *    只是也没用 —— 那就得换别的办法（比如引导用户去网页登录一次，
   *    拿到可持久的 CASTGC）。
   */
  async function pfKeepAlive() {
    try {
      if (!pfTgtCands().length) return;
      var last = Number(localStorage.getItem(PF.TOUCH) || 0) || 0;
      if (last && Date.now() - last < 2 * 3600 * 1000) return;
      try { localStorage.setItem(PF.TOUCH, String(Date.now())); } catch (e) { }
      var r = await pfServiceTicket(PF.SERVICE);
      if (!r || !r.ok) return;
      // 拿到票还不算「用过」—— 拿它把门户自己的会话也续上（和 pfRenew 后半段一致）
      await pfHttp('GET', PF.SERVICE + '?ticket=' + encodeURIComponent(r.ticket));
    } catch (e) {
      // 保活失败不影响任何功能，也不许冒泡成「未处理的 Promise 拒绝」
    }
  }

  /** 拿身份证换一张**专门给某个办事系统**的票。
   *
   *  为什么要这么干：办事系统（学生信息管理、请假、打印中心…）都接的是
   *  统一身份认证，进门要一张 CAS 票据。**票拼在地址后面**，系统自己拿去
   *  CAS 验，验过就是登录态 —— 这条路完全不依赖 cookie，
   *  所以它不受「两个罐子」那件事的影响。
   *
   *  🔴 和 `pfRenew()` 的区别：那个换的是**门户自己的**票（service 写死成
   *     rhmh），只能让门户认你；办事系统要的是**以它自己地址为 service**
   *     的票。票和 service 是绑定的，拿门户的票去开别的系统一律 INVALID_TICKET。
   *
   *  返回：{ok:true, ticket:'ST-...'}
   *        {ok:false, why:'no-tgt'|'expired'|'net', error:'人话'}
   */
  async function pfServiceTicket(service) {
    var list = pfTgtCands();
    if (!list.length) return { ok: false, why: 'no-tgt', error: '还没有登录门户' };
    var netFail = 0;
    for (var i = 0; i < list.length; i++) {
      var r = null;
      try {
        r = await pfHttp('POST', PF.SF + '/v1/tickets/'
                         + encodeURIComponent(list[i].v), form({ service: service }));
      } catch (e) {
        netFail++;
        continue;                       // 这一次网络抖了，换下一个候选再试
      }
      var t = (r && r.status === 200) ? String(r.body || '').trim() : '';
      if (t.indexOf('ST-') === 0) {
        // 换到了 ⇒ 服务端认这个值就是有效 TGT（不管它长什么样）。
        // 记下来，下次不用再把三条来源全问一遍。
        if (pfState().tgt !== list[i].v) pfSaveState({ tgt: list[i].v });
        return { ok: true, ticket: t };
      }
    }
    // 全部候选都被拒 = 真的都过期了；全部都没连上 = 网络问题。
    // 这两种对用户是**两个不同的动作**（重新登录 / 换个网再试），不能合并。
    if (netFail >= list.length) return { ok: false, why: 'net', error: '连不上学校门户' };
    return { ok: false, why: 'expired', error: '门户登录过期了', tried: list.length };
  }

  /** 跑一次取数：门票过期就换一张再跑，身份证也过期才报 expired。 */
  async function pfCall(fn) {    try {
      return await fn();
    } catch (e) {
      if (!e || !e.expired) throw e;
      if (!(await pfRenew())) {
        throw pfExpired('门户登录过期了，重新输一次密码和验证码就行');
      }
      return await fn();
    }
  }

  /** 取数失败的统一形状。
   *  🔴 expired 必须单独标出来：前端据此说「重新登录」。
   *     把「网络抖了一下」说成「登录过期」会让用户白输一次密码和验证码
   *     （门户错 5 次锁号）；反过来把「真过期了」说成「没读到」，
   *     他会一直点刷新、一直没反应。 */
  function pfFailBody(e) {
    var b = { ok: false, error: String((e && e.message) || e) };
    if (e && e.expired) b.needLogin = true;
    return b;
  }

  async function pfCardPage(startpage) {
    var jwt = pfJwt();
    if (!jwt) throw pfExpired('还没有登录门户');
    var r = await pfHttp('POST', PF.RH + '/api/upp/cardFrontlist/getCard/' + PF.CARD,
                         JSON.stringify({ startpage: startpage, enablePagging: true }),
                         pfHeaders(jwt, true));
    if (!r || r.status !== 200) throw pfExpired();
    var j = null;
    try { j = JSON.parse(r.body); } catch (e) {
      throw new Error('一卡通没读出来，门户可能改版了');
    }
    if (!j || !j.meta || !j.meta.success) throw new Error('一卡通这次没给数据，过一会儿再试');
    var sd = (j.data || {}).serviceData || {};
    var rows = Array.isArray(sd.data) ? sd.data : [];
    var total = 0;
    if (rows.length && rows[0]) total = parseInt(rows[0].pageTotalCount, 10) || 0;
    return { rows: rows, total: total };
  }

  /** 一卡通余额 + 明细。
   *  ⚠️ 字段是拼音缩写，猜不出来：RQ 时间 / XFZD 地点 / DBXF 单笔（本身带负号）
   *     / ZCLX 类型 / YE 余额（**前面带一串空格**，不 trim 转不了数字）。 */
  async function pfCard() {
    return await pfCall(async function () {
      var first = await pfCardPage(1);
      var all = first.rows.slice();
      var page = 2;
      // 一页 12 条，33 条要 3 页。上限 4 页 —— 更早的历史对「最近花哪了」没意义。
      while (all.length < first.total && page <= 4) {
        var more = null;
        try { more = await pfCardPage(page); } catch (e) { break; }
        if (!more.rows.length) break;
        all = all.concat(more.rows);
        page++;
      }
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var x = all[i] || {};
        out.push({
          time: String(x.RQ || '').trim(),
          place: String(x.XFZD || '').trim(),
          amount: pfNum(x.DBXF),
          kind: String(x.ZCLX || '').trim(),
        });
      }
      return {
        balance: all.length ? pfNum(all[0].YE) : null,
        rows: out,
        total: first.total,
      };
    });
  }

  function pfNum(v) {
    if (v == null) return null;
    var n = parseFloat(String(v).replace(/,/g, '').trim());
    return isNaN(n) ? null : n;
  }

  async function pfApps() {
    return await pfCall(async function () {
      var jwt = pfJwt();
      if (!jwt) throw pfExpired('还没有登录门户');
      // pageSize=-1 才是「一次全给」，写 10 或 20 只给第一页
      var r = await pfHttp('GET', PF.RH + '/api/upp/appStore/queryApp'
        + '?pageNum=1&pageSize=-1&excludeMobile=1', '', pfHeaders(jwt));
      if (!r || r.status !== 200) throw pfExpired();
      var j = null;
      try { j = JSON.parse(r.body); } catch (e) {
        throw new Error('应用列表没读出来');
      }
      var data = (j || {}).data;
      if (!Array.isArray(data)) throw new Error('应用列表没读出来，门户可能改版了');
      var out = [];
      for (var i = 0; i < data.length; i++) {
        var a = data[i] || {};
        var url = String(a.appLink || a.mobileLink || '').trim();
        var name = String(a.appName || '').trim();
        if (!url || !name) continue;      // 没地址的入口点了也没反应，不如不显示
        out.push({ name: name, dept: pfLabel(a), url: url,
                   cas: String(a.isCas || '') === 'cas' });
      }
      return { apps: out };
    });
  }

  /** 归属部门。`labelName` 是 `[{zh_CN:{labelName:'日常服务'}}]`，
   *  但接口在某些应用上给空数组、给 null、或者干脆给个对象 —— 一律挡一遍，
   *  别让一个畸形字段打断整张列表。 */
  function pfLabel(a) {
    var lab = a.labelName;
    var first = Array.isArray(lab) ? lab[0] : lab;
    if (!first || typeof first !== 'object') return '';
    var zh = first.zh_CN;
    if (!zh || typeof zh !== 'object') return '';
    return String(zh.labelName || '').trim();
  }

  /** 拿一张验证码。`uid` 只留在内存里，**不回给页面** ——
   *  这样它天然和这次会话绑定，也不会被页面上的脚本改掉（改了就等于帮用户答错）。 */
  async function pfCaptcha() {
    var r = await pfHttp('GET', PF.SF + '/kaptcha', '',
                         { referer: PF.SF + '/login?service=' + PF.SERVICE,
                           'x-requested-with': 'XMLHttpRequest' });
    if (!r || r.status !== 200) throw new Error('拿不到验证码，检查一下网络');
    var j = null;
    try { j = JSON.parse(r.body); } catch (e) { j = null; }
    var uid = j && j.uid ? String(j.uid) : '';
    var img = j && j.content ? String(j.content) : '';
    if (!uid || img.indexOf('base64,') < 0) {
      throw new Error('验证码没拿到，门户可能改版了');
    }
    var life = parseInt(j.timeout, 10) || 300;
    // 留 15 秒余量：算得太慢的话服务端那边其实已经作废了，
    // 这时候提交必然「验证码错误」，白消耗一次错误次数。
    pfCap = { uid: uid, at: Date.now() + Math.max(30, life - 15) * 1000 };
    return { ok: true, img: img, timeout: life };
  }

  async function pfLogin(user, pass, code) {
    if (!pfCap || !pfCap.uid) {
      return { ok: false, error: '验证码过期了，换一张重新算', needCaptcha: true };
    }
    if (Date.now() > pfCap.at) {
      pfCap = null;
      return { ok: false, error: '验证码过期了，换一张重新算', needCaptcha: true };
    }
    var uid = pfCap.uid;
    pfCap = null;      // 🔴 一次性：不管成没成，这张都不能再用
    var r = null;
    try {
      r = await pfHttp('POST', PF.SF + '/v1/tickets', form({
        username: user,
        password: pfRsa(pass),
        service: PF.SERVICE,
        loginType: '',
        id: uid,
        code: code,
        otpcode: '',
      }), { referer: PF.SF + '/login?service=' + PF.SERVICE,
            origin: (String(CFG.cas.base).match(/^https?:\/\/[^/]+/i) || [''])[0],
            'x-requested-with': 'XMLHttpRequest',
            accept: 'application/json, text/plain, */*' });
    } catch (e) {
      return { ok: false, error: '连不上学校门户，检查一下网络', needCaptcha: true };
    }

    var body = String((r && r.body) || '');
    var j = null;
    try { j = JSON.parse(body); } catch (e) { j = null; }
    var tgt = pfFind(j, 'TGT-');
    var ticket = pfFind(j, 'ST-');

    if (tgt) pfSaveState({ tgt: tgt, user: user });
    if (ticket) {
      await pfHttp('GET', PF.SERVICE + '?ticket=' + encodeURIComponent(ticket));
      await pfHttp('GET', PF.RH + '/');
    }
    if (!pfJwt()) {
      // code 一并带出去：调用方要据此判断「是不是本机存的密码已经不对了」。
      // 中文文案不能拿来做判断（改一句话就崩，而且不报错）。
      return { ok: false, error: pfWhy(j, r), needCaptcha: true, code: pfCode(j) };
    }
    var who = pfSub(pfJwt()) || user;
    pfSaveState({ tgt: tgt || (pfState().tgt || ''), user: who });
    return { ok: true, user: who };
  }

  /** 在返回的 JSON 里递归找以某个前缀开头的字符串。
   *  CAS 不同版本把票据放在 ticket / data.ticket / tgt 上，写死一层就是赌版本。 */
  function pfFind(o, prefix, depth) {
    depth = depth || 0;
    if (depth > 6 || o == null) return '';
    if (typeof o === 'string') return o.indexOf(prefix) === 0 ? o : '';
    if (Array.isArray(o)) {
      for (var i = 0; i < o.length; i++) {
        var g = pfFind(o[i], prefix, depth + 1);
        if (g) return g;
      }
      return '';
    }
    if (typeof o === 'object') {
      if (typeof o.ticket === 'string' && o.ticket.indexOf(prefix) === 0) return o.ticket;
      if (typeof o.tgt === 'string' && o.tgt.indexOf(prefix) === 0) return o.tgt;
      for (var k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        var v = pfFind(o[k], prefix, depth + 1);
        if (v) return v;
      }
    }
    return '';
  }

  /** 把服务端的拒绝理由翻成人话。**不猜** —— 认不出来就带上状态码，
   *  别编一个「密码错误」去误导用户（他可能只是验证码算错了）。 */
  function pfWhy(j, r) {
    var MAP = {
      CODEFALSE: '验证码算错了，换一张重算',
      PASSERROR: '账号或密码不对',
      NOUSER: '没有这个账号',
      USERLOCK: '账号被锁了，去网页版看看',
      NOREGISTER: '这个账号还没开通门户',
      NOAUTHORIZATION: '这个账号没有门户的使用权限',
      ISMODIFYPASS: '门户要求先改密码，请去网页版改完再来',
      NETWORKCOMMITMENT: '要先同意网络使用承诺书，请去网页版点一下',
    };
    if (j && typeof j === 'object') {
      var nodes = [j.data, j.meta, j];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n || typeof n !== 'object') continue;
        if (MAP[n.code]) return MAP[n.code];
        var m = String(n.message || '').trim();
        if (m && m.toLowerCase() !== 'ok' && m.toLowerCase() !== 'success') {
          return '门户拒绝了这次登录：' + m.slice(0, 60);
        }
      }
    }
    return '门户没给出登录凭据，可能是账号密码不对';
  }

  /* ==================================================================
   * 学习通 · 作业待办（只读）
   *
   * 这份是 mobile/chaoxing.py 的手机端实现，逻辑一一对应。两套必须
   * 拿同一份 HTML 对拍（_lab/cx/check_cx_js.py），否则手机上看到的
   * 作业条数和电脑版不一样，而且不报错。
   *
   * 🔴 四条硬规矩（和 Python 那份完全一样）
   *   1. 只读。不签到、不刷课、不自动答题、不代交。
   *   2. 失败不重试。重试会把 needVcode 撞成 1，之后要人做滑块。
   *   3. 「没读到」≠「没有作业」。拿不到的课记进 failed，不变成 0 条。
   *   4. 不认识的作业状态不许兜底成「已完成」或「待办」。
   *
   * 🔴 两个 enc 必须来自同一次课程页加载：
   *      stuenc  —— 藏在 302 之后的 URL 里，**每次进课程页都变**
   *      workEnc —— 藏在 HTML 的 <input id="workEnc"> 里，课程级固定
   *    混用旧的和新的 → 回「无权限的操作」，而 HTTP 状态码还是 200。
   * ================================================================== */

  var CXS = {
    LOGIN_PAGE: 'https://passport2.chaoxing.com/login?fid=&refer=',
    LOGIN_API: 'https://passport2.chaoxing.com/fanyalogin',
    COURSE_API: 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',
    COURSE_REF: 'https://mooc2-ans.chaoxing.com/mooc2-ans/visit/interaction',
    COURSE_PAGE: 'https://mooc1.chaoxing.com/visit/stucoursemiddle',
    WORK_LIST: 'https://mooc1.chaoxing.com/mooc2/work/list',
    // 考试列表。参数照抄 course-stu.js 点导航时的拼法 —— 缺一个就回
    // 「参数传递不正确」，而 HTTP 状态码还是 200。
    EXAM_LIST: 'https://mooc1.chaoxing.com/exam-ans/mooc2/exam/exam-list',
    // 课程活动（签到/讨论/通知）。返回 JSON，比抓 HTML 稳得多。
    // 🔴 fid 是**学校 id**（course.schoolId），不是课程页隐藏字段那个 id="fid"。
    ACTIVE_LIST: 'https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist',
    CACHE: 'cx.cache',
    USERKEY: 'cx.user'
  };

  // 🔴 「待互评」是**要我去评别人** ⇒ 算 todo。以前两边都不在，落到「其他」并被
  //    排除在待办之外，等于把一件该做的事藏了。
  // 🔴 「待批阅 / 已批阅」是**我已经交了**、等老师 ⇒ 算 done。全算「要交」会让人
  //    一进门看到 76，滑三屏才发现只有 7 条真没交（2026-10-23 南师侧实测）。
  //    改这里必须同步 chaoxing.py 的 TODO_STATES / DONE_STATES。
  var CX_TODO = ['未交', '未开始', '待互评'];
  var CX_DONE = ['已完成', '待批阅', '已批阅', '已互评'];

  /** 考试：只有**明确表示已经考完/考过**的才算做完。
   *  没见过的取值一律留在待办里 —— 宁可多显示一条，
   *  也不能把一场还没考的考试藏起来。 */
  var CX_DONE_EXAM = ['已完成', '已结束', '已交卷', '已参加', '已批阅', '已过期'];

  /** activeType → 分类。表和 mobile/chaoxing.py 的 KIND_BUCKET 一致，
   *  来源是学习通任务列表页的 Vue 模板（_lab/cx/ml/active_page.html）。 */
  var CX_KIND_BUCKET = {
    sign: ['2', '74'],      // 签到 / 签退
    topic: ['5', '50'],     // 主题讨论
    work: ['19'],           // 作业
    notice: ['34', '45'],   // 通知。34 老版本 / 45 新版本，同一件事的两种 type。
                            // 🔴 45 是南师侧拿原始响应实测的（content 里是老师名、
                            //    extraInfo 里是 noticeId），不是猜的。只认 34 会让新版
                            //    通知全落进「其他」。改这里必须同步 chaoxing.py。
    // 随堂练习 / 互动练习（0.39.0）。用户 2026-11-01：「还很容易错过…还有随堂练习」。
    // 以前落到 other，和「白板 / 教案 / PDF 文档」挤在同一格 —— 那格是垃圾桶，
    // 真正的任务淹在里面等于没提示。单独一类，排在做作业后面。
    quiz: ['42', '68']
  };

  /** activeType → 中文名。30 种，从模板里的 aria-label 逐条抄的。 */
  var CX_ACTIVE_KIND = {
    '2': '签到', '4': '抢答', '5': '主题讨论', '11': '选人', '14': '问卷',
    '17': '直播', '19': '作业', '23': '评分', '34': '通知', '35': '分组任务',
    '42': '随堂练习', '43': '投票', '45': '通知', '46': '群聊', '47': '计时器', '48': '课程章节',
    '49': '白板', '50': '主题讨论', '51': '同步课堂', '56': '泛雅课堂',
    '57': 'PPT文档', '58': '教案', '59': '抽签', '60': '教案', '61': 'WORD文档',
    '62': 'PDF文档', '63': '阅读任务', '68': '互动练习', '74': '签退',
    '75': '思政资源库', '77': 'AI实践'
  };

  var CX_KIND_ORDER = ['work', 'exam', 'quiz', 'sign', 'topic', 'notice', 'other'];

  /** 活动详情页地址：按 activeType 分。
   *  🔴 不是猜的，是从学习通活动列表页模板的 activeRowClick() 那个 switch 里抄的
   *  （_lab/cx/ml/active_page.html）。参数只用课程对象里现成的
   *  courseId / classId / fid（= schoolId）。和 chaoxing.py 的 ACTIVE_PAGE 一致。 */
  var CX_BASE = 'https://mobilelearn.chaoxing.com';
  var CX_ACTIVE_PAGE = {
    '2': '/page/sign/signIn',                              // 签到
    '74': '/page/sign/signIn',                             // 签退
    '50': '/page/topicDiscuss/student/stu_reply_discuss',  // 主题讨论
    '42': '/page/quiz/stu/answerQuestion2',                // 随堂练习
    '14': '/page/quiz/stu/answerQuestion',                 // 问卷
    '43': '/page/qvote/stu/answerQvote',                   // 投票
    '68': '/page/interactivepractice/stu/answerQu'         // 互动练习
  };

  /** 每门课之间的间隔。加抖动，别让请求节奏整齐得像机器。 */
  var CX_GAP = 900;
  var CX_JITTER = 400;

  // ---- 结课判定 -----------------------------------------------------
  // 🔴 必须和 chaoxing.py 的 REST_STREAK / REST_SPAN / REST_GAP 完全一致。
  //    APK 里没有 Python，这两份是各写一遍的 —— 只改一边不报错，
  //    只是手机上和网页上「哪些课算结课」会得出不同答案。
  //
  // 判据：四个请求全成功 + 三个列表全空，连续 REST_STREAK 次，且跨度 >= REST_SPAN。
  // 之后每 REST_GAP 才扫一次。
  //
  // 🔴 为什么不能「首次扫到空就判」：开学第一周课都还没发作业，
  //    实测 32 门里 13 门是空的，其中「线性代数」「高等数学」是本学期的课。
  //    首次就判会把整个学期的课全判死。
  // 🔴 为什么是降频不是永不扫：判据一定会错，永不扫就永远发现不了。
  var CX_REST_STREAK = 3;
  var CX_REST_SPAN = 7 * 86400;
  var CX_REST_GAP = 7 * 86400;

  // ---- 冷课判定（0.39.0）----
  // 上面那条要求「三个列表全空」—— 但历史学期的课**不空**：上学期的作业还挂着。
  // 于是 37 门里 22 门一个学期都判不出结课，每次刷新仍然全量扫。
  // 换证据：**有内容，但最新那条已经是 CX_COLD_DAY 之前的事**。
  // 🔴 冷课「一次就降频」，空课要攒 3 次 + 7 天：
  //    空 = 没有证据（老师可能还没发作业）；冷 = 有证据（东西都在，都很旧）。
  var CX_COLD_DAY = 90 * 86400;

  /** 结课状态的 key：`<courseId>:<classId>`。和 `chaoxing.rest_key` 逐字对齐。
   *  🔴 必须带 classId：同一个 courseId 下可能挂着不同学期的教学班，
   *     只按 courseId 存会让本学期的班被上学期的班判成「已结课」。 */
  function cxRestKey(courseId, classId) {
    return String(courseId) + ':' + (classId == null ? '' : String(classId));
  }

  /** 按 (courseId, classId) 去重。和 `chaoxing.unique_courses` 逐条对齐。
   *  🔴 0.39.0 之前只按 courseId 去重，注释写着「不同 classId 的作业/考试/活动
   *     都是同一套」—— 那句是错的。同一个 courseId 下面可能挂着**不同学期**的
   *     教学班，压成一个就只查了其中一个班，顺序一换本学期作业全没了。 */
  function cxUniqueCourses(courses) {
    var seen = {}, out = [];
    if (!Array.isArray(courses)) return out;
    for (var i = 0; i < courses.length; i++) {
      var c = courses[i];
      if (!c || typeof c !== 'object') continue;
      var k = cxRestKey(c.courseId, c.classId);
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(c);
    }
    return out;
  }

  // ---- 教务课表白名单（和 chaoxing.py 的 _norm_name / _in_white 逐字对齐）----
  var CX_ROMAN = { 'Ⅰ': 'I', 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV',
                   'Ⅴ': 'V', 'Ⅵ': 'VI', 'Ⅶ': 'VII', 'Ⅷ': 'VIII' };

  /** 课名归一化：全角转半角、罗马数字统一、去掉空白和标点、转大写。 */
  function cxNormName(s) {
    var t = String(s == null ? '' : s);
    // 全角 → 半角
    t = t.replace(/[\uFF01-\uFF5E]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    }).replace(/\u3000/g, ' ');
    for (var k in CX_ROMAN) {
      if (CX_ROMAN.hasOwnProperty(k)) t = t.split(k).join(CX_ROMAN[k]);
    }
    t = t.replace(/[\s\u3000·・,，。、;；:：!！?？'"“”‘’()（）\[\]【】<>《》/\\|+*#\-]/g, '');
    return t.toUpperCase();
  }

  function cxNormNames(names) {
    if (!Array.isArray(names)) return [];
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var v = cxNormName(names[i]);
      if (v.length >= 2) out.push(v);
    }
    return out;
  }

  /** 这门课是不是「本学期教务课表里在修」。**故意宽松** ——
   *  误放行只是多扫一门，漏放行等于把真的作业降频档住。 */
  function cxInWhite(title, white) {
    if (!white || !white.length) return false;
    var t = cxNormName(title);
    if (!t) return false;
    for (var i = 0; i < white.length; i++) {
      var w = white[i];
      if (w === t || t.indexOf(w) >= 0 || w.indexOf(t) >= 0) return true;
      if (w.length >= 4 && t.length >= 4 && w.slice(0, 4) === t.slice(0, 4)) return true;
    }
    return false;
  }

  /** 扫描进度。和 bridge.py 的 _CX_SCAN 同构，前端只认这几个键。 */
  var CX_SCAN = { state: 'idle', at: 0, i: 0, n: 0, course: '', phase: '',
                  err: '', kind: '' };
  var CX_RESTORED = false;      // cookie 只还原一次
  var CX_USER = '';

  function cxErr(msg, kind) {
    var e = new Error(msg);
    e.kind = kind || 'net';
    return e;
  }

  function cxSleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /** 学习通请求。不走 http()：那个每次要等 POLITE_MS（1.2 秒），
   *  32 门课就是 77 秒白等。节奏由 cxScan 自己按 CX_GAP 控制。 */
  function cxHttp(method, url, body, referer, headers) {
    return new Promise(function (resolve, reject) {
      try { guardUrl(url); } catch (e0) { reject(e0); return; }
      var id = ++seq;
      waiting[id] = { resolve: resolve, reject: reject };
      try {
        if (window.Android && typeof Android.req2 === 'function') {
          Android.req2(id, method, url, body || '', referer || '',
                       headers ? JSON.stringify(headers) : '');
        } else {
          Android.req(id, method, url, body || '', referer || '');
        }
      } catch (e) {
        delete waiting[id];
        reject(new Error('原生请求失败：' + e));
      }
    });
  }

  // ---------------------------------------------------------- 纯函数（可对拍）

  /** 「还剩 2 小时 10 分钟」→ 绝对截止时间（unix 秒）。
   *  列表页只给倒计时、不给绝对时间，只能在解析这一刻换算。
   *  和 chaoxing.py 的 _end_from_left 是同一条规则（对拍脚本会验）。
   *
   *  🔴 判断「没传」只能用 `== null`，不能用 `> 0` 兜底 —— Python 那边写的是
   *     `now is None`，传 0 就是字面的 0。两边不一致的话，同一个输入会算出
   *     相差二十多年的截止时间，而且**不报错**。 */
  function cxEndFromLeft(leftMin, nowSec) {
    if (leftMin == null) return null;
    var now = (nowSec == null) ? Date.now() / 1000 : nowSec;
    return Math.floor(now + leftMin * 60);
  }

  /** 「剩余32小时54分钟」→ 1974（分钟）。认不出来返回 null。
   *
   *  🔴 不兜底成 0：0 分钟意味着「已经到期」，那是完全相反的意思。 */
  function cxLeft(text) {
    if (!text) return null;
    var s = String(text);
    if (s.indexOf('剩余') < 0) return null;
    var d = /(\d+)\s*天/.exec(s);
    var h = /(\d+)\s*小时/.exec(s);
    var m = /(\d+)\s*分/.exec(s);
    if (!d && !h && !m) return null;
    return (d ? parseInt(d[1], 10) * 1440 : 0)
         + (h ? parseInt(h[1], 10) * 60 : 0)
         + (m ? parseInt(m[1], 10) : 0);
  }

  /** 状态归三档。不认识的返回 'other' —— 不往任何一边凑。 */
  function cxBucket(status) {
    var s = String(status || '').replace(/^\s+|\s+$/g, '');
    for (var i = 0; i < CX_TODO.length; i++) if (CX_TODO[i] === s) return 'todo';
    for (var j = 0; j < CX_DONE.length; j++) if (CX_DONE[j] === s) return 'done';
    return 'other';
  }

  /** backclazzdata 的 JSON → 课程列表。字段位置是实测出来的：
   *    courseId = content.course.data[0].id
   *    classId  = content.id
   *    cpi      = channel.cpi
   *    title    = data[0].name（干净课名）
   *    alias    = content.name（带老师/周次，不能当课名用）
   *    schoolId = data[0].belongSchoolId（学校 id，活动列表接口要这个；郑航是 1286） */
  function cxParseCourses(j) {
    var out = [];
    var chs = (j && j.channelList) || [];
    for (var i = 0; i < chs.length; i++) {
      var ch = chs[i] || {};
      var ct = ch.content || {};
      var rows = (ct.course && ct.course.data) || [];
      if (!rows.length) continue;
      var d = rows[0] || {};
      out.push({
        courseId: d.id,
        classId: ct.id,
        cpi: ch.cpi || ct.cpi,
        title: d.name || ct.name || '',
        alias: ct.name || '',
        schoolId: d.belongSchoolId || ''
      });
    }
    return out;
  }

  /** activeType → 分类。认不出来归 'other'，不往任何一类里凑。 */
  function cxKindOf(activeType) {
    var t = String(activeType == null ? '' : activeType).replace(/^\s+|\s+$/g, '');
    if (/\.0$/.test(t)) t = t.slice(0, -2);      // 万一给了 5.0
    for (var k in CX_KIND_BUCKET) {
      if (!CX_KIND_BUCKET.hasOwnProperty(k)) continue;
      if (CX_KIND_BUCKET[k].indexOf(t) >= 0) return k;
    }
    return 'other';
  }

  /** 签到的「我到底签了没」→ true / false / null。
   *
   *  🔴 认不出来就返回 null，**绝不兜底成 false**。兜成「没签」等于凭空
   *     告诉用户「你漏签了」—— 那是会让人白跑一趟教务处的错。
   *     ⚠️ 这份判定必须和 chaoxing.py 的 sign_state() 一模一样：
   *        网页版走 Python，APK 走这里，两边不一致的话同一份数据
   *        会算出两种「漏签次数」，而且不报错。 */
  function cxSignState(text) {
    var t = String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
    if (!t) return null;
    if (t.indexOf('已签') >= 0) return true;              // 已签到 / 已签退
    if (t.indexOf('未签') >= 0 || t.indexOf('缺勤') >= 0) return false;
    return null;
  }

  /** 毫秒时间戳 → 秒。空/0/非数字返回 null。
   *  🔴 学习通的 0 表示「没有这个时间」，不是 1970 年。当成 0 会算出一个
   *     五十多年前的倒计时，然后被当成「早就过期」悄悄丢掉。 */
  function cxMsToSec(v) {
    var n = parseInt(v, 10);
    if (!isFinite(n) || n <= 0) return null;
    return Math.floor(n / 1000);
  }

  /** 补全协议。学习通给的多半是 `//mobilelearn.chaoxing.com/...`。 */
  function cxAbsUrl(u) {
    u = String(u == null ? '' : u).trim();
    if (!u) return '';
    if (u.indexOf('//') === 0) return 'https:' + u;
    if (u.indexOf('http://') === 0 || u.indexOf('https://') === 0) return u;
    return '';                                  // 相对路径 / javascript: 一律不要
  }

  /** 活动 JSON 的 content 里带的 stuUrl（学习通自己用的兜底地址）。
   *  🔴 content 有时是对象、有时是 JSON 字符串 —— 两种都认。 */
  function cxContentStuUrl(a) {
    var c = a ? a.content : null;
    if (typeof c === 'string') {
      try { c = JSON.parse(c); } catch (e) { return ''; }
    }
    if (!c || typeof c !== 'object') return '';
    return cxAbsUrl(c.stuUrl);
  }

  /** 一条活动 → 详情页地址。拼不出来返回空串（界面就不显示小箭头）。
   *  只做「上面这些参数就够」的类型：直播(17)/分组任务(35)/在线课堂(56)
   *  要先调别的接口拿 liveId / uuid，宁可**不给链接**，也别给个点开就报错的。 */
  function cxActiveUrl(a, course) {
    var u = cxContentStuUrl(a);
    if (u) return u;
    var path = CX_ACTIVE_PAGE[String(a && a.activeType != null ? a.activeType : '').trim()];
    if (!path) return '';
    var c = course || {};
    var cid = String(c.courseId == null ? '' : c.courseId).trim();
    var clid = String(c.classId == null ? '' : c.classId).trim();
    var fid = String(c.schoolId == null ? '' : c.schoolId).trim();
    var aid = String(a.id == null ? '' : a.id).trim();
    if (!(cid && clid && fid && aid)) return '';
    var q = 'courseId=' + cid + '&classId=' + clid + '&activeId=' + aid + '&fid=' + fid;
    if (path.indexOf('stu_reply_discuss') >= 0) {
      var cpi = String(c.cpi == null ? '' : c.cpi).trim();
      if (cpi) q += '&cpi=' + cpi;
      q += '&showOnScreenShare=true';
    }
    return CX_BASE + path + '?' + q;
  }

  /** 活动列表 JSON → 条目（签到 / 主题讨论 / 通知 / 作业提醒 …）。
   *
   *  字段名不是猜的，是从学习通自己的任务列表页模板里逐条抄的
   *  （_lab/cx/ml/active_page.html，191 KB 真实抓取）：
   *      nameOne   标题
   *      nameTwo   状态文字（可能为空）
   *      nameFour  倒计时文字，🔴 只有 status=='1' 才渲染
   *      startTime / endTime  毫秒时间戳
   *      status    '1' 进行中 / '2' 已结束 / 其他 未开始
   *
   *  🔴 result != 1 必须抛，不能返回空数组 —— 空数组会被前端显示成
   *     「这门课没有活动」，而真相是「没读到」。 */
  function cxParseActive(j, nowSec, course) {
    if (!j || typeof j !== 'object') return [];
    var res = j.result;
    if (!(res === 1 || res === '1' || res === true)) {
      throw cxErr(String(j.errorMsg || j.msg || '活动列表返回失败'), 'deny');
    }
    var rows = (j.data && j.data.activeList) || [];
    // nowSec 只是给对拍脚本固定时间用的（不传就是当前时间）——
    // 不然「从 endTime 算倒计时」那几条，JS 和 Python 会差个几十秒。
    var now = (typeof nowSec === 'number' && nowSec > 0) ? nowSec : Date.now() / 1000;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      if (!a || typeof a !== 'object') continue;
      var title = String(a.nameOne == null ? '' : a.nameOne).trim();
      if (!title) continue;
      var st = String(a.status == null ? '' : a.status).trim();
      var name4 = String(a.nameFour == null ? '' : a.nameFour).trim();
      var end = cxMsToSec(a.endTime);
      var start = cxMsToSec(a.startTime);

      var leftMin = null;
      if (st === '1') {
        leftMin = cxLeft(name4);
        // 🔴 不夹 0：过点但 status 还是 1 的活动，留负数让排序把它归到「已过期」，
        //    夹成 0 会写成「还剩 不到 1 分钟」。改这里必须同步 chaoxing.py。
        if (leftMin == null && end) leftMin = Math.floor((end - now) / 60);
      }
      var state = st === '1' ? 'live' : (st === '2' ? 'ended' : 'pending');

      var kd = cxKindOf(a.activeType);
      // 🔴 通知的 endTime 是**活动自己的生命周期终点**，不是待办截止时间。
      //    拿它渲染「截止 X」，一条公告会显示成「已截止 2025-09-30」，像漏了件事。
      //    改这里必须同步 chaoxing.py 的 parse_active。
      if (kd === 'notice') { end = null; leftMin = null; }

      out.push({
        kind: kd,
        kindName: CX_ACTIVE_KIND[String(a.activeType)] || '活动',
        title: title,
        status: String(a.nameTwo == null ? '' : a.nameTwo).trim(),
        state: state,
        left: name4,
        leftMin: leftMin,
        startAt: start,
        endAt: end,
        // 只有签到/签退才有；别的活动一律 null（不是 false）。
        signed: kd === 'sign' ? cxSignState(a.nameTwo) : null,
        url: cxActiveUrl(a, course)
      });
    }
    return out;
  }

  /** 考试列表页 → 条目。
   *
   *  结构从这一页自己的样式表反推（_lab/cx/ml/exam-list.css，127 个类名），
   *  和作业列表页**同构**：
   *      li > .tag + .right-content > p.overHidden2（标题）+ p.status（状态）
   *         + .time / .time.notOver（倒计时）
   *
   *  🔴 有 aria-label 就用（作业页就是这条路），没有就退回读文字。
   *     两条路都留着 —— 页面改版时至少有一条能撑住，而不是静默返回 0 条。 */
  function cxParseExam(html, nowSec) {
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var lis = doc.querySelectorAll('li');
    var out = [];
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      // 筛选栏、翻页那些 li 没有 .right-content，不是任务
      var right = li.querySelector('.right-content');
      if (!right) continue;

      var title = '', status = '';
      var lab = li.getAttribute('aria-label');
      if (lab) {
        var cut = lab.lastIndexOf(';');
        title = (cut >= 0 ? lab.slice(0, cut) : lab).replace(/^\s+|\s+$/g, '');
        status = cut >= 0 ? lab.slice(cut + 1).replace(/^\s+|\s+$/g, '') : '';
      }
      if (!title) {
        var tEl = right.querySelector('.overHidden2');
        if (tEl) title = String(tEl.textContent || '').replace(/\s+/g, ' ').trim();
      }
      if (!status) {
        var sEl = right.querySelector('.status');
        if (sEl) status = String(sEl.textContent || '').replace(/\s+/g, ' ').trim();
      }
      if (!title) continue;

      var wEl = li.querySelector('.time');
      var raw = wEl ? String(wEl.textContent || '').replace(/\s+/g, ' ').trim() : '';

      var done = false;
      for (var d = 0; d < CX_DONE_EXAM.length; d++) {
        if (status.indexOf(CX_DONE_EXAM[d]) >= 0) { done = true; break; }
      }
      out.push({
        kind: 'exam',
        kindName: '考试',
        title: title,
        status: status,
        state: done ? 'done' : 'todo',
        left: raw,
        leftMin: cxLeft(raw),
        startAt: null,
        endAt: cxEndFromLeft(cxLeft(raw), nowSec),
        url: li.getAttribute('data') || ''
      });
    }
    return out;
  }

  /** 这条还值不值得摆到人面前。 */
  function cxIsOpen(it) {
    return it && (it.state === 'todo' || it.state === 'live' || it.state === 'pending');
  }

  /** 作业列表页 → 作业数组。
   *
   *  每条 li：
   *    aria-label = "标题 ; 状态"   ← 最干净的来源（标题和状态一次拿全）
   *    .time                       ← 「剩余32小时54分钟」，没有就没有倒计时
   *    data="..."                  ← 详情页地址
   *
   *  🔴 用 lastIndexOf(';') 而不是 indexOf：万一标题里带分号，
   *     状态仍然是最后一段。 */
  function cxParseWork(html, nowSec) {
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var ul = doc.querySelector('ul');
    if (!ul) return [];
    var lis = ul.querySelectorAll('li');
    var out = [];
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var lab = li.getAttribute('aria-label');
      if (lab == null) continue;
      var cut = lab.lastIndexOf(';');
      var title = (cut >= 0 ? lab.slice(0, cut) : lab).replace(/^\s+|\s+$/g, '');
      var status = cut >= 0 ? lab.slice(cut + 1).replace(/^\s+|\s+$/g, '') : '';
      if (!title) continue;

      var tEl = li.querySelector('.time');
      var raw = tEl ? String(tEl.textContent || '').replace(/\s+/g, ' ').trim() : '';

      out.push({
        kind: 'work',
        kindName: '作业',
        title: title,
        status: status,
        state: cxBucket(status),
        left: raw,
        leftMin: cxLeft(raw),
        startAt: null,
        endAt: cxEndFromLeft(cxLeft(raw), nowSec),
        url: li.getAttribute('data') || ''
      });
    }
    return out;
  }

  // ---------------------------------------------------------- cookie 持久化

  /** App 一退出，java.net 的 cookie 罐子就空了。第一次用到时从本机还原。 */
  function cxRestore() {
    if (CX_RESTORED) return;
    CX_RESTORED = true;
    // 学号先读回来 —— 别放在下面那个 early-return 后面，
    // 否则「cookie 还在」这条路上 CX_USER 永远是空的。
    try { CX_USER = String(localStorage.getItem(CXS.USERKEY) || ''); }
    catch (e0) { CX_USER = ''; }
    try {
      if (Android.cxHasLogin()) return;
      var blob = String(Android.cxLoad() || '');
      if (blob) Android.cxLoadCookies(blob);
    } catch (e) { /* 还原不了就当没登录，让用户重登一次 */ }
  }

  function cxPersist() {
    try {
      if (!Android.cxHasLogin()) return;
      Android.cxSave(String(Android.cxDumpCookies() || '[]'));
    } catch (e) { /* 存不上只是下次要重登，不影响本次 */ }
  }

  function cxHasLogin() {
    try { return !!Android.cxHasLogin(); } catch (e) { return false; }
  }

  // ---- 学习通账号密码（加密存本机）----
  //
  // 为什么也存密码：cookie 会过期，一过期就得重新翻密码，用户明确说不要这样。
  // 但**绝不后台自动去撞** —— 只在用户点「重新连接」时用一次。
  // 服务端明确说账号密码不对时立刻删掉这份，不拿错的密码反复试。

  function cxPwdLoad() {
    try {
      if (!window.Android || typeof Android.loadCxPwd !== 'function') return null;
      var s = String(Android.loadCxPwd() || '');
      if (!s) return null;
      var o = JSON.parse(s);
      return (o && o.u && o.p) ? { u: String(o.u), p: String(o.p) } : null;
    } catch (e) { return null; }
  }

  function cxPwdSave(u, p) {
    try {
      if (!window.Android || typeof Android.saveCxPwd !== 'function') return 'none';
      return String(Android.saveCxPwd(String(u || ''), String(p || '')) || '');
    } catch (e) {
      return 'fail: 调用原生保存出错（' + ((e && e.message) || e) + '）';
    }
  }

  function cxPwdClear() {
    try {
      if (window.Android && typeof Android.clearCxPwd === 'function') Android.clearCxPwd();
    } catch (e) { /* 清不掉也只能这样 */ }
  }

  // ---------------------------------------------------------- 缓存

  function cxCacheGet() {
    try {
      var s = localStorage.getItem(CXS.CACHE);
      if (!s) return null;
      var o = JSON.parse(s);
      return (o && o.data) ? o.data : null;
    } catch (e) { return null; }
  }

  function cxCacheSet(d) {
    try {
      localStorage.setItem(CXS.CACHE,
        JSON.stringify({ at: Math.floor(Date.now() / 1000), data: d }));
    } catch (e) { /* 存不下就只活这一次 */ }
  }

  function cxCacheClear() {
    try { localStorage.removeItem(CXS.CACHE); } catch (e) { /* 无所谓 */ }
  }

  function cxCacheAge() {
    try {
      var s = localStorage.getItem(CXS.CACHE);
      if (!s) return -1;
      var o = JSON.parse(s);
      var at = o && o.at;
      if (!at) return -1;
      return Math.max(0, Math.floor(Date.now() / 1000) - at);
    } catch (e) { return -1; }
  }

  // ---------------------------------------------------------- 登录 / 取数

  /** 账号密码登录。🔴 失败直接抛，**绝不重试**。
   *
   *  重试的代价：学习通会把 needVcode 置 1，之后每次登录都要人做滑块；
   *  再撞下去是冻结 24 小时，然后是灰名单人工申诉。 */
  async function cxLogin(user, pwd) {
    var enc = '';
    try { enc = String(Android.cxAes(String(pwd)) || ''); } catch (e) { enc = ''; }
    // 🔴 加密失败**不能**拿明文顶上：学习通只认密文，发明文等于拿错的密码去撞
    if (!enc) throw cxErr('密码加密失败，手机系统的加密模块不可用', 'parse');

    // 先开一次登录页，拿到 passport2 域的 JSESSIONID / route
    await cxHttp('GET', CXS.LOGIN_PAGE, '', '');

    var body = form({
      fid: '-1',
      uname: user,
      password: enc,
      // 这个值本身已经是 URL 编码过的，form() 会再编一次 —— 和 Python 版
      // 用 requests 发出去的结果一致（服务端认的就是这个双重编码）。
      refer: 'http%3A%2F%2Fi.mooc.chaoxing.com',
      t: 'true',                 // 🔴 只有 true 时前端才加密密码
      forbidotherlogin: '0',
      validate: '',              // 首次登录不需要验证码
      _blank: '1',
      retainlogin: '2',
      pcxxtpage: '0',
      needVcode: ''
    });

    var r = await cxHttp('POST', CXS.LOGIN_API, body, CXS.LOGIN_PAGE,
                         { 'X-Requested-With': 'XMLHttpRequest' });

    var j = null;
    try { j = JSON.parse(String((r && r.body) || '')); }
    catch (e) { throw cxErr('登录没成功，学校系统可能改版了', 'parse'); }

    var ok = !!(j && j.status) || String((j && j.status)).toLowerCase() === 'true';
    if (!ok) {
      var mes = String((j && j.mes) || '').replace(/^\s+|\s+$/g, '');
      if (mes.indexOf('验证码') >= 0 || (j && j.needVcode)) {
        throw cxErr('学习通这次要验证码了，得在电脑上手动登录一次', 'auth');
      }
      throw cxErr(mes || '账号或密码不对', 'auth');
    }
    return true;
  }

  async function cxCourses() {
    var r = await cxHttp('GET', CXS.COURSE_API, '', CXS.COURSE_REF);
    cxStatusOk(r, '课程列表');
    var t = String((r && r.body) || '');
    if (!t.replace(/\s+/g, '')) throw cxErr('课程列表是空的 —— 登录态可能失效了', 'auth');
    // 🔴 登录页要单独认出来。不认的话会掉进下面 JSON.parse 失败那条，
    //    报「课程列表不是 JSON，接口可能变了」—— 那是**假话**：
    //    接口没变，只是没登录，服务器把我们 302 到登录页了。
    //    用户按「接口变了」去理解，唯一能做的事是等更新，而真正该做的是重连。
    if (cxLooksLoggedOut(t)) {
      throw cxErr('学习通的登录态过期了，点「重新连接」再试一次', 'auth');
    }
    var j;
    try { j = JSON.parse(t); }
    catch (e) { throw cxErr('课程列表没读出来，学校系统可能改版了', 'parse'); }
    var rows = cxParseCourses(j);
    if (!rows.length && !(j && j.channelList)) {
      throw cxErr('课程列表没读出来，学校系统可能改版了', 'parse');
    }
    return rows;
  }

  /** 这段内容是不是「登录页」而不是接口数据。
   *
   *  ⚠️ 必须和 chaoxing.py 的 `_looks_logged_out()` 逐字对齐（对拍脚本会验）。
   *
   *  🔴 先判「像不像 JSON」再判关键字：正常响应里 courseName 之类的字段
   *     完全可能带「用户登录」四个字（比如一门叫《用户登录与鉴权》的课），
   *     只看关键字会把正常数据判成没登录 —— 那比反过来更糟，
   *     因为它会让人白白重连一次。
   */
  function cxLooksLoggedOut(text) {
    var s = String(text == null ? '' : text);
    if (!s) return false;
    var head = s.replace(/^\s+/, '').charAt(0);
    if (head === '{' || head === '[') return false;      // 是 JSON 就不可能是登录页
    return s.indexOf('passport2.chaoxing.com') >= 0 || s.indexOf('用户登录') >= 0;
  }

  /** 非 200 一律当服务端/网络错误。
   *
   *  🔴 必须显式判：Java 那边只把响应体交回来，502 的 HTML 和「真的没作业」
   *     在解析层长得一模一样（`cxParseWork` 找不到 <ul> 就返回 []），
   *     于是「服务器挂了」会被静默当成「这门课没有作业」。
   *
   *  实测（`_lab/cx/probe_502.py`，两门课全部 502）修之前的样子：
   *      work   → code=noentry「没给作业入口」      ← 假话
   *      exam   → code=noentry「没给考试入口」      ← 假话
   *      active → code=auth    「登录态可能失效了」  ← 假话，而且更糟：
   *                扫描见到 auth 就停，**第二门课根本不查、也不记录**。
   *
   *  ⚠️ 这个函数必须和 `chaoxing.py` 的 `_status_ok()` 逐字对齐 ——
   *     APK 没有 Python，两边是各写一份。只改一边不报错。
   */
  function cxStatusOk(r, what) {
    var code = (r && r.status) || 0;
    // 🔴 2026-10-25 补：401 是「未授权」，不是「服务器出错」。
    //    以前 401 走下面那条「学习通服务器出错了，不是你的问题」——
    //    那句话会让用户干等着，而他真正该做的是点「重新连接」。
    //    而且 401 判成 net 之后扫描不会停，剩下几十门课各发一次注定 401 的请求。
    //    ⚠️ 403 仍然算 net：学习通的 403 多半是风控拦的，不是账号问题。
    //    ⚠️ 必须和 `chaoxing.py` 的 `_status_ok()` 逐字一致（对拍会验）。
    if (code === 401) {
      throw cxErr(what + '打不开，登录过期了，点「重新连接」再试一次', 'auth');
    }
    // 🔴 202 = Accepted：请求收到了但没给内容，学习通那边通常是风控在排队。
    //    和 chaoxing.py 的 _status_ok 逐字一致（对拍会比对文案本身）。
    //    说「服务器出错了」会让用户以为没事、接着点，越点越封。
    if (code === 202) {
      throw cxErr(what + '查得太频繁了，过几分钟再试', 'net');
    }
    if (code !== 200) {
      throw cxErr(what + '返回 ' + code + '（学习通服务器出错了，不是你的问题）', 'net');
    }
  }

  /** 进课程页，拿 stuenc + workEnc。两个必须来自同一次加载。 */
  async function cxCourseMeta(c) {
    var url = CXS.COURSE_PAGE + '?courseid=' + c.courseId + '&clazzid=' + c.classId
            + '&cpi=' + c.cpi + '&ismooc2=1&v=2';
    var r = await cxHttp('GET', url, '', '');
    cxStatusOk(r, '课程页');
    // 原生层已经把重定向跟完并把**最终地址**带回来了，stuenc 就在里面
    var u = String((r && r.url) || '') || url;
    var stu = /[?&]enc=([0-9a-fA-F]{32})/.exec(u);
    var work = /id="workEnc"[^>]*value="([0-9a-fA-F]{32})"/.exec(String((r && r.body) || ''));
    return {
      stuenc: stu ? stu[1] : '',
      workEnc: work ? work[1] : '',
      referer: u
    };
  }

  async function cxWorkList(c, meta) {
    // 🔴 kind 用 'noentry' 而不是 'deny'：界面上这是**完全不同**的两句话。
    //    deny = 被拒绝（账号可能有问题），noentry = 这门课的页面里压根没这个
    //    入口（多半已结课归档）。混成一种，用户只能看到「拿不到入口」。
    if (!meta.stuenc || !meta.workEnc) throw cxErr('没给作业入口', 'noentry');
    var url = CXS.WORK_LIST + '?courseId=' + c.courseId + '&classId=' + c.classId
            + '&cpi=' + c.cpi + '&ut=s&t=' + Date.now()
            + '&stuenc=' + meta.stuenc + '&enc=' + meta.workEnc;
    var r = await cxHttp('GET', url, '', meta.referer);
    cxStatusOk(r, '作业列表');
    var t = String((r && r.body) || '');
    if (t.indexOf('无权限的操作') >= 0 || t.indexOf('无效的用户') >= 0) {
      throw cxErr('作业列表读不了，重新连接一次再试', 'deny');
    }
    return cxParseWork(t);
  }

  /** 一门课的活动列表。🔴 不需要 stuenc，所以不用先进课程页 —— 省一次请求。 */
  async function cxActiveList(c) {
    if (!c.schoolId) throw cxErr('这门课没带学校 id，活动查不了', 'parse');
    var url = CXS.ACTIVE_LIST + '?fid=' + c.schoolId
            + '&courseId=' + c.courseId + '&classId=' + c.classId
            + '&showNotStartedActive=0&_=' + Date.now();
    var referer = CXS.COURSE_PAGE + '?courseid=' + c.courseId
                + '&clazzid=' + c.classId + '&cpi=' + c.cpi;
    var r = await cxHttp('GET', url, '', referer, { 'X-Requested-With': 'XMLHttpRequest' });
    cxStatusOk(r, '活动列表');
    var t = String((r && r.body) || '');
    // 没登录时会 302 到登录页，回来的是一大坨 HTML 而不是 JSON
    var head = t.replace(/^\s+/, '').slice(0, 1);
    if (head !== '{' && head !== '[') {
      // 🔴 非 JSON **不再一律判 auth**。原来只要不是 JSON 就说「登录态可能失效了」，
      //    可 auth 会让扫描直接停下 —— 一个维护页 / 接口改版，就能让后面
      //    所有课**一门都不查**，而用户看到的是「登录失效」。
      //    现在只有真的看到登录页特征才判 auth，其余判 parse（照常往下查）。
      var hs = t.slice(0, 4000);
      if (hs.indexOf('用户登录') >= 0 || hs.indexOf('passport2') >= 0
          || hs.toLowerCase().indexOf('login') >= 0) {
        throw cxErr('活动列表跳到登录页了（登录态失效）', 'auth');
      }
      throw cxErr('活动列表没读出来，学校系统可能改版了', 'parse');
    }
    var j;
    try { j = JSON.parse(t); }
    catch (e) { throw cxErr('活动列表没读出来，学校系统可能改版了', 'parse'); }
    // 详情页地址要 courseId / classId / fid，而接口**不回**这三个
    // （它本来就是按课查的），所以把课程对象带进去自己拼。
    return cxParseActive(j, null, c);
  }

  /** 一门课的考试列表。需要 stuenc，必须在 cxCourseMeta 之后调。 */
  async function cxExamList(c, meta) {
    if (!meta.stuenc) throw cxErr('没给考试入口', 'noentry');
    var url = CXS.EXAM_LIST + '?courseid=' + c.courseId + '&clazzid=' + c.classId
            + '&cpi=' + c.cpi + '&ut=s&t=' + Date.now() + '&stuenc=' + meta.stuenc;
    var r = await cxHttp('GET', url, '', meta.referer);
    cxStatusOk(r, '考试列表');
    var t = String((r && r.body) || '');
    if (t.indexOf('这次操作没成功，重试一次') >= 0) {
      throw cxErr('考试读不出来，学习通可能改版了', 'parse');
    }
    if (t.indexOf('无权限的操作') >= 0 || t.indexOf('无效的用户') >= 0) {
      throw cxErr('考试列表被拒（登录态失效）', 'deny');
    }
    if (t.slice(0, 3000).indexOf('用户登录') >= 0) {
      throw cxErr('考试页跳到登录了（登录态失效）', 'auth');
    }
    return cxParseExam(t);
  }

  /** 把每门课的**作业 + 考试 + 课堂活动**都读一遍。
   *  返回结构与 bridge.py 的 scan() 完全一致（前端只写一套分支）。 */
  /** 算一门课这一轮扫描之后的「结课判定」状态。**纯函数**。
   *
   * st       上一轮的状态（可能没有）
   * okAll    这一轮四个请求是不是全部成功（课程页 + 作业 + 考试 + 活动）
   * isEmpty  三个列表是不是都为空
   * now      现在（unix 秒）
   * newest   这门课最新一条内容的时间（unix 秒）。None/null = 有内容但没给时间。
   *           **0.39.0 新增**，见 CX_COLD_DAY。
   *
   * 🔴 这是 `chaoxing.py` 的 `rest_next` 的**第二份实现**（APK 里没有 Python）。
   *    两份靠 `_lab/cx/check_cx_js.py` 逐条对拍 —— 只改一边不报错，
   *    只是手机上和网页上「哪些课算结课」会得出不同答案，用户看不出来。
   *
   * 🔴 okAll=false 时**原样返回**：既不加次数（那是拿「没读到」当「没有」），
   *    也不清零（那会让好不容易攒的次数白费）。这是整个判据里最要紧的一条。
   */
  function cxRestNext(st, okAll, isEmpty, now, newest) {
    st = (st && typeof st === 'object') ? st : {};
    if (!okAll) return st;
    if (isEmpty) {
      var streak = (st.streak || 0) + 1;
      var since = st.since || now;
      return {
        streak: streak, since: since, lastAt: now,
        // 次数够 + 跨度够 才真的停扫。只满足一条不算：一天点三次刷新
        // 也能凑够 3 次，但那才过了半天，分不清「结课」和「今天还没发作业」。
        resting: !!(streak >= CX_REST_STREAK && now - since >= CX_REST_SPAN)
      };
    }
    // 有内容，但最新那条已经很旧 ⇒ 冷课，这一轮就降频。
    // 🔴 newest 不是数字时**不判冷**：那是「不知道多旧」，不是「很旧」。
    // 🔴 只认数字和数字字符串。**不能直接 Number(newest)**：
    //    `Number([]) === 0`、`Number(null) === 0`、`Number('') === 0` ——
    //    空数组会被当成「1970 年」，`now - 0` 是个天文数字 ⇒ 直接判成冷课，
    //    一门课就这么被永久降频了。对拍时 `newest=[]` 就是这么红的。
    var cold = false;
    var nv = NaN;
    if (typeof newest === 'number') nv = newest;
    else if (typeof newest === 'string' && newest !== '') nv = Number(newest);
    if (isFinite(nv)) cold = (now - nv) >= CX_COLD_DAY;
    if (cold) {
      return {
        streak: (st.streak || 0) + 1,
        since: st.since || now, lastAt: now,
        resting: true
      };
    }
    // 有内容且是新的 ⇒ 立刻恢复。这是判错时的自我纠错。
    return { streak: 0, since: now, lastAt: now, resting: false };
  }

  async function cxScanAll(prevRest, force, preCourses, activeNames) {
    // preCourses 由 /api/cx/scan 在没有 UID 时先探一次拿到（见那里的注释）。
    // ⚠️ 只在「真的是个数组」时采信：`cxCourses()` 拿不到会抛，不会返回空数组，
    //    所以走到这里还拿到空数组 = 上游传错了，重取一次更稳。
    var courses = (Array.isArray(preCourses) && preCourses.length)
      ? preCourses : await cxCourses();

    // 🔴 0.39.0：按 (courseId, classId) 去重，不再只按 courseId。
    //    以前那句「不同 classId 的作业/考试/活动都是同一套」是错的：
    //    同一个 courseId 下可能挂着**不同学期**的教学班 —— 实测这个账号的
    //    「大学物理实验」同时有 26-27-1 和 25-26-2 两个班。压成一个 ⇒
    //    只查了其中**一个**班，顺序一换本学期的作业就一条都不在了。
    var uniq = cxUniqueCourses(courses);

    var items = [], failed = [];
    var PHASE = '作业 · 考试 · 课堂活动';
    var nowSec = Math.floor(Date.now() / 1000);
    prevRest = (prevRest && typeof prevRest === 'object') ? prevRest : {};
    // 先整体继承上一轮的状态，再逐门覆盖扫过的课。
    // 🔴 不能只写「这次扫过的课」：中途 auth 失效 break 之后，剩下的课没扫，
    //    状态丢了它们攒的 streak 就白攒了 —— 等于每次从零数。
    var rest = {};
    for (var rk in prevRest) {
      // ⚠️ 只继承新格式的 key（带 `:`）。0.38 及以前按裸 courseId 存，
      //    那个口径本身就是错的（一个 courseId 压了多个学期的班）。
      if (prevRest.hasOwnProperty(rk) && prevRest[rk] &&
          typeof prevRest[rk] === 'object' && String(rk).indexOf(':') >= 0) {
        rest[rk] = prevRest[rk];
      }
    }
    var paused = [];              // 这次因为「已结课」而没扫的课
    var white = cxNormNames(activeNames);

    for (var k = 0; k < uniq.length; k++) {
      var c = uniq[k];
      var ckey = cxRestKey(c.courseId, c.classId);

      // ---- 已结课的课，到点之前不扫 ----
      // 🔴 三个前提，缺一不可：
      //    ① 用户没点「全部重扫」；② **有白名单**（没绑教务时 white 为空，
      //       这时一律不降频 —— 宁可慢，也不能因为一个优化把作业弄丢）；
      //    ③ 这门课不在本学期教务课表里。
      var st = prevRest[ckey] || {};
      if (!force && st.resting && white.length &&
          !cxInWhite(c.title, white) &&
          nowSec - (st.lastAt || 0) < CX_REST_GAP) {
        paused.push({ course: c.title, courseId: c.courseId,
                      classId: c.classId, lastAt: st.lastAt || 0 });
        // 进度照报。跳过的课不报进度的话，用户看着「第 5/32 门」停住不动，
        // 会以为卡死了 —— 而卡死和「跳过了 27 门」在界面上长得一模一样。
        CX_SCAN.i = k + 1;
        CX_SCAN.n = uniq.length;
        CX_SCAN.course = c.title;
        CX_SCAN.phase = '已结课，跳过';
        continue;
      }

      // 这门课这一轮读到的条目，用来算「最新内容时间」（冷课判据要）
      var mine = [];
      var push = function (rows) {
        for (var x = 0; x < rows.length; x++) {
          rows[x].course = c.title;
          rows[x].courseId = c.courseId;
          items.push(rows[x]);
          mine.push(rows[x]);
        }
      };
      // part / code 是给**界面**用的分类键，不是给人看的字（和 chaoxing.py
      // 的 note() 同一个口径）。界面拿它们把「20 门课各缺作业 + 各缺考试」
      // 合成一句人话。
      var note = function (why, part, code) {
        failed.push({ course: c.title, why: String(why).slice(0, 60),
                      part: part || 'other', code: String(code || '') });
      };

      var meta = null;
      // 这一轮三个模块各自「读到了没有、读到几条」。
      // 🔴 只有三个都 ok 才谈得上「这门课是空的」—— 少一个都不算，
      //    因为没读到的那块可能正好装着作业。
      var wOk = false, eOk = false, aOk = false;
      var wN = 0, eN = 0, aN = 0;

      try {
        meta = await cxCourseMeta(c);
      } catch (e) {
        if (e && e.kind === 'auth') {
          note((e && e.message) || e, 'course', e.kind);
          for (var y = k + 1; y < uniq.length; y++) {
            failed.push({ course: uniq[y].title, why: '登录态失效，没查',
                          part: 'auth', code: 'auth' });
          }
          break;
        }
        note((e && e.message) || e, 'course', e && e.kind);
      }

      // 三个模块各查各的：一个挂了不能连累另外两个。
      // 🔴 每个失败都要记进 failed —— 否则「没读到」会被当成「没有」。
      var stop = false;
      if (meta) {
        try {
          var wRows = await cxWorkList(c, meta);
          wN = wRows.length; wOk = true; push(wRows);
        } catch (e2) {
          note((e2 && e2.message) || e2, 'work', e2 && e2.kind);
          if (e2 && e2.kind === 'auth') stop = true;
        }
        if (!stop) {
          try {
            var eRows = await cxExamList(c, meta);
            eN = eRows.length; eOk = true; push(eRows);
          } catch (e3) {
            note((e3 && e3.message) || e3, 'exam', e3 && e3.kind);
            if (e3 && e3.kind === 'auth') stop = true;
          }
        }
      } else {
        // 课程页没打开 ⇒ 作业和考试也查不了（两个都要课程页里的 stuenc）。
        // 🔴 必须**分别**记下来。只写一句「进不了课程页」的话，界面上
        //    「作业」和「考试」两项就静默消失了，用户会以为这门课没有。
        //    code=nocourse 是给界面看的：这两条和 course 那条是**同一件事**，
        //    界面上要并成一句，不能数成「17 门 + 34 门」。
        //    和 chaoxing.py 的 scan() 逐字对齐。
        note('课程页没打开，没查', 'work', 'nocourse');
        note('课程页没打开，没查', 'exam', 'nocourse');
      }

      // 活动列表不需要 stuenc，课程页挂了也能查
      if (!stop) {
        try {
          var aRows = await cxActiveList(c);
          aN = aRows.length; aOk = true; push(aRows);
        } catch (e4) {
          note((e4 && e4.message) || e4, 'active', e4 && e4.kind);
          if (e4 && e4.kind === 'auth') stop = true;
        }
      }

      CX_SCAN.i = k + 1;
      CX_SCAN.n = uniq.length;
      CX_SCAN.course = c.title;
      CX_SCAN.phase = PHASE;

      if (stop) {
        // auth 失效：这门课没扫完，**不更新它的状态**（rest 里保留继承值）。
        // 拿「登录失效」当「空」的话，被限流的那一轮会把一批课直接判成结课。
        for (var y2 = k + 1; y2 < uniq.length; y2++) {
          failed.push({ course: uniq[y2].title, why: '登录态失效，没查',
                        part: 'auth', code: 'auth' });
        }
        break;
      }

      // ---- 结课判定 ----
      // 🔴 只有「课程页打开 + 作业/考试/活动三个列表全部成功返回」才算一次
      //    有效的观察。失败、noentry、课程页没打开**都不算空** —— 那是「没读到」。
      //    和 chaoxing.py 的 scan() 逐条对齐。
      if (meta && wOk && eOk && aOk) {
        // newest = 这门课最新一条内容的时间。0.39.0 起它是「冷课」的证据：
        //   历史学期的课**不是空的**（上学期的作业还挂着），只按「全空」
        //   永远判不出结课，于是每次刷新都全量扫。改成看「最新一条有多旧」。
        //   只认 endAt / startAt，两者都没有就是 null（= 不知道多旧，不判冷）。
        var newest = null;
        for (var mi = 0; mi < mine.length; mi++) {
          var mt = mine[mi].endAt || mine[mi].startAt;
          if (mt && (newest === null || mt > newest)) newest = mt;
        }
        var nxt = cxRestNext(st, true, wN + eN + aN === 0, nowSec, newest);
        nxt.title = c.title;
        rest[ckey] = nxt;
      }
      // 没读到 ⇒ streak / since 原地不动：既不加（那是拿失败当空），
      // 也不清零（那会让好不容易攒的次数白费）。rest 里已经继承了原值。

      if (k < uniq.length - 1) {
        await cxSleep(CX_GAP + Math.random() * CX_JITTER);
      }
    }

    // ---- 归类 ----
    // 签到单独留一份**完整**的（含已结束）：用户问的是「我漏了哪几次」，
    // 那只有看历史才知道。只留 live 的话，「查看签到」等于什么都没查。
    // 🔴 仍然只读：这里只是把读到的排出来，不代签、不点任何按钮。
    var signs = [];
    for (var s1 = 0; s1 < items.length; s1++) {
      if (items[s1].kind === 'sign') signs.push(items[s1]);
    }
    // 新的排前面。没有 startAt 的垫底，别当 0 —— 那会变成「最老」。
    signs.sort(function (a, b) { return (b.startAt || 0) - (a.startAt || 0); });

    // 作业里状态认不出来的（比如「已互评」）不往任何一类里凑，单独说清楚。
    var odd = [];
    var open = [];
    var doneN = 0, endedN = 0;
    for (var t1 = 0; t1 < items.length; t1++) {
      var it = items[t1];
      if (it.kind === 'work' && it.state === 'other') { odd.push(it); continue; }
      if (it.state === 'done') { doneN++; continue; }
      if (it.state === 'ended') { endedN++; continue; }
      // 🔴 签到不进待办列表 —— 它在顶部那张签到卡里，单独一个位置。
      //    签到的时效是「几分钟」，和「还剩 3 天的作业」排一起会被挤到下面；
      //    而且同一条会同时出现在卡里和列表里，像重复了。
      if (it.kind === 'sign') continue;
      if (cxIsOpen(it)) open.push(it);
    }

    // 有倒计时的排前面（越少越急），没倒计时的垫底。
    // 🔴 垫底 ≠ 已过期：实测真有「未交但没写截止时间」的作业。
    // 🔴 三段排序，不是两段：
    //      rank 0 还能赶上的（按剩余分钟升序）
    //      rank 1 没有截止时间的（按标题）
    //      rank 2 已经过期的（按标题，**绝不能排最前面**）
    //    以前只有「有/没有」两段：过期那条 endAt 在过去、算出来是负数，
    //    负数最小 ⇒ 一年前的通知排首屏第一行，真要交的作业掉到第三屏。
    //    改这里必须同步 chaoxing.py 的 open_items.sort。
    var nowSort = Math.floor(Date.now() / 1000);
    function cxSortRank(x) {
      if (x.leftMin == null) return 1;
      if (x.endAt && x.endAt < nowSort) return 2;
      return 0;
    }
    open.sort(function (a, b2) {
      var ra = cxSortRank(a), rb = cxSortRank(b2);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return (a.leftMin || 0) - (b2.leftMin || 0);
      var ta = String(a.title || ''), tb = String(b2.title || '');
      return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });

    var counts = { work: 0, exam: 0, sign: 0, topic: 0, notice: 0, other: 0 };
    for (var t2 = 0; t2 < open.length; t2++) {
      var kk = open[t2].kind || 'other';
      counts[kk] = (counts[kk] || 0) + 1;
    }

    // 🔴 按**课**去重：一门课可能同时缺作业和考试，failed 里会记两条，
    //    但它是同一门课。以前按 failed 条数减，20 门课能算出 scanned = 12。
    var authCourses = {};
    for (var f = 0; f < failed.length; f++) {
      if (String(failed[f].part || '') === 'auth') authCourses[failed[f].course] = 1;
    }
    var notScanned = 0;
    for (var ac in authCourses) {
      if (authCourses.hasOwnProperty(ac)) notScanned++;
    }

    return {
      ok: true,
      at: Math.floor(Date.now() / 1000),
      courses: uniq.length,
      scanned: uniq.length - notScanned,
      total: items.length,
      todo: open.length,
      counts: counts,
      skipped: { done: doneN, ended: endedN, odd: odd.length },
      failed: failed,
      items: open,
      // 每门课的结课判定状态。下一轮扫描要原样传回来（`prevRest`），
      // 断了就每次都从零数，永远判不出结课。
      rest: rest,
      // 这次因为「已结课」而没扫的课。空数组 ≠ 没有结课 ——
      // 也可能是这一轮全都到点了、全扫了。
      paused: paused,
      // 全部签到（含已结束），给「签到」卡用。老前端没有这个字段也能跑。
      signs: signs,
      // 老字段，前端 0.12 及以前在用，留着别删
      other: odd.length,
      otherItems: odd
    };
  }

  function cxScanState() {
    return {
      state: CX_SCAN.state, at: CX_SCAN.at, i: CX_SCAN.i,
      n: CX_SCAN.n, course: CX_SCAN.course, phase: CX_SCAN.phase,
      err: CX_SCAN.err, kind: CX_SCAN.kind
    };
  }

  var NativeApi = {
    /** 把一场考试交给系统日历（Java 侧见 NativeBridge.addCalendar）。
     *
     *  返回：'' = 已经拉起日历的新建事件界面；
     *        'none' = 这个壳没有日历能力（网页版 / 老 APK）—— 调用方退回去下载 .ics；
     *        其余 = 打不开的原因。
     *
     *  🔴 这里不判断「该不该加进日历」（有没有日期、是不是过去场次），
     *     那是 app.js 的事：网页版和 APK 得用同一套判断，别分成两份。
     */
    addCalendar: function (title, desc, loc, begin, end, allDay) {
      if (!(window.Android && typeof window.Android.addCalendar === 'function')) return 'none';
      try {
        return String(window.Android.addCalendar(
          String(title || ''), String(desc || ''), String(loc || ''),
          Number(begin) || 0, Number(end) || 0, !!allDay) || '');
      } catch (e) {
        return 'fail: ' + ((e && e.message) || e);
      }
    },

    /** 在 App 内打开一个外链（Java 侧见 NativeBridge.openWeb → WebActivity）。
     *
     *  返回：'' = 已经打开了；
     *        'none' = 这个壳没有这个能力（网页版 / 0.6.0 之前的 APK）；
     *        其余 = 起不来的原因。
     *
     *  `warn`（0.17.3 起）：false = 这个地址本来就不用登录（公告正文、百科），
     *  进去时别弹「登录已过期」。老 APK 没有 openWebEx ⇒ 退回两参数的 openWeb，
     *  那边会按「要登录」处理 —— 老机子上多一句提示，但**不会开不了**。
     *
     *  🔴 为什么不让 app.js 直接调 Android.openWeb：
     *     `window.Android` 在老 APK 上不存在这个函数，直接调会抛 TypeError，
     *     整个点击处理器就断了（连「退回浏览器」都走不到）。这里统一兜住。
     */
    openWeb: function (url, title, warn) {
      if (!(window.Android && typeof window.Android.openWeb === 'function')) return 'none';
      try {
        // 🔴 按函数是否存在分派，不能靠 try/catch 试第三个参数：
        //    老 APK 收到三个参数会抛，而下面那个 catch 会把它写成
        //    'fail: ...' ⇒ 调用方当成「窗口起不来」⇒ 静默退回浏览器。
        if (typeof window.Android.openWebEx === 'function') {
          return String(window.Android.openWebEx(
            String(url || ''), String(title || ''), warn !== false) || '');
        }
        return String(window.Android.openWeb(String(url || ''), String(title || '')) || '');
      } catch (e) {
        return 'fail: ' + ((e && e.message) || e);
      }
    },

    /** 与 bridge.py 的 /api/* 完全同构。app.js 只认这个契约。 */
    handle: async function (path, body) {
      body = body || {};
      // 网页版的 api() 把参数拼在路径里（/api/notice?limit=60），APK 这边
      // 得自己拆。拆完把 path 还原成不带参数的，下面那些精确比较
      // （=== '/api/state'）才照旧成立。
      var q = {};
      path = String(path || '');
      var qi = path.indexOf('?');
      if (qi >= 0) {
        var pairs = path.slice(qi + 1).split('&');
        for (var pi = 0; pi < pairs.length; pi++) {
          if (!pairs[pi]) continue;
          var eq = pairs[pi].indexOf('=');
          var k = eq < 0 ? pairs[pi] : pairs[pi].slice(0, eq);
          var v = eq < 0 ? '' : pairs[pi].slice(eq + 1);
          try { q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
          catch (e0) { q[k] = v; }
        }
        path = path.slice(0, qi);
      }
      try {
        if (path === '/api/state') {
          var c = loadCred();
          var cs = '';
          try { cs = String(Android.credState() || ''); } catch (e) { cs = ''; }
          return { ok: true, bound: !!c, username: c ? c.u : '', credState: cs };
        }
        if (path === '/api/captcha') {
          // uid 留在本文件的 captchaUid 里，只把图片给页面 —— 与 bridge.py 同契约。
          try {
            var cap = await fetchCaptcha();
            return { ok: true, img: cap.img, ttl: cap.ttl };
          } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
          }
        }
        if (path === '/api/login') {
          var user = (body.username || '').trim();
          var pwd = body.password || '';
          var code = String(body.code || '').trim();
          if (!user || !pwd) return { ok: false, error: '请填学号和密码' };
          if (!code) {
            // 学校 CAS 第一次登录就要验证码。前端先拦一道，
            // 省掉一次必然失败（还会计入错误次数）的请求。
            return { ok: false, error: '请填验证码', needCaptcha: true };
          }
          var payload;
          try {
            payload = await doSync(user, pwd, code);
          } catch (e) {
            var out = { ok: false, error: (e && e.message) || String(e) };
            if (e && e.kind === 'code') { out.needCaptcha = true; out.captchaStale = true; }
            return out;
          }
          if (body.remember !== false) {
            // 空串 = 存好了；"soft" = 走了备用方式；"fail: xxx" = 没存上。
            // 🔴 别再把这三件事压成一个布尔值 —— 用户有权知道密码到底存没存住。
            var why = '';
            try { why = String(Android.saveCred(user, pwd) || ''); } catch (e2) {
              why = 'fail: 调用原生保存出错（' + ((e2 && e2.message) || e2) + '）';
            }
            payload.saved = why;
          }
          return payload;
        }
        if (path === '/api/sync') {
          var acc = loadCred();
          if (!acc) return { ok: false, error: '还没绑定账号', needBind: true };
          try {
            return await doSync(acc.u, acc.p, '');
          } catch (e) {
            // 🔴 CASTGC 过期后自动重登会撞上验证码 —— 这不是「密码错了」，
            //   是「这次要人算一道题」。标出来让界面去要验证码，
            //   别把用户推到「重新绑定」那条更重的路上。
            var so = { ok: false, error: (e && e.message) || String(e) };
            if (e && e.kind === 'code') so.needCaptcha = true;
            return so;
          }
        }
        if (path === '/api/unbind') {
          Android.clearCred();
          // 解绑要连教务系统的会话一起丢掉：只清本机凭据不清 cookie 的话，
          // 下次绑另一个账号时学校服务器还会认着旧会话（登录页被 302 走、
          // 拿不到加盐值），只能靠 login() 里那段补救逻辑绕一圈才登得上。
          clearCookies();
          idsCache = '';
          loggedIn = false;
          loggedUser = '';
          examPageSeen = false;
          projectReady = false;
          return { ok: true };
        }
        // ---- 学习通（作业待办）----
        // 契约与 bridge.py 的 /api/cx/* 完全一致：app.js 只写一套分支。
        if (path === '/api/cx/status') {
          cxRestore();
          var cxp = cxPwdLoad();
          return { ok: true, linked: cxHasLogin(), user: CX_USER,
                   saved: !!cxp,
                   // 能不能一键重连：账号和密码都得在
                   canRelink: !!(cxp && cxp.u),
                   scan: cxScanState(), age: cxCacheAge() };
        }
        if (path === '/api/cx/todo') {
          // 扫描要 60 秒，不能同步等。这里只读缓存 + 报进度，前端自己轮询。
          cxRestore();
          return { ok: true, scan: cxScanState(), age: cxCacheAge(), data: cxCacheGet() };
        }
        if (path === '/api/cx/login') {
          var cuser = String(body.user || '').replace(/^\s+|\s+$/g, '');
          var cpwd = body.pass || '';
          // 密码留空 = 「用本机存着的那份」。登录态过期后重连时，
          // 人只需要点一下，不用再翻密码。
          var cxUsedSaved = false;
          if (!cpwd) {
            var sc2 = cxPwdLoad();
            if (!sc2) return { ok: false, error: '账号和密码都要填' };
            // 🔴 存的是另一个账号的密码就**不许**拿去试：学习通会把
            //    needVcode 撞成 1，之后要人做滑块。
            if (sc2.u && cuser && sc2.u !== cuser) {
              return { ok: false,
                       error: '存的是 ' + sc2.u + ' 的学习通密码，跟这个账号对不上，请手动输入' };
            }
            cuser = cuser || sc2.u;
            cpwd = sc2.p;
            cxUsedSaved = true;
          }
          if (!cuser || !cpwd) return { ok: false, error: '账号和密码都要填' };
          try {
            await cxLogin(cuser, cpwd);
          } catch (e) {
            // 🔴 一次失败就回，绝不重试 —— 重试会把 needVcode 撞成 1
            var cmsg = String((e && e.message) || e);
            // 用着本机存的密码、服务端又明确说账号密码不对 ⇒ 把那份删掉。
            // 不删的话下次还会拿一个错密码去撞。
            if (cxUsedSaved && e && e.kind === 'auth') {
              cxPwdClear();
              return { ok: false, kind: 'auth', pwdStale: true,
                       error: cmsg + ' —— 存着的那份密码已经删掉，请手动输入一次' };
            }
            return { ok: false, error: cmsg, kind: (e && e.kind) || 'net' };
          }
          var csaved = '';
          try {
            csaved = String(Android.cxSave(String(Android.cxDumpCookies() || '[]')) || '');
          } catch (e2) {
            csaved = 'fail: 调用原生保存出错（' + ((e2 && e2.message) || e2) + '）';
          }
          // 密码也存一份：下次过期只需点一下
          var cpwSaved = cxPwdSave(cuser, cpwd);
          if (csaved.indexOf('fail') === 0) csaved = cpwSaved;
          CX_USER = cuser;
          try { localStorage.setItem(CXS.USERKEY, cuser); } catch (e3) { /* 无所谓 */ }
          return { ok: true, user: cuser, saved: csaved };
        }
        if (path === '/api/cx/scan') {
          cxRestore();
          // 🔴 这里**不再**用「cookie 里有没有 UID」当硬闸门。
          //
          //    2026-10-25 用户报的原话：「明明已经登录了学习通，点重新检查的时候
          //    还是说学习通未登录」。根因有两层：
          //      ① 在「打开学习通」那个 WebView 里登录的，cookie 进的是
          //         android.webkit 的罐子，java.net 这个罐子压根没有 ——
          //         两个罐子互不可见（见 WebActivity 的反向同步）。
          //      ② 就算 cookie 在，用**名字**判登录态本身就是错判据：
          //         本项目红线写着「「登录成功」= 需要登录的接口返回 200，
          //         不是 cookie 在不在」。cookie 名一改（或某条被 HttpCookie
          //         丢掉），会话明明还活着，这里也会说「未登录」。
          //
          //    改法：cookie 检查只当**快速提示**，不当结论。没有 UID 也照样
          //    问一次服务器 —— 而且问的就是扫描本来要做的第一件事（拿课程列表），
          //    所以**不多发一个请求**，拿到就顺手喂给扫描。
          // 已经在扫就不排队、不并发 —— 风控怕这个。
          // ⚠️ 这一条必须排在探网之前：否则「已经在扫」时再点一次，
          //    会白发一个课程列表请求（那个请求正是扫描正在做的事）。
          if (CX_SCAN.state === 'scanning') {
            return { ok: true, started: false, scan: cxScanState() };
          }
          var preCourses = null;
          if (!cxHasLogin()) {
            try {
              preCourses = await cxCourses();
            } catch (e0) {
              var k0 = String((e0 && e0.kind) || 'net');
              return { ok: false,
                       error: String((e0 && e0.message) || e0),
                       kind: k0,
                       // auth 才让人去重连；net（限流/断网）说「未登录」是误导
                       needLogin: k0 === 'auth' };
            }
          }
          CX_SCAN.state = 'scanning';
          CX_SCAN.at = 0;
          CX_SCAN.i = 0;
          CX_SCAN.n = 0;
          CX_SCAN.course = '';
          CX_SCAN.phase = '';
          CX_SCAN.err = '';
          CX_SCAN.kind = '';
          // 后台跑，不 await：前端靠轮询 /api/cx/todo 看进度
          (async function () {
            try {
              // 上一份结果里的 rest 就是「哪些课已经结课」的记忆。
              // 不传的话每次都当第一次扫，永远判不出结课。
              var prev = cxCacheGet();
              // preCourses 是上面探网时已经拿到的课程列表（没有 UID 那条路）。
              // 传下去省一次请求 —— 风控认的就是请求次数。
              var data = await cxScanAll(prev && prev.rest, !!(body && body.force),
                                         preCourses,
                                         // 本学期教务课表里的课名：命中白名单的课
                                         // 永不降频。前端拿不到课表就不传，
                                         // 见 cxScanAll 里「white 为空 ⇒ 不降频」。
                                         (body && body.activeNames) || null);
              cxCacheSet(data);
              // 扫描过程中 cookie 可能续期，顺手存回本机
              cxPersist();
              CX_SCAN.state = 'done';
              CX_SCAN.at = data.at;
              CX_SCAN.err = '';
              CX_SCAN.kind = '';
            } catch (e) {
              CX_SCAN.state = 'error';
              CX_SCAN.err = String((e && e.message) || e).slice(0, 140);
              // kind 给前端判断「是不是登录态失效」用：失效且本机存着密码时
              // 直接给一个「重连」按钮，不用人再输一遍。
              CX_SCAN.kind = String((e && e.kind) || '');
            }
          })();
          return { ok: true, started: true, scan: cxScanState() };
        }
        if (path === '/api/cx/logout') {
          // 断开 = 不再保留这个账号的任何东西：cookie、密码、缓存、学号
          try { Android.cxClear(); } catch (e) { /* 无所谓 */ }
          cxPwdClear();
          cxCacheClear();
          CX_USER = '';
          try { localStorage.removeItem(CXS.USERKEY); } catch (e2) { /* 无所谓 */ }
          CX_SCAN.state = 'idle';
          CX_SCAN.at = 0;
          CX_SCAN.i = 0;
          CX_SCAN.n = 0;
          CX_SCAN.course = '';
          CX_SCAN.phase = '';
          CX_SCAN.err = '';
          CX_SCAN.kind = '';
          // 学习通跨 4 个域，全清。漏一个的话「断开」之后还能读到东西。
          // 🔴 用 cxClearCookies 而不是 clearCookiesFor：后者会连 WebView 的
          //    罐子一起清，把门户的登录态也带走 —— 断开学习通不该影响门户。
          try {
            if (typeof Android.cxClearCookies === 'function') Android.cxClearCookies();
          } catch (e3) { /* 清不掉也只能这样 */ }
          return { ok: true };
        }
        // ---- 智慧门户：一卡通 + 办事应用 ----
        // 🔴 达小助改造（W6 安全收口）：这一段**全部短路**。
        //   底座里门户走的是郑航 sfrz/rhmh 那套（RSA 加密账密 + 算术验证码），
        //   app.js 的「连接门户」弹层会把用户输入的学号密码原样送进来 ——
        //   留着这条路径，升达学生的凭据就会发到别的学校的认证服务器上。
        //   升达门户 my.shengda.edu.cn 走 CASTGC，机制不同，等阶段2抓包重写。
        //   下面 pfLogin/pfCard/pfApps 那一大段保留作结构参照，已无路由可达；
        //   真正的兜底是 guardUrl()：PF 里的郑航域名已置空，发不出去。
        if (path === '/api/portal/status') {
          return { ok: false, unsupported: true,
                   error: '门户未适配本校系统（待校内抓包确认学校用哪套门户）' };
        }
        if (path === '/api/portal/captcha') {
          return { ok: false, unsupported: true, needCaptcha: false,
                   error: '门户未适配本校系统，不需要验证码' };
        }
        if (path === '/api/portal/login') {
          return { ok: false, unsupported: true,
                   error: '门户未适配本校系统：不会把学号密码发往任何第三方' };
        }
        // 🔴 达小助改造（W4）：一卡通/办事应用入口停用 —— 升达用哪套系统未确认，
        //   郑航的网关地址、CARD id、RSA modulus 全部作废。返回明确「未配置」，
        //   app.js 的校园页会显示未连接状态而不是报错崩页面。
        if (path === '/api/portal/card') {
          return { ok: false, error: '一卡通未适配本校系统（待抓包确认）' };
        }
        if (path === '/api/portal/apps') {
          return { ok: false, error: '办事应用未适配本校系统（待抓包确认）' };
        }
        // 给某个办事系统换一张 CAS 票。
        // 🔴 达小助改造（W6）：连同上面的登录一起停用 —— 换票要先有门户会话，
        //   而门户没适配。留着就是把「一张等于登录态的票」的发出口空对着外面。
        //   将来接升达门户时，白名单规则照旧：只给 shengda.edu.cn 及其子域换票，
        //   `([a-z0-9-]+\.)*` 不接受 `shengda.edu.cn.evil.com` 这种拼接。
        if (path === '/api/portal/ticket') {
          return { ok: false, unsupported: true,
                   error: '门户未适配本校系统，暂不提供换票' };
        }
        if (path === '/api/portal/logout') {
          pfCap = null;
          try { localStorage.removeItem(PF.KEY); } catch (e) { /* 无所谓 */ }
          // 断开门户 = 不再保留这个账号的任何东西，包括那份密码。
          // 只清会话不清密码的话，换个人用这台手机点「连接门户」就进去了。
          pfCredClear();
          // 只清门户那两个域，别顺手把教务系统的会话也清了 ——
          // 用户只是不想看一卡通了，课表不该跟着掉线。
          try {
            if (window.Android && typeof Android.clearCookiesFor === 'function') {
              Android.clearCookiesFor('shengda.edu.cn');
            }
          } catch (e2) { /* 清不掉也只是本地不再用它 */ }
          return { ok: true };
        }
        // 考试页「选学期」用。青果版 semesters() 给的是 xn-xqM 形态的 id，
        // 界面只把用户点的那个原样送回来 —— 🔴 不再按郑航的纯数字校验。
        if (path === '/api/exams') {
          var acc2 = loadCred();
          if (!acc2) return { ok: false, error: '还没绑定账号', needBind: true };
          var sid = String(body.semesterId == null ? '' : body.semesterId).trim();
          if (sid && !/^[\w.\-\/]+$/.test(sid)) {
            // 不猜、不兜底：id 不对就说，别默默拿当前学期的数据
            // 冒充用户点的那一学期。
            return { ok: false, error: '学期编号不对' };
          }
          var one = await withLogin(function () { return exams(sid); });
          one.ok = true;
          return one;
        }
        if (path === '/api/semesters') {
          if (!loadCred()) return { ok: false, error: '还没绑定账号', needBind: true };
          var sems = await withLogin(function () { return semesters(); });
          return { ok: true, semesters: sems };
        }
        // 课表页翻历史学期（2026-10-31 加）。契约与 bridge.py 的同名接口一致。
        if (path === '/api/timetable') {
          if (!loadCred()) return { ok: false, error: '还没绑定账号', needBind: true };
          var tsid = String(body.semesterId == null ? '' : body.semesterId).trim();
          // 青果的学期 id 是 `2026-2027/1` 这种形态（郑航才是纯数字 257），
          // 按 \d+ 判会让课表页翻不了历史学期。规则与上面 /api/exams 保持一致。
          if (tsid && !/^[\w.\-\/]+$/.test(tsid)) return { ok: false, error: '学期编号不对' };
          var tsname = String(body.semesterName == null ? '' : body.semesterName).trim();
          var tt2 = await withLogin(function () { return timetable(tsid, tsname); });
          tt2.ok = true;
          tt2.semesterId = tsid;
          return tt2;
        }
        // 「该办的事」：选课 / 评教 / 免听 / 免修的开放状态。
        // 单独一个接口而不是塞进 /api/sync —— 这四页要打四次教务系统，
        // 学校有「别点太快」的守卫，串起来十几秒；而它一学期才变几次。
        if (path === '/api/todo') {
          if (!loadCred()) return { ok: false, error: '还没绑定账号', needBind: true };
          var td = await withLogin(function () { return todo(); });
          td.ok = true;
          td.at = Math.floor(Date.now() / 1000);
          return td;
        }
        if (path === '/api/room-options') {
          if (!loadCred()) return { ok: false, error: '还没绑定账号', needBind: true };
          var opts = await withLogin(function () { return roomOptions(); });
          opts.ok = true;
          return opts;
        }
        if (path === '/api/free-rooms') {
          if (!loadCred()) return { ok: false, error: '还没绑定账号', needBind: true };
          // 🔴 参数一个都不猜：日期必须是 YYYY-MM-DD，节次必须是 1~12。
          //    写错了直接回错，别默默按「今天第 1 节」查一遍再冒充用户要的。
          var one = await withLogin(function () { return freeRooms(body); });
          one.ok = true;
          return one;
        }
        // 校园公告：🔴 达小助改造（W4）—— 郑航六部门站源表随 CMS 确认前**停用**。
        //   返回空列表而不是报错：公告页显示「暂无」，不会把错误说成事实；
        //   升达公告站与链接形状待阶段2抓包确认后恢复。
        if (path === '/api/notice') {
          return { ok: true, at: Math.floor(Date.now() / 1000), cached: true,
                   total: 0, items: [], failed: [], sources: 0,
                   note: '升达公告源未配置（待抓包确认学校CMS）' };
        }
        if (path === '/api/notice/detail') {
          return { ok: false, error: '升达公告源未配置（待抓包确认学校CMS）' };
        }
        return { ok: false, error: '这个功能用不了（App 版本太旧）' };
      } catch (e) {
        var msg = (e && e.message) || String(e);
        var detail = (e && e.detail) || '';
        // 网络层错误（超时、连不上）没有 EamsError 的语义，补一句人话
        // 🔴 2026-10-23 改：以前是 `msg = '连不上教务系统（' + msg + '）'`。
        //    人话是有了，但**括号里塞的是 Java 原文**，用户看到的是
        //    「连不上教务系统（原生请求失败：java.net.SocketTimeoutException:
        //      failed to connect to ... after 15000ms）」。
        //    各层都以为自己守住了：底层说「我加了『原生请求失败』这个中文前缀」，
        //    这一层说「我加了『连不上教务系统』这个中文前缀」—— 合起来还是异常原文。
        //    （2026-10-23 南师侧踩到同一个，两边结构一模一样。）
        //    现在：message 只放人话，原文进 detail —— 不显示，但排查时还在。
        if (!(e instanceof EamsError) && /timeout|failed|connect|Network/i.test(msg)) {
          detail = msg;
          // ⚠️ 不写死「教务只在校内网能打开」：郑航的教务解析到公网地址
          //    （202.196.166.172），到底放不放行校外还没实测过。措辞留余地，
          //    两种情况下都不算撒谎。
          msg = /timeout|failed to connect|ETIMEDOUT/i.test(msg)
            ? '连不上教务系统 —— 检查一下网络。如果人在校外，教务可能只在校内网能打开，连上校园网再试'
            : '连不上教务系统，检查一下网络再试';
        }
        var out = { ok: false, error: msg };
        if (detail) out.detail = detail;
        // 🔴 错误分类必须一起带出去（2026-10-30 修）。
        //    以前这里只回 {ok, error}，`e.kind` 就被吞在原生层里了 ——
        //    bridge.py 那条路有 kind，native.js 这条路没有，于是同一份
        //    app.js 在网页版分得清「签名被拒 / 限流 / 登录过期」，在 APK 里
        //    一律退化成一句原话。**不报错，只是少了一层信息**，最难发现。
        if (e && e.kind) out.kind = String(e.kind);
        // 凭据失效（密码改了）才让用户重输；网络问题别让人白输一遍
        if (e instanceof EamsError && e.kind === 'auth') out.authFail = true;
        return out;
      }
    },
    /**
     * 用系统浏览器打开链接。目前只给「检查更新 → 立即更新」下载 APK 用。
     *
     * 🔴 WebView 默认没有 DownloadListener，点 .apk 链接什么都不会发生，
     *    所以必须走系统浏览器（Java 那边的 openUrl）。返回 false = 没交出去，
     *    界面要给出「复制下载地址」的兜底，不能假装打开了。
     */
    openUrl: function (url) {
      try { Android.openUrl(String(url || '')); return true; }
      catch (e) { return false; }
    },

    /** 应用内下载更新（APK 专属）。网页版调用 available() 会得到 false，
     *  app.js 据此退回「交给浏览器」。 */
    update: UpdApi,

    // 给测试用的内部函数（真机上不对外用）
    _test: {
      sha1hex: sha1hex, parseTimetable: parseTimetable, parseGrades: parseGrades,
      parseProfile: parseProfile, parseExams: parseExams, parseExamPage: parseExamPage,
      parseSemesterList: parseSemesterList,
      parseFreeRooms: parseFreeRooms, parseRoomOptions: parseRoomOptions,
      parsePlan: parsePlan, splitCourseCell: splitCourseCell,
      // 公告三件套。和 notice.py 的 parse_list / parse_article / classify
      // 是同一套规则，_lab/out/check_notice_js.py 会拿同一份 HTML 对拍两边结果。
      nParseList: nParseList, nParseArticle: nParseArticle, nClassify: nClassify,
      // 「该办的事」四个页面的状态判断。每个都要单独钉：
      // 判错的后果是「没开放说成开放」，用户白跑一趟就不信这软件了。
      parseElect: parseElect, parseFreeListen: parseFreeListen,
      parseExemption: parseExemption, parseEvaluate: parseEvaluate,
      plainText: plainText, selectOptions: selectOptions,
      tablesOf: tablesOf, evalIndex: evalIndex, utf8Bytes: utf8Bytes,
      // 学习通的纯函数。和 chaoxing.py 的 parse_work / parse_courses /
      // parse_left / bucket 是同一套规则，_lab/cx/check_cx_js.py 拿
      // 同一份 HTML 对拍两边结果 —— 两边不一致的话，手机上看到的作业
      // 条数会和电脑版不一样，而且**不报错**。
      cxLeft: cxLeft, cxBucket: cxBucket, cxEndFromLeft: cxEndFromLeft,
      cxParseCourses: cxParseCourses, cxParseWork: cxParseWork,
      // 0.13.0 起作业之外还有考试和课堂活动，解析器也开出来给对拍脚本用
      cxKindOf: cxKindOf, cxParseActive: cxParseActive, cxParseExam: cxParseExam,
      // 签到的「签了没」判定也要对拍：和 chaoxing.py 的 sign_state 不一致的话，
      // 同一份数据在网页版和 APK 上会算出两个「漏签次数」，而且不报错。
      cxSignState: cxSignState,
      // 详情页地址的拼法也要对拍：拼错了手机上点开就是「参数错误」，
      // 而且**不报错**，只是页面打不开
      cxActiveUrl: cxActiveUrl,
      // HTTP 状态判据。和 chaoxing.py 的 _status_ok() 是同一套规则：
      // 非 200 一律 kind='net'。两边不一致的话，同一个 502 在网页版是
      // 「服务器出错」、在 APK 上是「没给作业入口」—— 而后者是假话。
      cxStatusOk: cxStatusOk,
      // 结课判定：必须和 chaoxing.py 的 rest_next 逐条对拍。
      // 两份实现只改一边**不报错**，只是两边结论会不一样 ——
      // 和 cxStatusOk 那对是同一类风险。
      cxRestNext: cxRestNext,
      cxRestConst: function () {
        return { streak: CX_REST_STREAK, span: CX_REST_SPAN, gap: CX_REST_GAP,
                 cold: CX_COLD_DAY };
      },
      // 0.39.0：结课 key 和教务课表白名单。两样都要和 chaoxing.py 对拍 ——
      // 白名单判错的后果是「本学期的课被降频」，用户会漏作业。
      cxRestKey: cxRestKey,
      cxUniqueCourses: cxUniqueCourses,
      cxNormName: cxNormName,
      cxInWhite: cxInWhite,
      // 登录链路是「有记忆的」（CX_SCAN / CX_USER / CX_RESTORED），
      // 不开这两个口子就没法在同一个页面里连着验几种状态。
      cxScanState: cxScanState,
      cxReset: function () {
        CX_RESTORED = false; CX_USER = '';
        CX_SCAN.state = 'idle'; CX_SCAN.at = 0; CX_SCAN.i = 0;
        CX_SCAN.n = 0; CX_SCAN.course = ''; CX_SCAN.phase = ''; CX_SCAN.err = '';
      },
      // 教务那边的会话状态机（loggedIn / loggedUser），同样是有记忆的，
      // 不开这两个口子就没法在同一个页面里连着验几种会话状态。
      login: login, sessionAlive: sessionAlive,
      sessionState: function () { return { loggedIn: loggedIn, user: loggedUser }; },
      resetSession: function () {
        loggedIn = false; loggedUser = ''; idsCache = '';
        examPageSeen = false; projectReady = false;
      },
    },
  };

  window.NativeApi = NativeApi;
})();
