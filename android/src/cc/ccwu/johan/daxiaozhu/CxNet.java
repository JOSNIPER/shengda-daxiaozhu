package cc.ccwu.johan.daxiaozhu;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.CookieStore;
import java.net.HttpCookie;
import java.net.URI;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 学习通那边只有三件事非在 Java 层做不可，其余全在 native.js 里。
 *
 * 为什么只搬这三件：项目一直是「Java 只管发请求和带 cookie，解析全在 JS」。
 * WebView 有 DOMParser，按属性取节点比在 Java 里手写 HTML 解析稳得多，
 * 而且解析逻辑只有一份（对照测试见 _lab/out/check_cx_js.py）。
 *
 *   1. AES 加密密码 —— JS 侧能做，但 `crypto.subtle` 要求安全上下文，
 *      万一哪天页面加载方式一变就静默不可用。JCE 没这个前提，稳。
 *   2. 导出 cookie —— `java.net.CookieManager` 的罐子只有 Java 能摸到。
 *      App 一退出罐子就空了，不导出的话每次开 App 都要重新登录。
 *   3. 还原 cookie —— 同上。
 *
 * ================================================================
 * 🔴 为什么必须用 CookieManager 而不是自己拼 Cookie 头
 * ================================================================
 * 学习通把 cookie 分在两个域上：
 *
 *   passport2.chaoxing.com : JSESSIONID、route        ← 只属于登录站
 *   .chaoxing.com          : UID、_uid、_d、vc3、uf、cx_p_token、
 *                            p_auth_token、xxtenc、fid、DSSTASH_LOG
 *
 * 把前两个也发给 mooc1.chaoxing.com，服务端会拿着不属于它的 session 去查用户，
 * 回一句「无效的用户！」—— 而且 HTTP 状态码是 200，看着像成功。
 * 用 CookieManager 它自己按 domain 匹配，天然不会串。
 */
public final class CxNet {

    /** 16 字节。学习通前端 login.js 里写死的，同时当 key 和 iv。 */
    private static final String AES_KEY = "u2oh6Vu^HWe4_AES";

    private CxNet() {
    }

    // ------------------------------------------------------------ AES

    /**
     * 照抄学习通 login.js 的 encryptByAES：AES-CBC + PKCS7，key 当 iv，输出 Base64。
     *
     * 🔴 iv 是固定的 ⇒ 同一个密码每次算出同一串密文。这不是偷懒，是照抄前端：
     *    服务端就按这个解。改成随机 iv 会直接登录失败（密码对也不认）。
     *
     * 🔴 这是「小端 + 无填充」的**反面**：门户那边是裸 RSA 不填充，
     *    这里却是标准 PKCS7。两套系统两套规矩，别互相套。
     */
    public static String aesB64(String pwd) throws Exception {
        byte[] k = AES_KEY.getBytes("UTF-8");
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(k, "AES"),
                new IvParameterSpec(k));
        return Base64.encodeToString(c.doFinal(pwd.getBytes("UTF-8")), Base64.NO_WRAP);
    }

    // ------------------------------------------------------------ cookie 存取

    /**
     * 把罐子里**所有** cookie 导成 JSON。
     *
     * 每条带 domain：`.chaoxing.com` 这种跨子域的必须原样保留 ——
     * 丢了 Domain 就退化成「仅此域名」，换个二级域就看不见了，
     * 表现是「明明登录过，进去又说没登录」。
     */
    public static String dumpCookies() {
        JSONArray arr = new JSONArray();
        try {
            CookieStore store = store();
            if (store == null) return arr.toString();
            List<HttpCookie> all = store.getCookies();
            if (all == null) return arr.toString();
            for (HttpCookie ck : all) {
                if (ck == null) continue;
                String name = ck.getName();
                String val = ck.getValue();
                if (name == null || name.isEmpty() || val == null) continue;
                // Max-Age = 0 是「删掉这条」的指令，不是一条 cookie
                if (ck.getMaxAge() == 0) continue;
                JSONObject o = new JSONObject();
                o.put("name", name);
                o.put("value", val);
                o.put("domain", ck.getDomain() == null ? "" : ck.getDomain());
                o.put("path", ck.getPath() == null ? "/" : ck.getPath());
                o.put("secure", ck.getSecure());
                arr.put(o);
            }
        } catch (Throwable ignored) {
            // 导出失败就当没存过 —— 用户下次重登一次，不影响别的功能
        }
        return arr.toString();
    }

    /**
     * 把 JSON 还原进罐子。
     *
     * @return 还原成功的条数（调用方用它判断「到底有没有登录态」）。
     *
     * 🔴 单条坏了必须 continue，不能让一条异常带走整批 ——
     *    否则一条残缺 cookie 就等于「全部没还原」，看起来又像登录失效。
     */
    public static int loadCookies(String json) {
        if (json == null || json.isEmpty()) return 0;
        int n = 0;
        try {
            CookieStore store = store();
            if (store == null) return 0;
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String name = o.optString("name", "");
                String val = o.optString("value", "");
                if (name.isEmpty() || val.isEmpty()) continue;
                try {
                    HttpCookie ck = new HttpCookie(name, val);
                    String dom = o.optString("domain", "");
                    if (!dom.isEmpty()) ck.setDomain(dom);
                    String p = o.optString("path", "/");
                    ck.setPath(p.isEmpty() ? "/" : p);
                    ck.setSecure(o.optBoolean("secure", false));

                    // 还原时给一个「属于这个 domain」的地址。
                    // 带 Domain 属性的 cookie 拿不匹配的 host 去 add，会被直接丢掉。
                    String host = dom;
                    while (host.startsWith(".")) host = host.substring(1);
                    if (host.isEmpty()) continue;
                    store.add(new URI("https://" + host + "/"), ck);
                    n++;
                } catch (Throwable ignored) {
                    // 这一条坏了，接着下一条
                }
            }
        } catch (Throwable ignored) {
            // 整段 JSON 坏了：返回已经还原的条数
        }
        return n;
    }

    /** 罐子里有没有登录态。看 UID —— 那是 `.chaoxing.com` 域上跨站有效的那份。 */
    public static boolean hasLogin() {
        try {
            CookieStore store = store();
            if (store == null) return false;
            List<HttpCookie> all = store.getCookies();
            if (all == null) return false;
            for (HttpCookie ck : all) {
                if (ck == null) continue;
                if (!"UID".equals(ck.getName()) && !"_uid".equals(ck.getName())) continue;
                String v = ck.getValue();
                if (v != null && !v.isEmpty()) return true;
            }
        } catch (Throwable ignored) {
            // 罐子摸不到 = 当作没登录
        }
        return false;
    }

    private static CookieStore store() {
        CookieHandler h = CookieHandler.getDefault();
        if (!(h instanceof CookieManager)) return null;
        return ((CookieManager) h).getCookieStore();
    }
}
