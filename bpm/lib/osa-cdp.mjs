// 在「运行中的 Chrome」里的 osa_web 页面上下文中发请求。
// 为什么要绕这一道：osa_web 的会话是浏览器同源自动带的 cookie，脚本侧看不到也拿不到，
// 票据换出来的会话服务端不认（实测整条跳转链退回 CAS 登录页）。所以只能借浏览器已登录的页面去 fetch。
import { Cdp, listPages } from './cdp.mjs';

const HINT = '先跑  node ~/.agents/skills/bpm/bin/bpm.mjs browser --url osa  打开集中运维平台并登录（保持那个 Chrome 开着），再重试本命令。';

/// 拼一段页面里执行的脚本：fetch 一个 form POST，把状态码、最终地址、响应文本一起带回来。
/// 不用 redirect:'manual' —— 同源下它给出 opaqueredirect（status 0、body 空），看不出掉没掉登录态；
/// 让它跟随，再看最终地址是不是被踢到登录页，比看状态码准。
function evalFetch({ url, method, form }) {
  return `(async () => {
    const r = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(method || 'POST')},
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
      body: ${JSON.stringify(form || '')},
      credentials: 'include',
    });
    return { status: r.status, finalUrl: r.url, text: await r.text() };
  })()`;
}

/// 造一个「经 CDP 在 osa_web 页面里 fetch」的 http 层，形状与 osa-api 里注入的假 http 一致：
///   入参 (url, { method, form })  出参 { status, headers, text() }
/// 连不上 Chrome / 没有 osa_web 标签页 / 掉登录态，三种情况各报各的，别让人猜。
export function createCdpHttp({ port = 9222, host } = {}) {
  return async function cdpHttp(url, { method = 'POST', form = '' } = {}) {
    const origin = host || new URL(url).origin;
    let tabs;
    try {
      tabs = await listPages(port);
    } catch (e) {
      throw new Error(`连不上 Chrome 调试端口 ${port}（${e.message}）。${HINT}`);
    }
    const page = tabs.find(
      (t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(origin + '/'),
    );
    if (!page) {
      throw new Error(`Chrome（端口 ${port}）里没有打开着的 ${origin} 页面。${HINT}`);
    }

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    let r;
    try {
      r = await cdp.eval(evalFetch({ url, method, form }));
    } finally {
      await cdp.close(); // 不等关完会撞 libuv 的 UV_HANDLE_CLOSING
    }
    if (!r) throw new Error(`页面里执行 fetch 没有返回值：${url}`);

    // 掉登录态：被踢到登录页，或干脆吐回一整页 HTML
    const kicked = !r.finalUrl.startsWith(origin + '/osa_web/a/') || /\/login/i.test(r.finalUrl);
    if (kicked || r.status === 401) {
      throw new Error(
        `${origin} 的 osa_web 会话已失效（最终地址 ${r.finalUrl}）。${HINT}`,
      );
    }
    if (r.status !== 200) {
      throw new Error(`${url} 返回 HTTP ${r.status}：${r.text.slice(0, 160)}`);
    }
    return {
      status: r.status,
      headers: new Headers([['content-type', 'application/json']]),
      text: async () => r.text,
    };
  };
}
