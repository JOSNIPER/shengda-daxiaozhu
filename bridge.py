"""达小助 · 手机端本地服务（网页版第二轨）

作用：把教务系统（只支持 HTTP、且有同源限制）的数据，转成手机浏览器能直接用的 JSON。

为什么需要它：
    手机浏览器出于安全策略，不允许网页直接请求 `http://jw.shengda.edu.cn:8090`
    （跨域 + 混合内容两条都会拦）。所以由这个本地服务替手机去登录、抓数据，
    再以同源接口交给手机页面。**凭据不出这台电脑**，也不经过任何第三方服务器。

数据走的是哪一轨：
    教务那部分用 `kingo.KingoClient`（青果/升达），和 APK 里 native.js 的
    青果镜像是同构的两条路，逐字段对拍见 tests/w5_parity_compare.py。
    🔴 以前这里挂的是 `eams.EamsClient`（郑航教务），等于「网页版会把升达
    学生的账密发往郑航」；W4 那批只换了 JS 轨，Python 轨一直没换 —— 现在补上。

运行：
    python bridge.py            # 默认 8788 端口，连真实升达教务（config/shengda.json）
    python bridge.py --port 9000
    python bridge.py --config x.json   # 换配置（tableId/menucode 抓包后另存一份）
    python bridge.py --mock            # 连本机离线 mock，免账号联调界面

凭据保存：Windows DPAPI 加密后存到 %LOCALAPPDATA%\\DaXiaoZhu\\account.bin
    只有当前 Windows 账户能解开，拷走文件也解不开。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
from ctypes import wintypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
WEB_DIR = HERE / "web"
DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "DaXiaoZhu"
ACCOUNT_FILE = DATA_DIR / "account.bin"
TOKEN_FILE = DATA_DIR / "token.txt"

sys.path.insert(0, str(HERE))
import chaoxing  # noqa: E402
import eams  # noqa: E402  只借它的 EamsError/字段映射，教务取数已改走 kingo
import kingo  # noqa: E402
import portal  # noqa: E402
# notice 暂不 import：那六张公告源表全是郑航部门站，路由停用后没有可达路径
# （见 /api/notice 那里）。升达 CMS 抓包确认后重写 notice.py 再接回来。


# ------------------------------------------------------------------ DPAPI

class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes):
    buf = ctypes.create_string_buffer(data, len(data))
    return _BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


def _dpapi(data: bytes, protect: bool) -> bytes:
    if os.name != "nt":
        raise OSError("DPAPI 只在 Windows 上可用")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    inb, _keep = _blob(data)
    outb = _BLOB()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(inb), "DaXiaoZhu", None, None, None, 0, ctypes.byref(outb))
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(outb.pbData, outb.cbData)
    finally:
        kernel32.LocalFree(outb.pbData)


def save_account(username: str, password: str) -> bool:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        raw = json.dumps({"u": username, "p": password}).encode("utf-8")
        ACCOUNT_FILE.write_bytes(_dpapi(raw, True))
        return True
    except Exception:  # noqa: BLE001
        return False


def load_account() -> tuple[str, str] | None:
    try:
        raw = _dpapi(ACCOUNT_FILE.read_bytes(), False)
        d = json.loads(raw.decode("utf-8"))
        if d.get("u") and d.get("p"):
            return d["u"], d["p"]
    except Exception:  # noqa: BLE001
        pass
    return None


def clear_account() -> None:
    try:
        ACCOUNT_FILE.unlink()
    except FileNotFoundError:
        pass


def load_token() -> str:
    try:
        t = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if t:
            return t
    except FileNotFoundError:
        pass
    t = secrets.token_urlsafe(16)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(t, encoding="utf-8")
    return t


# ------------------------------------------------------------------ 门户凭据
#
# 🔴 达小助改造（W6 安全收口，本任务补齐 Python 轨）：下面这一整段是**郑航**
#   门户（rhmh.zua.edu.cn / sfrz.zua.edu.cn，RSA 账密 + 算术验证码）的本机凭据
#   层，`portal.Portal` 里的地址也还是那一套。升达门户 my.shengda.edu.cn 走
#   CASTGC，机制不同，等阶段2抓包重写。
#   ⇒ /api/portal/* 这一组路由已全部短路（见 Handler 里「门户未适配本校系统」），
#     这段存/取函数因此暂无路由可达。留着是因为升达适配完要用的还是同一套
#     DPAPI 落盘形状；真正的兜底是 kingo._assert_allowed_host() 那类域名白名单。
#
# 门户会话和教务**不是同一套**，所以单独存一份，不塞进 account.bin。
#
# 存 cookie，**也存密码**（2026-10-22 加的）：
#   · cookie 里那张 CASTGC（身份证）是日常用的 —— 门票过期能自己换新的，
#     只要身份证还活着就不用再登录。
#   · 但身份证本身撑不过 7.2 小时（学校那边的硬限制），过期就只能重新登录，
#     而门户登录要「密码 + 算术验证码」。
#   · 密码存在本机之后，过期重登**只剩一道算术题要人算** —— 这是人能省的最大值，
#     因为验证码故意不能被自动识别（错 5 次锁号，见 portal.py 顶部那段）。
# 仍然走 DPAPI：文件里是密文，且**接口永不回明文**（只回「存的是哪个学号」）。

PORTAL_FILE = DATA_DIR / "portal.bin"

_PORTAL = None
_PORTAL_LOCK = threading.Lock()


def load_portal() -> dict | None:
    try:
        raw = _dpapi(PORTAL_FILE.read_bytes(), False)
        d = json.loads(raw.decode("utf-8"))
        if isinstance(d, dict) and d.get("cookies"):
            return d
    except Exception:  # noqa: BLE001
        pass
    return None


def portal_saved_pwd() -> tuple[str, str]:
    """本机存着的那份门户密码。返回 `(密码, 学号)`，没存就是两个空串。

    🔴 这个函数的返回值**绝不许**出现在任何 HTTP 响应里。对外只说
    「存过没有、存的是哪个学号」（见 /api/portal/status），密码只在
    「用户把密码框留空」时由服务端自己取用。
    """
    acc = load_portal() or {}
    pwd = str(acc.get("pwd") or "")
    user = str(acc.get("pwdUser") or "")
    return pwd, user


def save_portal(data: dict) -> bool:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PORTAL_FILE.write_bytes(_dpapi(json.dumps(data).encode("utf-8"), True))
        return True
    except Exception:  # noqa: BLE001
        return False


def clear_portal() -> None:
    try:
        PORTAL_FILE.unlink()
    except FileNotFoundError:
        pass


CX_FILE = DATA_DIR / "chaoxing.bin"

_CX = None
_CX_LOCK = threading.Lock()
# 扫描进度。60 秒的事不能同步等 HTTP，所以起后台线程 + 前端轮询。
_CX_SCAN = {"state": "idle", "at": 0, "i": 0, "n": 0, "course": "", "phase": "",
            "err": "", "kind": ""}


def load_cx() -> dict | None:
    try:
        raw = _dpapi(CX_FILE.read_bytes(), False)
        d = json.loads(raw.decode("utf-8"))
        if isinstance(d, dict) and d.get("cookies"):
            return d
    except Exception:  # noqa: BLE001
        pass
    return None


def save_cx(data: dict) -> bool:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CX_FILE.write_bytes(_dpapi(json.dumps(data).encode("utf-8"), True))
        return True
    except Exception:  # noqa: BLE001
        return False


def clear_cx() -> None:
    try:
        CX_FILE.unlink()
    except FileNotFoundError:
        pass


# 上次扫描结果的落盘副本。
#
# 🔴 为什么必须有它：扫描结果以前只活在内存里（chaoxing._LAST），服务一重启
#    就「还没查过」，用户得再等 90 秒、再发一百多个请求才看得见自己的作业。
#    APK 那边一直是用 localStorage 存的，只有网页版漏了 —— 两边体验不该不一样。
#
# 里面是课名、作业标题、签到记录，属于个人信息，所以和账号一样过 DPAPI，
# 不裸存 JSON。「断开学习通」时一起删。
CX_CACHE_FILE = DATA_DIR / "cx_cache.bin"


def load_cx_cache() -> None:
    """把上次的结果读回内存。读不出来就当没有，绝不抛。"""
    try:
        raw = _dpapi(CX_CACHE_FILE.read_bytes(), False)
        d = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return
    # 坏形状先判 isinstance：老版本/半截文件都不该让服务起不来
    if not isinstance(d, dict) or not isinstance(d.get("items"), list):
        return
    # 🔴 at 必须一起恢复。漏了它，三天前的作业会显示成「刚查的」。
    chaoxing.cache_set(d, at=d.get("at"))


def save_cx_cache() -> None:
    data = chaoxing.cache_get()
    if not isinstance(data, dict):
        return
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CX_CACHE_FILE.write_bytes(_dpapi(json.dumps(data).encode("utf-8"), True))
    except Exception:  # noqa: BLE001
        # 存不下就只活这一次 —— 不影响本次显示，下次冷启动重新扫一遍
        pass


def clear_cx_cache() -> None:
    try:
        CX_CACHE_FILE.unlink()
    except FileNotFoundError:
        pass


def get_cx() -> chaoxing.Chaoxing:
    """那个唯一的学习通会话。

    cookie 存本机（DPAPI），所以登录一次能用很久，不用每次输密码。
    """
    global _CX
    with _CX_LOCK:
        if _CX is None:
            saved = load_cx() or {}
            _CX = chaoxing.Chaoxing(saved.get("cookies") or [])
            _CX.user = str(saved.get("user") or "")
        return _CX


def cx_scan_start(force: bool = False, pre_courses=None,
                  active_names=None) -> bool:
    """启动后台扫描。已经在扫就返回 False（不排队、不并发，风控怕这个）。

    `force` = 无视「已结课」，全部重扫。给用户手动点「全部重扫」用 ——
    判据一定会错，必须留一个「我不信你，全查一遍」的出口。

    `pre_courses` = 调用方已经探到的课程列表（见 /api/cx/scan 的注释）。
    传了就不再重复取一次。

    `active_names` = 本学期教务课表里的课名。见 `Chaoxing.scan` 的注释：
    命中白名单的课永不降频；空 / None ⇒ 一律不降频（宁可慢，别漏作业）。
    """
    with _CX_LOCK:
        if _CX_SCAN["state"] == "scanning":
            return False
        _CX_SCAN.update({"state": "scanning", "at": 0, "i": 0, "n": 0,
                         "course": "", "phase": "", "err": "", "kind": ""})

    def run() -> None:
        try:
            cx = get_cx()
            # 🔴 这里不再用 has_login() 一票否决 —— 理由见 /api/cx/scan。
            #    真没登录的话，下面 cx.scan() 的第一步（courses()）会抛
            #    CxError(kind="auth")，文案比「还没登录」更有用。
            def prog(i: int, n: int, title: str, phase: str = "") -> None:
                _CX_SCAN.update({"i": i, "n": n, "course": title, "phase": phase})

            data = cx.scan(on_progress=prog,
                           # 上一份结果里的 rest 就是「哪些课已经结课」的记忆。
                           # 不传的话每次都当第一次扫，永远判不出结课。
                           prev_rest=(chaoxing.cache_get() or {}).get("rest"),
                           force=force,
                           pre_courses=pre_courses,
                           active_names=active_names)
            chaoxing.cache_set(data)
            # 落盘：服务重启以后还能秒开，不用再等 90 秒
            save_cx_cache()
            # 扫描过程中 cookie 可能续期，顺手存回本机
            saved = load_cx() or {}
            saved["cookies"] = cx.dump_cookies()
            saved["user"] = cx.user or saved.get("user") or ""
            save_cx(saved)
            _CX_SCAN.update({"state": "done", "at": data["at"], "err": "", "kind": ""})
        except chaoxing.CxError as exc:
            # kind 要传出去：前端靠它判断「是不是登录态失效」，
            # 失效且本机存着密码时直接给一个「重连」按钮 ——
            # 用户 2026-10-22 要的就是「后续再看不需要输账号密码」。
            _CX_SCAN.update({"state": "error", "err": str(exc)[:140],
                             "kind": exc.kind or ""})
        except Exception as exc:  # noqa: BLE001
            _CX_SCAN.update({"state": "error",
                             "err": ("扫描出错：%s" % exc)[:140], "kind": ""})

    threading.Thread(target=run, daemon=True).start()
    return True


def reset_cx() -> None:
    """断开学习通：内存会话、本机 cookie、扫描状态、落盘的作业缓存一起清。"""
    global _CX
    with _CX_LOCK:
        _CX = None
        _CX_SCAN.update({"state": "idle", "at": 0, "i": 0, "n": 0,
                         "course": "", "phase": "", "err": "", "kind": ""})
    chaoxing.cache_clear()
    clear_cx_cache()


def get_portal() -> portal.Portal:
    """拿那个唯一的门户会话。

    为什么必须唯一：验证码的 uid 只存在对象内存里（前端不回传），
    每次新建一个实例就等于「刚拿的验证码马上丢了」。
    """
    global _PORTAL
    with _PORTAL_LOCK:
        if _PORTAL is None:
            _PORTAL = portal.Portal()
        cli = _PORTAL
        # 内存里的会话是空的、盘上却有凭据 ⇒ 补一次。
        # 正常流程里两者不会脱节（只有这套接口自己写这个文件），
        # 但「手动删了又放回去」「上一版程序留下的文件」都可能造成脱节，
        # 而症状是「明明存着却说没连」，非常难查。这里顺手兜住。
        if not cli.has_ticket() and not cli.has_id():
            acc = load_portal()
            if acc:
                cli.load(acc.get("cookies") or [])
                cli.user = str(acc.get("user") or "")
        return cli


def reset_portal() -> None:
    global _PORTAL
    with _PORTAL_LOCK:
        _PORTAL = None


# ------------------------------------------------------------------ 同步

class Service:
    """串行化对教务系统的访问，避免手机连点把学校服务器打疼。"""

    def __init__(self, config: dict = None, cfg_desc: str = "") -> None:
        self.lock = threading.Lock()
        self.cfg = config          # None ⇒ KingoClient 自己读 config/shengda.json
        self.cfg_desc = cfg_desc or "config/shengda.json（默认）"
        self.client = self._new_client()
        self.last_error = ""
        # 验证码 uid 只活在内存里，**不回给页面** —— 页面只负责让用户看图填答案。
        # 一次性：登录请求发出后立刻清掉，同一张图不会被用第二次。
        self.captcha_uid = ""
        self.captcha_at = 0.0

    def _new_client(self) -> kingo.KingoClient:
        """换一个干净会话。每次登录、每次「会话过期后重登」都新建一个 ——
        青果的 JSESSIONID 和菜单上下文绑在一起，复用半死的会话只会一路
        「无效访问请求」。"""
        return kingo.KingoClient(config=self.cfg)

    def captcha(self) -> dict:
        """取一张验证码。返回 {img(data URL), ttl_sec}；uid 留在 self 里。"""
        with self.lock:
            self.client = self._new_client()
            c = self.client.captcha()
            self.captcha_uid = c["uid"]
            self.captcha_at = time.time()
            return {"img": c["img"], "ttl_sec": c.get("ttl_sec", 30)}

    def sync(self, username: str, password: str, code: str = "") -> dict:
        with self.lock:
            self.client = self._new_client()
            uid = self.captcha_uid
            self.captcha_uid = ""      # 用掉就作废，避免同一张图重放
            self.client.login(username, password, code=code, uid=uid)
            profile = self.client.profile()
            tt = self.client.timetable()
            # 成绩单独兜一层。**没有成绩不是错误** —— 新生第一学期历年成绩
            # 页就是空表。2026-11-01 之前这里是裸调用，一抛就把整次绑定带走了：
            # 账号密码全对，界面却写「没解析出成绩，可能登录态过期了」。
            # 现在解析失败也照样交出课表和学籍，只把原因写进 grades.error，
            # 让成绩页自己说「没读到」，别让课表陪着一起打不开。
            try:
                gr = self.client.grades()
            except Exception as e:  # noqa: BLE001
                gr = {"summary": [], "overall": None, "courses": [],
                      "error": str(e)}
            # 考试表：学校没排考时返回空列表（published=False），不是错误。
            # 单独兜一层：万一考试页结构变了，不能把整个同步拖垮。
            try:
                ex = self.client.exams()
            except Exception as e:  # noqa: BLE001
                ex = {"exams": [], "published": False, "error": str(e)}
            # 学期列表是「考试页能选学期」的前提，但它属于附加信息：
            # 取不到时照样把考试数据交出去，只是把原因写进 semestersError，
            # 让界面说「学期列表没取到」——不能安静地只剩一个学期。
            try:
                ex["semesters"] = self.client.semesters()
            except Exception as e:  # noqa: BLE001
                ex["semesters"] = []
                ex["semestersError"] = str(e)
            # 培养计划只影响「学分进度」那一块。取不到不能让整次同步失败，
            # 但**也不能安静地变成「没有培养计划」** —— 那会把「没读到」说成
            # 「学校没给你排计划」，学生看了会以为出了大事。原因原样带回去。
            try:
                pl = self.client.plan()
            except Exception as e:  # noqa: BLE001
                pl = {"total": 0, "cats": [], "courses": [], "subs": [],
                      "specials": [], "error": str(e)}
            self.last_error = ""
            return {
                "ok": True,
                "syncedAt": int(time.time()),
                "profile": profile,
                "semester": tt["semester"],
                "unitCount": tt["unitCount"],
                "totalWeeks": tt["totalWeeks"],
                "courses": tt["courses"],
                # 🔴 0.1.10：课表页头部的「课程门数 / 课程学分」。
                #    教务一直有（课表页第一行就写着「课程学分：23.5」），
                #    网页版和 APK 共用同一套 app.js，所以这里也要传 ——
                #    不传的话网页版的课程页会跟 APK 显示得不一样。
                "credits": tt.get("credits", ""),
                "courseCount": tt.get("courseCount", 0),
                "grades": gr,
                "exams": ex,
                "plan": pl,
            }

    # -- 考试页按学期查 ------------------------------------------------
    #
    # 这两个接口都要重新走一次教务系统，但**不能**每次切学期都重新登录：
    # 登录本身要 3 秒（登录页要求「别点太快」），再加页面抓取，一次切换就
    # 七八秒，手指点两下就以为卡死了。所以复用上一次同步留下的会话。
    #
    # 🔴 会话失效时**只重登一次**：重登还失败就如实报错，别循环打学校服务器。

    def _with_client(self, fn, username: str, password: str):
        with self.lock:
            if not self.client.logged_in:
                self.client = self._new_client()
                self.client.login(username, password)
            try:
                return fn(self.client)
            except eams.EamsError:
                # 会话过期 / 服务端重启 ⇒ 换一个干净会话再来一次
                self.client = self._new_client()
                self.client.login(username, password)
                return fn(self.client)

    def exams_for(self, username: str, password: str, semester_id: str) -> dict:
        return self._with_client(lambda c: c.exams(semester_id), username, password)

    def semesters_for(self, username: str, password: str) -> list:
        return self._with_client(lambda c: c.semesters(), username, password)

    def timetable_for(self, username: str, password: str,
                      semester_id: str, semester_name: str = "") -> dict:
        """某一学期的课表（2026-10-31 加，课表页翻历史学期用）。

        和考试页那套同一个思路：复用上一次同步的会话，不重新登录。
        """
        return self._with_client(
            lambda c: c.timetable(semester_id, semester_name), username, password)

    def todo_for(self, username: str, password: str) -> dict:
        return self._with_client(lambda c: c.todo(), username, password)

    # -- 空闲教室 ------------------------------------------------------
    #
    # 这两个都要先把 project 上下文摸出来（见 eams.EamsClient._ensure_project），
    # 所以必须走同一个 client，别每次新建。

    def room_options_for(self, username: str, password: str) -> dict:
        return self._with_client(lambda c: c.room_options(), username, password)

    def free_rooms_for(self, username: str, password: str, **kw) -> dict:
        return self._with_client(lambda c: c.free_rooms(**kw), username, password)


SERVICE = Service()


def free_room_max_periods():
    """空闲教室的每日节数上限。没配置就是 None（那时只判「正整数、起不晚于止」）。
    走 SERVICE 当前那份配置，所以 `--mock` / `--config` 换的是哪份，这里就是哪份。"""
    cfg = SERVICE.cfg or kingo.load_config()
    return (cfg.get("free_room") or {}).get("max_periods")


# ------------------------------------------------------------------ HTTP

class Handler(SimpleHTTPRequestHandler):
    server_version = "DaXiaoZhu/0.1"
    token = ""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB_DIR), **kw)

    # -- 界面文件每次都回源问一次
    # 🔴 不加这条会踩到「代码改了、页面没变」：SimpleHTTPRequestHandler 发
    #    Last-Modified，浏览器于是直接吃本地缓存，连 304 都不问。症状是点了
    #    按钮没反应、而磁盘上那份 app.js 明明是对的 —— 排查的人会先怀疑自己
    #    改错了地方。`no-cache` 只是「必须问一下」，命中 304 时只多一个来回。
    REVALIDATE = (".html", ".js", ".css")

    def end_headers(self):
        try:
            if self.path.split("?")[0].endswith(self.REVALIDATE):
                self.send_header("Cache-Control", "no-cache")
        except Exception:  # noqa: BLE001  头部的事不该把响应弄坏
            pass
        super().end_headers()

    # -- 小工具
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return {}
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _authed(self) -> bool:
        # 手机首次扫码进来时 URL 上带 ?k=token，页面会把它存进 localStorage
        # 用 compare_digest 而不是 ==：== 会在第一个不同的字符处提前返回，
        # 理论上能靠响应时间一个字符一个字符试出来。局域网里不太现实，
        # 但换成常量时间比较是零成本的。
        hdr = self.headers.get("X-Token") or ""
        if hdr and secrets.compare_digest(hdr, self.token):
            return True
        q = parse_qs(urlparse(self.path).query)
        got = (q.get("k", [""])[0] or "")
        return bool(got) and secrets.compare_digest(got, self.token)

    def log_message(self, fmt, *args):  # 别刷屏
        # 🔴 这里的 args 不保证是字符串：走 send_error() 的时候 args[0] 是
        #    HTTPStatus 枚举（不是 str），直接 `in` 会抛
        #    TypeError: argument of type 'HTTPStatus' is not iterable。
        #    异常发生在 send_response 之后、响应体写出之前 ⇒ 浏览器只看到
        #    ERR_EMPTY_RESPONSE（一次 404 favicon 就能把整页加载打断）。
        #    所以先 str() 再判断，并且整段吞异常 —— 日志永远不该弄坏响应。
        try:
            first = str(args[0]) if args else ""
            if "/api/" in first:
                return
            line = fmt % args
            # 🔴 别把访问口令写进日志。手机首次打开是 `GET /?k=<token>`，
            #    原样打出来就等于把凭据贴在屏幕上 —— 截个图、投个屏就漏了。
            #    token 是唯一凭证，拿到就能读课表和成绩。
            line = re.sub(r"([?&]k=)[^&\s\"]+", r"\1***", line)
            sys.stderr.write("  %s\n" % line)
        except Exception:  # noqa: BLE001
            pass

    # -- 路由
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self._json({"ok": True, "version": "0.1"})
            return
        if path == "/api/state":
            if not self._authed():
                self._json({"ok": False, "error": "token"}, 403)
                return
            acc = load_account()
            self._json({
                "ok": True,
                "bound": acc is not None,
                "username": acc[0] if acc else "",
                # 和 APK 那边保持同一套取值：none / ok / broken。
                # 电脑上的凭据是 DPAPI 加密的单文件，没有「存着但解不开」这种
                # 中间态 —— 解不开就是读不到，等同 none。
                "credState": "ok" if acc else "none",
            })
            return
        if path == "/api/captcha":
            # 🔴 2026-11-03 新增：升达 CAS 开了验证码（/loginType 返回 isVerifyCode=1），
            #   **第一次登录就要带**，不是错几次才出现。
            #   uid 留在后端内存里（Service.captcha_uid），页面只拿图片 ——
            #   页面拿不到 uid，就没有「重放同一张验证码」的可能。
            if not self._authed():
                self._json({"ok": False, "error": "token"}, 403)
                return
            try:
                c = SERVICE.captcha()
            except eams.EamsError as exc:
                self._json({"ok": False, "error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "拿不到验证码：%s" % exc})
                return
            self._json({"ok": True, "img": c["img"], "ttl": c.get("ttl_sec", 30)})
            return
        if path == "/api/room-options":
            if not self._authed():
                self._json({"ok": False, "error": "token"}, 403)
                return
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            try:
                out = SERVICE.room_options_for(acc[0], acc[1])
            except eams.EamsError as exc:
                self._json({"ok": False, "error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "连接教务系统失败：%s" % exc})
                return
            out["ok"] = True
            self._json(out)
            return
        # 「该办的事」：选课 / 评教 / 免听 / 免修的开放状态。
        # 走 GET（app.js 的 api() 不带 body 时发 GET），四页串起来十几秒，
        # 所以是用户点一下才查，不进 /api/sync。
        if path == "/api/todo":
            if not self._authed():
                self._json({"ok": False, "error": "token"}, 403)
                return
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            try:
                out = SERVICE.todo_for(acc[0], acc[1])
            except eams.EamsError as exc:
                self._json({"ok": False, "error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "连接教务系统失败：%s" % exc})
                return
            out["ok"] = True
            out["at"] = int(time.time())
            self._json(out)
            return
        # 校园公告：🔴 达小助改造（W6，和 native.js 同步停用）。
        # notice.py 里的六张源表全是郑航的部门站（www/jwc/tuanwei/hqfwzgs/
        # xxglzx.zua.edu.cn），升达的公告 CMS 还没抓包确认。
        # 返回空列表而不是报错：公告页显示「暂无」，不会把错误说成事实。
        if path == "/api/notice":
            self._json({"ok": True, "at": int(time.time()), "cached": True,
                        "total": 0, "items": [], "failed": [], "sources": 0,
                        "note": "升达公告源未配置（待抓包确认学校CMS）"})
            return
        # 单篇正文：以前靠 notice.py 里的域名白名单兜住「不替陌生人访问内网」，
        # 现在源表整张作废，直接停用，不给它任何出网机会。
        if path == "/api/notice/detail":
            self._json({"ok": False, "error": "升达公告源未配置（待抓包确认学校CMS）"})
            return
        # ---------------- 智慧门户：一卡通 + 办事应用 ----------------
        # 🔴 达小助改造（W6 安全收口）：这一组路由**全部短路**，与 native.js
        #   的 /api/portal/* 逐条同构。底座走的是郑航 sfrz/rhmh（RSA 账密 +
        #   算术验证码），而 app.js「连接门户」弹层会把用户输入的学号密码原样
        #   送进来 —— 留着这条路径，升达学生的凭据就发到别的学校去了。
        #   升达门户 my.shengda.edu.cn 走 CASTGC，机制不同，等阶段2抓包重写。
        #   ⚠️ Python 轨没有 guardUrl 那种运行期兜底（portal.py 的地址是硬编码
        #   的），所以「路由不可达」就是这道闸本身 —— 没换掉 portal.py 之前别接回。
        if path == "/api/portal/status":
            self._json({"ok": False, "unsupported": True,
                        "error": "门户未适配本校系统（待校内抓包确认学校用哪套门户）"})
            return
        if path == "/api/portal/captcha":
            self._json({"ok": False, "unsupported": True, "needCaptcha": False,
                        "error": "门户未适配本校系统，不需要验证码"})
            return
        if path == "/api/portal/card":
            self._json({"ok": False, "error": "一卡通未适配本校系统（待抓包确认）"})
            return
        if path == "/api/portal/apps":
            self._json({"ok": False, "error": "办事应用未适配本校系统（待抓包确认）"})
            return
        # 给某个办事系统换一张 CAS 票：换票要先有门户会话，门户没适配就停在这里。
        # 将来接升达门户时白名单规则照旧 —— 这张票**等于一次登录态**，
        # 必须先解析 host 再比，别用 startswith 比字符串
        # （`https://shengda.edu.cn.evil.com` 也满足 startswith）。
        if path == "/api/portal/ticket":
            self._json({"ok": False, "unsupported": True,
                        "error": "门户未适配本校系统，暂不提供换票"})
            return
        # ---------------- 学习通（作业待办） ----------------
        # 只读。不签到、不刷课、不自动答题、不代交。
        if path == "/api/cx/status":
            acc = load_cx()
            self._json({
                "ok": True,
                "linked": bool(acc),
                "user": str((acc or {}).get("user") or ""),
                # 本机存着学习通密码 ⇒ 登录态过期后点一下就能重连，不用再输
                "saved": bool((acc or {}).get("pass")),
                # 能不能一键重连：账号和密码都得在。只存了 cookie 的话
                # 过期后没别的办法，只能让用户重新输一次。
                "canRelink": bool((acc or {}).get("pass") and (acc or {}).get("user")),
                "scan": dict(_CX_SCAN),
                "age": chaoxing.cache_age(),
            })
            return
        if path == "/api/cx/todo":
            # 扫描要 60 秒，不能同步等。这里只读缓存 + 报进度，前端自己轮询。
            self._json({
                "ok": True,
                "scan": dict(_CX_SCAN),
                "age": chaoxing.cache_age(),
                "data": chaoxing.cache_get(),
            })
            return
        if path in ("/", "/index.html"):
            self.path = "/index.html"
        elif path == "/favicon.ico":
            # 浏览器无条件会来要 favicon，直接复用现有图标，
            # 免得控制台每次多一条 404 噪音。
            self.path = "/icon-180.png"
        elif path.startswith("/api/"):
            # 🔴 /api/* 不管什么原因没匹配上，都必须回 JSON。
            #    否则会掉进下面的静态文件处理，返回一个 HTML 404 页面，
            #    手机端 res.json() 抛 "Unexpected token '<'"，完全看不出是
            #    「路径写错了」还是「服务端坏了」。
            #    常见情形：把只收 POST 的 /api/sync 用 GET 请求了。
            self._json({"ok": False, "error": "接口不存在或请求方式不对"}, 404)
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if not self._authed():
            self._json({"ok": False, "error": "token"}, 403)
            return
        data = self._body()

        if path == "/api/login":
            user = (data.get("username") or "").strip()
            pwd = data.get("password") or ""
            # 验证码答案由人算出来填；uid 在后端内存里，不从请求体取（见 /api/captcha）
            code = str(data.get("code") or "").strip()
            if not user or not pwd:
                self._json({"ok": False, "error": "请填学号和密码"})
                return
            if not code:
                # 学校 CAS 第一次登录就要验证码。先在前端拦一道，
                # 省掉一次必然失败的请求（每次失败都在动那个错误计数器）。
                self._json({"ok": False, "error": "请填验证码", "needCaptcha": True})
                return
            try:
                payload = SERVICE.sync(user, pwd, code=code)
            except eams.EamsError as exc:
                out = {"ok": False, "error": str(exc)}
                if getattr(exc, "kind", "") == "code":
                    # 验证码错了/过期 ⇒ 界面换一张，别让人对着死图重试
                    out["needCaptcha"] = True
                    out["captchaStale"] = True
                self._json(out)
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "连接教务系统失败：%s" % exc})
                return
            if data.get("remember", True):
                # 空串 = 存好了，其余是原因（和 APK 的 saveCred 同构）。
                # 以前这里是布尔值，界面只能说「没存上」，说不出为什么。
                payload["saved"] = "" if save_account(user, pwd) else \
                    "fail: 凭据文件写不进去（检查数据目录权限）"
            self._json(payload)
            return

        if path == "/api/sync":
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            try:
                payload = SERVICE.sync(acc[0], acc[1])
            except eams.EamsError as exc:
                # 密码错 / 改过密码 ⇒ authFail，界面据此请用户重新输入。
                # 其他失败（网络、改版）不要让人白输一遍。
                out = {"ok": False, "error": str(exc)}
                if getattr(exc, "kind", "") == "auth":
                    out["authFail"] = True
                if getattr(exc, "kind", "") == "code":
                    # 🔴 CASTGC 过期后自动重登会撞上验证码 —— 这不是「密码错了」，
                    #   是「这次需要人算一道题」。标出来，界面去要验证码，
                    #   别把用户推到「重新绑定」那条更重的路上。
                    out["needCaptcha"] = True
                self._json(out)
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "连接教务系统失败：%s" % exc})
                return
            self._json(payload)
            return

        if path == "/api/unbind":
            clear_account()
            self._json({"ok": True})
            return

        # ---- 智慧门户登录 / 断开 ----
        # 🔴 达小助改造（W6 安全收口）：登录这一条是全部残留里最危险的一条 ——
        #   app.js 的「连接门户」弹层把学号、密码、验证码原样 POST 到这里，
        #   底座会拿去打郑航 sfrz.zua.edu.cn 的 RSA 登录接口。升达学生的凭据
        #   不能发给别的学校，所以在换成升达门户之前先短路（形状与 native.js 一致）。
        #   ⚠️ 这里**不读 data**：密码停在这个请求体里，不进任何函数、不落盘。
        if path == "/api/portal/login":
            self._json({"ok": False, "unsupported": True,
                        "error": "门户未适配本校系统：不会把学号密码发往任何第三方"})
            return

        if path == "/api/portal/logout":
            # 只做本地清理 —— 门户那边不需要「退出登录」，我们只是不再用这个 cookie。
            # 这条留着还有个用处：老版本在这台电脑上存过的郑航门户凭据（portal.bin）
            # 能被清掉，而它现在已经没有任何路由可读它了。
            clear_portal()
            reset_portal()
            self._json({"ok": True})
            return

        # ---- 学习通登录 / 扫描 / 断开 ----
        if path == "/api/cx/login":
            user = (data.get("user") or "").strip()
            pwd = data.get("pass") or ""
            # 密码留空 = 「用本机存着的那份」。登录态过期后重连时，
            # 人只需要点一下，不用再翻密码。
            used_saved = False
            if not pwd:
                saved = load_cx() or {}
                if not saved.get("pass"):
                    self._json({"ok": False, "error": "账号和密码都要填"})
                    return
                # 🔴 存的是另一个账号的密码就**不许**拿去试：
                #    学习通会把 needVcode 撞成 1，之后要人做滑块。
                if saved.get("user") and user and saved["user"] != user:
                    self._json({"ok": False,
                                "error": "本机存的是 %s 的学习通密码，跟这个账号对不上，请手动输入"
                                         % saved["user"]})
                    return
                user = user or str(saved.get("user") or "")
                pwd = str(saved.get("pass") or "")
                used_saved = True
            if not user or not pwd:
                self._json({"ok": False, "error": "账号和密码都要填"})
                return
            cx = get_cx()
            try:
                cx.login(user, pwd)
            except chaoxing.CxError as exc:
                # 🔴 一次失败就回，绝不重试：重试会把 needVcode 撞成 1，
                #    之后就得人做滑块验证，越弄越糟。
                # 用着本机存的密码、服务端又明确说账号密码不对 ⇒ 把那份删掉。
                # 不删的话下次还会拿一个错密码去撞。
                if used_saved and exc.kind == "auth":
                    save_cx({"cookies": (load_cx() or {}).get("cookies") or [],
                             "user": user})
                    self._json({"ok": False, "error": str(exc) + " —— 本机存的那份密码已经删掉，请手动输入一次",
                                "kind": exc.kind, "pwdStale": True})
                    return
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "登录出错：%s" % exc})
                return
            ok = save_cx({"cookies": cx.dump_cookies(), "user": user, "pass": pwd})
            self._json({"ok": True, "user": user,
                        "saved": "" if ok else "fail: 凭据文件写不进去"})
            return

        if path == "/api/cx/scan":
            # 🔴 不再用「cookie 里有没有 UID」一票否决。
            #
            #    2026-10-25 用户报：「明明已经登录了学习通，点重新检查的时候
            #    还是说学习通未登录」。用**名字**判登录态本身就是错判据 ——
            #    本项目红线写着「「登录成功」= 需要登录的接口返回 200，
            #    不是 cookie 在不在」。cookie 名一改、或某条被丢掉，
            #    会话明明还活着，这里也会说「未登录」。
            #
            #    改法：没有 UID 也照样问一次服务器 —— 问的就是扫描本来要做的
            #    第一件事（拿课程列表），所以**不多发一个请求**，拿到就喂给扫描。
            #    与 web/native.js 的 /api/cx/scan 逐条对齐。
            pre_courses = None
            cx0 = get_cx()
            if not cx0.has_login():
                try:
                    pre_courses = cx0.courses()
                except chaoxing.CxError as exc:
                    self._json({"ok": False, "error": str(exc),
                                "kind": exc.kind or "net",
                                # auth 才让人去重连；net（限流/断网）说「未登录」是误导
                                "needLogin": (exc.kind == "auth")})
                    return
            started = cx_scan_start(force=bool(data.get("force")),
                                    pre_courses=pre_courses,
                                    # 本学期教务课表里的课名。0.39.0 用它当
                                    # 「这门课现在真的在上」的白名单 —— 命中
                                    # 的课永不降频。前端拿不到课表就不传，
                                    # 后端见空列表一律不降频。
                                    active_names=data.get("activeNames"))
            self._json({"ok": True, "started": started, "scan": dict(_CX_SCAN)})
            return

        if path == "/api/cx/logout":
            clear_cx()
            reset_cx()
            self._json({"ok": True})
            return

        # 考试页「选学期」用。学期 id 由 /api/sync 或 /api/semesters 给，
        # 手机端只负责把用户点的那个原样送回来。
        if path == "/api/exams":
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            sid = str(data.get("semesterId") or "").strip()
            # 青果的学期 id 是 `2026-2027/1` 这种形态（郑航是纯数字 257），
            # 不能再按 isdigit 判 —— 那样每次切学期都被这句「学期编号不对」挡死。
            # 规则与 native.js 的 /api/exams 一致：空 = 当前学期，非空只收
            # [字母数字._/-]。不猜、不兜底：形状不对就直接说。
            if sid and not re.fullmatch(r"[\w.\-/]+", sid):
                self._json({"ok": False, "error": "学期编号不对"})
                return
            try:
                out = SERVICE.exams_for(acc[0], acc[1], sid)
            except eams.EamsError as exc:
                self._json({"ok": False, "error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "连接教务系统失败：%s" % exc})
                return
            out["ok"] = True
            self._json(out)
            return

        if path == "/api/semesters":
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            try:
                sems = SERVICE.semesters_for(acc[0], acc[1])
            except eams.EamsError as exc:
                self._json({"ok": False, "error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "连接教务系统失败：%s" % exc})
                return
            self._json({"ok": True, "semesters": sems})
            return

        # 课表页翻历史学期（2026-10-31 加）。
        # 学期 id 由 /api/sync 或 /api/semesters 给，前端原样送回来；
        # `semesterName` 只是让界面能立刻显示规范名字，不传也不影响取数。
        if path == "/api/timetable":
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            sid = str(data.get("semesterId") or "").strip()
            # 同上：青果的学期 id 不是纯数字（见 /api/exams 那段注释）。
            if sid and not re.fullmatch(r"[\w.\-/]+", sid):
                # 不猜：id 不合法就直说，别默默返回当前学期的课表冒充用户点的那一学期
                self._json({"ok": False, "error": "学期编号不对"})
                return
            name = str(data.get("semesterName") or "").strip()
            try:
                out = SERVICE.timetable_for(acc[0], acc[1], sid, name)
            except eams.EamsError as exc:
                self._json({"ok": False, "error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "连接教务系统失败：%s" % exc})
                return
            out["ok"] = True
            out["semesterId"] = sid
            self._json(out)
            return

        # 空闲教室：先拿下拉选项（教室类型 / 校区 / 教学楼），再查。
        # ⚠️ 这个走 GET（见 do_GET 里同名分支）。以前把它写在 do_POST 里，
        #    网页版发的是 GET ⇒ 一律 404「接口不存在」，而 APK 侧走 native.js
        #    根本没经过这里 —— 只有电脑上打开才会坏，最容易漏掉。
        if path == "/api/free-rooms":
            acc = load_account()
            if not acc:
                self._json({"ok": False, "error": "还没绑定账号", "needBind": True})
                return
            # 🔴 参数一个都不猜：日期必须是 YYYY-MM-DD，节次必须是正整数、
            #    开始不晚于结束。写错了直接回错，别默默按「今天第 1 节」查一遍
            #    再冒充用户要的。
            day = str(data.get("date") or "").strip()
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
                self._json({"ok": False, "error": "日期格式不对（要 YYYY-MM-DD）"})
                return
            try:
                p1 = int(data.get("periodBegin") or 0)
                p2 = int(data.get("periodEnd") or 0)
            except (TypeError, ValueError):
                self._json({"ok": False, "error": "节次要是数字"})
                return
            # 上限来自配置，不写死 12（那是郑航的节数）。升达每日几节要等阶段2
            # 抓包填进 config 的 free_room.max_periods，填了才按它判 ——
            # 规则与 native.js 的 freeRooms() 逐条一致。
            mx = free_room_max_periods()
            if mx and not (1 <= p1 <= p2 <= int(mx)):
                self._json({"ok": False, "error": "节次要在 1~%s 之间，且开始不晚于结束" % mx})
                return
            if not (1 <= p1 <= p2):
                self._json({"ok": False, "error": "节次范围不对"})
                return
            try:
                out = SERVICE.free_rooms_for(
                    acc[0], acc[1],
                    date_begin=day, date_end=day,
                    period_begin=p1, period_end=p2,
                    building_id=str(data.get("buildingId") or ""),
                    campus_id=str(data.get("campusId") or ""),
                    type_id=str(data.get("typeId") or ""),
                    seats=str(data.get("seats") or ""),
                    name=str(data.get("name") or ""),
                )
            except eams.EamsError as exc:
                self._json({"ok": False, "error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "连接教务系统失败：%s" % exc})
                return
            out["ok"] = True
            self._json(out)
            return

        self._json({"ok": False, "error": "not found"}, 404)


# ------------------------------------------------------------------ 启动

def lan_ips() -> list[str]:
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:  # noqa: BLE001
        pass
    return sorted(ips)


def print_qr(url: str) -> None:
    # 打不出二维码不是致命问题（网址上面已经印了），但也不能一声不吭 ——
    # 用户会以为「本来就该没有二维码」，然后一直在找。
    try:
        import qrcode  # type: ignore
    except ImportError:
        print("  （没装 qrcode，跳过二维码。想要就 pip install qrcode）")
        return
    try:
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make()
        qr.print_ascii(invert=True)
    except Exception as exc:  # noqa: BLE001
        print("  （二维码生成失败：%s —— 用上面的网址手输即可）" % exc)


# ------------------------------------------------------------------ 教务配置
#
# 网页版的教务轨现在只认 kingo.KingoClient，配置就从它那份单一真源来：
#   默认          config/shengda.json     —— 域名是真的，tableId 全是 TBD_*
#   --config PATH 自己指定一份            —— 阶段2抓到真实值后另存一份用这个
#   --mock [PORT] config/build.json       —— 整条链打到本机离线 mock
#
# 🔴 为什么要有 --mock：正式表 tableId/menucode 得在校内抓包才能填（阶段2），
#    在那之前网页版一绑号就只能报「还没配置」，界面根本没东西可看。
#    mock 用的就是 kingo.py 那套真实形状（GBK、head_/trN_、错误页 1098 字节），
#    所以界面跑通了不等于线上能跑通 —— 它验的是 UI，不是接口。

MOCK_CFG_FILE = HERE / "config" / "build.json"
#: build.json 里给手机用的占位符；APK 打包时换成局域网 IP，本机跑换成 127.0.0.1
MOCK_TOKEN = "__PC_IP__:8090"


def load_mock_config(port: int) -> dict:
    raw = MOCK_CFG_FILE.read_text(encoding="utf-8")
    return json.loads(raw.replace(MOCK_TOKEN, "127.0.0.1:%d" % port))


def make_service(args) -> "Service":
    if args.mock:
        return Service(load_mock_config(args.mock),
                       "config/build.json（本机离线 mock，端口 %d）" % args.mock)
    if args.config:
        return Service(kingo.load_config(args.config), args.config)
    return Service(None, "config/shengda.json（默认）")


def source_note(svc: "Service") -> list:
    """启动时把「教务这一轨现在连着谁、能不能读出数据」说清楚。
    撞在界面上才知道，比打印两行难查得多。

    🔴 配置里的 pages 现在有条 ``_comment`` 字符串，遍历时**必须跳过非字典项**，
    否则启动就 AttributeError（2026-11-03 踩过：桥起不来，页面白屏，
    浏览器那头只看到 switchTab 未定义）。
    """
    cfg = svc.cfg or kingo.load_config()
    pages = cfg.get("pages") or {}
    ready, unsupported = [], []
    for k, v in pages.items():
        if not isinstance(v, dict):       # _comment 之类的说明项
            continue
        if (v.get("kind") or "") == "unsupported":
            unsupported.append(k)
        elif v.get("path"):
            ready.append(k)
    out = ["教务轨：  青果 kingo.py → %s" % cfg["jw"]["base"],
           "配置：    %s" % svc.cfg_desc]
    if ready:
        out.append("已适配：  %s（入口来自校内抓包实测）" % " / ".join(sorted(ready)))
    if unsupported:
        out.append("未适配：  %s —— 界面上会如实说『还没适配』，不编数据。"
                   % " / ".join(sorted(unsupported)))
    if not ready:
        out.append("⚠️ 一个页面都没配上：只能登录，取不到任何数据。")
        out.append("   想先跑通界面：python 离线mock_ui跑通/mock_server.py 8090")
        out.append("   再用 python bridge.py --mock 起本服务。")
    return out


def main() -> int:
    global SERVICE
    ap = argparse.ArgumentParser(description="达小助手机端本地服务（网页版第二轨）")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--no-qr", action="store_true")
    ap.add_argument("--config", metavar="PATH",
                    help="教务配置 JSON（默认 config/shengda.json，正式值等阶段2抓包）")
    ap.add_argument("--mock", nargs="?", const=8090, type=int, metavar="PORT",
                    help="连本机离线 mock 教务（默认 8090），免校园网/免账号跑通界面")
    args = ap.parse_args()

    if not WEB_DIR.is_dir():
        print("找不到 web/ 目录，脚本可能被挪动了")
        return 2

    SERVICE = make_service(args)
    token = load_token()
    Handler.token = token
    # 上次扫的作业读回来：冷启动也能立刻看到列表（标着「X 分钟前查的」），
    # 而不是一句「还没查过」再加 90 秒。
    load_cx_cache()

    try:
        srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    except OSError as exc:
        print("端口 %d 起不来：%s" % (args.port, exc))
        print("换一个端口：python bridge.py --port 8899")
        return 3

    ips = lan_ips() or ["127.0.0.1"]
    print()
    print("  达小助 · 手机端服务已启动")
    print("  " + "-" * 46)
    print("  电脑上打开：  http://127.0.0.1:%d/?k=%s" % (args.port, token))
    for ip in ips:
        print("  手机上打开：  http://%s:%d/?k=%s" % (ip, args.port, token))
    print("  " + "-" * 46)
    for line in source_note(SERVICE):
        print("  " + line)
    print("  手机要和这台电脑连同一个 Wi-Fi。")
    print("  连不上最常见的原因是校园网开了「客户端隔离」，")
    print("  改成用电脑开热点给手机连最省事（README.md 里有对照表）。")
    print("  数据目录：%s" % DATA_DIR)
    print("  按 Ctrl+C 停止。")
    print()
    if not args.no_qr:
        print_qr("http://%s:%d/?k=%s" % (ips[0], args.port, token))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
