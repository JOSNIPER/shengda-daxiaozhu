"""郑航教务系统（金智 EAMS）客户端与解析器。

只做**读**：登录、取课表、取成绩、取学籍。没有任何提交动作。

实测要点（2026-10-18）：
  1. 密码 = SHA1('<salt>-' + 明文)，而 salt 是**每次 GET 登录页随机生成的 UUID**，
     必须从本次响应里现抓，写死常量会一直报「账号或密码错误」。
  2. GET 登录页后立刻 POST 会被「请不要过快点击」挡，中间必须停几秒。
  3. 登录页没有验证码。
  4. 课表是 JS 片段：`new TaskActivity(...)` + `index =D*unitCount+M;`
     ⇒ index = 星期 * unitCount + 节次（星期 0=周一，节次 0=第一节）。
"""

from __future__ import annotations

import hashlib
import html as _html
import re
import time
from html.parser import HTMLParser

import requests

BASE = "http://jwglxt.zua.edu.cn"
LOGIN_URL = BASE + "/eams/loginExt.action"
HOME_URL = BASE + "/eams/homeExt.action"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# 两次请求之间的最小间隔（秒），别把学校服务器打疼
POLITE_DELAY = 1.2


class EamsError(Exception):
    """登录失败 / 解析失败 / 服务器异常，都收敛成这一个。

    `kind` 用来区分「凭据问题」和「其他问题」：
      "auth"  —— 学号密码不对（或者改过密码了）。界面应该请用户重新输入。
      ""      —— 网络、改版、临时抽风。别让用户白输一遍密码。
    """

    def __init__(self, msg: str, kind: str = "") -> None:
        super().__init__(msg)
        self.kind = kind


# ---------------------------------------------------------------- HTML 表格

class _Table:
    __slots__ = ("rows",)

    def __init__(self) -> None:
        self.rows: list[list[str]] = []


