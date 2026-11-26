---
name: net-capture
description: 抓浏览器接口。用户说"监听/开始抓接口/start"就在后台起一个脱离会话的 CDP 记录器，一直抓 XHR 与 Fetch（含中途新开的标签页），并落成 JSONL 与 Markdown 两份；用户说"停/stop"就终止并把抓到的接口出成报告。摸接口、看请求体、查某个接口调了几次、要一份接口清单时用。不抓静态资源，不做重放。
---

# net-capture

后台接口抓包。一次抓取 = 一份输出目录，目录里的两份产物：`net.jsonl`（证据源）与 `report.md`（给人读、给 AI 引用的视图）。

## 一条入口

```bash
node ~/.dsh/skills/net-capture/bin/capture.mjs <动作> --out <目录>
```

`--out` 省略时用 `<当前工作目录>/.capture/`。**所有动作都要带同一个 `--out`**，否则 start 写 A 目录、stop 去 B 目录找进程，会判成"未在运行"。

**参数一律空格分隔**：`--out D:/cap`。`--out=D:/cap`、`--host=x.com` 这类带等号的写法不受支持——`parseArgs` 只认 `--out` 与 `--fresh` 两个位置参数，`--host / --path / --method / --status / --tab` 走 `flagValue` 直读 argv；等号写法下它们会静默取不到值，`--out=` 更会静默回落到 `<cwd>/.capture/`。

| 动作 | 什么时候用 | 输出 | 退出码 |
|---|---|---|---|
| `start [--fresh] [--port N]` | 用户说监听、开始抓 | 一行 JSON：`{ok, pid, startedAt, out}` | 0 成功；1 已在运行 / 找不到浏览器端口 / recorder 没起来 |
| `stop` | 用户说停 | 多行摘要：pid、条数、分主机、去重接口数、`report.md` 路径 | 0 成功（未在运行也算成功）；1 未能终止 |
| `status` | 每轮确认一次"在抓吗、抓了多少"，别读 JSONL | 一行：`running: true pid: N records: N targets: N`；未运行只有 `running: false` | 恒为 0 |
| `report` | 抓取中要一份当前快照 | `report.md` 路径 | 0 成功；1 没有数据或写失败 |
| `log` | 精查某几个接口 | 每条一行：`时间 方法 主机路径?查询 状态 耗时ms tab:标签页`，末行 `共 N 条` | 0 有或无匹配；2 没给任何过滤条件 |

`--fresh` 只对 `start` 有效，清空旧的 `net.jsonl` 重来；不加就在已有数据上追加。

## 动作判定

用户的话落到哪个动作：

- "监听"、"开始抓"、"抓一下这个页面"、"帮我看看它调了什么接口" → `start`
- "停了"、"别抓了" → `stop`
- "抓多少了"、"还在跑吗" → `status`
- "出个报告"、"整理成文档" → `report`
- 想知道某个接口的详情 → 先 `log` 窄取，再读 `report.md` 里对应小节

start 之后立刻回一句"已开始，输出在 `<out>`"，然后**继续干用户交待的别的事**。抓取在后台，不阻塞对话。

## 读法：先窄后宽

按费用从低到高，够用就停：

1. `status` — 一行，确认跑没跑、多少条。
2. `report.md` — 整份接口清单，按主机分组，每个去重接口（同方法 + 同主机 + 同路径）一个小节：调用次数、最近状态与耗时、响应结构骨架、请求体样本。
3. `log --host --path --method --status --tab` — 从 `net.jsonl` 里窄取几行。`--path` 是精确匹配，`/v1/users` 不会命中 `/v1/users/detail`。
4. 直接读 `net.jsonl` — 只在需要某个字段原件时用（`log` 不输出请求头、响应头、请求体）。文件可能几百 KB，按行 `grep` 或 `head`，别整份读进上下文。

## 失败分流

| 现象 | 处理 |
|---|---|
| `找不到 ego 浏览器端口` | `%LOCALAPPDATA%\ego-lite-linux\browser.json` 不存在，说明 ego 浏览器没起。让用户先打开，或用 `--port` 给 devtools 端口（自己打开 `--remote-debugging-port` 的 Chrome 也行） |
| `already running` | 该目录已有 recorder 在跑，不是错误。要重来先 `stop`，再 `start --fresh` |
| `recorder 启动后没有存活` | recorder 一启动就退了。报错里带实际启动命令、`Start-Process` 返回的 pid、以及 `state.json` 是否写出。先看这三行。带 `--port` 重试 |
| `running: false` 但用户说抓过 | 进程已不在（被强杀或机器重启）。数据还在 `net.jsonl`，直接 `report` |
| `stop` 报 `未能终止 recorder` | 目录下有进程杀不掉，输出里带 pid。用 `taskkill /PID <pid> /T /F` 手工清掉再重来 |
| `log` 退出码 2 | 没给任何过滤条件。至少带 `--host` / `--path` / `--method` / `--status` / `--tab` 之一 |

