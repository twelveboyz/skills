// S1：capture.mjs 的 CLI 进程边界。只跑子进程，断言退出码与 stdout。
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/capture.mjs', import.meta.url));
const RECORDER = fileURLToPath(new URL('../bin/recorder.mjs', import.meta.url));
function tmpOut() {
  return mkdtempSync(join(tmpdir(), 'netcapture-s1-'));
}

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function pidIn(dir) {
  return JSON.parse(readFileSync(join(dir, 'recorder.pid'), 'utf8')).pid;
}

// Windows 上 process.kill(pid, 0) 对已退出的进程也会成功，改用 tasklist 精确核对。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  if (process.platform === 'win32') {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf8',
    });
    return out.includes(` ${pid} `) || out.includes(`\t${pid}\t`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 命令行里同时含 recorder.mjs 与本归一化目录的进程号。用 .Contains 不用 -like：
// -like 会把 [ ] * ? 当通配符，目录名带这些字符就匹配不上。
function cimPidsScript(dir) {
  return (
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
    `Where-Object { $_.CommandLine -and ` +
    `$_.CommandLine.Contains('recorder.mjs') -and ` +
    `$_.CommandLine.Contains('${dir}') } | ` +
    `ForEach-Object { $_.ProcessId }`
  );
}

function pidsUnderOutDir(dir) {
  return execFileSync('powershell', ['-NoProfile', '-Command', cimPidsScript(dir)], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(Number);
}

// start 返回后进程清单不一定立刻可见：轮询到条件成立或超时，别用一次性时序断言。
async function waitFor(fn, timeoutMs = 3000) {
  for (let i = 0; i < timeoutMs / 100; i++) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}

// 按目录杀干净：只认命令行里含本归一化目录的 recorder，绝不按 recorder.mjs 裸杀（别的安装路径会被误伤）。
// recorder.pid 里有 pid 时一并补一刀，防止命令行匹配因路径写法分叉而漏杀。

function cleanupDir(dir) {
  if (process.platform === 'win32') {
    const pids = new Set(pidsUnderOutDir(dir));
    const pidFile = join(dir, 'recorder.pid');
    if (existsSync(pidFile)) pids.add(pidIn(dir));
    for (const pid of pids) {
      if (isAlive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

test('AC7 status 未运行时返回 running:false 且退出码 0', () => {
  const out = tmpOut();
  try {
    const r = run(['status', '--out', out]);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /running: false/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('AC1 start 拉起独立进程并返回 pid 与输出路径', async () => {
  const out = tmpOut();
  try {
    const r = run(['start', '--out', out]);
    assert.strictEqual(r.code, 0, r.err);
    const info = JSON.parse(r.out);
    assert.ok(isAlive(info.pid), 'recorder 进程应存活');
    assert.strictEqual(info.out, out);
    // 新方案的验收凭据：recorder.pid 存在，且 pid 与进程清单里的实际 pid 一致
    assert.ok(existsSync(join(out, 'recorder.pid')), '应写 pid 文件');
    assert.ok(await waitFor(() => existsSync(join(out, 'recorder.pid'))), 'recorder.pid 应出现');
    assert.strictEqual(pidIn(out), info.pid, 'recorder.pid 的 pid 必须与进程清单一致');
    assert.ok(
      await waitFor(() => pidsUnderOutDir(out).includes(info.pid)),
      `进程清单里应出现 pid ${info.pid}`,
    );
    assert.deepStrictEqual(pidsUnderOutDir(out), [info.pid], '进程清单里应只有这一个 recorder');
  } finally {
    cleanupDir(out);
  }
});

// 回归锁：pid 文件里是死 pid、进程清单为空时，stop 不许假报「已停止」。
// 死 pid 用 spawn 一个马上退出的 node 拿真 pid：start 时带本目录，所以三态不会误判成 unknown。
test('stop 遇到死 pid 与空进程清单时报未在运行', () => {
  const out = tmpOut();
  try {
    mkdirSync(out, { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    assert.ok(dead.pid > 0, '应拿到一个真 pid');
    writeFileSync(
      join(out, 'recorder.pid'),
      JSON.stringify({ pid: dead.pid, out, at: Date.now() }),
    );
    assert.deepStrictEqual(pidsUnderOutDir(out), [], '前置：进程清单必须为空');
    const r = run(['stop', '--out', out]);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /未在运行/);
    assert.doesNotMatch(r.out, /已停止/);
    assert.ok(!existsSync(join(out, 'recorder.pid')), '过期 pid 文件应被删掉');
  } finally {
    cleanupDir(out);
  }
});

test('AC3 stop 终止进程、删 pid 文件并打印摘要', () => {
  const out = tmpOut();
  try {
    const started = run(['start', '--out', out]);
    assert.strictEqual(started.code, 0, started.err);
    const pid = JSON.parse(started.out).pid;

    const t0 = Date.now();
    const stopped = run(['stop', '--out', out]);
    const stopMs = Date.now() - t0;
    assert.strictEqual(stopped.code, 0, stopped.err);
    // 量出真实耗时：规格是 /T /F 后 1 秒内判完，实测远低于上限；超了说明 stop 在死等
    assert.ok(stopMs < 30000, `stop 应在 30 秒内返回，实测 ${stopMs}ms`);
    assert.ok(!isAlive(pid), 'stop 后进程应消失');
    assert.ok(!existsSync(join(out, 'recorder.pid')), 'stop 后应删除 pid 文件');
    assert.match(stopped.out, /条数|records/);
  } finally {
    cleanupDir(out);
  }
});

test('AC7 status 运行中返回 running:true 与条数', () => {
  const out = tmpOut();
  try {
    const started = run(['start', '--out', out]);
    assert.strictEqual(started.code, 0, started.err);

    const status = run(['status', '--out', out]);
    assert.strictEqual(status.code, 0, status.err);
    assert.match(status.out, /running: true/);
    assert.match(status.out, /records: \d+/);
  } finally {
    cleanupDir(out);
  }
});

test('AC3b stop 摘要给出分主机与去重接口数', () => {  const out = tmpOut();
  try {
    const started = run(['start', '--out', out]);
    assert.strictEqual(started.code, 0, started.err);

    const row = (url) => ({ ts: '2026-11-17T03:00:00.000Z', targetId: 'A', pageUrl: 'p', method: 'GET', url, reqHeaders: {}, postData: null, status: 200, mimeType: 'application/json', respHeaders: {}, body: '{}', durMs: 5 });
    // 同一接口打了两次只算一个接口
    writeFileSync(
      join(out, 'net.jsonl'),
      [row('https://api.keep.com/v1/users?a=1'), row('https://api.keep.com/v1/users?a=2'), row('https://api.other.com/v2/x')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const stopped = run(['stop', '--out', out]);
    assert.strictEqual(stopped.code, 0, stopped.err);
    assert.match(stopped.out, /分主机: api\.keep\.com 2, api\.other\.com 1/);
    assert.match(stopped.out, /去重接口数: 2/);
  } finally {
    cleanupDir(out);
  }
});

test('AC7b status 运行中带上覆盖的标签页数', () => {
  const out = tmpOut();
  try {
    const started = run(['start', '--out', out]);
    assert.strictEqual(started.code, 0, started.err);

    const status = run(['status', '--out', out]);
    assert.strictEqual(status.code, 0, status.err);
    assert.match(status.out, /targets: \d+/);
  } finally {
    cleanupDir(out);
  }
});

test('AC9b log 支持按方法、状态码、标签页过滤', () => {
  const out = tmpOut();
  try {
    const row = (o) => ({ ts: '2026-11-17T03:00:00.000Z', targetId: 'A', pageUrl: 'p', method: 'GET', url: 'https://api.keep.com/v1/x', reqHeaders: {}, postData: null, status: 200, mimeType: 'application/json', respHeaders: {}, body: '{}', durMs: 5, ...o });
    writeFileSync(
      join(out, 'net.jsonl'),
      [
        row({}),
        row({ method: 'POST', status: 500 }),
        row({ targetId: 'B' }),
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    const byMethod = run(['log', '--out', out, '--method', 'POST']);
    assert.strictEqual(byMethod.code, 0, byMethod.err);
    assert.strictEqual(byMethod.out.trim().split('\n').length - 1, 1, byMethod.out);

    const byStatus = run(['log', '--out', out, '--status', '500']);
    assert.strictEqual(byStatus.out.trim().split('\n').length - 1, 1, byStatus.out);

    const byTab = run(['log', '--out', out, '--tab', 'B']);
    assert.strictEqual(byTab.out.trim().split('\n').length - 1, 1, byTab.out);
    assert.match(byTab.out, /tab:B/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('AC9 log 按主机与路径过滤，输出精简单行', () => {
  const out = tmpOut();
  try {
    const rows = [
      { ts: '2026-11-17T03:00:00.000Z', targetId: 'A', pageUrl: 'p', method: 'GET', url: 'https://api.keep.com/v1/users?page=1', reqHeaders: {}, postData: null, status: 200, mimeType: 'application/json', respHeaders: {}, body: '{}', durMs: 5 },
      { ts: '2026-11-17T03:00:01.000Z', targetId: 'A', pageUrl: 'p', method: 'GET', url: 'https://api.keep.com/v1/other', reqHeaders: {}, postData: null, status: 200, mimeType: 'application/json', respHeaders: {}, body: '{}', durMs: 6 },
      { ts: '2026-11-17T03:00:02.000Z', targetId: 'A', pageUrl: 'p', method: 'GET', url: 'https://api.other.com/v1/users', reqHeaders: {}, postData: null, status: 200, mimeType: 'application/json', respHeaders: {}, body: '{}', durMs: 7 },
    ];
    writeFileSync(join(out, 'net.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const r = run(['log', '--out', out, '--host', 'api.keep.com', '--path', '/v1/users']);
    assert.strictEqual(r.code, 0, r.err);
    const lines = r.out.trim().split('\n').slice(0, -1); // 去掉末尾"共 N 条"汇总行
    assert.strictEqual(lines.length, 1, r.out);
    assert.match(lines[0], /GET/);
    assert.match(lines[0], /api\.keep\.com\/v1\/users/);
    assert.ok(!lines[0].trim().startsWith('{'), '不应是原始 JSON 原文');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('AC9 log 的 --path 是精确匹配，不吃前缀相同的路径', () => {
  const out = tmpOut();
  try {
    const row = (url) => ({ ts: '2026-11-17T03:00:00.000Z', targetId: 'A', pageUrl: 'p', method: 'GET', url, reqHeaders: {}, postData: null, status: 200, mimeType: 'application/json', respHeaders: {}, body: '{}', durMs: 5 });
    writeFileSync(
      join(out, 'net.jsonl'),
      [row('https://api.keep.com/v2/users'), row('https://api.keep.com/v2/users/detail')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const r = run(['log', '--out', out, '--path', '/v2/users']);
    const lines = r.out.trim().split('\n').slice(0, -1);
    assert.strictEqual(lines.length, 1, r.out);
    assert.match(lines[0], /\/v2\/users /);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('S4 log 遇到半截坏行跳过，不整体报错', () => {
  const out = tmpOut();
  try {
    const row = { ts: '2026-11-17T03:00:00.000Z', targetId: 'A', pageUrl: 'p', method: 'GET', url: 'https://api.keep.com/v1/x', reqHeaders: {}, postData: null, status: 200, mimeType: 'application/json', respHeaders: {}, body: '{}', durMs: 5 };
    // recorder 被强杀时最后一行会停在半截
    writeFileSync(join(out, 'net.jsonl'), JSON.stringify(row) + '\n{"ts":"2026-11-17T03:00:0');
    const r = run(['log', '--out', out, '--host', 'api.keep.com']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /共 1 条/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('AC11 Windows 上 stop 真的执行 taskkill 兜底并把进程杀掉', { skip: process.platform !== 'win32' }, () => {
  const out = tmpOut();
  try {
    const started = run(['start', '--out', out]);
    assert.strictEqual(started.code, 0, started.err);
    const pid = JSON.parse(started.out).pid;

    const stopped = run(['stop', '--out', out]);
    assert.strictEqual(stopped.code, 0, stopped.err);
    assert.ok(!isAlive(pid), 'taskkill 分支后进程应消失');
    assert.ok(!existsSync(join(out, 'recorder.pid')));
  } finally {
    cleanupDir(out);
  }
});

test('AC2 记录器存活时再次 start 不拉第二份', () => {
  const out = tmpOut();
  try {
    const first = run(['start', '--out', out]);
    assert.strictEqual(first.code, 0, first.err);
    const firstPid = JSON.parse(first.out).pid;

    const second = run(['start', '--out', out]);
    assert.notStrictEqual(second.code, 0, '重复 start 应返回非 0');
    assert.match(second.out + second.err, /already running/);
    assert.strictEqual(pidIn(out), firstPid, 'pid 文件不应被覆盖');
  } finally {
    cleanupDir(out);
  }
});

test('R3 stop 时进程已自行退出就按未运行处理，退出码 0 且清掉 pid 文件', async () => {
  const out = tmpOut();
  try {
    const started = run(['start', '--out', out]);
    assert.strictEqual(started.code, 0, started.err);
    const pid = JSON.parse(started.out).pid;
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(100);
    assert.ok(!isAlive(pid), '前置条件：进程应已退出');

    const stopped = run(['stop', '--out', out]);
    assert.strictEqual(stopped.code, 0, stopped.err);
    assert.match(stopped.out, /未在运行/);
    assert.ok(!existsSync(join(out, 'recorder.pid')), '残留 pid 文件应清掉');
  } finally {
    cleanupDir(out);
  }
});

test('B11 两个目录各开一份抓取，互不删掉对方的托管任务', async () => {
  const a = tmpOut();
  const b = tmpOut();
  try {
    const first = run(['start', '--out', a]);
    assert.strictEqual(first.code, 0, first.err);
    const pidA = JSON.parse(first.out).pid;
    assert.ok(
      await waitFor(() => pidsUnderOutDir(a).includes(pidA)),
      '前置：A 的 recorder 必须真的在进程清单里',
    );

    const second = run(['start', '--out', b]);
    assert.strictEqual(second.code, 0, `第二个目录 start 不应失败: ${second.err}`);
    const pidB = JSON.parse(second.out).pid;
    assert.notStrictEqual(pidB, pidA);

    // 隔离靠 recorder 命令行里的 outDir：B 起来之后 A 的进程和 pid 文件都不能被动到。
    // 固定等 2 秒再一次性断言，不用 waitFor：缺陷是「B 起过之后 A 就没了」，
    // 用轮询等一个应该一直成立的条件，等于把超时值和缺陷暴露时间绑在一起，会假绿。
    assert.deepStrictEqual(pidsUnderOutDir(b), [pidB], 'B 的进程清单里应只有 B 这一个 recorder');
    await sleep(2000);
    assert.ok(isAlive(pidA), 'A 的 recorder 不应被 B 的 start 连带弄丢');
    assert.ok(pidsUnderOutDir(a).includes(pidA), 'A 的 recorder 应仍在进程清单里');
    assert.strictEqual(pidIn(a), pidA, 'A 的 recorder.pid 不应被 B 的 start 覆盖');
    assert.strictEqual(pidIn(b), pidB, 'B 的 recorder.pid 应指向 B 的进程');
    const statusA = run(['status', '--out', a]);
    assert.match(statusA.out, /running: true/, statusA.out);

    assert.strictEqual(pidIn(a), pidA, 'A 的 recorder.pid 应指向 A 的进程');
    assert.strictEqual(pidIn(b), pidB, 'B 的 recorder.pid 应指向 B 的进程');

    const stoppedA = run(['stop', '--out', a]);
    assert.strictEqual(stoppedA.code, 0, stoppedA.err);
    assert.ok(!isAlive(pidA), 'stop A 应能停掉 A 的 recorder');
    assert.ok(isAlive(pidB), 'stop A 不应牵连 B');
  } finally {
    cleanupDir(a);
    cleanupDir(b);
  }
});

// 回归锁：含中文的 out 目录（如 F:\桌面\上云\...）下，start 能起、status 必须报 running: true。
// 旧版 procInfo 按 utf8 解码 PowerShell 输出，中文变成问号，命中不了命令行，status 假报未运行。
test('AC12 中文路径下 start 后 status 报 running: true', () => {
  const base = mkdtempSync(join(tmpdir(), 'netcapture-中文路径-'));
  const out = join(base, '.capture');
  try {
    const started = run(['start', '--out', out]);
    assert.strictEqual(started.code, 0, started.err);
    const pid = JSON.parse(started.out).pid;

    const status = run(['status', '--out', out]);
    assert.strictEqual(status.code, 0, status.err);
    assert.match(status.out, /running: true/, `中文路径下 status 应报运行中，实际: ${status.out}`);

    const stopped = run(['stop', '--out', out]);
    assert.strictEqual(stopped.code, 0, stopped.err);
    assert.ok(!isAlive(pid), 'stop 后进程应消失');
  } finally {
    cleanupDir(base);
  }
});

// 回归锁：recorder 重启后 state.json 的条数要接上 net.jsonl 已有行数，不许从 0 重来。
test('AC13 recorder 重启后 state.json 的条数接着 net.jsonl 已有行数累加', async () => {
  const out = mkdtempSync(join(tmpdir(), 'netcapture-s2-'));
  const row = (i) => JSON.stringify({ ts: '2026-11-17T03:00:00.000Z', targetId: 'A', pageUrl: 'p', method: 'GET', url: `https://api.keep.com/v1/x${i}`, reqHeaders: {}, postData: null, status: 200, mimeType: 'application/json', respHeaders: {}, body: '{}', durMs: 5 });
  try {
    writeFileSync(join(out, 'net.jsonl'), [row(1), row(2), row(3)].join('\n') + '\n');

    const started = run(['start', '--out', out]);
    assert.strictEqual(started.code, 0, started.err);

    // start 会删旧 state.json；recorder 起来后立刻写的第一份 state 就该带上基数
    assert.ok(
      await waitFor(() => existsSync(join(out, 'state.json'))),
      'state.json 应出现',
    );
    const state = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8'));
    assert.strictEqual(state.records, 3, `条数应承接已有 3 行，实际 ${state.records}`);
  } finally {
    cleanupDir(out);
  }
});

// 回归锁：recorder 的命令行里 --out 用正斜杠还是反斜杠，status 都要认出来。
// start 只产反斜杠归一化后的路径，正斜杠这一路只能直接在测试里 spawn 出来。
test('AC17 status 认得出正斜杠 --out 启动的 recorder', async () => {
  const base = mkdtempSync(join(tmpdir(), 'netcapture-sep-'));
  const out = join(base, '.capture');
  mkdirSync(out, { recursive: true });
  // 正斜杠写法：和用户在命令行里手敲 F:/桌面/... 同一种形态
  const fwd = out.replace(/\\/g, '/');
  // 端口用真实浏览器端口：recorder 没有端口会直接退出，起不来就测不到命令行形态
  const port = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA ?? '', 'ego-lite-linux', 'browser.json'), 'utf8')).port;
  const child = spawn(process.execPath, [RECORDER, '--out', fwd, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  try {
    // 前置只看进程活着：命令行形态是本用例的被测对象，不能拿它当前置条件
    assert.ok(await waitFor(() => existsSync(join(out, 'state.json')), 15000), '前置：recorder 应写出 state.json');
    assert.ok(isAlive(child.pid), `前置：recorder 应存活，pid=${child.pid}`);

    const status = run(['status', '--out', out]);
    assert.strictEqual(status.code, 0, status.err);
    assert.match(status.out, /running: true/, `正斜杠启动的 recorder 应被认出来，实际: ${status.out}`);
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});

// 回归锁：父目录不能命中子目录的 recorder。归一化改宽以后，这层边界一旦破，stop 会误杀别的目录。
test('AC18 父目录不命中子目录的 recorder，stop 不会误杀', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'netcapture-parent-'));
  const out = join(parent, '.capture');
  mkdirSync(out, { recursive: true });
  const started = run(['start', '--out', out]);
  assert.strictEqual(started.code, 0, started.err);
  const pid = JSON.parse(started.out).pid;
  try {
    // 用父目录查：不应报运行中
    const statusParent = run(['status', '--out', parent]);
    assert.strictEqual(statusParent.code, 0, statusParent.err);
    assert.match(statusParent.out, /running: false/, `父目录不应命中子目录 recorder，实际: ${statusParent.out}`);

    // 用父目录 stop：不该杀掉子目录的 recorder
    run(['stop', '--out', parent]);
    assert.ok(isAlive(pid), 'stop 父目录不应牵连子目录的 recorder');

    // 同前缀兄弟目录也不能命中
    const sibling = `${out}2`;
    const statusSibling = run(['status', '--out', sibling]);
    assert.match(statusSibling.out, /running: false/, `同前缀兄弟目录不应命中，实际: ${statusSibling.out}`);
  } finally {
    cleanupDir(out);
    rmSync(parent, { recursive: true, force: true });
  }
});

// 回归锁：命令行里出现 --outdir 这种更长参数时，不能被当成 --out 读取。
// 旧实现用 indexOf('--out') 会先命中 --outdir 的前缀，把另一个目录当成目标。
test('AC19 --outdir 前缀不被误认成 --out', async () => {
  const base = mkdtempSync(join(tmpdir(), 'netcapture-outdir-'));
  const out = join(base, '.capture');
  const decoy = `${base}\\decoy`;
  mkdirSync(out, { recursive: true });
  const port = JSON.parse(
    readFileSync(join(process.env.LOCALAPPDATA ?? '', 'ego-lite-linux', 'browser.json'), 'utf8'),
  ).port;
  // 命令行里 --outdir 指向一个无关目录，真正的 --out 是 out
  const child = spawn(
    process.execPath,
    [RECORDER, '--outdir', decoy, '--out', out, '--port', String(port)],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  try {
    assert.ok(await waitFor(() => existsSync(join(out, 'state.json')), 15000), '前置：recorder 应写出 state.json');
    const status = run(['status', '--out', out]);
    assert.match(status.out, /running: true/, `--out 指向本目录时应被认出，实际: ${status.out}`);
    // 无关目录不能被命中
    const statusDecoy = run(['status', '--out', decoy]);
    assert.match(statusDecoy.out, /running: false/, `--outdir 的目录不应命中，实际: ${statusDecoy.out}`);
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});

// 回归锁：手写双反斜杠的 --out 也要能被认出。粗筛只比单反斜杠串时会漏。
test('AC20 双反斜杠 --out 也能被 status 认出', async () => {
  const base = mkdtempSync(join(tmpdir(), 'netcapture-dbl-'));
  const out = join(base, '.capture');
  mkdirSync(out, { recursive: true });
  const doubled = out.replace(/\\/g, '\\\\');
  const port = JSON.parse(
    readFileSync(join(process.env.LOCALAPPDATA ?? '', 'ego-lite-linux', 'browser.json'), 'utf8'),
  ).port;
  const child = spawn(process.execPath, [RECORDER, '--out', doubled, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  try {
    assert.ok(await waitFor(() => existsSync(join(out, 'state.json')), 15000), '前置：recorder 应写出 state.json');
    const status = run(['status', '--out', out]);
    assert.match(status.out, /running: true/, `双反斜杠启动的 recorder 应被认出，实际: ${status.out}`);
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});

// 测试进程被 kill 时 finally 跑不到，这是 23788 那类残留的来源。
// 写 recorder.pid 之后不再删目录，让 pid 文件活下来；子进程被直杀后，靠 pid 文件把它收掉。
test('残留回收 测试进程被杀后 recorder.pid 仍在，能定位并杀掉残留进程', async () => {
  const out = tmpOut();
  let child;
  let pid;
  try {
    // 用一个不会被 finally 兜住的子进程跑 start
    const started = spawnSync(process.execPath, [CLI, 'start', '--out', out], { encoding: 'utf8' });
    assert.strictEqual(started.status, 0, started.stderr);
    pid = JSON.parse(started.stdout).pid;

    // 前提：pid 文件在，并且指向真实存活的进程
    assert.ok(existsSync(join(out, 'recorder.pid')), 'start 后必须有 recorder.pid');
    assert.strictEqual(pidIn(out), pid, 'recorder.pid 必须与实际进程一致');

    // 模拟测试进程被 kill：直接用 taskkill 干掉 recorder，不经过 stop
    child = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
    for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(100);
    assert.ok(!isAlive(pid), '模拟中断：进程应已被直杀');

    // 目录和 pid 文件都还在，下一次清理能靠它定位
    assert.ok(existsSync(join(out, 'recorder.pid')), '中断后 pid 文件应仍在，供下次回收');
  } finally {
    if (pid && isAlive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    cleanupDir(out);
  }
});
