# bpm

BPM 流程系统的命令行工具。用纯 HTTP 走完 4A 会话 → CAS 票据 → JWT → BPM 接口，一条命令看待办、读工单、下载附件并归档成一套交付目录。

基于逆向出来的接口，不依赖任何 SDK，不手填 cookie。

## 能干什么

```bash
node bin/bpm.mjs list                 # 看待办
node bin/bpm.mjs done                 # 看已办
node bin/bpm.mjs cat <id>             # 打印工单全部字段
node bin/bpm.mjs download <id>        # 下附件 + 出工单页 PDF，按目录骨架归位
node bin/bpm.mjs browser              # 用 Chrome 打开 4A / BPM 页面
```

`cat` / `download` 的 id 收两种：待办行里的 17 位 `taskId`，或 15 位 `procInstId`（流程实例号）。

## 安装

需要 **Node.js ≥ 20**，以及 Chrome 或 Edge（`init` 的自动探测、`download` 的 PDF、`browser` 都要用）。

```bash
git clone <this-repo> ~/.agents/skills/bpm
node ~/.agents/skills/bpm/bin/bpm.mjs init
```

`init` 会做 8 项环境检查，然后**起一个 Chrome 让你在里面登录一次 4A**，登录成功后自动从接口反查出配置并写进 `~/.agents/skills/bpm/cache/config.json`（权限 0600）。它**绝不发认证请求**，只读 cookie 与只读接口。

整个过程只有两个问题：输出根目录、判定骨架用的附件关键词。两个地址全公司统一，是内置默认值，不问；账号类 6 项都是探测出来的。

## 首次配置要填什么

一共 6 个必填项 + 2 个本地项。**默认路径下，6 个必填项全部自动探测，你只需要登录一次 4A**：

```
$ node bin/bpm.mjs init
...
正在打开 Chrome，请在弹出的窗口里登录 4A（登录成功后会自动继续）
  检测到已登录的 4A 会话
正在从接口反查配置…
  ✔ SSO resId      ✔ SSO accId       ✔ 4A 主账号 accName
  ✔ SSO clientId   ✔ SIM 手机号密文 SIM_U   ✔ 租户 TENANT
```

探测来源：`sso/pagequeryres.do`（资源与账号、`clientSofts` 筛 `webAppByChrome`+`LOCAL` 得 `ssoClientId`）、`user/findById.do`（`mobile` 即 `simU`、`tenant`、`userId` 即 `ssoAccName`）、`loading.do`（用户 id）。

<details>
<summary>没 GUI / 想手填：`init --no-browser`，各项从哪抄</summary>

| 键 | 是什么 | 从哪拿 |
|---|---|---|
| `ssoAccName` | 4A 主账号 | 你登录 4A 用的账号 |
| `ssoResId` / `ssoAccId` / `ssoClientId` | 资源 SSO 三元组 | 4A 里随便打开一个资源 → 操作 → 登录，F12 Network 找 `sso/ssoLogin.do` 的请求体，三个同名参数原样复制 |
| `simU` | 手机号密文 | 4A 登录页 F12 Network 找 `sim/simauth.do`，请求体里 `u=` 后面那串 |
| `tenant` | 租户 | 同一个请求体里的 `tt=` |

</details>

另外两个本地项：`outRoot`（`download` 的输出根目录，不填落 `~/bpm-downloads`）、`computeKeywords`（判定用哪套目录骨架的附件关键词，默认 `计算资源,弹性资源`）。

也可以不交互，直接写：

```bash
node bin/bpm.mjs init --check                     # 只检查环境，不改配置
node bin/bpm.mjs init --reset                     # 删掉 config.json，回到未配置状态
node bin/bpm.mjs init --no-browser                # 不起 Chrome，逐项手填
node bin/bpm.mjs init --set simU=<值> --set tenant=<值>
node bin/bpm.mjs init --yes                       # 把当前生效值全部落盘
```

优先级：**环境变量 > `config.json` > 打包默认值**。两个地址有内置默认值（全公司统一），账号类 6 项默认空 —— 不配就跑不动，这是有意的，仓库里不放任何真实账号或凭据。

## 会话：只查缓存和浏览器，**不会自己发 SIM 认证**

SIM 认证发太密会锁账号，所以它只能由你显式跑 `login` 触发。其余动作在会话失效时一律报错停手。

| 顺序 | 来源 | 判据 |
|---|---|---|
| 1 | `~/.agents/skills/bpm/cache/session.json` 里的 cookie | `loading.do` 返回 `success:true` |
| 2 | **本机 Chrome（默认 9222）已登录的 4A** | 从浏览器读出的 cookie 打得通 |

两级都不通就抛错，提示你跑 `login` 或先在 Chrome 里登录 4A：

```
4A 会话失效，缓存与浏览器里都没有可用会话。
  想重新认证请显式跑: bpm.mjs login   （会发一次 SIM 认证，约 20 秒）
  或者在 Chrome 里登录一次 4A，再重试本命令（不触发风控）。
```

