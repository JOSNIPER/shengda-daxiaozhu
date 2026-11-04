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
           "home_path": "/frame/homes.action",
           "menu_context_path": "/frame/normalusemenu/getBreadcrumbsInfoNew.action",
           "droplist_path": "/frame/droplist/getDropLists.action",
           "term_path": "/jw/common/showYearTerm.action",
           "data_table_path": "/taglib/DataTable.jsp",
           "verify_tls": True, "polite_delay_sec": 0.0},
    "pages": {
        "timetable": {"kind": "kbt", "path": "/student/wsxk.xskcb10319.jsp",
                      "menucode": "S20301",
                      "params_b64": "xn={xn}&xq={xq}&xh={xh}"},
        "score": {"kind": "stuckcj", "path": "/student/xscj.stuckcj.jsp",
                  "data_path": "/student/xscj.stuckcj_data.jsp",
                  "menucode": "S40303",
                  "body": {"sjxz": "sjxz1", "ysyx": "yxcj", "zx": "1", "fx": "1",
                           "wz": "0", "btnExport": "导出", "ysyxS": "on",
                           "sjxzS": "on", "zxC": "on", "fxC": "on", "xsjd": "1"}},
        "exam": {"kind": "unsupported"},
        "free_room": {"kind": "unsupported"},
        "profile": {"kind": "from_kbt"},
    },
    "column_map": {},
    "timetable": {"unit_count": None},
    "semester": {"total_weeks": None}, "free_room": {"max_periods": None},
    "chaoxing": {}, "update": {},
}


def free_rooms_probe(c):
    try:
        r = c.free_rooms(date_begin="2026-11-05", date_end="2026-11-05",
                         period_begin=1, period_end=2)
        return {k: r.get(k) for k in
                ("rooms", "notice", "raw", "dateBegin", "periodBegin", "truncated")}
    except Exception as e:                      # noqa: BLE001
        return {"error": str(e)}


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
        # 🔴 0.1.10：课表页头部的总学分 / 门数也进对拍 ——
        #    新加的契约字段不参与对拍的话，改坏了没人知道。
        "credits": tt.get("credits", ""),
        "courseCount": tt.get("courseCount", 0),
        "courses": tt["courses"],
        "grades": gr,
        "exams": ex,
        "plan": pl,
        # 与 JS 轨共用的对照点：空闲教室与学期上下文。
        # 本校空教室未适配，两轨都应当返回 {error: ...} —— 对拍比的是「同不同」。
        "free_rooms_probe": free_rooms_probe(c),
        # 有效周数在 timetable 里（config 没写死就用课表实测最大值）
        "week_probe": tt["totalWeeks"],
    }
    print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
