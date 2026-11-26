// BPM 侧：4A 会话 → CAS 换 oneOff → JWT → 接口调用
import fs from 'node:fs';
import path from 'node:path';
import { U4A, STATE_DIR } from './session.mjs';
import { BPM, SSO } from './config.mjs';

export { BPM };

// JWT 有效期实测 2 小时。换一次票要两次 HTTPS 往返（约 5.8 秒），
// 缓存到快过期前再用，避免每次调用都重走 CAS。
const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
const TOKEN_SKEW_MS = 5 * 60_000;

function readTokenCache() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

const keyHeaders = (cookie) => ({
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: `${U4A}/index.html`,
  Cookie: cookie,
});

/// 走 ssoTrigger + ssoLogin，拿到含一次性 ticket 的 CAS 登录 URL。
/// 每调用一次都是一张新票，可以给浏览器用，也可以给 getToken 用。
export async function getCasUrl(cookie) {
  const trig = await fetch(`${U4A}/jk/ssoTrigger.do?rnd=${Math.random()}`, {
    method: 'POST',
    headers: keyHeaders(cookie),
    body: new URLSearchParams({ ...SSO, accPwd: '' }).toString(),
  });
  await trig.text(); // 不读走 body，句柄会挂着

  const r = await fetch(`${U4A}/sso/ssoLogin.do?rnd=${Math.random()}`, {
    method: 'POST',
    headers: keyHeaders(cookie),
    body: new URLSearchParams({
      ...SSO,
      resProtocol: '',
      isRoamRes: '1',
      accPwd: '',
      isJKAuthned: '0',
      actionUrl: `${BPM}/ucService/api/sso/v1/loginFor4A`,
    }).toString(),
  });
  // 先把 body 读成文本再自己 parse：r.json() 抛错时 body 流还挂着，
  // 外层立刻 process.exit 会让 libuv 在关句柄时撞 assertion（Windows 实测）。
  const raw = await r.text();
  let sso;
  try {
    sso = JSON.parse(raw);
  } catch {
    throw new Error(
      `ssoLogin.do 没返回 JSON（HTTP ${r.status}）${
        raw ? `：${raw.slice(0, 120)}` : '：空响应，4A 会话多半已失效，用 bpm.mjs login 重建'
      }`,
    );
  }
  if (!sso.success) throw new Error(`ssoLogin 失败: ${JSON.stringify(sso)}`);
  return Buffer.from(sso.data.appSsoStr, 'base64').toString('utf8');
}

/// 4A 会话是否真的活着：只读探测，不发任何凭据、不落盘。
/// 端口上有没有 Chrome 是猜的；cookie 是真的 —— init 靠这个决定要不要复用那个浏览器。
export async function probe4a(cookie, ms = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`${U4A}/loading.do?rnd=${Math.random()}`, {
      method: 'POST',
      headers: keyHeaders(cookie),
      body: '',
      signal: ac.signal,
    });
    const j = await r.json();
    return !!j?.success;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/// 走一遍 CAS 跳转拿一次性码（打开 BPM 页面时用，页面自己拿它建登录态）
async function casOneOff(cookie) {
  const casUrl = await getCasUrl(cookie);
  const cas = await fetch(casUrl, { redirect: 'manual' });
  const oneOff = new URL(cas.headers.get('location') || '', BPM).searchParams.get('oneOff');
  if (!oneOff) throw new Error(`CAS 未返回 oneOff (status ${cas.status})`);
  return oneOff;
}

/// 给 browser 动作用：一次性的 oneOff，直接塞进 /front/xxx?oneOff= 就能让页面自己登录
export async function getOneOff(cookie) {
  return casOneOff(cookie);
}

/// 真走一遍 CAS 换 JWT，不查缓存
async function fetchToken(cookie) {
  const oneOff = await casOneOff(cookie);

  const auth = await (await fetch(`${BPM}/ucService/sso/authLogin?code=${oneOff}&type=oneOff`)).json();
  if (!auth.token) throw new Error(`authLogin 未返回 token: ${JSON.stringify(auth)}`);
  return auth;
}

