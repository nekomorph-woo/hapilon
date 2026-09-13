/**
 * classifier.ts — 命令安全分类纯函数
 *
 * classifyCommand — block / confirm / allow 三级分类
 * hasShellInjection — shell 注入技巧检测（纯探测，不再直接阻断）
 *
 * 判定顺序（动机：旧版对整条命令做正则，导致「引号里的危险词」与任何
 * `$(...)` 都直接 block，grep/find 这类只读命令频繁被误拦）：
 *   1. 命令替换出现在破坏性目标位（`rm -rf $(echo /)`）→ block
 *   2. whole 规则对「去引号视图」匹配（目标型/跨命令型）→ block
 *   3. 逐简单命令：只读命令整体跳过；命令规则命中 → block / confirm
 *   4. whole 的 confirm 规则 → confirm
 *   5. 数据库客户端 + SQL 关键字（需要引号内容，故看原始命令）→ confirm
 *   6. 递归检查：命令替换体、`sh -c "<脚本>"` 的脚本体、eval 参数
 */
import { BLOCK_PATTERNS, CONFIRM_PATTERNS, SHELL_INJECTION_PATTERNS, } from "./rules.js";
import { commandWordAt, extractSubstitutions, extractShellPayloads, splitSimpleCommands, stripQuotedText, substitutionInDestructiveTarget, } from "./parse.js";
const RANK = { allow: 0, confirm: 1, block: 2 };
function maxVerdict(a, b) {
    return RANK[a] >= RANK[b] ? a : b;
}
/**
 * 只读命令：自身不会执行危险操作，其参数里的危险词（`grep "shutdown"`）
 * 不是命令，跳过命令规则。破坏性删除等由 whole 规则先行覆盖
 * （`find -exec rm` / `find -delete` 都是 whole 作用域）。
 * 刻意不含 sed/awk/xargs/ssh/curl 等可写文件或执行命令的工具。
 */
const READ_ONLY_COMMANDS = new Set([
    "grep", "egrep", "fgrep", "rg", "ag", "ack",
    "ls", "cat", "head", "tail", "wc", "cut", "tr", "sort", "uniq", "nl", "tac",
    "echo", "printf", "file", "stat", "du", "df", "ps", "lsof", "env", "printenv",
    "which", "type", "date", "pwd", "tree", "jq", "basename", "dirname", "realpath",
    "test", "true", "false", "sleep", "seq", "find", "diff",
]);
/** 数据库客户端命令词——SQL 关键字只在它们的参数里才算危险 */
const DB_CLIENT_WORDS = /^(psql|mysql|mariadb|sqlite3?|mongo|mongosh|clickhouse-client|redis-cli)$/;
function ruleHit(rules, scope, text) {
    return rules.find((rule) => (rule.scope ?? "command") === scope && rule.test(text));
}
export function classifyCommand(command) {
    const trimmed = command.trim();
    if (!trimmed)
        return "allow";
    const normalized = normalizeForInspection(trimmed);
    const { view: subView, bodies } = extractSubstitutions(normalized);
    const unquoted = stripQuotedText(subView);
    const simpleCommands = splitSimpleCommands(unquoted);
    let verdict = "allow";
    // 1. 命令替换藏在破坏性目标位（`rm -rf $(...)`）——目标不可静态求值，直接 block
    if (bodies.length > 0 && substitutionInDestructiveTarget(subView)) {
        verdict = "block";
    }
    // 2. whole 规则：目标型/跨命令型（去引号视图）
    if (ruleHit(BLOCK_PATTERNS, "whole", unquoted))
        return "block";
    // 3. 逐简单命令（只读命令跳过）
    for (const simple of simpleCommands) {
        if (READ_ONLY_COMMANDS.has(commandWordAt(simple).word))
            continue;
        if (ruleHit(BLOCK_PATTERNS, "command", simple))
            return "block";
    }
    for (const simple of simpleCommands) {
        if (READ_ONLY_COMMANDS.has(commandWordAt(simple).word))
            continue;
        if (ruleHit(CONFIRM_PATTERNS, "command", simple))
            verdict = maxVerdict(verdict, "confirm");
    }
    // 4. whole 的 confirm 规则
    if (ruleHit(CONFIRM_PATTERNS, "whole", unquoted))
        verdict = maxVerdict(verdict, "confirm");
    // 5. SQL 客户端：关键字在引号参数里，故看原始命令
    if (sqlClientDangerous(trimmed))
        verdict = maxVerdict(verdict, "confirm");
    // 6. 递归：命令替换体与 shell 脚本载荷（sh -c "..." / eval "..."）
    for (const body of [...bodies, ...extractShellPayloads(trimmed)]) {
        verdict = maxVerdict(verdict, classifyCommand(body));
    }
    return verdict;
}
/** sql 客户端判定：命令词是 DB 客户端且原始命令里出现 SQL 危险关键字 */
function sqlClientDangerous(rawCommand) {
    if (!/\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+(TABLE\s+)?)/i.test(rawCommand))
        return false;
    const unquoted = stripQuotedText(extractSubstitutions(rawCommand).view);
    return splitSimpleCommands(unquoted).some((simple) => DB_CLIENT_WORDS.test(commandWordAt(simple).word));
}
/**
 * 归一化检测副本——不修改原始命令，仅用于规则匹配。
 * 反斜杠转义空白（`rm\ -rf\ /`）与 IFS 变量（`${IFS}`/`$IFS`，shell 展开为空白）
 * 在真实执行中等价于普通空白，检测时需同步归一化，否则绕过 `\s+` 匹配。issue #6
 */
function normalizeForInspection(command) {
    return command
        .replace(/\\ /g, " ")
        .replace(/\$\{IFS\}/g, " ")
        .replace(/\$IFS\b/g, " ");
}
export function hasShellInjection(command) {
    if (!command)
        return false;
    return SHELL_INJECTION_PATTERNS.some((re) => re.test(command));
}
