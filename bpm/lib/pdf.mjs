// 用无头 Chrome 打开工单页并打印成 PDF
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Cdp, findChrome, freePort, listPages, poll, sleep } from './cdp.mjs';
import { BPM } from './bpm.mjs';

// pdf.mjs 以前自带 findChrome，bin/bpm.mjs 从这儿 import；转出去保持签名不变
export { findChrome };

// 把页面改成「适合打印」的样子，对齐人工 Ctrl+P 出来的版式：
//   - 站点顶栏（logo + 菜单 + 你好！某某）不打印
//   - 右上角「打印 / 流程图 / 复制工单号和标题」那排按钮不打印
//   - 客服浮标不打印
//   - 滚动容器撑开，否则只截一屏
// 标题 h3、水印、表单、审批记录一律保留。
const EXPAND = `(function(){
  var st = document.createElement('style');
  st.id = '__bpm_pdf_prep';
  st.textContent = [
    'body > section.el-container.is-vertical > header.el-header{display:none !important;}',
    '.el-aside{display:none !important;}',
    '.top-btns-col{display:none !important;}',
    '.chat-icon{display:none !important;}',
    '#nprogress,.peg,.spinner,.el-loading-spinner,.el-loading-mask{display:none !important;}',
    'html,body{height:auto !important;overflow:visible !important;margin:0 !important;padding:0 !important;}',
    'body > section.el-container{height:auto !important;}',
    '.base-container-app{height:auto !important;}',
    '.base-main,.el-main{height:auto !important;max-height:none !important;overflow:visible !important;margin:0 !important;padding:0 !important;background:#fff !important;}'
  ].join('\\n');
  document.head.appendChild(st);
  return true;
})()`;

// 页眉：左上日期时间、正中系统名。页脚：左下完整 URL、右下 页码/总页数。
// 用 Chrome 的 .date / .url / .pageNumber / .totalPages 占位符，跟模板一致。
const HEADER_TMPL =
  '<div style="font-size:8px;width:100%;padding:0 0.5in;display:flex;justify-content:space-between;">' +
  '<span class="date"></span>' +
  '<span style="position:absolute;left:0;right:0;text-align:center;">集中流程管理系统</span>' +
  '<span></span></div>';

const FOOTER_TMPL =
  '<div style="font-size:8px;width:100%;padding:0 0.5in;display:flex;justify-content:space-between;">' +
  '<span class="url"></span>' +
  '<span style="white-space:nowrap;"><span class="pageNumber"></span>/<span class="totalPages"></span></span>' +
  '</div>';

function dataUrlToBuf(b64) {
  return Buffer.from(b64, 'base64');
}

