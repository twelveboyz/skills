#!/usr/bin/env node
// gen-report.mjs：读 net.jsonl，生成 Markdown 视图。输出到 stdout，或在给了 --out 时写 report.md。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 响应结构骨架：只描述形状（键名 + 类型），不抄响应原值，避免报告里出现业务数据。
export function skeleton(value, depth = 0) {
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.length ? `[${skeleton(value[0], depth + 1)}]` : '[]';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    const parts = Object.entries(value).map(([k, v]) => `${k}: ${skeleton(v, depth + 1)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  return typeof value;
}

function bodySkeleton(text) {
  if (!text) return null;
  try {
    return skeleton(JSON.parse(text));
  } catch {
    return '(非 JSON)';
  }
}

export function renderReport(records) {
  const byHost = new Map();
  for (const r of records) {
    const host = new URL(r.url).host;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(r);
  }

  const lines = ['# 接口抓取报告', '', '## 概览', '', `共 ${records.length} 条请求。`, ''];

  for (const [host, list] of byHost) {
    lines.push(`## ${host}`, '');
    const byApi = new Map();
    for (const r of list) {
      const u = new URL(r.url);
      const key = `${r.method} ${u.pathname}`;
      if (!byApi.has(key)) byApi.set(key, []);
      byApi.get(key).push(r);
    }
    for (const [key, calls] of byApi) {
      const last = calls[calls.length - 1];
      lines.push(
        `### ${key}`,
        '',
        `调用 ${calls.length} 次，状态: ${last.status ?? '-'}，耗时: ${last.durMs}ms。`,
        '',
      );
      const shape = bodySkeleton(calls.map((c) => c.body).find(Boolean));
      if (shape) lines.push(`响应结构: \`${shape}\``, '');
      const sample = calls.find((c) => c.postData);
      if (sample) lines.push('请求体样本：', '', '```json', sample.postData, '```', '');
    }
  }

  return lines.join('\n') + '\n';
}

function readJsonl(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 半截末行（recorder 正在写）跳过，不能让整份报告失败
    }
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : null;
  const md = renderReport(readJsonl(outDir ? join(outDir, 'net.jsonl') : argv[0]));
  if (outDir) writeFileSync(join(outDir, 'report.md'), md);
  else process.stdout.write(md);
}
