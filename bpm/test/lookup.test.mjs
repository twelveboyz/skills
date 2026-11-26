// 票 03：用批次关键字（E605）定位工单与批次。一个缝：注入的 HTTP 层；缓存落在临时 STATE_DIR。
// 假 http 按「URL 里含哪个路径」分派固定响应，断言的是解析结果、缓存文件内容与报错文案，
// 不 mock 任何内部模块。跑法：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOsaApi } from '../lib/osa-api.mjs';
import { createLookup, kindOf } from '../lib/lookup.mjs';

const OSA = 'http://10.19.105.29:8080';
const SEARCH = '/gridData4Search';
const PROJECT_ID = 'ee1f958e96ea4754a1620fd720cc35bf';

// 真实抓包里的行形状（E605，2026-11-25）
const row = (over = {}) => ({
  projectId: PROJECT_ID,
  projectName: 'E605-2026_E605_云平台资源需求',
  seriesId: '1111011827874e7ba14e8e7153a83f5a',
  seriesName: '第一批',
  createTime: '2026-11-19 17:07',
  orderNo: '202610305033060',
  agentValidateStatus: '待验证',
  agentValidateFlag: '0',
  agentInstallProgress: '/',
  ...over,
});

const OTHER = row({
  projectId: '5c0d1e6a9f2b4c3d8e7f6a5b4c3d2e1f',
  projectName: 'E605-2026_E605_网络资源需求',
  seriesId: '2222011827874e7ba14e8e7153a83f5a',
  seriesName: '第二批',
  createTime: '2026-11-20 09:31',
  orderNo: '202610305033061',
});

/// 造一个假 http：按路径分派；calls 记下每次请求，供「搜索了几次」这类断言用。
function fakeHttp({ rows = [], calls = [] } = {}) {
  return async (url, { method = 'POST', form = '' } = {}) => {
    calls.push({ url, method, body: form });
    if (!url.includes(SEARCH)) assert.fail(`假 http 没配这个路径：${url}`);
    const body = { total: rows.length, rows };
    return { status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
  };
}

const countSearch = (calls) => calls.filter((c) => c.url.includes(SEARCH)).length;

/// 每个用例一个临时 STATE_DIR，跑完删掉；绝不写进真缓存目录。
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bpm-lookup-'));
}

// ---- 切片 1：唯一命中 → 直接用，并写缓存 ----

