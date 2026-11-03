package cc.ccwu.johan.daxiaozhu;

import java.net.CookieStore;
import java.net.HttpCookie;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 把 `java.net.CookieManager` 那个罐子里的 cookie，翻成「(往哪个地址写, 写什么)」。
 *
 * ================================================================
 * 为什么单独一个类
 * ================================================================
 * 这段逻辑是整个「办事入口免登录」功能里**唯一容易错、又错得最安静**的地方：
 * 少带一个 Domain、Secure 的 cookie 用 http 塞，WebKit 都**不报错**，
 * 只是把 cookie 丢掉 —— 然后网页老老实实弹个登录页，看起来像「身份证过期了」。
 *
 * 它又跑在手机上，没法在这台电脑上真机调试。所以把它抽出来：
 * 这里只依赖 `java.net.*`（JDK 自带），**一个 android.* 都没碰**，
 * 于是可以直接拿桌面 JVM 跑真断言（见 `_lab/portal/CookieJarTest.java`）。
 *
 * ================================================================
 * 🔴 踩过的一个坑：不能用 getURIs() + get(uri)
 * ================================================================
 * 第一版是这么写的（看着很自然：遍历罐子里的每个地址，取出该地址的 cookie）：
 *
 *     for (URI u : store.getURIs()) for (HttpCookie c : store.get(u)) ...
 *
 * 在桌面 JVM 上跑断言才发现：**CASTGC 一条都取不到**。
 * 原因有两层，叠在一起：
 *
 *   1. `getURIs()` 返回的地址被 JDK **规范化成 `http://host`**（连 path 都没了），
 *      哪怕你当初是用 https 存进去的。
 *   2. `get(uri)` 会按 scheme 过滤：**Secure 的 cookie 用 http 地址去取，直接不返回。**
 *
 * 而 CASTGC 恰好是 Secure 的 —— 于是真机上「身份证」永远搬不过去，
 * 网页照样弹登录页，**不报错、不崩、控制台干净**。这正是最难发现的那种 bug。
 *
 * 现在改成 `getCookies()` 取全量（它不做任何过滤），再用 getURIs() 的 host
 * 反查「没有 Domain 的 cookie 属于谁」。
 *
 * ================================================================
 * 三条规矩（测试里逐条钉着）
 * ================================================================
 * 1. **Domain 属性原样保留。** `.zua.edu.cn` 这种跨子域 cookie，丢了 Domain
 *    就退化成「仅此域名」，换个二级域名就看不见了，免登录直接废。
 * 2. **一律用 https 地址写。** WebKit 只对 Secure 的 cookie 挑 scheme；
 *    非 Secure 的写 https 也不会漏发（它照样会被发到 http 页面）。
 *    反过来，Secure 的 cookie 用 http 地址写会被**直接拒收** —— 所以统一 https 最省事。
 * 3. **Max-Age = 0 是「删除」指令，不是一条 cookie。** 照搬过去等于没写。
 */
public final class CookieJar {

    private CookieJar() {
    }

    /** 一条待写入的 cookie：往 url 这个地址，写 line 这一行。 */
    public static final class Pair {
        /** 用来调 `CookieManager.setCookie(url, line)` 的地址，形如 `https://a.b/` */
        public final String url;
        /** 形如 `name=value; Domain=.a.b; Path=/; Secure` */
        public final String line;
        /** cookie 名字，方便调用方判断「有没有 CASTGC」这种问题 */
        public final String name;

        public Pair(String url, String line, String name) {
            this.url = url;
            this.line = line;
            this.name = name;
        }
    }

