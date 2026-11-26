// bpm.mjs init：首次配置引导 + 环境检查。绝不发 SIM 认证。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { findChrome } from './cdp.mjs';
import { cdpPort, openInChrome, read4aCookies } from './browser.mjs';
import { probe4a } from './bpm.mjs';
import {
  CONFIG_FILE,
  CONFIG_KEYS,
  REQUIRED_KEYS,
  STATE_DIR,
  envOverrides,
  readConfig,
  resolveConfig,
  writeConfig,
} from './config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATES_DIR = process.env.BPM_TEMPLATE_DIR || path.join(ROOT, 'templates');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

const MASK = (v) => (v && v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v ? '******' : '');

async function timedFetch(url, init, ms = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    return { status: r.status, text: (await r.text()).slice(0, 300) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? `超时 ${ms}ms` : e.message };
  } finally {
    clearTimeout(t);
  }
}

/// 只读探测。任一致命项失败 → 不该写配置。
/// 本地项（Node/Chrome/状态目录/模板/输出根）是瞬时的，先出；
/// 三个网络项各自要 1~2 秒，必须并发 —— 串行跑等于把最慢三件事加起来。
/// browserCookie：调用方已经读到的 4A cookie。给了就省掉一次端口探测。
export async function runChecks(cfg = resolveConfig(), { browserCookie } = {}) {
  const checks = [];
  const add = (key, label, ok, detail, fatal = false) => checks.push({ key, label, ok, detail, fatal });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', 'Node', major >= 20, `v${process.versions.node}${major >= 20 ? '' : '（需 ≥ 20）'}`, true);

  const chrome = findChrome();
  add('chrome', '浏览器', !!chrome, chrome || '未找到，PDF 与 browser 不可用；设 BPM_CHROME', false);

  let stateOk = false;
  let stateDetail = STATE_DIR;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const probe = path.join(STATE_DIR, '.init-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    stateOk = true;
  } catch (e) {
    stateDetail = `${STATE_DIR}（${e.message}）`;
  }
  add('state', '状态目录', stateOk, stateDetail, true);

  const tpl = ['nil', 'nil-s'].map((n) => ({ n, ok: fs.existsSync(path.join(TEMPLATES_DIR, n)) }));
  const tplBad = tpl.filter((t) => !t.ok).map((t) => t.n);
  add(
    'templates',
    '交维模板',
    tplBad.length === 0,
    tplBad.length ? `缺 ${tplBad.join(', ')}（重拷 templates/ 或设 BPM_TEMPLATE_DIR）` : `${TEMPLATES_DIR}（2 套）`,
    true,
  );

  const outOk = fs.existsSync(cfg.outRoot);
  add('outRoot', '输出根目录', outOk, outOk ? cfg.outRoot : `${cfg.outRoot}（不存在，稍后可创建）`, false);

  // 三项网络探测并发，结果按 u4a → bpm → browser4a 的固定顺序插回来
  const [a4, bpm, browser4a] = await Promise.all([
    // 没配地址就别发请求了，说清楚「未配置」比抛 URL 解析错有用
    !cfg.u4aBase
      ? { label: '4A 可达', ok: false, detail: '未配置，跑 bpm init', fatal: true }
      : timedFetch(`${cfg.u4aBase}/loading.do?rnd=${Math.random()}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: '',
        }).then((r) => ({ label: '4A 可达', ok: !r.error, detail: r.error || `${cfg.u4aBase}（HTTP ${r.status}）` })),

    !cfg.bpmBase
      ? { label: 'BPM 可达', ok: false, detail: '未配置，跑 bpm init', fatal: true }
      : timedFetch(`${cfg.bpmBase}/ucService/sys/sysType/v1/getTypesByKey?typeKey=FLOW_TYPE&flowReqType=todo`, {}).then(
          (r) => ({ label: 'BPM 可达', ok: !r.error, detail: r.error || `${cfg.bpmBase}（HTTP ${r.status}）` }),
        ),

    browserCookie !== undefined
      ? browserCookie
      : read4aCookies()
          .then((c) => c)
          .catch(() => null),
  ]);

  add('u4a', a4.label, a4.ok, a4.detail, !!a4.fatal);
  add('bpm', bpm.label, bpm.ok, bpm.detail, !!bpm.fatal);
  add(
    'browser4a',
    'Chrome 已登录 4A',
    !!browser4a,
    browser4a ? '可直接复用浏览器会话，无需 SIM 凭据' : '未检测到（可选）',
    false,
  );

  return checks;
}

function printChecks(checks) {
  for (const c of checks) {
    const mark = c.ok ? G('✔') : c.fatal ? R('✘') : Y('·');
    console.log(`  ${mark} ${c.label}  ${DIM(c.detail)}`);
  }
}

const fatalFailed = (checks) => checks.some((c) => c.fatal && !c.ok);

/// timedFetch 会把 body 截到 300 字符，探测要解析 JSON，另开一个。
async function timedJson(url, init = {}, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 就让调用方看 status */
    }
    return { status: r.status, json, head: text.slice(0, 200) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? `超时 ${ms}ms` : e.message };
  } finally {
    clearTimeout(t);
  }
}

const u4aHeaders = (u4aBase, cookie) => ({
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: `${u4aBase}/index.html`,
  ...(cookie ? { Cookie: cookie } : {}),
});

/// 只验「能不能复用」：读这个端口的 4A cookie，再用 loading.do 确认会话活着。
/// 读不到或会话已失效都返回 null —— 复用一个坏掉的浏览器就是在等超时。
async function reuseOnly(port, host, u4aBase) {
  const hdr = (await read4aCookies(port, host))?.cookieHeader;
  if (!hdr) return null;
  return (await probe4a(hdr)) ? hdr : null;
}

/// 等用户在 Chrome 里登录 4A。拿到 cookie 立刻返回，超时返回 null。
/// 间隔从 2 秒收到 0.5 秒：登录成功后不要再多等两秒才继续。
async function waitFor4aLogin(port, host, { timeoutMs, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastNote = 0;
  for (;;) {
    const got = await read4aCookies(port, host);
    if (got) return got.cookieHeader;
    if (Date.now() >= deadline) return null;
    if (Date.now() - lastNote > 10000) {
      lastNote = Date.now();
      console.log(DIM('  等待登录中…（登录成功后会自动继续）'));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/// 拿 BPM 那个资源。先按名字搜，搜不到再全量扫 actionUrl。
async function findBpmResource(u4aBase, cookie) {
  const post = (body) =>
    timedJson(`${u4aBase}/sso/pagequeryres.do?isRoamRes=1&rnd=${Math.random()}`, {
      method: 'POST',
      headers: u4aHeaders(u4aBase, cookie),
      body,
    });

  const byActionUrl = (rows) =>
    (rows || []).find((r) => /loginFor4A/i.test(r?.resource?.actionUrl || '')) || null;

  let r = await post('draw=1&start=0&length=1&search[value]=BPM');
  let rows = r?.json?.data || [];
  if (byActionUrl(rows)) return rows;

  // 名字搜索没命中（改了名 / 多语言）就全量翻一遍
  r = await post('draw=1&start=0&length=500');
  rows = r?.json?.data || [];
  if (byActionUrl(rows)) return rows;
  return rows.length ? rows : null;
}

/// 用已登录的 4A session 反查能自动填的配置项。只读，不发 SIM 认证。
/// 导出是为了能被单独验证（不需要起 Chrome）。
export async function deriveConfig(cookie, u4aBase) {
  const patch = {};
  const done = [];
  const failed = [];

  // 资源、会话、用户是三条独立的只读链，并发跑；谁先回来不影响结果顺序。
  const [rows, load] = await Promise.all([
    findBpmResource(u4aBase, cookie),
    timedJson(`${u4aBase}/loading.do?rnd=${Math.random()}`, {
      method: 'POST',
      headers: u4aHeaders(u4aBase, cookie),
      body: '',
    }),
  ]);
  const row = (rows || []).find((x) => /loginFor4A/i.test(x?.resource?.actionUrl || '')) || rows?.[0];
  if (row) {
    const res = row.resource || {};
    const acc = (row.accounts || [])[0] || {};
    if (res.id) {
      patch.ssoResId = res.id;
      done.push('ssoResId');
    }
    if (acc.id) {
      patch.ssoAccId = acc.id;
      done.push('ssoAccId');
    }
    if (acc.name) {
      patch.ssoAccName = acc.name;
      done.push('ssoAccName');
    }
    // BPM 地址直接从资源的 actionUrl 推：它就是门户前端所在的那台
    if (res.actionUrl) {
      try {
        patch.bpmBase = new URL(res.actionUrl).origin;
        done.push('bpmBase');
      } catch {
        /* 解不出来就留给用户 */
      }
    }
    // clientSofts 里挑「本机 Chrome」那条，就是 browser 子命令要用的 clientId
    const soft = (row.clientSofts || []).find(
      (s) => s.clientSoftFlag === 'webAppByChrome' && s.serverType === 'LOCAL',
    );
    if (soft?.id) {
      patch.ssoClientId = String(soft.id);
      done.push('ssoClientId');
    } else {
      failed.push('ssoClientId（没找到本机 Chrome 客户端）');
    }
  } else {
    failed.push('SSO 三元组（页面上找不到 BPM 资源）');
  }

  // loading.do 给出 user.id，findById 再拿 mobile（= SIM_U）与 tenant
  const uid = load?.json?.data?.user?.id;
  if (!uid) {
    failed.push('simU / tenant（4A 会话已失效）');
    return { patch, done, failed };
  }

  const who = await timedJson(`${u4aBase}/user/findById.do?rnd=${Math.random()}`, {
    method: 'POST',
    headers: u4aHeaders(u4aBase, cookie),
    body: `id=${encodeURIComponent(uid)}`,
  });
  const u = who?.json?.data;
  if (u) {
    // mobile 这串密文就是 simauth.do 里的 u=
    if (u.mobile) {
      patch.simU = u.mobile;
      done.push('simU');
    } else failed.push('simU');
    if (u.tenant) {
      patch.tenant = u.tenant;
      done.push('tenant');
    } else failed.push('tenant');
    // findById 的 userId 是登录账号，比资源上的 accName 更准
    if (u.userId) {
      patch.ssoAccName = u.userId;
      if (!done.includes('ssoAccName')) done.push('ssoAccName');
    }
  } else {
    failed.push('simU / tenant（findById 无数据）');
  }

  return { patch, done, failed };
}

/// 把 stdin 包成一个「按需下一行」的函数。
/// rl.question 那种逐次注册监听的做法在管道输入下会丢行（一次性到齐的数据没人接），
/// 所以自己缓冲：迭代 readline 的异步迭代器，每次取一行。
function lineReader() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  let done = false;
  return {
    async next(prompt) {
      process.stdout.write(prompt);
      if (done) return null;
      const r = await it.next();
      if (r.done) {
        done = true;
        return null;
      }
      // 管道输入不会回显，自己补一个换行让日志 readable
      if (!process.stdin.isTTY) process.stdout.write('\n');
      return r.value;
    },
    close: () => rl.close(),
  };
}

/// 提问：显示当前生效值，回车保留。mask 用于密码类。
async function ask(io, label, current, { mask = false } = {}) {
  const shown = mask ? MASK(current) : current;
  const q = current ? `${label} [${shown}]: ` : `${label}: `;
  const line = await io.next(q);
  const v = (line ?? '').trim();
  if (v === '') return current;
  return v;
}

async function confirm(io, label, dflt = true) {
  const ans = await ask(io, `${label} ${dflt ? '[Y/n]' : '[y/N]'}`, '');
  if (!ans) return dflt;
  return !/^n/i.test(ans);
}

const GUIDE = `
--no-browser：逐项手填。这些值在 4A 已登录的前提下都能从接口反查，
默认路径（不加 --no-browser）会起 Chrome 让你登录一次后自动填好，不用抄。
两个地址是内置默认值，不用填。

  accName        4A 登录用的账号
  resId/accId/clientId
                 F12 Network 找 sso/ssoLogin.do 的请求体，三个同名参数原样复制
  SIM_U          4A 登录页 F12 Network 找 sim/simauth.do，请求体里 u= 后面那串
  TENANT         同一个请求体里的 tt=
`;

const LABELS = {
  u4aBase: '4A 地址',
  bpmBase: 'BPM 地址',
  ssoAccName: '4A 主账号 accName',
  ssoResId: 'SSO resId',
  ssoAccId: 'SSO accId',
  ssoClientId: 'SSO clientId',
  simU: 'SIM 手机号密文 SIM_U',
  tenant: '租户 TENANT',
  outRoot: '交维输出根目录',
  computeKeywords: '判定「计算资源」的附件关键词',
};

export async function runInit(argv) {
  const flag = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const has = (name) => argv.includes('--' + name);

  const asJson = has('json');
  const checkOnly = has('check');
  const autoYes = has('yes');
  const noBrowser = has('no-browser');
  const resetOnly = has('reset');

  const KNOWN = ['--json', '--check', '--yes', '--set', '--no-browser', '--reset'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') {
      i++;
      continue;
    }
    if (!KNOWN.includes(a)) {
      console.error(`未知参数: ${a}\n只能给 --check / --yes / --no-browser / --reset / --set key=value / --json`);
      process.exitCode = 2;
      return;
    }
  }

  // --set key=value，可重复
  const sets = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--set') continue;
    const raw = argv[i + 1] || '';
    const eq = raw.indexOf('=');
    if (eq < 1) {
      console.error(`--set 要写成 key=value，收到: ${raw}`);
      process.exitCode = 2;
      return;
    }
    const k = raw.slice(0, eq).trim();
    const v = raw.slice(eq + 1);
    if (!CONFIG_KEYS.includes(k)) {
      console.error(`未知配置项: ${k}\n合法项: ${CONFIG_KEYS.join(', ')}`);
      process.exitCode = 2;
      return;
    }
    sets[k] = v;
  }

  // --reset：把配置删干净。只删 config.json —— session/token/auth-log 是缓存不是配置，
  // 删掉 auth-log 会丢冷却时间戳，可能触发一次不该发的 SIM 认证。
  if (resetOnly) {
    const existed = fs.existsSync(CONFIG_FILE);
    if (existed) fs.rmSync(CONFIG_FILE, { force: true });
    if (asJson) {
      console.log(JSON.stringify({ removed: existed, configFile: CONFIG_FILE }, null, 2));
    } else if (existed) {
      console.log(`已删除 ${CONFIG_FILE}`);
      console.log(DIM('再跑一次 bpm.mjs init 重新配置。'));
    } else {
      console.log(`配置本来就是空的（${CONFIG_FILE} 不存在）`);
    }
    process.exitCode = 0;
    return;
  }

  let cfg = resolveConfig();
  let checks = await runChecks(cfg);

  if (checkOnly) {
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            ok: !fatalFailed(checks),
            checks,
            config: { ...cfg, simU: { set: !!cfg.simU } },
            overrides: envOverrides(),
            configFile: CONFIG_FILE,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`环境检查  (${fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : '未找到 config.json，使用打包默认值'})`);
      console.log('');
      printChecks(checks);
      const hard = checks.filter((c) => c.fatal && !c.ok);
      if (hard.length) {
        console.log('');
        console.log(R(`有 ${hard.length} 项必须先修好，否则跑不了。`));
      }
    }
    process.exitCode = fatalFailed(checks) ? 1 : 0;
    return;
  }

  // ---- 写配置的路径 ----
  // --yes 落一份完整基线（明确写出所有生效值），--set 只覆盖点名的那几项
  const patch = autoYes ? { ...cfg, ...sets } : { ...sets };
  // 这一次跑里验证过的 4A cookie；写完配置后复查环境时直接复用，不再探端口
  let liveCookie;

  // 给了 --set 就算非交互：不再提问，只写点名的那几项
  if (!autoYes && Object.keys(sets).length === 0) {
    if (!process.stdin.isTTY) {
      console.error(
        '当前不是交互终端，init 无法逐项提问。\n' +
          '  起 Chrome 自动探测（需 GUI）: 在交互终端里跑 bpm.mjs init\n' +
          '  非交互写法: bpm.mjs init --set outRoot=D:\\交维\\待交维 --set simU=<值>\n' +
          '  只做检查  : bpm.mjs init --check\n' +
          '  沿用现值  : bpm.mjs init --yes',
      );
      process.exitCode = 2;
      return;
    }

    console.log('环境检查');
    console.log('');
    printChecks(checks);
    console.log('');

    const io = lineReader();
    const savedRaw = readConfig();
    const fresh = Object.keys(savedRaw).length === 0;
    const port = cdpPort();
    const loginTimeout = Number(process.env.BPM_INIT_LOGIN_TIMEOUT_MS || 180000);

    try {
      // ---- 第 1 步：两个地址是内置默认值，不问 ----
      const u4aBase = cfg.u4aBase;
      if (noBrowser) {
        if (fresh) console.log(DIM('跳过浏览器探测，逐项手填。'));
        console.log(GUIDE);
        for (const k of CONFIG_KEYS) {
          if (k === 'u4aBase' || k === 'bpmBase' || k === 'outRoot' || k === 'computeKeywords') continue;
          const v = await ask(io, LABELS[k], cfg[k], { mask: k === 'simU' });
          if (v !== cfg[k]) patch[k] = v;
        }
      } else {
        // 先确认这个地址真打得通，别让用户干等 180 秒才发现网络没连上
        const probe = await timedJson(`${u4aBase}/loading.do?rnd=${Math.random()}`, {
          method: 'POST',
          headers: u4aHeaders(u4aBase, ''),
          body: '',
        });
        if (probe.error) {
          console.error(R(`连不上 ${u4aBase}：${probe.error}`));
          console.error(DIM('检查网络（4A 是自签证书，已跳过校验；VPN/内网要连上）。'));
          process.exitCode = 1;
          return;
        }

        console.log('');
        // 端口上有 Chrome 不等于它是我的：先读 cookie，再拿 loading.do 验一遍。
        // 不验就复用，会对着一个没登录 4A 的窗口干等到超时（占着 9222 的
        // 别的调试 Chrome 就是这种）。
        const u4aHost = (() => {
          try {
            return new URL(u4aBase).hostname;
          } catch {
            return u4aBase;
          }
        })();
        let opened = await openInChrome({ urls: [], port });
        let cookie = await reuseOnly(opened.port, u4aHost, u4aBase);
        if (cookie) {
          console.log(DIM(`  复用端口 ${opened.port} 上已登录的浏览器（会话有效）`));
        } else {
          // 复用到的这个浏览器没法用：起一个自己的可见 Chrome，让用户在里面登录
          console.log('正在打开 Chrome，请在弹出的窗口里登录 4A（登录成功后会自动继续）');
          opened = await openInChrome({ urls: [`${u4aBase}/index.html`], port, newWindow: true });
          console.log(DIM(`  ${opened.mode === 'reused' ? '复用' : '已启动'} Chrome（端口 ${opened.port}）`));
          cookie = await reuseOnly(opened.port, u4aHost, u4aBase);
          if (!cookie) cookie = await waitFor4aLogin(opened.port, u4aHost, { timeoutMs: loginTimeout });
          if (!cookie) {
            console.log(R(`  等不到 4A 登录（${Math.round(loginTimeout / 1000)} 秒）。`));
            console.log(DIM('  登录好后重跑一次 init 即可；也可以用 --no-browser 逐项手填。'));
            process.exitCode = 1;
            return;
          }
        }
        liveCookie = cookie;

        console.log('');
        console.log('正在从接口反查配置…');
        const { patch: got, done, failed } = await deriveConfig(cookie, u4aBase);
        for (const k of done) console.log(`  ${G('✔')} ${LABELS[k] || k}`);
        for (const f of failed) console.log(`  ${Y('·')} ${f} ${DIM('（没探到，保留原值）')}`);
        for (const [k, v] of Object.entries(got)) if (v) patch[k] = v;

        const missing = REQUIRED_KEYS.filter((k) => !(patch[k] ?? cfg[k]));
        if (missing.length) {
          console.log('');
          console.log(Y(`还差 ${missing.length} 项没探到，逐个补一下（回车跳过）：`));
          for (const k of missing) {
            const v = await ask(io, LABELS[k], cfg[k], { mask: k === 'simU' });
            if (v) patch[k] = v;
          }
        }
      }

      // ---- 最后：只有输出根目录与机器有关，得由用户定；骨架关键词是公司统一规则，
      //      默认值够用，改它走 --set computeKeywords=... 或 BPM_COMPUTE_KEYWORDS，不在这里问 ----
      console.log('');
      const o = await ask(io, `${LABELS.outRoot}（回车用 ${cfg.outRoot}）`, '');
      if (o) patch.outRoot = path.resolve(o);

      const finalOut = patch.outRoot || cfg.outRoot;
      if (!fs.existsSync(finalOut)) {
        if (await confirm(io, `目录不存在，创建 ${finalOut} ？`, true)) {
          try {
            fs.mkdirSync(finalOut, { recursive: true });
          } catch (e) {
            console.log(R(`创建失败: ${e.message}`));
          }
        }
      }
    } finally {
      io.close();
    }
  }

  if (fatalFailed(checks) && Object.keys(patch).length === 0) {
    console.error('有致命项未通过，且没有要写入的配置。先修环境。');
    process.exitCode = 1;
    return;
  }

  if (Object.keys(patch).length) writeConfig(patch);
  cfg = resolveConfig();

  // 常量是 import 时算的，写盘后要自己再探一遍才算数。
  // 交互路径里刚验证过会话，cookie 直接传进去，省掉一次端口探测。
  checks = await runChecks(cfg, { browserCookie: liveCookie });

  if (asJson) {
    console.log(
      JSON.stringify(
        { written: patch, configFile: CONFIG_FILE, ok: !fatalFailed(checks), checks, config: { ...cfg, simU: { set: !!cfg.simU } } },
        null,
        2,
      ),
    );
    process.exitCode = fatalFailed(checks) ? 1 : 0;
    return;
  }

  console.log('');
  if (Object.keys(patch).length) console.log(`已写入 ${G(CONFIG_FILE)}`);
  else console.log(`配置未变（${CONFIG_FILE}）`);

  const hard = checks.filter((c) => c.fatal && !c.ok);
  if (hard.length) {
    console.log('');
    console.log(R(`仍有 ${hard.length} 项致命问题：`));
    printChecks(hard);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('下一步');
  console.log(`  node ${path.join(ROOT, 'bin', 'bpm.mjs')} session     ${DIM('# 验会话（首次可能要 SIM 认证，约 20 秒）')}`);
  console.log(`  node ${path.join(ROOT, 'bin', 'bpm.mjs')} list        ${DIM('# 看待办')}`);
  console.log(`  node ${path.join(ROOT, 'bin', 'bpm.mjs')} init --check   ${DIM('# 只复查环境，不改配置')}`);
  // 不用 process.exit：Windows 上 stdout 是管道时硬退出会在 libuv 里撞
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。设退出码让进程自然结束。
  process.exitCode = 0;
}
