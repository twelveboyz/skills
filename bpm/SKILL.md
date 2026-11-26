---
name: bpm
description: 查 BPM 流程系统的待办/已办工单，下载工单附件并按交维目录骨架归档、生成工单页 PDF，把交维好的交付物回填到工单（上传附件、保存表单、触发资源录入），或用 Chrome 打开已登录的 4A / BPM / 集中运维平台（osa_web）页面。用户说"看看我的待办""列出工单""有没有新流程要审批""待办多少条""把这个工单的文件下下来""交维做好了/传附件/录入""打开 BPM/4A 页面""打开集中运维平台"时用；换机器或迁移给别人时用 init 初始化环境。走纯接口，不碰浏览器登录——4A 会话优先复用本机已登录的 Chrome，没有再走 SIM 认证并落盘复用。
---

# bpm

BPM 流程系统的命令行。主干全链路纯 HTTP：4A 会话 → CAS 票据 → JWT → BPM 接口，不手填凭据。只有两处会用到浏览器：生成 PDF 时起无头 Chrome，`browser` 动作按需起可见 Chrome。

## 一条入口

```bash
node ~/.agents/skills/bpm/bin/bpm.mjs <动作> [参数]
```

| 动作 | 什么时候用 | 输出 |
|---|---|---|
| `init` | 换了一台机器、或要迁移给同事 | 8 项环境检查表；起 Chrome 让你登录一次 4A，自动探测并写入 `~/.agents/skills/bpm/cache/config.json` |
| `list` | 用户要看待办 | 每人一行：`工单号 标题 创建时间 流程名 环节名`，首行 `待办 N 条 / 共 M 条 (姓名)` |
| `done` | 用户要看已办 | 同上格式 |
| `cat <id>` | 看某个工单的内容 | 表单全部字段（分组标题 + 标签：值）、可用操作 |
| `download <id>` | 把工单附件全下下来，并出一份工单页 PDF，按交维目录骨架归位 | 骨架与目录名两行，每个文件一行 `✔ 名称 字节数`，最后一行汇总 |
| `handover <id>` | 交维做好了，把交付物传回工单、保存表单、触发录入 | **默认 dry-run**（0.7 秒）：交维目录树 + 每字段←哪些文件 + 跳过说明 + 安全验收判定；加 `--yes` 才上传（约 26 秒），每文件一行 `✔ 字段 文件名 → fileId` |
| `browser` | 用 Chrome 打开 4A / BPM / 集中运维平台页面 | 每行 `✔ 4A/BPM/osa <url>`，首行说明是复用还是新开 |
| `onboard <arg> --status` | 看某个资源需求工单的自动化纳管进度 | 批次与工单一行、`进度 0/27  验证中  9 台` 一行、每台一行三格（自动化程序 / zabbix / filebeat），失败行只带三格状态；报错原文在下面的分类段（按「能修 / 要找人 / 还没结论」分组），一格原文都没有的会单独点名，末尾合计与更新时间。**纯只读**，不触发纳管。需要 Chrome 里开着已登录的 osa_web 页面（先跑 `browser --url osa`），否则报错并提示 |
| `onboard <arg>`（不带 `--status`） | 给某个工单真的点纳管并等到出结果 | 先一行 `命中「E605」：<projectId> / 第一批  工单 202610305033060`（`命中缓存` 说明没重搜），再打上面那套进度；末行 `成功 8 台，失败 1 台`。`arg` 可以是 32 位 `projectId`，也可以是批次关键字：唯一命中直接用；**命中多个列出候选**（第一列就是 `projectId`，后面是工单名、批次名、订单号、创建时间，照着抄第一列即可）并以退出码 1 停下，不替你猜；零命中报错退出码 1。命中的关键字记进 `cache/lookup.json`，同一个关键字下次不再搜 |
| `session` | 确认当前复用谁的会话 | `复用会话: 张三 / 4f2a...（Chrome 9222）` |
| `login` | **唯一会发 SIM 认证的动作**，缓存坏了要重建时用 | `已认证: 张三 / 4f2a...` |

`--page N` / `--size N` 分页，默认 1 / 200。`--json` 输出原始响应（给下游程序吃）。

`cat` / `download` 的 id 两种都收：待办行里的 17 位 `id`（taskId），或 15 位 `procInstId`（流程实例号）。按位数猜接口，猜错自动换另一个兜底。

