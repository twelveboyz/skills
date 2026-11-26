// 集中运维平台（osa_web）：4A 漫游资源换票 + 用票据在 Chrome 里开页面。
// 换票就是 4A 资源列表页点「登录」时发的那个 ssoLogin.do，只是 accPwd 传空
// （金库策略 jkStatus=1 时服务端不校验从账号密码，实测可复现）。
import { Cdp, openTab, sleep } from './cdp.mjs';
import { SSO, U4A } from './config.mjs';

// 4A 里「集中运维平台」这个漫游资源的固定标识；换环境/换账号时用环境变量覆盖。
// accId 是「用户在这个资源上的从账号」，默认沿用 BPM 那个，实测服务端照样认。
export const OSA = {
  resId: process.env.BPM_OSA_RES_ID || '59be76548a5049559d38a55457f60238',
  accId: process.env.BPM_OSA_ACC_ID || '96584528485347738d367e9c5df37ecd',
  accName: process.env.BPM_OSA_ACC_NAME || SSO.accName || '',
  clientId: process.env.BPM_OSA_CLIENT_ID || '6959360573754306289',
  host: process.env.BPM_OSA_HOST || 'http://10.19.105.29:8080',
};
export const OSA_HOME = `${OSA.host}/osa_web/a/cmdbIndex`;

/// 拿一张 osa_web 的一次性登录 URL。票据只能用一次，每次开页都得重新换。
/// accName / 4A 地址从 config 与 cookie 反推，尽量少配。
export async function osaTicket(cookieHeader, { u4aHome, accName } = {}) {
  const home = u4aHome || U4A;
  const body = {
    resId: OSA.resId,
    resProtocol: '',
    accId: OSA.accId,
    accName: accName || OSA.accName || '',
    clientId: OSA.clientId,
    isRoamRes: '1',
    accPwd: '',
    isJKAuthned: '0',
  };
  const res = await fetch(`${home}/sso/ssoLogin.do?rnd=${Math.random()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Cookie: cookieHeader,
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`4A 换票返回的不是 JSON：${text.slice(0, 120)}`);
  }
  if (j.success !== true) {
    // failedInfoList 里的错误码是 4A 自己的，原样透出比翻译成中文更有用
    throw new Error(`4A 换票失败：${JSON.stringify(j).slice(0, 200)}`);
  }
  const sso = j.data?.appSsoStr || '';
  if (!sso) throw new Error('4A 换票成功但没有 appSsoStr');
  const url = Buffer.from(sso, 'base64').toString('utf8');
  if (!url.startsWith('http')) throw new Error(`appSsoStr 解码异常：${url.slice(0, 80)}`);
  return url;
}

/// 在现有标签页里用票据换登录态，再导航到业务页。
/// 两步是因为票据接口只 set-cookie 不跳转，落地页得自己再走一次。
export async function openOsa(port, ticketUrl, { home = OSA_HOME } = {}) {
  const tab = await openTab(port, ticketUrl);
  const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await sleep(2500); // 票据接口是同步 set-cookie，等它落成
    await cdp.send('Page.navigate', { url: home });
    await sleep(4000); // 前端是 Vue 壳，等首屏
    return (await cdp.eval('location.href')) || home;
  } finally {
    await cdp.close();
  }
}
