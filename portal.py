"""郑航智慧门户（rhmh.zua.edu.cn）· 一卡通 + 办事应用

这个模块只干一件事：用**你自己**登录出来的会话，把门户里两块数据读出来 ——
一卡通余额/消费明细，以及 19 个办事系统的入口。

--------------------------------------------------------------------------
三条硬规矩（都是踩出来的，别绕）

  1. 🔴 **绝不自动识别验证码。** 门户错 5 次就锁号，而「验证码识别错了」和
     「密码打错了」在服务器那边走的是同一个计数器。所以图交给人看、
     答案由人填 —— 慢一点，但不会把号锁掉。

  2. 🔴 **判据必须是「需要登录的接口返回 200」。** `/api/upp/Unauthorize/*`
     那一族不登录也返回 200，拿它验证「登录成功」等于没验证；
     「URL 里有 ticket=」「cookie 里有 customsid」同样都是假判据
     （10-21 就是这样假成功过一次）。

  3. 🔴 **过期就说过期，不许把「没读到」显示成「没有数据」。**
     余额读不到要能表达成「不知道」，而不是「0.00 元」——
     后者会让人以为钱没了。

--------------------------------------------------------------------------
门户是「门票 + 身份证」两层（这个比方很重要，不理解就会乱重登）

    customsid + Authorization（rhmh 域）  = 门票，几小时就作废
    CASTGC（sfrz 域，CAS 的 TGT）        = 身份证，有效期长得多

  门票没了不要紧，拿着身份证去 `/auth?service=...` 走一趟就能换张新的，
  **不用密码、不用验证码**。所以日常刷新是零成本的：
  只有身份证也过期了，才需要真的重新登录一次。
"""

from __future__ import annotations

import base64
import functools
import json
import threading
import time

import requests

# ------------------------------------------------------------------ 常量

SF = "https://sfrz.zua.edu.cn/lyuapServer"          # CAS（发门票的地方）
RH = "https://rhmh.zua.edu.cn"                      # 智慧门户

# 🔴 `service` 给的是**带 /shiro-cas 的完整地址**，这里和 `/auth` 不一样：
#    `/auth?service=` 要裸域名（它自己会拼 /shiro-cas，多给一次就拼成
#    /shiro-cas/shiro-cas → 404）；而登录表单里这个 `service` 是门户已经
#    拼好的结果，原样回传就行。两者别搞混。
SERVICE = RH + "/shiro-cas"

# 备注：`https://rhmh.zua.edu.cn/auth?service=<裸域名>` 也能换来门票，
# 但它走的是 rhmh 自己的会话（customsid），**不认 CASTGC** ——
# 会话一过期它就跳去 CAS 登录页，看起来像「身份证也过期了」。
# 真正靠身份证续期的是 `POST /lyuapServer/v1/tickets/{CASTGC}`，
# 见 Portal.renew()。

SITE = "e4cc6a13ff4046ccae6d8e8480eb2ba0"
# 需要登录才能访问的接口，用来判断「会话到底活没活」
CHECK = RH + "/api/upp/pages/getPage?siteId=" + SITE
CARD_YKT = "1b1029d961e94aa196fb7f0ec072d622"      # 一卡通卡片
APP_STORE = RH + "/api/upp/appStore/queryApp"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")

# RSA 公钥，从门户 app.js 里抠出来的（public_exponent / modulus 两个字面量）。
# 门户在浏览器里就把密码加密了才发，所以我们也得这么发 ——
# 发明文的话服务器解不开，表现就是「密码错误」，很容易误判成用户记错密码。
MODULUS = int(
    "00b5eeb166e069920e80bebd1fea4829d3d1f3216f2aabe79b6c47a3c18dcee5"
    "fd22c2e7ac519cab59198ece036dcf289ea8201e2a0b9ded307f8fb704136eaeb"
    "670286f5ad44e691005ba9ea5af04ada5367cd724b5a26fdb5120cc95b6431604"
    "bd219c6b7d83a6f8f24b43918ea988a76f93c333aa5a20991493d4eb1117e7b1", 16)
EXPONENT = 65537
KEY_BYTES = (MODULUS.bit_length() + 7) // 8          # 128

