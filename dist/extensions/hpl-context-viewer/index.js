/**
 * hpl-context-viewer — /context 上下文查看命令扩展
 *
 * 通过 pi.registerCommand 注册 /context slash 命令，
 * 收集上下文数据 → 渲染为终端文本 → FloatingPane 浮层展示。
 *
 */
import { collectContextSnapshot } from "./collector.js";
import { renderContextLines, formatTokens } from "./renderer.js";
import { showFloatingPane } from "../../shared/floating-pane/index.js";
export default function hplContextViewer(pi) {
    pi.registerCommand("context", {
        description: "Show current context composition — token breakdown by category",
        handler: async (_args, ctx) => {
            try {
                // 收集数据
                const usage = ctx.getContextUsage();
                const spOpts = ctx.getSystemPromptOptions();
                const model = ctx.model;
                // 收集 session stats（遍历 entries）
                const entries = ctx.sessionManager.getEntries();
                let userMessages = 0;
                let assistantMessages = 0;
                let totalInputTokens = 0;
                let totalOutputTokens = 0;
                let totalTokens = 0;
                for (const entry of entries) {
                    if (entry.type === "message") {
                        if (entry.message.role === "user") {
                            userMessages++;
                        }
                        else if (entry.message.role === "assistant") {
                            assistantMessages++;
                            const msg = entry.message;
                            if (msg.usage) {
                                totalInputTokens += msg.usage.input ?? 0;
                                totalOutputTokens += msg.usage.output ?? 0;
                                totalTokens += msg.usage.totalTokens ?? (msg.usage.input ?? 0) + (msg.usage.output ?? 0);
                            }
                        }
                    }
                }
                const input = {
                    contextUsage: usage ?? undefined,
                    systemPromptOptions: spOpts
                        ? {
                            toolSnippets: spOpts.toolSnippets,
                            selectedTools: spOpts.selectedTools,
                            contextFiles: spOpts.contextFiles,
                            skills: spOpts.skills,
                        }
                        : undefined,
                    model: model
                        ? { id: model.id, name: model.name, contextWindow: model.contextWindow }
                        : undefined,
                    sessionStats: {
                        userMessages,
                        assistantMessages,
                        totalMessages: entries.length,
                        tokens: { input: totalInputTokens, output: totalOutputTokens, total: totalTokens },
                    },
                };
                const snapshot = collectContextSnapshot(input);
                const lines = renderContextLines(snapshot);
                // hpl-econ 压缩统计（#52）：有压缩记录时追加一行
                try {
                    const { statsLine } = await import("../hpl-econ/index.js");
                    lines.push("", statsLine());
                }
                catch {
                    // hpl-econ 未加载时静默跳过（可选依赖）
                }
                const totalInfo = `${formatTokens(snapshot.usage.tokens)} / ${formatTokens(snapshot.model.contextWindow)} tokens (${snapshot.usage.percent !== null ? snapshot.usage.percent.toFixed(1) + "%" : "?%"})`;
                const footer = `${snapshot.model.id} | ${totalInfo} | ↑↓ scroll | Esc close`;
                await showFloatingPane(ctx, {
                    title: `Context Usage — ${snapshot.model.id}`,
                    lines,
                    footer,
                    width: 68,
                    maxHeight: 80,
                });
            }
            catch (err) {
                console.error("[hpl-context-viewer] Failed to render context:", err);
                ctx.ui.notify("Failed to show context — see console for details", "error");
            }
        },
    });
}
