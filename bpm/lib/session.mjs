// 4A 会话：SIM 认证只需走一次，cookie 落盘复用；失效才重新认证。
import fs from 'node:fs';
import path from 'node:path';
import { read4aCookies } from './browser.mjs';
import { U4A, SIM_U, TENANT, STATE_DIR } from './config.mjs';

export { U4A, STATE_DIR };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

// 两次真实认证的最小间隔：SIM 认证发太密会锁账号
const AUTH_COOLDOWN_MS = Number(process.env.BPM_AUTH_COOLDOWN_MS || 60_000);

const SESSION_FILE = path.join(STATE_DIR, 'session.json');
// 冷却时间戳独立存放：清掉 cookie 缓存不该连带清掉风控保护
const AUTH_LOG_FILE = path.join(STATE_DIR, 'auth-log.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function absorb(jar, res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const sc of raw) {
    const kv = sc.split(';')[0];
    const i = kv.indexOf('=');
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (v === '') jar.delete(k);
    else jar.set(k, v);
  }
  return raw;
}

function headers(jar, referer) {
  return {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': UA,
    Referer: `${U4A}/${referer}`,
    Cookie: cookieHeader(jar),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
function writeJson(file, data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const readState = () => readJson(SESSION_FILE);
const writeState = (patch) => writeJson(SESSION_FILE, { ...readState(), ...patch });
const readAuthLog = () => readJson(AUTH_LOG_FILE);
const markAuth = () => writeJson(AUTH_LOG_FILE, { lastAuthAt: Date.now() });

/// 用 cookie 验会话，返回 loading.do 的 JSON
export async function loading(cookie) {
  const ck = typeof cookie === 'string' ? cookie : cookieHeader(cookie);
  const r = await fetch(`${U4A}/loading.do?rnd=${Math.random()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      Referer: `${U4A}/index.html`,
      Cookie: ck,
    },
    body: '',
  });
  return r.json();
}

/// 真实走一次 SIM 认证。只在没有可用会话时调用。
async function authenticate() {
  const last = readAuthLog().lastAuthAt || 0;
  const wait = AUTH_COOLDOWN_MS - (Date.now() - last);
  if (wait > 0) {
    throw new Error(
      `距上次 SIM 认证仅 ${Math.round((Date.now() - last) / 1000)} 秒，需等待 ${Math.ceil(
        wait / 1000,
      )} 秒（发太密会锁账号）。缓存失效时请稍后再试，或设 BPM_AUTH_COOLDOWN_MS=0 强制。`,
    );
  }
  markAuth();

  const jar = new Map();

  let r = await fetch(`${U4A}/login_hlw.html`, { headers: { 'User-Agent': UA } });
  absorb(jar, r);
  await r.text();

  r = await fetch(`${U4A}/sim/simauth.do?rnd=${Math.random()}`, {
    method: 'POST',
    headers: headers(jar, 'login_hlw.html'),
    body: `u=${SIM_U}&tt=${TENANT}&authType=fastsim`,
  });
  absorb(jar, r);
  const tx = await r.json();
  if (!tx.success) throw new Error(`simauth 失败: ${JSON.stringify(tx)}`);

  let done = false;
  for (let i = 1; i <= 4 && !done; i++) {
    await sleep(5000);
    r = await fetch(`${U4A}/sim/simquickauthnresult.do?`, {
      method: 'POST',
      headers: headers(jar, 'login_hlw.html'),
      body: `transactionid=${tx.data}&rnd=${Math.random() * 10}`,
    });
    absorb(jar, r);
    const t = await r.text();
    done = t.includes('"success":true');
    if (i === 4 && !done) throw new Error(`SIM 认证 4 次轮询仍未成功: ${t.slice(0, 120)}`);
  }

  // 服务端先后发 u_t/tt_t/t_t/r_t，afterlogin.do 换发正式的 u/t/tt/r
  r = await fetch(`${U4A}/afterlogin.do?rnd=${Math.random()}`, {
    method: 'POST',
    headers: headers(jar, 'login_hlw.html'),
    body: '',
    redirect: 'manual',
  });
  absorb(jar, r);
  await r.text();

  const ses = await loading(jar);
  if (!ses.success) throw new Error(`4A 会话无效: ${JSON.stringify(ses)}`);

  const cookies = cookieHeader(jar);
  writeState({ cookies, user: ses.data.user });
  return { cookies, user: ses.data.user };
}

/// 只看缓存里的会话，不联网（配合 peekToken 跳过整条验会话链路）
export function peekSession() {
  const { cookies, user } = readState();
  return cookies && user ? { cookies, user } : null;
}

/// 拿 4A 会话。默认只读，绝不发 SIM 认证：
///   1. 缓存 session.json 有效 → 直接用
///   2. 本机 Chrome（默认 9222）已登录 4A → 拿它的 cookie，落盘后复用
///   3. 都不行 → 报错让人自己决定
///
/// SIM 认证会触发风控（发太密锁账号），所以只有显式 `login` 动作能开这个口子：
/// 必须传 allowAuth: true。任何"顺手降级"都不许调它 —— 之前在 browser 的换票失败
/// 分支里偷偷降级过一次，连发了 4 轮轮询，把用户账号推到风控边缘。
export async function getSession({ force = false, allowAuth = false } = {}) {
  if (!force) {
    const { cookies } = readState();
    if (cookies) {
      const ses = await loading(cookies);
      if (ses.success) return { cookies, user: ses.data.user, reused: true, from: 'cache' };
    }

    const fromChrome = await read4aCookies();
    if (fromChrome) {
      const ses = await loading(fromChrome.cookieHeader);
      if (ses.success) {
        writeState({ cookies: fromChrome.cookieHeader, user: ses.data.user });
        return { cookies: fromChrome.cookieHeader, user: ses.data.user, reused: true, from: 'chrome' };
      }
    }
  }

  if (!allowAuth) {
    throw new Error(
      '4A 会话失效，缓存与浏览器里都没有可用会话。\n' +
        '  想重新认证请显式跑: bpm.mjs login   （会发一次 SIM 认证，约 20 秒）\n' +
        '  或者在 Chrome 里登录一次 4A，再重试本命令（不触发风控）。',
    );
  }

  const r = await authenticate();
  return { ...r, reused: false, from: 'auth' };
}
