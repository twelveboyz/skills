// osa_web 的纳管接口：工单级进度（gridData4Search）+ 逐台单元明细（gridData4PublicAgentDetails）。
// 只读接口在 batchStatus；点纳管（resource/management）走 BPM 域的 trigger，由调用方注入。
import { OSA } from './osa.mjs';
import { classifyBatch, loadRules, rawsOf } from './naguan-errors.mjs';

const BASE = '/osa_web/a/cmdb/project/cmdbProjectBpm';

// 三格状态：接口只回这四个中文字面量 + 一个工单级验证标志，全仓库只在这里认它们。
export const OK_FLAG = '已安装';
export const PENDING = '待检测';
export const INSTALLING = '安装中';
const FAILED = '安装失败';
// 工单级 agentValidateFlag 的「验证中」
export const VALIDATING = '3';

/// 一台的三个单元（自动化程序 / zabbix / filebeat）。判断只写一次，别四处各拼一遍数组。
export const cellsOf = (h) => [h.agent, h.zabbix, h.filebeat];

/// 还在转：格子里仍是「待检测」或「安装中」—— 成没成还没数，既不算失败也不能收工。
export const inFlightCell = (v) => v === PENDING || v === INSTALLING;

/// 安装失败：原文里写死的失败态，只有它才算「试过且没成」。
export const failedCell = (v) => v === FAILED;

/// 整台口径：三个单元全「已安装」才算这台正常；任一格失败即整台判失败 ——
/// 27 个单元里挂一个，那台机器就是没纳管成功。
export const goodHost = (h) => cellsOf(h).every((v) => v === OK_FLAG);
export const inFlightHost = (h) => cellsOf(h).some(inFlightCell);
export const failedHost = (host) => cellsOf(host).some(failedCell);

/// 从没纳管过：flag 0 且逐台所有单元都是「待检测」且 deviceIp 全空。三者缺一不点纳管。
export function neverManaged(res) {
  return (
    String(res.agentValidateFlag) === '0' &&
    res.hosts.every((h) => h.deviceIp === '') &&
    res.hosts.every((h) => cellsOf(h).every((v) => v === PENDING))
  );
}

/// 终态是两层判：工单级不再是「验证中」，且逐台每一格都不再是「待检测」也不再是「安装中」。少一层都继续等 ——
/// 实测工单级先出「验证中 0/27」，逐台 9 行里 8 行还是待检测，只看工单级会在结果落表前收工。
/// 「安装中」也算没停：那一格到底成没成还没数，这时候收工等于把「还在装」报成「已出结果」。
export function isTerminal(res) {
  return String(res.agentValidateFlag) !== VALIDATING && res.hosts.every((h) => !inFlightHost(h));
}

/// 这台到底轮到过没有：IP 出来了，或者三格里有一格不再是「待检测」（在装 / 已装 / 失败），
/// 就说明排队轮到过它。**跑过失败也算跑过** —— 人要看的是「每台都真的被执行一次」，不是「每台都成功」。
export function attemptedHost(h) {
  return h.deviceIp !== '' || cellsOf(h).some((v) => v !== PENDING);
}

/// 全台都跑过一遍：没有任何一台还是「IP 空 + 三格全待检测」。
/// 这是「等这一轮排队跑完」的收工判据：osa 逐台执行，没轮到的台 IP 是空的、三格全待检测。
export function allAttempted(res) {
  return (res.hosts || []).every(attemptedHost);
}