`download` 额外参数：`--downloads`（输出到 `~/Downloads`）、`--no-files`（只出 PDF）、`--no-pdf`（只下附件）。`manifest.json` 不落盘；要逐文件结果加 `--json`（打印到 stdout）。

**输出根目录**由 `config.json` 的 `outRoot` 决定（`init` 会问，`BPM_OUT_ROOT` 可临时覆盖）；没配就落到 `~/bpm-downloads`。**没有 `--out`**——目录名全自动。

`browser` 额外参数：`--url 4a|bpm|osa|both|all`（默认 both；all = 三个都开）、`--port N`（默认 9222）、`--new`（强制新开 Chrome）、`--profile 目录`。

`handover` 额外参数：`--dir 目录`（默认按 download 的规则推算）、`--yes`（不加只 dry-run）、`--skip-input`（保存完就停，不录资源）。

## 会话：只能查缓存和浏览器，**不会自己发 SIM 认证**

**这是本 skill 的硬约束**：SIM 认证发太密会锁账号，所以它只能由你显式跑 `login` 触发。其余动作在会话失效时一律报错停手，绝不偷偷降级。

| 顺序 | 来源 | 判据 | 命中后 |
|---|---|---|---|
| 1 | `~/.agents/skills/bpm/cache/session.json` | `loading.do` 返回 `success:true` | 直接换 JWT |
| 2 | **本机 Chrome（默认 9222）已登录的 4A** | 从浏览器读出的 cookie 打 `loading.do` 成功 | 落盘到 session.json |

两招都不通就抛错，提示你去跑 `login` 或先在 Chrome 里登录 4A：

```
4A 会话失效，缓存与浏览器里都没有可用会话。
  想重新认证请显式跑: bpm.mjs login   （会发一次 SIM 认证，约 20 秒）
  或者在 Chrome 里登录一次 4A，再重试本命令（不触发风控）。
```

`list`/`done`/`cat`/`download`/`browser`/`session` 都不会调用认证函数；代码里只有 `bin/bpm.mjs` 的 `login` 分支传来 `allowAuth: true`。这是 2026-11-24 那次连发 4 轮轮询把账号推到风控边缘之后加的硬约束。

第 2 招是**优先于认证的**：你在 Chrome 里登录过 4A，skill 就直接用那个会话，一次认证都不发。`session` 的输出会写来源：`（Chrome 9222）`/`（缓存）`。

JWT 另有一层缓存：`~/.agents/skills/bpm/cache/token.json`，有效期 2 小时（`exp` 减 5 分钟余量）。**`list`/`done`/`cat`/`download` 只要 JWT 没过期就连 4A 都不碰**。`browser`/`session`/`login` 要动 4A 会话本身，必走上面两招。

输出里带 `· 复用会话` 说明没重新认证。只有 `login` 动作强制认证。想强制换票删 `~/.agents/skills/bpm/cache/token.json`。

真实认证之间有 60 秒硬冷却（`BPM_AUTH_COOLDOWN_MS` 可调）。冷却期内前两招又都不通 → 直接报错让等，不会硬发认证。

**遇到"认证 4 次轮询仍未成功"** → 账号可能已被风控限流。停手，别重试，等几分钟再说。

## 用 Chrome 打开页面（`browser`）

```bash
bpm.mjs browser              # 9222 有 Chrome 就在它里面开 4A + BPM 两个标签页；没有就新起一个
bpm.mjs browser --new        # 强制新起一个可见 Chrome（不打扰正在用的那个）
bpm.mjs browser --url bpm    # 只开 BPM 待办页
bpm.mjs browser --url osa    # 只开集中运维平台（走 4A 换票，见下）
bpm.mjs browser --url all    # 4A + BPM + 集中运维平台 三个都开
```

两种模式：

| 模式 | 触发 | 行为 |
|---|---|---|
| 复用 | 探测端口（默认 9222）有浏览器在线 | 把 4A cookie 写进去（幂等覆盖），用 `PUT /json/new` 开标签页。**绝不关闭你的浏览器** |
| 新开 | 端口不通，或给了 `--new` | 起一个可见 Chrome（独立 profile `~/.agents/skills/bpm/cache/chrome-ui-profile`），`detached` 起来后 CLI 立刻退出，窗口留着你用 |

三个页面各自怎么拿到登录态：

