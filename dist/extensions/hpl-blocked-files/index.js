/**
 * hpl-blocked-files — 禁止读取/检索指定 agent 指令文件（默认 CLAUDE.md、AGENTS.md）
 *
 * 背景：hapi 已不把这些文件加载进上下文，但文件还在项目里，read/搜索/bash
 * 仍能碰到内容。本扩展在两个层面封死：
 *   tool_call   — read 路径命中 → 硬 block；bash/powershell 命令点名 → 硬 block；
 *                 带 exclude 入参的搜索工具（ffgrep/fffind 等）原地注入排除项
 *   tool_result — 工具文本输出里的禁文件路径行与 rg 命中行按行过滤，
 *                 兜住 pi 内置 grep/find（无 exclude 入参）与 ls
 *
 * 名单管理：/block 命令维护追加名单，持久化到 <HAPILON_HOME>/blocked-files.json。
 * 默认两项是代码常量，不可删除。匹配双语义：basename 传播（登记任一路径，
 * 所有同名文件都拦，堵 bash 相对路径引用）+ 精确路径（resolve + realpath，
 * 命中 symlink/.. 归一后的登记条目）。
 *
 * ponytail: bash 通配符读取（cat *.md）不点名文件、输出是纯文本，拦不住；
 * 出现真实泄漏案例再考虑在 bash 输出层做内容指纹比对。
 */
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";
import { pickFromList } from "../../shared/list-picker.js";
import { argumentCompletions } from "../../shared/argument-completion.js";
import { readBlockedFiles, saveBlockedFiles } from "./config.js";
/** 默认名单：代码常量，永远生效，不可通过 /block 删除 */
export const DEFAULT_BLOCKED_FILES = ["CLAUDE.md", "AGENTS.md"];
// ─── 运行时名单与匹配器 ─────────────────────────────────────────────
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const expandTilde = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
let extraEntries = [];
let extraNames = new Set();
let extraPaths = new Set();
let matchers = rebuildMatchers();
function rebuildMatchers() {
    const names = [...DEFAULT_BLOCKED_FILES, ...extraEntries.map((p) => basename(p))];
    const alternation = names.map(escapeRegExp).join("|");
    return {
        // 纯路径行：行尾是禁文件名，前面是路径分隔符或空白（覆盖 find/ls 路径行与 ls -la）
        pathLine: new RegExp(`(?:^|[\\\\/\\s])(?:${alternation})$`, "i"),
        // rg/grep 命中行：路径段后跟 :行号 或 -行号（上下文行）
        hitLine: new RegExp(`(?:^|[\\\\/])(?:${alternation})[:\\-]\\d`, "i"),
        // bash/powershell 命令点名禁文件。大小写不敏感：macOS/Windows 文件系统不区分大小写
        command: new RegExp(`\\b(?:${alternation})\\b`, "i"),
    };
}
/** 覆盖运行时追加名单（启动加载与 /block 命令共用入口） */
export function setExtraBlockedEntries(entries) {
    extraEntries = [...entries];
    extraNames = new Set(extraEntries.map((p) => basename(p).toLowerCase()));
    extraPaths = new Set(extraEntries.map((p) => normalize(p)));
    matchers = rebuildMatchers();
}
export function getExtraBlockedEntries() {
    return [...extraEntries];
}
/** read 的 path 是否命中禁文件（basename 传播或精确路径）；命中返回展示名 */
export function matchBlockedReadPath(p, cwd = process.cwd()) {
    if (!p)
        return null;
    const name = basename(p);
    const def = DEFAULT_BLOCKED_FILES.find((n) => n.toLowerCase() === name.toLowerCase());
    if (def)
        return def;
    if (extraNames.has(name.toLowerCase()))
        return name;
    // 精确路径维度：symlink/.. 归一后命中登记条目。文件不存在时 realpath 抛错，
    // basename 已查过，静默不命中（read 本就会因文件不存在失败）。
    try {
        if (extraPaths.has(normalize(realpathSync(resolve(cwd, expandTilde(p))))))
            return name;
    }
    catch {
        // fallthrough
    }
    return null;
}
/** 命令字符串是否点名禁文件；命中返回命中的名字 */
export function matchBlockedCommand(command) {
    const m = command.match(matchers.command);
    return m ? m[0] : null;
}
/** 输出行是否引用禁文件（路径行或 rg 命中行） */
export function matchBlockedPathLine(line) {
    const t = line.trim();
    return matchers.pathLine.test(t) || matchers.hitLine.test(t);
}
/** 给带 exclude 入参的搜索工具原地追加排除项（fff 系列接受 string | string[]） */
export function injectExclude(input) {
    const names = [...DEFAULT_BLOCKED_FILES, ...extraEntries.map((p) => basename(p))];
    const cur = input.exclude;
    if (typeof cur === "string")
        input.exclude = `${cur},${names.join(",")}`;
    else if (Array.isArray(cur))
        input.exclude = [...cur, ...names];
    else
        input.exclude = names;
}
/** 按行过滤工具文本输出 */
export function filterBlockedLines(text) {
    const lines = text.split("\n");
    const kept = lines.filter((l) => !matchBlockedPathLine(l));
    return { text: kept.join("\n"), removed: lines.length - kept.length };
}
const denyReason = (name) => `🚫 ${name} 是被禁止访问的文件（其它 agent 工具的指令文件），禁止读取、检索或列出。请不涉及该文件继续当前任务。`;
export function parseBlockArgs(argsStr) {
    const arg = argsStr.trim();
    if (!arg || arg === "list")
        return { kind: "list" };
    const isRemove = arg === "remove" || arg.startsWith("remove ");
    const isAdd = arg === "add" || arg.startsWith("add ");
    if (!isRemove && !isAdd)
        return { kind: "add", paths: arg.split(/\s+/).filter(Boolean) };
    const rest = arg.replace(/^(remove|add)\s*/, "").split(/\s+/).filter(Boolean);
    if (rest.length === 0)
        return { kind: "usage" };
    return isRemove ? { kind: "remove", paths: rest } : { kind: "add", paths: rest };
}
export function validateAddPath(raw, home) {
    const expanded = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
    if (!isAbsolute(expanded))
        return { ok: false, reason: `${raw} 不是绝对路径（支持 / 开头或 ~）` };
    const normalized = normalize(expanded);
    // 登记侧与查询侧（matchBlockedReadPath 的 realpathSync）同口径：存在的文件
    // 归一到真实路径，否则 macOS /var、/tmp 这类 symlink 会让精确匹配永远脱靶。
    try {
        return { ok: true, resolved: realpathSync(normalized) };
    }
    catch {
        return { ok: true, resolved: normalized }; // 不存在的路径保留归一化形式
    }
}
// ─── /block 命令 — 交互流程 ─────────────────────────────────────────
function addEntries(ctx, raws) {
    // 命令反馈走 ctx.ui（会话通知而非状态行），与 /allow 一致
    const say = (msg, level = "info") => ctx.ui?.notify(msg, level);
    const accepted = [];
    const problems = [];
    const knownNames = new Set([
        ...DEFAULT_BLOCKED_FILES.map((n) => n.toLowerCase()),
        ...extraEntries.map((p) => basename(p).toLowerCase()),
    ]);
    for (const raw of raws) {
        const v = validateAddPath(raw, homedir());
        if (!v.ok) {
            problems.push(v.reason);
            continue;
        }
        if (extraPaths.has(v.resolved)) {
            problems.push(`${raw} 已在名单中`);
            continue;
        }
        const base = basename(v.resolved).toLowerCase();
        if (knownNames.has(base)) {
            problems.push(`${raw} 的文件名 ${basename(v.resolved)} 已在拦截名单中（basename 传播下所有同名文件都已拦截），无需重复添加`);
            continue;
        }
        accepted.push(v.resolved);
        knownNames.add(base);
    }
    if (accepted.length > 0) {
        setExtraBlockedEntries([...extraEntries, ...accepted]);
        if (!saveBlockedFiles(getExtraBlockedEntries())) {
            say("[hpl-blocked-files] 内存名单已生效，但写盘失败，重启后丢失", "warning");
        }
        say(`已追加 ${accepted.length} 条禁读条目：\n${accepted.join("\n")}`);
    }
    if (problems.length > 0)
        say(problems.join("\n"), "warning");
}
function removeEntries(ctx, raws) {
    const say = (msg, level = "info") => ctx.ui?.notify(msg, level);
    const problems = [];
    const removed = [];
    for (const raw of raws) {
        const expanded = normalize(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
        const def = DEFAULT_BLOCKED_FILES.find((n) => n.toLowerCase() === basename(expanded).toLowerCase());
        if (def) {
            problems.push(`${def} 是默认名单，不可删除`);
            continue;
        }
        const hit = extraEntries.find((p) => p === expanded || normalize(p) === expanded || basename(p) === basename(expanded));
        if (!hit) {
            problems.push(`${raw} 不在追加名单中（/block 查看名单）`);
            continue;
        }
        setExtraBlockedEntries(extraEntries.filter((p) => p !== hit));
        removed.push(hit);
    }
    if (removed.length > 0) {
        if (!saveBlockedFiles(getExtraBlockedEntries())) {
            say("[hpl-blocked-files] 内存名单已生效，但写盘失败，重启后恢复", "warning");
        }
        say(`已删除 ${removed.length} 条：\n${removed.join("\n")}`);
    }
    if (problems.length > 0)
        say(problems.join("\n"), "warning");
}
async function interactiveList(ctx) {
    // 本地别名：命令上下文里统一走 ctx.ui（与 /allow 一致，非交互时静默）
    const say = (msg, level = "info") => ctx.ui?.notify(msg, level);
    while (true) {
        const extras = getExtraBlockedEntries();
        if (extras.length === 0) {
            say(`追加名单为空。默认拦截 ${DEFAULT_BLOCKED_FILES.join("、")}（不可删除）。用 /block <绝对路径> 追加。`);
            return;
        }
        const selected = await pickFromList(ctx, `已屏蔽文件（默认：${DEFAULT_BLOCKED_FILES.join("、")}，不可删除）\n选中追加条目进入删除：`, extras, "取消");
        if (selected === undefined || selected === null)
            return;
        const confirmed = await ctx.ui.select(`确认从名单删除 ${selected}？`, ["删除", "取消"]);
        if (confirmed !== "删除")
            continue;
        removeEntries(ctx, [selected]);
    }
}
// ─── 事件处理（抽出便于单测；default export 仅是注册壳）────────────
export async function handleToolCallEvent(event, cwd = process.cwd()) {
    if (isToolCallEventType("read", event)) {
        const hit = matchBlockedReadPath(event.input.path, cwd);
        if (hit) {
            notify(`[hpl-blocked-files] 已拦截 read：${event.input.path}`);
            return { block: true, reason: denyReason(hit) };
        }
        return;
    }
    if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
        const hit = matchBlockedCommand(event.input.command ?? "");
        if (hit) {
            notify(`[hpl-blocked-files] 已拦截命令（引用 ${hit}）`);
            return { block: true, reason: denyReason(hit) };
        }
        return;
    }
    if (EXCLUDE_TOOLS.has(event.toolName))
        injectExclude(event.input);
}
export async function handleToolResultEvent(event) {
    let removed = 0;
    const content = event.content.map((c) => {
        if (c.type !== "text")
            return c;
        const r = filterBlockedLines(c.text);
        removed += r.removed;
        return r.removed > 0 ? { ...c, text: r.text } : c;
    });
    if (removed > 0) {
        notify(`[hpl-blocked-files] 已从 ${event.toolName} 结果过滤 ${removed} 行（禁文件相关）`);
        return { content };
    }
    return;
}
// 支持 exclude 入参的搜索工具（@ff-labs/pi-fff 注册的自定义工具；exclude 是
// 可选字段，模型没传时 input 上无此 key，只能按工具名判断）。
// pi 内置 grep/find 无 exclude 参数，不动入参，靠 tool_result 过滤兜底。
const EXCLUDE_TOOLS = new Set(["ffgrep", "fffind", "ln", "fff-multi-grep"]);
export default function (pi) {
    setExtraBlockedEntries(readBlockedFiles());
    // 显式单参包装：handleToolCallEvent 的 cwd 参数不进 pi 的 handler 签名
    pi.on("tool_call", (event) => handleToolCallEvent(event));
    pi.on("tool_result", handleToolResultEvent);
    pi.registerCommand("block", {
        description: "管理禁读文件名单。用法：/block <绝对路径>... | remove <路径>... | list（默认打开交互列表）",
        getArgumentCompletions: (query) => argumentCompletions([
            { value: "remove ", label: "remove — 删除条目" },
            { value: "list", label: "list — 交互列表" },
        ], query),
        handler: async (argsStr, ctx) => {
            const args = parseBlockArgs(argsStr);
            switch (args.kind) {
                case "list":
                    await interactiveList(ctx);
                    return;
                case "add":
                    addEntries(ctx, args.paths);
                    return;
                case "remove":
                    removeEntries(ctx, args.paths);
                    return;
                case "usage":
                    ctx.ui?.notify("用法：/block <绝对路径>... | remove <路径>... | list", "warning");
                    return;
            }
        },
    });
}
