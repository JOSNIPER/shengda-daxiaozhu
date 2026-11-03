#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""校园公告 · 数据层（公开页面，**不需要登录**）

设计要点
--------
1. 列表和详情分开：
   `/api/notice` 只出标题/日期/来源（快，一次抓 6 个列表页）
   `/api/notice/detail` 才去抓某一篇的正文（抠「时间 / 地点」）
   否则一进页面就要抓 40 篇正文，慢且把学校服务器打疼。

2. 一套解析吃六个站：
   郑航各部门站是同一套 CMS，通知链接形状统一是
       <a href="../info/1178/4951.htm" title="标题">
   路径里带 /info/数字/数字.htm，title 属性里是完整标题。
   列表容器模板各不相同（<li> / <table><tr><td> / <div>），但链接本身不变，
   所以按**链接**找，再往两边找日期，比按容器找稳得多。

3. 分众分层（回答「太杂」）：源保持广，输出按受众过滤。
   实测 2026 年 64 条 / 8 个月 = 月均 8 条，一天不到 0.3 条，
   噪音只有 19%，且全在 DROP 那几类里。

⚠️ 四个坑（全部踩过）
  ① href 是相对路径，必须 urljoin；直接拼会得到 https://host/../info/…
     → 服务器返回 **400**（不是 404，很容易看错）
  ② 前导斜杠可有可无（校级 ../info/，后勤 info/）。正则写成 [^"]*?/info/
     会把后勤和团委**全漏掉**，而且不报错、只返回 0 条
  ③ 学校站点偶发超时（信息中心实测 25 秒超时，重试立刻 200）⇒ 必须重试，
     且**单源失败不能拖垮整体**
  ④ 有的通知把两个标签挤一行（展览地点：… 展览时间：…），
     只取「下一行」会让时间和地点抠成同一串，界面上两行字一模一样
"""

from __future__ import annotations

import html
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# 一个源 = (显示名, 列表地址, 部门)
# ⚠️ 选源时先看这个栏目还在不在更新：
#    教务处「教务通知 jwgl/jwtz.htm」「教学通知 jxyj/jxtz.htm」都停在 2023 年，
#    所以换成还在更新的「学籍通知」「实践通知」。停更栏目留着只会让公告栏看起来像坏了。
SOURCES = [
    ("校级通知", "https://www.zua.edu.cn/xwzx/tzgg.htm", "学校"),
    ("学籍通知", "https://jwc.zua.edu.cn/xjgl/xjtz.htm", "教务处"),
    ("实践通知", "https://jwc.zua.edu.cn/sjjx/sjtz.htm", "教务处"),
    ("团委通知", "https://tuanwei.zua.edu.cn/tzgg.htm", "团委"),
    ("后勤动态", "https://hqfwzgs.zua.edu.cn/", "后勤管理处"),
    ("信息中心", "https://xxglzx.zua.edu.cn/xwzx/tzgg.htm", "信息管理中心"),
]

# 🔴 详情接口只允许抓这些域名。
#    否则 `?u=http://evil/...` 就变成一个「让用户的电脑替我访问内网」的洞。
ALLOWED_HOSTS = ("zua.edu.cn",)

DATE_RE = re.compile(r"(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})")
INFO_RE = re.compile(r'href="([^"]*?info/\d+/\d+\.htm)"', re.I)

# ======================================================================
# 分层与分众
# ======================================================================

DROP = [
    ("附小", ("附小", "附属小学", "幼儿园")),
    ("值班表", ("值班表",)),
    ("会议新闻", ("工作会议", "教学例会", "工作例会", "见面交流会", "座谈会",
                  "调研交流", "来校调研")),
    ("采购招标", ("采购公告", "中标", "招标", "询价")),
    ("党建公示", ("代表候选人", "党支部", "党委会", "民主生活会", "述职")),
    ("继续教育", ("继续教育招生", "成人教育招生", "自考招生")),
]

IMPACT = ("割接", "停水", "停电", "断网", "封楼", "封闭", "闭馆", "维修",
          "检修", "调休", "停课", "暂停开放", "交通管制", "禁行", "施工",
          "停运", "临时调整")

ACTION = ("报名", "缴费", "申报", "提交", "补办", "办理", "确认", "注册",
          "选课", "转专业", "分流", "评教", "申请", "领取", "资格审核",
          "资格审查", "学籍异动", "毕业论文", "实习", "学业警示", "学生证",
          "医保", "参保", "团籍", "推优")

ACTIVITY = ("校庆", "庆典", "晚会", "比赛", "竞赛", "讲座", "报告会", "展览",
            "文化节", "运动会", "演出", "招募", "社团", "升旗", "论坛",
            "沙龙", "典礼", "开放日", "发放", "餐券", "福利", "月饼", "慰问",
            "志愿服务", "社会实践", "表彰")

COHORT = ("新生", "毕业生", "本科生", "团员", "党员", "实习生", "在校生",
          "学生", "同学", "2026级", "2027届", "2026届", "2025级", "全校师生")


def classify(title: str) -> tuple[bool, str, list[str], str]:
    """返回 (是否保留, 层级, 标签, 剔除原因)。层级：impact/action/activity/other/drop"""
    for name, kws in DROP:
        if any(k in title for k in kws):
            return False, "drop", [], name
    if any(k in title for k in IMPACT):
        return True, "impact", ["影响出行"], ""
    if any(k in title for k in ACTION):
        return True, "action", ["要办事"], ""
    if any(k in title for k in ACTIVITY):
        return True, "activity", ["活动"], ""
    if any(k in title for k in COHORT):
        return True, "other", [], ""
    return True, "other", [], ""


# ======================================================================
# 抓取
# ======================================================================

_SSL_CTX = None


def _opener():
    global _SSL_CTX
    import ssl
    if _SSL_CTX is None:
        _SSL_CTX = ssl.create_default_context()
        _SSL_CTX.check_hostname = False
        _SSL_CTX.verify_mode = ssl.CERT_NONE
    # 不走系统代理：本机常年挂代理，学校域名直连更快更稳。
    # 代理一挂，这几个站会变成 407/超时，看起来像「网站坏了」。
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=_SSL_CTX),
    )


def _get(url: str, timeout: int = 20, retries: int = 2):
    """🔴 必须重试：学校站点偶发超时。单源失败由调用方兜住，不能拖垮整体。"""
    last = ""
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            r = _opener().open(req, timeout=timeout)
            raw = r.read()
            for enc in ("utf-8", "gb18030"):
                try:
                    return r.status, raw.decode(enc)
                except UnicodeDecodeError:
                    continue
            return r.status, raw.decode("utf-8", "ignore")
        except urllib.error.HTTPError as exc:
            return exc.code, ""
        except Exception as exc:  # noqa: BLE001
            last = str(exc)[:90]
            if attempt < retries:
                time.sleep(1.0 * (attempt + 1))
    return 0, "ERR " + last


def _clean(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def parse_list(page: str, base: str, window: int = 300) -> list[dict]:
    out, seen = [], set()
    for m in INFO_RE.finditer(page):
        url = urllib.parse.urljoin(base, m.group(1))   # 🔴 必须 urljoin
        if url in seen:
            continue
        tail = page[m.start():m.start() + 400]
        tm = re.search(r'title="([^"]{4,120})"', tail)
        if tm:
            title = _clean(tm.group(1))
        else:
            am = re.search(r"<a[^>]*>(.*?)</a>", tail, re.S | re.I)
            title = _clean(am.group(1)) if am else ""
        if len(title) < 5:
            continue
        seen.add(url)
        out.append({
            "title": title,
            "url": url,
            "date": _date_near(page, m.start(), m.end(), window),
        })
    return out


def _date_near(page: str, start: int, end: int, window: int) -> str:
    """链接附近的日期。**先看链接后面，再看前面。**

    🔴 顺序不能反。校级站的列表是
           <li><a href="...info/1065/9794.htm" title="…">…</a><span>2026-10-09</span></li>
       一开始写成「取链接前后各 300 字里的第一个日期」，窗口左边先命中了
       **上一条**的日期 —— 整列日期集体错位一行，而且看上去完全正常
       （每条都有日期、格式也对），只有拿真页面核对才发现。

    为什么还要看前面：有的站是「日期在前、标题在后」的排法。
    """
    d = DATE_RE.search(_clean(page[end:end + window]))
    if not d:
        d = DATE_RE.search(_clean(page[max(0, start - window):start]))
    if not d:
        return ""
    return "%s-%02d-%02d" % (d.group(1), int(d.group(2)), int(d.group(3)))


def strip_body(page: str) -> str:
    s = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S | re.I)
    s = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</tr>|</h\d>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s)


PAIR_RE = re.compile(
    r"([\u4e00-\u9fa5]{2,8})[：:]\s*([^：:]{1,60}?)(?=\s+[\u4e00-\u9fa5]{2,8}[：:]|$)")

# 🔴 「发布时间」「更新时间」「浏览次数」不是活动时间。
#    教务处的页面把这两件事写在同一行：
#        发布时间：2026-10-20文章来源：实践教学科
#    只按「标签里有『时间』两个字」去取，会把**发布日期**当成
#    「活动时间」显示出来 —— 界面上一本正经地写「时间 2026-10-20」，
#    实际那天只是文章发出来的日子。这比不显示更坏。
SKIP_LABEL = ("发布", "更新", "浏览")


def _pick_pair(lines, want):
    """在**同一行**里按「标签：值」拆开取。坑④就靠这个绕过去。"""
    for l in lines:
        for label, value in PAIR_RE.findall(l):
            if any(s in label for s in SKIP_LABEL):
                continue
            if any(w in label for w in want):
                return value.strip()
    return ""


def _grab_next(lines, labels, span=3):
    for i, l in enumerate(lines):
        if len(l) > 24 or any(s in l for s in SKIP_LABEL):
            continue
        if any(lb in l for lb in labels):
            buf = []
            for nxt in lines[i + 1:i + 1 + span]:
                if re.match(r"^[一二三四五六七八九十]+、", nxt):
                    break
                buf.append(nxt)
            if buf:
                return " ".join(buf)[:140]
    return ""


# 正文从哪一句开始。不同部门的模板不一样：
#   校级 / 团委 / 后勤：以「各有关单位」「各部门」「全校师生」开头
#   教务处：直接就是「各学院：」，前面没有任何套话
# 少了「各学院」这一项，教务处那一大批通知的正文摘要**整篇为空**，
# 界面上看起来像「这篇文章没有正文」。
BODY_START = (r"(各有关单位|各部门|各单位|各学院|各系|各教学单位|各二级学院|"
              r"全校师生|全体学生|各位同学|同学们)")
BODY_END = r"(下一条|上一条|关闭窗口|版权所有|ICP备|浏览次数)"


def parse_article(page: str) -> dict:
    lines = [l.strip() for l in strip_body(page).split("\n") if l.strip()]
    dept, pub = "", ""
    for l in lines[:400]:
        # 「日期：」「发布时间：」「发布日期：」三种写法都见过
        m = re.search(r"(?:日期|发布时间|发布日期)[：:]\s*(20\d{2}-\d{2}-\d{2})", l)
        if m:
            pub = m.group(1)
        # 「作者：」和「文章来源：」都有站点在用
        m2 = re.search(r"(?:作者|文章来源|来源)[：:]\s*(\S{2,30})", l)
        if m2 and not dept:
            dept = m2.group(1)
        if pub and dept:
            break

    when = _pick_pair(lines, ("时间",)) or _grab_next(
        lines, ("活动时间", "举办时间", "会议时间", "报名时间", "活动日期", "时间"))
    where = _pick_pair(lines, ("地点", "场地")) or _grab_next(
        lines, ("活动地点", "举办地点", "会议地点", "活动场地", "地点"))
    if not when:
        for l in lines:
            m = re.search(r"\d{1,2}\s*月\s*\d{1,2}\s*日[^\n]{0,40}?\d{1,2}\s*[:：]\s*\d{2}", l)
            if m:
                when = m.group(0)[:140]
                break

    # 正文摘要：跳过导航（前面几十行全是栏目名），从问候语之后取
    body = []
    started = False
    for l in lines:
        if not started:
            # ⚠️ 不能光看「句子里有没有『各单位』」。正文中间会出现
            #    「（二）各单位组织讲解」这种句子，一匹配就从那儿开始截，
            #    结果摘要里全是表格碎片。问候语的特征是**短**或者**顶格**。
            if re.search(BODY_START, l) and (len(l) <= 30 or re.match(r"^(各|全体|各位)", l)):
                started = True
            continue
        if re.search(BODY_END, l):
            break
        if len(l) >= 8:
            body.append(l)
        if len("".join(body)) > 500:
            break

    if not body:
        # 兜底：从「发布时间 / 文章来源」那一行之后开始。
        # 认不出问候语的时候（模板又变了）至少还能给出一段正文，
        # 而不是让界面显示成「这篇文章没有正文」。
        meta_i = -1
        for i, l in enumerate(lines):
            if re.search(r"(发布时间|文章来源|发布日期|日期[：:])", l):
                meta_i = i
                break
        if meta_i >= 0:
            for l in lines[meta_i + 1:]:
                if re.search(BODY_END, l):
                    break
                if len(l) >= 8:
                    body.append(l)
                if len("".join(body)) > 500:
                    break

    return {"publish": pub, "dept": dept, "when": when, "where": where,
            "summary": "\n".join(body)[:500]}


# ======================================================================
# 对外接口
# ======================================================================

_LOCK = threading.Lock()
_CACHE = {"at": 0.0, "data": None}
TTL = 30 * 60      # 列表缓存 30 分钟：别每次切页都去敲 6 个学校站点


def fetch_list(limit: int = 60, force: bool = False) -> dict:
    with _LOCK:
        now = time.time()
        if not force and _CACHE["data"] and now - _CACHE["at"] < TTL:
            data = dict(_CACHE["data"])
            data["cached"] = True
            return data

        allitems, failed = [], []
        for name, url, dept in SOURCES:
            st, page = _get(url)
            items = parse_list(page, url) if st == 200 else []
            if st != 200 or not items:
                # 🔴 失败要往上报，不能安静地少一块 ——
                # 否则「今天只有 3 条」看不出是「真的只有 3 条」还是「5 个源没取到」。
                failed.append({"source": name, "status": st, "count": len(items)})
            for it in items:
                it["source"] = name
                it["dept"] = dept
                keep, tier, tags, reason = classify(it["title"])
                it["keep"] = keep
                it["tier"] = tier
                it["tags"] = tags
                it["drop"] = reason
            allitems.extend(items)

        uniq, seen = [], set()
        for it in allitems:
            k = it["url"].split("/info/")[-1]
            if k in seen:
                continue
            seen.add(k)
            uniq.append(it)
        uniq.sort(key=lambda x: x["date"] or "0000", reverse=True)

        kept = [x for x in uniq if x["keep"]]
        data = {
            "ok": True,
            "at": int(now),
            "cached": False,
            "total": len(uniq),
            "items": kept[:limit],
            "failed": failed,
            "sources": len(SOURCES) - len(failed),
        }
        _CACHE["at"] = now
        _CACHE["data"] = data
        return dict(data)


def fetch_detail(url: str) -> dict:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if not any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS):
        return {"ok": False, "error": "只能查看校内站点的通知"}
    st, page = _get(url)
    if st != 200:
        return {"ok": False, "error": "打开通知失败（HTTP %s）" % st}
    d = parse_article(page)
    d["ok"] = True
    d["url"] = url
    return d


if __name__ == "__main__":   # 自测：python notice.py
    import json
    out = fetch_list(force=True)
    print("源 %d 个，取到 %d 条，保留 %d 条"
          % (out["sources"], out["total"], len(out["items"])))
    for it in out["items"][:12]:
        print("  %-10s %-8s %s" % (it["date"], it["tier"], it["title"][:42]))
    if out["failed"]:
        print("失败的源：", out["failed"])
    print(json.dumps(out["items"][0], ensure_ascii=False, indent=2)[:400])