- **4A**：靠 cookie。所以先把 cookie 写进浏览器（`Network.setCookie`，domain 取 `u4aBase` 的 host，`secure`）。起新 Chrome 时必须带 `--ignore-certificate-errors`，否则 4A 停在「隐私设置错误」页（`NODE_TLS_REJECT_UNAUTHORIZED=0` 只管 node 侧，不管 Chrome）。
- **BPM**：靠注入 `sessionStorage.currentUser`。开标签页时先导航到 `about:blank`，用 CDP `Page.addScriptToEvaluateOnNewDocument` 把登录态塞进 `sessionStorage`，再导航到待办页——首帧前就已是登录态，省掉 CAS 换票那条链（约 5.8 秒）。刷新不掉，能一直点下去。
- **集中运维平台（osa_web）**：只能换票，cookie 进不去。顺序是 `POST {u4aBase}/sso/ssoLogin.do` 拿 `appSsoStr`（base64 一次性登录 URL）→ 在新标签页打开它（只 set-cookie，页面停在白页）→ 再 `Page.navigate` 到 `cmdbIndex`。票据**一次性**，所以每开一次都得重新换；旧链接再点会 302 到 `cmic-auth-qd` 登录页。`accPwd` 传空串即可——金库策略 `jkStatus=1` 时服务端不校验从账号密码，只需 4A cookie。这个资源的 `resId` 与 BPM 那张票不同（`59be7654…` vs config 里的 `ssoResId`），`accId` 沿用 BPM 的也能过。四项都可用 `BPM_OSA_RES_ID` / `BPM_OSA_ACC_ID` / `BPM_OSA_ACC_NAME` / `BPM_OSA_HOST` 覆盖。

**这个子命令不等页面渲染、不验工单、不报会话名**：开完标签页就退，剩下交给人接手。

新窗口用独立 profile 是有意的：PDF 的无头 Chrome 用 `~/.agents/skills/bpm/cache/chrome-profile`，两者抢同一个 profile 会互锁。`--new` 时如果那个 profile 已被别的 Chrome 占着，Chrome 会把 URL 交给旧实例然后自己退出，端口永远不监听——脚本会快速报错让你换 `--profile`，不会静默成功。

## 交维目录骨架（`download` 的输出形态）

`download` 不只下文件，还会先把一套交维交付骨架铺好，再把东西放进对应格子。骨架两份，存在 `templates/` 下：

| 骨架 | 内容 | 何时选 |
|---|---|---|
| `nil` | 6 个一级目录：`1、订购评审纪要`／`2、密码表`（含资源密码表.xlsx）／`3、公有云产品性能官网承诺标准`／`4、安全漏扫报告`（基线检查、弱口令、漏洞扫描）／`5、测试报告`（fio/iperf/Unixbench/基础资源测试报告）／`6、资源录入表` | 附件里有「计算资源」或「弹性资源」字样的模板 |
| `nil-s` | 3 个一级目录：`1、订购评审纪要`／`2、公有云产品性能官网承诺标准`／`3、资源录入表` | 其余情况 |

**自动识别**：扫工单附件文件名（`detectSkeleton`），命中 `COMPUTE_KEYWORDS`（默认 `计算资源,弹性资源`）就用 `nil`，否则 `nil-s`。输出第二行会写明依据：`骨架 nil（命中「计算资源」：nasproxy-计算资源订购.xlsx）`。

**东西放哪**：

| 产物 | 落点 |
|---|---|
| 附件 + 工单页 PDF | `1、订购评审纪要` |
| 空白资源录入模板（改名 `资源录入模板.xlsx`） | `6、资源录入表`（nil）或 `3、资源录入表`（nil-s） |

**目录名**（`projectDirName`）按优先级取工单字段，不手工指定：`project_name` 去掉开头 `^\d{4}_` → `gcbh` → `order_title` 拆拼 → 兜底流程实例号。例：`E605_某某项目资源需求`。

**幂等**：骨架用 `fs.cpSync(..., {force:false})` 合并进已存在目录，只补缺、不覆盖、不产生 `*(2)*` 副本；`~$` 开头的 Office 锁文件一律跳过（源里没有、拷进去也不要）。你在目录里手放的文件会原样留着，所以同一工单可以反复跑。

模板缺失时报 `模板缺失: <路径>（重拷 templates/ 或设 BPM_TEMPLATE_DIR）`，退出码 1——不会自己编一个空骨架糊弄过去。

## 交维回填（`handover`）

