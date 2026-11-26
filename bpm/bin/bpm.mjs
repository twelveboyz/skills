#!/usr/bin/env node
// bpm 命令行入口，同时是可注入的 main(argv, deps)：
//   生产：node bin/bpm.mjs <action> …  走默认 deps（真 Chrome 的 CDP 层、真 BPM 接口、真状态目录）。
//   测试：import { main } 自己喂 argv 和假 http / 假 trigger / 临时状态目录，一个字节都不出网。

// 4A 用的是自签证书（DEPTH_ZERO_SELF_SIGNED_CERT），不跳过就整条 4A 链 fetch failed。
// 必须在任何 lib 的静态 import 之前设 —— lib/session.mjs 加载时就要用。
// 只在被当入口执行时设，测试 import 本文件不会被动改全局 TLS 行为。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSession, peekSession } from '../lib/session.mjs';
import {
  BPM,
  getToken,
  peekToken,
  currentUserOf,
  getTodoList,
  getDoneList,
  getTaskDetail,
  getInstForm,
  getTaskInfo,
  getInstance,
  downloadFile,
  exportResourceOrderTemplate,
  uploadFile,
  saveFormData,
  inputResource,
  getResourceStatus,
  triggerManagement,
} from '../lib/bpm.mjs';
import { renderForm } from '../lib/form.mjs';
import { collectAttachments, saveBuffer, uniqueName } from '../lib/attach.mjs';
import {
  SINGLE,
  acceptMap,
  collectPlan,
  dataKeyOf,
  detectSafeAcceptance,
  zipDir,
} from '../lib/handover.mjs';
import { applySkeleton, detectSkeleton, outputRoot, projectDirName, slotOf } from '../lib/layout.mjs';
import { renderTicketPdf, findChrome } from '../lib/pdf.mjs';
import { closeTab, openInChrome, pairsOf, read4aCookies } from '../lib/browser.mjs';
import { U4A_HOME, U4A_HOST } from '../lib/config.mjs';
import { listPages } from '../lib/cdp.mjs';
// onboard 的报告与留底只增不改，静态 import 没有副作用（不读配置、不连浏览器）。
import { renderOnboard, toView, saveResult, exitCodeOf, exitReasonOf } from '../lib/onboard.mjs';
// 这几个只在真跑时按需 import：静态 import 会立刻读本机配置/会话，import 这个文件本身不该有副作用 ——
// 测试要能 import 进来只验参数纠错，连配置都不必存在。
const lazy = {
  config: () => import('../lib/config.mjs'),
  init: () => import('../lib/init.mjs'),
  osa: () => import('../lib/osa.mjs'),
  osaCdp: () => import('../lib/osa-cdp.mjs'),
  lookup: () => import('../lib/lookup.mjs'),
};

// 参数绑定：全部从 main 收到的 argv 派生 —— 模块加载时不碰 process.argv，
// 测试才能 import 进来自己喂一套参数（这就是那个注入缝）。
let argv = [];
let action;
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes('--' + name);

