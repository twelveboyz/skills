#!/usr/bin/env node
// recorder.mjs：CDP 记录器。由 capture.mjs start 以 detached 方式拉起。
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactBody, redactHeaders, redactText } from '../lib/redact.mjs';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

const outDir = arg('--out', join(process.cwd(), '.capture'));
// 注意：不能写成 arg('--port', readBrowserPort()) —— JS 默认参数是急切求值，
// 没传 --port 时本该走 browser.json，但传了 --port 也会先跑 readBrowserPort()
// 并在没有 browser.json 的机器上直接 exit(1)，--port 等于失效。
const portArg = arg('--port', null);
const port = portArg != null ? Number(portArg) : Number(readBrowserPort());
const POLL_MS = 2000;
const STATE_MS = 5000;
const BODY_LIMIT = 8192;

const STATIC = /\.(js|css|png|jpe?g|svg|woff2?|gif|ico)(\?|$)/i;
const STATIC_DIR = /\/(static|assets)\//i;

function readBrowserPort() {
  const p = join(process.env.LOCALAPPDATA ?? '', 'ego-lite-linux', 'browser.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8')).port;
  } catch {
    console.error(`找不到 ego 浏览器端口：${p}；请用 --port 指定`);
    process.exit(1);
  }
}

// 条数的基数是 net.jsonl 里「可解析」的记录数：口径与 capture.mjs 的 readJsonl 一致，
// 半截行两边都不算，否则 status 的 records 和 stop 的条数会永远差一截。
function countExistingLines(file) {
  try {
    let n = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
        n++;
      } catch {
        // 被强杀时留下的半截行：不计入
      }
    }
    return n;
  } catch {
    return 0;
  }
}

// 上一次被强杀时最后一行可能是半截。直接追加会把新记录粘在坏行尾部，两条一起变成坏行。
// 追加前看一眼文件最后一个字节，不是换行就先补一个，让新记录独立成行。
function endsWithNewline(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (!size) return true;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

let records = 0;
const targets = new Map(); // targetId -> {ws, pages:Map, pend:Map, seq}
const pending = new Map(); // requestId -> 请求阶段已收齐的字段

mkdirSync(outDir, { recursive: true });
records = countExistingLines(join(outDir, 'net.jsonl'));

function writeRecord(rec) {
  const file = join(outDir, 'net.jsonl');
  const prefix = endsWithNewline(file) ? '' : '\n';
  appendFileSync(file, prefix + JSON.stringify(rec) + '\n');
  records++;
  writeState(); // 先落 JSONL 再抬条数，state 永远不领先于文件
}

function writeState() {
  writeFileSync(
    join(outDir, 'state.json'),
    JSON.stringify({ records, targets: targets.size, updatedAt: Date.now() }),
  );
}

async function poll() {
  let list;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    list = await res.json();
  } catch {
    return;
  }
  const seen = new Set();
  for (const t of list) {
    if (t.type !== 'page') continue;
    seen.add(t.id);
    if (!targets.has(t.id)) connect(t);
  }
  for (const [id, t] of targets) {
    if (!seen.has(id)) {
      t.ws.close();
      targets.delete(id);
    }
  }
}

function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const entry = { ws, pend: new Map(), seq: 0, url: t.url };
  targets.set(t.id, entry);
  ws.addEventListener('open', () => {
    send(t.id, 'Network.enable', {});
  });
  // 每条 WebSocket 只挂这一个 message 监听器，按消息 id 分发给「响应体」或「事件」两条路径。
  // 旧写法每 finish 一次就 addEventListener 一个 onBody，监听器随请求数无限累积，
  // 现场 recorder.log 因此报 MaxListenersExceededWarning。
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id !== undefined && entry.pend.has(msg.id)) {
      onBody(entry, msg);
      return;
    }
    onEvent(t.id, msg);
  });
  ws.addEventListener('close', () => targets.delete(t.id));
  ws.addEventListener('error', () => {});
}

function send(targetId, method, params) {
  const t = targets.get(targetId);
  if (!t) return;
  t.ws.send(JSON.stringify({ id: ++t.seq, method, params }));
}

// pending（请求阶段字段表）的上限与超时。请求永远不回 loadingFinished 时会一直堆着，
// 所以要有上限，也要有过期清理。两者都能用环境变量覆盖，测试不用等 60 秒。
// 注意：这张表与 t.pend（响应体回包登记表）是两张不同的表。
const PENDING_MAX = Number(process.env.NETCAPTURE_PENDING_MAX ?? 2000);
const PENDING_TIMEOUT_MS = Number(process.env.NETCAPTURE_PENDING_TIMEOUT_MS ?? 60000);
const DIAG = process.env.NETCAPTURE_DIAG === '1';