`download` 的反向操作：把填好的交维目录传回工单、保存表单、触发资源录入。

**🔴 两步走，中间必须停下来给人核对**（脚本本身不会替你确认）：

```bash
# 第 1 步 · 核对（0.7 秒，不发一个请求）
bpm.mjs handover 20638122238035969

# 第 2 步 · 人看过输出、说"传"之后，才执行（约 26 秒）
bpm.mjs handover 20638122238035969 --yes
```

第 1 步打印三类信息，AI 必须**原文转给用户并等确认**，不许自己判断"没问题"直接跑第 2 步：

```
交维目录                          ← 目录里到底有什么，能看出是否拷错目录
  1、订购评审纪要/  9 个文件  1718764 B
  ...
  合计 6 个一级目录

待上传 5 个字段                    ← 每个字段←哪些文件，一一对应
  工程交维材料 (gcjwcl)  ←  E605_xxx.zip（整目录打包）
  ↳ 跳过 基线合规检测_E595(1)excel报告.zip：该字段只收 xls/xlsx/csv
  跳过 检查验收说明 (acceptance_file)：目录里没有 4、安全漏扫报告/漏洞、基线及弱口令扫描说明.txt

安全验收 1 → 1  （「资源录入」含「弹性计算」9 处）

dry-run：没有发任何请求。确认无误后加 --yes 执行。
```

传给用户时保留「↳ 跳过」和「跳过 …」两类行 —— 那是判断"漏传"还是"故意不收"的唯一线索。

其他参数：

```bash
bpm.mjs handover <id> --dir ./E605_xxx                  # 指定交维目录
bpm.mjs handover <id> --yes --skip-input                # 传完保存就停，不录入
```

三步串行，前一步失败整单停：

1. **上传** 交维目录里的交付物 → 拿到每个文件的 `fileId`
2. **保存** `saveFormData`（`busData` = live 表单整包 base64，只替换本命令管的 5 个字段，其余原样回传）
3. **录入** `resource/input`（`fileJson` 就是刚写进「资源订购配置表」的那个附件数组 JSON 字符串）

字段映射（`lib/handover.mjs` 的 `DEFAULT_MAP`，改这里就改行为）：

| 字段 | 中文名 | 取自交维目录 |
|---|---|---|
| `gcjwcl` | 工程交维材料 | `$dir` — 整个交维目录打成一个 zip |
| `resource_subscription_configuration_table` | 资源订购配置表 | `$entry` — `6、资源录入表`（nil-s 是 `3、`）里的 xlsx |
| `baseline_check_file` | 基线检查文件 | `4、安全漏扫报告/基线检查` |
| `vulnerability_scanning_file` | 安全漏扫文件 | `4、安全漏扫报告/漏洞扫描` |
| `acceptance_file` | 检查验收说明 | `4、安全漏扫报告/漏洞、基线及弱口令扫描说明.txt` |

**只碰这 5 个字段**。工单里别的附件字段（尤其 `resource_ordering_requirements_table` 上挂的前人需求模板）一律原样提交，不会被清掉。

**覆盖语义**：字段值整个替换成目录里当前文件的新 `fileId`。改了内容就重跑一次，不追加、不去重旧附件。

**安全验收自动判定**：读资源录入表的第一个可见工作表，命中 `弹性计算`/`计算资源`/`云主机`/`云服务器`/`ECS` 任一 → `sfsjaqys=1`，否则 `0`；xlsx 解析不了就**保留原值**并在输出里写明原因。dry-run 会把 `原值 → 新值` 连同依据打出来。