/// 只看缓存，不联网。有效就返回 {token,...,exp,cached:true}，否则 null。
/// 有可用 JWT 时连 4A 会话都不用验（省 1.4 秒）。
export function peekToken() {
  const c = readTokenCache();
  if (!c.token) return null;
  const exp = jwtExp(c.token);
  if (exp - TOKEN_SKEW_MS <= Date.now()) return null;
  return { ...c, exp, cached: true };
}

/// 拿 BPM 的 JWT：缓存有效就直接用，否则换一张（约 5.8 秒）。
/// 返回 {token, userId, username, account, mobile, email, exp, cached}
export async function getToken(cookie, { force = false } = {}) {
  if (!force) {
    const c = readTokenCache();
    if (c.token && jwtExp(c.token) - TOKEN_SKEW_MS > Date.now()) {
      return { ...c, exp: jwtExp(c.token), cached: true };
    }
  }
  const auth = await fetchToken(cookie);
  const exp = jwtExp(auth.token);
  const rec = { ...auth, exp };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(rec, null, 2));
  } catch {
    /* 写不进缓存不影响本次使用 */
  }
  return { ...rec, cached: false };
}

/// 浏览器里要的 sessionStorage.currentUser 结构：字段与 authLogin 响应一一对应（值已是 base64）
export function currentUserOf(t) {
  return {
    token: t.token,
    username: t.username,
    account: t.account,
    userId: t.userId,
    mobile: t.mobile,
    email: t.email,
  };
}

/// 带 token 调 BPM 接口。Authorization 必须带 Bearer 前缀，bpm-nonceId 必须每次新生成。
export async function call(token, path, body) {
  const r = await fetch(BPM + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'bpm-nonceId': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'),
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} 返回非 JSON (HTTP ${r.status}): ${text.slice(0, 160)}`);
  }
  return json;
}

/// 带 token 发 GET。同样需要 Authorization + bpm-nonceId。
export async function get(token, path) {
  const r = await fetch(BPM + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      'bpm-nonceId': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'),
    },
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} 返回非 JSON (HTTP ${r.status}): ${text.slice(0, 160)}`);
  }
}

/// 工单详情（按 taskId）：返回 { result, form:{formHtml,...}, data:{<表单key>:{...}}, permission, buttons }
export function getTaskDetail(token, taskId) {
  return get(token, `/bpmrunService/runtime/task/v1/taskDetailBo?taskId=${taskId}&reqParams=`);
}

/// 工单详情（按流程实例 id）：同上，只需 instId
export function getInstForm(token, instId) {
  return get(token, `/bpmrunService/runtime/instance/v1/getInstFormAndBO?proInstId=${instId}`);
}

/// 任务对象（含 procInstId）。已办单的 15 位 id 打这个会 404「此任务已被处理或不存在」
export function getTaskInfo(token, taskId) {
  return get(token, `/bpmrunService/runtime/task/v1/get?id=${taskId}`);
}

/// 流程实例对象（含 subject）
export function getInstance(token, instId) {
  return get(token, `/bpmrunService/runtime/instance/v1/getInstanceByInstId?instId=${instId}`);
}

/// 从 Content-Disposition 里取文件名。
/// 本服务端用的是非标准的 `filename==?UTF-8?B?xxx?=`，三种写法都要兜。
function cdName(cd) {
  if (!cd) return '';
  const b = /filename==\?UTF-8\?B\?([^?]+)\?=/.exec(cd);
  if (b) return Buffer.from(b[1], 'base64').toString('utf8');
  const r = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (r) return decodeURIComponent(r[1]);
  const q = /filename="?([^";]+)"?/.exec(cd);
  if (!q) return '';
  try {
    return decodeURIComponent(q[1]);
  } catch {
    return q[1];
  }
}

async function fetchFile(token, path) {
  const r = await fetch(BPM + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      'bpm-nonceId': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'),
    },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status !== 200) {
    throw new Error(
      `HTTP ${r.status} ${buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 200)}`,
    );
  }
  return { buf, filename: cdName(r.headers.get('content-disposition')) };
}