function diag() {
  if (DIAG) console.error(`pending-size=${pending.size} pending-keys=${[...pending.keys()].join(',')}`);
}

// 超过上限就删最早一条：Map 的键顺序就是插入顺序，keys().next() 拿到的就是最早的那条。
function trimPending() {
  while (pending.size > PENDING_MAX) {
    pending.delete(pending.keys().next().value);
  }
}

// 扫描过期项：每条记录带 t0，超过 PENDING_TIMEOUT_MS 就摘掉。
// 限流值必须小于定时器周期，否则定时器抖动时会被自己挡掉一次。
let lastPendingSweep = 0;
function sweepPending(now = Date.now()) {
  if (now - lastPendingSweep < 100) return;
  lastPendingSweep = now;
  for (const [id, p] of pending) {
    if (now - p.t0 > PENDING_TIMEOUT_MS) pending.delete(id);
  }
  diag();
}

function onEvent(targetId, msg) {
  const { method, params } = msg;
  if (!params?.requestId) return;

  if (method === 'Network.requestWillBeSent') {
    const { request, type } = params;
    if (type !== 'XHR' && type !== 'Fetch') return;
    if (request.method === 'OPTIONS') return;
    if (STATIC.test(request.url) || STATIC_DIR.test(request.url)) return;
    pending.set(params.requestId, {
      ts: new Date().toISOString(),
      targetId,
      pageUrl: targets.get(targetId)?.url ?? '',
      method: request.method,
      url: request.url,
      reqHeaders: request.headers,
      postData: request.postData ?? null,
      t0: Date.now(),
    });
    trimPending();
    diag();
  } else if (method === 'Network.responseReceived') {
    const p = pending.get(params.requestId);
    if (!p) return;
    p.status = params.response.status;
    p.mimeType = params.response.mimeType;
    p.respHeaders = params.response.headers;
  } else if (method === 'Network.loadingFinished') {
    const p = pending.get(params.requestId);
    if (!p) return;
    pending.delete(params.requestId);
    finish(targetId, params.requestId, p);
  }
}

// 响应体永远不回来时，超时把 pend 里这一条摘掉，不让它一直占着。
const BODY_TIMEOUT_MS = 10000;

// 只保留登记和超时兜底；消息分发由 connect 里那唯一一个监听器完成。
// 响应体永远不回来时，超时把 pend 里这一条摘掉，不让它一直占着。
function finish(targetId, requestId, p) {
  const t = targets.get(targetId);
  if (!t) return;
  const id = ++t.seq;
  t.pend.set(id, { ...p, t0: p.t0 });
  t.ws.send(JSON.stringify({ id, method: 'Network.getResponseBody', params: { requestId } }));
  const timer = setTimeout(() => t.pend.delete(id), BODY_TIMEOUT_MS);
  timer.unref?.();
}

// 收到 getResponseBody 的回包：从 pend 取登记，落盘一条记录。
function onBody(entry, msg) {
  const rec = entry.pend.get(msg.id);
  if (!rec) return;
  entry.pend.delete(msg.id);
  let body = msg.error ? null : msg.result.body;
  let bodyError = msg.error ? msg.error.message : undefined;
  writeRecord({
    ts: rec.ts,
    targetId: rec.targetId,
    pageUrl: rec.pageUrl,
    method: rec.method,
    url: rec.url,
    reqHeaders: redactHeaders(rec.reqHeaders),
    postData: rec.postData === null ? null : redactText(rec.postData),
    status: rec.status ?? null,
    mimeType: rec.mimeType ?? null,
    respHeaders: redactHeaders(rec.respHeaders ?? {}),
    body: body === undefined ? null : redactBody(body, BODY_LIMIT).body,
    ...(redactBody(body, BODY_LIMIT).bodyTruncated ? { bodyTruncated: true } : {}),
    ...(bodyError ? { bodyError } : {}),
    durMs: Date.now() - rec.t0,
  });
}

function shutdown() {
  writeState();
  rmSync(join(outDir, 'recorder.pid'), { force: true });
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

poll();
setInterval(poll, POLL_MS);
setInterval(writeState, STATE_MS);
setInterval(sweepPending, 500);
writeState();
