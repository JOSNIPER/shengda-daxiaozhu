// W5 对拍 · JS 轨一侧：在 Node 里跑 native.js（linkedom 提供 DOMParser），
// Android 桥用本机 HTTP + 内存 cookie jar 模拟，打 mock_server 的端口。
// 用法: node w5_js_side.js <port>   输出: stdout 一段 JSON（与 w5_py_side.py 同形）
'use strict';
const { parseHTML } = require('D:/xiangmu/daxiaozhu/app/node_modules/linkedom');
const http = require('http');
const fs = require('fs');

const PORT = parseInt(process.argv[2] || '18091', 10);

// ---------- 模拟 java.net.CookieStore（只按 host 存，忽略 domain 后缀规则） ----------
const jar = new Map(); // host -> Map(name->value)
function jarSet(host, name, val) {
  if (!jar.has(host)) jar.set(host, new Map());
  jar.get(host).set(name, val);
}
function jarGet(hostUrl, name) {
  try {
    const u = new URL(hostUrl);
    const m = jar.get(u.host);
    return m && m.get(name) ? m.get(name) : '';
  } catch (e) { return ''; }
}
function cookieHeader(url) {
  try {
    const u = new URL(url);
    const m = jar.get(u.host);
    if (!m || !m.size) return '';
    return [...m.entries()].map(([k, v]) => k + '=' + v).join('; ');
  } catch (e) { return ''; }
}
function absorbSetCookie(url, headers) {
  const sc = headers['set-cookie'];
  if (!sc) return;
  const u = new URL(url);
  for (const line of sc) {
    const kv = line.split(';')[0];
    const eq = kv.indexOf('=');
    if (eq > 0) jarSet(u.host, kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
}

// ---------- Android 桥 ----------
let reqSeq = 0;
const pending = new Map();

/* ---- CAS 密码 RSA 加密（Node 侧等价实现，供 Android.casRsa 桩使用）----
   算法与 app/cas_rsa.py、NativeBridge.java 逐条一致：
   两个字符拼一个小端 16 位字 → 按 16 位一段累加 → modPow → hex 左补到 4 的倍数。 */
const CAS_MODULUS_HEX =
  '00b5eeb166e069920e80bebd1fea4829d3d1f3216f2aabe79b6c47a3c18dcee5' +
  'fd22c2e7ac519cab59198ece036dcf289ea8201e2a0b9ded307f8fb704136eaeb' +
  '670286f5ad44e691005ba9ea5af04ada5367cd724b5a26fdb5120cc95b6431604' +
  'bd219c6b7d83a6f8f24b43918ea988a76f93c333aa5a20991493d4eb1117e7b1';
const CAS_N = BigInt('0x' + CAS_MODULUS_HEX);
const CAS_E = 65537n;

function bigPowMod(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

function casRsaBigInt(pwd) {
  if (!pwd) return '';
  const CHUNK = 126;
  const codes = [];
  for (const ch of String(pwd)) codes.push(ch.codePointAt(0));
  while (codes.length % CHUNK !== 0) codes.push(0);
  let out = '';
  for (let off = 0; off < codes.length; off += CHUNK) {
    let acc = 0n;
    for (let r = 0; r < CHUNK / 2; r++) {
      const i = off + 2 * r;
      const lo = codes[i] || 0;
      const hi = codes[i + 1] || 0;
      const word = lo + (hi << 8);
      if (word) acc |= BigInt(word) << BigInt(16 * r);
    }
    let hex = bigPowMod(acc, CAS_E, CAS_N).toString(16);
    while (hex.length % 4 !== 0) hex = '0' + hex;
    out += hex;
  }
  return out;
}

function fireNativeDone(id, obj) {
  const cb = global.window.__nativeDone;
  if (cb) cb(id, JSON.stringify(obj));
}

function doReq(method, url, body, referer, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const h = Object.assign({ 'User-Agent': 'DaXiaoZhu-test' }, headers || {});
    if (referer) h['Referer'] = referer;
    const ck = cookieHeader(url);
    if (ck) h['Cookie'] = ck;
    // 真实壳(HttpURLConnection)发 POST 会带 Content-Length；模拟服务只认它。
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      method, headers: h,
    }, (res) => {      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => {
        absorbSetCookie(url, res.headers);
        const raw = Buffer.concat(bufs);
        // GBK/charset 解码逻辑与 NativeBridge.readAll 同规
        const ct = res.headers['content-type'] || '';
        let text;
        try {
          const m = /charset=([\w-]+)/i.exec(ct);
          if (m) text = require('D:/xiangmu/daxiaozhu/app/node_modules/iconv-lite').decode(raw, m[1]);
          else {
            text = require('D:/xiangmu/daxiaozhu/app/node_modules/iconv-lite').decode(raw, 'gbk');
            if (text.includes('\uFFFD')) text = raw.toString('utf8');
          }
        } catch (e) { text = raw.toString('utf8'); }
        // 302 手动跟一次（对齐 doReq 的兜底）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          return resolve(doReq('GET', next, '', url, {}).then((r) => { r.url = r.url || next; return r; }));
        }
        resolve({ status: res.statusCode, body: text, url });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: '', url: '', error: String(e) }));
    if (body) req.write(body);
    req.end();
  });
}

