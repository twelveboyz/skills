// 交维：把交维目录里的交付物对应到工单字段，打包 zip，读资源录入表判定安全验收
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/// 默认映射：表单字段 → 交维目录里的相对路径。
/// `$dir` = 把整个交维目录打进一个 zip；`$entry` = 资源录入表目录（只取 xlsx）。
export const DEFAULT_MAP = {
  gcjwcl: '$dir',
  resource_subscription_configuration_table: '$entry',
  baseline_check_file: '4、安全漏扫报告/基线检查',
  vulnerability_scanning_file: '4、安全漏扫报告/漏洞扫描',
  acceptance_file: '4、安全漏扫报告/漏洞、基线及弱口令扫描说明.txt',
};

export const LABELS = {
  gcjwcl: '工程交维材料',
  resource_subscription_configuration_table: '资源订购配置表',
  baseline_check_file: '基线检查文件',
  vulnerability_scanning_file: '安全漏扫文件',
  acceptance_file: '检查验收说明',
};

/// 表单数据的真实 key：form.formKey 和 data 的 key 不一定相同
/// （E605：formKey=zydgjflcbd，data 里却是 zydgjflcjm），所以要单独认一次。
export function dataKeyOf(detail) {
  const formKey = detail?.form?.formKey;
  const data = detail?.data || {};
  if (formKey && data[formKey]) return formKey;
  const keys = Object.keys(data).filter((k) => data[k] && typeof data[k] === 'object');
  if (keys.length === 1) return keys[0];
  throw new Error(`认不出表单数据：formKey=${formKey}，data 里有 ${keys.join('、') || '空'}`);
}

/// 表单里 multiple="false" 的字段：多给一个文件后端不会收，得提前拦住
export const SINGLE = new Set(['baseline_check_file', 'vulnerability_scanning_file', 'acceptance_file']);

/// 判定「是否涉及安全验收」的关键词：资源录入表里出现这些就算涉及计算资源
const COMPUTE_CELL_KEYWORDS = ['弹性计算', '计算资源', '云主机', '云服务器', 'ECS'];

const skip = (n) => n.startsWith('~$') || n.startsWith('.') || n === '.gitkeep';

/// 交维骨架里「资源录入表」在哪个一级目录：nil 用 6、nil-s 用 3
export function entryDirOf(root) {
  for (const name of ['6、资源录入表', '3、资源录入表']) {
    const p = path.join(root, name);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return { dir: p, name };
  }
  return null;
}

function listFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((n) => !skip(n))
    .map((n) => path.join(dir, n))
    .filter((p) => fs.statSync(p).isFile())
    .sort()
    .map((p) => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }));
}

/// 从表单模板里抠出每个字段上传组件的 accept 列表。
/// 模板里是 `<ht-file v-model="data.<表单key>.<字段>" :multiple="..." accept="pdf,PDF" ... />`。
/// 这个列表就是后端收不收的硬边界：基线检查只收 xls/xlsx/csv，安全漏扫只收 pdf，
/// 检查验收说明只收 doc/docx/txt。目录里塞了 zip 之类的东西，先按它筛掉。
export function acceptMap(detail) {
  const html = detail?.form?.formHtml || '';
  const out = {};
  for (const seg of html.split('<ht-file').slice(1)) {
    const vm = /v-model="data\.[A-Za-z0-9_]+\.([A-Za-z0-9_]+)"/.exec(seg);
    const ac = /accept="([^"]*)"/.exec(seg);
    if (!vm || !ac) continue;
    const exts = [...new Set(
      ac[1]
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    )];
    if (exts.length) out[vm[1]] = exts;
  }
  return out;
}

const extOf = (name) => path.extname(name).slice(1).toLowerCase();

