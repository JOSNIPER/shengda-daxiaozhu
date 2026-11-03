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
