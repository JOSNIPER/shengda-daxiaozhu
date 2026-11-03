# -*- coding: utf-8 -*-
"""慧生活798（直饮水）—— 余额 / 设备 / 接水 / 停止 / 积分 / 消费记录 / 积分任务。

## 这是什么

宿舍直饮水走的是慧生活798（长沙云多啦）平台，和学校门户、一卡通**不是**
一套账号。这个模块按它公开的接口协议实现，**没有复制任何第三方代码**
（第三方客户端 nocookies111/life-798 是 MIT，但我们是照着协议自己写的）。

## 🔴 做哪些、不做哪些

做：查余额、列设备、启动/停止接水、查积分、查消费记录、
    **列积分任务 + 你点了才批量跑**。

不做（2026-10-30 用户定，别再往回加）：

  · **后台自动签到** —— 不挂定时器、不在打开 App 时偷偷补签。签到是账号行为，
    替他做而他又不在场，出了事他连什么时候发生的都不知道。
    ⚠️ 任务列表里如果自带签到任务，那是「他点了批量完成」的一部分，不算后台。
  · **充值 / 下单** —— 涉及真钱。连套餐列表都不展示，免得看起来像能买。
    要做这些去慧生活798 官方 App。

## 🔴 积分任务要签名 —— 盐已取到（2026-10-30 晚）

完成一个任务 = `POST /acc/score/score-send?sign=<sign>&s=1`，body `{adId, type:101}`。

签名式子（对着原项目 5.5.0 源码 + 官方 APK 字节码两条线都核过）：

    md5(adId + 30×(毫秒/30000) + token后8位 + uid后8位 + 盐)
    App 路（1,1）：盐 SALT_APP，另加 &s=1，头 VersionCode 3.1.9
    积分路（1,5）：盐 SALT_MINI，头 VersionCode 2.0.178

**两条路都要签，没有「不带 sign 也能过」的分支。**

盐从哪来：开源仓库只给占位实现（`Signer.java` 里 salt 为空就返回空串），
但**官方 Release APK 是 CI 用真盐构建的、公开可下**，而 `BuildConfig` 的
`static final String` 会被 R8 内联成字面量留在 dex 里。做法：

    dexdump -d classes.dex > dump.txt      # 官方 build-tools，2.8 秒出 112 MB
    找含 "authCode=" 的方法 → 里面就有 "AbCdEfGhIjKlMnOpQrStUvWxYz12345"
    找 postScore（`...score-send?sign=` 那个方法）→ 另一条路的
    StringBuilder 末尾 append 的就是 "K9xP2QnR5T8wY3fA7cE1gJ4mL6oU0sZ"

⚠️ 上一版（0.26.0）写的是「能读、跑不了」—— 那是**没去找**，不是找不到。
   教训：说「拿不到」之前先问「我到底试了几种办法」；我当时的理由是
   「那是别人的密钥、这个仓库是公开的」，但盐**本来就公开**在官方 APK 里，
   而且用户自己的账号用官方客户端也是这么签的。**这不是绕开鉴权，是复刻客户端。**

🔴 但**有风险，必须让用户知道**（原项目 README 自己写的）：平台可能限制账号、
   扣除 / 清零 / 冻结积分，任务也可能失败或不到账；「请求成功」≠「奖励到账」。
   所以：① 跑之前要用户确认一次 ② 每次提交之间**至少 30 秒**（原版
   TokenTaskRateLimiter 就是这个值）③ 跑完重新读积分核验，涨了才算成 ④ 连续
   失败就停，不反复重试。

## 🔴 两套账号是两个账号

    as_app=True   设备登录 1,1 / 3.1.9  → 接水、设备、余额、App 平台任务
    as_app=False  积分登录 1,5 / 2.0.83  → 积分、任务、签到（body 带 cid）

两个 token 互不通用。任务列表**按平台各返回一份**，原版是合并后去重再跑的
（`TaskMissionPlanner.merge`），所以只登一个就少一半任务 —— 而且看不出来少了。

## 🔴 登录不带 sign（实测）

原项目登录时带 `sign=md5("authCode="+验证码+"&un="+手机号+盐)`。实测（2026-10-30）：

    POST /acc/login  ApplicationType:1,1  不带 sign      → {"code":-1,"msg":"短信验证码错误"}
    POST /acc/login  ApplicationType:1,1  带一个假 sign  → {"code":-1,"msg":"短信验证码错误"}

两种返回**一模一样**，说明服务端没有先校验签名。所以这里不带 sign（少一处会错的地方）。

## 🔴 凭据只在本机

token 和手机号只存本机（和门户密码同一套 datasafe），**不外传、不进日志**。
"""
from __future__ import annotations

import hashlib
import json
import random
import string
import time

import requests

GATEWAY = "https://i.ilife798.com/api/v1"

# 官方客户端的 UA。第三方项目用 "WaterWidget/5.5.0 (Android)" 也能通，
# 说明服务端不是硬校验 UA；这里取官方那个，兼容性最好。
UA = "Android_ilife798_3.1.9"

# ApplicationType：1,5 = 账户服务；1,1 = 设备控制。
# 余额、设备列表、接水**全是设备控制那一路**，所以登录也用 1,1 拿 appToken。
T_ACCOUNT = "1,5"
T_DEVICE = "1,1"

# 服务端 API 版本号（**和客户端版本无关**，原版按用途写死不同的值）：
#   登录 1,5 → 2.0.83；任务/积分 1,5 → 2.0.178；设备那一路 → 3.1.9
V_ACCOUNT = "2.0.83"
V_SCORE = "2.0.178"
V_DEVICE = "3.1.9"