**几个必须知道的坑**：
- **扩展名白名单是后端硬边界**：`acceptMap(detail)` 从表单模板的 `<ht-file ... accept="...">` 抠出每个字段允许的扩展名，不匹配的文件自动跳过（打印 `↳ 跳过`），不会因为目录里多放了一个 zip 就整单失败。实测：`baseline_check_file` 只收 `xls/xlsx/csv`、`vulnerability_scanning_file` 只收 `pdf`、`acceptance_file` 只收 `doc/docx/txt`。
- **上传是并行的**：zip 只打一次（整目录 24M 约 900ms），5 个文件的 multipart 全部 `Promise.all` 同时发。这一步串行时要 4 分钟，并行后约 20 秒。
- 表单 key 有两层：`form.formKey` 是模板 key（E605 是 `zydgjflcbd`），`data` 的 key 是数据 key（`zydgjflcjm`）。两者可能不同，`dataKeyOf()` 负责认。
- `upload` 的 multipart 字段名固定 `file`，`Content-Type` 绝不能被手动设置（boundary 要浏览器/fetch 自己生成）。
- 响应里的 `value` 是 **JSON 字符串**，要再 `JSON.parse` 一次才是 `{ success, fileId, ... }`。
- 单文件字段（`SINGLE`：基线检查、安全漏扫、检查验收说明）目录里有多个**且都符合白名单**时直接报错停下，不静默挑一个。
- 目录里缺某个槽位不会报错，只打印「跳过」，方便分批交维。
- `resource/input` 的 `fileJson` 若为空串，后端会报 `流程缺少关键信息，审批失败，请通过移动办公支撑群联系BPM维护人员排查处理`——那是附件没渲染成正常值，不是权限问题。
- zip 是纯 Node 手写的（`zipDir`，CRC32 + `deflateRawSync`），不依赖 PowerShell 或系统 `tar`；顶层带目录名，`tar -tf` / Windows 资源管理器都能正常打开。

**别做这几件事**（每次多花 1–2 分钟）：

- ❌ 为了核对而反复跑 dry-run。跑一次，把输出给用户，等答复。dry-run 每次都重新取工单详情，跑三次就是三次网络往返。
- ❌ 先 `cat` 一遍工单再 `handover`。`handover` 的 dry-run 已经把表单字段和附件槽位都打出来了。
- ❌ 自己去 `ls` 交维目录、算文件数。dry-run 的「交维目录」段就是干这个的。
- ❌ 读 `lib/handover.mjs` / `bin/bpm.mjs` 源码去确认字段映射。字段表就在上面那张表里，`--dir` 之外没有别的开关。

## 排查顺序

1. `bpm.mjs session` — 会话通不通？看输出里的来源：`（Chrome 9222）` 说明走的浏览器复用，`（缓存）` 说明 session.json 还有效
2. `bpm.mjs list` — 数据对不对？
3. 还不对就 `--json` 看原始响应，或翻 `~/.agents/skills/bpm/cache/session.json` 看 cookie 时间

## 换账号 / 换环境

别改源码。跑 `bpm.mjs init`：它会起一个 Chrome 让你登录一次 4A，然后从接口反查出 `ssoResId`/`ssoAccId`/`ssoAccName`/`ssoClientId`/`simU`/`tenant` 六项，只剩输出根目录、骨架关键词两项要问。两个地址全公司统一，是内置默认值，不问。写进 `~/.agents/skills/bpm/cache/config.json`（0600 权限）。只想改一两项用 `--set`：

```bash
bpm.mjs init                                      # 起 Chrome → 你登录 4A → 自动探测 → 写配置
bpm.mjs init --no-browser                         # 不起 Chrome，逐项手填（无 GUI 时）
bpm.mjs init --check                              # 只检查，不写配置、不发认证
bpm.mjs init --reset                              # 删掉 config.json，回到未配置状态
bpm.mjs init --set simU=<密文> --set tenant=<租户>
bpm.mjs init --yes                                # 把当前生效值全部落盘（含默认值）
```

探测来源：`sso/pagequeryres.do`（资源/账号/`actionUrl`→`bpmBase`/`clientSofts` 筛 `webAppByChrome`+`LOCAL`→`ssoClientId`）、`user/findById.do`（`mobile`→`simU`、`tenant`、`userId`→`ssoAccName`）、`loading.do`（用户 id）。

配置优先级 **环境变量 > `config.json` > 打包默认值**。两个地址在打包默认值里（全公司统一），账号类 6 项默认空 —— 仓库里不含任何真实账号。首次使用必须跑一次 `bpm init` 把这 6 项填齐：`ssoResId`、`ssoAccId`、`ssoAccName`、`ssoClientId`、`simU`、`tenant`。没填齐时任何动作都会直接提示「还没配置：缺 …」并退出 2，不会带着空值去发请求。

