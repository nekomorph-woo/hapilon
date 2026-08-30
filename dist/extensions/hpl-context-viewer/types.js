/**
 * types.ts — hpl-context-viewer 共享类型
 *
 * 定义 ContextSnapshot、CategoryBreakdown、SystemPromptMeta 等类型，
 * 供 collector.ts、renderer.ts 和 hpl-system-prompt/metadata.ts 使用。
 */
// ── Token 估算工具 ─────────────────────────────────────────────────────
/** Pi 内置 token 估算策略：chars / 4（保守高估） */
export const CHARS_PER_TOKEN = 4;
/** 估算一段文本的 token 数 */
export function estimateTokens(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
/** 估算多段文本的总 token 数 */
export function estimateTotalTokens(...texts) {
    return texts.reduce((sum, t) => sum + estimateTokens(t), 0);
}
/** 安全计算百分比（handle 0/NaN/null） */
export function safePercent(tokens, contextWindow) {
    if (tokens === null || contextWindow <= 0)
        return null;
    return Math.round((tokens / contextWindow) * 1000) / 10; // 1 decimal
}
