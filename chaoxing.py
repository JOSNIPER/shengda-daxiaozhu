"""超星学习通 · 作业待办（只读）

这个模块只干一件事：用你自己的账号，把「哪些作业还没交、还剩多久」读出来。

--------------------------------------------------------------------------
四条硬规矩（都是实测踩出来的）

  1. 🔴 **只读。** 不签到、不刷课、不自动答题、不代交作业。
     这些是学术诚信红线；而且超星是分级风控 ——
     首次警告 → 冻结 24 小时 → 灰名单要人工申诉。脚本化操作真的会被封。

  2. 🔴 **失败不重试。** 登录失败一次就停。重试会把 needVcode 撞成 1，
     之后就要人做滑块验证，越弄越糟。

  3. 🔴 **「没读到」≠「没有作业」。** 某门课拿不到数据时，要如实记进 failed，
     不能让它悄悄变成 0 条 —— 否则你会以为真的没作业。

  4. 🔴 **不认识的作业状态不许兜底。** 实测状态有 6 种：
     未交 / 未开始 / 已完成 / 待批阅 / 已批阅 / 已互评。
     前两个算待办，中间三个算完成，「已互评」既不像待办也不像完成 ——
     单独列出来，不当成任何一边。

--------------------------------------------------------------------------
为什么每门课要两个请求（不搞懂就会一直「无权限」）

  第 1 个：进课程页，拿两样东西
      · stuenc  —— 藏在 302 之后的 URL 里，**每次进课程页都变**
      · workEnc —— 藏在 HTML 的 <input id="workEnc"> 里，课程级固定
  第 2 个：带着 stuenc + workEnc 去要作业列表

  🔴 两个 enc 必须来自**同一次**课程页加载。混用旧的和新的 → 「无权限的操作」。
     2026-10-22 在这个坑里耗了三轮：先猜旧接口（404），再裸请求（无权限），
     最后发现是打印 URL 时截断了 190 字符，enc 少了一位。

--------------------------------------------------------------------------
cookie 分两个域，混在一起就「无效的用户」

  passport2.chaoxing.com : JSESSIONID、route      ← 只属于登录站
  .chaoxing.com          : UID、_uid、_d、vc3、uf、cx_p_token、p_auth_token、
                           xxtenc、fid、DSSTASH_LOG

  把前两个也发给 mooc1.chaoxing.com，服务端会拿着不属于它的 session 去查用户。
  所以必须用 requests 的 cookie jar 按域自动匹配，**不能用 Cookie 头硬塞**。

--------------------------------------------------------------------------
代价

  32 门课 ≈ 64 个请求 ≈ 60 秒。学习通没有「一次拿全部作业」的接口，
  作业挂在每门课下面，只能一门一门来。所以手机上必须「后台跑 + 结果缓存 +
  写明更新于什么时候」，不能每次进页面都跑。
"""

from __future__ import annotations

import base64
import json
import random
import re
import threading
import time

import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

# ------------------------------------------------------------------ 常量

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")

AES_KEY = b"u2oh6Vu^HWe4_AES"      # 16 字节，同时当 key 和 iv（login.js 里写死的）

PASSPORT = "https://passport2.chaoxing.com"
LOGIN_PAGE = PASSPORT + "/login?fid=&refer="
LOGIN_API = PASSPORT + "/fanyalogin"
COURSE_API = "https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1"
COURSE_PAGE = ("https://mooc1.chaoxing.com/visit/stucoursemiddle"
               "?courseid=%s&clazzid=%s&cpi=%s&ismooc2=1&v=2")
WORK_LIST = ("https://mooc1.chaoxing.com/mooc2/work/list"
             "?courseId=%s&classId=%s&cpi=%s&ut=s&t=%d&stuenc=%s&enc=%s")

# 课程内的「活动」列表（签到 / 主题讨论 / 通知 / 作业 / 随堂练习 …）。
# 返回 JSON，比抓 HTML 稳得多。
# 🔴 fid 是**学校 id**（课程数据里的 belongSchoolId，郑航是 1286），
#    不是课程页隐藏字段里那个 id="fid"（那个是 23264，别的东西）。
ACTIVE_LIST = ("https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist"
               "?fid=%s&courseId=%s&classId=%s&showNotStartedActive=0&_=%d")

# 考试列表。参数照抄 course-stu.js 里点导航时的拼法 ——
# 缺任何一个都回「参数传递不正确」，而 HTTP 状态码还是 200。
EXAM_LIST = ("https://mooc1.chaoxing.com/exam-ans/mooc2/exam/exam-list"
             "?courseid=%s&clazzid=%s&cpi=%s&ut=s&t=%d&stuenc=%s")

# activeType → 中文名。
# 🔴 这张表不是查来的，是**从学习通自己的任务列表页里挖出来的**：
#    _lab/cx/ml/active_page.html 的 Vue 模板里 aria-label 和
#    `v-if="active.activeType=='N'"` 一一对应，逐条抄下来。
ACTIVE_KIND = {
    "2": "签到", "4": "抢答", "5": "主题讨论", "11": "选人", "14": "问卷",
    "17": "直播", "19": "作业", "23": "评分", "34": "通知", "35": "分组任务",
    "42": "随堂练习", "43": "投票", "45": "通知", "46": "群聊", "47": "计时器", "48": "课程章节",
    "49": "白板", "50": "主题讨论", "51": "同步课堂", "56": "泛雅课堂",
    "57": "PPT文档", "58": "教案", "59": "抽签", "60": "教案", "61": "WORD文档",
    "62": "PDF文档", "63": "阅读任务", "68": "互动练习", "74": "签退",
    "75": "思政资源库", "77": "AI实践",
}

# 活动详情页地址：**按 activeType 分**。
# 🔴 这张表不是猜的，是从学习通自己的活动列表页模板里抄的 ——
#    `_lab/cx/ml/active_page.html` 的 `activeRowClick()` 里那个 switch。
#    参数只用课程对象里现成的 courseId / classId / fid（= schoolId）。
CX_BASE = "https://mobilelearn.chaoxing.com"
ACTIVE_PAGE = {
    "2": "/page/sign/signIn",                                  # 签到
    "74": "/page/sign/signIn",                                 # 签退
    "50": "/page/topicDiscuss/student/stu_reply_discuss",      # 主题讨论
    "42": "/page/quiz/stu/answerQuestion2",                    # 随堂练习
    "14": "/page/quiz/stu/answerQuestion",                     # 问卷
    "43": "/page/qvote/stu/answerQvote",                       # 投票
    "68": "/page/interactivepractice/stu/answerQu",            # 互动练习
}

# 归成用户要的四类。用户 2026-10-22：
#   「学习通的作业信息也分成几种，比如主题讨论，签到信息，作业，考试」
# 考试不在这里 —— 它在单独的页上（EXAM_LIST），不在活动列表里。
KIND_BUCKET = {
    "sign": ("2", "74"),      # 签到 / 签退
    "topic": ("5", "50"),     # 主题讨论
    "work": ("19",),          # 作业（活动列表里也会有作业提醒）
    "notice": ("34", "45"),   # 通知。34 是老版本，45 是新版本 —— 同一件事的两种 type。
                              # 🔴 45 是南师侧 2026-10-23 拿原始响应实测出来的：那条记录的
                              #    content 里是 creatorRealName（老师名）、extraInfo 里是
                              #    noticeId（通知主键）。不是猜的。
                              #    只认 34 的后果：新版通知全落进「其他」，用户看不到。
    # 随堂练习 / 互动练习（0.39.0）。用户 2026-11-01 原话：
    #   「还很容易错过作业和考试，还有随堂练习」。
    # 以前它们落到 other，和「白板 / 教案 / PDF 文档 / 计时器」挤在同一格 ——
    # 那格本来就是垃圾桶，真正的任务淹没在里面，等于没提示。
    # 单独一类，排在做作业后面：这是**要在几分钟内做完**的东西，
    # 比作业还急，不该跟「老师传了个 PDF」平起平坐。
    "quiz": ("42", "68"),
}

