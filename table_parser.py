# -*- coding: utf-8 -*-
"""青果 KINGOSOFT DataTable.jsp 解析层（达小助）。

规则移植自 yyydsz/shengda-qk（MIT）2026-10 升达真机实测契约，
native.js（APK 内置数据层）镜像本文件的逻辑，两轨以 config/shengda.json 为单一真源。

要点：
- DataTable.jsp 响应是 **GBK 编码的 HTML 表格**；
  表头 ``<th id="head_xxx">``，数据格 ``<td id='trN_xxx'>``；
- 按**行内 id** 取值优先于按列位置 —— 列序变了也不错位（实测教训）；
- 缺会话/菜单上下文时服务器回「无效访问请求」页（实测 1098 字节）；
  频控回「请求太过频繁」页 —— **频控页里也含「无效的访问请求」字样，
  必须先排除频控再判会话失效**，否则用户会被白白要求重新扫码；
- 空 tbody 是正常情况（比如这学期没排课），不是错误，不能报「登录态过期」。

本文件不含学校域名/参数，配置一律见 config/shengda.json。
"""

import re
from html import unescape

# ---- 实测标志串（shengda-qk 2026-10-14） ----
SESSION_EXPIRED_HINTS = ("凭证已失效", "无效访问请求", "无效的访问请求")
RATE_LIMIT_HINTS = ("请求太过频繁", "请求过于频繁")

_TR = re.compile(r"<tr[^>]*>(.*?)</tr>", re.I | re.S)
_HEAD_ID = re.compile(r"<t[dh][^>]*id=[\"']?head_([A-Za-z0-9_]+)", re.I)
_CELL = re.compile(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", re.I | re.S)
_CELL_ID = re.compile(r"<t[dh][^>]*id=[\"']?tr\d+_([A-Za-z0-9_]+)", re.I)
_TAG = re.compile(r"<[^>]+>")


def decode_body(raw: bytes, content_type: str = "") -> str:
    """教务表是 GBK、门户/CAS 是 UTF-8：先按 Content-Type，再 gbk→utf-8 依次试。"""
    order = [m.group(1) for m in re.finditer(r"charset=([\w-]+)", content_type or "")]
    order += ["gbk", "utf-8"]
    for cs in order:
        try:
            return raw.decode(cs)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("gbk", errors="replace")


def clean_cell(cell_html: str) -> str:
    """单元格 HTML → 纯文本。解实体、压空白（\u00a0 不属于 \\s，单独处理）。"""
    t = _TAG.sub("", cell_html or "")
    t = unescape(t).replace("\xa0", " ")
    return re.sub(r"\s+", " ", t).strip()


def looks_rate_limited(text: str) -> bool:
    return any(h in (text or "") for h in RATE_LIMIT_HINTS)


def looks_session_expired(text: str) -> bool:
    """会话失效判定。**先排除频控页**：实测频控页也含「无效的访问请求」，
    误判会让人白跑一次扫码，而它实际只需要等待。"""
    if looks_rate_limited(text):
        return False
    return any(h in (text or "") for h in SESSION_EXPIRED_HINTS)


def parse_data_table(html_text: str) -> list:
    """DataTable.jsp HTML → [{列名: 文本}]；列名 = 表头 id 去掉 head_ 前缀。

    行内 id（trN_xxx）优先，取不到退回列位置。空表返回 []（不是错误）。
    """
    if not html_text:
        return []
    rows = _TR.findall(html_text)
    if len(rows) < 2:
        return []
    header_ids = _HEAD_ID.findall(rows[0])
    if not header_ids:
        return []
    out = []
    for row_html in rows[1:]:
        frags = _CELL.findall(row_html)
        cells = [clean_cell(f) for f in frags]
        if len(cells) < 2:
            continue
        by_id = {}
        for i, frag in enumerate(frags):
            m = _CELL_ID.search(frag)
            if m and i < len(cells):
                by_id[m.group(1)] = cells[i]
        entry = {}
        for i, hid in enumerate(header_ids):
            val = by_id.get(hid)
            if val is None:
                val = cells[i] if i < len(cells) else ""
            entry[hid] = val
        if any(entry.values()):
            out.append(entry)
    return out


def apply_column_map(rows: list, mapping: dict) -> list:
    """青果列名 → UI 契约键。未登记的列以原名保留（不丢数据，方便对账）。"""
    out = []
    for r in rows:
        e = {}
        for k, v in r.items():
            e[mapping.get(k, k)] = v
        out.append(e)
    return out


# ---------------------------------------------------------------- 课表格子
# 青果标准的「星期 / 节次 / 周次」三列（skxq / skjc / zc）。值格式各校有差，
# 这里只认下面这几种；**认不出来就整批放弃**，由调用方退回 shape:"raw"。
# 理由：一张猜错格的课表比一张原始行列表害人得多 —— 学生会照着错误的时间
# 去教室。config 里的 timetable.parse_slots 是这一层的总开关。

_DAY_CN = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}

