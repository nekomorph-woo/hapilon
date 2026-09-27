/**
 * hpl-md-reflow — 用户粘贴文本的硬换行重排
 *
 * 从别处复制的 CJK 文本常带 ~80 列的逐字硬换行，marked 会把段内 \n
 * 当强制换行保留，渲染出「左对齐挤在半屏、行尾参差」的气泡。
 * 这里把散文与列表条目内部的换行接回通栏（CJK 直接相接，拉丁词间补空格），
 * 结构行——标题、列表项、引用、表格行、代码围栏、分隔线——原样保留。
 * 只处理 messageType === "user"：模型输出的换行几乎都是有意排版。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Class {
  kind: "fence" | "rule" | "heading" | "quote" | "table" | "list" | "code" | "break" | "text" | "blank";
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const QUOTE_RE = /^\s{0,3}>/;
const TABLE_RE = /^\s{0,3}\|/;
const LIST_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const INDENT_CODE_RE = /^ {4,}\S/;
// 同一符号重复 ≥3 次的行视为分隔线（---、───、===== 等），不与上下文粘连
const RULE_RE = /^\s{0,3}([^\s\w])(\s*\1){2,}\s*$/;

function classify(line: string): Class {
  if (line.trim() === "") return { kind: "blank" };
  if (FENCE_RE.test(line)) return { kind: "fence" };
  if (RULE_RE.test(line)) return { kind: "rule" };
  if (HEADING_RE.test(line)) return { kind: "heading" };
  if (QUOTE_RE.test(line)) return { kind: "quote" };
  if (TABLE_RE.test(line)) return { kind: "table" };
  if (LIST_RE.test(line)) return { kind: "list" };
  if (INDENT_CODE_RE.test(line)) return { kind: "code" };
  // 行尾 ≥2 空格是 markdown 的强制换行，尊重它
  if (/  $/.test(line)) return { kind: "break" };
  return { kind: "text" };
}

const CJK_RE = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

function joinLines(acc: string, line: string): string {
  const prev = acc.slice(-1);
  const next = line.slice(0, 1);
  const glue = CJK_RE.test(prev) || CJK_RE.test(next) ? "" : " ";
  return acc + glue + line;
}

/** 把硬换行的散文接回通栏；结构行原样保留 */
export function reflowHardWraps(markdown: string): string {
  const lines = markdown.split(/\r\n|\r|\n/);
  const out: string[] = [];
  let buf: string | undefined;
  let inFence = false;

  const flush = () => {
    if (buf !== undefined) out.push(buf);
    buf = undefined;
  };

  for (const raw of lines) {
    if (inFence) {
      out.push(raw);
      if (FENCE_RE.test(raw)) inFence = false;
      continue;
    }
    const { kind } = classify(raw);
    if (kind === "fence") {
      flush();
      inFence = true;
      out.push(raw);
      continue;
    }
    if (kind === "blank") {
      flush();
      out.push(raw);
      continue;
    }
    if (kind === "text") {
      buf = buf === undefined ? raw.trim() : joinLines(buf, raw.trim());
      continue;
    }
    // 结构行：先结算正在累积的段落，再原样落行。
    // list 既是新单元的起点，也允许后续 text 行并入（悬挂续行）。
    flush();
    if (kind === "list") {
      buf = raw.trim();
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
