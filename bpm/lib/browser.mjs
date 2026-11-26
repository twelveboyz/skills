// 跟「用户自己那个 Chrome」打交道：读它的 4A 登录 cookie、把页面开进去。
// 只依赖 cdp.mjs，不 import session/bpm —— 那两个要反过来用这里的函数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Cdp, browserWs, findChrome, jsonReq, listPages, openTab, portFor, sleep } from './cdp.mjs';
import { U4A_HOST, U4A_HOME } from './config.mjs';

export { U4A_HOST, U4A_HOME };

// 可见窗口用的 profile 不长期保留：每次起窗用 %TEMP% 下的一次性目录，
// 免得在磁盘上攒出几百 MB。Chrome 必须用独立 user-data-dir 才肯开调试端口，
// 所以这个目录没法完全省掉，只能保证它落在临时目录、且用完就被清。
const uiProfileDir = () => path.join(os.tmpdir(), `dsh-bpm-ui-${Date.now()}`);

/// 清掉之前遗留的一次性 profile：只删 2 小时没动过、且没有 Chrome 占着的。
function sweepOldProfiles() {
  const base = os.tmpdir();
  let names = [];
  try {
    names = fs.readdirSync(base).filter((n) => n.startsWith('dsh-bpm-ui-'));
  } catch {
    return;
  }
  const cutoff = Date.now() - 2 * 3600_000;
  for (const n of names) {
    const dir = path.join(base, n);
    try {
      if (fs.statSync(dir).mtimeMs > cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了，下次再试 */
    }
  }
}

export function cdpPort() {
  return Number(process.env.BPM_CDP_PORT || 9222);
}

/// "u=..; t=.." → [{name,value}]。_t 系列是认证中间态，带上会让 loading.do 返 2200211
export function pairsOf(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf('=');
      return i > 0 ? { name: s.slice(0, i), value: s.slice(i + 1) } : null;
    })
    .filter((c) => c && !c.name.endsWith('_t'));
}

/// 从浏览器里读 4A 的登录 cookie。浏览器没开 / 没登录都返回 null，不抛。
/// host 显式传：config 的 U4A_HOST 是 import 时算的常量，init 在运行期改地址后得能覆盖。
export async function read4aCookies(port = cdpPort(), host = U4A_HOST) {
  // 空 host 时 includes('') 恒为 true，会把任意域的 u/t 都当成本站的
  if (!host) return null;
  try {
    const ws = await browserWs(port);
    if (!ws) return null;
    const cdp = await Cdp.connect(ws);
    try {
      const all = (await cdp.send('Storage.getCookies', {})).cookies || [];
      const pairs = all
        .filter((c) => String(c.domain).includes(host) && !c.name.endsWith('_t'))
        .map((c) => ({ name: c.name, value: c.value }));
      const has = (n) => pairs.some((c) => c.name === n);
      if (!has('u') || !has('t')) return null; // 没登录，或只有中间态
      return { pairs, cookieHeader: pairs.map((c) => `${c.name}=${c.value}`).join('; ') };
    } finally {
      await cdp.close();
    }
  } catch {
    return null;
  }
}

/// 把 4A cookie 写进浏览器（幂等覆盖），返回成功条数
export async function ensure4aCookies(port, pairs) {
  if (!pairs || !pairs.length) return 0;
  const pages = await listPages(port);
  const page = pages.find((t) => t.type === 'page');
  if (!page) throw new Error('浏览器里没有可用的标签页');
  const cdp = await Cdp.connect(`ws://localhost:${port}/devtools/page/${page.id}`);
  try {
    await cdp.send('Network.enable');
    let ok = 0;
    for (const c of pairs) {
      const r = await cdp.send('Network.setCookie', {
        name: c.name,
        value: c.value,
        domain: U4A_HOST,
        path: '/',
        secure: true,
        httpOnly: false,
      });
      if (r.success) ok++;
    }
    return ok;
  } finally {
    await cdp.close();
  }
}

