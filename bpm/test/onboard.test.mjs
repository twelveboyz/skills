// 纳管适配器的行为测试。一个缝：注入的 HTTP 层。
// 假 http 按「URL 里含哪个路径」分派固定响应；断言的是适配器返回的结构与 CLI 渲染出来的文字，
// 不 mock 任何内部模块、不断言内部函数被调了几次。跑法：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOsaApi, wholeHostVerdict, attemptedHost, allAttempted } from '../lib/osa-api.mjs';
import { renderOnboard, exitCodeOf, exitReasonOf, toView, saveResult } from '../lib/onboard.mjs';
import { classifyOne, classifyBatch, loadRules, renderClassify } from '../lib/naguan-errors.mjs';

const OSA = 'http://10.19.105.29:8080';
const SEARCH = `${OSA}/osa_web/a/cmdb/project/cmdbProjectBpm/gridData4Search`;
const DETAILS = `${OSA}/osa_web/a/cmdb/project/cmdbProjectBpm/gridData4PublicAgentDetails`;
const MANAGEMENT = 'resource/management';

// 真实抓包里的行形状（E605，2026-11-25）：9 台，8 台三格「待检测」，1 台三格「安装失败」
const WAIT = '待检测';
const FAIL = '安装失败';
const OK = '已安装';

const searchRow = (agentValidateFlag, progress) => ({
  projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
  projectName: 'E605-2026_E605_云平台资源需求',
  seriesId: '1111011827874e7ba14e8e7153a83f5a',
  seriesName: '第一批',
  createTime: '2026-11-19 17:07',
  orderNo: '202610305033060',
  agentValidateStatus: { 0: '待验证', 2: '验证不通过', 3: '验证中' }[agentValidateFlag],
  agentValidateFlag: String(agentValidateFlag),
  agentInstallProgress: progress,
});

const host = (ip, flags, info = '') => ({
  deviceIp: ip,
  ipv6: '',
  agentInstallFlag: flags[0],
  zabbixAgentInstallFlag: flags[1],
  filebeatAgentInstallFlag: flags[2],
  agentInstallInfo: info,
  zabbixAgentInstallInfo: '',
  filebeatAgentInstallInfo: '',
  updateTime: '2026-11-25 17:11:38',
});

const emptyBatch = () => Array.from({ length: 9 }, () => host('', [WAIT, WAIT, WAIT]));
const installedBatch = () =>
  Array.from({ length: 9 }, (_, i) => host(`10.35.85.${10 + i}`, [OK, OK, OK]));

/// 造一个假 http：按 URL 里的路径分派；calls 记下每次请求，供「没打过某个接口」这类断言用。
function fakeHttp({ search, details, calls = [] }) {
  return async (url, { method = 'POST', form = '' } = {}) => {
    calls.push({ url, method, body: form });
    let body = null;
    if (url.includes('/gridData4Search')) body = search;
    else if (url.includes('/gridData4PublicAgentDetails')) body = details;
    assert.ok(body, `假 http 没配这个路径：${url}`);
    return {
      status: 200,
      headers: new Headers([['content-type', 'application/json']]),
      text: async () => JSON.stringify(body),
    };
  };
}

const statusFor = (projectId, http) =>
  createOsaApi({ http }).batchStatus({ projectId });

// ---- 正常出数 ----

test('已纳管过的批次：工单级进度 0/27，9 台逐台三格，失败主机带 IP 与报错原文', async () => {
  const rows = emptyBatch();
  rows[8] = host('10.35.85.129', [FAIL, FAIL, FAIL], 'bash: /tmp/install.sh: Permission denied\n');
  const calls = [];
  const http = fakeHttp({
    calls,
    search: { total: 1, rows: [searchRow(2, '0/27')] },
    details: { total: 9, rows },
  });

  const res = await statusFor('ee1f958e96ea4754a1620fd720cc35bf', http);

  assert.equal(res.batch.projectName, 'E605-2026_E605_云平台资源需求');
  assert.equal(res.batch.seriesName, '第一批');
  assert.equal(res.orderNo, '202610305033060');
  assert.equal(res.progress, '0/27');
  assert.equal(res.agentValidateStatus, '验证不通过');
  assert.equal(res.hosts.length, 9);
  assert.deepEqual(
    res.hosts.map((h) => [h.deviceIp, h.agent, h.zabbix, h.filebeat]),
    [
      ['', WAIT, WAIT, WAIT],
      ['', WAIT, WAIT, WAIT],
      ['', WAIT, WAIT, WAIT],
      ['', WAIT, WAIT, WAIT],
      ['', WAIT, WAIT, WAIT],
      ['', WAIT, WAIT, WAIT],
      ['', WAIT, WAIT, WAIT],
      ['', WAIT, WAIT, WAIT],
      ['10.35.85.129', FAIL, FAIL, FAIL],
    ],
  );
  assert.equal(res.hosts[8].agentInstallInfo, 'bash: /tmp/install.sh: Permission denied\n');
  assert.equal(res.hostCount, 9);
  assert.match(res.touched, /17:11:38$/);
});

test('--status 是只读：全程一次 resource/management 请求都没有', async () => {
  const calls = [];
  const http = fakeHttp({
    calls,
    search: { total: 1, rows: [searchRow(0, '/')] },
    details: { total: 9, rows: emptyBatch() },
  });

  await statusFor('ee1f958e96ea4754a1620fd720cc35bf', http);

  assert.equal(calls.length, 2, '只该打两个只读接口');
  assert.deepEqual(
    calls.map((c) => (c.url.includes('/gridData4Search') ? 'search' : 'details')),
    ['search', 'details'],
  );
  for (const c of calls) assert.equal(c.method, 'POST');
  assert.ok(
    calls.every((c) => !c.url.includes(MANAGEMENT)),
    `不该出现写接口：${calls.map((c) => c.url).join('  ')}`,
  );
});

test('没纳管过的批次：全「待检测」、deviceIp 全空、进度「/」', async () => {
  const http = fakeHttp({
    search: { total: 1, rows: [searchRow(0, '/')] },
    details: { total: 9, rows: emptyBatch() },
  });

  const res = await statusFor('ee1f958e96ea4754a1620fd720cc35bf', http);

  assert.equal(res.progress, '/');
  assert.equal(res.agentValidateStatus, '待验证');
  assert.equal(res.hosts.length, 9);
  assert.deepEqual(
    res.hosts.map((h) => [h.deviceIp, h.agent, h.zabbix, h.filebeat]),
    Array.from({ length: 9 }, () => ['', WAIT, WAIT, WAIT]),
  );
});

test('进度三种形态原样透出：/ 、0/27 、2/27', async () => {
  for (const progress of ['/', '0/27', '2/27']) {
    const http = fakeHttp({
      search: { total: 1, rows: [searchRow(progress === '/' ? 0 : 3, progress)] },
      details: { total: 9, rows: emptyBatch() },
    });
    const res = await statusFor('ee1f958e96ea4754a1620fd720cc35bf', http);
    assert.equal(res.progress, progress);
  }
});

// ---- CLI 渲染 ----

test('渲染：批次信息一行、进度一行、每台一行三格，「/」写成「未开始」', async () => {
  const http = fakeHttp({
    search: { total: 1, rows: [searchRow(0, '/')] },
    details: { total: 9, rows: emptyBatch() },
  });
  const text = renderOnboard(await statusFor('ee1f958e96ea4754a1620fd720cc35bf', http));

  assert.match(text, /^E605-2026_E605_云平台资源需求 \/ 第一批 {2}工单 202610305033060$/m);
  assert.match(text, /^进度 未开始 {2}待验证 {2}9 台$/m);
  assert.equal(text.split('\n').filter((l) => /^ \S (10\.|\(空\))/.test(l)).length, 9);
  // 行首是「空格 + 标记 + 空格」：标记是空格时前缀占三个字符
  assert.match(text, / … \(空\)  待检测  待检测  待检测$/m);
});