_DAY_RE = re.compile(r"^(?:星期|周|礼拜)?\s*([一二三四五六日天1-7])\s*$")
_RANGE_RE = re.compile(r"^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$")
_PARITY_RE = re.compile(r"[（(]\s*(单|双)\s*[)）]")


def _pick(row: dict, *keys):
    """按优先级取第一个非空值。列名映射前后两套键都认（kcm / name …）。"""
    for k in keys:
        v = row.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    return ""


def _norm(s: str) -> str:
    return (s.replace("，", ",").replace("、", ",").replace("－", "-")
             .replace("–", "-").replace("—", "-").replace("~", "-"))


def _parse_day(v: str):
    m = _DAY_RE.match(v)
    if not m:
        return None
    c = m.group(1)
    if c.isdigit():
        n = int(c)
        return 6 if n == 7 else n - 1      # 周日有的学校写 7
    return _DAY_CN.get(c)


def _parse_periods(v: str, unit_count: int):
    s = _norm(v).replace("第", "").replace("节", "").strip()
    if not s:
        return None
    out = []
    for part in s.split(","):
        m = _RANGE_RE.match(part.strip())
        if not m:
            return None
        a = int(m.group(1))
        b = int(m.group(2) or a)
        if a < 1 or b < a or b > unit_count:
            return None
        out.extend(range(a, b + 1))
    return [p - 1 for p in sorted(set(out))] if out else None


def _parse_weeks(v: str):
    s = _norm(v).replace("第", "").replace("周", "")
    parity = None
    m = _PARITY_RE.search(s)
    if m:
        parity = 1 if m.group(1) == "单" else 0
        s = s[:m.start()] + s[m.end():]
    out = set()
    for part in s.split(","):
        m = _RANGE_RE.match(part.strip())
        if not m:
            if not part.strip():
                continue
            return None
        a = int(m.group(1))
        b = int(m.group(2) or a)
        if a < 1 or b < a:
            return None
        out.update(range(a, b + 1))
    if not out:
        return None
    if parity is not None:                 # 双周 = 偶数周（2,4,6…）
        out = {w for w in out if w % 2 == parity}
    return sorted(out) if out else None


def shape_courses(rows: list, unit_count: int):
    """原样行 → 格子能画的 courses[]（name/teacher/room/weeks/slots/code）。

    返回 None 表示**有行解析不了**，整批退回 raw。不做「跳过坏行、画好行」：
    半张课表比没有更危险（少一门课的人不会发现）。
    """
    out = []
    for r in rows:
        name = _pick(r, "name", "kcm", "课程名")
        day = _parse_day(_pick(r, "day", "skxq", "上课星期"))
        periods = _parse_periods(_pick(r, "periods", "skjc", "上课节次"), unit_count)
        weeks = _parse_weeks(_pick(r, "weeks_text", "weeks", "zc", "周次"))
        if not name or day is None or not periods or not weeks:
            return None
        code = _pick(r, "code", "kcdm", "课程代码", "kch", "课程号") or name
        out.append({
            "code": code,
            "name": name,
            "teacher": _pick(r, "teacher", "skjs", "任课教师"),
            "room": _pick(r, "room", "cdmc", "上课地点"),
            "weeks": weeks,
            "slots": [{"day": day, "period": p} for p in periods],
        })
    return out