# 分类的中文名 + 显示顺序。前端的分段条照这个顺序生成，两边别各写一份。
KIND_NAME = {
    "work": "作业", "exam": "考试", "quiz": "练习", "sign": "签到",
    "topic": "讨论", "notice": "通知", "other": "其他",
}
KIND_ORDER = ("work", "exam", "quiz", "sign", "topic", "notice", "other")

# 作业状态分三档。不认识的走「其他」，两边都不算。
# 🔴 「待互评」是**要我去评别人**，是要我动手的事 ⇒ 必须算 todo。
#    以前它两边都不在，落到「其他」并被排除在待办之外 —— 等于把一件该做的事藏了。
# 🔴 「待批阅 / 已批阅」是**我已经交了**、等老师 ⇒ 算 done，绝不能算要交。
#    （2026-10-23 南师侧实测：76 条作业里 63 条是这种，全算「要交」会让人一进门
#     看到 76，滑三屏才发现只有 7 条真没交 —— 那会训练用户忽略这个数字。）
TODO_STATES = ("未交", "未开始", "待互评")
DONE_STATES = ("已完成", "待批阅", "已批阅", "已互评")

# 考试状态。🔴 只把**明确表示已经考完/考过**的算 done；
#    没见过的取值一律留在待办里，并把原始状态文字原样显示出来。
#    宁可多显示一条，也不能把一场还没考的考试藏起来。
DONE_EXAM_STATES = ("已完成", "已结束", "已交卷", "已参加", "已批阅", "已过期")

# 每门课之间的间隔（秒）。加抖动，别让请求节奏整齐得像机器。
SCAN_GAP = 0.9
SCAN_JITTER = 0.4

# ---- 结课判定 ---------------------------------------------------------
# 一门课「四个请求全成功、三个列表全空」连续出现 REST_STREAK 次，且从第一次
# 空到现在已经过了 REST_SPAN，就认为它结课了；之后每 REST_GAP 才扫一次。
#
# 🔴 为什么不能「首次扫到空就判结课」：
#    开学第 1 周几乎所有课都还没发作业 —— 实测 32 门课里 13 门是空的，
#    其中「线性代数」「高等数学」都是**本学期**的课，只是作业还没留。
#    首次就判的话，开学第一周能把整个学期的课全判死，然后老师真发了作业，
#    用户永远看不到。这比「慢 90 秒」糟得多。
#
# 🔴 为什么是「降频」而不是「永不扫」：
#    判据总有出错的那天（老师换课、作业晚发、我们解析过时）。
#    永不扫 = 错了就永远发现不了；每 7 天扫一次 = 最坏晚 7 天。
#    用户的原话是「结课后不再具体扫描」，这里的「不扫」是「几乎不扫」，
#    留的这条低频线就是给他兜底的。
#
# 🔴 为什么「没读到」不算空：
#    502 / 202 / 超时 / 课程页没打开 —— 这些是「不知道」，不是「没有」。
#    拿它们当空，等于把被限流的课判成结课，然后它就再也不会被扫。
#    这跟我们刚修的「502 被当成没作业」是同一个病，只是后果更重：
#    那次是这一次显示错了，这次是**以后永远不查**。
REST_STREAK = 3
REST_SPAN = 7 * 86400
REST_GAP = 7 * 86400

# ---- 冷课判定（0.39.0）------------------------------------------------
# 上面的规则要求「三个列表全空」—— 但历史学期的课**不空**：它们还挂着
# 上学期的作业和活动。于是 37 门课里 22 门一个学期都判不出结课，
# 每次刷新仍然全量扫，用户的原话是「每次都需要全量扫描」。
#
# 换个证据：**有内容，但最新那条已经是 COLD_DAY 之前的事**。
#   真读到了内容（不是「没读到」），只是那些内容全都旧了 ⇒ 这门课没在动。
#
# 🔴 为什么冷课可以「一次就降频」，而空课必须攒 3 次 + 7 天：
#    空 = 没有证据（老师可能只是还没发作业）；冷 = 有证据（东西都在，都很旧）。
#    两件事的可信度差一档，处理也不该一样。
COLD_DAY = 90 * 86400


class CxError(Exception):
    """kind: 'auth' 登录/登录态有问题，'net' 网络，'deny' 被拒，'parse' 结构变了。"""

    def __init__(self, msg: str, kind: str = "net") -> None:
        super().__init__(msg)
        self.kind = kind


def _status_ok(r, what: str) -> None:
    """非 200 一律当服务端/网络错误。

    🔴 为什么必须显式判：`requests` 默认**不**对 4xx/5xx 抛异常，
       所以 502 页会被当成正常响应交给解析器。而 `parse_work` 找不到 `<ul>`
       就返回 `[]` —— 「服务器挂了」于是被静默当成「这门课没有作业」。

    实测（`_lab/cx/probe_502.py`，两门课全部 502）修之前的样子：
        work   → code=noentry 「没给作业入口」      ← 假话
        exam   → code=noentry 「没给考试入口」      ← 假话
        active → code=auth    「登录态可能失效了」  ← 假话，而且更糟：
                  `scan()` 见到 auth 就 break，**第二门课根本不查、也不记录**，
                  界面上它凭空消失了。

    2026-10-23 修。南师侧同一天真撞上「一门课 502 让整场扫描崩掉」
    （他的 `except CxError` 漏了网络层的 `NynuError`）。我这边不崩，
    但静默少数据 —— 两个都不是「说真话」。

    🔴 2026-10-24 补：**202 不是「服务器出错」，是「查得太密被限流」。**
       用户真机上 17 门课一起返回 202（截图 2026-10-24）。202 = Accepted，
       请求收到了但没给内容 —— 学习通那边通常就是风控在排队。
       这时候「等几分钟再试」是有用的；「不是你的问题」听着像没事，
       用户就不会等，反而接着点，越点越封。
       所以 202 单独一句文案，别的非 200 才说「服务器出错了」。
    """
    code = int(getattr(r, "status_code", 0) or 0)
    # 🔴 2026-10-25 补：401 是「未授权」，不是「服务器出错」。
    #    以前 401 走下面那条「学习通服务器出错了，不是你的问题」——
    #    那句话会让用户干等着，而他真正该做的是点「重新连接」。
    #    而且 401 判成 net 之后，`scan()` 不会 break，剩下 25 门课
    #    会各发一次注定 401 的请求 —— 白打 25 次，还加重风控。
    #    ⚠️ 403 仍然算 net：学习通的 403 多半是风控拦的，不是账号问题。
    #    ⚠️ 必须和 `web/native.js` 的 `cxStatusOk()` 逐字一致（对拍会验）。
    if code == 401:
        raise CxError("%s返回 401（登录态过期了，点「重新连接」再试一次）"
                      % what, "auth")
    if code == 202:
        raise CxError("%s返回 202（查得太密，被临时限流了 —— 过几分钟再试）"
                      % what, "net")
    if code != 200:
        raise CxError("%s返回 %d（学习通服务器出错了，不是你的问题）"
                      % (what, code), "net")


def _looks_logged_out(text: str) -> bool:
    """这段内容是不是「登录页」而不是接口数据。

    ⚠️ 必须和 `web/native.js` 的 `cxLooksLoggedOut()` 逐字对齐
       （`_lab/cx/check_cx_js.py` 拿同一份输入对拍）。

    🔴 为什么需要它：没登录时学习通会把接口 302 到登录页，回来的是 200 +
       一大坨 HTML。只判「JSON 解析失败」的话，会报「接口可能变了」——
       那是**假话**，用户按它理解只能等更新，而真正该做的是重连。

    🔴 先判「像不像 JSON」再判关键字：正常数据里 courseName 完全可能带
       「用户登录」四个字（一门叫《用户登录与鉴权》的课），
       只看关键字会把正常数据判成没登录 —— 比反过来更糟，
       因为它会让人白白重连一次、还可能把密码撞错。
    """
    s = "" if text is None else str(text)
    if not s:
        return False
    head = s.lstrip()[:1]
    if head in ("{", "["):
        return False                       # 是 JSON 就不可能是登录页
    return ("passport2.chaoxing.com" in s) or ("用户登录" in s)


