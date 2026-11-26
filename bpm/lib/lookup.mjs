// 票 03：把用户给的一个参数解析成「哪个工单、哪个批次」。
// 参数有三种：32 位 hex 的 projectId（osa 批次列表里那一列）、15 位订单号、其余算关键字（E605）。
// 关键字走 osa 的全量搜索，命中的结果按关键字记进 STATE_DIR/lookup.json，下次同关键字不再搜。
// 票 05：15 位订单号也回退成搜索（按 orderNo 精确匹配，不当关键字模糊撞），且不写关键字缓存；
//         关键字缓存带 TTL —— 缓存只是省一次搜索，不是事实来源，工单状态天天在变。
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

const CACHE_FILE = 'lookup.json';
// 关键字缓存的有效期：一周。过期就重搜一次，免得缓存里那条早已换掉的工单一直顶着。
const CACHE_TTL_MS = 7 * 24 * 3600_000;
const PROJECT_ID_RE = /^[0-9a-f]{32}$/i;
const ORDER_NO_RE = /^\d{15}$/;

/// 认一段参数是什么：32 位 hex → projectId，15 位数字 → 订单号（不能当 projectId 查，但能回退成搜索），
/// 其余一律当关键字。边界按「整串」判，差一位就换一条路 —— 拿错一位的 projectId 去搜会静默失配。
export function kindOf(input) {
  const s = String(input || '').trim();
  if (PROJECT_ID_RE.test(s)) return 'projectId';
  if (ORDER_NO_RE.test(s)) return 'orderNo';
  return 'keyword';
}

/// 造一个「参数 → 工单/批次」解析器。api 是 osa_web 适配器（唯一的 HTTP 缝）；
/// batchStatus 是可选的「已知 projectId 直接查一次」的函数，不给就只回 projectId 本身；
/// 零命中的报错：说清搜的是什么、下一步给什么，别让人只在「搜不到」上打转。
function zeroHit(input, head) {
  return new Error(`${head} 订单号：${input}。换个说法，或直接给 32 位 projectId。`);
}

/// 命中多个就原样交回去让人选：这里挑一个等于替用户猜，猜错就是给别人的工单点纳管。
function ambiguous(input, rows, via = 'search') {
  return {
    from: 'ambiguous',
    via,
    input,
    candidates: rows.map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName || '',
      seriesId: r.seriesId,
      seriesName: r.seriesName || '',
      orderNo: r.orderNo || '',
      createTime: r.createTime || '',
    })),
  };
}

/// stateDir 默认取 bpm 技能的 STATE_DIR，测试传临时目录；now 固定首次命中时间与判断缓存过期。
export function createLookup({ api, batchStatus, stateDir = STATE_DIR, now = () => Date.now() } = {}) {
  const cacheFile = path.join(stateDir, CACHE_FILE);
  const readCache = () => {
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch {
      return {};
    }
  };

  return {
    async resolve(input) {
      const kind = kindOf(input);

      // 票 01 起的用法：直接给 projectId。不搜、不入关键字缓存
      if (kind === 'projectId') {
        const res = batchStatus ? await batchStatus({ projectId: input }) : null;
        return {
          from: 'id',
          input,
          projectId: input,
          seriesId: res?.batch?.seriesId || '',
          seriesName: res?.batch?.seriesName || '',
          orderNo: res?.orderNo || '',
        };
      }
      // 15 位订单号：回退成全量搜索，但只认 orderNo 相等的行 —— 拿它当关键字模糊撞会撞到别的批次。
      // 订单号是唯一键、不像关键字那样会变，所以不写关键字缓存。
      if (kind === 'orderNo') {
        const rows = await api.searchOrder(input);
        if (!rows.length) throw zeroHit(input, 'osa 里没有这个（按订单号精确搜过一遍）');
        if (rows.length > 1) return ambiguous(input, rows, 'orderNo');
        const one = rows[0];
        return {
          input,
          from: 'orderNo',
          projectId: one.projectId,
          seriesId: one.seriesId,
          seriesName: one.seriesName || '',
          orderNo: one.orderNo,
        };
      }

      // 同一段关键字搜出来的总是同一个工单：先看缓存，别每次重搜。过了 TTL 就当没命中。
      const cached = readCache()[input];
      if (cached && now() - Number(cached.firstHitAt || 0) < CACHE_TTL_MS) return { ...cached, input, from: 'cache' };

      const rows = await api.searchAll(input);
      if (!rows.length) {
        throw zeroHit(input, `osa 里搜不到「${input}」对应的工单（按工单名 / 批次名匹配）`);
      }
      if (rows.length > 1) return ambiguous(input, rows);

      const row = rows[0];
      const found = {
        input,
        from: 'search',
        projectId: row.projectId,
        seriesId: row.seriesId,
        seriesName: row.seriesName || '',
        orderNo: row.orderNo,
      };
      const cache = readCache();
      cache[input] = {
        projectId: found.projectId,
        seriesId: found.seriesId,
        orderNo: found.orderNo,
        firstHitAt: now(),
      };
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
      return found;
    },

    /// 把解析结果渲染成人读文字：定下来了就一行，没定就列候选 + 下一步怎么办。
    render(hit) {
      if (hit.from === 'ambiguous') {
        // projectId 打在每行最前面：下一步就是照着敲它，别再让人去 --json 里翻
        const lines = [`「${hit.input}」命中 ${hit.candidates.length} 个，不替你猜，挑一个重跑：`];
        for (const c of hit.candidates) {
          lines.push(`  ${c.projectId}  ${c.projectName}  ${c.seriesName}  ${c.orderNo}  ${c.createTime}`);
        }
        lines.push('下一步  把上面某一行的 projectId 填进去：bpm onboard <projectId>');
        return lines.join('\n');
      }
      if (hit.from === 'orderNo') {
        const where = `${hit.projectId}${hit.seriesName ? ' / ' + hit.seriesName : ''}`;
        return `订单号 ${hit.input} → ${where}`;
      }
      const where = `${hit.projectId}${hit.seriesName ? ' / ' + hit.seriesName : ''}`;
      const tail = hit.orderNo ? `  工单 ${hit.orderNo}` : '';
      if (hit.from === 'cache') return `命中缓存「${hit.input}」：${where}${tail}`;
      if (hit.from === 'id') return `projectId ${where}${tail}`;
      return `命中「${hit.input}」：${where}${tail}`;
    },
  };
}