# 一卡通明细一次给 12 条（服务端写死的），33 条要翻 3 页。
# 上限 4 页：再多的历史记录对「看看最近花哪了」没有意义，
# 而每页一次请求，翻十页就是十次。
MAX_PAGES = 4

# 登录失败的编码 → 人话。CODEFALSE 是「验证码错」，它**分不清**
# 「字段名错」和「答案错」，所以见到它就别再猜别的原因了。
CODE_TEXT = {
    "CODEFALSE": "验证码算错了，换一张重算",
    "NOREGISTER": "这个账号还没开通门户",
    "NOAUTHORIZATION": "这个账号没有门户的使用权限",
    "ISMODIFYPASS": "门户要求先改密码，请去网页版改完再来",
    "NETWORKCOMMITMENT": "要先同意网络使用承诺书，请去网页版点一下",
}


class PortalError(Exception):
    """kind:
        expired —— 会话/身份证都过期了，必须重新登录
        auth    —— 账号密码被拒
        code    —— 验证码问题
        net     —— 网络/服务器问题（换台网络再试就好，别让人白输密码）

    code:
        门户原样返回的错误码（`PASSERROR` / `CODEFALSE` / …），认不出来就是空串。
        🔴 为什么要单独留一份：`kind` 只分到「auth」，而「密码错」和「验证码错」
        都落在这里 —— 界面要据此决定「能不能把本机存的那份密码扔掉」，
        靠中文文案去猜是行不通的。
    """

    def __init__(self, msg: str, kind: str = "net", code: str = "") -> None:
        super().__init__(msg)
        self.kind = kind
        self.code = code


# 这几个码说明「本机存着的那份密码已经不对了」，只有它们才允许把密码删掉。
# 🔴 `CODEFALSE`（验证码算错）**不在此列**：一次手滑就把密码删了，
#    用户下次还得重输，等于白存。
PWD_BAD_CODES = ("PASSERROR", "NOUSER", "USERLOCK")


# ------------------------------------------------------------------ RSA

def rsa_hex(text: str) -> str:
    """把密码加密成 256 位十六进制（门户要求的形式）。

    ⚠️ 这里**不是**标准的 PKCS#1 v1.5 —— 踩过一次坑，写清楚：

    门户前端用的是老版 jsbn（Dave Shapiro 那套 `RSAKeyPair` / `encryptedString`，
    标志是 `setMaxDigits(131)` 加三参数的 `RSAKey(e, "", n)`）。
    它的做法是：
        1. 把密码逐字符塞进字节数组，末尾补 0 到 chunkSize 的整数倍
           （chunkSize = 2 * biHighIndex(m) = 126，实测补到 126/127/128 都一样，
            因为补的都是末尾的 0）；
        2. 按 **小端** 16 位字拼成大整数：`digits[j] = a[k] + (a[k+1] << 8)`。

    第 2 步是全部关键：**字节序是小端**，等于 `int.from_bytes(密码, "little")`。
    我一开始按标准 PKCS#1 v1.5（`00 02 || 随机 || 00 || 明文`，大端）写，
    服务器回 `PASSERROR`（密码错）—— 而且因为它分不清「解不开」和「密码不对」，
    看起来就像密码记错了，非常容易往错的方向查。

    好消息：没有随机数 ⇒ 同样的密码永远算出同样的密文，可以拿抓包结果
    逐字节对拍。现在这份实现和浏览器发出去的**完全一致**。
    """
    msg = text.encode("utf-8")
    # 超过一个分组就要分块，那属于「密码长到不像密码」，直接拒绝而不是算错。
    if len(msg) > 126:
        raise PortalError("密码太长了（超过 126 字节）", "auth")
    m = int.from_bytes(msg, "little")
    return pow(m, EXPONENT, MODULUS).to_bytes(KEY_BYTES, "big").hex()


# ------------------------------------------------------------------ 小工具

def jwt_sub(token: str) -> str:
    """从 JWT 里取 `sub`（学号）。取不到就返回空串，不抛异常 ——
    身份显示不出来不该让整页数据一起挂掉。"""
    try:
        p = token.split(".")[1]
        p += "=" * (-len(p) % 4)
        return str(json.loads(base64.urlsafe_b64decode(p)).get("sub") or "")
    except Exception:  # noqa: BLE001
        return ""


