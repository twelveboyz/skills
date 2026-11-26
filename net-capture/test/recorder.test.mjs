// S2：recorder 连假 CDP 端点，断言落盘的 JSONL。覆盖跨标签页、过滤、脱敏三条 AC。
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeCdp } from './helpers/fake-cdp.mjs';

const RECORDER = fileURLToPath(new URL('../bin/recorder.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cdp;

before(async () => {
  cdp = await startFakeCdp();
});

after(() => cdp?.close());

async function readJsonl(dir, min) {
  const file = join(dir, 'net.jsonl');
  for (let i = 0; i < 50; i++) {
    if (existsSync(file)) {
      const rows = readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          // 被强杀留下的半截行解析不了：跳过，和 capture.mjs 的 readJsonl 同口径
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        });
      if (rows.length >= min) return rows;
    }
    await sleep(100);
  }
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '(无文件)';
  throw new Error(`JSONL 未攒够 ${min} 条，现有：${raw}`);
}

// 一条 XHR 的完整生命周期：请求、响应、取体。
function emitXhr(id, { reqId, url, method = 'GET', headers = {}, postData, status = 200, body = '{}' }) {
  cdp.send(id, {
    method: 'Network.requestWillBeSent',
    params: {
      requestId: reqId,
      type: 'XHR',
      request: { url, method, headers, postData },
      timestamp: 1,
      wallTime: Date.now() / 1000,
    },
  });
  cdp.send(id, {
    method: 'Network.responseReceived',
    params: {
      requestId: reqId,
      type: 'XHR',
      response: { status, headers: {}, mimeType: 'application/json' },
    },
  });
  cdp.send(id, {
    method: 'Network.loadingFinished',
    params: { requestId: reqId },
  });
  cdp.lastBodies.set(reqId, body);
}

function startRecorder(dir) {
  const child = spawn(
    process.execPath,
    [RECORDER, '--out', dir, '--port', String(cdp.port)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stderr.on('data', (d) => process.stderr.write(`[recorder] ${d}`));
  return child;
}

function cleanup(dir, child) {
  if (child && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  rmSync(dir, { recursive: true, force: true });
}

test('AC4 中途新开的标签页也被抓到，各自计数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.lastBodies = new Map();
  cdp.ensureTarget('A');
  const child = startRecorder(dir);
  try {
    for (let i = 0; i < 50 && cdp.state.enables.filter((e) => e.method === 'Network.enable').length < 1; i++) {
      await sleep(100);
    }
    emitXhr('A', { reqId: 'a1', url: 'https://api.example.com/a' });

    cdp.ensureTarget('B');
    for (let i = 0; i < 50 && cdp.state.enables.filter((e) => e.method === 'Network.enable').length < 2; i++) {
      await sleep(100);
    }
    emitXhr('B', { reqId: 'b1', url: 'https://api.example.com/b' });

    const rows = await readJsonl(dir, 2);
    assert.deepStrictEqual(rows.map((r) => r.targetId).sort(), ['A', 'B']);
    assert.strictEqual(rows.find((r) => r.targetId === 'A').url, 'https://api.example.com/a');
    assert.strictEqual(rows.find((r) => r.targetId === 'B').url, 'https://api.example.com/b');
  } finally {
    cleanup(dir, child);
  }
});

test('AC6c 超长响应体先截断再脱敏，标记 bodyTruncated 且原值不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.lastBodies = new Map();
  cdp.ensureTarget('H');
  const child = startRecorder(dir);
  try {
    for (let i = 0; i < 100 && !cdp.state.enables.some((e) => e.id === 'H' && e.method === 'Network.enable'); i++) {
      await sleep(100);
    }
    // 敏感键在 8KB 之后才出现，且整体被切断：截断片段里只剩半截 JSON
    const tail = '{"access_token":"TOPSECRET12345"}';
    const big = `{"items":[{"blob":"${'a'.repeat(9000)}${tail}`;
    emitXhr('H', { reqId: 'big1', url: 'https://api.example.com/big', body: big });

    const rows = await readJsonl(dir, 1);
    const mine = rows.filter((r) => r.url === 'https://api.example.com/big');
    assert.strictEqual(mine.length, 1, `应落一条，实际 ${rows.length} 条`);
    assert.strictEqual(mine[0].bodyTruncated, true, '应标记截断');
    assert.ok(!JSON.stringify(rows).includes('TOPSECRET12345'), '截断后的敏感值也不能落盘');
  } finally {
    cleanup(dir, child);
  }
});

test('AC6c 被切在敏感键名前也不泄露令牌，截断标记如实', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.lastBodies = new Map();
  cdp.ensureTarget('G');
  const child = startRecorder(dir);
  try {
    for (let i = 0; i < 100 && !cdp.state.enables.some((e) => e.id === 'G' && e.method === 'Network.enable'); i++) {
      await sleep(100);
    }
    // 8192 落在 `","ac` 上：键名被切开，值根本没进文件
    const pad = 'x'.repeat(8179);
    const big = `{"pad":"${pad}","access_token":"TOPSECRET12345"}`;
    emitXhr('G', { reqId: 'big2', url: 'https://api.example.com/big2', body: big });

    const rows = await readJsonl(dir, 1);
    const mine = rows.filter((r) => r.url === 'https://api.example.com/big2');
    assert.strictEqual(mine.length, 1, `应落一条，实际 ${rows.length} 条`);
    assert.strictEqual(mine[0].bodyTruncated, true);
    assert.ok(!JSON.stringify(rows).includes('TOPSECRET12345'), '键名被切掉时值也不该出现');
  } finally {
    cleanup(dir, child);
  }
});