def _double_encoded_json(text: str):
    """Kingosoft 常见形态 {"status":"200","result":"{...}"}（result 是字符串里的 JSON）。
    解析失败返回 {}，**不抛异常** —— 会话失效时这里会收到一段 alert 弹窗 HTML。"""
    import json
    try:
        payload = json.loads(text)
    except (TypeError, ValueError):
        return {}
    if isinstance(payload, dict) and isinstance(payload.get("result"), str):
        try:
            inner = json.loads(payload["result"])
        except (TypeError, ValueError):
            return payload
        if isinstance(inner, dict):
            return {**payload, "result": inner}
    return payload if isinstance(payload, dict) else {}


def parse_selects(html_text: str, name_map: dict) -> dict:
    """解析表单下拉：<select name=X> 的 option 列表（丢掉空 value 占位项）。
    name_map = {select的name: 输出键}，教学楼/校区/学期/批次共用。"""
    out = {v: [] for v in name_map.values()}
    for sel_name, ui_key in name_map.items():
        m = re.search(r'<select[^>]*name="%s"[^>]*>(.*?)</select>'
                      % re.escape(sel_name), html_text or "", re.S)
        if not m:
            continue
        seen = set()
        for mo in re.finditer(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)</option>',
                              m.group(1)):
            rid, label = mo.group(1).strip(), mo.group(2).strip()
            if not rid or not label or rid in seen:
                continue
            seen.add(rid)
            out[ui_key].append({"id": rid, "name": label})
    return out


# ======================================================================
# 升达青果「课表/成绩」页面解析（2026-11-03 校内 HAR 实测）
# ----------------------------------------------------------------------
# 🔴 本校**不用 DataTable.jsp**。上面那套 head_/trN_ 解析对课表成绩无效，
#    真实入口是两张 jsp 页面。HAR 里抓到的原文见 _lab/har/*.html。
#
# 课表页 /student/wsxk.xskcb10319.jsp?params=<base64("xn=..&xq=..&xh=..")>
#   结构：第一张表给学号/姓名/班级/课程门数/学分；
#         第二张表 id=mytable，首行是「星期一…星期日」，
#         之后每 2 行一大节（td[rowspan] 上午/下午/晚上 + td 节次「一」），
#         每行最后 7 个 td 是周一到周日；
#         有课的格子里是若干 <div>，每个 div 用 <br> 分成四段：
#             课程名 / 教师 / 周次[节次] / 地点
#         例：面向对象程序设计 / 张小峰 / 1-4,6-16[1-2] / 资-305（计算机教室二十）
#         周次里可能带「单」「双」；同一格可能有多门课（分两个 div）。
#
# 成绩页 POST /student/xscj.stuckcj_data.jsp
#   结构：多个「学年学期：2024-2025学年第一学期」分隔行，每段一张 12 列表：
#         序号|课程/环节|学分|总学时|类别|修读性质|考核方式|成绩|获得学分|绩点|学分绩点|备注
#         课程名带课程号前缀 "[01238111]专业认知"。
# ======================================================================

_TD = re.compile(r"<td[^>]*>(.*?)</td>", re.I | re.S)
_BR = re.compile(r"<br\s*/?>", re.I)
_KBT_DIV = re.compile(r"<div[^>]*padding-bottom[^>]*>(.*?)</div>", re.I | re.S)
_BRACKET = re.compile(r"\[(\d+)-(\d+)\]")


def _week_numbers(spec: str) -> list:
    """'1-4,6-16 双' → 偶数周；'1-16 单' → 奇数周；'14,16' → [14,16]。

    🔴 「单/双」必须**先记下来再从串里删**：直接剔非数字会把
    '1-16 双' 变成 [1..16]，于是单周课也会出现在双周上。
    """
    s = str(spec or "")
    even = "双" in s
    odd = "单" in s
    s = re.sub(r"[^\d,\-]", " ", s)
    weeks = set()
    for token in re.split(r"[,\s]+", s.strip()):
        if not token:
            continue
        if "-" in token:
            a, _, b = token.partition("-")
            if a.isdigit() and b.isdigit():
                weeks.update(range(int(a), int(b) + 1))
        elif token.isdigit():
            weeks.add(int(token))
    if even:
        weeks = {w for w in weeks if w % 2 == 0}
    elif odd:
        weeks = {w for w in weeks if w % 2 == 1}
    return sorted(weeks)


