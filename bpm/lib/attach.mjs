// 工单附件：从详情响应里认出附件数组，安全落盘
import fs from 'node:fs';
import path from 'node:path';

/// 认出附件：值能 JSON.parse 成数组，且每项都有 id 和 name。
/// 表单里别的数组（如 business_list 的 financialId/financialName）会被排除。
export function collectAttachments(detail) {
  const out = [];
  const data = detail?.data || {};
  for (const [formKey, fields] of Object.entries(data)) {
    if (!fields || typeof fields !== 'object') continue;
    for (const [field, raw] of Object.entries(fields)) {
      if (typeof raw !== 'string' || !raw.trim().startsWith('[')) continue;
      let arr;
      try {
        arr = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(arr) || arr.length === 0) continue;
      if (!arr.every((x) => x && typeof x === 'object' && x.id && x.name)) continue;
      for (const f of arr) {
        out.push({
          formKey,
          field,
          id: String(f.id),
          name: String(f.name),
          size: f.size ?? null,
          username: f.username || '',
        });
      }
    }
  }
  return out;
}

/// 去掉各平台非法字符与控制字符
export function safeName(name) {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return s || 'file';
}

/// 同一次运行内重名才加 (2)(3)…；跨次运行直接覆盖，避免越跑越多
export function uniqueName(name, seen) {
  const safe = safeName(name);
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = safe;
  for (let i = 2; seen.has(candidate); i++) candidate = `${stem}(${i})${ext}`;
  seen.add(candidate);
  return candidate;
}

/// 写文件（同名覆盖），返回绝对路径
export function saveBuffer(dir, name, buf) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, safeName(name));
  fs.writeFileSync(p, buf);
  return p;
}