test('渲染：9 台的格子数正好 27 格；失败主机标出 ✘ 与报错原文', async () => {
  const rows = emptyBatch();
  rows[8] = host('10.35.85.129', [FAIL, FAIL, FAIL], 'bash: /tmp/install.sh: Permission denied\n');
  const http = fakeHttp({
    search: { total: 1, rows: [searchRow(2, '0/27')] },
    details: { total: 9, rows },
  });
  const text = renderOnboard(await statusFor('ee1f958e96ea4754a1620fd720cc35bf', http));

  assert.match(text, /^进度 0\/27 {2}验证不通过 {2}9 台$/m);
  assert.match(text, /✘ 10\.35\.85\.129\s+安装失败\s+安装失败\s+安装失败/);
  assert.match(text, /bash: \/tmp\/install\.sh: Permission denied/);
  // 只数三格都是状态词的机器行，别把下面的报错原文算进去
  // 行首「空格 + 标记 + 空格」：标记是 ✘ / … / 空格三种
  const cells = text
    .split('\n')
    .filter((l) => /^ [✘… ] \S+ +(待检测|安装中|安装失败|已安装)( +(待检测|安装中|安装失败|已安装)){2}$/.test(l));
  assert.equal(cells.length, 9);
  // 逐台那一段共 27 格：24 格待检测 + 3 格失败；合计行里的「待检测」不算
  assert.equal(cells.join('\n').match(/待检测/g).length, 24, '8 台 × 3 格');
  assert.equal(cells.join('\n').match(/安装失败/g).length, 3);
});

test('渲染：同一份结果渲染两次，文字一致', async () => {
  const http = () =>
    fakeHttp({ search: { total: 1, rows: [searchRow(3, '2/27')] }, details: { total: 9, rows: emptyBatch() } });
  const a = renderOnboard(await statusFor('ee1f958e96ea4754a1620fd720cc35bf', http()));
  const b = renderOnboard(await statusFor('ee1f958e96ea4754a1620fd720cc35bf', http()));
  assert.equal(a, b);
});

// ---- 票 02：点纳管、等到出结果、报整台结论 ----
// 第二个缝：BPM 的触发纳管（它走 lib/bpm.mjs 的 call()，不走 osa_web 的 CDP http 层）。
// 假的 trigger 只记下被点了几次、点的哪个订单号，绝不真连 BPM。

const SEM = 1_000_000; // 轮询间隔用极小值：测试不真的等
const NO_WAIT = { pollMs: 1, timeoutMs: 50 };

/// 假 trigger：记下每次点的订单号；calls 里放它的调用记录供断言。
function fakeTrigger(calls = []) {
  return async (orderNo) => {
    calls.push({ orderNo });
    return { state: 'success', message: '' };
  };
}

/// 让假 http 按「第几次被问」回一串快照：用来演「先验证中、后出结果」。
/// plan 是 [search, details] 的数组，第 i 次快照用 plan[i]（用完就停在最后一个）。
function sequencedHttp(plan, calls = []) {
  let i = -1;
  return async (url, { method = 'POST', form = '' } = {}) => {
    if (url.includes('/gridData4Search')) i += 1;
    calls.push({ url, method, body: form });
    const [search, details] = plan[Math.min(i, plan.length - 1)];
    const body = url.includes('/gridData4Search') ? search : details;
    return { status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
  };
}

/// 按调用次数往前跳的假时钟：watch 的到点判据靠它，测试不真的等一分钟。
function ticking(step) {
  let t = 0;
  return () => (t += step);
}

/// 换掉数组里的第 i 项（造「这一台已经跑完、其余还没轮到」的快照）
const replaceAt = (arr, i, v) => arr.map((x, k) => (k === i ? v : x));

/// 让假 http 按「第几次被问」回不同快照：用来演「先验证中、后出结果」。
function scriptedHttp({ search, details, calls = [] }) {  // 点纳管之前的那份快照：从没纳管过（flag 0、deviceIp 全空、全待检测）
  const fresh = { total: 1, rows: [searchRow(0, '/')] };
  return async (url, { method = 'POST', form = '' } = {}) => {
    calls.push({ url, method, body: form });
    const n = calls.length;
    // 头两个请求是「点纳管之前」的那份快照：工单级还在验证中，逐台全待检测
    const before = n <= 2;
    const isSearch = url.includes('/gridData4Search');
    const body = before
      ? isSearch ? fresh : { total: 9, rows: emptyBatch() }
      : isSearch ? search : details;
    return { status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
  };
}

test('没纳管过：点一次纳管，等到终态，报出成功台数与失败台数、每台 IP 与结论', async () => {
  const rows = installedBatch();
  rows[8] = host('10.35.85.129', [FAIL, FAIL, FAIL], 'bash: /tmp/install.sh: Permission denied\n');
  const sb = [];
  const calls = [];
  const http = scriptedHttp({ calls, search: { total: 1, rows: [searchRow(2, '27/27')] }, details: { total: 9, rows } });

  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(sb),
    ...NO_WAIT,
  });

  assert.deepEqual(sb.map((c) => c.orderNo), ['202610305033060'], '没纳管过就该点一次纳管');
  assert.equal(res.triggered, true);
  assert.equal(res.terminal, true, '终态：工单级 2 且逐台无待检测');
  assert.equal(res.okCount, 8);
  assert.equal(res.failCount, 1);
  assert.deepEqual(res.failed.map((h) => h.deviceIp), ['10.35.85.129']);
  assert.equal(
    calls.filter((c) => c.url.includes(MANAGEMENT)).length,
    0,
    'resource/management 走 BPM 的 trigger，不该出现在 osa_web 的 http 层里',
  );

  const text = renderOnboard(res);
  assert.match(text, /成功 8 台/);
  assert.match(text, /失败 1 台/);
  assert.match(text, /10\.35\.85\.129/);
});

test('已经纳管过的批次：只打当前状态，一次纳管都不点', async () => {
  const calls = [];
  const http = fakeHttp({
    calls,
    search: { total: 1, rows: [searchRow(3, '2/27')] },
    details: { total: 9, rows: [host('10.35.85.10', [OK, OK, WAIT])] },
  });
  const sb = [];

  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(sb),
    ...NO_WAIT,
  });

  assert.deepEqual(sb, [], '已经纳管过：不该点纳管');
  assert.equal(res.triggered, false);
  assert.equal(calls.filter((c) => c.url.includes(MANAGEMENT)).length, 0, 'resource/management 一次都不许出现');
  assert.match(renderOnboard(res), /进度 2\/27/);
});

test('--install：已经纳管过也再点一次，然后继续等', async () => {
  const sb = [];
  const rows = installedBatch();
  const http = scriptedHttp({ search: { total: 1, rows: [searchRow(2, '27/27')] }, details: { total: 9, rows } });

  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(sb),
    reinstall: true,
    ...NO_WAIT,
  });

  assert.deepEqual(sb.map((c) => c.orderNo), ['202610305033060'], '--install 必须重打一次');
  assert.equal(res.triggered, true);
  assert.equal(res.terminal, true);
  assert.equal(res.okCount, 9);
});

test('工单级已离开「验证中」但仍有格子「待检测」：不判终态，继续等', async () => {
  const halfway = { total: 9, rows: [host('10.35.85.10', [OK, OK, WAIT]), ...installedBatch().slice(1, 9)] };
  const done = { total: 9, rows: installedBatch() };
  const http = sequencedHttp([
    [{ total: 1, rows: [searchRow(0, '/')] }, { total: 9, rows: emptyBatch() }], // 没纳管过
    [{ total: 1, rows: [searchRow(2, '26/27')] }, halfway], // 工单级已 2，但还有一格待检测
    [{ total: 1, rows: [searchRow(2, '27/27')] }, done],
  ]);

  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(),
    ...NO_WAIT,
  });

  assert.equal(res.terminal, true, '最后一格落地后才算终态');
  assert.equal(res.okCount, 9, '9 台的 27 格全已安装');
  assert.notEqual(
    halfway.rows.some((h) => [h.agentInstallFlag, h.zabbixAgentInstallFlag, h.filebeatAgentInstallFlag].includes(WAIT)),
    false,
    '中间那份快照确实还有待检测格，否则这条测试什么也没验到',
  );
});

test('一台里只有一格失败，整台判失败，不算进成功台数', async () => {
  const rows = installedBatch();
  rows[3] = host('10.35.85.13', [OK, FAIL, OK], 'zabbix: port 10050 refused\n');
  const http = scriptedHttp({ search: { total: 1, rows: [searchRow(2, '27/27')] }, details: { total: 9, rows } });

  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(),
    ...NO_WAIT,
  });

  assert.equal(res.okCount, 8);
  assert.deepEqual(res.failed.map((h) => h.deviceIp), ['10.35.85.13']);
  const text = renderOnboard(res);
  assert.match(text, /成功 8 台，失败 1 台/);
  assert.match(text, /成功 8 台/);
});

