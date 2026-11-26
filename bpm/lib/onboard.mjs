// 把 batchStatus 的快照渲染成人读文字。终端只打摘要、逐台三格、按报错类型分组的失败，不生成任何文件。
import fs from 'node:fs';
import path from 'node:path';
import { renderClassify, rawsOf } from './naguan-errors.mjs';
import { cellsOf, failedHost, inFlightHost } from './osa-api.mjs';

/// 判定「这次跑得算不算过」—— 只看结果，不看渲染：
/// 超时 → 1（理由 timeout）；有失败台数或有待归类原文 → 1；其余 0。
/// 参数错误（2）发生在有结果之前，由 CLI 给。
export function exitCodeOf(res) {
  if (res.timedOut) return 1;
  if (res.failCount > 0) return 1;
  if (res.classify && res.classify.unknown.length) return 1;
  return 0;
}

/// 过没过的理由：timeout 要单独认得出来，别和「跑到头了但有失败」混成一句话。
export function exitReasonOf(res) {
  if (res.timedOut) return 'timeout';
  return exitCodeOf(res) ? 'failed' : 'ok';
}

/// 渲染一个批次的纳管进度。progress 为「/」时写「未开始」，别让人以为有数字没打出来。
export function renderOnboard(res) {
  const lines = [];
  lines.push(`${res.batch.projectName} / ${res.batch.seriesName}  工单 ${res.orderNo}`);
  const prog = res.progress && res.progress !== '/' ? res.progress : '未开始';
  lines.push(`进度 ${prog}  ${res.agentValidateStatus}  ${res.hostCount} 台`);
  lines.push('');

  // 拒绝重装要说在最前面：底下那 9 行没人看的话，至少第一屏能看到「没点、为什么没点」
  if (res.refused === 'validating') {
    lines.push(`拒绝重装：这个批次正在验证中（${prog}），没有点纳管 —— 接口对同一订单号重复点会发生什么没人实测过，可能把安装叠起来`);
    lines.push(`确认要强点：bpm onboard ${res.orderNo} --install --force   （不加 --install 就只是看状态）`);
    lines.push('');
  }

  // 三种标记分清楚：还在装的不打 ✘（它没失败，只是没数），否则一屏看下去像全挂了
  for (const h of res.hosts) {
    const mark = failedHost(h) ? '✘' : inFlightHost(h) ? '…' : ' ';
    lines.push(` ${mark} ${h.deviceIp || '(空)'}  ${cellsOf(h).join('  ')}`);
  }

  lines.push('');
  lines.push(`合计 ${res.installedCount}/${res.cellCount} 格已安装，${res.pendingCount} 格待检测`);
  // 排队跑到哪了：osa 逐台执行，没轮到的台 IP 空、三格全待检测 —— 这两句专治「怎么一直没动静」
  if (typeof res.attemptedCount === 'number') {
    lines.push(`已轮到 ${res.attemptedCount}/${res.hostCount} 台${res.allAttempted ? '（全部轮过一遍）' : `，还有 ${res.hostCount - res.attemptedCount} 台在排队`}`);
  }
  // 整台口径在 wholeHostVerdict 里算一次（res 里已有 failed/running/uncleared/两个台数），
  // 这里只负责打出来，免得两处各算各的
  // 超时是快照：上面失败数只算已经停下的机器，还在转的不进这个数（不然「超时」配「失败 N 台」自相矛盾）
  // 全台都轮过了就等于这一轮排队收了工（--watch 的正常出口），此时该给成功/失败台数，
  // 不能因为 terminal 只由 runOnboard 设置就把结论咽掉
  if (res.terminal || res.allAttempted === true) lines.push(`成功 ${res.okCount} 台，失败 ${res.failCount} 台`);
  else if (res.timedOut) lines.push(`已停下的 ${res.hostCount} 台里：成功 ${res.okCount} 台，失败 ${res.failCount} 台`);
  // 还在装的机器单独一句，绝不并进「失败」：它既不是成功也没出结论
  if (res.running && res.running.length) {
    lines.push(`还在装（没出结果，不算失败也不算成功）${res.running.length} 台：${res.running.map((h) => h.deviceIp || '(空)').join('  ')}`);
  }
  if (res.failed && res.failed.length) {
    lines.push(`失败 ${res.failed.length} 台：${res.failed.map((h) => h.deviceIp || '(空)').join('  ')}`);
    // 报错原文只挂在分类结果下面，同一段原文命中多台时只列一行
    if (res.classify && res.classify.errors.length + res.classify.unknown.length) lines.push(...renderClassify(res.classify));
    // 一格原文都没有的那几台，分类接不到，得单独点名：别让人以为原文被分类吃了
    for (const h of res.uncleared || []) lines.push(`  ${h.deviceIp || '(空)'} 没有报错原文（服务端没写原因）`);
    // 既没分类也说不出「没原文」时，照原文兜底打一遍
    if (!(res.classify && res.classify.errors.length + res.classify.unknown.length) && !(res.uncleared && res.uncleared.length)) {
      const written = res.failed.flatMap((h) => rawsOf(h).map((r) => `  ${h.deviceIp || '(空)'}  原文 ${r}`));
      lines.push(...(written.length ? written : ['  失败主机都没有报错原文']));
    }
    lines.push('本版不下发任何主机命令；「能修」那类留给第二版的 --fix，本版没有 --fix 这个参数，加上去会报参数错误');
  }
  lines.push('');
  // 超时要自己说清楚：到点退出不等于「全部失败」，还在装的机器不算失败
  if (res.timedOut) {
    const waited = res.timeoutMin ? `等了 ${res.timeoutMin} 分钟` : '到' + '点了';
    lines.push(`本次是超时退出（${waited}没等到结果），不是失败 —— 上面是到点那一刻的快照，还在装的机器不算失败`);
    lines.push(`当前进度 ${prog}，${res.pendingCount} 格待检测`);
    lines.push(`继续看：bpm onboard ${res.orderNo} --status`);
    lines.push('');
  }
  lines.push('纳管只管 zabbix / filebeat / snc；云安全中心 agent 另走 ec-agent-install');
  if (res.touched) lines.push(`数据更新于 ${res.touched}`);
  return lines.join('\n');
}

