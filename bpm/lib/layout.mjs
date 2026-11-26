// 交维目录布局：认骨架（nil / nil-s）、推目录名、按槽位落文件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeName } from './attach.mjs';
import { OUT_ROOT, COMPUTE_KEYWORDS } from './config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export { OUT_ROOT, COMPUTE_KEYWORDS };

/// 固定输出根目录。换机器/换位置跑 bpm.mjs init，或设 BPM_OUT_ROOT 临时覆盖。
export const DOWNLOADS = path.join(os.homedir(), 'Downloads');

export const TEMPLATES_DIR = process.env.BPM_TEMPLATE_DIR || path.join(ROOT, 'templates');

/// 两个骨架各自的槽位：附件与 PDF 进 minutes，空白资源录入模板进 entry。
const SLOTS = {
  nil: { minutes: '1、订购评审纪要', entry: '6、资源录入表' },
  'nil-s': { minutes: '1、订购评审纪要', entry: '3、资源录入表' },
};

export function slotOf(name) {
  const s = SLOTS[name];
  if (!s) throw new Error(`未知骨架: ${name}`);
  return s;
}

export const outputRoot = (useDownloads) => (useDownloads ? DOWNLOADS : OUT_ROOT);

/// 命中哪个关键词就返回哪个，顺带把命中的附件名带出来给人核对
export function detectSkeleton(attachments, keywords = COMPUTE_KEYWORDS) {
  for (const a of attachments || []) {
    const name = a?.name || '';
    const hit = keywords.find((k) => name.includes(k));
    if (hit) return { name: 'nil', hit, file: name };
  }
  return { name: 'nil-s', hit: null, file: null };
}

/// 从工单的各种字段推目录名。任一步失败往下一步走，最后兜底实例号。
export function projectDirName(detail, instId) {
  const bags = Object.values(detail?.data || {}).filter((b) => b && typeof b === 'object');
  const pick = (...fields) => {
    for (const f of fields) {
      for (const b of bags) {
        const v = b[f];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
    return '';
  };

  // 1. 工程名，去年份前缀：2026_E605_某工程… → E605_某工程…
  const proj = pick('project_name', 'proj_name', 'projectName', 'gc_name');
  if (proj) return safeName(proj.replace(/^\d{4}_/, ''));

  // 2. 工程编号 + 工程名
  const code = pick('gcbh', 'project_code');
  if (code) return safeName(code);

  // 3. 订单标题：E605-2026_E605_xxx-X_某单位 → E605_2026_E605_xxx_X_某单位
  const order = pick('order_title');
  if (order) {
    const parts = order.split('-');
    if (parts.length >= 2) return safeName(`${parts[0]}_${parts.slice(1).join('_')}`);
    return safeName(order);
  }

  return safeName(instId);
}

/// 把骨架合并进目标目录。force:false 是关键——目标里已有的人工文件绝不覆盖。
export async function applySkeleton(name, destDir) {
  const src = path.join(TEMPLATES_DIR, name);
  if (!fs.existsSync(src)) {
    throw new Error(`模板缺失: ${src}（重拷 templates/ 或设 BPM_TEMPLATE_DIR）`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(src, destDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    // ~$ 是 Office 锁文件；.gitkeep 只是让 git 保住空目录，真拷过去会脏了交付目录
    filter: (s) => !path.basename(s).startsWith('~$') && path.basename(s) !== '.gitkeep',
  });
  return src;
}