test('工单级还在「验证中」、逐台已全落地：也不判终态', async () => {
  // 反向那一半：两层判的任何一层没满足都得继续等，不能只认逐台
  const done = { total: 9, rows: installedBatch() };
  const http = sequencedHttp([
    [{ total: 1, rows: [searchRow(0, '/')] }, { total: 9, rows: emptyBatch() }],
    [{ total: 1, rows: [searchRow(3, '27/27')] }, done], // 全已安装，但工单级还在验证中
    [{ total: 1, rows: [searchRow(2, '27/27')] }, done],
  ]);
  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(),
    ...NO_WAIT,
  });
  assert.equal(res.terminal, true);
  assert.equal(res.agentValidateFlag, '2', '停在同一份快照上：flag 已不再是 3');
});

// ---- --watch：只读盯着排队跑完 ----
// 判据是「每台都轮到过」：osa 逐台执行，没轮到的台 IP 空、三格全待检测；失败也算轮过。
// 这三条测的是「轮到过」的认定与收工时机，不是「跑成功」。

test('排队口径：IP 空且三格全待检测 = 没轮到；IP 出来、任一格离开待检测、或三格全失败 = 轮到过', () => {
  // attemptedHost 吃的是 batchStatus 归一化之后的行（agent/zabbix/filebeat 三格），不是接口原始行
  const norm = (ip, flags) => ({ deviceIp: ip, agent: flags[0], zabbix: flags[1], filebeat: flags[2] });
  assert.equal(attemptedHost(norm('', [WAIT, WAIT, WAIT])), false, '还没轮到');
  assert.equal(attemptedHost(norm('10.35.85.64', [WAIT, WAIT, WAIT])), true, 'IP 出来就算轮到（在装）');
  assert.equal(attemptedHost(norm('', [WAIT, '安装中', WAIT])), true, '格子在装也算轮到');
  assert.equal(attemptedHost(norm('10.35.85.64', [FAIL, FAIL, FAIL])), true, '失败也算轮过');
  assert.equal(attemptedHost(norm('10.35.85.64', [OK, OK, OK])), true, '成功算轮过');
  // 九台里八台没轮到：全台没跑完；最后一台也轮到了才算收工
  assert.equal(allAttempted({ hosts: [] }), true, '空批次不许卡死轮询');
  assert.equal(
    allAttempted({ hosts: Array.from({ length: 9 }, () => norm('', [WAIT, WAIT, WAIT])) }),
    false,
  );
  assert.equal(
    allAttempted({ hosts: Array.from({ length: 9 }, () => norm('10.35.85.10', [OK, OK, OK])) }),
    true,
  );
});

test('--watch：每轮快照推进一台，直到九台全轮到过才收工；全程一次纳管都不点', async () => {
  const plan = [
    [{ total: 1, rows: [searchRow(2, '0/27')] }, { total: 9, rows: emptyBatch() }],
    [
      { total: 1, rows: [searchRow(2, '1/27')] },
      { total: 9, rows: replaceAt(emptyBatch(), 0, host('10.35.85.64', [FAIL, FAIL, FAIL], 'bash: /tmp/install.sh: Permission denied')) },
    ],
    [
      { total: 1, rows: [searchRow(2, '2/27')] },
      { total: 9, rows: installedBatch() },
    ],
  ];
  const calls = [];
  const rounds = [];
  const api = createOsaApi({ http: sequencedHttp(plan, calls) });

  const res = await api.watchOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    pollMs: 1,
    now: ticking(1),
    onChange: (snap, round) => rounds.push([round, snap.attemptedCount]),
  });

  assert.equal(res.watched, true);
  assert.equal(res.watchRounds, 3, '三轮快照：0 → 1 → 9 台轮到过');
  assert.equal(res.allAttempted, true);
  assert.equal(res.timedOut, false);
  assert.deepEqual(rounds, [[1, 0], [2, 1], [3, 9]]);
  assert.equal(calls.filter((c) => c.url.includes(MANAGEMENT)).length, 0, 'watch 是只读的');
});

test('--watch：到点还有台没轮到 → 停在快照上并标 timedOut，不假装跑完', async () => {
  const plan = [[{ total: 1, rows: [searchRow(2, '0/27')] }, { total: 9, rows: emptyBatch() }]];
  const api = createOsaApi({ http: sequencedHttp(plan) });

  // now 一次跳一分钟：没两轮就过 30 秒的时限
  const res = await api.watchOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    pollMs: 1000,
    timeoutMs: 30_000,
    now: ticking(60_000),
  });

  assert.equal(res.timedOut, true);
  assert.equal(res.allAttempted, false);
  assert.equal(res.attemptedCount, 0);
  assert.equal(res.hostCount, 9, '超时也把当前快照原样给出来');
});

test('--watch 的快照带排队口径：attemptedCount 数「轮到过」的台，报告里写成 N/M', async () => {
  const rows = emptyBatch();
  rows[0] = host('10.35.85.64', [FAIL, FAIL, FAIL], 'bash: /tmp/install.sh: Permission denied');
  rows[1] = host('10.35.85.128', [FAIL, FAIL, FAIL], 'bash: /tmp/install.sh: Permission denied');
  const res = await statusFor(
    'ee1f958e96ea4754a1620fd720cc35bf',
    fakeHttp({ search: { total: 1, rows: [searchRow(2, '2/27')] }, details: { total: 9, rows } }),
  );

  assert.equal(res.attemptedCount, 2);
  assert.equal(res.allAttempted, false);
  const text = renderOnboard(res);
  assert.match(text, /已轮到 2\/9 台/);
  assert.match(text, /还有 7 台在排队/);
  // 全轮过之后报告要给结论，不能因为没走 runOnboard 就把成功/失败台数咽掉
  const done = renderOnboard({ ...res, attemptedCount: 9, allAttempted: true, terminal: false });
  assert.match(done, /全部轮过一遍/);
  assert.match(done, /成功 0 台，失败 2 台/);
});

// ---- 票 04：按报错类型分类 ----
// 规则表是数据不是代码：分类函数是纯函数，输入只有报错原文集合；规则表路径可注入。
// 每个用例自带一份最小规则表，绝不读生产的那份 —— 生产表加规则不会把这里的断言带跑。

const RULES = [
  { type: 'tmp_not_executable', group: '能修', disposition: '主机上 /tmp 或 /tmp/install.sh 不可执行', suggest: 'chmod 777 /tmp; chmod 777 /tmp/install.sh', auto_fix: true, fixable: true, match: ['Permission denied', '/tmp'] },
  { type: 'zbx_template_missing', group: '要找人', disposition: '资源池缺模板，联系监控中心给该资源池添加模板', suggest: '联系监控中心给该资源池添加模板', auto_fix: false, fixable: false, match: ['模板', '不存在', '资源池'], match_mode: 'all' },
  { type: 'proxy_port_unreachable', group: '要找人', disposition: '端口不通，确认对等连接是否建立', suggest: '确认对等连接是否建立', auto_fix: false, fixable: false, match: ['端口', '连接', '网络不通'], match_mode: 'any' },
];

/// 按 classifyBatch 的口径把一串原文归一遍：这条是匹配的单元测试（不造整台结果）。
/// 归类本身只有 classifyOne 一个出口，这里只把结果摆成 {errors, unknown}。
function classifyOf(raws, base) {
  const { rules } = Array.isArray(base) ? { rules: base } : base;
  const all = raws.map((r) => classifyOne(r, rules));
  return { errors: all.filter((c) => c.type !== 'unknown'), unknown: all.filter((c) => c.type === 'unknown') };
}
/// 报告分组的说明（与生产规则表同形）：组名 → 一句话。组顺序就是渲染顺序。
const GROUPS = {
  '能修': '本机能处理，修完再重装',
  '要找人': '得别人动手，我们等或去问',
  '还没结论': '认不出的原文，只记录不下结论',
};

const PERMISSION = 'bash: /tmp/install.sh: Permission denied';
const TEMPLATE = 'zabbix agent install failed: 资源池 模板 不存在';
const PROXY = 'connect to proxy 10.19.0.1:10051 failed: 连接超时';