    /**
     * 把整个罐子翻一遍。
     *
     * 顺序不保证 —— 调用方不该依赖顺序（同名 cookie 的覆盖由 WebKit 自己按
     * Domain/Path 具体度决定，不靠写入先后）。
     */
    public static List<Pair> toPairs(CookieStore store) {
        List<Pair> out = new ArrayList<Pair>();
        if (store == null) return out;

        // 「没有 Domain 的 cookie 属于哪个 host」—— 真机上 CookieManager.put()
        // 会顺手把 domain 补成请求的 host，所以这条路基本用不上；但 store.add()
        // 直接塞进去的 cookie 是真的没有 domain（实测过），兜一层不吃亏。
        Map<String, String> hostByName = hostIndex(store);

        List<HttpCookie> all;
        try {
            // 🔴 必须用 getCookies()：它不过滤 scheme，Secure 的也拿得到。
            //    用 getURIs() + get(uri) 会把 Secure 的全漏掉（见类注释）。
            all = store.getCookies();
        } catch (Throwable t) {
            return out;
        }
        if (all == null) return out;

        for (HttpCookie ck : all) {
            Pair p = pairOf(ck, hostByName == null ? null : hostByName.get(keyOf(ck)));
            if (p != null) out.add(p);
        }
        return out;
    }

    /** 用 getURIs() 的 host 建一张「name|path → host」的表，给没 domain 的 cookie 兜底。 */
    private static Map<String, String> hostIndex(CookieStore store) {
        Map<String, String> m = new HashMap<String, String>();
        List<URI> uris;
        try {
            uris = new ArrayList<URI>(store.getURIs());
        } catch (Throwable t) {
            return m;
        }
        for (URI u : uris) {
            if (u == null) continue;
            String host = u.getHost();
            if (host == null || host.isEmpty()) continue;
            try {
                // 用 https 探，Secure 的 cookie 才拿得到
                for (HttpCookie c : store.get(new URI("https://" + host + "/"))) {
                    m.put(keyOf(c), host);
                }
            } catch (Throwable ignored) {
                // 某个地址探不动就算了，不影响别的
            }
        }
        return m;
    }

    private static String keyOf(HttpCookie c) {
        if (c == null) return "";
        String p = c.getPath();
        return c.getName() + "|" + (p == null || p.isEmpty() ? "/" : p);
    }

    /**
     * 单条转换。返回 null 表示这条该跳过（无效 / 删除指令 / 不知道属于谁）。
     *
     * @param fallbackHost 这条 cookie 没有 Domain 属性时，用它当写入地址的 host。
     *                     不知道就传 null —— 那这条会被跳过（宁可少一条，
     *                     也不能瞎写到一个错的域名上去）。
     */
    public static Pair pairOf(HttpCookie ck, String fallbackHost) {
        if (ck == null) return null;
        String name = ck.getName();
        String val = ck.getValue();
        if (name == null || name.isEmpty() || val == null) return null;
        // Max-Age = 0 是「把这个 cookie 删掉」，不是一条要写入的 cookie
        if (ck.getMaxAge() == 0) return null;

        // 写地址的 host 优先用 cookie 自己的 Domain：带 Domain 属性的 cookie
        // 拿一个不匹配的 host 去 set，WebKit 会丢掉。
        String host = ck.getDomain();
        if (host != null) {
            while (host.startsWith(".")) host = host.substring(1);
        }
        if (host == null || host.isEmpty()) host = fallbackHost;
        if (host == null || host.isEmpty()) return null;

        StringBuilder sb = new StringBuilder(name).append('=').append(val);
        String dom = ck.getDomain();
        if (dom != null && !dom.isEmpty()) sb.append("; Domain=").append(dom);
        String path = ck.getPath();
        sb.append("; Path=").append((path == null || path.isEmpty()) ? "/" : path);
        if (ck.getSecure()) sb.append("; Secure");
        if (ck.getMaxAge() > 0) sb.append("; Max-Age=").append(ck.getMaxAge());

        // 统一 https，理由见类注释第 2 条
        return new Pair("https://" + host + "/", sb.toString(), name);
    }

    /** 结果里有没有叫这个名字的 cookie。用来判断「身份证还在不在」。 */
    public static boolean has(List<Pair> pairs, String name) {
        if (pairs == null || name == null) return false;
        for (Pair p : pairs) {
            if (name.equals(p.name)) return true;
        }
        return false;
    }
}