/// 打开工单页并打印成 PDF。
/// 传 currentUser 就直接注入登录态（省掉 CAS 登录的 4.3 秒）；没传才退回走 casUrl。
/// 页面地址优先用 taskId + procDefKey + nodeId 拼 /front/task/…，
/// 这跟订单页标题栏、页脚 URL 都与模板对得上；没有这三个参数才退回 /front/inst/<instId>。
export async function renderTicketPdf({
  casUrl,
  currentUser,
  taskId,
  procDefKey,
  nodeId,
  instId,
  outPath,
  chromePath,
}) {
  const pageUrl =
    taskId && procDefKey && nodeId
      ? `${BPM}/front/task/${taskId}?procDefKey=${encodeURIComponent(procDefKey)}&nodeId=${encodeURIComponent(nodeId)}`
      : `${BPM}/front/inst/${instId}`;
  const exe = chromePath || findChrome();
  if (!exe) throw new Error('未找到 Chrome，可用 BPM_CHROME 指定');
  if (!currentUser && !casUrl) throw new Error('renderTicketPdf 需要 currentUser 或 casUrl');

  const port = await freePort();
  // 每次都用一次性 profile，跑完就删：不长期占几百 MB，也不会有「上次的 Chrome 还锁着」问题。
  // 代价是每次都走冷缓存（比复用 profile 慢约 2.4 秒）。
  const tmpDir = path.join(os.tmpdir(), `dsh-bpm-pdf-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const spawnChrome = (dir) =>
    spawn(
      exe,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${dir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--hide-scrollbars',
        '--disable-extensions',
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true },
    );

  let child = spawnChrome(tmpDir);

  let cdp;
  try {
    let page;
    try {
      page = await poll(
        async () => (await listPages(port)).find((t) => t.type === 'page'),
        { tries: 80, gap: 100, label: 'Chrome 启动' },
      );
    } catch (e) {
      // 一次性目录理论上不会锁冲突，但还是换一个目录重来一次，避免偶发残留
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      await sleep(300);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      child = spawnChrome(tmpDir);
      page = await poll(
        async () => (await listPages(port)).find((t) => t.type === 'page'),
        { tries: 80, gap: 100, label: 'Chrome 启动' },
      );
    }

    cdp = await Cdp.connect(`ws://localhost:${port}/devtools/page/${page.id}`);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 1. 建立 BPM 登录态
    if (currentUser) {
      // 直接注入：BPM 用 sessionStorage 存 token，路由守卫看到它就放行。
      // 必须在页面脚本之前注入，否则守卫先跑就被踢去登录页。
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `sessionStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify(currentUser))});`,
      });
    } else {
      // 没给登录态就走 CAS（多花 4.3 秒，但不用依赖 JWT 结构）
      await cdp.send('Page.navigate', { url: casUrl });
      await poll(async () => cdp.eval('!!sessionStorage.currentUser'), {
        tries: 20,
        gap: 700,
        label: 'BPM 登录',
      });
    }

    // 2. 打开工单页。服务端偶发 502 兜底页，整轮重试
    //    判据只认「审批内容」这个工单页独有的标记；表格数和字数只做下限兜底，
    //    按大表单的数值调死会把字段少的流程全挡掉。
    const READY = `(function(){
      var t = document.body.innerText || '';
      if (t.indexOf('An error occurred') > -1) return false;
      if (t.indexOf('审批内容') === -1) return false;
      return t.length > 800 && document.querySelectorAll('table').length >= 3;
    })()`;
    let rendered = false;
    for (let round = 0; round < 3 && !rendered; round++) {
      await cdp.send('Page.navigate', { url: pageUrl });
      try {
        await poll(async () => cdp.eval(READY), { tries: 120, gap: 120, label: '工单页渲染' });
        // 长度连续两次相同就认为渲染停了；最多再看 4 次，别为骨架屏多等
        let prev = -1;
        for (let i = 0; i < 4; i++) {
          const len = await cdp.eval('document.body.innerText.length');
          if (len === prev) break;
          prev = len;
          await sleep(60);
        }
        rendered = true;
      } catch {
        await sleep(1200);
      }
    }
    if (!rendered) throw new Error('工单页渲染失败（多次重试）');

    await cdp.eval(EXPAND);
    await sleep(60);

    // 版式对齐人工 Ctrl+P 出来的样子：A4 横向、带页眉页脚
    const pdf = await cdp.send('Page.printToPDF', {
      landscape: true,
      printBackground: true,
      paperWidth: 11.69,
      paperHeight: 8.27,
      marginTop: 0.47,
      marginBottom: 0.4,
      marginLeft: 0.31,
      marginRight: 0.31,
      scale: 0.84,
      displayHeaderFooter: true,
      headerTemplate: HEADER_TMPL,
      footerTemplate: FOOTER_TMPL,
    });

    const buf = dataUrlToBuf(pdf.data);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    const pages = Number(/\/Count (\d+)/.exec(buf.toString('latin1'))?.[1] || 0);
    return { path: outPath, bytes: buf.length, pages };
  } finally {
    try {
      if (cdp) await cdp.send('Browser.close');
    } catch {
      /* 关不上就直接杀 */
    }
    await sleep(400);
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    if (tmpDir) {
      for (let i = 0; i < 10; i++) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(300);
        }
      }
    }
  }
}
