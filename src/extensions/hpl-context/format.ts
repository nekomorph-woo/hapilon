/**
 * format.ts — hapilon 上下文注入格式化（纯函数）
 *
 * 将文件发现结果格式化为 XML block，追加到 systemPrompt。
 * 设计来源: _plans/hpl-context-system.md §4.3
 */

/** XML 最小转义：保护属性值 &lt; 标签体，防止内容破坏 XML 结构 */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 将 HAPILON.md 文件列表格式化为 <hapilon_instructions> XML block */
export function formatHapilonMd(
  files: { path: string; content: string }[],
): string {
  if (files.length === 0) return "";
  const body = files.map((f) => xmlEscape(f.content)).join("\n\n").trim();
  return `<hapilon_instructions>\n\n${body}\n\n</hapilon_instructions>`;
}

/** 将 Rules 列表格式化为 <hapilon_rules> XML block */
export function formatRules(
  rules: { name: string; content: string }[],
): string {
  if (rules.length === 0) return "";
  const items = rules
    .map((r) => `<rule name="${xmlEscape(r.name)}">\n${xmlEscape(r.content)}\n</rule>`)
    .join("\n\n");
  return `<hapilon_rules>\n\n${items}\n\n</hapilon_rules>`;
}
