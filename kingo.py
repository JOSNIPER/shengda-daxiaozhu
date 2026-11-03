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
        self._context = {}            # getWsxkTimeRange 给的 xn/xqM/lcid…
        self._context_loaded = False

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
        if referer:
            headers.setdefault("Referer", self._jw_url(referer))
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
    def ensure_session(self, force: bool = False) -> None:
        """CASTGC → ST → caslogin → 菜单上下文 → 预热。幂等。

        🔴 只要拿得到 CASTGC 就重新换票（shengda-qk 实测教训：门户的
        JSESSIONID 与教务的不是同一个，看到同名 cookie 就跳过会一路"凭证已失效"）。
        """
        if self._ready and not force:
            return
        if not self._logged_in:
            raise EamsError("还没登录", kind="auth")
        tgt = self._ck("CASTGC")
        service = self.cfg["jw"]["cas_service"]
        if tgt:
            r = self._request("POST", "%s%s/%s" % (self.cas_base,
                              self.cfg["cas"]["tickets_path"].rstrip("/"), tgt),
                              data={"service": service}, allow_redirects=False)
            m = re.search(r"(ST-[A-Za-z0-9._\-]+)", r.text or "")
            if not m:
                raise EamsError("CAS 会话已过期（CASTGC 失效），请重新登录", kind="auth")
            joiner = "&" if "?" in service else "?"
            self._request("GET", service + joiner + "ticket=" + m.group(1),
                          allow_redirects=True)
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
    def _load_context(self) -> dict:
        """选课/查询上下文（xn/xqM/lcid/nj/zydm…）与 🔴 学期总周数。
        周数只能从这里来，不能用末课所在周反推（郑航 24 vs 18 的坑）。"""
        if self._context_loaded:
            return self._context
        r = self._jw_get(self.cfg["jw"]["time_range_path"], params={"xktype": "2"})
        j = tp._double_encoded_json(r.text)
        if not j:
            self._guard(self._body_text(r), "学期时间范围")
            raise EamsError("学期上下文没取到（响应不是预期 JSON）")
        ctx = j.get("result") if isinstance(j.get("result"), dict) else j
        if isinstance(ctx, dict):
            self._context = ctx
        self._context_loaded = True
        return self._context

    def _context_params(self) -> dict:
        c = self._load_context()
        keys = ("xn", "xqM", "kcfw", "lcid", "nj", "zydm", "yxbdm")
        return {k: c[k] for k in keys if k in c and c[k] not in (None, "")}

    def total_weeks(self):
        """学期总周数（整数或 None）。🔴 唯一合法来源=time_range 端点。"""
        c = self._load_context()
        for k in ("zs", "zxs", "totalWeeks", "xqzs"):
            v = c.get(k)
            if v is not None:
                try:
                    n = int(float(v))
                    if 10 <= n <= 40:
                        return n
                except (TypeError, ValueError):
                    pass
        return None

    def _fetch_table(self, page_key: str, extra: dict = None) -> list:
        """DataTable.jsp 取一页表格行 [{青果列名:文本}]。TBD 未配置则报可操作错误。"""
        conf = self.cfg["pages"].get(page_key) or {}
        tid = conf.get("tableId", "")
        if not tid or tid.startswith("TBD"):
            raise EamsError("%s的 tableId 还没配置（等校内抓包填入 config/shengda.json）"
                            % page_key)
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

    # ----------------------------------------------------------- 契约输出层
    def timetable(self, semester_id: str = "", semester_name: str = "") -> dict:
        """课表。契约 {unitCount, courses[], totalWeeks, weekStart, semester}。

        🔴 会话类错误**向上抛**（与 eams.EamsClient.timetable 一致）——
        bridge.Service._with_client 靠捕获 EamsError 触发"重登一次再试"；
        在这里吞掉会把"重登能救"变成"界面显示空课表"。

        课程行的形状：config 里开了 timetable.parse_slots 才把青果三列
        （skxq/skjc/zc）拼成格子用的 slots/weeks；**任何一行拼不出来就整批
        退回原样行**（shape:"raw"），绝不画一张可能错的课表。
        """
        rows = self._fetch_table("timetable")   # EamsError 直接上抛
        tw = None
        try:
            tw = self.total_weeks()
        except EamsError:
            pass
        tcfg = self.cfg.get("timetable") or {}
        unit_count = tcfg.get("unit_count", 12)
        courses, shape = rows, "raw"
        if tcfg.get("parse_slots") and rows:
            shaped = tp.shape_courses(rows, unit_count)
            if shaped is not None:
                courses, shape = shaped, "slots"
        out = {"unitCount": unit_count,
               "courses": courses, "totalWeeks": tw, "weekStart": 1,
               "semester": self._context.get("lcmc", "") or semester_name,
               "shape": shape}
        if not rows:
            out["empty"] = True   # 空表≠过期（守卫已在 _fetch 区分过）
        return out

    def grades(self) -> dict:
        """成绩。契约 {summary[], overall, courses[]}。同上：先 raw。"""
        try:
            rows = self._fetch_table("score")
        except EamsError as e:
            return {"summary": [], "overall": None, "courses": [], "error": str(e)}
        return {"summary": [], "overall": None, "courses": rows, "shape": "raw",
                "empty": not rows}

    def exams(self, semester_id: str = "") -> dict:
        try:
            rows = self._fetch_table("exam")
        except EamsError as e:
            return {"exams": [], "published": False, "error": str(e)}
        return {"exams": rows, "published": bool(rows), "shape": "raw"}

    def semesters(self) -> list:
        """学期下拉。青果来源端点未确认（郑航是 dataQuery.action）——
        抓包确认前返回空列表且不报错：考试页界面据此只显示当前学期。"""
        m = re.search(r"(\d{4})-(\d{4})", str(self._load_context().get("xn", "")))
        if m:
            return [{"id": "%s-%s/%s" % (m.group(1), m.group(2),
                                          self._context.get("xqM", "1")),
                     "name": "%s-%s学年第%s学期" % (m.group(1), m.group(2),
                                                    self._context.get("xqM", "1"))}]
        return []

    def profile(self) -> dict:
        """学籍中文键 → 契约键（_PROFILE_KEYS 沿用 eams 的映射表）。

        青果学籍表两种版式都见过：一行两对(键,值,键,值…) 和 两列(键,值)。
        统一按**值扫描**：某个单元格等于标签 → 取它右边第一个非空值。"""
        from eams import _PROFILE_KEYS
        try:
            rows = self._fetch_table("profile")
        except EamsError as e:
            raise EamsError("学籍信息没取到：%s" % e, kind="auth")
        out = {}
        for r in rows:
            vals = list(r.values())
            for i, v in enumerate(vals):
                key = (v or "").strip().rstrip("：:")
                if key in _PROFILE_KEYS and i + 1 < len(vals):
                    val = (vals[i + 1] or "").strip()
                    if val and val != "*":
                        out.setdefault(_PROFILE_KEYS[key], val)
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
        except EamsError as e:
            raise EamsError("空闲教室查询失败：%s" % e)
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