## 不要做

只列正文没讲过的红灯项；上面各节已写明的，这里不重复。

- 别把 `stop` 的明细或 `report.md` 全文倒给用户。他要的是"几条、哪些主机、报告在哪"。
- 别在 MSYS bash 里给 `taskkill` 加双斜杠（`//T //F`）：MSYS 把 `//T` 原样透传给 taskkill，被判成非法选项，报 `Invalid argument/option - '//T'`。用单斜杠 `taskkill /PID x /T /F`，或 `powershell -NoProfile -Command "Stop-Process -Id x -Force"`。

## Windows 行为（实现事实，写下来免得误判）

- recorder 由 `capture.mjs start` 用 `Start-Process -PassThru` 拉起（一次 PowerShell 调用就拿到 pid），pid 写进 `recorder.pid`。父 CLI 立即返回，不阻塞调用方。
- **别改回 `spawn(..., {detached:true}).unref()`**：Windows 上 detached+unref 的子进程仍留在调用方的 job 对象里，宿主（bash job / 终端）要等它退出才返回——实测 CLI 第 2.9 秒就打出了 `{"ok":true}`，调用它的 bash 却挂满 120 秒超时。`Start-Process` 走 `CreateProcess` 直接脱离 job 树。
- `Start-Process -ArgumentList` **必须传单个字符串**，每个参数各自加双引号。传 PowerShell 数组时它按空格重新拼接，含空格的路径会被拆散、进程起不来。实测 `...\a b\cap` 被拆成 `'F:\...\a'` 和 `'b\cap"'` 两个参数。
- 代价：命令行里每个参数都带引号，形态是 `"--out" "F:\a\b"`。`commandMatchesDir` 因此**必须按 token 切分再比 `--out` 的值**，不能按空格扫字符串——按空格扫时 `--out` 前是 `"` 不是空格，会落到兜底前缀匹配，父目录命中子目录的 recorder，`stop` 误杀别的目录（AC18 回归锁）。
- 旧版本走 `cmd /c start /b wscript.exe` 读 `launch.vbs`，这条路已移除。`start` 会删掉本目录残留的 `launch.vbs`。
- 因此 `stop` 在 Windows 上**直接 `taskkill /T /F`**，没有 SIGTERM 式的优雅收尾。数据不丢靠的是 recorder 逐条追加写盘、每 5s 写 `state.json`，不靠信号。
- `stop` 的 `/T` 会连带杀掉该进程的全部后代。对手工从别的 job 里起的 recorder，`stop` 可能连带影响那个 job。
- 输出目录名含中文时也能正常判定。`findRecorderPids` 与 `procInfo` 两条 PowerShell 查询都先设 `PS_UTF8`，让 PowerShell 按 UTF-8 输出，node 侧按 `utf8` 解码。不设这行前缀，中文目录会被解成问号，命令行匹配不上，`status` 会误报 `running: false`。
- `status` 的"跑没跑"按 `procState` 判。它先看 `recorder.pid`，再问一趟 `Get-CimInstance`，一次拿到该 pid 的存活与命令行。

  1. pid 活着且命令行含本目录 → `running`。
  2. pid 活着但命令行不含本目录 → `unknown`。此时 `start` 拒绝，`stop` 只打印不杀。理由是 pid 会被系统复用。
  3. pid 已死 → `stopped`。`start` 删掉过期的 `recorder.pid` 后照常启动。`status` 把 `stopped` 打印成 `running: false`。
  4. `recorder.pid` 不存在 → 回落到进程清单，兼容没有 pid 文件的旧目录。

- `state.json` 只提供条数与标签页数。它不参与存活判定，所以它的旧值不会误报 `running`。

## 脱敏

在 recorder 落盘时做，`net.jsonl` 里没有明文。

