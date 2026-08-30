/**
 * hpl-simplify — /simplify 事后清理命令（#56）
 *
 * check → human → audit → modify 的人工闸门流程：
 *   /simplify [范围]        check 阶段：注入只读审查 prompt，agent 产出编号报告，零写入
 *   /simplify apply 2,4     modify 阶段：仅对用户批准的编号执行修改 + 跑测试
 *
 * 人工闸门的落点：check 与 apply 是两次独立命令——check 的报告先经用户
 * 审阅裁决，批准的编号才进入 apply。不存在「一条命令自动跑完」的路径。
 *
 * 规则文本内置于 audit.ts（不依赖 ponytail 运行时激活）。
 */
import { buildAuditPrompt, buildApplyPrompt, parseScope } from "./audit.js";
export default function hplSimplify(pi) {
    pi.registerCommand("simplify", {
        description: "Post-change cleanup audit (check → human approve → apply). Usage: /simplify [ref | A..B | --staged] or /simplify apply <numbers>",
        handler: async (args, ctx) => {
            const trimmed = args.trim();
            // ── apply 子命令：受控执行 ──────────────────────────────
            const applyMatch = trimmed.match(/^apply\s+(.+)$/);
            if (applyMatch) {
                const numbers = applyMatch[1]
                    .split(/[,\s]+/)
                    .map((s) => Number.parseInt(s, 10))
                    .filter((n) => Number.isInteger(n) && n > 0);
                if (numbers.length === 0) {
                    ctx.ui?.notify?.("Usage: /simplify apply 1,3,5 (item numbers from the audit report)", "error");
                    return;
                }
                // 人工闸门：执行前二次确认（防止误触发）
                if (ctx.ui?.confirm) {
                    const ok = await ctx.ui.confirm("hpl-simplify", `Apply audit items ${numbers.join(", ")}?\nOnly these items will be edited, then tests run.`);
                    if (!ok) {
                        ctx.ui?.notify?.("Apply cancelled. Nothing was modified.", "info");
                        return;
                    }
                }
                pi.sendUserMessage(buildApplyPrompt(numbers));
                return;
            }
            // ── check 阶段：只读审查 ────────────────────────────────
            const scope = parseScope(args);
            if (!scope) {
                ctx.ui?.notify?.("Usage: /simplify [ref | A..B | --staged] or /simplify apply <numbers>\n" +
                    "  /simplify            audit the latest commit\n" +
                    "  /simplify --staged   audit staged changes\n" +
                    "  /simplify main..HEAD audit a range", "error");
                return;
            }
            pi.sendUserMessage(buildAuditPrompt(scope));
            ctx.ui?.notify?.("Read-only audit dispatched. Review the numbered report, then: /simplify apply <numbers>", "info");
        },
    });
}
