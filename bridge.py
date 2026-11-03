"""郑航课表 · 手机端本地服务

作用：把教务系统（只支持 HTTP、且有同源限制）的数据，转成手机浏览器能直接用的 JSON。

为什么需要它：
    手机浏览器出于安全策略，不允许网页直接请求 `http://jwglxt.zua.edu.cn`
    （跨域 + 混合内容两条都会拦）。所以由这个本地服务替手机去登录、抓数据，
    再以同源接口交给手机页面。**凭据不出这台电脑**，也不经过任何第三方服务器。

运行：
    python bridge.py            # 默认 8788 端口
    python bridge.py --port 9000

凭据保存：Windows DPAPI 加密后存到 %LOCALAPPDATA%\\ZuaTimetable\\account.bin
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
DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "ZuaTimetable"
ACCOUNT_FILE = DATA_DIR / "account.bin"
TOKEN_FILE = DATA_DIR / "token.txt"

sys.path.insert(0, str(HERE))
import chaoxing  # noqa: E402
import eams  # noqa: E402
import notice  # noqa: E402
import portal  # noqa: E402
import water  # noqa: E402


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
    ok = fn(ctypes.byref(inb), "ZuaTimetable", None, None, None, 0, ctypes.byref(outb))
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
# 门户（rhmh.zua.edu.cn）的密码和教务系统**不是同一套**，会话也是两套，
# 所以单独存一份，不塞进 account.bin。
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


WATER_FILE = DATA_DIR / "water.bin"

# 慧生活798（直饮水）的本机状态：token、手机号、设备列表、上次同步时间。
# 和 portal.bin / chaoxing.bin 同一套 DPAPI，**token 永不回给前端**。
# 🔴 为什么单独一个文件而不是塞进 account.bin：那是教务的账号，三套账号
#    （教务 / 门户 / 饮水）混进同一个 JSON 迟早串号 —— 门户那边已经踩过。


def load_water() -> dict | None:
    """读接水本机状态。**两套账号各存一格**（2026-10-30 起）。

        {"device": {token,uid,eid,phone,at}, "score": {同上}, "devices": [...], "at": 0}

    老状态（只有一个顶层 `token`）在这里**就地迁移**成 device 那一格 ——
    不迁移的话老用户升级后会被判成「没登录」，而 token 明明还在。
    """
    try:
        raw = _dpapi(WATER_FILE.read_bytes(), False)
        d = json.loads(raw.decode("utf-8"))
        if not isinstance(d, dict):
            return None
        if d.get("token") and not isinstance(d.get("device"), dict):
            d["device"] = {"token": str(d.get("token") or ""),
                           "uid": str(d.get("uid") or ""),
                           "eid": str(d.get("eid") or ""),
                           "phone": str(d.get("phone") or ""),
                           "at": int(d.get("at") or 0)}
            d.pop("token", None)
            d.pop("uid", None)
            d.pop("eid", None)
            d.pop("phone", None)
        if not any(isinstance(d.get(k), dict) and d[k].get("token")
                   for k in ("device", "score")):
            return None
        return d
    except Exception:  # noqa: BLE001
        pass
    return None


def water_acct(st, kind):
    """取某一套账号。返回 dict 或 None（None = 这个账号没登）。"""
    if not isinstance(st, dict):
        return None
    a = st.get(kind)
    if isinstance(a, dict) and a.get("token"):
        return a
    return None


def water_tokens(st):
    """(设备 token, 积分 token)，缺的那个是 None。"""
    d = water_acct(st, "device")
    s = water_acct(st, "score")
    return (d or {}).get("token"), (s or {}).get("token")


def _dev(st):
    """设备账号的 token。余额 / 设备 / 接水**只用它**（1,1 那一路）。"""
    a = water_acct(st, "device")
    if not a:
        raise water.WaterError(
            "设备账号没登录 —— 接水、余额、设备列表要用「设备登录」那个账号", "auth")
    return a["token"]


def water_score_lane(st):
    """积分类接口（积分 / 任务 / 签到）用哪个账号。

    优先**积分账号**（1,5）；没登就退回设备账号（1,1）——
    原版也是这个优先级（`useApp = !account.hasToken()`）。
    返回 (token, use_app)；两个都没登返回 (None, False)。
    """
    s = water_acct(st, "score")
    if s:
        return s["token"], False
    d = water_acct(st, "device")
    if d:
        return d["token"], True
    return None, False


def save_water(data: dict) -> bool:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        WATER_FILE.write_bytes(_dpapi(json.dumps(data).encode("utf-8"), True))
        return True
    except Exception:  # noqa: BLE001
        return False


def clear_water() -> None:
    try:
        WATER_FILE.unlink()
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

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.client = eams.EamsClient()
        self.last_error = ""

    def sync(self, username: str, password: str) -> dict:
        with self.lock:
            self.client = eams.EamsClient()
            self.client.login(username, password)
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
                self.client = eams.EamsClient()
                self.client.login(username, password)
            try:
                return fn(self.client)
            except eams.EamsError:
                # 会话过期 / 服务端重启 ⇒ 换一个干净会话再来一次
                self.client = eams.EamsClient()
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


# ------------------------------------------------------------------ HTTP

class Handler(SimpleHTTPRequestHandler):
    server_version = "ZuaTimetable/0.1"
    token = ""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB_DIR), **kw)

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

    def _portal_call(self, fn):
        """跑一次门户取数，把失败翻译成前端认识的形状。

        约定（和 app.js 的 renderCampus 对齐）：
            ok:false + needLogin:true  ⇒ 门户要重新登录
            ok:false + 其它 error      ⇒ 这次没读到，会话可能还好

        🔴 这两种必须分开：把「网络抖了一下」说成「登录过期」，用户会白输
           一次密码和验证码（门户错 5 次锁号）；把「真过期了」说成「没读到」，
           他会一直点刷新、一直没反应。
        """
        cli = get_portal()
        if not cli.has_ticket() and not cli.has_id():
            return {"ok": False, "error": "还没连接门户", "needLogin": True}
        try:
            out = fn(cli)
        except portal.PortalError as exc:
            body = {"ok": False, "error": str(exc)}
            if exc.kind == "expired":
                body["needLogin"] = True
            return body
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": "读门户数据失败：%s" % exc}
        # 取数过程中可能续过期（cookie 换了一批），顺手落盘，下次开机直接用
        save_portal({"cookies": cli.dump(), "user": cli.who()})
        out["ok"] = True
        return out

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
        # 校园公告：抓的是学校各部门的**公开页面**，所以不校验 token。
        # 这也是有意的 —— 公告是唯一「没绑教务账号也能看」的栏目，
        # 刚装完 App 还没绑号的时候，至少有个东西是能用的。
        if path == "/api/notice":
            q = parse_qs(urlparse(self.path).query)
            try:
                limit = max(1, min(200, int((q.get("limit", ["60"])[0] or 60))))
            except ValueError:
                limit = 60
            force = (q.get("force", ["0"])[0] or "0") == "1"
            try:
                self._json(notice.fetch_list(limit=limit, force=force))
            except Exception as exc:  # noqa: BLE001
                # 红线：不能把「没拿到」显示成「没有记录」
                self._json({"ok": False, "error": "取公告失败：%s" % exc})
            return
        # 单篇正文：只用来抠「时间 / 地点」和正文摘要。
        # notice.fetch_detail 里有域名白名单，防止被当成跳板去访问内网。
        if path == "/api/notice/detail":
            q = parse_qs(urlparse(self.path).query)
            u = (q.get("u", [""])[0] or "").strip()
            if not u:
                self._json({"ok": False, "error": "缺少 u 参数"}, 400)
                return
            try:
                self._json(notice.fetch_detail(u))
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "打开通知失败：%s" % exc})
            return
        # ---- 智慧门户：一卡通 + 19 个办事应用 ----
        # 这套接口和其他接口有一处根本不同：它要的是**门户**密码，
        # 和教务系统的账号密码不是同一套，所以单独存一份凭据。
        # ---------------- 慧生活798（直饮水） ----------------
        # 0.26.0 的注释在这里写着「积分任务**故意不做**：要签名盐值」——
        # 那个结论是错的（盐在官方 APK 里，2026-10-30 已取出，见 water.py 文件头），
        # 0.26.2 起积分任务和签到都做了。风险提示在界面上（TaskRiskConsent）。
        if path == "/api/water/state":
            st = load_water()
            if not st:
                self._json({"ok": True, "state": "none", "accounts": {}})
                return
            dev = water_acct(st, "device")
            sco = water_acct(st, "score")

            def brief(a):
                if not a:
                    return None
                return {"phone": str(a.get("phone") or ""),
                        "uid": str(a.get("uid") or ""),
                        "at": int(a.get("at") or 0)}

            # 🔴 两套账号**分开报**，缺哪个要能看出来缺哪个。合成一个
            #    `state: ok/partial` 是不够的 —— 界面要知道「缺的是积分账号，
            #    所以签到和任务少了那个平台」，而不是笼统「登录不完整」。
            self._json({"ok": True,
                        "state": "ok" if (dev and sco) else "partial",
                        "accounts": {"device": brief(dev), "score": brief(sco)},
                        "phone": (dev or {}).get("phone") or "",
                        "devices": st.get("devices") or [],
                        "at": st.get("at") or 0})
            return
        if path == "/api/water/captcha":
            key = water.new_key()
            self._json({"ok": True, "key": key, "url": water.captcha_url(key)})
            return
        # ---------------- 0.24.0：积分 / 消费记录 / 套餐 ----------------
        # 和 native.js 的 handle 一一对应（路径、字段、错误形状都一样）。
        if path == "/api/water/score":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            try:
                tok, use_app = water_score_lane(st)
                self._json(dict(ok=True, **water.acc_score(tok, use_app=use_app)))
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "查积分失败：%s" % exc})
            return
        if path == "/api/water/bills":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            q = parse_qs(urlparse(self.path).query)
            try:
                page = int((q.get("page") or ["0"])[0] or 0)
            except ValueError:
                page = 0
            try:
                got = water.bills(_dev(st), page=page, size=20)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "查消费记录失败：%s" % exc})
                return
            self._json(dict(ok=True, **got))
            return
        if path == "/api/water/missions":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            dev_tok, score_tok = water_tokens(st)
            try:
                got = water.missions_all(dev_tok, score_tok)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "查积分任务失败：%s" % exc})
                return
            # 🔴 `daily` / `lanes` / `errors` 必须一起转发。0.26.0 第一版漏了
            #    `daily` —— water.missions() 老老实实算出了签到状态，桥这里只挑
            #    items/skipped 往外送，界面拿到的永远是 undefined ⇒ 签到卡一直藏着，
            #    而所有解析判据都是绿的（它们只查 water.py 那一层）。
            #    `lanes` 同理：少了它，界面就不知道「少一半任务是没登积分账号」，
            #    只会显得「任务就是这些」。
            #    ⇒ 「中间层转发漏字段」是静默的，必须有判据盯（check_water_bridge）。
            self._json({"ok": True, "items": got["items"],
                        "skipped": got["skipped"], "daily": got.get("daily"),
                        "lanes": got.get("lanes"), "errors": got.get("errors")})
            return
        if path == "/api/portal/status":
            acc = load_portal()
            if not acc:
                self._json({"ok": True, "state": "none", "saved": False})
                return
            cli = get_portal()
            # 只在本地看 cookie，不探网 —— 这个接口每次切到「校园」页都会调，
            # 探一次网就多几百毫秒。真正的死活由 card/apps 的 needLogin 决定。
            state = "ok" if (cli.has_ticket() or cli.has_id()) else "expired"
            # `saved` = 本机存着门户密码 ⇒ 过期后只需算一道验证码。
            # 只回「存的是哪个学号」，**密码本身永远不出这个进程**。
            self._json({"ok": True, "state": state, "user": cli.who(),
                        "saved": bool(str(acc.get("pwd") or "")),
                        "savedUser": str(acc.get("pwdUser") or "")})
            return
        if path == "/api/portal/captcha":
            try:
                cap = get_portal().captcha()
            except portal.PortalError as exc:
                self._json({"ok": False, "error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "拿验证码失败：%s" % exc})
                return
            self._json({"ok": True, "img": cap["img"], "timeout": cap["timeout"]})
            return
        if path == "/api/portal/card":
            out = self._portal_call(lambda c: c.card())
            if out is not None:
                self._json(out)
            return
        if path == "/api/portal/apps":
            out = self._portal_call(lambda c: {"apps": c.apps()})
            if out is not None:
                self._json(out)
            return
        # 给某个办事系统换一张 CAS 票（app.js 拿到票会拼在地址后面再打开）。
        if path == "/api/portal/ticket":
            q = parse_qs(urlparse(self.path).query)
            svc = (q.get("service") or [""])[0].strip()
            # 🔴 只给学校的地址换票：这张票**等于一次登录态**，
            #    拼到别人的域名上就是把登录态送出去了。
            #    先解析 host 再比，别用 startswith 比字符串 ——
            #    `https://zua.edu.cn.evil.com` 也满足 startswith。
            host = (urlparse(svc).hostname or "").lower()
            if not svc.startswith("https://") or not (
                    host == "zua.edu.cn" or host.endswith(".zua.edu.cn")):
                self._json({"ok": False, "error": "只给学校（zua.edu.cn）的地址换票"})
                return
            out = self._portal_call(lambda c: {"ticket": c.ticket_for(svc)})
            if out is not None:
                self._json(out)
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

        # ---------------- 慧生活798（直饮水） ----------------
        if path == "/api/water/sms":
            phone = (data.get("phone") or "").strip()
            key = (data.get("key") or "").strip()
            graph = (data.get("graph") or "").strip()
            if not phone or not key or not graph:
                self._json({"ok": False, "error": "手机号、图形验证码都要填"})
                return
            try:
                water.send_sms(phone, key, graph)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "发短信失败：%s" % exc})
                return
            self._json({"ok": True})
            return

        if path == "/api/water/login":
            phone = (data.get("phone") or "").strip()
            sms = (data.get("sms") or "").strip()
            kind = (data.get("kind") or "device").strip()
            if kind not in ("device", "score"):
                self._json({"ok": False, "error": "账号类型只认 device / score"})
                return
            if not phone or not sms:
                self._json({"ok": False, "error": "手机号和短信验证码都要填"})
                return
            try:
                got = water.login(phone, sms, as_app=(kind == "device"))
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "登录失败：%s" % exc})
                return
            # 🔴 **只覆盖登录的这一格**，另一格原样留着。整套覆盖的话，
            #    登完积分账号会把设备账号踢掉 —— 接水立刻不能用了，
            #    而用户以为自己只是「补登了一个账号」。
            st = load_water() or {}
            st[kind] = {"token": got["token"], "phone": phone,
                        "uid": got.get("uid") or "", "eid": got.get("eid") or "",
                        "at": int(time.time() * 1000)}
            st.setdefault("devices", [])
            if not save_water(st):
                self._json({"ok": False,
                            "error": "登录成功了，但 token 存不进本机"
                                     "（检查数据目录权限），关掉服务就得重登"})
                return
            self._json({"ok": True, "phone": phone, "kind": kind})
            return

        if path == "/api/water/home":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            # 🔴 `_dev` 会抛（只登了积分账号时）。放在 try 外面抛出去会变成
            #    一个没人接的异常，用户看到的是「服务出错」而不是「这个功能
            #    要用设备账号」—— 和 native.js 的 wGate('device') 同一句话。
            try:
                token = _dev(st)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            out = {"ok": True}
            # 🔴 余额和设备**分开报错**：一个挂了不该把另一个也变成「读不到」，
            #    也不许安静吞掉（「没读到」和「没有」是两件事）。
            try:
                out["balance"] = water.wallet_balance(token)
            except water.WaterError as exc:
                if exc.kind == "auth":
                    self._json({"ok": False, "error": str(exc), "kind": "auth"})
                    return
                out["balance"] = None
                out["balanceError"] = str(exc)
            except Exception as exc:  # noqa: BLE001
                out["balance"] = None
                out["balanceError"] = "查余额失败：%s" % exc
            try:
                out["devices"] = water.devices(token)
                st["devices"] = out["devices"]
                st["at"] = int(time.time() * 1000)
                save_water(st)
            except water.WaterError as exc:
                if exc.kind == "auth":
                    self._json({"ok": False, "error": str(exc), "kind": "auth"})
                    return
                out["devices"] = st.get("devices") or []
                out["devicesError"] = str(exc)
            except Exception as exc:  # noqa: BLE001
                out["devices"] = st.get("devices") or []
                out["devicesError"] = "列设备失败：%s" % exc
            self._json(out)
            return

        if path == "/api/water/start":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            did = (data.get("did") or "").strip()
            if not did:
                self._json({"ok": False, "error": "没给设备号"})
                return
            try:
                ok, msg = water.dev_start(_dev(st), did)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "启动失败：%s" % exc})
                return
            self._json({"ok": True, "msg": msg})
            return

        if path == "/api/water/logout":
            kind = (data.get("kind") or "").strip()
            if kind in ("device", "score"):
                # 只退一格。另一格留着 —— 退积分账号不该把接水也弄坏。
                st = load_water()
                if st:
                    st.pop(kind, None)
                    if not any(water_acct(st, k) for k in ("device", "score")):
                        clear_water()
                    else:
                        save_water(st)
                self._json({"ok": True, "kind": kind})
                return
            clear_water()
            self._json({"ok": True})
            return

        # ---------------- 0.24.0：停止接水 / 签到 / 收藏设备 ----------------
        # 这三个都**有副作用**，界面必须二次确认；失败**不自动重试**。
        if path == "/api/water/end":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            did = (data.get("did") or "").strip()
            if not did:
                self._json({"ok": False, "error": "没给设备号"})
                return
            try:
                msg = water.dev_end(_dev(st), did)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "停止失败：%s" % exc})
                return
            self._json({"ok": True, "msg": msg})
            return

        if path == "/api/water/mission":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            ad_id = (data.get("adId") or "").strip()
            if not ad_id:
                self._json({"ok": False, "error": "没给任务 id"})
                return
            score = data.get("score")
            try:
                score = None if score in (None, "") else int(score)
            except (TypeError, ValueError):
                score = None
            # 平台决定用哪个账号、哪套签名和请求头（见 water.sign_score）
            lane = (data.get("platform") or "").strip()
            if lane == "device":
                tok, use_app = _dev(st), True
            elif lane == "score":
                # 🔴 不能把 use_app 写死成 False。`water_score_lane` 的规矩是
                #    「优先积分账号，没登就退回设备账号，并且 use_app 跟着变」——
                #    写死 False 就会出现「拿设备 token 配积分盐 + 1,5 头」，
                #    服务端按无效 token 拒掉，而界面上看着像「这个任务做不了」。
                #    签到那条路由（/api/water/signin）一直是跟着回退走的，
                #    这里原来跟它不一致 —— 同一个回退在两条路上效果不同。
                tok, use_app = water_score_lane(st)
            else:
                tok, use_app = water_score_lane(st)
            a = water_acct(st, "device" if use_app else "score") or \
                water_acct(st, "device") or {}
            uid = str(a.get("uid") or "")
            try:
                msg = water.mission_done(tok, ad_id, uid, add_score=score,
                                         use_app=use_app)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "执行任务失败：%s" % exc})
                return
            self._json({"ok": True, "msg": msg})
            return

        if path == "/api/water/signin":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            ad_id = (data.get("adId") or "").strip()
            if not ad_id:
                self._json({"ok": False, "error": "没给签到 adId"})
                return
            try:
                weekday = int(data.get("weekday"))
            except (TypeError, ValueError):
                self._json({"ok": False, "error": "没给星期几"})
                return
            try:
                score = int(data.get("score") or 0)
            except (TypeError, ValueError):
                score = 0
            tok, use_app = water_score_lane(st)
            a = water_acct(st, "device" if use_app else "score") or \
                water_acct(st, "device") or {}
            try:
                msg = water.sign_in(tok, str(a.get("uid") or ""), weekday,
                                    ad_id, score, use_app=use_app)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "签到失败：%s" % exc})
                return
            self._json({"ok": True, "msg": msg})
            return

        # ---------------- 0.27.1：积分兑换余额 ----------------
        # 和 native.js 的 handle 一一对应（路径、字段、错误形状都一样）。
        if path == "/api/water/wallets":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            # 兑换扣的是**积分**，所以钱包列表也走积分那条路 —— 两处用不同
            # 账号读的话，列表里的 endpointId 可能根本不属于能扣分的那个账号。
            tok, use_app = water_score_lane(st)
            try:
                ws = water.wallets(tok, use_app=use_app)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "查钱包失败：%s" % exc})
                return
            self._json({"ok": True, "wallets": ws})
            return

        if path == "/api/water/exchange":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            eid = str(data.get("eid") or "").strip()
            if not eid:
                self._json({"ok": False, "error": "没选兑换到哪个钱包"})
                return
            try:
                score = int(data.get("score"))
            except (TypeError, ValueError):
                self._json({"ok": False, "error": "没给要兑换的积分"})
                return
            tok, use_app = water_score_lane(st)
            try:
                sn = water.score_exchange(tok, eid, score, use_app=use_app)
            except water.WaterError as exc:
                # 🔴 网络类失败**不代表没扣分**：请求可能已经到服务端了。
                #    文案必须让用户先去核验，不能让他「再点一次」—— 那就是再扣一次。
                if exc.kind in ("net", "limit"):
                    self._json({"ok": False, "kind": exc.kind,
                                "error": "兑换结果未知（%s），先别重复兑换" % exc})
                else:
                    self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "kind": "net",
                            "error": "兑换结果未知（%s），先别重复兑换" % exc})
                return
            self._json({"ok": True, "sn": sn})
            return

        if path == "/api/water/exchange-bill":
            st = load_water()
            if not st:
                self._json({"ok": False, "error": "还没登录", "kind": "auth"})
                return
            q = parse_qs(urlparse(self.path).query)
            bid = str((q.get("id") or [""])[0] or "").strip()
            if not bid:
                self._json({"ok": False, "error": "没给账单号"})
                return
            tok, use_app = water_score_lane(st)
            try:
                got = water.exchange_bill(tok, bid, use_app=use_app)
            except water.WaterError as exc:
                self._json({"ok": False, "error": str(exc), "kind": exc.kind})
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "查兑换账单失败：%s" % exc})
                return
            self._json(dict(ok=True, **got))
            return

        if path == "/api/login":
            user = (data.get("username") or "").strip()
            pwd = data.get("password") or ""
            if not user or not pwd:
                self._json({"ok": False, "error": "请填学号和密码"})
                return
            try:
                payload = SERVICE.sync(user, pwd)
            except eams.EamsError as exc:
                self._json({"ok": False, "error": str(exc)})
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
        if path == "/api/portal/login":
            user = (data.get("user") or "").strip()
            pwd = data.get("pass") or ""
            code = (data.get("code") or "").strip()
            # 密码留空 = 「用本机存着的那份」。这样过期重登时人只需要算一道算术题。
            used_saved = False
            if not pwd:
                sp, su = portal_saved_pwd()
                if not sp:
                    self._json({"ok": False, "error": "学号和密码都要填", "needCaptcha": True})
                    return
                # 🔴 存的是另一个学号的密码就**不许**拿去试：门户错 5 次锁号，
                #    拿错账号的密码去撞等于帮用户把号锁了。
                if su and user and su != user:
                    self._json({"ok": False, "needCaptcha": True,
                                "error": "本机存的是 %s 的门户密码，跟这个学号对不上，请手动输入" % su})
                    return
                pwd = sp
                user = user or su
                used_saved = True
            # 🔴 一律回 needCaptcha：验证码是一次性的，不管哪一步失败，
            #    这张都不能再用。前端收到就重新拉图，用户重算一次。
            if not user or not pwd:
                self._json({"ok": False, "error": "学号和密码都要填", "needCaptcha": True})
                return
            if not code:
                self._json({"ok": False, "error": "还没算验证码", "needCaptcha": True})
                return
            try:
                out = get_portal().login(user, pwd, code)
            except portal.PortalError as exc:
                body = {"ok": False, "error": str(exc), "needCaptcha": True}
                # 用着本机存的密码、门户又明确说「密码/账号不对」⇒ 把那两份都扔了。
                # 不扔的话下次还会拿一个错密码去撞，撞 5 次号就锁了。
                # ⚠️ 验证码算错（CODEFALSE）**不在此列**：手滑一次不该删密码。
                if used_saved and getattr(exc, "code", "") in portal.PWD_BAD_CODES:
                    clear_portal()
                    reset_portal()
                    body["pwdStale"] = True
                    body["error"] = "%s —— 本机存的那份密码已经删掉，请手动输入一次" % exc
                self._json(body)
                return
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": "登录出错：%s" % exc, "needCaptcha": True})
                return
            cli = get_portal()
            saved = save_portal({"cookies": cli.dump(), "user": out["user"],
                                 "pwd": pwd, "pwdUser": user})
            self._json({"ok": True, "user": out["user"],
                        # 空串 = 存好了，其余是原因（和 /api/login 同构）
                        "saved": "" if saved else "fail: 凭据文件写不进去"})
            return

        if path == "/api/portal/logout":
            # 本地断开就行 —— 门户那边不需要「退出登录」：
            # 我们只是不再拿这个 cookie 去请求了。
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
            if not sid.isdigit():
                # 不猜、不兜底：id 不对就直接说，别默默返回当前学期的数据
                # 冒充用户点的那一学期。
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
            if sid and not sid.isdigit():
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
            # 🔴 参数一个都不猜：日期必须是 YYYY-MM-DD，节次必须是 1~12 的整数。
            #    写错了直接回错，别默默按「今天第 1 节」查一遍再冒充用户要的。
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
            if not (1 <= p1 <= p2 <= 12):
                self._json({"ok": False, "error": "节次要在 1~12 之间，且开始不晚于结束"})
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


def main() -> int:
    ap = argparse.ArgumentParser(description="郑航课表手机端本地服务")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--no-qr", action="store_true")
    args = ap.parse_args()

    if not WEB_DIR.is_dir():
        print("找不到 web/ 目录，脚本可能被挪动了")
        return 2

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
    print("  郑航课表 · 手机端服务已启动")
    print("  " + "-" * 46)
    print("  电脑上打开：  http://127.0.0.1:%d/?k=%s" % (args.port, token))
    for ip in ips:
        print("  手机上打开：  http://%s:%d/?k=%s" % (ip, args.port, token))
    print("  " + "-" * 46)
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
