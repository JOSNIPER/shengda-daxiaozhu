# 达小助

面向**郑州升达经贸管理学院**的校园 App：课表和成绩，同步一次之后离线可看。

教务系统是青果（KINGOSOFT），走 CAS 单点登录。这不是学校官方客户端，只是把本来要一次次打开教务网页才能看到的东西，收进一个手机上顺手的地方。

当前版本 **0.1.11**（code 71）。两种形态共用同一套界面代码：

| 形态 | 怎么用 | 谁去连教务 |
| --- | --- | --- |
| 网页版 | 电脑跑 `bridge.py`，手机浏览器打开同一 Wi-Fi 下的地址 | 电脑上的 Python 服务 |
| APK | 装到手机上直接打开，不需要电脑 | App 原生 HTTP 层 |

> 安装包在 [Releases](https://github.com/JOSNIPER/shengda-daxiaozhu/releases/latest) 上，也可以按下面的步骤自行构建。
> 这一版仍是 debug 构建，尚未在校内真机上完整验证。

---

## 能做什么

### 课表

- **周视图 / 日视图**，5 天或 7 天切换，带半天分隔线；左右滑动翻周。
- **每次打开都回到今天所在的那一周**（0.1.11）。会话内翻到第几周都照常保留，但关掉重开不会再停在上次的旧周次。
- 点顶部周次打开**校历 / 跳周**弹层；「学期设置」里改开学日期，周次自己重算。
- 课程详情弹层：上课时间、地点、教师、周次、学分。
- 两套课程块配色（官网色 / 淡彩）、深色模式、暖白底大圆角；支持 `corner-shape: squircle` 的浏览器会用连续圆角。

### 成绩

- **按学期查看**成绩，顶部汇总已修学分 / 总学分（取自教务课表页头部）。
- 没同步到成绩时明确写「还没有成绩」，不留一片空白。

### 功能

- 校园公告列表（网页版）。
- 校园服务入口：升达侧尚未接入，界面直接说明「校园服务尚未接入」，不会假装能用。

### 我的

- 绑定 / 解绑教务处账号；登录态过期时单独走重新认证，不用重新填一遍全部信息。
- 学籍信息：姓名、班级、专业、学院；学号打码显示。
- 账号管理、清缓存、界面设置。
- 「检查更新」在这里只是一张说明卡：给出项目仓库与个人网页地址，点一下直接跳到 GitHub Releases 看最新版。**不提供应用内在线更新，也不会在后台检查或下载**。

### 数据与隐私

- 学号密码只存在本机：Windows 上是 DPAPI，APK 上是 Android Keystore（AES-256-GCM）。
- 本地接口只回答「绑的是哪个学号」，**不回明文密码**，前端也没有「显示密码」这个能力。
- 所有请求从本机服务或 App 原生层直连学校系统，**不经任何第三方服务器**。
- 同步结果缓存在本地，断网也能看已同步过的课表和成绩。

---

## 跑起来

### 网页版

依赖 Python 3，以及 `requests`、`pycryptodome`、`qrcode`（二维码可选，加 `--no-qr` 可关）：

```bash
pip install requests pycryptodome qrcode
python bridge.py --port 8788
```

启动后终端会打印电脑和手机各自该打开的地址，并画一个二维码。手机和电脑要连同一个 Wi-Fi；校园网开了「客户端隔离」时，用电脑开热点给手机连最省事。

`python bridge.py --mock` 走离线 mock，不碰校园网，用来跑通界面；`python bridge.py --help` 看全部参数。

### APK

不用 Gradle，走 Android 官方命令行：`aapt2 → javac → d8 → zipalign → apksigner`。需要 JDK 17、Android SDK build-tools 34、`android-14/android.jar`，以及你自己的签名 keystore（keystore 已被 `.gitignore` 排除，丢了只能卸载重装，千万别提交进仓库）。最低支持 minSdk 23。

```bash
python android/build_apk.py --clean
```

产物在 `android/dist/daxiaozhu-0.1.11.apk`，同时会重写 `version.json` 里的体积与 sha256。改版本号要同时改 `version.json`、`android/build_apk.py`、`web/app.js`、`MainActivity.java` 四处，脚本有一致性校验，对不上会拒绝出包。

### 测试

```bash
python tests/test_w2_kingo.py      # 登录链路（离线 mock）
node tests/parse_check.js          # 课表解析
# W5 对拍：分别跑 w5_py_side.py / w5_js_side.js，再用 w5_parity_compare.py 比对两侧输出
```

---

## 项目结构

```
├─ web/            界面：原生 HTML / CSS / JS，无框架无构建，WebView 直接加载
│  ├─ app.js       页面逻辑
│  ├─ app.css      样式（含深色与课程块配色）
│  └─ native.js    APK 侧的原生能力适配层
├─ bridge.py       网页版本地服务（http.server + 路由）
├─ kingo.py        青果教务取数
├─ config/         升达端点 / 离线 mock 端点
├─ android/        APK 壳：Java + 资源 + 命令行打包脚本
├─ site/           发布页模板（占位符由构建脚本替换）
├─ tests/          回归测试与 Python / JS 对拍
└─ docs/           历史设计记录
```

技术栈：Python 3 标准库 + requests（后端）、原生 HTML / CSS / JS（前端）、Java（Android WebView 与 HTTP 桥）。没有前端构建步骤，改完 CSS / JS 刷新即可看到。

---

## 当前限制

- 校内真实课表 / 成绩的 `tableId`、`menucode`、列名**仍待抓包确认**；解析不出来的部分会按原始行展示，不编造数据。
- **考试安排与空闲教室明确不做**：`config/shengda.json` 里两项都是 `unsupported`；考试接口固定返回「考试安排还没适配本校系统」，空闲教室的 `menucode` 未配置。仓库里仍有上游遗留的对应代码和路由，不代表升达已接入。
- 智慧门户、一卡通、办事应用，以及 APK 侧的校园公告**未适配**，接口固定返回「未适配本校系统」，并且不会把账号密码发往任何第三方。
- 直饮水整块删除（升达不用该平台）。
- 仓库里的 `eams.py` / `portal.py` / `notice.py` / `chaoxing.py` 是上游时期留下的模块，其中的端点指向另一所学校，**不代表升达已接入**。
- 自更新入口仍保持禁用；0.1.11 的安装包已发布到 [Releases](https://github.com/JOSNIPER/shengda-daxiaozhu/releases/tag/v0.1.11)，`version.json` 里的下载地址已生效。

---

## 参与

欢迎提 issue / PR。抓包资料、账号、Cookie、真实学号这类信息请勿提交进仓库。

## 许可与参考来源

- 本项目采用 [MIT](LICENSE) 许可；LICENSE 中保留了原作者的版权声明。
- 基于**航院通**（Hobson，MIT，<https://cnb.cool/Hobson2233/hangyuantong>）改造而来，界面骨架、取数层思路与早期设计记录源自该项目。
- 界面暖白配色、连续圆角与 Android 主题图标的实现参考了 **FlClash** 官网及其 `prism_ui`。
- 上游 2887 行设计记录完整归档在 [`docs/legacy-README.md`](docs/legacy-README.md)；其中的抓包结论、端点与 cookie 域名表属于郑航时期资料，仅作方法参考，不是升达的事实。
- 第三方库：[requests](https://github.com/psf/requests)、[PyCryptodome](https://github.com/Legrandin/pycryptodome)、[qrcode](https://github.com/lincolnloop/python-qrcode)。
- 教务系统为青果 KINGOSOFT，认证走 CAS 单点登录；本项目与学校无隶属关系，使用请遵守学校相关规定，风险由使用者自行承担。