test('AC6c 截断正好切在敏感键名后时，键名剩下的值被盖掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.lastBodies = new Map();
  cdp.ensureTarget('F');
  const child = startRecorder(dir);
  try {
    for (let i = 0; i < 100 && !cdp.state.enables.some((e) => e.id === 'F' && e.method === 'Network.enable'); i++) {
      await sleep(100);
    }
    // 让 8192 的切点正好落在值里：前面是 "{pad": "...86 个 x..." , token 前缀
    const pad = `${'x'.repeat(30)}"${''}"${'x'.repeat(8128)}`;
    const big = `{"pad":"${pad}","access_token":"TOPSECRET12345"}`;
    const piece = big.slice(0, 8192);
    assert.ok(/"access_token":"[A-Z]/.test(piece), `切点应落在 access_token 值中间，实际 ${JSON.stringify(piece.slice(-24))}`);
    emitXhr('F', { reqId: 'big3', url: 'https://api.example.com/big3', body: big });

    const rows = await readJsonl(dir, 1);
    const mine = rows.filter((r) => r.url === 'https://api.example.com/big3');
    assert.strictEqual(mine.length, 1, `应落一条，实际 ${rows.length} 条`);
    assert.strictEqual(mine[0].bodyTruncated, true);
    assert.ok(!JSON.stringify(rows).includes('TOPSECRET12345'));
    assert.match(mine[0].body, /"access_token":"<REDACTED>/, mine[0].body.slice(-40));
  } finally {
    cleanup(dir, child);
  }
});

test('AC5 静态资源与 OPTIONS 被丢弃，XHR 保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.ensureTarget('C');
  const child = startRecorder(dir);
  try {
    for (let i = 0; i < 50 && !cdp.state.enables.some((e) => e.id === 'C'); i++) await sleep(100);
    emitXhr('C', { reqId: 'c1', url: 'https://api.example.com/keep' });
    emitXhr('C', { reqId: 'c2', url: 'https://cdn.example.com/app.js' });
    emitXhr('C', { reqId: 'c3', url: 'https://api.example.com/preflight', method: 'OPTIONS' });
    emitXhr('C', { reqId: 'c4', url: 'https://api.example.com/after' });

    const rows = await readJsonl(dir, 2);
    const urls = rows.map((r) => r.url);
    assert.ok(urls.includes('https://api.example.com/keep'));
    assert.ok(urls.includes('https://api.example.com/after'));
    assert.ok(!urls.includes('https://cdn.example.com/app.js'), '静态资源不应落盘');
    assert.ok(!urls.includes('https://api.example.com/preflight'), 'OPTIONS 不应落盘');
  } finally {
    cleanup(dir, child);
  }
});

test('AC7 recorder 落盘后 state.json 的条数与 JSONL 一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.lastBodies = new Map();
  cdp.ensureTarget('E');
  const child = startRecorder(dir);
  try {
    for (let i = 0; i < 50 && !cdp.state.enables.some((e) => e.id === 'E'); i++) await sleep(100);
    emitXhr('E', { reqId: 'e1', url: 'https://api.example.com/e1' });
    emitXhr('E', { reqId: 'e2', url: 'https://api.example.com/e2' });
    const rows = await readJsonl(dir, 2);

    // state.json 每条记录都补写一次，读到的条数不会领先于 JSONL
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(state.records, rows.length);
  } finally {
    cleanup(dir, child);
  }
});

