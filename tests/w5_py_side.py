# -*- coding: utf-8 -*-
"""W5 对拍 · Python 轨一侧：按 bridge.Service.sync 契约组装输出 JSON。

用法： python w5_py_side.py <port>      输出：stdout 一段 JSON
mock_server.py 需已在该端口起着。
"""
import json
import sys
import time

sys.path.insert(0, r'D:\xiangmu\daxiaozhu\app')
import requests
import kingo
from kingo import KingoClient

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18091

CFG = {
    "cas": {"base": "http://127.0.0.1:%d/lyuapServer" % PORT,
            "portal": "http://127.0.0.1:%d/" % PORT,
            "tickets_path": "/v1/tickets", "kaptcha_path": "/kaptcha"},
    "jw": {"base": "http://127.0.0.1:%d" % PORT,
           "cas_service": "http://127.0.0.1:%d/caslogin" % PORT,
           "menu_context_path": "/frame/normalusemenu/getBreadcrumbsInfoNew.action",
           "data_table_path": "/taglib/DataTable.jsp",
           "time_range_path": "/jw/common/getWsxkTimeRange.action",
           "score_stat_path": "/jw/common/getSelectLessonScoreKcsInfo.action",
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
    "column_map": {},
    "timetable": {"unit_count": 12, "parse_slots": True},
    "semester": {}, "free_room": {"max_periods": None},
    "chaoxing": {}, "update": {},
}


def main():
    c = KingoClient(config=CFG, session=requests.Session())
    # 学校 CAS 第一次登录就要验证码 —— 先取一张，答案从 mock 的测试专用端点拿。
    cap = c.captcha()
    ans = c.s.get("http://127.0.0.1:%d/mock/kaptcha-answer" % PORT,
                  params={"uid": cap["uid"]}, timeout=5).json().get("answer", "")
    c.login("2024010101", "mock-pass", code=ans, uid=cap["uid"])
    profile = c.profile()
    tt = c.timetable()
    try:
        gr = c.grades()
    except Exception as e:
        gr = {"summary": [], "overall": None, "courses": [], "error": str(e)}
    try:
        ex = c.exams()
    except Exception as e:
        ex = {"exams": [], "published": False, "error": str(e)}
    try:
        ex["semesters"] = c.semesters()
    except Exception as e:
        ex["semesters"] = []
        ex["semestersError"] = str(e)
    pl = c.plan()
    out = {
        "ok": True,
        "profile": profile,
        "semester": tt["semester"],
        "unitCount": tt["unitCount"],
        "totalWeeks": tt["totalWeeks"],
        "courses": tt["courses"],
        "grades": gr,
        "exams": ex,
        "plan": pl,
        # 与 JS 轨共用的对照点：空闲教室与学期上下文
        "free_rooms_probe": (lambda: (lambda r: {k: r[k] for k in
            ("rooms", "notice", "raw", "dateBegin", "periodBegin", "truncated")})(
            c.free_rooms(date_begin="2026-11-05", date_end="2026-11-05",
                         period_begin=1, period_end=2)))() if True else None,
        "week_probe": c.total_weeks(),
    }
    print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