| 配置项 | 含义 | 环境变量 |
|---|---|---|
| `u4aBase` | 4A 根地址（有内置默认值，公司统一） | `BPM_U4A_BASE` |
| `bpmBase` | BPM 根地址（有内置默认值，公司统一） | `BPM_BASE` |
| `ssoResId` / `ssoAccId` / `ssoClientId` | 资源 SSO 三元组 | `BPM_SSO_RES_ID` / `BPM_SSO_ACC_ID` / `BPM_SSO_CLIENT_ID` |
| `ssoAccName` | 4A 主账号 | `BPM_SSO_ACC_NAME` |
| `simU` | SIM 手机号密文 | `BPM_SIM_U` |
| `tenant` | 租户 | `BPM_TENANT` |
| `outRoot` | download 输出根目录 | `BPM_OUT_ROOT` |
| `computeKeywords` | 判定用 `nil` 骨架的附件关键词 | `BPM_COMPUTE_KEYWORDS` |

其余环境变量：`BPM_STATE_DIR`（缓存目录，也是 `config.json` 所在）、`BPM_AUTH_COOLDOWN_MS`、`BPM_CDP_PORT`（浏览器调试端口，默认 9222）、`BPM_INIT_LOGIN_TIMEOUT_MS`（`init` 等你登录 4A 的时限，默认 180000）、`BPM_CHROME`（浏览器可执行文件）、`BPM_TEMPLATE_DIR`（交维骨架目录）。

## 打包迁移

整个 `~/.agents/skills/bpm/` 目录就是完整包（约 1.2M，`templates/` 占了大部分）。运行时状态全在同目录的 `cache/` 下——`config.json`、`session.json`、`token.json`、`auth-log.json`、`lookup.json`（关键字 → 工单/批次，含 `orderNo` 与首次命中时间）、两个 Chrome profile（合计几百 MB）。`cache/` 已被 `.gitignore` 挡住，不会进仓库；迁移时也**不要**拷 `cache/`，那是每台机器各自的。

同事拿到后三步：

1. 把目录放到 `~/.agents/skills/bpm/`
2. `node ~/.agents/skills/bpm/bin/bpm.mjs init` —— 检查 Node ≥ 20、Chrome、模板、网络可达性，然后起 Chrome 让你登录一次 4A 并自动探测出全部账号类配置
3. `node ~/.agents/skills/bpm/bin/bpm.mjs list` —— 出待办就通了

**首次认证的时间点**：`init` 绝不发 SIM 认证，只做只读探测。真正的认证发生在第一次需要 4A 会话的动作（`session`/`list`），且只有前两级会话来源都不通时才会发。

## 代码结构