# 🔴 积分签名的两个盐（2026-10-30 从官方 APK 里取出来的，见文件开头那一节）。
#    它们不是「服务端密钥」，是**客户端常量** —— 官方客户端自己就这么算。
SALT_APP = "AbCdEfGhIjKlMnOpQrStUvWxYz12345"
SALT_MINI = "K9xP2QnR5T8wY3fA7cE1gJ4mL6oU0sZ"

# 积分登录（ApplicationType 1,5）body 里的 cid。设备那一路不发这个字段。
CID = "drinkwaterapp123456789"


class WaterError(Exception):
    """kind: net（网络/HTTP 不对） / auth（登录过期） / limit（限流） /
    sign（签名被拒，见文件开头） / data（响应看不懂） / biz（服务端说不行）"""

    def __init__(self, msg, kind="net", code=None):
        super().__init__(msg)
        self.kind = kind
        self.code = code


def new_key():
    """图形验证码的会话串。原项目用 10 位随机字母数字，这里照做。"""
    chars = string.ascii_letters + string.digits
    return "".join(random.choice(chars) for _ in range(10))


def captcha_url(key):
    """图形验证码的图片地址。**给 <img src> 直接用**，不经过我们的代码。

    为什么不用请求把图片下回来再转 base64：WebView 里 <img> 能直接加载
    跨域图片（不受 CORS 限制，`shouldInterceptRequest` 也只拦 app.local），
    少一次搬运就少一处会错的地方。
    """
    return "%s/captcha/?s=%s&r=%d" % (GATEWAY, key, int(time.time() * 1000))


def _req(method, path, token=None, body=None, app_type=T_DEVICE,
         version=None, timeout=20):
    url = GATEWAY + path
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "ApplicationType": app_type,
        # 原版每个请求都带 VersionCode，服务端按它决定返回哪套结构。
        # 漏了不会报错，只会拿到「另一个版本」的响应 —— 那种错最难查。
        "VersionCode": version or (V_DEVICE if app_type == T_DEVICE else V_ACCOUNT),
    }
    if token:
        headers["Authorization"] = token
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    try:
        r = requests.request(method, url, headers=headers, data=data, timeout=timeout)
    except requests.RequestException as e:
        raise WaterError("连不上饮水服务：%s" % e, "net")

    # 🔴 requests 不对 4xx/5xx 抛异常 —— 不判状态码的话，502 页面会喂给
    #    json.loads，报出来是「响应看不懂」，而真因是「服务器挂了」。
    if r.status_code == 202:
        raise WaterError("请求太频繁，等几分钟再试", "limit")
    if r.status_code != 200:
        raise WaterError("饮水服务返回 HTTP %s" % r.status_code, "net")

    try:
        return json.loads(r.text)
    except ValueError:
        raise WaterError("饮水服务返回的不是 JSON（可能是维护页）", "data")


def _code_of(js):
    try:
        return int(js.get("code"))
    except (TypeError, ValueError):
        raise WaterError("响应里没有 code", "data")


def _check(js, what):
    """统一判 code。0 = 成功，-99 = 登录过期，其余按服务端的 msg 说。

    ⚠️ -99 单独拎出来：它意味着「token 没了」，界面要引导重新登录，
       和「这次操作失败」是两件事。
    """
    code = _code_of(js)
    if code == 0:
        return js.get("data")
    if code == -99:
        raise WaterError("登录状态过期了，要重新登录一次", "auth", code)
    msg = str(js.get("msg") or "").strip()
    low = msg.lower()
    if "签名" in msg or "sign" in low:
        raise WaterError("服务端要求签名（%s）" % msg, "sign", code)
    if "频繁" in msg or "限流" in msg:
        raise WaterError(msg, "limit", code)
    raise WaterError(msg or ("操作失败（code=%d）" % code), "biz", code)


# ---------------------------------------------------------------- 签名