test('分类：权限不足原文归 tmp_not_executable，并带出 chmod 建议', () => {
  const c = classifyOf([PERMISSION], RULES);
  assert.equal(c.unknown.length, 0);
  assert.equal(c.errors.length, 1);
  assert.equal(c.errors[0].type, 'tmp_not_executable');
  assert.equal(c.errors[0].group, '能修');
  assert.equal(c.errors[0].fixable, true);
  assert.equal(c.errors[0].suggest, 'chmod 777 /tmp; chmod 777 /tmp/install.sh');
  assert.equal(c.errors[0].raw, PERMISSION);
});

test('分类：模板不存在原文归 zbx_template_missing，并带出「联系监控中心」', () => {
  const c = classifyOf([TEMPLATE], RULES);
  const e = c.errors[0];
  assert.equal(e.type, 'zbx_template_missing');
  assert.match(e.suggest, /联系监控中心/);
});

test('分类：端口不通原文归 proxy_port_unreachable，并带出「确认对等连接」', () => {
  const c = classifyOf([PROXY], RULES);
  const e = c.errors[0];
  assert.equal(e.type, 'proxy_port_unreachable');
  assert.match(e.suggest, /确认对等连接/);
});

test('分类：陌生原文归 unknown，只记录不生效，不进「能修」组', () => {
  const odd = 'segmentation fault while unpacking';
  const c = classifyOf([odd], RULES);
  assert.equal(c.errors.length, 0);
  assert.equal(c.unknown[0].raw, odd);
  // 未知不产生任何可修标记和命令
  assert.equal(c.unknown[0].group, '还没结论');
  assert.equal(c.unknown[0].fixable, false);
  assert.equal(c.unknown[0].suggest, '');
  assert.deepEqual(classifyOf([odd], RULES).errors, [], '绝不因为见到陌生报错就自动变成规则');
});

test('分类：只有含有无原文的主机，什么都不归，也不抛', () => {
  const c = classifyOf([], RULES);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.unknown, []);
});

test('分类：匹配顺序从上到下，第一条命中即归类', () => {
  // 同一段原文既像权限又像端口：权限规则在前，就该归权限
  const both = 'Permission denied /tmp/install.sh; connect 端口 10050 连接失败';
  const c = classifyOf([both], RULES);
  assert.equal(c.errors.length, 1);
  assert.equal(c.errors[0].type, 'tmp_not_executable');
});

test('分类：规则表加一条新规则，不改代码就生效', () => {
  const raw = 'disk quota exceeded';
  assert.equal(classifyOf([raw], RULES).unknown[0].raw, raw, '生产规则里没有这条：先归未知');

  const withNew = [...RULES, { type: 'disk_full', group: '能修', disposition: '磁盘满', suggest: 'df -h /', auto_fix: false, fixable: true, match: ['disk quota'] }];
  const c = classifyOf([raw], withNew);
  assert.equal(c.unknown.length, 0);
  assert.equal(c.errors[0].type, 'disk_full');
  assert.equal(c.errors[0].group, '能修');
});