def rest_next(st: dict, ok_all: bool, is_empty: bool, now: int,
              newest=None) -> dict:
    """算一门课这一轮扫描之后的「结课判定」状态。**纯函数**。

    st       上一轮的状态（可能没有）
    ok_all   这一轮四个请求是不是全部成功（课程页 + 作业 + 考试 + 活动）
    is_empty 三个列表是不是都为空
    now      现在（unix 秒）
    newest   这门课最新一条内容的时间（截止时间 / 活动开始时间，unix 秒）。
             None = 有内容但都没给时间，或者一条都没有。见 COLD_DAY。

    🔴 为什么单独抽出来：APK 里没有 Python，`native.js` 的 `cxRestNext` 是
       **另一份实现**。两份必须逐条对拍（`_lab/cx/check_cx_js.py`）——
       只改一边不报错，只是手机上和网页上「哪些课算结课」会得出不同答案，
       而且用户看不出来是哪一边错了。

    🔴 ok_all=False 时**原样返回**：既不加次数（那是拿「没读到」当「没有」），
       也不清零（那会让好不容易攒的次数白费）。这是整个判据里最要紧的一条。
    """
    st = st if isinstance(st, dict) else {}
    if not ok_all:
        return dict(st)
    if is_empty:
        streak = int(st.get("streak") or 0) + 1
        since = int(st.get("since") or now)
        return {
            "streak": streak, "since": since, "lastAt": now,
            # 次数够 + 跨度够 才真的停扫。只满足一条不算：用户一天点三次刷新
            # 也能凑够 3 次，但那才过了半天，分不清「结课」和「今天还没发作业」。
            "resting": bool(streak >= REST_STREAK and now - since >= REST_SPAN),
        }
    # 有内容，但最新那条已经是 COLD_DAY 之前的事 ⇒ 冷课，这一轮就降频。
    #   历史学期的课全都落在这里：它们不是空的（上学期的作业还挂着），
    #   只是**全都旧了**。以前正是因为「不空」，这些课永远判不出结课。
    # 🔴 newest 不是数字（结构变了 / 页面没给）时**不判冷**：那是「不知道多旧」，
    #    不是「很旧」。宁可多扫一轮，也不要把一门课误判死。
    cold = False
    if newest is not None:
        try:
            cold = (now - int(newest)) >= COLD_DAY
        except (TypeError, ValueError):
            cold = False
    if cold:
        return {"streak": int(st.get("streak") or 0) + 1,
                "since": int(st.get("since") or now), "lastAt": now,
                "resting": True}
    # 有内容且是新的 ⇒ 立刻恢复。这是判错时的自我纠错：判成结课以后
    # 低频扫到东西，下一轮就回到每轮都扫。
    return {"streak": 0, "since": now, "lastAt": now, "resting": False}


def unique_courses(courses) -> list:
    """按 `(courseId, classId)` 去重。**纯函数**，和 `native.js` 的逐条对齐。

    🔴 0.39.0 之前只按 `courseId` 去重，注释写着「不同 classId 的作业/考试/活动
       都是同一套」—— 那句是错的。同一个 courseId 下面可能挂着**不同学期**的
       教学班（实测这个账号的「大学物理实验」同时有 26-27-1 和 25-26-2 两个班，
       「高等数学（理工类）」有三个班跨三个学期）。
       压成一个 ⇒ 只查了其中**一个**班（留下的是先出现的那个），
       顺序一换，本学期的作业就一条都不在了，而界面上一切正常。
    """
    seen, out = set(), []
    for c in (courses or []):
        if not isinstance(c, dict):
            continue
        k = (c.get("courseId"), c.get("classId"))
        if k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out


def rest_key(course_id, class_id) -> str:
    """结课状态的 key：`<courseId>:<classId>`。**纯函数**。

    🔴 为什么必须带 classId：同一个 courseId 下面可能挂着**不同学期**的教学班
       （实测这个账号的「高等数学（理工类）」同时有 25-26-1 / 25-26-2 / 非当前
       三个班）。只按 courseId 存，就等于让三个班共用一份「结没结课」的结论 ——
       本学期的班会被上学期的班判定成结课，然后真的作业就再也不会被查。
    和 `native.js` 的 `cxRestKey` 逐字对齐。
    """
    return "%s:%s" % (course_id, class_id if class_id is not None else "")


# ---- 教务课表白名单 ---------------------------------------------------
# 归一化：全角转半角、去掉所有空白和标点、罗马数字统一、砍掉学期后缀。
# 目标是让「大学英语Ⅰ（二）」和「大学英语I(二)」能对上，而不是做分词。
_FULL2HALF = {c: c - 0xFEE0 for c in range(0xFF01, 0xFF5F)}
_FULL2HALF[0x3000] = 0x20
_ROMAN = {"Ⅰ": "I", "Ⅱ": "II", "Ⅲ": "III", "Ⅳ": "IV", "Ⅴ": "V",
          "Ⅵ": "VI", "Ⅶ": "VII", "Ⅷ": "VIII"}


def _norm_name(s) -> str:
    """课名归一化。认不出就返回空串（空串永远不参与匹配）。"""
    t = str(s or "").translate(_FULL2HALF)
    for a, b in _ROMAN.items():
        t = t.replace(a, b)
    t = re.sub(r"[\s\u3000·・,，。、;；:：!！?？'\"“”‘’()（）\[\]【】<>《》/\\|+*#-]", "", t)
    t = t.upper()
    return t


def _norm_names(names) -> list:
    """把一串课名归一化成可比较的列表。空 / 不是列表 ⇒ 空列表。"""
    if not isinstance(names, (list, tuple)):
        return []
    out = []
    for x in names:
        v = _norm_name(x)
        if len(v) >= 2:            # 一个字的名字（「体育」被截成「体」）不参与匹配
            out.append(v)
    return out


def _in_white(title, white) -> bool:
    """这门课是不是「本学期教务课表里在修」。

    🔴 匹配故意**宽松**（互相包含 / 前 4 个字相同都算）：白名单的作用是
       「别把正在上的课降频」，误放行只是多扫一门，代价很小；
       而漏放行 = 这门课真的作业被降频档住了，代价很大。
       ⇒ 宁可多认，不可少认。
    """
    if not white:
        return False                   # 没白名单 ⇒ 调用方会整体关掉降频
    t = _norm_name(title)
    if not t:
        return False
    for w in white:
        if w == t or w in t or t in w:
            return True
        if len(w) >= 4 and len(t) >= 4 and w[:4] == t[:4]:
            return True
    return False


def _progress(cb, i: int, n: int, title: str, phase: str = "") -> None:
    """调前端传进来的进度回调。

    老调用方只接 3 个参数（没有 phase），多传一个会 TypeError —— 退回 3 参数再试。
    回调本身出错绝不能连累扫描：它只是个显示器，坏了不该让整件事停下。
    """
    if not cb:
        return
    try:
        cb(i + 1, n, title, phase)
    except TypeError:
        try:
            cb(i + 1, n, title)
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        pass


# ------------------------------------------------------------------ 纯函数（可单测）

def aes_b64(text: str) -> str:
    """照抄 login.js 的 encryptByAES：AES-CBC + PKCS7，key 当 iv，输出 Base64。

    iv 是固定的 ⇒ 同一个密码每次算出同一串密文。验收脚本靠这条性质反推
    「用的到底是哪份密码」。
    """
    c = AES.new(AES_KEY, AES.MODE_CBC, AES_KEY)
    return base64.b64encode(c.encrypt(pad(text.encode("utf-8"), 16))).decode()


def parse_left(text: str):
    """「剩余32小时54分钟」→ 1974（分钟）。认不出来返回 None。

    🔴 不兜底成 0：0 分钟意味着「已经到期了」，那是完全相反的意思。
       认不出来就是认不出来，调用方自己决定怎么显示。
    """
    if not text:
        return None
    s = str(text)
    if "剩余" not in s:
        return None
    d = re.search(r"(\d+)\s*天", s)
    h = re.search(r"(\d+)\s*小时", s)
    m = re.search(r"(\d+)\s*分", s)
    if not (d or h or m):
        return None
    return ((int(d.group(1)) * 1440 if d else 0)
            + (int(h.group(1)) * 60 if h else 0)
            + (int(m.group(1)) if m else 0))


