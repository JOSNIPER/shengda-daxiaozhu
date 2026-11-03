package com.hobson.hangyuantong;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.security.MessageDigest;

/**
 * 应用内下载更新 + 拉起系统安装器。
 *
 * 为什么不自己写 HTTP 下载：系统的 DownloadManager 自带断点续传、通知栏进度、
 * 失败重试、等 WiFi 这些，而且**不受 WebView 生命周期影响** —— 用户关掉 App
 * 下载照样在跑。自己写一个 HttpURLConnection 循环，上面这些全得重来一遍，
 * 还容易在后台被杀掉时把文件写坏。
 *
 * 🔴 两个关键点，改动前先看：
 *
 * 1. **不用 FileProvider**。Android 7+ 不许把 file:// 交给别的应用
 *    （会抛 FileUriExposedException），标准解法是 androidx 的 FileProvider ——
 *    但我们这个项目是**手工打包、没有 Gradle、没有 androidx**，引不进来。
 *    `getUriForDownloadedFile(id)` 返回的 content://downloads/... 自带读权限，
 *    可以直接交给安装器。这是这条路能走通的原因。
 *
 * 2. **不能静默安装**。Android 不允许 App 自己装自己（除非设备管理员/系统应用），
 *    最后一步一定弹系统安装器让用户点「安装」。所以这里最多做到
 *    「下载完自动把安装界面拉起来」，不能做到「点一下就装好了」。
 *
 * 安全：只认 http/https 的地址、只认纯 ASCII 的 .apk 文件名。
 * 地址和文件名都来自版本清单，而清单是网络上下来的 —— 不校验的话，
 * 一份被改过的清单就能让 App 往任意路径写文件。
 */
public class UpdateDownloader {

    private final Context ctx;

    public UpdateDownloader(Context ctx) {
        this.ctx = ctx;
    }

    private DownloadManager dm() {
        return (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
    }

    private static String err(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", msg == null ? "未知错误" : msg);
            return o.toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"error\":\"unknown\"}";
        }
    }

    /** 只放行 `hangyuantong-0.1.1.apk` 这种形状，挡掉 `../../` 和奇怪字符。 */
    private static String safeName(String name) {
        String n = (name == null) ? "" : name.trim();
        if (!n.matches("[A-Za-z0-9._-]{1,80}")) return null;
        if (!n.endsWith(".apk")) return null;
        if (n.contains("..")) return null;
        return n;
    }

    // ---------------------------------------------------------------- 下载

