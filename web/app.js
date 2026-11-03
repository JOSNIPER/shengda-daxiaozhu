/* 郑航课表 · 手机端逻辑
   纯原生 JS，无框架、无构建步骤。
   数据来源：同源的本地服务（bridge.py），由它去登录教务系统。 */

'use strict';

// ------------------------------------------------------------------ 常量

/* 本地缓存键。
   zt.data / zt.settings 是课表那一套（早就有）；后面三个是「不需要强即时性」的数据，
   存本机是为了**打开软件就有东西看**，而不是每次都去问学校服务器。
   🔴 只有一卡通**余额**必须联网 —— 它随时会变，缓存下来的数字会骗人。
      消费记录、办事入口、公告都属于「几小时前的也一样有用」。 */
const KEY = {
  token: 'zt.token', data: 'zt.data', settings: 'zt.settings',
  card: 'zt.card', apps: 'zt.apps', notice: 'zt.notice',
};
const DAY_CN = ['一', '二', '三', '四', '五', '六', '日'];

/* 🔴 版本号只在这里写一次。
   以前「我的 → 版本」那行是 HTML 里写死的 0.1.0，安卓的 versionName 又写在
   build_apk.py 里，两处各写一遍，迟早会出现「软件里显示 0.1.0、装上去是 0.1.1」
   这种没法解释的事。现在 build_apk.py 和 version.json 都从这里读。
   code 是整数，只增不减：比版本号字符串靠谱（"0.10.0" < "0.9.0" 是字符串比较的经典坑）。 */
const APP_VERSION = '0.39.2';
const APP_CODE = 60;

/* 两套运行环境共用这一份界面：
     NATIVE=false  手机浏览器 + 电脑上的 bridge.py（凭据用 Windows DPAPI 存在电脑）
     NATIVE=true   APK 里（凭据用 Android Keystore 存在手机）
   凡是「存在哪台机器上」的说法都得跟着变 —— 在 APK 里写「存在这台电脑上」
   就是错的，会让人以为手机在偷偷连电脑。 */
const NATIVE = !!window.NativeApi;
const envText = (web, app) => (NATIVE ? app : web);

/* 默认作息：按常见高校排布填的，**不是从教务系统读的**（教务系统不给时间）。
   和实际不一样，在「我的 → 上课时间」里改，改完存本地。 */
// 🔴 郑航真实作息（2026-10-18 从 WakeUp 课表的左侧时间轴实测抄下来的）。
//    之前那套是按「常见作息」猜的，整体偏了：第 2→3 节、第 6→7 节之间是
//    20 分钟大课间（09:40→10:00、16:10→16:30），不是 10 分钟；
//    第 3 节是 10:00 而不是 09:55。别凭印象改，要改先对一遍课表。
const DEFAULT_TIMES = [
  ['08:00', '08:45'], ['08:55', '09:40'],
  ['10:00', '10:45'], ['10:55', '11:40'],
  ['14:30', '15:15'], ['15:25', '16:10'],
  ['16:30', '17:15'], ['17:25', '18:10'],
  ['19:30', '20:15'], ['20:25', '21:10'],
];

// 旧的默认作息。用户如果只是点过「保存」但没真改，localStorage 里存的是这一套，
// 光改 DEFAULT_TIMES 不会生效 —— 得认出来并替换掉。
const LEGACY_TIMES = [
  ['08:00', '08:45'], ['08:50', '09:35'],
  ['09:55', '10:40'], ['10:45', '11:30'],
  ['14:30', '15:15'], ['15:20', '16:05'],
  ['16:15', '17:00'], ['17:05', '17:50'],
  ['19:30', '20:15'], ['20:20', '21:05'],
];

// ------------------------------------------------------------------ 存储

const store = {
  get(k, dflt) {
    try { const v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); }
    catch (e) { return dflt; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

let TOKEN = (() => {
  const q = new URLSearchParams(location.search).get('k');
  if (q) { store.set(KEY.token, q); return q; }
  return store.get(KEY.token, '') || '';
})();

let DATA = store.get(KEY.data, null);
/* 本机有没有存住凭据。null = 还没问过（别急着提示用户）。
   和「有没有课表数据」是两回事：数据在、密码没存是真实存在的情况。 */
let BOUND = null;
/* 凭据的更细状态：'none' 从没存上 / 'ok' 存着且解得开 / 'broken' 存着但解不开。
   🔴 这三种要说三套话。「存着但解不开」说成「没保存」，用户会以为软件每次
      都在骗他 —— 明明输过、明明提示保存成功，下次又要重输。 */
let CRED_STATE = null;
/* 上一次保存失败的原因（'fail: xxx'），只为在界面上说清楚，不落盘。 */
let CRED_ERR = '';
/* 正在看的**历史学期**课表。null = 就渲染 DATA 里那份（教务系统的当前学期）。
 *
 * 2026-10-31 加。用户原话：「你这怎么切换不了学期」「给我自己绑定的大二学年」——
 * 之前课表只能看学校**此刻**认定的那个学期，想回头翻上学期的课只能等教务系统
 * 自己切。教务系统的课表表单本来就有 `semester.id`，传上学期的 id 就能取回来。
 *
 * 有值时形如 { id, semester, courses, unitCount, totalWeeks, weekStart }，
 * 字段和 DATA 里那几个**同名**，所以下面所有渲染只要读 `tt()` 就行。
 * ⚠️ 不落盘：翻历史学期是临时看一眼，下次打开 App 应该回到当前学期 ——
 *    否则用户过几天打开，看到的是一张旧课表，会以为这学期没课。
 * 🔴 也**不改 DATA**：DATA 是同步下来的整份数据（成绩、考试、培养计划都在里面），
 *    拿历史学期的课表覆盖它，会连带把「这学期在读学分」之类的统计算错。 */
let TT = null;
/* 正在取某个学期的课表。取数期间禁止再点 —— 学校服务器有「别点太快」的守卫。 */
let ttLoading = false;
/* 现在渲染用的那份课表。历史学期用 TT，否则用同步下来的 DATA。
 *
 * 🔴 名字不能叫 `tt` —— 这个文件里有十几处 `const tt = times()`
 *    （作息表），全局访问器跟它们撞名时，指向的是**那个局部变量**：
 *    同一个函数里先 `curTT().unitCount` 再 `const tt = times()` 更是直接
 *    TDZ 抛错，整张课表画不出来，控制台只有一句
 *    "Cannot access 'tt' before initialization"。 */
const curTT = () => TT || DATA || {};
/* 看的是不是当前学期。历史学期不能说「今天」「本周」——
   那学期早结束了，日期和今天对不上，说「今天第 3 周」是错的。 */
const ttIsNow = () => !TT;
/* 考试页选中的学期 id。'' = 教务系统默认的那个（当前学期）。 */
let examTerm = '';
/* 正在取某一学期的考试。取数期间界面显示「正在取…」，别让人以为没数据。 */
let examLoading = false;
/* 正在取的是哪个学期。用户可能在取数期间又点了别的 chip —— 只有
   「正在取的」和「选中的」是同一个学期时才算 loading，否则那一格会
   一直转圈（其实根本没在取它）。 */
let examLoadingSid = '';
/* 取数期间又被点了的学期，等这一次结束再补取。 */
let examPending = '';
/* 某一学期取失败的原因（sid → 原文）。只在内存里：下次进来重新试，
   不把一次网络抽风钉死成「这学期没有考试」。 */
const EXAM_ERR = {};
/* 上一次 renderExams 画出来的那批（按显示顺序）。点「加进日历」时按 data-i
   回查是哪一场 —— 不能按课程名找，同一门课可能既有结课考又有期末考。 */
let examItems = [];
/** 考试页「已考完」那段是不是展开着。
 *  不落盘：这是个临时看法，下次进来重新按「只看接下来考什么」开始。 */
let examPastOpen = false;
/* 整份同步是否正在进行。四个入口共用一个开关，防止连点变成两次登录。 */
let syncing = false;
/* 后台「把其他学期的考试也提前拉一遍」的进度。
   prefetchTok 是轮次号：换账号、重新同步都会 ++，正在跑的那一轮自己退出。 */
let prefetching = false;
let prefetchTotal = 0;
let prefetchDone = 0;
let prefetchTok = 0;
let CFG = Object.assign(
  { startDate: '', week: 0, view: 'week', cursor: '', times: null, hidden: [],
    // 上一次「打开/画课表」是哪一天（YYYY-MM-DD）。
    // 🔴 week / cursor 都存本机，而它们只在**当天**有意义 —— 见 syncToday()。
    seenDay: '',
    // 余额提醒：默认开着、阈值 20 元。一卡通刷完才发现没钱是最常见的懊恼，
    // 而这条提示是**常驻行内提示**，不弹窗 —— 弹窗会被点掉，行内的一直在。
    alertOn: true, alertLow: 20,
    // 检查更新：默认开着，默认**每天查一次**（一次请求，几百字节）。
    // 为什么不是「每次打开」：一天开十次 App 就查十次，而一天之内
    // 根本不会有新版本 —— 纯属白耗流量。想更勤可以在设置里改成「每次打开」。
    updOn: true, updFreq: 'daily', updLast: 0, updSkip: '' },
  store.get(KEY.settings, {})
);

// 认旧的默认作息：等于 LEGACY_TIMES 就说明用户没真改过，直接换成新的。
// （只要有一条不一样就尊重用户的选择，不覆盖）
if (CFG.times && CFG.times.length === LEGACY_TIMES.length &&
    CFG.times.every((r, i) => r && r[0] === LEGACY_TIMES[i][0] && r[1] === LEGACY_TIMES[i][1])) {
  CFG.times = null;
}

// ------------------------------------------------------------------ 工具

const $ = (id) => document.getElementById(id);
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

function toast(msg, ms) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms || 2000);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function api(path, body) {
  // APK 里没有电脑上的 bridge.py（手机连不到电脑的 127.0.0.1），
  // 改由 App 内置的原生桥 + 本地解析顶上；两条路径返回的 JSON 契约完全一样。
  if (NATIVE) return window.NativeApi.handle(path, body || {});

  const opt = { method: body ? 'POST' : 'GET', headers: { 'X-Token': TOKEN } };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  if (r.status === 403) throw new Error('访问凭证不对，重新扫一下电脑启动窗口里的二维码');
  return r.json();
}

const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
/* 两种日期写法，别混用：
   `mdDot`   → 10.12   周条副标题里用（比「10月12日」短，一行放得下）
   `mdSlash` → 10/12   日头里用（和大部分课表 App 一致，一眼认得出是日期） */
const mdDot = (d) => (d.getMonth() + 1) + '.' + pad2(d.getDate());
const mdSlash = (d) => (d.getMonth() + 1) + '/' + pad2(d.getDate());
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
const today0 = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(x, -((x.getDay() + 6) % 7));
}

// 往「后」找最近的周一。
function mondayAfter(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (x.getDay() + 6) % 7;
  return addDays(x, back === 0 ? 0 : 7 - back);
}

// 学期的「最早可能开学日」：秋季从 9/1 起，春季从 2/20 起。
// 学期号兼容「第 1 学期」和「第一学期」两种写法——教务系统的措辞会变，
// 认不出来就会掉进「拿今天当第 1 周」的兜底，整张表悄悄错位。
function semesterBase(semester) {
  // ⚠️ `第` 必须可选。教务系统两种写法都出现过：
  //     课表页学期名  `2026-2027 学年第 1 学期`
  //     考试页学期下拉 `2026-2027学年1学期`
  //    只认带「第」的那种，用下拉里那串名字算开学日就会解析失败、退化成
  //    「今天所在的周一」—— 而 2026-10-31 的学期切换正好把下拉的名字
  //    写进了课表学期名，历史学期整张表会因此错位好几个月。
  //    termParts() 早就把「第」当可选了，这两处必须同时放宽。
  const m = /(\d{4})-(\d{4})\s*学年\s*第?\s*([12一二])\s*学期/.exec(semester || '');
  if (!m) return null;
  const term = m[3] === '一' ? 1 : m[3] === '二' ? 2 : Number(m[3]);
  const y1 = Number(m[1]);
  return term === 1 ? new Date(y1, 8, 1) : new Date(y1 + 1, 1, 20);
}

function defaultStart(semester) {
  const base = semesterBase(semester);
  if (!base) return mondayOf(today0());
  // 🔴 这里必须往「后」找周一，不能往「前」。
  //    2026-09-01 是周二，往前找会得到 8/31，于是整学期周次多算一周
  //    （用户 2026-10-18 的 WakeUp 截图是第 6 周，按 8/31 会算成第 7 周）。
  //    学期不可能在 9/1 之前开学，所以「9/1 之后最近的周一」= 9/7 才对。
  return mondayAfter(base);
}

// 旧版本用 mondayOf(base) 当默认值，会算出比真实开学早一周的日期。
// 已存进 localStorage 的旧默认值要迁移掉，否则老用户永远差一周。
// 判据：存的正好等于「旧算法对当前学期算出的值」才改——用户自己挑的日期不碰。
function migrateStartDate(semester) {
  const base = semesterBase(semester);
  if (!base || !CFG.startDate) return false;
  const oldDefault = ymd(mondayOf(base));
  const newDefault = ymd(mondayAfter(base));
  if (oldDefault !== newDefault && CFG.startDate === oldDefault) {
    CFG.startDate = newDefault;
    return true;
  }
  return false;
}

/** 这一学期第 1 周的周一。
 *
 *  🔴 历史学期**不能**用 CFG.startDate：那是当前学期（用户可能自己调过）的
 *     开学日，套到去年那个学期上，整张表的日期会偏出好几个月。
 *     历史学期没有存过校历，只能按学期名推算 —— 比真实开学日可能差一两天，
 *     但周次条、日期范围、课程格子之间的关系是自洽的。
 */
const startDate = () => {
  if (TT) return defaultStart(TT.semester);
  return CFG.startDate ? parseYmd(CFG.startDate) : defaultStart(DATA && DATA.semester);
};

/** 学期总周数。
 *
 *  默认取教务系统给的（`marshalTable` 的 endWeek，实测 24），但允许用户
 *  在「学期设置」里改：学校临时调校历、或者哪天接口取不到这个数，
 *  得有个地方能自己填 —— 否则整学期的周次条就只有一半。
 *  `CFG.weeks` 为空 / 0 / 越界都当「没设置」，退回数据里的值。
 *
 *  ⚠️ 历史学期**只认教务给的那个数**，不看 CFG.weeks —— 那个值是给当前学期
 *     调的（比如「我们这学期只有 16 周」），套到别的学期上会把周次条截断。
 */
const totalWeeks = () => {
  if (TT) return Math.max(1, Math.floor(Number(TT.totalWeeks)) || 20);
  const n = Math.floor(Number(CFG.weeks));
  if (n >= 1 && n <= 60) return n;
  return (DATA && DATA.totalWeeks) || 20;
};

/** 学期名。历史学期用它自己的名字，当前学期用教务原文（用户改过就用用户改的）。 */
const semesterName = () => {
  if (TT) return TT.semester || '';
  return CFG.semester || (DATA && DATA.semester) || '';
};

// ------------------------------------------------------------------ 大几上/下

/** 入学年份（四位）。全部来自教务处给的学籍信息，不靠猜。
 *
 *  优先级：年级（原文「2025」）→ 入校时间 → 班级名（「25计科1班」）→ 学号前两位。
 *  四个来源任意一个能对上就够用；都对不上返回 0，界面退回显示学期原文。
 */
function enrolledYear() {
  const p = (DATA && DATA.profile) || {};
  const ok = (y) => (y >= 1900 && y <= 2100 && y <= new Date().getFullYear() + 1);
  let y = parseInt(p.grade, 10);
  if (ok(y)) return y;
  let m = /^(\d{4})/.exec(String(p.enrolledAt || ''));
  if (m) { y = parseInt(m[1], 10); if (ok(y)) return y; }
  // 班级名 / 学号里的两位年份：「25计科1班」「2512345678」⇒ 2025
  m = /^(\d{2})/.exec(String(p.className || '')) || /^(\d{2})/.exec(String(p.studentId || ''));
  if (m) { y = 2000 + parseInt(m[1], 10); if (ok(y)) return y; }
  return 0;
}

/** 学期名里的「学年起始年 + 第几学期」。认不出来返回 null。
 *
 *  教务系统两处写法不一样，都得认：
 *    考试页下拉   `2026-2027学年1学期`
 *    课表页学期名 `2026-2027 学年第 1 学期`
 */
function termParts(name) {
  const m = /(\d{4})\s*-\s*(\d{4})\s*学年\s*第?\s*([12一二])\s*学期/.exec(String(name || ''));
  if (!m) return null;
  return { y: Number(m[1]), s: (m[3] === '一' || m[3] === '1') ? 1 : 2 };
}

/** 学期名里的「学年起始年 + 第几学期」。学期名认不出来就按今天推。 */
function academicTerm(semester) {
  const a = termParts(semester);
  if (a) return a;
  // 退路：9 月开学算第一学期；1 月还属于上一学年的第一学期
  const t = today0();
  const mo = t.getMonth() + 1;
  if (mo >= 9) return { y: t.getFullYear(), s: 1 };
  if (mo >= 2) return { y: t.getFullYear() - 1, s: 2 };
  return { y: t.getFullYear() - 1, s: 1 };
}

/** 「大二上」这种说法。
 *
 *  为什么不直接显示「2026-2027 学年第 1 学期」：
 *  那是学校内部的编号，学生说自己从来不说这个 —— 他只说「我大二上」。
 *
 *  算法（三个数就能定，全部来自教务处，不猜）：
 *    入学年   年级 2025（或 入校时间 / 班级名 / 学号）
 *    学年     2026-2027 学年第 1 学期 ⇒ 起始年 2026、第 1 学期
 *    学期序号 = (起始年 − 入学年) × 2 + (第几学期 − 1)
 *    大几     = 序号 ÷ 2 + 1，序号奇偶决定上/下
 *  实测：2026 − 2025 = 1 ⇒ 序号 2 ⇒ 大二上，和他自己的说法一致。
 *
 *  🔴 算不出来、或者算出来的年级比学制还高（延期毕业 / 数据对不上）
 *     就返回空串，界面退回显示学期原文。宁可拗口，也不能瞎编一个「大七上」。
 */
function gradeLabel() {
  const a = academicTerm(semesterName());
  return gradeName(a.y, a.s);
}

/** 学期短名，只给界面用：「大二上」，算不出来才退回教务原文。
 *
 *  课表副标题和选学期的 chip 都用它 —— 学生认「大二上」，
 *  不认「2024-2025 学年第 1 学期」（那是学校内部编号）。
 *  和 gradeLabel 的区别：那个说的是**当前学期**，这个可以传任意学期名。
 */
function termShort(name) {
  const a = termParts(name);
  const g = a ? gradeName(a.y, a.s) : '';
  return g || String(name || '').replace(/\s+/g, ' ');
}

/** 给定「学年起始年 + 第几学期」，算「大二上」。
 *
 *  抽出来是因为**成绩页的学期筛选**也要用同一套说法：
 *  那里的学期来自成绩表（2025-2026 / 1），和当前学期不是一回事。
 */
function gradeName(startYear, term) {
  const y0 = enrolledYear();
  if (!y0 || !startYear || !term) return '';
  const idx = (startYear - y0) * 2 + (term - 1);
  if (idx < 0) return '';
  const n = Math.floor(idx / 2) + 1;
  const dur = parseInt((DATA && DATA.profile && DATA.profile.duration) || '4', 10) || 4;
  if (n > dur + 1) return '';                 // 多留一年给延期毕业，再多就是数据不对
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八'];
  if (n > CN.length) return '';
  return '大' + CN[n - 1] + (idx % 2 ? '下' : '上');
}

/** "2025-09-01" → "2025.09"。学籍里的日期都带日，学生只关心年月。
 *  认不出来就返回空串 —— 让调用方把整行收起来，而不是摆一个 "2025-09-01" 占着。 */
function ymDot(s) {
  const m = /^(\d{4})-(\d{1,2})/.exec(String(s == null ? '' : s).trim());
  return m ? m[1] + '.' + ('0' + m[2]).slice(-2) : '';
}

function weekOf(date) {
  const diff = Math.round((today0() && new Date(date.getFullYear(), date.getMonth(), date.getDate()) - startDate()) / 86400000);
  return Math.floor(diff / 7) + 1;
}
function currentWeek() {
  // 历史学期没有「本周」：那学期早就结束了，按今天算会得到第 60 多周。
  // 界面上默认落在第 1 周，用户自己翻。
  if (TT) return 1;
  const w = weekOf(new Date());
  return Math.min(Math.max(w, 1), Math.max(totalWeeks(), 1));
}

function times() {
  const n = (DATA && curTT().unitCount) || 10;
  const t = (CFG.times && CFG.times.length) ? CFG.times : DEFAULT_TIMES;
  const out = [];
  for (let i = 0; i < n; i++) out.push(t[i] || ['', '']);
  return out;
}

/** `08:45` → 525（当天第几分钟）。认不出返回 **null**，不是 0。
 *
 *  ⚠️ 别往「0 点」兜底：那样 `nowMin >= 0` 恒成立，
 *     一节没配时间的课会永远显示成「正在上」。宁可不算。
 *  周视图高亮、日视图高亮、「下一节」提示三处共用这一个。 */
function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 此刻是第几分钟。单独抽出来，测试里好固定时钟。 */
function nowMinute() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

/** 第 p 节到第 q-1 节这一整段（跨两节的大课算一块），此刻是不是正在上。
 *  头一节的开始 ~ 最后一节的结束。中间那个 10 分钟课间也算「在上」——
 *  学生这会儿还在那间教室，灯不该灭。 */
function liveAt(tt, p, q, nowMin) {
  const s = hhmmToMin(tt[p] && tt[p][0]);
  const e = hhmmToMin(tt[q - 1] && tt[q - 1][1]);
  if (s === null || e === null) return false;
  return nowMin >= s && nowMin <= e;
}

function weeksText(weeks) {
  if (!weeks || !weeks.length) return '—';
  const a = weeks.slice().sort((x, y) => x - y);
  const parts = [];
  let s = a[0], p = a[0];
  for (let i = 1; i < a.length; i++) {
    if (a[i] === p + 1) { p = a[i]; continue; }
    parts.push(s === p ? '' + s : s + '-' + p);
    s = p = a[i];
  }
  parts.push(s === p ? '' + s : s + '-' + p);
  return parts.join('、') + ' 周';
}

function periodsText(periods) {
  if (!periods.length) return '—';
  const a = periods.slice().sort((x, y) => x - y);
  const parts = [];
  let s = a[0], p = a[0];
  for (let i = 1; i < a.length; i++) {
    if (a[i] === p + 1) { p = a[i]; continue; }
    parts.push(s === p ? '第' + (s + 1) + '节' : '第' + (s + 1) + '-' + (p + 1) + '节');
    s = p = a[i];
  }
  parts.push(s === p ? '第' + (s + 1) + '节' : '第' + (s + 1) + '-' + (p + 1) + '节');
  return parts.join('、');
}

function colorSlot(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 8;
}

/** 把 room 拆成「楼栋 / 房间号」两段，**所有教室都返回**。
 *
 *  教务系统给的是 `01B104`、`02A201` 这种连写。列宽只有 44~50px，
 *  一整串挤一行必然被截断 —— 而房间号恰恰是学生最需要看到的信息。
 *  拆成两段（`@01B 104`）后，两段各自都能完整显示，和 WakeUp 的排法一致。
 *
 *  🔴 **一门课可能给两个教室**：`02B506(D机房),02B505(C机房)`。
 *     两个都是上课地点（比如分机房上课），以前只取第一个 ——
 *     用户 2026-10-19 直接指出来了：「显示了两个教室，只显示了一个」。
 *     现在按逗号拆开、每间一行，全画出来。
 *
 *  括号里是场地类型（`(电工技术实验室)`），找教室用不上，而且一行放不下；
 *  格子里去掉，**完整原文仍在课程详情面板里**。
 *  拆不出来就原样返回（比如「东区操场8」这种没有楼栋编码的）。
 */
function roomList(room) {
  return String(room || '')
    .split(/[,，、;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // 括号可能是全角也可能是半角，偶尔还多一个右括号（`…实验室）)`）
      let clean = s.replace(/[（(][^）)]*[）)]+/g, '').trim();
      clean = clean.replace(/[）)]+$/, '').trim() || s;
      const m = /^(\d{2}[A-Za-z]?)(.+)$/.exec(clean);
      return m ? m[1] + ' ' + m[2].trim() : clean;
    });
}

/** 日视图 / 详情里用的完整教室串：多个教室用 `·` 隔开，括号里的场地类型保留。
 *  日视图一行有 300px 宽，放得下；周视图格子里放不下（见 roomList）。 */
function roomFull(room) {
  return String(room || '')
    .split(/[,，、;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' · ');
}

/** 单/双周判定。
 *
 *  教务系统给的是「逐周精确列表」，所以 [1,3,5,7] 就是隔周上课。
 *  判据：至少 2 周、相邻差全是 2。差不是 2 就是连续周或者有跳跃，
 *  那种情况宁可**不标**也不猜（标错了比不标更坑）。
 *  返回 'odd' / 'even' / ''。
 */
function parityOf(weeks) {
  if (!weeks || weeks.length < 2) return '';
  // 🔴 判据是「所有周次奇偶性一致」，不是「相邻差恒为 2」。
  //    大学英语I（三）周三实测周次 [2,4,6,8,10,12,16,18]——第 14 周停课，
  //    12→16 差 4，用「相邻差 == 2」就判不出双周，角标直接丢掉。
  //    （2026-10-18 跟用户 WakeUp 截图逐格对比时发现。）
  const odd = weeks.filter((w) => w % 2 === 1).length;
  if (odd === 0) return 'even';
  if (odd === weeks.length) return 'odd';
  return '';
}

/** 某周某天的课：day -> period -> [course] */
function occupancy(week) {
  const map = {};
  const hid = hiddenSet();
  (curTT().courses || []).forEach((c) => {
    if (hid.has(c.code)) return;               // 用户隐藏掉的课不画
    if (c.weeks.indexOf(week) < 0) return;
    c.slots.forEach((s) => {
      const k = s.day + ':' + s.period;
      (map[k] = map[k] || []).push(c);
    });
  });
  return map;
}

/* ---------------- 隐藏课程 ----------------
 * 为什么需要：教务系统的数据里会有「你实际上不上的课」——实测郑航 2026 秋季
 * 就有一门「高等数学Ⅰ(二)」，四个时段**全部**和别的课撞车，而学生实际课表里没有它。
 * 这种脏数据没法靠规则自动判（撞课也可能是真的调课），只能让用户自己点一下藏起来。
 * 键用 course.code：同一门课的多个时段/多个教室共用一个 code，一次隐藏全干净。
 */
function hiddenSet() {
  return new Set(CFG.hidden || []);
}

function setHidden(code, hide) {
  const s = hiddenSet();
  if (hide) s.add(code); else s.delete(code);
  CFG.hidden = Array.from(s);
  store.set(KEY.settings, CFG);
  renderSchedule(); renderMe();
}

/** code -> 课程（同 code 可能有多条记录，取第一条够用） */
function courseByCode(code) {
  return (curTT().courses || []).find((c) => c.code === code) || null;
}

/** 这周一共几门课（按课程代码去重，不是按格子数）。
 *  放副标题里是为了让人一眼判断「这一周是不是我要找的那周」——
 *  光看「第 6 周」记不住，但「21 门课」能对上感觉。 */
function weekCourseCount(occ) {
  const s = new Set();
  Object.keys(occ).forEach((k) => occ[k].forEach((c) => s.add(c.code || c.name)));
  return s.size;
}

/** 这一屏显示哪几天（0 = 周一）。
 *
 *  🔴 **固定 7 列：周一到周日全显示**（2026-10-19 改回来的）。
 *
 *  上一版为了给工作日多挤点宽度，周末「整学期有课才显示那一列」。
 *  用户当天就反馈：「为什么没有周日了？很多人周日也有课」。
 *  这个规则有两个毛病：
 *    1. 没课的那天整列消失，用户分不清是「真的没课」还是「软件不支持周日」——
 *       看不见的东西没法被信任。
 *    2. 列数跟着数据变，两个人截同一周的图对不上，翻周时还容易看错列。
 *  宽度是紧了点（7 列比 6 列每列窄约 1/7），但「看得见」比「宽 7 像素」重要。
 *  挤的问题用别的办法补：留白压到 7px、节次栏 30px、字号按三档走（见 CSS）。
 *
 *  ⚠️ 返回值仍是「真实星期几」的数组，不是列号 —— 以后要是再想隐藏某天，
 *     记得 `cols[ci]` 才是星期几，`ci` 只是第几列。
 */
function visibleDays() {
  return [0, 1, 2, 3, 4, 5, 6];
}

// ------------------------------------------------------------------ 切换页

/* 🔴 底部**固定 5 个**，别再往上加。
   2026-10-21 用户提的：主流 App 底部最多 5 个，我们一度挤到 6 个。

   `calendar` / `rooms` 不是 tab，是**从课表页进去的子页**：
   底部继续亮着「课表」—— 校历和空教室本来就是「同一时间维度的另一面」，
   放在课表底下比单独占一个位置更顺。 */
/* 底部 5 格（0.27.0 起）：课表 / 学习 / WIKI / 功能 / 我的。
   中间那格原来是「公告」，用户 2026-10-30 要求换成 WIKI —— 公告是低频内容，
   并进了「功能」页；攻略是新生天天翻的。 */
const TABS = ['schedule', 'exams', 'wiki', 'campus', 'me'];
const SUBPAGES = ['calendar', 'rooms', 'accounts', 'notice'];
/* 子页是从哪个 tab 进去的 —— 返回时回那里，底部也要高亮那一个。
   原来只有校历/空教室两个、都挂在课表下，所以写死成 'schedule'；
   0.14.0 的「账号管理」是从「我的」进去的，再写死就会高亮错 tab。 */
const SUB_PARENT = { calendar: 'schedule', rooms: 'schedule',
                      accounts: 'me', notice: 'campus' };

/* 当前真正在显示哪一页。
   🔴 不能拿 `.tab.active` 反推：子页亮的是「课表」，在空教室页按返回
      会以为自己在课表、直接退出 App（这就是为什么要有这个变量）。 */
let CUR_PAGE = 'schedule';

function switchTab(name) {
  TABS.concat(SUBPAGES).forEach((t) => {
    const el = $('page-' + t);
    if (el) el.hidden = (t !== name);
  });
  CUR_PAGE = name;
  // 接水轮询只在「功能」页看得见的时候跑。换到别的 tab 就停 ——
  // 不停的话它会在后台每 10 秒打一次服务器，最长打 10 分钟。
  if (name !== 'campus') wtLiveStopPoll();
  const hl = SUB_PARENT[name] || name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === hl));
  if (name === 'exams') { renderExamView(); renderExams(); renderGrades(); cxEnter(); }
  if (name === 'me') renderMe();
  if (name === 'accounts') renderAccounts();
  if (name === 'wiki') renderWikiPage();
  // 功能：直饮水是这一页的主体，先画本机缓存再探一次网（见 renderWater）
  if (name === 'campus') { renderCampus(); renderWater(); }
  // 校历纯本地计算，没有网络，每次进来重画一遍就行（跨零点后周次会变）
  if (name === 'calendar') renderCalendar();
  // 公告：本机有就先画，再按新鲜度决定要不要后台刷。
  // （以前是「第一次进来才抓」，等于每次都从空白页开始等 6 个学校站点。）
  if (name === 'notice') enterNotice();
  if (name === 'rooms') {
    renderRooms();
    // 第一次进这一页就直接查一遍：用户点「空教室」就是想看结果，
    // 再让他点一次「查询」属于白等。整个 App 生命周期只自动查这一次，
    // 之后切来切去不再打学校服务器（空教室数据也不会几秒钟就变）。
    if (DATA && !ROOM.autoTried) {
      ROOM.autoTried = true;
      queryRooms().then(() => { loadRoomOptions(); });
    }
  }
  // 课表页重新可见时补量一次：隐藏状态下量不出宽度，两间教室的字号没法缩
  if (name === 'schedule') { fitRoomLines($('wkTrack')); fitRoomLines($('dayView')); }
}
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

/* 切到后台就停接水轮询，切回来接着盯。
 * 🔴 不这么做的话，手机锁屏后那条 10 分钟里还在每 10 秒发一次请求 ——
 *    安卓会把这种「后台偷偷联网」当耗电，而且它查的账单本来也没人看。
 * ⚠️ 回到前台要**重新起**：定时器在隐藏时已经清掉了，不重起就永远不查了
 *    （「切回来还是显示正在出水」就是这个坑的形状）。 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { wtLiveStopPoll(); return; }
  if (CUR_PAGE === 'campus' && WT.live) wtLiveStartPoll();
  // 0.39.0：从后台切回「学习」页也顺手查一次（同样受 CX_AUTO_SEC 挡着）。
  // 用户最常做的动作就是「课间切回来看一眼新作业」，这正是最该是最新的时刻。
  if (CUR_PAGE === 'exams') cxAutoScan();
});

// ------------------------------------------------------------------ 公告

/* 数据来自学校 6 个部门的**公开网页**（校级 / 教务处×2 / 团委 / 后勤 / 信息中心），
 * 不需要登录 —— 所以这一页是整个 App 里唯一「没绑教务账号也能用」的栏目。
 *
 * 🔴 列表和详情分成两个接口，这是有意的：
 *    /api/notice         一次抓 6 个列表页 → 标题 / 日期 / 来源 / 分类
 *    /api/notice/detail  才去抓某一篇的正文 → 从里面抠「时间 / 地点」
 *    合成一个接口的话，一进页面就得抓 60 篇正文，慢，而且把学校服务器打疼。
 *
 * 但只有标题的话，这页跟直接看学校官网没区别 —— 用户要的是
 * 「什么时候、在哪儿、有没有餐券」，那三样只在正文里。
 * 所以列表画完之后**异步**给最上面几条补详情，补到一条就更新一张卡：
 * 用户不用等，也不会盯着一屏「正在加载」。
 */

const NT_TIERS = [
  ['all', '全部'],
  ['impact', '影响出行'],
  ['action', '要办事'],
  ['activity', '活动'],
  ['other', '其他'],
];

const NT = {
  tried: false,     // 抓过一次没有（不管成没成）
  loading: false,
  err: '',
  at: 0,            // 服务端取数的 unix 秒
  total: 0,         // 过滤前的总条数（用来算「76 条里显示最近 60 条」）
  sources: 0,       // 这次成功取到几个源
  failed: [],       // [{source, status, count}] —— 必须往界面上报，不能安静地少一块
  all: [],          // 全部条目，服务端已按日期倒序
  tier: 'all',      // 当前筛选
  fromCache: false, // 这批是不是从本机读出来的（决定要不要顺手刷一次）
};

/* url → {ok, when, where, summary} 或 {ok:false, error}。
   undefined = 还没取过；有对象 = 取过了（成功失败都算，失败的不再重试）。 */
const NT_DETAIL = {};
/* 正在取的（防止同一条被两个 worker 同时抓）。 */
const NT_BUSY = {};
/* 详情弹层当前是哪一篇。数据晚到时要靠它判断「要不要重画」。 */
let ntSheetUrl = '';

/** 属性值转义。`esc()` 不转引号，直接塞进 data-url="" 会把属性截断。 */
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 今年的省掉年份（「10-20」），往年的带上（「2025-12」）。
 *  学校通知绝大多数是近两个月的，每条都写「2026-」纯属占地方。 */
function ntDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return String(s || '');
  return m[1] === String(new Date().getFullYear()) ? m[2] + '-' + m[3] : m[1] + '-' + m[2];
}

function ntStamp(sec) {
  const d = new Date(sec * 1000);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
         pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 「3 小时前」这种说法。
 *  缓存数据的界面必须用它 —— 「10-21 12:03」要人自己算差多久，
 *  而「1 天前」一眼就知道该不该刷新。 */
function agoText(sec) {
  if (!sec) return '';
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
  return ntStamp(sec);
}

function ntTierClass(tier) {
  return tier === 'impact' ? 't-impact'
       : tier === 'action' ? 't-action'
       : tier === 'activity' ? 't-activity' : 't-other';
}

function ntFiltered() {
  return NT.tier === 'all' ? NT.all : NT.all.filter((x) => x.tier === NT.tier);
}

/** 一张卡。**详情没到就只画标题** —— 不写「时间：无」，
 *  「没读到」和「没有」是两件事，写成一样等于把错误说成事实。 */
function ntCardHtml(it) {
  const d = NT_DETAIL[it.url];
  const tag = (it.tags && it.tags[0])
    ? '<span class="nt-tag ' + ntTierClass(it.tier) + '">' + esc(it.tags[0]) + '</span>'
    : '';
  let extra = '';
  if (d && d.ok && (d.when || d.where)) {
    extra = '<div class="nt-extra">' +
      (d.when ? '<div class="nt-kv"><span class="k">时间</span><span class="v">' +
                esc(d.when) + '</span></div>' : '') +
      (d.where ? '<div class="nt-kv"><span class="k">地点</span><span class="v">' +
                 esc(d.where) + '</span></div>' : '') +
      '</div>';
  }
  return '<div class="ntitem" data-url="' + escAttr(it.url) + '">' +
    '<div class="nt-title">' + esc(it.title) + '</div>' +
    '<div class="nt-meta">' + tag +
      '<span class="nt-dept">' + esc(it.dept || it.source || '') + '</span>' +
      '<span class="nt-date">' + esc(ntDate(it.date)) + '</span>' +
    '</div>' + extra +
  '</div>';
}

function ntPaintState() {
  const has = NT.all.length > 0;
  const f = NT.failed || [];
  $('ntLoading').hidden = !NT.loading;
  $('ntChips').hidden = !has;
  $('ntSum').hidden = !has;
  $('ntList').hidden = !has;

  // 「一条都没有」和「取失败」要分开说：前者可能真的没通知，
  // 后者是我们没拿到。混成一句「暂无数据」等于把故障说成事实。
  const dead = !NT.loading && NT.tried && !has;
  $('ntEmpty').hidden = !dead;
  if (dead) {
    $('ntEmptyTitle').textContent = NT.err ? '没取到公告' : '这次一条都没取到';
    $('ntEmptyText').textContent = NT.err ||
      '可能是学校网站临时出问题，过一会儿再试。';
  }

  // 有内容但有源失败 / 刷新失败：黄色提示条。两种情形说两句不同的话。
  let warn = '';
  if (has && NT.err) warn = '刷新没成功（' + NT.err + '），下面是上一次取到的内容。';
  else if (has && f.length) {
    warn = '有 ' + f.length + ' 个来源没取到（' +
      f.map((x) => x.source).join('、') + '），下面的内容可能不全。';
  }
  $('ntWarn').hidden = !warn;
  if (warn) $('ntWarn').textContent = warn;
}

function renderNotice() {
  const all = NT.all;
  const cnt = { all: all.length };
  NT_TIERS.forEach((t) => { if (t[0] !== 'all') cnt[t[0]] = all.filter((x) => x.tier === t[0]).length; });

  // 分类 chip 上带条数：一眼能看出「影响出行」只有两三条、
  // 「要办事」二十几条 —— 这就是回答「公告太杂」最直接的办法，
  // 不用写一段说明文字去解释。
  $('ntChips').innerHTML = NT_TIERS.map((t) =>
    '<button class="chip' + (NT.tier === t[0] ? ' on' : '') + '" data-tier="' + t[0] + '">' +
    esc(t[1]) + (cnt[t[0]] ? '<i class="ntc">' + cnt[t[0]] + '</i>' : '') + '</button>'
  ).join('');

  $('ntSum').textContent = NT.sources + ' 个来源 · ' + NT.total + ' 条' +
    (all.length < NT.total ? '（显示最近 ' + all.length + ' 条）' : '') +
    (NT.at ? ' · ' + ntStamp(NT.at) + ' 更新' : '');

  const list = ntFiltered();
  $('ntList').innerHTML = list.map((it) => ntCardHtml(it)).join('');
  $('ntFoot').hidden = !list.length;
  if (list.length) {
    $('ntFoot').textContent = '内容摘自学校各部门网站，以原文为准。';
  }
  ntPaintState();
  // 公告 tab 的红点（0.24.1）：用户说「公告也是[低频的]」——
  // 低频的东西不该靠一个常驻 tab 提醒人去点，而是**有新东西才亮**。
  // 只有正看着公告页的时候才算「看过了」；后台刷到新公告照样亮着。
  ntMarkSeen();
  // 只在**公告页正显示着**的时候才去补正文。
  // 以前是无条件补：开机后台刷新一次就会顺手敲 8 个详情页 ——
  // 用户可能正在看课表，这 8 个请求纯属白打。
  if (CUR_PAGE === 'notice') ntPrefetchFor(list);
}

/* ---------------- 公告的本地缓存 ----------------
 *
 * 为什么要缓存：公告是 6 个学校部门站点串起来抓的，冷启动要两三秒。
 * 用户的原话是「点打开软件自动更新公告」—— 所以顺序必须是
 * **先拿本机这份画出来（立刻有内容），再去后台刷**，
 * 而不是让他对着空白页等 6 个站点。
 *
 * 只存列表，不存正文：正文（NT_DETAIL）是几十 KB 的解析结果，
 * 而且列表里最上面几条一进来就会重新补，存了也是白存。
 */
const NT_CACHE_MAX = 80;

function ntCacheSave() {
  try {
    store.set(KEY.notice, {
      at: NT.at, total: NT.total, sources: NT.sources,
      // 裁一下：公告一直累积，不裁的话 localStorage 会被慢慢撑爆
      all: NT.all.slice(0, NT_CACHE_MAX),
    });
  } catch (e) { /* 存不下就算了，不能因为缓存失败把界面搞坏 */ }
}

/* ---- 公告「有新东西」的红点（0.24.1）--------------------------------
   🔴 只读本机缓存来判断，**不动 NT** —— 在这里调 ntCacheLoad() 会把
      NT.tried 置 true，于是 enterNotice 里「先画本机那份」那一支被跳过，
      用户点进公告页会对着空白等 6 个站点（正是以前修过的那个毛病）。
   「看过了」记的是**最新那条的身份**（url），不是时间：学校各站点的日期
   格式不统一，拿时间比大小迟早比错，比身份则只要「是不是同一条」就够。 */
const NT_SEEN_KEY = 'nt.seen';

function ntNewestId(all) {
  const it = Array.isArray(all) && all[0];
  if (!it) return '';
  return String(it.url || it.title || '');
}

function ntPaintDot() {
  const dot = $('ntDot');
  if (!dot) return;
  const c = store.get(KEY.notice, null);
  if (!c || !Array.isArray(c.all) || !c.all.length) { dot.hidden = true; return; }
  const id = ntNewestId(c.all);
  dot.hidden = !id || id === store.get(NT_SEEN_KEY, '');
}

/** 「这一屏的公告我看过了」。只在这一页正显示时才算。
 *  🔴 必须同时被 renderNotice **和** enterNotice 调到：
 *     NT.tried 一旦为 true，再进这一页 renderNotice 就不会跑了
 *     （`if (!NT.tried && ntCacheLoad())`），只在 renderNotice 里记的话
 *     「第二次进来」永远不记，红点就再也不灭。 */
function ntMarkSeen() {
  if (CUR_PAGE !== 'notice' || !NT.all.length) return;
  store.set(NT_SEEN_KEY, ntNewestId(NT.all));
  ntPaintDot();
}

/** 从本机读回来。有内容返回 true。
 *  🔴 读回来要标记 fromCache —— 界面得说清楚这是「上次看到的」，
 *     不能把旧数据伪装成刚刷新的。 */
function ntCacheLoad() {
  const c = store.get(KEY.notice, null);
  if (!c || !Array.isArray(c.all) || !c.all.length) return false;
  NT.all = c.all;
  NT.total = c.total == null ? c.all.length : c.total;
  NT.sources = c.sources == null ? 0 : c.sources;
  NT.at = c.at || 0;
  NT.tried = true;
  NT.fromCache = true;
  return true;
}

/** 进公告页 / 开机预热共用的一条路。
 *
 *  顺序很重要：**先画本机那份**（立刻有内容），再决定要不要刷。
 *  反过来就是用户对着空白页等 6 个站点 —— 那正是要改掉的体验。
 *
 *  `stale` 用 10 分钟：服务端自己还有 30 分钟 TTL，所以这里大多数时候
 *  连学校站点都不会碰，只是把本机缓存对齐一下时间戳。 */
function enterNotice() {
  if (!NT.tried && ntCacheLoad()) renderNotice();
  ntMarkSeen();      // 已经加载过的情况：renderNotice 不会再跑，这里补一刀
  if (NT.loading) return;
  const age = NT.at ? (Date.now() / 1000 - NT.at) : 1e9;
  if (!NT.tried || age > 10 * 60) loadNotice(false);
}

async function loadNotice(force) {
  if (NT.loading) return;
  NT.loading = true;
  NT.err = '';
  ntPaintState();
  try {
    const r = await api('/api/notice?limit=60' + (force ? '&force=1' : ''));
    if (!r || !r.ok) throw new Error((r && r.error) || '没取到数据');
    NT.all = r.items || [];
    NT.total = r.total == null ? NT.all.length : r.total;
    NT.sources = r.sources == null ? 0 : r.sources;
    NT.failed = r.failed || [];
    NT.at = r.at || 0;
    NT.tried = true;
    NT.fromCache = false;
    ntCacheSave();          // 刷成功才落盘：失败时保留上一次那份，别用空列表盖掉
    renderNotice();
  } catch (e) {
    // 🔴 刷新失败不能把已经拿到的列表清空 —— 那是把「这次没刷上」
    //    变成「什么都没有」，比不刷新更糟。
    NT.err = (e && e.message) || String(e);
    NT.tried = true;
  } finally {
    NT.loading = false;
    ntPaintState();
  }
}

/** 取一条的正文（时间 / 地点 / 摘要）。失败也记下来，不再重试。 */
async function ntLoadDetail(it) {
  if (!it || NT_BUSY[it.url] || NT_DETAIL[it.url]) return;
  NT_BUSY[it.url] = true;
  let d;
  try {
    d = await api('/api/notice/detail?u=' + encodeURIComponent(it.url));
    if (!d || !d.ok) d = { ok: false, error: (d && d.error) || '没读到正文' };
  } catch (e) {
    d = { ok: false, error: (e && e.message) || String(e) };
  }
  delete NT_BUSY[it.url];
  NT_DETAIL[it.url] = d;
  ntPatchCard(it.url);
  // 弹层可能已经关了（或者换成了别的弹层）—— 只在它还开着、
  // 且显示的就是这一篇时才重画。不判断的话会把别的弹层内容冲掉。
  if (ntSheetUrl === it.url && !$('sheetMask').hidden) ntPaintSheet(it, d);
}

/** 给列表最上面几条补详情。两个并发：
 *  一个太慢（八条要等八轮），六个就是同时敲学校服务器。 */
function ntPrefetchFor(list) {
  const queue = list.slice(0, 8).filter((x) => !NT_DETAIL[x.url] && !NT_BUSY[x.url]);
  if (!queue.length) return;
  let i = 0;
  const worker = async () => {
    while (i < queue.length) {
      const it = queue[i++];
      if (NT_DETAIL[it.url] || NT_BUSY[it.url]) continue;
      await ntLoadDetail(it);
    }
  };
  worker(); worker();
}

/** 只换这一张卡。整列重画的话，用户正在滑的时候滚动位置和点击态都会丢。 */
function ntPatchCard(url) {
  const nodes = $('ntList').children;
  for (let k = 0; k < nodes.length; k++) {
    if (nodes[k].dataset.url !== url) continue;
    const it = NT.all.find((x) => x.url === url);
    if (!it) return;
    const box = document.createElement('div');
    box.innerHTML = ntCardHtml(it);
    if (box.firstChild) nodes[k].parentNode.replaceChild(box.firstChild, nodes[k]);
    return;
  }
}

function ntPaintSheet(it, d) {
  const meta = [it.dept || it.source || '', it.date || ''].filter(Boolean).join(' · ');
  let kv = '';
  if (d && d.ok) {
    if (d.when) kv += '<div class="sh-row"><span class="k">时间</span><span class="v">' +
                      esc(d.when) + '</span></div>';
    if (d.where) kv += '<div class="sh-row"><span class="k">地点</span><span class="v">' +
                       esc(d.where) + '</span></div>';
    if (d.publish && d.publish !== it.date) {
      kv += '<div class="sh-row"><span class="k">发布</span><span class="v">' +
            esc(d.publish) + '</span></div>';
    }
  }
  let mid;
  if (!d) {
    mid = '<div class="ntd-loading">正在读原文…</div>';
  } else if (!d.ok) {
    mid = '<div class="ntd-loading">没读到正文（' + esc(d.error || '原因不明') +
          '）。下面可以直接打开原文。</div>';
  } else if (d.summary) {
    mid = '<div class="ntd-body">' + esc(d.summary) + '</div>';
  } else {
    mid = '';
  }

  $('sheetBody').innerHTML =
    '<div class="sh-title">' + esc(it.title) + '</div>' +
    '<div class="sh-sub">' + esc(meta) + '</div>' +
    (kv ? '<div class="sh-rows">' + kv + '</div>' : '') +
    mid +
    '<div class="ntd-note">时间地点可能有出入，以原文为准。</div>' +
    '<div class="sheetbtns">' +
      '<button class="btn" id="ntClose">关闭</button>' +
      '<button class="btn primary" id="ntOpen">看原文</button>' +
    '</div>';
  $('ntClose').addEventListener('click', () => {
    ntSheetUrl = '';
    $('sheetMask').hidden = true;
  });
  $('ntOpen').addEventListener('click', () => {
    // 0.17.3 起在 App 内打开：公告正文在门户域名下，带着 CASTGC 进去就不用重登。
    // 以前交给系统浏览器 —— 那是第三个 cookie 罐子，每次都要在浏览器里再登一次，
    // 登完回来还得再切回 App。
    // warn=false：公告源是 www / jwc / tuanwei 这些**公开**新闻站，
    // 没连门户也照样能看，别弹「登录已过期」。
    if (!openApp(it.url, '公告原文', false)) toast('打不开，可以复制链接手动打开');
  });
}

function openNotice(it) {
  ntSheetUrl = it.url;
  ntPaintSheet(it, NT_DETAIL[it.url]);
  $('sheetMask').hidden = false;
  // 预取只覆盖最上面八条，点第 20 条时现取一次。
  if (!NT_DETAIL[it.url]) ntLoadDetail(it);
}

$('ntRefresh').addEventListener('click', () => { if (!NT.loading) loadNotice(true); });
// 公告是「功能」页的子页，返回回那里（见 SUB_PARENT）
$('ntBack').addEventListener('click', () => switchTab('campus'));
$('ntRetry').addEventListener('click', () => loadNotice(true));
$('ntChips').addEventListener('click', (e) => {
  const b = e.target.closest ? e.target.closest('.chip') : null;
  if (!b || !b.dataset.tier || NT.tier === b.dataset.tier) return;
  NT.tier = b.dataset.tier;
  renderNotice();
});
$('ntList').addEventListener('click', (e) => {
  const card = e.target.closest ? e.target.closest('.ntitem') : null;
  if (!card) return;
  const it = NT.all.find((x) => x.url === card.dataset.url);
  if (it) openNotice(it);
});

// ------------------------------------------------------------------ 课表

/** 换了日历日，就把「看到第几周 / 哪一天」拉回今天。
 *
 *  🔴 `CFG.week` 和 `CFG.cursor` 都存在本机（`zt.settings`），可它们只在
 *     **当天**有意义。2026-10-23 用户报的「周切日显示的不是当天」就是这条：
 *     他昨天看过日视图，cursor 停在 10-22，今天切过去还画 10-22。
 *     更危险的是周视图那一半 —— 上周日看的是第 7 周，周一已经第 8 周，
 *     开 App 还停在第 7 周，照着上周的课表走**会跑错教室**。
 *
 *  规则：同一天内照旧记住（「我刚翻到第 12 周」不能被冲掉），
 *        跨了一天就归位。判断依据是 `seenDay` 而不是「有没有 cursor」。
 */
function syncToday() {
  const t = ymd(today0());
  if (CFG.seenDay === t) return;
  CFG.seenDay = t;
  CFG.week = 0;          // 0 = 「没选过」，renderWeek 会补成 currentWeek()
  CFG.cursor = '';
  store.set(KEY.settings, CFG);
}

/** 日视图该画哪一天。
 *
 *  日视图的日期必须落在「周视图正在看的那一周」里，否则两个视图各说各的
 *  （顶栏写着「第 12 周」，切过去却是第 3 周的某一天）。
 *    · cursor 已经在那周里 —— 同一天内自己翻过天，保留，别抢用户的选择
 *    · 不在 —— 取那一周里**今天这个星期几**；看的就是当周时，正好是今天
 */
function dayAnchor() {
  const w = Math.min(Math.max(CFG.week || currentWeek(), 1), totalWeeks());
  const wd = (today0().getDay() + 6) % 7;
  if (CFG.cursor) {
    const cur = parseYmd(CFG.cursor);
    if (weekOf(cur) === w) return cur;
  }
  return addDays(startDate(), (w - 1) * 7 + wd);
}

function renderSchedule() {
  syncToday();
  const hasData = !!(DATA && curTT().courses && curTT().courses.length);
  $('schEmpty').hidden = hasData;
  $('gridWrap').hidden = !(hasData && CFG.view === 'week');
  $('dayWrap').hidden = !(hasData && CFG.view === 'day');
  // 视图切换按钮上写的是**当前**视图（周 / 日），点一下换成另一个。
  // 以前是两个 SVG 互切，网格图标表示不了「点一下会换一种」。
  $('wkViewLab').textContent = CFG.view === 'week' ? '周' : '日';
  $('viewToggle').classList.toggle('is-day', CFG.view === 'day');
  // 没数据的时候顶上那排「翻周 / 今天 / 切视图」全是无效控件 ——
  // 点了没反应，还让人以为界面坏了，直接收起来。
  document.querySelector('.weekbar').hidden = !hasData;
  if (!hasData) return;
  if (CFG.view === 'day') renderDay(); else renderWeek();
}

/* ---------------- 周视图 ----------------
 *
 * 🔴 **一屏画三页**（上一周 / 本周 / 下一周）并排塞进一条 `.track`。
 *    之前只画当前这一页，手指一拖就把唯一那页推走了，底下什么都没有 ——
 *    用户看到的就是「先整屏空白，再蹦出下一页」。
 *    三页同时在场，拖到一半时左右两边都是真课表，这才叫翻页。
 *    松手后把轨道平移一页、重画三页、再把轨道摆回中间，全在同一帧里完成。
 */
function renderWeek() {
  const total = totalWeeks();
  if (!CFG.week) CFG.week = currentWeek();
  const week = Math.min(Math.max(CFG.week, 1), total);
  // 把夹紧后的值写回去。不然用户在「学期设置」里把总周数从 24 改成 10 时，
  // CFG.week 还停在 18，界面显示第 10 周，但下次 `‹ ›` 是从 18 开始加减的。
  CFG.week = week;

  const ws = addDays(startDate(), (week - 1) * 7);
  const we = addDays(ws, 6);

  // 副标题改成「10.12 – 10.18 · 21 门课」。
  // 原来写「10月12日 - 10月18日」，中文月份把一行占满，没地方再放门数。
  $('wkNum').textContent = '第 ' + week + ' 周';
  // 门数单独包一层：顶栏加了刷新按钮之后，320dp 的老机型只剩 107px，
  // 日期范围 + 门数放不下，会变成「10.19 – 10.25 · 14 …」。
  // 让门数先让位（它是锦上添花），日期范围必须完整 —— CSS 里按宽度藏。
  //
  // 🔴 看历史学期时，副标题换成「大一上 · 9.01–9.07」：
  //    这一屏最要紧的信息不再是「几门课」，而是「我看的是哪一学期」——
  //    否则往上翻两页，用户根本分不清这张表是今年还是去年的。
  //    同时「现在」按钮比「今天」宽，顶栏只剩 100 来像素，
  //    再挤下去副标题会变成「大一上 · 9.01 – …」，日期被省略号吃掉。
  //    所以：按钮只写「现在」两字（CSS `.is-back` 再收窄内边距），
  //    副标题的日期连接符也从 ` – ` 收成 `–`（省两个字符宽度）。
  $('wkRange').innerHTML = TT
    ? '<b class="wk-term">' + esc(termShort(TT.semester)) + '</b> · ' +
      mdDot(ws) + '–' + mdDot(we)
    : mdDot(ws) + ' – ' + mdDot(we) +
      '<i class="wk-cnt"> · ' + weekCourseCount(occupancy(week)) + ' 门课</i>';
  // 已经在「本周」时把「今天」按钮标成浅蓝：按下去没变化，
  // 不标的话用户会以为按钮坏了。
  // 历史学期下这个按钮变成「回到现在」—— 否则它点了会跳到「历史学期的今天」，
  // 而那个日期根本不存在（week 被夹到 1，看着像没反应）。
  $('wkToday').classList.toggle('is-here', ttIsNow() && week === currentWeek());
  $('wkToday').classList.toggle('is-back', !ttIsNow());
  $('wkToday').textContent = ttIsNow() ? '今天' : '现在';

  renderGutter();
  const track = $('wkTrack');
  track.innerHTML = '';
  // 越界那一页画成空表：拖到头时橡皮筋只露一点点边，
  // 露出一张别的周的课表会让人以为翻页翻错了。
  [[week - 1, week > 1], [week, true], [week + 1, week < total]].forEach((p, i) => {
    const g = buildWeekGrid(p[1] ? p[0] : 0);
    if (i === 1) g.id = 'grid';   // 中间那页才是「当前页」，测试和老代码都认这个 id
    track.appendChild(g);
  });
  fitRoomLines(track);
  centerTrack(track);
}

/** 放不下的单行文本：量一下宽度，放不下就把字号往下压（最低 8px）。
 *
 *  管两类元素，都是「裁一半等于没写」的东西：
 *    · `.br2` —— 双教室号 `02B506`。9.5px 在电脑上量得下，在用户手机上
 *      末尾那个 6 被裁掉一半（2026-10-19 截图）。
 *    · `.bt`  —— 老师名字。带单双周角标的块还要让出右下角 12px，
 *      于是「李怡琦」显示成「李…」（2026-10-30 截图）。
 *
 *  🔴 为什么不靠 CSS 定死字号：Android WebView 的 Roboto 比桌面 Chromium 宽。
 *     只有**量出来**才知道放不放得下。判据用 scrollWidth > clientWidth ——
 *     元素是 nowrap + overflow:hidden，放不下时 scrollWidth 会大于可视宽度。
 *     `clientWidth` 不含 padding，所以 `.bt` 让给角标的那 12px 自动算在内。
 */
function fitRoomLines(root) {
  const els = root.querySelectorAll('.br2, .bt');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    el.style.fontSize = '';
    el.classList.remove('wrap');       // 每次重画都从「不折行」重新量
    // 页面被切走时（display:none）量出来全是 0，硬缩会把字号一路压到 8px。
    // 量不了就先不动，等切回课表页时 switchTab 会再调一次。
    if (!el.clientWidth) continue;
    // 🔴 起始字号必须**读 CSS**，不能写死一个数。写死 9.5 而 CSS 是 10 的话，
    //    第一次比较用的是 10px（还没赋值），循环第一轮直接跳到 9.0 ——
    //    9.5 这一档永远试不到，最后可能多缩半档还差 1px 被裁。
    let size = parseFloat(getComputedStyle(el).fontSize) || 10;
    while (size > 8 && el.scrollWidth > el.clientWidth + 0.5) {
      size -= 0.5;
      el.style.fontSize = size.toFixed(1) + 'px';
    }
    // 8px 还是放不下：老师名折到第二行（CSS 的 `.bt.wrap`），完整比截断重要。
    // ⚠️ 只对 `.bt` 这么做。`.br2` 的注释写明「锁死 nowrap，再折行就真的
    //    塞不下（360dp 实测溢出 10px）」—— 教室号折行会把格子撑破。
    if (el.classList.contains('bt') && el.scrollWidth > el.clientWidth + 0.5) {
      el.classList.add('wrap');
    }
  }
}

/** 左边固定的「节次 / 起止时间」栏。它不跟着翻页走，所以只画一次。 */
function renderGutter() {
  const units = (curTT().unitCount || 10);
  const tt = times();
  const g = $('wkGutter');
  g.style.setProperty('--units', units);
  let html = '<div class="g-corner"></div>';
  for (let p = 0; p < units; p++) {
    // 节次 + 起 + 止（WakeUp 那样三行）。只写开始时间看不出上到几点。
    html += '<div class="g-slot"><b>' + (p + 1) + '</b>' +
      (tt[p][0] ? '<i>' + tt[p][0] + '</i><i>' + tt[p][1] + '</i>' : '') + '</div>';
  }
  g.innerHTML = html;
}

/** 画某一周的一整张表，返回还没插进文档的 `.grid` 元素。 */
function buildWeekGrid(week) {
  const ws = addDays(startDate(), (week - 1) * 7);
  const occ = week >= 1 ? occupancy(week) : {};
  // 显示哪几天。拿到的是**真实星期几**，不是列序号 ——
  // 跳过空的周末列之后，最后一列的 d 可能是 4（周五）也可能是 6（周日），
  // 拿列号当星期用会把课画到错误的列上。
  const cols = visibleDays();
  const days = cols.length;

  const units = (curTT().unitCount || 10);
  const tt = times();
  const nowMin = nowMinute();

  const t0 = today0();
  const todayIdx = (week === weekOf(t0))
    ? Math.round((t0 - mondayOf(t0)) / 86400000) : -1;

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.setProperty('--days', days);
  grid.style.setProperty('--units', units);
  const frag = document.createDocumentFragment();

  // 「今天」那一列铺一条很淡的底色（整列，从表头到最后一节）。
  // 只在表头上做个胶囊，翻到别的周再翻回来时很容易看丢；
  // 整列一条淡淡的「泳道」，扫一眼就知道哪列是今天。
  // 🔴 必须先于 g-day / g-cell / g-block 入 DOM —— 网格项按 DOM 顺序叠，
  //    放后面就会盖住课程块。
  // ⚠️ 列号是 ci + 1：节次栏已经挪到轨道外面了，第 1 列就是周一。
  if (todayIdx >= 0) {
    const ci = cols.indexOf(todayIdx);
    if (ci >= 0) {
      const lane = document.createElement('div');
      lane.className = 'g-today-lane';
      lane.style.gridColumn = (ci + 1);
      lane.style.gridRow = '1 / span ' + (units + 1);
      frag.appendChild(lane);
    }
  }

  for (let ci = 0; ci < days; ci++) {
    const d = cols[ci];
    const el = document.createElement('div');
    el.className = 'g-day' + (d === todayIdx ? ' is-today' : '');
    el.style.gridColumn = (ci + 1);
    // 两行：星期在上（小、灰），月/日在下（大、深）。
    // 以前是「一 12」挤在一行、日期还是 <i> 斜体 —— 又小又斜，
    // 基本看不出那是日期，用户直接说「怎么不写日期」。
    // 写「周一」不写「一」：单个「一」渲染出来就是一根横线，
    // 摆在日期上面像条分隔符，不像星期。
    el.innerHTML = '<b>周' + DAY_CN[d] + '</b>' +
      '<span class="dnum">' + mdSlash(addDays(ws, d)) + '</span>';
    frag.appendChild(el);
  }

  for (let ci = 0; ci < days; ci++) {
    for (let p = 0; p < units; p++) {
      const el = document.createElement('div');
      el.className = 'g-cell';
      el.style.gridRow = (p + 2);
      el.style.gridColumn = (ci + 1);
      frag.appendChild(el);
    }
  }

  for (let ci = 0; ci < days; ci++) {
    const d = cols[ci];
    let p = 0;
    while (p < units) {
      const here = occ[d + ':' + p];
      if (!here || !here.length) { p++; continue; }
      const sig = here.map((c) => c.name + '@' + c.room).sort().join('|');
      let q = p + 1;
      while (q < units) {
        const nxt = occ[d + ':' + q];
        if (!nxt || !nxt.length) break;
        if (nxt.map((c) => c.name + '@' + c.room).sort().join('|') !== sig) break;
        q++;
      }
      const span = q - p;
      const startP = p;                       // p 会被改写，闭包里另存
      const main = here[0];
      const blk = document.createElement('div');
      // tall = 跨 2~3 节，xtall = 跨 4 节以上，one = 只有一节。
      // 三种高度能放下的文字行数不同，靠 class 决定课名最多占几行。
      // 「正在上」高亮：只在这一列**就是今天**、且此刻落在这块的起止之间时亮。
      // 翻到别的周 todayIdx 已经是 -1，天然不亮 —— 别让用户以为第 5 周
      // 也有节课正在上。
      const isNow = todayIdx >= 0 && cols[ci] === todayIdx && liveAt(tt, p, q, nowMin);
      blk.className = 'g-block c' + colorSlot(main.name) +
        (here.length > 1 ? ' multi' : '') +
        (span >= 4 ? ' tall xtall' : (span >= 2 ? ' tall' : ' one')) +
        (isNow ? ' live' : '');
      blk.style.gridRow = (p + 2) + ' / span ' + span;
      blk.style.gridColumn = (ci + 1);
      const names = here.map((c) => '<div class="bn">' + esc(c.name) + '</div>').join('');
      // 撞课（一格两门）时不放教室和教师 —— 分不清哪个属于哪门课，
      // 写了反而误导。单节的格子也照常写：字小一点塞得下，
      // 「这节课在哪个教室」比「课名多显示两个字」重要。
      let foot = '';
      if (here.length === 1) {
        if (main.room) {
          // 一间一行。两个教室就两行 —— 不能只写第一个（用户 2026-10-19 提的）。
          // 两间时把「楼栋 房间」中间那个空格去掉，**并且不要 @ 前缀**：
          // 格子只有 44px 宽，`@02B506` 在手机 WebView 里正好差几个像素，
          // 末尾的 6 被裁掉一半（用户 2026-10-19 第二次截图）。
          const rl = roomList(main.room);
          rl.forEach((r) => {
            const two = rl.length > 1;
            foot += '<div class="br' + (two ? ' br2' : '') + '">' +
              (two ? '' : '@') + esc(two ? r.replace(/\s+/g, '') : r) + '</div>';
          });
        }
        // 多个老师只写第一个。`张强,苏博` 在 27px 宽的角落只能显示成
        // 「张强,...」，还不如干净显示一个；完整名单在详情面板里。
        const tname = String(main.teacher || '').split(/[,，、]/)[0].trim();
        if (tname) foot += '<div class="bt">' + esc(tname) + '</div>';
      }
      blk.innerHTML = names + foot;
      const par = parityOf(main.weeks);
      if (par) blk.dataset.par = par;         // 右下角单/双周角标，纯 CSS 画
      blk.addEventListener('click', () => openCourseSheet(here, d, startP, span, week));
      frag.appendChild(blk);
      p = q;
    }
  }
  grid.appendChild(frag);
  return grid;
}

/* ---------------- 日视图 ----------------
 * 和周视图同一套做法：前后各画一天并排塞进轨道，翻天才不会先白一下。
 */
function renderDay() {
  const date = CFG.cursor ? parseYmd(CFG.cursor) : today0();
  const week = weekOf(date);
  const dayIdx = (date.getDay() + 6) % 7;
  const total = totalWeeks();

  $('wkNum').textContent = '周' + DAY_CN[dayIdx] + ' ' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
  $('wkRange').textContent = (week < 1 || week > total)
    ? (week < 1 ? '还没开学' : '学期已结束')
    : '第 ' + week + ' 周';
  $('wkToday').classList.toggle('is-here', ymd(date) === ymd(today0()));

  const track = $('dayView');
  track.innerHTML = '';
  [addDays(date, -1), date, addDays(date, 1)].forEach((d, i) => {
    const p = buildDayPage(d);
    if (i === 1) p.id = 'dayCur';
    track.appendChild(p);
  });
  centerTrack(track);
  renderDayNext(date);
}

/** 「现在这节 / 下一节」那条提示。
 *
 *  纯本地推算：课表、上课时间、当前时间都是现成的，不打服务器。
 *
 *  🔴 只在**看今天**的时候出现。翻到明天还写「下一节 14:00」，
 *     用户会以为那是在说现在 —— 这比不显示更糟。
 *
 *  两个刻意的克制：
 *    · 下一节在 3 小时以外就不显示（早上八点弹一条「还有 9 小时」没意义）
 *    · 今天课上完了就说「上完了」，别显示成「下一节」后面跟个负数
 */
function renderDayNext(date) {
  const el = $('dayNext');
  const isToday = ymd(date) === ymd(today0());
  const isDayView = CFG.view !== 'week';
  if (!isToday || !isDayView || !DATA || !curTT().courses) { el.hidden = true; return; }

  const week = weekOf(date);
  if (week < 1) { el.hidden = true; return; }

  const occ = occupancy(week);
  const dayIdx = (date.getDay() + 6) % 7;
  const tt = times();
  const units = curTT().unitCount || 10;
  const nowMin = nowMinute();
  const toMin = hhmmToMin;

  let cur = null, next = null;
  for (let p = 0; p < units; p++) {
    const here = occ[dayIdx + ':' + p];
    if (!here || !here.length) continue;
    const s = toMin(tt[p] && tt[p][0]);
    const e = toMin(tt[p] && tt[p][1]);
    if (s === null || e === null) continue;        // 时间没配就别瞎算
    if (nowMin >= s && nowMin <= e) { cur = { p: p, courses: here, s: s, e: e }; break; }
    if (s > nowMin && !next) { next = { p: p, courses: here, s: s, e: e }; break; }
  }

  const hhmm = (m) => pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  const main = (c) => c.courses[0];
  const where = (c) => roomFull(main(c).room) || '教室没写';

  if (cur) {
    const left = cur.e - nowMin;
    el.className = 'daynext live';
    el.innerHTML = '<span class="dn-tag">正在上</span>' +
      '<span class="dn-main"><b>' + esc(main(cur).name) + '</b>' +
      '<em>' + esc(where(cur)) + ' · ' + hhmm(cur.s) + '–' + hhmm(cur.e) + '</em></span>' +
      '<span class="dn-side">还有 ' + left + ' 分钟</span>';
    el.hidden = false;
    return;
  }
  if (next && next.s - nowMin <= 180) {
    const left = next.s - nowMin;
    el.className = 'daynext';
    el.innerHTML = '<span class="dn-tag">下一节</span>' +
      '<span class="dn-main"><b>' + esc(main(next).name) + '</b>' +
      '<em>' + esc(where(next)) + ' · ' + hhmm(next.s) + '–' + hhmm(next.e) + '</em></span>' +
      '<span class="dn-side">' + (left <= 0 ? '马上' : '还有 ' + left + ' 分钟') + '</span>';
    el.hidden = false;
    return;
  }
  // 今天有课但都上完了 —— 说清楚，别让人盯着空白猜
  const hasAny = Object.keys(occ).some((k) => k.indexOf(dayIdx + ':') === 0);
  if (hasAny && !next) {
    el.className = 'daynext done';
    el.innerHTML = '<span class="dn-tag">今天</span>' +
      '<span class="dn-main"><b>课上完了</b><em>明天见</em></span>';
    el.hidden = false;
    return;
  }
  el.hidden = true;
}

// 每分钟刷一次「还有几分钟」。只在页面可见时算 ——
// 后台还每秒算一遍纯属耗电，而手机最在意这个。
setInterval(() => {
  if (document.hidden) return;
  if (CFG.view === 'week') return;
  if (!DATA || !curTT().courses) return;
  const date = CFG.cursor ? parseYmd(CFG.cursor) : today0();
  if (ymd(date) !== ymd(today0())) return;
  renderDayNext(date);
}, 60000);

/** 画某一天的整列卡片，返回还没插进文档的 `.dayview` 元素。 */
function buildDayPage(date) {
  const week = weekOf(date);
  const total = totalWeeks();
  const dayIdx = (date.getDay() + 6) % 7;
  const occ = week >= 1 ? occupancy(week) : {};
  const units = (curTT().unitCount || 10);
  const tt = times();

  const list = [];
  for (let p = 0; p < units; p++) {
    const here = occ[dayIdx + ':' + p];
    if (here && here.length) list.push({ p, courses: here });
  }

  const box = document.createElement('div');
  box.className = 'dayview';
  if (!list.length) {
    box.innerHTML = '<div class="empty" style="padding-top:48px">' +
      '<div class="empty-ico"><svg viewBox="0 0 24 24"><path d="M20 12.5A8 8 0 1 1 11.5 4"/><path d="M12 8v4.5l3 1.8"/></svg></div>' +
      '<h2>' + (week < 1 ? '还没开学' : (week > total ? '学期已结束' : '这天没课')) + '</h2>' +
      '<p>' + (week < 1 ? '开学日期设成 ' + ymd(startDate()) + '，可以在「我的」里改' : '') + '</p></div>';
    return box;
  }

  // 连续同课合并
  const merged = [];
  list.forEach((it) => {
    const last = merged[merged.length - 1];
    const sig = it.courses.map((c) => c.name + '@' + c.room).sort().join('|');
    if (last && last.p + last.len === it.p && last.sig === sig) { last.len++; return; }
    merged.push({ p: it.p, len: 1, sig, courses: it.courses });
  });

  const nowMin = nowMinute();
  const isToday = ymd(date) === ymd(today0());

  box.innerHTML = merged.map((m) => {
    const startT = tt[m.p][0] || '';
    const endT = tt[m.p + m.len - 1][1] || '';
    const periods = [];
    for (let i = 0; i < m.len; i++) periods.push(m.p + i);
    // 跟周视图同一套判据（`liveAt`），两处别各写一份 ——
    // 一份用 split(':')、一份用正则，遇到空串就会一边亮一边不亮。
    const live = isToday && liveAt(tt, m.p, m.p + m.len, nowMin);
    const main = m.courses[0];
    const extra = m.courses.slice(1);
    return '<div class="dv-item">' +
      '<div class="dv-time"><b>' + (startT || '—') + '</b><i>' + (endT || '') + '</i></div>' +
      '<div class="dv-card c' + colorSlot(main.name) + (live ? ' live' : '') + '">' +
        '<div class="dv-head"><span class="dv-name">' + esc(main.name) + '</span>' +
          '<span class="dv-period">' + periodsText(periods) + '</span></div>' +
        '<div class="dv-meta">' + esc(roomFull(main.room)) +
          (main.teacher ? ' · ' + esc(main.teacher) : '') + '</div>' +
        (extra.length ? '<div class="dv-meta">另：' + extra.map((c) => esc(c.name)).join('、') + '</div>' : '') +
      '</div></div>';
  }).join('');

  box.querySelectorAll('.dv-card').forEach((el, i) => {
    el.addEventListener('click', () => {
      const m = merged[i];
      openCourseSheet(m.courses, dayIdx, m.p, m.len, week);
    });
  });
  return box;
}

/* ---------------- 课程详情 ---------------- */
function openCourseSheet(courses, day, period, span, week) {
  const tt = times();
  const periods = [];
  for (let i = 0; i < span; i++) periods.push(period + i);
  const t1 = tt[period] && tt[period][0];
  const t2 = tt[period + span - 1] && tt[period + span - 1][1];

  $('sheetBody').innerHTML = courses.map((c) => {
    const w = c.weeks || [];
    const odd = w.length > 1 && w.every((x) => x % 2 === 1);
    const even = w.length > 1 && w.every((x) => x % 2 === 0);
    return '<div class="sh-block">' +
      '<div class="sh-title">' + esc(c.name) + '</div>' +
      '<div class="sh-sub">' + esc(c.code || '') + '</div>' +
      '<div class="sh-rows">' +
        '<div class="sh-row"><span class="k">教师</span><span class="v">' + esc(c.teacher || '—') + '</span></div>' +
        '<div class="sh-row"><span class="k">教室</span><span class="v">' + esc(c.room || '—') + '</span></div>' +
        '<div class="sh-row"><span class="k">时间</span><span class="v">星期' + DAY_CN[day] + ' ' +
          periodsText(periods) + (t1 ? '（' + t1 + ' - ' + (t2 || '') + '）' : '') + '</span></div>' +
        '<div class="sh-row"><span class="k">周次</span><span class="v">' + weeksText(w) +
          (odd ? '（单周）' : (even ? '（双周）' : '')) + '</span></div>' +
      '</div>' +
      '<button class="sh-hide" data-code="' + esc(c.code || '') + '">隐藏这门课</button>' +
      '</div>';
  }).join('');
  $('sheetMask').hidden = false;

  $('sheetBody').querySelectorAll('.sh-hide').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.code;
      if (!code) return;
      setHidden(code, true);
      $('sheetMask').hidden = true;
      toast('已隐藏，可在「我的」里恢复');
    });
  });
}

/* ---------------- 确认框（自绘，不用 window.confirm） ----------------
 *
 * 🔴 为什么不用 confirm()：
 *    WebView 里的 confirm() 要靠 WebChromeClient.onJsConfirm() 才会弹框。
 *    MainActivity 只 setWebViewClient，没设 WebChromeClient ⇒ confirm()
 *    **连框都不弹，直接返回 false** ⇒ 按钮点了毫无反应。
 *    2026-10-19 用户报「清除本机缓存和解除绑定之类的按钮形同虚设」就是这个。
 *
 * ⚠️ 也别「网页版用 confirm、APK 用自绘」—— 两套行为不一致的话，
 *    在浏览器里测着好好的，装到手机上才发现是死的。统一走这里。
 */
let askResolve = null;   // 正在等回答的那个 Promise 的 resolve

/** 弹一个两按钮的确认框，返回 Promise<boolean>。
 *
 *  `danger` 默认 true —— 原来四个调用点（断开门户 / 断开学习通 / 解除绑定 /
 *  清除缓存）全是「删掉点什么」，红色是对的。直饮水的「开始接水」不是删除，
 *  红色会让人以为要删东西，所以那里传 false 走主按钮色。
 *  ⚠️ 默认值必须是 true：漏传的那个调用点会从红变蓝，而且**不报错**。
 */
function askConfirm(title, sub, okText, danger) {
  const cls = (danger === false) ? 'primary' : 'danger';
  return new Promise((resolve) => {
    // 上一张还没答就又来一张：先把旧的按「取消」结掉。
    // 不结的话那个 Promise 永远悬着，对应的 await 之后再也走不下去。
    if (askResolve) { const old = askResolve; askResolve = null; old(false); }
    askResolve = resolve;
    $('sheetBody').innerHTML =
      '<div class="sh-title">' + esc(title) + '</div>' +
      '<div class="sh-sub">' + esc(sub) + '</div>' +
      '<div class="sheetbtns">' +
        '<button class="btn" id="askNo">取消</button>' +
        '<button class="btn ' + cls + '" id="askYes">' + esc(okText) + '</button>' +
      '</div>';
    $('sheetMask').hidden = false;
    $('askNo').addEventListener('click', () => askDone(false));
    $('askYes').addEventListener('click', () => askDone(true));
  });
}

/** 收尾：关框 + 回答。只能答一次，重复调用是空操作。 */
function askDone(v) {
  if (!askResolve) return false;
  const r = askResolve;
  askResolve = null;
  $('sheetMask').hidden = true;
  r(v);
  return true;
}

/** 关掉底部弹层。**唯一的正确关法** —— 遮罩点击、返回键、右上角 ✕ 全走这里。
 *
 *  🔴 只把 `#sheetMask` 藏掉是不行的：openPick / openInput / askConfirm
 *     各挂着一个 Promise，不 resolve 就永远悬着，下次点同一个按钮
 *     「没反应」而且**不报错**（0.37.0 踩过一次，0.38.0 把它收成一个函数）。
 *  🔴 0.38.0：原来只有「点遮罩」和「按返回键」两条路能出去。用户 2026-11-01：
 *     「很多界面进入后没有返回按钮，会导致用户不知所措」——
 *     ⇒ 弹层外壳上固定一颗 ✕，**不用每个调用方各自记得加取消按钮**。
 */
function closeSheet() {
  if (askDone(false)) return true;
  if (pickDone(null)) return true;
  if (inputDone(null)) return true;
  $('sheetMask').hidden = true;
  return true;
}

$('sheetMask').addEventListener('click', (e) => {
  if (e.target !== $('sheetMask')) return;
  // 点外面 = 取消。必须走 closeSheet，别在这里再写一遍三条 done()。
  closeSheet();
});
$('sheetX').addEventListener('click', closeSheet);

/* ---------------- 单选弹层（替代原生 <select>） ----------------
 *
 * 为什么不用 <select>：安卓 WebView 里点开是**系统那个「一列单选框」的对话框**
 * （白底、系统字体、圆点靠右），跟应用里其他所有弹层都不是一个世界 ——
 * 用户 2026-10-19 截了图说「跟老安卓页面似的」。
 *
 * 这里用应用自己的底部弹层：同一个 .sheet 容器、同一套配色和深色主题、
 * 返回键和点遮罩的行为也跟别处一致。
 *
 * 返回 Promise：
 *   resolve(选项 id)  选中了（**空串是合法的「不限」**）
 *   resolve(null)     取消了（点遮罩 / 按返回键）
 * 🔴 取消必须 resolve，不能只是把框藏掉 —— 否则 await 永远不回来。
 */
let pickResolve = null;

function openPick(title, sub, groups, cur) {
  return new Promise((resolve) => {
    // 上一个还没选就又来一个：先按「取消」结掉，别留下悬着的 Promise
    if (pickResolve) { const old = pickResolve; pickResolve = null; old(null); }
    pickResolve = resolve;
    let html = '<div class="sh-title">' + esc(title) + '</div>' +
      (sub ? '<div class="sh-sub">' + esc(sub) + '</div>' : '<div class="pickgap"></div>') +
      '<div class="picklist">';
    groups.forEach((g) => {
      if (!g || !g.items || !g.items.length) return;
      if (g.title) html += '<div class="pickhead">' + esc(g.title) + '</div>';
      g.items.forEach((it) => {
        const id = it.id == null ? '' : String(it.id);
        html += '<button class="pickopt' + (id === String(cur || '') ? ' on' : '') +
          (it.danger ? ' danger' : '') +
          '" data-id="' + esc(id) + '">' +
          '<span class="t">' + esc(it.name) + '</span>' +
          '<svg class="ck" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>' +
          '</button>';
      });
    });
    html += '</div>' +
      // 🔴 0.38.0：原来这个弹层**只有点遮罩才能关**，没有取消按钮。
      //    用户 2026-11-01：「很多界面进入后没有返回按钮，会导致用户不知所措」——
      //    「点外面关掉」是知道的人才知道的规矩，不知道的人只能按返回键试。
      //    凡是能进来的地方，都得给一颗写得出来的出口。
      '<div class="sheetbtns"><button class="btn" id="pickNo">取消</button></div>';
    $('sheetBody').innerHTML = html;
    $('sheetMask').hidden = false;
    $('sheetBody').querySelectorAll('.pickopt').forEach((b) => {
      b.addEventListener('click', () => pickDone(b.dataset.id));
    });
    const no = $('pickNo');
    if (no) no.addEventListener('click', () => pickDone(null));
  });
}

/** 收尾：关框 + 交回结果。只能交一次，重复调用是空操作。 */
function pickDone(id) {
  if (!pickResolve) return false;
  const r = pickResolve;
  pickResolve = null;
  $('sheetMask').hidden = true;
  r(id);
  return true;
}

/* ---------------- 文本输入弹层（0.28.1） ----------------
 *
 * 只有「添加饮水机」一处用得上：把二维码里的内容粘进来。
 *
 * 🔴 为什么不用 window.prompt()：跟 confirm() 同一个原因 ——
 *    WebView 里要靠 WebChromeClient.onJsPrompt() 才会弹，而 MainActivity
 *    只 setWebViewClient ⇒ prompt() **连框都不弹，直接返回 null**，
 *    按钮点了毫无反应。同一个坑别踩第二遍（见上面 askConfirm 的注释）。
 *
 * 返回 Promise：
 *   resolve(字符串)  点了确定（**空串是合法的**，交给调用方判）
 *   resolve(null)    取消了（点遮罩 / 按返回键 / 点取消）
 * ⚠️ 取消必须 resolve，不能只把框藏掉 —— 否则 await 永远不回来。
 */
let inputResolve = null;

function openInput(title, sub, placeholder, okText, value) {
  return new Promise((resolve) => {
    if (inputResolve) { const old = inputResolve; inputResolve = null; old(null); }
    inputResolve = resolve;
    $('sheetBody').innerHTML =
      '<div class="sh-title">' + esc(title) + '</div>' +
      (sub ? '<div class="sh-sub">' + esc(sub) + '</div>' : '') +
      '<input class="sheetinput" id="inputVal" type="text" inputmode="text"' +
      ' autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"' +
      ' placeholder="' + escAttr(placeholder || '') + '">' +
      '<div class="sheetbtns">' +
        '<button class="btn" id="inputNo">取消</button>' +
        '<button class="btn primary" id="inputYes">' + esc(okText || '确定') + '</button>' +
      '</div>';
    $('sheetMask').hidden = false;
    const el = $('inputVal');
    // 0.37.0：可选预填。改名时要把现在的名字放进去 —— 让用户在一个空框里
    // 重敲一遍自己的名字，是纯粹的刁难。
    if (value != null && value !== '') el.value = String(value);
    // 弹层刚显示时立刻 focus，部分安卓机不弹软键盘（元素还在 hidden 的祖先里）。
    // 等一帧再 focus，键盘才稳。
    setTimeout(() => { try { el.focus(); } catch (e) { /* 没有键盘的设备（模拟器）*/ } }, 60);
    $('inputNo').addEventListener('click', () => inputDone(null));
    $('inputYes').addEventListener('click', () => inputDone(el.value));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') inputDone(el.value); });
  });
}

/** 收尾：关框 + 交回内容。只能交一次，重复调用是空操作。 */
function inputDone(v) {
  if (!inputResolve) return false;
  const r = inputResolve;
  inputResolve = null;
  $('sheetMask').hidden = true;
  r(v);
  return true;
}

/* ---------------- 学期切换（课表） ----------------
 *
 * 用户 2026-10-31 的原话：「你这怎么切换不了学期」「给我自己绑定的大二学年」
 *   「又更新了一下 变到大二下了」。
 * 之前课表只认教务系统**此刻**认定的那个学期 —— 学校一换，整张表跟着变，
 * 想回头看上学期的课只能等学校自己切回来。
 * 教务的课表表单里本来就有 `semester.id`（以前恒传空串 = 当前学期），
 * 传上学期的 id 就能把那学期的课表取回来，**同一个接口，不用另找页面**。
 *
 * 入口放在「跳到第几周」那个弹层的顶上：这两件事都是「我要看别处的课表」。
 * 顶栏已经挤了 6 个控件（翻周 / 标题 / 今天 / 空教室 / 周·日），
 * 再挂一个按钮，会把「第 8 周 10.19–10.25」那串字直接挤没。
 */

/** 当前学期的 id（同步时教务给的那个，考试页也在用同一个）。取不到返回空串。 */
const nowTermId = () => String((DATA && DATA.exams && DATA.exams.semesterId) || '');

/** 切到某一学期的课表。`sid` 为空 = 回到当前学期（不用联网，DATA 里就有）。
 *
 *  三种「不用真的去取」的情况分开处理，别让用户白等一次网络：
 *    · 点的就是正在看的那学期
 *    · 已经是当前学期、又点了当前学期
 *    · 上一次还在取
 */
async function switchTerm(sid) {
  sid = String(sid || '');
  if (ttLoading) return;
  if (sid && TT && sid === TT.id) { $('sheetMask').hidden = true; return; }
  if (!sid && ttIsNow()) { $('sheetMask').hidden = true; return; }

  if (!sid) {
    // 回到当前学期：TT 一置空，tt() 就退回 DATA 那份，不用再打学校服务器。
    TT = null;
    CFG.week = currentWeek();
    CFG.cursor = CFG.view === 'day' ? ymd(dayAnchor()) : '';
    store.set(KEY.settings, CFG);
    $('sheetMask').hidden = true;
    renderSchedule();
    toast('已回到当前学期');
    return;
  }

  const t = studyTerms().find((x) => x.id === sid);
  ttLoading = true;
  toast('正在取' + (t ? t.label : '这一学期') + '的课表…', 8000);
  let r;
  try {
    r = await api('/api/timetable', {
      semesterId: sid, semesterName: (t && t.name) || '',
    });
  } catch (e) {
    r = { ok: false, error: '连不上服务，稍后再试' };
  }
  ttLoading = false;
  if (!r || !r.ok) { toast((r && r.error) || '这一学期的课表没取到'); return; }

  // 🔴 空课表要**明说**「教务系统里没有」，不能说成「取失败」，
  //    更不能安静地切过去显示一张空表 —— 那会让人以为软件坏了。
  if (!r.courses || !r.courses.length) {
    toast('教务系统里' + (t ? t.label : '这一学期') + '没有课表');
    return;
  }

  TT = {
    id: sid,
    semester: r.semester || (t && t.name) || '',
    courses: r.courses,
    unitCount: r.unitCount || 10,
    totalWeeks: r.totalWeeks || 20,
  };
  // 换了一张表，周次必须从第 1 周重新开始 —— 上一张表停在第 15 周，
  // 新表如果只有 18 周，会直接落在一半的位置，看着像丢了前半学期。
  CFG.week = 1;
  CFG.cursor = '';
  store.set(KEY.settings, CFG);
  $('sheetMask').hidden = true;
  renderSchedule();
  $('schScroll').scrollTop = 0;
  toast('已切到' + (termShort(TT.semester) || '该学期'));
}

/* ---------------- 周次选择器 ---------------- */
$('wkTitle').addEventListener('click', () => {
  if (!DATA) return;
  const total = totalWeeks();
  const cur = CFG.view === 'day'
    ? (CFG.cursor ? weekOf(parseYmd(CFG.cursor)) : currentWeek())
    : (CFG.week || currentWeek());
  // 副标题写「大二上 · 共 24 周」。算不出年级才退回教务系统的学期原文。
  const sl = gradeLabel() || semesterName();
  let html = '';

  // 学期 chip（见上面 switchTerm 的说明）。只有**两个以上**学期时才摆出来：
  // 只有一个学期的账号，摆一排点了没变化的按钮，比不摆更让人困惑。
  const terms = studyTerms();
  if (terms.length > 1) {
    const nowId = nowTermId();
    html += '<div class="sh-title">学期</div><div class="sh-terms">';
    // 看历史学期时，最前面给一个「当前学期」—— 不用在列表里找自己那格。
    if (!ttIsNow()) html += '<button class="chip" data-sid="">当前学期</button>';
    html += terms.map((t) => {
      const on = TT ? t.id === TT.id : t.id === nowId;
      return '<button class="chip' + (on ? ' on' : '') + '" data-sid="' + esc(t.id) + '">' +
        esc(t.label) +
        (t.id === nowId ? '<i class="sh-now">在读</i>' : '') + '</button>';
    }).join('');
    html += '</div>';
  }

  html += '<div class="sh-title">跳到第几周</div>' +
    '<div class="sh-sub">' + (sl ? esc(sl) + ' · ' : '') +
    '共 ' + total + ' 周，点一下直接跳过去</div><div class="wkgrid">';
  for (let i = 1; i <= total; i++) {
    html += '<button class="wkcell' + (i === cur ? ' on' : '') + '" data-w="' + i + '">' + i + '</button>';
  }
  // 周数不对 / 开学日期不对，就在这儿给个入口 —— 用户翻周翻到一半发现
  // 「怎么只有 20 周」时，第一反应是找地方改，不会跑去「我的」翻设置。
  // 「看校历」也放这儿：顶栏已经 6 个控件，再加一个，「第 8 周 10.19-10.25」
  // 那串字就没地方写了。而点周次本来就是「我要看时间安排」，语义正好。
  //
  // ⚠️ 这两个入口都只对**当前学期**有意义（校历是当前学期的，学期设置改的
  //    也是它）。翻历史学期时藏起来 —— 否则点进去看到的是另一个学期的校历，
  //    改完还会把当前学期弄乱。
  html += '</div>';
  if (ttIsNow()) {
    html += '<div class="sheetbtns">' +
      '<button class="btn" id="wkToCalendar">看校历</button>' +
      '<button class="btn" id="wkToSemester">学期设置</button></div>';
  }
  $('sheetBody').innerHTML = html;
  $('sheetMask').hidden = false;
  if (ttIsNow()) {
    $('wkToCalendar').addEventListener('click', () => {
      $('sheetMask').hidden = true;
      switchTab('calendar');
    });
    $('wkToSemester').addEventListener('click', openSemesterSheet);
  }
  $('sheetBody').querySelectorAll('.sh-terms .chip').forEach((b) => {
    b.addEventListener('click', () => switchTerm(b.dataset.sid));
  });
  $('sheetBody').querySelectorAll('.wkcell').forEach((b) => {
    b.addEventListener('click', () => {
      const w = Number(b.dataset.w);
      $('sheetMask').hidden = true;
      if (CFG.view === 'day') {
        CFG.cursor = ymd(addDays(startDate(), (w - 1) * 7 + ((CFG.cursor ? (parseYmd(CFG.cursor).getDay() + 6) % 7 : 0))));
      } else {
        CFG.week = w;
      }
      store.set(KEY.settings, CFG);
      renderSchedule();
    });
  });
});

/* ---------------- 导航按钮 ---------------- */
$('wkPrev').addEventListener('click', () => step(-1));
$('wkNext').addEventListener('click', () => step(1));

/* ---------------- 左右滑动翻周 / 翻天 ----------------
 *
 * 参考了几个开源课表 App 的做法（晴课表 CourseSchedule、时光课程表、
 * 下节啥课），共同点是**跟手**：手指往左推，课表跟着往左走，松手才决定
 * 翻不翻。只判「滑了多远」不跟手，手感像在戳按钮，不像在翻页。
 *
 * 三个必须踩住的点：
 *  1. **不能抢纵向滚动** —— 课表纵向要滚 10 节课，横向才是翻周。
 *     所以先看前 8px 的位移方向，横向要明显压过纵向（1.4 倍）才接管。
 *  2. **到头要停** —— 第 1 周再往右拉只给 28% 位移（橡皮筋），松手弹回。
 *  3. **滑动后要吞掉那个 click** —— 否则松手时会顺带把手指底下的
 *     课程块点开，弹出详情面板，看着像误触。
 */
let swipeAt = 0;
/* 动画期间不接受新的滑动。不然连着甩两下，第二下会在第一下的
   中途重新起算位移，画面会「抖一下再跳」。 */
let sliding = false;

/** 这个方向还能不能翻。到头了就不让滑（只留橡皮筋）。 */
function canStep(dir) {
  if (!DATA) return false;
  if (CFG.view === 'day') return true;        // 日视图不设边界，方便看空白天
  const w = CFG.week || currentWeek();
  return dir < 0 ? w > 1 : w < totalWeeks();
}

function swipeInner() {
  return CFG.view === 'day' ? $('dayView') : $('wkTrack');
}

/* 一页到底多宽。
   🔴 别用 `track.clientWidth`：容器有纵向滚动条时它会比「一页」窄十几像素，
      平移量就会差那十几像素 —— 上一页会从左边漏出一条边（实测漏 20px）。 */
function pageW(el) {
  const p = el && el.firstElementChild;
  const w = p ? p.getBoundingClientRect().width : 0;
  return w || (el && el.clientWidth) || 320;
}

/* 三页并排，位移基准是「一页宽」。
   轨道里三页等宽，所以把中间那页摆到可视区就是 translateX(-W)，
   翻页时再 ± 一个 W。 */
function centerTrack(track) {
  if (!track) return;
  track.style.transition = 'none';
  track.style.transform = 'translate3d(' + (-pageW(track)) + 'px,0,0)';
}

/** 滑完一页的收尾：把轨道整页平移过去，再重画三页并把轨道摆回中间。 */
function slideStep(dir) {
  if (sliding) return;
  sliding = true;
  const el = swipeInner();
  if (!el) { sliding = false; return; }
  const w = pageW(el);
  const ease = 'transform .24s cubic-bezier(.32,.72,0,1)';
  el.style.transition = ease;
  el.style.transform = 'translate3d(' + (-w - dir * w) + 'px,0,0)';
  setTimeout(() => {
    step(dir);          // 重画三页；renderWeek / renderDay 里会把轨道摆回中间
    sliding = false;
  }, 245);
}

/** 拖到一半松手、又不翻页时，把轨道弹回原位。 */
function snapBack() {
  const el = swipeInner();
  if (!el) return;
  const w = pageW(el);
  el.style.transition = 'transform .18s ease-out';
  el.style.transform = 'translate3d(' + (-w) + 'px,0,0)';
  setTimeout(() => { if (el) el.style.transition = ''; }, 200);
}

(function attachSwipe() {
  const host = $('schScroll');
  if (!host) return;

  let sx = 0; let sy = 0; let dx = 0; let t0 = 0;
  let axis = '';            // '' = 还没定方向，'x' = 翻周，'y' = 纵向滚动（我们不插手）
  let active = false;

  const reset = () => {
    active = false; axis = ''; dx = 0;
    const el = swipeInner();
    if (el) { el.style.transition = ''; centerTrack(el); }
  };

  host.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !DATA || sliding) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; dx = 0; t0 = Date.now();
    axis = ''; active = true;
    const el = swipeInner();
    if (el) el.style.transition = 'none';
  }, { passive: true });

  host.addEventListener('touchmove', (e) => {
    if (!active || e.touches.length !== 1) return;
    const t = e.touches[0];
    dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (!axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axis = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'x' : 'y';
      if (axis === 'y') { active = false; const el = swipeInner(); if (el) el.style.transition = ''; return; }
    }
    if (axis !== 'x') return;
    const el = swipeInner();
    if (!el) return;
    const w = pageW(el);
    const dir = dx > 0 ? -1 : 1;
    // 到头了只给三成位移：手指有反馈，但明确告诉你「没得翻了」
    const d = canStep(dir) ? dx : dx * 0.28;
    el.style.transform = 'translate3d(' + (-w + d) + 'px,0,0)';
  }, { passive: true });

  const finish = () => {
    if (!active || axis !== 'x') { reset(); return; }
    const el = swipeInner();
    const w = pageW(el);
    const dt = Math.max(1, Date.now() - t0);
    const v = Math.abs(dx) / dt;                 // px/ms
    // 两种都算翻页：划得够远（屏幕 22%，上限 70px），或者快速一甩（>0.45 px/ms）
    const far = Math.abs(dx) > Math.min(70, w * 0.22);
    const flick = v > 0.45 && Math.abs(dx) > 24;
    const dir = dx > 0 ? -1 : 1;                 // 手指往右 = 看上一周
    const go = (far || flick) && canStep(dir);
    const moved = dx;
    // 🔴 这里不能调 reset() —— 它会把 transform 摆回中间，
    //    等于把已经拖出去的距离瞬间抹掉，看起来就是「抖一下再跳」。
    //    只清手势状态，位移交给 slideStep / snapBack。
    active = false; axis = ''; dx = 0;
    if (go) { swipeAt = Date.now(); slideStep(dir); }
    else if (Math.abs(moved) > 2) snapBack();
    else if (el) el.style.transition = '';
  };

  host.addEventListener('touchend', finish, { passive: true });
  host.addEventListener('touchcancel', finish, { passive: true });

  // 滑动后浏览器会补一个 click，落在课程块上就弹出详情 —— 吞掉它。
  // 用捕获阶段，比在每个课程块里各判一次靠谱。
  host.addEventListener('click', (e) => {
    if (Date.now() - swipeAt < 350) { e.stopPropagation(); e.preventDefault(); }
  }, true);
})();

function step(n) {
  if (!DATA) return;
  if (CFG.view === 'day') {
    const d = CFG.cursor ? parseYmd(CFG.cursor) : today0();
    CFG.cursor = ymd(addDays(d, n));
  } else {
    CFG.week = Math.min(Math.max(1, (CFG.week || currentWeek()) + n), totalWeeks());
  }
  store.set(KEY.settings, CFG);
  renderSchedule();
}

$('wkToday').addEventListener('click', () => {
  if (!DATA) return;
  // 历史学期下这个按钮叫「回到现在」：先切回当前学期，再落到本周/今天。
  if (!ttIsNow()) {
    switchTerm('');
    return;
  }
  if (CFG.view === 'day') CFG.cursor = ymd(today0());
  else CFG.week = currentWeek();
  store.set(KEY.settings, CFG);
  renderSchedule();
  $('schScroll').scrollTop = 0;
});

$('viewToggle').addEventListener('click', () => {
  CFG.view = CFG.view === 'week' ? 'day' : 'week';
  // 🔴 不能写成「cursor 为空才设今天」—— cursor 是存本机的，昨天看过就非空。
  if (CFG.view === 'day') CFG.cursor = ymd(dayAnchor());
  store.set(KEY.settings, CFG);
  renderSchedule();
  $('schScroll').scrollTop = 0;
});

/* App 被切到后台过夜，回来时课表还停在昨天 —— 同一类问题。
   只在「日期真的变了」时重画：同一天切来切去不该闪一下。 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !DATA || !curTT().courses || !curTT().courses.length) return;
  if (CFG.seenDay === ymd(today0())) return;
  syncToday();
  renderSchedule();
  // 空教室那个「默认查哪天」也是按今天算的（课上完了默认明天），
  // 跨日之后同样得重算 —— 否则第二天进去还在查昨天。
  ROOM.date = '';
  renderRooms();
});

/* 空教室和校历是课表页的「子页」（底部固定 5 个 tab 之后收进来的）。
   进出都走 switchTab —— 不要自己改 hidden，否则 CUR_PAGE、底部高亮、
   系统返回键三处会互相打架。 */
$('wkRooms').addEventListener('click', () => switchTab('rooms'));
$('calBack').addEventListener('click', () => switchTab('schedule'));
$('rmBack').addEventListener('click', () => switchTab('schedule'));

// ------------------------------------------------------------------ 成绩

let gradeTerm = 'all';
let gradeFind = '';        // 搜索词（课程名 / 课程号）
let gradeSort = 0;         // 0 默认 / 1 分数优先 / 2 学分优先
// 0.33.0：列表**首屏**显示几门。一学期十几门 × 65px 就是 900+，
// 这一页可用只有 678（上面还有汇总卡、绩点趋势、学期筛选、搜索框）。
// 5 门 + 一颗「还有 N 门」正好一屏；要看全套点一下，或者用上面的搜索。
let gradeShowN = 5;
const GRADE_SORTS = ['默认排序', '分数优先', '学分优先'];

/** 课程号 → 它在培养计划里的身份。
 *
 *  返回 Map<code, {pc, sub}>：pc 是计划里那条课程，sub 表示「这门是替代课」。
 *  计划没同步下来时返回**空 Map** —— 调用方看到 size===0 就一个标签都不打，
 *  否则所有课都会被标成「计划外」，那是把「没读到」说成了事实。
 */
function planIndex() {
  const m = new Map();
  const plan = (DATA && DATA.plan) || null;
  if (!plan || !plan.courses || !plan.courses.length) return m;
  const byCode = {};
  plan.courses.forEach((pc) => {
    const k = String(pc.code || '').trim();
    if (!k) return;
    byCode[k] = pc;
    m.set(k, { pc: pc, sub: false });
  });
  (plan.subs || []).forEach((s) => {
    const from = byCode[String((s.from && s.from.code) || '').trim()];
    const to = String((s.to && s.to.code) || '').trim();
    if (to && from) m.set(to, { pc: from, sub: true });
  });
  return m;
}

/** 每学期一根柱子画绩点。
 *
 *  只有总绩点的话，「大一上 3.11 → 大一下 2.06」会被平均成 2.51，
 *  看上去风平浪静 —— 但那是掉了一整个档。数据一直在 grades.summary 里，
 *  以前只是没画出来。
 *
 *  少于两学期就不画：一根柱子不叫趋势，还白占一块地方。
 */
function renderGpaTrend(g) {
  const box = $('grTrend');
  if (!box) return;
  const rows = (g.summary || []).map((s) => {
    const y = /^(\d{4})/.exec(String(s.year || ''));
    const gl = y ? gradeName(Number(y[1]), Number(s.term)) : '';
    return {
      label: gl || (String(s.year || '') + ' ' + String(s.term || '')).trim(),
      gpa: parseFloat(s.gpa),
    };
  }).filter((r) => !isNaN(r.gpa) && r.gpa > 0);

  if (rows.length < 2) { box.hidden = true; return; }
  box.hidden = false;

  // 分母取 max(4, 实际最高)：郑航是 4 分制，按 4 折算柱子高矮可比；
  // 万一遇到 5 分制的学校也不会把柱子顶出框。
  const top = Math.max(4, Math.max.apply(null, rows.map((r) => r.gpa)));
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const d = last.gpa - prev.gpa;
  // 涨了是绿的、掉了是红的 —— 这里不是股票，别套「红涨绿跌」那套。
  const dHtml = '<i class="gpt-d ' + (d >= 0 ? 'up' : 'down') + '">' +
    (d >= 0 ? '↑ ' : '↓ ') + Math.abs(d).toFixed(2) + '</i>';

  box.innerHTML = '<div class="gpt-hd"><span>绩点趋势</span>' + dHtml + '</div>' +
    '<div class="gpt-bars">' + rows.map((r) =>
      '<div class="gpt-col"><b>' + r.gpa.toFixed(2) + '</b>' +
      '<div class="gpt-track"><i style="height:' +
        Math.max(4, Math.round(r.gpa / top * 100)) + '%"></i></div>' +
      '<span>' + esc(r.label) + '</span></div>').join('') + '</div>';
}

/** 分数读成数字；等级制（优秀/良好）读不出来，返回 NaN 排到最后。 */
function scoreNum(c) {
  const n = parseFloat(c.final || c.score);
  return isNaN(n) ? NaN : n;
}

function renderGrades() {
  const hasData = !!(DATA && DATA.grades && DATA.grades.courses && DATA.grades.courses.length);
  $('grEmpty').hidden = hasData;
  $('grBody').hidden = !hasData;
  if (!hasData) {
    // 🔴 空态有三种，别混成一句「还没有成绩数据」（原来那句子还催人去绑定，
    //    已经绑定的人看了只会以为自己没绑上）：
    //    ① 没绑账号 ② 绑了、但确实还没出分 ③ 读失败，原因照实写。
    //    新生第一学期走的永远是 ②，而 2026-11-01 之前后端把它当成了
    //    「登录态过期」，人连绑定都过不去 —— 所以这里必须说清楚是「没有分」。
    const g = (DATA && DATA.grades) || null;
    const bound = !!(DATA && DATA.profile && DATA.profile.studentId) || BOUND;
    const h = $('grEmpty').querySelector('h2');
    const p = $('grEmpty').querySelector('p');
    const btn = $('goBind2');
    if (!bound) {
      h.textContent = '还没有成绩数据';
      p.textContent = '绑定账号后会自动同步一次。';
      if (btn) btn.hidden = false;
    } else if (g && g.error) {
      h.textContent = '这次没读到成绩';
      p.textContent = '课表、考试这些都正常，只有成绩这一块没取到：' + g.error;
      if (btn) btn.hidden = true;
    } else {
      h.textContent = '还没有成绩';
      p.textContent = '可能是还没出分 —— 期中、期末的成绩不是一次全出来的。出分后会自动同步，不用再绑一次。';
      if (btn) btn.hidden = true;
    }
    return;
  }

  const g = DATA.grades;
  const o = g.overall || {};
  $('grGpa').textContent = o.gpa || '—';
  $('grCredits').textContent = o.credits || '—';
  $('grCount').textContent = o.count || '—';

  renderGpaTrend(g);

  // 学期筛选条。教务系统给的是「2025-2026 1」，学生认的是「大一上」——
  // 用户 2026-10-19 明确提过：别再摆学年编号。
  // key 保留原样（成绩记录的 term 字段就是它），只换显示的文字。
  const terms = (g.summary || []).map((s) => {
    const key = s.year + ' ' + s.term;
    const y = /^(\d{4})/.exec(String(s.year || ''));
    const gl = y ? gradeName(Number(y[1]), Number(s.term)) : '';
    return { key: key, label: gl || key };
  });
  const chips = [{ key: 'all', label: '全部' }].concat(terms);
  $('grChips').innerHTML = chips.map((t) =>
    '<button class="chip' + (gradeTerm === t.key ? ' on' : '') + '" data-term="' + esc(t.key) + '">' +
    esc(t.label) + '</button>').join('');
  $('grChips').querySelectorAll('.chip').forEach((b) => {
    b.addEventListener('click', () => {
      gradeTerm = b.dataset.term;
      gradeShowN = 5;      // 换了学期，首屏重新从 5 门开始
      renderGrades();
    });
  });

  // 排序按钮的文字就是当前状态 —— 不用再猜「现在按什么排的」
  const sb = $('grSort');
  if (sb) {
    sb.textContent = GRADE_SORTS[gradeSort] || GRADE_SORTS[0];
    sb.classList.toggle('on', gradeSort !== 0);
  }

  let list = g.courses.filter((c) => gradeTerm === 'all' || c.term === gradeTerm);

  const q = gradeFind.trim().toLowerCase();
  if (q) {
    list = list.filter((c) =>
      (String(c.name || '') + ' ' + String(c.code || '')).toLowerCase().indexOf(q) >= 0);
  }

  if (gradeSort === 1) {
    // 等级制读不出分数的排最后（不是当 0 分排最前）
    list = list.slice().sort((a, b) => {
      const x = scoreNum(a), y = scoreNum(b);
      if (isNaN(x) && isNaN(y)) return 0;
      if (isNaN(x)) return 1;
      if (isNaN(y)) return -1;
      return y - x;
    });
  } else if (gradeSort === 2) {
    list = list.slice().sort((a, b) =>
      (parseFloat(b.credit) || 0) - (parseFloat(a.credit) || 0));
  }

  // 计划里有没有这门课。有 ⇒ 不打标签（必修/选修副行里本来就写着）；
  // 没有 ⇒ 打「计划外」，因为那正是「总学分和进度对不上」的原因。
  const pidx = planIndex();
  const hasPlan = pidx.size > 0;

  // 0.33.0：首屏只铺前 `gradeShowN` 门（默认 5），多的收在「还有 N 门」后面。
  // 🔴 只截**渲染**：会话统计（`list.length`）和下面的空态判断仍按全量算。
  const shown = list.slice(0, gradeShowN);

  $('grList').innerHTML = (shown.map((c) => {
    const score = c.final || c.score || '';
    const num = parseFloat(score);
    let cls = '';
    if (!isNaN(num)) cls = num >= 85 ? ' s-good' : (num >= 60 ? ' s-mid' : ' s-bad');
    const hit = hasPlan ? pidx.get(String(c.code || '').trim()) : undefined;
    // nature 缺了就退回计划里的「是否必修」，再退就什么都没有 ——
    // 宁可少写一行，也不猜一个「必修」出来。
    const nature = c.nature || c.category ||
      (hit && hit.pc ? (hit.pc.required ? '必修课' : '选修课') : '');
    let tag = '';
    if (hasPlan) {
      if (!hit) tag = '<i class="gitag out">计划外</i>';
      else if (hit.sub) tag = '<i class="gitag sub">替代</i>';
    }
    const meta = [esc(c.credit) + ' 学分', nature ? esc(nature) : '']
      .filter(Boolean).join(' · ') + tag;
    return '<div class="gradeitem">' +
      '<div class="gi-main"><div class="gi-name">' + esc(c.name) + '</div>' +
      '<div class="gi-meta">' + meta + '</div></div>' +
      '<div class="gi-score' + cls + '"><b>' + esc(score) + '</b><span>绩点 ' + esc(c.gpa) + '</span></div>' +
      '</div>';
  }).join('') || ('<div class="gradeitem"><div class="gi-main"><div class="gi-meta">' +
    (q ? '没搜到「' + esc(gradeFind.trim()) + '」' : '这个学期没有成绩记录') +
    '</div></div></div>')) +
    (list.length > shown.length
      ? '<button class="cx-more" id="grMore">还有 ' + (list.length - shown.length) +
        ' 门没显示</button>'
      : '');
  if ($('grMore')) {
    $('grMore').addEventListener('click', () => { gradeShowN = 9999; renderGrades(); });
  }
}

// ------------------------------------------------------------------ 学分进度

/** 一门课算不算「过了」。
 *
 *  返回 true / false / null（null = 成绩还没出来，不知道）。
 *  🔴 别把「没有成绩」当成「没过」：那会让「这学期正在上的课」全部
 *     跳进「挂科」名单里，一开学就看见红字。
 */
function passedOf(g) {
  if (!g) return null;
  const raw = String(g.final || g.score || '').trim();
  if (!raw) return null;
  const n = parseFloat(raw);
  if (!isNaN(n)) return n >= 60;
  // 等级制成绩：优秀/良好/中等/及格 算过，不及格/缺考/缓考 不算
  if (/不及格|未通过|缺考|旷考|作弊/.test(raw)) return false;
  if (/优秀|良好|中等|及格|合格|通过|优|良|中/.test(raw)) return true;
  return null;   // 认不出的写法：不猜，当「不知道」处理
}

/** 把培养计划和成绩对起来，算出毕业学分进度。
 *
 *  为什么要这么小心（三个口径必须分开，混一起就会算出跟学校不一样的数）：
 *    应修 = 培养计划的「全程总计」，学校自己写的那个数（比如 164）
 *    已修 = 计划内的课里，**成绩及格**的那些的「计划学分」
 *    在读 = 课表里有、成绩里还没有的（这学期正在上，不能算已修）
 *
 *  挂科的**不进已修** —— 挂了的学分不算修到，这是常识，也是重修制度的依据。
 *  但它也不能凭空消失，所以单独列出来。
 *
 *  还有两类容易被漏掉的：
 *    - 替代课程：培养计划第二张表列了「线性代数 ↔ 高等代数」这种关系。
 *      学生修的是高等代数，如果不认这条，就会误报「你缺线性代数」。
 *    - 计划外的课：选修课、转专业多修的。这些成绩里有、计划里没有。
 *      算进已修会让主数字虚高（还可能超过某一类的应修），
 *      所以**不算进进度**，单独说一句「另外还修了 X 学分」。
 */
function creditProgress() {
  const plan = (DATA && DATA.plan) || null;
  const g = (DATA && DATA.grades) || null;
  const out = {
    ok: false, why: '',
    total: 0, done: 0, doing: 0, failedCredit: 0,
    cats: [], failed: [], missing: [], doingCourses: [], extra: [],
    extraCredit: 0, subUsed: [], catSum: 0,
  };

  if (!plan || !plan.courses || !plan.courses.length) {
    out.why = (plan && plan.error) || '还没同步到培养计划';
    return out;
  }
  if (!g || !g.courses || !g.courses.length) {
    out.why = '还没同步到成绩，没法算已修学分';
    return out;
  }

  // 同一门课可能有多条成绩（重修）。取分数高的那条 ——
  // 学校判断「过没过」也是这个口径。
  const byCode = {};
  g.courses.forEach((c) => {
    const k = String(c.code || '').trim();
    if (!k) return;
    const prev = byCode[k];
    if (!prev) { byCode[k] = c; return; }
    const a = parseFloat(prev.final || prev.score);
    const b = parseFloat(c.final || c.score);
    if (isNaN(a) || (!isNaN(b) && b > a)) byCode[k] = c;
  });

  // 替代关系：原课 → 替代课
  const subTo = {};
  (plan.subs || []).forEach((s) => { subTo[s.from.code] = s.to.code; });

  // 课表里这学期正在上的课
  //
  // 🔴 这里必须读 **DATA.courses**，不能读 `curTT().courses`：
  //    「正在上」按定义就是教务系统当前那一学期。用户翻到「大一上」看历史课表时，
  //    那学期的课早就考完了，拿它算「在读学分」会把学分进度整个算错
  //    （已修的课被算成在读，已修学分凭空少一大块）。
  const doing = {};
  (DATA.courses || []).forEach((c) => {
    if (c.code) doing[String(c.code).trim()] = c;
  });

  const catMap = {};
  const catOf = (name) => {
    if (!catMap[name]) {
      catMap[name] = { name: name, need: 0, done: 0, doing: 0, failed: 0, cnt: 0, cntDone: 0 };
    }
    return catMap[name];
  };
  (plan.cats || []).forEach((c) => { catOf(c.name).need = c.credit; });

  const planCodes = {};

  plan.courses.forEach((pc) => {
    planCodes[pc.code] = 1;
    // 分类取第一层（「个性化课程 / 专业选修课」归到「个性化课程」）
    const st = catOf(String(pc.cat || '').split(' / ')[0].trim() || '其他');
    st.cnt++;

    const hit = byCode[pc.code];
    const subCode = subTo[pc.code];
    const subHit = subCode ? byCode[subCode] : null;

    const pass = hit ? passedOf(hit) : (subHit ? passedOf(subHit) : null);
    const rec = hit || subHit;

    if (pass === true) {
      st.done += pc.credit; st.cntDone++; out.done += pc.credit;
      if (!hit && subHit) {
        out.subUsed.push({ plan: pc, by: subHit });
      }
      return;
    }
    if (pass === false) {
      st.failed++; out.failedCredit += pc.credit;
      out.failed.push({ plan: pc, grade: rec });
      return;
    }
    // pass === null：要么没修过，要么成绩还没出
    if (doing[pc.code]) {
      st.doing += pc.credit; out.doing += pc.credit;
      out.doingCourses.push(pc);
      return;
    }
    if (rec) {
      // 有成绩记录但分数读不出来（等级制写法没见过）⇒ 不算已修，
      // 但也不能说成「没修」，单独归到「待确认」
      out.missing.push({ plan: pc, grade: rec, unsure: true });
      return;
    }
    out.missing.push({ plan: pc, grade: null, unsure: false });
  });

  // 计划外的课（成绩里有、计划里没有）
  g.courses.forEach((c) => {
    const k = String(c.code || '').trim();
    if (k && planCodes[k]) return;
    const p = passedOf(c);
    if (p !== true) return;
    out.extra.push(c);
    out.extraCredit += parseFloat(c.credit) || 0;
  });

  out.total = plan.total || 0;
  out.cats = Object.keys(catMap).map((k) => catMap[k]);
  // 各类小计之和 vs 全程总计：教务系统有时不给「通识选修课」小计
  // （郑航 2026 级就是：各类加起来 160，总计写 164，差的那 4 学分
  //   是「通用选修课 4 学分」，只写在备注里）。差多少要说出来，不能装作没有。
  out.catSum = out.cats.reduce((s, c) => s + (c.need || 0), 0);
  out.ok = out.total > 0;
  if (!out.ok) out.why = '培养计划里没读到「全程总计」，可能页面结构变了';
  return out;
}

let creditOpen = {};   // 哪些分类是展开的

function renderCredit() {
  const hasPlan = !!(DATA && DATA.plan && DATA.plan.courses && DATA.plan.courses.length);
  const hasGrade = !!(DATA && DATA.grades && DATA.grades.courses && DATA.grades.courses.length);
  const p = creditProgress();
  const bound = !!(DATA && DATA.profile && DATA.profile.studentId);

  $('crEmpty').hidden = p.ok;
  $('crBody').hidden = !p.ok;
  if (!p.ok) {
    const t = $('crEmptyTitle'), d = $('crEmptyText');
    if (!bound) {
      t.textContent = '还没绑定账号';
      d.textContent = '绑定教务处账号后，会自动同步培养计划和成绩，算出还差多少学分毕业。';
    } else if (!hasPlan) {
      t.textContent = '培养计划没取到';
      // 0.39.1：「这是附加信息」是在替用户判断要不要在意，去掉；
      // 留「不影响课表和成绩」—— 这句才是他会担心的。
      d.textContent = p.why + '。不影响课表和成绩。';
    } else if (!hasGrade) {
      t.textContent = '还没有成绩';
      d.textContent = '没有成绩就没法算已修学分。点右上角刷新试试。';
    } else {
      t.textContent = '算不出进度';
      d.textContent = p.why;
    }
    $('goBind5').hidden = bound;
    return;
  }

  const pct = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0;
  const n = (x) => (Math.round(x * 100) / 100).toString();

  let html = '<div class="crhero">' +
    '<div class="crhero-top"><b>' + n(p.done) + '</b><span>/ ' + n(p.total) + ' 学分</span>' +
    '<i>' + (Math.round(pct * 10) / 10) + '%</i></div>' +
    '<div class="crbar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
    '<div class="crhero-sub">' +
    (p.doing > 0 ? '这学期在读 ' + n(p.doing) + ' 学分，考完才算数。' : '按培养计划的课逐门对出来的。') +
    '</div>' +
    // 🔴 计划外的课不算进进度（算了会让数字虚高，还可能超过某一类的应修），
    //    但用户去教务系统一看是 46.5、这里是 45.5，一定会觉得算错了。
    //    所以差多少要当场说清楚，别让他自己猜。
    (p.extraCredit > 0
      ? '<div class="crhero-sub">教务系统那边统计的是 ' + n(p.done + p.extraCredit) +
        ' 学分 —— 比这里多的 ' + n(p.extraCredit) + ' 学分是计划外的课，见下面。</div>'
      : '') +
    '</div>';

  // 分类
  html += '<div class="crcats">';
  p.cats.forEach((c) => {
    const cp = c.need > 0 ? Math.min(100, (c.done / c.need) * 100) : 0;
    const full = c.need > 0 && c.done >= c.need;
    html += '<div class="crcat' + (full ? ' full' : '') + '">' +
      '<div class="crcat-top"><span class="crcat-n">' + esc(c.name) + '</span>' +
      '<span class="crcat-v">' + n(c.done) + '<em>/' + n(c.need) + '</em></span></div>' +
      '<div class="crcat-bar"><i style="width:' + cp.toFixed(1) + '%"></i></div>' +
      '<div class="crcat-meta">' + c.cntDone + ' / ' + c.cnt + ' 门' +
      (c.doing > 0 ? ' · 在读 ' + n(c.doing) + ' 学分' : '') +
      (c.failed > 0 ? ' · <span class="crcat-bad">' + c.failed + ' 门没过</span>' : '') +
      '</div></div>';
  });
  html += '</div>';

  // 各类小计对不上总计，要说出来
  if (p.catSum > 0 && Math.abs(p.catSum - p.total) >= 0.01) {
    html += '<div class="crnote">上面各类加起来是 ' + n(p.catSum) + ' 学分，' +
      '总计写的是 ' + n(p.total) + '。差的那 ' + n(p.total - p.catSum) +
      ' 学分教务系统没单列（郑航是通识选修课的额度），不是算漏了。</div>';
  }

  // 挂科
  if (p.failed.length) {
    html += '<div class="crcard crcard-bad"><div class="crcard-h">' +
      '<span class="crcard-t">没过的课</span>' +
      '<span class="crcard-n">' + p.failed.length + ' 门 · ' + n(p.failedCredit) + ' 学分</span></div>' +
      p.failed.map((x) => {
        const sc = String((x.grade && (x.grade.final || x.grade.score)) || '').trim();
        return '<div class="crline"><span class="crline-n">' + esc(x.plan.name) + '</span>' +
          '<span class="crline-v">' + esc(sc || '—') + ' 分</span></div>';
      }).join('') +
      '<div class="crcard-f">这些学分没算进上面。重修过了会自动加回去。</div></div>';
  }

  // 在读
  if (p.doingCourses.length) {
    html += '<div class="crcard"><div class="crcard-h">' +
      '<span class="crcard-t">这学期在上</span>' +
      '<span class="crcard-n">' + p.doingCourses.length + ' 门 · ' + n(p.doing) + ' 学分</span></div>' +
      p.doingCourses.map((c) => '<div class="crline"><span class="crline-n">' + esc(c.name) + '</span>' +
        '<span class="crline-v muted">' + n(c.credit) + ' 学分</span></div>').join('') +
      '<div class="crcard-f">还没出成绩，考完并及格才会加进进度。</div></div>';
  }

  // 未修
  if (p.missing.length) {
    const open = !!creditOpen.missing;
    html += '<div class="crcard"><div class="crcard-h crtoggle" id="crMissToggle">' +
      '<span class="crcard-t">还没修的</span>' +
      '<span class="crcard-n">' + p.missing.length + ' 门 <i class="crarrow' + (open ? ' on' : '') + '">›</i></span></div>';
    if (open) {
      // 按建议学期分组：学生看的是「我这学期/下学期该修什么」
      const byTerm = {};
      p.missing.forEach((m) => {
        const ts = (m.plan.terms && m.plan.terms.length) ? m.plan.terms : [0];
        ts.forEach((t) => {
          const k = t || 0;
          (byTerm[k] = byTerm[k] || []).push(m);
        });
      });
      Object.keys(byTerm).sort((a, b) => Number(a) - Number(b)).forEach((k) => {
        const label = Number(k) > 0 ? '第 ' + k + ' 学期' : '未标学期';
        html += '<div class="crgroup">' + label + '</div>';
        byTerm[k].forEach((m) => {
          html += '<div class="crline"><span class="crline-n">' + esc(m.plan.name) +
            (m.unsure ? ' <em class="crline-q">成绩读不出来</em>' : '') + '</span>' +
            '<span class="crline-v muted">' + n(m.plan.credit) + ' 学分</span></div>';
        });
      });
    }
    html += '<div class="crcard-f">按培养计划的「建议修读学期」分组，不代表必须在那一学期修。</div></div>';
  }

  // 替代课程
  if (p.subUsed.length) {
    html += '<div class="crcard"><div class="crcard-h">' +
      '<span class="crcard-t">按替代课程算的</span></div>' +
      p.subUsed.map((x) => '<div class="crline"><span class="crline-n">' + esc(x.plan.name) + '</span>' +
        '<span class="crline-v muted">修的是 ' + esc(x.by.name || '') + '</span></div>').join('') +
      '<div class="crcard-f">培养计划里给了替代关系，这两门互相顶。</div></div>';
  }

  // 计划外的
  if (p.extra.length) {
    html += '<div class="crcard"><div class="crcard-h">' +
      '<span class="crcard-t">计划外修的</span>' +
      '<span class="crcard-n">' + p.extra.length + ' 门 · ' + n(p.extraCredit) + ' 学分</span></div>' +
      '<div class="crcard-f">这些课不在培养计划里（选修、转专业多修的），' +
      '学分没算进上面。</div></div>';
  }

  $('crBody').innerHTML = html;

  const t = $('crMissToggle');
  if (t) {
    t.addEventListener('click', () => {
      creditOpen.missing = !creditOpen.missing;
      renderCredit();
    });
  }
}


// ------------------------------------------------------------------ 考试

/** 从「2026-10-25」「2026/10/25」「2026年10月25日」里抠出 Date。
 *
 *  抠不出来返回 null。学校换个日期写法是常事，这里宁可显示原文，
 *  也别在界面上出现 "Invalid Date" 或者悄悄算成 1970 年。
 */
function examDate(s) {
  const m = /(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** 学校用「未安排」占位：`时间未安排`、`地点未安排`、`座位未安排`。
 *
 *  这些值一律当空处理 —— 否则详情里会出现「地点 地点未安排」
 *  「座位 地点未安排」这种把占位符原样念一遍的行（2026-10-19 实测）。
 */
function blankField(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return true;
  return /^(时间|地点|考场|座位|周次|考试)?\s*未安排$/.test(s);
}

/* ---------------- 考试加进手机日历 ----------------
 *
 * 用户 2026-10-20 提的：逐场倒计时有了，但还得自己抄到日历里设提醒。
 *
 * 同一份「事件」数据，两条落地的路：
 *   APK  → NativeApi.addCalendar(...) → 拉起系统日历的「新建事件」界面，
 *          时间/地点/备注都填好，用户确认一下保存。
 *   网页 → 生成 .ics 下载，双击或导入都能进日历。
 *
 * 🔴 只有**能算出真实开始时间**的场次才给按钮。
 *    学校对没排时间的场次写「时间未安排」，那种加进日历只会多一个
 *    不知道该放哪天的事件 —— 与其给个坏按钮，不如不给。
 *    有日期、没时间的（学校只给了日期）算**全天事件**，至少提醒那天有考试。
 */

/** 从 "09:00-11:00" / "14:30~16:10" / "09:00" 里取起止分钟数。
 *
 *  只认 `时:分` 这种带冒号的写法：日期里的 "2026-10-21" 不会被误当成时间。
 *  取不到返回 null；只给了一个时间时，结束按 +120 分钟算。
 */
function parseArrange(s) {
  const hits = String(s || '').match(/\d{1,2}\s*[:：]\s*\d{2}/g) || [];
  if (!hits.length) return null;
  const at = (t) => {
    const a = t.split(/[:：]/);
    const h = Number(a[0]);
    const mi = Number(a[1]);
    if (!(h >= 0 && h < 24) || !(mi >= 0 && mi < 60)) return null;
    return h * 60 + mi;
  };
  const b = at(hits[0]);
  if (b === null) return null;
  let e = hits.length > 1 ? at(hits[1]) : null;
  // 结束早于或等于开始 = 学校把时间写反了（或者只给了开始）⇒ 兜底两小时。
  // 别让日历里出现「16:30 到 14:30」这种负长度的场次。
  if (e === null || e <= b) e = Math.min(b + 120, 23 * 60 + 59);
  return { b, e };
}

/** 一场考试 → 日历事件。翻译不出来返回 null（界面上就不出现按钮）。 */
function examEvent(e) {
  const d = examDate(e.date);
  if (!d) return null;
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const t = parseArrange(e.arrange);
  const lines = [];
  if (!blankField(e.seat)) lines.push('座位 ' + String(e.seat).trim());
  if (!blankField(e.form)) lines.push('形式 ' + String(e.form).trim());
  if (!blankField(e.category)) lines.push('类型 ' + String(e.category).trim());
  if (!blankField(e.code)) lines.push('课程号 ' + String(e.code).trim());
  if (!blankField(e.note)) lines.push('说明 ' + String(e.note).trim());
  lines.push('来自「航院通」，以教务系统为准');
  return {
    title: '考试：' + String(e.name || '未命名课程').trim(),
    desc: lines.join('\n'),
    loc: blankField(e.room) ? '' : String(e.room).trim(),
    begin: t ? day + t.b * 60000 : day,
    end: t ? day + t.e * 60000 : day + 86400000,
    allDay: !t,
  };
}

/** 毫秒 → iCalendar 的 UTC 时间戳（20261021T013000Z）。 */
function icsStamp(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
    'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
}

/** 毫秒 → 本地日期（20261021）。全天事件用日期而不是时刻。 */
function icsDay(ms) {
  const d = new Date(ms);
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

/** 文本值里的特殊字符必须转义，否则日历软件解析会断在半截。 */
function icsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** 生成一份只含一场考试的 .ics。
 *
 *  🔴 行尾必须是 CRLF（RFC 5545 硬性要求），用 \n 拼出来有些日历会整份不认。
 */
function icsText(ev) {
  const uid = 'exam-' + icsDay(ev.begin) + '-' +
    String(ev.title).replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '').slice(0, 24) +
    '@hangyuantong';
  const L = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HangYuanTong//Exam//CN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + icsStamp(Date.now()),
  ];
  if (ev.allDay) {
    // 全天事件的 DTEND 是**不含**的，所以结束要往后推一天
    L.push('DTSTART;VALUE=DATE:' + icsDay(ev.begin));
    L.push('DTEND;VALUE=DATE:' + icsDay(ev.begin + 86400000));
  } else {
    L.push('DTSTART:' + icsStamp(ev.begin));
    L.push('DTEND:' + icsStamp(ev.end));
  }
  L.push('SUMMARY:' + icsEsc(ev.title));
  if (ev.loc) L.push('LOCATION:' + icsEsc(ev.loc));
  L.push('DESCRIPTION:' + icsEsc(ev.desc));
  L.push('BEGIN:VALARM');
  L.push('TRIGGER:-PT12H');          // 前一天晚上提醒一次，考试当天早上能看见
  L.push('ACTION:DISPLAY');
  L.push('DESCRIPTION:' + icsEsc(ev.title));
  L.push('END:VALARM');
  L.push('END:VEVENT');
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}

/** 网页版：把 .ics 下载下来。 */
function downloadIcs(ev) {
  const base = String(ev.title).replace(/^考试[:：]\s*/, '');
  const name = ('航院通-' + base + '-' + icsDay(ev.begin))
    .replace(/[\\/:*?"<>|]/g, '_') + '.ics';
  const blob = new Blob([icsText(ev)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  toast('已下载 ' + name + '，用日历打开即可');
}

/** 点「加进日历」的落地动作：APK 走原生，网页走下载。 */
function addExamToCalendar(ev) {
  const nat = (NATIVE && window.NativeApi &&
    typeof window.NativeApi.addCalendar === 'function') ? window.NativeApi : null;
  if (nat) {
    const r = String(nat.addCalendar(ev.title, ev.desc, ev.loc,
      ev.begin, ev.end, !!ev.allDay) || '');
    if (r === '') {
      toast('已打开日历，确认一下时间就能保存');
      return;
    }
    // 'none' = 这个版本的壳没有日历能力（老 APK），退回去下载 .ics
    if (r !== 'none') {
      toast('打不开日历：' + r.replace(/^fail[:：]\s*/, ''), 3500);
      return;
    }
  }
  downloadIcs(ev);
}

/** 列表里的按钮是每次重画出来的，所以用事件委托，只绑一次。 */
$('exList').addEventListener('click', (e) => {
  if (!e.target.closest) return;
  // 0.35.0：已考完那一段默认是收着的，点一下展开（再点收起）
  if (e.target.closest('#exFold')) {
    examPastOpen = !examPastOpen;
    renderExams();
    return;
  }
  const btn = e.target.closest('.excal');
  if (!btn) return;
  const it = examItems[Number(btn.dataset.i)];
  if (!it) return;
  const ev = examEvent(it.e);
  if (ev) addExamToCalendar(ev);
});

/** 考试列表。
 *
 *  🔴 空态必须分三种，不能一律说「没有考试」：
 *     ① 没绑账号 —— 让他去绑；
 *     ② 学校还没排考（published=false）—— 是**学校没发**，不是我们漏了；
 *     ③ 取数出错 —— 把错误原话摆出来，别装成「没有」。
 *     把「没读到」说成「没有」，就是在把错误说成事实。
 *
 *  选学期之后还要多分一种：**这一学期**没排考 ≠ 所有学期都没排考，
 *  文案里必须点出是哪一学期，否则用户会以为整个软件都没有考试数据。
 */

/** 选学期用的 chip 列表。
 *
 *  教务系统给 53 个学期，全摆出来没法看。只留「他读过 / 正在读」的：
 *  入学年之后、且不晚于当前学期。未来的学期一定没有考试，摆出来是空按钮。
 *
 *  🔴 一个都筛不出来时返回空数组，界面退回「只看当前学期」，
 *     绝不硬编几个假学期糊上去 —— 点进去是空的，比没有按钮更让人困惑。
 */
function studyTerms() {
  const ex = (DATA && DATA.exams) || null;
  const raw = (ex && ex.semesters) || [];
  // ⚠️ 边界必须是**教务系统的当前学期**，不能图省事用 semesterName()：
  //    那个在看历史学期时会返回历史学期名，列表就被截到那一年之前 ——
  //    用户正在看的那一学期自己反倒不在列表里，选完回不去。
  const cur = academicTerm(DATA && DATA.semester);
  const y0 = enrolledYear();
  const out = [];
  const seen = {};
  raw.forEach((s) => {
    const a = termParts(s && s.name);
    if (!a || !s.id || seen[s.id]) return;
    if (a.y > cur.y || (a.y === cur.y && a.s > cur.s)) return;   // 还没开学
    if (y0 && a.y < y0) return;                                  // 入学之前
    seen[s.id] = 1;
    out.push({ id: s.id, name: s.name, y: a.y, s: a.s,
      label: gradeName(a.y, a.s) || s.name });
  });
  out.sort((a, b) => (a.y - b.y) || (a.s - b.s));
  return out;
}

/** 考试页的学期 chip 列表 = 在读的那几个学期（和课表页共用一份筛选）。 */
function examTerms() {
  return studyTerms();
}

/** 某一学期的考试数据：当前学期用同步下来的那份，其余查缓存。 */
function examBucket(sid) {
  const ex = (DATA && DATA.exams) || null;
  const curId = (ex && ex.semesterId) || '';
  if (!sid || sid === curId) return ex;
  return ((DATA && DATA.examsBySem) || {})[sid] || null;
}

function renderExamChips(terms) {
  const box = $('exChips');
  if (!box) return;
  if (terms.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = terms.map((t) =>
    '<button class="chip' + (t.id === examTerm ? ' on' : '') +
    '" data-sid="' + esc(t.id) + '">' + esc(t.label) + '</button>').join('');
  box.querySelectorAll('.chip').forEach((b) => {
    b.addEventListener('click', () => selectExamTerm(b.dataset.sid));
  });
}

/* ---------------- 学习 / 考试 / 成绩 / 学分 ----------------
 *
 * 成绩原来单独占一个底部 tab。用户 2026-10-19 的原话：
 *   「查询成绩使用的频率比较低，不需要单独列出」
 * 一学期也就期末看几次，占着一个常驻入口不值当 —— 并进考试页，
 * 上面一个分段切换，底部 tab 从五个回到四个。
 *
 * 2026-10-22 用户又说：
 *   「学习通功能可以跟考试合并，就叫学习，进入这个界面后先展示学习通，
 *    其他的考试学分什么的放到什么的选项里」
 * ⇒ 底部 tab 改叫「学习」，分段多出第一项「学习通」，且是默认视图。
 *   名字跟着高频的那个走：考试一学期看几次，学习通天天要看。
 *
 * 🔴 选中的视图记进 CFG（`examView`）：连着看成绩的那几天，
 *    不该每次进来都先点一下「成绩」。默认是「学习通」。
 */
const EX_VIEWS = ['cx', 'exam', 'grade', 'credit'];
const EX_HEAD = { cx: '学习', exam: '考试', grade: '成绩', credit: '学分' };

function renderExamView() {
  const v = EX_VIEWS.indexOf(CFG.examView) >= 0 ? CFG.examView : 'cx';
  EX_VIEWS.forEach((k) => {
    const el = $('exView' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.hidden = (k !== v);
  });
  $('exHead').textContent = EX_HEAD[v] || '学习';
  $('exSeg').querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === v);
  });
  if (v === 'cx') cxPaint();
  if (v === 'grade') renderGrades();
  if (v === 'credit') renderCredit();
}

function setExamView(v) {
  CFG.examView = EX_VIEWS.indexOf(v) >= 0 ? v : 'cx';
  store.set(KEY.settings, CFG);
  renderExamView();
}

$('exSeg').querySelectorAll('.seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.view === (CFG.examView || 'cx')) return;
    setExamView(b.dataset.view);
  });
});

function renderExams() {
  const ex = (DATA && DATA.exams) || null;
  const curId = (ex && ex.semesterId) || '';
  const terms = examTerms();
  if (!examTerm) examTerm = curId;
  // 选中的学期不在列表里（换了账号、学期列表变了）⇒ 回到当前学期
  if (terms.length && !terms.some((t) => t.id === examTerm)) examTerm = curId;
  renderExamChips(terms);
  renderPrefetchHint();

  const bucket = examBucket(examTerm);
  const list = (bucket && bucket.exams) || [];
  const has = list.length > 0;
  const err = (bucket && bucket.error) || EXAM_ERR[examTerm] || '';
  // 只有「正在取的就是选中这个学期」才算 loading
  const loading = examLoading && examLoadingSid === examTerm && !bucket;
  const cur = !examTerm || examTerm === curId;
  const pick = terms.find((t) => t.id === examTerm);
  const which = pick ? pick.label : '';

  $('exLoading').hidden = !loading;
  $('exEmpty').hidden = has || loading;
  $('exBody').hidden = !has;

  if (!has) {
    if (loading) return;
    const bound = !!(DATA && DATA.profile && DATA.profile.studentId);
    const title = $('exEmptyTitle');
    const text = $('exEmptyText');
    $('goBind3').hidden = bound;
    $('exRetry').hidden = !(bound && err);
    if (!bound) {
      title.textContent = '还没绑定账号';
      text.textContent = '绑定教务处账号后，会自动同步这个学期的考试安排。';
    } else if (err) {
      title.textContent = which ? (which + '的考试没取到') : '考试安排没取到';
      text.textContent = '教务系统那边出了点问题：' + err;
    } else if (!cur) {
      title.textContent = which ? (which + '没有考试安排') : '这一学期没有考试安排';
      text.textContent = '教务系统里这个学期没有排考数据。换一个学期看看？';
    } else {
      title.textContent = '学校还没发布考试安排';
      // 0.39.1：原来这句后半截是「这不是漏同步 —— 等学校排好考，点右上角刷新
      // 就有了」。前半截是在解释**我们的同步没坏**，用户没怀疑过这件事；
      // 后半截才是他要做的。留后半截（「点右上角刷新」给了动作）。
      text.textContent = '等学校排好考，点右上角刷新。';
    }
    return;
  }

  // 有日期的按日期排，没日期的排最后（保持原顺序，别打乱）
  const items = list.map((e, i) => ({ e, d: examDate(e.date), i }));
  items.sort((a, b) => {
    if (a.d && b.d) return (a.d - b.d) || (a.i - b.i);
    if (a.d) return -1;
    if (b.d) return 1;
    return a.i - b.i;
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const next = items.find((x) => x.d && x.d >= today);

  // 选中的是不是**已经过完**的学期。
  // 🔴 这一条决定了「待定」还是「已结束」：大一下整体都过去了，
  //    里面那门「认识实习」学校写的是「时间未安排」—— 整学期不能因此
  //    显示成「还有考试没定日期」（用户 2026-10-19 直接指出来了）。
  // ⚠️ 边界用 DATA.semester（教务的当前学期），不能用 semesterName()：
  //    课表页翻到历史学期时它会返回历史学期名，于是所有考试都会被算成「未来学期」。
  const curT = academicTerm((DATA && DATA.semester) || '');
  const isPastTerm = !!(pick && (pick.y < curT.y || (pick.y === curT.y && pick.s < curT.s)));

  let sum = '<div class="exsum-main"><span>共</span><b>' + items.length + '</b><span>场考试</span></div>';
  if (next) {
    // 用「日期相减 / 一天毫秒数」而不是小时数：跨夏令时也不至于差 1 天
    const days = Math.round((next.d - today) / 86400000);
    // 「3 天」+「后最近一场」分两行读起来是断的（后 / 最近一场）。
    // 改成「3 天后」+「最近一场」，两行各自成句。
    sum += '<div class="exsum-side"><b>' + (days === 0 ? '今天' : days + ' 天后') + '</b>' +
      '<span>最近一场</span></div>';
  } else if (!isPastTerm && items.some((x) => !x.d)) {
    // 当前/未来学期里有没定日期的场次，才叫「待定」
    sum += '<div class="exsum-side"><b>待定</b><span>还有考试没定日期</span></div>';
  } else {
    sum += '<div class="exsum-side"><b>已结束</b><span>都是过去的考试</span></div>';
  }
  $('exSummary').innerHTML = sum;

  const row = (k, v) => (blankField(v) ? '' :
    '<div class="exrow"><i>' + k + '</i><span>' + esc(v) + '</span></div>');

  const built = items.map(({ e, d }, idx) => {
    // 过去的学期里每一场都算过去（包括学校没给日期的那场）
    const past = isPastTerm || (d && d < today);
    // 学校对没排时间的场次会直接写「时间未安排」，照它的说法显示，
    // 别一律写「待定」—— 那会让人以为还没定、还有机会安排。
    const md = d ? (d.getMonth() + 1) + '/' + d.getDate()
      : (/未安排|未定/.test(String(e.date || '')) ? '未安排' : '待定');
    const wd = d ? '周' + DAY_CN[(d.getDay() + 6) % 7] : '';
    // 逐场倒计时。顶上那条汇总只说「最近一场还有几天」，
    // 但一个学期常有四五场，谁近谁远得一场一场看 —— 否则得自己拿日期减。
    // 已考完的不写「-5 天」：那既不是倒计时也不好看，整张卡本来就压暗了。
    const leftDays = d ? Math.round((d - today) / 86400000) : null;
    const leftTxt = leftDays === null || leftDays < 0 ? ''
      : (leftDays === 0 ? '今天' : leftDays === 1 ? '明天' : leftDays + '天后');
    // 三天以内用强调色：再远的天天标红，整列都在喊，反而看不出哪个最急。
    const leftHtml = leftTxt
      ? '<i class="excd' + (leftDays <= 3 ? ' soon' : '') + '">' + leftTxt + '</i>' : '';
    const meta = [e.category, e.form, e.code].filter(Boolean).join(' · ');
    let rows = row('时间', e.arrange);
    rows += row('地点', e.room);
    rows += row('座位', e.seat);
    // 没日期时才把「考试周次与星期」拿出来当参考，有日期就不重复占地方
    if (!d) rows += row('周次', e.weekText);
    rows += row('情况', e.status);
    rows += row('说明', e.note);

    // 能算出真实时间的场次才给「加进日历」；没日期的（学校写「时间未安排」）
    // 加进去只会多一个不知道该放哪天的事件。已经考完的也不给 —— 加进去干嘛。
    const canCal = !past && !!examEvent(e);
    if (canCal) {
      rows += '<button class="excal" data-i="' + idx + '" type="button">加进日历</button>';
    }

    return { past: past, html: '<div class="exitem' + (past ? ' past' : '') + '">' +
      '<div class="exdate' + (d ? '' : ' txt') + '"><b>' + esc(md) + '</b>' +
      (wd ? '<span>' + wd + '</span>' : '') + leftHtml + '</div>' +
      '<div class="exmain">' +
      '<div class="exname">' + esc(e.name) + '</div>' +
      (meta ? '<div class="exmeta">' + esc(meta) + '</div>' : '') +
      rows +
      '</div></div>' };
  });

  // ---- 0.35.0：考完的收起来 ----
  // 一个学期常见的形状是「接下来 3 场、已经考过 9 场」。那 9 场一直铺在
  // 下面，把「下一场什么时候」压到需要滑屏才看得到 —— 而来看这一页的人
  // 关心的就是接下来考什么。收成一行按钮，点开照旧逐条看，一个字都不删。
  // 🔴 两种情况不收：
  //    ① 这个学期整段都在过去（用户主动切回来翻旧账，收起来等于什么都没有）
  //    ② 一场都没剩（全考完了，那这些就是他来看的东西）
  const ahead = built.filter((x) => !x.past);
  const gone = built.filter((x) => x.past);
  if (!ahead.length) {
    $('exList').innerHTML = gone.map((x) => x.html).join('');
  } else {
    $('exList').innerHTML = ahead.map((x) => x.html).join('') +
      (gone.length
        ? '<button class="exfold" id="exFold" aria-expanded="' +
            (examPastOpen ? 'true' : 'false') + '">' +
            '<span>已考完 ' + gone.length + ' 场</span>' +
            '<i>' + (examPastOpen ? '收起' : '展开') + '</i></button>' +
          (examPastOpen ? gone.map((x) => x.html).join('') : '')
        : '');
  }
  examItems = items;
}

/** 点了某一学期的 chip。缓存里有就直接画，没有就去教务系统取。 */
function selectExamTerm(sid) {
  if (!sid) return;
  examTerm = sid;
  // 换学期 ⇒ 「已考完」回到收着的状态。不然上个学期展开着，
  // 切过来直接铺开一屏旧考试，看着像切换没生效。
  examPastOpen = false;
  renderExams();                       // 先把选中态画出来，别等请求回来才高亮
  if (!examBucket(sid) && !EXAM_ERR[sid]) loadExamTerm(sid);
}

/** 取某一学期的考试安排。
 *
 *  🔴 取失败**不能**安静地画成「没有考试」：把原因记进 EXAM_ERR，
 *     界面显示「这一学期的考试没取到 + 原因」，还留一个「再试一次」。
 *     缓存只存成功的（DATA.examsBySem 落盘），失败只在内存里，
 *     下次进考试页会重新试一遍。
 */
async function loadExamTerm(sid) {
  if (!sid) return;
  // 单飞：一次只发一个请求，别把学校服务器打成并发的。
  // 取数期间又点了别的学期就记下来，这一次结束再补。
  if (examLoading) { examPending = sid; return; }
  examLoading = true;
  examLoadingSid = sid;
  renderExams();
  try {
    const res = await api('/api/exams', { semesterId: sid });
    if (res && res.ok) {
      delete EXAM_ERR[sid];
      const rec = {
        exams: res.exams || [],
        published: !!res.published,
        semesterId: res.semesterId || sid,
        at: Math.floor(Date.now() / 1000),
      };
      if (DATA) {
        DATA.examsBySem = DATA.examsBySem || {};
        DATA.examsBySem[sid] = rec;
        store.set(KEY.data, DATA);
      }
    } else {
      EXAM_ERR[sid] = (res && res.error) || '教务系统没给数据';
    }
  } catch (e) {
    EXAM_ERR[sid] = e.message || String(e);
  } finally {
    examLoading = false;
    examLoadingSid = '';
    renderExams();
    // 取的过程中用户又点了别的学期 ⇒ 接着取那个
    const next = examPending;
    examPending = '';
    if (next && next !== sid && !examBucket(next) && !EXAM_ERR[next]) loadExamTerm(next);
  }
}

// ------------------------------------------------------------------ 后台补取考试

/** 补取进度提示。
 *
 *  为什么要有：绑定后会把「他在读的每一学期」的考试都提前拉一遍，这个过程
 *  几秒到十几秒。不说一声的话，用户切学期时看到的那一下等待就是没来由的。
 */
function renderPrefetchHint() {
  const el = $('exPrefetch');
  if (!el) return;
  if (!prefetching || !prefetchTotal) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = '正在提前取其他学期的考试 · ' + prefetchDone + '/' + prefetchTotal;
}

/** 停掉正在跑的补取（解绑、清缓存时用）。不调的话那一轮会继续往
 *  已经清空的 DATA 里写，而且进度条会挂在「还没绑定账号」的页面上。 */
function cancelPrefetch() {
  prefetchTok++;
  prefetching = false;
  prefetchTotal = 0;
  prefetchDone = 0;
  renderPrefetchHint();
}

/** 把「他在读的每一学期」的考试都提前取一遍，存进 examsBySem。
 *
 *  用户 2026-10-19：「首次绑定账号后直接把咱们软件能同步的东西全给同步了吧，
 *  比如考试信息，不然看考试信息还得在对应页面上等半天。」
 *
 *  整份同步本来就带**当前学期**的考试，缺的是其他学期：以前要等用户点 chip
 *  才现取，一次三四秒。这里在同步结束后按顺序补上，之后切学期就是瞬间的。
 *
 *  🔴 必须串行、且只补没缓存的：并发会把学校服务器打疼（登录那边有 3 秒防抖），
 *     而且 examsBySem 是落盘的，第二次启动一个都不用取。
 *  🔴 失败不重试、也不吞：loadExamTerm 会把原因记进 EXAM_ERR，用户切过去
 *     看到的是「没取到 + 原话 + 再试一次」，而不是「这学期没有考试」。
 */
async function prefetchExams() {
  // 先作废上一轮：换账号 / 重新同步时，旧那一轮还在跑的话必须自己退出，
  // 否则它会把上一个账号的考试写进这个账号的缓存里。
  const tok = ++prefetchTok;
  prefetching = false;
  prefetchTotal = 0;
  prefetchDone = 0;

  if (!DATA || !DATA.profile || !DATA.profile.studentId) { renderPrefetchHint(); return; }
  const terms = examTerms();
  const curId = (DATA.exams && DATA.exams.semesterId) || '';
  const todo = terms.filter((t) => t.id !== curId && !examBucket(t.id) && !EXAM_ERR[t.id]);
  if (!todo.length) { renderPrefetchHint(); return; }

  prefetching = true;
  prefetchTotal = todo.length;
  renderPrefetchHint();
  try {
    for (let i = 0; i < todo.length; i++) {
      if (tok !== prefetchTok) return;
      const sid = todo[i].id;
      // 前面可能有人在取（用户自己点了 chip）⇒ 等它落地再发下一个，绝不并发
      while (examLoading) {
        await new Promise((r) => setTimeout(r, 120));
        if (tok !== prefetchTok) return;
      }
      if (examBucket(sid) || EXAM_ERR[sid]) {
        prefetchDone++; renderPrefetchHint(); continue;
      }
      await loadExamTerm(sid);
      if (tok !== prefetchTok) return;         // 取的过程中换了账号，别动计数器
      prefetchDone++;
      renderPrefetchHint();
    }
  } finally {
    if (tok === prefetchTok) { prefetching = false; renderPrefetchHint(); }
  }
}

// ------------------------------------------------------------------ 空闲教室
//
// 数据全部来自学校教务系统的「空闲教室查询」（/eams/classroom/apply/free.action）。
// 我们只是把它的表单换成点两下就能用的样子，**不猜、不补、不缓存结果**：
// 空教室是「现在这一刻」的状态，昨天查到的今天没意义，落盘反而会骗人。
//
// 🔴 两个已知的服务端脾气（都是实测出来的，不是猜的）：
//   1. 不先摸一次 stdDetail，服务端会说 project not selected（500）；
//   2. 不传 pageSize，只回 20 行 —— 而且那 20 行是按容量升序的前 20 个，
//      全是常年空着的小实验室，换个节次换个日期看起来「一模一样」。
//   这两条在 eams.py / native.js 里已经处理掉了，界面只需要如实显示 truncated。

/** 节次块：两块一组，跟作息表对得上。学校接口收的是「第几节」。 */
/** 节次块：两节一组，跟作息表对得上。学校接口收的是「第几节」。
 *
 *  🔴 块数**不能写死**。这里以前硬编码了 6 块（1-2 … 11-12），是照「常见高校
 *     12 节」抄的 —— 郑航只有 10 节，于是界面上凭空多出一个「11-12」，
 *     用户会以为学校真有第 11、12 节课（2026-10-20 用户就是照这个问的）。
 *
 *  真值从 `curTT().unitCount` 来：它是教务系统课表 HTML 里 `unitCount = 10`
 *  直接读出来的，学校自己声明的节次数，比任何猜测都可靠（见 native.js
 *  parseTimetable）。没同步过课表时按 10 兜底。
 *
 *  节数是奇数时最后一块会退化成「9-9」（`Math.min` 夹住），学校作息都是偶数，
 *  这里只为不越界，不为好看。 */
function roomBlocks() {
  const n = Math.max(2, (DATA && curTT().unitCount) || 10);
  const out = [];
  for (let p = 1; p <= n; p += 2) out.push([p, Math.min(p + 1, n)]);
  return out;
}

const ROOM = {
  date: '',          // YYYY-MM-DD
  p1: 1, p2: 2,      // 节次区间
  typeId: '', campusId: '', buildingId: '', seats: '', name: '',
  opts: null,        // {types, campuses, buildings}
  optsErr: '',
  optsLoading: false,
  filterOpen: false,
  res: null,         // 最近一次成功的结果
  err: '',           // 最近一次失败的原话
  loading: false,
  again: false,      // 查询期间又改了条件 ⇒ 这次回来再查一遍
  tok: 0,            // 轮次号：条件变了，旧响应直接丢
  autoTried: false,  // 本次打开 App 只自动查一次
  _sig: '',          // 筛选项的结构签名，没变就不重建 DOM
};

/** 默认查「接下来那一大节」。
 *  下午四点打开 App 却默认查上午 1-2 节，等于每次都要多按一下。 */
function defaultRoomBlock() {
  const tt = times();
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  for (let i = 0; i < tt.length; i++) {
    const end = tt[i] && tt[i][1];
    if (!end) continue;
    const hm = end.split(':').map(Number);
    if (hm[0] * 60 + hm[1] > mins) {
      // 第 i 节（0 起）落在哪一大节：0,1 → 1-2；2,3 → 3-4 ……
      // 上限是作息表自己的长度，不是写死的 12（郑航只有 10 节）。
      const start = i - (i % 2) + 1;
      return [start, Math.min(start + 1, tt.length)];
    }
  }
  // 晚自习都下课了：给最后一大节（同样按节数算，不写死 9-10）。
  const bs = roomBlocks();
  return bs[bs.length - 1];
}

/** 默认查哪天：今天；今天的课都上完了就查明天。 */
function defaultRoomDate() {
  const tt = times();
  const last = tt.length ? tt[tt.length - 1][1] : '';
  let d = today0();
  if (last) {
    const hm = last.split(':').map(Number);
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() >= hm[0] * 60 + hm[1]) d = addDays(d, 1);
  }
  return ymd(d);
}

function roomInit() {
  if (ROOM.date) return;
  const b = defaultRoomBlock();
  ROOM.date = defaultRoomDate();
  ROOM.p1 = b[0];
  ROOM.p2 = b[1];
}

/** 换账号 / 清缓存：把上一次的查询结果和筛选项一起扔掉。
 *  留着别人的查询结果比留着别人的课表更糟 —— 那张表看起来完全是「现在的」。 */
function resetRooms() {
  ROOM.tok++;
  ROOM.res = null;
  ROOM.err = '';
  ROOM.loading = false;
  ROOM.again = false;
  ROOM.opts = null;
  ROOM.optsErr = '';
  ROOM._sig = '';
  ROOM.date = '';
  ROOM.autoTried = false;
  ROOM.typeId = '';
  ROOM.campusId = '';
  ROOM.buildingId = '';
  ROOM.seats = '';
  ROOM.name = '';
  renderRooms();
}

function roomDayLabel(key) {
  const d = parseYmd(key);
  return mdDot(d) + ' 周' + DAY_CN[(d.getDay() + 6) % 7];
}

function renderRoomDays() {
  const box = $('rmDays');
  if (!box) return;
  const t = today0();
  const short = [0, 1, 2].map((off) => ({ key: ymd(addDays(t, off)), label: ['今天', '明天', '后天'][off] }));
  const isShort = short.some((x) => x.key === ROOM.date);
  let html = short.map((x) =>
    '<button class="chip' + (x.key === ROOM.date ? ' on' : '') +
    '" data-day="' + x.key + '">' + x.label + '</button>').join('');
  // 「选日期」那个 chip 选中后要变成真实日期 —— 否则用户看不出自己选了哪天。
  html += '<button class="chip' + (isShort ? '' : ' on') + '" data-day="pick">' +
    (isShort ? '选日期' : esc(roomDayLabel(ROOM.date))) + '</button>';
  box.innerHTML = html;
  box.querySelectorAll('.chip').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.day === 'pick') { openRoomPicker(); return; }
      if (b.dataset.day === ROOM.date) return;      // 点的就是当前项：别白发一次请求
      ROOM.date = b.dataset.day;
      roomChanged();
    });
  });
}

function renderRoomPeriods() {
  const box = $('rmPeriods');
  if (!box) return;
  const blocks = roomBlocks();
  // 当前选中的块如果不在列表里（节数变少了，或者残留了旧的 11-12），
  // 夹回最后一个合法块 —— 否则整排按钮一个都不高亮，用户看不出自己在查哪节。
  if (!blocks.some((b) => b[0] === ROOM.p1 && b[1] === ROOM.p2)) {
    const last = blocks[blocks.length - 1];
    ROOM.p1 = last[0];
    ROOM.p2 = last[1];
  }
  box.innerHTML = blocks.map((b) =>
    '<button class="chip' + (b[0] === ROOM.p1 && b[1] === ROOM.p2 ? ' on' : '') +
    '" data-p1="' + b[0] + '" data-p2="' + b[1] + '">' + b[0] + '-' + b[1] + '</button>').join('');
  box.querySelectorAll('.chip').forEach((b) => {
    b.addEventListener('click', () => {
      const p1 = Number(b.dataset.p1), p2 = Number(b.dataset.p2);
      if (p1 === ROOM.p1 && p2 === ROOM.p2) return;
      ROOM.p1 = p1;
      ROOM.p2 = p2;
      roomChanged();
    });
  });
}

function roomFilterSummary() {
  const o = ROOM.opts || {};
  const pick = (list, id) => {
    const x = (list || []).find((i) => i.id === id);
    return x ? x.name : '';
  };
  const parts = [];
  const campus = pick(o.campuses, ROOM.campusId);
  const bld = pick(o.buildings, ROOM.buildingId);
  const typ = pick(o.types, ROOM.typeId);
  if (campus) parts.push(campus);
  if (bld) parts.push(bld);
  if (typ) parts.push(typ);
  if (ROOM.seats) parts.push('≥' + ROOM.seats + ' 座');
  if (ROOM.name) parts.push('「' + ROOM.name + '」');
  return parts.length ? parts.join(' · ') : '不限';
}

function renderRoomFilter() {
  const box = $('rmFilterBox');
  if (!box) return;
  box.hidden = !ROOM.filterOpen;
  $('rmFilterIco').style.transform = ROOM.filterOpen ? 'rotate(90deg)' : '';
  $('rmFilterSum').textContent = roomFilterSummary();

  // 结构没变就只同步值。整块重建会打断正在操作的输入框，
  // 也会让「刚选好的教学楼」在重画后跳回第一项。
  const sig = JSON.stringify([ROOM.opts, ROOM.optsErr, ROOM.optsLoading]);
  if (sig === ROOM._sig) {
    syncRoomFilterValues();
    return;
  }
  ROOM._sig = sig;

  if (!ROOM.opts) {
    if (ROOM.optsLoading) {
      box.innerHTML = '<div class="rmfilter-err">正在读取筛选项…</div>';
      return;
    }
    // 🔴 筛选项取不到**不影响查询**，别把整页弄成不可用；
    //    但也别装作「本来就没有筛选项」—— 把原因原话摆出来。
    box.innerHTML = '<div class="rmfilter-err">筛选项没取到：' +
      esc(ROOM.optsErr || '未知原因') + '。直接查也能用，只是不能按楼筛。</div>' +
      '<button class="btn block" id="rmOptsRetry">重试</button>';
    $('rmOptsRetry').addEventListener('click', () => loadRoomOptions(true));
    return;
  }

  // 三个筛选项都是「点一行 → 弹层里挑一个」，不再是原生 <select>
  const row = (id, label) =>
    '<button class="rmpick" id="' + id + '">' +
    '<span class="k">' + label + '</span>' +
    '<span class="v muted" id="' + id + 'V">不限</span>' +
    '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' +
    '</button>';

  box.innerHTML =
    row('rmCampus', '校区') +
    row('rmBuilding', '教学楼') +
    row('rmType', '教室类型') +
    '<label class="rmfield"><span>至少能坐（人）</span>' +
    '<input id="rmSeats" type="number" inputmode="numeric" ' +
    'placeholder="不限" value="' + esc(ROOM.seats) + '"></label>' +
    // 一次能查出七百多间，靠滚动找某间教室不现实 —— 给个按名字找的口子。
    '<label class="rmfield rm-wide"><span>教室名（可只写一部分，如 01B）</span>' +
    '<input id="rmName" type="text" placeholder="不限" value="' + esc(ROOM.name) + '"></label>';

  const o = ROOM.opts;
  const anyGroup = (list) => [{ items: [{ id: '', name: '不限' }].concat(list || []) }];

  $('rmCampus').addEventListener('click', async () => {
    const v = await openPick('校区', '先选校区，教学楼是全校的', anyGroup(o.campuses), ROOM.campusId);
    if (v === null || v === ROOM.campusId) return;
    ROOM.campusId = v;
    roomChanged();
  });

  $('rmBuilding').addEventListener('click', async () => {
    const v = await openPick('教学楼', '按楼号排；南区和各区字母楼放在「其他」',
      roomBuildingGroups(o.buildings), ROOM.buildingId);
    if (v === null || v === ROOM.buildingId) return;
    ROOM.buildingId = v;
    roomChanged();
  });

  $('rmType').addEventListener('click', async () => {
    const v = await openPick('教室类型', '', anyGroup(o.types), ROOM.typeId);
    if (v === null || v === ROOM.typeId) return;
    ROOM.typeId = v;
    roomChanged();
  });

  $('rmSeats').addEventListener('change', () => {
    // 只留数字：服务端认的是纯数字，输个「50人」过去它会当没填。
    ROOM.seats = String($('rmSeats').value || '').replace(/\D/g, '');
    roomChanged();
  });
  $('rmName').addEventListener('change', () => {
    ROOM.name = String($('rmName').value || '').trim();
    roomChanged();
  });

  syncRoomFilterValues();
}

/** 把当前选中的名字刷到那三行上（没选就写「不限」并变灰）。 */
function syncRoomFilterValues() {
  const o = ROOM.opts || {};
  const name = (list, id) => {
    const x = (list || []).find((i) => i.id === id);
    return x ? x.name : '';
  };
  const put = (id, text) => {
    const el = $(id + 'V');
    if (!el) return;
    el.textContent = text || '不限';
    el.classList.toggle('muted', !text);
  };
  put('rmCampus', name(o.campuses, ROOM.campusId));
  put('rmBuilding', name(o.buildings, ROOM.buildingId));
  put('rmType', name(o.types, ROOM.typeId));
  const s = $('rmSeats');
  if (s && s.value !== ROOM.seats) s.value = ROOM.seats;
  const n = $('rmName');
  if (n && n.value !== ROOM.name) n.value = ROOM.name;
}

/* 教学楼分两组：
 *   「按楼号」—— 名字形如「08楼」「3号楼」，**按数字从小到大**排。
 *               学校返回的顺序是乱的（06/09/08/07/05/02/01…），不排的话
 *               找一个楼得把整列读一遍。
 *   「其他」  —— 南区A座 / 南区实验楼 / 工程实训中心 / A / B / C 这些不是楼号的。
 *               ⚠️ A/B/C 在教务系统里是**独立的楼栋 ID**，删掉它们大学路校区
 *               那些教室就再也筛不出来了，所以收在「其他」里而不是丢掉。
 */
function roomBuildingGroups(list) {
  const num = [];
  const other = [];
  (list || []).forEach((x) => {
    const m = /^0*(\d+)\s*(?:号)?楼$/.exec(String(x.name || '').trim());
    if (m) num.push({ id: x.id, name: x.name, n: parseInt(m[1], 10) });
    else other.push(x);
  });
  num.sort((a, b) => a.n - b.n);
  // 「其他」里也要有个固定次序：字母楼（A/B/C）→ 南区/东区这类带方位的 → 其余。
  // 纯按名字排的话 ICU 的中文排序会把「南区实验楼」排到 A 前面，看着像乱序。
  const rank = (n) => {
    const s = String(n || '');
    if (/^[A-Za-z]+$/.test(s)) return '0' + s;
    if (/^[东南西北]/.test(s)) return '1' + s;
    return '2' + s;
  };
  other.sort((a, b) => rank(a.name).localeCompare(rank(b.name), 'zh-Hans-CN', { numeric: true }));
  return [
    { items: [{ id: '', name: '不限' }] },
    { title: '按楼号', items: num },
    { title: '其他', items: other },
  ];
}

function renderRoomResult() {
  $('rmLoading').hidden = !ROOM.loading;
  $('rmErrCard').hidden = !ROOM.err;
  if (ROOM.err) $('rmErrText').textContent = ROOM.err;

  const r = (!ROOM.err && ROOM.res) || null;
  $('rmResult').hidden = !r;
  // 没查过、没出错、也没在查 ⇒ 显示「选好点查询」的引导
  $('rmFirst').hidden = !!(r || ROOM.err || ROOM.loading);
  if (!r) return;

  // 学校是按容量**升序**返回的：一屏下来全是 6 座的小实验室/储藏室，
  // 而人问「哪儿能自习」要的是大教室。所以按容量从大到小排。
  // 相同容量保持学校原来的顺序（sort 是稳定的）。
  // ⚠️ 两条必须挡住的坑（2026-10-19 用真数据看到的）：
  //   1. 「公用资源」那一类根本不是教室（办公室、国际教学办、
  //      「请联系任课老师」「无卷开放考试」这类占位条目），
  //      容量写 900~9999。按容量排会把它们全顶到第一屏。→ 一律排最后。
  //   2. 9999 是「不限额」的占位值，当容量参与排序没有意义 → 按 0 算。
  const isPublic = (x) => (x.type || '') === '公用资源';
  const capOf = (x) => (x.capacity && x.capacity < 2000 ? x.capacity : 0);
  const rooms = (r.rooms || []).slice().sort((a, b) =>
    (isPublic(a) - isPublic(b)) || (capOf(b) - capOf(a)));
  const notice = r.notice || [];
  const d = parseYmd(r.dateBegin || ROOM.date);
  const w = '周' + DAY_CN[(d.getDay() + 6) % 7];
  const pTxt = r.periodBegin === r.periodEnd
    ? '第 ' + r.periodBegin + ' 节'
    : '第 ' + r.periodBegin + '-' + r.periodEnd + ' 节';
  const head = mdDot(d) + ' ' + w + ' · ' + pTxt;

  $('rmSum').innerHTML = rooms.length
    ? esc(head) + ' · 空闲 <b>' + rooms.length + '</b> 间'
    : esc(head) + ' · <b>没有</b>空闲教室';

  // 「停课」这种行：学校塞在结果表里的状态，不是教室。
  // 单独说一句，别让它变成一间叫「停课」的教室，也别悄悄吞掉。
  // 「这一节可能不排课」只在真的一间都没有时才说 —— 明明有 199 间还这么讲就是瞎猜。
  const nb = $('rmNotice');
  nb.hidden = !notice.length;
  if (notice.length) {
    nb.textContent = '学校在结果里标了「' + notice.join('、') +
      '」，那不是教室，已经跳过。' + (rooms.length ? '' : '这一节可能本来就不排课。');
  }

  $('rmList').innerHTML = rooms.map((x) => {
    const meta = [x.building, x.type, x.campus].filter(Boolean).join(' · ');
    // 三种容量要分开说：有数、学校没给（0）、学校写的是「不限」（9999）。
    // 把 9999 原样画出来，屏幕上就是一排「9999 座」，看着像算错了。
    const cap = x.capacity >= 2000
      ? '<span>容量不限</span>'
      : (x.capacity ? '<b>' + x.capacity + '</b><span>座</span>' : '<span>容量未知</span>');
    return '<div class="rmitem"><div class="rm-main">' +
      '<div class="rm-name">' + esc(x.name) + '</div>' +
      (meta ? '<div class="rm-meta">' + esc(meta) + '</div>' : '') +
      '</div><div class="rm-cap">' + cap + '</div></div>';
  }).join('');

  // 截断要说清楚：不然「全校就这 200 间」会被当成事实。
  const tr = $('rmTrunc');
  tr.hidden = !r.truncated;
  if (r.truncated) {
    tr.textContent = '还有教室没列出来。加个「筛选」（校区 / 教学楼 / 至少能坐几人）能缩小范围。';
  }
}

function renderRooms() {
  const bound = !!(DATA && DATA.profile && DATA.profile.studentId);
  $('rmEmpty').hidden = bound;
  $('rmMain').hidden = !bound;
  if (!bound) return;
  roomInit();
  renderRoomDays();
  renderRoomPeriods();
  renderRoomFilter();
  renderRoomResult();
}

/** 条件变了：先重画选中态，停手 320ms 再真去查。
 *  连着点「今天→明天→后天」时，中间的日期不该各打一次学校服务器。 */
let roomTimer = 0;
function roomChanged() {
  renderRooms();
  clearTimeout(roomTimer);
  roomTimer = setTimeout(() => { if (DATA) queryRooms(); }, 320);
}

function openRoomPicker() {
  const inp = $('rmDate');
  inp.value = ROOM.date;
  // 老 WebView 没有 showPicker()，退回 click()；两个都不行的话
  // 至少把日期框留在那儿（用户还能手动改）。
  try {
    if (typeof inp.showPicker === 'function') { inp.showPicker(); return; }
  } catch (e) { /* 落到下面 */ }
  try { inp.click(); } catch (e) { /* 什么都不做 */ }
}

async function loadRoomOptions(force) {
  if (!DATA || ROOM.optsLoading) return;
  if (ROOM.opts && !force) return;
  ROOM.optsLoading = true;
  ROOM.optsErr = '';
  renderRooms();
  try {
    const r = await api('/api/room-options');
    if (r && r.ok) {
      const o = { types: r.types || [], campuses: r.campuses || [], buildings: r.buildings || [] };
      // 三个下拉全空 = 学校没给，等于没有筛选项；说成「不限」是在骗人。
      if (!o.types.length && !o.campuses.length && !o.buildings.length) {
        ROOM.opts = null;
        ROOM.optsErr = '学校没返回筛选项';
      } else {
        ROOM.opts = o;
      }
    } else {
      ROOM.opts = null;
      ROOM.optsErr = (r && r.error) || '没取到筛选项';
    }
  } catch (e) {
    ROOM.opts = null;
    ROOM.optsErr = e.message || envText('连不上电脑上的服务', '连不上教务系统，检查一下网络再试');
  } finally {
    ROOM.optsLoading = false;
    renderRooms();
  }
}

async function queryRooms() {
  if (!DATA) { toast('先绑定账号'); return; }
  // 单飞：查询期间又改了条件，只记一个「等会儿再查」，绝不并发打学校服务器。
  if (ROOM.loading) { ROOM.again = true; return; }
  const tok = ++ROOM.tok;
  ROOM.loading = true;
  ROOM.err = '';
  renderRooms();
  try {
    const res = await api('/api/free-rooms', {
      date: ROOM.date,
      periodBegin: ROOM.p1,
      periodEnd: ROOM.p2,
      campusId: ROOM.campusId,
      buildingId: ROOM.buildingId,
      typeId: ROOM.typeId,
      seats: ROOM.seats,
      name: ROOM.name,
    });
    if (tok !== ROOM.tok) return;            // 条件已经换了，这份结果作废
    if (!res || !res.ok) {
      ROOM.res = null;
      ROOM.err = (res && res.error) || '查询失败';
      return;
    }
    ROOM.res = res;
    ROOM.err = '';
  } catch (e) {
    if (tok !== ROOM.tok) return;
    ROOM.res = null;
    ROOM.err = e.message || envText('连不上电脑上的服务', '连不上教务系统，检查一下网络再试');
  } finally {
    if (tok === ROOM.tok) {
      ROOM.loading = false;
      renderRooms();
      if (ROOM.again) { ROOM.again = false; queryRooms(); }
    }
  }
}

// ------------------------------------------------------------------ 我的

function renderMe() {
  // 版本号在 HTML 里只留一个占位（「—」），真值从 APP_VERSION 来。
  // 写死在 HTML 里的话，改版本号就会漏掉这一处。
  $('meVersion').textContent = 'v' + APP_VERSION;
  const bound = !!(DATA && DATA.profile && DATA.profile.studentId);
  $('meBound').hidden = !bound;
  $('meUnbound').hidden = bound;
  // 有数据但本机没存住凭据 ⇒ 提示重新输入密码。
  // 只认 BOUND === false（问过、且确实没有）；null（还没问到 / 服务没开）不提示，
  // 否则开 App 的瞬间会闪一下这条警告。
  $('reauthCard').hidden = !(bound && BOUND === false);
  if (bound && BOUND === false) {
    // 🔴 「从来没存上」和「存着但解不开」是两件事，得说两套话。
    //    混成一句「密码没保存」，在第二种情况下就是在说假话 ——
    //    密文明明在文件里，只是密钥被系统重置了。
    const broken = CRED_STATE === 'broken';
    $('reauthHead').textContent = broken ? '密码还在，但解不开了' : '需要重新输入密码';
    $('reauthSub').textContent = broken
      ? '存着的密码读不出来了（换过手机、系统升级或清过 App 数据会这样）。再输一次就行，之后会一直记住。'
      : '课表成绩还在，但密码没存住，每次打开都要再输一次。';
    $('reauthTip').textContent = CRED_ERR ? ('上次没存住的原因：' + CRED_ERR) : '';
  }

  // 账号管理那一行的摘要：三套系统里连上了几个。
  // 这里给一个数，而不是「查看」—— 一行里右边那个位置要么说事、要么空着。
  //
  // 🔴 这一段**必须在 `if (!bound) return` 之前**。
  //    账号管理里除了三个学校系统还有慧生活（接水/积分），
  //    没绑教务的人照样能进去、照样可能连了学习通和门户。
  //    原来写在 return 之后 ⇒ 没绑教务的人这一行永远是 HTML 里那个「—」，
  //    而页面看上去一切正常（没人报错，只是那句话一直不出现）。
  //
  // 🔴 口径必须走 accState()，不能在这儿再判一遍 CAMPUS.state。
  //    上一版就是这儿自己写了一遍 `state === 'ok' || 'expired'`，
  //    结果改 accState() 的时候这个数字不跟着变 —— 同一屏两个「连了几个」
  //    给出不同答案，而且不报错。
  const accSt = accState();
  const nAcc = ['jw', 'cx', 'portal']
    .filter((k) => accSt[k] === 'on' || accSt[k] === 'expired').length;
  // 🔴 0.38.0：原来写「已连 N / 3」。用户 2026-11-01 指出这看着像账号上限
  //    （「咱们现在已经能绑定不止三个账号了，但页面上还是显示 3/3」）——
  //    账号管理里其实有 5 个位置：教务 / 学习通 / 门户 + 慧生活的设备、积分。
  //    分母只有 3 个学校系统，写出来就是**一个不存在的上限**。
  //    ⇒ 去掉分母，只说连了几个。0 个时别写「已连 0 个」，那是句废话。
  $('meAccounts').textContent = nAcc ? ('已连 ' + nAcc + ' 个') : '还没连';

  if (!bound) return;

  const p = DATA.profile;
  $('meAvatar').textContent = (p.name || '?').slice(0, 1);
  $('meName').textContent = p.name || '—';
  $('meMeta').textContent = (p.className || '') + (p.major ? ' · ' + p.major : '');

  // 个人信息收成了一行（见 index.html 里那段注释）。
  // 右边小字只写学号 —— 名字和班级上面那张头像卡已经有了，
  // 再写一遍只会被挤成省略号。
  $('meProfileHint').textContent = p.studentId || '—';
  // 弹层正开着就顺手刷一遍，别让数据变了弹层还显示旧的
  paintProfileSheet();
  $('meSyncTime').textContent = DATA.syncedAt ? timeAgo(DATA.syncedAt) : '还没同步';
  // 「学期设置」这一行右边写「大二上 · 9.07 开学 · 24 周」。
  // 以前只写开学日期和周数，学期名（2026-2027 学年第 1 学期）只在弹层里 ——
  // 但那串编号学生自己根本不用，他认的是「大二上」。
  //
  // 🔴 这一行点进去改的是**当前学期**，所以四个值都必须取当前学期的：
  //    startDate()/totalWeeks()/gradeLabel() 在看历史学期时会返回那一学期的，
  //    而这里显示错的值 = 用户以为自己改的是历史学期。
  const curSemName = CFG.semester || (DATA && DATA.semester) || '';
  const ca = academicTerm(curSemName);
  const gl = gradeName(ca.y, ca.s);
  const curStart = CFG.startDate ? parseYmd(CFG.startDate) : defaultStart(DATA && DATA.semester);
  const curWeeks = (() => {
    const n = Math.floor(Number(CFG.weeks));
    return (n >= 1 && n <= 60) ? n : ((DATA && DATA.totalWeeks) || 20);
  })();
  $('meSemester').textContent = (gl ? gl + ' · ' : '') +
    mdDot(curStart) + ' 开学 · ' + curWeeks + ' 周';

  const tt = times();
  const first = tt.find((x) => x[0]);
  $('meTimes').textContent = CFG.times
    ? '已自定义' + (first ? '（第1节 ' + first[0] + '）' : '')
    : '默认作息，可修改';

  const hid = CFG.hidden || [];
  $('btnHidden').hidden = hid.length === 0;
  $('meHidden').textContent = hid.length + ' 门';

  // 把「按这个开学日期算，现在是第几周」直接写出来。
  // 周次是靠开学日期推的，学校实际开学日期差一周，整张课表就整体错一周 ——
  // 与其让用户自己去猜，不如把推算结果摆在眼前让他核对。
  const wk = currentWeek();
  const total = totalWeeks();
  const hint = $('startHint');
  if (wk < 1) {
    hint.textContent = '今天还没开学。日期不对就改上面那个。';
  } else if (wk > total) {
    hint.textContent = '今天是第 ' + wk + ' 周，学期已经结束。';
  } else {
    // 0.39.1：「按这个日期算」「如果跟实际周次差一周」「把日期前后挪 7 天」
    //    都是推演过程；用户只需要知道现在第几周、不对去哪儿改。
    hint.textContent = '今天是第 ' + wk + ' 周（共 ' + total + ' 周）。' +
      '周次不对就去「学期设置」改开学日期。';
  }
  renderTodo();
}

/* ---------------- 个人信息弹层 ----------------
 *
 * 「我的」页原来把 11 个学籍字段一行行铺开，滑好几屏才到底，
 * 而每天真正要看的就是最上面那张头像卡。
 * 用户 2026-10-22 的原话：「我的 界面不要拉这么长，你在前面展示的一大堆
 * 个人信息其实只需要一个 个人信息 栏就够了，点进个人信息栏查看自己的详细信息」。
 *
 * 为什么是「按需生成 HTML」而不是把那块 DOM 搬进弹层再搬回来：
 *   sheetMask 有十几处关闭入口（点遮罩、返回键、各个按钮），
 *   搬 DOM 就得在每一处都记得搬回去，漏一个那张卡就永远消失了。
 *   生成一份 HTML 没有这个隐患 —— 关掉就是关掉。
 *
 * ⚠️ 字段是「有才显示」：很多专业压根没有「方向」这一项，
 *    摆一行「—」等于专门跟用户说「这项是空的」。
 * ⚠️ 学籍状态那一项最要紧：写着「大类分流」就等于说专业还没最终定，
 *    这直接影响按哪个培养计划算学分。
 */
const PROFILE_FIELDS = [
  ['学号', (p) => p.studentId],
  ['学院', (p) => p.dept],
  ['专业', (p) => p.major],
  ['方向', (p) => p.direction],
  ['班级', (p) => p.className],
  ['校区', (p) => p.campus],
  ['性别', (p) => p.gender],
  ['年级', (p) => (p.grade ? p.grade + ' 级' : '')],
  ['学历', (p) => [p.level, p.duration ? p.duration + ' 年制' : ''].filter(Boolean).join(' · ')],
  ['学籍状态', (p) => p.status],
  ['在校时间', (p) => {
    const a = ymDot(p.enrolledAt); const b = ymDot(p.graduateAt);
    return (a && b) ? (a + ' – ' + b) : '';
  }],
];

function profileRowsHtml(p) {
  return PROFILE_FIELDS.map((f) => {
    let v = '';
    try { v = String(f[1](p) == null ? '' : f[1](p)).trim(); } catch (e) { v = ''; }
    if (!v) return '';
    return '<div class="row"><span class="k">' + esc(f[0]) + '</span>' +
           '<span class="v">' + esc(v) + '</span></div>';
  }).join('');
}

function openProfileSheet() {
  const p = (DATA && DATA.profile) || {};
  const rows = profileRowsHtml(p);
  $('sheetBody').innerHTML =
    // data-sheet 是给 paintProfileSheet 认人的：数据一变就重画，
    // 但不能把别人开着的弹层冲掉。
    '<div data-sheet="profile">' +
    '<div class="sh-title">个人信息</div>' +
    '<div class="sh-sub">' + esc(p.name || '—') +
      (p.className ? ' · ' + esc(p.className) : '') + '</div>' +
    '<div class="card">' +
      (rows || '<p class="tip">还没同步到学籍信息，去「同步教务处数据」试一次。</p>') +
    '</div>' +
    '<p class="note">来自学校教务系统的学籍页，只做读取。</p>' +
    '</div>';
  $('sheetMask').hidden = false;
}

/** 弹层开着的时候由 renderMe 调一次，保证看到的是最新数据。 */
function paintProfileSheet() {
  const m = $('sheetMask');
  if (!m || m.hidden) return;
  // 只认「当前弹层就是个人信息」——别把课程详情之类的内容冲掉
  if (!$('sheetBody').querySelector('[data-sheet="profile"]')) return;
  openProfileSheet();
}

// ------------------------------------------------------------------ 该办的事
//
// 选课 / 评教 / 免听 / 免修：一年就开那么几次，错过要等半年，
// 而且评教不做完查不了成绩。所以专门查一遍，摆在「我的」靠上的位置。
//
// 🔴 只查状态、给入口，**绝不代替提交** —— 跟「充值和办套餐不代办」
//    是同一条规矩：写操作出错了不是重试能救的。
//
// 为什么不放进 /api/sync：这四页要打四次教务系统，学校有「别点太快」
// 的守卫，串起来十几秒。为了一个一学期才变几次的状态，让每次同步都
// 白等十几秒不值当。所以同步后**在后台**查一次，用户也可以手动刷新。

const TODO_TTL = 12 * 3600;      // 12 小时内不自动重查
// 手点「重新检查」的最小间隔。跟 TODO_TTL 是两回事：
// 缓存挡的是「正常进页面」，这个挡的是「反复戳」—— 后者会被学校 WAF 判成异常。
const CX_COOL_SEC = 90;
// ---- 自动查（0.39.0）--------------------------------------------------
//
// 用户 2026-11-01：「学习通的内容只能让用户主动发起扫描，很麻烦，
// 还很容易错过作业和考试，还有随堂练习」。
//
// 以前真的没有自动查的入口 —— 只有「登录成功后扫一次」和用户手点。
// 现在接上：进「学习」页 / 从后台切回来，只要上次扫完超过 CX_AUTO_SEC 就自己扫。
//
// 30 分钟 = 一节课。上完一节课回来看一眼，看到的必然是这节课期间发的。
// ⚠️ 别调得太短：一次全量扫描几十个请求，超星那边会限流（403）。
const CX_AUTO_SEC = 30 * 60;
// 自动查失败之后隔多久再试。
// 没有它的话，一次网络抖动会让用户**每次**进页面都撞一次失败 ——
// 而自动查是静默的，他只会觉得「怎么一进这一页就转圈」。
const CX_AUTO_RETRY = 10 * 60;
// ---- 轮询的两种「卡住」（2026-10-24）----------------------------------
//
// 🔴 为什么要有这两个数：原来 cxPoll 的 catch 里只有一句 cxStopPoll() ——
//    一次请求失败（切 WiFi / 息屏 / 后端正好在忙）就把定时器**永久**掐掉，
//    而 CX.scan 还停在 {state:'scanning'}。之后没有任何代码会把它改回来，
//    因为改它的只有 cxPoll，而 cxPoll 已经不跑了。
//    界面上：有旧数据 ⇒ 一条永远不动的进度条；没旧数据 ⇒ 整页「正在检查…」，
//    连一个按钮都没有，唯一出路是杀掉 App 重开。
//
//    所以失败要能容忍（抖动不是故障），卡住要能判（没失败、但也没进展）。
const CX_POLL_FAIL_MAX = 3;        // 连续 3 次拿不到 /api/cx/todo 才算失联
// 单门课最坏多久：课程页 25 + 作业 25 + 考试 20 + 活动 25，加三个 1 秒间隔
// ≈ 98 秒（四个请求全超时）。刚启动时还有一段 i=0/n=0 的登录窗口（≤35 秒）。
// 取 180 秒 = 最坏情况的 1.8 倍：真的卡住三分钟内一定判得出来，
// 又不至于把「这门课特别慢」误判成卡住。
const CX_STUCK_MS = 180 * 1000;
const TODO_SHOW = {
  open: { cls: 'on', tag: '可以办' },
  closed: { cls: '', tag: '没事' },
  unknown: { cls: 'unk', tag: '状态不明' },
};
let TODO = null;                 // { at, items, error }
let todoLoading = false;

async function loadTodo(force) {
  if (todoLoading) return;
  if (!force && TODO && TODO.at && (Date.now() / 1000 - TODO.at) < TODO_TTL) return;
  todoLoading = true;
  renderTodo();
  try {
    const res = await api('/api/todo');
    if (!res.ok) {
      // 「没查到」和「查了但没开」必须分开。前者可能是网络或登录态，
      // 后者才是「没事」—— 混在一起会让人以为真没事。
      TODO = { at: 0, items: [], error: res.error || '没查到' };
    } else {
      TODO = {
        at: res.at || Math.floor(Date.now() / 1000),
        items: res.items || [],
        error: '',
      };
    }
  } catch (e) {
    TODO = { at: 0, items: [], error: e.message || String(e) };
  } finally {
    todoLoading = false;
    renderTodo();
  }
}

function renderTodo() {
  const card = $('todoCard');
  const bound = !!(DATA && DATA.profile && DATA.profile.studentId);
  card.hidden = !bound;
  if (!bound) return;

  const btn = $('todoRefresh');
  btn.disabled = todoLoading;
  // 0.33.0：按钮文案自己把「检查什么」说了（以前靠正文里一句引导语，
  // 白占 30px）。判据按 id 点，不认文案。
  btn.textContent = todoLoading ? '正在查…'
    : (TODO ? '重新查' : '检查选课评教');
  const foot = $('todoFoot');
  // 空态/加载态时这张卡只留标题一行 —— 正文那句「点右边检查」等于把
  // 按钮上写的话又说一遍，而这一页要挤进一屏。
  card.classList.toggle('bare', !TODO || todoLoading || !!TODO.error);

  if (todoLoading && !TODO) {
    $('todoList').innerHTML = '';
    foot.hidden = true;
    return;
  }
  if (!TODO) {
    $('todoList').innerHTML = '';
    foot.hidden = true;
    return;
  }
  if (TODO.error) {
    $('todoList').innerHTML = '<div class="todo-msg bad">没查到：' + esc(TODO.error) + '</div>';
    foot.hidden = true;
    return;
  }

  const items = TODO.items || [];
  if (!items.length) {
    // 「什么都没查到」这句话反而要留着：它和「还没查」是两件事，
    // 前者是查过了没东西，后者是没查过 —— 长一样就分不出来。
    card.classList.remove('bare');
    $('todoList').innerHTML = '<div class="todo-msg">这次四项都没有新消息。</div>';
    foot.hidden = true;
    return;
  }

  $('todoList').innerHTML = items.map((it) => {
    const st = TODO_SHOW[it.state] || TODO_SHOW.unknown;
    return '<div class="todo-item ' + st.cls + '">' +
      '<i class="todo-dot"></i>' +
      '<div class="todo-main">' +
      '<span class="todo-name">' + esc(it.name) + '</span>' +
      '<span class="todo-text">' + esc(it.text) + '</span>' +
      (it.detail ? '<span class="todo-detail">' + esc(it.detail) + '</span>' : '') +
      '</div>' +
      '<span class="todo-tag">' + st.tag + '</span>' +
      '</div>';
  }).join('');

  foot.hidden = false;
  foot.textContent = '查于 ' + timeAgo(TODO.at) + '。这里只显示状态，' +
    '真要办还是去教务系统 —— 提交这类操作不代劳。';
}

$('todoRefresh').addEventListener('click', () => loadTodo(true));

// 成绩页的搜索框和排序按钮只绑一次。
// 🔴 不能写在 renderGrades 里面 —— 那个函数每点一次学期 chip 就重跑一遍，
//    绑在里面会越积越多（点 5 次就有 5 个监听器）。输入框本身不会被重建，
//    所以绑一次就够，重画列表也不会丢焦点。
$('grFind').addEventListener('input', () => {
  gradeFind = $('grFind').value;
  gradeShowN = 5;        // 换了搜索词，首屏重新从 5 门开始
  renderGrades();
});
$('grSort').addEventListener('click', () => {
  gradeSort = (gradeSort + 1) % GRADE_SORTS.length;
  gradeShowN = 5;        // 换了排序，首屏重新从 5 门开始
  renderGrades();
});

function timeAgo(ts) {  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60) return '刚刚同步';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前同步';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前同步';
  return Math.floor(d / 86400) + ' 天前同步';
}

/* ---------------- 学期设置 ----------------
 *
 * 为什么单独做一个面板，而不是在「我的」里塞一个日期框：
 * 周次是靠**开学第一周的周一**推出来的，这个日期错一天，整张课表就整体错一周。
 * 所以它得让人能核对、能改、还能看见改完的结果 —— 一个孤零零的日期框做不到。
 *
 * 顺带把「总周数」也放开：教务系统给的是 `marshalTable` 的 endWeek（实测 24），
 * 但换学期、或者接口哪次没取到这个值，用户得有地方自己填，
 * 否则周次条只有一半，后半学期翻不过去。
 */
function openSemesterSheet() {
  // 🔴 这里改的永远是**当前学期**的校历，所以取默认值必须直接用 DATA / CFG，
  //    不能用 semesterName() / startDate() —— 那两个在看历史学期时会返回
  //    历史学期的名字和推算日期，一旦保存就把当前学期的设置污染了。
  //    症状很隐蔽：看完「大一上」的课表回到现在，周次整体差好几周。
  const curSem = CFG.semester || (DATA && DATA.semester) || '';
  const curStart = CFG.startDate ? parseYmd(CFG.startDate) : defaultStart(DATA && DATA.semester);
  const curWeeks = (() => {
    const n = Math.floor(Number(CFG.weeks));
    return (n >= 1 && n <= 60) ? n : ((DATA && DATA.totalWeeks) || 20);
  })();
  const cur = {
    label: curSem,
    start: ymd(curStart),
    weeks: curWeeks,
  };

  // 面板顶部先说人话：「现在是 大二上（入学年 2025）」。
  // 下面那个输入框里躺着的仍然是教务系统原文 —— 它是算开学日期的依据，不能改格式。
  const ct = academicTerm(curSem);
  const gl = gradeName(ct.y, ct.s);
  const y0 = enrolledYear();
  const head = gl
    ? '现在是 <b>' + esc(gl) + '</b>（按入学年 ' + y0 + ' 和「' +
      esc(curSem || '学期名未知') + '」算出来的）'
    : '「第几周」按开学第一周的周一算。';

  $('sheetBody').innerHTML =
    '<div class="sh-title">学期设置</div>' +
    '<div class="sh-sub">' + head + '</div>' +
    '<div class="setrows">' +
      '<label class="setrow"><span class="sk">学期（教务系统原文）</span>' +
        '<input class="setinput" id="setName" type="text" autocomplete="off" ' +
        'value="' + esc(cur.label) + '" placeholder="例如 2026-2027 学年 第一学期"></label>' +
      '<label class="setrow"><span class="sk">开学第一周的周一</span>' +
        '<input class="setinput" id="meStartDate" type="date" value="' + cur.start + '"></label>' +
      '<label class="setrow"><span class="sk">学期总周数</span>' +
        '<input class="setinput" id="setWeeks" type="number" min="1" max="60" ' +
        'inputmode="numeric" value="' + cur.weeks + '"></label>' +
    '</div>' +
    '<div class="setpreview" id="setPreview"></div>' +
    '<div class="sheetbtns">' +
      '<button class="btn" id="setReset">恢复默认</button>' +
      '<button class="btn primary" id="setSave">保存</button>' +
    '</div>';
  $('sheetMask').hidden = false;

  /** 边填边算，让人当场看到「按这个日期今天是第几周」。 */
  const preview = () => {
    const box = $('setPreview');
    if (!box) return;
    const s = $('meStartDate').value;
    const n = Math.floor(Number($('setWeeks').value));
    if (!s) { box.textContent = '先选一个开学日期。'; return; }
    const d = parseYmd(s);
    if (isNaN(d.getTime())) { box.textContent = '日期填得不对。'; return; }
    const diff = Math.round((today0() - d) / 86400000);
    const w = Math.floor(diff / 7) + 1;
    const total = (n >= 1 && n <= 60) ? n : 0;
    let msg;
    if (w < 1) {
      msg = '按这个日期，今天还没开学（还有 ' + (-diff) + ' 天）。';
    } else if (total && w > total) {
      msg = '按这个日期，今天是第 ' + w + ' 周，已经超过你填的 ' + total + ' 周 —— 检查一下日期或周数。';
    } else if (total) {
      msg = '按这个日期，今天是第 ' + w + ' 周（共 ' + total + ' 周，还剩 ' + (total - w) + ' 周）。';
    } else {
      msg = '按这个日期，今天是第 ' + w + ' 周（总周数填 1~60 之间）。';
    }
    box.textContent = msg;
    // 日期没落在周一，就提醒一句：不算错，但八成是选歪了
    if (d.getDay() !== 1) box.textContent += ' ⚠️ 这天不是周一。';
  };
  ['setName', 'meStartDate', 'setWeeks'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('input', preview);
    if (el) el.addEventListener('change', preview);
  });
  preview();

  $('setSave').addEventListener('click', () => {
    const name = $('setName').value.trim();
    const start = $('meStartDate').value;
    const n = Math.floor(Number($('setWeeks').value));
    if (!start) { toast('开学日期不能空'); return; }
    if (!(n >= 1 && n <= 60)) { toast('总周数请填 1~60'); return; }
    CFG.semester = name;
    CFG.startDate = start;
    CFG.weeks = n;
    // 改的是当前学期的校历 ⇒ 顺手切回当前学期，否则用户还停在历史课表上，
    // 看不到刚改的结果（还会以为没保存成功）。
    TT = null;
    CFG.week = currentWeek();          // 日期变了，当前周要跟着重算
    store.set(KEY.settings, CFG);
    $('sheetMask').hidden = true;
    renderSchedule(); renderMe();
    toast('学期设置已保存，今天是第 ' + currentWeek() + ' 周');
  });

  $('setReset').addEventListener('click', () => {
    // 恢复默认 = 把三个覆盖值全清掉，退回教务系统给的学期/日期/周数。
    // 注意 totalWeeks() 会因此重新去读 DATA.totalWeeks。
    CFG.semester = '';
    CFG.startDate = '';
    CFG.weeks = 0;
    TT = null;                          // 同上：回到当前学期看结果
    CFG.week = currentWeek();
    store.set(KEY.settings, CFG);
    $('sheetMask').hidden = true;
    renderSchedule(); renderMe();
    toast('已恢复默认（按教务系统的学期和日期）');
  });
}

$('rowSemester').addEventListener('click', openSemesterSheet);
$('rowProfile').addEventListener('click', openProfileSheet);

/* 「我的」里的校历。
   这条是给「不习惯点图标」的人准备的文字路径 —— 课表页顶部已经有入口，
   但校历那条以前是**点标题**，看不出能点。
   🔴 0.35.0：同源的「找空教室」删掉了。空教室在课表页顶部已经有一个带字
      的按钮，两处都能进只会让人猜「这是不是同一个地方」。 */
$('rowCalendar').addEventListener('click', () => switchTab('calendar'));

/* ---------------- 已隐藏的课程 ---------------- */
$('btnHidden').addEventListener('click', () => {
  const hid = CFG.hidden || [];
  if (!hid.length) return;
  let html = '<div class="sh-title">已隐藏的课程</div>' +
    '<div class="sh-sub">这些课不会出现在课表里。点「恢复」重新显示。</div>' +
    '<div class="hidlist">';
  hid.forEach((code) => {
    const c = courseByCode(code);
    const name = c ? c.name : '（这门课已不在最新数据里）';
    const sub = c ? [c.teacher, c.room].filter(Boolean).join(' · ') : '';
    html += '<div class="hidrow">' +
      '<div class="hidtxt"><div class="hidname">' + esc(name) + '</div>' +
      (sub ? '<div class="hidsub">' + esc(sub) + '</div>' : '') + '</div>' +
      '<button class="hidback" data-code="' + esc(code) + '">恢复</button>' +
      '</div>';
  });
  html += '</div>';
  $('sheetBody').innerHTML = html;
  $('sheetMask').hidden = false;
  $('sheetBody').querySelectorAll('.hidback').forEach((btn) => {
    btn.addEventListener('click', () => {
      setHidden(btn.dataset.code, false);
      $('sheetMask').hidden = true;
      toast('已恢复显示');
    });
  });
});

/* ---------------- 上课时间编辑 ---------------- */
$('btnTimes').addEventListener('click', () => {
  const tt = times();
  let html = '<div class="sh-title">上课时间</div>' +
    '<div class="sh-sub">按你们实际作息改；改完课表里会显示每节课的起止时间</div><div class="timerows">';
  tt.forEach((t, i) => {
    html += '<div class="timerow"><span class="tn">第' + (i + 1) + '节</span>' +
      '<input type="time" data-i="' + i + '" data-k="0" value="' + (t[0] || '') + '">' +
      '<span class="tdash">—</span>' +
      '<input type="time" data-i="' + i + '" data-k="1" value="' + (t[1] || '') + '"></div>';
  });
  html += '</div><div class="sheetbtns">' +
    '<button class="btn" id="timeReset">恢复默认</button>' +
    '<button class="btn primary" id="timeSave">保存</button></div>';
  $('sheetBody').innerHTML = html;
  $('sheetMask').hidden = false;

  $('timeReset').addEventListener('click', () => {
    CFG.times = null;
    store.set(KEY.settings, CFG);
    $('sheetMask').hidden = true;
    renderSchedule(); renderMe();
    toast('已恢复默认时间');
  });
  $('timeSave').addEventListener('click', () => {
    const out = [];
    $('sheetBody').querySelectorAll('input[type=time]').forEach((inp) => {
      const i = Number(inp.dataset.i), k = Number(inp.dataset.k);
      out[i] = out[i] || ['', ''];
      out[i][k] = inp.value;
    });
    CFG.times = out;
    store.set(KEY.settings, CFG);
    $('sheetMask').hidden = true;
    renderSchedule(); renderMe();
    toast('已保存');
  });
});

/* 余额提醒：阈值 + 开关。
 *
 * 2026-10-22 用户要求从「我的 → 设置」搬进「校园」页的一卡通余额卡里。
 * 原来那句「校园页是看数据的，放开关会让人以为提示能点」的判断，用户推翻了 ——
 * 想调阈值的时候人正看着余额，却要跑去另一个页面找，那才是别扭。
 * 所以现在它就在余额卡里，和它管的那个数字同屏。
 */
$('yktAlert').addEventListener('click', () => {
  const on = !!CFG.alertOn;
  const cur = Number(CFG.alertLow) > 0 ? Number(CFG.alertLow) : 20;
  $('sheetBody').innerHTML =
    '<div class="sh-title">余额提醒</div>' +
    '<div class="sh-sub">一卡通余额低于这个数时，「校园」页会提醒你。</div>' +
    '<label class="field"><span>阈值（元）</span>' +
    '<input id="alVal" type="number" inputmode="decimal" min="1" max="999" step="1" ' +
    'value="' + cur + '"></label>' +
    '<div class="sheetbtns">' +
    '<button class="btn" id="alToggle">' + (on ? '关掉提醒' : '恢复提醒') + '</button>' +
    '<button class="btn primary" id="alSave">保存</button></div>' +
    '<p class="tip" id="alTip"></p>';
  $('sheetMask').hidden = false;
  const tip = (s) => { $('alTip').textContent = s || ''; };
  $('alToggle').addEventListener('click', () => {
    CFG.alertOn = !on;
    store.set(KEY.settings, CFG);
    $('sheetMask').hidden = true;
    renderCampus(); renderMe();
    toast(CFG.alertOn ? '已开启余额提醒' : '已关掉余额提醒');
  });
  $('alSave').addEventListener('click', () => {
    const v = Number($('alVal').value);
    // 🔴 不兜底：填了个看不懂的值就说看不懂，别悄悄当成 20
    if (!isFinite(v) || v <= 0 || v > 999) { tip('填 1 到 999 之间的数'); return; }
    CFG.alertLow = v;
    CFG.alertOn = true;
    store.set(KEY.settings, CFG);
    $('sheetMask').hidden = true;
    renderCampus(); renderMe();
    toast('余额低于 ' + v + ' 元时提醒');
  });
});

/* ---------------------------------------------------------------- 账号管理
 *
 * 用户 2026-10-22：「把 教务系统，学习通，智慧门户 这些账号统一放在 我的 页面，
 * 做成 账号管理 界面」。
 *
 * 三套账号互不通用，以前散在三个地方 —— 教务在「我的」的绑定表单里、
 * 门户在「校园」的连接卡里、学习通在「学习」页里。想改某一套，
 * 得先知道它在哪儿。集中到这一屏，只回答两件事：连没连上、怎么连/怎么断。
 *
 * 🔴 这里**不重复业务入口**：作业在「学习」，余额在「校园」。
 *    上一版「我的 → 学习通」就是因为只是个快捷方式，被用户点名删掉 ——
 *    别再往这一屏塞「查看作业」之类的按钮。
 */

/** 三套系统的状态，只在这里归一，别在渲染里各判一遍。 */
function accState() {
  const bound = !!(DATA && DATA.profile && DATA.profile.studentId);
  return {
    jw: bound ? 'on' : 'off',
    // expired = 连过、门票过期。它还认这个人（身份证在），所以算「已连接」，
    // 只是要重新验一次 —— 别显示成「没连」，那会让人以为白连了。
    portal: CAMPUS.state === 'ok' ? 'on'
      : (CAMPUS.state === 'expired' ? 'expired'
        : (CAMPUS.state === 'none' ? 'off' : 'unknown')),
    cx: CX.state === 'ok' ? 'on' : (CX.state === 'none' ? 'off' : 'unknown'),
  };
}

const ACC_SYS = [
  { id: 'jw', k: '教务系统', host: 'jwglxt.zua.edu.cn' },
  { id: 'cx', k: '学习通', host: 'chaoxing.com' },
  { id: 'portal', k: '智慧门户', host: 'rhmh.zua.edu.cn' },
];

function renderAccounts() {
  const st = accState();
  const p = (DATA && DATA.profile) || {};
  // 每一行的「状态文字」和「按钮文字」。unknown 不写成「没连」——
  // 还没问到和确实没连是两件事（红线：不许把未知兜底成正常/异常）。
  const say = {
    jw: st.jw === 'on'
      ? '已绑定' + (p.name ? ' · ' + p.name : '') + (p.studentId ? ' · ' + p.studentId : '')
      : '还没绑定',
    cx: st.cx === 'on'
      ? '已登录' + (CX.user ? ' · ' + CX.user : '')
      : (st.cx === 'unknown' ? '还没查过' : '还没登录'),
    portal: st.portal === 'on'
      ? '已连接' + (CAMPUS.user ? ' · ' + CAMPUS.user : '')
      : (st.portal === 'expired' ? '已连接 · 登录过期了'
        : (st.portal === 'unknown' ? '还没查过' : '还没连接')),
  };
  const act = {
    jw: st.jw === 'on' ? '解绑' : '去绑定',
    cx: st.cx === 'on' ? '断开' : '连接',
    portal: st.portal === 'on' ? '断开' : (st.portal === 'expired' ? '重连' : '连接'),
  };
  $('accList').innerHTML = ACC_SYS.map((s) => {
    const on = st[s.id] === 'on';
    const warn = st[s.id] === 'expired';
    // 一条一个状态记号：小圆点 + 墨色文字。不用彩色胶囊 ——
    // 三行里有两行是「连着的」，彩色会把这一屏染成花布。
    return '<div class="acc-row">' +
      '<div class="acc-main">' +
      '<span class="acc-k">' + s.k + '</span>' +
      '<span class="acc-s"><i class="acc-dot' + (on ? ' on' : (warn ? ' warn' : '')) +
      '"></i>' + esc(say[s.id]) + '</span>' +
      '</div>' +
      '<button class="acc-act' + (act[s.id] === '解绑' || act[s.id] === '断开' ? ' quiet' : '') +
      '" data-acc="' + s.id + '">' + act[s.id] + '</button>' +
      '</div>';
  }).join('');
}

$('accList').addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('[data-acc]') : null;
  if (!b) return;
  const who = b.dataset.acc;
  if (who === 'jw') {
    // 未绑定时没有可解绑的东西 ⇒ 回「我的」让他在那张表单上绑
    if (accState().jw === 'on') unbindJw(); else switchTab('me');
    return;
  }
  if (who === 'cx') {
    if (CX.state === 'ok') { cxDisconnect().then(renderAccounts); return; }
    // 连接 = 去「学习」页的学习通段填账号。不在这儿再放一个登录表单 ——
    // 两个表单就是两套校验，改一处必漏一处（cxPaintLogin 已经踩过）。
    switchTab('exams');
    setExamView('cx');
    return;
  }
  if (who === 'portal') {
    if (CAMPUS.state === 'ok') { unbindPortal(); return; }
    openPortalSheet();     // expired 也是这条路：重连只要一道验证码
  }
});

$('rowAccounts').addEventListener('click', () => switchTab('accounts'));
$('accBack').addEventListener('click', () => switchTab('me'));

/* ---------------------------------------------------------------- 学习通
 *
 * 只读：不签到、不刷课、不自动答题、不代交。
 * 那些是学术诚信红线；而且超星是分级风控 —— 首次警告 → 冻结 24 小时 →
 * 灰名单要人工申诉。脚本化操作真会被封，所以这条路只走「读」。
 *
 * 为什么是「检查一次」而不是实时：
 *   学习通没有「一次拿全部作业」的接口，作业挂在每门课下面，一门一门来。
 *   32 门课 = 64 个请求 = 40~60 秒。手机上每次进页面都跑这个不现实，
 *   所以是「点了才查 → 结果缓存 → 写明更新于什么时候」。
 *
 * 🔴 三件事不能省：
 *   1. 某门课读不到要如实说「N 门没查到」，不能让它悄悄变成「没有作业」；
 *   2. 没有倒计时的作业**不等于**已过期（实测真有「未交但没倒计时」的）；
 *   3. 断开连接要连缓存一起清，否则换个人拿这手机还能看到你的作业。
 */
const CX = {
  state: null,      // null 没问过 / 'none' 没登录 / 'ok'
  user: '',
  saved: false,     // 本机存着密码
  canRelink: false, // 账号+密码都在 ⇒ 登录态过期时能一键重连，不用再输
  scan: null,       // {state:'idle'|'scanning'|'done'|'error', i, n, course, err, kind}
  data: null,       // 上次扫描结果
  // 扫描前那一份 + 「这次新查到的」key 集合。用来在列表上打「新」标。
  // 🔴 必须存在 CX 上而不是 DOM 上：cxPaint 每次重画都换掉 #cxBody 的 innerHTML，
  //    存 DOM 里的话一重画就丢（和 signOpen 同一个理由）。
  prevData: null,
  newKeys: null,
  age: -1,          // 距今多少秒。-1 = 没查过
  busy: false,
  timer: 0,
  // 上次**自动**查失败的时刻（unix 秒）。0 = 没失败过。
  // 自动查是静默的：不记这笔账的话，一次抖动会让用户每次进页面都撞一次，
  // 而他只会看到「一进这一页就转圈」，还以为是自己网络的问题。
  autoFailAt: 0,
  // 轮询的两笔账（见 CX_POLL_FAIL_MAX / CX_STUCK_MS 的注释）：
  //   pollFails —— 连续几次没拿到 /api/cx/todo，拿到一次就清零
  //   sig/sigAt —— 进度指纹，以及这个指纹第一次出现的时刻
  pollFails: 0,
  sig: '',
  sigAt: 0,
  // 签到卡的「看全部」是否展开。放在这里而不是 DOM 上：cxPaint 每次重画
  // 都会换掉 #cxBody 的 innerHTML，展开状态存在 DOM 上就丢了。
  signOpen: false,
  // 0.33.0：列表**首屏**显示几条。用户要「内容都在一页内，不用上下滑」，
  // 而这一页天生是「N 门课里的一堆待办」—— 一条 79px，十条就是 790。
  // 给前 4 条 + 一颗「还有 N 条」最诚实：默认这一屏就是最紧急的那几条。
  // 🔴 换分类 / 换分组时要重置回 5（见 cxBind），否则「看完了全部」
  //    的状态会漏到另一个分类里，表现是「换了筛选还是老长一页」。
  showN: 4,
};

function cxStopPoll() {
  if (CX.timer) { clearInterval(CX.timer); CX.timer = 0; }
}

/** 轮询自己判定「这一场已经废了」，就地落 error 态。
 *
 *  为什么要前端自己造一个 error、而不是等后端回一个：后端那个线程可能还在跑，
 *  只是**我们这边收不到**（切了网、后端重启了）。等下去就是无限等。
 *  落 error 之后界面才有出口 —— error 态本来就有「重新检查」按钮。
 */
function cxPollGiveUp(msg) {
  cxStopPoll();
  CX.scan = Object.assign({}, CX.scan || {}, { state: 'error', err: msg, kind: '' });
  // 账要清掉：不清的话下一次扫描还带着「已失联 3 次」/「上个钟头的指纹」，
  // 一开跑就立刻再判一次 —— 修 bug 引入一个更快的 bug。
  CX.pollFails = 0;
  CX.sig = '';
  CX.sigAt = 0;
  toast('检查失败：' + msg);
  renderMe();
  cxPaint();
}

/** 分钟数说人话：「3 天 5 小时」「2 小时 10 分钟」。null 返回空串。 */
/** 这一条还剩多少分钟 —— **现在**算，不用扫描时冻住的那个数。
 *
 *  为什么要有这个函数：列表页只给「还剩 2 小时 10 分钟」，所以扫描那一刻
 *  把它换算成绝对时间存进 endAt（后端 parse_work / parse_exam 做的）。
 *  之后一律从 endAt 现算 —— 否则缓存放两小时，界面上还写着「还剩 2 小时」，
 *  而下面那行「截止 15:40」已经过去了，两个数自己打架。
 *  没有 endAt（老缓存 / 页面没给倒计时）就退回 leftMin。
 *
 *  🔴 返回**可以是负数**（已经过点了）。以前这里夹到 0，于是过期作业显示成
 *     「还剩 不到 1 分钟」还标红 —— 明明已经交不了了，界面还在催。
 *     学习通把「已过截止」的作业在列表里多留一阵（state 还是 todo），
 *     再加上缓存放几天，这条很容易真被看到。调用方见 `over` 分支。
 */
function cxMinLeft(it) {
  if (!it) return null;
  if (it.endAt) return Math.round((it.endAt - Date.now() / 1000) / 60);
  return it.leftMin == null ? null : it.leftMin;
}

function cxLeft(min) {
  if (min == null) return '';
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60); const m = min % 60;
  if (h < 24) return m ? h + ' 小时 ' + m + ' 分钟' : h + ' 小时';
  const d = Math.floor(h / 24); const hh = h % 24;
  return hh ? d + ' 天 ' + hh + ' 小时' : d + ' 天';
}

/** 上次检查距今多久。 */
function cxAgo(sec) {
  if (sec == null || sec < 0) return '没查过';
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.round(sec / 3600) + ' 小时前';
  return Math.round(sec / 86400) + ' 天前';
}

async function cxRefresh(silent) {
  try {
    const st = await api('/api/cx/status');
    CX.state = st.linked ? 'ok' : 'none';
    CX.user = st.user || '';
    CX.saved = !!st.saved;          // 本机存着密码
    CX.canRelink = !!st.canRelink;  // 账号+密码都在 ⇒ 能一键重连
    CX.scan = st.scan || null;
    const t = await api('/api/cx/todo');
    CX.scan = t.scan || CX.scan;
    CX.data = t.data;
    CX.age = typeof t.age === 'number' ? t.age : -1;
    renderMe();
    return true;
  } catch (e) {
    if (!silent) toast('读不到学习通状态：' + e.message);
    return false;
  }
}

/** 进「学习」页时调用。
 *
 *  🔴 第一次进来才问后端（CX.state === null），之后切 tab 只重画 ——
 *     学习通一次状态查询要打两个接口，来回切 tab 打得太密不合适。
 *     想强制刷新有「重新检查」按钮。 */
async function cxEnter() {
  if (CX.state === null) await cxRefresh(true);
  cxPaint();
  // 🔴 自动查必须放在 cxRefresh 之后：那之前 CX.data 还是空的，
  //    判断「上次什么时候查的」会永远得出「没查过」。
  cxAutoScan();
}

/** 到点了就自己查一次（0.39.0）。返回是否真的发了这一趟。
 *
 *  什么时候调：进「学习」页、从后台切回「学习」页、登录/重连成功后。
 *
 *  🔴 三条不做的事：
 *    1. **不弹 toast**。自动查是背景行为，弹一次「正在查」比不查更烦；
 *    2. **不打断正在进行的扫描**（CX.busy / scan.state==='scanning' 直接返回）；
 *    3. **不动登录态**。CX.state !== 'ok' 就返回 —— 别把用户刚打开的
 *       登录表单顶掉，也别替他决定要不要登录。
 */
function cxAutoScan() {
  if (CX.state !== 'ok') return false;
  if (CX.busy) return false;
  if (CX.scan && CX.scan.state === 'scanning') return false;
  // 上次自动查失败了 ⇒ 隔 CX_AUTO_RETRY 再试，别每次进页面都撞一次
  const nowSec = Date.now() / 1000;
  if (CX.autoFailAt && nowSec - CX.autoFailAt < CX_AUTO_RETRY) return false;
  // 判据用「上次扫完的时刻」，不用 CX.age ——
  //   age 是服务端算好的「距今多少秒」，它不会随时间自己长；
  //   用户在别的页面待了两小时再回来，age 还停在两小时前的那个数，永远不会触发。
  const lastAt = CX.data && CX.data.at ? Number(CX.data.at) : 0;
  if (lastAt && nowSec - lastAt < CX_AUTO_SEC) return false;
  cxScanStart(false, false, true);
  return true;
}

function cxPaint() {
  const box = $('cxBody');
  if (!box) return;
  if (CX.state === null) {
    box.innerHTML = '<p class="tip">正在读学习通状态…</p>';
    return;
  }
  if (CX.state !== 'ok') { cxPaintLogin(); return; }
  cxPaintTodo();
}

// -- 未登录 --------------------------------------------------------
//
// 这里只在**从来没连过**时出现（后端的 linked 就是「本机有没有存过凭证」）。
// 「连过但登录态过期」不走这里，走 cxPaintTodo 里的「重连」按钮 ——
// 那种情况下账号密码都还在本机，让人再输一遍正是用户 2026-10-22 抱怨的事。

function cxPaintLogin() {
  $('cxBody').innerHTML =
    '<div class="card cx-login">' +
    '<h2 class="cx-h">连上学习通</h2>' +
    // 0.39.1：原来是「用你自己的账号。只读作业和截止时间 —— 不签到、不刷课、
    //    不自动答题、不代交。」那串排比是**写给我们自己安心**的，
    //    用户只需要知道一件事：登进去能看到作业，别的不会发生。
    '<p class="cx-p">登录后只读你的作业和截止时间，不会替你交，也不会刷课。</p>' +
    '<label class="field"><span>账号</span>' +
    '<input id="cxUser" type="text" inputmode="tel" autocomplete="username" ' +
      'placeholder="手机号或学号"></label>' +
    '<label class="field"><span>密码</span><span class="pwdbox">' +
    '<input id="cxPass" type="password" autocomplete="current-password" ' +
      'placeholder="学习通密码">' + pwdEyeHtml('cxPass') + '</span></label>' +
    pwdHelpHtml('cx') +
    '<button class="btn primary block" id="cxGo">连上</button>' +
    // 0.39.1：原来是「密码只用来换一次登录凭证，之后和门户密码一样加密存在
    //    这台手机里。存住以后登录态过期，点一下「重连」就行，不用再输。」
    //    —— 三句话说了一件事，还夹着「登录凭证」这种词。
    '<p class="cx-note" id="cxTip">密码只存在这台手机里。过期了点「重连」，不用重输。</p>' +
    '</div>';

  // 出错时把这行变红。默认是灰色说明 —— 一进来就红着，像在报错。
  const tip = (s, bad) => {
    const t = $('cxTip');
    if (!t) return;
    t.textContent = s || '';
    t.classList.toggle('err', !!bad);
  };

  const go = async () => {
    const user = ($('cxUser').value || '').trim();
    const pass = $('cxPass').value || '';
    // 密码可以留空（后端会用本机存的那份），账号必须填 ——
    // 后端要拿账号核对「存着的密码是不是这个人的」，对不上直接拒。
    if (!user) { tip('账号要填', true); return; }
    if (!pass) { tip('密码要填', true); return; }
    const btn = $('cxGo');
    btn.disabled = true;
    btn.textContent = '连着…';
    tip('正在登录…');
    try {
      const r = await api('/api/cx/login', { user: user, pass: pass });
      if (!r.ok) {
        // 🔴 不重试：重试会把超星的 needVcode 撞成 1，之后要人做滑块
        tip(r.error || '登录没成功', true);
        if (r.pwdStale) CX.saved = false;
        btn.disabled = false;
        btn.textContent = '连上';
        return;
      }
      CX.state = 'ok';
      CX.user = r.user || user;
      CX.saved = true;
      CX.canRelink = true;    // 刚存下的账号+密码，下次过期能一键重连
      // 密码没存住要说出来 —— 静默失败的话，用户只会觉得「怎么又要输」
      if (r.saved) toast('连上了，但密码没能存下来（' + r.saved + '），下次还要再输一次');
      renderMe();
      cxPaint();
      // 连上就直接查一次，省得用户再点一下
      cxScanStart();
    } catch (e) {
      tip('登录出错：' + e.message, true);
      btn.disabled = false;
      btn.textContent = '连上';
    }
  };
  $('cxGo').addEventListener('click', go);
  $('cxPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// -- 已登录：待办 --------------------------------------------------
//
// 两种看法，用户 2026-10-22 的原话：
//   「可以按照课程单独看其信息，也可以直接看所有课程的作业和考试，
//     按照结束时间快慢（也就是紧急程度）排序」
// ⇒ 「按紧急度」= 所有课混在一起，最急的排最前；
//    「按课程」= 先按课分堆，堆内部照样按急的排，堆之间按「这堆里最急的那条」排。
//    选哪个记进 CFG（cxGroup），下次进来还是那个。

// -- 分类（作业 / 考试 / 签到 / 讨论 / 通知）------------------------
//
// 用户 2026-10-22 的原话：
//   「学习通的作业信息也分成几种，比如主题讨论，签到信息，作业，考试」
// 后端给每条都打了 kind（见 mobile/chaoxing.py 的 KIND_BUCKET），
// 这里只负责筛选和显示。🔴 顺序和中文名跟后端 KIND_ORDER / KIND_NAME 对齐，
// 两边各写一份会漂移 —— 改一处记得搜另一处。

// 「练习」是 0.39.0 加的：随堂练习（type 42）和互动练习（68）以前落在「其他」里，
// 和「白板 / 教案 / PDF 文档」挤同一格 —— 那格是垃圾桶，真正的任务淹在里面
// 等于没提示。用户 2026-11-01 原话：「还很容易错过作业和考试，还有随堂练习」。
const CX_KINDS = ['work', 'exam', 'quiz', 'sign', 'topic', 'notice', 'other'];
const CX_KIND_NAME = {
  work: '作业', exam: '考试', quiz: '练习', sign: '签到',
  topic: '讨论', notice: '通知', other: '其他',
};

/** 一条属于哪类。
 *  🔴 0.12 及以前的数据没有 kind 字段（那时只有作业），兜底成 work ——
 *     兜成 other 会让老数据全跑到「其他」里，看着像坏了。 */
function cxKindOf(it) {
  const k = it && it.kind ? String(it.kind) : 'work';
  return CX_KINDS.indexOf(k) >= 0 ? k : 'other';
}

function cxKindCounts(items) {
  const m = { work: 0, exam: 0, sign: 0, topic: 0, notice: 0, other: 0 };
  (items || []).forEach((it) => { m[cxKindOf(it)] += 1; });
  return m;
}

/** 当前选的分类。选了个已经没数据的（比如重查后考试都考完了）就退回「全部」。 */
function cxKindFilter(items) {
  const want = CFG.cxKind || 'all';
  if (want === 'all') return 'all';
  const c = cxKindCounts(items);
  return (c[want] || 0) > 0 ? want : 'all';
}

/** 这场签到现在还能不能签。
 *
 *  `state` 是**扫描那一刻**学习通给的说法；`endAt` 才是硬证据 ——
 *  缓存放一天，昨天那场签到还写着 live。卡片和顶部那句「签到在进行」
 *  必须用同一个判据，否则会一个说「正在进行」一个说「都清了」。
 */
function cxSignOpen(it) {
  if (!it) return false;
  // 🔴 只认 live。`pending`（未开始）**不算可签** —— 还没开始就点不进去，
  //    给一个「去签到」箭头等于给一个点开是空页面的按钮。
  //    （而且 showNotStartedActive=0 让 pending 压根不会返回，见 chaoxing.py。）
  if (it.state !== 'live') return false;
  // endAt 缺失时**信任服务端的 state**，判成可签。
  // 跟南师侧不一样，是有原因的：他们的 state 是自己从 endTime 算出来的，
  // endTime 没了就没法判，只能保守算 ended；我们这边 state 直接来自
  // 服务端的 `status` 字段，endTime 只是「过点了但 status 还没翻」的二次校验。
  // 少给一个入口 = 用户可能漏签，代价比多点一个空页面大。
  if (!it.endAt) return true;
  return it.endAt * 1000 > Date.now();
}

/** 「签到」卡 —— 只**看**，不代签。
 *
 *  🔴 为什么不做「一键签到」：学习通的签到有五种形式，其中三种的「钥匙」
 *     在老师那块屏幕上（手势图案要照着画、二维码要扫、四位数字码要听），
 *     第四种要 GPS 坐标、第五种要拍照。也就是说，除了「伪造位置」这种
 *     等于替他撒谎说「人在教室」的做法，剩下的根本无从下手 —— 那不是
 *     技术难度问题，是不该做。
 *     能做的、也真有用的是：**现在有没有签到、我漏了哪几次**。
 *
 *  数据来自扫描时留下的 d.signs（含已结束的）——
 *  只留正在进行的，「查看签到」就等于什么都没查。
 */
function cxSignCardHtml(d) {
  const list = Array.isArray(d.signs) ? d.signs : [];
  if (!list.length) return '';

  // 「正在签」= 状态是 live 且 endAt 还没过。未开始的不算（点了也签不了），
  // 已经结束的更不算。
  const live = list.filter(cxSignOpen);
  // 历史 = 其余全部（含「state 还说 live、但 endAt 已经过去」的），
  // 不能只写 state !== 'live' —— 那两条都不算，这场签到就凭空消失了。
  const past = list.filter((it) => !cxSignOpen(it));
  const doneN = past.filter((it) => it.signed === true).length;
  const missN = past.filter((it) => it.signed === false).length;

  let h = '<div class="card cx-signcard">' +
    '<div class="cx-signhd"><b>签到</b>' +
    (live.length
      ? '<span class="cx-signlive">' + live.length + ' 个正在进行</span>'
      : '<span class="cx-signidle">现在没有要签的</span>') +
    '</div>';

  if (live.length) {
    h += '<div class="cx-srows">' +
      live.slice(0, 3).map((it) => cxSignRowHtml(it, false)).join('') + '</div>';
  }

  // 历史统计。🔴 一条状态都认不出来时不给「已签 0 / 漏了 0」——
  //    编个数字比不给更糟，那会让人以为真的一次没签过。
  if (doneN + missN > 0) {
    h += '<button class="cx-signtot" id="cxSignMore" aria-expanded="' +
      (CX.signOpen ? 'true' : 'false') + '">' +
      '<span>最近 ' + past.length + ' 次签到 · 已签 ' + doneN +
        (missN ? ' · 漏了 ' + missN : '') + '</span>' +
      '<i>' + (CX.signOpen ? '收起' : '看全部') + '</i></button>';
    if (CX.signOpen) {
      // 最多列 12 条。签到记录能到几十条，全铺出来会把下面的作业
      // 一路挤到屏幕外 —— 那是这个页面真正要看的东西。
      const cap = 12;
      h += '<div class="cx-srows">' +
        past.slice(0, cap).map((it) => cxSignRowHtml(it, true)).join('') + '</div>';
      if (past.length > cap) {
        h += '<p class="cx-smore">还有 ' + (past.length - cap) +
          ' 条更早的没列出来。</p>';
      }
    }
  } else if (!live.length && past.length) {
    // 有记录但状态全认不出来（学习通换了说法）—— 至少把记录本身列出来，
    // 让他自己看「已签到/未签到」那几个字。
    h += '<div class="cx-srows">' +
      past.slice(0, 8).map((it) => cxSignRowHtml(it, true)).join('') + '</div>';
  }

  return h + '</div>';
}

/** 签到卡里的一行。hist=true 是历史明细，带日期、不带箭头。 */
function cxSignRowHtml(it, hist) {
  // 只有还没结束的才谈得上「还剩多久」。已结束的 endAt 在过去，
  // cxMinLeft 会给出负数 —— 写出来是「还剩 不到 1 分钟」，像马上要截止。
  const open = cxSignOpen(it);
  const min = open ? cxMinLeft(it) : null;
  const left = (min != null && min >= 0) ? '还剩 ' + cxLeft(min) : '';

  let tail;
  if (it.signed === true) tail = '已签到';
  else if (it.signed === false) tail = left ? '没签 · ' + left : '没签';
  else if (left) tail = left;
  else tail = String(it.status || '') || '已结束';

  // 只有还来得及签的才给链接。已结束的签到点进去是一张空页面，
  // 点了没反应比不给箭头更让人困惑。
  const link = (!hist && it.url) ? String(it.url) : '';
  // 「签退」和「签到」是两件事，只写课程名分不出来 —— 标题不是「签到」
  // 的时候补上，是「签到」就省掉（那是绝大多数情况，写出来只是噪声）。
  const label = (it.title && it.title !== '签到')
    ? (it.course ? it.course + ' · ' + it.title : it.title)
    : (it.course || it.title || '签到');
  const name = it.course ? it.course + ' · ' + (it.title || '签到') : (it.title || '签到');

  return '<div class="cx-srow' + (link ? ' tap' : '') + '"' +
    (link ? ' data-url="' + escAttr(link) + '" data-title="' + escAttr(name) + '"' : '') + '>' +
    (hist ? '<span class="cx-sdate">' + esc(cxSignWhen(it)) + '</span>' : '') +
    (CX.newKeys && CX.newKeys.has(cxItemKey(it))
      ? '<span class="cx-new">新</span>' : '') +
    '<span class="cx-scourse">' + esc(label) + '</span>' +
    '<span class="cx-sstate' + (it.signed === false ? ' miss' : '') + '">' +
      esc(tail) + '</span>' +
    (link ? '<svg class="cx-go" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M9 6l6 6-6 6"/></svg>' : '') +
    '</div>';
}

/** 签到发生的日期：10-22 08:05。
 *
 *  🔴 「没有时间」和「时间解析不了」不能共用一个返回值。
 *     以前是 `const sec = it.startAt || it.endAt` —— 只要 startAt **有值**就用它，
 *     哪怕那个值解析不出日期，于是 `new Date(NaN)` 直接返回空串，明明有 endAt 也不看。
 *     界面上那一条历史签到就成了「没有日期」，看着像「学习通压根没给时间」。
 *
 *     现在改成逐个试：startAt 拿不到**可用**的时间才回落 endAt；
 *     两个都拿不到可用时间，才是真的没有时间可显示（返回空串）。
 *     注意「有值」和「能用」是两件事 —— 空值、解析失败的字符串都算不能用。 */
function cxSignWhen(it) {
  const fmt = (sec) => {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    // 有值但解析不了 —— 不是「没有时间」，是「这个值不能用」，交给调用处试下一个
    if (isNaN(d.getTime())) return '';
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  };
  return fmt(it.startAt) || fmt(it.endAt);
}

/** 分类筛选条。只列有数据的类（+ 永远有「全部」）——
 *  一个「考试 0」摆在那儿只会让人以为加载失败了。 */
function cxCatsHtml(items) {
  const c = cxKindCounts(items);
  const cur = cxKindFilter(items);
  const total = (items || []).length;
  let h = '<div class="cx-cats" id="cxCats">' +
    '<button class="cx-cat' + (cur === 'all' ? ' on' : '') + '" data-kind="all">' +
    '全部<i>' + total + '</i></button>';
  CX_KINDS.forEach((k) => {
    if (!c[k]) return;
    h += '<button class="cx-cat' + (cur === k ? ' on' : '') + '" data-kind="' + k + '">' +
      CX_KIND_NAME[k] + '<i>' + c[k] + '</i></button>';
  });
  return h + '</div>';
}

/** 紧急度排序。
 *  🔴 没倒计时的**垫底**，但不能当 0 —— 那不等于已经过期。
 *     实测真有「未交但没写截止时间」的作业。 */
/** 三段排序的档位：0 还能赶上 / 1 没有截止时间 / 2 已经过期。
 *  🔴 以前直接按剩余分钟升序 —— 过期那条剩余是**负数**，负数最小 ⇒ 排最前面，
 *     一年前的通知占着首屏第一行，真要交的作业掉到第三屏。
 *     后端 open_items.sort 已经是三段，这里是「按课程分堆」之后的重排，
 *     两边口径必须一致，否则分堆视图又把过期项顶回来。 */
function cxSortRank(it) {
  const m = cxMinLeft(it);
  if (m == null) return 1;
  if (it.endAt && it.endAt < Date.now() / 1000) return 2;
  return 0;
}

function cxSortItems(items) {
  return items.slice().sort((a, b) => {
    const ra = cxSortRank(a); const rb = cxSortRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const x = cxMinLeft(a); const y = cxMinLeft(b);
      return (x || 0) - (y || 0);
    }
    return String(a.course || a.title || '')
      .localeCompare(String(b.course || b.title || ''));
  });
}

/** 按课程分堆。堆的顺序看「这堆里最急的那条」——
 *  一门课有明天到期的，就该排在只有下周到期的课前面。 */
function cxGroupByCourse(items) {
  const map = new Map();
  items.forEach((it) => {
    const k = String(it.course || '') || '（没写课程名）';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  });
  const out = [];
  map.forEach((list, course) => {
    let min = null;
    list.forEach((it) => {
      const mm = cxMinLeft(it);
      if (mm != null && (min == null || mm < min)) min = mm;
    });
    out.push({ course: course, items: cxSortItems(list), min: min });
  });
  out.sort((a, b) => {
    if (a.min == null && b.min == null) return a.course.localeCompare(b.course);
    if (a.min == null) return 1;
    if (b.min == null) return -1;
    return a.min - b.min;
  });
  return out;
}

/** 一条待办。
 *  `showCourse` 为 false 时（按课程分组里）不再重复写课程名。
 *  `showKind` 只在「全部」里为 true —— 分类视图里标题栏已经写着是哪类了，
 *  每条再挂一枚「作业」标纯属噪声。
 *
 *  🔴 有 `url` 的条目可以点开（作业、考试都有详情页；签到/讨论/通知没有，
 *     活动是弹在课程页里的，没有独立地址）。点开走 App 内 WebView，
 *     因为**学习通和门户共用同一个 java.net cookie 罐子**，WebActivity
 *     会把它整个倒进 WebView —— 所以点进去是已登录状态，不用再登一次。
 *     走系统浏览器就不行了，那是第三个罐子。 */
/** 绝对截止时间：10-23 23:59。跨年才带年份（同一年的都省掉，短一些）。 */
function cxDueAt(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return (sameYear ? '' : d.getFullYear() + '-') +
    p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes());
}

function cxItemHtml(it, showCourse, showKind) {
  const min = cxMinLeft(it);
  // 已经过点了（学习通还会在列表里留一阵，缓存也会留更久）——
  // 这时候写「还剩 不到 1 分钟」还标红，是在催一件已经办不了的事。
  const over = min != null && min < 0;
  // 只有真·临近（一天以内）才标红。没倒计时的不标 —— 那不等于过期。
  const urgent = min != null && min >= 0 && min <= 1440;
  const k = cxKindOf(it);
  const link = it.url ? String(it.url) : '';
  const due = cxDueAt(it.endAt);
  return '<div class="cx-item' + (link ? ' tap' : '') + (over ? ' cx-over' : '') + '"' +
    (link ? ' data-url="' + escAttr(link) + '"' +
            ' data-title="' + escAttr(it.title || '') + '"' : '') + '>' +
    '<div class="cx-t">' +
    (showKind ? '<span class="cx-k">' + esc(CX_KIND_NAME[k]) + '</span>' : '') +
    (CX.newKeys && CX.newKeys.has(cxItemKey(it))
      ? '<span class="cx-new">新</span>' : '') +
    esc(it.title) + '</div>' +
    '<div class="cx-m">' +
    (showCourse ? '<span class="cx-c">' + esc(it.course) + '</span>' : '') +
    // 签到/讨论这类活动，学习通自己会给一句状态文字（「已签到」「待批阅」）。
    // 有就带出来 —— 光看「还剩 12 分钟」分不清是要我去做还是我已经做完了。
    (it.status ? '<span class="cx-s">' + esc(it.status) + '</span>' : '') +
    // 右边两行、共用一条右边缘：上面是还剩多久（会变，也是要判断的东西），
    // 下面是绝对截止时间（2026-10-22 用户要求：「除了截止倒计时，也应该加一个
    // 截止时间，不然不够直观」—— 光看「还剩 2 小时 10 分钟」得自己算到几点）。
    // 不再给条目加左侧色条：那是 AI 生成页面的典型记号，而且把颜色花在了
    // 边框（chrome）上。急不急由这个数字本身说，红色只落在这行字上。
    // 🔴 通知不给时间位：它的 endTime 是**活动自己的生命周期终点**，不是待办截止。
    //    照常渲染会变成「已截止 2025-09-30」，一条公告看着像漏了件事。
    //    后端 parse_active 已经把 notice 的 endAt/leftMin 置空，这里再兜一层。
    (k === 'notice'
      ? ''
      : (min != null || due
        ? '<span class="cx-when">' +
          (over
            // 0.35.0：过点的把绝对时间**并进这一行**。
            //    以前是两行（「已截止」/「截止 10-30 23:59」），一条过期的
            //    作业跟明天要交的一样高 —— 用户原话「已经结束和完成的作业
            //    不要显示这么高这么显眼」。
            //    但不能把时间删掉：「我到底错过的是几点」是要看的东西。
            //    并成一行，信息不丢，高度省一半。
            ? '<span class="cx-l">已截止' + (due ? ' ' + due : '') + '</span>'
            : min != null
              ? '<span class="cx-l' + (urgent ? ' urgent' : '') + '">还剩 ' + cxLeft(min) + '</span>'
              : '<span class="cx-l none">没写剩余时间</span>') +
          (!over && due ? '<span class="cx-due">截止 ' + due + '</span>' : '') +
          '</span>'
        : '<span class="cx-when"><span class="cx-l none">没写截止时间</span></span>')) +
    (link ? '<svg class="cx-go" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M9 6l6 6-6 6"/></svg>' : '') +
    '</div></div>';
}

/** 点条目 → 在 App 内打开详情页。
 *
 *  ⚠️ 网页版（没有原生壳）没有 WebView，只能新开标签页 —— 那个罐子里
 *     没有学习通的 cookie，进去要重新登一次。这一点在按钮文案里说清楚。 */
function cxOpenItem(el) {
  const url = el && el.dataset ? el.dataset.url : '';
  if (!url) return;
  const name = (el.dataset && el.dataset.title) || '学习通';
  if (NATIVE && window.NativeApi && typeof NativeApi.openWeb === 'function') {
    let why = 'none';
    try { why = NativeApi.openWeb(url, name); }
    catch (e) { why = 'fail: ' + ((e && e.message) || e); }
    if (why === '') return;
    // 老 APK / 起不来 —— 退回浏览器，宁可多登一次也不能点了没反应
  }
  if (!openExternal(url)) toast('打不开浏览器，可以复制链接手动打开');
}

/** 登录态过期时的一条捷径。
 *
 *  用户 2026-10-22 的原话：「能不能把学习通的账号密码也存到本地，
 *  后续再看就不需要输入账号密码了」。
 *  账号密码在第一次登录时就加密存了，过期时只需要点一下 —— 密码留空，
 *  后端拿本机那份去换新凭证。**不自动重试**：超星的 needVcode 撞一次
 *  就要人做滑块，必须是人主动点的。
 */
function cxRelinkHtml() {
  const s = CX.scan || {};
  if (s.state !== 'error' || s.kind !== 'auth' || !CX.canRelink) return '';
  return '<button class="btn primary block" id="cxRelink">用存着的密码重连</button>';
}

async function cxRelink() {
  const btn = $('cxRelink');
  if (btn) { btn.disabled = true; btn.textContent = '重连中…'; }
  try {
    // pass 留空 = 用本机存的那份。账号照传，后端会核对是不是同一个人 ——
    // 对不上直接拒，免得拿别人的密码去撞学习通的风控。
    const r = await api('/api/cx/login', { user: CX.user, pass: '' });
    if (!r.ok) {
      toast(r.error || '重连没成功');
      if (r.pwdStale) CX.canRelink = false;   // 存的那份错了，已经删掉
      cxPaint();
      return;
    }
    CX.state = 'ok';
    CX.canRelink = true;
    toast('重连上了');
    cxScanStart();
  } catch (e) {
    toast('重连出错：' + e.message);
    cxPaint();
  }
}

/** 底部动作 + 断开。放在页面里，不再有「关闭弹层」那种东西。
 *
 *  0.33.0：三颗并成一行。以前「断开学习通」是单独一整行（44px + 12 上边距），
 *  在「一屏装下」的预算里它占了 56 —— 而它是三者里最不常用的一个。
 *  降成一行里的小字按钮，仍然带二次确认（`cxDisconnect` 的 askConfirm）。
 */
function cxFootHtml(withScan) {
  // 文案写「打开学习通」而不是「浏览器打开」：走的是 App 内 WebView，
  // 那边带着学习通的登录态（和门户共用一个 cookie 罐子），点进去是已登录的。
  // 交给系统浏览器就变成第三个罐子，每次都要重登一次。
  //
  // 🔴 0.39.1：这一行原来还有第三颗「断开」。用户 2026-11-01：
  //    「删除东西的功能你做的实在是显眼过头了……还容易让用户误触」。
  //    它紧挨着「打开学习通」—— 两个按钮相隔 8px，一个天天点、一个一学期
  //    点一次，还都是 44px 高。断开是**删凭证**，误触一次的代价是重新登录。
  //    现在只在「我的 → 账号管理 → 学习通 → 断开」。
  return '<div class="cx-acts">' +
    (withScan ? '<button class="btn primary" id="cxScan">重新检查</button>' : '') +
    '<button class="btn" id="cxOpen">打开学习通</button>' +
    '</div>';
}

async function cxDisconnect() {
  const ok = await askConfirm('断开学习通',
    '会删掉手机里存的账号密码和作业记录。下次要重新输密码。', '断开');
  if (!ok) return;
  try { await api('/api/cx/logout', {}); } catch (e) { /* 本地清掉就行 */ }
  cxStopPoll();
  CX.state = 'none'; CX.user = ''; CX.data = null; CX.scan = null;
  CX.age = -1; CX.saved = false; CX.canRelink = false;
  renderMe();
  cxPaint();
  toast('已断开学习通');
}

/** 重画之后重新挂事件。每次 innerHTML 都会把监听器一起冲掉，必须重挂。 */
function cxBind() {
  // ⚠️ 必须用箭头函数转一层：直接把 cxScanStart 交给 addEventListener 的话，
  //    第一个参数是 Event 对象（真值），冷却判断会被当成「用户手点」——
  //    虽然结果正好对，但那是碰巧，不是本意。
  if ($('cxScan')) $('cxScan').addEventListener('click', () => cxScanStart(true));
  if ($('cxRelink')) $('cxRelink').addEventListener('click', cxRelink);
  if ($('cxOpen')) $('cxOpen').addEventListener('click', () => {
    // 有原生壳就走 App 内 WebView（带着学习通登录态）；
    // 网页版没得选，只能新开标签页 —— 那边要重新登一次，所以文案分开写。
    if (NATIVE && window.NativeApi && typeof NativeApi.openWeb === 'function') {
      let why = 'none';
      try { why = NativeApi.openWeb(CX_HOME, '学习通'); }
      catch (e) { why = 'fail: ' + ((e && e.message) || e); }
      if (why === '') return;
    }
    if (!openExternal(CX_HOME)) toast('打不开浏览器，可以复制链接手动打开');
  });
  // 0.39.1：`#cxOut`（底栏那颗「断开」）已删，见 cxFootHtml 的说明。
  // 断开仍走 cxDisconnect，只是入口在「账号管理 → 学习通」。
  // 条目点开：事件委托挂一次就够，别每条都挂 —— 列表最多几十条，
  // 每条挂一个监听器会在每次重画时堆积。
  // 🔴 而且 #cxBody 这个**元素本身**不随重画换掉（换的只是它的 innerHTML），
  //    所以这里必须打标记，否则 cxBind 每调一次就多挂一个监听器，
  //    点一下会打开 N 个窗口。
  if ($('cxBody') && !$('cxBody').dataset.cxBound) {
    $('cxBody').dataset.cxBound = '1';
    $('cxBody').addEventListener('click', (e) => {
      // 「全部重查」—— 它每次重画都是新元素，所以走委托（和下面条目点击
      // 同一个理由：每条挂一个监听器会在重画时堆积）。
      // 🔴 必须 preventDefault：它是 <a href="#">，不拦会跳回页面顶部，
      //    用户会以为「点了没反应，只是页面滚上去了」。
      if (e.target && e.target.closest && e.target.closest('#cxAllScan')) {
        e.preventDefault();
        cxScanStart(true, true);
        return;
      }
      // 0.33.0：「还有 N 条没显示」—— 展开就是全铺（这时才需要滑，
      // 而且是用户自己点开的）。用体量而不是 true/false：
      // 换分类后这个数字就不对了，只能按条数放。
      if (e.target && e.target.closest && e.target.closest('#cxMore')) {
        CX.showN = 9999;
        cxPaint();
        return;
      }
      // 签到卡里的行也是同一种「点开详情」，所以一起收在这里。
      const el = e.target && e.target.closest
        ? e.target.closest('.cx-item.tap, .cx-srow.tap') : null;
      if (el) cxOpenItem(el);
    });
  }
  // 签到卡的「看全部」。展开状态存在 CX.signOpen 上 —— 重画时 DOM 会换掉。
  if ($('cxSignMore')) {
    $('cxSignMore').addEventListener('click', () => {
      CX.signOpen = !CX.signOpen;
      cxPaint();
    });
  }
  // 「这次新查到 N 条」上的「知道了」：收起提示，也把条目的「新」标一起去掉。
  // 两件事要一起做 —— 留着标记、只收起提示的话，用户会以为那些标还在提示什么。
  if ($('cxNewBarX')) {
    $('cxNewBarX').addEventListener('click', () => {
      CX.newKeys = null;
      cxPaint();
    });
  }
  if ($('cxCats')) {
    $('cxCats').querySelectorAll('.cx-cat').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.kind === 'all' ? 'all' : b.dataset.kind;
        if (k === (CFG.cxKind || 'all')) return;
        CFG.cxKind = k;
        CX.showN = 4;          // 换了分类，首屏重新从 4 条开始
        store.set(KEY.settings, CFG);
        cxPaint();
      });
    });
  }
  if ($('cxGroupSeg')) {
    $('cxGroupSeg').querySelectorAll('.seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const g = b.dataset.group === 'course' ? 'course' : 'all';
        if (g === (CFG.cxGroup === 'course' ? 'course' : 'all')) return;
        CFG.cxGroup = g;
        CX.showN = 4;
        store.set(KEY.settings, CFG);
        cxPaint();
      });
    });
  }
}

/** 「有东西没读到」那一块。
 *
 *  改之前长这样（用户 2026-10-23 的原话是「未找到入口什么的是什么意思」）：
 *      40 处没查到，这些课的作业/考试可能没列进来：
 *      · 作业：拿不到入口：20 门
 *      · 考试：这门课拿不到考试入口：20 门
 *
 *  三个毛病：
 *    1. 「入口」是内部说法 —— 他既不知道指什么，也不知道自己能做什么。
 *    2. 同一门课被数了两遍（作业一次、考试一次），20 门课显示成「40 处」。
 *    3. 「页面里没这个入口」（不用管）和「登录态失效」（要管）摆在一起，
 *       分不清轻重。
 *
 *  现在按 part 合并：同一批课缺作业 + 缺考试 ⇒ 一句话「没读到作业和考试」；
 *  数字按**课**算；原因分成「页面里没这个入口」（多半结课了）和
 *  「真的没读到」（登录/接口问题）两类，各自说清楚。
 */
/** 「已结课，这次没查」的提示条。
 *
 * 🔴 必须**看得见 + 能撤销**。这个判定是猜出来的（最新一条内容是几个月前的），
 *    一定会有猜错的那天。猜错时用户必须能看见「哦，这 10 门被跳过了」，
 *    并且能一键全查 —— 否则他只会觉得「这软件漏了我的作业」，
 *    而且**没有任何办法证明不是**。那比慢 140 秒糟得多。
 *
 * 0.39.0 改了判据，文案跟着改：「已结课」说得太满 —— 真实情况是
 *    「这学期没在超星上发东西」，不等于教务系统里结课了。
 *    说「近期没动静」是在说我们**读到**的事实，不是我们**猜**的结论。
 */
function cxPausedHtml(d) {
  const paused = Array.isArray(d && d.paused) ? d.paused : [];
  if (!paused.length) return '';
  // 同一门课可能挂着好几个学期的教学班，各算一条 —— 显示时按课名去重，
  // 否则用户会看到「大学物理实验、大学物理实验、大学物理实验」。
  const seen = new Set();
  const names = [];
  paused.forEach((p) => {
    const n = String((p && p.course) || '').trim();
    if (n && !seen.has(n) && names.length < 3) { seen.add(n); names.push(n); }
  });
  return '<div class="cx-note cx-paused">' +
    '<b>' + paused.length + ' 门课近期没动静，这次没查</b>' +
    (names.length
      ? '（' + esc(names.join('、')) + (paused.length > 3 ? ' 等' : '') + '）'
      : '') +
    '<p>老师刚发了东西的话，<a href="#" id="cxAllScan">全部重查一遍</a>。</p>' +
    '</div>';
}

/** 把后端给的失败原因翻译成「用户能做什么」。
 *
 *  🔴 后端的 `why` 是**写给维护者看的**：「课程页返回 202（查得太密，被临时
 *     限流了 —— 过几分钟再试）」。它原样出现在界面上时，用户读到的是
 *     「202」「限流」这些词，还得自己想「那我该干嘛」。用户 2026-11-01：
 *     「用户能看见的一切文案都应该面向用户，不应该有冗余的解释性文案」。
 *
 *  只翻译认得出的几种；认不出来的**照原样显示**（截断到 24 字），
 *  绝不编一句像模像样的话 —— 那是把「不知道」说成了「知道」（红线）。
 */
function cxWhySay(why) {
  const s = String(why || '').trim();
  if (!s) return '没查到';
  if (/202|限流|太密|太频繁|请求过多/.test(s)) return '访问太频繁，被学习通拦了，过几分钟再试';
  if (/登录|失效|无效的用户|未登录/.test(s)) return '登录过期了，去账号管理重连';
  if (/超时|timeout|网络|连接/.test(s)) return '网络没连上';
  return s.length > 24 ? s.slice(0, 24) + '…' : s;
}

function cxFailHtml(failed) {
  const noEntry = { work: [], exam: [] };
  const other = new Map();
  // 课程页没打开的课：它的「作业没查」「考试没查」两条**不是另外两件事**，
  // 而是 course 那条失败的直接后果。
  // 🔴 2026-10-24 修：以前这两条会进 other，于是 17 门课被数成
  //    「课程页返回 202：17 门」+「课程页没打开，没查：34 门」——
  //    17 + 34 = 51，可用户总共只有 32 门课。同一件事数了两遍，
  //    而且第二个数字还是重复计数（一门课 work + exam 各一条）。
  const noCourse = new Set();

  failed.forEach((f) => {
    const why = String(f.why || '没查到').slice(0, 50);
    const part = String(f.part || '');
    const code = String(f.code || '');
    const course = String(f.course || '');
    // 0.15.0 之前扫的缓存没有 part —— 退回按 why 原文分组，别因此崩掉
    if (!part) {
      if (!other.has(why)) other.set(why, []);
      other.get(why).push(course);
      return;
    }
    if (code === 'nocourse') { noCourse.add(course); return; }
    if (code === 'noentry' && (part === 'work' || part === 'exam')) {
      if (noEntry[part].indexOf(course) < 0) noEntry[part].push(course);
      return;
    }
    if (!other.has(why)) other.set(why, []);
    other.get(why).push(course);
  });

  const w = noEntry.work; const e = noEntry.exam;
  // 两批课完全一样 ⇒ 合并成一句。这是最常见的情形：课已经结课归档，
  // 作业页和考试页一起没有入口 —— 说两遍等于把同一件事数了两次。
  const sameSet = w.length > 0 && w.length === e.length &&
    w.every((x) => e.indexOf(x) >= 0);
  // 少于 4 门才把课名写出来，多了写出来是一整屏，反而没人看
  const names = (arr) => (arr.length <= 3 ? '（' + arr.join('、') + '）' : '');

  let out = '';
  if (sameSet) {
    // 🔴 2026-10-23 补：这一支原来**不写课名**，只说「N 门课没读到作业和考试」。
    //    可「作业和考试一起没有入口」正是最常见的情形（课已归档），
    //    等于最常见的提示恰好是信息量最少的那句 —— 用户知道有几门，
    //    但不知道是哪几门，没法去核对。
    //    names() 本来就把课名卡在 3 门以内，不会把一屏占满。
    // 0.39.1：后半句「这 N 门课的学习通页面里找不到作业和考试的入口 ——
    //    多半已经结课归档，或者老师换成了新版课程页」是**机制解释**，
    //    用户只需要知道「多半结课了」和「没查到 ≠ 没有」。
    out += '<b>' + w.length + ' 门课没查到作业和考试</b>' + esc(names(w)) +
      '<p>多半已经结课。没查到不等于没有。</p>';
  } else if (w.length || e.length) {
    if (w.length) {
      out += '<b>' + w.length + ' 门课没查到作业</b>' + esc(names(w)) + ' ';
    }
    if (e.length) {
      out += '<b>' + e.length + ' 门课没查到考试</b>' + esc(names(e));
    }
    out += '<p>多半已经结课。没查到不等于没有。</p>';
  }

  // 其余原因（限流、登录过期、网络）翻译成人话，但**按课去重** ——
  // 一门课可能作业和活动一起挂，不能数两次。
  if (other.size) {
    // 去重后的课数。不能拿 other 里的条目数：一门课挂两处就算了两遍，
    // 那正是原来「20 门课显示成 40 处」的毛病。
    const uniq = [];
    other.forEach((courses) => courses.forEach((c) => {
      if (c && uniq.indexOf(c) < 0) uniq.push(c);
    }));
    const nOther = uniq.length;

    // 只有一种原因，且这一种就覆盖了全部课（绝大多数情况：一次限流全挂）⇒
    // 折成一句「31 门课没查到（学习通限流了，过几分钟再试）」。
    // 0.39.1 之前是「31 门课有东西没读到」+ 一条只有一项的列表 + 两句解释：
    // 一个原因写成三行，用户读到的是「202」这种我们内部的词。
    const groups = Array.from(other.entries());
    const onlyOne = groups.length === 1 &&
      new Set(groups[0][1].filter(Boolean)).size === nOther;

    if (onlyOne) {
      out += (sameSet || w.length || e.length)
        ? '<p class="cx-failsub">另外 ' + nOther + ' 门：' +
          esc(cxWhySay(groups[0][0])) + '。</p>'
        : '<b>' + nOther + ' 门课没查到</b>' + esc(names(uniq)) +
          '<p>' + esc(cxWhySay(groups[0][0])) + '。</p>';
    } else {
      // 上面已经说过「没查到作业/考试」时，这里只能算「另外」——
      // 否则读者会以为下面这些课和上面是两批不同的事。
      out += (sameSet || w.length || e.length)
        ? '<p class="cx-failsub">另外 ' + nOther + ' 门课：</p>'
        : '<b>' + nOther + ' 门课没查到</b>';

      let rows = '';
      groups.forEach((g) => {
        // 按课去重。目前主要靠上面 `nocourse` 那道拦截保证不重复
        // （17 门课 × 作业/考试两条 = 34 条，不拦就会数成 34 门）；
        // 这层是兜底：同一个 why 下真出现重复时，也别把门数数大。
        const uq = Array.from(new Set(g[1].filter(Boolean)));
        rows += '<li>' + esc(cxWhySay(g[0])) + '：' + uq.length + ' 门' +
          esc(names(uq)) + '</li>';
      });
      out += '<ul>' + rows + '</ul>';
    }
    // 0.39.1：这里原来还有一句「其中 N 门课连课程页都没打开，作业和考试
    //    因此也没查 —— 那是「没读到」，不等于没有。」它解释的是**我们的
    //    数据是怎么缺的**，而用户已经知道「N 门没查到」了。删掉。
    //    noCourse 仍然照常收集：它保证上面的门数不重复计数。
    void noCourse;
    out += '<p class="cx-failsub">没查到不等于没有。</p>';
  }

  return '<div class="cx-note cx-fail">' + out + '</div>';
}

/** 扫描中的细进度条。
 *
 *  🔴 摆法很关键：它挂在**旧数据上面**，不替换旧数据。
 *     用户在等的时候还能翻上次的列表、还能点开作业看 —— 这才叫「不用等」。
 *     整块换成进度卡是 0.15.2 及以前的行为（见 cxPaintTodo 里的说明）。
 */
function cxScanStripHtml(s) {
  const pct = s.n ? Math.round(s.i / s.n * 100) : 0;
  return '<div class="cx-strip">' +
    '<div class="cx-strip-h">' +
      '<span class="cx-strip-l"><i class="cx-dot"></i>正在更新</span>' +
      '<span class="cx-strip-p">第 ' + (s.i || 0) + '/' + (s.n || '?') + ' 门' +
        (s.course ? ' · ' + esc(s.course) : '') + '</span>' +
    '</div>' +
    '<div class="cx-strip-bar"><i style="width:' + pct + '%"></i></div>' +
    '<p class="cx-strip-t">下面是上次查到的，扫完自动换 —— 不用等在这儿。</p>' +
    '</div>';
}

/** 一条条目的身份。用来算「这次新查到的是哪些」。
 *
 *  为什么不用下标/顺序：扫描结果的顺序会变（按紧急度排），
 *  下标一比全都「变了」。用「类型 + 课程 + 标题」才是稳定的。
 */
function cxItemKey(it) {
  return (it && it.kind ? it.kind : '') + '|' +
         (it && it.courseId != null ? it.courseId : '') + '|' +
         (it && it.title ? it.title : '');
}

/** 一份扫描结果里所有条目的 key。签到也算 —— 「漏了一次签到」正是要看的东西。 */
function cxKeysOf(d) {
  const set = new Set();
  if (!d) return set;
  for (const field of ['items', 'signs', 'otherItems']) {
    const rows = Array.isArray(d[field]) ? d[field] : [];
    for (const it of rows) set.add(cxItemKey(it));
  }
  return set;
}

/** 这次比上次多了哪些。
 *
 *  🔴 三道「不知道就别报」，一条都不能少 —— 都是「宁可不说，也不能瞎说」：
 *
 *  ① 上一份没有 `failed` 字段 ⇒ 不报。
 *     0.15.2 及以前的缓存有 failed，但更老的（或别的客户端写的）没有。
 *     缺了它就没法判断「上次这门课读到没读到」，等于假装上次全读到了 ——
 *     上次漏掉的课会整门被报成「新」。
 *
 *  ② 上一份 items 是空的 ⇒ 不报。
 *     典型形态是「暑假扫过一次 0 条、开学再扫 76 条」，报「新查到 76 条」
 *     等于把整个列表说成新的，比不报更误导。
 *     看起来损失了「上次全交完、这次来了一条新作业」这种场景 ——
 *     但那种时候整屏就那么一两条，标不标「新」都看得见。
 *     （这条是南师侧 2026-10-23 提的，两边实现必须一致，否则同一份数据
 *      在网页版和 APK 上会显示不同的数字。）
 *
 *  ③ 上次或这次没读到某门课（failed 里有它）⇒ 那门课不报。
 *     这次所有条目对它来说都是「第一次见」—— 那不是新作业，
 *     是我们上次没看见。这条和「没读到 ≠ 没有」是同一个道理的两个方向。
 */
function cxDiffNew(prev, now) {
  const out = new Set();
  if (!prev || !now) return out;
  if (!Array.isArray(prev.failed)) return out;
  if (!Array.isArray(prev.items) || !prev.items.length) return out;

  const blind = new Set();
  for (const src of [prev, now]) {
    for (const f of (Array.isArray(src.failed) ? src.failed : [])) {
      if (f && f.course) blind.add(String(f.course));
    }
  }
  const oldKeys = cxKeysOf(prev);
  for (const field of ['items', 'signs', 'otherItems']) {
    const rows = Array.isArray(now[field]) ? now[field] : [];
    for (const it of rows) {
      if (blind.has(String(it.course || ''))) continue;
      const k = cxItemKey(it);
      if (!oldKeys.has(k)) out.add(k);
    }
  }
  return out;
}

/** 「这次新查到 N 条」的一条提示。点「知道了」就收起。 */
function cxNewBarHtml() {
  const n = CX.newKeys ? CX.newKeys.size : 0;
  if (!n) return '';
  return '<div class="cx-newbar">' +
    '<span>这次新查到 <b>' + n + '</b> 条</span>' +
    '<button class="cx-newbar-x" id="cxNewBarX">知道了</button>' +
    '</div>';
}

function cxPaintTodo() {
  const s = CX.scan || {};
  const d = CX.data;
  let html = '';

  // 🔴 2026-10-23 改：扫描时**不再盖掉已有数据**。
  //    以前只要 state === 'scanning' 就把整个 #cxBody 换成一张进度卡，于是
  //    「想看新发的作业」= 盯着进度条等 90 秒，这期间连旧列表都看不见。
  //    用户原话：「学习通每次想看新发的作业都需要全量读取一遍，效率太低了」。
  //    现在：有旧数据就照常显示（只在顶上挂一条细进度），扫完原地替换。
  //    真没数据时才显示整块进度卡 —— 那种情况下本来也没有东西可看。
  const scanning = s.state === 'scanning';

  if (scanning && !d) {
    const pct = s.n ? Math.round(s.i / s.n * 100) : 0;
    html =
      '<div class="card cx-login">' +
      '<h2 class="cx-h">正在检查…</h2>' +
      '<p class="cx-p">第 ' + (s.i || 0) + ' / ' + (s.n || '?') + ' 门课' +
        (s.course ? '（' + esc(s.course) + '）' : '') + '</p>' +
      '<div class="cx-bar"><i style="width:' + pct + '%"></i></div>' +
      (s.phase ? '<p class="cx-note">正在查：' + esc(s.phase) + '</p>' : '') +
      '<p class="cx-note">大约要 1 分钟，可以先切到别的页，回来看进度。</p>' +
      '</div>';
    $('cxBody').innerHTML = html;
    return;
  }

  if (!d) {
    html =
      '<div class="card cx-login">' +
      '<h2 class="cx-h">还没查过</h2>' +
      '<p class="cx-p">' +
        (s.state === 'error' ? '上次出错：' + esc(s.err || '') + '。<br>' : '') +
        '大约要 1 分钟。查完会存下来，下次打开直接看。</p>' +
      cxRelinkHtml() +
      '<button class="btn primary block" id="cxScan">检查一次</button>' +
      '</div>' + cxFootHtml(false);
    $('cxBody').innerHTML = html;
    cxBind();
    return;
  }

  // ---- 有数据 ----
  const all = cxSortItems(Array.isArray(d.items) ? d.items : []);
  const kind = cxKindFilter(all);
  const items = kind === 'all' ? all : all.filter((it) => cxKindOf(it) === kind);
  const group = CFG.cxGroup === 'course' ? 'course' : 'all';

  // 分类各有多少条，下面那排药丸上写着，不在这里重复。
  const counts = cxKindCounts(all);
  // 只有「混着好几类」才给每条挂分类标。全是作业的时候挂 4 个「作业」标
  // 纯属噪声 —— 那本来就是绝大多数情况。
  const showKind = kind === 'all' &&
    CX_KINDS.filter((k) => counts[k] > 0).length > 1;
  const dueN = (counts.work || 0) + (counts.exam || 0);
  // 这次**没读到**的课。必须在算头部大字之前就拿到 —— 下面「都清了」和
  // 「所有课的作业都交了」两句话都要先问它。
  // 🔴 2026-10-27 修（南师侧同一处）：以前这两句话完全不管 failed，
  //    于是「登录态过期、一门都没查成」的页面上会写着「都清了」，
  //    紧接着下面又列出 20 门没查到 —— 两句话互相打架，而前一句是假话。
  //    「没读到」被说成「没有」，正是这个产品最不能犯的错。
  // ⚠️ noentry（课程页里根本没这个入口）不算没查成：多半是已结课归档。
  //    算进来的话，学期中每门结课课都会让这句话天天挂着，
  //    用户三天就学会无视它 —— 那比不提示更糟。
  const failed = Array.isArray(d.failed) ? d.failed : [];
  const missedN = new Set(failed
    .filter((f) => String(f.code || '') !== 'noentry')
    .map((f) => String(f.course || ''))).size;
  let headMain, headWord;
  if (kind !== 'all') {
    headMain = items.length;
    headWord = ' 条' + CX_KIND_NAME[kind];
  } else if (dueN) {
    headMain = dueN;
    headWord = ' 条要交';
  } else if (all.length) {
    headMain = all.length;
    headWord = ' 条动态';
  } else {
    headMain = 0;
    headWord = '';
  }
  // 签到已经从待办里摘出去了，所以「作业考试都清了」的时候 all 是空的。
  // 这时候如果还有签到在等，头部不能写「都清了」—— 它会和下面那张
  // 「2 个正在进行」的签到卡直接打架。
  const liveSigns = (Array.isArray(d.signs) ? d.signs : []).filter(cxSignOpen).length;

  html = (scanning ? cxScanStripHtml(s) : '') + cxNewBarHtml() +
    '<div class="cx-hd">' +
    (headMain ? '<b>' + headMain + '</b>' + headWord
              // 这里**不带数字**：下面那张签到卡第一行就写着「N 个正在进行」，
              // 隔 40px 把同一个数字说两遍，看着像出了 bug。
              : (liveSigns ? '签到在进行' : (missedN ? '没查全' : '都清了'))) +
    '<span class="cx-hdm">' + cxAgo(CX.age) + '查的 · 共 ' + (d.courses || 0) + ' 门课</span>' +
    '</div>';

  // 🔴 这次没查成，但本机有上次的数据 —— 必须说清楚「下面是旧的」，
  //    不然用户会以为这就是现在的状态，那比不显示更糟。
  if (s.state === 'error') {
    html += '<p class="cx-note err">这次没查成：' + esc(s.err || '') +
            '。下面这些是上次查到的。</p>' + cxRelinkHtml();
  }

  // 签到卡摆在数据头下面、分类药丸上面。
  // 🔴 必须在 `if (all.length)` 外面：签到记录和「待办」是两回事 ——
  //    作业全交了（all 为空）的时候，签到历史照样该看得见。
  html += cxSignCardHtml(d);

  // 「N 门课已结课，这次没查」—— 摆在签到卡下面、列表上面。
  // 放这里而不是塞进失败提示：它不是「出错了」，是「我们主动省了事」，
  // 混在错误里会让人以为扫描坏了。
  html += cxPausedHtml(d);

  if (all.length) {
    html += cxCatsHtml(all);
    html += '<div class="seg cx-seg cx-seg-mini" id="cxGroupSeg">' +
      '<button class="seg-btn' + (group === 'all' ? ' on' : '') + '" data-group="all">按紧急度</button>' +
      '<button class="seg-btn' + (group === 'course' ? ' on' : '') + '" data-group="course">按课程</button>' +
      '</div>';
  }

  // 0.33.0：首屏只铺前 `CX.showN` 条（默认 4）。
  // 这一页天生是长列表（一条 83px），十条就 830px —— 不截的话必须滑。
  // 截断只影响**渲染**，不动 items：分类计数、失败提示、跳过统计还是全量的。
  const cap = Math.max(1, CX.showN || 4);
  const shownItems = items.slice(0, cap);

  if (!items.length) {
    html += '<p class="cx-note">' +
      (all.length ? '这一类里现在没有东西。'
                  : (missedN
                      ? '这次没查全（' + missedN + ' 门课没读到），所以不能说'
                        + '「都交了」—— 没查到的课里可能有作业。'
                      : '上次检查的时候，所有课的作业都交了，也没有待考的试。')) +
      '</p>';
  } else if (group === 'course') {
    html += '<div class="cx-list cx-list-page">' +
      cxGroupByCourse(shownItems).map((g) =>
        '<div class="cx-grp">' +
        '<div class="cx-grph"><span class="cx-grpn">' + esc(g.course) + '</span>' +
        '<span class="cx-grpc">' + g.items.length + ' 条</span></div>' +
        g.items.map((it) => cxItemHtml(it, false, showKind)).join('') +
        '</div>').join('') + '</div>';
  } else {
    html += '<div class="cx-list cx-list-page">' +
      shownItems.map((it) => cxItemHtml(it, true, showKind)).join('') + '</div>';
  }
  // 「还有 N 条」：说了还剩几条，而不是只说「展开」—— 数字让人知道
  // 后面是 2 条还是 20 条，值不值得点。
  if (items.length > shownItems.length) {
    html += '<button class="cx-more" id="cxMore">还有 ' +
      (items.length - shownItems.length) + ' 条没显示</button>';
  }

  // 有课没查到时必须说出来，不能让人以为「全都查到了」。
  // （`failed` 在函数开头就取好了 —— 头部那两句话要先问它。）
  if (failed.length) html += cxFailHtml(failed);

  // 被筛掉的那些也要交代清楚。🔴 「没显示」不等于「不存在」——
  //    已交/已结束/状态认不出来，三种原因分开说，别揉成一句。
  //    只在「全部」里说：这些数字是整个扫描的全局统计，
  //    摆在「只看考试」里会读成「考试里有 86 条已交」，那是错的。
  //
  // 0.39.1：只留「认不出的」。「已交或已考完 442 条、已结束 442 条」是
  //    全库统计，对用户没有任何可做的事 —— 用户 2026-11-01：
  //    「不应该有冗余的解释性文案」。认不出的那几条要留着：它是**不确定**，
  //    不写出来就成了「悄悄丢掉」，两种性质完全不一样。
  const sk = d.skipped || {};
  if (kind === 'all') {
    const odd = sk.odd || d.other || 0;
    if (odd) {
      html += '<p class="cx-note">还有 ' + odd + ' 条状态认不出，没列进来。</p>';
    }
  }

  html += cxFootHtml(true);
  $('cxBody').innerHTML = html;
  cxBind();
}

// -- 扫描 ----------------------------------------------------------

/** 本学期教务课表里在修的课名 —— 给学习通扫描当「别降频」的白名单。
 *
 *  为什么需要它：0.39.0 起「最新内容三个月前 ⇒ 这门课不常扫了」。
 *  那是个猜，猜错就漏作业。教务课表是「这门课现在真的在上」的唯一权威来源，
 *  拿它兜住：课表里有的课**永不降频**。
 *
 *  🔴 拿不到就返回空数组，后端见空数组**一律不降频**（宁可慢）。
 *     绝不能因为「没绑教务」就退化成「全都当历史课」—— 那会把用户正在上的
 *     课全档住，而他甚至没做错什么。
 */
function cxActiveNames() {
  const out = [];
  ((DATA && DATA.courses) || []).forEach((c) => {
    const n = c && c.name ? String(c.name).trim() : '';
    if (n) out.push(n);
  });
  return out;
}

async function cxScanStart(manual, force, auto) {
  if (CX.busy) return;
  // 自动查（cxAutoScan 发起的那条路径）失败时不弹 toast —— 见 cxPoll。
  CX.autoScan = !!auto;
  // 🔴 90 秒冷却，只挡**用户手点**（manual=true）。
  //    一次全量扫描要 60~90 秒、几十个请求；刚扫完马上再点，学校的 WAF 会直接
  //    403（2026-10-23 南师侧实测：一分钟内再点必 403）。403 不是权限问题，
  //    是「查得太密」—— 挡在客户端，比让用户撞上去看一句看不懂的报错好。
  //    ⚠️ 自动查不挡：那条路径自己按 CX_AUTO_SEC 挡着（30 分钟），
  //       比 90 秒严得多，再叠一层只会让「刚扫完切个页面回来」被无谓拒绝。
  if (manual) {
    const lastAt = CX.data && CX.data.at ? Number(CX.data.at) : 0;
    const waited = Date.now() / 1000 - lastAt;
    if (lastAt && waited < CX_COOL_SEC) {
      toast('刚扫过，' + Math.ceil(CX_COOL_SEC - waited) +
            ' 秒后再试 —— 查太频繁会被学校网站临时拦下');
      return;
    }
  }
  CX.busy = true;
  // 记下扫描前的样子 —— 扫完要拿它算「这次新查到了什么」。
  // 「新」标记也一起清掉：那是上一轮的结论，不该跟着新结果继续挂着。
  CX.prevData = CX.data || null;
  CX.newKeys = null;
  try {
    const r = await api('/api/cx/scan', { force: !!force,
                                          activeNames: cxActiveNames() });
    if (!r.ok) {
      CX.busy = false;
      // 🔴 只有**服务端确认会话没了**（needLogin）才退回登录态。
      //    限流/断网（kind=net）时保持「已登录」不动 —— 那种情况登录态是好的，
      //    把界面退回登录页会让人白输一遍密码。
      if (r.needLogin) {
        CX.state = 'none';
        CX.scan = null;
        // CX.data **不清**：重连之后还能立刻把上次的结果摆出来，
        // 清掉的话用户重连完还得再等一整轮扫描才有东西看。
        cxPaint();
      }
      toast(r.error || '启动失败');
      return;
    }
    CX.scan = r.scan || { state: 'scanning', i: 0, n: 0, course: '' };
    // 🔴 能开始扫 ⇒ 会话是活的。界面可能还停在登录表单上 ——
    //    两种来路：① 刚从「打开学习通」那个 WebView 里登录回来，
    //    cookie 已经回灌进罐子，但本页的 CX.state 还是旧的 'none'；
    //    ② cookie 名跟我们的判据对不上，可服务器认。
    //    不补这一步，用户会看到「明明能查，界面却让我再登一次」。
    if (CX.state !== 'ok') {
      CX.state = 'ok';
      cxPaint();
    }
    cxPaint();
    cxStopPoll();
    // 🔴 开始新一轮前清旧账。不清的话：sigAt 还是上个钟头的时刻，
    //    第一次轮询就判「卡住了」；pollFails 还带着上一场的失败次数，
    //    新一场第一次抖动就直接落 error。
    CX.pollFails = 0;
    CX.sig = '';
    CX.sigAt = 0;
    // 后端是后台线程跑的，前端只轮询进度。1.2 秒一次，别打太密。
    CX.timer = setInterval(cxPoll, 1200);
  } catch (e) {
    toast('启动失败：' + e.message);
  } finally {
    CX.busy = false;
  }
}

async function cxPoll() {
  // 已经收尾（done / error）之后又被叫了一次 —— 比如上一个定时器的回调
  // 正好在收尾那一瞬间排上队。这时候**不许再动状态**：把 done 改成 error
  // 等于把刚查到的结果作废，用户会看到「这次没查成」而其实查成了。
  const cur = (CX.scan || {}).state;
  if (cur === 'done' || cur === 'error') { cxStopPoll(); return; }
  let t;
  try {
    t = await api('/api/cx/todo');
  } catch (e) {
    // 一次抖动不算故障（切 WiFi、息屏、后端正好在忙都会这样）。
    // 连续 CX_POLL_FAIL_MAX 次都拿不到才判失联 —— 不判的话界面会永远停在
    // 「正在检查」，而那是没有任何出口的。
    CX.pollFails = (CX.pollFails || 0) + 1;
    if (CX.pollFails >= CX_POLL_FAIL_MAX) {
      cxPollGiveUp('跟后台失去联系（连续 ' + CX_POLL_FAIL_MAX + ' 次没回应）');
    }
    return;
  }
  CX.pollFails = 0;
  CX.scan = t.scan || CX.scan;
  CX.data = t.data || CX.data;
  CX.age = typeof t.age === 'number' ? t.age : CX.age;
  const s = CX.scan || {};

  // ---- 卡住判定：进度指纹一直不变 ----
  // 四个字段都要进指纹，理由各不相同：
  //   i      —— 最直观
  //   course —— 后端先写 i 再换 course，同一门上停住时两个都不变
  //   phase  —— 扫描刚开始那段 i/n 都是 0（还在拿课程列表），只看 i 的话
  //             从第一秒起就在攒「没变」的时间
  //   n      —— 换一场扫描（25 门 → 26 门）i 可能碰巧相同
  if (s.state === 'scanning') {
    const sig = [s.i, s.n, s.course, s.phase].join('|');
    const now = Date.now();
    if (sig !== CX.sig) {
      CX.sig = sig;
      CX.sigAt = now;
    } else if (CX.sigAt && now - CX.sigAt > CX_STUCK_MS) {
      cxPollGiveUp('检查停住了（两三分钟内一点进展都没有）');
      return;
    }
  }

  if (s.state === 'done' || s.state === 'error') {
    cxStopPoll();
    if (s.state === 'error') {
      // 自动查是静默的，失败也静默 —— 但要记一笔，让 cxAutoScan
      // 隔 CX_AUTO_RETRY 再试（见 CX.autoFailAt 的注释）。
      CX.autoFailAt = Date.now() / 1000;
      // 🔴 自动查失败**不弹 toast**。用户没点任何东西，突然一条「检查失败」
      //    只会让他以为 App 坏了；而真实情况往往是「这会儿没网」，
      //    十有八九他自己也看不出来。界面上那张错误卡已经写清楚了（cxPaint）。
      if (!CX.autoScan) toast('检查失败：' + (s.err || ''));
    } else {
      // 扫成了才谈得上「新」。失败那次一条都没读到，拿它当基线
      // 会把整份列表都说成「新查到」—— 那正是 cxDiffNew 要挡的事。
      CX.newKeys = cxDiffNew(CX.prevData, CX.data);
      CX.autoFailAt = 0;
    }
    renderMe();
  }
  cxPaint();
}

/* 「我的」里那一行学习通 2026-10-22 删掉了（用户：跟现有功能重复）。
   账号相关的事现在统一在「账号管理」页，见 renderAccounts()。 */

// ------------------------------------------------------------------ 绑定 / 同步

/** 解读 /api/login 回来的 `saved` 字段。
 *
 *  空串      → 存好了（网页版走 Windows DPAPI，APK 走 Android Keystore）
 *  'soft'    → 存好了，但用的是备用密钥（Keystore 不可用，退到 ANDROID_ID 派生）
 *  'fail: x' → 没存上，x 是原因
 *  undefined → 这个数据层没有 remember 机制（老版本），按「存好了」处理，
 *              否则老服务配新界面会天天弹「密码没存住」
 *
 *  🔴 以前这里是 `res.saved === false` 的布尔判断，而**重新输密码那条路
 *     根本没看这个字段**，于是「提示已保存 → 下次又要重输」能一直存在。
 *     所以这里统一成一个入口，两条路都必须走它。
 */
function credSaved(res) {
  const v = res ? res.saved : undefined;
  if (v === undefined || v === null) return { ok: true, soft: false, why: '' };
  // 老版本 bridge（布尔值）还在跑的时候也要认，别因为契约变了就误报「没存住」
  if (v === true) return { ok: true, soft: false, why: '' };
  if (v === false) return { ok: false, soft: false, why: '数据层报告保存失败（没有给原因）' };
  const s = String(v);
  if (!s) return { ok: true, soft: false, why: '' };
  if (s === 'soft') return { ok: true, soft: true, why: '' };
  return { ok: false, soft: false, why: s.replace(/^fail:\s*/, '') || '未知原因' };
}

function setBusy(btn, busy, text) {
  if (busy) {
    btn.dataset.old = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>' + (text || '处理中…');
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.old || text || '完成';
  }
}

async function doBind() {
  const user = $('inUser').value.trim();
  const pass = $('inPass').value;
  const tip = $('bindTip');
  tip.textContent = '';
  if (!user || !pass) { tip.textContent = '学号和密码都要填'; return; }

  const btn = $('btnBind');
  setBusy(btn, true, '正在登录教务系统…');
  try {
    // 🔴 一律 remember: true。以前跟着勾选框走，取消勾选后就会出现
    //    「明明登录成功了，刷新却说没绑定」—— 数据在、密码没存，界面看不出来。
    //    密码怎么存：网页版走 Windows DPAPI，APK 走 Android Keystore，都是密文。
    const res = await api('/api/login', { username: user, password: pass, remember: true });
    if (!res.ok) { tip.textContent = res.error || '绑定失败'; return; }
    applyPayload(res);
    $('inPass').value = '';
    const sv = credSaved(res);
    if (sv.ok) {
      BOUND = true;
      CRED_STATE = 'ok';
      CRED_ERR = '';
    } else {
      // 🔴 没存住就是没存住，不能把 BOUND 置 true 蒙过去。
      //    置 false 之后「我的」里那张补密码的卡片会直接出现，
      //    用户当场就能再试一次，而不是等下次打开才发现白输了。
      BOUND = false;
      CRED_STATE = 'none';
      CRED_ERR = sv.why;
    }
    switchTab('schedule');
    renderMe();
    // applyPayload 里的 prefetchExams() 是同步跑到第一个 await 的，
    // 所以这时 prefetchTotal 已经知道有几个学期要补。告诉用户一声 ——
    // 不然他以后切学期时那一下等待还是没来由的。
    const more = prefetchTotal ? '，正在补齐其他学期的考试' : '';
    if (!sv.ok) {
      toast('登录成功，但密码没存住：' + sv.why + '。下次打开要重新输入', 6000);
    } else if (sv.soft) {
      toast('绑定成功，已同步 ' + res.courses.length + ' 条课程安排' + more + '（密码用了备用加密方式）', 4000);
    } else {
      toast('绑定成功，已同步 ' + res.courses.length + ' 条课程安排' + more);
    }
  } catch (e) {
    tip.textContent = e.message || envText('连不上电脑上的服务', '连不上教务系统，检查一下网络再试');
  } finally {
    setBusy(btn, false, '绑定并同步');
  }
}

async function doSync(goSchedule) {
  // 🔴 全局单飞。现在有四个入口能触发整份同步（我的→同步教务处数据、
  //    成绩页刷新、考试页刷新、课表页刷新），连点两下就是两次登录 ——
  //    学校那边要 3 秒防抖，还会把「点太快」当成登录失败。
  if (syncing) { toast('正在同步，稍等一下'); return; }
  syncing = true;
  $('schRefresh').classList.add('busy');
  const btn = $('btnSync');
  const v = $('meSyncTime');
  btn.disabled = true;
  const old = v.textContent;
  v.textContent = '同步中…';
  try {
    const res = await api('/api/sync', {});
    if (!res.ok) {
      if (res.needBind) {
        // 「没凭据」不等于「没绑定」。数据在的时候说「还没绑定账号」，
        // 用户看着满屏课表会觉得这软件在胡说 —— 而且他也找不到重输的地方。
        BOUND = false;
        renderMe();
        if (DATA) {
          toast('密码没存住，重新输一次就能自动同步', 3200);
          switchTab('me');                   // 直接把输入框摆到眼前
        } else {
          toast('还没绑定账号', 2600);
          switchTab('me');
        }
        v.textContent = old;
        return;
      }
      // 凭据存着但教务系统不认了（改过密码、会话过期）⇒ 让用户重输。
      if (res.authFail) {
        BOUND = false;
        renderMe();
        toast('教务系统登录失败，密码可能改过了，请重新输入', 3600);
        switchTab('me');
        v.textContent = old;
        return;
      }
      toast(res.error || '同步失败', 2600);
      v.textContent = old;
      return;
    }
    applyPayload(res);
    BOUND = true;
    toast('同步完成');
    if (goSchedule) switchTab('schedule');
  } catch (e) {
    toast(e.message || envText('连不上电脑上的服务', '连不上教务系统，检查一下网络再试'), 2600);
    v.textContent = old;
  } finally {
    syncing = false;
    $('schRefresh').classList.remove('busy');
    btn.disabled = false;
    renderMe();
  }
}

function applyPayload(res) {
  // 换账号了就别留着上一个人的「其他学期考试」缓存。
  // 同一个人的话留着：切来切去不用重新打教务系统。
  const oldSid = (DATA && DATA.profile && DATA.profile.studentId) || '';
  const newSid = (res.profile && res.profile.studentId) || '';
  const keepBySem = (oldSid && oldSid === newSid && DATA && DATA.examsBySem) || {};
  // 同步回来的是**当前学期**：正在看历史学期的话，收回当前学期。
  // 否则下面 `CFG.week = currentWeek()` 会按历史学期算（恒为 1），
  // 而界面还挂着旧的那张历史课表，用户点刷新会看到「没反应」。
  TT = null;
  DATA = {
    profile: res.profile,
    semester: res.semester,
    unitCount: res.unitCount,
    totalWeeks: res.totalWeeks,
    courses: res.courses,
    grades: res.grades,
    // 考试可能整块缺失（老版本服务、或后端兜底失败）—— 存 null 而不是 {}，
    // 让 renderExams 能区分「没这块数据」和「查了但学校没排考」
    exams: res.exams || null,
    // 培养计划。取不到时是个带 error 的空壳（native.js 里兜的），
    // 所以这里存 null 还是 {} 要分清：null = 老服务根本没有这块，
    // {} = 有这块但没取到，两种情况的提示语不一样。
    plan: res.plan || null,
    // 按学期缓存的考试（考试页切学期用），只存取成功的
    examsBySem: keepBySem,
    syncedAt: res.syncedAt,
  };
  // 新同步回来的就是当前学期 ⇒ 选中项回到默认，旧错误清掉
  examTerm = '';
  Object.keys(EXAM_ERR).forEach((k) => { delete EXAM_ERR[k]; });
  // 换了人就把上一位的空教室查询结果扔掉。同一人重新同步则留着：
  // 空教室查一次要打一次学校服务器，没换人就没必要再查一遍。
  if (oldSid !== newSid) resetRooms();
  store.set(KEY.data, DATA);
  if (migrateStartDate(DATA.semester)) { /* 旧默认值已纠正 */ }
  if (!CFG.startDate) CFG.startDate = ymd(defaultStart(DATA.semester));
  CFG.week = currentWeek();
  store.set(KEY.settings, CFG);
  renderSchedule(); renderGrades(); renderExams(); renderMe(); renderCredit();
  // 该办的事在后台查（十几秒），不挡住首屏。12 小时内不重复查。
  loadTodo(false);
  // 不 await：课表先画出来。补取是给「考试页切学期」铺路的，
  // 用户可能压根不去考试页，不能为它挡住首屏。
  prefetchExams();
}

$('btnBind').addEventListener('click', doBind);

/** 有数据但本机没存住密码时的补救入口：学号已知，只补一个密码。 */
$('btnReauth').addEventListener('click', async () => {
  const tip = $('reauthTip');
  const pass = $('inPass2').value;
  const sid = (DATA && DATA.profile && DATA.profile.studentId) || '';
  tip.textContent = '';
  if (!pass) { tip.textContent = '请输入密码'; return; }
  if (!sid) { tip.textContent = '本地没有学号，请用「解除绑定」后重新绑定'; return; }

  const btn = $('btnReauth');
  setBusy(btn, true, '正在登录…');
  try {
    const res = await api('/api/login', { username: sid, password: pass, remember: true });
    if (!res.ok) { tip.textContent = res.error || '登录失败'; return; }
    applyPayload(res);
    $('inPass2').value = '';
    // 🔴 这条路径以前**根本不看 res.saved**，登录成功就喊「已保存」。
    //    存不进去的时候照样报喜，用户下次打开又看到这张卡片 ——
    //    这正是「每次都要输密码」的由来。现在和绑定那条路走同一个判断。
    const sv = credSaved(res);
    if (!sv.ok) {
      BOUND = false;
      CRED_STATE = 'none';
      CRED_ERR = sv.why;
      renderMe();
      tip.textContent = '密码还是没存住：' + sv.why;
      toast('同步成功，但密码没存住', 5000);
      return;                              // 停在「我的」，别把用户送去课表
    }
    BOUND = true;
    CRED_STATE = 'ok';
    CRED_ERR = '';
    toast(sv.soft ? '已保存（备用加密方式），下次打开会自动同步' : '已保存，下次打开会自动同步');
    switchTab('schedule');
  } catch (e) {
    tip.textContent = e.message || envText('连不上电脑上的服务', '连不上教务系统，检查一下网络再试');
  } finally {
    setBusy(btn, false, '保存并同步');
  }
});
$('btnSync').addEventListener('click', doSync);
$('schRefresh').addEventListener('click', () => {
  // 课表页的刷新和「我的 → 同步教务处数据」是同一件事：
  // 课表、成绩、考试一起重新拉，不是只刷课表。
  if (!DATA) { toast('先绑定账号'); return; }
  doSync();
});
$('examRefresh').addEventListener('click', () => {
  if (!DATA) { toast('先绑定账号'); return; }
  // 看的是成绩 ⇒ 只能整份同步（成绩是随整份同步下来的，没有单取接口）
  if (CFG.examView === 'grade') { doSync(); return; }
  // 看的是别的学期就只刷那一个学期；当前学期才走整份同步
  // （整份同步要重登、重取课表成绩，为了看一眼旧学期的考试不值当）
  const curId = (DATA.exams && DATA.exams.semesterId) || '';
  if (examTerm && examTerm !== curId) {
    delete EXAM_ERR[examTerm];
    if (DATA.examsBySem) delete DATA.examsBySem[examTerm];
    loadExamTerm(examTerm);
    return;
  }
  doSync();
});

/* ---------------- 清本地缓存 ----------------
 *
 * 🔴 这里原来只清 `zt.data`（课表/成绩）。0.7.0 加了三个新缓存键之后，
 *    按钮说的和做的就对不上了：用户点「清除本机缓存」，一卡通和公告还是旧的那份。
 *
 * 分两个层次，别混：
 *   · **清缓存**（`clearLocalCaches`）：只扔「能重新拉回来」的数据，
 *     **保留登录状态** —— 清个缓存不该逼人重新输密码。
 *   · **解绑**：在清缓存的基础上，**再清登录状态**（教务 + 门户）。
 *     解绑的确认框写着「会删掉……缓存数据」，而 `resetRooms()` 早就在做
 *     「把别人的数据全扔掉」这件事了 —— 门户不跟着清就不一致。
 */
function clearLocalCaches() {
  cancelPrefetch();
  DATA = null;
  store.del(KEY.data);
  store.del(KEY.card);
  store.del(KEY.apps);
  store.del(KEY.notice);
  examTerm = '';
  Object.keys(EXAM_ERR).forEach((k) => { delete EXAM_ERR[k]; });
  resetRooms();

  // 内存里的也要跟着清：只删 localStorage 的话，屏幕上那份还在，
  // 用户会以为「清了个寂寞」，直到下次重启才变。
  CAMPUS.bal = null; CAMPUS.rows = []; CAMPUS.total = 0;
  CAMPUS.apps = []; CAMPUS.at = 0; CAMPUS.fromCache = false;
  NT.all = []; NT.total = 0; NT.sources = 0; NT.at = 0;
  NT.failed = []; NT.err = ''; NT.tried = false; NT.fromCache = false;

  renderSchedule(); renderGrades(); renderExams(); renderMe();
  renderCampus();
  // 公告：tried=false 时 ntPaintState 会整块收起来（不当成「没有记录」），
  // 下次点进公告 tab 会自己重新取。
  renderNotice();
}

/* 解绑教务。抽成具名函数是为了让「账号管理」页也能调它 ——
   抄第二份的话，以后改确认文案/清理范围必定漏一处。 */
async function unbindJw() {
  // 🔴 这里原来写的是 `if (!confirm(...)) return;` —— 在 APK 里 confirm()
  //    不弹框直接返回 false，于是整段代码从来没执行过（按钮形同虚设）。
  //    换成自绘确认框，原因见 askConfirm 上面那段。
  const ok = await askConfirm('解除绑定',
    envText('会删掉电脑上保存的账号密码，手机里的数据也会清空，智慧门户会一起断开。',
      '会删掉手机里存的账号密码和已同步的数据，智慧门户会一起断开。'),
    '解除绑定');
  if (!ok) return;
  // 🔴 先停后台补取，再去打网络。以前这句放在 await 后面，
  //    而 /api/unbind 一个来回要几百毫秒 —— 这期间补取还会再发下一个学期的
  //    请求，等于「用户已经点了解绑，后台还在拿他的凭据打学校服务器」。
  cancelPrefetch();
  try { await api('/api/unbind', {}); } catch (e) { /* 服务没开也要能解绑本地 */ }
  // 门户单独一套凭据，`/api/unbind` 不管它。这里必须自己断 ——
  // 不断的话，换个人用这台手机，打开「校园」页看到的还是上一个人的一卡通。
  try { await api('/api/portal/logout', {}); } catch (e) { /* 同上，尽力而为 */ }
  CAMPUS.state = 'none'; CAMPUS.user = ''; CAMPUS.open = false;
  CAMPUS.saved = false; CAMPUS.savedUser = '';   // 解绑连门户密码一起清
  clearLocalCaches();
  CFG.startDate = '';
  store.set(KEY.settings, CFG);
  probeBound();                  // 电脑上已经不绑了 ⇒「直接同步」得跟着消失
  toast('已解除绑定');
  renderAccounts();
}
// 0.39.1：这一行原来挂的是「我的」页那个整行红按钮 `#btnUnbind`。
// 入口已收进「我的 → 账号管理 → 教务系统 → 解绑」（那里调的是同一个 unbindJw）。

$('btnClearCache').addEventListener('click', async () => {
  // 同上：confirm() 在 WebView 里不弹框，换成自绘的
  const ok = await askConfirm('清除缓存',
    envText('只清手机里的缓存，电脑上的账号还留着。',
      '会删掉课表、成绩、一卡通、公告这些数据，账号还留着。'),
    '清除');
  if (!ok) return;
  // 🔴 必须走 clearLocalCaches()，不能在这儿手抄一遍删除语句 ——
  //    0.7.0 加了三个缓存键，抄漏了按钮就名不副实（清完一卡通还是旧的）。
  //    这里**不清登录状态**：清缓存不该逼人重新输密码。
  clearLocalCaches();
  toast('已清除，下次进来会重新同步');
});

$('goBind').addEventListener('click', () => switchTab('me'));
$('goBind2').addEventListener('click', () => switchTab('me'));
$('goBind3').addEventListener('click', () => switchTab('me'));
$('goBind4').addEventListener('click', () => switchTab('me'));
$('goBind5').addEventListener('click', () => switchTab('me'));
$('exRetry').addEventListener('click', () => {
  const sid = examTerm;
  delete EXAM_ERR[sid];
  loadExamTerm(sid);
});

// -- 空闲教室
$('rmGo').addEventListener('click', () => queryRooms());
$('rmRefresh').addEventListener('click', () => {
  if (!DATA) { toast('先绑定账号'); return; }
  queryRooms();
});
$('rmRetry').addEventListener('click', () => queryRooms());
$('rmFilterRow').addEventListener('click', () => {
  ROOM.filterOpen = !ROOM.filterOpen;
  renderRoomFilter();
  // 展开的时候顺手把筛选项拉回来（上次可能因为没网失败了）
  if (ROOM.filterOpen && !ROOM.opts) loadRoomOptions();
});
$('rmDate').addEventListener('change', () => {
  const v = $('rmDate').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;   // 用户点了取消
  if (v === ROOM.date) return;
  ROOM.date = v;
  roomChanged();
});

// ------------------------------------------------------------------ 已绑探测

/** 学号打码：2023123456 -> 2023****56
 *  屏幕可能被别人看到，也避免截图外传，所以只露头尾。
 *  （能拿到 token 的人本来就有权限，打码只是防「路过看一眼」）
 */
function maskUid(s) {
  s = String(s || '');
  if (s.length <= 6) return s ? s.slice(0, 1) + '****' : '';
  return s.slice(0, 4) + '****' + s.slice(-2);
}

/** 按运行环境替换文案。
 *
 *  HTML 里用 data-web / data-app 两个属性写两套说法，这里挑一套塞回去。
 *  为什么不用两套 HTML：两边共用一份界面，改一次就够，不会漂。
 */
function applyEnvTexts() {
  if (!NATIVE) return;                     // 网页版就用 HTML 里默认那套
  document.querySelectorAll('[data-app]').forEach((el) => {
    el.textContent = el.dataset.app;
  });
}

/** 问一下本地数据层：这台机器绑过账号没有。
 *
 *  场景：换了手机、清了浏览器缓存 —— 手机里没数据了，但电脑上的凭据还在。
 *  以前这种情况只能把密码再输一遍，其实没必要。
 *
 *  🔴 这里问的是「本机存住凭据了吗」，和「本地有课表数据吗」是两件事。
 *     两者可能不一致：数据在、密码没存（Keystore 失败 / 老版本没存）。
 *     所以结果存进 BOUND，让 renderMe 决定要不要提示「重新输入密码」。
 */
async function probeBound() {
  let st = null;
  try {
    st = await api('/api/state');
  } catch (e) {
    BOUND = null;                            // 服务没开：状态未知，别乱提示
    CRED_STATE = null;
    return;
  }
  BOUND = !!(st && st.ok && st.bound);
  // 服务没给 credState（老版本 bridge）⇒ 只知道自己没绑，不知道是哪种没绑
  CRED_STATE = (st && st.credState) ? String(st.credState) : (BOUND ? 'ok' : null);
  if (BOUND) CRED_ERR = '';                  // 存住了，上一次的失败原因就没意义了
  document.querySelectorAll('.quickbox').forEach((el) => { el.hidden = !BOUND; });
  if (BOUND) {
    document.querySelectorAll('.qwho').forEach((el) => { el.textContent = maskUid(st.username); });
  }
  renderMe();                                // 凭据状态变了，提示卡要跟着变
}

$('btnQuick').addEventListener('click', () => { doSync(true); });
$('goQuick').addEventListener('click', () => { switchTab('me'); doSync(true); });
$('btnUpdate').addEventListener('click', () => { openUpdateSheet(); });
// 办事入口默认折着（19 个一年用不了几次）。展开状态不存盘：
// 下次进来还是折着 —— 它本来就是低频的东西，记住了反而让首页变长。
$('cpAppsToggle').addEventListener('click', () => {
  const box = $('cpAppsBox');
  const open = box.hidden;
  box.hidden = !open;
  $('cpAppsToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
});
// 「校园服务」（一卡通 / 办事入口 / 门户）整块默认折着。
// 用户 2026-10-30：「校园页的绝大部分功能使用频率都极低」——
// 这一页的主体是直饮水，低频的东西不该占着上半屏。
$('cpMoreToggle').addEventListener('click', () => {
  const box = $('cpMoreBox');
  const open = box.hidden;
  box.hidden = !open;
  $('cpMoreToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
});
// 公告并进了功能页：一行入口，点进完整列表（列表页还在，只是不占 tab）。
$('ntEnter').addEventListener('click', () => { switchTab('notice'); });
// 没登慧生活时那颗按钮：账号在「我的 → 账号管理」，直接把人送过去并展开设备登录。
$('wtGoLogin').addEventListener('click', () => {
  switchTab('accounts');
  wtAccTap('device');
});
$('wtCapNew').addEventListener('click', () => { wtNewCaptcha(); });
// 点图也能换一张。图和「看不清？换一张」是同一个动作 —— 用户看图第一反应
// 是点图，不是找链接。
$('wtCapImg').addEventListener('click', () => { wtNewCaptcha(); });
// 图挂了也要给个交代：静默失败的话用户看到的是一个空框，不知道是网慢还是坏了。
// 🔴 这里**不能**自动重新拉 —— 会和 wtNewCaptcha 打成一个循环（每张图都挂就
//    无限请求）。只提示，让用户自己点。
$('wtCapImg').addEventListener('error', () => {
  $('wtCapImg').classList.add('bad');
  wtTip('图形验证码没加载出来，点一下换一张', true);
});
$('wtSend').addEventListener('click', () => { wtSendSms(); });
$('wtLogin').addEventListener('click', () => { wtLogin(); });
// 两行账号：点「登录」展开表单，点「退出」只退那一格。
$('wtAccDeviceBtn').addEventListener('click', () => { wtAccTap('device'); });
$('wtAccScoreBtn').addEventListener('click', () => { wtAccTap('score'); });
$('wtLoginCancel').addEventListener('click', () => { wtCancelLogin(); });
// 刷新 = 刷新**这一页**（余额设备 + 积分 + 任务 + 账单），不是只刷余额。
// 只刷一半的话，用户看到「余额变了、积分还是刚才那个数」，会以为积分不更新。
// 0.27.0 起页头只有一颗刷新（直饮水并进功能页了），它两样都刷。
$('wtOpenApp').addEventListener('click', () => { openWater(); });
// 0.39.1：「退出登录」整行删了，改由「账号管理」里设备/积分各自的「退出」承担
// （`wtAccTap` → `wtLogout(kind)`）。这一页只留常用动作。
// 「重新登录」不跳别处，就在本页把表单换出来 —— 手机号还在，只要再收条短信。
$('wtRelogin').addEventListener('click', () => { wtShowOff(); });
// 0.24.0：一键完成任务 / 加载更多账单 / 停止接水 / 免责声明
$('wtRunAll').addEventListener('click', () => { wtRunAll(); });
// 0.33.0：任务明细默认收起（一屏的预算），点标题行展开。
// 🔴 只折叠**明细**，不折「一键完成」—— 收起不是让操作多一步。
$('wtTaskOpen').addEventListener('click', () => {
  const box = $('wtTaskBox'), hd = $('wtTaskOpen');
  const open = box.hidden;
  box.hidden = !open;
  hd.setAttribute('aria-expanded', open ? 'true' : 'false');
});
// 「停下」只置标记，真正退出发生在下一个检查点 —— 不打断正在飞的那一个请求
// （打断了服务端可能已经收下，我们却当成没发，下次还会再发一次）。
$('wtRunStop').addEventListener('click', () => {
  WT.runStop = true;
  toast('正在停…（正在提交的那一个会走完）');
});
$('wtBillMore').addEventListener('click', () => { wtLoadBills(true); });
// ---- 积分兑换余额（0.27.1）----
// 默认收起：这一页已经很长，不兑换的人不该先看一堆控件。
$('wtExOpen').addEventListener('click', () => {
  WT.ex.open = !WT.ex.open;
  WT.ex.qty = 1;                 // 每次打开从 1 份开始，别记住上一次的份数
  $('wtExMsg').hidden = true;
  wtExPaint();
});
$('wtExUnits').addEventListener('click', (e) => {
  const b = e.target.closest('.wtchip');
  if (!b) return;
  WT.ex.unit = Number(b.dataset.unit);
  WT.ex.qty = 1;                 // 换档位时份数归 1 —— 留着旧份数会突然变成「积分不够」
  wtExPaint();
});
// 份数的上下限：下限 1，上限 = 可用积分买得起的份数（和 wtExTotalOf 同一个判据）
$('wtExMinus').addEventListener('click', () => {
  WT.ex.qty = Math.max(1, WT.ex.qty - 1);
  wtExPaint();
});
$('wtExPlus').addEventListener('click', () => {
  const avail = (WT.score && typeof WT.score.valid === 'number') ? WT.score.valid : null;
  const max = avail == null ? 1 : Math.floor(avail / WT.ex.unit);
  WT.ex.qty = Math.min(Math.max(1, max), WT.ex.qty + 1);
  wtExPaint();
});
// 多个钱包时点「兑换到」换一个（只有一个钱包时这颗按钮是 disabled 的）
$('wtExTo').addEventListener('click', async () => {
  const ws = Array.isArray(WT.ex.wallets) ? WT.ex.wallets : [];
  if (ws.length < 2) return;
  const cur = wtExCurWallet();
  const id = await openPick('兑换到哪个钱包', '', [{
    items: ws.map((w) => ({ id: w.endpointId, name: w.name })),
  }], cur ? cur.endpointId : '');
  if (id == null) return;        // 取消 = 不换
  WT.ex.eid = id;
  wtExPaint();
});
$('wtExGo').addEventListener('click', () => { wtExGo(); });
$('wtDevAdd').addEventListener('click', () => { wtAddDevStart(); });
// 0.37.0：手动输入编号（不碰相机）。两颗图标各管一条路，
// 有相机也不影响这一颗 —— 用户点了「手动输入」就是不想扫。
$('wtDevType').addEventListener('click', () => { wtAddDev(); });
// 「已隐藏 N 台 · 恢复」：一次全恢复，不做二级页面（一共最多几十台）
$('wtDevShow').addEventListener('click', async () => {
  const n = wtHiddenCount();
  if (!n) return;
  const ok = await askConfirm('恢复 ' + n + ' 台？',
    '它们会重新出现在列表里。', '恢复', false);
  if (!ok) return;
  wtUnhideAll();
  wtPaintDevs();
});
// 消费记录默认收起：这一页先回答「还有多少钱」，明细是偶尔翻的。
$('wtBillOpen').addEventListener('click', () => {
  const open = $('wtBillBox').hidden;
  $('wtBillBox').hidden = !open;
  $('wtBillOpen').setAttribute('aria-expanded', open ? 'true' : 'false');
});
$('wtScanClose').addEventListener('click', () => { wtScanStop(); });
// 相机用不了时的退路：先关相机（不然灯一直亮），再走粘贴那条老路。
$('wtScanPaste').addEventListener('click', () => { wtScanStop(); wtAddDev(); });
// ---- 估算水量（0.30.0）----
// 点那一行才展开。不改比例的人不该先看两个输入框 —— 这一页已经够长了。
$('wtUseRow').addEventListener('click', () => {
  const box = $('wtUseBox');
  if (!box.hidden) { box.hidden = true; return; }
  const c = wtUsageCfg();
  $('wtUseAmt').value = wtNumText(c.amt);
  $('wtUseVol').value = wtNumText(c.vol);
  // 关掉之后按钮要变成「显示水量」，否则关了就没有任何办法开回来。
  $('wtUseOff').textContent = c.on ? '不显示水量' : '显示水量';
  box.hidden = false;
});
$('wtUseSave').addEventListener('click', () => {
  const amt = Number(String($('wtUseAmt').value).trim());
  const vol = Number(String($('wtUseVol').value).trim());
  // 空串 Number('') 是 0，会被 > 0 挡掉 —— 不会把 0 存进去算出「0 ml」
  if (!isFinite(amt) || amt <= 0 || !isFinite(vol) || vol <= 0) {
    toast('金额和水量都要填大于 0 的数');
    return;
  }
  wtUsageSave({ on: true, amt, vol });
  $('wtUseBox').hidden = true;
  wtPaintStats();
  toast('已保存');
});
// 只填默认值不保存的话，点了看着像生效了其实没变 —— 这里一步到位。
$('wtUseDef').addEventListener('click', () => {
  wtUsageSave({ on: true, amt: WT_USE_DEF.amt, vol: WT_USE_DEF.vol });
  $('wtUseBox').hidden = true;
  wtPaintStats();
  toast('已恢复默认比例');
});
$('wtUseOff').addEventListener('click', () => {
  const c = wtUsageCfg();
  // 比例留着：下次点「显示水量」还是上次填的那个价，不用重填
  wtUsageSave({ on: !c.on, amt: c.amt, vol: c.vol });
  $('wtUseBox').hidden = true;
  wtPaintStats();
});
$('wtStop').addEventListener('click', () => { wtStop(); });
$('wtTermsOk').addEventListener('click', () => { wtTermsOk(); });
// 返回回「校园」—— 百科 0.21.0 从「我的」搬到「校园」了（见 SUB_PARENT）。
// ⚠️ 这里和 SUB_PARENT 必须一致：不一致的话，点返回去的页面和底部高亮的
//    tab 是两个东西，用户会以为自己点错了。
// 头卡上那个「打开原站首页」。走 openWiki 同一条路 —— 白名单、开不了时说一句，
// 一个都不能少。别在这里另写 openApp / openExternal。
$('wikiHome').addEventListener('click', () => { openWiki(WIKI_HOME + '/'); });

/** 安卓返回键：先关浮层，再回课表，最后才退出 App。
 *
 *  不加这个的话，课程详情弹着的时候按返回会直接把 App 退掉，
 *  下次进来还得重新找那门课 —— 安卓上这属于「手感不对」。
 *  返回 true 表示「我处理了」，原生那边就不退出。
 */
window.appBack = function () {
  // 扫码浮层在最上面。返回键必须先把相机**关掉**再收浮层 —— 只藏浮层的话
  // 相机轨道还在跑，指示灯常亮，下次再开还会报「被占用」。
  if (!$('wtScan').hidden) { wtScanStop(); return true; }
  // 免责声明层在最上面，先关它。**不记「已读」** —— 没点「我知道了」就
  // 不算读过，下次进来还得看。挂着的那个动作也一起丢掉：用户按返回就是不想做了。
  if (!$('wtTerms').hidden) { $('wtTerms').hidden = true; wtPending = null; return true; }
  // 弹层开着 ⇒ 按返回 = 取消。走 closeSheet（它负责把挂着的 Promise 结掉）
  if (!$('sheetMask').hidden) { closeSheet(); return true; }
  // 子页（校历 / 空教室 / 账号管理）先回它所属的那个 tab；
  // 不在子页就先回课表，再按一次才退出
  if (SUBPAGES.indexOf(CUR_PAGE) >= 0) {
    switchTab(SUB_PARENT[CUR_PAGE] || 'schedule');
    return true;
  }
  if (CUR_PAGE !== 'schedule') { switchTab('schedule'); return true; }
  return false;
};

// ------------------------------------------------------------------ 检查更新
/* 更新清单是一份静态 JSON，跟发布页放在同一个域名下，APK 和网页版查的是同一份。
 *
 * 为什么不用 GitHub Releases API：国内访问 github.com 时通时断（校网里尤其明显），
 * 而且它要带 token、有速率限制、返回体还大。静态 JSON 一次几百字节，
 * 失败也不打扰人 —— 查更新失败对用户来说什么都不是，不该弹错误框。
 *
 * 🔴 这份 JSON 必须带 `Access-Control-Allow-Origin: *`：
 *    APK 的页面源是 https://app.local，网页版是 http://127.0.0.1:8788，
 *    两边都是跨域请求。少了这个头，fetch 会静默失败，
 *    表现成「永远显示已是最新版本」—— 又是一个把错误说成事实的坑。
 */
const UPD_SRC = [
  'https://hobson2233.dpdns.org/hangyuantong/version.json',
  'https://raw.githubusercontent.com/Hobson2233/hangyuantong/main/version.json',
];
// 频率 → 允许的间隔（秒）。always = 0，即每次打开都查。
const UPD_FREQ_SEC = { always: 0, daily: 86400, weekly: 7 * 86400 };
const UPD_FREQ_CN = { always: '每次打开', daily: '每天一次', weekly: '每周一次' };
const UPD_FREQ_LIST = ['always', 'daily', 'weekly'];

let updBusy = false;
/* 自动检查查到新版本时，用户正开着别的弹层 —— 先存这儿，等他关掉再弹。
   存的是清单本身，不是「待办标记」：关掉的那一刻直接拿来渲染。 */
let updPending = null;

/** 把 '0.10.2' 拆成 [0,10,2]。别用字符串比大小 —— "0.10" < "0.9"。 */
function verNum(s) {
  return String(s || '').replace(/^v/i, '').split(/[.\-+_]/)
    .map((x) => parseInt(x, 10) || 0);
}

/** 比较两个版本号：a 比 b 新返回 1，一样返回 0，旧返回 -1。 */
function verCmp(a, b) {
  const A = verNum(a); const B = verNum(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const fmtBytes = (n) => {
  const v = Number(n);
  if (!(v > 0)) return '';
  if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
};

function updAgo(ts) {
  if (!ts) return '还没检查过';
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 0) return '刚刚检查过';
  if (d < 60) return '刚刚检查过';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前检查过';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前检查过';
  return Math.floor(d / 86400) + ' 天前检查过';
}

/** 依次试几个源，谁先给出合法清单就用谁。全挂了返回 ok:false + 原因。
 *
 *  🔴 界面上的原因只说人话，**状态码一律留在控制台**（2026-11-01 改）。
 *     以前非 2xx 直接 `why = 'HTTP ' + status`，用户看到的是
 *     「检查失败：HTTP 404」—— 他既不能改代码也不能重发版，
 *     这句话除了让人以为是自己手机坏了，没有任何用。
 *     现在只分两种，因为用户能做的只有两件事：
 *       · 连不上网     -> 去看网络
 *       · 服务暂时不可用 -> 过会儿再试
 */
async function fetchManifest() {
  let why = '';
  for (let i = 0; i < UPD_SRC.length; i++) {
    const base = UPD_SRC[i];
    try {
      const u = base + (base.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now();
      // no-store + 时间戳：清单换版本时必须立刻拿到新的，
      // 否则用户点了更新还看到旧版本号（缓存在 CDN 边缘节点上）。
      const r = await fetch(u, { cache: 'no-store' });
      if (!r.ok) { console.warn('[upd] ' + u + ' -> HTTP ' + r.status); why = '更新服务暂时不可用'; continue; }
      const j = await r.json();
      if (!j || typeof j !== 'object' || !j.version) { console.warn('[upd] ' + u + ' 清单格式不对'); why = '更新服务暂时不可用'; continue; }
      return { ok: true, info: j };
    } catch (e) {
      const m = (e && e.message) || String(e);
      console.warn('[upd] ' + u + ' 失败：' + m);
      why = /failed to fetch|load failed|networkerror|network error/i.test(m)
        ? '连不上网，检查一下网络'
        : '更新服务暂时不可用';
    }
  }
  return { ok: false, error: why || '连不上网，检查一下网络' };
}

/** 查一次。返回 {ok, newer, info, error}，界面怎么显示由调用方决定。
 *
 *  🔴 以前这里用 toast 报结果，结果弹层一开，toast 正好压在按钮上
 *     （弹层从底部升起，toast 也在底部）。现在一律不弹 toast：
 *     结果写在弹层自己那一行字里，或者直接换成「发现新版本」。
 */
async function checkUpdate(manual) {
  if (updBusy) return { ok: false, busy: true, error: '正在检查中' };
  updBusy = true;
  let r;
  try { r = await fetchManifest(); } finally { updBusy = false; }

  if (!r.ok) {
    // 自动检查失败就彻底安静：查更新失败不代表任何功能坏了。
    return { ok: false, error: r.error };
  }
  const info = r.info;
  CFG.updLast = Math.floor(Date.now() / 1000);
  store.set(KEY.settings, CFG);

  // code 是整数，优先信它；清单里没有 code 的老格式退回比版本号字符串。
  const newer = (typeof info.code === 'number')
    ? info.code > APP_CODE
    : verCmp(info.version, APP_VERSION) > 0;

  if (!newer) {
    if (manual) renderMe();
    return { ok: true, newer: false, info };
  }
  // 自动检查时，用户点过「以后再说」的那个版本不再自己弹；
  // 手动点「检查更新」还是弹 —— 那是他自己要看。
  if (!manual && CFG.updSkip === String(info.version)) {
    return { ok: true, newer: true, info, skipped: true };
  }
  // 手动点的时候必须当场换掉面板（他就是来看这个的），自动的则排队。
  showUpdateSheet(info, !!manual);
  return { ok: true, newer: true, info };
}

/* ---------------------------------------------------------------- 应用内下载
 *
 * 只有 APK 里有（网页版 NativeApi.update.available() 返回 false，退回浏览器）。
 *
 * 为什么值得做：以前点「立即更新」是跳到系统浏览器，很多人下完根本不知道
 * 还要去通知栏点一下，回来问「怎么没更新」。现在是自己下、自己校验、自己
 * 把安装界面拉起来 —— 中间不用离开 App。
 *
 * 🔴 有一条做不到：**不能静默安装**。Android 不许一个 App 自己装自己，
 *    最后一定弹系统安装器让用户点「安装」。所以这里的终点是「把安装界面拉起来」。
 *
 * 状态机：idle → downloading → ready → （交给系统）→ 用户点安装
 *                ↘ failed（换线路重试一次，仍失败就报错）
 *                ↘ needperm（缺「安装未知应用」授权）
 */
let updDl = null;
/* { id, ver, lines, i, timer, state, pct, total, got, err, allowBrowser,
     note, startedAt, lastBytes, lastAt } */

/** 「下载器不动了」的判据。
 *
 *  🔴 为什么必须有这一条（0.26.4 加的，用户实测卡在 0%）：系统下载器有三种
 *     「没在动」的样子 —— 排队等(1)、网络错误后暂停(4)、以及下载中但一直
 *     0 字节 —— 它们和「正在下」在界面上**长得一模一样**。
 *     0.26.3 及以前只认 8(完成) 和 16(失败)，剩下的全当「正在下载」，
 *     于是卡住以后永远显示「正在下载 0%」，主按钮还是禁用的 ⇒ **没有任何出口**。
 *     状态机缺的不是分支，是**时间**。
 *
 *  🔴 0.37.0 拆成两个数（用户 2026-11-01：「点下载进度一直卡住，非常频繁」）：
 *     以前只有一个 30 秒，**「还没开始」和「下到一半停了」共用一个判据**，
 *     结果是「这条线路压根没起来」也要干等 30 秒。包只有 546 KB，正常线路
 *     一秒内就开始出字节了 —— 8 秒一个字节都没有，就不是「慢」，是「不通」。
 *     分开以后最坏等待从 60 秒（两条线各 30）降到 20 秒左右。
 */
const UPD_BOOT_MS = 8000;    // 入队后这么久一个字节都没下来 = 这条线路没起来
const UPD_STALL_MS = 20000;  // 已经出过字节，之后再停这么久 = 真的断了


/** 现查现用，不在模块加载时缓存 —— 网页版里这个对象永远不存在。 */
function nativeUpd() {
  const u = window.NativeApi && window.NativeApi.update;
  if (!u || typeof u.available !== 'function' || !u.available()) return null;
  return u;
}

/* ---- 下载线路（0.37.0）
 *
 * 两条线路对**系统下载器**的友好程度不一样，这是本轮排查的结论：
 *
 *   · 主站（Cloudflare Worker）回 `Content-Length: 559060` —— 下载器知道
 *     总大小，进度条能一格一格走。
 *   · CNB 制品库是**分块传输**：没有 `Content-Length`，也不支持断点
 *     （实测 `Range: bytes=0-99` 回的是 200 整包，不是 206）。
 *     这种响应在部分国产 ROM 上会让系统下载器一直停在 0%，用户看到的就是
 *     「进度卡住」—— 而它其实不是慢，是**读不到任何进度**。
 *
 * CNB 在国内快得多，所以默认仍然先走它（用户 2026-11-01 明确要求）；
 * 但「先走」不等于「只能走」：8 秒没字节就换下一条，弹层里也能手动换。
 * 记住用户手动选的那条 —— 他按过一次「换线路」，下次不该再按第二次。
 */
const UPD_LINES = [
  { id: 'cn', name: '国内线路', of: (info) => info.apk_cn },
  { id: 'main', name: '主站', of: (info) => info.apk },
];

/** 当前该用哪条线路。没选过 / 存的值不认识 ⇒ 国内线路（用户定的默认）。 */
function updLineId() {
  const v = String(CFG.updLine || '');
  return UPD_LINES.some((l) => l.id === v) ? v : 'cn';
}

/** 排好的线路：**选过的那条在最前**，其余按 UPD_LINES 顺序兜底。
 *  空地址和重复地址都在这里剔掉 —— 清单里 `apk_cn` 缺了是常事（老格式）。 */
function updLines(info) {
  const first = updLineId();
  const arr = UPD_LINES.slice().sort(
    (a, b) => (b.id === first ? 1 : 0) - (a.id === first ? 1 : 0));
  const out = [], seen = {};
  arr.forEach((l) => {
    const u = l.of(info);
    if (typeof u !== 'string' || !/^https?:\/\//.test(u) || seen[u]) return;
    seen[u] = 1;
    out.push({ id: l.id, name: l.name, url: u });
  });
  return out;
}

/** 只要地址（「用浏览器下载」那条退路，以及判据里比顺序用）。 */
function updUrls(info) {
  return updLines(info).map((l) => l.url);
}

/** 下载到本机的文件名。只用 ASCII —— 中文名在有些 ROM 的下载目录里会变乱码。 */
function updName(info) {
  const v = String(info.version || '').replace(/[^0-9A-Za-z._-]/g, '');
  return 'hangyuantong-' + (v || 'new') + '.apk';
}

/** DownloadManager 的失败原因码。不翻译的话界面上就是一句「错误码 1008」。 */
function updReason(code) {
  const m = {
    1001: '存不下这个文件',
    1002: '下载服务出问题了，请重试',
    1003: '下载中断了（可能断网了）',
    1004: '下载地址不对',
    1005: '存储空间不够',
    1006: '手机存储读不了',
    1007: '下载中断了，重新下一次',
    1008: '连不上网',
    1009: '文件已存在',
    1010: '被系统拦下了',
    1011: '文件太大',
  };
  return m[code] || ('错误码 ' + code);
}

/** 按当前状态把按钮、进度条、提示刷一遍。找不到元素（弹层已关）就直接返回。 */
function updPaint(info) {
  const box = $('updProg'), bar = $('updBarFill'), pct = $('updPct');
  const go = $('updGo'), later = $('updLater'), tip = $('updTip');
  if (!box || !bar || !pct || !go || !later || !tip) return;
  const st = updDl ? updDl.state : 'idle';
  const p = updDl ? updDl.pct : 0;

  // 失败时**不显示**进度条：一条 100% 的红条看着像「下满了」，
  // 而失败跟进度没关系，说明不了任何事，只会误导。
  box.hidden = (st === 'idle' || st === 'failed');
  // 总大小未知时进度条改成「来回跑」的不确定态 —— 停在 0% 的死条和
  // 「卡住」长得一样，而我们这时**确实不知道**还剩多少。
  box.classList.toggle('indet', st === 'downloading' && !updDl.total);
  if (box.classList.contains('indet')) bar.style.width = '';
  else bar.style.width = (st === 'ready' || st === 'needperm') ? '100%' : p + '%';
  updLinePaint(info);

  if (st === 'downloading') {
    go.disabled = true;
    go.textContent = updDl.total ? ('正在下载 ' + p + '%') : '正在下载';
    later.textContent = '后台下载';
    pct.textContent = (updDl.total
      ? ('已下载 ' + p + '% · 共 ' + fmtBytes(updDl.total))
      : ('已下载 ' + (fmtBytes(updDl.got) || '0 KB') + '（这条线路没给文件大小）')) +
      (updDl.note ? ' · ' + updDl.note : '');
    tip.textContent = '';
    tip.classList.remove('bad');
  } else if (st === 'ready') {
    go.disabled = false;
    go.textContent = '安装';
    later.textContent = '以后再说';
    pct.textContent = '下载完成，安装包已校验';
    tip.textContent = '';
    tip.classList.remove('bad');
  } else if (st === 'needperm') {
    go.disabled = false;
    go.textContent = '去允许安装';
    later.textContent = '以后再说';
    pct.textContent = '下载完成，安装包已校验';
    tip.textContent = '手机还没允许这个 App 安装应用。点上面那个按钮去设置里打开，' +
      '回来再点一次「安装」。';
    tip.classList.remove('bad');
  } else if (st === 'failed') {
    go.disabled = false;
    go.textContent = updDl && updDl.allowBrowser ? '用浏览器下载' : '重试';
    later.textContent = '以后再说';
    pct.textContent = '';
    tip.textContent = (updDl && updDl.err) || '下载失败';
    tip.classList.add('bad');
  } else {
    go.disabled = false;
    go.textContent = '立即更新';
    later.textContent = '以后再说';
    pct.textContent = '';
    tip.textContent = '';
    tip.classList.remove('bad');
  }
}

/** 画「线路」那一行。清单里只有一个地址时整行不出现 ——
 *  一颗按了没得选的按钮比没有更糟（同一个理由见「兑换到」那行）。 */
function updLinePaint(info) {
  const row = $('updLineRow'), sw = $('updLineSw');
  if (!row || !sw) return;
  const lines = info ? updLines(info) : [];
  const st = updDl ? updDl.state : 'idle';
  // 已经下完了就不给换了：这时候换线路只是把校验过的包再下一遍。
  row.hidden = lines.length < 2 || st === 'ready' || st === 'needperm';
  if (row.hidden) return;
  const cur = (updDl && updDl.lines[updDl.i]) ? updDl.lines[updDl.i] : lines[0];
  sw.textContent = '线路：' + cur.name;
}

/** 手动换一条线路。
 *
 *  🔴 下载中换线路 = **取消当前任务、从 0 重下**，不是「接着下」——
 *     两条地址是同一个包的两份拷贝，字节对不上，硬接会把包装坏。
 *     这里不弹确认：用户按了「换线路」就是受够了这条，再多一次确认只是添堵。
 * 🔴 换之前必须 cancel 旧任务（理由见 updDropLine 那段注释：僵尸任务会自己
 *     活过来往同一个文件名里写）。
 */
function updSwitchLine(info) {
  const lines = updLines(info);
  if (lines.length < 2) return;
  const cur = (updDl && updDl.lines[updDl.i]) ? updDl.lines[updDl.i].id : lines[0].id;
  const next = lines.filter((l) => l.id !== cur)[0];
  if (!next) return;
  const u = nativeUpd();
  if (updDl) {
    if (u && updDl.id) u.cancel(updDl.id);
    if (updDl.timer) clearInterval(updDl.timer);
    updDl = null;
    CFG.updDlId = 0;
  }
  // 记住他选的这条：按过一次「换线路」，下次不该再按第二次
  CFG.updLine = next.id;
  store.set(KEY.settings, CFG);
  if (updStart(info)) updPaint(info);
  else updPaint(info);
}

/** 入队下载。返回 false = 这台设备/这个版本没有应用内下载能力。 */
function updStart(info) {
  const u = nativeUpd();
  if (!u) return false;
  const lines = updLines(info);
  if (!lines.length) return false;
  if (updDl && updDl.timer) clearInterval(updDl.timer);
  updDl = { id: 0, ver: String(info.version || ''), lines: lines, i: 0, timer: 0,
            state: 'downloading', pct: 0, total: Number(info.size) || 0,
            err: '', allowBrowser: false, note: '', got: 0,
            // lastBytes 从 -1 起步：第一次拿到 0 也算「变了」，好让计时从
            // 真正开始查的那一刻算，而不是从页面打开的那一刻算。
            startedAt: Date.now(), lastBytes: -1, lastAt: Date.now() };
  updEnqueue(info);
  return true;
}

/** 按当前线路入队；入队本身失败就换下一条。 */
function updEnqueue(info) {
  const u = nativeUpd();
  if (!u || !updDl) return;
  const r = u.start(updDl.lines[updDl.i].url, updName(info));
  if (!r || !r.ok) {
    if (updDl.i + 1 < updDl.lines.length) {
      updDl.i++;
      updEnqueue(info);
      return;
    }
    updDl.state = 'failed';
    updDl.err = '下载没能开始：' + ((r && r.error) || '未知原因');
    updPaint(info);
    return;
  }
  updDl.id = r.id;
  // 这一条线路的「起跑计时」从真正入队那一刻算 —— 不是从点按钮那一刻，
  // 中间还隔着 nativeUpd() / 建目录 / 删同名文件
  updDl.startedAt = Date.now();
  updDl.lastAt = Date.now();
  updDl.got = 0;
  updDl.lastBytes = -1;
  // 记下来：用户关掉弹层再打开，进度还能接上（下载本身在系统里跑，不受影响）
  CFG.updDlId = r.id;
  CFG.updDlVer = updDl.ver;
  store.set(KEY.settings, CFG);
  updPoll(info);
}

function updPoll(info) {
  if (!updDl) return;
  clearInterval(updDl.timer);
  updDl.timer = setInterval(() => updTick(info), 600);
  updTick(info);
}

/** 这条线路不要了：换下一条，没得换就报失败。
 *
 *  🔴 换线之前**必须 cancel** 掉卡住的那个任务。不然系统里留着一个「等网络」
 *     的僵尸任务，它稍后会自己活过来、往同一个文件名里写；而 start() 又会
 *     先删同名文件 —— 两个任务抢一个文件，或者下次打开弹层被 updResume
 *     接回来，永远卡在同一个地方。这条不写，看门狗会把「卡一次」变成「卡死」。
 */
function updDropLine(info, why, browser) {
  const u = nativeUpd();
  if (!updDl) return;
  if (u && updDl.id) u.cancel(updDl.id);
  if (updDl.i + 1 < updDl.lines.length) {
    updDl.i++;
    updDl.pct = 0;
    updDl.note = '';
    updDl.state = 'downloading';
    updDl.got = 0;
    updDl.lastBytes = -1;
    updDl.lastAt = Date.now();
    updEnqueue(info);
    return;
  }
  updDl.state = 'failed';
  updDl.err = why;
  updDl.allowBrowser = !!browser;
  updPaint(info);
}

function updTick(info) {
  const u = nativeUpd();
  if (!u || !updDl) return;
  const st = u.state(updDl.id);
  if (!st || !st.ok) {
    // 任务没了（系统清了 / 卸载重装）：别继续显示「正在下载」，那是在骗人
    clearInterval(updDl.timer);
    updDl = null;
    CFG.updDlId = 0;
    store.set(KEY.settings, CFG);
    updPaint(info);
    return;
  }
  if (st.total > 0) updDl.total = st.total;
  updDl.pct = updDl.total > 0
    ? Math.min(100, Math.floor(st.bytes * 100 / updDl.total))
    : 0;

  if (st.status === 8) {                    // SUCCESSFUL
    clearInterval(updDl.timer);
    updVerify(info);
    return;
  }
  if (st.status === 16) {                   // FAILED
    clearInterval(updDl.timer);
    updDropLine(info, '下载失败：' + updReason(st.reason), false);
    return;
  }

  // 走到这里说明还没结束：1 等待 / 2 下载中 / 4 暂停。
  // 这三种里只有 2 且 bytes 在涨才是真在下载，所以判据只能是「有没有在动」。
  const bytes = Number(st.bytes) || 0;
  if (bytes !== updDl.lastBytes) {
    updDl.lastBytes = bytes;
    updDl.got = bytes;
    updDl.lastAt = Date.now();
    updDl.note = '';
  } else if (st.status === 1) {
    updDl.note = '系统下载器还在排队';
  } else if (st.status === 4) {
    updDl.note = '被系统暂停了（在等网络）';
  }
  // 判据分两段：**还没出过字节**说明这条线路压根没起来（8 秒就够判），
  // 出过字节之后再停才是「断了」（给 20 秒，可能只是网抖了一下）。
  const booting = !updDl.got;
  const still = Date.now() - (updDl.lastAt || 0);
  const limit = booting ? UPD_BOOT_MS : UPD_STALL_MS;
  if (still >= limit) {
    clearInterval(updDl.timer);
    // 把系统状态码留在话里：下次他再报「卡住」，这一句能直接告诉我们
    // 是排队(1)、等网络(4) 还是别的 —— 不用再猜一轮。
    const sec = Math.round(limit / 1000);
    updDropLine(info,
      booting
        ? ('这条线路 ' + sec + ' 秒还没开始传（系统状态 ' + st.status + '）')
        : ('下载停在第 ' + updDl.pct + '%，' + sec + ' 秒没动（系统状态 '
           + st.status + '）'),
      true);
    return;
  }
  updDl.state = 'downloading';
  updPaint(info);
}

/** 下载完先对 sha256 再交给安装器。
 *
 *  🔴 「算出来不一样」和「没读到」必须分开说：
 *     前者是「这个包不是我们要的那个」（被人换了 / 传错了），必须删掉重来；
 *     后者是「读不出文件」，同样不能装 —— 但我们没说它坏，只说读不到。
 */
function updVerify(info) {
  const u = nativeUpd();
  const want = String(info.sha256 || '').toLowerCase();
  const got = (u && u.sha256(updDl.id)) || '';
  if (want && got !== want) {
    u.cancel(updDl.id);                 // 连文件一起删掉，别留在手机上
    updDl.state = 'failed';
    updDl.allowBrowser = true;          // 给一条退路，别把人卡死在这
    updDl.err = got
      ? '安装包不完整，已经删掉了，请重试'
      : '安装包没存好，已经删掉了，请重试';
    updDl.id = 0;
    CFG.updDlId = 0;
    store.set(KEY.settings, CFG);
    updPaint(info);
    return;
  }
  updDl.state = 'ready';
  updPaint(info);
}

function updInstall(info) {
  const u = nativeUpd();
  if (!u || !updDl) return;
  if (!u.canInstall()) { updDl.state = 'needperm'; updPaint(info); return; }
  const r = u.install(updDl.id);
  const tip = $('updTip');
  if (r === '') {
    // 已经交给系统安装器了。这里只留一句说明 —— 真正的「装」在系统界面里
    if (tip) {
      tip.textContent = '已经打开安装界面，跟着提示点「安装」就行。';
      tip.classList.remove('bad');
    }
    return;
  }
  if (r === 'need-permission') { updDl.state = 'needperm'; updPaint(info); return; }
  updDl.state = 'failed';
  updDl.err = '没能打开安装界面：' + String(r).replace(/^fail:\s*/, '');
  updPaint(info);
}

/** 主按钮点下去该干什么，全看当前状态。 */
function updAction(info) {
  const st = updDl ? updDl.state : 'idle';
  if (st === 'needperm') { nativeUpd().openInstallSettings(); return; }
  if (st === 'ready') { updInstall(info); return; }
  if (st === 'downloading') return;          // 按钮此时是禁用的
  if (st === 'failed' && updDl && updDl.allowBrowser) {
    openExternal(updUrls(info)[0] || info.page || '');
    return;
  }
  if (updStart(info)) { updPaint(info); return; }
  // 网页版 / 没有原生下载能力：老办法，交给系统浏览器
  const url = info.apk_cn || info.apk || info.page || '';
  if (!url) {
    const tip = $('updTip');
    if (tip) {
      tip.classList.add('bad');
      tip.textContent = '清单里没写下载地址，去发布页手动下载吧。';
    }
    return;
  }
  if (!openExternal(url)) {
    const tip = $('updTip');
    if (tip) {
      tip.classList.add('bad');
      tip.textContent = '没能打开浏览器，请手动访问：' + url;
    }
  }
}

/** 弹层重新打开时，把还在跑的那个下载接上。 */
function updResume(info) {
  if (!nativeUpd()) return false;
  const id = CFG.updDlId;
  if (!id || String(CFG.updDlVer || '') !== String(info.version || '')) return false;
  updDl = { id: id, ver: String(info.version), lines: updLines(info), i: 0, timer: 0,
            state: 'downloading', pct: 0, total: Number(info.size) || 0,
            err: '', allowBrowser: false, note: '', got: 0,
            startedAt: Date.now(), lastBytes: -1, lastAt: Date.now() };
  updPoll(info);
  return true;
}

/** 新版本提示。只有三样东西：版本号、更新内容、两个按钮。
 *
 *  force=false（自动检查）时，如果用户正开着别的弹层，先记下来等他关掉再弹 ——
 *  否则他正在填「学期设置」的日期，内容会被凭空换掉。
 */
function showUpdateSheet(info, force) {
  if (!force && !$('sheetMask').hidden) { updPending = info; return; }
  updPending = null;
  const notes = (Array.isArray(info.notes) ? info.notes : [])
    .filter((x) => typeof x === 'string' && x.trim());
  const size = fmtBytes(info.size);
  $('sheetBody').innerHTML =
    '<div class="sh-title">发现新版本 ' + esc(info.version) + '</div>' +
    '<div class="sh-sub">当前 v' + esc(APP_VERSION) + (size ? ' · 新版本 ' + size : '') + '</div>' +
    (notes.length
      ? '<ul class="updnotes">' + notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>'
      : '<p class="sh-sub">这次主要是修问题和细节优化。</p>') +
    '<div class="updprog" id="updProg" hidden>' +
      '<div class="updbar"><i id="updBarFill"></i></div>' +
      '<p class="tip note" id="updPct"></p>' +
    '</div>' +
    '<div class="updline" id="updLineRow" hidden>' +
      '<button class="updline-sw" id="updLineSw">线路：国内线路</button>' +
      '<span class="updline-k">下不动就换一条</span>' +
    '</div>' +
    '<p class="tip note" id="updTip"></p>' +
    '<div class="sheetbtns">' +
      '<button class="btn" id="updLater">以后再说</button>' +
      '<button class="btn primary" id="updGo">立即更新</button>' +
    '</div>';
  $('sheetMask').hidden = false;

  $('updLater').addEventListener('click', () => {
    // 正在下载时这个按钮是「后台下载」：只收起弹层，不记「以后再说」——
    // 用户已经决定要装了，只是不想盯着进度条。
    if (updDl && updDl.state === 'downloading') {
      $('sheetMask').hidden = true;
      return;
    }
    // 记住「这个版本我不想现在装」。下次发新版照弹，不会因为点过一次就永远静音。
    CFG.updSkip = String(info.version);
    store.set(KEY.settings, CFG);
    $('sheetMask').hidden = true;
  });

  $('updGo').addEventListener('click', () => { updAction(info); });
  $('updLineSw').addEventListener('click', () => { updSwitchLine(info); });

  // 关掉再打开时，如果这个版本的下载还在跑，接着显示进度
  if (!updResume(info)) { updDl = null; updPaint(info); }
}

/** 交给外部打开：APK 里走系统浏览器，网页版新开一个标签页。 */
function openExternal(url) {
  if (NATIVE && window.NativeApi && typeof window.NativeApi.openUrl === 'function') {
    try { if (window.NativeApi.openUrl(url)) return true; } catch (e) { /* 落到下面 */ }
  }
  try {
    const w = window.open(url, '_blank');
    if (w) return true;
  } catch (e) { /* 被拦截 */ }
  return false;
}

/* ---- 直饮水（慧生活798）----------------------------------------------
   喝水和门户、一卡通是**三个**系统：门户管余额和办事，一卡通管食堂刷卡，
   饮水机是慧生活798（长沙云多啦）自己一套，跟学校账号不通。
   ⇒ 所以这张卡和百科一样留在 #cpOff / #cpOn 外面（没连门户也接得了水）。

   🔴 我们**只做入口，不搬它的功能**。它的接口地址和签名密钥在开源仓库里
      是被 secrets.properties 排除掉的，仓库里只有 your_salt_here 这种占位符；
      硬搬等于把别人的密钥写进我们仓库，推 CNB 就是公开 —— 不做。
      （第三方客户端 nocookies111/life-798 是 MIT，代码可以读，
        但密钥不在里面，从它的 APK 里能挖出来 —— 那更不该写进我们的仓库。）

   两个包名都试，因为同学装的可能不是同一个：
     com.cloudora.android  慧生活798 官方
     com.water.widget      WaterWidget，第三方客户端
   ⚠️ 这两个包名必须和 AndroidManifest 的 <queries>、NativeBridge.ALLOWED_APPS
      三处一致。少一处都**不报错**，只是「装了却说没装」或「点了没反应」。
*/
const WATER_APPS = [
  ['com.cloudora.android', '慧生活798'],
  ['com.water.widget', 'WaterWidget'],
];
// 没装时跳这里。用小米应用商店的页面：国内能直接打开，而且是官方渠道。
// ⚠️ 别换成 GitHub 的 release 页 —— 那个域名在国内经常打不开，
//    点了就是「白屏 → 退回来」，比不给入口还糟。
const WATER_STORE = 'https://app.mi.com/details?id=com.cloudora.android';

/** 装了哪几个（按 WATER_APPS 顺序）。网页版 / 没有这个接口的老 APK 返回空。 */
function waterTargets() {
  const out = [];
  if (!NATIVE || !window.NativeApi || typeof NativeApi.hasApp !== 'function') return out;
  WATER_APPS.forEach((a) => {
    if (NativeApi.hasApp(a[0]) === '1') out.push(a);
  });
  return out;
}

/** 打开慧生活798 客户端。
 *
 *  0.23.0 起它不再是「宿舍接水」那一行的去向 —— 那一行现在进我们自己的
 *  `#page-water`（查余额 / 列设备 / 接水）。这里只负责页内那行
 *  「打开慧生活798」：充值、签代扣协议、绑一卡通都得在那边做。
 *
 *  装了就直接切过去；没装就跳商店 —— 不在这里弹窗问「要不要装」：
 *  想接水的人本来就得有那个 App，多一层选择只是多一次点击。
 */
function openWater() {
  const got = waterTargets();
  if (got.length) {
    const r = NativeApi.openApp(got[0][0]);
    if (r === 'ok') return;                  // 已经切过去了，这边不用再做任何事
    // 起不来的原因要说一句，但**别停在这里** —— 用户要的是接水，不是错误码
    if (r !== 'notinstalled') toast('打不开' + got[0][1] + '，去商店看看');
  }
  if (!openExternal(WATER_STORE)) {
    toast('打不开应用商店，在里面搜「慧生活798」就行');
  }
}

/* ==================================================================
   直饮水页（#page-water）
   ------------------------------------------------------------------
   现在做的是：查余额 / 列设备 / 接水 / 停止 / 积分 / 账单 / 积分任务 /
   签到 / 两套账号。0.26.0 这里写着「别扩张，积分任务要签名盐值」——
   那个前提是错的（盐在官方 APK 里，2026-10-30 取到了，见 water.py 开头）。

   🔴 界面硬规矩（改这一页之前先读）：
     1. `start` 是**唯一**会真的出水扣钱的调用 ⇒ 二次确认。
        任务 / 签到也有副作用（动账号），同样要确认。
     2. 余额 `null` ≠ `0`。接口改字段名和「真的没钱了」看起来一模一样，
        但该做的事相反 ⇒ `null` 显示「没读到」，绝不显示 ¥0.00
     3. 出错按 `kind` 说话，不许一律「操作失败」
     4. 批量提交之间**至少 30 秒**，而且要能停（原版限流器就是 30 秒）
   🔴 登录失败**绝不自动重试**（尤其验证码）：错一次就换一张图，
        让用户重新读。自动重试会把账号试锁。
   ================================================================== */
const WT = {
  key: '',      // 图形验证码的会话串（服务端按它认这张图）
  busy: false,  // 有请求在飞 —— 防连点，不是防重复提交
  cd: 0,        // 短信倒计时还剩几秒
  timer: 0,
  phone: '',
  bal: null,    // null = 没读到（**不是 0**）
  balErr: '',
  devs: [],
  devErr: '',
  loadedAt: 0,  // 余额最后一次读到的时间（ms）
  expired: false, // 登录态过期了 —— 过期卡已经解释过，别再在别处重复

  // ---- 0.24.0：积分 / 积分任务 / 消费记录 ----
  score: null,       // {valid,total}；null = 没读到（**不是 0 分**）
  scoreErr: '',
  // [{refId,name,score,limit,used,left}]
  // 🔴 是 refId 不是 adId —— 响应里就叫 refId，只有请求 body 里才叫 adId
  //    （2026-10-30 查原项目 5.5.0 源码确认）。0.25.0 按 adId 找，所以
  //    真机上一直报「找不到带 adId 的数组」。
  missions: [],
  missionErr: '',
  missionSkipped: 0, // 列表里被跳过的条数（没 refId / 属于「不做的类别」）
  daily: null,       // 签到状态 {adId,score,week,weekday,signed,rewards}；null=没这功能
  run: {},           // refId -> 'wait'|'ok'|'bad'，这一轮跑出来的状态
  running: false,    // 批量任务正在跑（和 busy 分开：busy 是防连点）
  cur: '',           // 正在跑的那个 refId，界面上高亮那一行

  // ---- 0.26.2：两套账号 ----
  // 设备登录（1,1）管接水/余额/设备；积分登录（1,5）管积分/任务/签到。
  // 两个 token 互不通用，任务列表按平台各返回一份。
  accounts: { device: null, score: null },
  loginKind: '',     // '' = 不显示登录表单；'device' / 'score' = 正在登哪个
  lanes: null,       // {device:'ok'|'missing'|'error', score:…}；null = 还没读
  laneErr: {},       // 平台 -> 读失败的原因
  runStop: false,    // 用户点了「停」—— 跑任务时每一轮都要看它
  runGap: 0,         // 两次提交之间的间隔（ms），0 = 用默认 30 秒
  bills: [],         // 消费记录（翻页是往里追加，不是替换）
  billErr: '',
  billsPage: 0,
  billsMore: false,
  billsLoaded: false,
  live: null,        // {did,name,at} 本地记的「刚才你启动了」——**不是**服务端状态
  last: null,        // {did,name,at,money|null} 刚停完那一次的结算（内存，不落盘）

  // ---- 0.27.1：积分兑换余额 ----
  ex: {
    open: false,     // 兑换那块默认收起（这一页已经很长）
    unit: 100,       // 档位，只有 100 / 1000（原版 amounts）
    qty: 1,          // 份数
    eid: '',         // 选中的钱包端点 id（空 = 用第一个）
    wallets: null,   // null = 还没读；[] = 确实没有钱包
    err: '',         // 读钱包失败的原因
    busy: false,     // 提交中（防连点，不是防重复提交）
  },
};

/** 把 kind 翻译成「用户下一步该做什么」。
 *  原样抛 `msg` 等于什么都没说 —— 每条错误用户要做的事都不一样。 */
function wtErrText(kind, msg) {
  const m = msg || '操作失败';
  if (kind === 'limit') return m + '。先别急着重试，等几分钟再点。';
  if (kind === 'net') return m + '。换一下网络（WiFi / 流量）再试。';
  if (kind === 'sign') return m + '。签名没过，先看看手机时间准不准，' +
    '时间不对就校准后再试。不是你操作错了。';
  return m;
}

/** 页内提示。说明用灰字（.note），出错才加 .bad。
 *  🔴 光写 `class="tip"` 是红字居中 —— 那是错误样式，不是提示样式。 */
function wtTip(msg, bad) {
  const el = $('wtTip');
  if (!msg) { el.hidden = true; el.textContent = ''; el.classList.remove('bad'); return; }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('bad', !!bad);
}

/** 换一张图形验证码。
 *  🔴 服务端按 `s=key` 认这张图，所以**必须**先拿到新 key 再换 src，
 *     不能只改 src 上的时间戳 —— 那样图变了、key 还是旧的，发短信必错。 */
async function wtNewCaptcha() {
  const img = $('wtCapImg');
  try {
    const r = await api('/api/water/captcha');
    if (!r || !r.ok) { wtTip((r && r.error) || '拿不到图形验证码', true); return; }
    WT.key = r.key;
    img.classList.remove('bad');
    img.src = r.url;
    $('wtGraph').value = '';
  } catch (e) {
    wtTip('拿不到图形验证码：' + e.message, true);
  }
}

/** 短信倒计时。倒计时里按钮是禁用的 —— 不禁用的话用户会连点，
 *  服务端按 202 限流，报出来是「请求太频繁」，看着像我们坏了。 */
function wtCountdown(sec) {
  clearInterval(WT.timer);
  const btn = $('wtSend');
  let n = sec;
  const paint = () => {
    if (n <= 0) {
      clearInterval(WT.timer);
      WT.timer = 0; WT.cd = 0;
      btn.disabled = false;
      btn.textContent = '发送';
      return;
    }
    WT.cd = n;
    btn.disabled = true;
    btn.textContent = n + 's';
    n -= 1;
  };
  paint();
  WT.timer = setInterval(paint, 1000);
}

function wtShowOff() {
  WT.expired = false;      // 卡要藏起来了，标记必须一起清（见 wtExpire 注释）
  // 🔴 账号卡在两种状态下都要显示 —— 它是「哪半功能缺账号」的唯一说明处。
  //    藏起来的话，用户只看到「没登录」，不知道该登哪个。
  wtPaintAccounts();
  $('waterOff').hidden = !WT.loginKind;   // 只有点了某一行才展开表单
  $('waterOn').hidden = true;
  $('wtExpired').hidden = true;
  // 这一页的主体是直饮水，没登录时给一句「还没登录 + 去登录」，
  // 登录表在「我的 → 账号管理 → 慧生活账号」。
  $('wtNeedLogin').hidden = !!WT.loginKind;
  // 进这一页就该看见一张能读的图。没有 key 才去要 —— 有 key 就说明
  // 刚才那张还没用过，换掉反而让用户白读一次。
  if (WT.loginKind && !WT.key) wtNewCaptcha();
}

function wtShowOn() {
  WT.expired = false;
  wtPaintAccounts();
  $('waterOff').hidden = !WT.loginKind;
  $('waterOn').hidden = false;
  $('wtNeedLogin').hidden = true;
  $('wtExpired').hidden = true;
  // 手机号打码：屏幕可能被别人看到，截图也会外传。露头尾够自己认就行
  // （和 maskUid 同一个理由）。
  const dev = WT.accounts.device;
  WT.phone = (dev && dev.phone) || '';
  $('wtPhoneShown').textContent = WT.phone ? wtMaskPhone(WT.phone) : '—';
}

/** 画两行账号。**哪一行没登就说清缺它少什么** —— 只说「未登录」等于没说。
 *
 *  🔴 这张卡**永远显示**，包括一个账号都没登的时候。
 *     0.26.2 第一版写的是「有账号或有 loginKind 才显示」，结果
 *     「一个都没登」时卡片藏着、表单也藏着 ⇒ 整页只剩一个标题，
 *     用户找不到任何能点的地方（而且不报错）。
 *     它本来就是「哪半功能缺账号」的唯一说明处，藏起来等于把说明书藏了。 */
function wtPaintAccounts() {
  const dev = WT.accounts.device, sco = WT.accounts.score;
  const box = $('wtAccounts');
  if (!box) return;
  box.hidden = false;

  const rows = [
    { el: 'wtAccDevice', btn: 'wtAccDeviceBtn', sub: 'wtAccDeviceSub', a: dev,
      need: '没登：接水、余额、设备都用不了' },
    { el: 'wtAccScore', btn: 'wtAccScoreBtn', sub: 'wtAccScoreSub', a: sco,
      need: '没登：任务少一半，也签不了到' },
  ];
  for (const r of rows) {
    const a = r.a;
    const b = $(r.btn);
    if (a) {
      $(r.sub).textContent = wtMaskPhone(a.phone || '') + ' · 已登录';
      $(r.sub).classList.remove('need');
      b.textContent = '退出';
      b.dataset.act = 'out';
    } else {
      $(r.sub).textContent = r.need;
      $(r.sub).classList.add('need');
      b.textContent = '登录';
      b.dataset.act = 'in';
    }
  }
  // 两个都登了就别再啰嗦
  const tip = $('wtAccTip');
  if (dev && sco) {
    tip.hidden = true;
  } else {
    tip.hidden = false;
    tip.classList.remove('err');
    tip.textContent = dev || sco
      ? '两个账号各管一半功能，另一个登了才完整。同一个手机号就行。'
      : '两个都要登（同一个手机号），一个管接水、一个管积分。';
  }
}

/** 138****5678。太短的不打码（打完全看不出是什么了）。 */
function wtMaskPhone(p) {
  const s = String(p || '').replace(/\s+/g, '');
  if (s.length < 7) return s;
  return s.slice(0, 3) + '****' + s.slice(-4);
}

/** 登录过期。数据留着（能留的都留着），只把「要重登」这件事摆到最上面 ——
 *  整块换成登录表单的话，用户看到的是「数据没了」，其实只是票过期了。
 *
 *  🔴 **这一张卡是唯一的声音**：不把服务端那句「登录状态过期了，要重新登录
 *     一次」再拼进来 —— 拼出来是「…要重新登录一次。重新登录一次就行…」，
 *     同一句话说两遍。而且余额和设备那两处也不再加红字，否则同屏三遍。
 *     固定的文案写在 index.html 的 `.sub` 里，这里只管显示。 */
function wtExpire() {
  WT.expired = true;
  $('wtExpired').hidden = false;
}

/** 画余额。🔴 `null` 走「没读到」，绝不兜底成 0。 */
function wtPaintBal() {
  const v = $('wtBalV'), tip = $('wtBalTip');
  if (typeof WT.bal === 'number' && isFinite(WT.bal)) {
    v.className = 'wtbal-v';
    // 金额只有两位小数，拼进 innerHTML 也安全；unit 单独一个 span 是为了
    // 让 ¥ 比数字小一号（和 iOS 的金额排版一致）。
    v.innerHTML = '<span class="unit">¥</span>' + WT.bal.toFixed(2);
  } else {
    v.className = 'wtbal-v unknown';
    v.textContent = '没读到';
  }
  if (WT.balErr && !WT.expired) {
    tip.hidden = false;
    tip.classList.add('bad');
    tip.textContent = '余额没读到：' + WT.balErr;
  } else {
    tip.hidden = true;
    tip.classList.remove('bad');
    tip.textContent = '';
  }
  $('wtBalWhen').textContent = WT.loadedAt ? agoText(WT.loadedAt / 1000) + '更新' : '';
}

/** 画设备列表。🔴「一台都没有」和「没读到」必须分开说：
 *  前者要去慧生活798 里绑一台，后者是网络/接口问题 —— 该做的事完全不同。 */
/* --------------------------------------- 手动添加的设备（0.28.1）
 * 场景：教学楼的机器不在「我的设备」里，扫一下二维码就知道它是哪台。
 *
 * 🔴 归一是照原版 `DeviceIdParser.normalize()` **逐条**抄的：
 *      · 先 URL-decode 一次（二维码里常常是编码过的）
 *      · 键值形式：`?did=xxx` / `&deviceId:xxx` / `{"id":"xxx"}`
 *      · hnkzy.com 的路径里取最后一段 8~32 位纯数字
 *      · 路径里有 device/did/bind/q/qr 这类标记时，取标记**之后**那段
 *        （6~64 位字母数字，而且**必须含数字** —— 纯字母的 "bind" 不算编号）
 *      · 都没有就把整串当设备号
 *    ⚠️ `_lab/out/check_device_id.py` 拿一张表钉着这套规则，改一边必须改另一边。
 *
 * 🔴 **不扫相机**：WebView 读相机要额外的二维码解码库 + 相机权限（那会在
 *    第一次接水时弹一个「允许使用相机」，为了一件偶尔才做的事不值得），
 *    而系统相机本来就会读二维码，复制过来是同一个结果。
 */
const WT_DEV_KEY = 'wt.devs.local';
/* 0.37.0：自己起的名字。服务端那几台的名字是慧生活798 里的设备名（常常是
   「3号机」这种），楼里好几台都叫这个。这里存的是**本机别名**，只覆盖显示，
   不发给服务端 —— 我们没有改名的接口，假装改了只会让下次刷新白回来。 */
const WT_NAME_KEY = 'wt.names.local';
/* 0.37.0：「在本机隐藏」。服务端绑的那几台删不掉（删了下次刷新又回来），
   但用户可能就是想让它别占这一行 —— 记在本地，不画出来，随时能恢复。 */
const WT_HIDE_KEY = 'wt.hide.local';

function wtLocalDevs() {
  const a = store.get(WT_DEV_KEY, []);
  return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : [];
}

/** 本机别名表。键是设备编号，值是最多 20 字的显示名。 */
function wtNames() {
  const o = store.get(WT_NAME_KEY, {});
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {};
  Object.keys(o).forEach((k) => {
    if (typeof o[k] === 'string' && o[k]) out[k] = o[k];
  });
  return out;
}

function wtSetName(id, name) {
  const o = wtNames();
  if (name) o[id] = String(name).slice(0, 20);
  else delete o[id];
  store.set(WT_NAME_KEY, o);
}

function wtHidden() {
  const a = store.get(WT_HIDE_KEY, []);
  return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : [];
}

function wtHideDev(id) {
  const a = wtHidden();
  if (a.indexOf(id) < 0) a.push(id);
  store.set(WT_HIDE_KEY, a.slice(-50));
}

function wtUnhideAll() {
  store.set(WT_HIDE_KEY, []);
}

function wtSaveLocalDev(id) {
  const a = wtLocalDevs();
  if (a.indexOf(id) < 0) a.push(id);
  // 只留最近 20 个：这是「快捷入口」，不是通讯录。旧的不清会一直涨。
  store.set(WT_DEV_KEY, a.slice(-20));
  // 重新加回来的时候顺手从「已隐藏」里摘掉 —— 不然加了却看不见，
  // 用户只会以为「加失败了」（这两件事都不报错）。
  const h = wtHidden().filter((x) => x !== id);
  store.set(WT_HIDE_KEY, h);
}

function wtDropLocalDev(id) {
  store.set(WT_DEV_KEY, wtLocalDevs().filter((x) => x !== id));
}

function wtDevFromUrl(value) {
  let u = null;
  try { u = new URL(value); } catch (e) { return ''; }
  const scheme = String(u.protocol || '').replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ilife') return '';
  const dec = (v) => { try { return decodeURIComponent(v); } catch (e) { return v; } };
  const segs = String(u.pathname || '').split('/')
    .map(dec).map((x) => x.trim()).filter(Boolean);
  if (!segs.length) return '';
  const strong = (v) => /^\d{8,32}$/.test(v);
  const flex = (v) => /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/.test(v) && /\d/.test(v);
  const host = String(u.hostname || '').toLowerCase();
  if (host === 'hnkzy.com' || host.endsWith('.hnkzy.com')) {
    for (let i = segs.length - 1; i >= 0; i -= 1) if (strong(segs[i])) return segs[i];
  }
  const MARK = ['device', 'devices', 'did', 'bind', 'binding', 'q', 'qr'];
  let idx = -1;
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    if (MARK.indexOf(segs[i].toLowerCase()) >= 0) { idx = i; break; }
  }
  if (idx >= 0) {
    for (let i = segs.length - 1; i > idx; i -= 1) if (flex(segs[i])) return segs[i];
  }
  const last = segs[segs.length - 1];
  return strong(last) ? last : '';
}

/** 二维码内容 / 手动输入 → 设备编号。认不出就返回空串（**不编一个**）。 */
function wtNormDevice(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  try { s = decodeURIComponent(s); } catch (e) { /* 不是编码过的，原样用 */ }
  const KEY = /(?:[?&#;,\s{]|^)["']?(?:did|deviceId|device_id|id)["']?\s*(?:=|:)\s*["']?([^&#\/,}\s"']+)/i;
  const m = KEY.exec(s);
  let got = m ? m[1] : '';
  if (!got) got = wtDevFromUrl(s);
  if (!got) got = s;
  got = got.trim();
  // 原版是 removeSurrounding("\"") 再 removeSurrounding("'")：**两端都有**才去掉，
  // 只有一端不动；而且两步是**先后**做的（'"abc"' 会先掉双引号再掉单引号）。
  const rm = (v, q) => (v.length >= 2 && v[0] === q && v[v.length - 1] === q)
    ? v.slice(1, -1) : v;
  got = rm(rm(got, '"'), "'");
  // 同样两步、同样区分大小写：原版只认 "did:" 和 "DID:" 这两种写法。
  if (got.slice(0, 4) === 'did:') got = got.slice(4);
  else if (got.slice(0, 4) === 'DID:') got = got.slice(4);
  return got.slice(0, 160);
}

/** 服务端设备 + 本机手动添加的，按 id 去重（服务端优先，名字更准）。
 *  0.37.0：再过两道本机的闸 —— 别名覆盖、已隐藏的不画。 */
function wtDevRows() {
  const server = Array.isArray(WT.devs) ? WT.devs : [];
  const names = wtNames(), hide = wtHidden();
  const out = [], seen = {};
  server.forEach((d) => {
    const id = String((d && d.id) || '').trim();
    if (!id || seen[id]) return;
    seen[id] = 1;
    out.push({ id: id, name: names[id] || (d && d.name) || '', local: false });
  });
  wtLocalDevs().forEach((id) => {
    if (seen[id]) return;
    seen[id] = 1;
    out.push({ id: id, name: names[id] || '', local: true });
  });
  return out.filter((d) => hide.indexOf(d.id) < 0);
}

/** 被隐藏了几台。**只数还在列表里的那些** —— 设备早就不在服务端了
 *  （在慧生活798 里解绑了），隐藏记录还留着的话，这个数会一直虚高。 */
function wtHiddenCount() {
  const hide = wtHidden();
  if (!hide.length) return 0;
  const alive = {};
  (Array.isArray(WT.devs) ? WT.devs : []).forEach((d) => {
    const id = String((d && d.id) || '').trim();
    if (id) alive[id] = 1;
  });
  wtLocalDevs().forEach((id) => { alive[id] = 1; });
  return hide.filter((id) => alive[id]).length;
}

/** 存之前再看一眼：这一串**像不像**设备编号。
 *
 *  🔴 只挡「明显不是」的三种：整条链接（含 `/`）、一句话（含空白）、
 *     长得离谱（>64）。不设「至少几位数字」这种门槛 —— 门槛是编出来的，
 *     真设备号多长我们并不知道；而接水时服务端认不认，本来就是最终判据。
 *     之所以要挡，是因为扫到「官网二维码」时归一的结果就是整条 URL，
 *     存进去之后接水才报错，用户会以为是我们的问题。 */
function wtDevIdOk(id) {
  const s = String(id || '');
  if (!s || s.length > 64) return false;
  if (/[\/\s]/.test(s)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(s);
}

/** 「扫码」那枚图标：有相机就扫码，没有就直接给输入框。
 *  没有 `getUserMedia`（桌面浏览器、http 的网页版）时弹一个永远黑的浮层
 *  是最糟的选择 —— 用户只会以为坏了。 */
function wtAddDevStart() {
  if (wtScanReady()) { wtScanOpen(); return; }
  wtAddDev();
}

/** 「手动输入」那枚图标（0.37.0）：**不进相机**，直接要编号。
 *  和扫码分开是有必要的 —— 扫码那条路在没相机时会退化成输入框，但反过来
 *  不行：用户明确点了「手动输入」，再给他弹一次相机权限是答非所问。
 *  机器身上印的编号、同学发来的一串数字、二维码里的整段内容，都走这里。 */
async function wtAddDev() {
  const raw = await openInput('添加饮水机',
    '机器上印的编号，或者二维码里的那串内容',
    '设备编号', '添加');
  if (raw == null) return;                    // 点了取消
  const id = wtNormDevice(raw);
  if (!id) { toast('没读到内容，再贴一次'); return; }
  if (!wtDevIdOk(id)) { toast('这不是设备编号'); return; }
  wtSaveLocalDev(id);
  wtPaintDevs();
  toast('已添加');
}

/* ---- 扫码（0.31.0） --------------------------------------------------
   为什么自己解：系统相机确实能读二维码，但要用户「拍照→回相册→复制文字
   →切回来粘贴」，四步。这里点一下、对着码停半秒就好了。
   解码用 jsQR（见 jsqr.js），相机用 getUserMedia —— WebView 从 5.0 起就支持，
   前提是原生那边把相机权限批给网页（MainActivity.onPermissionRequest）。

   🔴 三条容易踩的：
     ① 关浮层必须 stop 轨道，否则相机一直开着、指示灯常亮，下次再开还会
        报「被占用」（NotReadableError）。
     ② 打开相机是异步的，等的过程中用户可能已经把浮层关了 ⇒ 拿到流之后
        要再确认一次浮层还在，不在就立刻掐掉。
     ③ 视频还没出画面时 videoWidth 是 0，往 canvas 上画会得到空图 ⇒ 每帧
        先看 videoWidth，画布尺寸也按它算。 */

const WT_SCAN = { stream: null, timer: 0, waitT: 0, last: '', cv: null };

/** 能不能扫。少任何一样都给粘贴那条路，不硬来。 */
function wtScanReady() {
  return !!(window.jsQR && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof document.createElement('canvas').getContext === 'function');
}

function wtScanSay(msg) { $('wtScanTip').textContent = msg; }
/** 取景器正中间那句话。同一条信息放这儿比放底部 hint 更靠眼睛，
 *  但只放**状态**；怎么解决写在底部 hint 里。 */
function wtScanWait(msg) { $('wtScanWaitT').textContent = msg; }

/** 相机起不来时统一收尾：撤掉取景框，图标转红，把话说清楚。 */
function wtScanFail(head, why) {
  $('wtScan').classList.add('bad');
  $('wtScanWait').hidden = false;
  wtScanWait(head);
  wtScanSay(why);
}

async function wtScanOpen() {
  if (!$('wtScan').hidden) return;
  WT_SCAN.last = '';
  $('wtScan').hidden = false;
  $('wtScan').classList.remove('bad');
  $('wtScanWait').hidden = false;
  wtScanWait('正在打开相机…');
  wtScanSay('把二维码放进框里');

  // 🔴 5 秒没动静就把话说清楚。
  //    有些机器上 getUserMedia 会**一直不 resolve**（系统权限框被吞掉、
  //    WebView 没把请求交出去），表现就是永远停在「正在打开相机…」。
  //    这里**不 reject、也不放弃**：用户之后点了「允许」，画面照样会来；
  //    只是别让他在那 5 秒之后还以为「再等等就好」。
  const slow = setTimeout(() => {
    if (WT_SCAN.stream) return;
    wtScanFail('相机还没起来', '可能没给相机权限。用不了就点下面粘贴。');
  }, 5000);

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },   // 手机上有后置就用后置
      audio: false,
    });
  } catch (e) {
    clearTimeout(slow);
    // 「没给权限」和「没有相机」要说不同的话：一种能去设置里打开，
    // 另一种只能换个办法。
    const n = (e && e.name) || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      wtScanFail('没给相机权限',
        '系统设置 → 应用 → 航院通 → 权限，打开相机；或者点下面粘贴。');
    } else if (n === 'NotFoundError') {
      wtScanFail('这台设备没有相机', '用「粘贴二维码内容」添加，效果一样。');
    } else {
      wtScanFail('相机打不开',
        '可能被别的 App 占着。关掉那个再试，或者点下面粘贴。');
    }
    return;                                     // 浮层留着，「粘贴」在下面
  }
  clearTimeout(slow);

  // ① 等相机的这段时间里浮层可能已经被关了
  if ($('wtScan').hidden) {
    stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    return;
  }

  WT_SCAN.stream = stream;
  const v = $('wtScanV');
  v.srcObject = stream;
  try { await v.play(); } catch (e) { /* 静音自动播放；个别 WebView 仍会拒，下面按帧等画面 */ }

  // ② 拿到流 ≠ 有画面（有些机器要一两秒才出第一帧）。
  //    以 videoWidth 为准再撤占位层，不然会先闪一下黑，再出现那个大三角。
  const show = () => {
    if (WT_SCAN.stream !== stream) return;
    if (!v.videoWidth) return;
    $('wtScanWait').hidden = true;
    $('wtScan').classList.remove('bad');
    wtScanSay('把二维码放进框里');
    if (WT_SCAN.waitT) { clearInterval(WT_SCAN.waitT); WT_SCAN.waitT = 0; }
  };
  show();
  WT_SCAN.waitT = setInterval(show, 120);

  WT_SCAN.timer = setInterval(wtScanTick, 160);
}

/** 关相机。**幂等**：没开的时候调用什么也不做。 */
function wtScanStop() {
  if (WT_SCAN.timer) { clearInterval(WT_SCAN.timer); WT_SCAN.timer = 0; }
  if (WT_SCAN.waitT) { clearInterval(WT_SCAN.waitT); WT_SCAN.waitT = 0; }
  const s = WT_SCAN.stream;
  WT_SCAN.stream = null;
  if (s) {
    try { s.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); } catch (e) {}
  }
  const v = $('wtScanV');
  try { v.pause(); } catch (e) {}
  try { v.srcObject = null; } catch (e) {}
  $('wtScan').hidden = true;
  // 下一次打开要回到干净状态：失败态的「bad」不能带过去，
  // 否则第二次点「添加设备」会先闪一屏红字。
  $('wtScan').classList.remove('bad');
  $('wtScanWait').hidden = false;
  wtScanWait('正在打开相机…');
  WT_SCAN.last = '';
  wtScanSay('把二维码放进框里');
}

/** 每帧：缩到 640 宽再解。手机原图 1280 宽，jsQR 要扫全部像素，
 *  不缩的话低端机上会掉到每秒几帧、还费电；二维码不需要那么细。 */
function wtScanTick() {
  const v = $('wtScanV');
  if (!v || !v.videoWidth) return;              // ③ 还没出画面
  const w = v.videoWidth, h = v.videoHeight;
  const sc = Math.min(1, 640 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
  if (!WT_SCAN.cv) WT_SCAN.cv = document.createElement('canvas');
  const cv = WT_SCAN.cv;
  if (cv.width !== cw) cv.width = cw;
  if (cv.height !== ch) cv.height = ch;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(v, 0, 0, cw, ch);
  let img = null;
  try { img = g.getImageData(0, 0, cw, ch); } catch (e) { return; }
  let r = null;
  try {
    r = window.jsQR(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
  } catch (e) { return; }
  if (r && r.data) wtScanTaken(r.data);
}

/** 解出一条码。认不出是设备就**留在相机里**继续扫，只改提示那句。 */
function wtScanTaken(raw) {
  const text = String(raw || '').trim();
  if (!text || text === WT_SCAN.last) return;   // 同一帧会连着解出好几次
  WT_SCAN.last = text;
  const id = wtNormDevice(text);
  if (!wtDevIdOk(id)) { wtScanSay('这不是饮水机的码'); return; }
  wtScanStop();
  wtSaveLocalDev(id);
  wtPaintDevs();
  toast('已添加');
}

/** 移到后台（切 App、锁屏）就关相机：前台服务都没开，凭什么开着摄像头。 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !$('wtScan').hidden) wtScanStop();
});

/* ---- 设备行的「⋯」（0.37.0）----------------------------------------
 * 以前：手动加的那几台有一颗 ✕，服务端绑的那几台**什么都没有** ——
 * 同一行左边一个样右边一个样，看着像「这几台不是我的」。
 * 现在每台都有同一个「⋯」，点开三件事：重命名 / 复制编号 / 移除。
 *
 * 🔴 三件事都**只动本机**，一件都不往服务端发：
 *      · 改名 —— 没有改名接口，发了也没用；
 *      · 复制 —— 只是把编号放进剪贴板，方便发给同学；
 *      · 移除 —— 手动加的删记录，服务端绑的记「本机隐藏」。
 *    服务端那几台真删不掉（下次刷新会回来），所以文案必须说「隐藏」，
 *    说「删除」就是在骗人。
 */

/** 复制到剪贴板。返回是否成功。
 *
 *  🔴 用 `execCommand` 而不是 `navigator.clipboard`：后者要求**安全上下文**，
 *     而 APK 里的页面源是 `https://app.local` —— 不是每个 ROM 都认它是安全的。
 *     认不出时 clipboard 直接 undefined，调用就抛，而且**没有任何提示**。
 */
function wtCopy(text) {
  const s = String(text || '');
  if (!s) return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;'
      + 'opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand ? document.execCommand('copy') : false;
    document.body.removeChild(ta);
    if (ok) return true;
  } catch (e) { /* 落到下面 */ }
  return false;
}

/** 改名。清空再保存 = 恢复原名（服务端给的那个 / 「手动添加的饮水机」）。 */
async function wtRenameDev(row) {
  const v = await openInput('重命名',
    '只改这台手机上的显示，慧生活798 里的设备名不变',
    '给这台起个名字', '保存', row.name || '');
  if (v == null) return;
  const name = String(v).trim().slice(0, 20);
  wtSetName(row.id, name);
  wtPaintDevs();
  toast(name ? '已重命名' : '已恢复原名');
}

/** 复制编号。复制不了就把编号摊开让用户自己长按 —— 不能只说一句「失败」。 */
async function wtCopyDev(row) {
  if (wtCopy(row.id)) { toast('已复制编号'); return; }
  await openInput('复制编号', '长按下面这串选中，再复制', '', '好', row.id);
}

/** 移除。手动加的删记录，服务端绑的只在本机隐藏。 */
async function wtRemoveDev(row) {
  if (row.local) {
    const ok = await askConfirm('移除这台设备？',
      '移除后要接水得重新贴一次二维码', '移除');
    if (!ok) return;
    wtDropLocalDev(row.id);
    wtPaintDevs();
    return;
  }
  const ok = await askConfirm('在这台手机上隐藏？',
    '它还在你的慧生活798 名下，只是这一页不画了。随时能在列表下面恢复。', '隐藏');
  if (!ok) return;
  wtHideDev(row.id);
  wtPaintDevs();
}

/** 点「⋯」弹出的菜单。 */
async function wtDevMenu(row) {
  const pick = await openPick(row.name || '这台饮水机', row.id, [{
    items: [
      { id: 'rename', name: '重命名' },
      { id: 'copy', name: '复制编号' },
      { id: 'remove', name: row.local ? '移除' : '在本机隐藏', danger: true },
    ],
  }], '');
  if (pick === 'rename') wtRenameDev(row);
  else if (pick === 'copy') wtCopyDev(row);
  else if (pick === 'remove') wtRemoveDev(row);
}

function wtPaintDevs() {
  const box = $('wtDevs'), tip = $('wtDevTip'), n = $('wtDevN');
  const devs = wtDevRows();
  const hid = wtHiddenCount();
  // 卡头的台数。**读到 0 台时不写「0 台」** —— 那种情况下面的提示文字
  // 已经在说「还没绑」，卡头再喊一句 0 台是同一个坏消息说两遍。
  if (n) n.textContent = devs.length > 1 ? (devs.length + ' 台') : '';
  if (devs.length) {
    box.innerHTML = devs.map((d) => (
      '<div class="wtdev">' +
        // 0.32.0：名字和编号竖排（见 app.css 那段注释）。
        '<span class="wtdev-main">' +
          '<span class="wtdev-name">' + esc(d.name || '手动添加的饮水机') + '</span>' +
          '<span class="wtdev-id">' + esc(d.id) + '</span>' +
        '</span>' +
        '<button class="wtdev-go" data-did="' + escAttr(d.id) + '"' +
        ' data-name="' + escAttr(d.name || '') + '">接水</button>' +
        // 「⋯」放在**最右**：菜单本来就在行尾，而「接水」要是被挤到边上，
        // 主操作就只剩 2px 的余量贴着卡片边缘。
        '<button class="wtdev-more" data-more="' + escAttr(d.id) + '"' +
        ' aria-label="更多操作">' +
          '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.7"/>' +
          '<circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>' +
        '</button>' +
      '</div>'
    )).join('');
    // innerHTML 会把旧节点连同监听一起扔掉 ⇒ 每次重画都重新绑一遍。
    // 不重绑的话第二次进来点了没反应，而且**不报错**。
    box.querySelectorAll('button[data-did]').forEach((b) => {
      b.addEventListener('click', () => { wtStart(b.dataset.did, b.dataset.name); });
    });
    box.querySelectorAll('button[data-more]').forEach((b) => {
      b.addEventListener('click', () => {
        const row = wtDevRows().filter((x) => x.id === b.dataset.more)[0];
        if (row) wtDevMenu(row);
      });
    });
  } else {
    box.innerHTML = '';
  }

  // 「已隐藏 N 台」那一行：**只在本机真藏了东西时出现**。
  const showRow = $('wtDevShow'), showN = $('wtDevHideN');
  if (showRow) {
    showRow.hidden = !hid;
    if (hid && showN) showN.textContent = hid + ' 台 · 恢复';
  }

  if (WT.devErr && !WT.expired) {
    tip.hidden = false;
    tip.classList.add('bad');
    tip.textContent = '设备列表没读到：' + WT.devErr;
  } else if (!devs.length && !WT.expired && !hid) {
    // ⚠️ 全部被隐藏时**不说「还没有绑定」** —— 那是「没有」和「被我藏了」
    //    两件不同的事，说错了用户会去慧生活798 重新绑一台。
    tip.hidden = false;
    tip.classList.remove('bad');
    // 一句话说完。原来那句「要在慧生活798 里先绑一台，绑完这里就能看到」
    // 换行成两行，多占 20px —— 而「去哪儿绑」下面那颗「添加设备」已经说了。
    tip.textContent = '这个账号名下还没有绑定饮水机，去慧生活798 绑一台。';
  } else {
    tip.hidden = true;
    tip.classList.remove('bad');
    tip.textContent = '';
  }
}

/** 拉一次余额 + 设备。
 *  🔴 这两件事**分开报错**：一个挂了不该把另一个也变成「读不到」，
 *    也不许安静吞掉（「没读到」和「没有」是两件事）。后端已经是这个形状，
 *    这里只负责照着画。 */
async function wtLoad() {
  // 0.27.0：页头只剩一颗刷新（直饮水并进功能页了），忙态挂在它身上。
  // 🔴 只能加 class，**不能设 disabled** —— 这颗按钮现在同时管「刷门户」，
  //    接水那边一请求它就灰掉的话，用户想刷一卡通会点不动（而且不报错）。
  const btn = $('cpRefresh');
  if (btn) btn.classList.add('busy');
  try {
    const r = await api('/api/water/home');
    if (!r || !r.ok) {
      // auth 是唯一需要换页面状态的：其余错误就地把话说清楚
      if (r && r.kind === 'auth') { wtExpire(); }
      WT.bal = null;
      WT.balErr = (r && r.error) || '读不到';
      WT.devErr = (r && r.error) || '读不到';
      wtPaintBal();
      wtPaintDevs();
      return;
    }
    WT.expired = false;      // 读到了 ⇒ 票是好的，把过期标记清掉
    WT.bal = (typeof r.balance === 'number' && isFinite(r.balance)) ? r.balance : null;
    WT.balErr = r.balanceError || '';
    WT.devs = Array.isArray(r.devices) ? r.devices : [];
    WT.devErr = r.devicesError || '';
    WT.loadedAt = Date.now();
    wtPaintBal();
    wtPaintDevs();
  } catch (e) {
    WT.bal = null;
    WT.balErr = e.message;
    WT.devErr = e.message;
    wtPaintBal();
    wtPaintDevs();
  } finally {
    if (btn) btn.classList.remove('busy');
  }
}

/* ---- 0.24.0：积分 / 积分任务 / 消费记录 ----------------------------
   三块各自独立拉、各自独立报错。合成一次请求的话，任务接口挂了余额也会
   跟着变「没读到」，用户会以为账号出问题 —— 而该做的事完全不同。

   🔴 全部守同一条：`null` ≠ `0`。
      积分没读到写「没读到」，金额没读到写「金额没读到」，
      绝不写 0 分 / ¥0.00 —— 前者像「今天没挣到」，后者像「这单免费」。 */

/** 画积分。两个数各自判断：一个读到、一个没读到，也要分开说。 */
function wtPaintScore() {
  const paint = (id, n) => {
    const el = $(id);
    if (typeof n === 'number' && isFinite(n)) {
      el.className = 'wtpair-v';
      el.textContent = String(n);
    } else {
      el.className = 'wtpair-v unknown';
      el.textContent = '没读到';
    }
  };
  const sc = WT.score;
  paint('wtScoreValid', sc ? sc.valid : null);
  paint('wtScoreTotal', sc ? sc.total : null);

  const tip = $('wtScoreTip');
  if (WT.scoreErr && !WT.expired) {
    tip.hidden = false;
    tip.classList.add('bad');
    tip.textContent = '积分没读到：' + WT.scoreErr;
  } else {
    tip.hidden = true;
    tip.classList.remove('bad');
    tip.textContent = '';
  }
  wtExPaint();
}

/* ---------------------------------------------------- 积分兑换余额（0.27.1）
 * 照出水小部件的 WalletActivity 做的同一件事：
 *   1000 积分 = ¥1，档位只有 100 / 1000，份数从 1 起，**一次提交**。
 *
 * 🔴 请求体只传**总积分**、不传份数（原版 `ScoreExchangeParserTest` 明确断言
 *    body 里没有 `count`）。份数是界面自己乘出来的。
 * 🔴 拿到账单号 ≠ 兑换完成：要再查一次 `bill.status === 3` 才算。
 * 🔴 任何一步失败都**不自动重试** —— 重试等于再扣一次积分。网络类失败连
 *    「到底扣没扣」都不知道，所以文案是「先别重复兑换」，不是「再试一次」。
 */
const WT_EX_UNITS = [100, 1000];

/** 档位 × 份数 = 这次要花的积分；不合法返回 null（**不兜底成 0**）。
 *
 *  和原版 `ScoreExchangeParser.totalScore` 逐条对应：档位只能是 100/1000，
 *  份数 ≥1，且不能超过「可用积分买得起的份数」。
 *  ⚠️ 这条规则**只写这一份** —— 网页版和 APK 跑的是同一份 app.js，
 *     没有第二份需要对齐（再写一份就是「各自合规、其实早已分叉」）。
 */
function wtExTotalOf(unit, qty, avail) {
  const u = Number(unit), q = Number(qty), a = Number(avail);
  if (avail == null || !isFinite(u) || !isFinite(q) || !isFinite(a)) return null;
  if (WT_EX_UNITS.indexOf(u) < 0) return null;
  if (q < 1 || a < 0) return null;
  if (q > Math.floor(a / u)) return null;
  return u * q;
}

/** 现在选中的钱包。没选过就用第一个（只有一个钱包时这是唯一的那个）。 */
function wtExCurWallet() {
  const ws = Array.isArray(WT.ex.wallets) ? WT.ex.wallets : [];
  if (!ws.length) return null;
  const hit = ws.filter((w) => w.endpointId === WT.ex.eid)[0];
  return hit || ws[0];
}

/** 画兑换那块。入口的显示条件由它自己成不成立决定（红线 50）：
 *  有可用积分、读到了钱包、没在读钱包的错误 —— 三条都满足才给入口。
 *  否则点进去只能说「没有钱包」，那是挖坑。 */
function wtExPaint() {
  const open = $('wtExOpen'), box = $('wtExBox');
  if (!open || !box) return;
  const ws = Array.isArray(WT.ex.wallets) ? WT.ex.wallets : [];
  const avail = (WT.score && typeof WT.score.valid === 'number') ? WT.score.valid : null;
  const can = ws.length > 0 && !WT.ex.err && avail != null && !WT.expired;
  open.hidden = !can;
  if (!can) { box.hidden = true; WT.ex.open = false; return; }
  box.hidden = !WT.ex.open;
  if (!WT.ex.open) return;

  const w = wtExCurWallet();
  // 多个钱包时这一行能点开选择器；只有一个时它就是标签 —— 箭头藏掉、按钮
  // 禁用。**不能**留一颗点了没反应的按钮（那比没有按钮更让人恼火）。
  const more = ws.length > 1;
  $('wtExWallet').textContent = (w && w.name) || '—';
  $('wtExChev').hidden = !more;
  $('wtExTo').disabled = !more;

  $('wtExUnits').querySelectorAll('.wtchip').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.unit) === WT.ex.unit);
  });
  $('wtExQty').textContent = String(WT.ex.qty);

  const total = wtExTotalOf(WT.ex.unit, WT.ex.qty, avail);
  const sum = $('wtExSum');
  if (total == null) {
    sum.textContent = '积分不够换这么多份。';
    sum.classList.add('bad');
  } else {
    sum.classList.remove('bad');
    // 1000 分 = ¥1，所以元 = 分 / 1000。留两位小数，别写成 ¥0.2000000001
    sum.textContent = '消耗 ' + total + ' 积分，兑 ¥' + (total / 1000).toFixed(2);
  }
  const go = $('wtExGo');
  go.disabled = total == null || WT.ex.busy;
  go.textContent = WT.ex.busy ? '兑换中…' : '兑换';
}

/** 读钱包列表。读失败要说出来，不能安静当成「没有钱包」。 */
async function wtLoadWallets() {
  try {
    const r = await api('/api/water/wallets');
    if (!r || !r.ok) {
      WT.ex.wallets = null;
      WT.ex.err = (r && r.error) || '读不到';
    } else {
      WT.ex.wallets = Array.isArray(r.wallets) ? r.wallets : [];
      WT.ex.err = '';
      const cur = wtExCurWallet();
      WT.ex.eid = cur ? cur.endpointId : '';
    }
  } catch (e) {
    WT.ex.wallets = null;
    WT.ex.err = e.message;
  }
  wtExPaint();
}

/** 提交兑换。**只提交一次**，失败不重试。 */
async function wtExGo() {
  if (WT.ex.busy) return;
  const w = wtExCurWallet();
  if (!w) return;
  const avail = (WT.score && typeof WT.score.valid === 'number') ? WT.score.valid : null;
  const total = wtExTotalOf(WT.ex.unit, WT.ex.qty, avail);
  if (total == null) return;

  // 这是账号行为、会扣积分，还要真金白银地变成余额 —— 必须二次确认。
  const ok = await askConfirm('兑换积分',
    '用 ' + total + ' 积分兑换 ¥' + (total / 1000).toFixed(2)
      + ' 到「' + w.name + '」。兑换只能提交一次，中途出错不会自动重试。',
    '兑换');
  if (!ok) return;

  WT.ex.busy = true;
  const msg = $('wtExMsg');
  msg.hidden = false;
  msg.classList.remove('bad');
  msg.textContent = '正在兑换…';
  wtExPaint();

  let sn = '';
  try {
    const r = await api('/api/water/exchange', { eid: w.endpointId, score: total });
    if (!r || !r.ok) {
      // 🔴 网络类失败时**我们不知道扣没扣**。这时候让用户「再试一次」是最坏的
      //    建议（等于再扣一次），所以文案分开写。
      const netish = !r || !r.kind || r.kind === 'net' || r.kind === 'limit';
      msg.classList.add('bad');
      msg.textContent = netish
        ? '兑换结果未知：' + ((r && r.error) || '没连上') + '。先去官方 App 核一下记录，别重复兑换。'
        : wtErrText(r && r.kind, r && r.error);
      WT.ex.busy = false;
      wtExPaint();
      return;
    }
    sn = r.sn;
  } catch (e) {
    msg.classList.add('bad');
    msg.textContent = '兑换结果未知：' + e.message + '。先去官方 App 核一下记录，别重复兑换。';
    WT.ex.busy = false;
    wtExPaint();
    return;
  }

  // 拿到账单号只是「提交成功」。再查一次账单，status === 3 才算真的到账。
  msg.textContent = '已提交，正在核对…';
  let done = false, note = '';
  try {
    const b = await api('/api/water/exchange-bill?id=' + encodeURIComponent(sn));
    if (b && b.ok) {
      done = !!b.done;
      if (!done) note = '（账单状态 ' + b.status + '，还没完成）';
    } else {
      note = '（' + ((b && b.error) || '账单查不到') + '）';
    }
  } catch (e) {
    note = '（' + e.message + '）';
  }

  msg.classList.toggle('bad', !done);
  msg.textContent = done
    ? '兑换完成：¥' + (total / 1000).toFixed(2) + ' 已到「' + w.name + '」。'
    : '兑换结果待确认' + note + '。先去官方 App 核一下记录，别重复兑换。';
  WT.ex.busy = false;
  wtExPaint();
  if (done) {
    // 余额和积分都变了 —— 两样都重读，别让界面停在旧数上
    if (WT.accounts.device) { wtLoad().catch(() => {}); }
    wtLoadScore().catch(() => {});
  }
}

async function wtLoadScore() {
  try {
    const r = await api('/api/water/score');
    if (!r || !r.ok) {
      if (r && r.kind === 'auth') { wtExpire(); }
      WT.score = null;
      WT.scoreErr = (r && r.error) || '读不到';
    } else {
      WT.score = {
        valid: (typeof r.valid === 'number' && isFinite(r.valid)) ? r.valid : null,
        total: (typeof r.total === 'number' && isFinite(r.total)) ? r.total : null,
      };
      WT.scoreErr = '';
    }
  } catch (e) {
    WT.score = null;
    WT.scoreErr = e.message;
  }
  wtPaintScore();
}

/** 画任务列表。
 *
 *  🔴 「还剩几次」是**自己算的** `limit - used`，响应里没有现成的剩余
 *     （`missions[i].limit` 是总次数，`accScoreRsp.limits[j].limit` 是已做次数，
 *      同名反义 —— 见 water.py 那一大段）。
 *
 *  🔴 按钮的显示条件是 `canRun`（有任务、没读失败）。0.26.0/0.26.1 那两版
 *     写的是「永远不显示，因为盐值没公开」—— 那个前提是错的（盐在官方 APK
 *     里，2026-10-30 取到）。现在签名自己算，不看响应里有没有 `sign`。
 */
/** 「这一页要跑的东西」= 签到（如果有）+ 全部积分任务。
 *
 *  🔴 只写**一处**。列表、计数、确认框、执行循环全部从这里拿 —— 0.26.2 就是
 *     列表和执行各写一遍，结果卡片写「共 3 个」、确认框写「2 个」（红线 59）。
 *  🔴 签到排第一行，因为它是每天必做的那一件；`kind` 决定用哪个请求体：
 *     签到 `{weekday, adId}` / 任务 `{adId, type:101}`。**不能混**（见 wtRunAll）。
 *  ⚠️ 服务端的任务列表里有时也会带一条「每日签到」（refId == daily.adId），
 *     先按 id 剔掉再补我们自己的那一行，否则会重复。
 */
function wtTaskRows() {
  const all = Array.isArray(WT.missions) ? WT.missions : [];
  const d = WT.daily;
  const dailyId = (d && d.adId) || '';
  const rest = dailyId ? all.filter((x) => x.refId !== dailyId) : all;
  if (!dailyId) return rest;
  const base = (typeof d.score === 'number' && isFinite(d.score)) ? d.score : null;
  return [{
    kind: 'signin',
    refId: dailyId,
    name: '每日签到',
    score: base,
    left: d.signed ? 0 : 1,
    used: d.signed ? 1 : 0,
    signed: !!d.signed,
  }].concat(rest);
}

/** 真正**还能跑**的那些（签过的签到不算）。
 *  计数、确认文案、按钮的可用性都按它算 —— 和 `wtTaskRows()` 是同一次计算
 *  的两个视角，不是两份数据。 */
function wtRunnableRows() {
  return wtTaskRows().filter((x) => {
    // 签到：平台说今天签过了，就不算这一轮待做
    if (x.kind === 'signin' && x.signed) return false;
    // 🔴 0.35.0：剩余次数被平台算成 0，就是「今天做完了」。
    //    以前只认签到那一行，于是八个任务全跑完、每一行都写着「已完成」，
    //    上面的计数还写着「待做 8 个」—— 同一张卡里两句话互相打架，
    //    用户会以为「一键完成」没生效。
    //    left 是后端用 limit - used 算出来的；None 表示「不限次」或「读不到」，
    //    那种**不能**当成做完了。
    if (typeof x.left === 'number' && x.left <= 0) return false;
    return true;
  });
}

function wtPaintMissions() {
  const box = $('wtMissions'), tip = $('wtMissionTip'), btn = $('wtRunAll');
  const items = wtTaskRows();
  const todo = wtRunnableRows();

  box.innerHTML = items.map((it) => {
    const st = WT.run[it.refId] || '';
    // 签到已经签过：直接标「已签」，不参与这一轮，也不显示「剩 0 次」那种怪话
    const signed = it.kind === 'signin' && it.signed && !st;
    // 0.35.0：平台算出的剩余次数为 0 —— 今天这个任务到次数了。
    // 和签到同一个待遇：标一句「今天做完了」，不给「剩 0 次」（读起来像还能做零次）。
    const doneToday = !st && typeof it.left === 'number' && it.left <= 0;
    const cls = st === 'ok' ? 'ok' : st === 'bad' ? 'bad' : st ? 'wait'
              : (signed || doneToday ? 'ok' : '');
    const txt = st === 'ok' ? '已完成' : st === 'bad' ? '失败'
              : st ? '执行中' : (signed ? '今天已签' : (doneToday ? '今天做完了' : ''));
    const money = (typeof it.score === 'number' && isFinite(it.score))
      ? '<span class="wtmission-s">+' + it.score + '</span>'
      : '<span class="wtmission-s unknown">分值没读到</span>';
    // 剩余次数：null = 不限次（或读不到），不显示 —— 别编一个数字出来
    // 签到那条固定「剩 1 次」/已签时不显示，它的次数没有意义
    const left = it.kind === 'signin' ? ''
      : doneToday ? ''
      : (typeof it.left === 'number' && isFinite(it.left))
        ? '<span class="wtmission-l">剩 ' + it.left + ' 次</span>'
        : (it.used === -1 ? '<span class="wtmission-l">不限次</span>' : '');
    return '<div class="wtmission' + (WT.cur === it.refId ? ' on' : '')
             + (signed || doneToday ? ' done' : '') + '">' +
             '<span class="wtmission-t">' + esc(it.name || it.refId) + '</span>' +
             left + money +
             (txt ? '<span class="wtmission-st ' + cls + '">' + txt + '</span>' : '') +
           '</div>';
  }).join('');

  // 🔴 0.26.2 起签名能算了（盐从官方 APK 里取到），所以按钮该出现就出现。
  //    仍然要求「至少有一条可跑的」—— 一条都没有时按钮没意义。
  //    计数用 `todo`（签过的签到不算），和确认文案是**同一个数**。
  const canRun = todo.length > 0 && !WT.missionErr;
  btn.hidden = !canRun || WT.running;
  // 🔴 0.35.0：这一轮已经跑成功的不再算「待做」。
  //    WT.run 记着本轮每一条的结果；不扣的话跑完八个，列表每行都写着
  //    「已完成」，卡头还是「待做 8 个」—— 同一张卡里两句话对着干。
  const pending = todo.filter((x) => WT.run[x.refId] !== 'ok');
  const allDone = todo.length > 0 && pending.length === 0;
  btn.disabled = WT.running || allDone;
  // 0.33.0：按钮从卡片底部的通栏按钮挪到标题行，文案跟着变短 ——
  // 「一键完成全部任务」八个字在标题行里会把它挤到下一行。
  btn.textContent = allDone ? '都做完了' : '一键完成';
  // 自动展开：正在跑的时候必须看得见每一行的状态和「停下」，
  // 否则收起状态跑起来就成了「按了没反应」。
  if (WT.running) {
    $('wtTaskBox').hidden = false;
    $('wtTaskOpen').setAttribute('aria-expanded', 'true');
  }
  // 「停下」只在跑的时候出现。放在按钮**下面**而不是旁边：
  // 两个按钮并排且颜色相近时，误点「停下」比误点「开始」更让人火。
  const stop = $('wtRunStop');
  if (stop) stop.hidden = !WT.running;

  const cnt = $('wtTaskCount');
  if (WT.running) {
    cnt.textContent = (todo.length - pending.length) + '/' + todo.length;
  } else {
    // 全做完了就说「做完了」。写「待做 0 个」是把一句结论说成一次统计。
    cnt.textContent = !todo.length ? ''
      : (pending.length ? '待做 ' + pending.length + ' 个' : '今天的都做完了');
  }

  // 哪个平台没读到/没登，要在这儿说出来 —— 不说的话「任务只有这几条」
  // 看起来就是全部，用户不会想到「另一半在另一个账号里」。
  const laneMsg = (() => {
    const L = WT.lanes || {};
    const out = [];
    if (L.score === 'missing') out.push('积分账号没登，另一个平台的任务看不到');
    if (L.device === 'missing') out.push('设备账号没登，另一个平台的任务看不到');
    if (L.score === 'error') out.push('积分平台任务读失败：' + (WT.laneErr.score || ''));
    if (L.device === 'error') out.push('设备平台任务读失败：' + (WT.laneErr.device || ''));
    return out.join('；');
  })();

  if (WT.missionErr && !WT.expired) {
    tip.hidden = false;
    tip.classList.add('bad');
    tip.textContent = '任务列表没读到：' + WT.missionErr;
  } else if (!todo.length && !WT.expired) {
    tip.hidden = false;
    tip.classList.remove('bad');
    // 签过到、又没有别的任务 ⇒ 不是「没有任务」，是「今天的做完了」。
    // 这两句话对用户是两件事：前者让他去别处找，后者告诉他可以关了。
    tip.textContent = (items.length
      ? '今天的都做完了。'
      : '现在没有可做的任务。') + (laneMsg ? '（' + laneMsg + '）' : '');
  } else if (laneMsg) {
    tip.hidden = false;
    tip.classList.remove('bad');
    tip.textContent = laneMsg;
  } else if (WT.missionSkipped > 0) {
    tip.hidden = false;
    tip.classList.remove('bad');
    tip.textContent = '有 ' + WT.missionSkipped + ' 条跳过了（没有 ID 或者属于不做的类别）。';
  } else {
    tip.hidden = true;
    tip.classList.remove('bad');
    tip.textContent = '';
  }
}

async function wtLoadMissions() {
  try {
    const r = await api('/api/water/missions');
    if (!r || !r.ok) {
      if (r && r.kind === 'auth') { wtExpire(); }
      WT.missions = [];
      WT.missionErr = (r && r.error) || '读不到';
      WT.missionSkipped = 0;
      WT.daily = null;
      WT.lanes = null;
      WT.laneErr = {};
    } else {
      WT.missions = Array.isArray(r.items) ? r.items : [];
      WT.missionErr = '';
      WT.missionSkipped = Number(r.skipped) || 0;
      // 签到状态和任务列表是同一个响应里的两块（dailyRSP / accScoreRsp.daily）
      WT.daily = r.daily || null;
      // 哪个平台读了、哪个没登/读失败 —— 界面要靠它说「少的那半在另一个账号里」
      WT.lanes = r.lanes || null;
      WT.laneErr = r.errors || {};
      // 任务列表换了（比如重新登录），上一轮的状态就没意义了
      WT.run = {};
    }
  } catch (e) {
    WT.missions = [];
    WT.missionErr = e.message;
    WT.daily = null;
    WT.lanes = null;
    WT.laneErr = {};
  }
  wtPaintMissions();
}

const wtSleep = (ms) => new Promise((res) => { setTimeout(res, ms); });

/** 两次提交之间等一会儿。**默认 30 秒**，和原版 TokenTaskRateLimiter 一致。
 *
 *  为什么必须等：原版每次提交之间自己压 30 秒，说明打快了会被平台限流
 *  （服务端回 202），更糟的是可能触发风控 —— 而风控的后果是账号被限制、
 *  积分被冻结，不是「重试一下就好」。所以宁可慢。
 *
 *  等待期间每秒更新一次倒计时，并且**随时可以停** —— 让用户干等 30 秒
 *  看着屏幕不动，他会以为卡死了。
 *  返回 false = 用户点了「停」，调用方应该收工。 */
async function wtPace(ms) {
  const box = $('wtRunPace');
  const endAt = Date.now() + ms;
  while (Date.now() < endAt) {
    if (WT.runStop) {
      if (box) { box.hidden = true; box.textContent = ''; }
      return false;
    }
    const left = Math.ceil((endAt - Date.now()) / 1000);
    if (box) {
      box.hidden = false;
      box.textContent = '等 ' + left + ' 秒再提交下一个';
    }
    await wtSleep(250);
  }
  if (box) { box.hidden = true; box.textContent = ''; }
  return !WT.runStop;
}

/** 一键完成全部任务。
 *
 *  🔴 这是**第三个有副作用**的批量操作，而且一次动 N 次账号。三条自我约束：
 *     1. 二次确认，文案要说清「会真的动你的账号、可能被风控」
 *     2. **失败不重试**；连续两个失败就停下 —— 原项目 README 自己写着
 *        「出现异常时请停止任务，勿反复运行期待自动恢复」
 *     3. 跑完**重新读一次积分**来核验。服务端回「成功」不等于到账，
 *        原 README 也写着「请求成功不等于奖励到账」。不信提示，信数字。
 */
async function wtRunAll() {
  if (WT.busy || WT.running) return;
  // 第一次点它：先把风险说清楚。点完「知道了」自动接着走（见 wtNeedTerms）
  if (!wtNeedTerms(() => { wtRunAll(); })) return;
  // 🔴 签到和任务**请求体不一样**，所以在下面的循环里按 `kind` 分派：
  //    签到 `{weekday, adId}` / 任务 `{adId, type:101}`。用错 body 服务端可能
  //    当成一次普通任务，甚至把「签到」记成「做任务」—— 而且**不报错**。
  //    原版也是两条独立的路（DailySignInPlanner / TaskMissionPlanner），
  //    只是被同一个按钮串起来跑。
  //    ⚠️ 用 `wtRunnableRows()` 而**不是**自己再过滤一遍：0.26.2 就是列表和
  //    执行各写一遍，结果列表没剔、执行剔了 ⇒ 卡片一个数、确认框另一个数。
  const items = wtRunnableRows();
  if (!items.length) return;

  const ok = await askConfirm(
    '一键完成全部任务',
    '会逐个完成 ' + items.length + ' 个任务。这是真的在动你的账号：平台可能因此'
      + '限制账号、扣分或清零积分，「提示成功」也不等于到账。中途出错会停下来，不重试。',
    '开始');
  if (!ok) return;

  WT.running = true;
  WT.runStop = false;
  WT.run = {};
  WT.cur = '';
  WT.missionErr = '';
  const before = (WT.score && typeof WT.score.valid === 'number') ? WT.score.valid : null;
  wtPaintMissions();

  let done = 0, fails = 0, stopped = false, firstErr = '', authOut = false;

  for (let i = 0; i < items.length; i += 1) {
    if (WT.runStop) { stopped = true; break; }
    const it = items[i];
    WT.run[it.refId] = 'wait';
    WT.cur = it.refId;
    wtPaintMissions();

    let bad = '';
    try {
      // 🔴 按 kind 分派：签到走 `/api/water/signin`（body 带 weekday），
      //    任务走 `/api/water/mission`（body 带 type）。两条路不能混。
      const d = WT.daily || {};
      const r = (it.kind === 'signin')
        ? await api('/api/water/signin', {
            adId: it.refId,
            weekday: (d.weekday >= 1 && d.weekday <= 7) ? d.weekday : 0,
            score: (typeof it.score === 'number' && isFinite(it.score)) ? it.score : 0,
          })
        : await api('/api/water/mission', {
            adId: it.refId, score: it.score, platform: it.platform || '',
          });
      if (r && r.ok) {
        WT.run[it.refId] = 'ok';
        done += 1;
        fails = 0;                 // 成功一次就重置，判的是「连续」失败
      } else {
        WT.run[it.refId] = 'bad';
        fails += 1;
        bad = wtErrText(r && r.kind, r && r.error);
        if (r && r.kind === 'auth') { authOut = true; }
      }
    } catch (e) {
      WT.run[it.refId] = 'bad';
      fails += 1;
      bad = e.message;
    }
    if (bad && !firstErr) firstErr = bad;

    WT.cur = '';
    wtPaintMissions();

    if (authOut) { wtExpire(); stopped = true; break; }
    if (fails >= 2) { stopped = true; break; }
    // 最后一个不用等 —— 等完也没下一个可跑了，纯属让用户多等半分钟。
    if (i < items.length - 1) {
      if (!(await wtPace(WT.runGap || 30000))) { stopped = true; break; }
    }
  }

  WT.running = false;
  WT.runStop = false;
  WT.cur = '';
  const pace = $('wtRunPace');
  if (pace) { pace.hidden = true; pace.textContent = ''; }
  wtPaintMissions();

  // ---- 核验：重新读一次积分，用数字说话 ----
  await wtLoadScore();
  const after = (WT.score && typeof WT.score.valid === 'number') ? WT.score.valid : null;

  let msg = '跑了 ' + done + ' 个任务';
  if (stopped) msg += '（中途停下了）';
  if (before != null && after != null) {
    const diff = after - before;
    msg += '，可用积分 ' + before + ' → ' + after;
    if (diff > 0) {
      msg += '（+' + diff + '）';
    } else if (diff < 0) {
      // 🔴 变少必须明说。只写「没变」等于把「积分被扣了」说成「什么都没发生」——
      //    用户看到这句就不会去查，而分数确实少了（红线 66g：变多自动接受、
      //    变少必须明说）。
      msg += '（少了 ' + (-diff) + ' 分 —— 积分被扣了，留意一下）';
    } else if (done > 0) {
      msg += '（没变 —— 提示成功不等于到账，过一会儿再看）';
    }
  } else {
    msg += '，但积分没读到，到账情况核不了';
  }
  if (firstErr) msg += '。第一个错误：' + firstErr;

  const tip = $('wtMissionTip');
  tip.hidden = false;
  tip.classList.toggle('bad', done === 0 && !!firstErr);
  tip.textContent = msg;
}

/** 画消费记录。🔴 金额没读到写「金额没读到」，绝不写 ¥0.00。 */
/* ---- 今日 / 本月 / 本年（照出水小部件原版的「本地优先统计」）---------
   🔴 只能按**已经读到的账单**算。没读完的时候那个数是**下限**，所以写成
      「≥ ¥3.20」——把下限说成总额，和「没读到说成 0」是同一类错。
   🔴 有一条金额没读到（money === null）时同样降级：宁可给下限，
      也不许把「这条不知道多少钱」当成 0 悄悄跳过。
   🔴 服务端的账单里有没有充值记录，我们不知道（type 的取值没见过，
      按红线 58 不许兜底猜），所以标题就写「账单合计」，不写「消费」——
      叫消费就得保证只算消费，而我们保证不了。 */
function wtStatsOf(items, now) {
  const y0 = new Date(now.getFullYear(), 0, 1).getTime();
  const m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const acc = { today: 0, month: 0, year: 0 };
  let unknown = false;
  let oldest = Infinity;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (!it || !it.at) continue;
    if (it.at < oldest) oldest = it.at;
    if (typeof it.money !== 'number' || !isFinite(it.money)) { unknown = true; continue; }
    if (it.at >= y0) acc.year += it.money;
    if (it.at >= m0) acc.month += it.money;
    if (it.at >= d0) acc.today += it.money;
  }
  return { acc: acc, unknown: unknown, oldest: oldest };
}

/* ---- 估算水量 ------------------------------------------------------
   账库里**没有真实的毫升数**（原版 WaterConsumptionParser 的注释也是这么说的：
   服务端不返回可靠的出水毫升）。所以只能按「多少钱 ≈ 多少水」换算。
   比例必须可改：冷水和热水的单价不一样，写死一个数总有一半是错的。 */

const WT_USE_KEY = 'wt.usage.local';
const WT_USE_DEF = { on: true, amt: 0.16, vol: 500 };

/** 读配置。坏数据退回默认 —— 算出 NaN 或者「0 ml」比不显示更糟。 */
function wtUsageCfg() {
  const r = store.get(WT_USE_KEY, null);
  if (!r || typeof r !== 'object') return Object.assign({}, WT_USE_DEF);
  const amt = Number(r.amt), vol = Number(r.vol);
  return {
    on: r.on !== false,
    amt: (isFinite(amt) && amt > 0) ? amt : WT_USE_DEF.amt,
    vol: (isFinite(vol) && vol > 0) ? vol : WT_USE_DEF.vol,
  };
}

function wtUsageSave(cfg) { store.set(WT_USE_KEY, cfg); }

/** 4 位小数足够，再把末尾的 0 去掉 —— 「0.1600 元」看着像没填完。 */
function wtNumText(n) { return String(Math.round(n * 10000) / 10000); }

/**
 * 金额 → 水量文字。取整照原版 WaterEstimate.waterText：
 * 满 1000 ml 说「x.x L」，否则四舍五入到 10 ml。
 * 传进来的金额本身是下限时，外面还会加「≥」。
 */
function wtWaterText(money, cfg) {
  if (typeof money !== 'number' || !isFinite(money) || money < 0) return '';
  const c = cfg || wtUsageCfg();
  const ml = Math.floor(money / c.amt * c.vol);
  if (ml >= 1000) return (ml / 1000).toFixed(1) + ' L';
  return (Math.floor((ml + 5) / 10) * 10) + ' ml';
}

/** 比例那一行：有估算时说比例，关掉了也得留一行让人能点回来。 */
function wtPaintUseRow() {
  const c = wtUsageCfg();
  $('wtUseRow').hidden = false;
  $('wtUseTxt').textContent = c.on
    ? '按 ¥' + wtNumText(c.amt) + ' = ' + wtNumText(c.vol) + ' ml 估算'
    : '水量估算已关闭';
}

/** 画那三个数。`complete` = 这一期的起点之后所有账单都读到了。 */
function wtPaintStats() {
  const cells = { today: $('wtToday'), month: $('wtMonth'), year: $('wtYear') };
  const wcells = { today: $('wtTodayW'), month: $('wtMonthW'), year: $('wtYearW') };
  const note = $('wtStatNote');
  const items = Array.isArray(WT.bills) ? WT.bills : [];

  // 一条都还没读回来：写「没读到」，不许写 ¥0.00
  if (!WT.billsLoaded) {
    ['today', 'month', 'year'].forEach((k) => {
      cells[k].textContent = '没读到';
      cells[k].classList.add('unknown');
      cells[k].classList.remove('lower');
      // 金额都没读到，水量更不能留着上一次的数
      wcells[k].textContent = '';
    });
    note.hidden = true;
    // 账单没读到也得让比例那一行在：改比例和读账单是两件事，
    // 不能因为接口挂了就连设置都进不去。
    wtPaintUseRow();
    return;
  }

  const now = new Date();
  const st = wtStatsOf(items, now);
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const y0 = new Date(now.getFullYear(), 0, 1).getTime();

  // 读完了（没有下一页）⇒ 三期都完整；否则「起点之后还有没读到的」
  // 只有当最老的一条比这一期的起点还早，才能说这一期是完整的。
  const done = !WT.billsMore;
  const spans = {
    today: done || st.oldest < d0,
    month: done || st.oldest < m0,
    year: done || st.oldest < y0,
  };

  const cfg = wtUsageCfg();
  let anyLower = false;
  ['today', 'month', 'year'].forEach((k) => {
    const el = cells[k];
    const lower = !spans[k] || st.unknown;
    if (lower) anyLower = true;
    el.textContent = (lower ? '≥ ' : '') + '¥' + st.acc[k].toFixed(2);
    el.classList.toggle('lower', lower);
    el.classList.remove('unknown');
    // 金额是下限，估出来的水量跟着是下限 —— 两个符号必须一起出现，
    // 不然「≥ ¥3.20」配「1.0 L」就是说这个数准了。
    wcells[k].textContent = cfg.on
      ? (lower ? '≥ ' : '') + wtWaterText(st.acc[k], cfg)
      : '';
  });

  if (st.unknown) {
    note.hidden = false;
    note.textContent = '有几条账单的金额没读到，所以上面是下限。';
  } else if (anyLower) {
    note.hidden = false;
    note.textContent = '还有更早的账单没读完（点「加载更多」），所以上面是下限。';
  } else {
    note.hidden = true;
    note.textContent = '';
  }
  wtPaintUseRow();
}

function wtPaintBills() {
  const box = $('wtBills'), tip = $('wtBillTip'), more = $('wtBillMore');
  const items = Array.isArray(WT.bills) ? WT.bills : [];

  box.innerHTML = items.map((b) => {
    const money = (typeof b.money === 'number' && isFinite(b.money))
      ? '<span class="wtbill-money">¥' + b.money.toFixed(2) + '</span>'
      : '<span class="wtbill-money unknown">金额没读到</span>';
    const when = b.at ? ntStamp(b.at / 1000) : '';
    const sub = [when, b.did ? '设备 ' + b.did : ''].filter(Boolean).join(' · ');
    return '<div class="wtbill">' +
             '<span class="wtbill-main">' +
               '<span class="wtbill-t1">' + esc(b.msg || '消费') + '</span>' +
               (sub ? '<span class="wtbill-t2">' + esc(sub) + '</span>' : '') +
             '</span>' + money +
           '</div>';
  }).join('');

  // 加载更多：只在「确实还有下一页」时出现。靠「这页是不是满的」猜的话，
  // 最后一页正好装满时会多给一个点了是空的按钮。
  more.hidden = !WT.billsMore;

  if (WT.billErr && !WT.expired) {
    tip.hidden = false;
    tip.classList.add('bad');
    tip.textContent = '消费记录没读到：' + WT.billErr;
  } else if (!items.length && WT.billsLoaded && !WT.expired) {
    tip.hidden = false;
    tip.classList.remove('bad');
    tip.textContent = '还没有消费记录。';
  } else {
    tip.hidden = true;
    tip.classList.remove('bad');
    tip.textContent = '';
  }

  // 收起时右边那行字：最近一条。不展开也知道刚被扣了多少。
  // 🔴 没读到就说「没读到」，不许写成 ¥0.00 或空着 —— 空着像是「今天没花钱」。
  const brief = $('wtBillBrief');
  if (WT.billErr && !WT.expired) {
    brief.textContent = '没读到';
  } else if (!WT.billsLoaded) {
    brief.textContent = '—';
  } else if (!items.length) {
    brief.textContent = '还没有记录';
  } else {
    const b = items[0];
    const money = (typeof b.money === 'number' && isFinite(b.money))
      ? '¥' + b.money.toFixed(2) : '金额没读到';
    brief.textContent = (b.at ? money + ' · ' + agoText(b.at / 1000) : money);
  }

  // 三个合计跟着列表一起重画 —— 分开画的话「加载更多」之后数字不动，
  // 用户会以为统计坏了。
  wtPaintStats();
}

/** 拉消费记录。`more` = true 表示翻下一页（往已有列表后面追加）。 */
async function wtLoadBills(more) {
  const btn = $('wtBillMore');
  if (more) btn.disabled = true;
  const page = more ? WT.billsPage + 1 : 0;
  try {
    const r = await api('/api/water/bills?page=' + page);
    if (!r || !r.ok) {
      if (r && r.kind === 'auth') { wtExpire(); }
      WT.billErr = (r && r.error) || '读不到';
      if (!more) { WT.bills = []; WT.billsPage = 0; WT.billsMore = false; }
    } else {
      const got = Array.isArray(r.items) ? r.items : [];
      WT.bills = more ? WT.bills.concat(got) : got;
      WT.billsPage = page;
      WT.billsMore = !!r.more;
      WT.billErr = '';
      WT.billsLoaded = true;
    }
  } catch (e) {
    WT.billErr = e.message;
  } finally {
    btn.disabled = false;
  }
  wtPaintBills();
}

/* ---- 接水进行中（本机记的会话，**不是**服务端状态）---------------
   /ui/app/master 只给设备列表，没有「这台正在出水」这个字段。所以这里
   记的是「你在本机点过 start」，不是「设备真的在出水」—— 文案不能装作
   知道设备真实状态。

   🔴 0.38.0：光记一笔**不够**，必须自己判断它什么时候结束。
      用户 2026-11-01：「在饮水机上结束后 APP 里还是显示正在接水」。
      旧写法只有两条路能把它清掉：本机点「停止」、或者等 2 小时过期。
      人在机器上按了结束，APP 就一路挂着「正在出水」两小时 —— 而且那两小时
      里它还会按「正在出水」的样子继续显示，用户以为在一直扣钱。
      照 WaterWidget（nocookies111/life-798，MIT）的做法补两件事：
        ① **查账单**：启动 8 秒后开始，每 10 秒读一次消费记录；
           出现「启动时刻之后」的账单 ⇒ 这次接水结束了，立刻收条子 + 结算。
        ② **超时兜底**：10 分钟（= WaterWidget 的 MAX_MONITOR_MILLIS）
           还没读到账单，就当它已经结束，把条子收掉。
      ⚠️ WaterWidget 的会话**只存内存**、重启就没了；我们存在 localStorage
         （网页版刷新一次不该把「正在出水」弄丢），所以**有效期是唯一的安全阀**
         —— 它必须短，短到「挂着一条假的」比「漏掉一次真的」更烦人。
      ⚠️ 判据只能是「账单里有没有新条目」：设备状态接口不存在，
         「过了 X 秒」只是兜底，不能拿它当结束信号。 */
const WT_LIVE_KEY = 'wt.live';
const WT_LIVE_TTL = 10 * 60 * 1000;   // 10 分钟，对齐 WaterWidget 的最长监测
const WT_POLL_FIRST = 8000;           // 启动后 8 秒先查一次（账单不会立刻出）
const WT_POLL_EVERY = 10000;          // 之后每 10 秒一次
let wtPollTimer = null;

function wtLoadLive() {
  const v = store.get(WT_LIVE_KEY, null);
  if (!v || !v.did || !v.at) { WT.live = null; return; }
  if (Date.now() - v.at > WT_LIVE_TTL) {      // 过期就扔掉，别留着吓人
    store.del(WT_LIVE_KEY);
    WT.live = null;
    return;
  }
  WT.live = v;
}

function wtPaintLive() {
  const box = $('wtLive');
  if (!WT.live || !WT.live.did) { box.hidden = true; return; }
  box.hidden = false;
  // 🔴 文案只能说「**你启动过**」，不能说「正在出水」—— 设备状态我们读不到。
  //    0.38.0 加了账单轮询，能知道「这次结束了」，但**结束之前**有没有真的在流，
  //    仍然没有接口能证明。说「已启动」是真的，说「正在出水」是猜的。
  //    所以主语是「你」不是「机器」：「刚才你启动了 X」是本机发生过的事实。
  $('wtLiveName').textContent = '刚才你启动了 ' + (WT.live.name || ('设备 ' + WT.live.did));
  $('wtLiveWhen').textContent = agoText(WT.live.at / 1000) + ' · 接完自动结算';
}

/** 停掉轮询。离开这一页 / 停水 / 过期都要调 —— 不调就是每 10 秒打一次服务器。 */
function wtLiveStopPoll() {
  if (wtPollTimer) { clearTimeout(wtPollTimer); wtPollTimer = null; }
}

/** 结算这次接水：刷余额 + 读账单 + 填「刚才那次」。
 *  🔴 账单可能还没出 ⇒ money 为 null，写「账单还没出」，绝不写 ¥0.00。
 *  wtStop（本机点的）和 wtLivePoll（机器上按的）共用这一份，别各写一遍。 */
async function wtSettle(lv) {
  await wtLoad();
  await wtLoadBills(false);
  const sm = wtSumSince(WT.bills, lv.at);
  WT.last = { did: lv.did, name: lv.name, at: lv.at,
              money: sm.money, partial: sm.partial };
  wtPaintLast();
}

/** 结束这次接水（不论是谁结束的）：收条子、清本机记录、结算。 */
async function wtLiveEnd(msg, lv) {
  wtLiveStopPoll();
  WT.live = null;
  store.del(WT_LIVE_KEY);
  wtPaintLive();
  if (msg) toast(msg, 3000);
  try { await wtSettle(lv); } catch (e) { /* 结算失败不影响「已经结束」这个事实 */ }
}

/** 查一次账单，看这次接水是不是已经结束了。
 *  🔴 查不到 ≠ 结束：网络错误、还没记账都当「继续等」，
 *     只有**真读到**启动时刻之后的账单才收条子。 */
function wtLivePoll() {
  wtLiveStopPoll();
  const lv = WT.live;
  if (!lv || !lv.did) return;
  // 超时兜底：等满 10 分钟还没账单，就当它早停了（WaterWidget 的 expireIfNeeded）
  if (Date.now() - lv.at > WT_LIVE_TTL) {
    wtLiveEnd('这次接水提醒已经结束，账单可以往下看消费记录', lv);
    return;
  }
  if (document.hidden) return;      // 页面看不见就不查，回到前台再起（见 visibilitychange）
  const at = lv.at;
  api('/api/water/bills?page=0').then((r) => {
    // 期间被停掉 / 换了另一台：这一趟作废，别拿旧数据去收新会话
    if (!WT.live || WT.live.at !== at) return;
    if (!r || !r.ok) { wtPollTimer = setTimeout(wtLivePoll, WT_POLL_EVERY); return; }
    const bills = Array.isArray(r.items) ? r.items : [];
    if (wtSumSince(bills, at).money !== null) {
      wtLiveEnd('这次接水结束了，已按账单结算', lv);
      return;
    }
    wtPollTimer = setTimeout(wtLivePoll, WT_POLL_EVERY);
  }).catch(() => {
    if (WT.live && WT.live.at === at) wtPollTimer = setTimeout(wtLivePoll, WT_POLL_EVERY);
  });
}

/** 起轮询。启动成功后调一次；回到「功能」页 / 回到前台也调（幂等，先清旧定时器）。 */
function wtLiveStartPoll() {
  wtLiveStopPoll();
  if (!WT.live || !WT.live.did) return;
  const left = WT_LIVE_TTL - (Date.now() - WT.live.at);
  if (left <= 0) { wtLiveEnd('这次接水提醒已经结束，账单可以往下看消费记录', WT.live); return; }
  wtPollTimer = setTimeout(wtLivePoll, Math.min(WT_POLL_FIRST, left));
}

/* ---- 「刚才那次」结算 ----------------------------------------------
   原版接水结束会通知「本次消费 + 估算水量」。水量要一个金额↔升数的兑换
   比例（原版可配置，我们不知道真值），**不编** —— 只报金额。

   🔴 账单不是立刻出的：停止后立刻读一次，读不到就写「账单还没出」，
      绝不当成 ¥0.00。这是「没读到 ≠ 0」在同一页的第三次应用。 */
function wtPaintLast() {
  const box = $('wtLast'), v = $('wtLastV'), tip = $('wtLastTip');
  if (!WT.last || !WT.last.at) { box.hidden = true; return; }
  box.hidden = false;
  $('wtLastWhen').textContent = ntStamp(WT.last.at / 1000) + ' 起';
  if (typeof WT.last.money === 'number' && isFinite(WT.last.money)) {
    v.textContent = (WT.last.partial ? '≥ ' : '') + '¥' + WT.last.money.toFixed(2);
    v.classList.remove('unknown');
    v.classList.toggle('lower', !!WT.last.partial);
    tip.hidden = !WT.last.partial;
    tip.textContent = WT.last.partial ? '有几笔的金额还没读到，所以这是下限。' : '';
  } else {
    v.textContent = '账单还没出';
    v.classList.add('unknown');
    tip.hidden = false;
    tip.textContent = '平台一般几分钟后才记账。等一下点右上角刷新，或者看下面的消费记录。';
  }
}

/** 从已读到的账单里，把「这次接水」那几笔挑出来加总。
 *  时间窗从启动前一分钟算起（服务端记账时间可能比我们点「开始」早几秒）。
 *  返回 {money, partial}：一条都找不到 ⇒ money = null（= 还没出账），**不是 0**；
 *  有几条金额没读到 ⇒ partial = true（那个数是下限）。 */
function wtSumSince(bills, since) {
  let sum = 0, hit = 0, partial = false;
  (Array.isArray(bills) ? bills : []).forEach((b) => {
    if (!b || !b.at || b.at < since - 60000) return;
    hit += 1;
    if (typeof b.money === 'number' && isFinite(b.money)) sum += b.money;
    else partial = true;
  });
  return { money: hit ? sum : null, partial: partial };
}

/** 停止接水。**第二个有副作用**的调用（结束计费）。
 *  🔴 不自动重试：同一台设备可能不止一个人在用，重试可能停掉别人的水。
 *  🔴 **不弹二次确认**（2026-10-31 用户拍板：「结束」按一颗就走）。
 *     停水是**往安全方向**的动作 —— 每多一次点击，水就多流一会儿；
 *     而误点「结束」最多是这次少接一点，再点一次「接水」就行。
 *     防误触靠的是按钮位置（在「正在出水」条里，红色）和它只在这一条里出现。 */
async function wtStop() {
  if (WT.busy) return;
  const lv = WT.live;
  if (!lv || !lv.did) return;

  WT.busy = true;
  try {
    const r = await api('/api/water/end', { did: lv.did });
    if (!r || !r.ok) {
      if (r && r.kind === 'auth') { wtExpire(); return; }
      toast(wtErrText(r && r.kind, r && r.error), 4000);
      return;                        // 没停成，提醒留着 —— 别让用户以为停了
    }
    wtLiveStopPoll();
    WT.live = null;
    store.del(WT_LIVE_KEY);
    wtPaintLive();
    toast('已停止', 3000);
    // 结算会改余额、也会多一条账单，顺手刷一下（和自动结束共用一份，见 wtSettle）
    await wtSettle(lv);
  } catch (e) {
    toast('停止失败：' + e.message, 4000);
  } finally {
    WT.busy = false;
  }
}

/* ---- 免责声明：**积分任务**那一条路弹一次 ----------------------------
   文案在 index.html 里（照 WaterWidget 的 README / TaskRiskDialog 抄的）。
   🔴 每次进都弹等于逼人盲点「我知道了」，那这个提示就白写了 ⇒ 记一笔。
   🔴 也**不能**一进「功能」页就弹：那一页还有一卡通和办事入口，多数人不是
      为积分来的；而这一层是 `position:fixed; inset:0` 的全屏遮罩，会把底部
      导航一起盖住 —— 用户看到的是「点了没反应」，以为 App 卡死了。
      ⇒ 只挂在「一键完成」这个**真会动账号**的动作前面。
   🔴 0.38.0：**接水那条路已经不弹它了**（用户 2026-11-01：「点接水不要出
      弹窗提示了，太麻烦了」）。接水的风险改成卡里常驻一行 `#wtRisk`。
      这里保留是因为积分任务会被平台风控（扣分/冻结/限流），
      那是用户明确要求过的一次性告知，跟「接水会出水」不是一回事。 */
const WT_TERMS_KEY = 'wt.terms.ok';
/* 点了「知道了」要接着做的那件事（只在首次弹层时存在） */
let wtPending = null;

/** true = 已经读过，可以继续；false = 刚弹出来，等用户点「知道了」。 */
function wtNeedTerms(next) {
  if (store.get(WT_TERMS_KEY, false)) return true;
  wtPending = (typeof next === 'function') ? next : null;
  $('wtTerms').hidden = false;
  return false;
}

function wtTermsOk() {
  $('wtTerms').hidden = true;
  store.set(WT_TERMS_KEY, true);
  const f = wtPending;
  wtPending = null;
  if (f) f();
}

/** 进这一页。**先画缓存再探网** —— 每次进来都从空白开始等，是白等。 */
async function renderWater() {
  wtLoadLive();           // 「刚才你启动了 X」是本机记的，不用等网络
  wtPaintLive();
  wtPaintLast();          // 「刚才那次」只在本进程里有，切回来还在就还显示
  // 有会话就接着盯账单（切走时 switchTab 会停掉，回来这里再起）
  if (WT.live) wtLiveStartPoll();

  let st;
  try {
    st = await api('/api/water/state');
  } catch (e) {
    wtShowOff();
    wtTip('读不到登录状态：' + e.message, true);
    return;
  }
  const acc = (st && st.accounts) || {};
  WT.accounts = { device: acc.device || null, score: acc.score || null };
  if (!st || st.state === 'none' || st.state === 'broken') {
    WT.loginKind = '';
    wtShowOff();
    // 「存着但解不开」（换过手机 / 清过数据 / Keystore 换密钥）和「从没登录」
    // 长得一样，但该说的话不一样：前者重登一次就好，后者是第一次用。
    if (st && st.state === 'broken') {
      wtTip('存的登录信息读不出来了（换过手机或清过 App 数据），重新登录一次就好', true);
    }
    return;
  }

  // partial = 只登了其中一个账号。**照常显示能看的部分**，缺的那半在账号卡上说。
  if (Array.isArray(st.devices)) WT.devs = st.devices;
  wtShowOn();
  wtPaintDevs();          // 本机缓存，不用等网络
  wtPaintBal();           // 余额没有缓存，先画「没读到」，等下面那次结果
  wtPaintScore();         // 同上：先画「没读到」，别让格子空着像坏了
  wtPaintMissions();
  wtPaintBills();
  // 设备账号才有余额/设备/账单；只登了积分账号时别去请求（会白报一个 auth 错）
  if (WT.accounts.device) {
    await wtLoad();
  } else {
    WT.balErr = '要用「设备登录」那个账号才能查余额和接水';
    WT.devErr = '';
    wtPaintBal();
    wtPaintDevs();
  }
  await wtLoadExtras();
}

/** 余额设备之外的三块（积分 / 任务 / 消费记录）并行拉。
 *  并行不是图快：串行的话任务接口慢一点，账单就跟着晚三秒才出来。
 *  每块自己 catch，一块挂了不影响另外两块 —— 用户至少要看到能看的那部分。 */
async function wtLoadExtras() {
  const jobs = [
    wtLoadScore().catch(() => {}),
    wtLoadMissions().catch(() => {}),
    // 兑换要的钱包端点。和积分同一个账号，所以一起拉；失败不影响别的块。
    wtLoadWallets().catch(() => {}),
  ];
  // 🔴 消费记录只认**设备账号**（1,1）。只登了积分账号时别去请求：
  //    打过去会被路由的守卫挡回来，`kind` 是 auth，而 `wtLoadBills` 见到
  //    auth 就弹「登录状态过期」—— 明明没过期，只是没登另一个账号。
  //    「没登这个账号」和「票过期了」在界面上必须是两句话。
  if (WT.accounts.device) {
    jobs.push(wtLoadBills(false).catch(() => {}));
  } else {
    WT.billErr = '要用「设备登录」那个账号才能看消费记录';
    WT.bills = [];
    WT.billsLoaded = false;
    wtPaintBills();
  }
  await Promise.all(jobs);
}

/** 点右上角刷新：这一页所有东西都重读一遍。 */
async function wtRefreshAll() {
  // 同上：没有设备账号时 `/home` 会回 auth，被当成「登录过期」弹卡。
  if (WT.accounts.device) {
    await wtLoad();
  } else {
    WT.bal = null;
    WT.balErr = '要用「设备登录」那个账号才能查余额和接水';
    wtPaintBal();
    wtPaintDevs();
  }
  await wtLoadExtras();
}

/** 发短信验证码。🔴 失败不自动重试，换一张图让用户重新读。 */
async function wtSendSms() {
  if (WT.busy) return;
  const phone = $('wtPhone').value.trim();
  const graph = $('wtGraph').value.trim();
  if (!/^1\d{10}$/.test(phone)) { wtTip('手机号看着不对，检查一下（11 位数字）', true); return; }
  if (!graph) { wtTip('先把图上的字填进去', true); return; }
  if (!WT.key) { wtTip('图形验证码没加载出来，点「换一张」', true); return; }

  WT.busy = true;
  $('wtSend').disabled = true;
  wtTip('正在发短信…', false);
  try {
    const r = await api('/api/water/sms', { phone, key: WT.key, graph });
    if (!r || !r.ok) {
      wtTip(wtErrText(r && r.kind, r && r.error), true);
      wtNewCaptcha();               // 图形验证码一次性，失败必须换
      return;
    }
    wtTip('短信发出去了，看一下手机', false);
    wtCountdown(60);
    $('wtSms').focus();
  } catch (e) {
    wtTip('发短信失败：' + e.message, true);
  } finally {
    WT.busy = false;
    if (!WT.timer) $('wtSend').disabled = false;
  }
}

/** 用短信验证码换 token。🔴 失败**绝不自动重试**（红线）：错一次就换图。 */
/** 点了某一行的按钮：已登录就退出，没登录就展开表单登这个。 */
async function wtAccTap(kind) {
  if (WT.busy) return;
  const a = WT.accounts[kind];
  if (a) { await wtLogout(kind); return; }
  WT.loginKind = kind;
  WT.key = '';                 // 换账号就换一张图，别用上一张的 key
  wtPaintAccounts();
  $('waterOff').hidden = false;
  $('wtLoginTitle').textContent = kind === 'device' ? '登录设备账号' : '登录积分账号';
  $('wtLoginWhy').textContent = kind === 'device'
    ? '设备账号管接水、余额、设备列表。用的是短信验证码，密码不用填。'
    : '积分账号管积分、积分任务、签到。用的是短信验证码，密码不用填。'
      + '同一个手机号就行 —— 但它是**另一个**账号，要单独登一次。';
  // 表单在页面上方，滚上去让人看见它出来了
  const box = $('waterOff');
  if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  wtNewCaptcha();
}

function wtCancelLogin() {
  WT.loginKind = '';
  WT.key = '';
  $('waterOff').hidden = true;
  $('wtSms').value = '';
  $('wtGraph').value = '';
  wtTip('', false);
  wtPaintAccounts();
  // 一个账号都没有的话，账号卡本来就空着 —— 把它顶上来当「首次使用」的说明
  if (!WT.accounts.device && !WT.accounts.score) wtShowOff();
}

async function wtLogin() {
  if (WT.busy) return;
  const kind = WT.loginKind || 'device';
  const phone = $('wtPhone').value.trim();
  const sms = $('wtSms').value.trim();
  if (!/^1\d{10}$/.test(phone)) { wtTip('手机号看着不对，检查一下（11 位数字）', true); return; }
  if (!/^\d{4,8}$/.test(sms)) { wtTip('短信验证码是手机收到的那串数字', true); return; }

  WT.busy = true;
  $('wtLogin').disabled = true;
  wtTip('正在登录…', false);
  try {
    const r = await api('/api/water/login', { phone, sms, kind });
    if (!r || !r.ok) {
      wtTip(wtErrText(r && r.kind, r && r.error), true);
      wtNewCaptcha();
      $('wtSms').value = '';
      return;
    }
    WT.phone = r.phone || phone;
    WT.key = '';                  // 这张图用完了，下次登录要新的
    WT.loginKind = '';            // 表单收起来
    $('wtSms').value = '';
    $('wtGraph').value = '';
    wtTip('', false);
    clearInterval(WT.timer);
    WT.timer = 0; WT.cd = 0;
    $('wtSend').disabled = false;
    $('wtSend').textContent = '发送';
    // 🔴 登完**整页重画**，不是只画账号卡：补登积分账号后，任务列表会多出
    //    另一个平台的那一半，签到卡也可能才第一次能显示。只画账号卡的话，
    //    用户看到「已登录」却还是那几条任务，会以为没生效。
    await renderWater();
  } catch (e) {
    wtTip('登录失败：' + e.message, true);
  } finally {
    WT.busy = false;
    $('wtLogin').disabled = false;
  }
}

/** 启动一台饮水机。
 *  🔴 **唯一有副作用**的调用：真的会出水、真的会按用量扣钱。
 *  🔴 **什么都不弹**（2026-10-31 拍板不弹二次确认；2026-11-01 又把免责弹层也撤了：
 *     「点接水不要出弹窗提示了，太麻烦了」）。
 *     走过的两版理由都记在这儿，免得以后有人又「出于安全」加回去：
 *       · 二次确认问的是「会出水、会扣钱」—— 这是接水这件事的定义，
 *         问第二遍只是挡路；真正防误触的是**位置**（按钮只长在某一台设备那一行）
 *         和**即时反馈**（点完这一行立刻变成「正在出水 + 停止」）。
 *       · 免责声明原来是一次性全屏遮罩，但它挡住的恰恰是「第一次用水」那一下，
 *         而且「知道了」点完还是要接水 —— 它的作用是**告知**，不是**关卡**。
 *         ⇒ 改成卡里常驻的一行小字（`#wtRisk`），风险照旧写在用户眼前，
 *           只是不再拦着他。
 *     ⚠️ 积分任务的免责弹层**没撤**（wtRunAll 那条路）：那是会动账号的风控动作，
 *        用户明确要求过那一次告知，两者不是一回事。
 *  ⚠️ 参数 `name` 只用于提示文案，不参与请求。 */
async function wtStart(did, name) {
  if (WT.busy) return;
  if (!did) { toast('这台设备的编号没读到，刷新一下'); return; }
  const label = name || ('设备 ' + did);

  WT.busy = true;
  try {
    const r = await api('/api/water/start', { did });
    if (!r || !r.ok) {
      if (r && r.kind === 'auth') { wtExpire(); return; }
      // 业务错误逐条说清楚（欠费 / 没签约 / 没绑卡 / 没权限…），
      // 这些**不是**重试能救的，所以要停 4 秒让人读完。
      toast(wtErrText(r && r.kind, r && r.error), 4000);
      return;
    }
    toast(r.msg || '已经启动了，接完自动结算', 3000);
    // 记下「你在本机点了启动」，提醒条要用它。
    // 🔴 这只是**本机记录**，不是服务端状态 —— /ui/app/master 没有
    //    「这台正在出水」这个字段，别把猜的说成读到的。
    WT.live = { did: did, name: label, at: Date.now() };
    store.set(WT_LIVE_KEY, WT.live);
    // 新一轮开始，「刚才那次」就该让位 —— 留着会让人以为这次已经结算过了
    WT.last = null;
    wtPaintLive();
    wtPaintLast();
    // 开始盯账单：人可能在机器上按结束，APP 得自己发现（见 wtLivePoll）
    wtLiveStartPoll();
  } catch (e) {
    toast('启动失败：' + e.message, 4000);
  } finally {
    WT.busy = false;
  }
}

/** 退出登录。只清本机的 token，**不动**慧生活798 那边的登录态 ——
 *  我们没资格替用户在别人的平台上登出。 */
async function wtLogout(kind) {
  const one = (kind === 'device' || kind === 'score') ? kind : '';
  const name = one === 'device' ? '设备账号' : (one === 'score' ? '积分账号' : '登录');
  const ok = await askConfirm('退出' + name,
    one
      ? '只会清掉这台手机上存的这个账号，另一个账号不受影响。慧生活798 那边的登录也不受影响。'
      : '只会清掉这台手机上存的登录态，慧生活798 那边的登录不受影响。下次要用得再收一条短信。',
    '退出');
  if (!ok) return;
  try {
    await api('/api/water/logout', one ? { kind: one } : {});
  } catch (e) { /* 清不掉也要把界面切回去，别卡在「已登录」 */ }
  WT.key = '';
  WT.loginKind = '';
  if (one) {
    // 🔴 只退一格：另一个账号的数据原样留着。整套清掉的话，退积分账号会
    //    把余额和设备也变成「没读到」，而用户只是不想跑任务了。
    WT.accounts[one] = null;
    if (one === 'score') {
      WT.score = null; WT.scoreErr = '';
      WT.missions = []; WT.missionErr = ''; WT.missionSkipped = 0;
      WT.daily = null; WT.lanes = null; WT.laneErr = {};
      WT.run = {}; WT.running = false; WT.cur = '';
    } else {
      WT.bal = null; WT.balErr = ''; WT.devs = []; WT.devErr = '';
      WT.loadedAt = 0;
      WT.live = null; store.del(WT_LIVE_KEY);
      WT.last = null;
      wtPaintLive(); wtPaintLast();
    }
    clearInterval(WT.timer);
    WT.timer = 0; WT.cd = 0;
    $('wtSend').disabled = false;
    $('wtSend').textContent = '发送';
    $('wtPhone').value = '';
    $('wtSms').value = '';
    $('wtGraph').value = '';
    await renderWater();
    return;
  }
  WT.bal = null; WT.balErr = ''; WT.devs = []; WT.devErr = '';
  WT.loadedAt = 0; WT.expired = false;
  // 0.24.0 的三块也要清：不清的话换个人登录，屏幕上还挂着上一个人的积分和账单
  WT.score = null; WT.scoreErr = '';
  WT.missions = []; WT.missionErr = ''; WT.missionSkipped = 0;
  WT.daily = null; WT.lanes = null; WT.laneErr = {};
  WT.run = {}; WT.running = false; WT.cur = '';
  WT.bills = []; WT.billErr = ''; WT.billsPage = 0; WT.billsMore = false;
  WT.billsLoaded = false;
  WT.accounts = { device: null, score: null };
  WT.live = null; store.del(WT_LIVE_KEY);      // 换账号了，上一个人接的水不关我事
  wtLiveStopPoll();                            // 轮询也得停，否则拿新账号去查旧会话
  WT.last = null;                              // 「刚才那次」也是上一个人的
  wtPaintLive();
  wtPaintLast();
  clearInterval(WT.timer);
  WT.timer = 0; WT.cd = 0;
  $('wtSend').disabled = false;
  $('wtSend').textContent = '发送';
  $('wtPhone').value = '';
  $('wtSms').value = '';
  $('wtGraph').value = '';
  wtShowOff();
}

/* ---- 郑航百科（wiki.zua.fan）------------------------------------------
   学长们写的非官方百科。**我们只做入口，不复制正文**：
   站上「关于本项目」写着「任何复制、转载请注明出处！严禁用于商业用途！」，
   而且它目前还没开源（原文：「预计近期上线 GitHub」）。
   ⇒ 这里只存「标题 + 相对路径」，点了打开原站那一页。

   ⚠️ 路径是手抄的，对方改结构就会 404。缓解办法：
      · 全部写成 `/xxx` 相对路径拼在 WIKI_HOME 后面 —— 换域名只改一处
      · `check_wiki_links.py` 盯着两件事：路径必须是相对路径、
        拼出来的 URL 必须还在 wiki.zua.fan 里（离线跑，不联网）
   ⚠️ 别用 `<a href>`：MainActivity 拦掉一切非 app.local 的跳转，
      点了毫无反应、也不报错 —— 必须走 openWiki → openApp。 */
const WIKI_HOME = 'https://wiki.zua.fan';
const WIKI_GROUPS = [
  ['关于郑航', [
    ['学校简介', '/aboutZUA/'],
    ['映像郑航', '/aboutZUA/videos'],
    ['校园地图', '/map/'],
  ]],
  ['招生与入学', [
    ['招生章程', '/enroll/brochure'],
    ['招生计划', '/enroll/plan'],
    ['新生入学须知', '/enroll/starting'],
  ]],
  ['校园生活', [
    ['宿舍', '/life/hostel'],
    ['日常消费', '/life/consumption'],
    ['交通出行', '/life/transportation'],
  ]],
  ['人才培养', [
    ['大类分流', '/education/MajorSelection'],
    ['转专业', '/education/ChangingMajors'],
  ]],
  ['其他', [
    ['社区（QQ 频道 / 贴吧群）', '/community/'],
    ['关于这个站', '/aboutUs/'],
  ]],
];

/** 把 4 组 13 条填进独立页（`#page-wiki`）。
 *
 *  🔴 为什么是页面不是弹层：11 条 + 4 个组标题在 `.sheet` 里放不下 ——
 *     实测内容 839px、可用高度 641px（`max-height:76%`），底部按钮被滚出屏幕
 *     （按钮底边 1009 / 视口 844）。一页装得下，也不用内部滚动。
 *     弹层那版是做完才量出来的，量完就改了 —— 「代码里写着对」和「画出来对」是两件事。
 */
function renderWikiPage() {
  // 组名在卡片**外面**、条目在一张白卡里 —— iOS 分组列表的样子。
  // 旧版是「组名 + 13 行全塞进同一张卡」，组与组之间只靠一条 14px 的间距分开，
  // 扫起来分不清哪几行是一组的（用户 2026-10-28 说的「审美」就是这个）。
  //
  // 🔴 0.33.0：组内改成**两列**（用户：「每个界面的内容都放在一页内」）。
  //    单列 13 行 = 802px，一页 1026、可用只有 731，怎么压都装不下；
  //    两列后 8 行装完。`lastrow` 是给 CSS 用的：最后一行不画分隔线 ——
  //    两列时最后一个格子可能落在**左列**，`:last-child` 算不准。
  $('wikiList').innerHTML = WIKI_GROUPS.map(([g, items]) => {
    const lastRowStart = Math.max(0, (Math.ceil(items.length / 2) - 1) * 2);
    return '<div class="wikigroup">' +
      '<div class="gname">' + esc(g) + '</div>' +
      '<div class="card wcard">' +
        items.map(([name, path], i) =>
          '<button class="wikilink' + (i >= lastRowStart ? ' lastrow' : '') +
          '" data-path="' + escAttr(path) + '">' +
          '<span class="t">' + esc(name) + '</span>' +
          '<svg class="go" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' +
          '</button>').join('') +
      '</div>' +
    '</div>';
  }).join('');
  // innerHTML 会把旧节点连同监听一起扔掉，所以每次重画都重新绑一遍。
  // 不重绑的话第二次进来点了没反应，而且**不报错**。
  $('wikiList').querySelectorAll('.wikilink').forEach((b) => {
    b.addEventListener('click', () => { openWiki(WIKI_HOME + b.dataset.path); });
  });
}

/** 百科的外链统一走这里 —— **只允许 wiki.zua.fan**，别的一律不开。
 *  白名单是必须的：URL 来自 DOM 的 `data-path`，将来有人往里塞绝对地址，
 *  `WIKI_HOME + x` 会拼出别的站（`https://wiki.zua.fan` + `https://evil`）。
 *  这也是「跨产品复用页面必断言外链白名单」那条红线的具体落点。 */
function openWiki(url) {
  if (!/^https:\/\/wiki\.zua\.fan\//.test(url)) {
    toast('链接不对，没打开');
    return;
  }
  // 0.17.3 起在 App 内打开：这个站没有登录态，所以不是为了免登录 ——
  // 纯粹是别把人踢出去再跳回来。外面那套（白名单 → 有反馈）一条都不少。
  // warn=false：公开站，别弹「门户登录已过期」。
  if (!openApp(url, '郑航百科', false)) toast('打不开，可以复制链接手动打开');
}

/** 「我的 → 检查更新」：开关 + 频率 + 立即检查，一屏放完。 */
function openUpdateSheet() {
  const on = CFG.updOn !== false;
  const freq = UPD_FREQ_SEC[CFG.updFreq] === undefined ? 'daily' : CFG.updFreq;
  $('sheetBody').innerHTML =
    '<div class="sh-title">检查更新</div>' +
    '<div class="sh-sub">当前版本 v' + esc(APP_VERSION) + ' · ' + updAgo(CFG.updLast) + '</div>' +
    '<div class="setrows">' +
      '<div class="setrow">' +
        '<span class="sk">自动检查更新</span>' +
        '<button class="switch' + (on ? ' on' : '') + '" id="updSw" role="switch" ' +
        'aria-checked="' + (on ? 'true' : 'false') + '" aria-label="自动检查更新"></button>' +
      '</div>' +
    '</div>' +
    '<div id="updFreqBox"' + (on ? '' : ' hidden') + '>' +
      '<div class="setlabel">多久查一次</div>' +
      '<div class="seg flat" id="updSeg">' +
        UPD_FREQ_LIST.map((k) =>
          '<button class="seg-btn' + (k === freq ? ' on' : '') + '" data-freq="' + k + '">' +
          UPD_FREQ_CN[k] + '</button>').join('') +
      '</div>' +
    '</div>' +
    '<div class="sheetbtns"><button class="btn primary" id="updNow">立即检查</button></div>' +
    '<p class="tip note" id="updTip"></p>';
  $('sheetMask').hidden = false;

  $('updSw').addEventListener('click', () => {
    CFG.updOn = !(CFG.updOn !== false);
    store.set(KEY.settings, CFG);
    openUpdateSheet();                 // 重画：频率那一块要跟着显示/隐藏
  });

  $('updSeg').querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      CFG.updFreq = b.dataset.freq;
      store.set(KEY.settings, CFG);
      $('updSeg').querySelectorAll('.seg-btn').forEach((x) => {
        x.classList.toggle('on', x.dataset.freq === CFG.updFreq);
      });
    });
  });

  $('updNow').addEventListener('click', async () => {
    const btn = $('updNow');
    if (btn.disabled) return;
    // 就地变成「正在检查…」，不关弹层：关掉再弹一个 toast 会压在按钮上，
    // 而且万一网络慢，用户会以为点了没反应。
    btn.disabled = true;
    btn.textContent = '正在检查…';
    $('updTip').textContent = '';
    const r = await checkUpdate(true);
    if (r.busy) return;
    // 有新版本时，showUpdateSheet 已经把这一整块换掉了 —— 这个按钮已经不在页面上，
    // 再改它的文字没有任何意义（也改不到）。
    if (r.ok && r.newer) return;
    const b2 = $('updNow');
    if (!b2) return;
    b2.disabled = false;
    b2.textContent = '立即检查';
    const tip = $('updTip');
    if (!tip) return;
    if (!r.ok) {
      tip.textContent = '检查失败：' + r.error;
      tip.classList.add('bad');
    } else {
      tip.classList.remove('bad');
      tip.textContent = '已经是最新版本 v' + APP_VERSION + ' · ' + updAgo(CFG.updLast);
      // 顺手把顶部那行「上次检查」也刷新一下
      const sub = document.querySelector('.sh-sub');
      if (sub) sub.textContent = '当前版本 v' + APP_VERSION + ' · ' + updAgo(CFG.updLast);
    }
  });
}

/** 打开 App 时按设置自动查一次。默认「每次打开」。 */
function autoCheckUpdate() {
  if (CFG.updOn === false) return;
  const gap = UPD_FREQ_SEC[CFG.updFreq];
  const sec = (gap === undefined) ? 0 : gap;
  if (sec > 0 && CFG.updLast && (Math.floor(Date.now() / 1000) - CFG.updLast) < sec) return;
  // 等首屏画完再查：别跟同步、跟首屏渲染抢带宽。
  setTimeout(() => { checkUpdate(false); }, 1500);
}

/* 弹层关掉的瞬间，把排队的新版本提示补上。
 *
 * 用 MutationObserver 盯 hidden 属性，而不是在每个关闭的地方加一句 ——
 * 关弹层的写法散在十几处（点遮罩、点按钮、安卓返回键……），
 * 漏一处就是「更新提示永远不会出现」，而且很难发现。
 */
new MutationObserver(() => {
  if (!$('sheetMask').hidden || !updPending) return;
  const info = updPending;
  updPending = null;
  // 等收起动画走完再弹，否则两张弹层会叠在一起
  setTimeout(() => { showUpdateSheet(info, true); }, 260);
}).observe($('sheetMask'), { attributes: true, attributeFilter: ['hidden'] });

// ------------------------------------------------------------------ 校历
/* 数据来源：学校发布的《2026–2027 学年校历》（外国语学院转载的公开页面
   https://wyx.zua.edu.cn/info/1051/8303.htm），关键日期逐条人工核对过。

   🔴 为什么写死在代码里，而不是每次去抓：
      ① 校历一个学年只变一次，天天去抓 364 天是白抓；
      ② 它是一张 3504×5096 的图片，没有结构化接口，抓回来也解析不出日期；
      ③ 抓不到的时候只能显示「没有校历」—— 把「没抓到」说成「没有」，
         正是红线 40 那种错。
      代价是每学年要改一次，所以只留 CAL_TERMS 一个入口。

   每周的起止是**算出来的**，不是抄的：第 1 周一定是周一
   （2026-09-07、2027-02-22 都核对过是星期一），第 n 周 = 开学 + (n-1)×7 天。
   拿它跟校历图上印的日期对过，19 周末正好是放假前一天。 */
const CAL_YEAR = '2026–2027';
const CAL_TERMS = [
  {
    name: '第一学期',
    start: '2026-09-07',        // 第 1 周的周一
    weeks: 19,
    holiday: { d: '2027-01-18', label: '寒假' },
    marks: [
      { d: '2026-09-05', e: '2026-09-06', t: '在校生、第二学士学位新生报到注册' },
      { d: '2026-09-07', t: '在校生开始上课' },
      { d: '2026-09-07', e: '2026-09-08', t: '新生（研究生、本科、专升本）报到注册' },
      { d: '2026-09-09', t: '专升本新生开始上课' },
      { d: '2026-09-14', t: '研究生新生开始上课' },
      { d: '2026-10-08', t: '本科新生开始上课' },
      // 这两条跨整学期，日期列改成「第几周」，比印两个日期好读
      { d: '2026-09-07', e: '2027-01-10', w: '1–18 周', t: '理论教学' },
      { d: '2027-01-11', e: '2027-01-17', w: '19 周', t: '考试周' },
      { d: '2027-01-18', t: '放寒假' },
    ],
  },
  {
    name: '第二学期',
    start: '2027-02-22',
    weeks: 19,
    holiday: { d: '2027-07-05', label: '暑假' },
    marks: [
      { d: '2027-02-22', e: '2027-02-23', t: '在校生报到注册' },
      { d: '2027-02-24', t: '开始上课' },
      { d: '2027-02-22', e: '2027-06-27', w: '1–18 周', t: '理论教学' },
      { d: '2027-06-28', e: '2027-07-04', w: '19 周', t: '考试周' },
      { d: '2027-07-05', t: '放暑假' },
    ],
  },
];

const calYmd = (d) => d.getFullYear() + '-' +
  String(d.getMonth() + 1).padStart(2, '0') + '-' +
  String(d.getDate()).padStart(2, '0');

/** 校历里哪个学期的日期条目是**收起**的（0.33.0）。
 *
 *  默认：当前学期展开、另一学期收起 —— 两学期全摊开是 14 条 = 721px，
 *  这一页可用只有 726（还要放头卡和脚注），必须滑。
 *
 *  `fold[i]` 存的是**用户手点之后的状态**（true=展开）。没点过就是
 *  `undefined`，回落到默认：当前学期展开、另一学期收起。
 *  存在内存里就够，这是「这一眼想不想看」，不是设置，没必要落盘。
 */
const CAL = { fold: {} };
const calMd = (d) => (d.getMonth() + 1) + '.' + d.getDate();

/** 某个学期在今天处于什么阶段。三种：没开学 / 学期中 / 已放假。 */
function calState(term, today) {
  const s = parseYmd(term.start);
  const last = addDays(s, term.weeks * 7 - 1);
  const diff = Math.round((today - s) / 86400000);
  if (diff < 0) return { phase: 'before', toStart: -diff, s: s, last: last };
  const week = Math.floor(diff / 7) + 1;
  if (week > term.weeks) return { phase: 'after', over: diff - (term.weeks * 7 - 1), s: s, last: last };
  return {
    phase: 'in', week: week, s: s, last: last,
    wStart: addDays(s, (week - 1) * 7),
    wEnd: addDays(s, (week - 1) * 7 + 6),
  };
}

/** 今天「最该看」的那个学期：学期中优先，其次下一个要开的，最后是刚结束的。 */
function calCurrent(today) {
  let before = null;
  for (let i = 0; i < CAL_TERMS.length; i++) {
    const st = calState(CAL_TERMS[i], today);
    if (st.phase === 'in') return { term: CAL_TERMS[i], st: st };
    if (st.phase === 'before' && !before) before = { term: CAL_TERMS[i], st: st };
  }
  if (before) return before;
  const lastTerm = CAL_TERMS[CAL_TERMS.length - 1];
  return { term: lastTerm, st: calState(lastTerm, today) };
}

function renderCalendar() {
  const today = today0();
  const cur = calCurrent(today);
  const term = cur.term;
  const st = cur.st;
  const curIdx = CAL_TERMS.indexOf(term);

  $('calLab').textContent = CAL_YEAR + ' 学年 · ' + term.name;

  const wk = $('calWeek');
  const rng = $('calRange');
  const fill = $('calFill');
  const find = $('calFind');

  if (st.phase === 'in') {
    wk.textContent = '第 ' + st.week + ' 周';
    rng.textContent = calMd(st.wStart) + ' – ' + calMd(st.wEnd);
    fill.style.width = Math.round((st.week / term.weeks) * 100) + '%';
    const left = term.weeks - st.week;
    const days = Math.round((parseYmd(term.holiday.d) - today) / 86400000);
    const parts = [];
    if (left <= 0) parts.push('本周就是考试周');
    else if (left === 1) parts.push('下周就是考试周');
    else parts.push('距考试周还有 ' + left + ' 周');
    if (days > 0) parts.push(term.holiday.label + '还有 ' + days + ' 天');
    find.textContent = parts.join(' · ');
  } else if (st.phase === 'before') {
    // 别把「还没开学」显示成「第 1 周」—— 那是拿一个假数字冒充事实
    wk.textContent = '还没开学';
    rng.textContent = calMd(st.s) + ' 开始';
    fill.style.width = '0%';
    find.textContent = '还有 ' + st.toStart + ' 天开学 · ' +
      term.name + '共 ' + term.weeks + ' 周';
  } else {
    wk.textContent = '已放假';
    rng.textContent = calMd(st.last) + ' 结束';
    fill.style.width = '100%';
    find.textContent = term.name + '已结束 ' + st.over + ' 天 · 下一学期见下方';
  }

  // 两个学期都列出来：在读的那个在前，另一个在后 —— 顺序跟着时间走，
  // 不因为「哪个是当前学期」而调换，否则用户每次都要重新找。
  //
  // 0.33.0：**非当前学期默认收起**（点标题展开）。
  // 两个学期全摊开是 14 条 = 721px，一页 933、可用只有 726 —— 必须滑。
  // 收起以后当前学期 9 条 + 两个学期头 = 约 490，一屏装得下。
  // 🔴 收起的那个学期只显示「几号到几号」，不显示任何日期条目 ——
  //    要看得点一下，这是用户自己的选择。
  let html = '';
  for (let i = 0; i < CAL_TERMS.length; i++) {
    const t = CAL_TERMS[i];
    const ts = calState(t, today);
    // 当前学期默认展开（除非用户点过收起），另一个默认收起。
    // 🔴 `CAL.fold[i]` 存的是「用户手点之后的状态」：一旦点过就以它为准，
    //    没点过才回落到默认。别拿「和默认反着来」当语义 —— 那样第一次点
    //    收起会变成「再点还是收起」（实测：第二个学期永远展不开）。
    const open = (CAL.fold[i] === undefined) ? (i === curIdx) : CAL.fold[i];
    html += '<button class="calsec tap" data-cali="' + i + '" aria-expanded="' +
      (open ? 'true' : 'false') + '">' +
      '<h2>' + esc(t.name) + '</h2>' +
      '<span>' + calMd(ts.s) + ' – ' + calMd(ts.last) + '</span>' +
      '<svg class="rowico calchev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' +
      '</button>';
    if (!open) continue;
    html += '<ul class="caltl">';
    // 「下一件事」只认**开始日期在今天或以后**的第一条。
    // 不能拿「结束日期」判 —— 理论教学那条跨整学期，用它判会一直霸占高亮。
    let marked = false;
    for (let j = 0; j < t.marks.length; j++) {
      const m = t.marks[j];
      const md = parseYmd(m.d);
      const me = m.e ? parseYmd(m.e) : md;
      let cls = '';
      if (me < today) cls = ' past';
      else if (!marked && md >= today) { cls = ' next'; marked = true; }
      const lab = m.w || (m.e && m.e !== m.d ? calMd(md) + '–' + calMd(me) : calMd(md));
      html += '<li class="' + cls.trim() + '"><span class="d">' + esc(lab) +
        '</span><span class="t">' + esc(m.t) + '</span></li>';
    }
    html += '</ul>';
  }
  $('calBody').innerHTML = html;
}

// ------------------------------------------------------------------ 校园（智慧门户）
/*
 * 这一页装的是**智慧门户**（rhmh.zua.edu.cn）的东西，跟教务系统是两套账号：
 *   · 密码不一样（实测自助服务 9 位、门户 10 位）
 *   · 登录要算一道**算术验证码**，而且**错 5 次锁号**
 *
 * 三条硬规矩：
 *   1. **绝不自动登录、绝不 OCR 验证码** —— 锁号是用户自己的损失，省那 5 秒不值。
 *   2. 连一次由用户自己输；之后靠 CASTGC（CAS 的「身份证」）静默换票，
 *      门票（customsid）过期也不用重输密码。实测 CASTGC 撑不过 7.2 小时，
 *      但只要在失效前用一次就会续期 —— 「偶尔打开一次」的人基本不会掉线。
 *   3. 过期就老实说「要重新登录」。🔴 **不许**把「没读到」显示成「没有数据」：
 *      余额读不到时显示「—」而不是「0.00 元」—— 后者会让人以为钱没了。
 */

/** 学习通的课程页。
 *
 *  为什么是「送过去」而不是「读回来」：它的作业/考试没有一次性拿全的接口，
 *  藏在每门课的 iframe 里，爬一轮 20 多次请求、15 秒起步；超星一改版就
 *  静默返回 0 条。一个「可能读不到」的提醒比没有提醒更危险。
 *  用系统浏览器打开，登录一次之后 cookie 长期有效，不用每次输密码。
 */
const CX_HOME = 'https://mooc2-ans.chaoxing.com/mooc2-ans/visit/interaction';

const CAMPUS = {
  state: null,     // null=还没问过 / 'none' 没连 / 'ok' 已连 / 'expired' 过期了
  user: '',
  saved: false,    // 本机存着门户密码 ⇒ 过期重登只需算一道验证码
  savedUser: '',   // 存的是哪个学号的密码（只回学号，密码永远不出后端）
  bal: null,       // null = 没读到（**不是 0 元**）
  rows: [],
  total: 0,
  apps: [],
  open: false,     // 明细展开着没有
  busy: false,
  at: 0,           // 这批数据是什么时候拿到的（unix 秒）。0 = 不知道
  fromCache: false,// 是不是从本机读出来的
};

/* ---------------- 校园页的本地缓存 ----------------
 *
 * 用户的原话：
 *   「一些不需要太强即时性的信息（比如消费记录）也存到本地，
 *     只有在看校园卡余额之类的需要即时更新的东西的时候才需要访问门户」
 *
 * 所以分两类：
 *   · **消费记录 / 办事入口** —— 几小时前的和现在的没有区别，存本机，
 *     进页面**一个门户请求都不打**。
 *   · **余额** —— 随时会变，必须联网。但「必须联网」不等于「进页面就联网」：
 *     进来先显示上次那个数并写明「更新于 X」，用户点刷新才真去问。
 *
 * 这样还有一个副作用，是更重要的：**门户过期不再是灾难**。
 * CASTGC 撑不过 7.2 小时（学校那边的硬限制，改不了），
 * 以前一过期整块内容就消失；现在过期只是「余额可能不准」，
 * 消费记录和 19 个办事入口照常能用。
 */
function cpCacheSave() {
  const at = CAMPUS.at || Math.floor(Date.now() / 1000);
  try {
    store.set(KEY.card, {
      user: CAMPUS.user, at: at, bal: CAMPUS.bal,
      rows: CAMPUS.rows, total: CAMPUS.total,
    });
    store.set(KEY.apps, { user: CAMPUS.user, at: at, apps: CAMPUS.apps });
  } catch (e) { /* 存不下不影响使用 */ }
}

/** 从本机读回来。**同一个学号才算数** —— 换人登录时必须重拿，
 *  否则会把上一个账号的消费记录摆给下一个人看。 */
function cpCacheLoad() {
  const c = store.get(KEY.card, null);
  const a = store.get(KEY.apps, null);
  let got = false;
  if (c && Array.isArray(c.rows) && (!c.user || !CAMPUS.user || c.user === CAMPUS.user)) {
    CAMPUS.bal = typeof c.bal === 'number' ? c.bal : null;
    CAMPUS.rows = c.rows;
    CAMPUS.total = c.total || 0;
    CAMPUS.at = c.at || 0;
    got = true;
  }
  if (a && Array.isArray(a.apps) && a.apps.length &&
      (!a.user || !CAMPUS.user || a.user === CAMPUS.user)) {
    CAMPUS.apps = a.apps;
    if (!CAMPUS.at) CAMPUS.at = a.at || 0;
    got = true;
  }
  CAMPUS.fromCache = got;
  return got;
}

/** 本机有没有能显示的东西（决定「过期」是整块藏起来、还是只加一条提示）。 */
function cpHasData() {
  return CAMPUS.rows.length > 0 || CAMPUS.apps.length > 0 || CAMPUS.bal != null;
}

/* ---------------- 消费小结（0.9.0）----------------
 *
 * 🔴 这个函数最难的地方不是算数，是**说清楚这份数据覆盖到哪儿**。
 *    门户那个接口一页 12 条、最多翻 3 页 ⇒ 手里只有最近 33 笔。
 *    这个月要是刷了 50 次，我们只看到 33 条；把「33 条里的合计」说成
 *    「本月一共」就是编数字。
 *
 *    判断办法：数据里**最早那一笔**早于本月 1 日 ⇒ 本月的记录从月初就有，
 *    统计是完整的；否则只能说「从 X 月 X 日算起」。
 *
 * 🔴 日均只在完整时给。被截断的时候连「这几天花了多少」都不知道，
 *    除出来的数只会误导人 —— 宁可不给。
 */
function yktYM(t) {
  const m = /^(\d{4})-(\d{2})/.exec(String(t || ''));
  return m ? m[1] + '-' + m[2] : '';
}

function yktStats() {
  // 只算支出。充值/补助是正数，混进「花了多少」里就全错了。
  const all = (Array.isArray(CAMPUS.rows) ? CAMPUS.rows : [])
    .filter((r) => r && r.time && Number(r.amount) < 0);
  if (!all.length) return { empty: true };

  const now = new Date();
  const ym = now.getFullYear() + '-' + pad2(now.getMonth() + 1);
  const month = all.filter((r) => yktYM(r.time) === ym);
  if (!month.length) return { empty: true };

  let total = 0;
  let maxRow = month[0];
  const byPlace = {};
  month.forEach((r) => {
    const a = Number(r.amount);
    total += -a;
    if (a < Number(maxRow.amount)) maxRow = r;
    const p = String(r.place || '').trim();
    if (p) byPlace[p] = (byPlace[p] || 0) + 1;
  });

  const earliest = all.reduce((a, b) => (String(b.time) < String(a.time) ? b : a), all[0]);
  const full = String(earliest.time).slice(0, 7) < ym;
  const day = now.getDate();

  let topPlace = '';
  let topN = 0;
  Object.keys(byPlace).forEach((p) => {
    if (byPlace[p] > topN) { topN = byPlace[p]; topPlace = p; }
  });

  return {
    empty: false,
    full: full,
    count: month.length,
    total: total,
    avg: full && day > 0 ? total / day : 0,
    // 只去过一次不算「常去」，说了等于没说
    topPlace: topN >= 2 ? topPlace : '',
    topN: topN,
    maxAmt: -Number(maxRow.amount),
    maxPlace: String(maxRow.place || ''),
    since: String(earliest.time).slice(5, 10),
  };
}

function renderCampus() {
  // 🔴 关键：有没有数据，和「门户通不通」是两件事。
  //    以前只按 state 判断，于是门户一过期就把数据也藏了。
  const hasData = cpHasData();
  const on = CAMPUS.state === 'ok';
  const expired = CAMPUS.state === 'expired';
  const show = on || (expired && hasData);

  $('cpOff').hidden = show;
  $('cpOn').hidden = !show;
  $('cpExpired').hidden = !(expired && hasData);

  // 连上了、手里却一条数据都没有（典型情况：刚点过「清除本机缓存」）
  // ⇒ 进这一页时自己去取一次。否则会留一个「余额 —、没有明细」的空壳，
  //   而且因为 state 还是 'ok'，它再也不会自己取。
  // 🔴 只在页面可见时取：清缓存那一刻页面是藏着的（在「我的」里点），
  //    那时候取等于立刻把缓存写回去，「清除」就成了摆设。
  //    busy 判断是防重入 —— loadCampus 一进来就把它置 true，不会打两遍。
  if (CUR_PAGE === 'campus' && on && !hasData && !CAMPUS.busy) loadCampus(false);

  if (!show) {
    $('cpOff').querySelector('h2').textContent = expired ? '门户登录过期了' : '连接智慧门户';
    $('cpConnect').textContent = expired ? '重新连接' : '连接门户';
    // 存着密码就把话说准：这一步到底要人做什么，别让人以为还得翻密码本
    $('cpNote').textContent = expired
      ? (CAMPUS.saved
        ? '门户登录会过期。密码还存着，重新连一次只要算一道验证码，数据不会丢。'
        : '门户登录会过期。重新输一次密码和验证码就能继续用，数据不会丢。')
      : (CAMPUS.saved
        ? '数据来自学校智慧门户，只做读取，不会提交任何申请、不会代替你操作。上次用过的密码还存着，连一次只要算一道验证码。'
        : '数据来自学校智慧门户，只做读取，不会提交任何申请、不会代替你操作。');
    // 第一次进来才去问状态：每切一次 tab 就打一次服务器属于白打
    if (CAMPUS.state === null) loadCampus(false);
    return;
  }

  if (expired && hasData) {
    $('cpExpiredTxt').textContent = (CAMPUS.at
      ? '这份数据是' + agoText(CAMPUS.at) + '拿到的，余额可能已经不是这个数了。'
      : '下面是上次拿到的数据，余额可能已经不是这个数了。')
      + (CAMPUS.saved ? '重新连接只要算一道验证码。' : '');
  }

  $('yktBal').textContent = CAMPUS.bal == null ? '—' : CAMPUS.bal.toFixed(2);
  $('yktTime').textContent = CAMPUS.user || '';
  const st = yktStats();
  // 右侧那格原来是「共 33 笔」—— 那是「手里有几条」，不是「这个月花了多少」。
  // 换成本月小结（明细条数在展开后还在，不丢信息）。
  // ⚠️ 不完整时**不写「本月」**：只看到最近 33 笔，说「本月」就是编。
  $('yktCount').textContent = st.empty
    ? (CAMPUS.total ? '共 ' + CAMPUS.total + ' 笔' : '')
    : ((st.full ? '本月 ' : '') + '¥' + st.total.toFixed(2));
  // 余额提醒那一行的说明。关掉时说「已关闭」，别让人以为还是默认的 20 元。
  // 它和下面那条常驻提示是同一件事的两种形态：一个是开关，一个是结果。
  const alv = Number(CFG.alertLow) > 0 ? Number(CFG.alertLow) : 20;
  $('yktAlertV').textContent = CFG.alertOn
    ? '低于 ' + alv + ' 元时提醒'
    : '已关闭';
  // 余额低：常驻一条，不弹窗。没读到余额（null）时什么都不说 ——
  // 「没读到」不等于「没钱了」。
  const thr = Number(CFG.alertLow);
  const low = !!CFG.alertOn && CAMPUS.bal != null && thr > 0 && CAMPUS.bal < thr;
  $('yktLow').hidden = !low;
  if (low) {
    $('yktLow').innerHTML = '余额只剩 <b>' + CAMPUS.bal.toFixed(2) +
      '</b> 元了，记得充值。';
  }
  // 余额是会变的数字。没在这一次连网刷新过，就必须标明它是什么时候的。
  $('yktAt').hidden = !(CAMPUS.at && CAMPUS.fromCache);
  if (!$('yktAt').hidden) {
    $('yktAt').textContent = '余额更新于 ' + agoText(CAMPUS.at) + '，点右上角刷新';
  }

  $('yktList').hidden = !CAMPUS.open;
  if (CAMPUS.open) {
    if (!CAMPUS.rows.length) {
      $('yktList').innerHTML = '<p class="sub small">这次没读到消费记录。</p>';
    } else {
      let head = '';
      if (!st.empty) {
        head = '<div class="ykt-stat">' +
          '<div class="ykt-s1"><b>¥' + st.total.toFixed(2) + '</b><span>' +
          (st.full
            ? '本月 ' + st.count + ' 笔 · 日均 ¥' + st.avg.toFixed(2)
            : st.since + ' 起 ' + st.count + ' 笔') +
          '</span></div>';
        const bits = [];
        if (st.topPlace) {
          bits.push('常去 ' + esc(st.topPlace) + '（' + st.topN + ' 次）');
        }
        if (st.maxAmt > 0) {
          bits.push('最大一笔 <em>¥' + st.maxAmt.toFixed(2) + '</em>' +
            (st.maxPlace ? '（' + esc(st.maxPlace) + '）' : ''));
        }
        if (bits.length) head += '<div class="ykt-s2">' + bits.join(' · ') + '</div>';
        if (!st.full) {
          // 说的是「手里一共几条记录」，不是「几条支出」—— 别把两个数混了
          head += '<div class="ykt-note">门户只给最近 ' + CAMPUS.rows.length + ' 笔，' +
            st.since + ' 之前的没算进来。</div>';
        }
        head += '</div>';
      }
      $('yktList').innerHTML = head + CAMPUS.rows.map((r) => {
        const amt = Number(r.amount) || 0;
        return '<div class="ykt-row">' +
          '<div class="ykt-r1"><span class="ykt-place">' + esc(r.place || '—') + '</span>' +
          '<b class="ykt-amt ' + (amt < 0 ? 'out' : 'in') + '">' +
          (amt > 0 ? '+' : '') + amt.toFixed(2) + '</b></div>' +
          '<div class="ykt-r2">' + esc(r.time || '') +
          (r.kind ? ' · ' + esc(r.kind) : '') + '</div>' +
          '</div>';
      }).join('');
    }
  }

  if (!CAMPUS.apps.length) {
    $('cpApps').innerHTML = '<p class="sub small">这次没读到应用列表。</p>';
    // 「没读到」和「一个都没有」要分开说（红线 58），所以这里不写 0 个。
    $('cpAppsN').textContent = '没读到';
  } else {
    $('cpAppsN').textContent = CAMPUS.apps.length + ' 个';
    $('cpApps').innerHTML = CAMPUS.apps.map((a) =>
      '<button class="appitem" data-url="' + escAttr(a.url || '') +
      '" data-name="' + escAttr(a.name || '') + '">' +
      '<span class="appname">' + esc(a.name || '') + '</span>' +
      '<span class="appdept">' + esc(a.dept || '') + '</span>' +
      '</button>').join('');
    $('cpApps').querySelectorAll('.appitem').forEach((b) => {
      b.addEventListener('click', async () => {
        // 🔴 0.17.3：这里以前把 openApp 的返回值丢掉了 —— 于是两种失败都不出声：
        //    ① 退到系统浏览器（用户以为「又要重登」是设计如此）
        //    ② 两条路都不通（用户看到「点了没反应」）
        // 现在降级和失败都各说一句，而且带上原生给的原因。
        // 🔴 0.17.4：改成**先换票再开**（见 openService）。只搬 cookie 不够 ——
        //    APK 的登录根本不产生 CASTGC 那张 cookie，所以进门必然是 CAS 登录页。
        let ok = false;
        try {
          ok = await openService(b.dataset.url, b.dataset.name);
        } catch (e) {
          toast('打不开这个入口（' + ((e && e.message) || e) + '）');
          return;
        }
        if (!ok) {
          toast('打不开这个入口（' + OPEN_WHY + '），可以复制链接到浏览器里打开');
        } else if (OPEN_WHY !== 'app') {
          toast('这次没能在 App 内打开（' + OPEN_WHY + '），已交给浏览器');
        }
      });
    });
  }
}

/** 取校园页数据。
 *
 *  `force = false`（默认，进页面/开机走这条）：
 *      只问一次本地状态（不探网），本机有缓存就直接画，**一个门户请求都不打**。
 *  `force = true`（用户点右上角刷新 / 重新连接后走这条）：
 *      真去门户取一次，取到就更新缓存。
 *
 *  🔴 为什么默认不联网：门户的 CASTGC 撑不过 7.2 小时，用户一天要撞上好几次
 *     「门票过期」。如果每次进页面都硬取，那就是每次都要输密码+验证码 ——
 *     而消费记录和办事入口其实几小时前的完全够用。
 */
async function loadCampus(force) {
  if (CAMPUS.busy) return;
  CAMPUS.busy = true;
  try {
    const st = await api('/api/portal/status');
    CAMPUS.state = st.ok ? (st.state || 'ok') : 'none';
    CAMPUS.user = st.user || '';
    // 本机存着门户密码吗？（只回「存的是哪个学号」，密码永远不出后端）
    // 有了它，过期重登就只剩一道算术验证码要人算。
    CAMPUS.saved = !!st.saved;
    CAMPUS.savedUser = String(st.savedUser || '');
    // 'none' = 本机根本没存过门户会话（从没连过 / 断开了）。
    // 这时候**不许**拿缓存顶上 —— 缓存是「这个账号的数据」，
    // 而这时连「是不是同一个人」都无从判断。
    if (CAMPUS.state === 'none') { renderCampus(); return; }

    // 本机有缓存就先画出来，不管门户现在通不通。
    // 🔴 这一步必须在「state 判断」之后、联网之前：过期时也要能显示旧数据。
    const had = cpCacheLoad();

    // 缓存优先：不是「用户主动刷新」就到此为止，**一个门户请求都不打**。
    if (!force && had) { renderCampus(); return; }

    // 一卡通和应用列表并行拉。**任何一个失败都不许拖垮另一个** ——
    // 应用列表挂了也还能看余额，反过来也一样。
    const [card, apps] = await Promise.all([
      api('/api/portal/card').catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
      api('/api/portal/apps').catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
    ]);
    let fresh = false;
    if (card && card.ok) {
      CAMPUS.bal = typeof card.balance === 'number' ? card.balance : null;
      CAMPUS.rows = card.rows || [];
      CAMPUS.total = card.total || 0;
      fresh = true;
    } else if (card && card.needLogin) {
      CAMPUS.state = 'expired';
    }
    if (apps && apps.ok) { CAMPUS.apps = apps.apps || []; fresh = true; }
    if (apps && apps.needLogin) CAMPUS.state = 'expired';

    if (fresh) {
      CAMPUS.at = Math.floor(Date.now() / 1000);
      CAMPUS.fromCache = false;
      cpCacheSave();
    } else if (!cpHasData()) {
      // 一样都没拿到、本机又是空的 ⇒ 让用户看到失败，而不是一片空白
      const why = (card && card.error) || (apps && apps.error) || '没取到数据';
      toast('校园数据没读上来：' + why, 3500);
    }
    renderCampus();
  } catch (e) {
    toast('校园数据没读上来：' + ((e && e.message) || e), 3500);
    renderCampus();
  } finally {
    CAMPUS.busy = false;
  }
}

/* 连接门户的弹层。
 *
 * 🔴 0.8.0 起这里多了一种形态：**本机存着密码时，密码那一行变成一个按钮**
 *    （「已保存 · 点这里改成手动输入」），人只需要算一道验证码。
 *    为什么值得：门户那张身份证撑不过 7.2 小时，一天要撞好几次过期；
 *    每撞一次就要翻密码本的话，这个功能基本没法用。
 *
 * 🔴 密码**不回显**：/api/portal/status 只告诉我们「存的是哪个学号」，
 *    密码留在后端 / 原生层。所以这里只有「用」和「不用」两个状态，没有第三个。
 */
async function openPortalSheet() {
  // 进弹层前先问一次本机状态：存过密码吗？存的是哪个学号？
  // 问不到就按「没存」处理 —— 绝不假装有（那样用户会卡在一个填不了密码的框里）。
  let saved = CAMPUS.saved;
  let savedUser = CAMPUS.savedUser;
  let pwdState = '';          // none / ok / broken（空串 = 这个壳没这能力）
  try {
    const st = await api('/api/portal/status');
    if (st && st.ok) {
      saved = !!st.saved;
      savedUser = String(st.savedUser || '');
      pwdState = String(st.pwdState || '');
      CAMPUS.saved = saved;
      CAMPUS.savedUser = savedUser;
    }
  } catch (e) { /* 用已知的那份，别让弹层打不开 */ }

  let savedMode = saved;                 // 现在是不是「用存着的密码」
  const preUser = savedUser || CAMPUS.user || '';

  const passHtml = saved
    ? '<div class="field"><span>密码</span>' +
      '<button type="button" class="savedpw" id="pfPassBtn">' +
      '<b>已保存</b><i>点这里改成手动输入</i></button></div>'
    : '<label class="field"><span>密码</span><span class="pwdbox">' +
      '<input id="pfPass" type="password" autocomplete="current-password" ' +
      'placeholder="智慧门户密码">' + pwdEyeHtml('pfPass') + '</span></label>';

  // 「存着但解不开」必须单独说一句。
  // 不说的话，用户看到密码框只会得出一个结论：「它根本没记住密码」——
  // 而真相是存过、但系统把密钥重置了。两种情况该给的话不一样。
  const pwdWarn = (pwdState === 'broken')
    ? '<p class="tip warn">存着的门户密码读不出来了（换过手机、系统升级或清过 App 数据会这样）。' +
      '再输一次就会重新记住。</p>'
    : '';

  $('sheetBody').innerHTML =
    '<div class="sh-title">连接智慧门户</div>' +
    '<div class="sh-sub">门户密码和教务处不是同一套。验证码是一道算术题，算出结果填进去。</div>' +
    '<label class="field"><span>学号</span>' +
    '<input id="pfUser" type="text" inputmode="numeric" autocomplete="username" ' +
    'placeholder="学号" value="' + escAttr(preUser) + '"></label>' +
    passHtml +
    pwdHelpHtml('portal') +
    pwdWarn +
    '<label class="field"><span>验证码</span>' +
    '<div class="caprow">' +
    '<input id="pfCode" type="text" inputmode="numeric" placeholder="算出结果">' +
    '<img id="pfCap" class="capimg" alt="验证码" title="点一下换一张">' +
    '</div></label>' +
    '<div class="sheetbtns"><button class="btn primary" id="pfGo">连接</button></div>' +
    '<p class="tip" id="pfTip"></p>';
  $('sheetMask').hidden = false;

  const tip = (s) => { $('pfTip').textContent = s || ''; };

  /** 从「已保存」切到手动输入。`why` 非空就同时提示一句原因。 */
  const toManual = (why) => {
    if (!savedMode) return;
    savedMode = false;
    const btn = $('pfPassBtn');
    if (btn) {
      const box = btn.parentNode;
      box.innerHTML = '<span>密码</span><span class="pwdbox">' +
        '<input id="pfPass" type="password" autocomplete="current-password" ' +
        'placeholder="智慧门户密码">' + pwdEyeHtml('pfPass') + '</span>';
      const el = $('pfPass');
      if (el) el.focus();
    }
    if (why) tip(why);
  };
  if ($('pfPassBtn')) $('pfPassBtn').addEventListener('click', () => toManual(''));

  const loadCap = async () => {
    $('pfCap').removeAttribute('src');
    try {
      const r = await api('/api/portal/captcha');
      if (r.ok && r.img) $('pfCap').src = r.img;
      else tip(r.error || '拿不到验证码');
    } catch (e) { tip('拿不到验证码：' + ((e && e.message) || e)); }
  };
  $('pfCap').addEventListener('click', loadCap);
  loadCap();

  $('pfGo').addEventListener('click', async () => {
    const user = $('pfUser').value.trim();
    // 空串 = 让后端用本机存着的那份（见 bridge.py / native.js 的 portal/login）
    const pass = $('pfPass') ? $('pfPass').value : '';
    const code = $('pfCode').value.trim();
    if (!user) { tip('学号要填'); return; }
    if (!pass && !savedMode) { tip('密码要填'); return; }
    if (!code) { tip('还没算验证码'); return; }
    $('pfGo').disabled = true;
    tip('正在登录…');
    try {
      const r = await api('/api/portal/login', { user: user, pass: pass, code: code });
      if (r.ok) {
        $('sheetMask').hidden = true;
        CAMPUS.state = 'ok';
        CAMPUS.user = r.user || '';
        // 登录成功后后端/原生会顺手把密码存下来，但**可能失败**。
        // 🔴 存不上就不许喊「已保存」—— 否则下次又白输一遍，
        //    用户还以为是自己记错了。这里如实说，并给出原因。
        const sv = String(r.pwdSave == null ? '' : r.pwdSave);
        const bad = sv.indexOf('fail') === 0;
        CAMPUS.saved = !bad;
        CAMPUS.savedUser = bad ? '' : user;
        if (bad) {
          toast('已连接门户，但密码没存住：' + sv.replace(/^fail:\s*/, ''));
        } else if (sv === 'soft') {
          toast('已连接门户（密码用的是备用加密方式存的）');
        } else {
          toast('已连接门户');
        }
        // 🔴 必须 force：刚登完就要看新的。走缓存优先的话，
        //    重新连接之后屏幕上还是上一次那个余额，等于白登。
        await loadCampus(true);
      } else {
        tip(r.error || '登录失败');
        // 后端说「存着的那份密码不对，已经删了」⇒ 立刻切成手输，
        // 否则用户再点一次还是用同一个错密码，撞满 5 次号就锁了。
        if (r.pwdStale) { CAMPUS.saved = false; CAMPUS.savedUser = ''; toManual(''); }
        // 🔴 验证码是一次性的，失败后一定换一张。不换的话用户再点一次
        //    必然还是错 —— 而门户错 5 次就锁号。
        loadCap();
        $('pfCode').value = '';
      }
    } catch (e) {
      tip('登录出错：' + ((e && e.message) || e));
    } finally {
      $('pfGo').disabled = false;
    }
  });
}

/* 在 App 内打开一个外链。办事入口、公告原文、百科、忘记密码全走这里。
 *
 * 三条路，差别只在「cookie 罐子」：
 *   - APK（0.6.0 起）：走 NativeApi.openWeb → App 内的 WebActivity。
 *     那边会把门户的 cookie（含 CASTGC 这张「身份证」）倒进 WebView 的罐子，
 *     所以 CAS 认得出你是谁，**点一下直接进，不用再登**。
 *   - APK 但窗口起不来（老版本没这能力 / 起 Activity 失败）：退回
 *     openExternal，也就是系统浏览器。那边是第三个 cookie 罐子，门户的登录态
 *     不在里面，第一次进去要再登一次 —— 但**点了必须有反应**，
 *     宁可多登一次也不能静默失败。
 *   - 网页版：openExternal 退成新标签页。
 *
 * 🔴 返回 true = 交出去了；false = 三条路都不通，**调用方负责说一句话**。
 *    （以前这里返回 undefined，而且兜底是裸 `window.open` —— 在 APK 里
 *      会被 MainActivity 拦掉，于是「点了没反应且不报错」。）
 *
 * 🔴 第三个参数 `warn`（默认 true）：这个地址「本来就要登录」吗。
 *    false 用于公开页（公告正文、郑航百科）—— 那边没有 CASTGC 也照样能看，
 *    不该弹「门户登录已过期」。办事入口必须留默认值 true。
 *
 * 🔴 界面上那句说明是**两套文案**（index.html 的 data-app / 默认值）。
 *    网页版不许写「不用再登」—— 那是假的，用户一点就发现被骗了。
 */
/* 上一次 openApp 走了哪条路：'app' = App 内打开了；别的是降级/失败的原因。
 *
 * 🔴 为什么要记这个（0.17.3）：以前「App 内起不来 ⇒ 退回系统浏览器」是**静默**的。
 *    用户看到的是「跳浏览器 + 又要重新登录」，而 App 一声不响 —— 既像功能没做，
 *    又拿不到任何线索。有了这个字段，界面能把原因说出来，
 *    用户也能一眼告诉我们断在哪一步（'none' / 'fail: xxx' / '→ 浏览器'）。
 */
let OPEN_WHY = '';

function openApp(url, name, warn) {
  OPEN_WHY = '';
  if (!url) { OPEN_WHY = '没有地址'; return false; }
  if (NATIVE && window.NativeApi && typeof NativeApi.openWeb === 'function') {
    let why = 'none';
    try { why = NativeApi.openWeb(url, name || '', warn !== false); }
    catch (e) { why = 'fail: ' + ((e && e.message) || e); }
    if (why === '') { OPEN_WHY = 'app'; return true; }   // 窗口开出来了，收工
    // 'none' = 老 APK 没这能力；'fail: xxx' = 起不来。两种都往下退。
    OPEN_WHY = why;
  }
  if (openExternal(url)) { OPEN_WHY += ' → 浏览器'; return true; }
  return false;
}

/** 打开一个**办事系统**：先换票，再开。
 *
 * ================================================================
 * 为什么不能直接 openApp（2026-10-27 真机截图）
 * ================================================================
 * 用户点「学生信息管理」，App 内确实打开了 —— 但落在统一身份认证的登录页，
 * 底下还弹着「门户登录已过期」。真相不是过期：
 *
 *   APK 的登录走 CAS REST（POST /v1/tickets），服务端把 TGT 放在**响应体**里，
 *   **不会下发 CASTGC 这张 cookie**。而 WebActivity 判断「有没有登录态」
 *   看的偏偏就是 CASTGC ⇒ 永远判成过期 ⇒ 每次点都弹那句假话，
 *   而且「把 cookie 倒进 WebView」这条路在 APK 上根本不成立（罐子里没这张）。
 *
 * 正确做法：拿手上的 TGT 换一张**以这个系统地址为 service** 的票，
 * 拼在地址后面打开。办事系统自己拿票去 CAS 验，验过就是登录态 ——
 * 这条路不经过任何 cookie，所以不受「两个罐子」影响。
 *
 * ⚠️ 换不到票时**不能假装成功**：照旧打开原地址（用户至少能手动登），
 *    并且说清楚是哪一种失败。三种原因对用户是三种不同的动作：
 *      过期  → 去「账号管理」重新连一次
 *      没凭据 → 同上
 *      网络  → 换个网再试，别急着重登（重登要算验证码，还耗错误次数）
 */
async function openService(url, name) {
  if (!url) { OPEN_WHY = '没有地址'; return false; }
  let target = url;
  let ticketWhy = '';
  let haveTicket = false;
  // 🔴 票只能拼在 query 里，而且必须在 `#` 之前。
  //    拼到 `#` 后面会变成 fragment，**根本不会发给服务器**，票就等于丢了；
  //    而 CAS 校验的是「实际访问的 URL」，票丢了就退回登录页 ——
  //    表现和「没换票」一模一样，很难看出是拼串拼错了。
  //    service 也传去掉 fragment 的那一段：CAS 比对时不带 fragment。
  const hashAt = url.indexOf('#');
  const svc = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const frag = hashAt >= 0 ? url.slice(hashAt) : '';
  try {
    const r = await api('/api/portal/ticket?service=' + encodeURIComponent(svc));
    if (r && r.ok && r.ticket) {
      target = svc + (svc.indexOf('?') >= 0 ? '&' : '?') +
               'ticket=' + encodeURIComponent(r.ticket) + frag;
      haveTicket = true;
    } else {
      // 网页版走 bridge：那边失败时给的是 needLogin + error（没有 why）。
      ticketWhy = (r && r.needLogin) ? 'expired'
        : String((r && (r.why || r.error)) || 'unknown');
    }
  } catch (e) {
    ticketWhy = 'net';
  }
  // 有票 ⇒ 里面一定是登录态，别再让原生弹「登录已过期」（warn=false）。
  const ok = openApp(target, name, !haveTicket);
  if (!ok) return false;
  if (haveTicket) return true;
  // 没换到票：打开是打开了，但要如实说一句，否则用户以为是「设计如此」。
  // 🔴 三种原因对应**三种不同的动作**，不能合并成一句「登录过期了」：
  //      no-tgt  —— 本机一条门户凭据都没有（没连过 / 刚断开）⇒ 进去登一次就好
  //      expired —— 有凭据，服务端不认了（约 7 小时闲到过期）⇒ 同上，但要知道是时间到了
  //      net     —— 连不上门户 ⇒ 换个网再试，**别急着重登**（重登要算验证码，
  //                 还消耗错误次数）
  //    括号里那个英文码是给排查用的：用户截图一发，就知道断在哪一条分支。
  // 🔴 括号里的技术码（net / no-tgt / expired）只留给日志，不给人看
  //    （2026-11-01）：用户既分不清这几样，也不会因此做不同的事 —— 都要手动登一次。
  if (ticketWhy === 'net') {
    toast('这次没连上学校门户，进去可能要手动登一次', 5000);
  } else if (ticketWhy === 'no-tgt') {
    toast('需要手动登录一次门户', 6000);
  } else if (ticketWhy === 'expired') {
    toast('门户登录过期了，进去重登一次就行', 6000);
  } else {
    console.warn('[portal] 自动登录失败：' + ticketWhy);
    toast('这次没能自动登录，进去可能要手动登一次', 6000);
  }
  return true;
}

$('cpConnect').addEventListener('click', openPortalSheet);
$('cpReconnect').addEventListener('click', openPortalSheet);
// 右上角刷新 = 用户明确要求「现在就去门户看一眼」，这时候必须联网。
// 以前这里把 state 清成 null 再调 loadCampus()，现在 state 的含义变了
// （它同时决定「数据显不显示」），不能随便清。
$('cpRefresh').addEventListener('click', () => {
  if (CAMPUS.busy) return;
  $('cpRefresh').classList.add('busy');
  // 这一页有两块数据：门户（一卡通 / 办事）和慧生活（余额 / 设备 / 积分）。
  // 用户点刷新是想「现在就看最新的」，只刷一半会让人以为另一半不会更新。
  const jobs = [loadCampus(true).catch(() => {})];
  if (WT.accounts.device || WT.accounts.score) {
    jobs.push(wtRefreshAll().catch(() => {}));
  }
  Promise.all(jobs).finally(() => $('cpRefresh').classList.remove('busy'));
});
$('yktMore').addEventListener('click', () => {
  CAMPUS.open = !CAMPUS.open;
  renderCampus();
});
/* 断开门户。同样抽成具名函数给「账号管理」页复用。 */
async function unbindPortal() {
  if (!(await askConfirm('断开门户？',
    '断开后一卡通余额和办事入口都看不到了，存着的密码也会删掉，下次要重新输一遍。',
    '断开'))) return;
  try { await api('/api/portal/logout', {}); } catch (e) { /* 本地断开就够了 */ }
  CAMPUS.state = 'none'; CAMPUS.bal = null; CAMPUS.rows = []; CAMPUS.apps = [];
  CAMPUS.open = false; CAMPUS.at = 0; CAMPUS.fromCache = false;
  // 密码也跟着没了（后端 logout 会连密码一起删）—— 界面上的标记必须同步，
  // 否则下次进来还会说「只要算一道验证码」，点进去却要填密码。
  CAMPUS.saved = false; CAMPUS.savedUser = '';
  // 🔴 缓存必须一起清。不清的话下次连上别人的账号，
  //    会在「拿到新数据之前」先闪一下上一个人的消费记录。
  store.del(KEY.card);
  store.del(KEY.apps);
  renderCampus();
  renderAccounts();
}
// 0.39.1：`#cpUnbind`（校园页那张「断开门户」整行）已删，入口统一到
// 「我的 → 账号管理 → 智慧门户 → 断开」，调的还是这个 unbindPortal。

// --------------------------------------------------- 密码框：显示密码 / 找回密码
//
// 用户 2026-10-22：「很多时候用户可能忘记了密码，再去找官网改密码之类的很麻烦」
// +「在输入密码的密码框右侧加个显示密码的按键吧」。
//
// 🔴 三个找回地址都是**当天实测打开过的**，别凭印象改：
//      · 教务 `/eams/resetPassword.action` —— 正方 EAMS 的密码重置，
//        页面只有「账号所用邮箱」一个框。**没在教务里绑过邮箱就用不了**，
//        所以文案不能写成「一定能自助找回」。
//      · 学习通 `fid=1286` —— 郑航的学校 id，跟抓作业用的是同一个。
//      · 门户 `/aqzx/#/password/passwordFound` —— 统一身份认证的安全中心，
//        要 学号 + 姓名 + 身份证号 + 验证码。它自己写着：不行就找辅导员，
//        或者带证件去信息管理中心（0371-61912710）。
//   写错的代价比不给还大：点开一个 404，用户会以为整个 App 坏了。

const PWD_HELP = {
  jw: { name: '教务系统',
        url: 'http://jwglxt.zua.edu.cn/eams/resetPassword.action' },
  cx: { name: '学习通',
        url: 'https://passport2.chaoxing.com/pwd/findpwd?version=1&fid=1286' },
  portal: { name: '智慧门户',
            url: 'https://sfrz.zua.edu.cn/aqzx/#/password/passwordFound' },
};

/** 「显示密码」眼睛按钮。`id` 是要切换的那个输入框。
 *  图标走 index.html 顶部的 <symbol> 精灵表 —— 静态两处、动态两处共用一份。 */
function pwdEyeHtml(id) {
  return '<button type="button" class="pweye" data-for="' + escAttr(id) + '" ' +
    'aria-label="显示密码" aria-pressed="false">' +
    '<svg class="eye-on"><use href="#i-eye"/></svg>' +
    '<svg class="eye-off"><use href="#i-eye-off"/></svg></button>';
}

/** 密码框下面那行「忘记密码」。`sys` 是 PWD_HELP 的键。 */
function pwdHelpHtml(sys) {
  const h = PWD_HELP[sys];
  if (!h) return '';
  return '<button type="button" class="pwdlost" data-pwdhelp="' + escAttr(sys) +
    '">忘记密码？去' + escAttr(h.name) + '重置</button>';
}

/** 切换明文/密文。
 *
 *  ⚠️ 改 `type` 之后光标会跑到末尾，有的内核（老 Safari）还会直接丢焦点。
 *     两个都补一下 —— 用户正在打字时按到眼睛，回来必须还在原来位置附近。 */
function togglePwdEye(btn) {
  const input = document.getElementById(btn.getAttribute('data-for') || '');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  try {
    input.focus();
    const n = input.value.length;
    input.setSelectionRange(n, n);
  } catch (e) { /* 不支持就算了，别为了光标位置报错 */ }
}

/** 委托到 document，不挂在按钮上。
 *
 *  🔴 学习通的密码框和学习页一起被 innerHTML 重画（切 tab、重新检查都会换掉），
 *     门户弹层里那个在「已保存 → 手动输入」时也会被换掉。
 *     挨个 addEventListener 的话，重画一次就少一个能用的按钮，而且不报错。 */
document.addEventListener('click', (e) => {
  const eye = e.target.closest ? e.target.closest('.pweye') : null;
  if (eye) {
    // 按钮在 <label class="field"> 里，不拦的话 label 会把点击转发给输入框
    e.preventDefault();
    e.stopPropagation();
    togglePwdEye(eye);
    return;
  }
  const lost = e.target.closest ? e.target.closest('.pwdlost') : null;
  if (lost) {
    e.preventDefault();
    e.stopPropagation();
    const h = PWD_HELP[lost.getAttribute('data-pwdhelp') || ''];
    if (!h) return;
    // 0.17.3 起在 App 内打开：jwglxt / sfrz 都在学校域名下，门户连着就直接进。
    // 以前交给系统浏览器 —— 那是第三个 cookie 罐子，找回密码页先让你登一次，
    // 而用户点「忘记密码」的原因恰恰是登不进去。
    // 兜底仍是系统浏览器（openApp 内部），网页版退成新标签页。
    if (!openApp(h.url, '找回密码')) {
      toast('打不开，可以复制这个地址手动打开：' + h.url, 6000);
    }
  }
});

// ------------------------------------------------------------------ 启动

async function boot() {
  // APK 内置了数据层，不需要电脑给的那个 ?k= 凭证
  if (!TOKEN && !NATIVE) {
    toast('没有访问凭证：请用电脑上启动窗口给的地址打开', 5000);
  }
  // 老版本存的默认开学日期比真实开学早一周（见 migrateStartDate），先修再画
  if (DATA && migrateStartDate(DATA.semester)) store.set(KEY.settings, CFG);
  applyEnvTexts();
  renderExamView();
  renderSchedule(); renderGrades(); renderExams(); renderRooms(); renderMe();
  renderCalendar();                          // 纯本地算，零成本，开机就画好
  // 校历的学期头可点（0.33.0）。#calBody 这个元素本身不随重画换掉
  // （换的只是 innerHTML），所以挂一次就够 —— 挂在里面会越积越多。
  $('calBody').addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('.calsec') : null;
    if (!b) return;
    const i = Number(b.dataset.cali);
    // 点一下就翻转。以**界面上现在是什么状态**为准，不猜默认值。
    CAL.fold[i] = b.getAttribute('aria-expanded') !== 'true';
    renderCalendar();
  });
  probeBound();                              // 不 await：别挡住首屏
  autoCheckUpdate();                         // 也不 await：查更新不许拖慢启动
  // 公告：先把本机那份摆好（立刻有内容），需要新鲜就顺手刷一次 ——
  // 这就是「点打开软件自动更新公告」。同样不 await。
  enterNotice();
  ntPaintDot();          // 公告有没有新东西 —— 只看本机缓存，不探网
  // 校园页也预热：这条只问一次本地状态（不探网），然后把本机缓存画出来。
  // 等用户点进「校园」时就是现成的，不用再等一次往返。
  loadCampus(false);
  // 学习通：只问本地状态（不联网、不扫描），让「我的」那一行显示得对。
  // 真正的扫描要 40 秒，必须用户点了才跑。
  cxRefresh(true);

  if (DATA && DATA.syncedAt && (Date.now() / 1000 - DATA.syncedAt) > 12 * 3600) {
    try {
      const res = await api('/api/sync', {});
      if (res.ok) applyPayload(res);
    } catch (e) { /* 静默失败 */ }
  }
}

boot();