- `bin/bpm.mjs` — CLI 入口，参数解析与输出格式
- `lib/config.mjs` — 配置解析：`config.json` + 环境变量 + 打包默认值的优先级链（`readConfig` / `writeConfig` / `resolveConfig` / `envOverrides` / `missingKeys`），并导出全部配置常量。其它 lib 的地址、账号、路径都从这里取，不各自写字面量
- `lib/init.mjs` — `init` 动作：环境检查（`runChecks`）、起 Chrome 等登录（`openInChrome` + `waitFor4aLogin`）、接口反查配置（`deriveConfig`）、交互兜底（`lineReader` / `ask` / `confirm`）、写配置（`runInit`）
- `lib/session.mjs` — 会话来源（缓存/浏览器）+ 仅 login 可触发的 SIM 认证（`getSession` / `peekSession` / `loading`）
- `lib/bpm.mjs` — CAS 换票（`getToken` / `peekToken` / `getCasUrl` / `getOneOff` / `currentUserOf`）+ 接口封装（`getTodoList` / `getDoneList` / `getTaskDetail` / `getInstForm` / `getTaskInfo` / `getInstance` / `downloadFile` / `exportResourceOrderTemplate` / `uploadFile` / `saveFormData` / `inputResource` / `getResourceStatus` / `call` / `get`）
- `lib/form.mjs` — 把 `taskDetailBo` 的响应渲染成人读文本（`renderForm`）
- `lib/attach.mjs` — 从详情响应里认出附件数组、清洗文件名、落盘
- `lib/handover.mjs` — 交维回填：字段映射（`DEFAULT_MAP`）、按映射凑齐文件（`collectPlan`）、打 zip（`zipDir`）、读资源录入表判安全验收（`detectSafeAcceptance`）、认表单数据 key（`dataKeyOf`）
- `lib/cdp.mjs` — 极简 CDP 底座：`Cdp` 客户端、`jsonReq` / `browserWs` / `openTab`、`freePort` / `findChrome` / `poll`。PDF 与 browser 共用
- `lib/browser.mjs` — 读浏览器里的 4A cookie（`read4aCookies`）、写 cookie（`ensure4aCookies`）、开页面（`openInChrome` / `closeTab`）
- `lib/osa.mjs` — 集中运维平台：4A 换一次性票据（`osaTicket`）、用票据在已有 Chrome 里开页（`openOsa`）、`OSA` / `OSA_HOME`（可用 `BPM_OSA_*` 覆盖）
- `lib/osa-api.mjs` — 集中运维平台的纳管接口（`createOsaApi({ http })` → `searchAll` / `search` / `details` / `batchStatus` / `runOnboard`）。三格状态只在这里认（`OK_FLAG` / `PENDING` / `INSTALLING` / `cellsOf` / `failedHost` / `inFlightHost`），整台口径算在 `wholeHostVerdict`（`failed` 失败、`running` 还在装、`uncleared` 一格原文都没有）。HTTP 层是唯一注入点，测试注入假 http；本票只用只读接口，不碰 `resource/management`
- `lib/osa-cdp.mjs` — 纳管接口的 http 层实现：连 Chrome 调试端口，在已登录的 osa_web 页面里 fetch（`createCdpHttp`）。osa_web 的会话只在浏览器里，脚本侧换票换不到
- `lib/onboard.mjs` — 把纳管快照渲染成人读文本（`renderOnboard`）
- `lib/naguan-errors.mjs` — 报错分类：按 `assets/naguan-errors.json` 的规则把失败归成「能修 / 要找人 / 还没结论」（`classifyBatch` / `renderClassify`）。规则表的 `groups` 决定报告的组标题与说明，`scope` 限定只看三个 `*InstallInfo` 格；`classifyOne` 是单条原文的匹配出口
- `lib/lookup.mjs` — 把 `onboard` 的参数认成 `projectId` / 订单号 / 关键字（`kindOf`），关键字走 `searchAll` 找唯一工单并把命中记进 `cache/lookup.json`（`createLookup` → `resolve` / `render`；候选行第一列是 `projectId`，人读输出能直接照敲）
- `lib/pdf.mjs` — 起无头 Chrome，注入登录态后打开工单页打印成 PDF
- `lib/layout.mjs` — 交维目录骨架：识别 `nil`/`nil-s`（`detectSkeleton`）、定目录名（`projectDirName`）、铺骨架（`applySkeleton`）、定输出根（`outputRoot` / `OUT_ROOT` / `DOWNLOADS`）
- `templates/nil/`、`templates/nil-s/` — 两份交维骨架，`download` 时整体拷进输出目录
- `test/` — `node:test` 行为测试（`node --test`）。唯一被测的缝是注入的 HTTP 层：CLI 也走 `import { main } from bin/bpm.mjs` 再注入假 http / 假 trigger / 临时状态目录，不 mock 内部模块，不起子进程，测试里一律不出网

## 工单详情

两个接口都能取到同一份内容，只是入口不同：

| 函数 | 接口 | 参数 |
|---|---|---|
| `getTaskDetail(token, taskId)` | `GET /bpmrunService/runtime/task/v1/taskDetailBo?taskId=<id>&reqParams=` | 待办行的 17 位 `id` |
| `getInstForm(token, instId)` | `GET /bpmrunService/runtime/instance/v1/getInstFormAndBO?proInstId=<id>` | 15 位 `procInstId` |

响应结构：`{ result, form:{formHtml,name,...}, data:{<表单key>:{字段:值}}, permission, buttons }`。

**坑**：`taskDetailBo` 的 URL 带 `&reqParams=`，少了这个空参数会 404 或挂起；字段值全在 `data.<表单key>` 下，`form.formHtml` 只是模板（Vue 模板字符串，含 `v-model="data.xxx.yyy"` 绑定），要按模板里的绑定把 `data` 的值填回去才看得懂哪个值对应哪个中文标签。`lib/form.mjs` 干的就是这件事。

新增动作：在 `lib/bpm.mjs` 里加一个 `call(token, path, body)`（POST）或 `get(token, path)`（GET）的薄封装，再在 `bin/bpm.mjs` 的 `ACTIONS` 里挂上。接口的 header 要求（`Authorization: Bearer` 前缀必须有、`bpm-nonceId` 必须每次新生成）已经封在这两个函数里，别绕过它们手写 fetch。

## 附件与 PDF

`download` 干两件事：下附件、出 PDF。

**附件下载**（`downloadFile`）：

