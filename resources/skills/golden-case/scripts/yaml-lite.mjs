// yaml-lite —— case 文件用的零依赖 YAML 子集解析器（node:fs 之外无任何依赖）。
// 只支持 references/format.md 规定的子集：block/flow 的 map 与 seq、行内注释、
// 整数/小数/bool/字符串标量。锚点、多文档、多行标量、值内 # 均不支持。
// 小数字面量保留原始文本（"74.8"），以便视图渲染单位、freeze-check 做数值比较。

// 剥离注释：整行 # 或值后的 " #"（引号内的 # 不算）
function stripComment(line) {
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// 标量解析；小数按子集约定保留文本
export function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith('{')) return parseFlowMap(s);
  if (s.startsWith('[')) return parseFlowSeq(s);
  if (/^[+-]?\d+$/.test(s)) return Number(s);
  return s; // 小数与其余一律原样保留
}

// 顶层逗号切分：跳过引号内与括号/方括号内的逗号。
// 朴素的 split(',') 会把 `round(x * 1.10, 2)` 这类值从逗号处截断，且不报错——静默产错值。
function splitTop(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// flow map：{k: v, k2: v2}
function parseFlowMap(s) {
  const inner = s.trim().slice(1, -1);
  const out = {};
  if (inner.trim() === '') return out;
  for (const part of splitTop(inner)) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = parseScalar(part.slice(i + 1));
  }
  return out;
}

function parseFlowSeq(s) {
  const inner = s.trim().slice(1, -1);
  if (inner.trim() === '') return [];
  return splitTop(inner).map((p) => parseScalar(p));
}

// 行是否含「键:」结构（引号外第一个 ": " 或行尾 ":"）
function splitKey(text) {
  let inQuote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === ':') {
      const after = text[i + 1];
      if (after === undefined || after === ' ') {
        return [text.slice(0, i), text.slice(i + 1)];
      }
    }
  }
  return null;
}

function parseMap(lines, i, indent) {
  const out = {};
  while (i < lines.length) {
    const { indent: ind, text } = lines[i];
    if (ind !== indent || text.startsWith('- ')) break;
    const kv = splitKey(text);
    if (!kv) break; // 非法行，交给上层终止
    const [, rawVal] = kv;
    const val = rawVal.trim();
    if (val === '') {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [v, ni] = parseBlock(lines, i + 1, next.indent);
        out[kv[0].trim()] = v;
        i = ni;
        continue;
      }
      out[kv[0].trim()] = null;
      i++;
      continue;
    }
    out[kv[0].trim()] = parseScalar(val);
    i++;
  }
  return [out, i];
}

function parseSeq(lines, i, indent) {
  const out = [];
  while (i < lines.length) {
    const { indent: ind, text } = lines[i];
    if (ind !== indent || !text.startsWith('- ')) break;
    const rest = text.slice(2).trim();
    if (rest === '') {
      const next = lines[i + 1];
      const [v, ni] = next && next.indent > indent ? parseBlock(lines, i + 1, next.indent) : [null, i + 1];
      out.push(v);
      i = ni;
    } else if (/^[{[]/.test(rest)) {
      out.push(parseScalar(rest));
      i++;
    } else if (splitKey(rest)) {
      // 紧凑写法「- k: v」："- " 等价两级缩进，按 map 继续消化后续同级键
      lines[i] = { indent: ind + 2, text: rest };
      const [v, ni] = parseMap(lines, i, ind + 2);
      out.push(v);
      i = ni;
    } else {
      out.push(parseScalar(rest));
      i++;
    }
  }
  return [out, i];
}

function parseBlock(lines, i, indent) {
  return lines[i] && lines[i].text.startsWith('- ')
    ? parseSeq(lines, i, indent)
    : parseMap(lines, i, indent);
}

export function parseYaml(text) {
  const lines = text
    .split('\n')
    .map(stripComment)
    .filter((l) => l.trim() !== '')
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  if (lines.length === 0) return null;
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return value;
}

// 数值相等比较：兼容 "74.8"（保文本小数）与 74.8
export function numEq(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a) === String(b);
}

// 不可判定期望判定：字符串值含非 ASCII 或空白 = 描述，不是期望（铁律 5）
export function isUndecidable(v) {
  return typeof v === 'string' && (/[^\x20-\x7E]/.test(v) || /\s/.test(v));
}

// 是否小数形态（决定视图缺省单位「元」）
export function isDecimal(v) {
  return typeof v === 'string' && /^[+-]?\d+\.\d+$/.test(v);
}
