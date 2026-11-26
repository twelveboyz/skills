// 本机配置：环境变量 > <skill>/cache/config.json > 打包默认值。
// 这个模块不 import 任何其它 lib —— 别的 lib 反过来都要从这里取值，
// 而 session.mjs 与 browser.mjs 已经互相 import 了，不能再多一条边。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 状态目录放在 skill 自己目录下的 cache/：跟着 skill 走，不散落在别处。
// 内容是配置 + 两个 Chrome profile（几百 MB），已由 .gitignore 挡住，不会进仓库。
export const STATE_DIR =
  process.env.BPM_STATE_DIR || path.join(os.homedir(), '.agents', 'skills', 'bpm', 'cache');
export const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

/// 打包默认值。这里只放「人人都一样」的东西：两个地址全公司统一，所以内置。
/// 账号、SSO 三元组、SIM 凭据留空，靠 `bpm init` 探测后填进 config.json。
export const DEFAULTS = {
  u4aBase: 'https://10.21.1.6:7002/4a',
  bpmBase: 'http://10.19.105.28:28088',
  ssoResId: '',
  ssoAccId: '',
  ssoAccName: '',
  ssoClientId: '',
  simU: '',
  tenant: '',
  outRoot: '',
  computeKeywords: '计算资源,弹性资源',
};

/// 必须填才能跑通的键。两个地址有内置默认值，不算必填。
export const REQUIRED_KEYS = [
  'ssoResId',
  'ssoAccId',
  'ssoAccName',
  'ssoClientId',
  'simU',
  'tenant',
];

/// init 能改的键，顺序即提问顺序
export const CONFIG_KEYS = Object.keys(DEFAULTS);

let warned = false;
export function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    // JSON 坏了不该让整条链挂掉：报一次，按默认值继续
    if (e.code !== 'ENOENT' && !warned) {
      warned = true;
      console.error(`配置损坏，已忽略：${CONFIG_FILE}`);
    }
    return {};
  }
}

export function clearWarned() {
  warned = false;
}

/// 深合并后落盘。只写实际给出的键，不铺全量默认值。
export function writeConfig(patch) {
  const cur = readConfig();
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (v === null || v === '') delete next[k];
    else next[k] = v;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

const envOr = (envName, fallback) => {
  const v = process.env[envName];
  return v === undefined || v === '' ? fallback : v;
};

/// 纯函数：给定一份原始配置，算出最终生效值。config.json 自己不看 env。
export function resolveConfig(raw = readConfig()) {
  const cfg = raw || {};
  // 没配输出根目录就落到 ~/bpm-downloads，别往 cwd 里乱丢
  const outRoot =
    envOr('BPM_OUT_ROOT', cfg.outRoot ?? DEFAULTS.outRoot) || path.join(os.homedir(), 'bpm-downloads');
  return {
    u4aBase: envOr('BPM_U4A_BASE', cfg.u4aBase ?? DEFAULTS.u4aBase).replace(/\/+$/, ''),
    bpmBase: envOr('BPM_BASE', cfg.bpmBase ?? DEFAULTS.bpmBase).replace(/\/+$/, ''),
    ssoResId: envOr('BPM_SSO_RES_ID', cfg.ssoResId ?? DEFAULTS.ssoResId),
    ssoAccId: envOr('BPM_SSO_ACC_ID', cfg.ssoAccId ?? DEFAULTS.ssoAccId),
    ssoAccName: envOr('BPM_SSO_ACC_NAME', cfg.ssoAccName ?? DEFAULTS.ssoAccName),
    ssoClientId: envOr('BPM_SSO_CLIENT_ID', cfg.ssoClientId ?? DEFAULTS.ssoClientId),
    simU: envOr('BPM_SIM_U', cfg.simU ?? DEFAULTS.simU),
    tenant: envOr('BPM_TENANT', cfg.tenant ?? DEFAULTS.tenant),
    outRoot: path.resolve(outRoot),
    computeKeywords: envOr('BPM_COMPUTE_KEYWORDS', cfg.computeKeywords ?? DEFAULTS.computeKeywords),
  };
}

/// 还缺哪些必填项。空数组 = 配齐了。
export function missingKeys(cfg = resolveConfig()) {
  return REQUIRED_KEYS.filter((k) => !cfg[k]);
}

/// 哪些键被环境变量盖住了 —— init 展示时要说清楚"你填了也不生效"
export function envOverrides() {
  const map = {
    u4aBase: 'BPM_U4A_BASE',
    bpmBase: 'BPM_BASE',
    ssoResId: 'BPM_SSO_RES_ID',
    ssoAccId: 'BPM_SSO_ACC_ID',
    ssoAccName: 'BPM_SSO_ACC_NAME',
    ssoClientId: 'BPM_SSO_CLIENT_ID',
    simU: 'BPM_SIM_U',
    tenant: 'BPM_TENANT',
    outRoot: 'BPM_OUT_ROOT',
    computeKeywords: 'BPM_COMPUTE_KEYWORDS',
  };
  const hit = {};
  for (const [k, env] of Object.entries(map)) {
    if (process.env[env] !== undefined && process.env[env] !== '') hit[k] = env;
  }
  return hit;
}

// ---- 下面这些是各 lib 直接 import 的生效值，模块加载时算一次 ----
const CFG = resolveConfig();

export const U4A = CFG.u4aBase;
export const U4A_HOST = (() => {
  try {
    return new URL(U4A).hostname;
  } catch {
    return U4A;
  }
})();
export const U4A_HOME = `${U4A}/index.html`;
export const BPM = CFG.bpmBase;
export const SIM_U = CFG.simU;
export const TENANT = CFG.tenant;
export const OUT_ROOT = CFG.outRoot;
export const COMPUTE_KEYWORDS = CFG.computeKeywords
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const SSO = {
  resId: CFG.ssoResId,
  accId: CFG.ssoAccId,
  accName: CFG.ssoAccName,
  clientId: CFG.ssoClientId,
};