/// 整台口径：没全成的分两种报，别混成一句「失败 N 台」——
///   failed   三格都不是「已安装」且至少一格写着「安装失败」：真·安装失败
///   running  三格都不是「已安装」但还有格在装：还在装（超时截断时最常见），只把装完的算进成功
/// 报告里两种分开说，失败台数只数 failed，算不进去的也不装成「成功」。
export function wholeHostVerdict(res) {
  // 还在装 = 没全装完、也没写着失败、但还有格在转（超时截断时最常见）
  const running = res.hosts.filter((h) => !goodHost(h) && !failedHost(h) && inFlightHost(h));
  // 失败 = 有格写着「安装失败」（哪一格都算），不看另外两格：失败是事实，不该被别的格遮住
  const failed = res.hosts.filter((x) => !goodHost(x) && failedHost(x));
  // 失败里还要再分出一类：一格报错原文都没有的，分类接不到它 —— 逐台行照打，
  // 但失败那一句要单独点名谁没有原文，别让人以为分类把它吃了。
  const uncleared = failed.filter((x) => rawsOf(x).length === 0);
  return {
    okCount: res.hosts.length - failed.length - running.length,
    failCount: failed.length,
    failed,
    running,
    uncleared,
  };
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/// 造一个纳管适配器。http 是唯一注入的缝：测试注入假的（按 URL 路径分派响应），
/// 生产注入 lib/osa-cdp.mjs 那层（借 Chrome 里已登录的 osa_web 页面去 fetch）。
/// host 默认取现有 OSA 常量，换环境时用 BPM_OSA_HOST 覆盖。
/// ruleBook 也在这里注入：测试给一份最小规则表，生产默认读 assets/naguan-errors.json。
/// 文件里既有规则也有分组说明，所以名字叫 ruleBook（loadRules() 的返回值）。
export function createOsaApi({ http, host = OSA.host, ruleBook = loadRules() } = {}) {
  if (!http) throw new Error('createOsaApi 需要一个 http 层（生产用 createCdpHttp）');
  // 请求头照抄抓包里的真实请求；不在这层带 Cookie —— 会话在浏览器里，由页面 fetch 自动带上
  async function post(path, form) {
    const r = await http(host + path, { method: 'POST', form: new URLSearchParams(form).toString() });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${path} 返回非 JSON (HTTP ${r.status}): ${text.slice(0, 160)}`);
    }
  }

  return {
    /// 全量搜工单：不带 projectId 的 gridData4Search，就是 osa 页面上那个搜索框。
    /// 关键字在行里按 projectName / seriesName 模糊匹配（大小写不敏感），不在服务端过滤。
    /// 全量拉批次列表（接口没有真正的关键字参数，过滤在本地做）。
    /// 关键字与订单号两条路都要用同一份原始行，所以拆出来：谁过滤是调用方的事。
    ///
    /// 必须翻完所有页：接口按 page/rows 分页、total 是真实总数，只取第一页会在 1000+ 条
    /// 工单里静默漏掉目标（实测 total 1041，E607 排在第 1000 条附近，rows:20 永远搜不到）。
    /// 按 total 判停，拿不到 total 或本页不满就停，避免死循环。
    async listBatches() {
      const PAGE = 500;
      const seen = new Set();
      const all = [];
      for (let page = 1; ; page += 1) {
        const j = await post(`${BASE}/gridData4Search`, {
          page,
          rows: PAGE,
          projectId: '',
          batchId: '',
          progressStatus: 0,
          cmdbProjectType: 1,
        });
        const rows = j.rows || [];
        for (const r of rows) {
          // 实测相邻页会重叠一条，按 projectId+seriesId 去重
          const key = `${r.projectId}\n${r.seriesId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push(r);
        }
        const total = Number(j.total);
        if (rows.length < PAGE || !Number.isFinite(total) || all.length >= total) break;
      }
      return all;
    },

    /// 关键字（E605）：按工单名 / 批次名做包含匹配。
    async searchAll(keyword) {
      const k = keyword.toLowerCase();
      return (await this.listBatches()).filter((r) =>
        `${r.projectName || ''}\n${r.seriesName || ''}`.toLowerCase().includes(k),
      );
    },

    /// 15 位订单号：同一页里按 orderNo 精确取。订单号不进工单名，关键字那条路永远搜不到它。
    async searchOrder(orderNo) {
      return (await this.listBatches()).filter((r) => String(r.orderNo || '') === String(orderNo));
    },

    /// 按 projectId 取工单级进度：行里 seriesId 就是批次 id，orderNo 是触发纳管要的订单号。
    async search(projectId) {
      const j = await post(`${BASE}/gridData4Search`, {
        page: 1,
        rows: 20,
        projectId,
        batchId: '',
        progressStatus: 0,
        cmdbProjectType: 1,
      });
      const row = (j.rows || []).find((r) => r.projectId === projectId);
      if (!row) throw new Error(`osa 里查不到这个工单：${projectId}`);
      return row;
    },

    /// 按批次 id 取逐台明细（带三个 *InstallInfo 报错原文，是逐台状态的主源）。
    async details(projectBatchId) {
      const j = await post(`${BASE}/gridData4PublicAgentDetails`, {
        projectBatchId,
        beginTime: '',
        endTime: '',
        page: 1,
        rows: 20,
      });
      return j.rows || [];
    },

    /// 拿一个批次的只读快照：批次信息 + 进度 + 逐台三格。绝不发 resource/management。
    async batchStatus({ projectId }) {
      const row = await this.search(projectId);
      const rows = await this.details(row.seriesId);
      const hosts = rows.map((h) => ({
        deviceIp: h.deviceIp || '',
        ipv6: h.ipv6 || '',
        agent: h.agentInstallFlag || '',
        zabbix: h.zabbixAgentInstallFlag || '',
        filebeat: h.filebeatAgentInstallFlag || '',
        agentInstallInfo: h.agentInstallInfo || '',
        zabbixAgentInstallInfo: h.zabbixAgentInstallInfo || '',
        filebeatAgentInstallInfo: h.filebeatAgentInstallInfo || '',
        updateTime: h.updateTime || '',
      }));
      const count = (k) => hosts.reduce((n, h) => n + (h[k] === OK_FLAG ? 1 : 0), 0);
      return {
        projectId: row.projectId,
        batch: { projectName: row.projectName || '', seriesId: row.seriesId, seriesName: row.seriesName || '' },
        orderNo: row.orderNo,
        agentValidateStatus: row.agentValidateStatus || '',
        agentValidateFlag: row.agentValidateFlag || '',
        progress: row.agentInstallProgress || '',
        hostCount: hosts.length,
        cellCount: hosts.length * 3,
        installedCount: count('agent') + count('zabbix') + count('filebeat'),
        pendingCount: hosts.reduce((n, h) => n + cellsOf(h).filter(inFlightCell).length, 0),
        hosts,
        // 上次落表时间：看得出数据是不是刚刷的，不用再猜
        touched: hosts.map((h) => h.updateTime).sort().at(-1) || '',
        // 整台口径随快照一起给：报告与 --status 都读这一份，别让人在外面各算一遍
        ...wholeHostVerdict({ hosts }),
        // 排队跑到哪了：attemptedCount 是「轮到过」的台数，allAttempted 是全跑完没有
        attemptedCount: hosts.filter(attemptedHost).length,
        allAttempted: allAttempted({ hosts }),
        // 分类是报告的固定一段（--status 也用它），随快照一起给
        classify: classifyBatch({ hosts }, ruleBook),
      };
    },

    /// 守着看排队跑完：每 pollMs 拉一次快照，直到「每台都轮到过」或超时。
    /// **纯只读，绝不点纳管** —— 这是盯 osa 逐台排队的，不是 --install 的替身。
    /// 判据是 allAttempted（每台的 IP 出来或三格不再全待检测），失败也算跑过。
    async watchOnboard({ projectId, pollMs = 5 * 60_000, timeoutMs = 24 * 60 * 60_000, now = () => Date.now(), onChange } = {}) {
      const deadline = now() + timeoutMs;
      let rounds = 1;
      let res = await this.batchStatus({ projectId });
      if (onChange) onChange(res, rounds);
      while (!allAttempted(res)) {
        if (now() + pollMs >= deadline) break;
        await sleep(pollMs);
        res = await this.batchStatus({ projectId });
        rounds += 1;
        if (onChange) onChange(res, rounds);
        if (now() >= deadline) break;
      }
      const timedOut = !allAttempted(res);
      return { ...res, watchRounds: rounds, watched: true, timedOut };
    },

    /// 点纳管（必要时）然后守在原地等出结果。触发纳管是 BPM 域的接口，由调用方把 trigger 注入进来。
    async runOnboard({ projectId, trigger, force = false, reinstall = false, pollMs = 5000, timeoutMs = 60 * 60_000, now = () => Date.now() } = {}) {
      let res = await this.batchStatus({ projectId });
      // 显式要求重装、批次却还在「验证中」：拒绝，一次请求都不发。接口对同一订单号重复点
      // 会发生什么没人实测过（可能叠加安装），这道闸是 --install 的必过关；--force 才放行。
      const refused = reinstall && !force && String(res.agentValidateFlag) === VALIDATING ? 'validating' : undefined;
      const clicked = !refused && (reinstall || neverManaged(res));
      if (clicked) await trigger(res.orderNo);
      const deadline = now() + timeoutMs;
      let timedOut = false;
      while (!isTerminal(res)) {
        if (now() >= deadline) {
          timedOut = true;
          break;
        }
        await sleep(pollMs);
        // 睡醒之后再卡一次：睡之前没到点不等于睡醒后还没到点，否则超时会被白多轮一次
        if (now() >= deadline) {
          timedOut = true;
          break;
        }
        res = await this.batchStatus({ projectId });
      }
      // 分类按「三格各自的原文」做：实测九台里只有一台有原文，且只落在一格
      return {
        ...res,
        // 超时那一刻是快照，不是结论：还在转的机器（某一格「待检测 / 安装中」）不算失败，
        // 单独报成「还在装」，否则报告里会出现「超时 + 失败 N 台」这种自相矛盾的结论。
        ...wholeHostVerdict(res),
        classify: classifyBatch(res, ruleBook),
        triggered: clicked,
        terminal: isTerminal(res),
        timedOut,
        // 报告里要说「等了 N 分钟」，这里按实际给的上限换回分钟
        ...(timedOut ? { timeoutMin: Math.round(timeoutMs / 60_000) || 1 } : {}),
        ...(refused ? { refused } : {}),
      };
    },
  };
}
