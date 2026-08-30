/**
 * panel-source.ts — 面板数据提取
 *
 * 从 session entries 中提取可查看的 collapsible panel 内容。
 * 与 pi-pop 不同，我们不遍历 TUI component tree——
 * 直接从 session entries 读取 tool call inputs 和 tool results。
 */
/**
 * 从 session entries 提取可查看面板
 * @param entries session entries 数组
 * @param maxPanels 最多返回的面板数，默认 50
 */
export function discoverPanels(entries, maxPanels = 50) {
    const panels = [];
    for (const entry of entries) {
        if (panels.length >= maxPanels)
            break;
        if (entry.type !== "message")
            continue;
        const msg = entry.message;
        if (!msg)
            continue;
        // Assistant messages: extract tool_use blocks
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (panels.length >= maxPanels)
                    break;
                if (block?.type === "tool_use") {
                    const toolName = block.name ?? "unknown";
                    const input = block.input ?? {};
                    // 构建标题：tool name + 关键参数
                    const inputSummary = summarizeInput(toolName, input);
                    const title = `${toolName} — ${inputSummary}`;
                    // 内容：参数 JSON
                    const content = formatToolInput(toolName, input);
                    panels.push({ title, content });
                }
            }
        }
        // Tool results: show execution output
        if (msg.role === "toolResult" && Array.isArray(msg.content)) {
            const textBlocks = msg.content.filter((b) => b?.type === "text");
            if (textBlocks.length > 0) {
                const text = textBlocks.map((b) => b.text ?? "").join("\n");
                const lines = text.split("\n").slice(0, 200); // 最多 200 行
                const title = `output — ${lines.length} lines`;
                panels.push({ title, content: lines });
            }
        }
    }
    return panels;
}
/** 从 tool input 构建摘要文本 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeInput(toolName, input) {
    switch (toolName) {
        case "bash":
            return String(input.command ?? input.cmd ?? "").slice(0, 80);
        case "read":
            return String(input.file_path ?? input.path ?? "").slice(0, 80);
        case "write":
            return String(input.file_path ?? input.path ?? "").slice(0, 80);
        case "edit":
            return String(input.file_path ?? input.path ?? "").slice(0, 80);
        case "grep":
            return String(input.pattern ?? "").slice(0, 80);
        default:
            return JSON.stringify(input).slice(0, 80);
    }
}
/** 格式化 tool input 为可读行 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatToolInput(toolName, input) {
    const lines = [];
    // 按字段展示
    for (const [key, value] of Object.entries(input)) {
        const str = typeof value === "string" ? value : JSON.stringify(value);
        if (str.length > 200) {
            // 长内容分行
            lines.push(`${key}:`);
            const contentLines = str.match(/.{1,78}/g) ?? [str];
            for (const l of contentLines) {
                lines.push(`  ${l}`);
            }
        }
        else {
            lines.push(`${key}: ${str}`);
        }
    }
    return lines.length > 0 ? lines : [JSON.stringify(input)];
}