/// 把 urls 逐个开成标签页。一个开失败不影响另一个，返回 [{url, ok, error}]
/// 给了 currentUser 就先开 about:blank、装注入脚本再导航 —— 页面首帧前
/// sessionStorage 里已有登录态，省掉整套 CAS 换票。
export async function openTabs(port, urls, { currentUser } = {}) {
  const out = [];
  for (const url of urls) {
    try {
      if (!currentUser) {
        await openTab(port, url);
        out.push({ url, ok: true });
      } else {
        const tab = await openTab(port, 'about:blank');
        const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
        try {
          await cdp.send('Page.enable');
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `sessionStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify(currentUser))});`,
          });
          await cdp.send('Page.navigate', { url });
        } finally {
          await cdp.close();
        }
        out.push({ url, ok: true });
      }
    } catch (e) {
      out.push({ url, ok: false, error: e.message });
    }
  }
  // 导航刚发出就退出，libuv 关 ws 时未收干净会撞 assertion；给底层一拍
  if (currentUser) await sleep(120);
  return out;
}

/// 起一个可见的 Chrome，返回端口。detached + unref：CLI 退出后浏览器留着。
async function launchVisible(profileDir, preferPort) {
  const exe = findChrome();
  if (!exe) throw new Error('未找到 Chrome，可用 BPM_CHROME 指定');
  const port = await portFor(preferPort);
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // 4A 是自签证书；不加这个 Chrome 会停在「隐私设置错误」页
      '--ignore-certificate-errors',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true, windowsHide: false },
  );
  // 不要听 child 的 'exit' 当失败信号：Chrome 起窗时有 launcher 交接，
  // 那个进程提前退出是正常的，端口起来与否才是唯一判据。
  // 但 'error' 必须接住：路径不存在时 spawn 会 emit error，没人监听就直接崩，
  // 用户看不到「Chrome 起不来」这句人话。
  child.on('error', () => {});
  child.unref();
  try {
    for (let i = 0; i < 60; i++) {
      if (await browserWs(port)) return port;
      await sleep(150);
    }
    throw new Error('Chrome 启动超时');
  } catch (e) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw new Error(
      `Chrome 起不来（端口 ${port} 一直没监听）。若这个 profile 已被另一个 Chrome 占着，` +
        `先关掉那个窗口，或用 --profile 指定别的目录：${e.message}`,
    );
  }
}

/// 打开 4A / BPM 页面。
///   preferPort 有且浏览器在线 → 复用它；否则起一个新的可见 Chrome。
/// 两种情况都不关浏览器（那是用户要用的窗口）。
export async function openInChrome({ urls, cookiePairs, port, newWindow = false, profile, currentUser, bpmOnly }) {
  const prefer = port || cdpPort();

  if (!newWindow && (await browserWs(prefer))) {
    // 复用：顺手把本地 cookie 推进去，保证 4A 标签页一定已登录
    const wrote = cookiePairs ? await ensure4aCookies(prefer, cookiePairs) : 0;
    const results = await openTabs(prefer, urls, { currentUser: bpmOnly ? currentUser : undefined });
    return { mode: 'reused', port: prefer, wrote, results };
  }

  const dir = profile || uiProfileDir();
  // 起窗前先清一次历史遗留目录，别让 %TEMP% 越攒越多
  sweepOldProfiles();
  // 起窗前先盯住目标端口：占上了，下次调用就能自动复用它（而不必再加 --port）
  const p = await launchVisible(dir, prefer);
  const wrote = cookiePairs ? await ensure4aCookies(p, cookiePairs) : 0;
  const results = await openTabs(p, urls, { currentUser: bpmOnly ? currentUser : undefined });
  // 新窗口起手带了个 about:blank，页面开完就收掉，别给用户留额外空标签
  try {
    const pages = await listPages(p);
    for (const t of pages) {
      if (t.type === 'page' && t.url === 'about:blank') await closeTab(p, t.id);
    }
  } catch {
    /* 关不掉就算了，不影响结果 */
  }
  return { mode: 'launched', port: p, profile: dir, wrote, results };
}

/// 关掉一个标签页（browser 不默认关，留着给测试用）
export async function closeTab(port, id) {
  return jsonReq(port, { method: 'PUT', path: '/json/close/' + id });
}