global.Android = {
  req(id, method, path, body, referer) {
    doReq(method, path, body, referer, {}).then((r) => fireNativeDone(id, r));
  },
  req2(id, method, path, body, referer, headersJson) {
    let hs = {};
    try { hs = headersJson ? JSON.parse(headersJson) : {}; } catch (e) { }
    doReq(method, path, body, referer, hs).then((r) => fireNativeDone(id, r));
  },
  setCookie(url, header) {
    // "CASTGC=TGT-xxx; Path=/; Domain=127.0.0.1"
    const kv = String(header).split(';')[0];
    const eq = kv.indexOf('=');
    if (eq <= 0) return false;
    try { jarSet(new URL(url).host, kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()); return true; }
    catch (e) { return false; }
  },
  cookie(url, name) { return jarGet(url, name); },
  webCookie(url, name) { return ''; },
  webCookieLike() { return ''; },
  loadCred() { return JSON.stringify({ u: '2024010101', p: 'mock-pass' }); },
  saveCred() { return ''; },
  clearCred() { },
  credState() { return 'ok'; },
  /* CAS 密码 RSA 加密 —— 生产环境在 NativeBridge.casRsa（java.math.BigInteger）。
     这里是 Node 侧的等价实现，用 BigInt 复刻同一套「小端 16 位字 + 补 0」算法，
     所以 W5 对拍同时也验证了 JS/Java 侧与 Python 侧算出同一串密文。
     算法改一处就要改三处：cas_rsa.py / NativeBridge.java / 这里。 */
  casRsa(pwd) { return casRsaBigInt(pwd); },
  clearCookies() { jar.clear(); return true; },
  loadPortalCred() { return ''; }, savePortalCred() { return ''; }, portalCredState() { return 'none'; },
  clearPortalCred() { },
  cxDumpCookies() { return '[]'; }, cxLoad() { return ''; }, cxSave() { return ''; }, cxClear() { },
  cxHasLogin() { return false; }, cxAes(p) { return ''; }, cxClearCookies() { return 0; },
  cxPwdSave() { return ''; }, cxPwdLoad() { return null; }, cxPwdState() { return 'none'; }, clearCxPwd() { },
  clearCookiesFor() { },
  addCalendar() { return 'none'; },
  openWeb() { return 'none'; }, openUrl() { return false; },
  cookieJs() { return ''; }, webCookieJs() { return ''; },
};

// ---------- window / DOM ----------
const { window: domWin } = parseHTML('<!doctype html><html><body></body></html>');
global.window = domWin;
global.document = domWin.document;
global.DOMParser = domWin.DOMParser;
domWin.Android = global.Android;
domWin.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
domWin.setTimeout = setTimeout;
domWin.clearTimeout = clearTimeout;

