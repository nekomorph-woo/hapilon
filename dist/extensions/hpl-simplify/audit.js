/**
 * audit.ts — /simplify 的审查规则文本与 prompt 构建（#56）
 *
 * 纯函数模块：diff 范围解析、审查/执行 prompt 构建。
 * 规则文本内置（不依赖 ponytail 运行时激活）——ponytail off 时
 * /simplify 仍完整可用（issue #56 验收项）。
 */
// ── 规则文本（#54 code_style 白名单 + ponytail 红线，单一来源内置于本扩展）──
export const SIMPLIFY_RULES_TEXT = `Audit rules:

## Comments

Only three kinds of comments carry value; any other comment in the diff is a deletion candidate:
1. Functionality summary - one short line above a non-obvious block or function saying what the code does.
2. Design decision (optional) - why it is written this way instead of another way: the tradeoff, the constraint, the rejected alternative.
3. Major bug fix - what the bug was, its root cause, and why this fix closes it.

Candidates for deletion: comments that restate the code, narrate obvious steps, or pad with textbook explanations. Comments already on the unmodified lines are out of scope.

## Defensive programming

Candidates for removal: try-catch around internal calls that cannot throw, re-validation of internal data already guaranteed by the type system or preceding code, silent fallback values, empty catch blocks, catch-and-continue.

NEVER suggest deleting (hard red lines): input validation at trust boundaries (user input, network, files, process boundaries, external APIs), error handling that prevents data loss, security measures, accessibility basics, anything the user explicitly asked to keep.

## Confidence

Rate each finding: HIGH (mechanically safe - dead code, restating comment), MEDIUM (needs a human to judge context), LOW (stylistic, likely skip).`;
// ── 范围解析 ───────────────────────────────────────────────────────────
/** 解析 /simplify 参数为 diff 范围；未知参数返回 null（handler 报错提示） */
export function parseScope(args) {
    const trimmed = args.trim();
    if (trimmed === "")
        return { kind: "commit", ref: "HEAD" };
    if (trimmed === "--staged")
        return { kind: "staged" };
    // A..B 范围（git 双点语法）
    const range = trimmed.match(/^([^\s]+)\.\.([^\s]+)$/);
    if (range)
        return { kind: "range", from: range[1], to: range[2] };
    // 单个 ref（commit / branch / tag）
    if (/^[^\s]+$/.test(trimmed) && !trimmed.startsWith("-")) {
        return { kind: "commit", ref: trimmed };
    }
    return null;
}
/** 范围对应的取 diff 命令（供审查 prompt 内嵌，agent 自行执行） */
export function scopeDiffCommand(scope) {
    switch (scope.kind) {
        case "staged":
            return "git diff --cached";
        case "commit":
            return `git show ${scope.ref}`;
        case "range":
            return `git diff ${scope.from}..${scope.to}`;
    }
}
// ── Prompt 构建 ────────────────────────────────────────────────────────
/** check 阶段：只读审查 prompt——明确禁止写文件，只产出编号报告 */
export function buildAuditPrompt(scope) {
    const cmd = scopeDiffCommand(scope);
    const scopeDesc = scope.kind === "staged"
        ? "the staged changes"
        : scope.kind === "commit"
            ? `the changes in commit ${scope.ref}`
            : `the changes between ${scope.from} and ${scope.to}`;
    return (`/simplify audit (read-only). Audit ${scopeDesc}.\n\n` +
        `STRICT READ-ONLY: run \`${cmd}\` (and read surrounding file context as needed) ` +
        `to see the diff. DO NOT edit, write, or create any file. DO NOT run any state-changing command. ` +
        `Your entire output is a numbered findings report.\n\n` +
        SIMPLIFY_RULES_TEXT +
        `\n\nReport format: a numbered list. Each item: file:line, issue type ` +
        `(redundant-comment / impossible-guard / swallowed-error / spec others), ` +
        `one-line suggestion, confidence (HIGH/MEDIUM/LOW). ` +
        `If the diff has no findings, say so in one line. End of report.`);
}
/** modify 阶段：受控执行 prompt——只处理用户批准的编号 */
export function buildApplyPrompt(approved) {
    const list = approved.join(", ");
    return (`/simplify apply. A previous /simplify audit produced a numbered findings report ` +
        `(the most recent one in this conversation). Apply ONLY items: ${list}.\n\n` +
        `For each approved item: make the minimal edit that implements the suggestion. ` +
        `After all edits, run the test suite (or the relevant test files if the full suite is too slow). ` +
        `If a test fails because of an edit, revert that edit and report which one.\n\n` +
        `Finish with a summary: items applied, items reverted, test result, net diff stat.`);
}