// handover 待上传清单的表头。只给中文，不给字段英文名
const USAGE = `用法: bpm.mjs <init|list|done|cat|download|handover|onboard|browser|session|login> [参数]
  init                首次配置：起 Chrome 让你登录一次 4A，自动探测并写入本机配置
                      （只读 cookie 与接口，不发 SIM 认证）
  list                列待办工单
  done                列已办工单
  cat <id>            打印工单内容（id 传待办行的 id 或 15 位流程实例号都行）
  download <id>       下载工单全部附件，并生成工单页 PDF（自动套交维目录骨架）
  handover <id>       交维：上传交维目录里的交付物 → 保存表单 → 触发资源录入
  onboard <arg>       点纳管（没纳管过才点）并守在原地等出结果，最后给逐台结论
                       arg 传 projectId，或批次关键字（如 E605）：关键字去 osa 搜，唯一命中直接用；
                       命中多个列出候选并以非零退出码停下（不替用户猜），零命中报错；
                       命中的关键字记进缓存，同一个关键字下次不再搜
  onboard <arg> --status
                       只读打印纳管进度：工单级进度 + 逐台「自动化程序 / zabbix / filebeat」
  browser             用 Chrome 打开 4A / BPM / 集中运维平台（已登录态）
  session             只验 4A 会话（复用缓存，不重新认证）
  login               强制重新走一次 SIM 认证
  --page N --size N   list/done 分页
  --downloads         download 输出到用户下载目录（默认输出到交维根目录）
  --no-files          download 只生成 PDF
  --no-pdf            download 只下附件
  --dir 目录          handover 的交维目录（默认按 download 的规则推算）
  --yes               handover 真发请求（不加只做 dry-run，打印将要做的事）
  --skip-input        handover 只上传并保存，不触发资源录入
  --url 4a|bpm|osa|all  browser 开哪些页面（默认 both；all 为三个都开）
  --port N            browser / onboard 用哪个调试端口（默认 9222）
  --new               browser 强制新开一个 Chrome，不占用现有窗口
  --profile 目录      browser --new 时的 profile 目录
  --status            onboard 只读：打印纳管进度，绝不点纳管
  --watch             onboard 只读：守着盯到「每台都轮到过一次」再报，绝不点纳管。
                      osa 是逐台排队执行的，没轮到的台 IP 空、三格全「待检测」；
                      失败也算轮过，判据是每台的 IP 出来或三格不再全「待检测」
                      （间隔与超时用下面两个，watch 下默认 300 秒 / 1440 分钟）
  --install           onboard 连已纳管过的批次也重新点一次纳管再等；批次在「验证中」时拒绝，
                      要真点就再加 --force（重复点会发生什么没人实测过）
  --force             onboard 配合 --install：绕过「验证中不许重装」那道闸
  --interval N        onboard 轮询间隔秒数（点纳管默认 20；--watch 默认 300）
  --timeout N         onboard 总超时分钟数（点纳管默认 60，--watch 默认 1440）；
                      到点不挂死，打当前进度并非零退出
  （onboard 每次都在状态目录（BPM_STATE_DIR，默认 ~/.agents/skills/bpm/cache）下
    onboard-<UTC 时间戳>/result.json 留一份明细，终端只打摘要，不生成 md）
  --json              输出原始 JSON（给下游程序用）
  init --check        只检查环境，不改配置
  init --reset        删掉缓存里的 config.json，回到未配置状态
  init --yes          全部沿用当前生效值，直接写盘
  init --no-browser   不起 Chrome，回到逐项手填（无 GUI / 无 Chrome 时用）
  init --set k=v      非交互设置配置项（可重复），k ∈
                      ${'u4aBase,bpmBase,ssoAccName,ssoResId,ssoAccId,ssoClientId,simU,tenant,outRoot,computeKeywords'}`;

/// 取工单详情 + 流程实例号 + 标题。17 位是 taskId，15 位是 procInstId。
async function loadTicket(token, id) {
  const byTask = id.length >= 16;
  const ok = (r) => !!(r && r.form);
  let detail;
  try {
    detail = await (byTask ? getTaskDetail(token, id) : getInstForm(token, id));
    if (!ok(detail)) throw new Error(JSON.stringify(detail).slice(0, 160));
  } catch (e) {
    detail = await (byTask ? getInstForm(token, id) : getTaskDetail(token, id));
    if (!ok(detail)) throw new Error(`${id} 取不到工单内容: ${e.message}`);
  }
  let instId = id;
  let task = null;
  if (byTask) {
    const info = await getTaskInfo(token, id);
    instId = info?.bpmTask?.procInstId || id;
    task = info?.bpmTask || null;
  }
  let title = '';
  const formKey = detail.form?.formKey;
  if (formKey && detail.data?.[formKey]?.order_title) title = detail.data[formKey].order_title;
  if (!title) {
    try {
      title = (await getInstance(token, instId))?.subject || '';
    } catch {
      /* 标题拿不到就退回实例号 */
    }
  }
  return { detail, instId, title: title || instId, task };
}
// Node 24 + Windows：两次以上 fetch 之后调 process.exit() 会撞
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。
// 所以主流程里一律用抛哨兵的方式退出，让进程自然结束。

class Exit {
  constructor(code) {
    this.code = code;
  }
}
const bail = (code) => {
  throw new Exit(code);
};


