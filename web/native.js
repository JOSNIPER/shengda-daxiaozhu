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
     _setup/check_config_sync.py 会比对两者防漂移）。
     🔴 tableId/menucode 是 TBD_* 占位 —— 阶段2校内抓包后替换真实值。 */
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
      menu_context_path: '/frame/normalusemenu/getBreadcrumbsInfoNew.action',
      data_table_path: '/taglib/DataTable.jsp',
      time_range_path: '/jw/common/getWsxkTimeRange.action',
      score_stat_path: '/jw/common/getSelectLessonScoreKcsInfo.action',
      home_path: '/frame/homes.html',
      droplist_path: '/frame/droplist/getDropLists.action',
      polite_delay_sec: 0.35
    },
    pages: {
      timetable: { tableId: 'TBD_KB', menucode: 'TBD_KB_MENU', preheat_path: '' },
      score:     { tableId: 'TBD_CJ', menucode: 'TBD_CJ_MENU', preheat_path: '' },
      exam:      { tableId: 'TBD_KS', menucode: 'TBD_KS_MENU', preheat_path: '' },
      free_room: { tableId: 'TBD_KXJS', menucode: 'TBD_KXJS_MENU', preheat_path: '' },
      profile:   { tableId: 'TBD_XJ', menucode: 'TBD_XJ_MENU', preheat_path: '' }
    },
    column_map: { timetable: {}, score: {}, exam: {}, free_room: {}, profile: {} },
    semester: {},
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
    //   青果的开放状态查询端点待抓包；未配置时返回空列表，界面显示「暂无可办事项」。
    return { items: [] };
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
  var kingoCtx = null;           // getWsxkTimeRange 的 xn/xqM/lcid…
  var WRITE_RE = /(saveElectiveCourse|cancelElectiveCourse|getTempDeskey|getTempNowtime|electiveCourseForm|pingjia|evaluate|doXk)/i;

  /** 唯一出口：写端点特征 URL 一律拒绝发出。 */
  async function kingoReq(method, url, body, referer, headers) {
    if (WRITE_RE.test(url)) throw new EamsError('达小助是只读客户端，该操作(写)不被允许');
    return http(method, url, body || '', referer || '', Math.round((CFG.jw.polite_delay_sec || 0.35) * 1000), headers);
  }

  /** CAS 票据 cookie 读取：先问原生 java.net 罐，再兜 WebView 罐。 */
  function kingoCk(name) {
    try {
      if (typeof Android.cookie === 'function') {
        var v = String(Android.cookie(cfgUrl(CFG.cas.base) + '/', name) || '');
        if (v) return v;
      }
      if (typeof Android.webCookie === 'function') {
        return String(Android.webCookie(cfgUrl(CFG.cas.base) + '/', name) || '');
      }
    } catch (e) { /* 读不到当没有 */ }
    return '';
  }

  async function ensureKingoSession(force) {
    if (kingoReady && !force) return;
    if (!loggedIn) throw new EamsError('还没登录', 'auth');
    var tgt = kingoCk('CASTGC');
    var service = CFG.jw.cas_service;
    if (tgt) {
      // 🔴 拿得到 CASTGC 就一定重新换票（门户的 JSESSIONID ≠ 教务的，实测教训）
      var r = await kingoReq('POST', cfgUrl(CFG.cas.base) + CFG.cas.tickets_path + '/' + encodeURIComponent(tgt),
                             form({ service: service }), CFG.cas.portal);
      var m = /(ST-[A-Za-z0-9._\-]+)/.exec(String(r.body || ''));
      if (!m) throw new EamsError('CAS 会话已过期（CASTGC 失效），请重新登录', 'auth');
      var joiner = service.indexOf('?') >= 0 ? '&' : '?';
      await kingoReq('GET', service + joiner + 'ticket=' + m[1]);
    }
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
    if (kingoCtx) return kingoCtx;
    var r = await kingoReq('GET', cfgUrl(CFG.jw.base) + CFG.jw.time_range_path + '?xktype=2');
    var j = kingoJson(r.body);
    var ctx = (j.result && typeof j.result === 'object') ? j.result : j;
    if (!ctx || !Object.keys(ctx).length) {
      kingoGuard(r.body, '学期时间范围');
      throw new EamsError('学期上下文没取到（响应不是预期 JSON）');
    }
    kingoCtx = ctx;
    return ctx;
  }

  /** 🔴 学期总周数唯一合法来源 = time_range 端点；禁止末课反推。 */
  async function kingoTotalWeeks() {
    var c = await kingoContext();
    var keys = ['zs', 'zxs', 'totalWeeks', 'xqzs'];
    for (var i = 0; i < keys.length; i++) {
      var n = parseInt(c[keys[i]], 10);
      if (isFinite(n) && n >= 10 && n <= 40) return n;
    }
    return null;
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

  /** DataTable.jsp 一页 → [{青果列名:文本}]（head_ 表头定列、trN_ 行内 id 优先）。 */
  function kingoParseTable(htmlText, mapping) {
    var doc = new DOMParser().parseFromString(htmlText || '', 'text/html');
    var out = [];
    var tables = doc.querySelectorAll('table');
    for (var ti = 0; ti < tables.length; ti++) {
      var rows = tables[ti].rows;
      if (!rows.length) continue;
      var heads = [];
      var hcells = rows[0].cells;
      for (var hi = 0; hi < hcells.length; hi++) {
        var hid = (hcells[hi].getAttribute('id') || '').replace(/^head_/, '');
        heads.push(hid);
      }
      if (!heads.some(Boolean)) continue;
      for (var ri = 1; ri < rows.length; ri++) {
        var cells = rows[ri].cells;
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

  async function kingoFetch(pageKey, extraParams) {
    var conf = (CFG.pages || {})[pageKey] || {};
    var tid = conf.tableId || '';
    if (!tid || tid.indexOf('TBD') === 0) {
      throw new EamsError(pageKey + ' 的 tableId 还没配置（等校内抓包填入 config）');
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

  async function login(username, password) {
    // 🔴 达小助改造（W3）：升达走统一 CAS，**镜像 kingo.py KingoClient.login**。
    //   ① POST {cas}/v1/tickets（表单编码+小写键+loginType）→ 拿 TGT；
    //      有些部署直接回 JSON{TGT}，两种形态都抠。
    //   ② 🔴 CASTGC 是门户前端 JS 自己写进 cookie 的，服务器不 Set-Cookie ——
    //      必须手动种进原生 CookieStore（Android.setCookie），否则免密续期永不生效。
    //   ③ 失败**绝不重试**：错 5 次锁号、且会触发滑块验证码（红线）。
    if (loggedIn && loggedUser === username) return;
    var cas = cfgUrl(CFG.cas.base);
    var r = await http('POST', cas + CFG.cas.tickets_path, form({
      username: username, password: password,
      service: CFG.cas.portal, loginType: '',
    }), CFG.cas.portal, 0, {
      'Origin': cas.split('/lyuapServer')[0],
      'Referer': cas + '/login?service=' + encodeURIComponent(CFG.cas.portal),
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/plain, */*',
    });
    var body = String(r.body || '');
    var m = /TGT-[A-Za-z0-9_.\-]+/.exec(body);
    if (!m) {
      // 不自动重试；把服务端原话带回去，界面上说人话
      var why = '登录没成功';
      if (/验证码|kaptcha/i.test(body)) why = '需要验证码，请刷新后人工完成';
      else if (/密码|账号.*(错|误)/.test(body)) why = '学号或密码不对';
      throw new EamsError(why + '（' + (r.status || '网络') + '）', 'auth');
    }
    var tgt = m[0];
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

  async function timetable(semesterId, semesterName) {
    // 🔴 达小助改造（W3）：青果 DataTable 取课表，镜像 kingo.timetable。
    //   会话类错误向上抛（withLogin 靠它重登一次再试）；空表≠过期。
    //   courses 先原样保留解析行并标 shape:'raw' —— 周次/节次列的真实格式
    //   待阶段2抓包核对后固化，绝不猜格式编造格子。
    var rows = await kingoFetch('timetable');
    var tw = null;
    try { tw = await kingoTotalWeeks(); } catch (e) { /* 周数取不到照交课表 */ }
    var ctx = kingoCtx || {};
    var out = {
      unitCount: CFG.unit_count || 12,
      courses: rows, totalWeeks: tw, weekStart: 1,
      semester: ctx.lcmc || semesterName || '',
      shape: 'raw',
    };
    if (!rows.length) out.empty = true;
    return out;
  }

  async function grades() {
    var rows = await kingoFetch('score');
    return { summary: [], overall: null, courses: rows, shape: 'raw', empty: !rows.length };
  }

  async function profile() {
    var rows = await kingoFetch('profile');
    // 键值两列行版式：某格等于中文标签 → 取右边第一个非空值（镜像 kingo.profile）
    var KEYS = { '学号': 'studentId', '姓名': 'name', '性别': 'gender', '年级': 'grade',
                 '院系': 'dept', '专业': 'major', '方向': 'direction', '所属班级': 'className',
                 '班级': 'className', '所属校区': 'campus', '学籍状态': 'status', '学历层次': 'level',
                 '学制': 'duration', '入学时间': 'enrolledAt', '入学年份': 'grade', '毕业时间': 'graduateAt' };
    var p = {};
    for (var i = 0; i < rows.length; i++) {
      var vals = [];
      for (var k in rows[i]) vals.push(rows[i][k]);
      for (var j = 0; j < vals.length - 1; j++) {
        var kk = String(vals[j] || '').trim().replace(/[：:]$/, '');
        if (KEYS[kk]) {
          var vv = String(vals[j + 1] || '').trim();
          if (vv && vv !== '*' && !p[KEYS[kk]]) p[KEYS[kk]] = vv;
        }
      }
    }
    if (!p.studentId) throw new EamsError('没拿到学籍信息，可能登录过期了', 'auth');
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
    // 🔴 达小助改造（W3）：青果 DataTable 取考试，镜像 kingo.exams。
    //   学校没排考 = 空列表 + published=false，不是错误。
    var rows = await kingoFetch('exam');
    return { exams: rows, published: rows.length > 0, shape: 'raw' };
  }

  /** 全部学期。青果来源端点未确认 → 只给当前学期一项（界面只显示它）。 */
  async function semesters() {
    var c = kingoCtx || {};
    try { c = await kingoContext(); } catch (e) { /* 拿不到就空列表 */ }
    var m = /(\d{4})-(\d{4})/.exec(String(c.xn || ''));
    if (!m) return [];
    return [{ id: m[1] + '-' + m[2] + '/' + (c.xqM || '1'),
              name: m[1] + '-' + m[2] + '学年第' + (c.xqM || '1') + '学期' }];
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
  async function doSync(user, pwd) {
    try {
      return await doSyncOnce(user, pwd);
    } catch (e) {
      // 密码错是「用户重输一次就能解决」的，重试纯属白等
      if (e && e.kind === 'auth') throw e;
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
      return await doSyncOnce(user, pwd);
    }
  }

  async function doSyncOnce(user, pwd) {
    idsCache = '';
    examPageSeen = false;
    projectReady = false;
    await login(user, pwd);
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
        total: 0, cats: [], courses: [], subs: [],
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
  // 🔴 达小助改造（W4）：公告路由已停用（见 NativeApi.handle），下面这份郑航
  //   六部门源表仅作历史参照；升达公告站与链接形状待阶段2抓包确认后重建。
  var NOTICE_SOURCES = [
    ['校级通知', 'https://www.zua.edu.cn/xwzx/tzgg.htm', '学校'],
    ['学籍通知', 'https://jwc.zua.edu.cn/xjgl/xjtz.htm', '教务处'],
    ['实践通知', 'https://jwc.zua.edu.cn/sjjx/sjtz.htm', '教务处'],
    ['团委通知', 'https://tuanwei.zua.edu.cn/tzgg.htm', '团委'],
    ['后勤动态', 'https://hqfwzgs.zua.edu.cn/', '后勤管理处'],
    ['信息中心', 'https://xxglzx.zua.edu.cn/xwzx/tzgg.htm', '信息管理中心']
  ];
  // 详情只允许抓校内域名。否则 ?u=http://evil/... 就成了
  // 「让用户的手机替我访问内网」的一个洞。
  var NOTICE_HOSTS = ['zua.edu.cn'];

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
    SF: 'https://sfrz.zua.edu.cn/lyuapServer',
    RH: 'https://rhmh.zua.edu.cn',
    SERVICE: 'https://rhmh.zua.edu.cn/shiro-cas',
    CARD: '1b1029d961e94aa196fb7f0ec072d622',
    KEY: 'hyPortal',
    // 上次「保活」的时间戳（毫秒）。见 pfKeepAlive。
    TOUCH: 'hyPortal.touchAt',
    EXP: 65537,
    // 门户 app.js 里的 public_exponent / modulus 两个字面量
    N: '00b5eeb166e069920e80bebd1fea4829d3d1f3216f2aabe79b6c47a3c18dcee5' +
       'fd22c2e7ac519cab59198ece036dcf289ea8201e2a0b9ded307f8fb704136eaeb' +
       '670286f5ad44e691005ba9ea5af04ada5367cd724b5a26fdb5120cc95b6431604' +
       'bd219c6b7d83a6f8f24b43918ea988a76f93c333aa5a20991493d4eb1117e7b1',
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
    var cands = ['https://sfrz.zua.edu.cn/lyuapServer/',
                 'https://sfrz.zua.edu.cn/lyuapServer/login',
                 'https://sfrz.zua.edu.cn/'];

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
            origin: 'https://sfrz.zua.edu.cn',
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

  // ------------------------------------------------------ 慧生活798（直饮水）
  //
  // 查余额 / 列设备 / 接水 / 停止 / 积分 / 消费记录 / 积分任务 / 签到。
  //
  // 🔴 和 water.py 是**同一套规则的两份实现**（APK 没有 Python）。改一边必须
  //    逐条镜像另一边，`check_water_api.py` 会拿同一批响应喂给两边对拍。
  //
  // 🔴 **两套账号是两个账号**（2026-10-30 起）：设备登录（1,1）管接水和设备，
  //    积分登录（1,5）管积分、任务、签到。两个 token 互不通用，任务列表
  //    按平台各返回一份 —— 原版是合并后去重再跑的，只登一个就少一半任务。
  //
  // 🔴 签名：积分/签到**必须签**（0.26.2 之前写「不带」是错的）。
  //    md5(adId + 30×桶 + token尾8 + uid尾8 + 盐)，两个盐见下面常量。
  //    细则见 mobile/water.py 开头那段。
  var WATER = {
    BASE: 'https://i.ilife798.com/api/v1',
    // 官方客户端的 UA。第三方项目用 "WaterWidget/5.5.0" 也能通，说明服务端
    // 不是硬校验；取官方那个是为了兼容（万一哪天按 UA 分流）。
    UA: 'Android_ilife798_3.1.9',
    T_ACCOUNT: '1,5',
    T_DEVICE: '1,1',
    // 服务端 API 版本号（**和客户端版本无关**，原版按用途写死不同的值）。
    // 漏了不会报错，只会拿到「另一个版本」的响应 —— 那种错最难查。
    V_ACCOUNT: '2.0.83',
    V_SCORE: '2.0.178',
    V_DEVICE: '3.1.9',
    // 积分签名的两个盐（2026-10-30 从官方 Release APK 的 dex 里读出来的，
    // 见 water.py 开头那段）。它们不是服务端密钥，是**客户端常量**。
    SALT_APP: 'AbCdEfGhIjKlMnOpQrStUvWxYz12345',
    SALT_MINI: 'K9xP2QnR5T8wY3fA7cE1gJ4mL6oU0sZ',
    // 积分登录 body 里的 cid。设备那一路不发这个字段。
    CID: 'drinkwaterapp123456789',
    // 🔴 下面这些是**查出来的字段名，不是猜的**（2026-10-30 对着原项目
    //    life-798 5.5.0 源码核对过；细则见 mobile/water.py 那一大段注释）。
    //    data.missions[i] = {refId, name, score, limit}
    //      · 响应里叫 refId，请求 body 里才叫 adId —— 两个名字一个东西
    //      · data.accScoreRsp.limits[j].limit 是**已做次数**（-1=不限次），
    //        和 missions[i].limit（总次数）同名反义，剩余要自己减
    //    data.dailyRSP = {adId, score, config:[{rule,score,msg}]}
    //      · rule 是连签奖励的位掩码；已签掩码在 accScoreRsp.daily.week
    //    ⇒ 和 water.py 的 missions() **必须逐条对应**（红线：两份实现要对拍）。
    MISSION_SKIP: ['免费权益', '借贷', '贷款'],
    // 加分类型码要特殊处理的 adId。原版写死 `"1705776998".equals(adId) ? 2 : 4`。
    // ⚠️ 这**不是**签到任务（原项目单测里它 name 是 "video"）。
    SIGN_AD_ID: '1705776998'
  };

  function wErr(msg, kind, code) {
    var e = new Error(msg);
    e.kind = kind || 'net';
    e.code = (code == null ? null : code);
    return e;
  }

  /** 图形验证码的会话串。原项目用 10 位随机字母数字，照做。 */
  function wKey() {
    var cs = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    var s = '';
    for (var i = 0; i < 10; i++) s += cs.charAt(Math.floor(Math.random() * cs.length));
    return s;
  }

  /** 纯 JS 的 MD5（按 **UTF-8 字节**算，和 Python 的 hashlib.md5(s.encode('utf-8')) 一致）。
   *
   *  🔴 APK 里没有 Python，签名只能在这儿算；而水.py 那边是 hashlib。
   *     两份实现算出来**必须逐字节相同**，否则同一次任务在网页版和 APK 里
   *     一个能跑一个报「签名不对」，而那种错看着像服务端的问题。
   *     `check_water_api.py` 拿同一批输入对拍两边（红线 54）。
   *
   *  ⚠️ 不要图省事用 charCodeAt 直接算：只要有一个非 ASCII 字符（服务端
   *     将来把 adId 换成中文、或者 token 里带 emoji），两边就会分叉。
   */
  function wMd5(str) {
    function toBytes(s) {
      var out = [], i, c;
      for (i = 0; i < s.length; i++) {
        c = s.charCodeAt(i);
        if (c < 0x80) {
          out.push(c);
        } else if (c < 0x800) {
          out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
        } else if (c < 0xD800 || c >= 0xE000) {
          out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        } else {
          i++;
          var c2 = s.charCodeAt(i) || 0;
          var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
          out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                   0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        }
      }
      return out;
    }
    var K = [], i;
    for (i = 0; i < 64; i++) {
      K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    }
    var S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

    var bytes = toBytes(String(str == null ? '' : str));
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var lo = bitLen >>> 0, hi = Math.floor(bitLen / 4294967296) >>> 0;
    bytes.push(lo & 255, (lo >>> 8) & 255, (lo >>> 16) & 255, (lo >>> 24) & 255);
    bytes.push(hi & 255, (hi >>> 8) & 255, (hi >>> 16) & 255, (hi >>> 24) & 255);

    var a0 = 0x67452301, b0 = 0xEFCDAB89, c0 = 0x98BADCFE, d0 = 0x10325476;
    for (var off = 0; off < bytes.length; off += 64) {
      var M = [];
      for (i = 0; i < 16; i++) {
        M[i] = (bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8)
                | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24)) | 0;
      }
      var A = a0, B = b0, C = c0, D = d0;
      for (i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        var sh = S[(i >> 4) * 4 + (i % 4)];
        A = D; D = C; C = B;
        B = (B + (((F << sh) | (F >>> (32 - sh))) | 0)) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    function hex(n) {
      var s = '';
      for (var j = 0; j < 4; j++) {
        s += ('0' + (((n >>> (j * 8)) & 255).toString(16))).slice(-2);
      }
      return s;
    }
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }

  async function wReq(method, path, token, body, appType, version) {
    var at = appType || WATER.T_DEVICE;
    var headers = {
      'User-Agent': WATER.UA,
      'Accept': 'application/json, text/plain, */*',
      'ApplicationType': at,
      // 原版每个请求都带 VersionCode，服务端按它决定返回哪套结构。
      'VersionCode': version || (at === WATER.T_DEVICE
        ? WATER.V_DEVICE : WATER.V_ACCOUNT)
    };
    if (token) headers['Authorization'] = token;
    if (body != null) headers['Content-Type'] = 'application/json';

    var r;
    try {
      r = await pfHttp(method, WATER.BASE + path,
                       body == null ? '' : JSON.stringify(body), headers);
    } catch (e) {
      throw wErr('连不上饮水服务：' + ((e && e.message) || e), 'net');
    }
    // 🔴 202 = 限流。和 502 一样，不单独判的话会被当成「服务器挂了」，
    //    而用户该做的事完全不同（等几分钟 vs 换个网）。
    if (r && r.status === 202) throw wErr('请求太频繁，等几分钟再试', 'limit');
    if (!r || r.status !== 200) {
      throw wErr('饮水服务没响应', 'net');
    }
    var js;
    try { js = JSON.parse(r.body); } catch (e) {
      throw wErr('饮水服务可能在维护，过一会儿再试', 'data');
    }
    return js;
  }

  /** 统一判 code。0 成功；-99 登录过期；其余按服务端 msg 说。 */
  function wCheck(js) {
    var code = Number(js && js.code);
    if (code === 0) return (js && js.data);
    if (code === -99) throw wErr('登录状态过期了，要重新登录一次', 'auth', code);
    var msg = String((js && js.msg) || '');
    // 签名被拒要单独标出来：那说明「实测不需要签名」这个前提被推翻了，
    // 界面该说的是这件事，不是「操作失败」。
    if (/签名|sign/i.test(msg)) throw wErr('平台的校验没通过（可能需要更新 App）', 'sign', code);
    if (/频繁|限流/.test(msg)) throw wErr(msg, 'limit', code);
    throw wErr(msg || '操作没成功', 'biz', code);
  }

  /** 整数。认字符串，认不出来返回 null（**不兜底成 0**）。 */
  function wInt(v) {
    if (v == null || typeof v === 'boolean') return null;
    if (typeof v === 'number') return isFinite(v) ? Math.trunc(v) : null;
    var n = parseFloat(String(v).trim());
    return isFinite(n) ? Math.trunc(n) : null;
  }

  /** 时间戳统一成毫秒。服务端有的给秒（10 位），有的给毫秒（13 位）。 */
  function wMs(v) {
    var n = wInt(v);
    if (n == null || n <= 0) return 0;
    return n < 10000000000 ? n * 1000 : n;
  }

  /** 列表类响应的记录数组。null = 这个键不存在（结构变了）；[] = 确实没有。 */
  function wRecords(js) {
    var d = js && js.data;
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return null;
    var ks = ['records', 'items', 'list', 'content'];
    for (var i = 0; i < ks.length; i++) {
      if (Array.isArray(d[ks[i]])) return d[ks[i]];
    }
    return null;
  }

  /** 从 data 里取出「积分那一坨」。套着 accScoreRsp 就剥一层，没套就用 data 本身。
   *
   *  🔴 两种形状都要认，因为两条接口不一样（2026-10-30 查源码确认）：
   *     GET /acc/score/acc-score   → data 本身就是 {validScore, totalScore, limits, daily}
   *     GET /acc/score/mission-lst → data.accScoreRsp 才是那一坨
   *     原版 IlifeApi.taskDataWithToken 干的就是 `missions.data.accScoreRsp = score.data`。
   *
   *  返回 null = 这一坨压根不存在（**不是**「0 分」）。
   *  **和 water.py 的 _score_rsp 逐条对应**。 */
  function wScoreRsp(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    var inner = data.accScoreRsp;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
    if ('validScore' in data || 'totalScore' in data) return data;
    return null;
  }

  /** accScoreRsp.limits → {refId: 已做次数}。**-1 表示不限次**。
   *  **和 water.py 的 _limits 逐条对应**。 */
  function wLimits(rsp) {
    var out = {};
    if (!rsp || typeof rsp !== 'object' || !Array.isArray(rsp.limits)) return out;
    for (var i = 0; i < rsp.limits.length; i++) {
      var it = rsp.limits[i];
      if (!it || typeof it !== 'object') continue;
      var rid = String(it.refId || '').trim();
      var n = wInt(it.limit);
      if (rid && n != null && n >= -1) out[rid] = n;
    }
    return out;
  }

  /** 今天星期几，1=周一 … 7=周日（和原版 Calendar 的换算一致）。
   *  ⚠️ 只能用本机日期 —— 服务端没给。**和 water.py 的 _today_weekday 对应**。 */
  function wTodayWeekday() {
    var d = new Date().getDay();     // 0=周日 … 6=周六
    return d === 0 ? 7 : d;
  }

  /** 每日签到状态。返回 {adId, score, week, weekday, signed, rewards}；没有就 null。
   *  **和 water.py 的 _daily 逐条对应**。
   *  ⚠️ 星期几只能用本机日期（服务端没给）。**不补签、不自动签**（用户 2026-10-30 定）。 */
  function wDaily(data) {
    if (!data || typeof data !== 'object') return null;
    var rsp = data.dailyRSP;
    if (!rsp || typeof rsp !== 'object') return null;
    var adid = String(rsp.adId || '').trim();
    if (!adid) return null;
    var week = 0;
    var sc = data.accScoreRsp;
    if (sc && typeof sc === 'object' && sc.daily && typeof sc.daily === 'object') {
      week = wInt(sc.daily.week) || 0;
    }
    var wd = wTodayWeekday();
    var rewards = [];
    if (Array.isArray(rsp.config)) {
      for (var i = 0; i < rsp.config.length; i++) {
        var r = rsp.config[i];
        if (!r || typeof r !== 'object') continue;
        var mask = wInt(r.rule), sco = wInt(r.score);
        if (mask && mask > 0 && sco) {
          rewards.push({ rule: mask, score: sco, msg: String(r.msg || '').trim() });
        }
      }
    }
    return {
      adId: adid,
      score: wInt(rsp.score),
      week: week,
      weekday: wd,
      signed: !!(week & (1 << (wd - 1))),
      rewards: rewards
    };
  }

  function wNum(v) {
    if (v == null || typeof v === 'boolean') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var n = parseFloat(String(v).trim());
    return isFinite(n) ? n : null;
  }

  function wLoad() {
    if (!(window.Android && typeof Android.loadWater === 'function')) return null;
    var s = '';
    try { s = String(Android.loadWater() || ''); } catch (e) { return null; }
    if (!s) return null;
    var d;
    try { d = JSON.parse(s); } catch (e) { return null; }
    if (!d || typeof d !== 'object') return null;
    // 老状态（只有一个顶层 token）就地迁移成 device 那一格 ——
    // 不迁移的话老用户升级后会被判成「没登录」，而 token 明明还在。
    if (d.token && (!d.device || typeof d.device !== 'object')) {
      d.device = { token: String(d.token || ''), uid: String(d.uid || ''),
                   eid: String(d.eid || ''), phone: String(d.phone || ''),
                   at: Number(d.at || 0) };
      delete d.token; delete d.uid; delete d.eid; delete d.phone;
    }
    return d;
  }

  /** 取某一套账号。null = 这个账号没登。**和 bridge.py 的 water_acct 对应**。 */
  function wAcct(st, kind) {
    if (!st || typeof st !== 'object') return null;
    var a = st[kind];
    if (a && typeof a === 'object' && a.token) return a;
    return null;
  }

  /** 设备账号的 token。余额 / 设备 / 接水**只用它**。 */
  function wDev(st) {
    var a = wAcct(st, 'device');
    if (!a) {
      throw wErr('设备账号没登录 —— 接水、余额、设备列表要用「设备登录」那个账号',
                 'auth');
    }
    return a.token;
  }

  /** 积分类接口用哪个账号。优先积分账号（1,5），没登就退设备账号（1,1）——
   *  原版也是这个优先级（`useApp = !account.hasToken()`）。
   *  返回 {token, useApp}。**和 bridge.py 的 water_score_lane 对应**。 */
  function wScoreLane(st) {
    var s = wAcct(st, 'score');
    if (s) return { token: s.token, useApp: false };
    var d = wAcct(st, 'device');
    if (d) return { token: d.token, useApp: true };
    throw wErr('还没登录', 'auth');
  }

  /** 这个操作要哪个账号。返回空串 = 能过，非空 = 该说的话。
   *
   *  🔴 **不能统一按 `state === 'ok'` 判**（0.26.2 修的）：两套账号并存以后，
   *     只登了积分账号时 `state()` 是 `'partial'` —— 按 ok 判会把「明明能做」
   *     的积分/任务/签到全挡住，还报「还没登录」，用户刚登过。
   *     所以要按**这个操作实际需要哪个账号**分别判。
   *  `kind='device'`：接水 / 余额 / 设备列表，只认设备账号（1,1 那一路）；
   *  `kind='any'`：积分 / 任务 / 签到，有一个就行（water_score_lane 会兜底）。 */
  function wGate(kind) {
    var st = wLoad();
    var dev = wAcct(st, 'device'), sco = wAcct(st, 'score');
    if (kind === 'device') {
      if (dev) return '';
      return sco
        ? '这个功能要用「设备登录」那个账号（接水、余额、设备列表都归它）'
        : '还没登录';
    }
    return (dev || sco) ? '' : '还没登录';
  }

  /** 算积分/签到的签名。**两条路都签，没有不签的分支。**
   *  md5(adId + 30×(毫秒/30000) + token后8位 + uid后8位 + 盐)
   *  **和 water.py 的 sign_score 逐条对应**（两边算出来必须一模一样）。 */
  function wSignScore(adId, token, uid, useApp, nowMs) {
    var now = (nowMs == null ? Date.now() : Number(nowMs));
    var bucket = 30 * Math.floor(now / 30000);
    var tok = String(token == null ? '' : token);
    var u = String(uid == null ? '' : uid);
    return wMd5(String(adId == null ? '' : adId) + String(bucket)
                + tok.slice(-8) + u.slice(-8)
                + (useApp ? WATER.SALT_APP : WATER.SALT_MINI));
  }

  /** 存。空串 = 成功，其余是原因（和 CredStore.save 同构）。
   *  🔴 `'none'` 这个原因是有来历的：0.23.0 的 APK 里**压根没有** saveWater
   *     （CredStore 写好了、NativeBridge 漏了转发），用户登录成功却看到
   *     「token 存不进本机（none）」。现在有 check_bridge_methods.py 对账。 */
  function wSave(obj) {
    if (!(window.Android && typeof Android.saveWater === 'function')) return 'none';
    try { return String(Android.saveWater(JSON.stringify(obj)) || ''); }
    catch (e) { return 'fail: ' + ((e && e.message) || e); }
  }

  /** 「没登录」和「存着但解不开」必须分开。
   *  解不开 = 换过手机 / 清过数据 / Keystore 换了密钥 ⇒ 重新登录一次就好；
   *  混成一句「没登录」，用户只会觉得「怎么又要登」。 */
  function wBroken() {
    if (!(window.Android && typeof Android.waterState === 'function')) return false;
    try { return String(Android.waterState() || '') === 'broken'; }
    catch (e) { return false; }
  }

  var WaterApi = {
    /** 这个壳能不能用（老 APK 没有 req2 / saveWater）。 */
    available: function () {
      return !!(window.Android && typeof Android.req2 === 'function'
                && typeof Android.saveWater === 'function');
    },

    captchaKey: wKey,

    /** 图形验证码图片地址。给 <img src> 直接用，不经过我们的代码。 */
    captchaUrl: function (key) {
      return WATER.BASE + '/captcha/?s=' + encodeURIComponent(key) + '&r=' + Date.now();
    },

    /** 发短信。`graph` 是用户**自己看图读出来**的 —— 和门户那道一样，绝不自动识别。 */
    sendSms: async function (phone, key, graph) {
      var js = await wReq('POST', '/acc/login/code', null,
                          { un: phone, authCode: graph, s: key }, WATER.T_DEVICE);
      wCheck(js);
      return true;
    },

    /** 短信验证码换 token。`kind` = 'device'（1,1）或 'score'（1,5）。
     *
     *  🔴 **只覆盖登录的那一格**，另一格原样留着。整套覆盖的话，登完积分账号
     *     会把设备账号踢掉 —— 接水立刻不能用了，而用户以为自己只是「补登了一个」。
     */
    login: async function (phone, sms, kind) {
      var k = (kind === 'score') ? 'score' : 'device';
      var useApp = (k === 'device');
      var body = { authCode: sms, un: phone };
      if (!useApp) {
        // 账户服务那一路要多两个字段；设备控制这一路不需要。
        body.openCode = '';
        body.cid = WATER.CID;
      }
      var js = await wReq('POST', '/acc/login', null, body,
                          useApp ? WATER.T_DEVICE : WATER.T_ACCOUNT,
                          useApp ? WATER.V_DEVICE : WATER.V_ACCOUNT);
      var data = wCheck(js) || {};
      var al = (data.al && typeof data.al === 'object') ? data.al : data;
      var token = String((al && al.token) || '').trim();
      if (!token) throw wErr('登录成功了，但没拿到登录凭据，请重试', 'data');
      var st = wLoad() || {};
      st[k] = {
        token: token, phone: String(phone || ''),
        uid: String((al && (al.uid || al.id)) || ''),
        eid: String((al && al.eid) || ''),
        at: Date.now()
      };
      if (!Array.isArray(st.devices)) st.devices = [];
      var why = wSave(st);
      // 🔴 `'soft'` 是**存好了**，只是 Keystore 用不了、退到了备用加密方式
      //    （见 CredStore.savePlain 的第二层）。它和 `'fail: …'` 是两回事。
      //    0.26.3 及以前这里写的是 `if (why)`，把 `'soft'` 也当失败抛了 ——
      //    于是明明存上了，用户每次登录都看到「token 存不进本机（soft）」，
      //    而且因为抛错，调用方走的是失败分支、整页不刷新 ⇒ 出水功能看起来
      //    **完全不能用**。这两句话是同一件事，别当成两个 bug 修。
      //    对照 app.js 的 credSaved()：那边一直是 `s === 'soft' → ok:true`。
      if (why && why !== 'soft') {
        // 'none' = 这个壳里根本没有 saveWater（0.23.0 就是），不是磁盘满了。
        // 两种原因要分开说，否则用户只能反复重登。
        throw wErr(why === 'none'
          ? '这个版本还记不住登录（装 0.24.0 以上就好），'
            + '现在关掉 App 就得重登'
          : '登录成功了，但没记住（' + why + '），关掉 App 就得重登',
          'data');
      }
      return { phone: st[k].phone, uid: st[k].uid, kind: k, soft: why === 'soft' };
    },

    /** 本机状态。**不探网** —— 每次切进这一页都探一次等于白等。
     *  两套账号**分开报**，缺哪个要能看出来缺哪个。 */
    state: function () {
      var st = wLoad();
      var dev = wAcct(st, 'device'), sco = wAcct(st, 'score');
      if (!dev && !sco) {
        // 「存着但解不开」不等于「没登录」—— 前者重登一次就好，后者是第一次用。
        return { ok: true, state: wBroken() ? 'broken' : 'none', accounts: {} };
      }
      function brief(a) {
        if (!a) return null;
        return { phone: String(a.phone || ''), uid: String(a.uid || ''),
                 at: Number(a.at || 0) };
      }
      return { ok: true, state: (dev && sco) ? 'ok' : 'partial',
               accounts: { device: brief(dev), score: brief(sco) },
               phone: (dev && dev.phone) || '',
               devices: (st && st.devices) || [], at: (st && st.at) || 0 };
    },

    /** 退出。给了 kind 只退那一格 —— 退积分账号不该把接水也弄坏。 */
    logout: function (kind) {
      var k = (kind === 'device' || kind === 'score') ? kind : '';
      if (k) {
        var st = wLoad();
        if (st) {
          delete st[k];
          if (!wAcct(st, 'device') && !wAcct(st, 'score')) {
            if (window.Android && typeof Android.clearWater === 'function') {
              try { Android.clearWater(); } catch (e) { /* 清不掉也别崩 */ }
            }
          } else {
            wSave(st);
          }
        }
        return true;
      }
      if (window.Android && typeof Android.clearWater === 'function') {
        try { Android.clearWater(); } catch (e) { /* 清不掉也别崩 */ }
      }
      return true;
    },

    /** 查余额。取不到返回 null —— **不返回 0**（「没读到」≠「钱没了」）。 */
    balance: async function () {
      var st = wLoad();
      var js = await wReq('GET', '/acc/wallet/owner', wDev(st), null, WATER.T_DEVICE);
      var data = wCheck(js) || {};
      var cands = [];
      if (data.aw && typeof data.aw === 'object') cands.push(data.aw);
      if (Array.isArray(data.eps)) {
        data.eps.forEach(function (x) { if (x && typeof x === 'object') cands.push(x); });
      }
      for (var i = 0; i < cands.length; i++) {
        var ks = ['total', 'olCash', 'balance'];
        for (var j = 0; j < ks.length; j++) {
          var v = wNum(cands[i][ks[j]]);
          if (v != null) return v;
        }
      }
      return null;
    },

    /** 列设备。🔴 favos 键不存在 = 响应变了（报错）；存在但是空 = 真没有设备。 */
    devices: async function () {
      var st = wLoad();
      var js = await wReq('GET', '/ui/app/master', wDev(st), null, WATER.T_DEVICE);
      var data = wCheck(js) || {};
      if (!('favos' in data)) throw wErr('设备列表没读出来，平台可能改版了', 'data');
      var favos = data.favos || [];
      var out = [];
      for (var i = 0; i < favos.length; i++) {
        var it = favos[i];
        if (!it || typeof it !== 'object') continue;
        var did = String(it.id || '').trim();
        if (!did) continue;
        out.push({ id: did, name: String(it.name || '').trim() });
      }
      // 顺手记进本机：下次进来先画缓存，不用等网络
      st.devices = out;
      st.at = Date.now();
      wSave(st);
      return out;
    },

    /** 启动一台设备。**唯一有副作用的调用**，界面那边必须二次确认。
     *
     *  成功返回的是**文案**（不是 true）—— 和 water.py 的 `dev_start`
     *  返回 `(True, msg)` 是同一个意思。文案只有这一个来源：
     *  以前 handle() 那边另抄了一句「已经启动了，接完记得点结束」，
     *  两边各改各的就会分叉，而分叉了**不报错**。 */
    start: async function (did) {
      var st = wLoad();
      if (!wAcct(st, 'device') && !wAcct(st, 'score')) throw wErr('还没登录', 'auth');
      var path = '/dev/start?did=' + encodeURIComponent(String(did || ''))
               + '&upgrade=true&ptype=91&rcp=false';
      var js = await wReq('GET', path, wDev(st), null, WATER.T_DEVICE);
      var code = Number(js && js.code);
      if (code === 0) return '已经启动了，接完记得点结束';
      // 这些 code 是协议里定死的业务含义，逐条翻成人话 ——
      // 统一说「操作失败」等于什么都没说，而每条用户该做的事都不一样。
      var map = {
        '-99': ['登录状态过期了，要重新登录一次', 'auth'],
        '-21': ['这个账号没有设备控制权限，得先在慧生活798 里登录一次设备端', 'biz'],
        '-88': ['还没签约代扣协议，要去慧生活798 里签一下', 'biz'],
        '-87': ['代扣签约过期了，要去慧生活798 里重新签', 'biz'],
        '-52': ['账户欠费了，先充值', 'biz'],
        '-20': ['还没绑定一卡通，要先去慧生活798 里绑', 'biz'],
        '-19': ['设备正在准备，等几秒再点一次', 'biz'],
        '-82': ['需要先支付', 'biz']
      };
      var hit = map[String(code)];
      if (hit) throw wErr(hit[0], hit[1], code);
      throw wErr(String((js && js.msg) || ('启动失败（code=' + code + '）')), 'biz', code);
    },

    /* ==============================================================
       0.24.0 新增：停止接水 / 积分 / 消费记录 / 套餐 / 签到 / 收藏设备
       --------------------------------------------------------------
       这一批照 WaterWidget（nocookies111/life-798，MIT）公开的协议**自己
       重写**，没有复制它的代码。和 water.py 逐条对应（红线 54：两份实现，
       改一边忘另一边不报错 ⇒ check_water_api.py 拿同一批响应对拍）。

       🔴 充值不下单：原版 /bill/save 建单 + /trans/prepay/21 取支付宝 SDK
          串。我们是 WebView 壳没有那个 SDK；而且那是真钱交易，金额错了、
          退款、纠纷都落在用户身上。⇒ 只做 /prd/lst 展示 + 让用户去官方 App。
       🔴 积分任务只列不批量跑：作者自己 README 写着「积分冻结、任务提示成功
          但没到账，原因尚未确认」。
       🔴 签到不带 sign：盐是别人没公开的配置，不挖、不写进公开仓库。
          先不带 sign 试，失败报 kind='sign'，再和用户商量。
       ============================================================== */

    /** 停止接水。**第二个有副作用的调用**（结束计费），要二次确认。
     *  🔴 不自动重试：同一台设备可能不止一个人在用，重试可能停掉别人的水。 */
    end: async function (did) {
      var st = wLoad();
      if (!wAcct(st, 'device') && !wAcct(st, 'score')) throw wErr('还没登录', 'auth');
      var path = '/dev/end?did=' + encodeURIComponent(String(did || ''))
               + '&rcp=false';
      var js = await wReq('GET', path, wDev(st), null, WATER.T_DEVICE);
      var code = Number(js && js.code);
      if (code === 0) return '停止请求已发出，等设备结束和账单结算';
      if (code === -99) throw wErr('登录状态过期了，要重新登录一次', 'auth', code);
      throw wErr(String((js && js.msg) || ('停止失败（code=' + code + '）')), 'biz', code);
    },

    /** 可用积分。{valid, total}，读不到的项是 null（「没读到」≠「0 分」）。 */
    score: async function () {
      var st = wLoad();
      var lane = wScoreLane(st);
      var js = await wReq('GET', '/acc/score/acc-score', lane.token, null,
                          lane.useApp ? WATER.T_DEVICE : WATER.T_ACCOUNT,
                          lane.useApp ? WATER.V_DEVICE : WATER.V_SCORE);
      var data = wCheck(js) || {};
      var rsp = wScoreRsp(data);
      if (!rsp) return { valid: null, total: null };
      var valid = wInt(rsp.validScore);
      var total = wInt(rsp.totalScore);
      if (total == null) total = valid;
      return { valid: valid, total: total };
    },

    /** 钱包列表 —— 积分兑换要的 endpointId 就在这儿。
     *  [{endpointId, name, ownerId, balance}]
     *
     *  🔴 和 water.py 的 wallets() **逐条对应**：`data.aw`（单个）+
     *     `data.eps[]`（多个端点），`ep.id` 是兑换要的端点 id，
     *     `owner.id` 是用户 id，余额取 total → olCash → balance。
     *  ⚠️ 一个钱包都没有 ⇒ 空数组（不是报错）；`data` 整个不是对象才报错 ——
     *     前者是「你确实没有水卡」，后者是「响应变了」。
     */
    wallets: async function () {
      var st = wLoad();
      var lane = wScoreLane(st);
      var js = await wReq('GET', '/acc/wallet/owner', lane.token, null,
                          lane.useApp ? WATER.T_DEVICE : WATER.T_ACCOUNT,
                          lane.useApp ? WATER.V_DEVICE : WATER.V_SCORE);
      // 🔴 不能写 `wCheck(js) || {}`：空数组 / 空字符串都是**假值**，
      //    那样 `data: []` 会被悄悄换成 `{}` ⇒「响应结构变了」被说成
      //    「你一个钱包都没有」。两个相反的结论，只差一个 `||`。
      var data = wCheck(js);
      if (data == null) data = {};
      if (typeof data !== 'object' || Array.isArray(data)) {
        throw wErr('钱包没读出来，平台可能改版了', 'data');
      }
      var cands = [];
      if (data.aw && typeof data.aw === 'object') cands.push(data.aw);
      if (Array.isArray(data.eps)) {
        for (var i = 0; i < data.eps.length; i++) {
          if (data.eps[i] && typeof data.eps[i] === 'object') cands.push(data.eps[i]);
        }
      }
      var out = [], seen = {};
      for (var j = 0; j < cands.length; j++) {
        var w = cands[j];
        var ep = (w.ep && typeof w.ep === 'object') ? w.ep : null;
        if (!ep) continue;
        var eid = String(ep.id == null ? '' : ep.id).trim();
        if (!eid) continue;
        var ow = (w.owner && typeof w.owner === 'object') ? w.owner : {};
        var oid = String(ow.id == null ? '' : ow.id).trim();
        var key = eid + '\u0000' + oid;
        if (seen[key]) continue;
        seen[key] = 1;
        var bal = null;
        var ks = ['total', 'olCash', 'balance'];
        for (var k = 0; k < ks.length; k++) {
          bal = wNum(w[ks[k]]);
          if (bal != null) break;
        }
        out.push({
          endpointId: eid,
          name: String(ep.name == null ? '' : ep.name).trim() || eid,
          ownerId: oid,
          balance: bal
        });
      }
      return out;
    },

    /** 积分兑换余额。返回账单号（`data.sn`）。**有副作用，失败不重试。**
     *
     *  🔴 协议（原版 `ScoreExchangeParser.requestBody`）：
     *         POST /acc/score/score-use
     *         body {"ep":{"id":…},"score":N,"type":1}
     *     只传**总积分**、不传份数 —— 份数由 app.js 的 `wtExTotalOf` 乘出来
     *     （网页版和 APK 跑的是同一份 app.js，这条规则只有那一处）。
     *  ⚠️ 拿到 sn **不等于兑换完成**：要 `exchangeBill()` 查到 status 3 才算。
     *     网络结果不明确时**绝不自动重试**（重试 = 再扣一次积分）。
     */
    scoreExchange: async function (eid, score) {
      var st = wLoad();
      var id = String(eid == null ? '' : eid).trim();
      if (!id) throw wErr('没选兑换到哪个钱包', 'biz');
      var n = wInt(score);
      if (n == null) throw wErr('兑换积分不是数字（' + score + '）', 'data');
      if (n <= 0 || n % 100 !== 0) {
        throw wErr('兑换积分要是 100 的整数倍（现在是 ' + n + '）', 'data');
      }
      var lane = wScoreLane(st);
      var js = await wReq('POST', '/acc/score/score-use', lane.token,
                          { ep: { id: id }, score: n, type: 1 },
                          lane.useApp ? WATER.T_DEVICE : WATER.T_ACCOUNT,
                          lane.useApp ? WATER.V_DEVICE : WATER.V_SCORE);
      var data = wCheck(js) || {};
      if (typeof data !== 'object' || Array.isArray(data)) {
        throw wErr('兑换结果没读出来，平台可能改版了', 'data');
      }
      var sn = String(data.sn == null ? '' : data.sn).trim();
      if (!sn || sn === 'null') {
        throw wErr('没确认成功，也没给账单号（结果未知，别重复兑换）', 'data');
      }
      return sn;
    },

    /** 查兑换账单。{id, status, done}。`status === 3` 才算完成。 */
    exchangeBill: async function (bid) {
      var st = wLoad();
      var id = String(bid == null ? '' : bid).trim();
      if (!id) throw wErr('没给账单号', 'biz');
      var lane = wScoreLane(st);
      var js = await wReq('GET', '/bill/view-full?id=' + encodeURIComponent(id),
                          lane.token, null,
                          lane.useApp ? WATER.T_DEVICE : WATER.T_ACCOUNT,
                          lane.useApp ? WATER.V_DEVICE : WATER.V_SCORE);
      var data = wCheck(js) || {};
      var bill = (data && typeof data === 'object' && !Array.isArray(data)
                  && data.bill && typeof data.bill === 'object') ? data.bill : null;
      if (!bill) throw wErr('兑换账单还没出（过一会儿再看，别重复兑换）', 'data');
      var got = String(bill.id == null ? '' : bill.id).trim();
      if (got && got !== id) {
        throw wErr('查到的是另一张账单（' + got + ' ≠ ' + id + '）', 'data');
      }
      var stt = wInt(bill.status);
      return { id: id, status: (stt == null ? -1 : stt), done: stt === 3 };
    },

    /** 消费记录一页。{items:[{id,at,money,did,kind,msg}], more, total}
     *  🔴 money 取不到是 null，不兜底成 0（显示 ¥0.00 会让人以为这单免费）。 */
    bills: async function (page, size) {
      var st = wLoad();
      if (!wAcct(st, 'device') && !wAcct(st, 'score')) throw wErr('还没登录', 'auth');
      var pg = (page == null ? 0 : page), sz = (size == null ? 20 : size);
      var path = '/bill/lst-owner?page=' + pg + '&size=' + sz;
      var js = await wReq('GET', path, wDev(st), null, WATER.T_DEVICE);
      wCheck(js);
      var recs = wRecords(js);
      if (recs == null) throw wErr('消费记录没读出来，平台可能改版了', 'data');
      var out = [];
      for (var i = 0; i < recs.length; i++) {
        var it = recs[i];
        if (!it || typeof it !== 'object') continue;
        var dd = (it.data && typeof it.data === 'object') ? it.data : {};
        var dv = (it.dev && typeof it.dev === 'object') ? it.dev : {};
        var did = dv.id || it.did || dd.did || dd.deviceId || '';
        out.push({
          id: String(it.id || '').trim(),
          at: wMs(it.utime || it.ctime),
          money: wNum(it.payment),
          did: String(did).trim(),
          kind: wInt(it.type),
          msg: String(it.msg || '').trim()
        });
      }
      var total = null;
      if (js.data && typeof js.data === 'object' && !Array.isArray(js.data)) {
        total = wInt(js.data.total != null ? js.data.total : js.data.totalCount);
      }
      var more = (total != null) ? ((pg + 1) * sz < total) : (out.length >= sz);
      return { items: out, more: more, total: total };
    },

    /** 积分任务列表 + 签到状态。
     *  {items:[{refId,name,score,limit,used,left}], skipped, daily:{…}|null}
     *
     *  🔴 和 water.py 的 missions() **逐条对应**（红线：两份实现必须对拍）。
     *  🔴 字段名是查出来的（原项目 5.5.0 源码），不是猜的：
     *     missions[i] = {refId, name, score, limit}
     *     已做次数在 accScoreRsp.limits[j] = {refId, limit}（-1 = 不限次）
     *     ⇒ left = limit - used，**自己算**，响应里没有现成的剩余。
     *  🔴 读不到就抛，**绝不返回空数组**冒充「你没有任务」。
     */
    /** 任务列表（**一个平台**）。**和 water.py 的 missions() 逐条对应**。 */
    missions: async function (token, useApp) {
      var js = await wReq('GET', '/acc/score/mission-lst', token, null,
                          useApp ? WATER.T_DEVICE : WATER.T_ACCOUNT,
                          useApp ? WATER.V_DEVICE : WATER.V_SCORE);
      var data = wCheck(js);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw wErr('任务列表没读出来，平台可能改版了', 'data');
      }
      var recs = data.missions;
      if (!Array.isArray(recs)) {
        throw wErr('任务列表没读出来，平台可能改版了', 'data');
      }
      var done = wLimits(wScoreRsp(data));
      var out = [], skipped = 0;
      for (var i = 0; i < recs.length; i++) {
        var it = recs[i];
        if (!it || typeof it !== 'object') { skipped++; continue; }
        var rid = String(it.refId || '').trim();
        if (!rid) { skipped++; continue; }
        var name = String(it.name || it.title || '').trim();
        var hit = false;
        for (var k = 0; k < WATER.MISSION_SKIP.length; k++) {
          if (name && name.indexOf(WATER.MISSION_SKIP[k]) >= 0) { hit = true; break; }
        }
        if (hit) { skipped++; continue; }      // 原版也跳这类
        var limit = wInt(it.limit);
        var used = (rid in done) ? done[rid] : null;
        var left = null;
        if (limit != null && limit > 0 && used !== -1) {
          left = Math.max(0, limit - (used || 0));
        }
        out.push({
          refId: rid,
          name: name || rid,
          score: wInt(it.score),
          limit: limit,
          used: used,
          left: left,
          // 任务自带签名就带上。**实测响应里没有这个字段**（原版 postScore
          // 两条路都自己算签名），保留转发只是「服务端哪天给了不用改代码」。
          sign: String(it.sign || '').trim()
        });
      }
      return { items: out, skipped: skipped, daily: wDaily(data) };
    },

    /** 两个平台的**任务合并**（原版 TaskMissionPlanner.merge 的行为）。
     *  **和 water.py 的 missions_all 逐条对应**。
     *
     *  🔴 一个平台读失败**不拖垮另一个**，但也不许安静吞掉：失败记在 lanes 里，
     *     界面要能说出「少的是哪个平台」，否则看起来就像「任务只有这些」。 */
    missionsAll: async function () {
      var st = wLoad();
      if (!wAcct(st, 'device') && !wAcct(st, 'score')) {
        throw wErr('还没登录', 'auth');
      }
      var dev = wAcct(st, 'device'), sco = wAcct(st, 'score');
      var lanes = {}, errs = {}, items = [], skipped = 0, daily = null;
      // 顺序：积分平台在前（原版 merge 也是先 main 后 app，同 refId 以 main 为准）
      var plan = [
        { lane: 'score', tok: sco ? sco.token : null, useApp: false },
        { lane: 'device', tok: dev ? dev.token : null, useApp: true }
      ];
      for (var i = 0; i < plan.length; i++) {
        var p = plan[i];
        if (!p.tok) { lanes[p.lane] = 'missing'; continue; }
        var got;
        try {
          got = await WaterApi.missions(p.tok, p.useApp);
        } catch (e) {
          lanes[p.lane] = 'error';
          errs[p.lane] = (e && e.message) || String(e);
          continue;
        }
        lanes[p.lane] = 'ok';
        skipped += (got.skipped || 0);
        if (daily == null && got.daily) daily = got.daily;
        for (var j = 0; j < got.items.length; j++) {
          var it = got.items[j];
          it.platform = p.lane;
          items.push(it);
        }
      }
      // 按 refId 去重，先到的留下
      var seen = {}, uniq = [];
      for (var k = 0; k < items.length; k++) {
        if (seen[items[k].refId]) continue;
        seen[items[k].refId] = 1;
        uniq.push(items[k]);
      }
      var anyOk = false, ks = Object.keys(lanes);
      for (var m = 0; m < ks.length; m++) if (lanes[ks[m]] === 'ok') anyOk = true;
      if (!uniq.length && !anyOk) {
        // 一个都没读成功 ⇒ 这是真失败，不是「没有任务」
        var detail = Object.keys(errs).map(function (x) {
          return x + '：' + errs[x];
        }).join('；') || '没有可用的账号';
        var isAuth = false;
        Object.keys(errs).forEach(function (x) {
          if (errs[x].indexOf('登录') >= 0) isAuth = true;
        });
        throw wErr('两个平台的任务都没读到（' + detail + '）',
                   isAuth ? 'auth' : 'data');
      }
      return { items: uniq, skipped: skipped, daily: daily,
               lanes: lanes, errors: errs };
    },

    /** 执行一个积分任务。**有副作用**，界面二次确认，失败不重试。
     *
     *  🔴 签名是必须的（0.26.2 之前这里不带 sign，是错的）：
     *     md5(adId + 30×桶 + token尾8 + uid尾8 + 盐)，见 wSignScore。
     *     `platform` 决定用哪个账号、哪套盐和请求头。
     *  ⚠️ 返回成功**不等于到账**，界面跑完要重新读积分核验。
     *  addScore 读不到就不发 —— 发一个错的比不发更糟。
     */
    missionDone: async function (adId, addScore, platform) {
      var st = wLoad();
      var adid = String(adId || '').trim();
      if (!adid) throw wErr('这个任务做不了，平台没给必要的信息', 'biz');
      var lane, useApp;
      if (platform === 'device') {
        lane = { token: wDev(st), useApp: true };
        useApp = true;
      } else {
        // 🔴 用 `lane.useApp`，别写死 false：wScoreLane 在没登积分账号时会
        //    退回设备 token 并把 useApp 置 true。写死 false 就是
        //    「设备 token 配积分盐 + 1,5 头」⇒ 服务端按无效 token 拒掉。
        //    signIn 一直是跟着回退走的，这里原来跟它不一致。
        lane = wScoreLane(st);
        useApp = lane.useApp;
      }
      var acct = wAcct(st, useApp ? 'device' : 'score') || wAcct(st, 'device') || {};
      var sig = wSignScore(adid, lane.token, String(acct.uid || ''), useApp);
      var q = '?sign=' + encodeURIComponent(sig);
      if (useApp) q += '&s=1';
      var body = { adId: adid, type: 101 };
      if (useApp && addScore != null && isFinite(addScore)) {
        body.addScore = Number(addScore);
        body.addScoreType = (adid === WATER.SIGN_AD_ID) ? 2 : 4;
      }
      var js = await wReq('POST', '/acc/score/score-send' + q, lane.token, body,
                          useApp ? WATER.T_DEVICE : WATER.T_ACCOUNT,
                          useApp ? WATER.V_DEVICE : WATER.V_SCORE);
      return wDoneResult(js, '任务');
    },

    /** 每日签到。**有副作用**，失败不重试。
     *  body 的键名两条路不一样（原版就这样，不是笔误）：
     *    App 路 {weekday, addScore, addScoreType:1, adId} / 积分路 {weekDay, adId}
     *  **和 water.py 的 sign_in 逐条对应**。 */
    signIn: async function (adId, weekday, score) {
      var st = wLoad();
      var adid = String(adId || '').trim();
      if (!adid) throw wErr('这个签到做不了，平台没给必要的信息', 'biz');
      var wd = wInt(weekday);
      if (wd == null || wd < 1 || wd > 7) {
        throw wErr('星期几算错了（' + weekday + '），不敢签', 'data');
      }
      var lane = wScoreLane(st);
      var useApp = lane.useApp;
      var acct = wAcct(st, useApp ? 'device' : 'score') || wAcct(st, 'device') || {};
      var sig = wSignScore(adid, lane.token, String(acct.uid || ''), useApp);
      var q = '?sign=' + encodeURIComponent(sig);
      if (useApp) q += '&s=1';
      var body = useApp
        ? { weekday: wd, addScore: (wInt(score) || 0), addScoreType: 1, adId: adid }
        : { weekDay: wd, adId: adid };
      var js = await wReq('POST', '/acc/score/score-send' + q, lane.token, body,
                          useApp ? WATER.T_DEVICE : WATER.T_ACCOUNT,
                          useApp ? WATER.V_DEVICE : WATER.V_SCORE);
      return wDoneResult(js, '签到');
    }
  };

  /** score-send 的公共收尾：0 = 提交成功（**不等于到账**），其余按 code 说话。
   *  **和 water.py 的 _done_result 逐条对应**。 */
  function wDoneResult(js, what) {
    var code = Number(js && js.code);
    if (code === 0) {
      return String((js && js.msg) || '').trim() || (what + '已提交');
    }
    if (code === -99) throw wErr('登录状态过期了，要重新登录一次', 'auth', code);
    var msg = String((js && js.msg) || '').trim();
    if (/签名|sign/i.test(msg)) throw wErr(msg || '平台的校验没通过', 'sign', code);
    if (/频繁|限流/.test(msg)) throw wErr(msg, 'limit', code);
    throw wErr(msg || (what + '没成功'), 'biz', code);
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
        // ---------------- 慧生活798（直饮水） ----------------
        // 和 bridge.py 的 /api/water/* **一一对应**（路径、字段、错误形状都一样），
        // 所以 app.js 那边只写一套，不用 `if (NATIVE)` 分叉。
        if (path === '/api/water/state') return WaterApi.state();
        if (path === '/api/water/captcha') {
          var wk = WaterApi.captchaKey();
          return { ok: true, key: wk, url: WaterApi.captchaUrl(wk) };
        }
        if (path === '/api/water/sms') {
          await WaterApi.sendSms(body.phone, body.key, body.graph);
          return { ok: true };
        }
        if (path === '/api/water/login') {
          var wl = await WaterApi.login(body.phone, body.sms, body.kind);
          // soft 要带上去：'soft' = 存好了但走的是备用加密方式。
          // 它是**成功**，只是调用方有权知道一句（换手机/清数据后要重登）。
          return { ok: true, phone: wl.phone, kind: wl.kind, soft: !!wl.soft };
        }
        if (path === '/api/water/home') {
          var g0 = wGate('device');
          if (g0) return { ok: false, error: g0, kind: 'auth' };
          var wout = { ok: true };
          // 🔴 余额和设备分开报错：一个挂了不该把另一个也变成「读不到」，
          //    也不许安静吞掉。和 bridge.py 那段是同一套规则。
          try {
            wout.balance = await WaterApi.balance();
          } catch (e1) {
            if (e1 && e1.kind === 'auth') {
              return { ok: false, error: e1.message, kind: 'auth' };
            }
            wout.balance = null;
            wout.balanceError = (e1 && e1.message) || String(e1);
          }
          try {
            wout.devices = await WaterApi.devices();
          } catch (e2) {
            if (e2 && e2.kind === 'auth') {
              return { ok: false, error: e2.message, kind: 'auth' };
            }
            wout.devices = WaterApi.state().devices || [];
            wout.devicesError = (e2 && e2.message) || String(e2);
          }
          return wout;
        }
        if (path === '/api/water/start') {
          // 文案由 WaterApi.start 给，**不在这里另写一句** ——
          // 两份文案各改各的会分叉，而且不报错（和 water.py 对照的测试抓得到）。
          var wmsg = await WaterApi.start(body.did);
          return { ok: true, msg: wmsg };
        }
        if (path === '/api/water/logout') {
          WaterApi.logout(body.kind);
          return { ok: true, kind: body.kind || '' };
        }
        // ---------------- 0.24.0：和 bridge.py 逐条对应 ----------------
        if (path === '/api/water/score') {
          var g1 = wGate('any');
          if (g1) return { ok: false, error: g1, kind: 'auth' };
          var sc = await WaterApi.score();
          return { ok: true, valid: sc.valid, total: sc.total };
        }
        if (path === '/api/water/bills') {
          var g2 = wGate('device');
          if (g2) return { ok: false, error: g2, kind: 'auth' };
          var bp = parseInt(q.page, 10);
          var got = await WaterApi.bills(isFinite(bp) ? bp : 0, 20);
          return { ok: true, items: got.items, more: got.more, total: got.total };
        }
        if (path === '/api/water/missions') {
          var g3 = wGate('any');
          if (g3) return { ok: false, error: g3, kind: 'auth' };
          var mg = await WaterApi.missionsAll();
          // 🔴 `daily` / `lanes` / `errors` 必须一起转发（同 bridge.py 那条注释）：
          //    漏了 daily ⇒ 签到卡永远藏着；漏了 lanes ⇒ 界面不知道
          //    「少一半任务是没登积分账号」，只会显得「任务就是这些」。
          return { ok: true, items: mg.items, skipped: mg.skipped,
                   daily: mg.daily, lanes: mg.lanes, errors: mg.errors };
        }
        if (path === '/api/water/signin') {
          if (!String(body.adId || '').trim()) {
            return { ok: false, error: '签到信息不全，做不了' };
          }
          var si = await WaterApi.signIn(body.adId, body.weekday, body.score);
          return { ok: true, msg: si };
        }
        if (path === '/api/water/end') {
          var g4 = wGate('device');
          if (g4) return { ok: false, error: g4, kind: 'auth' };
          if (!String(body.did || '').trim()) {
            return { ok: false, error: '没给设备号' };
          }
          return { ok: true, msg: await WaterApi.end(body.did) };
        }
        if (path === '/api/water/mission') {
          var g5 = wGate('any');
          if (g5) return { ok: false, error: g5, kind: 'auth' };
          if (!String(body.adId || '').trim()) {
            return { ok: false, error: '没给任务 id' };
          }
          var as = (body.score == null || body.score === '') ? null : Number(body.score);
          var mm = await WaterApi.missionDone(body.adId,
                     isFinite(as) ? as : null, String(body.platform || ''));
          return { ok: true, msg: mm };
        }
        // ---------------- 0.27.1：积分兑换余额 ----------------
        // 和 bridge.py 一一对应（路径、字段、错误形状都一样）。
        if (path === '/api/water/wallets') {
          var gw = wGate('any');
          if (gw) return { ok: false, error: gw, kind: 'auth' };
          return { ok: true, wallets: await WaterApi.wallets() };
        }
        if (path === '/api/water/exchange') {
          var ge = wGate('any');
          if (ge) return { ok: false, error: ge, kind: 'auth' };
          if (!String(body.eid || '').trim()) {
            return { ok: false, error: '没选兑换到哪个钱包' };
          }
          if (body.score == null || body.score === '') {
            return { ok: false, error: '没给要兑换的积分' };
          }
          try {
            return { ok: true, sn: await WaterApi.scoreExchange(body.eid, body.score) };
          } catch (e) {
            var ek = (e && e.kind) || '';
            // 🔴 网络类失败**不代表没扣分**：请求可能已经到服务端了。
            //    文案必须让用户先去核验，不能让他「再点一次」—— 那就是再扣一次。
            if (!ek || ek === 'net' || ek === 'limit') {
              return { ok: false, kind: ek || 'net',
                       error: '兑换结果未知（' + ((e && e.message) || e)
                              + '），先别重复兑换' };
            }
            return { ok: false, error: (e && e.message) || String(e), kind: ek };
          }
        }
        if (path === '/api/water/exchange-bill') {
          var gb = wGate('any');
          if (gb) return { ok: false, error: gb, kind: 'auth' };
          var bid = String((q && q.id) || '').trim();
          if (!bid) return { ok: false, error: '没给账单号' };
          try {
            var eb = await WaterApi.exchangeBill(bid);
            return { ok: true, id: eb.id, status: eb.status, done: eb.done };
          } catch (e2) {
            return { ok: false, error: (e2 && e2.message) || String(e2),
                     kind: (e2 && e2.kind) || '' };
          }
        }
        if (path === '/api/state') {
          var c = loadCred();
          var cs = '';
          try { cs = String(Android.credState() || ''); } catch (e) { cs = ''; }
          return { ok: true, bound: !!c, username: c ? c.u : '', credState: cs };
        }
        if (path === '/api/login') {
          var user = (body.username || '').trim();
          var pwd = body.password || '';
          if (!user || !pwd) return { ok: false, error: '请填学号和密码' };
          var payload = await doSync(user, pwd);
          if (body.remember !== false) {
            // 空串 = 存好了；"soft" = 走了备用方式；"fail: xxx" = 没存上。
            // 🔴 别再把这三件事压成一个布尔值 —— 用户有权知道密码到底存没存住。
            var why = '';
            try { why = String(Android.saveCred(user, pwd) || ''); } catch (e) {
              why = 'fail: 调用原生保存出错（' + ((e && e.message) || e) + '）';
            }
            payload.saved = why;
          }
          return payload;
        }
        if (path === '/api/sync') {
          var acc = loadCred();
          if (!acc) return { ok: false, error: '还没绑定账号', needBind: true };
          return await doSync(acc.u, acc.p);
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
        // ---- 智慧门户：一卡通 + 19 个办事应用 ----
        // 契约与 bridge.py 的 do_GET / do_POST 完全一致（app.js 只写一套分支）。
        if (path === '/api/portal/status') {
          var pst = pfState();
          var pj = pfJwt();
          // `saved` = 本机存着门户密码 ⇒ 过期后只需算一道验证码。
          // 只回「存的是哪个学号」，密码本身不出原生层。
          var pcr = pfCredLoad();
          var savedInfo = { saved: !!pcr, savedUser: pcr ? pcr.u : '',
                            pwdState: pfCredState() };
          if (!pst.tgt && !pj) {
            // 没连过。密码可能还存着（比如只断开了会话），「连接门户」照样能省一步。
            return { ok: true, state: 'none', saved: savedInfo.saved,
                     savedUser: savedInfo.savedUser, pwdState: savedInfo.pwdState };
          }
          // 只做本地判断，不探网：这个接口每次切到「校园」页都会调，
          // 探一次网就多几百毫秒。真正的死活由 card/apps 的 needLogin 决定。
          //
          // 🔴 唯一例外是**保活**（2026-10-28）：它确实要发请求，但
          //    `pfKeepAlive` 不 await、自己限频（2 小时一次）、失败不出声，
          //    所以这里既不会变慢也不会因为门户抽风而报错。
          //    放这儿是因为「进校园页」是用户一天里最稳定的那个动作。
          pfKeepAlive();
          return { ok: true, state: 'ok', user: pst.user || pfSub(pj),
                   saved: savedInfo.saved, savedUser: savedInfo.savedUser,
                   pwdState: savedInfo.pwdState };
        }
        if (path === '/api/portal/captcha') {
          try { return await pfCaptcha(); }
          catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        }
        if (path === '/api/portal/login') {
          var pu = String(body.user || '').trim();
          var pp = body.pass || '';
          var pc = String(body.code || '').trim();
          // 密码留空 = 「用本机存着的那份」。过期重登时人只需要算一道算术题。
          var usedSaved = false;
          if (!pp) {
            var sc = pfCredLoad();
            if (!sc) return { ok: false, error: '学号和密码都要填', needCaptcha: true };
            // 🔴 存的是另一个学号的密码就**不许**拿去试：门户错 5 次锁号。
            if (sc.u && pu && sc.u !== pu) {
              return { ok: false, needCaptcha: true,
                       error: '本机存的是 ' + sc.u + ' 的门户密码，跟这个学号对不上，请手动输入' };
            }
            pp = sc.p;
            pu = pu || sc.u;
            usedSaved = true;
          }
          // 🔴 一律带 needCaptcha：验证码是一次性的，哪一步失败这张都不能再用
          if (!pu || !pp) return { ok: false, error: '学号和密码都要填', needCaptcha: true };
          if (!pc) return { ok: false, error: '还没算验证码', needCaptcha: true };
          var lr;
          try { lr = await pfLogin(pu, pp, pc); }
          catch (e) {
            return { ok: false, error: '登录出错：' + ((e && e.message) || e),
                     needCaptcha: true };
          }
          if (lr && lr.ok) {
            // 这次用的密码是对的（不管是手输的还是存的）⇒ 存下来，下次省一步。
            // 把「存没存住」如实带回去：存不上必须让人知道，否则下次又白输一遍。
            lr.pwdSave = pfCredSave(pu, pp);
            return lr;
          }
          var out = lr || { ok: false, error: '登录失败', needCaptcha: true };
          // 用着本机存的密码、门户又明确说「密码/账号不对」⇒ 把密码和会话都扔了。
          // 不扔的话下次还会拿一个错密码去撞，撞 5 次号就锁了。
          if (usedSaved && PF_PWD_BAD.indexOf(String(out.code || '')) >= 0) {
            pfCredClear();
            try { localStorage.removeItem(PF.KEY); } catch (e2) { /* 无所谓 */ }
            out.pwdStale = true;
            out.error = String(out.error || '密码不对') + ' —— 存着的那份密码已经删掉，请手动输入一次';
          }
          return out;
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
        // 🔴 白名单只放**本校**的地址：这张票等于一次登录态，
        //    拼到别人的域名上就是把登录态送出去了。
        //    `([a-z0-9-]+\.)*` 让 shengda.edu.cn 本身和各级子域都算，
        //    但不接受 `shengda.edu.cn.evil.com` 这种（后面必须紧跟 / 或结尾）。
        if (path === '/api/portal/ticket') {
          var svc = String(q.service || '').trim();
          if (!/^https:\/\/([a-z0-9-]+\.)*shengda\.edu\.cn(\/|$)/i.test(svc)) {
            return { ok: false, error: '只给学校（shengda.edu.cn）的地址换票' };
          }
          return await pfServiceTicket(svc);
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
          if (tsid && !/^\d+$/.test(tsid)) return { ok: false, error: '学期编号不对' };
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

    /** 别的 App 装了没有。返回 '1' / '0' / 'none'。
     *
     *  'none' = 这个壳**没有这个接口**（网页版、加这个能力之前的 APK）。
     *
     *  🔴 必须和 '0'（确实没装）分开。两者都是「拿不到」，但该做的事相反：
     *     '0'   → 让人去装（点了才提示，别在页面上催）
     *     'none'→ 直接给网页/商店入口，别催一个网页版用户去装 App
     *     以前这里如果统一返回 boolean，两种都是 undefined，调用方只能猜 ——
     *     猜错的代价是「装了却让人去下载」。
     */
    hasApp: function (pkg) {
      if (!(window.Android && typeof window.Android.hasApp === 'function')) return 'none';
      try { return String(window.Android.hasApp(String(pkg || '')) || '0'); }
      catch (e) { return '0'; }
    },

    /** 拉起另一个 App（Java 侧见 NativeBridge.openApp，**包名走白名单**）。
     *
     *  返回：'ok' = 已经切过去了；'notinstalled' = 没装；
     *        'deny' = 包名不在白名单（调用方写错）；'none' = 这个壳没这个能力；
     *        其余 = 起不来的原因。
     */
    openApp: function (pkg) {
      if (!(window.Android && typeof window.Android.openApp === 'function')) return 'none';
      try { return String(window.Android.openApp(String(pkg || '')) || 'fail: 空返回'); }
      catch (e) { return 'fail: ' + ((e && e.message) || e); }
    },

    /** 慧生活798（直饮水）。定义在本文件上半部分，规则和 water.py 逐条镜像。 */
    water: WaterApi,

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
