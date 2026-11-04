# -*- coding: utf-8 -*-
"""W5 双轨逐字段对拍：_js_out.json ↔ _py_out.json。
sync 契约字段逐个深比对（忽略 syncedAt/时间戳类字段与 plan/semesters 的
已知差异），任何差异都算 FAIL。"""
import json
import sys

d = 'D:/xiangmu/daxiaozhu/app/tests/'
js = json.load(open(d + '_js_out.json', encoding='utf-8-sig'))
py = json.load(open(d + '_py_out.json', encoding='utf-8-sig'))

fails = []
n_pass = 0


def deep_eq(a, b, path):
    """递归比对；dict 忽略 key 顺序，list 保序。"""
    ok = True
    if isinstance(a, dict) and isinstance(b, dict):
        ka, kb = set(a), set(b)
        for k in ka - kb:
            ok = False
            print('DIFF  %s.%s 仅JS有: %r' % (path, k, a[k]))
        for k in kb - ka:
            ok = False
            print('DIFF  %s.%s 仅PY有: %r' % (path, k, b[k]))
        for k in ka & kb:
            ok = deep_eq(a[k], b[k], '%s.%s' % (path, k)) and ok
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            print('DIFF  %s 长度 JS=%d PY=%d' % (path, len(a), len(b)))
            return False
        for i, (x, y) in enumerate(zip(a, b)):
            ok = deep_eq(x, y, '%s[%d]' % (path, i)) and ok
    else:
        if a != b:
            print('DIFF  %s JS=%r PY=%r' % (path, a, b))
            return False
    return ok


def check(name, cond):
    global n_pass
    if cond:
        n_pass += 1
        print('PASS  ' + name)
    else:
        fails.append(name)
        print('FAIL  ' + name)


# ---- 顶层字段 ----
for key in ('ok', 'profile', 'semester', 'unitCount', 'totalWeeks', 'credits', 'courseCount', 'courses'):
    check('sync.%s' % key, deep_eq(js.get(key), py.get(key), 'js.' + key)
          and js.get(key) == py.get(key))

# ---- 成绩 / 考试（semesters 里 id/name 允许实现差异？不允许，两轨都从 ctx 来）
check('sync.grades', deep_eq(js.get('grades'), py.get('grades'), 'js.grades')
      and js.get('grades') == py.get('grades'))
check('sync.exams', deep_eq(js.get('exams'), py.get('exams'), 'js.exams')
      and js.get('exams') == py.get('exams'))

# ---- plan 的 error 文案（两轨语义应一致）----
je, pe = js.get('plan', {}).get('error', ''), py.get('plan', {}).get('error', '')
check('sync.plan.error 两轨同串', je == pe)
check('sync.plan 结构键一致',
      set(js.get('plan', {})) == set(py.get('plan', {})))

# ---- 空闲教室探针 ----
jfr, pfr = js.get('free_rooms_probe', {}), py.get('free_rooms_probe', {})
# 本校空教室未适配 ⇒ 两侧都该是 {error: 同一句话}。这里只验「不能说一边成功一边失败」。
check('free_rooms_probe 两侧状态一致',
      ('error' in jfr) == ('error' in pfr))
check('free_rooms_probe 深比对', deep_eq(jfr, pfr, 'js.free_rooms_probe'))

# ---- 周数探针 ----
check('week_probe=16(JS)', js.get('week_probe') == 16)
check('week_probe=16(PY)', py.get('week_probe') == 16)

print('\n== W5 对拍: %d PASS / %d FAIL ==' % (n_pass, len(fails)))
sys.exit(0 if not fails else 1)