test('分类：规则文件路径可注入，读一份临时规则表就按它归类', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpm-rules-'));
  const file = path.join(dir, 'rules.json');
  fs.writeFileSync(file, JSON.stringify({ rules: [{ type: 'only_here', group: '要找人', disposition: 'd', suggest: 's', match: ['only me'], fixable: false }] }));
  try {
    const c = classifyOf(['only me'], loadRules(file));
    assert.equal(c.errors[0].type, 'only_here');
    assert.equal(classifyOf(['only me'], loadRules()).errors.length, 0, '默认读生产表，不认这条');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('生产规则表能读出三条起步规则', () => {
  const { rules, groups } = loadRules();
  assert.deepEqual(
    rules.map((r) => r.type),
    ['tmp_not_executable', 'zbx_template_missing', 'proxy_port_unreachable'],
  );
  assert.deepEqual(
    rules.map((r) => r.group),
    ['能修', '要找人', '要找人'],
  );
  assert.equal(rules[0].suggest, 'chmod 777 /tmp; chmod 777 /tmp/install.sh');
  assert.match(rules[1].suggest, /联系监控中心/);
  assert.match(rules[2].suggest, /确认对等连接/);
});

test('规则表：删掉一条规则，这段原文就退回「还没结论」', () => {
  const raw = 'bash: /tmp/install.sh: Permission denied';
  assert.equal(classifyOf([raw], RULES).errors[0].type, 'tmp_not_executable', '生产规则认得它');
  const fewer = RULES.filter((r) => r.type !== 'tmp_not_executable');
  const c = classifyOf([raw], fewer);
  assert.equal(c.errors.length, 0, '规则没了就不该再分类');
  assert.equal(c.unknown[0].group, '还没结论');
});

test('规则表：加一条规则 + 在 groups 里登记组名，报告就多出这一组', () => {
  const raw = 'disk quota exceeded';
  const rules = [...RULES, { type: 'disk_full', group: '得换机器', disposition: '磁盘满', fixable: true, match: ['disk quota'] }];
  const base = { rules, groups: { ...GROUPS, 得换机器: '申请换一台重装' } };
  const one = classifyBatch({ hosts: [{ deviceIp: '10.0.0.1', agentInstallInfo: raw }] }, base);
  assert.equal(one.errors[0].type, 'disk_full');
  const lines = renderClassify(one).join(String.fromCharCode(10));
  assert.match(lines, /^【得换机器】 申请换一台重装$/m, '组标题与说明来自规则表那份 groups');
  assert.match(lines, /^  disk_full  1 台$/m);
  // 只加规则、不在 groups 里登记：组名照样单独成组出现在末尾，不吞条目
  const loose = renderClassify(classifyBatch({ hosts: [{ deviceIp: '10.0.0.2', agentInstallInfo: raw }] }, { rules, groups: {} })).join(String.fromCharCode(10));
  assert.match(loose, /^【得换机器】$/m);
  assert.match(loose, /^  disk_full  1 台$/m);
});

test('规则表：scope 钉住「只看三个安装信息格」——不在三格里的原文不进分类', () => {
  const h = {
    deviceIp: '10.0.0.9',
    agent: '安装失败',
    zabbix: '安装失败',
    filebeat: '安装失败',
    agentInstallInfo: '',
    zabbixAgentInstallInfo: '',
    filebeatAgentInstallInfo: '',
    // 主机上别处的报错（不属于三个安装信息格）：scope 不认它
    updateTime: PERMISSION,
  };
  const c = classifyBatch({ hosts: [h] }, { rules: RULES, groups: GROUPS });
  assert.equal(c.errors.length, 0);
  assert.equal(c.unknown.length, 0, '不在三格里的原文连「还没结论」都不进');
});

test('规则表：auto_fix 只在「fixable 且有本机命令」时才为真', () => {
  const rules = [
    { type: 'a', group: '能修', fixable: true, auto_fix: true, match: ['aa'] },
    { type: 'b', group: '能修', fixable: false, auto_fix: true, match: ['bb'] },
    { type: 'c', group: '能修', fixable: true, auto_fix: false, match: ['cc'] },
  ];
  const [a, b, cc] = ['aa', 'bb', 'cc'].map((r) => classifyOne(r, rules));
  assert.equal(a.auto_fix, true);
  assert.equal(b.auto_fix, false, '没有明确处置的规则不能自称能自动修');
  assert.equal(cc.auto_fix, false);
});

test('规则表：生产那份里每个组名都在 groups 里登记过（报告不会出现无说明的组）', () => {
  const { rules, groups } = loadRules();
  for (const r of rules) assert.ok(r.group in groups, `组名没登记：${r.group}`);
  for (const r of rules) assert.ok(['installInfo'].includes(r.scope || 'installInfo'), `scope 只认 installInfo：${r.type}`);
});

// 汇总：把逐台结果按「整台三格合并后的原文」归一次，再挂上 IP
function summarise(raws, rules = RULES) {
  const hosts = raws.map((h) => ({ agent: h.agentInstallFlag, zabbix: h.zabbixAgentInstallFlag, filebeat: h.filebeatAgentInstallFlag, ...h }));
  const res = { projectId: 'p', batch: { projectName: 'x', seriesId: 's', seriesName: '第一批' }, orderNo: '202610305033060', agentValidateStatus: '验证不通过', agentValidateFlag: '2', progress: '0/27', hostCount: hosts.length, cellCount: hosts.length * 3, installedCount: 0, pendingCount: 0, terminal: true, hosts };
  return { ...res, ...wholeHostVerdict(res), classify: classifyBatch(res, rules) };
}

test('汇总：一台里有报错原文，另两个格空着，照样按整台原文归类', () => {
  const s = summarise([host('10.35.85.129', [FAIL, FAIL, FAIL], PERMISSION)]);
  assert.equal(s.classify.errors.length, 1);
  assert.deepEqual(s.classify.errors[0].hosts, ['10.35.85.129']);
});

test('汇总：同一段原文命中多台，只列一行并列出全部 IP', () => {
  const s = summarise([
    host('10.35.85.129', [FAIL, FAIL, FAIL], PERMISSION),
    host('10.35.85.130', [FAIL, OK, FAIL], PERMISSION),
    host('10.35.85.131', [FAIL, FAIL, FAIL], TEMPLATE),
  ]);
  const e = s.classify.errors.find((x) => x.type === 'tmp_not_executable');
  assert.equal(e.hosts.length, 2);
  assert.deepEqual(e.hosts, ['10.35.85.129', '10.35.85.130']);
  assert.deepEqual(s.classify.errors.map((x) => x.type), ['tmp_not_executable', 'zbx_template_missing']);
});

test('汇总：一台三格报同一段原文，只算一行一行 IP', () => {
  const h = host('10.35.85.129', [FAIL, FAIL, FAIL], PERMISSION);
  h.zabbixAgentInstallInfo = PERMISSION;
  h.filebeatAgentInstallInfo = PERMISSION + '\n';
  const s = summarise([h]);
  assert.equal(s.classify.errors.length, 1);
  assert.deepEqual(s.classify.errors[0].hosts, ['10.35.85.129']);
});

test('报告：按类型分组，同一段原文只出现一次，未知进「还没结论」组', () => {
  const odd = 'segmentation fault while unpacking';
  const rows = [
    host('10.35.85.129', [FAIL, FAIL, FAIL], PERMISSION),
    host('10.35.85.130', [FAIL, FAIL, FAIL], PERMISSION),
    host('10.35.85.131', [FAIL, FAIL, FAIL], TEMPLATE),
    host('10.35.85.132', [FAIL, FAIL, FAIL], PROXY),
    host('10.35.85.133', [FAIL, FAIL, FAIL], odd),
  ];
  const text = renderOnboard(summarise(rows));

  assert.match(text, /^【能修】/m);
  assert.match(text, /^  tmp_not_executable {2}2 台$/m);
  assert.match(text, /chmod 777 \/tmp; chmod 777 \/tmp\/install\.sh/);
  assert.match(text, /^【要找人】/m);
  assert.match(text, /^  zbx_template_missing {2}1 台$/m);
  assert.match(text, /联系监控中心/);
  assert.match(text, /^  proxy_port_unreachable {2}1 台$/m);
  assert.match(text, /确认对等连接/);
  assert.match(text, /^【还没结论】/m);
  assert.match(text, /^  unknown {2}1 台$/m);
  assert.match(text, /segmentation fault while unpacking/);
  // 同一段原文只在分类那一行出现一次：两台同时命中，也只打一行
  assert.equal(text.split('bash: /tmp/install.sh: Permission denied').length - 1, 1, '同一段原文只出现一次');
  // 未知不进「能修」组：能修那一段里不许出现陌生原文
  const fixBlock = text.split('【能修】')[1].split('【要找人】')[0];
  assert.ok(!fixBlock.includes('segmentation fault'), fixBlock);
});

test('报告：结尾提示云安全中心 agent 另走 ec-agent-install', () => {
  assert.match(renderOnboard(summarise([host('10.35.85.129', [FAIL, FAIL, FAIL], PERMISSION)])), /云安全中心 agent 另走 ec-agent-install/);
  assert.match(renderOnboard(summarise([])), /云安全中心 agent 另走 ec-agent-install/, '没有失败主机也要提示');
});

// ---- C：还在装的机器不许并进「安装失败」，也不许变成分类行 ----

test('安装中：算「还在装」，不进失败台数，单独一句说清是哪几台', () => {
  const s = summarise([
    host('10.35.85.10', [OK, OK, OK]),
    host('10.35.85.11', [FAIL, FAIL, FAIL], PERMISSION),
    host('10.35.85.12', [OK, '安装中', '安装中']),
  ]);
  assert.equal(s.failCount, 1, '还在装的那台不算失败');
  assert.equal(s.okCount, 1);
  assert.deepEqual(s.running.map((h) => h.deviceIp), ['10.35.85.12']);
  const text = renderOnboard(s);
  assert.match(text, /还在装（没出结果，不算失败也不算成功）1 台：10\.35\.85\.12/);
  assert.match(text, /失败 1 台：10\.35\.85\.11/, '失败那句只点真失败的');
  const failLine = text.split(String.fromCharCode(10)).find((l) => l.startsWith('失败 1 台'));
  assert.doesNotMatch(failLine, /10\.35\.85\.12/, '还在装的不许出现在失败名单里');
});

test('安装中：逐台标记是 …，不是 ✘', () => {
  const text = renderOnboard(summarise([host('10.35.85.12', ['安装中', OK, OK])]));
  assert.match(text, /^ … 10\.35\.85\.12/m);
  assert.doesNotMatch(text, /✘ 10\.35\.85\.12/);
});

test('安装中：只装了半台的机器没有报错原文，也不该冒出分类行', () => {
  const s = summarise([host('10.35.85.12', ['安装中', OK, OK])]);
  assert.equal(s.classify.errors.length, 0);
  assert.equal(s.classify.unknown.length, 0);
  assert.doesNotMatch(renderOnboard(s), /【能修】|【还没结论】/);
});

test('一格「安装失败」但没有报错原文：不许假装分类过，要点名「服务端没写原因」', () => {
  // 格子里写着「安装失败」，但报错原文的位置一格都没有字（接口偶尔就这么回）
  const h = host('10.35.85.13', ['', '', ''], '');
  h.agent = h.zabbix = h.filebeat = FAIL;
  const s = summarise([h]);
  assert.equal(s.failCount, 1);
  assert.equal(s.uncleared.length, 1, '没原文的得单独点名');
  const text = renderOnboard(s);
  assert.match(text, /10\.35\.85\.13 没有报错原文（服务端没写原因）/);
  assert.doesNotMatch(text, /【能修】/);
});

// ---- 票 05：退出码定案 ----
// 判定只看「结果」不看「渲染」：全部成功 0；有失败或未知 1；超时 1（报告明说超时）；参数错误 2 由 CLI 给。

test('退出码：9 台三格全已安装 → 0', () => {
  assert.equal(exitCodeOf(summarise(installedBatch())), 0);
});

test('退出码：一台里只有一格失败 → 1', () => {
  const s = summarise([...installedBatch().slice(0, 8), host('10.35.85.129', [OK, FAIL, FAIL], PERMISSION)]);
  assert.equal(s.failCount, 1);
  assert.equal(exitCodeOf(s), 1);
});

test('退出码：失败原文归不了类（unknown）也算没过 → 1', () => {
  const s = summarise([host('10.35.85.129', [FAIL, FAIL, FAIL], 'segmentation fault while unpacking')]);
  assert.equal(s.classify.unknown.length, 1);
  assert.equal(exitCodeOf(s), 1);
});

test('退出码：超时 → 1，理由写 timeout 而不是「全部失败」', () => {
  const s = { ...summarise([host('10.35.85.10', [OK, OK, WAIT])]), terminal: false, timedOut: true };
  assert.equal(exitCodeOf(s), 1);
  assert.equal(exitReasonOf(s), 'timeout');
  assert.match(renderOnboard(s), /超时/);
});

test('超时报告：说清是超时不是失败、带上当前进度、指向 --status', () => {
  const s = { ...summarise([host('10.35.85.10', [OK, OK, WAIT])]), progress: '2/27', terminal: false, timedOut: true };
  const text = renderOnboard(s);
  assert.match(text, /超时/);
  assert.match(text, /不是失败/, '别让人把超时读成「全部失败」');
  assert.match(text, /当前进度 2\/27/);
  assert.match(text, /--status/);
});

test('非超时结果不出现「超时」两个字', () => {
  assert.doesNotMatch(renderOnboard(summarise(installedBatch())), /超时/);
  assert.doesNotMatch(renderOnboard(summarise([host('10.35.85.129', [FAIL, FAIL, FAIL], PERMISSION)])), /超时/);
});

// ---- 票 05：--fix 的提示指向第二版，不能让人以为现在有这功能 ----

test('报告：--fix 那句明说是第二版的事，本版没有这个参数', () => {
  const text = renderOnboard(summarise([host('10.35.85.129', [FAIL, FAIL, FAIL], PERMISSION)]));
  assert.match(text, /--fix/);
  assert.match(text, /第二版/);
  assert.match(text, /本版.*没有.*--fix/);
});

// ---- 票 05：验证中拒绝重装 ----
// 接口对同一订单号重复 POST 会发生什么没人实测过（可能叠加安装），所以「验证中」这道闸必须有。

/// 已经点过纳管、正在验证中的批次：flag 3，9 台都已有 IP 但格子还是待检测。
const validatingBatch = () => Array.from({ length: 9 }, (_, i) => host(`10.35.85.${10 + i}`, [WAIT, WAIT, WAIT]));

test('--install 撞上「验证中」：拒绝，一次触发请求都不发，并说明原因', async () => {
  const sb = [];
  const calls = [];
  const http = fakeHttp({
    calls,
    search: { total: 1, rows: [searchRow(3, '2/27')] },
    details: { total: 9, rows: validatingBatch() },
  });

  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(sb),
    reinstall: true,
    ...NO_WAIT,
  });

  assert.deepEqual(sb, [], '验证中不许再点纳管');
  assert.equal(calls.filter((c) => c.url.includes(MANAGEMENT)).length, 0, '一次写接口都不许出现');
  assert.equal(res.triggered, false);
  assert.equal(res.refused, 'validating');
  assert.equal(res.agentValidateFlag, '3');
  // 拒绝也要给现状：照样把当前进度拉回来，人才能判断该不该 --force
  assert.equal(res.progress, '2/27');
  assert.equal(res.hosts.length, 9);
});