def parse_courses(j: dict) -> list:
    """把 backclazzdata 的 JSON 变成课程列表。

    🔴 字段位置是实测出来的：
       courseId = content.course.data[0].id
       classId  = content.id
       cpi      = channel.cpi（同一个人的所有课都是同一个数）
       title    = data[0].name（干净课名）
       alias    = content.name（班级课名，带老师/周次，不能当课名用）
       schoolId = data[0].belongSchoolId（学校 id，活动列表接口要这个；
                  郑航是 1286。🔴 别拿课程页里 id="fid" 那个数，那是别的东西）
    """
    out = []
    for ch in (j.get("channelList") or []):
        ct = ch.get("content") or {}
        rows = ((ct.get("course") or {}).get("data")) or []
        if not rows:
            continue
        d = rows[0]
        out.append({
            "courseId": d.get("id"),
            "classId": ct.get("id"),
            "cpi": ch.get("cpi") or ct.get("cpi"),
            "title": d.get("name") or ct.get("name") or "",
            "alias": ct.get("name") or "",
            "schoolId": d.get("belongSchoolId") or "",
        })
    return out


def _end_from_left(left_min, now=None):
    """「还剩 2 小时 10 分钟」→ 绝对截止时间（unix 秒）。

    列表页**只给倒计时，不给绝对时间**（作业页和考试页都是这样），
    所以只能在这一刻换算：`now + left_min*60`。

    为什么要存绝对时间而不是只存分钟：
      1. 界面上要同时给「还剩」和「截止 10-23 23:59」—— 后者得有个来源；
      2. 只存分钟的话，缓存放两小时，那个「还剩 2 小时」还在原地不动，
         和同一行里算出来的截止时间自相矛盾。
    精度就是原文的精度（分钟），换算误差不到 1 分钟。
    """
    if left_min is None:
        return None
    return int((time.time() if now is None else now) + left_min * 60)


def parse_work(html: str, now: float = None) -> list:
    """解析作业列表页。结构见模块注释上面的 work_truth.html。

    每条 li：
      aria-label = "标题 ; 状态"    ← 最干净的来源（标题和状态一次拿全）
      <p class="status fl">        ← 状态（和 aria-label 冗余，做交叉校验用）
      <div class="time notOver">   ← 「剩余32小时54分钟」，没有这个 div 就没有倒计时
      data="..."                   ← 详情页地址（点进去在浏览器里看）
    """
    m = re.search(r"<ul[^>]*>([\s\S]*?)</ul>", html)
    if not m:
        return []
    out = []
    for li in re.findall(r"<li[\s\S]*?</li>", m.group(1)):
        lab = re.search(r'aria-label="([^"]*)"', li)
        if not lab:
            continue
        # 🔴 rsplit 而不是 split：万一标题里带分号，状态仍然是最后一段
        parts = lab.group(1).rsplit(";", 1)
        title = parts[0].strip()
        status = parts[1].strip() if len(parts) > 1 else ""
        if not title:
            continue

        raw_left = ""
        tm = re.search(r'<div class="time ([^"]*)"[^>]*>([\s\S]*?)</div>', li)
        if tm:
            raw_left = re.sub(r"<[^>]+>", "", tm.group(2)).strip()

        href = re.search(r'data="([^"]*)"', li)
        left_min = parse_left(raw_left)
        out.append({
            "kind": "work",
            "kindName": "作业",
            "title": title,
            "status": status,
            "state": bucket(status),
            "left": raw_left,                      # 原文，给人看
            "leftMin": left_min,                   # 分钟，用来排序；None = 没有倒计时
            "startAt": None,
            "endAt": _end_from_left(left_min, now),
            "url": (href.group(1).replace("&amp;", "&") if href else ""),
        })
    return out


def bucket(status: str) -> str:
    """状态归三档。不认识的返回 'other' —— 不往任何一边凑。"""
    s = (status or "").strip()
    if s in TODO_STATES:
        return "todo"
    if s in DONE_STATES:
        return "done"
    return "other"


def kind_of(active_type) -> str:
    """activeType → 用户要的分类（work / exam / sign / topic / notice / other）。

    🔴 类型值可能是 int 也可能是 str（学习通自己返回的 JSON 不统一），
       先归一成字符串再比；认不出来就归 'other'，不往任何一类里凑。
    """
    t = str(active_type if active_type is not None else "").strip()
    if t.endswith(".0"):                       # 万一给了 5.0 这种
        t = t[:-2]
    for k, types in KIND_BUCKET.items():
        if t in types:
            return k
    return "other"


SIGNED_WORDS = ("已签",)                  # 已签到 / 已签退 都算签了
UNSIGNED_WORDS = ("未签", "缺勤")          # 未签到 / 未签退 / 缺勤


def sign_state(text: str):
    """签到的「我到底签了没」→ True / False / None。

    🔴 认不出来就返回 None，**绝不兜底成 False**。兜成「没签」等于凭空
       告诉用户「你漏签了」—— 这是会让人白跑一趟教务处的那种错。
       学习通的状态文字是会变的（老版本「未签到」、新版本可能给「缺勤」），
       所以只认这几个明确的词，其余一律 None（前端显示成状态原文）。
    """
    t = str(text or "").strip()
    if not t:
        return None
    if any(w in t for w in SIGNED_WORDS):
        return True
    if any(w in t for w in UNSIGNED_WORDS):
        return False
    return None