export async function main(argvIn = process.argv.slice(2), deps = {}) {
  const nl = String.fromCharCode(10);
  const D = { ...defaultDeps, ...deps };
  argv = argvIn;
  action = argv[0];
  if (!action || action === '--help' || action === '-h') {
    console.log(USAGE);
    return action ? 0 : 2;
  }
  const ACTIONS = ['init', 'list', 'done', 'cat', 'download', 'handover', 'onboard', 'browser', 'session', 'login'];
  if (!ACTIONS.includes(action)) {
    console.error(`未知动作: ${action}` + nl + nl + USAGE);
    return 2;
  }
  // 干净机器上没配置：直接告诉他跑 init，别让他在 fetch 报错里猜
  if (action !== 'init') {
    const miss = (await lazy.config()).missingKeys();
    if (miss.length) {
      console.error(`还没配置：缺 ${miss.join(', ')}` + nl + `先跑一次  node ${process.argv[1]} init  （加 --check 只看检查）`);
      return 2;
    }
  }
  // init 必须在取 token 之前跑完 —— 干净机器上没有 token 也没有 cookie
  if (action === 'init') {
    const { runInit } = await lazy.init();
    await runInit(argv.slice(1));
    return process.exitCode || 0;
  }
  const { STATE_DIR } = await lazy.config();
  // onboard：解析参数 → 定位工单 → 只读或点纳管守结果 → 人读报告 / --json。
  // http、trigger、stateDir 三样全从 deps 来：生产是 chrome 的 CDP 层 + BPM 接口 + 状态目录，
  // 测试注入假 http 与假 trigger，一个字节都不出网。
  async function runOnboard() {
    const arg = argv[1];
    if (!arg || arg.startsWith('--')) {
      console.error(`onboard 需要工单的 projectId，或批次关键字（如 E605）` + nl + nl + USAGE);
      bail(2);
    }
    // osa_web 的会话只存在于浏览器里（服务端请求不带可复制的 cookie），
    // 所以借 Chrome 里已登录的 osa_web 页面去 fetch，而不是在脚本侧换票。
    const { createCdpHttp } = await lazy.osaCdp();
    const { createOsaApi } = await import('../lib/osa-api.mjs');
    const { createLookup } = await lazy.lookup();
    const { OSA } = await lazy.osa();
    const http = D.http || createCdpHttp({ port: Number(flag('port', 9222)), host: D.osaHost || OSA.host });
    const api = D.createOsaApi ? D.createOsaApi({ http }) : createOsaApi({ http });
    // 参数可能是 projectId，也可能是批次关键字：统一在这里解析成 projectId。
    // 多命中和零命中都在 resolve 里停下，不替用户猜。
    const lookup = createLookup({ api, stateDir: D.stateDir || STATE_DIR, batchStatus: (o) => api.batchStatus(o) });
    const hit = await lookup.resolve(arg);
    if (hit.from === 'ambiguous') {
      // 多命中也是「结果」：字段形状固定成 {from:'ambiguous', via, input, candidates[]}，--json 原样给它
      if (has('json')) console.log(JSON.stringify(toView(hit), null, 2));
      else console.log(lookup.render(hit));
      bail(1);
    }
    const projectId = hit.projectId;
    // 先把「命中哪条」说清楚：后面要等的结果动辄几十分钟，先给一行定心
    if (!has('json')) console.log(lookup.render(hit));
    else console.error(lookup.render(hit)); // --json 时 stdout 只能有结果那一份 JSON
    let res;
    if (has('status')) {
      res = await api.batchStatus({ projectId });
    } else if (has('watch')) {
      // 盯排队跑完：纯只读，一次纳管都不点。轮询间隔默认 5 分钟（osa 的逐台队列按分钟级走），
      // 超时默认 24 小时（9 台按约 20 分钟一台，还有余量）；到点没跑完就报当前轮到哪台。
      res = await api.watchOnboard({
        projectId,
        pollMs: Number(flag('interval', 300)) * 1000,
        timeoutMs: Number(flag('timeout', 1440)) * 60_000,
        onChange: has('json') ? undefined : (snap, round) => {
          console.error(`第 ${round} 轮 ${new Date().toTimeString().slice(0, 5)}  已轮到 ${snap.attemptedCount}/${snap.hostCount} 台`);
        },
      });
    } else {
      // 点纳管走 BPM 域的接口（不是 osa_web）：token 只在真要发那一下时才取，
      // 所以所有不需要点纳管的批次（已纳管 / 验证中 / 还没到点）一个字节都不出网
      res = await api.runOnboard({
        projectId,
        trigger: async (orderNo) => D.trigger(orderNo, D.tokenOf ? D.tokenOf() : await tokenLazy()),
        // --install = 连已纳管过的也重点；--force 单独加不算数，它只解除「验证中」那道闸
        reinstall: has('install'),
        force: has('force'),
        pollMs: Number(flag('interval', 20)) * 1000,
        timeoutMs: Number(flag('timeout', 60)) * 60_000,
      });
    }
    // 明细留底：落状态目录（与 lookup.json 同一个根），终端只打摘要，不生成 md
    res.savedTo = saveResult(res, { root: D.stateDir || STATE_DIR });
    const view = toView(res);
    // --json 时 stdout 只留这一份 JSON，人话都走 stderr
    console.log(has('json') ? JSON.stringify(view, null, 2) : renderOnboard(res));
    if (view.savedTo) console.error(`明细已留底 ${view.savedTo}`);
    if (view.saveError) console.error(view.saveError);
    if (exitReasonOf(res) === 'timeout') {
      // 超时是「没等到」，不是「全失败」：报告里已经写明，退出码非零只表示没跑完。
      // --watch 与点纳管用的是两套默认值（1440 分钟 / 60 分钟），提示里不能写死其中一个。
      const waited = Math.round((res.timeoutMin || Number(flag('timeout', has('watch') ? 1440 : 60))));
      console.error(`超时退出：等了 ${waited} 分钟没等到终态；看进度 bpm onboard ${arg} --status`);
    }
    bail(exitCodeOf(res));
  }
  // 点纳管要 BPM 的 token；只读 --status 不要（也就不该为此换一轮票）
  async function bpmToken() {
    const quick = peekToken();
    if (quick) return quick.token;
    const s = await getSession({});
    return (await getToken(s.cookies)).token;
  }
  /// 惰性 token：trigger 被调用时才换票（D.tokenOf 给了就不换）
  let tokMemo;
  const tokenLazy = () => (tokMemo ||= bpmToken());
  try {
    // onboard 走 osa_web + 浏览器会话，不用 BPM 的 token：先它一步，
    // 参数问题也不该先换一轮票才报（换票要真打 4A）。
    if (action === 'onboard') bail(await runOnboard());
    // 有未过期的 JWT 就直接用：省掉 loading.do 的 1.4 秒和换票的 5.8 秒。
    // list/done/cat/download 都只要 token，不需要验 4A 会话本身。
    // browser/session/login 要动 4A 会话本身，走慢路。
    const needCookie = ['login', 'session', 'browser'].includes(action);
    const quick = needCookie ? null : peekToken();
    let user;
    let reused = true;
    let from = 'cache';
    // 快路：JWT 还没过期就直接用，连 4A 都不碰
    let tok = quick;
    let cookies;
    // 快路不拿会话对象，姓名得从缓存里补，否则下面打印 user.name 会炸
    if (quick) user = peekSession()?.user || {};

    if (action === 'browser') {
      // 慢路：先拿到 4A 会话（cookies 要写进浏览器）
      const s = await getSession({});
      cookies = s.cookies;
      user = s.user;
      reused = s.reused;
      from = s.from;
      // browser 要判断 4A 还是 BPM 的地址、开 BPM 页时还要注入登录态，JWT 得真的取一次。
      // getToken 第一个参数是 cookie 串，不能省。
      tok = peekToken() || (await getToken(cookies));
      const which = flag('url', 'both');
      // both 是历史别名；all = 三个都开
      const WANT = { '4a': ['4a'], bpm: ['bpm'], osa: ['osa'], both: ['4a', 'bpm'], all: ['4a', 'bpm', 'osa'] };
      if (!WANT[which]) {
        console.error(`--url 只认 4a / bpm / osa / both / all\n\n${USAGE}`);
        bail(2);
      }
      const want = WANT[which];
      const web = want.filter((k) => k !== 'osa');
      const openOsaToo = want.includes('osa');
      // BPM 页靠注入 sessionStorage.currentUser 登录（JWT 有缓存就直接用）；
      // 4A 页只靠 cookie。两页都不等渲染、不验工单，开完就交还给人。
      // 集中运维平台不在这里开：它要先拿一次性票据，见下面 openOsaToo 分支。
      const r = await openInChrome({
        // 只开 osa 时得留个白页，否则 Chrome 关掉唯一的标签页就退出了
        urls: web.length ? web.map((k) => (k === '4a' ? U4A_HOME : `${BPM}/front/flow/todo`)) : ['about:blank'],
        cookiePairs: pairsOf(cookies),
        port: Number(flag('port', 0)) || undefined,
        newWindow: has('new'),
        profile: flag('profile'),
        currentUser: web.includes('bpm') ? currentUserOf(tok) : null,
        bpmOnly: true,
      });
      console.log(
        r.mode === 'reused'
          ? `复用 ${r.port} 端口上的 Chrome`
          : `已启动 Chrome（端口 ${r.port}，profile ${r.profile}）`,
      );
      let bad = 0;
      for (const it of r.results) {
        if (it.url === 'about:blank') continue; // 占位页，不是给人看的
        if (it.ok) console.log(`✔ ${it.url.includes(U4A_HOST) ? '4A ' : 'BPM'} ${it.url}`);
        else {
          bad++;
          console.log(`✘ ${it.url}  ${it.error}`);
        }
      }
      if (openOsaToo) {
        try {
          const { openOsa, osaTicket } = await lazy.osa();
          const ticket = await osaTicket(cookies);
          console.log(`✔ osa  ${await openOsa(r.port, ticket)}`);
          // 只开 osa 时上面那个 about:blank 只是占位，别给人留一个空标签
          if (!web.length) {
            for (const t of await listPages(r.port)) {
              if (t.type === 'page' && t.url === 'about:blank') await closeTab(r.port, t.id);
            }
          }
        } catch (e) {
          bad++;
          console.log(`✘ osa  ${e.message}`);
        }
      }
      bail(bad ? 1 : 0);
    }
    // login / session 走慢路拿会话；这里把结果落到 user / from / cookies，
    // 下面「只认会话」的分支才有东西可打印（原来漏灌，login 直接报 .token 未定义）
    if (needCookie) {
      const s = await getSession({ allowAuth: action === 'login' });
      cookies = s.cookies;
      user = s.user;
      reused = s.reused;
      from = s.from;
    }
    // 快路没拿到（JWT 过期或没缓存）就走慢路：拿会话 cookie 再换票。
    // 基线 4b4428a 里这段在 else 分支，重构时连 tok 一起丢了。
    if (!tok) {
      const s = await getSession({});
      cookies = s.cookies;
      user = s.user;
      reused = s.reused;
      from = s.from;
      tok = await getToken(cookies);
    }
    // login / session 只认会话本身，到此为止；下面全都还要 JWT
    if (action === 'login') {
      console.log(`已认证: ${user.name} / ${String(user.id || '').slice(0, 4)}...`);
      bail(0);
    }
    if (action === 'session') {
      const src = { cache: '缓存', chrome: `Chrome ${flag('port', 9222)}`, auth: '刚认证' }[from] || from;
      console.log(`复用会话: ${user.name} / ${String(user.id || '').slice(0, 4)}...（${src}）`);
      bail(0);
    }
    const token = tok.token;
    if (action === 'cat') {
      const id = argv[1];
      if (!id || id.startsWith('--')) {
        console.error(`cat 需要工单 id\n\n${USAGE}`);
        bail(2);
      }
      // 17 位是 taskId（待办行的 id），15 位是流程实例号 procInstId；猜错就换另一个接口兜底
      const byTask = id.length >= 16;
      const ok = (r) => !!(r && r.form);
      let res;
      try {
        res = await (byTask ? getTaskDetail(token, id) : getInstForm(token, id));
        if (!ok(res)) throw new Error(JSON.stringify(res).slice(0, 160));
      } catch (e) {
        res = await (byTask ? getInstForm(token, id) : getTaskDetail(token, id));
        if (!ok(res)) throw new Error(`${id} 取不到工单内容: ${e.message}`);
      }
      if (has('json')) {
        console.log(JSON.stringify(res, null, 2));
        bail(0);
      }
      const { lines } = renderForm(res);
      console.log(`${id}  (${user.name}${reused ? ' · 复用会话' : ''})`);
      console.log('');
      for (const l of lines) console.log(l);
      bail(0);
    }
    if (action === 'download') {
      const id = argv[1];
      if (!id || id.startsWith('--')) {
        console.error(`download 需要工单 id\n\n${USAGE}`);
        bail(2);
      }
      const wantFiles = !has('no-files');
      const wantPdf = !has('no-pdf');
      const quiet = has('json');
      const say = (s) => !quiet && console.log(s);
      const { detail, instId, title, task } = await loadTicket(token, id);
      // 交维目录：认骨架 → 定槽位 → 推目录名 → 合并骨架（只补缺失，不覆盖人工文件）
      const list = collectAttachments(detail);
      const skel = detectSkeleton(list);
      const slot = slotOf(skel.name);
      const dirName = projectDirName(detail, instId);
      const outDir = path.join(outputRoot(has('downloads')), dirName);
      await applySkeleton(skel.name, outDir);
      const filesDir = path.join(outDir, slot.minutes);
      const entryDir = path.join(outDir, slot.entry);
      fs.mkdirSync(filesDir, { recursive: true });
      fs.mkdirSync(entryDir, { recursive: true });
      const manifest = { id, instId, title, outDir, dirName, skeleton: skel.name, hit: skel.hit, filesDir, entryDir, files: [], template: null, pdf: null };
      let failed = 0;
      say(`工单 ${id}  (${user.name}${reused ? ' · 复用会话' : ''})`);
      say(`实例 ${instId}  ${title}`);
      say(`输出 ${outDir}`);
      say(
        skel.hit
          ? `骨架 ${skel.name}（命中「${skel.hit}」：${skel.file}）`
          : `骨架 ${skel.name}（未命中计算资源关键词）`,
      );
      say('');
      // 附件走 HTTP、PDF 走浏览器，两条链互不依赖，并发跑能省掉一整个附件下载的时间
      const doFiles = async () => {
        if (!wantFiles) return;
        const seen = new Set();
        say(`附件 ${list.length} 个`);
        for (const f of list) {
          const item = { field: f.field, id: f.id, name: f.name, bytes: 0, path: '', ok: false };
          try {
            const { buf } = await downloadFile(token, f.id, instId);
            item.path = saveBuffer(filesDir, uniqueName(f.name, seen), buf);
            item.bytes = buf.length;
            item.ok = true;
            say(`  ✔ ${f.name}  ${buf.length} B`);
          } catch (e) {
            item.error = e.message;
            failed++;
            say(`  ✘ ${f.name}  ${e.message}`);
          }
          manifest.files.push(item);
        }
        // 表单里带「资源订购配置表模板」按钮时，顺手把这张空白模板也下下来。
        // 它不是上传附件，走的是 easyCmdb 的 exportTemplate。
        const html = detail.form?.formHtml || '';
        if (html.includes('downLoadResourceOrderConfiguration')) {
          const tpl = { name: '资源录入模板.xlsx', bytes: 0, path: '', ok: false };
          try {
            const { buf, filename } = await exportResourceOrderTemplate(token, instId, title);
            tpl.path = saveBuffer(entryDir, tpl.name, buf);
            tpl.bytes = buf.length;
            tpl.ok = true;
            if (filename && filename !== tpl.name) tpl.serverName = filename;
            say(`  ✔ ${tpl.name}  ${buf.length} B → ${slot.entry}${tpl.serverName ? `  （服务端文件名 ${tpl.serverName}）` : ''}`);
          } catch (e) {
            tpl.error = e.message;
            failed++;
            say(`  ✘ ${tpl.name}  ${e.message}`);
          }
          manifest.template = tpl;
        }
        say('');
      };
      const doPdf = async () => {
        if (!wantPdf) return;
        const chromePath = findChrome();
        if (!chromePath) {
          manifest.pdf = { ok: false, error: '未找到 Chrome，可用 BPM_CHROME 指定' };
          failed++;
          say('PDF  ✘ 未找到 Chrome，可用 BPM_CHROME 指定');
          return;
        }
        const pdfPath = path.join(filesDir, `${instId}-${title.replace(/[\\/:*?"<>|]/g, '_')}.pdf`);
        try {
          // 直接把登录态塞进 sessionStorage，省掉再一次 CAS 往返（约 4.3 秒）
          const r = await renderTicketPdf({
            currentUser: currentUserOf(tok),
            taskId: task?.taskId || task?.id,
            procDefKey: task?.procDefKey,
            nodeId: task?.nodeId,
            instId,
            outPath: pdfPath,
            chromePath,
          });
          manifest.pdf = { path: r.path, bytes: r.bytes, pages: r.pages, ok: true };
          say(`  ✔ PDF  ${r.bytes} B / ${r.pages} 页`);
          say(`     ${r.path}`);
        } catch (e) {
          manifest.pdf = { ok: false, error: e.message };
          failed++;
          say(`  ✘ PDF  ${e.message}`);
        }
        say('');
      };
      await Promise.all([doFiles(), doPdf()]);
      // manifest.json 不落盘：交维目录只留交付物，下载结果走 --json 或下面的汇总行
      if (quiet) console.log(JSON.stringify(manifest, null, 2));
      else {
        const parts = [`附件 ${manifest.files.filter((f) => f.ok).length}/${manifest.files.length}`];
        if (manifest.template) parts.push(`模板 ${manifest.template.ok ? 1 : 0}/1`);
        if (manifest.pdf) parts.push(`PDF ${manifest.pdf.ok ? 1 : 0}/1`);
        console.log(`${failed === 0 ? '完成' : '部分失败'}：${parts.join('  ')}  →  ${outDir}`);
      }
      bail(failed === 0 ? 0 : 1);
    }
    if (action === 'handover') {
      const id = argv[1];
      if (!id || id.startsWith('--')) {
        console.error(`handover 需要工单 id\n\n${USAGE}`);
        bail(2);
      }
      const quiet = has('json');
      const say = (s) => !quiet && console.log(s);
      const dry = !has('yes');
      const { detail, instId, title, task } = await loadTicket(token, id);
      const formKey = dataKeyOf(detail);
      const fields = detail.data[formKey];
      // taskId 才是待办行的 id；用 procInstId 调进来时从 task 里补
      const taskId = task?.taskId || task?.id || (id.length >= 16 ? id : '');
      if (!taskId) throw new Error(`${id} 取不到 taskId，交维必须从待办里的工单发起`);
      const root = flag('dir') || path.join(outputRoot(has('downloads')), projectDirName(detail, instId));
      if (!fs.existsSync(root)) throw new Error(`交维目录不存在：${root}（用 --dir 指定）`);
      const accepts = acceptMap(detail);
      const { items } = collectPlan(root, undefined, accepts);
      say(`工单 ${id}  (${user.name}${reused ? ' · 复用会话' : ''})`);
      say(`实例 ${instId}  ${title}`);
      say(`目录 ${root}`);
      say('');
      // 缺文件的字段直接跳过并在计划里标出来，别让一次漏拷整单失败
      const missing = items.filter((it) => it.missing || (it.files.length === 0 && !it.zip));
      for (const it of missing) {
        it.skip = it.missing
          ? `目录里没有 ${it.target}`
          : it.dropped?.length
            ? `目录里的文件都不收（只收 ${accepts[it.field].join('/')}）：${it.dropped.map((f) => f.name).join('、')}`
            : `目录是空的：${it.target}`;
      }
      const plan = items.filter((it) => !it.skip);
      if (plan.length === 0) throw new Error(`${root} 里没有可交维的交付物`);
      // 目录里到底有什么：让人能一眼看出是"该传的都传了"还是"目录拷错了"
      const tree = [...fs.readdirSync(root)]
        .filter((n) => !n.startsWith('~$') && !n.startsWith('.'))
        .filter((n) => fs.statSync(path.join(root, n)).isDirectory())
        .sort();
      say('交维目录');
      for (const name of tree) {
        const files = [];
        (function walk(d) {
          for (const n of fs.readdirSync(d)) {
            if (n.startsWith('~$') || n.startsWith('.')) continue;
            const p = path.join(d, n);
            if (fs.statSync(p).isDirectory()) walk(p);
            else files.push({ name: n, size: fs.statSync(p).size });
          }
        })(path.join(root, name));
        const bytes = files.reduce((a, b) => a + b.size, 0);
        say(`  ${name}/  ${files.length} 个文件  ${bytes} B`);
      }
      say(`  合计 ${tree.length} 个一级目录`);
      say('');
      say(`待上传 ${plan.length} 个字段`);
      say('');
      say(`交维根目录：${root}`);
      // 两列：字段 <- 文件。不显示字段名（gcjwcl 这类）、不显示大小、不显示被扩展名挡掉的文件
      const dispW = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
      const labelW = Math.max(...plan.map((it) => dispW(it.label)));
      for (const it of plan) {
        const pad = ' '.repeat(labelW - dispW(it.label));
        const names = it.files.map((f) => f.name).join('、');
        say(`  ${it.label}${pad}  <-  ${names}${it.zip ? '  (整目录打包)' : ''}`);
      }
      // 安全验收：资源录入表里有计算类资源就置 1。解析不了就保留原值，不瞎猜。
      const entryItem = plan.find((it) => it.field === 'resource_subscription_configuration_table');
      let safeValue = fields.sfsjaqys ?? '';
      let safeReason = '保留原值';
      if (entryItem && entryItem.files.length) {
        const d = detectSafeAcceptance(fs.readFileSync(entryItem.files[0].path));
        if (d.value) {
          safeValue = d.value;
          safeReason = d.reason;
        } else {
          safeReason = `${d.reason}，保留原值 ${fields.sfsjaqys ?? '(空)'}`;
        }
      }
      say('');
      say(`安全验收 ${fields.sfsjaqys ?? '(空)'} → ${safeValue}  （${safeReason}）`);
      // 单文件字段多给文件后端不收，宁可在这里停下让人改映射
      for (const it of plan) {
        if (SINGLE.has(it.field) && it.files.length > 1) {
          throw new Error(`${it.label} (${it.field}) 只能挂 1 个文件，目录里给了 ${it.files.length} 个：${it.files.map((f) => f.name).join('、')}`);
        }
      }
      if (dry) {
        say('');
        say('dry-run：没有发任何请求。确认无误后加 --yes 执行。');
        bail(0);
      }
      // 上传 → 拼 busData → 保存 → 录入，串行，前面失败就整单停
      const uploaded = {};
      say('');
      say('上传');
      const referer = `${BPM}/front/task/${taskId}?procDefKey=${task?.procDefKey || ''}&nodeId=${task?.nodeId || ''}`;
      // zip 只打一次（整目录 24M 要 900ms）；各字段的附件并行上传，输出仍按计划顺序
      const zipBuf = plan.some((it) => it.zip) ? zipDir(root) : null;
      const jobs = [];
      for (const it of plan) {
        const files = it.zip ? [{ ...it.files[0], buf: zipBuf }] : it.files;
        for (const f of files) {
          const buf = f.buf || fs.readFileSync(f.path);
          jobs.push(
            uploadFile(token, buf, f.name, { referer }).then((v) => ({
              field: it.field,
              label: it.label,
              name: f.name,
              size: buf.length,
              value: v,
            })),
          );
        }
      }
      for (const r of await Promise.all(jobs)) {
        (uploaded[r.field] ||= []).push({
          id: String(r.value.fileId),
          name: r.value.fileName || r.name,
          size: Number(r.value.size) || r.size,
          username: user.name,
        });
        say(`  ✔ ${r.label}  ${r.name}  ${r.size} B → ${r.value.fileId}`);
      }
      // busData：以 live 表单为基座，只替换本命令管理的字段 —— 其余 62 个字段原样回传
      const next = { ...fields };
      for (const [field, list] of Object.entries(uploaded)) next[field] = JSON.stringify(list);
      if (safeValue) next.sfsjaqys = safeValue;
      const busData = Buffer.from(JSON.stringify({ [formKey]: next }), 'utf8').toString('base64');
      say('');
      say('保存表单');
      const saved = await saveFormData(token, { procInstId: instId, taskId, busData });
      if (!saved.state) throw new Error(`保存失败：${saved.message || JSON.stringify(saved).slice(0, 160)}`);
      say(`  ✔ ${saved.message || '已保存'}`);
      const result = { id, instId, taskId, dir: root, uploaded, safeAcceptance: { from: fields.sfsjaqys ?? '', to: safeValue, reason: safeReason }, saved: true, input: null };
      if (has('skip-input')) {
        say('');
        say('已跳过资源录入（--skip-input）');
        if (quiet) console.log(JSON.stringify(result, null, 2));
        bail(0);
      }
      // 录入用的 fileJson 就是刚写进表单的那个附件数组的 JSON 字符串
      const fileJson = next.resource_subscription_configuration_table || '';
      say('');
      say('资源录入');
      const entered = await inputResource(token, { orderNo: instId, fileJson, requirement: next.requirement || '' });
      const ok = entered.state === true;
      result.input = { ok, message: entered.message || '' };
      say(ok ? `  ✔ ${entered.message || '已录入'}` : `  ✘ ${entered.message || JSON.stringify(entered).slice(0, 200)}`);
      try {
        const st = await getResourceStatus(token, instId);
        result.status = st;
        say(`  状态 ${st.projectStatus || '-'}  录入 ${st.inputStatus || '-'}  资源 ${st.inputResourceCount ?? '-'}`);
      } catch (e) {
        result.statusError = e.message;
      }
      if (quiet) console.log(JSON.stringify(result, null, 2));
      bail(ok ? 0 : 1);
    }
    const opts = { page: Number(flag('page', 1)), pageSize: Number(flag('size', 200)) };
    const res = action === 'list' ? await getTodoList(token, opts) : await getDoneList(token, opts);
    if (has('json')) {
      console.log(JSON.stringify(res, null, 2));
      bail(0);
    }
    const rows = res.rows || [];
    const label = action === 'list' ? '待办' : '已办';
    console.log(`${label} ${rows.length} 条 / 共 ${res.total} 条  (${user.name}${reused ? ' · 复用会话' : ''})`);
    for (const r of rows) {
      console.log(
        `  ${r.id}  ${r.subject || ''}  ${r.createDate || ''}  ${r.procDefName || '-'}  ${r.name || '-'}`,
      );
    }
  } catch (e) {
    if (e instanceof Exit) return e.code;
    else {
      console.error('失败:', e.message);
      // fetch 失败时 e.message 只有一句 "fetch failed"，真正的原因在 cause 里（ECONNRESET / 超时 / DNS）
      if (e.cause) console.error('  cause:', e.cause.code || e.cause.message || e.cause);
      return 1;
    }
  }
}

// 真依赖：静态 import 会在 import 这个文件时就读本机配置/会话，所以给成惰性的 ——
// 谁真跑谁才去加载；测试传了自己的 deps 就完全不碰这些。
const defaultDeps = {
  http: null, // 不给就用 osa-cdp 现搭一层
  osaHost: null, // 不给就用 lib/osa.mjs 里的 OSA.host
  stateDir: null, // 不给就用 lib/config.mjs 的 STATE_DIR
  trigger: (orderNo, tok) => triggerManagement(tok, orderNo),
  // 测试注入：点纳管时用它替代真换票（真跑时是 null）
  tokenOf: null,
};
// 只有被当入口执行时才跑主流程；被 import 时只导出 main。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = await main();
}
