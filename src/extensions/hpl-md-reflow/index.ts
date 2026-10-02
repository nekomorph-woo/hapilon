/**
 * hpl-md-reflow — 用户粘贴文本的硬换行重排
 *
 * 从别处复制的 CJK 文本常带 ~80 列的逐字硬换行，marked 会把段内 \n
 * 当强制换行保留，渲染出「左对齐挤在半屏、行尾参差」的气泡。
 * 这里把散文与列表条目内部的换行接回通栏（CJK 直接相接，拉丁词间补空格），
 * 结构行——标题、列表项（含圈号/中文序号）、引用、表格行、代码围栏、分隔线——原样保留。
 * 只处理 messageType === "user"：模型输出的换行几乎都是有意排版。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Kind = "fence" | "fence-content" | "rule" | "heading" | "quote" | "table" | "list" | "code" | "break" | "text" | "blank";

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const QUOTE_RE = /^\s{0,3}>/;
// 圈号（①⓵㉑…）与中文序号（一、/（一）/1、/1．）后面不跟空格，符合 CJK 书写习惯
const LIST_RE = /^\s{0,3}(?:[-*+]\s|\d{1,9}[.)]\s|\d{1,9}[．)）、]|[（(][\d一二三四五六七八九十]{1,3}[)）]|[一二三四五六七八九十]{1,3}、|[\u2460-\u24FF])/;
const INDENT_CODE_RE = /^ {4,}\S/;
// 同一非字母数字符号（含 _）重复 ≥3 次的行视为分隔线（---、___、─── 等）
const RULE_RE = /^\s{0,3}([^\sa-zA-Z0-9])(\s*\1){2,}\s*$/;
// 裸结构行（空标题、空列表项、空引用）：marked 有语义，不能并入段落
const BARE_MARKER_RE = /^\s{0,3}(?:#{1,6}|[-*+]|>)\s*$/;
// GFM 分隔行：只含 |、-、:、空格，且至少一个 |（防 `标题\n---` 的 setext 被误判成单列表格）
const TABLE_DELIM_RE = /^\s{0,3}\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/;
const TABLE_LEAD_RE = /^\s{0,3}\|/;

function classify(line: string): Kind {
  if (line.trim() === "") return "blank";
  if (FENCE_RE.test(line)) return "fence";
  if (RULE_RE.test(line)) return "rule";
  if (BARE_MARKER_RE.test(line)) return "rule";
  if (HEADING_RE.test(line)) return "heading";
  if (QUOTE_RE.test(line)) return "quote";
  if (LIST_RE.test(line)) return "list";
  if (INDENT_CODE_RE.test(line)) return "code";
  // 行尾 ≥2 空格是 markdown 的强制换行，尊重它
  if (/  $/.test(line)) return "break";
  return "text";
}

// 围栏标记只认同类符号闭合：``` 内的 ~~~ 是内容不是闭合
function fenceMark(line: string): string | undefined {
  return FENCE_RE.exec(line)?.[1]?.[0];
}

// CJK 范围含圈号（U+2460-24FF）、CJK 兼容标点（U+FE30-FE4F）与 Ext B（U+20000+，代理对）
const CJK_RE = /[\u2460-\u24FF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]/u;

// 取末/首完整码点：代理对不能只取半个 UTF-16 码元
function lastCodePoint(s: string): string {
  const cps = Array.from(s.slice(-2));
  return cps[cps.length - 1] ?? "";
}
function firstCodePoint(s: string): string {
  return Array.from(s.slice(0, 2))[0] ?? "";
}

const URL_TAIL_RE = /https?:\/\/\S+$/;

function joinLines(acc: string, line: string): string {
  const prev = lastCodePoint(acc);
  const next = firstCodePoint(line);
  let glue = CJK_RE.test(prev) || CJK_RE.test(next) ? "" : " ";
  if (prev === "]" && next === "(") {
    // [文本] + (url) 是链接语法被硬换行拆开，中间原本无空格
    glue = "";
  } else if (URL_TAIL_RE.test(acc)) {
    // 行尾裸 URL 直接接 CJK 会把后续文字吞进链接，补回空格
    glue = " ";
  } else if (prev === "/") {
    // 行尾 / 是路径断行（src/ + foo.ts），中间原本无空格
    glue = "";
  }
  return acc + glue + line;
}

/**
 * 表格行需要上下文判定：分隔行本身、行首 | 且上一行是表格行/下一行是分隔行、
 * 或含 | 且下一行是分隔行（无首管道 GFM 表格的表头）。孤立 `| 开头` 行是散文。
 */
function tableMembership(lines: string[], kinds: Kind[]): boolean[] {
  const isTable = new Array<boolean>(lines.length).fill(false);
  const isDelim = (i: number) => i >= 0 && i < lines.length && kinds[i] === "text" && TABLE_DELIM_RE.test(lines[i]);
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i] !== "text") continue;
    const raw = lines[i];
    if (isDelim(i)) {
      isTable[i] = true;
    } else {
      const prevIsTable = i > 0 && isTable[i - 1];
      const nextIsDelim = isDelim(i + 1);
      isTable[i] =
        (TABLE_LEAD_RE.test(raw) && (prevIsTable || nextIsDelim)) ||
        (!TABLE_LEAD_RE.test(raw) && nextIsDelim && raw.includes("|"));
    }
  }
  return isTable;
}

/** 把硬换行的散文接回通栏；结构行原样保留 */
export function reflowHardWraps(markdown: string): string {
  const lines = markdown.split(/\r\n|\r|\n/);

  // 预分类：围栏状态需顺序扫描，表格归属需上下文
  const kinds: Kind[] = [];
  let inFence = false;
  let openMark = "";
  for (const raw of lines) {
    if (inFence) {
      kinds.push("fence-content");
      if (fenceMark(raw) === openMark) inFence = false;
      continue;
    }
    const mark = fenceMark(raw);
    if (mark !== undefined) {
      kinds.push("fence");
      inFence = true;
      openMark = mark;
      continue;
    }
    kinds.push(classify(raw));
  }
  const isTable = tableMembership(lines, kinds);

  const out: string[] = [];
  let buf: string | undefined;

  const flush = () => {
    if (buf !== undefined) out.push(buf);
    buf = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const kind = isTable[i] ? "table" : kinds[i];
    if (kind === "fence-content") {
      out.push(raw);
      continue;
    }
    if (kind === "fence") {
      flush();
      out.push(raw);
      continue;
    }
    if (kind === "blank") {
      flush();
      out.push(raw);
      continue;
    }
    if (kind === "text") {
      // 段落首行保留前导缩进（≤3 空格的缩进 marked 本就忽略）；续行缩进是换行伪影，trim
      buf = buf === undefined ? raw.replace(/\s+$/, "") : joinLines(buf, raw.trim());
      continue;
    }
    // 结构行：先结算正在累积的段落，再原样落行。
    // list 既是新单元的起点，也允许后续 text 行并入（悬挂续行）；前导缩进是嵌套层级，保留。
    flush();
    if (kind === "list") {
      buf = raw.replace(/\s+$/, "");
      continue;
    }
    out.push(raw.replace(/\s+$/, ""));
  }
  flush();
  return out.join("\n");
}

export default function hplMdReflow(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "user") return markdown;
    return reflowHardWraps(markdown);
  });
}