def _kbt_header(html_text: str) -> dict:
    flat = clean_cell(html_text)
    out = {}
    for key, field, conv in (
            (r"学号[：:]\s*([0-9A-Za-z]+)", "studentId", str),
            (r"姓名[：:]\s*(\S+)", "name", str),
            (r"所在班级[：:]\s*(\S+)", "clazz", str),
            (r"课程门数[：:]\s*(\d+)", "courseCount", int),
            (r"课程学分[：:]\s*([\d.]+)", "credits", str)):
        m = re.search(key, flat)
        if m:
            try:
                out[field] = conv(m.group(1))
            except (TypeError, ValueError):
                pass
    return out


def parse_kbt_timetable(html_text: str) -> dict:
    """课表页 → {head, courses[], totalWeeks, unitCount, empty}。

    courses 的每一项都满足 UI 契约（code/name/teacher/room/weeks/slots），
    可以直接进格子视图 —— 不再有 shape:"raw" 这种半成品。
    """
    rows = _TR.findall(html_text or "")
    frags = []
    for row in rows:
        tds = _TD.findall(row)
        if len(tds) < 7:
            continue
        days = tds[-7:]
        if "星期" in clean_cell(days[0]):
            continue                          # 表头行
        for day, cell in enumerate(days):
            if "padding-bottom" not in cell:
                continue                      # 空格子（div_nokb）
            for inner in _KBT_DIV.findall(cell):
                parts = [clean_cell(p) for p in _BR.split(inner)]
                parts = [p for p in parts if p]
                if len(parts) < 2:
                    continue
                name = parts[0]
                teacher = parts[1]
                spec = parts[2] if len(parts) > 2 else ""
                room = parts[3] if len(parts) > 3 else ""
                pm = _BRACKET.search(spec)
                periods = []
                if pm:
                    a, b = int(pm.group(1)), int(pm.group(2))
                    if 1 <= a <= b <= 30:
                        periods = list(range(a, b + 1))
                weeks = _week_numbers(spec.split("[")[0])
                frags.append((name, teacher, room, tuple(weeks), tuple(periods), day))

    # 合并：同名同师同教室同周次 → 一条，多个时段并进 slots
    merged = {}
    order = []
    for name, teacher, room, weeks, periods, day in frags:
        key = (name, teacher, room, weeks)
        if key not in merged:
            merged[key] = {"code": name, "name": name, "teacher": teacher,
                           "room": room, "weeks": list(weeks), "slots": []}
            order.append(key)
        e = merged[key]
        for p in periods:
            slot = {"day": day, "period": p - 1}
            if slot not in e["slots"]:
                e["slots"].append(slot)

    courses = [merged[k] for k in order]
    for c in courses:
        c["slots"].sort(key=lambda s: (s["day"], s["period"]))
        if not c["slots"] or not c["weeks"]:
            # 拼不出格子就不交半成品：整条丢掉比画错位置好
            c["slots"] = c["slots"] or []

    usable = [c for c in courses if c["slots"] and c["weeks"]]
    max_week = max([max(c["weeks"]) for c in usable] or [0])
    max_period = max([max(s["period"] for s in c["slots"]) for c in usable] or [0]) + 1
    return {"head": _kbt_header(html_text), "courses": usable,
            "totalWeeks": max_week or None, "unitCount": max(10, max_period),
            "empty": not usable}


def parse_stuckcj(html_text: str) -> list:
    """成绩页 → [{term,kch,kcm,xf,cj,jd,hdjd,xfdj,ksxz,ksfs,xz}]（UI 契约同旧版）。"""
    rows = _TR.findall(html_text or "")
    term = ""
    out = []
    for row in rows:
        cells = [clean_cell(t) for t in re.findall(
            r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.I | re.S)]
        if len(cells) == 1 and "学年学期" in cells[0]:
            term = re.split(r"[：:]", cells[0])[-1].strip()
            continue
        if len(cells) >= 12 and cells[0].isdigit():
            raw = cells[1]
            m = re.match(r"\[([0-9A-Za-z]+)\]\s*(.*)", raw)
            kch, kcm = (m.group(1), m.group(2)) if m else ("", raw)
            out.append({
                "term": term, "kch": kch, "kcm": kcm,
                "xf": cells[2], "lb": cells[4], "ksxz": cells[5],
                "ksfs": cells[6], "cj": cells[7], "hdjd": cells[8],
                "jd": cells[9], "xfdj": cells[10], "bz": cells[11],
            })
    return out