class _TableParser(HTMLParser):
    """把页面里所有顶层 <table> 抽成 list[list[str]]，够用就好。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[_Table] = []
        self._stack: list[_Table] = []
        self._row: list[str] | None = None
        self._in_cell = False
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            t = _Table()
            self._stack.append(t)
            if len(self._stack) == 1:
                self.tables.append(t)
        elif tag == "tr" and self._stack:
            self._row = []
            self._stack[-1].rows.append(self._row)
        elif tag in ("td", "th") and self._row is not None:
            self._in_cell = True
            self._buf = []
        elif tag == "br" and self._in_cell:
            self._buf.append("\n")

    def handle_data(self, data):
        if self._in_cell:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._in_cell and self._row is not None:
            txt = "".join(self._buf)
            txt = re.sub(r"[ \t\r\f\v\u00a0]+", " ", txt).strip()
            self._row.append(txt)
            self._in_cell = False
            self._buf = []
        elif tag == "tr":
            self._row = None
            self._in_cell = False
        elif tag == "table" and self._stack:
            self._stack.pop()
            self._row = None


def parse_tables(html: str) -> list[list[list[str]]]:
    p = _TableParser()
    try:
        p.feed(html)
    except Exception:  # noqa: BLE001 - 半截 HTML 也要能出结果
        pass
    return [t.rows for t in p.tables]


# ---------------------------------------------------------------- 课表解析

def _split_js_args(src: str) -> list[str]:
    out, cur, quote, i = [], [], None, 0
    while i < len(src):
        c = src[i]
        if quote:
            if c == "\\":
                cur.append(src[i:i + 2])
                i += 2
                continue
            if c == quote:
                quote = None
            cur.append(c)
        elif c in "\"'":
            quote = c
            cur.append(c)
        elif c == ",":
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(c)
        i += 1
    if cur:
        out.append("".join(cur).strip())
    return out


def _unquote(tok: str) -> str:
    tok = tok.strip()
    if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in "\"'":
        return tok[1:-1]
    return tok


def _eval_index(expr: str, unit_count: int) -> int | None:
    e = expr.replace("unitCount", str(unit_count)).replace(" ", "")
    if not re.fullmatch(r"[0-9*+\-()]+", e):
        return None
    try:
        return int(eval(e, {"__builtins__": {}}, {}))  # noqa: S307 - 已限定字符集
    except Exception:  # noqa: BLE001
        return None


def parse_timetable(html: str) -> dict:
    """把课表 JS 片段解析成结构化数据。"""
    m = re.search(r"unitCount\s*=\s*(\d+)", html)
    unit_count = int(m.group(1)) if m else 10

    # 学期的周次范围由页面里的 `table0.marshalTable(from, startWeek, endWeek)` 给出。
    # 🔴 别用「最后一门课结束的周次」当学期总周数：郑航实测 marshalTable(2,1,24)，
    #    即第 1~24 周，而最后一门课只排到第 18 周。以前取 max(课程周次) 会得到 18，
    #    导致周次选择器翻不到第 19 周以后——后半个学期的课直接看不见。
    #    （这个参数是 2026-10-18 拆 WakeUp 的 eams 适配器时顺着 table0 找到的。）
    week_start, week_end = 1, 0
    mw = re.search(r"marshalTable\s*\(\s*\d+\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", html)
    if mw:
        week_start, week_end = int(mw.group(1)), int(mw.group(2))

    # 事件流：活动定义 / 格子下标，按出现顺序配对
    events: list[tuple[int, str, str]] = []
    act_spans: list[tuple[int, int, str]] = []
    for mm in re.finditer(r"new\s+TaskActivity\((.*?)\)\s*;", html, re.S):
        events.append((mm.start(), "act", mm.group(1)))
        act_spans.append((mm.start(), mm.end(), mm.group(1)))
    for mm in re.finditer(r"index\s*=\s*([^;]+);", html):
        events.append((mm.start(), "idx", mm.group(1)))
    events.sort()

    # 教师名不是字面量，而是 actTeacherName.join(',')。
    # 每个活动前面紧挨着一段 `var actTeachers = [{id:..,name:"徐璐",lab:false}];`
    # 只能按「上一个活动结束 → 本活动开始」切片去找，不能全局搜。
    teacher_of: dict[int, str] = {}
    prev_end = 0
    for start, end, _ in act_spans:
        chunk = html[prev_end:start]
        last = None
        for m2 in re.finditer(r"actTeachers\s*=\s*\[(.*?)\]\s*;", chunk, re.S):
            last = m2
        if last:
            names = re.findall(r'name:\s*"([^"]*)"', last.group(1))
            teacher_of[start] = ",".join(dict.fromkeys(n for n in names if n))
        prev_end = end

    raw: list[dict] = []
    cur: dict | None = None
    cur_pos = -1
    for pos, kind, payload in events:
        if kind == "act":
            args = _split_js_args(payload)
            if len(args) < 7:
                cur = None
                continue
            weeks_bits = _unquote(args[6])
            # 🔴 位图的下标**就是周次本身**（char[0] 对应第 0 周，恒为 0）。
            #    早期按 i+1 算会整体偏一周，靠浏览器渲染的真实格子才核对出来。
            weeks = [i for i, ch in enumerate(weeks_bits) if ch == "1" and i >= 1]
            full_name = _unquote(args[3])
            nm = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", full_name)
            cur = {
                "name": (nm.group(1) if nm else full_name).strip(),
                "code": (nm.group(2) if nm else "").strip(),
                "teacher": teacher_of.get(pos, _unquote(args[1])),
                "room": _unquote(args[5]),
                "weeks": weeks,
                "slots": [],
            }
            cur_pos = pos
            raw.append(cur)
        else:
            if cur is None:
                continue
            idx = _eval_index(payload, unit_count)
            if idx is None or idx < 0:
                continue
            day, period = divmod(idx, unit_count)
            if 0 <= day < 7 and 0 <= period < unit_count:
                slot = {"day": day, "period": period}
                if slot not in cur["slots"]:
                    cur["slots"].append(slot)

    # 「停课」是调课记录，不是真上课，别画到格子里
    for c in raw:
        if c["room"] == "停课":
            c["slots"] = []

    # 同一门课（同名/同教师/同教室/同周次）合并
    merged: dict[tuple, dict] = {}
    for c in raw:
        if not c["slots"]:
            continue
        key = (c["name"], c["code"], c["teacher"], c["room"], tuple(c["weeks"]))
        if key in merged:
            for s in c["slots"]:
                if s not in merged[key]["slots"]:
                    merged[key]["slots"].append(s)
        else:
            merged[key] = c

    courses = sorted(merged.values(), key=lambda c: (c["slots"][0]["day"], c["slots"][0]["period"]))
    # 学期总周数：页面给的 endWeek 优先，课程周次只作兜底（页面万一没有 marshalTable）
    total_weeks = max(
        week_end,
        max((max(c["weeks"]) for c in courses if c["weeks"]), default=0),
    )

    semester = ""
    for c in courses:
        mm = re.match(r"^(\d{2})(\d{2})(\d)\.", c["code"])
        if mm:
            semester = "20%s-20%s 学年第 %s 学期" % (mm.group(1), mm.group(2), mm.group(3))
            break

    return {
        "unitCount": unit_count,
        "courses": courses,
        "totalWeeks": total_weeks,
        "weekStart": week_start,
        "semester": semester,
    }


# ---------------------------------------------------------------- 成绩解析

def parse_grades(html: str) -> dict:
    tables = parse_tables(html)

    summary: list[dict] = []
    detail: list[dict] = []

    for rows in tables:
        for r in rows:
            cells = [c for c in r]
            if len(cells) == 5 and re.fullmatch(r"\d{4}-\d{4}", cells[0] or ""):
                summary.append({
                    "year": cells[0],
                    "term": cells[1],
                    "count": cells[2],
                    "credits": cells[3],
                    "gpa": cells[4],
                })
            elif len(cells) >= 10 and re.match(r"^\d{4}-\d{4}", cells[0] or ""):
                detail.append({
                    "term": cells[0],
                    "code": cells[1],
                    "seq": cells[2],
                    "name": cells[3],
                    "category": cells[4],
                    "nature": cells[5],
                    "credit": cells[6],
                    "score": cells[7],
                    "final": cells[8],
                    "gpa": cells[9],
                })

    overall = None
    for rows in tables:
        for r in rows:
            if "在校" in (r[0] or "") and len(r) == 4:
                overall = {"count": r[1], "credits": r[2], "gpa": r[3]}
            elif "在校" in (r[0] or "") and len(r) == 5:
                overall = {"count": r[2], "credits": r[3], "gpa": r[4]}
    return {"summary": summary, "overall": overall, "courses": detail}


# ---------------------------------------------------------------- 学籍解析

_PROFILE_KEYS = {
    "学号": "studentId",
    "姓名": "name",
    "性别": "gender",
    "年级": "grade",
    "院系": "dept",
    "专业": "major",
    "方向": "direction",
    "所属班级": "className",
    "所属校区": "campus",
    "学籍状态": "status",
    "学历层次": "level",
    "学制": "duration",
    "入校时间": "enrolledAt",
    "毕业时间": "graduateAt",
}


def parse_profile(html: str) -> dict:
    # 表格是「一行塞两对」的布局：['学号：','2023123456','姓名：','张三','']
    # ⇒ 必须按 2 步长走，只看 [0]/[1] 会漏掉一半字段。
    out: dict[str, str] = {}
    for rows in parse_tables(html):
        for r in rows:
            for i in range(0, len(r) - 1, 2):
                key = (r[i] or "").strip().rstrip("：:")
                val = (r[i + 1] or "").strip()
                if key in _PROFILE_KEYS and val and val != "*":
                    out.setdefault(_PROFILE_KEYS[key], val)
    return out


# ---------------------------------------------------------------- 考试安排
#
# 真实结构（2026-10-18 抓的）：
#   列表页 /eams/stdExamTable.action 里有一段
#     bg.Go('/eams/stdExamTable!examTable.action?examBatch.id=&semester.id=297','contentDiv')
#   ⇒ 明细必须带上 semester.id，否则 Hibernate 报
#     IllegalArgumentException: id to load is required for loading（HTTP 500）。
#   批次下拉 name="examBatch.id"，目前只有一个「平时结课考试」= 1482。
#
# 🔴 截至 2026-10-18 学校**还没发布排考**：表头齐全但 tbody 是空行。
#    所以这里按「表头名字定位列」写，不按下标——列顺序变了也不会错位。

_EXAM_COLS = {
    "课程序号": "code",
    "课程名称": "name",
    "考试类别": "category",
    "考试形式": "form",
    "考试周次与星期": "weekText",
    "考试日期": "date",
    "考试安排": "arrange",
    "考试地点": "room",
    "考场座位号": "seat",
    "考试情况": "status",
    "其它说明": "note",
}


def parse_exams(html: str) -> dict:
    """从考试明细页里抠出考试安排。没有排考时返回空列表（不是报错）。"""
    for rows in parse_tables(html):
        if not rows:
            continue
        head = [(c or "").strip() for c in rows[0]]
        if "考试日期" not in head and "考试地点" not in head:
            continue
        idx = {}
        for i, name in enumerate(head):
            key = _EXAM_COLS.get(name)
            if key and key not in idx:
                idx[key] = i

        out = []
        for r in rows[1:]:
            if not any((c or "").strip() for c in r):
                continue
            rec = {}
            for key, i in idx.items():
                rec[key] = (r[i] or "").strip() if i < len(r) else ""
            # 课程名都没有的行是空壳（学校空表里就是这种），丢掉
            if not rec.get("name"):
                continue
            out.append(rec)
        return {"exams": out, "published": bool(out)}
    return {"exams": [], "published": False}


def parse_exam_page(html: str) -> dict:
    """列表页：抠出 semester.id 和考试批次下拉。"""
    sid = ""
    m = re.search(r"stdExamTable!examTable\.action\?[^\"']*semester\.id=(\d+)", html)
    if m:
        sid = m.group(1)

    batches = []
    mb = re.search(r'<select[^>]*name="examBatch\.id"[^>]*>(.*?)</select>', html, re.S)
    if mb:
        for mo in re.finditer(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)</option>', mb.group(1)):
            batches.append({"id": mo.group(1).strip(), "name": mo.group(2).strip()})

    return {"semesterId": sid, "batches": batches}


def parse_semester_list(html: str) -> list[dict]:
    """学期下拉：`<option value="297">2026-2027学年1学期</option>`。

    只留纯数字 value（学期 id）；空 value 那种「请选择」的占位项要丢掉，
    否则界面上会多一个点不动的空按钮。
    """
    out: list[dict] = []
    seen: set[str] = set()
    for mo in re.finditer(r'<option[^>]*value="(\d+)"[^>]*>([^<]*)</option>', html):
        sid, name = mo.group(1), mo.group(2).strip()
        if not name or sid in seen:
            continue
        seen.add(sid)
        out.append({"id": sid, "name": name})
    return out


def _cells(tr_html: str) -> list[str]:
    """一行 `<td>` 里的纯文本（去标签、解实体、压空白）。

    🔴 必须解 HTML 实体。教务系统的表格里到处是 `&nbsp;`：
       培养计划的课程名是 `&nbsp;1&nbsp;大学生职业生涯规划`，
       不解的话名字前面会挂着 `&nbsp;1&nbsp;`，跟 JS 版（DOMParser 自动解码）
       对不上 —— 而两边不一致，同一个账号在手机和网页上会看到不同的课程名。
    """
    out = []
    for td in re.findall(r"<td[^>]*>(.*?)</td>", tr_html, re.S):
        t = _html.unescape(re.sub(r"<[^>]+>", "", td))
        # \s 在 Python 里不覆盖 \u00a0（NO-BREAK SPACE 属于 Zs 但不是 \s）
        t = re.sub(r"[\s\u00a0]+", " ", t)
        out.append(t.strip())
    return out


def parse_free_rooms(html: str) -> dict:
    """空闲教室结果表 → `{"rooms": [...], "notice": [...], "raw": n}`。

    表格结构（2026-10-19 实测）：
        <table class="gridtable"> → <tbody> → <tr> → 6 个 <td>
        序号 / 名称 / 教学楼 / 校区 / 教室设备配置 / 容量

    🔴 第一行经常是一条 **`停课`** —— 名称是「停课」、没有教学楼、容量 0。
       那不是教室，是学校塞在结果里的一个状态行。**不能当教室画出来**
       （界面上会出现一个叫「停课」的教室），也不能一声不吭地删掉：
       单独放进 `notice`，界面在「没查到教室」时可以说清楚是学校给的标记。
    """
    m = re.search(r"<tbody[^>]*>(.*?)</tbody>", html, re.S)
    if not m:
        return {"rooms": [], "notice": [], "raw": 0}

    rooms: list[dict] = []
    notice: list[str] = []
    raw = 0
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(1), re.S):
        tds = _cells(tr)
        if len(tds) < 6:
            continue
        raw += 1
        _no, name, building, campus, kind, cap = tds[:6]
        if not name:
            continue
        if name == "停课" or (not building and not kind and cap in ("", "0")):
            # 状态行，不是教室
            if name not in notice:
                notice.append(name)
            continue
        try:
            capacity = int(cap)
        except ValueError:
            capacity = 0
        rooms.append({
            "name": name,
            "building": building,
            "campus": campus,
            "type": kind,
            "capacity": capacity,
        })
    return {"rooms": rooms, "notice": notice, "raw": raw}


def parse_room_options(html: str) -> dict:
    """空闲教室查询表单里的三个下拉：教室类型 / 校区 / 教学楼。

    空 value 的「...」占位项丢掉 —— 否则界面上多一个点了没用的按钮。
    """
    def opts(name: str) -> list[dict]:
        m = re.search(r'<select[^>]*name="%s"[^>]*>(.*?)</select>' % re.escape(name),
                      html, re.S)
        if not m:
            return []
        out: list[dict] = []
        seen: set[str] = set()
        for mo in re.finditer(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)</option>', m.group(1)):
            rid, rname = mo.group(1).strip(), mo.group(2).strip()
            if not rid or not rname or rid in seen:
                continue
            seen.add(rid)
            out.append({"id": rid, "name": rname})
        return out

    return {
        "types": opts("classroom.type.id"),
        "campuses": opts("classroom.campus.id"),
        "buildings": opts("classroom.building.id"),
    }


# ---------------------------------------------------------------- 培养计划

def _num(s: str) -> float:
    m = re.search(r"\d+(?:\.\d+)?", s or "")
    return float(m.group(0)) if m else 0.0


def _split_course_cell(s: str) -> dict | None:
    """「KB008B 线性代数 (2.5)」→ `{code, name, credit}`。认不出返回 None。

    ⚠️ 名称本身可能带全角括号：「KB005C 大学物理（一） (2.5)」。
       所以括号里的学分那一段必须锚在**行尾**，否则会把「（一）」当成学分。
    """
    m = re.match(r"^(\S+)\s+(.+?)\s*[（(]\s*([\d.]+)\s*[)）]\s*$", (s or "").strip())
    if not m:
        return None
    return {"code": m.group(1), "name": m.group(2).strip(), "credit": _num(m.group(3))}


def parse_plan(html: str) -> dict:
    """培养计划（`/eams/myPlan.action`）→ 课程清单 + 分类小计 + 替代关系。

    🔴 列数**不固定**，这是这个解析器唯一难的地方：
       大多数行 15 列，但「个性化课程」下面还有子分类（专业选修课）和方向
       （航空智能信息处理方向），那些行是 16 / 17 列 —— 前面多一两格，
       后面全错位。按固定下标取会把学分读成课程名、把学期标记读成必修，
       **而且一个字都不会报错**。
       ⇒ 一律从右往左取：末三列固定是「是否必修 / 开课学院 / 备注」，
         再往左 8 列是「建议修读学期」的 1~8 打勾，再往左才是 学分 / 名称 / 代码。

    另外三类行不是课程，得单独认：
        `[分类, '学分小计', 学分, …]`              14 列
        `[分类, '应修学分', 学分, …]`              顶层分类的额度（通识选修 4 学分）
        `[分类, 子分类, '应修学分', 学分, …]`      子分类额度，父分类已含，不重复加
        `['全程总计', 学分, …]`                    13 列
    """
    out: dict = {
        "total": 0.0,
        "cats": [],
        "courses": [],
        "subs": [],
        "specials": [],
        "found": False,
    }

    for table in re.findall(r"<table[^>]*>.*?</table>", html, re.S):
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S):
            c = _cells(tr)
            if not c:
                continue

            # 全程总计
            if c[0] == "全程总计":
                out["total"] = _num(c[1] if len(c) > 1 else "")
                out["found"] = True
                continue
            # 各类小计
            if len(c) > 2 and c[1] == "学分小计":
                if c[0].strip():
                    out["cats"].append({"name": c[0].strip(), "credit": _num(c[2])})
                continue
            # 「应修学分」可能出现在不同深度，按内容找，别看第几列
            if "应修学分" in c:
                i = c.index("应修学分")
                if i == 0:
                    continue
                path = " / ".join(x.strip() for x in c[:i] if x.strip())
                credit = _num(c[i + 1] if len(c) > i + 1 else "")
                if i == 1:
                    out["cats"].append({"name": path, "credit": credit})
                else:
                    out["specials"].append(
                        {"cat": path, "name": "应修学分", "credit": credit, "note": ""})
                continue
            # 美育专项 / 四史专项这类子要求：14 列，第 2 格不是数字、第 3 格是数字
            if (len(c) == 14 and c[1] and not c[1][:1].isdigit()
                    and re.fullmatch(r"[\d.]+", c[2].strip() or "")):
                out["specials"].append({
                    "cat": c[0].strip(),
                    "name": c[1],
                    "credit": _num(c[2]),
                    "note": c[-1].strip(),
                })
                continue
            # 替代课程表：序号 / 原课程 / 替代课程
            if len(c) == 3 and c[0].strip().isdigit():
                a = _split_course_cell(c[1])
                b = _split_course_cell(c[2])
                if a and b:
                    out["subs"].append({"from": a, "to": b})
                continue

            # 课程行
            n = len(c)
            if n < 14:
                continue
            code = c[n - 14].strip()
            if not re.fullmatch(r"[0-9A-Za-z]+", code or ""):
                continue
            name = re.sub(r"^\s*\d+\s+", "", c[n - 13]).strip()
            if not name:
                continue
            terms = [k + 1 for k in range(8) if "√" in (c[n - 11 + k] or "")]
            out["courses"].append({
                "code": code,
                "name": name,
                "credit": _num(c[n - 12]),
                "cat": " / ".join(x.strip() for x in c[: n - 14] if x.strip()),
                "terms": terms,
                "required": "是" in (c[n - 3] or ""),
                "dept": (c[n - 2] or "").strip(),
                "note": (c[n - 1] or "").strip(),
            })
            out["found"] = True

    return out


# ---------------------------------------------------------------- 该办的事

def _plain_text(html: str) -> str:
    """页面正文：去脚本、去样式、解实体、压空白。"""
    t = re.sub(r"<script.*?</script>", " ", html, flags=re.S)
    t = re.sub(r"<style.*?</style>", " ", t, flags=re.S)
    t = _html.unescape(re.sub(r"<[^>]+>", " ", t))
    return re.sub(r"[\s\u00a0]+", " ", t).strip()


def _select_options(html: str, name: str) -> list[dict] | None:
    """某个 `<select>` 里的选项。**None 表示页面里压根没这个下拉**
    （跟「下拉在但没选项」是两件事，调用方要分开处理）。"""
    m = re.search(r'<select[^>]*name="%s"[^>]*>(.*?)</select>' % re.escape(name), html, re.S)
    if not m:
        return None
    out: list[dict] = []
    for mo in re.finditer(r"<option[^>]*value=\"([^\"]*)\"[^>]*>(.*?)</option>", m.group(1), re.S):
        rid = mo.group(1).strip()
        nm = _html.unescape(re.sub(r"<[^>]+>", "", mo.group(2))).strip()
        if not rid or not nm:
            continue
        out.append({"id": rid, "name": nm})
    return out


def parse_elect(html: str) -> dict:
    """选课（`/eams/stdElectCourse.action`）。

    🔴 只认「明确的关门话」，认不出就报 unknown。
       反过来「没看到关门话 ⇒ 开着」是危险的：页面改版、被踢回登录页、
       甚至加载失败，都会让那个判断变成「选课开了」的假警报。
       用户兴冲冲点进教务系统发现没开，这软件就不可信了。
    """
    t = _plain_text(html)
    m = re.search(r"现在未到选课时间[^！!。]*", t)
    if m:
        return {"state": "closed", "text": "还没到选课时间", "detail": m.group(0)}
    if re.search(r"选课已结束|已过选课时间|选课时间已过", t):
        return {"state": "closed", "text": "选课已经结束", "detail": ""}
    if "选课" in t:
        return {"state": "unknown", "text": "状态没认出来，去教务系统看看",
                "detail": t[:100]}
    return {"state": "unknown", "text": "页面没认出选课内容", "detail": t[:100]}


def parse_free_listen(html: str) -> dict:
    """免听（`/eams/teach/freeListen/freeListenApply.action`）。

    判据是 `select[name=freeListenSwitchId]` 里有没有批次 ——
    实测「2026-2027-1正常免听」「2026-2027-1重修免听」两个。
    """
    opts = _select_options(html, "freeListenSwitchId")
    if opts is None:
        return {"state": "unknown", "text": "页面里没找到免听批次", "detail": ""}
    if not opts:
        return {"state": "closed", "text": "这学期没有免听批次", "detail": ""}
    return {"state": "open", "text": "、".join(o["name"] for o in opts), "detail": ""}


def parse_exemption(html: str) -> dict:
    """免修（`/eams/exemptionApplyNew.action`）。

    ⚠️ 这个页面只有「免修类型」下拉（考核/替代/退役复学/主辅修四种），
       **那是固定的类型，不代表现在能申请**。没有可靠的开关信号，
       所以状态一律报 unknown，只把有哪几种类型摆出来。
    """
    opts = _select_options(html, "type.id")
    if opts is None:
        return {"state": "unknown", "text": "页面里没找到免修类型", "detail": ""}
    if not opts:
        return {"state": "closed", "text": "没有可申请的免修类型", "detail": ""}
    return {
        "state": "unknown",
        "text": "有 %d 种免修类型，开没开要去教务系统看" % len(opts),
        "detail": "、".join(o["name"] for o in opts),
    }


def parse_evaluate(html: str) -> dict:
    """量化评教（`/eams/quality/stdEvaluateNew.action`）。

    ⚠️ 这个页面**没抓到过样本**（2026-10-20 只从首页菜单里看到入口）。
       所以只认两种最不容易误判的信号，其余一律 unknown。
       **不许**因为「没看到待评」就说已评完 —— 那正是「没读到」
       被说成「没有」的经典翻车方式。
    """
    t = _plain_text(html)
    if re.search(r"已评完|评价已?完成|已完成评价", t) and not re.search(r"待评|未评", t):
        return {"state": "closed", "text": "看起来已经评完了", "detail": t[:100]}
    if re.search(r"待评|未评", t):
        return {"state": "open", "text": "有课等着评", "detail": t[:100]}
    return {"state": "unknown", "text": "状态没认出来，去教务系统看看", "detail": t[:100]}


# 该办的事：key / 名字 / 路径 / 解析函数
TODO_DEFS = [
    ("elect", "选课", "/eams/stdElectCourse.action", parse_elect),
    ("evaluate", "评教", "/eams/quality/stdEvaluateNew.action", parse_evaluate),
    ("freeListen", "免听申请", "/eams/teach/freeListen/freeListenApply.action", parse_free_listen),
    ("exemption", "免修申请", "/eams/exemptionApplyNew.action", parse_exemption),
]


# ---------------------------------------------------------------- 客户端

class EamsClient:
    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })
        self.username = ""
        self._last = 0.0
        self._ids = ""
        self._logged_in = False
        # 考试列表页是否已经访问过 —— 学期下拉接口依赖它（见 semesters()）
        self._exam_page_seen = False
        # 这个会话里有没有「project 上下文」—— 空闲教室依赖它（见 _ensure_project）
        self._project_ready = False

    # -- 内部
    def _get(self, path: str, **kw) -> requests.Response:
        gap = time.time() - self._last
        if gap < POLITE_DELAY:
            time.sleep(POLITE_DELAY - gap)
        r = self.s.get(BASE + path, timeout=30, **kw)
        r.encoding = "utf-8"
        self._last = time.time()
        return r

    def _post(self, path: str, data: dict, referer: str = "") -> requests.Response:
        gap = time.time() - self._last
        if gap < POLITE_DELAY:
            time.sleep(POLITE_DELAY - gap)
        headers = {"Origin": BASE}
        if referer:
            headers["Referer"] = BASE + referer
        r = self.s.post(BASE + path, data=data, timeout=40, headers=headers, allow_redirects=True)
        r.encoding = "utf-8"
        self._last = time.time()
        return r

    # -- 对外
    @property
    def logged_in(self) -> bool:
        return self._logged_in

    def login(self, username: str, password: str) -> None:
        r = self._get("/eams/loginExt.action")
        csrf_m = re.search(r'name="_csrf"[^>]*value="([^"]+)"', r.text)
        salt_m = re.search(r"CryptoJS\.SHA1\('([0-9a-fA-F\-]{36})-", r.text)
        if not salt_m:
            raise EamsError("没拿到登录页的加盐值，学校可能改版了")
        hashed = hashlib.sha1((salt_m.group(1) + "-" + password).encode("utf-8")).hexdigest()

        # 立刻提交会被「请不要过快点击」挡掉
        time.sleep(3.0)
        r2 = self._post(
            "/eams/loginExt.action",
            {
                "needModify": "0",
                "_csrf": csrf_m.group(1) if csrf_m else "",
                "username": username,
                "password": hashed,
                "session_locale": "zh_CN",
                "login_from": "login_from",
            },
            referer="/eams/loginExt.action",
        )
        if "homeExt" not in r2.url:
            if "请不要过快点击" in r2.text:
                raise EamsError("学校服务器提示「请不要过快点击」，稍等几秒再试")
            if "密码" in r2.text and ("错误" in r2.text):
                # kind="auth"：这是唯一一种「用户重输一次就能解决」的失败，
                # 界面据此弹「重新输入密码」；网络问题不该让人白输。
                raise EamsError("学号或密码不对", kind="auth")
            raise EamsError("登录没成功，学校系统可能临时抽风")
        self.username = username
        self._logged_in = True

    def ensure_login(self, username: str, password: str) -> None:
        if not self._logged_in:
            self.login(username, password)

    def student_ids(self) -> str:
        if self._ids:
            return self._ids
        r = self._get("/eams/courseTableForStd.action")
        m = re.search(r'bg\.form\.addInput\(form,"ids","(\d+)"\)', r.text)
        if not m:
            raise EamsError("没拿到学生内部编号，可能登录态过期了")
        self._ids = m.group(1)
        return self._ids

    def timetable(self, semester_id: str = "", semester_name: str = "") -> dict:
        """某个学期的课表。`semester_id` 为空 = 教务系统的当前学期。

        🔴 2026-10-31 起支持翻历史学期。表单里那个 `semester.id` 一直存在
           （以前恒为空串），传上学期的 id 教务系统就会返回那一学期的课表。
           **同一个接口，不需要额外的页面** —— 别去猜 `xskbcx` 那套老接口。

        ⚠️ 「空学期」和「登录态过期」都会让响应里没有 TaskActivity，
           但处理方式完全相反：前者该显示「这学期没有课表」，后者该请用户重登。
           区分办法看有没有登录页的特征（密码框 / loginExt），
           有 ⇒ 过期；没有 ⇒ 真的是空课表。
        """
        ids = self.student_ids()
        r = self._post(
            "/eams/courseTableForStd!courseTable.action",
            {
                "ignoreHead": "1",
                "setting.kind": "std",
                "startWeek": "",
                "semester.id": semester_id,
                "ids": ids,
            },
            referer="/eams/courseTableForStd.action",
        )
        if "TaskActivity" not in r.text:
            if re.search(r'name="password"|loginExt\.action', r.text):
                raise EamsError("课表页返回里没有课程数据，可能登录态过期了")
            # 空学期：单元数仍然解析得出来（页面骨架还在），课程为空
            out = parse_timetable(r.text)
            out["courses"] = []
            out["empty"] = True
            if semester_name:
                out["semester"] = semester_name
            return out
        out = parse_timetable(r.text)
        # 课表里的学期名是从**课程代码前缀**推出来的（`25261.`），
        # 课程代码不规整时会是空串。调用方手里有教务给的规范名字，优先用那个。
        if semester_name:
            out["semester"] = semester_name
        return out

    def grades(self) -> dict:
        """历年成绩。

        🔴 2026-11-01 修：**「没有成绩」不是「登录态过期」**。
           以前只要解析不出课程就抛 EamsError，结果 2026 级新生（第一学期
           还没出分、历年成绩页本来就是空表）账号密码全对也绑不上 ——
           提示还写着「可能登录态过期了」，人会一直怀疑自己密码打错了。
           这里改用课表那套判断：响应里有登录页特征 ⇒ 真过期；
           没有 ⇒ 就是空表，原样交出去，界面说「还没有成绩」。
        """
        self._get("/eams/teach/grade/course/person.action")
        r2 = self._get(
            "/eams/teach/grade/course/person!historyCourseGrade.action?projectType=",
            headers={"Referer": BASE + "/eams/teach/grade/course/person.action"},
        )
        if re.search(r'name="password"|loginExt\.action', r2.text):
            # kind="auth"：只有这一种失败是「重输一次就能解决」的。
            raise EamsError("成绩页被退回登录页，可能登录态过期了", kind="auth")
        data = parse_grades(r2.text)
        if not data["courses"]:
            # 空 ≠ 过期。带个标记，免得调用方又把空当成故障。
            data["empty"] = True
        return data

    def profile(self) -> dict:
        r = self._get("/eams/stdDetail.action")
        p = parse_profile(r.text)
        if not p.get("studentId"):
            raise EamsError("没解析出学籍信息，可能登录态过期了")
        return p

    def plan(self) -> dict:
        """培养计划。解析不出来就抛错 —— 「没读到」和「没有计划」必须分开。"""
        r = self._get("/eams/myPlan.action")
        p = parse_plan(r.text)
        if not p["found"] or not p["courses"]:
            raise EamsError("培养计划页没解析出课程，可能登录态过期或页面改版了")
        return p

    def todo(self) -> dict:
        """「该办的事」：选课 / 评教 / 免听 / 免修的开放状态。

        🔴 任何一项取失败都**只影响它自己**，别让整块变成「全都未知」；
           同时也要把失败原因写进那一项，不能安静地显示成「没开放」。
        """
        items = []
        for key, name, path, parse in TODO_DEFS:
            try:
                r = self._get(path)
                st = parse(r.text)
                items.append({
                    "key": key, "name": name, "state": st["state"],
                    "text": st["text"], "detail": st.get("detail", ""), "path": path,
                })
            except Exception as e:  # noqa: BLE001
                items.append({
                    "key": key, "name": name, "state": "unknown",
                    "text": "没查到：%s" % e, "detail": "", "path": path,
                })
        return {"items": items}

    def exams(self, semester_id: str = "") -> dict:
        """考试安排。`semester_id` 为空 = 教务系统默认（当前学期）。

        🔴 学校没排考时**不是错误**，返回空列表 + published=False，
           界面照实说「还没发布」，别把「没数据」伪装成「没有考试」。
        """
        path = "/eams/stdExamTable.action"
        if semester_id:
            # 带上 semester.id 服务端就切到那个学期：页面里的批次下拉
            # 和明细链接都跟着变（实测 257 / 277 / 297 各不相同）。
            path += "?semester.id=%s" % semester_id
        page = self._get(path)
        self._exam_page_seen = True
        meta = parse_exam_page(page.text)
        # 🔴 页面里既没有学期 id 也没有批次下拉 ⇒ 十有八九被踢回登录页了。
        #    这种情况**必须报错**：安静返回 0 条，界面就会说「这学期没有考试安排」，
        #    等于把「没读到」说成「没有」（2026-10-19 实测会话过期就是这样）。
        #    抛 EamsError 之后 _with_client 会重登一次再试。
        if not meta["semesterId"] and not meta["batches"]:
            raise EamsError("考试页没打开，可能登录态过期了")
        sid = semester_id or meta["semesterId"]
        batches = [b for b in meta["batches"] if b["id"]]

        if not sid:
            # 拿不到学期 id 就没法查明细，但也不能报「没有考试」
            return {
                "exams": [],
                "published": False,
                "batches": batches,
                "reason": "没找到学期编号，可能页面结构变了",
            }

        all_rows: list[dict] = []
        seen: set[tuple] = set()
        tried = []
        # 先按批次查；批次全空时再试「不指定批次」，学校两种写法都出现过
        targets = [b["id"] for b in batches] + [""]
        for bid in targets:
            tried.append(bid)
            r = self._get(
                "/eams/stdExamTable!examTable.action?examBatch.id=%s&semester.id=%s" % (bid, sid)
            )
            got = parse_exams(r.text)
            for e in got["exams"]:
                key = (e.get("code"), e.get("date"), e.get("room"), e.get("name"))
                if key in seen:
                    continue
                seen.add(key)
                all_rows.append(e)

        return {
            "exams": all_rows,
            "published": bool(all_rows),
            "batches": batches,
            "semesterId": sid,
            "tried": tried,
        }

    def semesters(self) -> list[dict]:
        """全部学期（教务系统给 53 个，界面自己筛成「我在读的那几个」）。

        🔴 必须**先访问一次考试页**，否则这个接口回空 —— 2026-10-19 实测：
           新会话里直接 GET dataQuery.action?dataType=semester 拿到的是空列表，
           先 GET /eams/stdExamTable.action 之后同样的请求就有 53 项。
           所以这里判断 `_exam_page_seen`，考试页已经走过就不再重复打一次。
        """
        if not self._exam_page_seen:
            self._get("/eams/stdExamTable.action")
            self._exam_page_seen = True
        r = self._get("/eams/dataQuery.action?dataType=semester")
        return parse_semester_list(r.text)

    # -- 空闲教室 ------------------------------------------------------
    #
    # 🔴 这一块有个跟「考试页要先摸一次」同类的坑：
    #    `/eams/classroom/apply/free.action` 是**受限动作**（RestrictionSupportAction），
    #    服务端要求 session 里有 project（培养层次，郑航是「本科」）。
    #    只访问 homeExt 不算；必须先访问 stdDetail / courseTableForStd 这类页面。
    #    2026-10-19 实测：不先摸，一律 500 `project not selected`；
    #    摸过之后同样的请求就是 200 + 结果表。
    #
    # 🔴 第二个坑：`free!search.action` 默认只回 **20 行**（grid 分页），
    #    而且要传 `pageSize`（不是 page.size / rows / pageSize 之外那些名字）。
    #    不传就只能看到按容量升序的前 20 个 —— 全是常年空着的小实验室，
    #    换节次、换日期看起来都「一模一样」，会让人以为筛选没生效。

    def _ensure_project(self) -> None:
        if self._project_ready:
            return
        self._get("/eams/stdDetail.action")
        self._project_ready = True

    def room_options(self) -> dict:
        """教室类型 / 校区 / 教学楼三个下拉的选项。"""
        self._ensure_project()
        r = self._get("/eams/classroom/apply/free.action")
        if "project not selected" in r.text:
            raise EamsError("空闲教室页没打开，可能登录态过期了")
        return parse_room_options(r.text)

    def free_rooms(self, date_begin: str, date_end: str,
                   period_begin: int = 1, period_end: int = 2,
                   building_id: str = "", campus_id: str = "",
                   type_id: str = "", seats: str = "", name: str = "",
                   page_size: int = 1000) -> dict:
        """查某天某几节的空闲教室。

        date_begin/date_end 必填（不填服务端直接 500）；
        period_begin/period_end 是**节次编号 1~12**（roomApplyTimeType=0 走小节）。

        🔴 page_size 默认给 1000，不是 200：这个参数服务端**认**，
           实测 1000 一次就回全 756 行（755 间教室 + 1 行「停课」）。
           以前用 200 只能拿到「按容量升序」的前 200 个 —— 全是 6 座的小实验室，
           换节次换日期看起来都一模一样，会让人以为筛选没生效。
        """
        if not date_begin or not date_end:
            raise EamsError("要查哪一天？日期不能空")
        if not (1 <= period_begin <= period_end <= 12):
            raise EamsError("节次要在 1~12 之间，且开始不晚于结束")
        self._ensure_project()
        data = {
            "classroom.type.id": type_id,
            "classroom.campus.id": campus_id,
            "classroom.building.id": building_id,
            "seats": seats,
            "classroom.name": name,
            "cycleTime.cycleCount": "1",
            "cycleTime.cycleType": "1",          # 1=按天
            "cycleTime.dateBegin": date_begin,
            "cycleTime.dateEnd": date_end,
            "roomApplyTimeType": "0",            # 0=按小节
            "timeBegin": str(period_begin),
            "timeEnd": str(period_end),
            "pageSize": str(page_size),
        }
        r = self._post("/eams/classroom/apply/free!search.action", data,
                       referer="/eams/classroom/apply/free.action")
        if r.status_code != 200:
            m = re.search(r"错误原因:.*?<pre>(.*?)</pre>", r.text, re.S)
            why = re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else "HTTP %d" % r.status_code
            raise EamsError("空闲教室查询失败：%s" % why)
        # 🔴 会话被踢时学校回的**也是 HTTP 200**，正文只有一句话：
        #    「本次会话已经被过期（可能是由于重复登录）」（20 字节）。
        #    不认这一条的话，parse 出来就是 0 间，界面会说「这一节没有空闲教室」
        #    —— 把错误说成事实，比直接报错更糟。
        #    抛 EamsError 还能让 _with_client 重登一次再试（见 bridge.Service）。
        #    正常的「查不到」返回里是有这张 gridtable 的（只是 tbody 为空），
        #    所以这个判据不会把真·空结果误判成失败。
        if "gridtable" not in r.text:
            why = re.sub(r"<[^>]+>", " ", r.text)
            why = re.sub(r"\s+", " ", why).strip()[:60]
            raise EamsError("空闲教室查询没返回结果表：%s" % (why or "可能登录态过期了"))
        out = parse_free_rooms(r.text)
        out["dateBegin"] = date_begin
        out["dateEnd"] = date_end
        out["periodBegin"] = period_begin
        out["periodEnd"] = period_end
        # 服务端回的行数拿满了 page_size 就说明可能还有更多 —— 界面上要照实说，
        # 不能让用户以为「全校就这么多空教室」。
        # ⚠️ 用 raw（含「停课」那种状态行）而不是 rooms 来判：状态行也占一个名额。
        out["truncated"] = out["raw"] >= page_size
        return out