    /**
     * 入队一个下载。返回 {"ok":true,"id":12} 或 {"ok":false,"error":"..."}。
     *
     * 文件落在 `getExternalFilesDir()`（应用私有目录）—— 那里**不需要存储权限**，
     * 卸载 App 时会一起清掉，也不会在用户的相册/下载目录里留垃圾。
     */
    @JavascriptInterface
    public String start(String url, String name) {
        try {
            String u = (url == null) ? "" : url.trim();
            if (!(u.startsWith("http://") || u.startsWith("https://"))) {
                return err("下载地址不是 http/https");
            }
            String n = safeName(name);
            if (n == null) return err("安装包文件名不合法：" + name);
            DownloadManager d = dm();
            if (d == null) return err("系统下载服务不可用");

            // 🔴 同名文件必须先删：目标文件已存在时 DownloadManager 会直接报错，
            //    表现成「点了更新没反应」，而且不留任何提示 —— 很难查。
            File dir = ctx.getExternalFilesDir(null);
            if (dir != null) {
                File old = new File(dir, n);
                if (old.exists() && !old.delete()) {
                    return err("旧的安装包删不掉，可能被别的程序占着");
                }
            }

            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(u));
            r.setTitle("航院通更新");
            r.setDescription("正在下载新版本");
            r.setMimeType("application/vnd.android.package-archive");
            // 通知栏留一条：用户关掉 App / 切到后台也能看到进度和结果
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
            r.setDestinationInExternalFilesDir(ctx, null, n);
            r.setAllowedOverMetered(true);      // 允许流量下载：校园网外的用户只有流量
            r.setAllowedOverRoaming(false);     // 漫游时不下，那是真烧钱

            long id = d.enqueue(r);
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("id", id);
            return o.toString();
        } catch (Throwable t) {
            return err(String.valueOf(t));
        }
    }

    /**
     * 查进度。status 用的是系统的原值，别自己改编号：
     * 1 等待 / 2 下载中 / 4 暂停 / 8 完成 / 16 失败。
     * reason 只在失败时有意义（404、存储不够、用户取消……）。
     */
    @JavascriptInterface
    public String state(long id) {
        Cursor c = null;
        try {
            DownloadManager d = dm();
            if (d == null) return err("系统下载服务不可用");
            c = d.query(new DownloadManager.Query().setFilterById(id));
            if (c == null || !c.moveToFirst()) return err("找不到这个下载任务（可能被系统清了）");
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            int reason = 0;
            int ri = c.getColumnIndex(DownloadManager.COLUMN_REASON);
            if (ri >= 0) reason = c.getInt(ri);
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("status", status);
            o.put("bytes", done);
            o.put("total", total);
            o.put("reason", reason);
            return o.toString();
        } catch (Throwable t) {
            return err(String.valueOf(t));
        } finally {
            if (c != null) c.close();
        }
    }

    /**
     * 算下载文件的 SHA-256（小写十六进制）。读不到就返回空串。
     *
     * 🔴 空串和「算出来不一样」是两件事：前者是「没读到」，后者是「包被换了」。
     *    界面要分开说，别把「没读到」说成「校验通过」。
     */
    @JavascriptInterface
    public String sha256(long id) {
        InputStream in = null;
        try {
            DownloadManager d = dm();
            if (d == null) return "";
            Uri u = d.getUriForDownloadedFile(id);
            if (u == null) return "";
            in = ctx.getContentResolver().openInputStream(u);
            if (in == null) return "";
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            byte[] h = md.digest();
            StringBuilder sb = new StringBuilder(h.length * 2);
            for (byte b : h) {
                // 必须 & 0xff：byte 是带符号的，直接格式化负数会出 "ffffff80" 这种
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Throwable t) {
            return "";
        } finally {
            if (in != null) {
                try { in.close(); } catch (Throwable t) { }
            }
        }
    }

    /** 取消并删掉已下载的文件。 */
    @JavascriptInterface
    public void cancel(long id) {
        try {
            DownloadManager d = dm();
            if (d != null) d.remove(id);
        } catch (Throwable t) { }
    }

    // ---------------------------------------------------------------- 安装

    /**
     * 有没有「安装未知应用」的权限。
     * Android 8.0 以前没有这个开关，一律当作有（装了就能装）。
     *
     * 查询本身失败时返回 true：查不出来不代表没权限，让安装那一步去撞，
     * 撞出来的错误更准 —— 在这里拦下来只会给一句含糊的「没权限」。
     */
    @JavascriptInterface
    public boolean canInstall() {
        if (Build.VERSION.SDK_INT < 26) return true;
        try {
            return ctx.getPackageManager().canRequestPackageInstalls();
        } catch (Throwable t) {
            return true;
        }
    }

    /** 跳到「安装未知应用」的授权页。 */
    @JavascriptInterface
    public void installSettings() {
        try {
            Intent it;
            if (Build.VERSION.SDK_INT >= 26) {
                it = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + ctx.getPackageName()));
            } else {
                it = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            }
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(it);
        } catch (Throwable t) {
            // 有些 ROM 没有这个页面 —— 静默失败，界面已经给了文字说明
        }
    }

    /**
     * 把下载好的包交给系统安装器。
     * 返回 "" = 已拉起；"need-permission" = 缺「安装未知应用」；其余是失败原因。
     */
    @JavascriptInterface
    public String install(long id) {
        try {
            if (!canInstall()) return "need-permission";
            DownloadManager d = dm();
            if (d == null) return "fail: 系统下载服务不可用";
            Uri u = d.getUriForDownloadedFile(id);
            if (u == null) return "fail: 还没下载完，或者文件已被系统清理";
            Intent it = new Intent(Intent.ACTION_VIEW);
            it.setDataAndType(u, "application/vnd.android.package-archive");
            // getUriForDownloadedFile 返回的 URI 本来就带读权限，
            // 但部分 ROM 会忽略这个隐式授权，显式再要一次不亏。
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(it);
            return "";
        } catch (Throwable t) {
            return "fail: " + t;
        }
    }
}
