/**
 * confirm.ts — confirm 弹框辅助（4 选项 select + 通配选项）
 *
 * 用 ctx.ui.select() 替代 ctx.ui.confirm()，提供：
 *   Allow Once      — 仅本次放行
 *   Allow Session   — 当前 session 不再询问（内存）
 *   Allow Project   — 本项目不再询问（持久化到 .hapilon/config.local.json）
 *   Allow Pattern   — 仅当调用方给出 allowSuggestion 时出现：输入通配前缀匹配
 *   Deny            — 拒绝本次
 */
const OPTIONS = [
    "Allow Once",
    "Allow this Session",
    "Allow this Project",
];
const WILDCARD_SESSION = "Allow Pattern this Session";
const WILDCARD_PROJECT = "Allow Pattern this Project";
const DENY = "Deny";
export async function requestConfirm(ctx, title, msg, opts = {}) {
    if (!ctx.hasUI)
        return { status: "unavailable" };
    try {
        const suggestion = opts.allowSuggestion;
        const options = suggestion !== undefined
            ? [...OPTIONS, WILDCARD_SESSION, WILDCARD_PROJECT, DENY]
            : [...OPTIONS, DENY];
        const choice = await ctx.ui.select(title + "\n\n" + msg, options);
        switch (choice) {
            case "Allow Once": return { status: "approved", scope: "once" };
            case "Allow this Session": return { status: "approved", scope: "session" };
            case "Allow this Project": return { status: "approved", scope: "project" };
            case WILDCARD_SESSION:
            case WILDCARD_PROJECT: {
                // 入口仅在 suggestion !== undefined 时出现；?? "" 仅为满足类型收窄
                const entered = await ctx.ui.input(`${title}\n\n允许命令前缀（尾随 * 前缀匹配）：\n建议：${suggestion ?? ""}\n留空使用建议`, suggestion);
                if (entered === undefined)
                    return { status: "rejected" }; // 取消输入 = 拒绝
                return {
                    status: "approved",
                    scope: choice === WILDCARD_PROJECT ? "project" : "session",
                    allowPattern: entered.trim() || suggestion || entered,
                };
            }
            default: return { status: "rejected" };
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("安全确认对话框异常:", message);
        return { status: "error", message };
    }
}
/**
 * 高危路径（WRITE_BLOCK）专用确认 — 仅两个选项（允许本次会话 / 拒绝）。
 *
 * 与 requestConfirm 的区别：高危路径的 /allow 放行**强制 session 级**，
 * 不提供 "Allow this Project" 持久化选项——block 保护不可被项目配置永久绕过
 * （安全设计核心原则：block 不可被持久化信任解除）。
 */
export async function requestHighRiskConfirm(ctx, title, msg) {
    if (!ctx.hasUI)
        return false; // 非交互模式 → 拒绝（安全侧默认）
    try {
        const choice = await ctx.ui.select(title + "\n\n" + msg, ["Allow this Session", "Deny"]);
        return choice === "Allow this Session";
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("高危路径确认对话框异常:", message);
        return false; // 对话框异常 → 拒绝
    }
}