def _ms_to_sec(v):
    """毫秒时间戳 → 秒。空/0/非数字返回 None。

    🔴 学习通的 0 表示「没有这个时间」，不是 1970 年。当成 0 会算出一个
       五十多年前的倒计时，然后被当成「早就过期」悄悄丢掉。
    """
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return int(n // 1000) if n > 0 else None


def _abs_url(u: str) -> str:
    """补全协议。学习通给的多半是 `//mobilelearn.chaoxing.com/...`。"""
    u = (u or "").strip()
    if not u:
        return ""
    if u.startswith("//"):
        return "https:" + u
    if u.startswith(("http://", "https://")):
        return u
    return ""                                   # 相对路径 / javascript: 一律不要


def _content_stuurl(a: dict) -> str:
    """活动 JSON 的 `content` 里带的 `stuUrl`（学习通自己用的兜底地址）。

    🔴 `content` 有时是对象、有时是 JSON 字符串 —— 两种都认。模板里
       `switch(activeType)` 的 `default` 分支就是取这个字段，所以它比
       我们自己拼的路径更可信，有就用它。
    """
    c = a.get("content")
    if isinstance(c, str):
        try:
            c = json.loads(c)
        except (ValueError, TypeError):
            return ""
    if not isinstance(c, dict):
        return ""
    return _abs_url(c.get("stuUrl") or "")


def active_url(a: dict, course: dict) -> str:
    """一条活动 → 详情页地址。拼不出来就返回空串（界面就不显示小箭头）。

    路径不是猜的：从学习通自己的活动列表页模板里逐条抄的
    （`_lab/cx/ml/active_page.html` 的 `activeRowClick()`，190 KB 真实抓取）：

        case '2' / '74'   /page/sign/signIn?courseId&classId&activeId&fid
        case '50'         /page/topicDiscuss/student/stu_reply_discuss?…&cpi
        case '42'         /page/quiz/stu/answerQuestion2?…
        case '14'         /page/quiz/stu/answerQuestion?…
        case '43'         /page/qvote/stu/answerQvote?…
        case '68'         /page/interactivepractice/stu/answerQu?…
        default           content.stuUrl

    🔴 只做**上面这些参数就够**的类型。直播(17)、分组任务(35)、在线课堂(56)
       要先调别的接口拿 liveId / uuid，资源型(75/63)要把 content 解出来 ——
       这些宁可**不给链接**，也别给一个点开就报错的地址。
    """
    u = _content_stuurl(a)
    if u:
        return u
    path = ACTIVE_PAGE.get(str(a.get("activeType")).strip())
    if not path:
        return ""
    cid = str((course or {}).get("courseId") or "").strip()
    clid = str((course or {}).get("classId") or "").strip()
    fid = str((course or {}).get("schoolId") or "").strip()
    aid = str(a.get("id") or "").strip()
    if not (cid and clid and fid and aid):
        return ""                               # 缺一个参数就拼不出能用的地址
    q = "courseId=%s&classId=%s&activeId=%s&fid=%s" % (cid, clid, aid, fid)
    if path.endswith("stu_reply_discuss"):
        cpi = str((course or {}).get("cpi") or "").strip()
        if cpi:
            q += "&cpi=" + cpi
        q += "&showOnScreenShare=true"
    return CX_BASE + path + "?" + q


def parse_active(j: dict, now: float = None, course: dict = None) -> list:
    """活动列表 JSON → 条目（签到 / 主题讨论 / 通知 / 作业提醒 …）。

    字段名不是猜的，是从学习通自己的任务列表页模板里逐条抄的
    （_lab/cx/ml/active_page.html，191 KB 的真实抓取）：

        active.nameOne    标题
        active.nameTwo    状态文字（可能为空，模板里是 v-if="nameTwo"）
        active.nameFour   倒计时文字，🔴 只有 status=='1' 才渲染
        active.startTime / active.endTime   毫秒时间戳
        active.status     '1' 进行中 / '2' 已结束 / 其他 未开始
        active.activeType 活动类型，映射见 ACTIVE_KIND

    响应外层是 {result: 1, data: {activeList: [...]}}，result != 1 时
    把 errorMsg 带出去 —— 不能让它变成「这门课没有活动」。
    """
    if not isinstance(j, dict):
        return []
    if j.get("result") not in (1, "1", True):
        msg = str(j.get("errorMsg") or j.get("msg") or "").strip()
        raise CxError(msg or "活动列表返回失败", "deny")
    data = j.get("data")
    rows = data.get("activeList") if isinstance(data, dict) else None
    if not rows:
        return []

    now = time.time() if now is None else now
    out = []
    for a in rows:
        if not isinstance(a, dict):
            continue
        at = a.get("activeType")
        title = str(a.get("nameOne") or "").strip()
        if not title:
            continue                        # 没标题的条目画出来是一行空白，跳过
        st = str(a.get("status") if a.get("status") is not None else "").strip()
        name4 = str(a.get("nameFour") or "").strip()
        start = _ms_to_sec(a.get("startTime"))
        end = _ms_to_sec(a.get("endTime"))

        # 倒计时：优先用页面自己给的文字（最准），没有就从 endTime 算。
        left_min = None
        if st == "1":
            left_min = parse_left(name4)
            if left_min is None and end:
                # 🔴 **不夹 0**。学习通把「已经过点」的活动在列表里多留一阵，
                #    status 还是 1、endTime 已经过去 —— 夹成 0 就等于把它说成
                #    「还剩不到 1 分钟」，是在催一件已经办不了的事。
                #    留负数，让 sort_rank() 把它分到「已过期」那一档，
                #    前端 cxMinLeft 也返回负数、写「已截止」。
                #    （2026-10-23 南师侧也踩了同一个，两边一致。）
                left_min = int((end - now) / 60)

        if st == "1":
            state = "live"                  # 正在进行
        elif st == "2":
            state = "ended"                 # 已结束
        else:
            state = "pending"               # 未开始

        k = kind_of(at)
        # 🔴 通知的 endTime 是**活动自己的生命周期终点**，不是待办截止时间。
        #    直接拿它渲染「截止 X」，一条公告就会显示成「已截止 2025-09-30」，
        #    看着像漏了一件事。通知整块不该有时间位。
        #    （2026-10-23 南师侧实测踩到，我这边同样中招。）
        if k == "notice":
            end, left_min = None, None

        out.append({
            "kind": k,
            "kindName": ACTIVE_KIND.get(str(at).strip(), "活动"),
            "title": title,
            "status": str(a.get("nameTwo") or "").strip(),
            "state": state,
            "left": name4,
            "leftMin": left_min,
            "startAt": start,
            "endAt": end,
            # 只有签到/签退才有这个字段；别的活动一律 None。
            # True 签了 / False 没签 / None 认不出来（见 sign_state 的说明）。
            "signed": sign_state(a.get("nameTwo")) if k == "sign" else None,
            "url": active_url(a, course),
        })
    return out


def parse_exam(html: str, now: float = None) -> list:
    """解析考试列表页（exam-ans/mooc2/exam/exam-list）。

    结构不是猜的：从这一页自己的样式表里反推出来的（_lab/cx/ml/exam-list.css，
    127 个类名），和作业列表页**同构**：

        .task-list .bottomList ul li
          .tag                        图标（icon-exam / self-exam / selfTestPreview）
          .right-content
            p.overHidden2             标题
            p.status                  状态（未开始 / 进行中 / 已结束 …）
            .label                    可能是「限时 60 分钟」这类补充
          .time / .time.notOver       「剩余…」或「开始时间：…」

    🔴 有 aria-label 就用它（作业页就是这么干的，一次拿全标题+状态），
       没有就退回读 p.overHidden2 / p.status 的文字。两条路都留着 ——
       页面改版时至少还有一条能撑住，而不是静默返回 0 条。
    """
    if not html:
        return []
    out = []
    # 🔴 正则必须把 <li ...> 的**开标签**也包进来 —— aria-label 和 data
    #    两个属性都挂在开标签上，只取标签内容的话这两条路就全废了，
    #    而且不会报错，只会静默退回到读文字（标题里会带上「限时 90 分钟」）。
    for li in re.findall(r"<li[^>]*>[\s\S]*?</li>", html):
        if "right-content" not in li:
            continue                        # 筛选栏、翻页那些 li 都不是任务

        title, status = "", ""
        lab = re.search(r'aria-label="([^"]*)"', li)
        if lab:
            parts = lab.group(1).rsplit(";", 1)
            title = parts[0].strip()
            status = parts[1].strip() if len(parts) > 1 else ""
        if not title:
            m = re.search(r'<p class="[^"]*overHidden2[^"]*"[^>]*>([\s\S]*?)</p>', li)
            if m:
                title = re.sub(r"<[^>]+>", "", m.group(1)).strip()
        if not status:
            m = re.search(r'<p class="[^"]*status[^"]*"[^>]*>([\s\S]*?)</p>', li)
            if m:
                status = re.sub(r"<[^>]+>", "", m.group(1)).strip()
        if not title:
            continue

        raw_left = ""
        tm = re.search(r'<div class="time([^"]*)"[^>]*>([\s\S]*?)</div>', li)
        if tm:
            raw_left = re.sub(r"<[^>]+>", "", tm.group(2)).strip()
        elif not tm:
            # 有的页面 .time 是 <p> 或者 <span>
            tm = re.search(r'<(p|span) class="time([^"]*)"[^>]*>([\s\S]*?)</\1>', li)
            if tm:
                raw_left = re.sub(r"<[^>]+>", "", tm.group(3)).strip()

        href = re.search(r'data="([^"]*)"', li)
        done = any(s in status for s in DONE_EXAM_STATES)
        left_min = parse_left(raw_left)
        out.append({
            "kind": "exam",
            "kindName": "考试",
            "title": title,
            "status": status,
            "state": "done" if done else "todo",
            "left": raw_left,
            "leftMin": left_min,
            "startAt": None,
            "endAt": _end_from_left(left_min, now),
            "url": (href.group(1).replace("&amp;", "&") if href else ""),
        })
    return out


def is_open(item: dict) -> bool:
    """这条还值不值得摆到人面前。

    作业/考试：todo 才算（done 已经交过/考过，other 是没见过的状态 ——
    作业那边的 other 由调用方单独说明，见 scan()）。
    活动：live / pending 算，ended 不算。
    """
    return item.get("state") in ("todo", "live", "pending")


def sort_rank(item: dict, now: float = None) -> int:
    """待办列表的排序档位。越小越靠前。

        0  还能赶上的   —— 按剩余分钟升序
        1  没有截止时间 —— 垫底但不等于过期（实测真有「未交但没写截止」的作业）
        2  已经过期的   —— **绝不能排最前面**

    🔴 为什么需要这个函数：以前只按「剩余分钟」升序排，过期那条的 endAt 在过去、
       算出来是负数，负数最小 ⇒ 一年前的通知占着首屏第一行，真正要交的作业
       掉到第三屏。2026-10-23 南师侧在真机上撞到，我这边同一个毛病。
    🔴 前端 app.js 的 cxSortRank 是同一套口径，改这里必须同步改那边。
    """
    if item.get("leftMin") is None:
        return 1
    end = item.get("endAt")
    if end and end < (time.time() if now is None else now):
        return 2
    return 0


# ------------------------------------------------------------------ 会话

class Chaoxing:
    """一个学习通会话。只读。"""

    def __init__(self, cookies=None) -> None:
        self.s = requests.Session()
        self.s.trust_env = False                   # 🔴 不吃环境变量里的代理
        self.s.headers["User-Agent"] = UA
        self.user = ""
        self.lock = threading.RLock()
        if cookies:
            self.load_cookies(cookies)

    # -- cookie 存取 -------------------------------------------------

    def load_cookies(self, rows) -> None:
        for r in rows or []:
            try:
                self.s.cookies.set(
                    str(r.get("name") or ""), str(r.get("value") or ""),
                    domain=str(r.get("domain") or ".chaoxing.com"),
                    path=str(r.get("path") or "/"))
            except Exception:
                continue                            # 单条坏了不影响别的

    def dump_cookies(self) -> list:
        with self.lock:
            return [{"name": c.name, "value": c.value,
                     "domain": c.domain, "path": c.path}
                    for c in self.s.cookies]

    def has_login(self) -> bool:
        """有没有登录态。看 `.chaoxing.com` 域下的 UID —— 那才是跨站有效的那份。"""
        with self.lock:
            for c in self.s.cookies:
                if c.name in ("UID", "_uid") and c.value:
                    return True
        return False

    # -- 登录 --------------------------------------------------------

    def login(self, user: str, pwd: str) -> dict:
        """账号密码登录。🔴 失败不重试，直接抛。"""
        with self.lock:
            try:
                self.s.get(LOGIN_PAGE, timeout=15)
            except Exception as e:
                raise CxError("连不上学习通：%s" % str(e)[:60])

            data = {
                "fid": "-1",
                "uname": user,
                "password": aes_b64(pwd),
                "refer": "http%3A%2F%2Fi.mooc.chaoxing.com",
                "t": "true",                       # 🔴 只有 true 时前端才加密密码
                "forbidotherlogin": "0",
                "validate": "",                    # 首次登录不需要验证码
                "_blank": "1",
                "retainlogin": "2",
                "pcxxtpage": "0",
                "needVcode": "",
            }
            try:
                r = self.s.post(LOGIN_API, data=data, timeout=20,
                                headers={"Referer": LOGIN_PAGE,
                                         "X-Requested-With": "XMLHttpRequest"})
            except Exception as e:
                raise CxError("登录请求失败：%s" % str(e)[:60])

            try:
                j = r.json()
            except Exception:
                raise CxError("登录返回的不是 JSON，接口可能变了", "parse")

            ok = bool(j.get("status")) or str(j.get("status")).lower() == "true"
            if not ok:
                mes = str(j.get("mes") or "").strip()
                # 服务端要验证码时 needVcode 会被置 1，这时只能人工处理
                if "验证码" in mes or j.get("needVcode"):
                    raise CxError("学习通要求验证码了，得手动登录一次", "auth")
                raise CxError(mes or "账号或密码不对", "auth")

            self.user = user
            return {"ok": True, "cookies": len(self.dump_cookies())}

    # -- 课程 --------------------------------------------------------

    def courses(self) -> list:
        with self.lock:
            try:
                r = self.s.get(COURSE_API, timeout=20, headers={
                    "Referer": "https://mooc2-ans.chaoxing.com/mooc2-ans/visit/interaction"})
            except Exception as e:
                raise CxError("拿不到课程列表：%s" % str(e)[:60])
        _status_ok(r, "课程列表")
        if not r.text.strip():
            raise CxError("课程列表是空的 —— 登录态可能失效了", "auth")
        # 登录页要单独认出来，别让它掉进下面「不是 JSON」那条报假话
        if _looks_logged_out(r.text):
            raise CxError("学习通的登录态过期了，点「重新连接」再试一次", "auth")
        try:
            j = r.json()
        except Exception:
            raise CxError("课程列表不是 JSON，接口可能变了", "parse")
        rows = parse_courses(j)
        if not rows and not j.get("channelList"):
            raise CxError("课程列表结构变了（没有 channelList）", "parse")
        return rows

    # -- 单门课 ------------------------------------------------------

    def course_meta(self, c: dict) -> dict:
        """进课程页，拿 stuenc + workEnc。两个必须来自同一次加载。"""
        url = COURSE_PAGE % (c["courseId"], c["classId"], c["cpi"])
        with self.lock:
            try:
                r = self.s.get(url, timeout=25, allow_redirects=True)
            except Exception as e:
                raise CxError("进课程页失败：%s" % str(e)[:50])
        _status_ok(r, "课程页")
        stu = re.search(r"[?&]enc=([0-9a-fA-F]{32})", r.url)
        work = re.search(r'id="workEnc"[^>]*value="([0-9a-fA-F]{32})"', r.text)
        return {
            "stuenc": stu.group(1) if stu else "",
            "workEnc": work.group(1) if work else "",
            "referer": r.url,
        }

    def work_list(self, c: dict, meta: dict) -> list:
        if not meta.get("stuenc") or not meta.get("workEnc"):
            # 🔴 kind 用 "noentry" 而不是 "deny"：这两种在界面上是**完全不同**的话。
            #    deny = 被拒绝（可能账号有问题），noentry = 这门课的页面里压根没这个
            #    入口（多半已结课归档，或者老师换了新版课程页）。混成一种说法，
            #    用户就只能看到「拿不到入口」这种他没法处理的字。
            raise CxError("没给作业入口", "noentry")
        url = WORK_LIST % (c["courseId"], c["classId"], c["cpi"],
                           int(time.time() * 1000),
                           meta["stuenc"], meta["workEnc"])
        with self.lock:
            try:
                r = self.s.get(url, timeout=25, headers={"Referer": meta["referer"]})
            except Exception as e:
                raise CxError("取作业列表失败：%s" % str(e)[:50])
        _status_ok(r, "作业列表")
        if "无权限的操作" in r.text or "无效的用户" in r.text:
            raise CxError("作业列表被拒（enc 不配对或登录态失效）", "deny")
        return parse_work(r.text)

    def active_list(self, c: dict) -> list:
        """一门课的活动列表（签到 / 主题讨论 / 通知 / 作业提醒）。

        🔴 这个接口**不需要 stuenc**，所以不用先进课程页 —— 省一次请求。
           它要的是学校 id（course.schoolId），不是课程页里那个 id="fid"。
        """
        if not c.get("schoolId"):
            raise CxError("这门课没带学校 id，活动查不了", "parse")
        url = ACTIVE_LIST % (c["schoolId"], c["courseId"], c["classId"],
                             int(time.time() * 1000))
        with self.lock:
            try:
                r = self.s.get(url, timeout=20, headers={
                    "Referer": COURSE_PAGE % (c["courseId"], c["classId"], c["cpi"]),
                    "X-Requested-With": "XMLHttpRequest",
                })
            except Exception as e:
                raise CxError("取活动列表失败：%s" % str(e)[:50])
        _status_ok(r, "活动列表")
        # 没登录时会 302 到登录页，回来的是一大坨 HTML 而不是 JSON
        if not r.text.lstrip().startswith(("{", "[")):
            # 🔴 2026-10-23 改：非 JSON **不再一律判 auth**。
            #    原来只要不是 JSON 就说「登录态可能失效了」，可 `auth` 会让
            #    `scan()` 直接 break —— 于是一个维护页 / 接口改版，就能让
            #    后面所有课**一门都不查**，而用户看到的是「登录失效」。
            #    现在只有真的看到登录页特征才判 auth，其余判 parse（照常往下查）。
            head = r.text[:4000]
            if "用户登录" in head or "passport2" in head or "login" in head.lower():
                raise CxError("活动列表跳到登录页了（登录态失效）", "auth")
            raise CxError("活动列表返回的不是 JSON（接口可能变了）", "parse")
        try:
            j = r.json()
        except Exception:
            raise CxError("活动列表不是 JSON，接口可能变了", "parse")
        # 详情页地址要 courseId / classId / fid，而接口**不回**这三个
        # （它本来就是按课查的），所以把课程对象带进去自己拼。
        return parse_active(j, course=c)

    def exam_list(self, c: dict, meta: dict) -> list:
        """一门课的考试列表。需要 stuenc，所以必须在 course_meta 之后调。"""
        if not meta.get("stuenc"):
            raise CxError("没给考试入口", "noentry")
        url = EXAM_LIST % (c["courseId"], c["classId"], c["cpi"],
                           int(time.time() * 1000), meta["stuenc"])
        with self.lock:
            try:
                r = self.s.get(url, timeout=25, headers={"Referer": meta["referer"]})
            except Exception as e:
                raise CxError("取考试列表失败：%s" % str(e)[:50])
        _status_ok(r, "考试列表")
        if "参数传递不正确" in r.text:
            raise CxError("考试页说参数不对（接口拼法可能变了）", "parse")
        if "无权限的操作" in r.text or "无效的用户" in r.text:
            raise CxError("考试列表被拒（登录态失效）", "deny")
        if "用户登录" in r.text[:3000]:
            raise CxError("考试页跳到登录了（登录态失效）", "auth")
        return parse_exam(r.text)

    # -- 全量扫描 ----------------------------------------------------

    def scan(self, on_progress=None, gap: float = SCAN_GAP,
             prev_rest=None, force: bool = False,
             pre_courses=None, active_names=None) -> dict:
        """把每门课的**作业 + 考试 + 课堂活动**都读一遍。

        on_progress(已完成门数, 总门数, 当前课名, 阶段名) —— 给前端显示进度用。
        🔴 阶段名是第 4 个参数，老调用方只传 3 个也能跑（多传的那个忽略掉）。

        prev_rest
            上一轮返回的 `rest`（每门课的结课判定状态）。不传就等于「第一次扫」，
            所有课都扫。判定规则见 REST_STREAK / REST_SPAN / REST_GAP / COLD_DAY。

        force
            True = 无视「已结课」，全部重扫一遍。给用户手动点「全部重扫」用。
            🔴 判据一定会错，所以必须留一个「我不信你，全查一遍」的出口。
               没有这个出口的话，判错一次用户就只能卸载重装。

        为什么一次全查、不分模块点：
          用户要的是「按紧急度排」—— 作业和考试混在一起才谈得上谁最急。
          分模块查的话，前端就没法给出一个统一的「最急的是这个」。
          代价是每门课 4 个请求（课程页 + 作业 + 考试 + 活动），32 门课约 1 分钟。

        pre_courses
            `/api/cx/scan` 在「cookie 里没 UID」时先探一次课程列表，探到的结果
            从这里传进来，省一次请求（风控认的就是请求次数）。
            和 `web/native.js` 的 `cxScanAll(prevRest, force, preCourses)` 对齐。

        active_names
            本学期**教务课表里在修**的课名。命中白名单的课，即使被判定「已结课」
            也照扫 —— 这是 0.39.0 降频的保险丝：冷课降频靠的是「内容旧」，
            但老师完全可能这学期课还在上、只是还没在超星发东西。
            教务课表是「这门课现在真的在上」的唯一权威来源。
            🔴 传空 / 没传（没绑教务、课表没拿到）⇒ **一律不降频**，
               宁可慢。降频是个优化，不能因为它把用户的作业弄丢。
        """
        courses = (pre_courses
                   if isinstance(pre_courses, list) and pre_courses
                   else self.courses())

        # 🔴 0.39.0：按 (courseId, classId) 去重，不再只按 courseId。
        #    以前那句「不同 classId 的作业/考试/活动都是同一套」是错的 ——
        #    同一个 courseId 下面可能挂着**不同学期**的教学班，压成一个
        #    就只查了其中一个班，顺序一换本学期的作业一条都不在了。
        #    详见 unique_courses() 的注释。
        uniq = unique_courses(courses)

        items, failed = [], []
        n = len(uniq)
        now = int(time.time())
        prev_rest = prev_rest if isinstance(prev_rest, dict) else {}
        # 先整体继承上一轮的状态，再逐门覆盖扫过的课。
        # 🔴 不能只写「这次扫过的课」：中途登录态失效 break 之后，剩下的课没扫，
        #    状态要是丢了，它们好不容易攒的 streak 就白攒了 —— 等于每次从零数。
        # ⚠️ 只继承新格式的 key（带 `:`）。0.38 及以前按裸 courseId 存，
        #    那个口径本身就是错的（一个 courseId 压了多个学期的班），
        #    丢掉重攒一次比继承下来更安全。
        rest = {k: v for k, v in prev_rest.items()
                if isinstance(v, dict) and ":" in str(k)}
        paused = []          # 这次因为「已结课」而没扫的课
        white = _norm_names(active_names)
        for i, c in enumerate(uniq):
            cid, title = c["courseId"], c["title"]
            clid = c.get("classId")
            key = rest_key(cid, clid)

            # ---- 已结课的课，到点之前不扫 ----
            # 🔴 三个前提，缺一不可：
            #    ① 用户没点「全部重扫」；
            #    ② **有白名单** —— 没绑教务 / 课表没拿到时 white 是空的，
            #       这时一律不降频（宁可慢，也不能因为一个优化把作业弄丢）；
            #    ③ 这门课不在本学期教务课表里。
            st = prev_rest.get(key) or {}
            if (not force) and st.get("resting") and white \
                    and not _in_white(title, white) \
                    and now - int(st.get("lastAt") or 0) < REST_GAP:
                paused.append({"course": title, "courseId": cid,
                               "classId": clid,
                               "lastAt": int(st.get("lastAt") or 0)})
                # 进度照报。跳过的课不报进度的话，用户看着「第 5/32 门」停住不动，
                # 会以为卡死了 —— 而卡死和「跳过了 27 门」在界面上长得一模一样。
                _progress(on_progress, i, n, title, "已结课，跳过")
                continue

            mine = []            # 这门课这一轮读到的条目，用来算「最新内容时间」

            def take(rows):
                for r in rows:
                    r["course"] = title
                    r["courseId"] = cid
                    items.append(r)
                    mine.append(r)


            def note(why, part="other", code=""):
                """记一条「这门课的某一块没读到」。

                🔴 part / code 是给**界面**用的分类键，不是给人看的字：
                     part = work / exam / active / course / auth
                     code = "noentry"（页面里根本没这个入口）或 ""（别的原因）
                   界面拿它们把「20 门课各缺作业 + 各缺考试」合成一句人话。
                   把 `why` 直接甩给用户，他只会看到「拿不到入口」这种
                   既不知道是什么、也不知道该干什么的词。
                """
                failed.append({"course": title, "why": str(why)[:60],
                               "part": part, "code": str(code or "")})

            def skip_rest(why="登录态失效，没查"):
                """登录态失效要跳出循环时，把**后面没查的课**都记进 failed。

                🔴 2026-10-23 补。不记的话那些课在界面上**凭空消失** ——
                   用户看到的是「N 门课都查完了，其中几门没读到作业」，
                   实际只查了前一两门。这比「整场崩掉」更难查：
                   崩了至少知道出事了。
                   （实测见 `_lab/cx/probe_502.py`：两门课全 502 时，
                   修之前第二门课一个字都没留下。）
                """
                for rest in uniq[i + 1:]:
                    failed.append({"course": rest["title"], "why": why,
                                   "part": "auth", "code": "auth"})

            meta = None
            # 这一轮三个模块各自「读到了没有、读到几条」。
            # 🔴 只有三个都 ok 才谈得上「这门课是空的」—— 少一个都不算，
            #    因为没读到的那块可能正好装着作业。
            w_ok = e_ok = a_ok = False
            w_n = e_n = a_n = 0

            try:
                meta = self.course_meta(c)
            except CxError as e:
                if e.kind == "auth":
                    note(e, "course", e.kind)
                    skip_rest()
                    break
                note(e, "course", e.kind)

            # 三个模块各查各的：一个挂了不能连累另外两个。
            # 🔴 每个失败都要记进 failed —— 否则「没读到」会被当成「没有」。
            if meta is not None:
                try:
                    rows = self.work_list(c, meta)
                    w_n, w_ok = len(rows), True
                    take(rows)
                except CxError as e:
                    note(str(e), "work", e.kind)
                    if e.kind == "auth":
                        skip_rest()
                        break

                try:
                    rows = self.exam_list(c, meta)
                    e_n, e_ok = len(rows), True
                    take(rows)
                except CxError as e:
                    note(str(e), "exam", e.kind)
                    if e.kind == "auth":
                        skip_rest()
                        break
            else:
                # 课程页没打开 ⇒ 作业和考试也查不了（两个都要课程页里的 stuenc）。
                # 🔴 必须**分别**记下来。只写一句「进不了课程页」的话，界面上
                #    「作业」和「考试」两项就静默消失了，用户会以为这门课没有。
                #    course_meta 那条错上面已经记过，这里记的是「因此没查」的部分。
                # code=nocourse 是给界面看的：这两条和 course 那条是**同一件事**，
                # 界面上要并成一句，不能数成「17 门 + 34 门」。
                note("课程页没打开，没查", "work", "nocourse")
                note("课程页没打开，没查", "exam", "nocourse")

            # 活动列表不需要 stuenc，课程页挂了也能查
            try:
                rows = self.active_list(c)
                a_n, a_ok = len(rows), True
                take(rows)
            except CxError as e:
                note(str(e), "active", e.kind)
                if e.kind == "auth":
                    skip_rest()
                    break

            # ---- 结课判定 ----
            # 🔴 只有「课程页打开 + 作业/考试/活动三个列表全部成功返回」才算一次
            #    有效的观察。失败、noentry、课程页没打开**都不算空** —— 那是
            #    「没读到」。拿没读到当空，会把被限流的课判成结课，然后它
            #    再也不会被扫，用户永远不知道老师发了作业。
            #
            # 判定本身在 rest_next() 里，那是纯函数 —— 和 native.js 的
            # cxRestNext 逐条对拍。只改一边不报错，只是两边结论会不一样。
            #
            # newest = 这门课最新一条内容的时间。0.39.0 起它是「冷课」的证据：
            #   历史学期的课**不是空的**（上学期的作业还挂着），只按「全空」
            #   永远判不出结课，于是每次刷新都全量扫 —— 用户的原话是
            #   「每次都需要全量扫描」。改成看「最新一条有多旧」。
            #   只认 endAt / startAt，两者都没有就是 None（= 不知道多旧，不判冷）。
            if meta is not None and w_ok and e_ok and a_ok:
                newest = None
                for r in mine:
                    t = r.get("endAt") or r.get("startAt")
                    if t and (newest is None or t > newest):
                        newest = t
                nxt = rest_next(st, True, w_n + e_n + a_n == 0, now, newest)
                nxt["title"] = title
                rest[key] = nxt
            # 没读到 ⇒ rest 里已经继承了上一轮的原值，什么都不用做。

            _progress(on_progress, i, n, title, "作业 · 考试 · 课堂活动")
            if i < n - 1:
                time.sleep(gap + random.random() * SCAN_JITTER)

        # ---- 归类 ----
        # 签到单独留一份**完整**的（含已结束）。
        # 为什么不能只留正在进行的：用户问的是「我漏了哪几次」——
        # 那只有看历史才知道。只留 live 的话，「查看签到」等于什么都没查。
        # 🔴 仍然只读：这里只是把读到的排出来，不代签、不点任何按钮。
        signs = [x for x in items if x.get("kind") == "sign"]
        # 新的排前面。没有 startAt 的垫底，别当 0 —— 那会排到最后变成「最老」。
        signs.sort(key=lambda x: -(x.get("startAt") or 0))

        # 作业里状态认不出来的（比如「已互评」）不往任何一类里凑，单独说清楚。
        odd = [x for x in items if x["kind"] == "work" and x["state"] == "other"]
        odd_ids = set(id(x) for x in odd)       # 按对象身份比，别按值比（慢且会误伤）
        # 🔴 签到不进「待办」列表 —— 它在上面那张签到卡里，单独一个位置。
        #    为什么分开：签到的时效是「几分钟」，跟「还剩 3 天的作业」排在一起
        #    会被挤到下面去；而且同一条会同时出现在卡里和列表里，像重复了。
        open_items = [x for x in items if is_open(x) and id(x) not in odd_ids
                      and x.get("kind") != "sign"]

        # 🔴 三段排序，不是两段：
        #      rank 0  还能赶上的   —— 按剩余分钟升序
        #      rank 1  没有截止时间 —— 按标题（垫底 ≠ 已过期：实测真有「未交但没写截止」的）
        #      rank 2  已经过期的   —— 按标题，**绝不能排最前面**
        #    以前只有「有/没有」两段：过期那条的 endAt 在过去，算出来是负数，
        #    负数最小 ⇒ 一年前的通知排在首屏第一行，真正要交的作业掉到第三屏。
        #    （2026-10-23 南师侧实测踩到，我这边同一个毛病。）
        open_items.sort(key=lambda x: (sort_rank(x),
                                       x["leftMin"] if sort_rank(x) == 0 else 0,
                                       x.get("title") or ""))

        counts = {k: 0 for k in KIND_ORDER}
        for x in open_items:
            k = x.get("kind") or "other"
            counts[k] = counts.get(k, 0) + 1

        done_n = len([x for x in items if x.get("state") == "done"])
        ended_n = len([x for x in items if x.get("state") == "ended"])

        return {
            "ok": True,
            "at": int(time.time()),
            "courses": n,
            # 🔴 按**课**去重：一门课可能同时缺作业和考试，failed 里会记两条，
            #    但它是同一门课。以前按 failed 条数减，20 门课能算出 scanned = 12。
            "scanned": n - len(set(f["course"] for f in failed
                                   if f.get("part") == "auth")),
            "total": len(items),
            "todo": len(open_items),
            "counts": counts,
            "skipped": {"done": done_n, "ended": ended_n, "odd": len(odd)},
            "failed": failed,
            "items": open_items,
            # 每门课的结课判定状态。下一轮扫描要原样传回来（`prev_rest`），
            # 断了就每次都从零数，永远判不出结课。
            "rest": rest,
            # 这次因为「已结课」而没扫的课。空列表 ≠ 没有结课 ——
            # 也可能是这一轮全都到点了、全扫了。
            "paused": paused,
            # 全部签到（含已结束），给「签到」卡用。老前端没有这个字段也能跑。
            "signs": signs,
            # 老字段，前端 0.12 及以前在用，留着别删
            "other": len(odd),
            "otherItems": odd,
        }


# ------------------------------------------------------------------ 结果缓存

_STORE_LOCK = threading.RLock()
_LAST = {}          # {"at": ts, "data": {...}}  内存里留一份，进程内复用


def cache_get():
    with _STORE_LOCK:
        return _LAST.get("data")


def cache_set(data, at=None):
    """存一份扫描结果。

    `at` 是「这份结果是什么时候查的」。默认取现在，但**落盘恢复时必须传** ——
    否则重启以后 `cache_age()` 会报「0 秒前刚查的」，把一份三天前的作业
    说成刚扫的。那比不显示更糟：用户会照着它判断「今晚没事」。
    """
    with _STORE_LOCK:
        _LAST["at"] = int(at or time.time())
        _LAST["data"] = data


def cache_clear() -> None:
    """连缓存一起扔掉。断开账号时必须调 —— 否则别人拿到这个手机还能看到你的作业。"""
    with _STORE_LOCK:
        _LAST.clear()


def cache_age() -> int:
    """上次扫描到现在多少秒。没扫过返回 -1。"""
    with _STORE_LOCK:
        at = _LAST.get("at")
    return -1 if not at else max(0, int(time.time()) - at)