```
GET /portalService/system/file/v1/download?fileId=<id>&proInstId=<流程实例号>
    Authorization: Bearer <JWT>
```

**`proInstId` 是权限校验的关键**，缺了稳定 500 `{"status":403,"message":"无权限访问"}`；不带 Bearer 是 401。不需要 `bpm-nonceId`，不需要 4A cookie，不需要浏览器。

**怎么认附件**：遍历 `detail.data.<表单key>.<字段>`，值是字符串且 `JSON.parse` 后是数组、每项都有 `id` 和 `name` → 就是附件。表单里还有别的数组（如 `business_list` 的 `financialId/financialName`），不符合这条的会被排除。

**第 7 个「资源订购配置表模板.xlsx」不是上传附件**，是空白模板：`form.formHtml` 里有 `fireWallStrategyPreview('downLoadResourceOrderConfiguration')` 按钮时才下，走

```
POST /bpmrunService/runtime/easyCmdb/v1/resource/input/exportTemplate
     Content-Type: application/json;charset=UTF-8
     {"orderNo":"<流程实例号>","orderTitle":"<data.<表单key>.order_title>"}
```

服务端回的 `Content-Disposition` 文件名是「资源录入模板.xlsx」，落盘按页面按钮的标签叫「资源订购配置表模板.xlsx」。那个按钮在页面上通常因权限不渲染，**别指望点它**，直接打接口。

**PDF**（`renderTicketPdf`）：服务端没有 PDF 导出接口，只能浏览器侧生成。流程是起无头 Chrome（`--headless=new`）→ 注入登录态 → 打开 `/front/task/<taskId>?procDefKey=…&nodeId=…` → 改成打印版式 → `Page.printToPDF`。

- **版式对齐人手工 Ctrl+P 的结果**：A4 横向（`landscape: true`, 11.69×8.27 英寸）、`scale 0.84`、页边距 `top .47 / bottom .4 / left .31 / right .31` 英寸、`displayHeaderFooter: true`
  - 页眉：左上 `日期 时间`（用 Chrome 的 `.date` 占位符）、正中「集中流程管理系统」
  - 页脚：左下完整页面 URL（`.url`）、右下 `页码/总页数`（`.pageNumber`/`.totalPages`）
- **进页面后注入一份打印样式**（`EXPAND`）去掉只有屏幕才该有的东西：站点顶栏 `.el-header`、左侧 `.el-aside`、右上「打印/流程图/复制工单号和标题」工具条 `.top-btns-col`、客服浮标 `.chat-icon`、加载动画 `.peg`/`.spinner`/`.el-loading-*`；同时把 `html/body/.el-container/.base-main` 的高度与溢出解锁，否则只截一屏
- **必须保留**：标题 `h3`（两行折行）、右上「工单号」、斜向水印（`position:fixed` 的 base64 背景图）、表单表格、批准操作区、审批记录表
- **页面地址用 `/front/task/<taskId>?procDefKey=&nodeId=`，不是 `/front/inst/<instId>`**：前者才和模板的标题栏、页脚 URL 完全一致；`taskId`/`procDefKey`/`nodeId` 从 `getTaskInfo` 的 `bpmTask` 取。只有拿不到这三个参数时才退回 `/front/inst/<instId>`
- **登录态直接注入 `sessionStorage.currentUser`**（`Page.addScriptToEvaluateOnNewDocument`），不走 CAS——省 4.3 秒。值必须是 `authLogin` 响应的原样结构（`username`/`account`/`userId`/`mobile`/`email` 都是 base64，塞明文会被路由守卫踢去登录页）
- **Chrome 用一次性 profile**：每次渲染在 `%TEMP%` 下建 `dsh-bpm-pdf-<时间戳>`，跑完就删。比常驻 profile 慢约 2.4 秒（冷缓存），但不会在磁盘上攒几百 MB，也没有「上次的 Chrome 还锁着」的问题
- 依赖本机 Chrome / Edge；`BPM_CHROME` 可指定可执行文件路径
- 渲染失败要整轮重试：服务端偶发 502 兜底页，判据是 `document.body.innerText` 里既没有 `An error occurred`，又含「审批内容」、字数 > 800、表格数 ≥ 3（门槛放低是为了兼容字段少的流程）

**耗时**：热态一张工单约 9 秒（附件与 PDF 并发跑；PDF 那半边因每次冷 profile 多约 3.5 秒）。冷态（JWT 过期）多 6 秒换票。