/// 下载工单挂载的附件。proInstId 是权限校验的关键，缺了必 403。
export function downloadFile(token, fileId, instId) {
  return fetchFile(
    token,
    `/portalService/system/file/v1/download?fileId=${fileId}&proInstId=${instId}`,
  );
}

/// 下载「资源订购配置表模板」（空白模板，不是工单上传的文件）
export async function exportResourceOrderTemplate(token, orderNo, orderTitle) {
  const r = await fetch(`${BPM}/bpmrunService/runtime/easyCmdb/v1/resource/input/exportTemplate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'bpm-nonceId': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'),
    },
    body: JSON.stringify({ orderNo, orderTitle }),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status !== 200) {
    throw new Error(`HTTP ${r.status} ${buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  return { buf, filename: cdName(r.headers.get('content-disposition')) };
}

/// 待办列表
export function getTodoList(token, { page = 1, pageSize = 200 } = {}) {
  return call(token, '/bpmrunService/runtime/task/v1/getTodoList', {
    pageBean: { page: String(page), pageSize: String(pageSize), showTotal: 'true' },
    params: { firstReadFlag: '1' },
  });
}

/// 已办列表
export function getDoneList(token, { page = 1, pageSize = 200 } = {}) {
  return call(token, '/bpmrunService/runtime/instance/v1/getDoneList', {
    pageBean: { page: String(page), pageSize: String(pageSize), showTotal: 'true' },
    params: {},
  });
}

/// 上传一个文件，返回表单里要挂的附件对象 {id,name,size,...}。
/// multipart 的字段名固定为 file；Content-Type 必须让 fetch 自己带 boundary，不能手设。
export async function uploadFile(token, buf, name, { referer } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buf]), name);

  const headers = {
    Authorization: `Bearer ${token}`,
    'bpm-nonceId': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'),
  };
  if (referer) headers.Referer = referer;

  const r = await fetch(`${BPM}/portalService/system/file/v1/upload`, {
    method: 'POST',
    headers,
    body: form,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`上传返回非 JSON (HTTP ${r.status}): ${text.slice(0, 160)}`);
  }
  if (!json.state) throw new Error(`上传失败：${json.message || text.slice(0, 160)}`);

  // value 是 JSON 字符串，要再 parse 一次才是 { success, fileId, fileName, size, filePath }
  const value = typeof json.value === 'string' ? JSON.parse(json.value) : json.value;
  if (!value || !value.success) throw new Error(`上传失败：${json.value}`);
  return value;
}

/// 保存表单（不推进流程）。busData 是整张表单的 base64，先在本地拼好再传。
export function saveFormData(token, { procInstId, taskId, busData, opinion = '同意' }) {
  return call(token, '/bpmrunService/runtime/bpmInstForm/v1/saveFormData', {
    procInstId,
    taskId,
    busData,
    opinion,
  });
}

/// 录入：把资源订购配置表交给 easyCmdb 解析。fileJson 必须是附件对象的 JSON 字符串。
export function inputResource(token, { orderNo, fileJson, requirement = '' }) {
  return call(token, '/bpmrunService/runtime/easyCmdb/v1/resource/input', {
    orderNo,
    fileJson,
    requirement,
  });
}

/// 点纳管：让平台开始给这批机器装三个单元。返回 { state, message }。
/// 注意这是 BPM 域的接口，不走 osa_web —— 不要把 osa 的 CDP http 层接进来。
export function triggerManagement(token, orderNo) {
  return call(
    token,
    `/bpmrunService/runtime/easyCmdb/v1/resource/management?orderNo=${encodeURIComponent(orderNo)}`,
    {},
  );
}

/// 录入状态：{ projectStatus, inputStatus, computingResourceCount, ... }
export function getResourceStatus(token, orderNo) {
  return call(
    token,
    `/bpmrunService/runtime/easyCmdb/v1/resource/status?orderNo=${encodeURIComponent(orderNo)}`,
    {},
  );
}