// 回归锁：上一次被强杀留下的半截行，不许吞掉之后的新记录，也不许算进基数。
// 两个口径必须同时为 3：半截行不计，新记录保住。
test('AC14 半截行之后的新记录不被吞掉，records 与可解析行数同时为 3', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  const row = (i) => JSON.stringify({ ts: '2026-11-17T03:00:00.000Z', targetId: 'A', pageUrl: 'p', method: 'GET', url: `https://api.example.com/x${i}`, reqHeaders: {}, postData: null, status: 200, mimeType: 'application/json', respHeaders: {}, body: '{}', durMs: 5 });
  cdp.lastBodies = new Map();
  cdp.ensureTarget('X');
  // 两条完整行 + 一条截断的半行，末尾没有换行：模拟 recorder 被强杀留下的现场
  writeFileSync(join(dir, 'net.jsonl'), [row(1), row(2)].join('\n') + '\n{"ts":"2026-11-17T03:00');
  const child = startRecorder(dir);
  try {
    // 基数：半截行不计入，应为 2
    for (let i = 0; i < 50 && !existsSync(join(dir, 'state.json')); i++) await sleep(100);
    const base = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).records;
    assert.strictEqual(base, 2, `基数应跳过半截行，实际 ${base}`);

    for (let i = 0; i < 50 && !cdp.state.enables.some((e) => e.id === 'X'); i++) await sleep(100);
    emitXhr('X', { reqId: 'x1', url: 'https://api.example.com/after' });

    // 新记录必须独立成行：两数同时为 3
    const rows = await readJsonl(dir, 3);
    assert.strictEqual(rows.length, 3, `可解析行数应为 3，实际 ${rows.length}`);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.strictEqual(state.records, 3, `records 应为 3，实际 ${state.records}`);
    assert.ok(rows.some((r) => r.url === 'https://api.example.com/after'), '新记录不能被吞进半截行');
  } finally {
    cleanup(dir, child);
  }
});

// 回归锁其一：不回包的请求不许堵住后面的请求。单测"写不写"，不测告警。
test('AC15a 响应体不回包时，后续正常请求照常落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.lastBodies = new Map();
  cdp.dropBodyFor = new Set();
  cdp.ensureTarget('M');
  const child = startRecorder(dir);
  try {
    for (let i = 0; i < 50 && !cdp.state.enables.some((e) => e.id === 'M'); i++) await sleep(100);

    for (let i = 0; i < 5; i++) {
      const reqId = `hang${i}`;
      cdp.dropBodyFor.add(reqId);
      emitXhr('M', { reqId, url: `https://api.example.com/hang${i}` });
    }
    await sleep(500);

    for (let i = 0; i < 3; i++) {
      emitXhr('M', { reqId: `fine${i}`, url: `https://api.example.com/fine${i}` });
    }
    // 只数 fine 三条：hang 那几条在超时前也可能回包，不能拿总数断言
    let fine = [];
    for (let i = 0; i < 50 && fine.length < 3; i++) {
      await sleep(100);
      if (existsSync(join(dir, 'net.jsonl'))) {
        fine = readFileSync(join(dir, 'net.jsonl'), 'utf8')
          .split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
          .filter((r) => r.url.includes('/fine'));
      }
    }
    assert.strictEqual(fine.length, 3, `不回包之后应仍写入 3 条 fine，实际 ${fine.length}`);
  } finally {
    cdp.dropBodyFor = new Set();
    cleanup(dir, child);
  }
});

