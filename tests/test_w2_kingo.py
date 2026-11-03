# -*- coding: utf-8 -*-
"""W2 端到端测试：kingo.py ↔ mock_server.py（离线，不碰校园网）。

覆盖：
  T1 登录拿 TGT → 🔴 CASTGC 必须是自己种的（mock 故意不 Set-Cookie）
  T2 换票纯文本 ST → caslogin → 菜单上下文 → 预热 全链路
  T3 课表/成绩/考试/学籍 四组 DataTable：GBK 解码、head_/trN_ 行内 id 定列
  T4 totalWeeks=24 且**不等于**末课周次(18) —— 反"末课反推"回归测试
  T5 会话负例：新建裸客户端直接打业务页 → mock 回 1098 错误页 → 报"登录态过期"
  T6 频控负例：连打 >6 次 → 识别为"请求太频繁"**而不是**"会话过期"
  T7 写端点护栏：saveElectiveCourse 等 URL 一律拒绝发出
  T8 未登录/配置缺失：报可操作错误，不编数据
"""
import subprocess
import sys
import time

sys.path.insert(0, r"D:\xiangmu\daxiaozhu\app")
sys.path.insert(0, r"D:\xiangmu\daxiaozhu\离线mock_ui跑通")

import requests
import kingo
from kingo import KingoClient, EamsError

PORT = 18090
MOCK = r"D:\xiangmu\daxiaozhu\离线mock_ui跑通\mock_server.py"

CFG = {
    "cas": {"base": "http://127.0.0.1:%d/lyuapServer" % PORT,
            "portal": "http://127.0.0.1:%d/" % PORT,
            "tickets_path": "/v1/tickets", "kaptcha_path": "/kaptcha"},
    "jw": {"base": "http://127.0.0.1:%d" % PORT,
           "cas_service": "http://127.0.0.1:%d/caslogin" % PORT,
           "menu_context_path": "/frame/normalusemenu/getBreadcrumbsInfoNew.action",
           "data_table_path": "/taglib/DataTable.jsp",
           "time_range_path": "/jw/common/getWsxkTimeRange.action",
           "home_path": "/frame/homes.html",
           "droplist_path": "/frame/droplist/getDropLists.action",
           "verify_tls": True, "polite_delay_sec": 0.0},
    "pages": {
        "timetable": {"tableId": "9001", "menucode": "M9001", "preheat_path": ""},
        "score": {"tableId": "9002", "menucode": "M9002", "preheat_path": ""},
        "exam": {"tableId": "9003", "menucode": "M9003", "preheat_path": ""},
        "free_room": {"tableId": "9004", "menucode": "M9004", "preheat_path": ""},
        "profile": {"tableId": "9005", "menucode": "M9005", "preheat_path": ""},
    },
    "column_map": {"timetable": {"zc": "weeks_text", "kcm": "name", "skjs": "teacher",
                                 "cdmc": "room", "skxq": "day", "skjc": "periods"},
                   "profile": {}},
    "semester": {}, "free_room": {"max_periods": None}, "chaoxing": {}, "update": {},
    "timetable": {"unit_count": 12},
}

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS  %s" % name)
    else:
        FAIL += 1
        print("  FAIL  %s  %s" % (name, detail))


def main():
    srv = subprocess.Popen([sys.executable, MOCK, str(PORT)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    try:
        run_tests()
    finally:
        srv.terminate()
    print("\n== W2 E2E: %d PASS / %d FAIL ==" % (PASS, FAIL))
    return 0 if FAIL == 0 else 1


def run_tests():
    # ---- T1/T2 登录 + CASTGC 手种 + 会话全链路 ----
    c = KingoClient(config=CFG, session=requests.Session())
    c.login("2024010101", "mock-pass")
    check("T1 登录后 CASTGC 由客户端手动种上(mock 不发 Set-Cookie)",
          "CASTGC" in c.s.cookies.get_dict(), c.s.cookies.get_dict())
    c.ensure_session()
    jars = c.s.cookies.get_dict()
    check("T2 换票→caslogin 拿到 JSESSIONID", "JSESSIONID" in jars, jars)

    # ---- T3 四组表格 ----
    tt = c.timetable()
    check("T3a 课表 4 行", len(tt["courses"]) == 4, len(tt["courses"]))
    r0 = tt["courses"][0]
    check("T3b 行内 id 定列(课程名列名映射)", r0.get("name") == "高等数学(上)", r0)
    check("T3c 中文列名未登记的保留原名", "课程号" not in r0 and "kch" in r0, r0)
    gr = c.grades()
    check("T3d 成绩 3 行", len(gr["courses"]) == 3, gr)
    ex = c.exams()
    check("T3e 考试 2 行 published=True",
          len(ex["exams"]) == 2 and ex["published"], ex)
    pf = c.profile()
    check("T3f 学籍中文键映射(_PROFILE_KEYS)",
          pf.get("studentId") == "2024010101" and pf.get("major") == "计算机科学与技术", pf)

    # ---- T4 周数 ----
    check("T4 totalWeeks=24 而非末课 18", tt["totalWeeks"] == 24, tt["totalWeeks"])

    # ---- T5 会话负例 ----
    c2 = KingoClient(config=CFG, session=requests.Session())
    c2._logged_in = True  # 假装登录过但没有 CASTGC/菜单上下文
    try:
        c2.timetable()
        ok5 = False
        err = None
    except EamsError as e:
        err = e
        ok5 = "tableId 还没配置" not in str(e)  # 走到了请求并被错误页拦
    check("T5 裸会话打业务页 → 报会话类错误",
          ok5 and getattr(err, "kind", "") == "auth", str(err))

    # ---- T6 频控 vs 会话失效 ----
    c3 = KingoClient(config=CFG, session=requests.Session())
    c3.login("2024010101", "mock-pass")
    c3.ensure_session()
    hit = ""
    try:
        for _ in range(12):          # polite_delay=0，快速连打
            c3._fetch_table("score")
    except EamsError as e:
        hit = str(e)
    check("T6 连打超限识别为『请求太频繁』而非『重新登录』",
          "频繁" in hit, hit)

    # ---- T7 写端点护栏 ----
    blocked = False
    try:
        c3._request("POST", c3._jw_url("/jw/common/saveElectiveCourse.action"), data={})
    except EamsError as e:
        blocked = "只读" in str(e)
    try:
        c3._request("GET", c3._jw_url("/frame/homepage?method=getTempDeskey"))
    except EamsError:
        pass
    check("T7 写端点 URL 一律拒绝发出", blocked)

    # ---- T8 配置缺失行为 ----
    cfg8 = json_copy(CFG)
    cfg8["pages"]["timetable"]["tableId"] = "TBD_X"
    c8 = KingoClient(config=cfg8, session=requests.Session())
    try:
        c8.timetable()
        msg8 = ""
    except EamsError as e:
        msg8 = str(e)
    check("T8 tableId 未配置 → 报可操作错误而非编数据",
          "还没配置" in msg8, msg8)


def json_copy(d):
    import copy
    return copy.deepcopy(d)


if __name__ == "__main__":
    sys.exit(main())
