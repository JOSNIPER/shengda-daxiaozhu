package cc.ccwu.johan.daxiaozhu;

import android.annotation.SuppressLint;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.app.Activity;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 达小助 · 唯一的一个界面。
 *
 * 界面本身是 WebView 里那套 HTML/CSS/JS（和网页版同一份代码），
 * 原生这边只干三件网页干不了的事：
 *   1. 用 https://app.local/ 把 assets 里的页面当「同源网页」发出去；
 *      直接从 file:// 加载的话，localStorage 在部分 WebView 版本上不可靠，
 *      而课表/成绩缓存全靠它。
 *   2. 提供 Android.req()：真正的 HTTP 请求（带 cookie），见 NativeBridge。
 *   3. 提供 Keystore 加密的凭据存取，见 CredStore。
 */
public class MainActivity extends Activity {

    /**
     * UA 尾巴，两个 WebView 共用（这个窗口 + 办事入口那个 WebActivity）。
     *
     * 🔴 `build_apk.py` 用正则 `DaXiaoZhu/([\d.]+)` **从这一行**读版本号，
     *    再跟 app.js / version.json 对账。所以改版本号时这里必须跟着改，
     *    而且**不能删掉这段字符串**（正则找不到会直接判构建失败）。
     */
    public static final String UA_TAG = " DaXiaoZhu/0.1.5";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        // Cookie 由 HttpURLConnection 全局共享一份 —— 登录拿到的 JSESSIONID
        // 后续每个请求都要带上，否则教务系统一律当没登录。
        java.net.CookieManager cm = new java.net.CookieManager(null, java.net.CookiePolicy.ACCEPT_ALL);
        java.net.CookieHandler.setDefault(cm);

        web = new WebView(this);
        web.setBackgroundColor(bgColor());
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // localStorage：课表/成绩/设置都存这儿
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(false);       // 页面自己做了响应式，别再缩放
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        // 🔴 assets 页面必须禁缓存：覆盖安装后 app.local 的 URL 不变，
// LOAD_DEFAULT 会让 WebView 继续用上一版的 index.html/app.js ——
// 新旧 JS+HTML 混搭，轻则按钮错乱，重则新版 app.js 在旧 HTML 上
// 找不到新元素，顶层抛 null，整份脚本罢工（0.1.1 真机翻车原因）。
// assets 读的是本地文件，禁缓存没有任何性能代价。
s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setUserAgentString(s.getUserAgentString() + UA_TAG);

        // 页面全在 assets 里，用不着访问手机上的文件。
        // 关掉能减少「万一页面被注入，借 file:// 读本地文件」这条路。
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // 别让 WebView 存表单/密码（凭据自己用 Keystore 管，不走这里）
        s.setSaveFormData(false);

        web.addJavascriptInterface(new NativeBridge(web), "Android");
        // 下载更新走单独的接口对象：它跟「发 HTTP + 带 cookie」不是一回事，
        // 混在一个类里会让 NativeBridge 越来越像个杂物间。
        web.addJavascriptInterface(new UpdateDownloader(this), "AndroidUpdate");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                String host = req.getUrl().getHost();
                if (!"app.local".equals(host)) return null;
                String path = req.getUrl().getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                try {
                    InputStream in = getAssets().open("web" + path);
                    return new WebResourceResponse(mimeOf(path), charsetOf(path), in);
                } catch (IOException e) {
                    // 缺文件就回 404，别让 WebView 去真网络上找 app.local（会挂很久）
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                            null, new ByteArrayInputStream(("404 " + path).getBytes()));
                }
            }

            /**
             * 页面只该待在 app.local 里。任何往外跳的链接一律拦下。
             *
             * 不拦的后果：点到一个外链，WebView 会真的去加载那个网站，
             * 页面 origin 就从 app.local 变成别人的站 —— 虽然 localStorage
             * 按 origin 隔离读不到课表，但一个「点一下就跑到陌生网站」的
             * App 会让人怀疑它到底在干什么。这条链路本来就不该有外部导航。
             */
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String host = req.getUrl().getHost();
                return !"app.local".equals(host);
            }
        });

        applySystemBars();
        web.loadUrl("https://app.local/index.html");
    }

    /** 状态栏跟着明暗模式走。硬写一个色的话，深色模式下顶上会挂一条亮白。 */
    private void applySystemBars() {
        Window w = getWindow();
        boolean dark = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        if (Build.VERSION.SDK_INT >= 21) {
            w.setStatusBarColor(dark ? Color.parseColor("#0f1013") : Color.parseColor("#f4f5f7"));
            w.setNavigationBarColor(dark ? Color.parseColor("#191b20") : Color.parseColor("#ffffff"));
        }
        if (Build.VERSION.SDK_INT >= 23) {
            // 「浅色状态栏」= 深色图标。系统 API 里名字是反的，容易搞混。
            View dv = w.getDecorView();
            int flags = dv.getSystemUiVisibility();
            if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            dv.setSystemUiVisibility(flags);
        }
    }

    private int bgColor() {
        boolean dark = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        return Color.parseColor(dark ? "#0f1013" : "#f4f5f7");
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        return "application/octet-stream";
    }

    /** 文本类要给 charset，否则中文会变乱码（尤其 js/css）。 */
    private static String charsetOf(String path) {
        String m = mimeOf(path);
        if (m.startsWith("text/") || m.equals("application/javascript") || m.equals("application/json")) {
            return "utf-8";
        }
        return null;
    }

    @Override
    public void onConfigurationChanged(Configuration cfg) {
        super.onConfigurationChanged(cfg);
        applySystemBars();
        web.setBackgroundColor(bgColor());
    }

    /**
     * 返回键先交给网页处理：关浮层 → 回课表 → 才真退出。
     *
     * 网页那边 window.appBack() 返回 true 表示「我处理了」。
     * 用 evaluateJavascript 拿返回值是异步的，所以这里只能同步等一下 ——
     * 但这是个纯 JS 表达式，几毫秒就回来了，不会卡。
     * targetSdk 33 且没开 enableOnBackInvokedCallback，onBackPressed 仍然有效。
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.appBack && window.appBack()) ? '1' : '0'",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        if (!"\"1\"".equals(v)) finish();
                    }
                });
    }
}
