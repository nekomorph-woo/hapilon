/**
 * xml.ts — XML 工具函数
 *
 * 提供 wrapSystemPrompt，由 assemble.ts 和测试使用。
 * xmlEscape 请直接从 shared/format.ts 导入。
 */
/** 将多个 XML section 字符串包裹为完整的 <system_prompt> 文档；空 section 被过滤 */
export function wrapSystemPrompt(sections) {
    const body = sections.filter((s) => s.length > 0).join("\n");
    return `<system_prompt>\n${body ? body + "\n" : ""}</system_prompt>\n`;
}
