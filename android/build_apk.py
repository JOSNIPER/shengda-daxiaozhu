"""把 mobile/ 打包成 APK「达小助 0.1.0」。

不用 Gradle —— 本机没有 Android Studio，而且这点代码用不上它。
走官方那套命令行：aapt2 → javac → d8 → zipalign → apksigner。

前置（都在 _lab/out/sdk/ 下，已验证）：
    zulu17.60.17-ca-jdk17.0.16-win_x64/   JDK 17
    android-14/                           build-tools 34（aapt2/d8/zipalign/apksigner）
    android-13/android.jar                platform-33

用法：
    python build_apk.py                # 打包
    python build_apk.py --clean        # 先清 build/ 再打
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent          # mobile/android
MOBILE = HERE.parent                            # mobile
WEB = MOBILE / "web"
BUILD = HERE / "build"
DIST = HERE / "dist"

# Android SDK / JDK 的位置。本机放在工作区的 _lab/out/sdk 下，**不随仓库分发**。
# 🔴 这里以前写的是本机绝对路径（带用户目录的那种）。公开仓库里带着用户名
#    既没意义（别人用不了这个路径），也没必要露。现在按「环境变量 → 仓库相对位置」找。
def _sdk_dir():
    env = os.environ.get("DZX_SDK")
    if env:
        return Path(env)
    near = MOBILE.parent / "_lab" / "out" / "sdk"
    if near.exists():
        return near
    sys.exit("找不到 Android SDK：把 DZX_SDK 指到 build-tools 那层，"
             "或者按文件开头「前置」里说的放到 _lab/out/sdk")

SDK = _sdk_dir()
# 🔴 必须是 JDK 17：更高版本 javac 给匿名内部类写的调试信息会让 d8/R8 崩
#    （NullPointerException: "<parameter1>" is null，极具误导性）。
def _jdk_dir():
    env = os.environ.get("DZX_JDK")
    if env:
        return Path(env)
    for cand in sorted(SDK.glob("jdk*17*")) + sorted(SDK.glob("zulu17*")):
        if (cand / "bin" / "javac.exe").exists():
            return cand
    fixed = SDK / "zulu17.60.17-ca-jdk17.0.16-win_x64"
    if (fixed / "bin" / "javac.exe").exists():
        return fixed
    sys.exit("找不到 JDK 17：设 DZX_JDK 指向 JDK 根目录，或放进 SDK 目录下（jdk*17*）")

JDK = _jdk_dir()
BT = SDK / "android-14"
ANDROID_JAR = SDK / "android-13" / "android.jar"

JAVA = JDK / "bin" / "java.exe"
JAVAC = JDK / "bin" / "javac.exe"
KEYTOOL = JDK / "bin" / "keytool.exe"

# 国内线路（腾讯云 CNB）上这个包的地址前缀 —— 换它等于换一条下载线路，
# 只在这里写一次，version.json 和发布页都从这儿派生。
# ⚠️ W9 待办：用户的 GitHub 用户名与 Cloudflare 加速域名确认后填入；
#    在此之前自更新入口在 app.js 里已被注释禁用，本常量不会生效。
GITHUB_USER = os.environ.get("DZX_GH_USER", "TBD-github-user")
UPD_PAGE_BASE = "https://johan.ccwu.cc/daxiaozhu"          # 用户域名(CNAME 到 Pages,待配置)
CNB_APK_BASE = ("https://maven.cnb.cool/" + GITHUB_USER + "/campus-login"
                "/-/packages/cnb/daxiaozhu")
CNB_APK_NAME = "达小助.apk"

VERSION_NAME = "0.1.9"
VERSION_CODE = 69
PKG = "cc.ccwu.johan.daxiaozhu"
MIN_SDK = 23
TARGET_SDK = 33

# 🔴 keystore 必须放持久化工作区（原设计在 SDK.parent 下，云端环境会连 SDK 一起被清 ——
#    丢 keystore = 老用户永远无法覆盖升级）。丢了要重新签名等于发新 App。
KEYSTORE = Path(os.environ.get("DZX_KEYSTORE",
                              str(MOBILE.parent / "keystore" / "daxiaozhu.keystore")))
KS_PASS = os.environ.get("DZX_KS_PASS") or "CHANGE_ME_dzx_dev_only"


def run(cmd, cwd=None, quiet=False):
    """跑一条命令。🔴 用 subprocess 而不是 shell 拼串 —— 路径里有空格，
    拼串在 Windows 上会被拆错。"""
    if not quiet:
        print("  $ " + " ".join(str(c) for c in cmd[:3]) + (" …" if len(cmd) > 3 else ""))
    p = subprocess.run([str(c) for c in cmd], cwd=str(cwd) if cwd else None,
                       capture_output=True)
    out = (p.stdout + p.stderr).decode("utf-8", "replace")
    if p.returncode != 0:
        print(out[-4000:])
        raise SystemExit("命令失败（%d）：%s" % (p.returncode, cmd[0]))
    return out


def check_env():
    for f in (JAVA, JAVAC, BT / "aapt2.exe", BT / "zipalign.exe",
              BT / "lib" / "d8.jar", BT / "lib" / "apksigner.jar", ANDROID_JAR):
        if not f.exists():
            raise SystemExit("缺文件：%s\n（先跑 _lab/out/sdk 的下载步骤）" % f)


def check_version_consistency():
    """版本号散落在几个地方，改一处漏三处是迟早的事，所以打包前硬核对。

    🔴 唯一来源是 web/app.js 里的 APP_VERSION / APP_CODE（界面自己也读它）。
       本文件的 VERSION_NAME 是「有意的第二份」—— 两边对不上就停下，
       免得打出一个「设置里显示 0.1.1、装上去是 0.1.0」的包。

    核对：
    1. app.js 的 APP_VERSION / APP_CODE == 本文件的 VERSION_NAME / VERSION_CODE
    2. MainActivity 的 User-Agent 后缀 == VERSION_NAME
    3. version.json（更新清单）== VERSION_NAME / VERSION_CODE
    4. strings.xml 里的 app_name（不含版本，但顺手确认没被改成别的名字）
    """
    bad = []

    js = (WEB / "app.js").read_text(encoding="utf-8")
    m = re.search(r"^const APP_VERSION = '([^']+)';", js, re.M)
    got = m.group(1) if m else "(找不到)"
    if got != VERSION_NAME:
        bad.append("app.js 的 APP_VERSION 是 %s，应为 %s" % (got, VERSION_NAME))
    m = re.search(r"^const APP_CODE = (\d+);", js, re.M)
    gotc = int(m.group(1)) if m else -1
    if gotc != VERSION_CODE:
        bad.append("app.js 的 APP_CODE 是 %s，应为 %d" % (gotc, VERSION_CODE))

    java = (HERE / "src" / "cc" / "ccwu" / "johan" / "daxiaozhu" / "MainActivity.java").read_text(encoding="utf-8")
    m = re.search(r"DaXiaoZhu/([\d.]+)", java)
    got = m.group(1) if m else "(找不到)"
    if got != VERSION_NAME:
        bad.append("MainActivity 的 UA 后缀是 %s，应为 %s" % (got, VERSION_NAME))

    strings = (HERE / "res" / "values" / "strings.xml").read_text(encoding="utf-8")
    if 'name="app_name">达小助<' not in strings:
        bad.append("strings.xml 里的 app_name 不是「达小助」")

    # 更新清单是发布出去的东西，版本号错了会让所有人的「检查更新」失灵
    mf = MOBILE / "version.json"
    if mf.exists():
        try:
            info = json.loads(mf.read_text(encoding="utf-8"))
        except Exception as e:
            bad.append("version.json 解析失败：%s" % e)
            info = {}
        if info:
            if info.get("version") != VERSION_NAME:
                bad.append("version.json 的 version 是 %s，应为 %s"
                           % (info.get("version"), VERSION_NAME))
            if info.get("code") != VERSION_CODE:
                bad.append("version.json 的 code 是 %s，应为 %d"
                           % (info.get("code"), VERSION_CODE))
    else:
        bad.append("缺 version.json（检查更新靠它）")

    # 界面里的版本那一行还在不在（不写死数字，但占位元素不能被删）
    html = (WEB / "index.html").read_text(encoding="utf-8")
    if 'id="meVersion"' not in html:
        bad.append("index.html 里没有 id=meVersion（「我的 → 检查更新」那一行）")

    if bad:
        print("  [!!] 版本/名称不一致：")
        for b in bad:
            print("       " + b)
        raise SystemExit("先统一版本号再打包（这是有意的门槛，别跳过）")
    print("  版本一致性 OK（%s / code %d）" % (VERSION_NAME, VERSION_CODE))


def read_notes() -> list[str]:
    """更新内容：mobile/RELEASE-NOTES.md 里 **本版本那一节** 的「- 」行。

    单独一个文件而不是写在代码里：发版时只想改文案，不想碰打包脚本。
    🔴 只取 `## <当前版本>` 到下一个 `##` 之间的行 —— 不然历史版本的
       更新内容会一起被塞进弹窗，用户会看到一堆早就装上的旧改动。
    """
    p = MOBILE / "RELEASE-NOTES.md"
    if not p.exists():
        return []
    out = []
    inside = False
    for lineno, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        s = line.strip()
        if s.startswith("## "):
            inside = (s[3:].strip().split()[0] if s[3:].strip() else "") == VERSION_NAME
            continue
        if inside and s.startswith("- "):
            out.append(s[2:].strip())
            continue
        # 🔴 本版本段落里出现「既不是标题也不是 - 开头」的非空行 ⇒ 报错。
        #    这条是踩出来的：把一条更新说明折成两行写，第二行会被静默丢掉，
        #    用户看到的弹窗就少半句话（"……打印中心这些，" 后面直接没了）。
        #    静默截断比写错更坏 —— 写错能看出来，截断看着像「本来就这么多」。
        if inside and s:
            raise SystemExit(
                "RELEASE-NOTES.md 第 %d 行：\n    %s\n"
                "这一行会被丢掉（只收以「- 」开头的行）。\n"
                "更新说明一条一行，别折行 —— 折了用户看到的弹窗就少半句。" % (lineno, line))
    return out


def write_manifest(apk: Path):
    """把 version.json 里的「事实」部分按这个 APK 重写。

    为什么由打包脚本写：size 和 sha256 只能从真实的包算，
    手填迟早会出现「清单里的 sha256 和下载到的文件对不上」。
    notes / 下载地址这些文案性的东西留在 version.json 里，这里只覆盖事实。
    """
    mf = MOBILE / "version.json"
    info = {}
    if mf.exists():
        try:
            info = json.loads(mf.read_text(encoding="utf-8"))
        except Exception:
            info = {}
    raw = apk.read_bytes()
    info["name"] = "达小助"
    info["version"] = VERSION_NAME
    info["code"] = VERSION_CODE
    info["size"] = len(raw)
    info["sha256"] = hashlib.sha256(raw).hexdigest()
    # 🔴 打包当天。以前**根本没人写这个字段** —— 它一路沿用上一版那天的值，
    #    于是今天打的包，清单里写着上一版的日期。字段在、值不对、零报错。
    #    （2026-10-27 南师侧在他那边翻出来的，同一个形状；我这边也一样，
    #      上一版 0.17.3 的日期是我手工改的，不是脚本写的。）
    info["date"] = datetime.date.today().isoformat()
    # 放在 /dl/ 子目录下：_headers 只支持尾部通配（/daxiaozhu/dl/*），
    # 放在 /daxiaozhu/ 根上就没法给 .apk 单独一条长缓存规则。
    info["apk"] = (UPD_PAGE_BASE + "/dl/daxiaozhu-" + VERSION_NAME + ".apk")
    # 国内线路（腾讯云 CNB）。和上面那条是**同一个包**，只是线路不同 ——
    # 主站走 Cloudflare，国内下起来慢，App 的「立即更新」优先用这条。
    # ⚠️ 这条地址要求**已经用 upload_cnb.py 传过这个版本**（见 README「发版顺序」）。
    # ⚠️ 拼的时候用 + 不用 %：`quote("达小助.apk")` 的结果里全是 `%E8%88%AA…`，
    #    拿去 `%` 格式化会被当成格式符，报 "not enough arguments for format string"。
    info["apk_cn"] = (CNB_APK_BASE + "/" + VERSION_NAME + "/"
                      + urllib.parse.quote(CNB_APK_NAME))
    info["page"] = UPD_PAGE_BASE + "/"
    notes = read_notes()
    if notes:
        info["notes"] = notes
    # 顺序固定，diff 好看
    order = ["name", "version", "code", "date", "size", "sha256",
             "apk", "apk_cn", "page", "notes"]
    out = {k: info[k] for k in order if k in info}
    for k in info:
        if k not in out:
            out[k] = info[k]
    mf.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n",
                  encoding="utf-8", newline="\n")
    print("  version.json 已更新（%s / code %d / %d 字节）"
          % (VERSION_NAME, VERSION_CODE, len(raw)))


def stage_assets():
    """把 web/ 整个搬进 assets/web/ —— APK 里的页面和网页版是同一份代码。"""
    dst = BUILD / "assets" / "web"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    for f in WEB.iterdir():
        if f.is_file():
            shutil.copy2(f, dst / f.name)
    names = sorted(x.name for x in dst.iterdir())
    print("  assets/web: " + ", ".join(names))
    # 🔴 达小助改造（W6）：native.js 运行时 fetch('config.json') 拿学校配置。
    #    优先用 config/build.json（打包专用，可指 mock），否则用 config/shengda.json。
    cfg_src = MOBILE / "config" / ("build.json" if (MOBILE / "config" / "build.json").exists()
                                   else "shengda.json")
    cfg_text = cfg_src.read_text(encoding="utf-8")
    # build.json 是模板：__PC_IP__ 换成构建机局域网 IP（手机连电脑跑 mock 用）
    if "__PC_IP__" in cfg_text:
        import socket
        ip = ""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 53)); ip = s.getsockname()[0]; s.close()
        except Exception:
            ip = "127.0.0.1"
        cfg_text = cfg_text.replace("__PC_IP__", ip)
        print("  [debug包] __PC_IP__ -> %s（手机需与本机同网段、mock 用 --lan 起）" % ip)
    (dst / "config.json").write_text(cfg_text, encoding="utf-8", newline="\n")
    print("  config.json <- %s" % cfg_src.name)
    # 网页版那套 Python 服务不在包里，但页面里引用了它 —— 少个文件会白屏，
    # 所以这里硬检查一遍必需文件，别等到手机上才发现。
    for need in ("index.html", "app.js", "app.css", "native.js",
                 "icon-180.png", "config.json"):
        if not (dst / need).exists():
            raise SystemExit("assets/web 里缺 %s" % need)


def compile_res():
    gen = BUILD / "gen"
    if gen.exists():
        shutil.rmtree(gen)
    gen.mkdir(parents=True)
    res_zip = BUILD / "res.zip"
    if res_zip.exists():
        res_zip.unlink()

    run([BT / "aapt2.exe", "compile", "--dir", HERE / "res", "-o", res_zip])

    out_apk = BUILD / "base.apk"
    # ⚠️ 编译产物要当**位置参数**传，不能用 -R：-R 是「覆盖层（overlay）」语义，
    #    会要求每条资源都去覆盖一个已存在的定义，于是每条都报
    #    "does not override an existing resource"。
    run([BT / "aapt2.exe", "link",
         "-o", out_apk,
         "-I", ANDROID_JAR,
         "--manifest", HERE / "AndroidManifest.xml",
         "-A", BUILD / "assets",
         "--java", gen,
         "--min-sdk-version", str(MIN_SDK),
         "--target-sdk-version", str(TARGET_SDK),
         "--version-code", str(VERSION_CODE),
         "--version-name", VERSION_NAME,
         res_zip])
    return out_apk, gen


def compile_java(gen):
    classes = BUILD / "classes"
    if classes.exists():
        shutil.rmtree(classes)
    classes.mkdir(parents=True)

    srcs = sorted(str(p) for p in (HERE / "src").rglob("*.java"))
    srcs += sorted(str(p) for p in gen.rglob("*.java"))
    print("  javac: %d 个源文件" % len(srcs))
    # --release 8：安卓这边只需要 Java 8 语法；d8 对更高版本的字节码支持有限。
    # 🔴 -encoding utf-8 不能省：Windows 上 javac 默认按 GBK 读源文件，
    #    源码里的中文注释会让它报一串「不可映射字符」并编译失败。
    run([JAVAC, "--release", "8", "-nowarn", "-encoding", "utf-8",
         "-classpath", ANDROID_JAR, "-d", classes] + srcs)
    return classes


def dex(classes):
    out = BUILD / "dex"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    # ⚠️ d8 不认「目录」这种输入（会报 Unsupported source file type），
    #    必须逐个 .class 传进去，或者先打成 jar。
    class_files = sorted(classes.rglob("*.class"))
    if not class_files:
        raise SystemExit("javac 没产出任何 .class")
    print("  待转 dex 的 class：%d 个" % len(class_files))
    run([JAVA, "-cp", BT / "lib" / "d8.jar", "com.android.tools.r8.D8",
         "--release", "--min-api", str(MIN_SDK), "--lib", ANDROID_JAR,
         "--output", out] + class_files)
    dx = out / "classes.dex"
    if not dx.exists():
        raise SystemExit("d8 没产出 classes.dex")
    print("  classes.dex %.1f KB" % (dx.stat().st_size / 1024))
    return dx


def add_dex(apk: Path, dx: Path) -> Path:
    """把 classes.dex 塞进 aapt2 产出的包里。
    （zipfile 追加即可；顺序不影响安装，zipalign 后面会统一对齐）"""
    with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
        z.write(dx, "classes.dex")
    return apk


def sign(apk: Path) -> Path:
    if not KEYSTORE.exists():
        KEYSTORE.parent.mkdir(parents=True, exist_ok=True)
        print("  生成签名密钥（只在本地，不进 git）：%s" % KEYSTORE)
        run([KEYTOOL, "-genkeypair", "-keystore", KEYSTORE,
             "-alias", "daxiaozhu", "-keyalg", "RSA", "-keysize", "2048",
             "-validity", "10000",
             "-storepass", KS_PASS, "-keypass", KS_PASS,
             "-dname", "CN=DaXiaoZhu, OU=Mobile, O=johan, L=Zhengzhou, ST=Henan, C=CN"])

    aligned = BUILD / "aligned.apk"
    run([BT / "zipalign.exe", "-f", "4", apk, aligned])

    DIST.mkdir(parents=True, exist_ok=True)
    out = DIST / ("daxiaozhu-%s.apk" % VERSION_NAME)
    if out.exists():
        out.unlink()
    run([JAVA, "-jar", BT / "lib" / "apksigner.jar", "sign",
         "--ks", KEYSTORE, "--ks-pass", "pass:" + KS_PASS,
         "--key-pass", "pass:" + KS_PASS,
         "--min-sdk-version", str(MIN_SDK),
         "--out", out, aligned])
    return out


def verify(apk: Path):
    print("\n校验")
    v = run([JAVA, "-jar", BT / "lib" / "apksigner.jar", "verify",
             "--print-certs", "--verbose", apk])
    for line in v.splitlines():
        if ("Verified using" in line or "Signer #1 certificate DN" in line
                or "SHA-256 digest" in line or "Number of signers" in line):
            print("  " + line.strip())

    badging = run([BT / "aapt2.exe", "dump", "badging", apk])
    for line in badging.splitlines():
        if (line.startswith("package:") or "application-label" in line
                or "sdkVersion" in line or "targetSdkVersion" in line
                or "launchable-activity" in line or "uses-permission" in line):
            print("  " + line.strip())

    # 关键内容在不在（装完打不开往往就是少了个 assets 文件）
    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
    need = ["classes.dex", "AndroidManifest.xml",
            "assets/web/index.html", "assets/web/app.js",
            "assets/web/native.js", "assets/web/app.css"]
    missing = [n for n in need if n not in names]
    print("  APK 内文件 %d 个" % len(names))
    if missing:
        raise SystemExit("APK 里缺：%s" % missing)
    print("  必需文件齐全（classes.dex / assets/web/*）")
    return apk


def main():
    ap = argparse.ArgumentParser(description="打包 达小助 APK")
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()

    check_env()
    check_version_consistency()
    if args.clean and BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir(parents=True, exist_ok=True)

    print("\n1/6 收网页资源")
    stage_assets()
    print("2/6 编译资源（aapt2）")
    apk, gen = compile_res()
    print("3/6 编译 Java")
    classes = compile_java(gen)
    print("4/6 转 dex（d8）")
    dx = dex(classes)
    print("5/6 打包 + 对齐 + 签名")
    add_dex(apk, dx)
    out = sign(apk)
    print("6/6 校验")
    verify(out)

    size = out.stat().st_size
    write_manifest(out)
    print("\n完成：%s（%.2f MB）" % (out, size / 1048576))
    print("  版本 %s（versionCode %d），包名 %s" % (VERSION_NAME, VERSION_CODE, PKG))
    return 0


if __name__ == "__main__":
    sys.exit(main())
