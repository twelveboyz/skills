// S4：gen-report.mjs 从固定 JSONL 夹具生成 Markdown。只断言输出的结构。
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GEN = fileURLToPath(new URL('../bin/gen-report.mjs', import.meta.url));

const fixture = [
  {
    ts: '2026-11-17T03:00:00.000Z',
    targetId: 'A',
    pageUrl: 'https://console.example.com/list',
    method: 'GET',
    url: 'https://api.example.com/v1/users?page=1',
    reqHeaders: { accept: 'application/json' },
    postData: null,
    status: 200,
    mimeType: 'application/json',
    respHeaders: { 'content-type': 'application/json' },
    body: '{"items":[]}',
    durMs: 21,
  },
  {
    ts: '2026-11-17T03:00:01.000Z',
    targetId: 'A',
    pageUrl: 'https://console.example.com/list',
    method: 'POST',
    url: 'https://api.example.com/v1/orders',
    reqHeaders: { 'content-type': 'application/json' },
    postData: '{"sku":"X1","qty":2}',
    status: 201,
    mimeType: 'application/json',
    respHeaders: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    durMs: 33,
  },
];

function render() {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-s4-'));
  const jsonl = join(dir, 'net.jsonl');
  writeFileSync(jsonl, fixture.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    return execFileSync(process.execPath, [GEN, jsonl], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('AC8 报告含概览、按主机分组、每个接口小节与请求体样本', () => {
  const md = render();
  assert.match(md, /## 概览/);
  assert.match(md, /## api\.example\.com/);
  assert.match(md, /### GET \/v1\/users/);
  assert.match(md, /### POST \/v1\/orders/);
  assert.match(md, /"sku":"X1"/);
});

test('AC8b 每个接口带响应结构骨架、状态码与耗时', () => {
  const md = render();
  assert.match(md, /状态: 200/);
  assert.match(md, /耗时: 21ms/);
  // 骨架只描述结构不抄值：对象列出键，数组给出元素类型
  assert.match(md, /响应结构: `\{ +items: \[\] *\}`/);
  assert.match(md, /响应结构: `\{ +ok: boolean *\}`/);
  assert.ok(!md.includes('"ok":true'), '骨架不应复制响应原值');
});

test('AC8 同输入两次生成的报告完全一致', () => {
  assert.strictEqual(render(), render());
});

test('B9 report 遇到半截末行也照常出报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netcapture-r-'));
  try {
    const good = JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z',
      targetId: 'A',
      pageUrl: 'https://app.example.com/',
      method: 'GET',
      url: 'https://api.example.com/v1/users',
      reqHeaders: {},
      postData: null,
      status: 200,
      mimeType: 'application/json',
      respHeaders: {},
      body: '{"ok":true}',
      durMs: 12,
    });
    writeFileSync(join(dir, 'net.jsonl'), `${good}\n{"ts":"2026-01-01T00:00:01.000Z","url":"https://ap`);
    const r = spawnSync(process.execPath, [GEN, '--out', dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'report.md')), '半截行不该让报告整体失败');
    assert.match(readFileSync(join(dir, 'report.md'), 'utf8'), /api\.example\.com/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
