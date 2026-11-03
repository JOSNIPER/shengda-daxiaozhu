package cc.ccwu.johan.daxiaozhu;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * 「办事入口」点进去之后的那个窗口：App 内的 WebView，**带着门户的 cookie**。
 *
 * ================================================================
 * 为什么需要这个 Activity（而不是继续交给系统浏览器）
 * ================================================================
 * 门户的 19 个办事系统（请假、第二课堂、打印中心……）全走 CAS 统一登录。
 * CAS 的免登录靠一张叫 `CASTGC` 的 cookie —— 在 Python 那套代码里我管它叫
 * 「身份证」：门票（customsid / Authorization）过期了，拿身份证能换新的，
 * 不用再输密码。
 *
 * 问题在于：**身份证存在哪儿**。
 *
 *   - App 自己发请求走的是 HttpURLConnection，cookie 存在
 *     `java.net.CookieManager` 这个罐子里（MainActivity.onCreate 里 setDefault 的那个）。
 *   - WebView 有它自己的一套，叫 `android.webkit.CookieManager`。
 *
 * 这是两个完全独立的罐子，互相看不见。以前点办事入口是交给**系统浏览器**打开，
 * 那是第三个罐子 —— 所以每次都要重新登录。
 *
 * 这个 Activity 干的事就是：把第一个罐子里的 cookie 倒进第二个罐子，再开网页。
 * 倒过去之后，WebView 访问 xssq.zua.edu.cn 之类的站点时，CAS 能看见 CASTGC，
 * 直接发票据放行 —— 一次都不用再登。
 *
 * ================================================================
 * 三个容易踩的地方
 * ================================================================
 * 1. 🔴 **Domain 属性必须原样带上**。CASTGC 那种跨子域的 cookie，如果只按
 *    当前 host 当「仅此域名」写进去，`sfrz` 有了、`xssq` 没有，免登录就废了。
 * 2. 🔴 **setAcceptCookie(true) 要在 setCookie 之前调**，否则静默丢弃，
 *    不报错、网页照样弹登录页 —— 看起来像「CASTGC 过期了」。
 * 3. ⚠️ WebView 的罐子会落盘（同一个 App 下次启动还在）。所以「断开门户」
 *    必须连这个罐子一起清，否则 App 里显示「没连」，点进去却还是登录态。
 *    清理在 NativeBridge.clearCookiesFor 里做的。
 *
 * ================================================================
 * 回灌（2026-10-25 补上，原来这里是「已知缺口」）
 * ================================================================
 * 以前这里写着「**不回灌**：在 WebView 里重新登录拿到的 cookie 不会写回
 * java.net 那个罐子，所以『校园』页仍然会显示过期」。
 *
 * 那个缺口害了一个真 bug：用户点「打开学习通」→ 在 WebView 里登录 →
 * 回主界面点「重新检查」→ App 说「还没登录学习通」。
 * 两边都没错，错的是搬运只做了单向。
 *
 * 现在 `syncBackCookies()` 按 host 逐个问、逐条写回（理由和「为什么可以猜」
 * 都写在那个方法的注释里），并且 `persistBack()` 会把结果落盘。
 *
 * ================================================================
 * 0.17.3 补上的三件「点了没反应」（原来写在「已知缺口」里）
 * ================================================================
 * 这一版把公告正文、找回密码、其它公开页也从系统浏览器搬进来了，进来的流量
 * 变多，那三个坑就从「偶尔撞上」变成「迟早撞上」：
 *
 * 1. **文件上传**（`<input type=file>`）：原来没接 `onShowFileChooser`，
 *    请假单要传病历、报销要传发票，点了**什么都不发生**。现在接了。
 * 2. **下载链接**：原来没接 `DownloadListener`，公告附件（PDF/DOC）点了没反应。
 *    现在用系统 DownloadManager 下，**把 WebView 的 cookie 一起带上** ——
 *    要登录才能下的附件，交给系统浏览器是下不动的（那是第三个罐子）。
 * 3. **`window.open`**：WebView 默认 `setSupportMultipleWindows(false)`，
 *    有些办事系统（打印中心之类）用 window.open 开新窗口 ⇒ 点了没反应。
 *    现在把新窗口的地址接回这一个窗口。
 *
 * ⚠️ 这三条都只在真机上能验，电脑上跑不了 —— 别拿「代码里写着」当「真机上行」。
 */