test('--install 撞上「验证中」：终端说清为什么拒、要强点该加什么', async () => {
  const sb = [];
  const http = fakeHttp({
    search: { total: 1, rows: [searchRow(3, '2/27')] },
    details: { total: 9, rows: validatingBatch() },
  });
  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(sb),
    reinstall: true,
    ...NO_WAIT,
  });

  const text = renderOnboard(res);
  assert.match(text, /正在验证中/);
  assert.match(text, /没有点纳管/);
  assert.match(text, /--force/);
  // 命令行用法要贴着拒绝那行给，别只给一个词
  assert.match(text, /onboard .*--install --force/);
});

test('--install --force 撞上「验证中」：放行，点一次纳管', async () => {
  const sb = [];
  const rows = validatingBatch();
  const http = fakeHttp({
    search: { total: 1, rows: [searchRow(3, '2/27')] },
    details: { total: 9, rows },
  });

  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(sb),
    reinstall: true,
    force: true,
    ...NO_WAIT,
  });

  assert.deepEqual(sb.map((c) => c.orderNo), ['202610305033060'], '--force 就是要强点一次');
  assert.equal(res.triggered, true);
  assert.equal(res.refused, undefined, '放了行就不是拒绝');
});

test('不加 --install 撞上「验证中」：本来就只看不点，不算拒绝', async () => {
  const sb = [];
  const http = fakeHttp({
    search: { total: 1, rows: [searchRow(3, '2/27')] },
    details: { total: 9, rows: validatingBatch() },
  });
  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(sb),
    ...NO_WAIT,
  });
  assert.deepEqual(sb, []);
  assert.equal(res.refused, undefined);
  assert.doesNotMatch(renderOnboard(res), /正在验证中.*没有点纳管/);
});

// ---- 票 05：超时路径 ----

test('超时：一直「验证中」，极短超时到点返回，带上当前进度与已落地的台数', async () => {
  // 工单级一直 flag 3，逐台一直有待检测 → 永远不到终态
  const http = fakeHttp({
    search: { total: 1, rows: [searchRow(3, '2/27')] },
    details: { total: 9, rows: validatingBatch() },
  });

  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(),
    pollMs: 1,
    timeoutMs: 30,
  });

  assert.equal(res.timedOut, true);
  assert.equal(res.terminal, false);
  assert.equal(res.progress, '2/27', '超时也要把当前进度带回来');
  assert.equal(res.hostCount, 9, '逐台明细一份不少');
  assert.equal(res.installedCount, 0);
  assert.equal(exitCodeOf(res), 1);
  assert.equal(exitReasonOf(res), 'timeout');
});

test('超时不挂死：超时被卡住的那一次轮询不会把整个命令拖住', async () => {
  // 每份快照都是「验证中」，但轮询间隔远长于超时：睡一次就该醒来收工
  const http = fakeHttp({
    search: { total: 1, rows: [searchRow(3, '2/27')] },
    details: { total: 9, rows: validatingBatch() },
  });
  const t0 = Date.now();
  const res = await createOsaApi({ http }).runOnboard({
    projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
    trigger: fakeTrigger(),
    pollMs: 10,
    timeoutMs: 20,
  });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - t0 < 2000, `超时后必须很快返回，实际 ${Date.now() - t0}ms`);
});

// ---- 票 05：result.json 落盘 ----
// 落盘根沿用仓库现有约定：stateDir 底下按 UTC 时间戳开一个批次目录。
// 实际路径由调用方注入（测试给临时目录），绝不写进真缓存。

const failBatch = () =>
  summarise([
    host('10.35.85.129', [FAIL, FAIL, FAIL], PERMISSION),
    host('10.35.85.130', [FAIL, OK, FAIL], PERMISSION),
    host('10.35.85.131', [FAIL, FAIL, FAIL], 'segmentation fault while unpacking'),
    ...installedBatch().slice(3),
  ]);

const withTmp = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpm-result-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('result.json：落在 stateDir 下的时间戳批次目录里，同名文件一个不少', () => {
  withTmp((root) => {
    const res = failBatch();
    const file = saveResult(res, { root, at: new Date(Date.UTC(2026, 10, 25, 9, 30, 0)) });
    assert.equal(file, path.join(root, 'onboard-20261125T093000Z', 'result.json'));
    assert.ok(fs.existsSync(file));
    // 只落一个文件：终端只打摘要，不生成 md
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['result.json']);
  });
});

test('result.json：含逐台原始行、分类结果、待归类清单，逐台三格与原始报错原文一字不差', () => {
  withTmp((root) => {
    const res = failBatch();
    const file = saveResult(res, { root, at: new Date(Date.UTC(2026, 10, 25, 9, 30, 0)) });
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));

    // 逐台原始行：接口那几个驼峰字段原样在
    assert.equal(j.hosts.length, 9);
    assert.deepEqual(
      j.hosts.map((h) => [h.deviceIp, h.agent, h.zabbix, h.filebeat]),
      res.hosts.map((h) => [h.deviceIp, h.agent, h.zabbix, h.filebeat]),
    );
    assert.equal(j.hosts[0].agentInstallInfo, PERMISSION, '原始报错原文要留底');
    assert.equal(j.hosts[0].agentInstallFlag, FAIL);
    assert.equal(j.hosts[0].updateTime, '2026-11-25 17:11:38');

    // 分类结果：类型 + 原文 + 影响的主机
    const perm = j.classify.errors.find((e) => e.type === 'tmp_not_executable');
    assert.deepEqual(perm.hosts, ['10.35.85.129', '10.35.85.130']);
    assert.equal(perm.raw, PERMISSION);

    // 待归类清单：陌生原文原样留着，供以后加规则时回溯
    assert.deepEqual(j.classify.unknown.map((u) => u.raw), ['segmentation fault while unpacking']);
  });
});

test('result.json：接口原始响应按路径分组留底（当时真回了什么，以后能回放）', () => {
  withTmp((root) => {
    const res = {
      ...summarise(installedBatch()),
      raw: {
        '/gridData4Search': { total: 1, rows: [searchRow(2, '27/27')] },
        '/gridData4PublicAgentDetails': { total: 1, rows: [host('10.35.85.10', [OK, OK, OK])] },
      },
    };
    const j = JSON.parse(fs.readFileSync(saveResult(res, { root }), 'utf8'));
    assert.equal(j.raw['/gridData4Search'].rows[0].orderNo, '202610305033060');
    assert.equal(j.raw['/gridData4PublicAgentDetails'].rows[0].filebeatAgentInstallFlag, OK);
  });
});