第 2 级优先于认证：你在 Chrome 里登录过 4A，工具就直接复用那个会话，一次认证都不发。`session` 的输出会标明来源（`Chrome 9222` / `缓存`）。

JWT 另有一层缓存（`token.json`，2 小时），**`list`/`done`/`cat`/`download` 只要 JWT 没过期就连 4A 都不碰**。

真实认证之间有 60 秒硬冷却（`BPM_AUTH_COOLDOWN_MS` 可调）。

## download 的输出形态

`download` 不只下文件，会先铺一套交付目录骨架，再把东西放进对应格子。骨架两份：

| 骨架 | 一级目录 | 何时选 |
|---|---|---|
| `nil` | 6 个：订购评审纪要 / 密码表 / 产品性能承诺标准 / 安全漏扫报告 / 测试报告 / 资源录入表 | 附件名里有「计算资源」或「弹性资源」 |
| `nil-s` | 3 个：订购评审纪要 / 产品性能承诺标准 / 资源录入表 | 其余情况 |

附件与工单页 PDF 进「订购评审纪要」，空白资源录入模板进「资源录入表」。目录名从工单字段自动推（`project_name` → `gcbh` → `order_title` → 实例号），不用手填。

**幂等**：骨架用 `force:false` 合并进已有目录，只补缺、不覆盖、不产生 `*(2)*` 副本。你在目录里手放的文件会原样留着。

参数只有三个：`--downloads`（输出到 `~/Downloads`）、`--no-files`（只出 PDF）、`--no-pdf`（只下附件）。

## browser

```bash
node bin/bpm.mjs browser              # 9222 有 Chrome 就在它里面开标签页；没有就新起一个
node bin/bpm.mjs browser --new        # 强制新起一个（不打扰正在用的那个）
node bin/bpm.mjs browser --url bpm    # 只开 BPM 待办页
```

4A 页面靠 cookie 登录（先 `Network.setCookie` 写进去）；BPM 页面靠注入 `sessionStorage.currentUser`，首帧前就已是登录态，不用等 CAS 换票。开完标签页就退出，剩下交给人接手。

## 环境变量

| 变量 | 作用 |
|---|---|
| `BPM_U4A_BASE` / `BPM_BASE` | 覆盖 4A / BPM 地址 |
| `BPM_SSO_RES_ID` / `BPM_SSO_ACC_ID` / `BPM_SSO_CLIENT_ID` / `BPM_SSO_ACC_NAME` | 覆盖 SSO 三元组与账号 |
| `BPM_SIM_U` / `BPM_TENANT` | 覆盖 SIM 凭据 |
| `BPM_OUT_ROOT` | 覆盖 `download` 输出根目录 |
| `BPM_COMPUTE_KEYWORDS` | 覆盖骨架判定关键词（逗号分隔） |
| `BPM_STATE_DIR` | 状态目录（默认 `~/.agents/skills/bpm/cache`） |
| `BPM_AUTH_COOLDOWN_MS` | 认证冷却（默认 60000） |
| `BPM_CDP_PORT` | 浏览器调试端口（默认 9222） |
| `BPM_INIT_LOGIN_TIMEOUT_MS` | `init` 等你登录 4A 的时限（默认 180000） |
| `BPM_CHROME` | 浏览器可执行文件路径 |
| `BPM_TEMPLATE_DIR` | 交维骨架目录 |

## 代码结构

| 文件 | 职责 |
|---|---|
| `bin/bpm.mjs` | CLI 入口，参数解析与输出格式 |
| `lib/config.mjs` | 配置解析（`config.json` + env + 默认值），导出全部配置常量 |
| `lib/init.mjs` | `init` 动作：环境检查、交互提问、写配置 |
| `lib/session.mjs` | 会话来源（缓存/浏览器）+ 仅 login 可触发的 SIM 认证 |
| `lib/bpm.mjs` | CAS 换票 + BPM 接口封装 |
| `lib/form.mjs` | 把接口响应渲染成人读文本 |
| `lib/attach.mjs` | 认附件、清洗文件名、落盘 |
| `lib/cdp.mjs` | 极简 CDP 底座，PDF 与 browser 共用 |
| `lib/browser.mjs` | 读/写浏览器里的 4A cookie、开页面 |
| `lib/pdf.mjs` | 起无头 Chrome 打印工单页 PDF |
| `lib/layout.mjs` | 交维目录骨架：识别、定名、铺设 |
| `templates/nil/`、`templates/nil-s/` | 两套骨架，`download` 时整体拷进输出目录 |

## 注意

- 本工具操作的是具体的企业内部系统，接口细节可能随系统升级失效。仓库里只内置了全公司统一的两个系统地址，不含任何账号或凭据——首次使用必须自己跑 `init` 登录一次。
- `templates/` 下的文件是公司交付模板，随仓库分发；如需替换成自己的，改这个目录或设 `BPM_TEMPLATE_DIR`。
- `download` 会往输出目录写文件，默认根目录由 `outRoot` 决定，跑之前确认路径。

## License

MIT