test('关键字唯一命中：直接给出 projectId + 批次 + 订单号，并把首次命中写进缓存', async () => {
  const dir = tempDir();
  try {
    const calls = [];
    const lookup = createLookup({
      api: createOsaApi({ http: fakeHttp({ rows: [row()], calls }) }),
      stateDir: dir,
      now: () => 1000,
    });

    const hit = await lookup.resolve('E605');

    assert.equal(hit.projectId, PROJECT_ID);
    assert.equal(hit.seriesId, '1111011827874e7ba14e8e7153a83f5a');
    assert.equal(hit.orderNo, '202610305033060');
    assert.equal(hit.from, 'search');
    assert.equal(countSearch(calls), 1, '没命中缓存时该搜一次');

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'lookup.json'), 'utf8'));
    assert.deepEqual(saved.E605, {
      projectId: PROJECT_ID,
      seriesId: '1111011827874e7ba14e8e7153a83f5a',
      orderNo: '202610305033060',
      firstHitAt: 1000,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 切片 2：多命中 → 列候选，不替用户猜，不落缓存 ----

test('关键字命中多个：列出每个候选的工单名/批次名/订单号/创建时间，且不写缓存', async () => {
  const dir = tempDir();
  try {
    const calls = [];
    const lookup = createLookup({
      api: createOsaApi({ http: fakeHttp({ rows: [row(), OTHER], calls }) }),
      stateDir: dir,
    });

    const hit = await lookup.resolve('E605');

    assert.equal(hit.from, 'ambiguous');
    assert.equal(hit.candidates.length, 2);
    assert.deepEqual(
      hit.candidates.map((c) => [c.projectName, c.seriesName, c.orderNo, c.createTime]),
      [
        ['E605-2026_E605_云平台资源需求', '第一批', '202610305033060', '2026-11-19 17:07'],
        ['E605-2026_E605_网络资源需求', '第二批', '202610305033061', '2026-11-20 09:31'],
      ],
    );
    assert.notEqual(hit.projectId, PROJECT_ID, '多命中不许挑一个当结果');
    assert.equal(fs.existsSync(path.join(dir, 'lookup.json')), false, '多命中还没有定论，不该落缓存');

    const text = lookup.render(hit);
    assert.match(text, /命中 2 个/);
    // 候选行第一列就是能照着敲的 projectId：人读输出里没有它，就得回头去翻 --json
    assert.match(text, /ee1f958e96ea4754a1620fd720cc35bf {2}E605-2026_E605_云平台资源需求/);
    assert.match(text, /5c0d1e6a9f2b4c3d8e7f6a5b4c3d2e1f {2}E605-2026_E605_网络资源需求/);
    assert.match(text, /E605-2026_E605_云平台资源需求 {2}第一批 {2}202610305033060 {2}2026-11-19 17:07/);
    assert.match(text, /E605-2026_E605_网络资源需求 {2}第二批 {2}202610305033061 {2}2026-11-20 09:31/);
    assert.match(text, /bpm onboard <projectId>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 切片 3：零命中 → 报错 ----

test('关键字零命中：抛错并提示换个说法，不落缓存', async () => {
  const dir = tempDir();
  try {
    const lookup = createLookup({
      api: createOsaApi({ http: fakeHttp({ rows: [row()] }) }),
      stateDir: dir,
    });

    await assert.rejects(() => lookup.resolve('E999'), /搜不到.*E999/);
    assert.equal(fs.existsSync(path.join(dir, 'lookup.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 切片 4：同一个关键字第二次直接命中缓存，不再搜 ----

test('同一个关键字第二次：一次搜索都不打，直接用缓存里的 projectId，首次命中时间不变', async () => {
  const dir = tempDir();
  try {
    const calls = [];
    const api = () => createOsaApi({ http: fakeHttp({ rows: [row()], calls }) });
    let clock = 1000;
    const first = createLookup({ api: api(), stateDir: dir, now: () => clock });
    await first.resolve('E605');
    assert.equal(countSearch(calls), 1);

    clock = 5000;
    const second = createLookup({ api: api(), stateDir: dir, now: () => clock });
    const hit = await second.resolve('E605');

    assert.equal(countSearch(calls), 1, '第二次不许再搜');
    assert.equal(hit.from, 'cache');
    assert.equal(hit.projectId, PROJECT_ID);
    assert.equal(hit.orderNo, '202610305033060');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, 'lookup.json'), 'utf8')).E605.firstHitAt,
      1000,
      '首次命中时间记的是第一次，不是这次',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 切片 5：直接给 projectId 仍然有效；三种参数的判定规则 ----

test('参数判定：32 位 hex 是 projectId，15 位数字是订单号（不是 projectId），其余是关键字', () => {
  assert.equal(kindOf(PROJECT_ID), 'projectId');
  assert.equal(kindOf('202610305033060'), 'orderNo');
  assert.equal(kindOf('E605'), 'keyword');
  // 边界：差一位就不是同一个东西
  assert.equal(kindOf('ee1f958e96ea4754a1620fd720cc35b'), 'keyword', '31 位 hex 算关键字');
  assert.equal(kindOf(`${PROJECT_ID}a`), 'keyword', '33 位 hex 算关键字');
  assert.equal(kindOf('20261030503306'), 'keyword', '14 位数字算关键字');
  assert.equal(kindOf('2026103050330600'), 'keyword', '16 位数字算关键字');
  assert.equal(kindOf('2026_E605'), 'keyword', '带下划线的短串不是订单号');
  assert.equal(kindOf('EE1F958E96EA4754A1620FD720CC35BF'), 'projectId', '大写 hex 也是');
  assert.equal(kindOf('  E605  '), 'keyword', '首尾空格不改变判定');
});

test('直接给 projectId：原样走 batchStatus，一次搜索都不打', async () => {
  const dir = tempDir();
  try {
    const calls = [];
    const projectId = PROJECT_ID;
    const http = async (url, { method = 'POST', form = '' } = {}) => {
      calls.push({ url, method, body: form });
      assert.fail(`不该有请求：${url}`);
    };
    const lookup = createLookup({
      api: createOsaApi({ http }),
      stateDir: dir,
      batchStatus: async ({ projectId: p }) => ({ projectId: p, seriesName: '第一批', orderNo: '202610305033060' }),
    });

    const hit = await lookup.resolve(projectId);

    assert.equal(hit.from, 'id');
    assert.equal(hit.projectId, projectId);
    assert.equal(calls.length, 0, '给 projectId 不该搜');
    assert.equal(fs.existsSync(path.join(dir, 'lookup.json')), false, 'projectId 不用进关键字缓存');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('给 15 位订单号：直接拒绝，不当 projectId 用', async () => {
  const dir = tempDir();
  try {
    const lookup = createLookup({
      api: createOsaApi({ http: fakeHttp({ rows: [] }) }),
      stateDir: dir,
    });
    await assert.rejects(() => lookup.resolve('202610305033060'), /订单号.*projectId/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 切片 6：关键字唯一命中 → 解析出的 projectId 直接交给 runOnboard 走完 ----

test('关键字唯一命中直接走到纳管流程：搜索只打一次，纳管按解析出的 projectId 跑', async () => {
  const dir = tempDir();
  try {
    const calls = [];
    const detail = {
      total: 1,
      rows: [
        {
          deviceIp: '10.35.85.10',
          ipv6: '',
          agentInstallFlag: '已安装',
          zabbixAgentInstallFlag: '已安装',
          filebeatAgentInstallFlag: '已安装',
          updateTime: '2026-11-25 17:11:38',
        },
      ],
    };
    // 搜索按关键字过滤后只有一行 → 唯一命中；详情给一台已安装 → 终态
    const http = async (url, { method = 'POST', form = '' } = {}) => {
      calls.push({ url, method, body: form });
      const body = url.includes(SEARCH) ? { total: 1, rows: [row(), OTHER] } : detail;
      return { status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
    };
    const api = createOsaApi({ http });
    const lookup = createLookup({ api, stateDir: dir });
    const hit = await lookup.resolve('E605-2026_E605_云');

    assert.equal(hit.from, 'search');
    // 全量搜索与按 projectId 取进度打的是同一个接口，靠 projectId 空/不空区分
    const searches = () => calls.filter((c) => c.url.includes(SEARCH));
    assert.equal(searches().length, 1, '解析阶段搜一次');
    // 只锁「projectId 传空」这一条：rows 是翻页批大小，会随接口分页策略调整，
    // 写死数值会让每次调分页都误报（实测从 20 改 500 就挂了）。
    assert.equal(
      new URLSearchParams(searches()[0].body).get('projectId'),
      '',
      '全量搜索就是 projectId 传空',
    );

    const res = await api.runOnboard({ projectId: hit.projectId, trigger: async () => {}, pollMs: 1, timeoutMs: 50 });

    assert.equal(res.projectId, PROJECT_ID);
    assert.equal(searches().length, 2, '纳管阶段按 projectId 查进度，不再全量搜');
    assert.match(searches()[1].body, new RegExp(`projectId=${PROJECT_ID}`));
    assert.equal(calls.filter((c) => c.url.includes('/gridData4PublicAgentDetails')).length, 1);
    assert.equal(
      calls.find((c) => c.url.includes('/gridData4PublicAgentDetails')).body,
      'projectBatchId=1111011827874e7ba14e8e7153a83f5a&beginTime=&endTime=&page=1&rows=20',
      '详情用的是解析结果里的批次 id',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 票 05：15 位订单号回退搜索 ----
// 票 03 保守地直接拒了；但 user story 20 要的正是「撞上验证中要知道」，而人手里最常有的就是订单号。
// 回退到搜索时必须按 orderNo 精确匹配，不许拿它当关键字去模糊撞。

const ORDER = '202610305033060';

test('给 15 位订单号：回退成搜索，按 orderNo 精确命中一行就用它', () => {
  const dir = tempDir();
  try {
    const calls = [];
    const lookup = createLookup({ api: createOsaApi({ http: fakeHttp({ rows: [row(), OTHER], calls }) }), stateDir: dir });

    return lookup.resolve(ORDER).then((hit) => {
      assert.equal(hit.from, 'orderNo');
      assert.equal(hit.projectId, PROJECT_ID);
      assert.equal(hit.orderNo, ORDER);
      assert.equal(countSearch(calls), 1, '订单号走一次全量搜索');
      // 订单号不是关键字：不进关键字缓存，免得污染「E605」那种真关键字
      assert.equal(fs.existsSync(path.join(dir, 'lookup.json')), false, '订单号不写关键字缓存');
    });
  } finally {
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 50);
  }
});

test('订单号回退：只认 orderNo 相等的行，别的行里含这串数字也不算命中', async () => {
  const dir = tempDir();
  try {
    // 把订单号塞进另一行的 projectName 里：按关键字模糊搜会撞上，按 orderNo 精确匹配就不该撞
    const trap = row({ projectId: '5c0d1e6a9f2b4c3d8e7f6a5b4c3d2e1f', projectName: `x_${ORDER}`, seriesId: 'x', orderNo: '202610305033099' });
    const lookup = createLookup({ api: createOsaApi({ http: fakeHttp({ rows: [trap, row()] }) }), stateDir: dir });
    const hit = await lookup.resolve(ORDER);
    assert.equal(hit.projectId, PROJECT_ID);
    assert.equal(hit.from, 'orderNo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('订单号回退：零命中时说清「osa 里没有这个订单号」，并给下一步', async () => {
  const dir = tempDir();
  try {
    const lookup = createLookup({ api: createOsaApi({ http: fakeHttp({ rows: [row(), OTHER] }) }), stateDir: dir });
    await assert.rejects(() => lookup.resolve('202610305033999'), /订单号：202610305033999/);
    await assert.rejects(() => lookup.resolve('202610305033999'), /projectId/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('订单号命中两行（同一个号出现在两个批次）：不替人猜，列候选', async () => {
  const dir = tempDir();
  try {
    const twin = row({ projectId: '5c0d1e6a9f2b4c3d8e7f6a5b4c3d2e1f', seriesId: 'x', seriesName: '第二批' });
    const lookup = createLookup({ api: createOsaApi({ http: fakeHttp({ rows: [row(), twin] }) }), stateDir: dir });
    const hit = await lookup.resolve(ORDER);
    assert.equal(hit.from, 'ambiguous');
    assert.equal(hit.candidates.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 票 05：关键字缓存加 TTL ----

test('缓存过期：超过 TTL 的关键字不再命中缓存，重新搜一次并刷新首中时间', async () => {
  const dir = tempDir();
  try {
    const calls = [];
    const api = () => createOsaApi({ http: fakeHttp({ rows: [row()], calls }) });
    let clock = 1000;
    await createLookup({ api: api(), stateDir: dir, now: () => clock }).resolve('E605');
    assert.equal(countSearch(calls), 1);

    // 7 天后再问：缓存已过期，必须重新搜
    clock = 1000 + 7 * 24 * 3600_000 + 1;
    const hit = await createLookup({ api: api(), stateDir: dir, now: () => clock }).resolve('E605');
    assert.equal(countSearch(calls), 2, '过期就该重搜');
    assert.equal(hit.from, 'search');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'lookup.json'), 'utf8')).E605.firstHitAt, clock);

    // 同一秒内再问：刚刷过的缓存有效
    const again = await createLookup({ api: api(), stateDir: dir, now: () => clock }).resolve('E605');
    assert.equal(again.from, 'cache');
    assert.equal(countSearch(calls), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