- 请求头、响应头、JSON 体内的键名命中 `cookie|authorization|token|ticket|secret|passw|pwd` → 值换成 `<REDACTED:n chars>`。
- 手机号 → `138****5678`；邮箱 → `co***@example.com`。
- 非 JSON 或半截 JSON 的文本走值域兜底（邮箱、11 位手机号）与"敏感键名 + 引号或等号"两条正则。

**已知边界**：邮箱打码只有走 JSON 键名路径才能做到 `co***`；非结构化文本里只能保留 2 位前缀本地部分，用户名级别打码拿不到。报给用户时别把它说成缺陷。

## 并发边界

- 一个输出目录同一时刻只能有一份 recorder；同一目录重复 start 返回 `already running`。
- 不同输出目录可以各跑一份。每个目录有自己的 `net.jsonl`、`state.json`、`recorder.pid`。`status` 与 `stop` 也只认自己的 `--out`。
- 隔离靠进程命令行匹配实现。`findRecorderPids` 要求命令行同时含 `recorder.mjs` 与归一化后的输出目录。
- 因为按归一化输出目录匹配，A 目录的 `stop` 不会杀掉 B 目录的 recorder。
- 跑全量测试要用显式超时：`node --test --test-timeout=180000 test/*.test.mjs`。这个目录不能放 `package.json`，所以没有 npm 脚本能挂超时。Node 在测试文件里也没有全局超时开关。全量跑 74 到 83 秒。
- recorder 重启并沿用旧 `net.jsonl` 时，`records` 从文件里可解析的行数接着数，不从 0 重来。
- 被强杀留下的半截行不计入基数。统计口径与 `readJsonl` 一致，两边都只数 `JSON.parse` 成功的行。
- 同一次抓取里，`records` 与 `net.jsonl` 的可解析行数相等。AC14 实测 3 = 3。
- 修前启动的 recorder 基数仍是 0。它的 `records` 会小于行数，重启一次才对得上。
- recorder 追加记录前先看文件最后一个字节。它不是换行就先补一个换行，再写新记录。
- 因此被强杀的半截行只影响自己那一行。后面的新记录不会被粘进坏行里。
- recorder 有两张状态表，名字不同，作用也不同。
  - `pending` 是请求阶段字段表。它由 `requestWillBeSent` 写入，由 `loadingFinished` 删除。
  - `t.pend` 是响应体回包登记表。它由 `finish` 写入，由 `onBody` 收到回包后删除。
- 清理一张表不等于清理另一张表。给一张表加上限或超时，不会限制另一张表。
- `pending` 有上限 `PENDING_MAX`，默认 2000。超过上限时删除最早一条。`trimPending` 用 `pending.keys().next().value` 取这条，`Map` 的键顺序就是插入顺序。
- 请求发出去却永远不回 `loadingFinished` 时，这个上限防止 `pending` 一直堆着占内存。
- `pending` 里超过 `PENDING_TIMEOUT_MS` 的记录会被定时抹掉，默认 60000 毫秒。
- 两个值都能用环境变量覆盖：`NETCAPTURE_PENDING_MAX` 与 `NETCAPTURE_PENDING_TIMEOUT_MS`。AC16 把上限设为 5，把超时设为 500 毫秒。
- AC16 验证两件事。一是上限触发后条目数收敛到 5。二是被删的是最早一条：`p0`、`p1`、`p2` 不在表里，`p7` 还在。
- `NETCAPTURE_DIAG=1` 时 recorder 向 stderr 打 `pending-size=N pending-keys=<键名列表>`。排障时用它看 `pending` 里还剩哪几条。
- 每条 WebSocket 只挂一个 `message` 监听器。它先按消息 id 查 `t.pend`，查到就走响应体路径，查不到就交给 `onEvent`。
- 旧写法每次 `finish` 挂一个 `onBody` 监听器。监听器随请求数无限累积，`recorder.log` 因此报 `MaxListenersExceededWarning`。
- 改成单一分发器后，AC15b 实测告警 0 次。
- `node --test` 超时被杀会留下 recorder 进程，需要手工清理：`taskkill /PID <pid> /T /F`。原因是测试进程被杀时 `finally` 不执行。
- `recorder.pid` 随输出目录一起消失后，`stop` 只能回落进程清单。清单里也找不到时，需手工 `taskkill /PID <pid> /T /F` 清理。

## 产物格式

`net.jsonl` 的字段、`report.md` 的完整结构、脱敏规则的精确形式见 [reference/output-format.md](reference/output-format.md)。只在需要逐字段核对时读它。