// fetch('config.json') 通道 = 构建时 assets 注入。测试里注入 mock 版配置。
global.fetch = async (u) => {
  if (String(u).includes('config.json')) {
    const cfg = {
      cas: { base: 'http://127.0.0.1:' + PORT + '/lyuapServer',
             portal: 'http://127.0.0.1:' + PORT + '/',
             tickets_path: '/v1/tickets', kaptcha_path: '/kaptcha' },
      jw: { base: 'http://127.0.0.1:' + PORT,
            cas_service: 'http://127.0.0.1:' + PORT + '/caslogin',
            home_path: '/frame/homes.action',
            menu_context_path: '/frame/normalusemenu/getBreadcrumbsInfoNew.action',
            droplist_path: '/frame/droplist/getDropLists.action',
            term_path: '/jw/common/showYearTerm.action',
            data_table_path: '/taglib/DataTable.jsp',
            polite_delay_sec: 0 },
      pages: {
        timetable: { kind: 'kbt', path: '/student/wsxk.xskcb10319.jsp',
                     menucode: 'S20301', params_b64: 'xn={xn}&xq={xq}&xh={xh}' },
        score: { kind: 'stuckcj', path: '/student/xscj.stuckcj.jsp',
                 data_path: '/student/xscj.stuckcj_data.jsp', menucode: 'S40303',
                 body: { sjxz: 'sjxz1', ysyx: 'yxcj', zx: '1', fx: '1', wz: '0',
                         btnExport: '导出', ysyxS: 'on', sjxzS: 'on', zxC: 'on',
                         fxC: 'on', xsjd: '1' } },
        exam: { kind: 'unsupported' },
        free_room: { kind: 'unsupported' },
        profile: { kind: 'from_kbt' },
      },
      column_map: { timetable: {}, score: {}, exam: {}, free_room: {}, profile: {} },
      timetable: { unit_count: null },
      semester: { total_weeks: null },
      free_room: { max_periods: null }, chaoxing: { fid: null },
      update: {},
    };
    return { ok: true, json: async () => cfg };
  }
  throw new Error('no fetch for ' + u);
};
domWin.fetch = global.fetch;

// ---------- 载入 native.js ----------
const src = fs.readFileSync('D:/xiangmu/daxiaozhu/app/web/native.js', 'utf8');
new Function('window', 'document', 'Android', 'DOMParser', 'setTimeout',
  'clearTimeout', 'fetch', 'localStorage', 'URL', 'BigInt', 'console', src)(
  domWin, domWin.document, global.Android, domWin.DOMParser,
  setTimeout, clearTimeout, global.fetch, domWin.localStorage, URL, BigInt, console);

function handle(path, body) {
  return domWin.NativeApi.handle(path, body || {});
}

/* 测试专用的直连 GET —— 上面 global.fetch 被换成了只答 config.json 的桩，
   拿 mock 的答案要走真 http。 */
function httpGetJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try { res(JSON.parse(d)); } catch (e) { rej(e); }
      });
    }).on('error', rej);
  });
}

async function main() {
  // 等 config.json 注入完成（loadCfg 是异步 IIFE）
  await new Promise((r) => setTimeout(r, 120));
  // 🔴 学校 CAS 第一次登录就要验证码（isVerifyCode=1），所以这里必须先取一张。
  const cap = await handle('/api/captcha');
  let answer = '';
  if (cap.ok) {
    // 测试专用端点：mock 从不把答案给客户端，这里是为了能稳定地走通「验证码对」
    // 那条路。生产环境没有这个东西。
    const ar = await httpGetJson('http://127.0.0.1:' + PORT + '/mock/kaptcha-answer');
    answer = ar.answer || '';
  }
  const sync = cap.ok
    ? await handle('/api/login', {
        username: '2024010101', password: 'mock-pass', code: answer,
      })
    : { ok: false, error: 'captcha failed: ' + (cap.error || '') };
  const fr = await handle('/api/free-rooms', {
    date: '2026-11-05', periodBegin: 1, periodEnd: 2,
  });
  const out = {
    ok: sync.ok,
    profile: sync.profile,
    semester: sync.semester,
    unitCount: sync.unitCount,
    totalWeeks: sync.totalWeeks,
    // 🔴 0.1.10：总学分 / 门数也要进对拍（见 w5_py_side.py 的同名注释）
    credits: sync.credits || '',
    courseCount: sync.courseCount || 0,
    courses: sync.courses,
    grades: sync.grades,
    exams: sync.exams,
    plan: sync.plan,
    free_rooms_probe: fr.ok ? {
      rooms: fr.rooms, notice: fr.notice, raw: fr.raw,
      dateBegin: fr.dateBegin, periodBegin: fr.periodBegin, truncated: fr.truncated,
    } : { error: fr.error },
    week_probe: sync.totalWeeks,
  };
  process.stdout.write(JSON.stringify(out, null, 0));
}

main().catch((e) => { console.error('JS_SIDE_FAIL', e); process.exit(1); });