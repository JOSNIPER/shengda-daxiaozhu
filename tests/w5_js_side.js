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
            menu_context_path: '/frame/normalusemenu/getBreadcrumbsInfoNew.action',
            data_table_path: '/taglib/DataTable.jsp',
            time_range_path: '/jw/common/getWsxkTimeRange.action',
            score_stat_path: '/jw/common/getSelectLessonScoreKcsInfo.action',
            home_path: '/frame/homes.html',
            droplist_path: '/frame/droplist/getDropLists.action',
            polite_delay_sec: 0 },
      pages: {
        timetable: { tableId: '9001', menucode: 'M9001', preheat_path: '' },
        score: { tableId: '9002', menucode: 'M9002', preheat_path: '' },
        exam: { tableId: '9003', menucode: 'M9003', preheat_path: '' },
        free_room: { tableId: '9004', menucode: 'M9004', preheat_path: '' },
        profile: { tableId: '9005', menucode: 'M9005', preheat_path: '' },
      },
      column_map: { timetable: {}, score: {}, exam: {}, free_room: {}, profile: {} },
      unit_count: 12,
      semester: {}, free_room: { max_periods: null }, chaoxing: { fid: null },
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

async function main() {
  // 等 config.json 注入完成（loadCfg 是异步 IIFE）
  await new Promise((r) => setTimeout(r, 120));
  const sync = await handle('/api/sync', {});
  const fr = await handle('/api/free-rooms', {
    date: '2026-11-05', periodBegin: 1, periodEnd: 2,
  });
  const out = {
    ok: sync.ok,
    profile: sync.profile,
    semester: sync.semester,
    unitCount: sync.unitCount,
    totalWeeks: sync.totalWeeks,
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
