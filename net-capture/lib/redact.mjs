// 脱敏：recorder 落盘前调用，保证明文不进 JSONL（规格 4.4）。
const SENSITIVE = /cookie|authorization|token|ticket|secret|passw|pwd/i;
// 不带 /g：带 /g 的 test() 会推进 lastIndex，同一正则复用时会漏判。
const PHONE_KEY = /^(phone|mobile|(tel|contact)_?number|shouji|sjh)/i;
const PHONE = /(\D|^)(\d{3})\d{4}(\d{4})(?=\D|$)/g;
const EMAIL = /([^@\s]{2})[^@\s]*@/g;
// 邮箱正则不加 \b（中文/数字边界不成立），改在键值分隔符处切断，免得把 "contact=" 粘进前缀。
const SEP = /([?&;,]\s*|\s+)/;
const maskEmail = (_m, head) => `${head}***@`;
const scrubEmail = (s) =>
  s
    .split(SEP)
    .map((part) => part.replace(EMAIL, maskEmail))
    .join('');
// 被截断的 JSON 解析不了，只能按"敏感键名 + 引号或等号 + 值"在原文上盖掉。
const KV = /([A-Za-z_][\w-]*(?:cookie|authorization|token|ticket|secret|passw|pwd)[\w-]*)(["']?\s*[:=]\s*)(["']?)([^"'&,\s}\]]*)/gi;
// 截断正好落在键名中间时找不到完整的键，按"敏感键名尾部 + 引号或等号"再盖一次剩下的值。
const KV_TAIL = /((?:cookie|authorization|token|ticket|secret|passw|pwd)[\w-]*)(["']?\s*[:=]\s*)(["']?)([^"'&,\s}\]]*)/i;
// 上一次扫描可能吞掉了这个键（值里夹空格），从最近的敏感键名尾部重新扫。
const TRAIL_RE = /(?:cookie|authorization|token|ticket|secret|passw|pwd)/gi;

// 脱敏总开关：NETCAPTURE_NO_REDACT=1 时全部明文落盘（仅用于本地排查，取完记得删）。
const NO_REDACT = process.env.NETCAPTURE_NO_REDACT === '1';

// 非结构化文本的唯一出口：敏感键值 → 邮箱 → 手机号，三层都走一遍。
function scrubText(text) {
  if (NO_REDACT) return text;
  const keyed = text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const key = pair.slice(0, eq);
      if (!SENSITIVE.test(decodeURIComponent(key))) return pair;
      return `${key}=<REDACTED:${pair.length - eq - 1} chars>`;
    })
    .join('&')
    .replace(KV, '$1$2$3<REDACTED>');
  // 尾锚版：JSON 键名可能被截断切掉开头的字母，只剩 "token"，从后往前找最近的敏感键再盖掉值。
  const at = keyed.search(TRAIL_RE);
  const guarded =
    at >= 0 ? keyed.slice(0, at) + keyed.slice(at).replace(KV_TAIL, '$1$2$3<REDACTED>') : keyed;
  return scrubEmail(guarded).replace(PHONE, '$1$2****$3');
}

function redactValue(key, value) {
  if (NO_REDACT) return value;
  if (typeof value === 'string') {
    if (PHONE_KEY.test(key)) return scrubEmail(value).replace(PHONE, '$1$2****$3');
    return scrubEmail(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v));
  if (value && typeof value === 'object') return redactObject(value);
  return value;
}

function redactObject(obj) {
  if (NO_REDACT) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) {
      const len = typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length;
      out[k] = `<REDACTED:${len} chars>`;
    } else {
      out[k] = redactValue(k, v);
    }
  }
  return out;
}

export function redactHeaders(headers) {
  return redactObject(headers);
}

// 文本可能是 JSON，也可能是表单/半截 JSON；JSON 走结构化遍历，其余走 scrubText 三层兜底。
export function redactText(text) {
  if (typeof text !== 'string') return text;
  try {
    return JSON.stringify(redactObject(JSON.parse(text)));
  } catch {
    return scrubText(text);
  }
}

// 落盘用的顺序入口：先按上限截断，再对截断后的片段脱敏——截断后的半截 JSON 由 scrubText 兜住。
// 顺序反过来的话，redactText 重排过的 JSON 再切一刀，照样会切在字符串中间。
export function redactBody(body, limit) {
  if (typeof body !== 'string') return { body: body ?? null };
  const truncated = body.length > limit;
  const piece = truncated ? body.slice(0, limit) : body;
  return { body: redactText(piece), ...(truncated ? { bodyTruncated: true } : {}) };
}