test('result.json 是能读的 JSON，且整体形状与 --json 一致', () => {
  withTmp((root) => {
    const res = failBatch();
    const j = JSON.parse(fs.readFileSync(saveResult(res, { root }), 'utf8'));
    // 落盘那份多一个 raw（接口原始响应），其余字段与 --json 一字不差
    assert.deepEqual(Object.keys(j).sort(), [...Object.keys(toView(res)), 'raw'].sort(), '落盘与 --json 用同一份视图');
    const { raw, ...same } = j;
    assert.deepEqual(same, toView(res));
    assert.equal(raw, null, '没抓原始响应时给 null，不给 undefined');
  });
});

test('落盘失败不许把已经等到结果的那份报告弄丢：报出原因，人还是能看到摘要', () => {
  withTmp((root) => {
    // 用一个不可能建成功的路径：父路径是个文件
    const blocker = path.join(root, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const res = { ...summarise(installedBatch()), saveError: undefined };
    const file = saveResult(res, { root: blocker });
    assert.equal(file, null);
    assert.match(res.saveError, /result\.json/);
  });
});

// ---- 票 05：--json 的稳定视图 ----
// 不加 --json 时内部对象可以随便长（比如 hosts 全字段），下游只认 toView 这一份。
// 字段名沿用接口的驼峰命名；分类固定 {type, group, disposition, suggest, fixable, raw, hosts}。

test('视图：顶层字段固定，批次/进度/计数/逐台/分类/待归类都在', () => {
  const v = toView(failBatch());
  assert.deepEqual(Object.keys(v).sort(), [
    'agentValidateFlag',
    'agentValidateStatus',
    'allAttempted',
    'attemptedCount',
    'batch',
    'cellCount',
    'classify',
    'failCount',
    'hostCount',
    'hosts',
    'installedCount',
    'okCount',
    'orderNo',
    'pendingCount',
    'progress',
    'projectId',
    'refused',
    'runningCount',
    'saveError',
    'savedTo',
    'terminal',
    'timedOut',
    'touched',
    'triggered',
    'watched',
    'watchRounds',
  ]);
  assert.equal(v.okCount, 6);
  assert.equal(v.failCount, 3);
  assert.equal(v.terminal, true);
});

test('视图：逐台既留渲染键，也留接口原始驼峰字段，三个 *InstallInfo 原文照留', () => {
  const v = toView(failBatch());
  assert.deepEqual(Object.keys(v.hosts[0]).sort(), [
    'agent',
    'agentInstallFlag',
    'agentInstallInfo',
    'deviceIp',
    'filebeat',
    'filebeatAgentInstallFlag',
    'filebeatAgentInstallInfo',
    'updateTime',
    'zabbix',
    'zabbixAgentInstallFlag',
    'zabbixAgentInstallInfo',
  ]);
});

test('视图：分类出来的是 {type, group, disposition, suggest, fixable, raw, hosts}，比原文那层少 auto_fix', () => {
  const v = toView(failBatch());
  const e = v.classify.errors[0];
  assert.deepEqual(Object.keys(e).sort(), [
    'disposition',
    'fixable',
    'group',
    'hosts',
    'raw',
    'suggest',
    'type',
  ]);
});

test('视图：多命中定位结果原样能穿过去（from/input/candidates）', () => {
  const hit = { from: 'ambiguous', input: 'E605', candidates: [{ projectId: 'p1', projectName: 'a' }] };
  const v = toView(hit);
  assert.equal(v.from, 'ambiguous');
  assert.equal(v.input, 'E605');
  assert.equal(v.candidates[0].projectId, 'p1');
});

// ---- 票 05：CLI 层（bin/bpm.mjs 的 main）的四条退出码与留底 ----
// 这一层不真起进程：main(argv, deps) 就是入口，测试直接 import 它，
// 把假 http / 假 trigger / 临时输出根从 deps 喂进去 —— 一个请求都不出网，一个字节都不碰本机 Chrome。
// 三样注入的缝：HTTP 层（假 http 按 URL 路径分派）、点纳管（假 trigger 只记一笔）、输出根（临时目录）。

const { main } = await import('../bin/bpm.mjs');

/// 接口原样的行（驼峰，工单级字段直接挂在行上），搜索与逐台明细都是这个形状。
const ALL_INSTALLED = {
  code: 200,
  rows: [
    {
      projectId: 'ee1f958e96ea4754a1620fd720cc35bf',
      projectName: 'E605-2026_E605_云平台资源需求',
      seriesId: 's-1',
      seriesName: '第一批',
      orderNo: '202610305033060',
      agentValidateStatus: '已验证',
      agentValidateFlag: '1',
      agentInstallProgress: '1/1',
      zabbixAgentInstallProgress: '1/1',
      filebeatAgentInstallProgress: '1/1',
      deviceIp: '10.35.85.129',
      agentInstallFlag: '已安装',
      zabbixAgentInstallFlag: '已安装',
      filebeatAgentInstallFlag: '已安装',
    },
  ],
};

/// 假 http 的响应按「被问了几次」给：runOnboard 是先用搜索的行判要不要点，之后每次轮询都重新查一遍，
/// 所以第一次和之后可以不一样（比如第一次不在验证中、之后在）。改 state.after 就直接改之后的每一次响应。
function staged(batch = ALL_INSTALLED) {
  let n = 0;
  const state = { after: null, batch };
  return Object.assign(state, {
    next: () => {
      n += 1;
      return n > 1 && state.after ? state.after : state.batch;
    },
  });
}

/// 一次 CLI 的夹具：http 是假 http，trigger 只记账，state 是本次运行的输出根（就是生产里的 BPM_STATE_DIR）。
/// stdout / stderr 按行收：main 的人话都走 console.log（--json 时那一份 JSON 也在 stdout）。
function cliFixture(batch = ALL_INSTALLED, { extra = [] } = {}) {
  const stage = batch && batch.next ? batch : staged(batch);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'bpm-cli-'));
  const calls = [];
  const ctx = { state, calls, stdout: '', stderr: '' };
  const http = async (url, { method = 'POST', form = '' } = {}) => {
    calls.push({ url, method, body: form });
    if (!url.includes('/gridData4Search') && !url.includes('/gridData4PublicAgentDetails')) {
      throw new Error(`假 http 没配这个路径：${url}`);
    }
    return { status: 200, headers: new Headers(), text: async () => JSON.stringify(stage.next()) };
  };
  const trigger = async (orderNo) => {
    calls.push({ url: `trigger://${orderNo}` });
    return { state: 'success', message: '' };
  };
  // tokenOf：真跑时这里是换票；夹具里给个常量，保证点纳管那次不去 4A 换票
  ctx.deps = { http, trigger, stateDir: state, tokenOf: () => 'fixture-token' };
  // 真跑时 trigger 是 BPM 的接口（吃 token）；夹具里只记账，token 传 null
  ctx.deps.trigger = (orderNo) => trigger(orderNo);
  for (const [k, v] of extra) ctx.deps[k] = v;
  ctx.run = async (args) => {
    const out = [];
    const err = [];
    const netted = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      netted.push(String(u));
      throw new Error('测试里不许真发请求：' + u);
    };
    const kept = [console.log, console.error];
    console.log = (...a) => out.push(a.map(String).join(' '));
    console.error = (...a) => err.push(a.map(String).join(' '));
    try {
      ctx.code = await ctx.withConfig(() => main(['onboard', ...args], ctx.deps));
    } finally {
      [console.log, console.error] = kept;
      globalThis.fetch = realFetch;
    }
    ctx.netted = netted;
    ctx.stdout = out.join(String.fromCharCode(10));
    ctx.stderr = err.join(String.fromCharCode(10));
    return { code: ctx.code, stdout: ctx.stdout, stderr: ctx.stderr };
  };
  // 触发请求的条数：点没点纳管只看这一个数
  ctx.triggers = () => calls.filter((c) => c.url.startsWith('trigger://')).length;
  // 配置只用来让 missingKeys() 放行：点在调用时改、调用完还原，别泄漏到别的用例
  ctx.withConfig = async (fn) => {
    const KEYS = ['BPM_U4A_BASE', 'BPM_BASE', 'BPM_SSO_RES_ID', 'BPM_SSO_ACC_ID', 'BPM_SSO_ACC_NAME', 'BPM_SSO_CLIENT_ID'];
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) process.env[k] = k.endsWith('BASE') ? 'http://' + k + '.invalid' : 'fixture';
    try {
      return await fn();
    } finally {
      for (const k of KEYS) if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  ctx.clean = () => fs.rmSync(state, { recursive: true, force: true });
  return ctx;
}