def _label_of(app: dict) -> str:
    """应用归属部门。`labelName` 是 `[{zh_CN: {labelName: '日常服务'}}]`，
    但接口在某些应用上会给空数组、给 `None`、或者干脆给个对象 ——
    一律用 isinstance 挡一遍，别让一个畸形字段打断整张列表。"""
    lab = app.get("labelName")
    if isinstance(lab, list) and lab:
        first = lab[0]
    elif isinstance(lab, dict):
        first = lab
    else:
        return ""
    if not isinstance(first, dict):
        return ""
    zh = first.get("zh_CN")
    if not isinstance(zh, dict):
        return ""
    return str(zh.get("labelName") or "").strip()


def _find_prefixed(obj, prefix: str, depth: int = 0) -> str:
    """在返回的 JSON 里递归找以某个前缀开头的字符串。

    为什么要递归找而不是写死 `data.ticket`：CAS 这个接口在不同版本里把
    ticket 放在 `ticket` / `data.ticket` / `tgt` 上，写死一层就等于
    赌服务端版本不变。找前缀总是稳的（ticket 是 `ST-`，身份证是 `TGT-`）。
    """
    if depth > 6:
        return ""
    if isinstance(obj, str):
        return obj if obj.startswith(prefix) else ""
    if isinstance(obj, dict):
        for k in ("ticket", "tgt"):
            v = obj.get(k)
            if isinstance(v, str) and v.startswith(prefix):
                return v
        for v in obj.values():
            got = _find_prefixed(v, prefix, depth + 1)
            if got:
                return got
    elif isinstance(obj, list):
        for v in obj:
            got = _find_prefixed(v, prefix, depth + 1)
            if got:
                return got
    return ""


# ------------------------------------------------------------------ 主体

def _locked(fn):
    """把公开方法串起来。

    为什么需要：前端是 `Promise.all([card, apps])` —— 两个请求真的会同时
    打到 bridge。而 `requests.Session` 的 cookie jar 不是线程安全的，
    两个线程同时改它，轻则丢 cookie（表现为「刚登录就说过期」），
    重则「续期」和「取数」互相覆盖。串行之后总耗时也就一秒出头，值得。
    """
    @functools.wraps(fn)
    def wrapper(self, *a, **kw):
        with self.lock:
            return fn(self, *a, **kw)
    return wrapper


