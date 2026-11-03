# -*- coding: utf-8 -*-
"""达小助 · 升达青果(KINGOSOFT)教务只读客户端。

方法集与返回结构 **对齐 eams.EamsClient**（bridge.Service 的调用面不变）：
    login(u,p) / ensure_login / logged_in / profile() / timetable(sem_id,sem_name)
    grades() / exams(sem_id) / semesters() / room_options() / free_rooms(**kw)
    plan() / todo() —— 后两个青果路径未确认，返回带 error 的空结构。

登录流（升达实测，见 docs/…-design.md §2 与 shengda-qk）：
    POST {cas}/v1/tickets            账密(小写键+loginType) → 返回 TGT
    🔴 CASTGC 是门户前端 JS 自己写进 cookie 的，服务器不 Set-Cookie ——
       必须手动种 cookie，否则免密续期永不生效。
    POST {cas}/v1/tickets/{CASTGC}   service 表单 → **纯文本** ST-…（不是 JSON）
    GET {jw}/caslogin?ticket=ST-…    → JSESSIONID，落 frame/homes.html
    POST getBreadcrumbsInfoNew.action?menucode=…  菜单上下文（缺→1098 错误页）
    预热：首页 → 下拉字典 → 目标页（缺→「不是选课学生本人」）

红线：本文件**只读**。选课/退课/评教的提交端点（saveElectiveCourse 等）
不移植、不实现、并在 _request 层拦截（写路径特征一律拒绝）。

配置单一真源：config/shengda.json。TBD 值在对应方法处返回带 error 的空结构，
**绝不猜参数发请求**。native.js 镜像本文件，两轨输出必须同构（app.js 契约）。
"""

import json
import os
import re
import time

import requests

import cas_rsa
import table_parser as tp

try:
    from eams import EamsError   # 复用错误类，bridge 的 except eams.EamsError 不变
except ImportError:              # pragma: no cover
    class EamsError(Exception):
        def __init__(self, msg, kind=""):
            super().__init__(msg)
            self.kind = kind

UA = "DaXiaoZhu/0.1.0 (Android; campus read-only client)"

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "config", "shengda.json")


