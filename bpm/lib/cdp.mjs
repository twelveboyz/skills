// 极简 CDP 底座：起浏览器、连页面 target、发命令。
// 从 lib/pdf.mjs 抽出来，PDF 与 browser 两条路共用。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findChrome() {
  if (process.env.BPM_CHROME) return process.env.BPM_CHROME;
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/// 这个端口能不能自己占下来。占用中（含"有浏览器在监听"）返回 false。
export function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/// 想用特定端口（比如 9222，好让下次调用能复用），占着就退回随机端口
export async function portFor(preferred) {
  if (!preferred) return freePort();
  return (await isPortFree(preferred)) ? preferred : freePort();
}

/// 打 CDP 的 HTTP 端点。必须带 Host 头，Chromium 会拒。
/// 不抛错：探测场景下拒绝连接是常态，返回 {error} 让调用方降级。
export function jsonReq(port, { method = 'GET', path: p = '/json/list', timeout = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: 'localhost', port, path: p, method, headers: { Host: `localhost:${port}` } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(timeout, () => req.destroy(new Error('TIMEOUT')));
    req.end();
  });
}

/// 打 /json/list 找页面 target
export async function listPages(port) {
  const r = await jsonReq(port, { path: '/json/list' });
  if (!r.body) throw new Error(r.error || 'json/list 无响应');
  return JSON.parse(r.body);
}

/// 浏览器的 ws 地址；端口没监听或不是 Chrome 就返回 null
export async function browserWs(port) {
  const r = await jsonReq(port, { path: '/json/version', timeout: 800 });
  if (!r.body) return null;
  try {
    return JSON.parse(r.body).webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

/// 开一个新标签页，可直接带 URL。GET 会 405，必须 PUT。
export async function openTab(port, url) {
  const r = await jsonReq(port, {
    method: 'PUT',
    path: '/json/new?' + encodeURIComponent(url || 'about:blank'),
  });
  if (r.status !== 200) throw new Error(`开标签页失败: ${r.status || r.error}`);
  return JSON.parse(r.body);
}

/// 极简 CDP 客户端，够用就行
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /// 求值，返回 JS 表达式的值；异常抛出来，别静默 undefined
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || '页面脚本报错');
    }
    return r.result?.value;
  }

  /// 关连接并等它真的关完；不等的话 process.exit 会在 libuv 里撞
  /// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。
  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === 3) return resolve();
      const done = () => setTimeout(resolve, 60); // close 事件后底层 async handle 还要一拍
      this.ws.addEventListener('close', done, { once: true });
      try {
        this.ws.close();
      } catch {
        return resolve();
      }
      setTimeout(resolve, 250); // 兜底：别为关连接卡住
    });
  }
}

export async function poll(fn, { tries, gap, label }) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(gap);
  }
  throw new Error(`${label} 超时${last ? `：${last.message}` : ''}`);
}