class Portal:
    """一个门户会话。线程不安全，用 `lock` 串起来（bridge 是单线程处理
    请求的，但后台刷新和用户点击可能撞上）。"""

    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9",
        })
        self.lock = threading.RLock()
        self._cap = None          # (uid, 到期时刻)：验证码是一次性的
        self.user = ""

    # ---------------------------------------------------------- cookie 存取

    def dump(self) -> list[dict]:
        """导出 cookie 给调用方加密存盘。

        只留 rhmh / sfrz 两个域的 —— 门户页面上可能还有别的第三方 cookie
        （埋点之类），存下来既没用又是隐私负担。
        """
        out = []
        for c in self.s.cookies:
            dom = c.domain or ""
            if not (dom.endswith("rhmh.zua.edu.cn") or dom.endswith("sfrz.zua.edu.cn")):
                continue
            out.append({"name": c.name, "value": c.value, "domain": dom,
                        "path": c.path or "/",
                        "expires": int(c.expires) if c.expires else 0})
        return out

    def load(self, cookies: list) -> None:
        for c in cookies or []:
            if not isinstance(c, dict) or not c.get("name"):
                continue
            kw = {"path": c.get("path") or "/"}
            # 🔴 Playwright 那边会话 cookie 的 expires 是 -1，requests 会当成
            #    「1969 年就过期」直接丢掉。所以只有正数才写。
            if c.get("expires") and int(c["expires"]) > 0:
                kw["expires"] = int(c["expires"])
            try:
                self.s.cookies.set(c["name"], c.get("value") or "",
                                   domain=c.get("domain") or "", **kw)
            except Exception:  # noqa: BLE001
                pass

    def _ck(self, name: str) -> str:
        for c in self.s.cookies:
            if c.name == name and (c.domain or "").endswith("zua.edu.cn"):
                return c.value
        return ""

    def _drop_ticket(self) -> None:
        """把「门票」扔掉，留着「身份证」。
        门票失效时服务端会回一个 `Authorization=; Max-Age=0`，
        但那是在跳转中间发生的，requests 有时收不全，干脆主动清掉。"""
        keep = [c for c in self.s.cookies if c.name != "Authorization"]
        self.s.cookies.clear()
        for c in keep:
            self.s.cookies.set(c.name, c.value, domain=c.domain, path=c.path or "/")

    # ---------------------------------------------------------- 判活 / 续期

    def has_ticket(self) -> bool:
        return bool(self._ck("Authorization"))

    def who(self) -> str:
        """当前登录的学号。从 cookie 里的 JWT 现算 —— 这样从磁盘恢复会话
        之后也能立刻显示「是谁的卡」，不用等下一次请求。"""
        return self.user or jwt_sub(self._ck("Authorization"))

    def has_id(self) -> bool:
        """身份证（CASTGC）还在不在。**在不在 ≠ 有没有过期** ——
        它可能早就被服务端作废了，只有真的去换一次票才知道。
        所以这个方法只用来决定「值不值得试一下」，不用来下结论。"""
        return bool(self._ck("CASTGC"))

    @_locked
    def check(self) -> bool:
        """真问一次服务器：需要登录的接口是不是 200。

        ⚠️ 这个会发网络请求，只在真的要确认时才调 —— 平时的
        「状态」是本地看 cookie 得出的，不探网。
        """
        jwt = self._ck("Authorization")
        if not jwt:
            return False
        try:
            r = self.s.get(CHECK, headers=self._hdr(jwt), timeout=20,
                           allow_redirects=False)
        except requests.RequestException:
            raise PortalError("连不上学校门户，检查一下网络", "net")
        return r.status_code == 200

    @_locked
    def ticket_for(self, service: str) -> str:
        """拿身份证换一张**以 service 为服务地址**的票（办事系统进门用）。

        🔴 和 `renew()` 的区别：那个把 service 写死成门户自己（SERVICE），
           换来的票只能让门户认你。办事系统要的是**以它自己地址为 service**
           的票 —— 票和 service 是绑定的，拿门户的票去开别的系统一律
           INVALID_TICKET，然后老老实实弹登录页（看着就像「没登录」）。

        🔴 为什么用票而不是「把 cookie 倒进浏览器」（2026-10-27 真机）：
           APK 那边登录走 CAS REST，服务端把 TGT 放在响应体里，
           **不会下发 CASTGC 这张 cookie**。所以「把 CASTGC 倒进 WebView」
           那条路在手机上是空的 —— 罐子里从来没有这张。
           票拼在地址后面，系统自己拿去 CAS 验，不经过任何 cookie 罐子。

        返回 ST-xxx；换不到就抛 PortalError（expired = 身份证也过期了）。
        """
        tgt = self._ck("CASTGC")
        if not tgt:
            raise PortalError("本机没有门户的登录凭据，重新连一次就行", "expired")
        try:
            r = self.s.post(
                "%s/v1/tickets/%s" % (SF, tgt),
                data={"service": service}, timeout=25, allow_redirects=False,
                headers={"Content-Type":
                         "application/x-www-form-urlencoded;charset=UTF-8"})
        except requests.RequestException:
            raise PortalError("连不上学校门户，检查一下网络", "net")
        body = (r.text or "").strip()
        ticket = body if body.startswith("ST-") else \
            _find_prefixed(self._try_json(r), "ST-")
        if not ticket:
            # 网络问题上面已经抛掉了，走到这儿是服务器明确不给票
            raise PortalError("门户登录过期了，重新连一次就行", "expired")
        return ticket

    @_locked
    def renew(self) -> bool:
        """拿身份证换新门票。成功返回 True，身份证也过期了返回 False。

        🔴 入口是 `POST /v1/tickets/{TGT}`，**不是** CAS 的登录页。
           这条走了两次弯路，记下来：
           ① 先试 `GET /lyuapServer/login?service=...` 带 CASTGC ——
              服务器根本不看这个 cookie，直接回登录页（200），
              看起来就像「身份证过期了」；
           ② 再试 `GET rhmh/auth` —— 它只用 rhmh 自己的会话，会话没了就
              跳去 CAS 登录页，同样不认身份证。
           正确做法是从门户前端源码里读出来的：
              `POST /lyuapServer/v1/tickets/<CASTGC>` + 表单 `service=...`
              → 直接回纯文本 `ST-...`，这就是新门票。
        """
        tgt = self._ck("CASTGC")
        if not tgt:
            return False
        try:
            r = self.s.post("%s/v1/tickets/%s" % (SF, tgt),
                            data={"service": SERVICE}, timeout=25,
                            allow_redirects=False,
                            headers={"Content-Type":
                                     "application/x-www-form-urlencoded;charset=UTF-8"})
        except requests.RequestException:
            raise PortalError("连不上学校门户，检查一下网络", "net")

        ticket = ""
        if r.status_code == 200:
            body = (r.text or "").strip()
            ticket = body if body.startswith("ST-") else \
                _find_prefixed(self._try_json(r), "ST-")
        if not ticket:
            # 服务器明确说「不给票」才算身份证过期；网络问题上面已经抛掉了，
            # 不会把「断网」误判成「要重新登录」。
            return False

        try:
            self.s.get(SERVICE, params={"ticket": ticket}, timeout=25,
                       allow_redirects=True)
            # 补一刀：门户首页会把 Authorization 写进 cookie
            self.s.get(RH + "/", timeout=25, allow_redirects=True)
        except requests.RequestException:
            raise PortalError("换票的时候断网了", "net")
        return self.has_ticket()

    def _hdr(self, jwt: str = "", json_body: bool = False) -> dict:
        h = {
            "authorization": jwt or self._ck("Authorization"),
            "accept": "application/json, text/plain, */*",
            "languagetype": "zh",
            "x-requested-with": "XMLHttpRequest",
            "referer": RH + "/",
            "origin": RH,
        }
        if json_body:
            h["content-type"] = "application/json"
        return h

    def _call(self, fn):
        """跑一次取数。门票过期就自动换一张再跑一次；身份证也过期才报错。

        只在**失败时**才换票（和桌面端换下载源一个思路）：
        每次请求前先探一下，等于把请求数翻倍。
        """
        try:
            return fn()
        except PortalError as e:
            if e.kind != "expired":
                raise
            self._drop_ticket()
            if not self.renew():
                raise PortalError("门户登录过期了，重新输一次密码和验证码就行",
                                  "expired")
            return fn()

    # ---------------------------------------------------------- 验证码 / 登录

    @_locked
    def captcha(self) -> dict:
        """拿一张验证码。返回 {img, timeout}，`img` 是可以直接塞进 <img src> 的
        data URL。

        ⚠️ `uid` 只存在服务端内存里、**不回给前端** —— 前端提交时只带
           密码和答案。这样验证码天然和这次会话绑定，也不会被页面上的
           脚本改掉（改了就等于帮用户答错）。
        """
        try:
            r = self.s.get(SF + "/kaptcha", timeout=20,
                           headers={"referer": SF + "/login?service=" + SERVICE,
                                    "x-requested-with": "XMLHttpRequest"})
            j = r.json()
        except (requests.RequestException, ValueError):
            raise PortalError("拿不到验证码，检查一下网络", "net")
        uid = str(j.get("uid") or "")
        img = str(j.get("content") or "")
        if not uid or "base64," not in img:
            raise PortalError("验证码接口返回的形状不对（门户可能改版了）", "net")
        life = int(j.get("timeout") or 300)
        # 留 15 秒余量：算得太慢的话，服务端那边其实已经作废了，
        # 这时候提交必然「验证码错误」，白白消耗一次错误次数。
        self._cap = (uid, time.time() + max(30, life - 15))
        return {"img": img, "timeout": life}

    @_locked
    def login(self, user: str, pwd: str, code: str) -> dict:
        """用密码 + 验证码登录一次。

        成功后 `self.user` 是学号，cookie 里会有 CASTGC（身份证）。
        """
        if not self._cap or time.time() > self._cap[1]:
            raise PortalError("验证码过期了，换一张重新算", "code")
        uid = self._cap[0]
        self._cap = None            # 🔴 一次性：不管成没成，这张都不能再用

        form = {
            "username": user,
            "password": rsa_hex(pwd),
            "service": SERVICE,
            "loginType": "",
            "id": uid,
            "code": code,
            "otpcode": "",
        }
        try:
            r = self.s.post(SF + "/v1/tickets", data=form, timeout=30,
                            allow_redirects=True,
                            headers={"referer": SF + "/login?service=" + SERVICE,
                                     "origin": "https://sfrz.zua.edu.cn",
                                     "x-requested-with": "XMLHttpRequest",
                                     "accept": "application/json, text/plain, */*"})
        except requests.RequestException:
            raise PortalError("连不上学校门户，检查一下网络", "net")

        j = self._try_json(r)
        ticket = _find_prefixed(j, "ST-") or self._ticket_in_url(r.url)
        tgt = _find_prefixed(j, "TGT-")

        # 🔴 CASTGC（身份证）**不是**服务器用 Set-Cookie 下发的，是门户前端
        #    自己写进 cookie 的（app.js 里那句 `n.i(v.c)("CASTGC", tgt, ...)`，
        #    tgt 取自登录接口返回的 JSON）。
        #    不补这一步，「免验证码续期」永远不会生效 —— 每次过期都得重新
        #    输密码 + 算验证码，白瞎了 CASTGC 能活好几小时。
        if tgt and not self._ck("CASTGC"):
            self.s.cookies.set("CASTGC", tgt, domain="sfrz.zua.edu.cn", path="/")

        # 先看是不是直接给票了（CAS 有些版本会 302 到 service?ticket=）
        if not self.has_ticket():
            if ticket:
                try:
                    self.s.get(SERVICE, params={"ticket": ticket},
                               timeout=25, allow_redirects=True)
                except requests.RequestException:
                    raise PortalError("换票的时候断网了", "net")
            # 最后补一刀：门户首页会把 Authorization 写进 cookie
            try:
                self.s.get(RH + "/", timeout=25, allow_redirects=True)
            except requests.RequestException:
                pass

        if not self.has_ticket():
            why, code = self._why_failed(r)
            raise PortalError(why, "auth", code)
        self.user = jwt_sub(self._ck("Authorization"))
        return {"user": self.user}

    @staticmethod
    def _try_json(r):
        try:
            return r.json()
        except ValueError:
            return None

    @staticmethod
    def _ticket_in_url(url: str) -> str:
        if "ticket=" not in url:
            return ""
        tail = url.split("ticket=", 1)[1].split("&", 1)[0]
        return tail if tail.startswith("ST-") else ""

    @staticmethod
    def _why_failed(r) -> tuple[str, str]:
        """把服务端的拒绝理由翻译成人话。**不猜** —— 认不出来就原样带上
        状态码，别编一个「密码错误」去误导用户。

        返回 `(给人看的文案, 门户原始错误码)`。错误码认不出来就是空串 ——
        「不知道」和「不是密码错」必须区分开，调用方靠它决定要不要删本机密码。
        """
        j = Portal._try_json(r)
        if isinstance(j, dict):
            for node in (j.get("data"), j.get("meta"), j):
                if isinstance(node, dict):
                    code = str(node.get("code") or "")
                    if code in CODE_TEXT:
                        return CODE_TEXT[code], code
                    msg = str(node.get("message") or "").strip()
                    if msg and msg.lower() not in ("ok", "success"):
                        return "门户拒绝了这次登录：%s" % msg[:60], code
        if r.status_code in (401, 403):
            return "门户拒绝了这次登录（账号或密码不对）", ""
        return "门户没有返回票据（HTTP %s），可能是账号密码不对" % r.status_code, ""

    @_locked
    def logout(self) -> None:
        self.s.cookies.clear()
        self._cap = None
        self.user = ""

    # ---------------------------------------------------------- 取数

    @_locked
    def card(self) -> dict:
        """一卡通：余额 + 最近消费明细。

        字段对应（服务端给的是拼音缩写，看名字根本猜不出来）：
            RQ    时间
            XFZD  消费地点（"西苑三层pos4"）
            DBXF  单笔金额，**本身带负号**，支出就是负数
            ZCLX  支出类型（"餐费支出"）
            YE    余额，⚠️ 前面带一串空格（`'     65.47'`），不 strip 就转不了数字
            KH    卡号
        """
        def once():
            return self._page(1)

        rows, total = self._call(once)
        all_rows = list(rows)
        page = 2
        # 12 条一页，33 条要 3 页。上限 4 页，够看一个多月的饭钱。
        while len(all_rows) < total and page <= MAX_PAGES:
            try:
                more, _ = self._call(lambda p=page: self._page(p))
            except PortalError:
                break                      # 后面几页拿不到就少给点，别整块失败
            if not more:
                break
            all_rows.extend(more)
            page += 1

        out = []
        for x in all_rows:
            if not isinstance(x, dict):
                continue
            amt = _num(x.get("DBXF"))
            out.append({
                "time": str(x.get("RQ") or "").strip(),
                "place": str(x.get("XFZD") or "").strip(),
                "amount": amt,                 # None = 读不到，不是 0
                "kind": str(x.get("ZCLX") or "").strip(),
            })
        # 余额取第一条的 YE（最新的那一笔之后的余额）。读不到就给 None。
        bal = _num(all_rows[0].get("YE")) if all_rows and isinstance(all_rows[0], dict) else None
        return {"balance": bal, "rows": out, "total": total,
                "cardNo": str((all_rows[0] or {}).get("KH") or "").strip() if all_rows else ""}

    def _page(self, startpage: int):
        """取一页。返回 (rows, pageTotalCount)。"""
        jwt = self._ck("Authorization")
        if not jwt:
            raise PortalError("还没有登录门户", "expired")
        body = {"startpage": startpage, "enablePagging": True}
        try:
            r = self.s.post("%s/api/upp/cardFrontlist/getCard/%s" % (RH, CARD_YKT),
                            headers=self._hdr(jwt, json_body=True),
                            data=json.dumps(body), timeout=25,
                            allow_redirects=False)
        except requests.RequestException:
            raise PortalError("连不上学校门户，检查一下网络", "net")
        # 302 / 401 = 门票作废（服务端会顺手把 Authorization 清掉）
        if r.status_code != 200:
            raise PortalError("门票过期", "expired")
        try:
            j = r.json()
        except ValueError:
            raise PortalError("一卡通接口返回的不是 JSON（门户可能改版了）", "net")
        if not (isinstance(j.get("meta"), dict) and j["meta"].get("success")):
            raise PortalError("一卡通接口拒绝了这次请求", "net")
        sd = (j.get("data") or {}).get("serviceData") or {}
        rows = sd.get("data") if isinstance(sd, dict) else None
        rows = rows if isinstance(rows, list) else []
        total = 0
        if rows and isinstance(rows[0], dict):
            try:
                total = int(rows[0].get("pageTotalCount") or 0)
            except (TypeError, ValueError):
                total = 0
        return rows, total

    @_locked
    def apps(self) -> list[dict]:
        """办事应用列表（实测 19 个，全部走 CAS 免登录）。

        `pageSize=-1` 才是「一次全给」，写 10 或 20 只会给你第一页。
        `excludeMobile=1` 是门户自己的参数，照抄它前端的行为。
        """
        def once():
            jwt = self._ck("Authorization")
            if not jwt:
                raise PortalError("还没有登录门户", "expired")
            try:
                r = self.s.get(APP_STORE, headers=self._hdr(jwt), timeout=25,
                               allow_redirects=False,
                               params={"pageNum": 1, "pageSize": -1,
                                       "excludeMobile": 1})
            except requests.RequestException:
                raise PortalError("连不上学校门户，检查一下网络", "net")
            if r.status_code != 200:
                raise PortalError("门票过期", "expired")
            try:
                return r.json()
            except ValueError:
                raise PortalError("应用列表接口返回的不是 JSON", "net")

        j = self._call(once)
        data = j.get("data")
        if not isinstance(data, list):
            raise PortalError("应用列表的形状不对（门户可能改版了）", "net")
        out = []
        for a in data:
            if not isinstance(a, dict):
                continue
            url = str(a.get("appLink") or a.get("mobileLink") or "").strip()
            name = str(a.get("appName") or "").strip()
            if not url or not name:
                continue          # 没有地址的入口点了也没反应，不如不显示
            out.append({"name": name, "dept": _label_of(a), "url": url,
                        "cas": str(a.get("isCas") or "") == "cas"})
        return out


def _num(v):
    """宽松转数字。转不出来就返回 None（**不是 0**）。
    `YE` 那种 `'     65.47'` 带空格的写法必须先 strip。"""
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