public class WebActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";
    /** false = 这个地址本来就不用登录（公告正文这类公开页）⇒ 别弹「登录已过期」。
     *  缺省 true，保持老行为：老版本 JS 只传两个参数，那时候只用来开办事系统。 */
    public static final String EXTRA_WARN = "warn";

    private static final int REQ_FILE = 1001;

    /**
     * 「整页装进屏幕」的那段脚本（2026-10-28，用户截图：「打开时的比例很奇怪」）。
     *
     * ================================================================
     * 病根：办事系统写的是「响应式」，画的却是桌面版
     * ================================================================
     * 请假管理那一页（截图 1440×3168，≈411dp）是这样的：
     *
     *   `<meta name=viewport content="width=device-width">`  ← 说自己响应式
     *   但里面是 `width:1200px` 的桌面布局                  ← 实际不是
     *
     * 于是 WebView 老老实实按 411dp 布局，页面却要 1200px 宽 ⇒
     * **右边三分之二被切掉**（截图里右栏只剩一条 40px 的缝，「暂无申请」竖着排）。
     * 而 `setUseWideViewPort(true)` / `setLoadWithOverviewMode(true)` 在这时候
     * 帮不上忙：那两个开关管的是「页面**没有** viewport 声明」的情况，
     * 页面自己声明了 `width=device-width`，WebView 就按它说的来。
     *
     * ================================================================
     * 做法：在页面内缩，**一个网络请求都不发**
     * ================================================================
     * 三层兜底，一层比一层更「只是视觉」：
     *   ① `body.style.zoom` → ② `html.style.zoom` → ③ `body.style.transform`
     *
     * 🔴 **`meta viewport` 那条路已经拆了**（2026-10-28）。原来是「把 viewport
     *    改成 `width=1200`，让浏览器自己整页缩放」。实测（`_lab/_m2.py`）：
     *    运行时改 `meta[name=viewport]` **不会重新布局** —— 红点还在 x=24，
     *    页面照样被切；可它把 `documentElement.clientWidth` 改成了 1200，
     *    于是所有宽度读数全部失真（`body.scrollWidth` 从 1200 变成 3504）。
     *    一个「看着生效了、其实没效果、还毁掉测量」的步骤，删掉比留着好。
     *
     * 🔴 **`setInitialScale` + `reload()` 那条路也拆了**（同一天，更严重）。
     *    CAS 的票是一次性的：reload = 拿用过的票再敲一次门 ⇒ 被拒 ⇒ 跳登录
     *    ⇒ 又跳回来 ⇒ **重定向环**。用户看到的正是「整页白屏、进度条反复横跳、
     *    2.4 MB/s 一直跑」。⇒ 页面适配只能做不改导航的动作。
     *
     * 三条纪律：
     *   1. **只在横向溢出时动**。`w0 <= vw*1.12` 直接 return —— CAS 登录页、
     *      公告正文、学习通都是正常响应式的，动了就是帮倒忙（把能看清的页面缩小）。
     *   2. **同一页只动一次**（`data-hyt-fit`）。`onPageFinished` 不是「每页一次」，
     *      CAS 换票和内部 302 都会让它再响，不防就会越缩越小。
     *   3. **不锁缩放**：缩小之后字会很小，双指放大是主要的补偿手段，不能禁。
     *
     * 配套探针：`_lab/out/check_webview_fit.py` —— 它把这段脚本**原文**抠出来，
     * 在 Playwright 的移动视口里跑两遍：桌面版页面必须被装进屏幕，
     * 响应式页面必须**一个字节都没被改**。
     */
    static final String FIT_JS =
            "(function(){try{"
            + "var d=document.documentElement,b=document.body||d;"
            // 🔴 同一页只动一次。`onPageFinished` 不是「每页一次」——
            //    CAS 换票、系统内部 302 都会让它再响一次。
            //    缩过之后 `d.scrollWidth` 已经是 411，`w0<=vis*1.12` 本来就会提前
            //    return；这个标记是**第二道闸**：万一某一层没改布局（比如 transform
            //    那条 `overflowX=hidden` 生效后 scrollWidth 被夹住），别再来一遍。
            + "if(d.getAttribute('data-hyt-fit'))return;"
            // 🔴 「屏幕有多宽」必须用 visualViewport.width，不能用 window.innerWidth。
            //    后者在「内容比屏幕宽」的时候会**跟着内容一起变大**（实测：
            //    411dp 的视口里，一个 1200px 的页面量出来 innerWidth=1200），
            //    拿它当分母就永远判成「装得下」，于是这段代码一次都不会生效 ——
            //    而且不报错。第一版就是这么写的，探针 [2] 三条全红才看出来。
            + "var vv=window.visualViewport||null;"
            + "var vis=(vv&&vv.width)||d.clientWidth||0;"
            // 🔴🔴 2026-10-29：两道「别叠乘」的守卫。这一天量出来的东西：
            //    教务首页 body{min-width:1260px} 且没有 viewport meta ⇒ WebView
            //    按 980 排版、overview 压到 0.49；这段代码再 zoom 0.38 ⇒ 字 2.4dp。
            //    对照组（同一页、只让浏览器缩）字 4.95dp，差 4 倍 —— 而
            //    「糊成一团」正是用户连着 8 次说的「比例还是很奇怪」。
            //
            //    ① 浏览器已经缩过了（visualViewport.scale < 1）⇒ 它已经替我们
            //       把整页塞进屏幕了，这里再缩一次就是叠乘，只会更小。
            + "if(vv&&vv.scale&&Math.abs(vv.scale-1)>0.05)return;"
            //    ② 页面自己能横向滚 ⇒ 交给浏览器原生滚动，不要接管。
            //       只有 `overflow-x:hidden`（滚不动、超出部分直接被裁掉）
            //       那种页面才值得用 zoom 救 —— 救的时候字会变小，但
            //       「小」总比「被裁掉看不见」强。
            + "var oh=getComputedStyle(d).overflowX,ob=getComputedStyle(b).overflowX;"
            + "var hiddenX=(oh==='hidden'||oh==='clip'||ob==='hidden'||ob==='clip');"
            + "if(!hiddenX)return;"
            // ① 要不要动：这里用 max(d,b) —— **改动之前**两个数都是真的
            //    （body 报它自己坐标系里的宽度，html 报视口滚动宽度）。
            //    取 max 是为了连「html 写了 overflow-x:hidden」那种页面也认出来。
            + "var w0=Math.max(d.scrollWidth||0,b.scrollWidth||0);"
            // 装得下就别动：响应式页面（登录页、公告）走这条
            + "if(!vis||!w0||w0<=vis*1.12)return;"
            // 决定要动了，先记账 —— 记在**改之前**，失败了也不重试
            // （宁可少缩一次，也别越缩越小）。
            + "d.setAttribute('data-hyt-fit','1');"
            + "var k=Math.max(vis/w0,0.2);"
            // ② 动了之后「装下了没有」：**只看 documentElement.scrollWidth**。
            //    ⚠️ 这把尺子和上面的 w0 不是同一把，别合并：
            //       - `body.scrollWidth` 在 body 被 zoom 之后**仍然是 1200**
            //         （它自己坐标系里的宽度）⇒ 拿它判永远「没装下」；
            //       - `body.getBoundingClientRect().width` 在**缩放前**就已经是
            //         411（body 是块级元素，宽度=视口；1200 宽的是它的子元素）
            //         ⇒ 拿它判永远「装下了」，底下两层一次都不会跑；
            //       - 只有 `documentElement.scrollWidth` 跟着缩放变（1200 → 411）。
            //    2026-10-28 我用的是前两个取 max ⇒ 永远判失败 ⇒ 0.19.1 里每次
            //    `onPageFinished` 都去 reload ⇒ **无限重载、进度条反复横跳**。
            + "function ok(){return (d.scrollWidth||0)<=vis*1.05;}"
            // 三层兜底，一层比一层更「只是视觉」：
            + "b.style.zoom=k;if(ok())return;"                    // ① body
            + "b.style.zoom='';d.style.zoom=k;if(ok())return;"    // ② html（不能同时留着，会叠乘）
            // ③ transform：纯视觉缩放，不改布局，更不触发任何加载。
            //    🔴 这里**不是** `setInitialScale`+`reload()`：CAS 的票是一次性的，
            //       reload = 拿用过的票再敲一次门 ⇒ 被拒 ⇒ 跳登录 ⇒ 又跳回来 ⇒ 环。
            + "d.style.zoom='';"
            + "b.style.transformOrigin='0 0';"
            + "b.style.transform='scale('+k+')';"
            + "b.style.width=Math.round(w0)+'px';"
            + "d.style.overflowX='hidden';"
            + "var hh=0;try{hh=b.scrollHeight;}catch(e6){}"
            + "if(hh>0)d.style.height=Math.round(hh*k)+'px';"
            + "}catch(e){}})()";

    /** 自检：跑完 `FIT_JS` 约 450ms 后读一次，回答「到底装下了没有」。
     *
     *  🔴 为什么非要自检：`FIT_JS` 的每一条路都可能**静默失效** ——
     *    改 `meta viewport` 在多数 WebView 上不会重新布局，`zoom` 在老内核上
     *    赋值不报错也不生效。JS 侧看不出来，只能从外面量。
     *
     *  🔴🔴 用哪个数当判据，是这个功能里最容易错的一步，而且错了不报错：
     *    - `documentElement.scrollWidth`：**会**跟着 zoom 变（1200 → 411）⇒ 用它；
     *    - `body.scrollWidth`：**永远**是 1200（body 自己坐标系里的宽度）⇒ 用它会
     *      得出「怎么缩都没用」；
     *    - `body.getBoundingClientRect().width`：缩放前就已经是 411 ⇒ 用它会得出
     *      「一缩就好」，假的。
     *    2026-10-28 我用的正是前两个取 `Math.max` ⇒ 永远判失败 ⇒ 0.19.1 里
     *    每次 `onPageFinished` 都去 `reload()` ⇒ **无限重载、进度条反复横跳**。
     *
     *  返回 JSON 字符串（`evaluateJavascript` 会把整串再包一层引号，Java 侧要解两次）。 */
    static final String FIT_CHECK_JS =
            "(function(){try{"
            + "var d=document.documentElement,b=document.body||d;"
            + "var vv=window.visualViewport||null;"
            + "var vis=(vv&&vv.width)||d.clientWidth||0;"
            // 🔴 只认 `documentElement.scrollWidth`（它是唯一跟着缩放变的那个，
            //    1200 → 411）。理由和「另外两个为什么不能用」写在 `FIT_JS` 的 ok() 那里。
            + "var w=d.scrollWidth||0;"
            + "var z=String((d.style&&d.style.zoom)||(b.style&&b.style.zoom)||'');"
            + "var tf=String((b.style&&b.style.transform)||'');"
            // UA 里带着 WebView 的 Chrome 版本 —— 判断「是不是内核太老」的唯一硬证据。
            // 只留 Chrome/xxx 那一段，整串太长，塞不进 toast。
            + "var ua=String(navigator.userAgent||'');"
            + "var cm=/Chrome\\/(\\d+)/.exec(ua);"
            + "var ver=cm?cm[1]:(/Version\\/(\\d+)/.exec(ua)||[0,'?'])[1];"
            + "return JSON.stringify({vis:Math.round(vis),w:Math.round(w),"
            + "zoom:z,tf:tf,fit:!!d.getAttribute('data-hyt-fit'),chrome:ver,"
            + "ok:(vis>0&&w>0&&w<=vis*1.05)});"
            + "}catch(e){return JSON.stringify({err:String(e&&e.message||e)});}})()";

    /** 页面里那根「左栏」收没收起来。
     *
     *  ================================================================
     *  为什么需要它（2026-10-28，用户第 7 次说「比例还是很奇怪」）
     *  ================================================================
     *  三张截图（19:20 手机版两张、19:58 电脑版一张）里，左右分栏的边界
     *  **逐像素相同**（1020 / 1068 / 1392）。也就是说换 UA、换排版宽度，
     *  这个 70.8% / 29.2% 一点没动 —— 结论只有一个：**那根左栏是按百分比写的**，
     *  换多宽的视口它都占七成。这也解释了 0.20.0 的「电脑版」为什么白做。
     *
     *  百分比左栏没法靠「加宽视口」救，只能动 DOM：把左栏收起来，
     *  内容区就拿到整条宽度。这条路对固定 px、flex、table 三种写法都成立。
     *
     *  🔴 但动别人的 DOM 是危险的，所以这里有两道闸 + 一道自检：
     *     ① 左栏必须占版面 58%~92%（再宽就不是「左栏」，是整页）；
     *     ② 内容区必须**已经被挤扁**（≤45%）—— 本来就好好的页面不碰；
     *     ③ 收完必须真的变宽 1.15 倍以上，否则**原样还回去**。
     *  三道全过才动手。任一道不过就什么都不做（并记 `data-hyt-side=0`，
     *  同一个文档只试一次，别反复量）。
     *
     *  ⚠️ 量尺寸一律用 `offsetWidth/offsetHeight/offsetLeft`，不用
     *     `getBoundingClientRect()` —— 判据 [9] 钉着「适配逻辑里不许出现
     *     getBoundingClientRect」，那条是因为拿 body 的 rect 当尺子是错的
     *     （见 FIT_CHECK_JS 上面那张表）。这里量的是别的元素的盒子，
     *     但既然 offset* 够用，就别去碰那条红线。
     */
    static final String SIDE_JS =
            "(function(){try{"
            + "var d=document.documentElement,b=document.body;"
            + "if(!d||!b)return 'skip';"
            // 🔴🔴 只认 '1'（已收），**绝不记 '0'（没有左栏）**。
            //    0.21.0 记了 '0'，结果这一版对办事系统完全没用 —— 那是个 SPA：
            //    `onPageFinished` 那一刻 body 里只有一张 page-loader.gif
            //    （实测 8 个元素），扫不到左栏 ⇒ 记 '0' ⇒ 等 index.js（9.4 MB）
            //    把界面画出来，这个文档已经「结案」了，永远不再看。
            //    「现在没扫到」和「这页没有」是两件事（红线 58）。
            + "if(d.getAttribute('data-hyt-side')==='1'){"
            + "var s0=window.__hytSide;"
            // 收着的那个节点还在 ⇒ 真的收好了，可以跳过
            + "if(s0&&d.contains(s0))return 'collapsed';"
            // SPA 换路由会整片重建 DOM，之前收起来的节点已经不在了 ⇒ 重新判。
            // 顺手把「上一次看到的元素数」清零：新页面的元素数可能跟旧页面
            // 巧合相同，那样会被误判成「已经稳定」，跳过等待直接扫 —— 扫出来
            // 也对，但就失去了「等它画完」的保护。
            + "d.removeAttribute('data-hyt-side');window.__hytN=0;}"
            + "var lw=d.clientWidth||0,vh=window.innerHeight||0;"
            + "if(!lw||!vh)return 'skip';"
            + "var all=b.getElementsByTagName('*'),cand=[],i,el;"
            // 🔴🔴 2026-10-29 性能修复。原来每 600ms 就 `for` 一遍全部元素，
            //    每个元素读 3 个 `offset*` —— 读这些属性会**强制同步重排**，
            //    3000 个元素就是 3000 次重排、几十毫秒。20 次重试 = 12 秒里
            //    一直在打断主线程 ⇒ 用户说的「校园页面打开都非常缓慢」。
            //
            //    改法：**先只读 `all.length`（几乎零成本），元素数还在变就直接
            //    返回 'pending'，根本不做全量扫描。** 界面画完了元素数自然稳定，
            //    那时候扫一次就够了。
            //    「元素数稳定」也是比「数够不够 40 个」更准的「画完了没」判据：
            //    SPA 空壳稳定在 8 个元素上，等 index.js 画完才会变。
            + "var n=all.length;"
            + "if(n!==window.__hytN){window.__hytN=n;return 'pending';}"
            // 稳定但只有零星几个元素 ⇒ 还是空壳（实测 page-loader 阶段 8 个）
            + "if(n<8)return 'pending';"
            // 超大页面设上限：扫前 4000 个足够覆盖任何正常布局，
            // 再多的部分是长列表，左栏不可能藏在第 5000 个上
            + "var lim=n>4000?4000:n;"
            + "for(i=0;i<lim;i++){"
            + "el=all[i];"
            + "if(el.offsetWidth<lw*0.58||el.offsetWidth>lw*0.92)continue;"
            + "if(el.offsetHeight<vh*0.45)continue;"
            + "if(el.offsetLeft>12)continue;"
            + "cand.push(el);}"
            // 到这里说明元素数已经稳定（界面画完了）⇒ 扫不到就是真的没有。
            // ⚠️ 不再用「元素数够不够 40」来判 —— 那个阈值只能猜「画完了没」，
            //    而「元素数稳定」是直接观察到的事实。
            + "if(!cand.length)return 'none';"
            // 只留最外层：内层那个是左栏里的菜单列表，收它没用
            + "var outer=[],j,p,nest;"
            + "for(j=0;j<cand.length;j++){"
            + "p=cand[j].parentElement;nest=false;"
            + "while(p&&p!==b){if(cand.indexOf(p)>=0){nest=true;break;}p=p.parentElement;}"
            + "if(!nest)outer.push(cand[j]);}"
            + "if(!outer.length)return 'none';"
            + "var side=outer[0],main=side.nextElementSibling;"
            + "if(!main)return 'none';"
            // 闸②：内容区没被挤扁就别动它
            + "if(main.offsetWidth>lw*0.45)return 'none';"
            + "var w0=main.offsetWidth;"
            + "window.__hytSide=side;window.__hytMain=main;"
            // 先把内容区原来的内联样式存下来 —— 自检不过时要一字不差地还回去
            + "main.__hytW=main.style.width;main.__hytM=main.style.marginLeft;"
            + "main.__hytF=main.style.flex;main.__hytN=main.style.minWidth;"
            + "side.style.display='none';"
            + "main.style.width='100%';main.style.marginLeft='0';"
            + "main.style.flex='1 1 auto';main.style.minWidth='0';"
            + "var w1=main.offsetWidth;"
            // 收成功了。顺手把 `FIT_JS` 的记账清掉 —— 万一这页先前已经按
            // 「收之前」的宽度缩过一次，那个缩放是偏小的（页面比现在窄），
            // 不清掉的话重新适配会被 `data-hyt-fit` 拦下，字就一直偏小。
            + "if(w1>w0*1.15){d.setAttribute('data-hyt-side','1');"
            + "d.removeAttribute('data-hyt-fit');return 'collapsed';}"
            // 闸③：没变宽 ⇒ 这条布局不吃「收左栏」这一招，原样还回去
            + "side.style.display='';main.style.width=main.__hytW;"
            + "main.style.marginLeft=main.__hytM;main.style.flex=main.__hytF;"
            + "main.style.minWidth=main.__hytN;"
            + "window.__hytSide=null;window.__hytMain=null;"
            + "return 'none';"
            + "}catch(e){return 'err';}})()";

    /** 把左栏调出来（用户点「菜单」）。顺带把内容区的宽度还回去 ——
     *  只把左栏显示出来、内容区还写着 `width:100%` 的话，两块会叠在一起。 */
    static final String SIDE_SHOW_JS =
            "(function(){try{"
            + "var s=window.__hytSide,m=window.__hytMain;"
            + "if(!s)return 'none';"
            + "s.style.display='';"
            + "if(m){m.style.width=m.__hytW||'';m.style.marginLeft=m.__hytM||'';"
            + "m.style.flex=m.__hytF||'';m.style.minWidth=m.__hytN||'';}"
            + "return 'shown';}catch(e){return 'err';}})()";

    /** 再收起来（用户点「收栏」）。 */
    static final String SIDE_HIDE_JS =
            "(function(){try{"
            + "var s=window.__hytSide,m=window.__hytMain;"
            + "if(!s)return 'none';"
            + "s.style.display='none';"
            + "if(m){m.__hytW=m.style.width;m.__hytM=m.style.marginLeft;"
            + "m.__hytF=m.style.flex;m.__hytN=m.style.minWidth;"
            + "m.style.width='100%';m.style.marginLeft='0';"
            + "m.style.flex='1 1 auto';m.style.minWidth='0';}"
            + "return 'hidden';}catch(e){return 'err';}})()";

    private WebView web;
    private TextView backBtn;
    private ProgressBar prog;
    /** 网页里 `<input type=file>` 点了之后，结果要回到这里。**必须且只能回调一次**，
     *  否则那个 file input 会一直挂在「选择中」，用户再点也没用。 */
    private ValueCallback<Uri[]> fileCb;
    /** 这次往 WebView 罐子里写了几条 cookie、拿哪个地址去验「写进去了」。
     *  见 `loadWhenCookiesReady`：`setCookie` 不保证返回时已生效，
     *  所以要靠「读回来」确认，而不是睡一觉赌它写完。 */
    private int injectedCount = 0;
    private String injectedProbe = "";
    /** 已经弹过「适配失败」提示的 URL。
     *
     *  🔴 这里**故意没有** `fitReloaded` 那种「兜底重载」状态 —— 见 `checkFit`
     *     上面那段：reload 在 CAS 保护下的页面里是毒药，会打成重定向环。
     */
    private String fitWarnedUrl = "";

    /** 顶栏右侧的「刷新」。 */
    private TextView refreshBtn;
    /** 顶栏右侧的「电脑版 / 手机版」切换。 */
    private TextView modeBtn;
    /** 顶栏右侧的「菜单 / 收栏」—— 收起那根按百分比写死的左栏（见 `SIDE_JS`）。 */
    private TextView sideBtn;
    /** 左栏当前是不是被收起来了（决定按钮写「菜单」还是「收栏」）。 */
    private boolean sideHidden = false;
    /** 「收左栏」重试的代数：每次 `onPageFinished` +1。
     *
     *  🔴 为什么需要它：办事系统（学生信息管理、请假、打印中心…）是 **SPA**，
     *     `onPageFinished` 触发时 body 里只有一张 `page-loader.gif`，
     *     真正的界面要等 `index.js`（实测 9.4 MB）跑起来才画出来。
     *     所以「扫一次」必然扫空 —— 必须等一会儿再看（见 `trySide`）。
     *     用户中途跳到下一页时，上一页排队的重试要**自己停**，
     *     否则它会在新页面上接着扫，把新页面也收掉。
     */
    private int sideGen = 0;
    /** 「左栏太宽已经收起来」这句提示只弹一次。每次加载都弹会烦死人，
     *  但一次都不弹的话，用户会以为学校的页面少了半边。 */
    private boolean sideToastShown = false;
    /** 电脑版模式：桌面 UA + 桌面排版，**不跑 `FIT_JS`**（理由见 `applyMode`）。 */
    private boolean desktopMode = false;
    /** 进这个窗口时的手机 UA。切回手机版要用**它**，不能拿当前 UA 去改
     *  —— 那样来回切几次，UA 后面会叠一长串版本标记。 */
    private String mobileUA = "";
    /** 顶栏两个按钮要用的颜色（`updateModeLabel` 里要重新上色，所以存成字段）。 */
    private int colSub = 0xff5f646d;
    private int colAccent = 0xff007aff;

    /** 最近几次「开始加载」的地址（和时刻），用来认重定向环。见 `noteLoad`。 */
    private final java.util.ArrayList<String> loadTrail = new java.util.ArrayList<String>();
    private final java.util.ArrayList<Long> loadTimes = new java.util.ArrayList<Long>();
    /** 已经因为「在原地打转」中断过的地址 —— 别反复弹同一个框。 */
    private String loopBrokenFor = "";

    /** 电脑版用的 UA。抄一个普通 Windows Chrome，**不带 Mobile / Android** ——
     *  学校那几个系统（教务、请假、学生信息）就是靠这个决定给不给桌面排版。 */
    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    /** 记住用户手动选过的模式。`-1` = 没选过（按页面类型给默认值），0 = 手机版，1 = 电脑版。 */
    private static final String PREF = "hyt_web";
    private static final String PREF_MODE = "mode";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        String url = "";
        String title = "";
        boolean warn = true;
        Intent it = getIntent();
        if (it != null) {
            String u = it.getStringExtra(EXTRA_URL);
            String t = it.getStringExtra(EXTRA_TITLE);
            if (u != null) url = u.trim();
            if (t != null) title = t.trim();
            // 没带这个 extra 时 getBooleanExtra 回 false，所以默认值要写 true
            warn = it.getBooleanExtra(EXTRA_WARN, true);
        }
        // 只放行 http/https。别的 scheme（file: / intent: / javascript:）一律不接 ——
        // 这个 Activity 的入口是「门户返回的一串 URL」，那串东西不是我们能控制的。
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            finish();
            return;
        }

        boolean dark = isDark();
        int cBg = Color.parseColor(dark ? "#0f1013" : "#f4f5f7");
        int cCard = Color.parseColor(dark ? "#191b20" : "#ffffff");
        int cText = Color.parseColor(dark ? "#f2f4f7" : "#14161a");
        int cSub = Color.parseColor(dark ? "#a8aeb8" : "#5f646d");
        int cLine = Color.parseColor(dark ? "#262a31" : "#e8eaee");
        colSub = cSub;
        // DESIGN.md 第 2 条：一个强调色 #007AFF，只上两处。这里用在
        // 「电脑版已开启」这一个控件上 —— 不然用户看不出当前是哪种模式。
        colAccent = Color.parseColor(dark ? "#4aa8ff" : "#007aff");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(cBg);

        // ---------------- 顶栏：一个返回/关闭 + 一行标题 ----------------
        // 为什么自己搭一条而不是用 ActionBar：整个 App 没引 appcompat，
        // 主题是 NoActionBar。为了这一条顶栏去引一整个支持库不值得。
        int barH = dp(48);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(cCard);
        bar.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, barH));

        backBtn = new TextView(this);
        backBtn.setText("关闭");
        backBtn.setTextSize(15);
        backBtn.setTextColor(cSub);
        backBtn.setGravity(Gravity.CENTER);
        backBtn.setPadding(dp(16), 0, dp(16), 0);
        // 高度撑满 48dp、左右各 16dp 内边距 ⇒ 触控目标远超 44dp 的下限
        backBtn.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, barH));
        backBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // 和硬件返回键同一个行为，别让两条路走出两种结果
                goBackOrClose();
            }
        });
        bar.addView(backBtn);

        TextView tv = new TextView(this);
        tv.setText(title.isEmpty() ? "学校应用" : title);
        tv.setTextSize(15);
        tv.setTextColor(cText);
        tv.setSingleLine(true);
        tv.setEllipsize(TextUtils.TruncateAt.END);
        tv.setGravity(Gravity.CENTER_VERTICAL);
        tv.setPadding(0, 0, dp(8), 0);
        tv.setLayoutParams(new LinearLayout.LayoutParams(0, barH, 1f));
        bar.addView(tv);

        // ---------------- 顶栏右侧：菜单 / 电脑版 / 刷新 ----------------
        // 用户 2026-10-28 要的：教务那几页「比例很奇怪」—— 左边导航撑满屏、
        // 右边内容被挤成一条竖排文字的缝。三张截图量下来，换 UA、换排版宽度
        // 分栏边界**一个像素都没动** ⇒ 那根左栏是按百分比写的，加宽视口没用。
        // 只能动 DOM 把它收起来（`SIDE_JS`），这就是「菜单」这个按钮。
        //
        // 顺序：菜单在左、模式切换居中、刷新在最右（刷新用得更多，靠拇指）。
        sideBtn = new TextView(this);
        sideBtn.setText("菜单");
        sideBtn.setTextSize(15);
        sideBtn.setTextColor(cSub);
        sideBtn.setGravity(Gravity.CENTER);
        sideBtn.setPadding(dp(12), 0, dp(12), 0);
        sideBtn.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, barH));
        sideBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                toggleSide();
            }
        });
        bar.addView(sideBtn);

        modeBtn = new TextView(this);
        modeBtn.setTextSize(15);
        modeBtn.setGravity(Gravity.CENTER);
        modeBtn.setPadding(dp(12), 0, dp(12), 0);
        modeBtn.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, barH));
        modeBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                applyMode(!desktopMode, true);
            }
        });
        bar.addView(modeBtn);

        refreshBtn = new TextView(this);
        refreshBtn.setText("刷新");
        refreshBtn.setTextSize(15);
        refreshBtn.setTextColor(cSub);
        refreshBtn.setGravity(Gravity.CENTER);
        refreshBtn.setPadding(dp(12), 0, dp(16), 0);
        refreshBtn.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, barH));
        refreshBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                refreshPage();
            }
        });
        bar.addView(refreshBtn);
        root.addView(bar);

        // 1px 分隔线。卡片靠边框分层、不用投影，这是 DESIGN.md 的第 2 条。
        View line = new View(this);
        line.setBackgroundColor(cLine);
        line.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1));
        root.addView(line);

        // ---------------- 细进度条 ----------------
        // 学校服务器有时候要等三四秒，没有这条线的话用户不知道是在加载还是点坏了。
        prog = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        prog.setIndeterminate(false);
        prog.setMax(100);
        prog.setProgress(0);
        prog.setVisibility(View.GONE);
        prog.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));
        root.addView(prog);

        // ---------------- WebView ----------------
        web = new WebView(this);
        web.setBackgroundColor(cBg);
        web.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 不少办事系统把 token 放 localStorage
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);            // 这是别人的站，别替它决定缩放
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);       // 不要那两个丑按钮，双指缩放就够
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSaveFormData(false);
        // window.open 要能接住，见下面的 onCreateWindow。
        // 🔴 默认是 false，而且**失效时一声不响**：页面里 `window.open(...)`
        //    什么都不做，用户看到的就是「这个按钮点了没反应」。
        s.setSupportMultipleWindows(true);
        // 学校有些站还是 http，里面又引了 https 的资源，或者反过来。
        // 用 COMPATIBILITY 而不是 NEVER_ALLOW：后者会让这些页面白屏。
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString() + MainActivity.UA_TAG);
        // 手机版 UA 留一份：切模式时用它改回来（理由见 mobileUA 的注释）。
        mobileUA = s.getUserAgentString();
        // 默认给哪种模式：
        //   - 用户手动选过 ⇒ 听用户的（`PREF_MODE`，-1 表示没选过）；
        //   - 没选过 ⇒ 「要登录的办事系统」给**电脑版**（教务/请假/学生信息
        //     本来就是桌面布局，手机版下右栏被挤成一条缝）；
        //     学习通和公开站（公告正文，`warn == false`）给**手机版**
        //     —— 它们本来就是给手机做的，硬上桌面版只会字更小。
        int saved = getSharedPreferences(PREF, MODE_PRIVATE).getInt(PREF_MODE, -1);
        applyMode(saved == 1 || (saved == -1 && warn && !isChaoxing(url)), false);

        // 🔴 顺序不能反：先开、再灌。反了的话 setCookie 静默丢弃，
        //    表现是「网页照样弹登录页」，看起来像身份证过期。
        CookieManager wc = CookieManager.getInstance();
        wc.setAcceptCookie(true);
        wc.setAcceptThirdPartyCookies(web, true);
        boolean hasId = injectCookies(wc, url);
        if (!hasId && warn) {
            // 没有登录态 ⇒ 进去要重新登一次。提前说，别让人以为是 App 坏了。
            // 🔴 只在 `warn` 时才说。以前不管打开什么都提示一句，那会儿这个窗口
            //    只用来开办事系统，所以没露馅。现在公告正文（学校各部门的
            //    **公开**新闻站）也走这里了，
            //    对它们说「登录已过期」就是假消息 —— 用户会以为看个公告还得
            //    重连门户，然后白跑一趟。
            // 🔴 文案要分家：学习通和学习门户是两套账号，说错了比不说更糟 ——
            //    用户会跑去重登门户，而真正要重登的是学习通。
            Toast.makeText(this, isChaoxing(url)
                            ? "学习通登录已过期，进去要重新登一次"
                            : "门户登录已过期，进去要重新登一次",
                    Toast.LENGTH_LONG).show();
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String u, Bitmap fav) {
                prog.setVisibility(View.VISIBLE);
                prog.setProgress(0);
                noteLoad(v, u);
            }

            @Override
            public void onPageFinished(WebView v, String u) {
                prog.setVisibility(View.GONE);
                // ① 先看左栏是不是占了七成（是就收起来，见 SIDE_JS）；
                // ② 手机版再按「收完之后」的宽度做整页适配（见 FIT_JS）。
                // 顺序不能反：`FIT_JS` 会按当下的宽度算缩放，先缩再收的话
                // 那个缩放是照「收之前」算的，收完页面变窄 ⇒ 字比该有的更小。
                // 所以 ② 挂在 ① 的回调里，不在这一行直接调（见 applySide）。
                // ⚠️ 放在 onPageFinished 而不是 onPageStarted：那时候还没有布局，
                //    量不到 offsetWidth / scrollWidth，会静默判成「不用管」。
                applySide(v);
                // 网页自己 Set-Cookie 拿到的东西（比如 CAS 换出来的会话）要落盘，
                // 不然关掉窗口就丢了。
                try { CookieManager.getInstance().flush(); } catch (Throwable ignored) { }
                // 🔴 顺手搬回 java.net 罐子。用户在 WebView 里登录学习通、
                //    或者 CAS 在这里换了新票据，主界面都得能看见 ——
                //    否则「我明明登录了」和「还没登录」会同时成立。
                persistBack(u);
                refreshBackLabel();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return handleUrl(req.getUrl().toString());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                prog.setProgress(p);
                if (p >= 100) prog.setVisibility(View.GONE);
            }

            /**
             * 网页里 `<input type=file>` 被点了。
             *
             * 🔴 不接这个方法的话，WebView **什么都不做**（不是报错，是没反应）——
             *    请假单要传病历、报销要传发票，用户会以为按钮坏了。
             * 🔴 `createIntent()` 会把页面自己写的 accept / multiple 带上，
             *    所以别自己 new 一个 ACTION_GET_CONTENT 丢掉这些条件。
             * 🔴 `fileCb` 必须**恰好回调一次**（见 onActivityResult / onDestroy），
             *    漏了那个 file input 会一直停在「选择中」。
             *
             * ⚠️ 真机上万一上传失败，第一个该怀疑的是上面那句
             *    `setAllowContentAccess(false)` —— 它拦的是 WebView 读
             *    `content://`。先改这一处再查别的。
             */
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                // 上一次的还没回（用户连着点两次）⇒ 先把旧的按「取消」了结，
                // 不然那个 input 永远等不到答案。
                if (fileCb != null) {
                    try { fileCb.onReceiveValue(null); } catch (Throwable ignored) { }
                    fileCb = null;
                }
                fileCb = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Throwable t) {
                    // 没有文件选择器（极简 ROM / 被禁用）⇒ 如实回失败。
                    // 不能返回 true 又什么都不做 —— 那就是「点了没反应」。
                    fileCb = null;
                    Toast.makeText(WebActivity.this, "这台手机没有可用的文件选择器",
                            Toast.LENGTH_LONG).show();
                    return false;
                }
            }

            /**
             * 页面里 `window.open(...)`。
             *
             * 办事系统里开新窗口的地方不少（打印预览、报销单）。
             * 默认 `setSupportMultipleWindows(false)` ⇒ 这个回调根本不会来，
             * `window.open` 静默失效。打开之后我们**不真的开第二个窗口**，
             * 而是把目标地址接回现在这一个 —— 手机上多窗口只会让人找不到回来的路。
             */
            @Override
            public boolean onCreateWindow(WebView v, boolean isDialog,
                                          boolean isUserGesture, Message resultMsg) {
                if (resultMsg == null || resultMsg.obj == null) return false;
                final WebView tmp = new WebView(WebActivity.this);
                tmp.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView tv, WebResourceRequest req) {
                        String u = req.getUrl() == null ? "" : req.getUrl().toString();
                        if (u.isEmpty()) return true;
                        if (!handleUrl(u) && web != null) web.loadUrl(u);
                        // 这个临时 WebView 一次都没上过屏，地址拿到就可以扔。
                        // 延后一点再 destroy：在它自己的回调里直接 destroy 会崩。
                        tv.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                try { tv.destroy(); } catch (Throwable ignored) { }
                            }
                        }, 1000);
                        return true;
                    }
                });
                try {
                    ((WebView.WebViewTransport) resultMsg.obj).setWebView(tmp);
                } catch (Throwable t) {
                    return false;                 // 接不住就让 WebView 按默认来
                }
                resultMsg.sendToTarget();
                return true;
            }
        });

        /**
         * 页面里的下载链接（公告附件 PDF/DOC、导出的表格）。
         *
         * 🔴 不接 `DownloadListener` 的话，点 `.pdf` **什么都不会发生**。
         * 🔴 也不能简单地丢给系统浏览器：要登录才给下的附件，浏览器那边是
         *    第三个 cookie 罐子，下下来只会是登录页。所以走系统 DownloadManager，
         *    **把 WebView 罐子里的 cookie 和 UA 一起带过去** —— 学校服务器认的是这个。
         * 🔴 存到 App 自己的外部目录：不用申请存储权限（API 19 起），
         *    下完点通知栏那条就能打开（DownloadManager 自带 content provider）。
         */
        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String u, String ua, String cd, String mime, long len) {
                if (u == null || !(u.startsWith("http://") || u.startsWith("https://"))) {
                    return;
                }
                try {
                    String name = URLUtil.guessFileName(u, cd, mime);
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(u));
                    String ck = CookieManager.getInstance().getCookie(u);
                    if (ck != null && !ck.isEmpty()) req.addRequestHeader("Cookie", ck);
                    if (ua != null && !ua.isEmpty()) req.addRequestHeader("User-Agent", ua);
                    if (mime != null && !mime.isEmpty()) req.setMimeType(mime);
                    req.setTitle(name);
                    req.setNotificationVisibility(
                            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalFilesDir(WebActivity.this,
                            Environment.DIRECTORY_DOWNLOADS, name);
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm == null) throw new IllegalStateException("没有下载服务");
                    dm.enqueue(req);
                    Toast.makeText(WebActivity.this,
                            "开始下载，完成后在通知栏点一下就能打开",
                            Toast.LENGTH_LONG).show();
                } catch (Throwable t) {
                    // 下载起不来：至少别让人以为点了没反应，并且给出能自救的路
                    Toast.makeText(WebActivity.this,
                            "下载没起来，可以长按这个链接复制到浏览器里下",
                            Toast.LENGTH_LONG).show();
                }
            }
        });

        web.addJavascriptInterface(new NativeBridge(web), "Android");
        web.addJavascriptInterface(new UpdateDownloader(this), "AndroidUpdate");

        // 🔴🔴 这一行漏过一次，症状极有迷惑性：顶栏照常显示（标题是 JS 传进来的
        //      EXTRA_TITLE，不是页面自己的 <title>），下面却是一整片空灰。
        //      看起来像「网页加载失败 / 白屏」，实际是 **WebView 根本没挂到布局上**，
        //      它照样在后台把页面加载完了，只是没人画出来。
        //      ⇒ 以后加视图，记得 root.addView；别把「空屏」当成网络问题去查。
        root.addView(web);

        setContentView(root);
        applySystemBars(dark);
        loadWhenCookiesReady(url);
    }

    // ------------------------------------------------------------ 模式 / 刷新

    /**
     * 切「手机版 / 电脑版」。`userAction = true` 时才落盘 + 重新加载。
     *
     * ================================================================
     * 为什么需要「电脑版」（2026-10-28 用户要的）
     * ================================================================
     * 教务那几页（学生信息管理、请假管理）在手机版下是「左边导航撑满屏、
     * 右边内容被挤成一条竖排文字的缝」。
     *
     * 🔴 0.20.0 的第一版做错了，值得记下来：当时以为「给它桌面 UA + 宽视口
     *    + overview 缩放」就能救（浏览器里勾「请求桌面网站」那一套）。
     *    用户第二天回来说「手机版电脑版都这样」。三张截图一量，左右分栏边界
     *    **逐像素相同**（1020 / 1068 / 1392）—— 换 UA 和换排版宽度对这个
     *    70.8% 一点影响都没有。真正的原因是那根左栏**按百分比写死**，
     *    再宽的视口它也占七成。
     *    ⇒ 真正的解法在 `SIDE_JS`（把左栏收起来），不是换 UA。
     *
     * 两种模式各自的分工：
     *   电脑版 —— 桌面 UA + **不缩放**（原大 100%，宽出去的部分左右滑）。
     *             overview 缩放会把 1260 宽的页面压成 0.28 倍，字只剩 4 像素，
     *             那不是「电脑版」，那是「看不清版」。
     *   手机版 —— 保留 overview + `FIT_JS`：整页缩进屏幕，看结构用。
     *
     * 🔴 电脑版下仍然**不跑 `FIT_JS`**：它是「检测到溢出就整体缩」，
     *    和「原大 + 左右滑」是相反的两种做法，一起上只会互相抵消。
     */
    private void applyMode(boolean desktop, boolean userAction) {
        desktopMode = desktop;
        try {
            WebSettings st = web.getSettings();
            // 🔴 手机版要还原成**进窗口时那一份** UA，不能用「当前 UA + 标记」，
            //    否则来回切几次，UA 后面会叠一长串版本号。
            st.setUserAgentString(desktop ? (DESKTOP_UA + MainActivity.UA_TAG) : mobileUA);
            st.setUseWideViewPort(true);
            // 🔴 2026-10-29：**两个模式都不缩了**。原来手机版是 overview=true
            //    （「整页塞进屏幕」），那是「比例奇怪」的头号来源，实测如下。
            //
            //    教务系统 body{font-size:13px; min-width:1260px}，且**没有**
            //    <meta viewport> ⇒ WebView 按 980 排版，overview 再把它压到
            //    480/980 = 0.49 ⇒ 字 6.4dp。然后 `FIT_JS` 又按「内容 1260 比
            //    视口 480 宽」zoom 0.38 ⇒ **两个缩放叠乘**，字只剩 2.4dp，
            //    糊成一团（对照截图 shots/cmp_A_*.png vs cmp_B_*.png，
            //    同一页字高 9.5px vs 39px，差 4 倍）。
            //
            //    改成 overview=false 后：initial-scale=1，字 13dp 正常大小，
            //    页面按 980 排版，右边超出屏幕的部分**左右滑**看。
            //    代价是要滑，但「要滑」比「看不清」好 —— 看不清是没法用的。
            //    再配合下面的双指缩放，用户想放大自己捏。
            st.setLoadWithOverviewMode(false);
            // 双指缩放：这类桌面页塞进手机，无论怎么定初始缩放都有人嫌大嫌小。
            // 与其猜，不如把决定权交出去。`setDisplayZoomControls(false)` 是
            // 去掉老安卓那个 +/− 浮动按钮 —— 它挡内容，而且双指本来就够用。
            st.setSupportZoom(true);
            st.setBuiltInZoomControls(true);
            st.setDisplayZoomControls(false);
        } catch (Throwable ignored) {
            // 改设置失败不影响页面能看，按钮点了没反应比崩了强
        }
        updateModeLabel();
        if (!userAction) return;
        try {
            getSharedPreferences(PREF, MODE_PRIVATE).edit()
                    .putInt(PREF_MODE, desktop ? 1 : 0).apply();
        } catch (Throwable ignored) { }
        // 换 UA 只对**之后**的请求生效 ⇒ 必须重新加载一次才看得出区别。
        refreshPage();
    }

    /** 按钮文案 = **下一个**动作，不是当前状态；颜色标出当前是电脑版。
     *  只写「电脑版」的话用户看不出自己是哪种模式，会反复点。 */
    private void updateModeLabel() {
        if (modeBtn == null) return;
        modeBtn.setText(desktopMode ? "手机版" : "电脑版");
        modeBtn.setTextColor(desktopMode ? colAccent : colSub);
    }

    /** 「菜单 / 收栏」的文案同样是**下一个动作**：
     *  收着的时候写「菜单」（点一下调出来），开着的时候写「收栏」。
     *
     *  🔴 强调色不往这儿放：DESIGN.md 说一个强调色只上两处，
     *     模式按钮已经占了一处。这里靠**字**区分状态就够了。 */
    private void updateSideLabel() {
        if (sideBtn == null) return;
        sideBtn.setText(sideHidden ? "菜单" : "收栏");
    }

    /**
     * 页面加载完，先看看「左栏是不是占了七成」，是的话收起来。
     *
     * 判据全在 `SIDE_JS` 里（三道闸 + 一次自检，见那个常量的注释）。
     * Java 这边只做三件事：把结果落到 `sideHidden`、更新按钮、第一次收起来时
     * 说一句话。
     *
     * ⚠️ 收完还要不要跑 `FIT_JS`，**必须等这一步有结果再决定**：
     *    `FIT_JS` 按「收之前」的宽度算缩放的话，收完页面变窄，那个缩放就偏小了
     *    （字比该有的更小）。所以手机版的适配放在这个回调里，不放在外面。
     */
    /** 「收左栏」最多试几次、隔多久。
     *
     *  🔴 为什么要试很多次而不是一次：办事系统（学生信息管理 / 请假管理 /
     *     打印中心…）是 **SPA** —— `onPageFinished` 那一刻 body 里只有一张
     *     `page-loader.gif`（实测 8 个元素），真正的界面要等 `index.js`
     *     （实测 9.4 MB）跑起来才画出来。0.21.0 只扫一次，对这类页面
     *     **必然扫空**，这就是用户说「一点没改善」的原因。
     *     20 × 600ms ≈ 12 秒。为什么留这么长：那 9.4 MB 的 index.js 在手机上
     *     首次要解析 + 执行，慢的机器三到五秒很正常，七秒不够保险。
     *     代价几乎为零 —— 只有 `pending`（元素还不到 40 个）才继续等，
     *     界面一画出来立刻就能判出 `none` / `collapsed` 并停手。
     */
    private static final int SIDE_RETRY_MAX = 20;
    private static final long SIDE_RETRY_MS = 600;

    private void applySide(WebView v) {
        if (v == null) return;
        final int gen = ++sideGen;      // 作废上一页排队中的重试
        sideHidden = false;
        updateSideLabel();
        trySide(v, gen, 0);
    }

    /** 试一次「收左栏」；没成就在 `SIDE_RETRY_MS` 后再试，最多 `SIDE_RETRY_MAX` 次。
     *
     *  幂等：`SIDE_JS` 自己认「已经收好了」（`data-hyt-side='1'` 且节点还在），
     *  重复调用不会重复动 DOM。
     */
    private void trySide(final WebView v, final int gen, final int attempt) {
        if (v == null || gen != sideGen) return;   // 已经翻页，别在新页面上乱动
        try {
            v.evaluateJavascript(SIDE_JS, new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String r) {
                    if (gen != sideGen) return;
                    if (r != null && r.indexOf("collapsed") >= 0) {
                        sideHidden = true;
                        updateSideLabel();
                        if (!sideToastShown) {
                            sideToastShown = true;
                            Toast.makeText(WebActivity.this,
                                    "左栏占了七成屏，已经收起来。点顶栏「菜单」可以调出来",
                                    Toast.LENGTH_LONG).show();
                        }
                        // 手机版才做「整页缩进屏幕」，且必须在收完之后（理由见上）
                        if (!desktopMode) fitToScreen(v);
                        return;                 // 收好了，不用再试
                    }
                    // 🔴 只有 'pending'（界面还没画出来）才值得等。
                    //    'none' 说明页面上元素已经够多了、这页确实没有左栏 ⇒
                    //    **立刻**做手机版适配，别让正常页面白等七秒
                    //    （那会让所有页面都比 0.21.0 更迟钝，得不偿失）。
                    boolean pending = r != null && r.indexOf("pending") >= 0;
                    if (pending && attempt < SIDE_RETRY_MAX) {
                        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                            @Override
                            public void run() { trySide(v, gen, attempt + 1); }
                        }, SIDE_RETRY_MS);
                        return;
                    }
                    // 收工：要么这页没有左栏，要么等够久还是没画出来，正常适配
                    if (!desktopMode) fitToScreen(v);
                }
            });
        } catch (Throwable ignored) {
            // JS 关掉/页面崩了也要保证手机版的适配照常跑，别因为这一步卡住
            if (!desktopMode) fitToScreen(v);
        }
    }

    /** 用户点「菜单 / 收栏」：把左栏调出来或者再收起来。
     *
     *  🔴 没有可收的左栏时**要说话**（toast），不能点了没反应 ——
     *     「点了没反应」是用户最难自己判断的一种故障。 */
    private void toggleSide() {
        if (web == null) return;
        String js = sideHidden ? SIDE_SHOW_JS : SIDE_HIDE_JS;
        try {
            web.evaluateJavascript(js, new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String r) {
                    if (r == null || r.indexOf("none") >= 0) {
                        Toast.makeText(WebActivity.this,
                                "这个页面没有可收起的左栏", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    sideHidden = r.indexOf("hidden") >= 0;
                    updateSideLabel();
                }
            });
        } catch (Throwable ignored) {
            Toast.makeText(this, "这个页面没有可收起的左栏", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * 用户点了「刷新」。
     *
     * 🔴🔴 **这是整个 Activity 里唯一允许 `reload()` 的地方，而且必须由用户点击
     *     直接触发。** 2026-10-28 我在 `checkFit` 里自动 reload 过一次，结果 CAS
     *     的一次性票据被反复敲门，打成重定向环（整页白屏、进度条反复横跳、
     *     2.4 MB/s 一直跑）。自动路径里重新加载 = 拿用过的票再敲门；
     *     用户主动点一下 = 和浏览器里按 F5 一样，票是当场换的，没问题。
     *     ⇒ 判据 `check_webview_fit` 的 [9] 钉着这件事：除了这个方法，
     *       别处出现 `reload(` 就红。
     */
    private void refreshPage() {
        if (web == null) return;
        // 先清「原地打转」的记账：不然用户连点四次刷新，会被自己的环检测
        // 拦下来还弹一个吓人的框。
        clearLoopGuard();
        try { web.reload(); } catch (Throwable ignored) { }
    }

    /** 清掉环检测的记账（用户主动操作时用，见 `refreshPage`）。 */
    private void clearLoopGuard() {
        loadTrail.clear();
        loadTimes.clear();
        loopBrokenFor = "";
    }

    /**
     * 记一笔「又开始加载了」，顺便判断是不是在原地打转。
     *
     * ================================================================
     * 为什么 App 自己要认这件事（2026-10-28）
     * ================================================================
     * 用户连着报了四次「校园页面无限加载、进度条反复横跳」，而我手上只有
     * 一张白屏截图和状态栏上那个「2.40 MB/s」—— **一个地址都没有**。
     * 于是只能一轮轮猜（cookie 罐子、内核版本、缩放比例），猜了四轮。
     *
     * 环到底在哪几个地址之间转，只有手机上知道。与其继续猜，不如让 App
     * 自己认出来并**当场说出来**：同一个地址在 8 秒内出现 4 次，那不可能是
     * 正常导航（正常的一次 CAS 往返是 `A → sfrz/login → A?ticket=...`，
     * 三个地址互不相同，不会误判）。
     *
     * 认出来之后做两件事：
     *   ① `stopLoading()` —— 一个转不完的圈没有任何价值，停掉比让它转着好；
     *   ② 弹一个框，把转的那串地址列出来 —— 用户截图发过来，我就能直接定位。
     *
     * ⚠️ 阈值放宽到「4 次 / 8 秒」，且只统计**完全相同**的地址：
     *    宁可漏判（那就退回「一直转圈」），也不要误判正常页面。
     */
    private void noteLoad(WebView v, String u) {
        try {
            if (v == null || u == null || u.isEmpty()) return;
            long now = System.currentTimeMillis();
            while (!loadTimes.isEmpty() && now - loadTimes.get(0) > 8000) {
                loadTimes.remove(0);
                loadTrail.remove(0);
            }
            loadTrail.add(u);
            loadTimes.add(now);
            int same = 0;
            for (int i = 0; i < loadTrail.size(); i++) {
                if (loadTrail.get(i).equals(u)) same++;
            }
            if (same < 4) return;
            if (u.equals(loopBrokenFor)) return;      // 已经断过一次，别再弹
            loopBrokenFor = u;
            try { v.stopLoading(); } catch (Throwable ignored) { }
            showLoop(same);
        } catch (Throwable ignored) {
            // 诊断/兜底功能不许把主功能拖垮
        }
    }

    /** 把环的形状摆给用户看 —— 这一屏就是我要的证据。 */
    private void showLoop(int times) {
        if (isFinishing()) return;
        StringBuilder sb = new StringBuilder();
        sb.append("这个页面在 8 秒里 ").append(times).append(" 次回到同一个地址，")
          .append("已经停止加载 —— 再等也不会有结果。\n\n");
        java.util.LinkedHashSet<String> uniq =
                new java.util.LinkedHashSet<String>(loadTrail);
        int i = 0;
        for (String s : uniq) {
            if (i++ >= 6) { sb.append("…（还有更多）\n"); break; }
            sb.append(i).append(". ").append(s).append('\n');
        }
        sb.append("\n请把这一屏截图发给开发者，就能定位到是哪一步在打转。");
        try {
            new AlertDialog.Builder(this)
                    .setTitle("页面在来回跳")
                    .setMessage(sb.toString())
                    .setPositiveButton("知道了", null)
                    .show();
        } catch (Throwable t) {
            // 弹不出来就退回 toast（框起不来不能连消息都没有）
            try {
                Toast.makeText(this, "页面在来回跳，已停止加载", Toast.LENGTH_LONG).show();
            } catch (Throwable ignored) { }
        }
    }

    /**
     * 跑一遍 `FIT_JS`，450ms 后**回读自检**；装不下就报出来，**不动页面**。
     *
     * 🔴 2026-10-28 改：原来这里只「叫它一声」，注释还写着「别指望判断有没有生效」——
     *    那句话是错的。`FIT_JS` 的每一条路都可能**静默失效**：改 `meta viewport`
     *    在多数 WebView 上不会重新布局，`zoom` 在部分内核上赋值不报错也不生效。
     *    而我看不见，就等于没发生 —— 用户连报四次「页面还是加载不出来」，
     *    就是因为我一直在 Playwright 里自证，从没在真机上量过一次。
     *
     * 三段：
     *   ① 叫 JS 去缩（viewport → body.zoom → html.zoom → transform，全在页面内）；
     *   ② 450ms 后回读 `FIT_CHECK_JS`，拿真实的 vis / w / zoom / chrome；
     *   ③ 还没装下 ⇒ **弹一行数字**（vis/w/chrome/zoom），绝不再动导航。
     *
     * 🔴🔴 第 ③ 步原来写的是 `setInitialScale` + `reload()`。那是错的，而且很严重：
     *    用户从「页面被挤成一条缝」变成「整页白屏 + 进度条反复横跳 + 2.4 MB/s」。
     *    CAS 的票是一次性的，reload = 拿用过的票再敲一次门 ⇒ 被拒 ⇒ 跳登录 ⇒
     *    又跳回来 ⇒ 环。而 `onPageStarted` 每次因 URL 变化把标志重置，reload 停不下来。
     *    ⇒ 页面适配**只能做不改导航的动作**；做不到就如实报数，别赌一次重载。
     */
    private void fitToScreen(WebView v) {
        if (v == null) return;
        try {
            v.evaluateJavascript(FIT_JS, null);
        } catch (Throwable ignored) {
            // 适配失败不影响页面能看（大不了右边要横向滚），
            // 不能因为这一句把整页拖垮。
        }
        // 450ms 后量一次：装下了就什么都不做；没装下就**报出来**（toast）。
        // ⚠️ 这里**不做任何会触发重新加载的动作** —— 理由见 `checkFit` 上面那段。
        v.postDelayed(new Runnable() {
            @Override public void run() { checkFit(v); }
        }, 450);
    }

    /** `fitToScreen` 的第二段：量一次，装不下就报出来。
     *
     *  🔴🔴 **绝对不许在这里 `reload()`。** 2026-10-28 我加过「`setInitialScale`
     *     + `reload()`」的原生兜底，结果用户从「页面被挤成一条缝」变成
     *     「整页白屏、进度条反复横跳、2.4 MB/s 一直跑」——
     *     因为 CAS 的票是**一次性**的：reload 等于拿用过的票再敲一次门，
     *     被拒 → 跳登录 → 又跳回来 → 成环。而 `onPageStarted` 每次都因 URL
     *     变了把「已经兜过底」的标志重置，于是 reload 停不下来。
     *    ⇒ 页面适配这件事，**只能做「不改导航」的动作**（CSS zoom / transform）。
     *      做不成就如实说，让用户截图，而不是赌一次重载。
     */
    private void checkFit(final WebView v) {
        if (v == null) return;
        try {
            v.evaluateJavascript(FIT_CHECK_JS, new ValueCallback<String>() {
                @Override public void onReceiveValue(String raw) {
                    String[] m = parseFit(raw);   // {vis, w, chrome, zoom}
                    if (m == null) return;
                    int vis, w;
                    try { vis = Integer.parseInt(m[0]); w = Integer.parseInt(m[1]); }
                    catch (Throwable e) { return; }
                    if (vis <= 0 || w <= 0) return;
                    if (w <= vis * 1.05) return;          // 装下了，收工
                    // 没装下 ⇒ 三条 JS 路都没成功。**只报，不动页面。**
                    // 同一个 URL 只报一次，否则 CAS 重定向会让它连弹好几遍。
                    String u = "";
                    try { u = String.valueOf(v.getUrl()); } catch (Throwable ignored) { }
                    if (u.equals(fitWarnedUrl)) return;
                    fitWarnedUrl = u;
                    String tip = "页面适配失败 vis=" + vis + " w=" + w
                            + " chrome=" + m[2] + " zoom=" + (m[3].isEmpty() ? "无" : m[3])
                            + " tf=" + (m[4].isEmpty() ? "无" : m[4]);
                    try {
                        Toast.makeText(WebActivity.this, tip, Toast.LENGTH_LONG).show();
                    } catch (Throwable ignored) { }
                }
            });
        } catch (Throwable ignored) { }
    }

    /** 解 `evaluateJavascript` 的回读值。它会把 JS 的返回值**再包一层引号并转义**，
     *  所以要先解一层 JSON 拿到里面的字符串，再解第二层拿到对象。
     *  返回 `{vis, w, chrome, zoom, tf}` 五个字符串；解不出来返回 null。 */
    private static String[] parseFit(String raw) {
        if (raw == null) return null;
        try {
            Object outer = new JSONTokener(raw).nextValue();
            if (!(outer instanceof String)) return null;
            JSONObject j = new JSONObject((String) outer);
            return new String[]{
                    String.valueOf(j.optInt("vis", 0)),
                    String.valueOf(j.optInt("w", 0)),
                    j.optString("chrome", "?"),
                    j.optString("zoom", ""),
                    j.optString("tf", ""),
            };
        } catch (Throwable e) {
            return null;
        }
    }

    /**
     * 等 cookie 真的进了 WebView 的罐子，再 loadUrl。
     *
     * ================================================================
     * 这是「点一下直接进」最隐蔽的失败方式（2026-10-27 补）
     * ================================================================
     * `CookieManager.setCookie()` 不保证在调用返回时就已落到 WebView 的存储里，
     * `flush()` 更是「排到磁盘」的异步动作。紧跟其后 `loadUrl()`，页面请求很可能
     * 跑在写 cookie 之前 —— CAS 收不到 CASTGC，老老实实弹登录页。
     *
     * 要命的是它的**表现和「身份证真的过期了」一模一样**：不报错、日志干净、
     * 网页就是让你登一次。于是被当成「本来就要重登」放过 —— 用户的原话正是
     * 「跳转完还需要再次登录」。
     *
     * ================================================================
     * 为什么不是 `flush(回调)`
     * ================================================================
     * `CookieManager` 只有无参的 `flush()`；带回调的是 `removeAllCookies` 那些。
     * 所以「等落盘完成」这条路走不通，只能**自己读回来验**：
     * 拿刚写进去的那个地址去 `getCookie()`，读得到就说明生效了。
     *
     * 这比「睡 200 毫秒赌它写完」强的地方在于：它是**可观测的**。
     * 慢的机器上多轮询几次，快的机器上第一次就过 —— 不靠猜一个固定的数。
     *
     * 兜底：最多等 800ms。等不到也得开 —— 宁可进去自己登一次，
     * 也不能让用户对着白屏。
     */
    private void loadWhenCookiesReady(final String url) {
        // 这次一条 cookie 都没写（公开站）⇒ 没什么可等的，直接开。
        if (injectedCount <= 0 || injectedProbe.isEmpty()) {
            web.loadUrl(url);
            return;
        }
        final long deadline = System.currentTimeMillis() + 800;
        final Runnable poll = new Runnable() {
            @Override
            public void run() {
                boolean ready = false;
                try {
                    String ck = CookieManager.getInstance().getCookie(injectedProbe);
                    ready = ck != null && !ck.isEmpty();
                } catch (Throwable ignored) {
                    // 读不出来就当没生效，按超时处理
                }
                if (!ready && System.currentTimeMillis() < deadline) {
                    web.postDelayed(this, 40);      // 40ms 一轮，最多 20 轮
                    return;
                }
                if (web != null) web.loadUrl(url);
            }
        };
        web.post(poll);
    }

    // ------------------------------------------------------------ cookie 搬运

    /**
     * 把 HttpURLConnection 那个罐子里的 cookie 全部倒进 WebView 的罐子。
     *
     * 返回：罐子里**有没有这次要用的那张「身份证」**（不是「倒了几条」）。
     *
     * 🔴 两种身份不能混判：
     *    - 统一认证把 `CASTGC` 种在 `cas.shengda.edu.cn` 上。用户点开的门户页
     *      在 `my.shengda.edu.cn` 上 —— 按「目标域名有没有 cookie」判断会永远是 0，
     *      但免登录其实是能成的。
     *    - 学习通认 `.chaoxing.com` 域下的 `UID` / `_uid`。拿 CASTGC 去判断
     *      学习通，会在「门户登着、学习通没登」时给出「已过期」的假提示；
     *      反过来「学习通登着、门户没登」时又什么都不说，用户点进去撞登录页。
     *
     * 具体的「一条 cookie 该写成哪一行」在 CookieJar 里 —— 那段逻辑不碰
     * android.*，所以在电脑上能真跑测试（_lab/portal/CookieJarTest.java）。
     */
    private boolean injectCookies(CookieManager wc, String targetUrl) {
        boolean hasId = false;
        boolean cx = isChaoxing(targetUrl);
        try {
            java.net.CookieHandler h = java.net.CookieHandler.getDefault();
            if (!(h instanceof java.net.CookieManager)) return false;
            java.util.List<CookieJar.Pair> pairs =
                    CookieJar.toPairs(((java.net.CookieManager) h).getCookieStore());
            hasId = cx
                    ? (CookieJar.has(pairs, "UID") || CookieJar.has(pairs, "_uid"))
                    : CookieJar.has(pairs, "CASTGC");
            for (CookieJar.Pair p : pairs) {
                try {
                    wc.setCookie(p.url, p.line);
                    injectedCount++;
                    // 第一条的地址留着当「验生效」的探针（见 loadWhenCookiesReady）
                    if (injectedProbe.isEmpty()) injectedProbe = p.url;
                } catch (Throwable ignored) { }
            }
            wc.flush();
        } catch (Throwable ignored) {
            // 搬运失败就当没有登录态：界面会提示「进去要重新登一次」，
            // 不影响窗口本身能打开。宁可降级，也别白屏。
        }
        return hasId;
    }

    /** 这个地址是不是学习通的。域名判断放宽到子域（mooc1./passport2./mobilelearn. 都算）。 */
    private static boolean isChaoxing(String url) {
        if (url == null) return false;
        try {
            String host = Uri.parse(url).getHost();
            if (host == null) return false;
            host = host.toLowerCase(java.util.Locale.ROOT);
            return host.equals("chaoxing.com") || host.endsWith(".chaoxing.com");
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 把 **WebView 罐子**里的 cookie 搬回 **java.net 罐子**（回灌）。
     *
     * ================================================================
     * 为什么必须补这一步（2026-10-25 用户报的 bug）
     * ================================================================
     * 症状原话：「明明已经登录了学习通，点重新检查的时候还是说学习通未登录」。
     *
     * 路径是这样的：
     *   1. 学习页有个「打开学习通」按钮 → NativeApi.openWeb → 这个 Activity。
     *   2. 进去时罐子里没有 UID，所以先弹「学习通登录已过期，进去要重新登一次」。
     *   3. 用户在**这个 WebView 里**登录了。cookie 落在
     *      `android.webkit.CookieManager` —— 那是另一个罐子。
     *   4. 回到主界面点「重新检查」→ `Android.cxHasLogin()` 读的是
     *      `java.net.CookieManager`，那里一条都没有 ⇒ 说「还没登录学习通」。
     *
     * 用户看到的是「我明明登录了」，App 看到的是「没登录」。两边都没错，
     * 错的是**中间那趟搬运只做了单向**。
     *
     * ================================================================
     * 为什么可以「猜」着写回去
     * ================================================================
     * 原来这里写着「不回灌」，理由是 webkit 的 `getCookie()` 只给
     * `a=1; b=2`，拿不到 Domain / Path / 过期时间，硬猜容易写坏。
     *
     * 那个顾虑对**跨子域**的 cookie 成立，但有一个不需要猜的办法：
     * **按 host 逐个问、问到哪条就按那个 host 原样写回**。
     * 同一张 UID 在 mooc1 / mooc1-api / mooc2-ans 上都会被问出来，
     * 于是每个 host 各得一份「仅此域名」的副本 —— 对「发请求时带不带上」
     * 这件事来说，和一张 `.chaoxing.com` 的域 cookie 效果相同。
     *
     * ⚠️ 必须 `setDomain(host)` 显式写上：不写的话 `dumpCookies()` 导出成
     *    `domain: ""`，而 `CxNet.loadCookies()` 对空 domain 是**直接丢掉**的
     *    （`if (host.isEmpty()) continue;`）⇒ 重启一次又白干。
     *
     * @return 搬回来几条（0 = 这个罐子里本来就没有）。
     */
    private int syncBackCookies(String url) {
        if (url == null || url.isEmpty()) return 0;
        int n = 0;
        try {
            CookieManager wc = CookieManager.getInstance();
            java.net.CookieHandler h = java.net.CookieHandler.getDefault();
            if (!(h instanceof java.net.CookieManager)) return 0;
            java.net.CookieStore store = ((java.net.CookieManager) h).getCookieStore();

            for (String host : hostsToAsk(url)) {
                String line;
                try {
                    line = wc.getCookie("https://" + host + "/");
                } catch (Throwable ignored) {
                    continue;                     // 这个 host 问不出来就跳过
                }
                if (line == null || line.isEmpty()) continue;
                for (String piece : line.split(";")) {
                    String s = piece.trim();
                    if (s.isEmpty()) continue;
                    int eq = s.indexOf('=');
                    if (eq <= 0) continue;        // 没有名字或没有等号：跳过
                    String name = s.substring(0, eq).trim();
                    String val = s.substring(eq + 1).trim();
                    if (name.isEmpty()) continue;
                    // 空值不搬：那通常是服务端下发的「删掉这条」，
                    // 搬回去反而会把 java.net 罐子里还在的那条覆盖成空。
                    if (val.isEmpty()) continue;
                    try {
                        java.net.HttpCookie ck = new java.net.HttpCookie(name, val);
                        ck.setDomain(host);       // 显式写，理由见上面 ⚠️
                        ck.setPath("/");
                        store.add(new java.net.URI("https://" + host + "/"), ck);
                        n++;
                    } catch (Throwable ignored) {
                        // 这一条写不进去就跳过，别带走整批
                    }
                }
            }
        } catch (Throwable ignored) {
            // 搬不动就算了：主界面会照旧说「未登录」，用户手动登一次也能用。
        }
        return n;
    }

    /** 要问哪些 host。学习通跨的子域是固定的那几个（见 CxNet 顶部那张表）。
     *
     *  🔴 2026-10-28（底座）：非学习通原来只问**当前 host 这一个**。那是错的，症状正好
     *    是用户报的「在 App 里登录了智慧门户，别的入口还是要重登」：
     *      - 用户走完 CAS 登录，最后停在哪一页取决于门户；
     *      - 而**身份证 `CASTGC` 在 CAS 那个域上**，从来没被问过；
     *      - 于是 java.net 罐子里始终没有 CASTGC ⇒ 主界面判「未登录」⇒
     *        下一个入口打开时没东西可灌 ⇒ 又要登一次。
     *    搬运的方向一直是对的，漏的是「问哪个 host」。
     *
     *  多问两个 host 是安全的：没 cookie 的 host 返回 null，直接跳过。
     *  ⚠️ 只对学校域名放宽 —— 别把第三方独立站也带进来。
     *  🔴 达小助改造（W6）：升达的统一认证是 `cas.shengda.edu.cn/lyuapServer`、
     *    门户是 `my.shengda.edu.cn`，跟郑航那套 sfrz/rhmh 不是一回事，
     *    按本校域名放宽。
     */
    private static String[] hostsToAsk(String url) {
        if (isChaoxing(url)) {
            return new String[] {
                    "passport2.chaoxing.com", "chaoxing.com", "i.chaoxing.com",
                    "mooc1.chaoxing.com", "mooc1-api.chaoxing.com",
                    "mooc2-ans.chaoxing.com", "mobilelearn.chaoxing.com"
            };
        }
        try {
            String host = Uri.parse(url).getHost();
            if (host == null || host.isEmpty()) return new String[0];
            host = host.toLowerCase(java.util.Locale.ROOT);
            java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<String>();
            set.add(host);                       // 当前这页自己的
            if (host.equals("shengda.edu.cn") || host.endsWith(".shengda.edu.cn")) {
                set.add("cas.shengda.edu.cn");   // 身份证（CAS）在这儿
                set.add("my.shengda.edu.cn");    // 门户首页
                set.add("jw.shengda.edu.cn");    // 教务（青果，8090）
            }
            return set.toArray(new String[0]);
        } catch (Throwable t) {
            return new String[0];
        }
    }

    // ------------------------------------------------------------ 导航

    /** true = 我拦下了，别让 WebView 自己加载。 */
    private boolean handleUrl(String u) {
        if (u == null || u.isEmpty()) return true;
        if (u.startsWith("http://") || u.startsWith("https://")) return false;
        // tel: / mailto: / intent: 这些交给系统 —— 学校页面上的「打电话给辅导员」
        // 之类，WebView 自己是不认的，点了没反应会让人以为坏了。
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable ignored) { }
        return true;
    }

    private void goBackOrClose() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            refreshBackLabel();
        } else {
            finish();
        }
    }

    /** 能往回退的时候写「返回」，退无可退写「关闭」—— 两个词对应两种真实结果。 */
    private void refreshBackLabel() {
        if (backBtn == null || web == null) return;
        backBtn.setText(web.canGoBack() ? "返回" : "关闭");
    }

    /**
     * 回灌 + 落盘。`onPageFinished` 和 `onPause` 都会调，所以必须幂等。
     *
     * 🔴 为什么还要落盘：回灌只改**内存里的** java.net 罐子，App 一退出就没了。
     *    而 `CredStore` 里那份是 native.js 在 `/api/cx/login` 时写的 ——
     *    用户要是在 WebView 里登的，那份从来没被更新过。
     *    不补这一步，表现是「这次能用，下次开 App 又变未登录」。
     */
    private void persistBack(String url) {
        try {
            int n = syncBackCookies(url);
            if (n <= 0) return;
            if (isChaoxing(url) && CxNet.hasLogin()) {
                CredStore.saveCx(CxNet.dumpCookies());
            }
        } catch (Throwable ignored) {
            // 落盘失败不影响本次使用，下次重登一次而已
        }
    }

    @Override
    protected void onPause() {
        // 用户可能登录完直接按 Home / 返回键走人，onPageFinished 之后
        // 还有可能再发生跳转 ⇒ 这里再搬一次。幂等，重复搬不会写坏。
        try {
            if (web != null) persistBack(web.getUrl());
        } catch (Throwable ignored) { }
        super.onPause();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        goBackOrClose();
    }

    /**
     * 文件选择器回来了。
     *
     * 🔴 三条铁律：
     *   1. `fileCb` 必须回调**恰好一次**，不管用户是选了、取消了、还是没选就返回。
     *      不回调 = 网页那个 file input 永远停在「选择中」，再点没反应。
     *   2. 取消要回 `null`（不是空数组）—— 空数组会被当成「选了 0 个文件」，
     *      有些表单会因此把已上传的附件清掉。
     *   3. 多选要按 `ClipData` 逐个取；只取 `getData()` 会丢掉除第一个以外的。
     */
    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != REQ_FILE) {
            super.onActivityResult(req, res, data);
            return;
        }
        if (fileCb == null) return;                // 已经被别处了结过，别再回调第二次
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                java.util.ArrayList<Uri> list = new java.util.ArrayList<Uri>();
                for (int i = 0; i < n; i++) {
                    Uri u = data.getClipData().getItemAt(i).getUri();
                    if (u != null) list.add(u);
                }
                if (!list.isEmpty()) out = list.toArray(new Uri[0]);
            } else if (data.getData() != null) {
                out = new Uri[] { data.getData() };
            }
        }
        try { fileCb.onReceiveValue(out); } catch (Throwable ignored) { }
        fileCb = null;
    }

    @Override
    protected void onDestroy() {
        // 页面在等「选文件」的时候被关掉 ⇒ 必须回一个 null 了结掉，
        // 不然那个回调对象连同 Activity 一起被攥住。
        if (fileCb != null) {
            try { fileCb.onReceiveValue(null); } catch (Throwable ignored) { }
            fileCb = null;
        }
        // WebView 不 destroy 会攥着 Activity 不放，来回开关几次就 OOM
        if (web != null) {
            try {
                web.stopLoading();
                web.setWebChromeClient(null);
                web.destroy();
            } catch (Throwable ignored) { }
            web = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------ 杂项

    private boolean isDark() {
        return (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /** 状态栏/导航栏跟着明暗走。和 MainActivity 里那段一样，故意没抽公共类：
     *  那边是能跑的老代码，为了省 8 行去动它不划算。 */
    private void applySystemBars(boolean dark) {
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor(dark ? "#0f1013" : "#f4f5f7"));
        w.setNavigationBarColor(Color.parseColor(dark ? "#191b20" : "#ffffff"));
        View dv = w.getDecorView();
        int flags = dv.getSystemUiVisibility();
        if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        dv.setSystemUiVisibility(flags);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