const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// 逐台这一层既留保留键（渲染用的 agent/zabbix/filebeat），也留接口的原始驼峰字段（回溯时才知道服务端回了什么）
const HOST_KEYS = [
  'deviceIp',
  'agent',
  'zabbix',
  'filebeat',
  'agentInstallFlag',
  'zabbixAgentInstallFlag',
  'filebeatAgentInstallFlag',
  'agentInstallInfo',
  'zabbixAgentInstallInfo',
  'filebeatAgentInstallInfo',
  'updateTime',
];

const viewOfError = (c) => ({
  type: c.type,
  group: c.group,
  disposition: c.disposition,
  suggest: c.suggest,
  fixable: !!c.fixable,
  raw: c.raw,
  hosts: c.hosts,
});

/// 下游只认这一份视图：字段名沿用接口的驼峰命名，形状固定。
/// 定位结果（from/ambiguous 的 candidates 或 from/id 的那几项）本来就已是接口形状，原样穿过去。
/// 注意这是 spec「输出」一节之外又补的一层：spec 只规定了退出码与人读报告，
/// --json / result.json 的字段清单以本函数为唯一真源，加字段先改这里再加测试。
export function toView(res) {
  if (!res || res.from) return { ...res };
  return {
    projectId: res.projectId,
    batch: res.batch,
    orderNo: res.orderNo,
    agentValidateStatus: res.agentValidateStatus,
    agentValidateFlag: res.agentValidateFlag,
    progress: res.progress,
    hostCount: res.hostCount,
    cellCount: res.cellCount,
    installedCount: res.installedCount,
    pendingCount: res.pendingCount,
    okCount: res.okCount,
    failCount: res.failCount,
    runningCount: (res.running || []).length,
    terminal: !!res.terminal,
    timedOut: !!res.timedOut,
    triggered: !!res.triggered,
    refused: res.refused || null,
    // 排队口径：attemptedCount 是「轮到过」的台数，watch 结束的报告靠它看进度
    attemptedCount: res.attemptedCount ?? null,
    allAttempted: res.allAttempted === undefined ? null : !!res.allAttempted,
    watched: !!res.watched,
    watchRounds: res.watchRounds ?? null,
    touched: res.touched || '',
    hosts: (res.hosts || []).map((h) => Object.fromEntries(HOST_KEYS.map((k) => [k, h[k]]))),
    classify: {
      errors: (res.classify?.errors || []).map(viewOfError),
      unknown: (res.classify?.unknown || []).map(viewOfError),
    },
    savedTo: res.savedTo || null,
    saveError: res.saveError || null,
  };
}

/// 明细留底：stateDir 底下按 UTC 时间戳开一目录放 result.json（与 lookup.json 同一个根，不另造输出根）。
/// 写失败不抛 —— 结果已经等到了，报出原因就够，别把整份报告一起丢掉。
export function saveResult(res, { root, at = new Date() } = {}) {
  const dir = path.join(root, 'onboard-' + utcStamp(at));
  const file = path.join(dir, 'result.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...toView(res), raw: res.raw ?? null }, null, 2), { mode: 0o600 });
    return file;
  } catch (e) {
    res.saveError = `result.json 没写成（${file}）：${e.message}；结果照上面这份看`;
    return null;
  }
}