def load_config(path: str = None) -> dict:
    with open(path or CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


#: 写端点特征（红线护栏）：这些路径/动作**永不发出**
_WRITE_PATTERNS = re.compile(
    r"(saveElectiveCourse|cancelElectiveCourse|getTempDeskey|getTempNowtime"
    r"|electiveCourseForm|pingjia|evaluate|doXk|submit.*course)", re.I)


#: 「2024-2025学年第一学期」→ ("2024-2025", 1)
_TERM_RE = re.compile(r"(\d{4}-\d{4})\s*学年\s*第?([一二三四])学期")
_CN_NO = {"一": 1, "二": 2, "三": 3, "四": 4}


def _split_term(text: str) -> tuple:
    m = _TERM_RE.search(str(text or ""))
    if not m:
        return ("", 0)
    return (m.group(1), _CN_NO.get(m.group(2), 0))


def _host_of(url: str) -> str:
    m = re.match(r"https?://([^/?#:]+)", str(url or ""), re.I)
    return m.group(1).lower() if m else ""


class KingoClient:
    """升达教务只读客户端。tableId/menucode 全部来自 config，不硬编码。"""

    def __init__(self, config: dict = None, session: requests.Session = None):
        self.cfg = config or load_config()
        self.s = session or requests.Session()
        self.s.headers.update({"User-Agent": UA,
                               "Accept-Language": "zh-CN,zh;q=0.9"})
        self.s.verify = self.cfg["jw"].get("verify_tls", True)
        self.jw_base = self.cfg["jw"]["base"].rstrip("/")
        self.cas_base = self.cfg["cas"]["base"].rstrip("/")
        # 🔴 本机 mock 必须绕开系统代理：这台机器上设了 HTTP_PROXY，requests 会把
        #    发往 127.0.0.1:8090 的请求也塞给代理，代理连不上就回 502
        #    「upstream connect failed」—— 表现是「验证码没取到」，极难往代理上想。
        #    只对回环地址关掉，真实域名照旧走系统代理。
        if _host_of(self.jw_base) in ("127.0.0.1", "localhost", "::1") or \
                _host_of(self.cas_base) in ("127.0.0.1", "localhost", "::1"):
            self.s.trust_env = False
            self.s.proxies = {}
        # 域名白名单（见 _assert_allowed_host）：config 里出现过的 host 才算本校
        self._allow_hosts = {h for h in (
            _host_of(self.jw_base), _host_of(self.cas_base),
            _host_of(self.cfg["cas"].get("portal", "")),
            _host_of(self.cfg["jw"].get("cas_service", ""))) if h}
        self.username = ""
        self._logged_in = False
        self._ready = False           # 教务会话（换票+菜单上下文）是否建好
        self._last = 0.0
        self._delay = float(self.cfg["jw"].get("polite_delay_sec", 0.35))
        self._context = {}            # showYearTerm 给的 xn/xqM/xqName
        self._context_loaded = False
        self._kbt_head = None         # 课表页头部（学号/姓名/班级），profile 复用

    # ---------------------------------------------------------------- 内部
    def _sleep(self):
        gap = time.time() - self._last
        if gap < self._delay:
            time.sleep(self._delay - gap)

    def _jw_url(self, path: str) -> str:
        return self.jw_base + path

    def _request(self, method: str, url: str, **kw):
        """唯一出口。写端点一律拒绝发出；域名不在白名单也拒绝发出。"""
        if _WRITE_PATTERNS.search(url):
            raise EamsError("达小助是只读客户端，该操作(写)不被允许: %s" % url)
        self._assert_allowed_host(url)
        self._sleep()
        kw.setdefault("timeout", 30)
        r = self.s.request(method, url, **kw)
        self._last = time.time()
        return r

    def _assert_allowed_host(self, url: str) -> None:
        """🔴 域名硬白名单（与 native.js 的 guardUrl 同构）。
        白名单从 config 现算，不写死域名：这样 mock（内网 IP）照样放行，
        换正式域名也不用改代码。留这条闸的原因是底座里残留过郑航地址，
        只要有一条路径忘了停用，学生的账密就发到别的学校去了。"""
        host = _host_of(url)
        if not host:
            raise EamsError("请求地址解析不出域名，已拦截: %s" % url)
        if host not in self._allow_hosts and not host.endswith(".chaoxing.com"):
            raise EamsError("已拦截：%s 不在本校白名单内（凭据不发往第三方）" % host)

    def _jw_get(self, path, **kw):
        r = self._request("GET", self._jw_url(path), **kw)
        r.encoding = "utf-8"
        return r

    def _jw_post(self, path, data=None, referer="", **kw):
        headers = kw.pop("headers", {}) or {}
        # 浏览器对同源 POST 一律带 Origin + Referer（HAR 实测）。
        # 少这两个头时青果可能回「无效访问请求」——它按来源页判上下文。
        headers.setdefault("Origin", self.jw_base)
        # 浏览器这些接口都是 jQuery 的 $.ajax 发的，带 X-Requested-With
        # （HAR 里 showYearTerm 的请求头逐个核对过）。少它时青果可能直接判成
        # 「无效访问请求」—— 2026-11-03 真机 515 字节的报错页就出现在这个方向。
        headers.setdefault("X-Requested-With", "XMLHttpRequest")
        if referer:
            headers.setdefault("Referer", self._jw_url(referer))
        else:
            headers.setdefault("Referer", self._jw_url(
                self.cfg["jw"]["home_path"]))
        r = self._request("POST", self._jw_url(path), data=data or {}, headers=headers, **kw)
        r.encoding = "utf-8"
        return r

    def _body_text(self, r) -> str:
        """DataTable/页面的正文。编码按响应头与 gbk 优先解码。"""
        return tp.decode_body(r.content, r.headers.get("Content-Type", ""))

    def _guard(self, text: str, what: str):
        """会话失效/频控统一判定。空表**不是**失效——只有错误页标志才报。"""
        if tp.looks_rate_limited(text):
            raise EamsError("学校服务器提示请求太频繁，请等一会儿再刷新")
        if tp.looks_session_expired(text):
            raise EamsError("%s没打开，可能登录态过期了" % what, kind="auth")

    def _ck(self, name: str, domain: str = "") -> str:
        jar = self.s.cookies
        for c in jar:
            if c.name == name and (not domain or (c.domain or "").endswith(domain)):
                return c.value or ""
        return ""

    # ---------------------------------------------------------------- 登录
    def captcha(self) -> dict:
        """取验证码（升达实测：kaptcha 是算术题）。红线：只展示，不自动识别。
        返回 {uid, img(data:image/png;base64,…), ttl_sec}；登录必须带 uid+答案。"""
        t = int(time.time() * 1000)
        r = self._request("GET", "%s%s" % (self.cas_base, self.cfg["cas"]["kaptcha_path"]),
                          params={"_t": t, "uid": ""})
        j = tp._double_encoded_json(r.text) or {}
        uid = j.get("uid", "")
        img = j.get("content", "")
        if not uid or not img:
            raise EamsError("验证码没取到，可能登录页改版了")
        try:
            ttl = int(j.get("timeout") or 30)
        except (TypeError, ValueError):
            ttl = 30
        return {"uid": uid, "img": img, "ttl_sec": ttl}

    #: 登录失败时服务端在 ``data.code`` 里给的原因码 → (给用户看的话, kind)。
    #: **只收录实测确认过的**（2026-11-03 用假学号真打接口得到）：
    #:   * ``NOUSER``    —— 账号不存在（验证码与密码格式都通过后才到这个判定）
    #:   * ``CODEFALSE`` —— 验证码为空/错误/过期（它在最前面校验，会掩盖密码错误）
    #: 其它码**不猜**，原样回显让用户能反馈。
    _CAS_CODE_HINTS = {
        "NOUSER": ("学号不存在，核对一下再输", "auth"),
        "CODEFALSE": ("验证码错了或过期了，换一张重新算", "code"),
    }

    @staticmethod
    def _cas_failure(text: str) -> tuple:
        """从 CAS 登录响应里提失败原因。返回 (说明, kind)；成功返回 ("", "")。

        🔴 为什么必须解析这个：升达 CAS 登录失败时**照样返回 HTTP 200**，
        真正原因只在 ``data.code`` 里。只看「有没有 TGT」的话，界面只能回一句
        「登录没成功（200）」—— 用户完全不知道该改密码还是该改验证码。
        """
        j = tp._double_encoded_json(text)
        if not isinstance(j, dict):
            return ("", "")
        data = j.get("data")
        if not isinstance(data, dict):
            return ("", "")
        code = str(data.get("code") or "").strip()
        if not code:
            return ("", "")
        hint, kind = KingoClient._CAS_CODE_HINTS.get(code.upper(), ("", "auth"))
        if not hint:
            return ("登录被拒绝（服务端返回 %s，请把这条反馈给开发者）" % code, kind)
        return ("%s（%s）" % (hint, code), kind)

    def login(self, username: str, password: str, code: str = "", uid: str = "") -> None:
        """CAS 账密登录（REST）。**失败不自动重试**（触发滑块/锁号的前科）。

        🔴 2026-11-03 修复：之前这里发明文密码、且不带验证码，
        服务端一律回 ``data.code = CODEFALSE``，界面显示「登录没成功（200）」。
        学校登录页前端（app.<hash>.js）的真实构造是：

            if (!loginType) { setMaxDigits(131); v = RSA.encrypt(password) }
            POST /v1/tickets { username, password: v, service, loginType, id, code }

        所以：① 密码必须 RSA 加密；② 学校开了 ``isVerifyCode=1``，
        验证码 ``id``(uid) + ``code``(答案) **第一次登录就要带**。
        """
        encrypted = cas_rsa.encrypt_password(password)
        if not encrypted:
            raise EamsError("密码是空的，没法加密提交", kind="auth")
        form = {"username": username, "password": encrypted,
                "service": self.cfg["cas"]["portal"], "loginType": ""}
        if uid:
            # 字段名就是 id / code（不是 captcha / verifyCode），实测确认。
            form["id"] = uid
            form["code"] = code or ""
        headers = {"Origin": self.cas_base.split("/lyuapServer")[0],
                   "Referer": self.cas_base + "/login",
                   "X-Requested-With": "XMLHttpRequest",
                   "Accept": "application/json, text/plain, */*"}
        r = self._request("POST", self.cas_base + self.cfg["cas"]["tickets_path"],
                          data=form, headers=headers, allow_redirects=True)

        # 先判业务失败码，再找 TGT —— 顺序反了就只能给出「登录没成功」。
        why, kind = self._cas_failure(r.text or "")
        if why:
            # 不重试：错 5 次锁号，"识别错误"与"密码输错"同一个计数器
            raise EamsError(why, kind=kind)

        tgt = self._extract_tgt(r)
        if not tgt:
            raise EamsError("登录没成功（服务端没给票据，HTTP %d）" % (r.status_code or 0),
                            kind="auth")
        # 🔴 手动种 CASTGC：服务器不 Set-Cookie，这是门户前端 JS 自己写的（实测）
        if not self._ck("CASTGC"):
            cas_dom = re.sub(r"^https?://", "", self.cas_base).split("/")[0]
            self.s.cookies.set("CASTGC", tgt, domain=cas_dom, path="/")
        self.username = username
        self._logged_in = True
        self._ready = False   # 教务会话等 ensure_session 建

    @staticmethod
    def _extract_tgt(r) -> str:
        """从登录响应里取 TGT。前端是 ``if (o.data.tgt) c = o.data.tgt; else c = o.data``，
        同时兼容纯文本与 Location 头三种形态。"""
        text = r.text or ""
        j = tp._double_encoded_json(text)
        cands = []
        if isinstance(j, dict):
            cands.append(j.get("tgt"))
            data = j.get("data")
            if isinstance(data, str):
                cands.append(data)
            elif isinstance(data, dict):
                cands.append(data.get("tgt"))
                inner = data.get("data")
                if isinstance(inner, str):
                    cands.append(inner)
        for c in cands:
            if isinstance(c, str):
                m = re.search(r"TGT-[A-Za-z0-9_.\-]+", c)
                if m:
                    return m.group(0)
        m = re.search(r"TGT-[A-Za-z0-9_.\-]+", text)
        if m:
            return m.group(0)
        loc = (r.headers.get("Location") or "") if getattr(r, "headers", None) else ""
        m = re.search(r"TGT-[A-Za-z0-9_.\-]+", loc)
        return m.group(0) if m else ""

    def ensure_login(self, username: str, password: str) -> None:
        if not self._logged_in:
            self.login(username, password)

    @property
    def logged_in(self) -> bool:
        return self._logged_in

    # ------------------------------------------------------- 教务会话（关键）
    def _cas_exchange(self) -> str:
        """REST 换票：POST /v1/tickets/{TGT} → ST → GET caslogin?ticket=ST。

        返回一句给人看的进展描述（失败时拼进报错里）。
        🔴 不看「有没有 JSESSIONID」：实测票据无效时 caslogin 回 500 却照样
        Set-Cookie —— 那个会话是空壳，拿它取数只会得到「凭证已失效」。
        """
        tgt = self._ck("CASTGC")
        if not tgt:
            return "没有 CASTGC"
        service = self.cfg["jw"]["cas_service"]
        try:
            r = self._request("POST", "%s%s/%s" % (
                self.cas_base, self.cfg["cas"]["tickets_path"].rstrip("/"), tgt),
                data={"service": service}, allow_redirects=False)
        except requests.RequestException as e:
            return "换票失败（%s）" % e
        m = re.search(r"(ST-[A-Za-z0-9._\-]+)", r.text or "")
        if not m:
            return "换票 HTTP %s（没给 ST）" % r.status_code
        joiner = "&" if "?" in service else "?"
        try:
            g = self._request("GET", service + joiner + "ticket=" + m.group(1),
                              allow_redirects=True)
        except requests.RequestException as e:
            return "换票 HTTP %s → caslogin 失败（%s）" % (r.status_code, e)
        return "换票 %s → caslogin %s" % (r.status_code, g.status_code)

    def _cas_redirect(self) -> str:
        """浏览器路径：带着 CASTGC 直接访问教务，让 CAS 自己把票送回来。

        这就是「已登录状态下在浏览器打开教务 URL」时发生的事 —— CAS 校验
        CASTGC，自动 302 到 caslogin?ticket=ST，教务随即下发真会话。
        比手动换票少一步，也不依赖 REST 接口的实现细节。
        """
        try:
            g = self._request("GET", self.cfg["jw"]["cas_service"],
                              allow_redirects=True)
            return "直连 caslogin %s" % g.status_code
        except requests.RequestException as e:
            return "直连 caslogin 失败（%s）" % e

    def ensure_session(self, force: bool = False) -> None:
        """CASTGC → 换票 → caslogin → 菜单上下文 → 预热。幂等。

        🔴 这里**不判断**会话到底成没成 —— 判断权交给第一次真实取数
        （见 _term_context）：能取到数据才算成。之前靠 cookie/状态码猜，
        结果把「CAS 登录页 200 + 空壳 JSESSIONID」当成了成功。
        """
        if self._ready and not force:
            return
        if not self._logged_in:
            raise EamsError("还没登录", kind="auth")
        if not self._ck("CASTGC"):
            raise EamsError("登录成功但票据没存住（CASTGC 为空），请重试一次",
                            kind="auth")
        self._last_cas_note = self._cas_exchange()
        self._menu_context()
        self._warmup()
        self._ready = True

    def _menu_code(self, page_key: str) -> str:
        mc = (self.cfg["pages"].get(page_key) or {}).get("menucode", "")
        return mc

    def _menu_context(self, page_key: str = "") -> None:
        """建立菜单上下文。未抓包的 page_key 只带默认 menucode 试一次总入口。"""
        mc = self._menu_code(page_key)
        if not mc or mc.startswith("TBD"):
            return  # 没配置就不发（绝不猜）
        self._jw_post("%s?menucode=%s" % (self.cfg["jw"]["menu_context_path"], mc),
                      data={}, referer=self.cfg["jw"]["home_path"])

    def _warmup(self) -> None:
        """按浏览器顺序预访问：首页→下拉字典。目标页在 _fetch 里按需补。"""
        try:
            self._jw_get(self.cfg["jw"]["home_path"],
                         headers={"Referer": self.jw_base + "/"})
            self._jw_post(self.cfg["jw"]["droplist_path"], data={},
                          headers={"Referer": self._jw_url(self.cfg["jw"]["home_path"])})
        except requests.RequestException:
            pass  # 预热尽力而为，真实请求判活

    # ---------------------------------------------------------------- 取数
    def _term_context(self) -> dict:
        """学期上下文。🔴 本校的真实来源是
        ``POST /jw/common/showYearTerm.action``（无 body），返回

            {"xn":"2026","xqM":"0","xqName":"第一学期","userCode":"202401010138",...}

        **这个调用同时是「会话到底成没成」的判据** —— 能拿到 xn 才算登录成功。
        失败时自动换一条路重试（最多三轮），并把每一轮的结果记下来：
          ① 直接调（此时走的是 REST 换票建出来的会话）
          ② 失败 → 走浏览器路径重新建会话（带 CASTGC 直连 caslogin）
          ③ 还失败 → 重做一次 REST 换票（CASTGC 可能是刚种上的）
        三轮都不行才报错，报错里带着每一步的 HTTP 状态和字节数。
        """
        if self._context_loaded:
            return self._context
        conf = self.cfg["jw"].get("term_path") or ""
        if not conf:
            raise EamsError("学期上下文端点没配置（config 的 jw.term_path）")
        notes = []
        for attempt in range(3):
            r = self._jw_post(conf, data={},
                              referer=self.cfg["jw"]["home_path"])
            j = tp._double_encoded_json(r.text) or {}
            if j.get("xn"):
                self._context = j
                self._context_loaded = True
                return self._context
            notes.append("第%d次 HTTP %s/%d字节"
                         % (attempt + 1, r.status_code, len(r.content or b"")))
            if attempt == 0:
                notes.append(self._cas_redirect())
            elif attempt == 1:
                notes.append(self._cas_exchange())
        raise EamsError("学期上下文没打开（%s）" % " · ".join(notes), kind="auth")

    def _load_context(self) -> dict:
        """兼容旧调用面。"""
        return self._term_context()

    def _context_params(self) -> dict:
        c = self._term_context()
        keys = ("xn", "xqM", "nj")
        return {k: c[k] for k in keys if c.get(k) not in (None, "")}

    def total_weeks(self):
        """学期总周数。🔴 本校没有权威端点（getWsxkTimeRange 不存在）。

        退路是「所有课程周次的最大值」—— 它不会把任何一门课藏起来
        （每门课的周次都 ≤ 这个值），代价是纯复习周看不见。
        config 里给了 ``semester.total_weeks`` 就以它为准，用来纠正。
        """
        forced = (self.cfg.get("semester") or {}).get("total_weeks")
        if forced:
            try:
                n = int(forced)
                if 10 <= n <= 40:
                    return n
            except (TypeError, ValueError):
                pass
        return None      # 交给 timetable() 用实测最大值兜底

    def _fetch_table(self, page_key: str, extra: dict = None) -> list:
        """DataTable.jsp 取一页表格行 —— 本校**只剩考试/空教室可能用到**，
        那两页还没抓包，所以这里通常直接报「未适配」。"""
        conf = self.cfg["pages"].get(page_key) or {}
        tid = conf.get("tableId", "")
        if not tid or tid.startswith("TBD"):
            raise EamsError("%s还没适配本校系统（等抓包确认入口）" % page_key)
        self.ensure_session()
        self._menu_context(page_key)
        params = {"tableId": tid, "fre": "1"}
        if conf.get("use_context", True):
            params.update(self._context_params())
        if extra:
            params.update(extra)
        r = self._jw_post(self.cfg["jw"]["data_table_path"], data=params,
                          referer=conf.get("preheat_path") or self.cfg["jw"]["home_path"])
        text = self._body_text(r)
        self._guard(text, "%s数据" % page_key)
        rows = tp.parse_data_table(text)
        return tp.apply_column_map(rows, self.cfg["column_map"].get(page_key) or {})

    def _kbt_params(self) -> str:
        """课表页的 ``params`` = base64(配置里的模板)。实测原文：
        ``eG49MjAyNiZ4cT0wJnhoPTIwMjQwMTAxMDEzOA==`` → ``xn=2026&xq=0&xh=202401010138``
        模板放 config（pages.timetable.params_b64），参数名变了不用改代码。
        """
        import base64
        ctx = self._term_context()
        tpl = (self.cfg["pages"].get("timetable") or {}).get("params_b64") \
            or "xn={xn}&xq={xq}&xh={xh}"
        try:
            raw = tpl.format(xn=ctx.get("xn", ""), xq=ctx.get("xqM", "0"),
                             xh=self.username or "")
        except (KeyError, IndexError):
            raw = "xn=%s&xq=%s&xh=%s" % (ctx.get("xn", ""), ctx.get("xqM", "0"),
                                         self.username or "")
        return base64.b64encode(raw.encode("utf-8")).decode("ascii")

    @staticmethod
    def _semester_name(ctx: dict) -> str:
        """'2026' + '第一学期' → '2026-2027学年第一学期'。"""
        xn = str(ctx.get("xn") or "")
        name = str(ctx.get("xqName") or "")
        if not xn:
            return ""
        try:
            y1 = int(xn)
        except ValueError:
            return name
        return ("%d-%d学年%s" % (y1, y1 + 1, name)) if name else ("%d-%d学年" % (y1, y1 + 1))

    # ----------------------------------------------------------- 契约输出层
    def timetable(self, semester_id: str = "", semester_name: str = "") -> dict:
        """课表。契约 {unitCount, courses[], totalWeeks, weekStart, semester}。

        🔴 2026-11-03 重写：本校课表是**独立的 jsp 页面**，不是 DataTable.jsp。
        实测入口 ``GET /student/wsxk.xskcb10319.jsp?params=<base64>``，
        格子结构见 table_parser.parse_kbt_timetable 的注释。
        该页 HTML 里直接带 学号/姓名/班级，所以学籍也顺手从这里取。

        以前那套「按 tableId 拉行 + 猜列名」在本校没有对应端点，
        所以不再保留 shape:"raw" 退路 —— 解析不出来就如实报错。
        """
        # 配置错误先报 —— 不该因为「还没建会话」把配置问题盖掉
        conf = self.cfg["pages"].get("timetable") or {}
        path = conf.get("path") or ""
        if not path:
            raise EamsError("课表入口没配置（config 的 pages.timetable.path）")
        self.ensure_session()
        # 🔴 顺序必须和浏览器一致（HAR 实测）：
        #   首页 → showYearTerm → 点菜单(getBreadcrumbs) → 目标页面。
        #   先设菜单上下文再调 showYearTerm 的话，青果按「当前上下文」校验，
        #   会直接回 1098「无效访问请求」——2026-11-03 真机上就是这么挂的。
        self._term_context()
        self._menu_context("timetable")
        r = self._jw_get(path, params={"params": self._kbt_params()},
                         headers={"Referer": self._jw_url(
                             self.cfg["jw"]["home_path"])})
        text = self._body_text(r)
        self._guard(text, "课表")
        res = tp.parse_kbt_timetable(text)

        tw = self.total_weeks() or res["totalWeeks"]
        ctx = self._term_context()
        out = {"unitCount": res["unitCount"],
               "courses": res["courses"],
               "totalWeeks": tw, "weekStart": 1,
               "semester": self._semester_name(ctx) or semester_name,
               "shape": "slots"}
        if res["empty"]:
            out["empty"] = True
        # 学籍缓存：课表页头部已有 学号/姓名/班级，profile() 省一次请求
        self._kbt_head = res["head"]
        return out

    def grades(self) -> dict:
        """成绩。契约 {summary[], overall, courses[]}。

        实测两步（HAR 2026-11-03）：
          ① ``GET /student/xscj.stuckcj.jsp?menucode=S40303`` —— 检索表单页
             （必须先访问，成绩数据页认这个页面的会话上下文）
          ② ``POST /student/xscj.stuckcj_data.jsp`` —— 返回多学期成绩表
        """
        conf = self.cfg["pages"].get("score") or {}
        path = conf.get("path") or ""
        data_path = conf.get("data_path") or ""
        if not path or not data_path:
            return {"summary": [], "overall": None, "courses": [],
                    "error": "成绩入口没配置（config 的 pages.score）"}
        try:
            self.ensure_session()
            self._term_context()          # 同上：先拿学期上下文，再动菜单
            self._menu_context("score")
            form = self._jw_get(path, params={"menucode": conf.get("menucode", "")},
                                headers={"Referer": self._jw_url(
                                    self.cfg["jw"]["home_path"])})
            self._guard(self._body_text(form), "成绩检索页")
            r = self._jw_post(data_path, data=self._score_body(conf),
                              referer=self._jw_url(path))
            text = self._body_text(r)
            self._guard(text, "成绩")
            rows = tp.parse_stuckcj(text)
        except EamsError as e:
            return {"summary": [], "overall": None, "courses": [], "error": str(e)}

        # 🔴 界面契约（app.js renderGrades 读的就是这些键，猜一个都不行）：
        #   summary  [{year:"2024-2025", term:1, count, credits, gpa}]
        #   overall  {gpa, credits, count}
        #   courses  [{term:"2024-2025 1", code, name, credit, score, gpa,
        #              category, nature}]
        # 学校原文是「2024-2025学年第一学期」+ kch/kcm/xf/cj/jd/类别/修读性质，
        # 这里做一次翻译 —— 界面不改，只改这层。
        courses, summary = [], []
        seen = []
        for r in rows:
            year, tno = _split_term(r.get("term") or "")
            if year and r.get("term") not in seen:
                seen.append(r.get("term"))
            courses.append({
                "term": ("%s %d" % (year, tno)) if year else (r.get("term") or ""),
                "code": r.get("kch", ""), "name": r.get("kcm", ""),
                "credit": r.get("xf", ""), "score": r.get("cj", ""),
                "gpa": r.get("jd", ""), "category": r.get("lb", ""),
                "nature": r.get("ksxz", ""),
            })
        for t in seen:
            year, tno = _split_term(t)
            sub = [c for c in courses if c["term"] == "%s %d" % (year, tno)]
            cr = 0.0
            for c in sub:
                try:
                    cr += float(c["credit"] or "")
                except (TypeError, ValueError):
                    pass
            summary.append({"year": year, "term": tno, "count": len(sub),
                            "credits": round(cr, 1), "gpa": self._gpa(sub)})
        total_cr = 0.0
        for c in courses:
            try:
                total_cr += float(c["credit"] or "")
            except (TypeError, ValueError):
                pass
        return {"summary": summary,
                "overall": {"gpa": self._gpa(courses),
                            "credits": round(total_cr, 1),
                            "count": len(courses)},
                "terms": ["%s %d" % (x["year"], x["term"]) for x in summary],
                "courses": courses, "shape": "table", "empty": not courses}

    def _score_body(self, conf: dict) -> dict:
        """成绩数据页的提交体。实测原文（HAR）：

            sjxz=sjxz1&ysyx=yxcj&zx=1&fx=1&wz=0&rxnj=2024&nj=2024
            &btnExport=导出&xn1=2027&ysyxS=on&sjxzS=on&zxC=on&fxC=on
            &xsjd=1&menucode_current=S40303

        ``rxnj``/``nj`` 是入学年级（学号前 4 位），``xn1`` 是学年+1 ——
        都能从已登录状态推出来，所以不写死在 config 里；config 只放
        那堆语义不明的开关（sjxz/ysyx/zx/fx…），抓包变了好改。
        """
        ctx = self._term_context()
        base = dict(conf.get("body") or {})
        xn = str(ctx.get("xn") or "")
        nj = (self.username or "")[:4]
        sub = {"xn": xn, "xn1": str(int(xn) + 1) if xn.isdigit() else "",
               "xq": str(ctx.get("xqM", "0")), "nj": nj, "rxnj": nj,
               "menucode_current": conf.get("menucode", "")}
        for k, v in list(base.items()):
            if "{" in str(v):
                try:
                    base[k] = str(v).format(**sub)
                except (KeyError, IndexError):
                    pass
        for k in ("xn", "xn1", "xq", "nj", "rxnj", "menucode_current"):
            if k not in base and sub.get(k):
                base[k] = sub[k]
        return base

    @staticmethod
    def _gpa(rows: list):
        """加权平均绩点 = Σ(绩点×学分) / Σ学分。非数字绩点（良好/合格）跳过。"""
        tot_c, tot_n = 0.0, 0.0
        for g in rows:
            jd_raw = g.get("gpa", g.get("jd", ""))
            xf_raw = g.get("credit", g.get("xf", ""))
            try:
                jd = float(jd_raw or "")
                xf = float(xf_raw or "")
            except (TypeError, ValueError):
                continue
            if xf <= 0:
                continue
            tot_c += jd * xf
            tot_n += xf
        return round(tot_c / tot_n, 2) if tot_n else None

    def exams(self, semester_id: str = "") -> dict:
        """考试：用户 2026-11-03 明确说「不用管」，本校入口未抓。
        如实返回未适配，不编数据。"""
        return {"exams": [], "published": False,
                "error": "考试安排还没适配本校系统"}

    def semesters(self) -> list:
        """学期下拉：来源是成绩页返回的「学年学期」分段（实测一次给全 4 个）。"""
        try:
            g = self.grades()
        except Exception:  # noqa: BLE001
            return []
        return [{"id": t, "name": t} for t in (g.get("terms") or [])]

    def profile(self) -> dict:
        """学籍。🔴 本校「学籍档案」页还没抓过（用户只点了课表/成绩/考试）。

        但**课表页头部就带 学号/姓名/所在班级**，够「我的」页显示主体信息：
        学院/专业/年级尽量从班级名里拆（「2024级软件工程本科2班」→
        2024 / 软件工程），拆不出就留空 —— 宁可空着，不编。
        等抓到学籍档案页再补全（那时把 _kbt_head 换成真正的学籍表即可）。
        """
        head = getattr(self, "_kbt_head", None)
        if not head:
            try:
                self.timetable()
            except EamsError:
                head = None
            head = getattr(self, "_kbt_head", None)
        if not head:
            # 退一步：至少把登录用的学号交出去，界面不会一片空白
            return {"studentId": self.username or ""} if self.username else {}
        out = {"studentId": head.get("studentId", ""),
               "name": head.get("name", "")}
        clazz = head.get("clazz", "")
        if clazz:
            out["clazz"] = clazz
            m = re.match(r"(\d{4})级(.+?)(?:本科|专科|专升本)?(\d+)班$", clazz)
            if m:
                out["grade"] = m.group(1)
                out["major"] = m.group(2)
            else:
                m2 = re.match(r"(\d{4})级", clazz)
                if m2:
                    out["grade"] = m2.group(1)
        if head.get("credits"):
            out["credits"] = head["credits"]
        return out

    def room_options(self) -> dict:
        """空闲教室下拉（教学楼/节次等）。selects 解析，未配置时报可操作错误。"""
        try:
            self.ensure_session()
        except EamsError:
            raise
        conf = self.cfg["pages"].get("free_room") or {}
        mc = conf.get("menucode", "")
        if not mc or mc.startswith("TBD"):
            raise EamsError("空闲教室的 menucode 还没配置（等校内抓包）")
        self._menu_context("free_room")
        r = self._jw_get(conf.get("preheat_path") or self.cfg["jw"]["home_path"])
        sel = tp.parse_selects(self._body_text(r), {})
        # 真实 select name 待抓包；先返回空结构，字段名对齐 bridge
        return {"types": sel.get("types", []), "campuses": sel.get("campuses", []),
                "buildings": sel.get("buildings", [])}

    def free_rooms(self, date_begin: str = "", date_end: str = "",
                   period_begin: int = 1, period_end: int = 2,
                   building_id: str = "", campus_id: str = "",
                   type_id: str = "", seats: str = "", name: str = "",
                   page_size: int = 1000) -> dict:
        if not date_begin or not date_end:
            raise EamsError("要查哪一天？日期不能空")
        mx = self.cfg["free_room"].get("max_periods")
        if mx and not (1 <= period_begin <= period_end <= int(mx)):
            raise EamsError("节次要在 1~%s 之间，且开始不晚于结束" % mx)
        try:
            rows = self._fetch_table("free_room", extra={
                "date": date_begin, "pb": period_begin, "pe": period_end,
                "building": building_id, "campus": campus_id,
                "type": type_id, "seats": seats, "name": name})
        except EamsError:
            raise        # 原样上抛：两轨提示必须逐字一致（W5 对拍比的是同不同）
        rooms = [{"name": r.get("教室名称", ""), "building": r.get("教学楼", ""),
                  "campus": r.get("校区", ""), "type": r.get("教室类型", ""),
                  "capacity": _to_int(r.get("容量"))} for r in rows]
        notice = [r.get("备注") for r in rows if r.get("备注") == "停课"]
        out = {"rooms": rooms, "notice": [n for n in notice if n],
               "raw": len(rows), "shape": "raw",
               "dateBegin": date_begin, "dateEnd": date_end,
               "periodBegin": period_begin, "periodEnd": period_end,
               "truncated": len(rows) >= page_size}
        return out

    def plan(self) -> dict:
        """培养计划：青果端点未确认（阶段2 若顺路抓不到就维持 error）。
        结构与 eams.plan 出错时的契约一致：{total,cats,courses,subs,specials,error}。"""
        return {"total": 0, "cats": [], "courses": [], "subs": [],
                "specials": [],
                "error": "青果版培养计划端点未配置（待抓包）"}

    def todo(self) -> dict:
        # 青果的选课/评教/免听/免修开放状态端点待抓包。返回**空列表 + note**：
        # note 必须和 native.js 的 todo() 逐字一致（W5 对账在盯），界面无 note
        # 时会退化成「这次四项都没有新消息」= 把「没适配」说成「没开放」（红线 20）。
        return {"items": [],
                "note": "本校教务的选课/评教状态还没接入，暂不查询这四类事项。"}


def _to_int(s):
    try:
        return int(re.sub(r"\D", "", str(s)) or 0)
    except Exception:
        return 0