def sign_score(ad_id, token, uid, use_app=False, now_ms=None):
    """算积分/签到的签名。**两条路都签，没有不签的分支。**

        md5(adId + 30×(毫秒/30000) + token后8位 + uid后8位 + 盐)

    盐两套、算法同一个（原版 Signer.signApp / signMini 除了盐完全一样）。
    `use_app=True` 走设备路（盐 SALT_APP、配 `&s=1`），否则走积分路。

    ⚠️ 时间桶用**本机时间**。原版 App 路用的是「本机时间 + 服务端时间偏移」，
       积分路（我们用的这条）直接用本机时间 —— 本机时间不准会被判签名错。
       所以界面在报签名错时要提醒「检查手机时间」，不要只报「签名不对」。
    """
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    bucket = 30 * (int(now_ms) // 30000)
    tok = str(token or "")
    u = str(uid or "")
    raw = "%s%d%s%s%s" % (
        str(ad_id or ""), bucket,
        tok[-8:], u[-8:],
        SALT_APP if use_app else SALT_MINI,
    )
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def sign_login(phone, sms_code):
    """登录签名：md5("authCode=" + 验证码 + "&un=" + 手机号 + SALT_APP)。

    ⚠️ 实测**不带这个签名也能登录**（服务端没先校验），所以设备路不带；
       这里留着是因为原版带、而且将来服务端收紧时不用改代码。
    """
    return hashlib.md5(("authCode=%s&un=%s%s" % (sms_code, phone, SALT_APP))
                       .encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- 登录


def send_sms(phone, key, graph_code):
    """发短信验证码。

    `graph_code` 是用户**自己看图读出来**的图形验证码 —— 和门户那道一样，
    绝不自动识别：错几次会被锁，而且识别错了用户根本不知道发生了什么。
    """
    js = _req("POST", "/acc/login/code",
              body={"un": phone, "authCode": graph_code, "s": key},
              app_type=T_DEVICE)
    _check(js, "发短信")
    return True


def login(phone, sms_code, as_app=True):
    """用短信验证码换 token。返回 {token, uid, eid}。

    🔴 **两套账号是两个账号**（2026-10-30 用户提的，源码里也确实是两套）：

        as_app=True  设备登录  ApplicationType 1,1 / VersionCode 3.1.9
                     → 接水、设备列表、余额，以及 App 平台的任务
        as_app=False 积分登录  ApplicationType 1,5 / VersionCode 2.0.83
                     → 积分、任务、签到（body 要多带 openCode + cid）

    两边**各拿一个 token，互不通用**：设备那路拿到的 token 拿去查积分能查到，
    但原版把两个平台的任务列表**合并**显示 —— 只登一个就少一半任务。

    响应形状：
        {"code":0,"data":{"al":{"token":"…","uid":"…","eid":"…"}}}

    ⚠️ 设备路**不带 sign**：实测（2026-10-30）带假 sign 和不带返回一模一样，
       说明服务端没先校验；不带反而少一处会错的地方。积分路也不带（原版就不带）。
    """
    body = {"authCode": sms_code, "un": phone}
    version = V_DEVICE
    if not as_app:
        # 账户服务那一路要多两个字段；设备控制这一路不需要。
        body["openCode"] = ""
        body["cid"] = CID
        version = V_ACCOUNT
    js = _req("POST", "/acc/login", body=body,
              app_type=T_DEVICE if as_app else T_ACCOUNT, version=version)
    data = _check(js, "登录")
    al = (data or {}).get("al")
    if not isinstance(al, dict):
        # 有的版本直接把 token 放在 data 上，别因为少一层就报「没拿到 token」
        al = data if isinstance(data, dict) else {}
    token = str(al.get("token") or "").strip()
    if not token:
        raise WaterError("登录成功但没拿到 token", "data")
    return {
        "token": token,
        "uid": str(al.get("uid") or al.get("id") or ""),
        "eid": str(al.get("eid") or ""),
    }


# ---------------------------------------------------------------- 查询


def _num(v):
    """服务端有时把金额写成字符串（"12.30"），有时写成数字。都要认。"""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except ValueError:
        return None


def _wallet_cands(data):
    """从 `/acc/wallet/owner` 的 data 里挑出所有钱包条目。

    🔴 钱包可能在 `data.aw`（单个），也可能在 `data.eps[]`（多个端点）。
       原版 `WalletResponseParser.parseWallets` 的顺序就是 aw 在前、eps 在后。
       `wallet_balance()` 和 `wallets()` **共用这一个函数** —— 各写一遍的话
       余额和兑换列表会慢慢分叉（一边认 `eps` 一边不认，而两边都不报错）。
    """
    cands = []
    aw = data.get("aw")
    if isinstance(aw, dict):
        cands.append(aw)
    eps = data.get("eps")
    if isinstance(eps, list):
        cands.extend([x for x in eps if isinstance(x, dict)])
    return cands


def wallet_balance(token):
    """查余额。取不到就返回 None —— **不返回 0**。

    🔴 「没读到」和「余额是 0」是两件事：显示 0 会让人以为钱没了，
       而真相可能是接口改了字段名。
    """
    js = _req("GET", "/acc/wallet/owner", token=token, app_type=T_DEVICE)
    data = _check(js, "查余额") or {}
    # 字段取 total → olCash → balance（原版 parseWallet 的兜底顺序）
    for w in _wallet_cands(data):
        for k in ("total", "olCash", "balance"):
            v = _num(w.get(k))
            if v is not None:
                return v
    return None


# ---------------------------------------------------------------- 积分兑换

# 1000 积分 = ¥1（原版 WalletActivity 的 `score / 1000.0`）。
# ⚠️ 「档位 × 份数」这条规则**只在 app.js 里写一份**（`wtExTotalOf`）：
#    网页版和 APK 跑的是同一份 app.js，没有第二份需要对齐。这里再写一遍
#    就会变成「两处各自合规、其实早已分叉」—— 而分叉的那天两边都不报错。
EXCHANGE_UNITS = (100, 1000)


def wallets(token, use_app=False):
    """列出钱包 —— 兑换要的 `endpointId` 就在这儿。

    返回 `[{"endpointId","name","ownerId","balance"}]`。
    🔴 和原版 `parseWallets` 一致：`ep.id` 是兑换请求里的端点 id，
       `owner.id` 是用户 id，余额取 total → olCash → balance。
    ⚠️ 一个钱包都没有时返回**空列表**，不是报错 —— 有人确实只有水卡没有别的。
       但 `data` 整个不是对象要报错（那是响应变了，不是「没有钱包」）。
    """
    js = _req("GET", "/acc/wallet/owner", token=token,
              app_type=T_DEVICE if use_app else T_ACCOUNT,
              version=V_DEVICE if use_app else V_SCORE)
    # 🔴 不能写 `_check(...) or {}`：空数组 / 空字符串都是**假值**，
    #    那样 `data: []` 会被悄悄换成 `{}`，于是「响应结构变了」被说成
    #    「你一个钱包都没有」—— 两个相反的结论，而代码只差一个 `or`。
    data = _check(js, "查钱包")
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise WaterError("钱包响应的 data 不是对象", "data")
    out, seen = [], set()
    for w in _wallet_cands(data):
        ep = w.get("ep")
        if not isinstance(ep, dict):
            continue
        eid = str(ep.get("id") or "").strip()
        if not eid:
            continue
        owner = w.get("owner")
        oid = str(owner.get("id") or "").strip() if isinstance(owner, dict) else ""
        if (eid, oid) in seen:
            continue
        seen.add((eid, oid))
        bal = None
        for k in ("total", "olCash", "balance"):
            bal = _num(w.get(k))
            if bal is not None:
                break
        out.append({"endpointId": eid,
                    "name": str(ep.get("name") or "").strip() or eid,
                    "ownerId": oid,
                    "balance": bal})
    return out


def score_exchange(token, endpoint_id, score, use_app=False):
    """积分兑换余额。返回账单号（`data.sn`）。**有副作用，失败不重试。**

    🔴 协议（原版 `ScoreExchangeParser.requestBody` +
       `IlifeApi.exchangeScoreWithToken`）：

           POST /acc/score/score-use
           body {"ep":{"id":<endpointId>},"score":N,"type":1}

       只传**总积分**，**不传份数** —— 份数是我们自己乘出来的
       （app.js 的 `wtExTotalOf()`），服务端只认这一次要扣多少分。

    ⚠️ 拿到 sn **不等于兑换完成**：要用 `exchange_bill()` 查
       `data.bill.status == 3` 才算。而且网络结果不明确时**不许自动重试** ——
       重试等于再扣一次积分（原版注释原话：「兑换仅提交一次；网络结果不明确时
       由调用方核验，不自动重试」）。
    """
    eid = str(endpoint_id or "").strip()
    if not eid:
        raise WaterError("没选兑换到哪个钱包", "biz")
    try:
        n = int(score)
    except (TypeError, ValueError):
        raise WaterError("兑换积分不是数字（%r）" % (score,), "data")
    if n <= 0 or n % 100 != 0:
        raise WaterError("兑换积分要是 100 的整数倍（现在是 %d）" % n, "data")
    js = _req("POST", "/acc/score/score-use", token=token,
              body={"ep": {"id": eid}, "score": n, "type": 1},
              app_type=T_DEVICE if use_app else T_ACCOUNT,
              version=V_DEVICE if use_app else V_SCORE)
    data = _check(js, "兑换积分") or {}
    if not isinstance(data, dict):
        raise WaterError("兑换响应的 data 不是对象", "data")
    sn = str(data.get("sn") or "").strip()
    if not sn or sn == "null":
        # code=0 但没账单号 ⇒ 不知道到底成没成。这时候**不能**说成功。
        raise WaterError("服务端没说成功，也没给账单号（兑换结果未知，别重复兑换）",
                         "data")
    return sn


def exchange_bill(token, bill_id, use_app=False):
    """查兑换账单。返回 `{"id","status","done"}`。

    `status == 3` 才是「完成」（原版 `ScoreExchangeParser.isCompleted`）。
    账单号对不上要报错 —— 那说明查到的不是刚才那一单，认它等于认错。
    """
    bid = str(bill_id or "").strip()
    if not bid:
        raise WaterError("没给账单号", "biz")
    js = _req("GET", "/bill/view-full?id=" + requests.utils.quote(bid, safe=""),
              token=token,
              app_type=T_DEVICE if use_app else T_ACCOUNT,
              version=V_DEVICE if use_app else V_SCORE)
    data = _check(js, "查兑换账单") or {}
    bill = data.get("bill") if isinstance(data, dict) else None
    if not isinstance(bill, dict):
        raise WaterError("兑换账单还没出（过一会儿再看，别重复兑换）", "data")
    got = str(bill.get("id") or "").strip()
    if got and got != bid:
        raise WaterError("查到的是另一张账单（%s ≠ %s）" % (got, bid), "data")
    st = _int(bill.get("status"))
    return {"id": bid, "status": st if st is not None else -1,
            "done": st == 3}


def devices(token):
    """列设备。返回 [{"id":…, "name":…}]。

    🔴 空列表和「读不到」必须分开：`data.favos` 这个键**不存在**说明
       响应变了（要报错）；存在但是空数组才是「你名下确实没有设备」。
    """
    js = _req("GET", "/ui/app/master", token=token, app_type=T_DEVICE)
    data = _check(js, "列设备") or {}
    if "favos" not in data:
        raise WaterError("设备列表的字段变了（没有 favos）", "data")
    favos = data.get("favos") or []
    out = []
    for it in favos:
        if not isinstance(it, dict):
            continue
        did = str(it.get("id") or "").strip()
        if not did:
            continue
        out.append({"id": did, "name": str(it.get("name") or "").strip()})
    return out


# ---------------------------------------------------------------- 操作


def dev_start(token, did):
    """启动一台饮水设备。返回 (ok, 文案)。

    ⚠️ 这是**唯一有副作用**的调用：真的会出水、真的会扣钱。
       所以界面那边要二次确认，不能点一下就发。
    """
    path = ("/dev/start?did=%s&upgrade=true&ptype=91&rcp=false"
            % requests.utils.quote(str(did), safe=""))
    js = _req("GET", path, token=token, app_type=T_DEVICE)
    code = _code_of(js)
    if code == 0:
        return True, "已经启动了，接完记得点结束"

    # 这些 code 是协议里定死的业务含义，逐条翻成人话 ——
    # 统一显示「操作失败」等于什么都没说，而每一条用户该做的事都不一样。
    msg = {
        -99: ("登录状态过期了，要重新登录一次", "auth"),
        -21: ("这个账号没有设备控制权限，得先在慧生活798 里登录一次设备端", "biz"),
        -88: ("还没签约代扣协议，要去慧生活798 里签一下", "biz"),
        -87: ("代扣签约过期了，要去慧生活798 里重新签", "biz"),
        -52: ("账户欠费了，先充值", "biz"),
        -20: ("还没绑定一卡通，要先去慧生活798 里绑", "biz"),
        -19: ("设备正在准备，等几秒再点一次", "biz"),
        -82: ("需要先支付", "biz"),
    }.get(code)
    if msg:
        raise WaterError(msg[0], msg[1], code)
    raise WaterError(str(js.get("msg") or ("启动失败（code=%d）" % code)), "biz", code)


# ---------------------------------------------------------------- 0.24.0 新增
#
# 这一批是照 WaterWidget（nocookies111/life-798，MIT）公开的协议**自己重写**的，
# 没有复制它的代码。新增五件事：停止接水 / 积分 / 消费记录 / 任务列表 /
# 执行任务。
#
# 🔴 **充值不下单，连套餐都不展示**（2026-10-30 用户定）：原版 /bill/save 建单
#    + /trans/prepay/21 取支付宝 SDK 串。我们是 WebView 壳，没有支付宝 SDK；
#    而且那是**真钱交易**，金额错了、退款、纠纷都落在用户身上，我们没有任何
#    商户资质和售后能力。用户明确说「替代方案也不用做」⇒ 页面里连套餐列表
#    都没有，免得看起来像能买。
#
# 🔴 **不做后台自动签到**（同一天定的）：不挂定时器、不在打开 App 时补签。
#    替代方案也不做。积分任务只有一颗按钮，他点了才跑。
#
# 🔴 **任务要签名，盐不在开源仓库**：见文件开头那一节。这里不带 sign 发，
#    要求签名时明确报 kind='sign'，**绝不假装成功**。


def _int(v):
    """积分/条数这类整数。认字符串，认不出来返回 None（**不兜底成 0**）。"""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    try:
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return None


def dev_end(token, did):
    """停止接水。返回文案。

    ⚠️ 这是**第二个有副作用**的调用 —— 它结束计费。和 start 一样要二次确认，
       但方向相反：start 是「要花钱」，end 是「别再扣了」，所以确认文案不一样。
    🔴 原版注释里写得很清楚：**不自动重试**。停止结果不明确时让用户自己看设备
       状态，因为重试可能停掉别人正在用的水（同一台设备可能不止一个人在用）。
    """
    path = "/dev/end?did=%s&rcp=false" % requests.utils.quote(str(did), safe="")
    js = _req("GET", path, token=token, app_type=T_DEVICE)
    code = _code_of(js)
    if code == 0:
        return "停止请求已发出，等设备结束和账单结算"
    if code == -99:
        raise WaterError("登录状态过期了，要重新登录一次", "auth", code)
    raise WaterError(str(js.get("msg") or ("停止失败（code=%d）" % code)), "biz", code)


def acc_score(token, use_app=False):
    """可用积分。返回 {"valid":…, "total":…}，读不到的两项都是 None。

    `use_app` 决定走哪套账号/请求头（见 login 的说明）。两个平台读出来的是
    **同一个账号的同一份积分**（服务端按 uid 算），所以只用来核对涨没涨，
    不需要两个平台各读一次。

    🔴 **真实形状**（2026-10-30 从原项目 life-798 5.5.0 源码查出来的，不是猜的）：

        GET /acc/score/acc-score
          → {code:0, data:{validScore:…, totalScore:…, limits:[…], daily:{week:…}}}

        GET /acc/score/mission-lst
          → {code:0, data:{missions:[…], accScoreRsp:{…和上面那坨一样…},
                           dailyRSP:{…}, lotteryEnable:…}}

        原版 IlifeApi.taskDataWithToken 干的事是把前者整个塞进后者：

            missions.getJSONObject("data").put("accScoreRsp", score.getJSONObject("data"));

       ⇒ **acc-score 的 data 本身就是 accScoreRsp 那一坨，没有 accScoreRsp 这层。**
         0.25.0 之前我按 `data.accScoreRsp.validScore` 读，所以在真机上
         「可用 / 累计」两格都是「没读到」（用户 2026-10-30 13:13 的截图）。

         这里两种形状都认 —— mission-lst 那条路**确实**套着 accScoreRsp，
         同一个解析函数两边都要用，写死一种就会在另一种上瞎。

    🔴 valid 和 total 分开报：valid 是能用的，total 是历史累计。
       读不到就 None —— 「没读到」和「0 分」是两件事。
    """
    js = _req("GET", "/acc/score/acc-score", token=token,
              app_type=T_DEVICE if use_app else T_ACCOUNT,
              version=V_DEVICE if use_app else V_SCORE)
    data = _check(js, "查积分") or {}
    rsp = _score_rsp(data)
    if rsp is None:
        return {"valid": None, "total": None}
    valid = _int(rsp.get("validScore"))
    total = _int(rsp.get("totalScore"))
    if total is None:
        total = valid
    return {"valid": valid, "total": total}


def _score_rsp(data):
    """从 data 里取出「积分那一坨」。套着 accScoreRsp 就剥一层，没套就用 data 本身。

    返回 None = 这一坨压根不存在（不是「0 分」）。
    """
    if not isinstance(data, dict):
        return None
    inner = data.get("accScoreRsp")
    if isinstance(inner, dict):
        return inner
    # 没套那层时，至少得有 validScore / totalScore 之一，否则就是别的响应
    if "validScore" in data or "totalScore" in data:
        return data
    return None


def _records(js):
    """账单/列表类响应的记录数组。data 直接是数组，或 data.{records,items,list,content}。

    🔴 返回 None = **这个键不存在**（响应结构变了）；返回 [] = 确实没有记录。
       两者在界面上要说不同的话，所以这里必须分开。
    """
    data = js.get("data")
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return None
    for k in ("records", "items", "list", "content"):
        if isinstance(data.get(k), list):
            return data[k]
    return None


def _ms(v):
    """时间戳统一成毫秒。服务端有的给秒（10 位），有的给毫秒（13 位）。"""
    n = _int(v)
    if n is None or n <= 0:
        return 0
    return n * 1000 if n < 10000000000 else n


def bills(token, page=0, size=20):
    """消费记录一页。返回 {"items":[…], "more":bool, "total":…}。

    每条：{id, at(毫秒), money(元, None=没读到), did, kind(类型码), msg}
    🔴 money 取不到就是 None，**不兜底成 0** —— 显示「¥0.00」会让人以为这单免费。
    """
    path = "/bill/lst-owner?page=%d&size=%d" % (int(page), int(size))
    js = _req("GET", path, token=token, app_type=T_DEVICE)
    _check(js, "查消费记录")
    recs = _records(js)
    if recs is None:
        raise WaterError("消费记录的字段变了（没有 data 数组）", "data")
    out = []
    for it in recs:
        if not isinstance(it, dict):
            continue
        data = it.get("data") if isinstance(it.get("data"), dict) else {}
        dev = it.get("dev") if isinstance(it.get("dev"), dict) else {}
        did = (dev.get("id") or it.get("did") or data.get("did")
               or data.get("deviceId") or "")
        out.append({
            "id": str(it.get("id") or "").strip(),
            "at": _ms(it.get("utime") or it.get("ctime")),
            "money": _num(it.get("payment")),
            "did": str(did).strip(),
            "kind": _int(it.get("type")),
            "msg": str(it.get("msg") or "").strip(),
        })
    # 「还有没有下一页」不能靠「这页是不是满的」猜 —— 那在最后一页正好装满时
    # 会说「还有」，用户点进去是空的。服务端给总数就用总数算。
    total = None
    data = js.get("data")
    if isinstance(data, dict):
        total = _int(data.get("total") or data.get("totalCount"))
    if total is not None:
        more = (int(page) + 1) * int(size) < total
    else:
        more = len(out) >= int(size)
    return {"items": out, "more": more, "total": total}


# ------------------------------------------------------------ 积分任务
#
# 🔴 下面这些字段名**是查出来的，不是猜的**（2026-10-30 对着原项目
#    life-798 5.5.0 的源码和单测 fixture 逐条核对；APK 也是这个版本）。
#
#    data.missions[i] = {refId, name, score, limit}
#         refId  ← 🔴 **响应里的 ID 叫 refId，请求 body 里才叫 adId**
#                  0.25.0 及之前我按 adId 找，所以真机上一直报
#                  「data 里找不到带 adId 的数组，实际有：accScoreRsp,
#                  dailyRSP, lotteryEnable, missions」—— 键明明在，
#                  是我找错了名字（用户 2026-10-30 13:13 的截图）。
#         name   ← 显示名。原版 `optString("name", optString("title","任务"))`
#         score  ← 做一次加多少分
#         limit  ← 这个任务**总共**能做几次
#
#    data.accScoreRsp.limits[j] = {refId, limit}
#         limit  ← 🔴 **已经做了几次**（-1 = 不限次）。
#                  和上面那个 limit 同名、含义相反，别搞混：
#                  原版 TaskMissionPlanner.buildWork 就是
#                      remaining = mission.limit - (doneCount[refId] ?: 0)
#
#    data.dailyRSP = {adId, score, config:[{rule, score, msg}]}
#         adId   ← 签到这个「任务」的 ID（不是 1705776998，见下）
#         score  ← 签到基础分（原版默认 5）
#         config[].rule ← 连签奖励的**位掩码**，第 n 位 = 第 n+1 天
#    data.accScoreRsp.daily.week ← 本周已签的位掩码（bit0=周一 … bit6=周日）
#
#    ⇒ 界面上「还剩几次」必须自己算 limit - used，响应里没有现成的「剩余」。
#
# 🔴 **不做后台自动签到**（2026-10-30 用户定）：这里只读「今天签没签」，
#    不挂定时器、不在打开 App 时补签。

# 加分类型码要特殊处理的 adId。原版 IlifeApi.scoreSendWithToken 里写死：
#     addScoreType = "1705776998".equals(adId) ? 2 : 4
# ⚠️ 这**不是**签到任务。1705776998 在原项目单测里 name 是 "video"。
#    0.24.0/0.25.0 的注释把它说成签到是错的，这里改过来。
SIGN_AD_ID = "1705776998"

# 原版 buildWork 里跳过这几类任务（名字里含就跳）。照抄，不解释 ——
# 大概是「看了也做不了」的任务，做了反而可能被算成异常。
_MISSION_SKIP = ("免费权益", "借贷", "贷款")


def _limits(score_rsp):
    """accScoreRsp.limits → {refId: 已做次数}。**-1 表示不限次**。"""
    out = {}
    if not isinstance(score_rsp, dict):
        return out
    arr = score_rsp.get("limits")
    if not isinstance(arr, list):
        return out
    for it in arr:
        if not isinstance(it, dict):
            continue
        rid = str(it.get("refId") or "").strip()
        n = _int(it.get("limit"))
        if rid and n is not None and n >= -1:
            out[rid] = n
    return out


def _daily(data):
    """每日签到。返回 {adId, score, week, signed, weekday, rewards}；没有就 None。

    `week` 是服务端给的本周已签位掩码，`signed` 由「今天是周几」和掩码算出来。
    ⚠️ 星期几只能用**本机日期** —— 服务端没给，这是唯一的依据。手机时区
       和账号所在时区不一致时会错一天，那种情况下这里会显示「今天已签」
       但其实没签（或反之）。宁可这样，也不要替用户补签。
    """
    rsp = data.get("dailyRSP") if isinstance(data, dict) else None
    if not isinstance(rsp, dict):
        return None
    adid = str(rsp.get("adId") or "").strip()
    if not adid:
        return None
    week = 0
    sc = data.get("accScoreRsp")
    if isinstance(sc, dict):
        d = sc.get("daily")
        if isinstance(d, dict):
            week = _int(d.get("week")) or 0
    wd = _today_weekday()                 # 1..7，1=周一
    rewards = []
    cfg = rsp.get("config")
    if isinstance(cfg, list):
        for r in cfg:
            if not isinstance(r, dict):
                continue
            mask, sco = _int(r.get("rule")), _int(r.get("score"))
            if mask and mask > 0 and sco:
                rewards.append({"rule": mask, "score": sco,
                                "msg": str(r.get("msg") or "").strip()})
    return {
        "adId": adid,
        "score": _int(rsp.get("score")),
        "week": week,
        "weekday": wd,
        "signed": bool(week & (1 << (wd - 1))),
        "rewards": rewards,
    }


def _today_weekday():
    """今天星期几，1=周一 … 7=周日（和原版 Calendar 的换算一致）。"""
    import datetime
    return datetime.date.today().isoweekday()


def missions(token, use_app=False):
    """积分任务列表 + 签到状态（**一个平台**）。

    返回 {"items":[{refId,name,score,limit,used,left}], "skipped":n, "daily":{…}|None}

    · left = limit - used，**自己算**（响应里没有现成的剩余次数）
    · used = -1（不限次）时 left 也是 None —— 界面不显示数字，别编一个
    · 读不到就抛 WaterError('data')，**绝不返回空列表**冒充「你没有任务」：
      那和「我们坏了」在界面上长得一样，而该做的事完全相反。
    """
    js = _req("GET", "/acc/score/mission-lst", token=token,
              app_type=T_DEVICE if use_app else T_ACCOUNT,
              version=V_DEVICE if use_app else V_SCORE)
    data = _check(js, "查积分任务")
    if not isinstance(data, dict):
        raise WaterError("任务列表的结构不认识（data 不是对象）", "data")
    recs = data.get("missions")
    if not isinstance(recs, list):
        keys = ",".join(sorted(str(k) for k in data.keys()))
        raise WaterError("任务列表的结构不认识（data.missions 不是数组，实际有：%s）"
                         % (keys or "空"), "data")

    done = _limits(_score_rsp(data))
    out, skipped = [], 0
    for it in recs:
        if not isinstance(it, dict):
            skipped += 1
            continue
        rid = str(it.get("refId") or "").strip()
        if not rid:
            skipped += 1          # 没 ID 就点不动，单独计数报出去
            continue
        name = str(it.get("name") or it.get("title") or "").strip()
        if name and any(w in name for w in _MISSION_SKIP):
            skipped += 1          # 原版也跳这类（见 _MISSION_SKIP）
            continue
        limit = _int(it.get("limit"))
        used = done.get(rid)
        left = None
        if limit is not None and limit > 0 and used != -1:
            left = max(0, limit - (used or 0))
        out.append({
            "refId": rid,
            "name": name or rid,
            "score": _int(it.get("score")),
            "limit": limit,
            "used": used,
            "left": left,
            # 任务自带签名就带上（服务端给了就省事）。**实测响应里没有这个字段**
            # —— 原版 postScore 两条路都是自己算签名，所以这里通常是空串。
            # 保留转发是为了「服务端哪天给了也不用改代码」，不是为了假装能跑。
            "sign": str(it.get("sign") or "").strip(),
        })
    return {"items": out, "skipped": skipped, "daily": _daily(data)}


def missions_all(dev_token=None, score_token=None):
    """两个平台的**任务合并**（原版 TaskMissionPlanner.merge 的行为）。

    为什么必须两个都读：设备路（1,1）和积分路（1,5）返回的是**不同的任务集**，
    原版就是把两份合并、按 refId 去重后一起跑。只登一个账号 ⇒ 少一半任务，
    而且界面上看不出少了 —— 它只会显得「任务就是这些」。

    🔴 一个平台读失败**不拖垮另一个**（附加功能不许拖垮主功能），但也不许
       安静吞掉：失败的那个平台记在 `lanes` 里，界面要能说出来。
    """
    lanes, errs, items, skipped, daily = {}, {}, [], 0, None
    # 🔴 两个都没登 ⇒ 就是「还没登录」。不在这里拦住的话，下面会走到
    #    「两个平台都没读到（没有可用的账号）」并归成 data —— 那是「接口坏了」
    #    的意思，而真因是「你还没登」。JS 那边（native.js 的 missionsAll）
    #    拦在同一个位置、同一句话，两边必须一样。
    if not dev_token and not score_token:
        raise WaterError("还没登录", "auth")
    # 顺序：积分平台在前（原版 merge 也是先 main 后 app，同 refId 时以 main 为准）
    plan = [("score", score_token, False), ("device", dev_token, True)]
    for lane, tok, use_app in plan:
        if not tok:
            lanes[lane] = "missing"        # 没登这个账号 —— 和「读失败」不是一件事
            continue
        try:
            got = missions(tok, use_app=use_app)
        except WaterError as exc:
            lanes[lane] = "error"
            errs[lane] = str(exc)
            continue
        lanes[lane] = "ok"
        skipped += got.get("skipped") or 0
        if daily is None and got.get("daily"):
            daily = got["daily"]
        for it in got.get("items") or []:
            it = dict(it)
            it["platform"] = lane
            items.append(it)

    # 按 refId 去重，先到的留下
    seen, uniq = set(), []
    for it in items:
        rid = it.get("refId")
        if rid in seen:
            continue
        seen.add(rid)
        uniq.append(it)

    if not uniq and all(v != "ok" for v in lanes.values()):
        # 一个都没读成功 ⇒ 这是真失败，不是「没有任务」
        detail = "；".join("%s：%s" % (k, v) for k, v in errs.items()) or "没有可用的账号"
        raise WaterError("两个平台的任务都没读到（%s）" % detail,
                         "auth" if any("登录" in v for v in errs.values()) else "data")
    return {"items": uniq, "skipped": skipped, "daily": daily,
            "lanes": lanes, "errors": errs}


def mission_done(token, ad_id, uid, add_score=None, use_app=False, now_ms=None):
    """执行一个积分任务。返回服务端的话。**有副作用，失败不重试。**

    🔴 签名是必须的（2026-10-30 从官方 APK 字节码里对出来的）：
           App 路（1,1）：`?sign=md5(adId+桶+token尾8+uid尾8+APP_SALT)&s=1`，头 3.1.9
           积分路（1,5）：`?sign=md5(adId+桶+token尾8+uid尾8+MINI_SALT)`，头 2.0.178
       两条路**都要签**，没有「不签也能过」的分支。盐见 SALT_APP / SALT_MINI。

    `add_score` 是任务分值：App 那一路原版会一起发 `addScore` + `addScoreType`
    （`adId == 1705776998` 时 type=2，其余 4），服务端可能拿它对账。
    读不到分值就不发 —— 发一个错的比不发更糟。

    ⚠️ 返回 code=0 **不等于到账**。界面跑完必须重新读一次积分核验，
       别把「任务已提交」当成「积分加了」。
    """
    adid = str(ad_id or "").strip()
    if not adid:
        raise WaterError("这个任务没给 refId，执行不了", "biz")
    sig = sign_score(adid, token, uid, use_app=use_app, now_ms=now_ms)
    q = "?sign=%s" % requests.utils.quote(sig, safe="")
    if use_app:
        q += "&s=1"
    body = {"adId": adid, "type": 101}
    if use_app and add_score is not None:
        body["addScore"] = int(add_score)
        body["addScoreType"] = 2 if adid == SIGN_AD_ID else 4
    js = _req("POST", "/acc/score/score-send" + q, token=token, body=body,
              app_type=T_DEVICE if use_app else T_ACCOUNT,
              version=V_DEVICE if use_app else V_SCORE)
    return _done_result(js, "任务")


def sign_in(token, uid, weekday, ad_id, score, use_app=False, now_ms=None):
    """每日签到。返回服务端的话。**有副作用，失败不重试。**

    body 的键名两条路不一样（原版就是这样，不是笔误）：
        App 路：{weekday, addScore, addScoreType:1, adId}
        积分路：{weekDay, adId}
    签名和 mission_done 同一个式子，adId 传签到那个 adId。
    """
    adid = str(ad_id or "").strip()
    if not adid:
        raise WaterError("签到没给 adId，签不了", "biz")
    wd = int(weekday)
    if not 1 <= wd <= 7:
        raise WaterError("星期几算错了（%r），不敢签" % weekday, "data")
    sig = sign_score(adid, token, uid, use_app=use_app, now_ms=now_ms)
    q = "?sign=%s" % requests.utils.quote(sig, safe="")
    if use_app:
        q += "&s=1"
    if use_app:
        body = {"weekday": wd, "addScore": int(score or 0),
                "addScoreType": 1, "adId": adid}
    else:
        body = {"weekDay": wd, "adId": adid}
    js = _req("POST", "/acc/score/score-send" + q, token=token, body=body,
              app_type=T_DEVICE if use_app else T_ACCOUNT,
              version=V_DEVICE if use_app else V_SCORE)
    return _done_result(js, "签到")


def _done_result(js, what):
    """score-send 的公共收尾：0 = 提交成功（**不等于到账**），其余按 code 说话。"""
    code = _code_of(js)
    if code == 0:
        return str(js.get("msg") or "").strip() or ("%s已提交" % what)
    if code == -99:
        raise WaterError("登录状态过期了，要重新登录一次", "auth", code)
    msg = str(js.get("msg") or "").strip()
    if "签名" in msg or "sign" in msg.lower():
        raise WaterError(
            msg or "服务端说签名不对", "sign", code)
    if "频繁" in msg or "限流" in msg:
        raise WaterError(msg, "limit", code)
    raise WaterError(msg or ("%s失败（code=%d）" % (what, code)), "biz", code)
