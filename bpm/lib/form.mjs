// 把 taskDetailBo / getInstFormAndBO 的响应渲染成人读文本
// 响应结构：{ result, form:{formHtml,name,...}, data:{<表单key>:{字段:值,...}}, permission, buttons }

const EMPTY = '（空）';

/// 数组元素取一个像人名的标签
const pickName = (x) => x.name || x.title || x.label || x.financialName || x.fileName || x.realName || JSON.stringify(x);

/// 值转文本：JSON 数组只取 name 类标签，过长截断
function fmtValue(v) {
  if (v === null || v === undefined || v === '') return EMPTY;
  if (Array.isArray(v)) {
    if (!v.length) return EMPTY;
    return v.map((x) => (x && typeof x === 'object' ? pickName(x) : String(x))).join('、');
  }
  if (typeof v !== 'object') {
    const s = String(v);
    if (s === '[]' || s === '{}' || s === 'null') return EMPTY;
    // 值是 JSON 字符串（附件表、子表等）→ 取 name
    if (/^\s*[[{]/.test(s)) {
      try {
        const p = JSON.parse(s);
        if (Array.isArray(p)) {
          if (!p.length) return EMPTY;
          // 元素带裸文件名的（如 business_list）优先 financialName/name
          return p.map((x) => (x && typeof x === 'object' ? pickName(x) : String(x))).join('、');
        }
        if (p && typeof p === 'object') {
          const inner = Object.entries(p)
            .filter(([, y]) => y !== null && y !== '' && !(Array.isArray(y) && !y.length))
            .map(([k, y]) => `${k}=${Array.isArray(y) ? y.join('/') : y}`);
          return inner.length ? inner.join('; ') : EMPTY;
        }
      } catch {
        /* 不是 JSON，原样输出 */
      }
    }
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  }
  // 普通对象
  const inner = Object.entries(v)
    .filter(([, y]) => y !== null && y !== '' && !(Array.isArray(y) && !y.length))
    .map(([k, y]) => `${k}=${Array.isArray(y) ? y.join('/') : y}`);
  return inner.length ? inner.join('; ') : EMPTY;
}

const clean = (s) =>
  s
    .replace(/<!--[\s\S]*?-->/g, '') // 注释掉的按钮
    .replace(/<el-button[\s\S]*?<\/el-button>/g, '') // 行内按钮不算标签
    .replace(/<i[\s\S]*?<\/i>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/// 分组标题：只取冒号前的主干，去掉挂着的按钮文案
const asSection = (s) => s.split(/[：:]/)[0].replace(/[，,、\s]+$/, '').trim();

/// 从 formHtml 抽取字段，保持文档顺序。
/// 表单是 th/td 交错排列。td 里有 v-model 才是字段，
/// 否则那个 th 是分组标题（如「订购资源验收结果」），后面跟的是按钮/子表。
function extractFields(html) {
  const out = [];
  let pending = null;
  const re = /<t([hd])\b([^>]*)>([\s\S]*?)<\/t\1>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, attrs, inner] = m;
    if (tag === 'h') {
      const label = clean(inner);
      if (!label) continue;
      // 独占整行的表头一定是分组标题
      if (/group-th/.test(attrs)) {
        out.push({ section: asSection(label) });
        pending = null;
      } else {
        pending = label.replace(/^[*＊]\s*/, '').replace(/[：:]\s*$/, '');
      }
    } else {
      if (!pending) continue;
      const vm = inner.match(/v-model="data\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)"/);
      if (vm) out.push({ label: pending, key: vm[1], field: vm[2] });
      else out.push({ section: asSection(pending) }); // 无输入控件 → 分组标题
      pending = null;
    }
  }
  return out;
}

/// 渲染成行数组
export function renderForm(res) {
  const form = res.form || {};
  const data = res.data || {};
  const lines = [];
  const title = form.name || form.formKey || '工单表单';
  lines.push(`表单：${title}${form.formType ? `（${form.formType}）` : ''}`);

  const fields = extractFields(form.formHtml || '');
  if (!fields.length) {
    lines.push('（表单模板未给出字段列表，只能看原始数据）');
  }
  let seen = 0;
  for (const f of fields) {
    if (f.section) {
      lines.push('');
      lines.push(`── ${f.section} ──`);
      continue;
    }
    const bag = data[f.key] || {};
    const v = fmtValue(bag[f.field]);
    lines.push(`  ${f.label}：${v}`);
    seen++;
  }

  // 表单模板未覆盖的字段（模板只列当前节点可见项）
  const covered = new Set(fields.filter((f) => f.key).map((f) => `${f.key}.${f.field}`));
  const extra = [];
  for (const [key, bag] of Object.entries(data)) {
    if (!bag || typeof bag !== 'object') continue;
    for (const [field, v] of Object.entries(bag)) {
      if (covered.has(`${key}.${field}`)) continue;
      if (field === 'initData') continue;
      const t = fmtValue(v);
      if (t === EMPTY) continue;
      extra.push(`  ${field}：${t}`);
    }
  }
  if (extra.length) {
    lines.push('');
    lines.push('── 模板之外还有值的字段 ──');
    lines.push(...extra);
  }

  const btns = (res.buttons || []).map((b) => b.name).filter(Boolean);
  if (btns.length) {
    lines.push('');
    lines.push(`可用操作：${[...new Set(btns)].join(' / ')}`);
  }
  return { lines, fieldCount: seen, extraCount: extra.length };
}
