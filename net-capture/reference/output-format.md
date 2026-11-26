# net-capture 产物格式

`SKILL.md` 给动作与判定，本文给字段与结构的精确形式。实现与本文冲突时，以规格 `specs/net-capture-skill.md` 与代码为准，并回来改本文。

## 输出目录

默认 `<cwd>/.capture/`，可用 `--out` 指定。一个目录对应一次抓取。

| 文件 | 谁写 | 内容 |
|---|---|---|
| `net.jsonl` | recorder | 每行一条记录，`JSON.stringify` 单行 |
| `report.md` | gen-report（`report` / `stop` 触发） | 人读视图 |
| `state.json` | recorder，每 5s 与每条记录后 | `{records, targets, updatedAt}` |
| `recorder.pid` | start 写、stop 删 | `{pid, startedAt, out}` |
| `launch.vbs` | 无（旧版本遗留） | `start` 不再写这个文件。启动时若在本目录发现它，仅删除。 |

`state.json` 的 `records` 永远不领先于 `net.jsonl`：代码先追加记录再抬计数。

`records` 与 `net.jsonl` 的可解析行数相等。可解析行指 `JSON.parse` 成功的行。recorder 启动时按可解析行数算基数，半截行不计入。AC14 实测：两条完整行加一条半截行的文件上基数为 2，追加一条后两侧同为 3。

recorder 追加前检查文件末尾换行。末尾不是换行就先补一个，新记录永远从行首开始，不会粘在半截行尾部。

## net.jsonl 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `ts` | string | 请求发起时刻，ISO 8601 |
| `targetId` | string | CDP page target id，同一标签页恒定 |
| `pageUrl` | string | 发起请求时该标签页的地址 |
| `method` | string | 大写，`OPTIONS` 已被过滤 |
| `url` | string | 完整 URL，含查询串 |
| `reqHeaders` | object | 已脱敏 |
| `postData` | string \| null | 已脱敏；GET 为 null |
| `status` | number \| null | 响应状态码；没收到响应为 null |
| `mimeType` | string \| null | CDP 报的响应 MIME |
| `respHeaders` | object | 已脱敏 |
| `body` | string \| null | 已脱敏的响应体，超过 8KB 截断；取不到为 null |
| `bodyTruncated` | true | 只在被截断时出现 |
| `bodyError` | string | 只在 `getResponseBody` 报错时出现，同时 `body` 为 null |
| `durMs` | number | 从 `requestWillBeSent` 到收到响应体的毫秒数 |

`getResponseBody` 取不到响应体时仍然落一条记录（`body: null` + `bodyError`）：宁可多一条"有请求无响应体"，也不丢掉"该接口存在"这个事实。

## 过滤规则

丢弃：

- CDP 事件 `type` 不是 `XHR` 或 `Fetch`。
- `method` 为 `OPTIONS`。
- URL 命中 `/\.(js|css|png|jpe?g|svg|woff2?|gif|ico)(\?|$)/i`。
- URL 路径含 `/static/` 或 `/assets/`。

同一接口的判定（`report.md` 分组与 `stop` 摘要的去重接口数都用它）：**同方法 + 同主机 + 同路径**，查询串不同也算同一个。

## 脱敏规则

在 recorder 落盘前执行。顺序：先按 8KB 截断，再对截断后的片段脱敏。顺序反过来的话，重排过的 JSON 再切一刀仍会切在字符串中间。

**结构化路径**（`JSON.parse` 成功的 JSON）：

- 键名匹配 `/cookie|authorization|token|ticket|secret|passw|pwd/i` → `<REDACTED:<值的字符数> chars>`。
- 键名匹配 `/^(phone|mobile|(tel|contact)_?number|shouji|sjh)/i` 的字符串值：邮箱打码 + 11 位手机号打码。
- 其余字符串值：只做邮箱打码。
- 同一套键名规则作用于请求头与响应头。

**非结构化路径**（表单串、半截 JSON），三层依次过：

1. `&` 切分后按 `key=value` 判断，键名命中敏感正则 → `key=<REDACTED:<n> chars>`。
2. 敏感键名后跟引号或等号的正则 `([A-Za-z_][\w-]*(?:cookie|authorization|token|ticket|secret|passw|pwd)[\w-]*)(["']?\s*[:=]\s*)(["']?)([^"'&,\s}\]]*)` → 值换成 `<REDACTED>`。另有一条尾锚版本，兜住被截断切掉键名开头的片段（例如只剩 `"access`、`"access_token`）。
3. 值域兜底：邮箱 `([^@\s]{2})[^@\s]*@` → `co***@`；手机号 `(\D|^)(\d{3})\d{4}(\d{4})(?=\D|$)` → `138****5678`。

表单串不走尾锚规则：否则 `password` 的尾锚会吞掉后面的 `&note=hi`。

**已知边界**：值域兜底路径下邮箱只能保 2 位前缀（`co***@example.com`）。要按用户名打码，请求体必须是可解析的 JSON，走键名路径。

## report.md 结构

```markdown
# 接口抓取报告

## 概览

共 N 条请求。

## <主机>

### <方法> <路径>

调用 N 次，状态: NNN，耗时: Nms。

响应结构: `{ code: number, data: { ... } }`

请求体样本：

```json
{...}
```
```

- 按 `net.jsonl` 中主机首次出现的顺序分组，主机内按接口首次出现顺序。
- 状态与耗时取该接口**最后一次**调用。
- `响应结构` 是该接口第一个非空响应体解析后的形状骨架。
  - 对象给 `{key: 类型}`。
  - 数组给 `[元素骨架]`。
  - 递归深度上限 3，超出给 `…`。
  - 非 JSON 响应体给 `(非 JSON)`。
- `请求体样本` 是该接口第一条带 `postData` 的记录。
- 同一份 JSONL 输入，两次生成的结果逐字节相同。
- 半截末行（recorder 正在写或被杀）直接跳过，不让整份报告失败。

## 命名约定

- 输出目录没有派生名。多目录隔离靠进程命令行匹配：`findRecorderPids` 要求命令行同时含 `recorder.mjs` 与归一化后的输出目录。
- 归一化指 `resolve(outDir)`。`start` 拼进 `spawn` 参数的 `--out` 与 `findRecorderPids` 的匹配串是同一份归一化结果，正反斜杠不会分叉。
- 命令行匹配先按 `--out` 的值精确比。查找带词边界，`--outdir` 这类更长参数不会被认成 `--out`。
- `report.md` 不放 emoji 与装饰符号，它要能被 `grep`、能被 diff。
