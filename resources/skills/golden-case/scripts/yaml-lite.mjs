// yaml-lite —— case 文件用的零依赖 YAML 子集解析器（node:fs 之外无任何依赖）。
// 只支持 references/format.md 规定的子集：block/flow 的 map 与 seq、行内注释、
// 整数/小数/bool/字符串标量。小数字面量保留原始文本（"74.8"），以便视图渲染单位、
// freeze-check 做数值比较。
// 解析语义是 lossless-or-fail：解析不了就抛 YamlLiteError（带原始行号），
// 绝不「能解析多少算多少」——静默吞掉一段输入等于让坏 case 源混进执行链。
export class YamlLiteError extends Error {
  constructor(message, line) {
    super(line == null ? message : `${message}（第 ${line} 行）`);
    this.name = 'YamlLiteError';
    this.line = line ?? null;
  }
}

function fail(message, line) {
  throw new YamlLiteError(message, line);
}

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

// flow 值整体校验：引号配平、括号配平、闭合后不得再有残余内容。
// 未校验时 slice(1,-1) 会把未闭合的 "[1, 2" 当 "[1, 2]" 静默接受。
function assertFlow(s, line) {
  const pairs = { '}': '{', ']': '[', ')': '(' };
  const stack = [];
  let quote = null;
  let closedAt = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '[' || c === '(') stack.push(c);
    else if (c === '}' || c === ']' || c === ')') {
      if (stack.pop() !== pairs[c]) fail(`括号错配「${c}」`, line);
      if (stack.length === 0) closedAt = i;
    } else if (stack.length === 0 && closedAt >= 0 && !/\s/.test(c)) {
      fail(`flow 值闭合后还有残余内容「${s.slice(closedAt + 1).trim()}」`, line);
    }
  }
  if (quote) fail(`引号未闭合`, line);
  if (stack.length) {
    const missing = stack.map((c) => ({ '{': '}', '[': ']', '(': ')' })[c]).join('');
    fail(`集合未闭合（缺 ${missing}）`, line);
  }
}

// 标量解析；小数按子集约定保留文本
export function parseScalar(raw, line = null) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.length >= 2) return s.slice(1, -1);
  }
  if (s.startsWith('"') || s.startsWith("'")) fail(`引号未闭合`, line);
  if (/^[&*!]/.test(s)) fail(`不支持的 YAML 构造「${s.slice(0, 1)}…」（锚点/别名/标签不在子集内）`, line);
  if (s.startsWith('{') || s.startsWith('[')) {
    assertFlow(s, line);
    return s.startsWith('{') ? parseFlowMap(s, line) : parseFlowSeq(s, line);
  }
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
function parseFlowMap(s, line) {
  const inner = s.trim().slice(1, -1);
  const out = {};
  if (inner.trim() === '') return out;
  for (const part of splitTop(inner)) {
    const i = part.indexOf(':');
    if (i < 0) fail(`flow map 项缺「键: 值」结构：「${part.trim()}」`, line);
    const key = part.slice(0, i).trim();
    if (key in out) fail(`重复键「${key}」`, line);
    out[key] = parseScalar(part.slice(i + 1), line);
  }
  return out;
}

function parseFlowSeq(s, line) {
  const inner = s.trim().slice(1, -1);
  if (inner.trim() === '') return [];
  return splitTop(inner).map((p) => parseScalar(p, line));
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

// 子集外的值形态：块标量与文档标记直接点名拒绝，不给「猜」的机会
function rejectUnsupportedValue(val, line) {
  if (/^[|>][+-]?$/.test(val)) fail(`不支持块标量「${val}」（多行标量不在子集内，压成一行或写成列表）`, line);
  if (/^[&*!]/.test(val)) fail(`不支持的 YAML 构造「${val.slice(0, 1)}…」（锚点/别名/标签不在子集内）`, line);
}

function parseMap(lines, i, indent) {
  const out = {};
  while (i < lines.length) {
    const { indent: ind, text, no } = lines[i];
    if (ind !== indent || text.startsWith('- ')) break;
    if (/^[?][\s]/.test(text)) fail(`不支持复杂键「? 」`, no);
    const kv = splitKey(text);
    if (!kv) fail(`无法识别的行「${text}」（既不是「键: 值」也不是列表项）`, no);
    const key = kv[0].trim();
    if (/^[&*!]/.test(key)) fail(`不支持的键「${key}」（锚点/别名/标签不在子集内）`, no);
    if (key in out) fail(`重复键「${key}」`, no);
    const val = kv[1].trim();
    if (val === '') {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [v, ni] = parseBlock(lines, i + 1, next.indent);
        out[key] = v;
        i = ni;
        continue;
      }
      out[key] = null;
      i++;
      continue;
    }
    rejectUnsupportedValue(val, no);
    out[key] = parseScalar(val, no);
    i++;
  }
  return [out, i];
}

function parseSeq(lines, i, indent) {
  const out = [];
  while (i < lines.length) {
    const { indent: ind, text, no } = lines[i];
    if (ind !== indent || !text.startsWith('- ')) break;
    const rest = text.slice(2).trim();
    if (rest === '') {
      const next = lines[i + 1];
      const [v, ni] = next && next.indent > indent ? parseBlock(lines, i + 1, next.indent) : [null, i + 1];
      out.push(v);
      i = ni;
    } else if (/^[{[]/.test(rest)) {
      out.push(parseScalar(rest, no));
      i++;
    } else if (splitKey(rest)) {
      // 紧凑写法「- k: v」："- " 等价两级缩进，按 map 继续消化后续同级键
      lines[i] = { indent: ind + 2, text: rest, no };
      const [v, ni] = parseMap(lines, i, ind + 2);
      out.push(v);
      i = ni;
    } else {
      rejectUnsupportedValue(rest, no);
      out.push(parseScalar(rest, no));
      i++;
    }
  }
  return [out, i];
}

function parseBlock(lines, i, indent) {
  const first = lines[i];
  if (!first) return [null, i];
  // 块值位置的单行 flow（`when:` 换行后整行 {…}）：整体作为一个 flow 标量消费，
  // 跨行延续属于未闭合输入，由 assertFlow 拒绝
  if (first.text.startsWith('{') || first.text.startsWith('[')) {
    return [parseScalar(first.text, first.no), i + 1];
  }
  return first.text.startsWith('- ')
    ? parseSeq(lines, i, indent)
    : parseMap(lines, i, indent);
}

export function parseYaml(text) {
  const lines = [];
  text.split('\n').forEach((raw, idx) => {
    const no = idx + 1;
    const stripped = stripComment(raw);
    if (stripped.trim() === '') return;
    const leading = stripped.slice(0, stripped.length - stripped.trimStart().length);
    if (leading.includes('\t')) fail(`缩进里有制表符（子集只接受空格缩进）`, no);
    const t = stripped.trim();
    if (t === '---' || t === '...' || t.startsWith('--- ')) fail(`不支持多文档标记「${t}」`, no);
    if (t.startsWith('%')) fail(`不支持指令行「${t}」`, no);
    lines.push({ indent: leading.length, text: t, no });
  });
  if (lines.length === 0) fail('空输入：没有可解析的内容', null);
  const [value, consumed] = parseBlock(lines, 0, lines[0].indent);
  if (consumed < lines.length) {
    fail(`解析提前结束，输入未被完整消费（缩进或结构不一致）`, lines[consumed].no);
  }
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
