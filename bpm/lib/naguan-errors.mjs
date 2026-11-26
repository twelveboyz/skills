// 纳管报错的分类：规则是数据（assets/naguan-errors.json），代码只负责按顺序匹配。
// 命中即归类；都不命中归 unknown —— 只记录不生效，绝不让陌生报错自己变成规则。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_RULES = fileURLToPath(new URL('../assets/naguan-errors.json', import.meta.url));

/// 读规则表：一份文件同时给出规则（按顺序匹配）和报告分组（组名 → 一句话说明）。
/// 路径可注入：加一条规则、加一个组，都只改 JSON，不改代码。
export function loadRules(file = DEFAULT_RULES) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { rules: j.rules || [], groups: j.groups || {} };
}

/// 一条规则命中原文：match 里每条都要出现（all），或出现任一条（any，默认）。
function hits(text, rule) {
  return rule.match[(rule.match_mode || 'any') === 'all' ? 'every' : 'some']((k) => text.includes(k));
}

/// 归类一行原文。规则表顺序即优先级，第一条命中即归，绝不让一段原文同时落进两个类型。
export function classifyOne(raw, rules) {
  const rule = rules.find((r) => hits(raw, r));
  return rule
    // fixable：这条报错在本版就有明确处置；auto_fix：还要求处置只是几条本机能跑的命令。
    // 两个都是第二版 --fix 的门槛 —— 本版一个都不执行，见 spec「报错规则表」。
    ? { type: rule.type, group: rule.group, disposition: rule.disposition, suggest: rule.suggest || '', auto_fix: !!rule.auto_fix && !!rule.fixable, fixable: !!rule.fixable, raw }
    : { type: 'unknown', group: '还没结论', disposition: '', suggest: '', auto_fix: false, fixable: false, raw };
}

/// 一台的报错原文集合：只认三个安装信息格（*InstallInfo）—— 服务端把主机上装不上的原因
/// 打回在这三格里，规则表里 scope:"installInfo" 钉的就是这件事，分类只吃这三格的原文。
/// 实测九台里只有一格有原文，别假设每格都有。
export const rawsOf = (h) =>
  [h.agentInstallInfo, h.zabbixAgentInstallInfo, h.filebeatAgentInstallInfo]
    .flatMap((s) => String(s || '').split('\n'))
    .map((s) => s.trim())
    .filter(Boolean);

/// 整批分类：每段原文只出一行，挂上受影响的 IP；同一台三格报同一段原文只算一次。
/// base 是 loadRules() 的返回值（{rules, groups}），也接受只有规则数组的旧形状。
export function classifyBatch(res, base) {
  const { rules, groups } = Array.isArray(base) ? { rules: base, groups: {} } : base;
  const rows = new Map();
  for (const h of res.hosts) {
    const ip = h.deviceIp || '(空)';
    // 按格拆开逐段归类：scope 说的「只看安装信息格」就落在这一处
    for (const [cell, raw] of [
      ['agent', h.agentInstallInfo],
      ['zabbix', h.zabbixAgentInstallInfo],
      ['filebeat', h.filebeatAgentInstallInfo],
    ]) {
      const c = classifyOne(String(raw || '').trim(), rules);
      if (!c.raw) continue;
      const row = rows.get(c.raw) || { ...c, hosts: [], cells: [] };
      rows.set(c.raw, row);
      if (!row.hosts.includes(ip)) row.hosts.push(ip);
      if (!row.cells.includes(cell)) row.cells.push(cell);
    }
  }
  const all = [...rows.values()];
  return {
    groups,
    errors: all.filter((r) => r.type !== 'unknown'),
    unknown: all.filter((r) => r.type === 'unknown'),
  };
}

/// 分组渲染：按规则表 groups 的顺序出组标题 + 组内条目，组里没东西就整组不打。
/// 规则里写了个 groups 里没登记的组名，就按出现顺序补在最后 —— 不因为它没登记就把条目吞掉。
/// 未知永远落在「还没结论」，不进「能修」。
export function renderClassify(c) {
  const rows = [...c.errors, ...c.unknown];
  if (!rows.length) return ['', '失败主机没有报错原文，没法分类'];
  const meta = c.groups || {};
  const order = Object.keys(meta);
  for (const r of rows) if (!order.includes(r.group)) order.push(r.group);
  const lines = [''];
  for (const g of order) {
    const items = rows.filter((r) => r.group === g);
    if (!items.length) continue;
    lines.push(`【${g}】${meta[g] ? ' ' + meta[g] : ''}`);
    for (const r of items) {
      lines.push(`  ${r.type}  ${r.hosts.length} 台`);
      lines.push(`    ${r.hosts.join('  ')}`);
      lines.push(`    「${r.raw}」`);
      if (r.disposition) lines.push(`    处置 ${r.disposition}`);
      if (r.suggest) lines.push(`    建议 ${r.suggest}`);
    }
  }
  return lines;
}