/// 按映射表算出「哪些字段传哪些文件」。缺的字段标 missing，不抛错 —— 由调用方决定要不要拦。
/// `accepts` 给出字段的 accept 白名单；给了就先把不符合的文件筛进 `dropped`，不静默丢掉。
export function collectPlan(root, map = DEFAULT_MAP, accepts = {}) {
  const entry = entryDirOf(root);
  if (!entry) {
    throw new Error(`交维目录里找不到「6、资源录入表」或「3、资源录入表」：${root}`);
  }

  const items = [];
  for (const [field, target] of Object.entries(map)) {
    const item = { field, label: LABELS[field] || field, target, zip: false, files: [], dropped: [], missing: false };

    if (target === '$dir') {
      item.zip = true;
      item.files = [{ path: root, name: `${path.basename(root)}.zip`, size: 0 }];
    } else {
      const rel = target === '$entry' ? entry.name : target;
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) {
        item.missing = true;
        items.push(item);
        continue;
      }
      let files;
      if (fs.statSync(abs).isDirectory()) {
        files = listFiles(abs);
        if (target === '$entry') {
          const xlsx = files.filter((f) => /\.xlsx$/i.test(f.name));
          files = xlsx.length ? xlsx : files;
        }
      } else {
        files = [{ path: abs, name: path.basename(abs), size: fs.statSync(abs).size }];
      }
      const allowed = accepts[field];
      if (allowed && allowed.length) {
        item.dropped = files.filter((f) => !allowed.includes(extOf(f.name)));
        files = files.filter((f) => allowed.includes(extOf(f.name)));
      }
      item.files = files;
    }
    items.push(item);
  }
  return { entry, items };
}

// ---------------- zip 写 ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/// 列出目录下所有文件（相对路径用 /），跳过 Office 锁文件与隐藏文件
function walk(root, dir = root, out = []) {
  for (const n of fs.readdirSync(dir)) {
    if (skip(n)) continue;
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(root, p, out);
    else out.push(p);
  }
  return out;
}

/// 把整个目录打成一个 zip（deflate）。顶层带目录名，解压出来就是一个文件夹。
export function zipDir(root) {
  const prefix = path.basename(root);
  const entries = walk(root).sort();

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of entries) {
    const rel = `${prefix}/${path.relative(root, file).split(path.sep).join('/')}`;
    const raw = fs.readFileSync(file);
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const name = Buffer.from(rel, 'utf8');
    const { time, date } = dosTime(fs.statSync(file).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

// ---------------- xlsx 读（只为判定安全验收） ----------------

function unzip(buf) {
  const from = Math.max(0, buf.length - 65558);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    if (!name.endsWith('/')) {
      const raw = buf.subarray(start, start + csize);
      out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    }
    p += 46 + nlen + elen + clen;
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const plain = (xml) =>
  xml
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ENTITIES[k]);

/// 读第一个可见工作表的字符串单元格，判断里面有没有计算类资源。
/// 返回 {value:'1'|'0'|null, reason}；解析不了给 null，交给调用方保留原值。
export function detectSafeAcceptance(buf) {
  let z;
  try {
    z = unzip(buf);
  } catch (e) {
    return { value: null, reason: `读不了 xlsx：${e.message}` };
  }

  const wb = z.get('xl/workbook.xml');
  const rels = z.get('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) return { value: null, reason: 'xlsx 缺 workbook.xml' };

  const targets = new Map();
  for (const m of rels.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const tgt = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && tgt) targets.set(id, tgt);
  }

  const sheet = [...wb.toString('utf8').matchAll(/<sheet\b[^>]*>/g)]
    .map((m) => ({
      name: /\bname="([^"]*)"/.exec(m[0])?.[1] || '',
      rid: /\br:id="([^"]+)"/.exec(m[0])?.[1] || '',
      hidden: /\bstate="(hidden|veryHidden)"/.test(m[0]),
    }))
    .find((s) => !s.hidden && s.rid);
  if (!sheet) return { value: null, reason: 'xlsx 里没有可见工作表' };

  const tgt = targets.get(sheet.rid) || '';
  const sheetPath = tgt.startsWith('/') ? tgt.slice(1) : `xl/${tgt.replace(/^\.\//, '')}`;
  const sheetXml = z.get(sheetPath);
  if (!sheetXml) return { value: null, reason: `xlsx 缺工作表 ${sheetPath}` };

  const shared = [];
  const ss = z.get('xl/sharedStrings.xml');
  if (ss) {
    for (const m of ss.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(plain(m[1]));
  }

  const cells = [];
  for (const m of sheetXml.toString('utf8').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const t = /\bt="([^"]+)"/.exec(m[1])?.[1];
    if (t === 's') {
      const i = Number(plain(m[2]));
      if (Number.isFinite(i) && shared[i]) cells.push(shared[i]);
    } else if (t === 'inlineStr' || t === 'str') {
      cells.push(plain(m[2]));
    }
  }

  for (const kw of COMPUTE_CELL_KEYWORDS) {
    const hits = cells.filter((c) => c.includes(kw)).length;
    if (hits) return { value: '1', reason: `「${sheet.name}」含「${kw}」${hits} 处`, hits };
  }
  return { value: '0', reason: `「${sheet.name}」里没有计算类资源关键词`, hits: 0 };
}
