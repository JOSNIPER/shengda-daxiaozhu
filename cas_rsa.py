# -*- coding: utf-8 -*-
"""达小助 · CAS 登录密码的 RSA 加密（升达 lyuapServer 前端算法的 Python 移植）。

为什么必须有这一步
------------------
升达 CAS 的 ``POST /lyuapServer/v1/tickets`` 有两种登录方式，**密码形态不同**：

* ``loginType="3"``（微信扫码建会话）：密码是**明文**；
* ``loginType=""``（账号密码登录）：密码必须是 **RSA 加密后的十六进制串**。

本项目只做账号密码登录，所以每次都要先加密。发明文上去服务端不是报「密码错」，
而是直接回 ``data.code = CODEFALSE``（因为它先校验验证码，再校验密码），
最终表现成一句毫无帮助的「登录没成功」—— 2026-11-03 就是这么被用户发现的。

算法不是教科书 RSA
-------------------
它是那几个前端库（RSAKey + 自定义 pad）的特有做法，照搬教科书会全错：

1. 明文按字符取 ``ord``，**两个字符**拼成一个小端 16 位字
   （``word = a[2r] + (a[2r+1] << 8)``），再按 16 位一段自低位累加成一个整数；
2. 字符数不足一块时**补 0**（不是 PKCS#1 填充）；
3. ``pow(块, 65537, N)`` 后转十六进制，**左侧补齐到 4 的倍数**；
4. 多块之间用**无空格**拼接（前端 ``qs.stringify`` 发出去就是一整串 256 位 hex）。

一块能放多少字符也不是「模数字节数」：按原 JS 的算法是 ``2 * top_index`` = **126**。

正确性怎么保证
--------------
用**浏览器真实密文**做测试向量（见 ``tests/test_cas_rsa.py``）：在登录页把密码
填成 ``zzz-not-a-real-password`` 点登录，抓到的请求体里 password 字段是 256 位 hex；
本实现算出的结果与它**逐字符一致**。

公钥来源
--------
``MODULUS_HEX`` / ``EXPONENT`` 抄自学校登录页前端包
``https://cas.shengda.edu.cn/assets/js/app.<hash>.js`` 里的
``{public_exponent:"010001", modulus:"00b5ee…"}``。
2026-11-03 重新核对过：与 shengda-qk 记录的 2026-10 版本**完全相同**，未换钥。
换钥的表现会是「密码明明对却一直 CODEFALSE」—— 那时来这里更新这两个常量。
"""

from __future__ import annotations

#: RSA 模数（2048 位）。来自登录页前端 bundle 的 `modulus` 字段。
MODULUS_HEX = (
    "00b5eeb166e069920e80bebd1fea4829d3d1f3216f2aabe79b6c47a3c18dcee5"
    "fd22c2e7ac519cab59198ece036dcf289ea8201e2a0b9ded307f8fb704136eaeb"
    "670286f5ad44e691005ba9ea5af04ada5367cd724b5a26fdb5120cc95b6431604"
    "bd219c6b7d83a6f8f24b43918ea988a76f93c333aa5a20991493d4eb1117e7b1"
)

#: 公钥指数 65537（前端写的是 "010001"）
EXPONENT = 0x10001

_N = int(MODULUS_HEX, 16)


def _to_digits(hexstr: str) -> list:
    """把 hex 串按 4 位一段**从右往左**切成数字数组（低位在前）—— 照搬原 JS。"""
    digs = []
    rem = len(hexstr)
    while rem > 0:
        part = hexstr[max(rem - 4, 0):rem]
        digs.append(int(part, 16) if part else 0)
        rem -= 4
    return digs


def _top_index(digs: list) -> int:
    """最高非零段的下标（用来推算一块能放多少字符）。"""
    i = len(digs) - 1
    while i > 0 and digs[i] == 0:
        i -= 1
    return i


#: 每块的字符数：两个字符进一个小端 16 位字 = 「模数高段下标 × 2」= 126
_CHUNK = 2 * _top_index(_to_digits(MODULUS_HEX))


def block_size() -> int:
    """一次能加密多少个字符（超出会分块）。"""
    return _CHUNK


def encrypt_password(password: str, *, separator: str = "") -> str:
    """把密码加密成服务端要的十六进制串。

    ``separator`` 默认空串 —— 真实请求体里就是**一整串**（无空格）。
    保留参数是为了能复现原 JS 的 ``' '`` 连接形式，便于与前端调试输出对照。

    空密码返回空串（不加密），避免把补位字节当成密码发出去。
    """
    if not password:
        return ""
    codes = [ord(ch) for ch in password]
    # 补 0 对齐到整块（原 JS 行为；不是 PKCS#1 填充）
    while len(codes) % _CHUNK != 0:
        codes.append(0)

    parts = []
    for offset in range(0, len(codes), _CHUNK):
        block = codes[offset:offset + _CHUNK]
        acc = 0
        for r in range(len(block) // 2):
            word = block[2 * r] + (block[2 * r + 1] << 8)
            acc |= word << (16 * r)
        cipher = pow(acc, EXPONENT, _N)
        hexed = format(cipher, "x")
        if len(hexed) % 4:
            hexed = hexed.zfill(len(hexed) + (4 - len(hexed) % 4))
        parts.append(hexed)
    return separator.join(parts)


__all__ = ["EXPONENT", "MODULUS_HEX", "block_size", "encrypt_password"]