// 回归锁其二：每次 finish 都挂一个 onBody，监听器会随请求数无上限增长。单测"告警次数"。
test('AC15b 连续 finish 不累积消息监听器，不触发 MaxListenersExceededWarning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.lastBodies = new Map();
  cdp.dropBodyFor = new Set();
  cdp.ensureTarget('N');
  const child = spawn(
    process.execPath,
    [RECORDER, '--out', dir, '--port', String(cdp.port)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let errText = '';
  child.stderr.on('data', (d) => { errText += String(d); });
  try {
    for (let i = 0; i < 50 && !cdp.state.enables.some((e) => e.id === 'N'); i++) await sleep(100);

    // 25 条都不回包：旧实现会挂 25 个 onBody，远超默认上限 10
    for (let i = 0; i < 25; i++) {
      const reqId = `leak${i}`;
      cdp.dropBodyFor.add(reqId);
      emitXhr('N', { reqId, url: `https://api.example.com/leak${i}` });
    }
    for (let i = 0; i < 100 && !/MaxListenersExceededWarning/.test(errText); i++) await sleep(100);

    const hits = (errText.match(/MaxListenersExceededWarning/g) ?? []).length;
    assert.strictEqual(hits, 0, `不应触发监听器泄漏告警，实际 ${hits} 次；stderr: ${errText.slice(0, 300)}`);
  } finally {
    cdp.dropBodyFor = new Set();
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
});

// 回归锁：pending（请求阶段字段表）只增不减。请求永远不回 loadingFinished 时会一直堆着。
// 用 NETCAPTURE_DIAG=1 让 recorder 把 pending.size 打到 stderr，用例直接读数字。
// 上限与超时走环境变量注入（5 / 500ms），用例不用等 60 秒。
test('AC16 pending 触顶删最早一条，超时清理由真的执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.lastBodies = new Map();
  cdp.dropBodyFor = new Set();
  cdp.ensureTarget('P');
  const child = spawn(
    process.execPath,
    [RECORDER, '--out', dir, '--port', String(cdp.port)],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NETCAPTURE_DIAG: '1',
        NETCAPTURE_PENDING_MAX: '5',
        NETCAPTURE_PENDING_TIMEOUT_MS: '500',
      },
    },
  );
  let errText = '';
  child.stderr.on('data', (d) => { errText += String(d); });
  const lastSize = () => {
    const m = [...errText.matchAll(/pending-size=(\d+)/g)];
    return m.length ? Number(m[m.length - 1][1]) : null;
  };
  const lastKeys = () => {
    const m = [...errText.matchAll(/pending-keys=([^\n]*)/g)];
    return m.length ? m[m.length - 1][1].split(',').filter(Boolean) : [];
  };
  try {
    for (let i = 0; i < 50 && !cdp.state.enables.some((e) => e.id === 'P'); i++) await sleep(100);

    // 8 条只发 requestWillBeSent、永不发 loadingFinished：全部堆在 pending
    for (let i = 0; i < 8; i++) {
      cdp.send('P', {
        method: 'Network.requestWillBeSent',
        params: {
          requestId: `p${i}`,
          type: 'XHR',
          request: { url: `https://api.example.com/pend${i}`, method: 'GET', headers: {} },
        },
      });
    }

    // 上限 5：等 stderr 报出 pending-size，它不该超过 5
    let size = null;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      size = lastSize();
      if (size !== null && size >= 5) break;
    }
    assert.ok(size !== null, `recorder 应报出 pending-size，实际 stderr: ${errText.slice(0, 200)}`);
    assert.strictEqual(size, 5, `pending 触顶后应为 5，实际 ${size}`);

    // 身份断言：触顶删的是最早一条，留下的是最新 5 条。
    // 只断数量会假绿：把删法改成删最新一条，size 仍然是 5，用例照样过。
    const keys = lastKeys();
    for (const gone of ['p0', 'p1', 'p2']) {
      assert.ok(!keys.includes(gone), `触顶应删最早一条，${gone} 不应留下；实际 ${keys.join(',')}`);
    }
    assert.ok(keys.includes('p7'), `最新一条 p7 应留下；实际 ${keys.join(',')}`);

    // 超时 500ms：过了周期之后 pending 应被清空为 0
    let cleared = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      cleared = lastSize();
      if (cleared === 0) break;
    }
    assert.strictEqual(cleared, 0, `超时清理应把 pending 清到 0，实际 ${cleared}`);
  } finally {
    cdp.dropBodyFor = new Set();
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC6 明文 Cookie / Authorization / phone 不出现在 JSONL 任何字节里', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  cdp.ensureTarget('D');
  const child = startRecorder(dir);
  try {
    for (let i = 0; i < 50 && !cdp.state.enables.some((e) => e.id === 'D'); i++) await sleep(100);
    emitXhr('D', {
      reqId: 'd1',
      url: 'https://api.example.com/login',
      method: 'POST',
      headers: { Cookie: 'sid=SECRETVALUE', Authorization: 'Bearer TOPSECRET' },
      postData: '{"phone":"13812345678"}',
      body: '{"token":"TOPSECRET"}',
    });

    const rows = await readJsonl(dir, 1);
    const raw = readFileSync(join(dir, 'net.jsonl'), 'utf8');
    for (const secret of ['SECRETVALUE', 'TOPSECRET', '13812345678']) {
      assert.ok(!raw.includes(secret), `明文 ${secret} 不应出现在 JSONL 里`);
    }
    assert.match(rows[0].reqHeaders.Cookie ?? rows[0].reqHeaders.cookie, /^<REDACTED:\d+ chars>$/);
  } finally {
    cleanup(dir, child);
  }
});