/// 跑完一次后留在输出根里的那一份 result.json
function savedOf(state) {
  const dir = fs.readdirSync(state).find((d) => d.startsWith('onboard-'));
  return dir ? JSON.parse(fs.readFileSync(path.join(state, dir, 'result.json'), 'utf8')) : null;
}

/// --json 的 stdout 必须整串是一份 JSON：多夹一行人话就会 parse 失败
const jsonOf = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`--json 的 stdout 不是一份能解析的 JSON：${r.stdout}${String.fromCharCode(10)}${r.stderr}`);
  }
};

test('CLI：全部成功 → 退出码 0；result.json 落在输出根的 onboard-<UTC>/ 下，且不生成 md', async () => {
  const f = cliFixture();
  try {
    const r = await f.run(['E605']);
    assert.equal(r.code, 0, r.stderr);
    const dirs = fs.readdirSync(f.state).filter((d) => d.startsWith('onboard-'));
    assert.equal(dirs.length, 1, '每次跑都开一个时间戳目录');
    assert.match(dirs[0], /^onboard-\d{8}T\d{6}Z$/);
    const file = path.join(f.state, dirs[0], 'result.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(j.projectId, 'ee1f958e96ea4754a1620fd720cc35bf');
    assert.equal(j.hosts.length, 1);
    assert.equal(j.hosts[0].deviceIp, '10.35.85.129', '逐台原始行留着');
    assert.equal(j.classify.errors.length, 0);
    assert.match(r.stderr, /明细已留底/, '留底路径走 stderr：stdout 只留给人读报告或那一份 JSON');
    assert.equal(fs.readdirSync(path.dirname(file)).filter((n) => /\.md$/.test(n)).length, 0, '不生成 md');
  } finally {
    f.clean();
  }
});

test('CLI：有失败 → 退出码 1（票 02 的「有失败也 bail(0)」就此作废）', async () => {
  const bad = structuredClone(ALL_INSTALLED);
  bad.rows[0].zabbixAgentInstallFlag = '安装失败';
  bad.rows[0].zabbixAgentInstallProgress = '0/1';
  bad.rows[0].zabbixAgentInstallInfo = PROXY;
  const f = cliFixture(bad);
  try {
    const r = await f.run(['E605']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /失败 1 台/);
    assert.match(r.stdout, /【要找人】/, '分类按组出标题');
    assert.ok(savedOf(f.state).classify.errors.length > 0, '分类结果与原文一起留底');
  } finally {
    f.clean();
  }
});

test('CLI：超时 → 退出码 1，stdout 明说超时、指向 --status，result.json 仍落盘', async () => {
  const hanging = structuredClone(ALL_INSTALLED);
  hanging.rows[0].agentValidateStatus = '验证中';
  hanging.rows[0].agentValidateFlag = '0';
  hanging.rows[0].agentInstallFlag = '安装中';
  hanging.rows[0].agentInstallProgress = '0/1';
  const f = cliFixture(hanging);
  try {
    const r = await f.run(['E605', '--install', '--timeout', '0.0002']);
    assert.equal(f.triggers(), 1, '真点了纳管，之后才卡在验证中');
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /超时/);
    assert.match(r.stdout, /不是失败/, '报告里要说明这是超时而不是全部失败');
    assert.match(r.stdout, /--status/);
    assert.equal(savedOf(f.state).timedOut, true);
  } finally {
    f.clean();
  }
});

test('CLI：参数缺 → 退出码 2，且一个请求都不发', async () => {
  const f = cliFixture();
  try {
    const r = await f.run([]);
    assert.equal(r.code, 2);
    assert.equal(f.calls.length, 0, '参数都没给，不该先发请求');
  } finally {
    f.clean();
  }
});

test('CLI：验证中点 --install → 拒绝、不点纳管、退出码 1；--json 里 refused 是 validating', async () => {
  const validating = structuredClone(ALL_INSTALLED);
  validating.rows[0].agentValidateStatus = '验证中';
  validating.rows[0].agentValidateFlag = '3';
  validating.rows[0].agentInstallProgress = '5/9';
  const f = cliFixture(validating);
  try {
    const r = await f.run(['E605', '--install', '--json', '--timeout', '0.05']);
    assert.equal(r.code, 1, r.stderr);
    const j = jsonOf(r);
    assert.equal(j.refused, 'validating');
    assert.equal(j.triggered, false, '拒绝就是没点');
    assert.equal(f.triggers(), 0, '一个触发请求都不许发');
  } finally {
    f.clean();
  }
});

test('CLI：多命中 --json → {from:ambiguous, via, input, candidates[]}，退出码 1，不点纳管', async () => {
  // 两行同名不同批次：关键字撞两条，得让人自己选，不许替他猜
  const two = structuredClone(ALL_INSTALLED);
  two.rows.push({ ...ALL_INSTALLED.rows[0], seriesId: 's-2', seriesName: '第二批', orderNo: '202610305033061' });
  const f = cliFixture(two);
  try {
    const r = await f.run(['E605', '--json']);
    assert.equal(r.code, 1, r.stderr);
    const j = jsonOf(r);
    assert.equal(j.from, 'ambiguous');
    assert.equal(j.via, 'search');
    assert.equal(j.input, 'E605');
    assert.equal(j.candidates.length, 2);
    assert.deepEqual(Object.keys(j.candidates[0]).sort(), ['createTime', 'orderNo', 'projectId', 'projectName', 'seriesId', 'seriesName']);
    assert.equal(f.triggers(), 0);
  } finally {
    f.clean();
  }
});

test('CLI：多命中的人读输出，每一行都带着能照着敲的 projectId', async () => {
  const two = structuredClone(ALL_INSTALLED);
  two.rows.push({ ...ALL_INSTALLED.rows[0], seriesId: 's-2', seriesName: '第二批', orderNo: '202610305033061' });
  const f = cliFixture(two);
  try {
    const r = await f.run(['E605']);
    assert.equal(r.code, 1, r.stdout);
    for (const c of two.rows) assert.ok(r.stdout.includes(c.projectId), `候选行要带 projectId：${r.stdout}`);
    assert.match(r.stdout, /bpm onboard <projectId>/);
  } finally {
    f.clean();
  }
});

test('CLI：--json 是一份能解析的 JSON，字段就是 toView 那几个，不多夹内部对象', async () => {
  const f = cliFixture();
  try {
    const r = await f.run(['E605', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = jsonOf(r);
    assert.equal(j.projectId, 'ee1f958e96ea4754a1620fd720cc35bf');
    assert.equal(j.hosts[0].zabbix, '已安装');
    assert.match(j.savedTo, /result\.json$/, '--json 里带上留底路径');
    assert.deepEqual(Object.keys(j).sort(), Object.keys(toView(summarise([host('x', [OK, OK, OK])]))).sort());
  } finally {
    f.clean();
  }
});

test('CLI：--status --json 不点纳管', async () => {
  const f = cliFixture();
  try {
    const r = await f.run(['E605', '--status', '--json']);
    assert.match(r.stderr, /命中「E605」/, '--json 时「命中哪条」走 stderr，别弄脏 stdout');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(jsonOf(r).triggered, false);
    assert.equal(f.triggers(), 0);
  } finally {
    f.clean();
  }
});

test('CLI：--install --force 放行，报告里就没有「拒绝重装」', async () => {
  const validating = structuredClone(ALL_INSTALLED);
  validating.rows[0].agentValidateStatus = '验证中';
  validating.rows[0].agentValidateFlag = '3';
  const f = cliFixture(validating);
  try {
    const r = await f.run(['E605', '--install', '--force', '--timeout', '0.0002']);
    assert.equal(f.triggers(), 1, '放行的证据：触发打了出去');
    assert.doesNotMatch(r.stdout, /拒绝重装/);
    assert.equal(savedOf(f.state).refused, null);
  } finally {
    f.clean();
  }
});

test('CLI：--help 打用法并回 0，不配配置也能跑', async () => {
  const out = [];
  const kept = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try {
    assert.equal(await main(['--help']), 0);
  } finally {
    console.log = kept;
  }
  assert.match(out.join(String.fromCharCode(10)), /onboard <arg>/);
});
