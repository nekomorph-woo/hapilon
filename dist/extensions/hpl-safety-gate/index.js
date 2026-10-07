/**
 * hpl-safety-gate/index.ts — 危险命令拦截扩展
 *
 * 通过 pi.on("tool_call", ...) 拦截 bash 工具调用：
 *   BLOCK — 高危直接阻止
 *   CONFIRM — 中危 4 选项弹框
 *   ALLOW — 正常放行
 *
 * 用法: hapilon 启动时自动加载（discoverExtensions() → -e 注入）
 * 拦截点: pi 的 tool_call 事件（能读到工具入参，也就能放行/改写）
 */
import { notify } from "../notify.js";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { argumentCompletions } from "../../shared/argument-completion.js";
import { agentDir, hapilonHome } from "../../config/hapilon-home.js";
import { classifyWithLabel } from "./classifier.js";
import { checkSandboxWrite } from "./sandbox-allow.js";
import { describeScenario, judgeCommand, recentAllows, readGateAutoConfig, setGateAutoEnabled, } from "./auto-judge.js";
import { deriveAllowPattern } from "./derive-allow.js";
import { hasSensitiveReadArg, sensitiveReadLabels, splitCommandSegments } from "./sensitive-args.js";
import { requestConfirm } from "../hpl-protected-paths/confirm.js";
import { addTrust, isCommandTrusted, initProjectTrust } from "../../config/trust-store.js";
// subagent 会话探针（分级依赖）：与 hpl-protected-paths 同款。
// bash 读敏感文件时 subagent block、主会话 confirm——与 read 分级一致。
let subagentProbe;
import("@tintinweb/pi-subagents/dist/child-context.js")
    .then((mod) => {
    subagentProbe = mod.inChildSessionContext;
})
    .catch(() => {
    notify("[hpl-safety-gate] subagent 探针不可得，bash 敏感读取将走 confirm 流程");
});
// ── 项目申报沙箱根：.hapilon/config.json 的 sandboxPaths（绝对路径数组）──
// 项目自有工作区常在仓库外（b31 的 ~/.b31-bd2 fixture 目录），申报后按沙箱内对待。
// cwd → roots 缓存，避免每次判定读盘。
const projectRootsCache = new Map();
export function projectSandboxRoots(cwd) {
    const cached = projectRootsCache.get(cwd);
    if (cached)
        return cached;
    let roots = [];
    try {
        const config = JSON.parse(readFileSync(join(cwd, ".hapilon", "config.json"), "utf8"));
        if (Array.isArray(config.sandboxPaths)) {
            roots = config.sandboxPaths.filter((p) => typeof p === "string" && p.startsWith("/"));
        }
    }
    catch {
        // 无配置或解析失败 → 无项目根（fail-closed）
    }
    projectRootsCache.set(cwd, roots);
    return roots;
}
// ── git 事实：写目标是否受 git 跟踪（可恢复性判定不再靠模型猜）──
export function gitTrackedSummary(targets, cwd) {
    const paths = [...new Set(targets.map((t) => t.resolved.replace(/^~/, homedir())))]
        .filter((p) => !p.includes("*") && !p.includes("\u0002"))
        .slice(0, 5);
    if (paths.length === 0)
        return "";
    let repoRoot = "";
    try {
        repoRoot = realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
        }).trim());
    }
    catch {
        return "cwd 不是 git 仓库";
    }
    const realPath = (p) => {
        try {
            return realpathSync(p);
        }
        catch {
            return p; // 路径向未存在（待写入的新文件）—— realpath 不了，用原样比对
        }
    };
    const parts = [];
    for (const p of paths) {
        const rp = realPath(p);
        const inside = rp === repoRoot || rp.startsWith(`${repoRoot}/`);
        if (!inside) {
            parts.push(`${p}=仓库外`);
            continue;
        }
        try {
            const out = execFileSync("git", ["-C", cwd, "ls-files", "--", rp], {
                encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
            }).trim();
            parts.push(`${p}=${out.length > 0 ? "git 跟踪（可恢复）" : "未跟踪（删改不可恢复）"}`);
        }
        catch {
            parts.push(`${p}=无法查询`);
        }
    }
    return parts.join("；");
}
function inSubagentSession() {
    return subagentProbe ? subagentProbe() : false;
}
// 信任匹配逐段（isCommandTrusted）：条目如 `git push*` 命中复合命令的任一段即放行。
function bashTrusted(normalized, cwd) {
    return isCommandTrusted("bash", normalized, cwd);
}
// ── skill 脚本豁免：hapi 自带/安装的技能脚本段不参与风险分级 ──
// 技能脚本是 agent 工具链的一部分（imp-case 的 case_tools.py 等），
// 它们本身不该把整条链拉进 confirm；链上其它危险段（sed -i 等）照常拦截。
const SCRIPT_INTERPRETERS = /^(?:python3?|node|deno|bun|tsx?|bash|sh|zsh|dash|ash)\b/;
function skillScriptRoots(cwd) {
    return [join(safeHapilonHome(), "agents", "skills"), join(cwd, ".hapilon", "agents", "skills")];
}
/** 段是「解释器直接执行 skill 目录下脚本」→ 豁免 */
export function isSkillScriptSegment(segment, cwd) {
    if (!SCRIPT_INTERPRETERS.test(segment))
        return false;
    const roots = skillScriptRoots(cwd);
    return roots.some((root) => segment.includes(`${root}/`));
}
/** 去掉豁免段后的命令（分类器只看不豁免的段；全豁免返回空串） */
export function stripSkillScriptSegments(command, cwd) {
    const kept = splitCommandSegments(command).filter((seg) => !isSkillScriptSegment(seg.trim(), cwd));
    return kept.join(" && ");
}
// 提示文本紧凑化：折叠空白（多行/正则命令不再断行爆宽），截 80 字符，超长补省略号
function compactCommand(command) {
    const oneLine = command.trim().replace(/\s+/g, " ");
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}
/** 审计 append-only；写失败只 warn 不阻塞主流程 */
export function appendGateAutoAudit(entry, filePath = join(agentDir(), "gate-auto.jsonl")) {
    try {
        appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    }
    catch (err) {
        notify(`[hpl-safety-gate] gate-auto 审计写入失败（不阻塞）: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function sandboxSummary(targets) {
    if (targets.length === 0)
        return "无写目标";
    return targets
        .map((t) => `${t.raw} → ${t.resolved}${t.note ? `（${t.note}）` : ""}`)
        .join("; ");
}
function gateAutoErrorReason(error) {
    return error._tag === "GateAutoTimeout"
        ? `判定超时（${error.timeoutMs}ms）`
        : error.message;
}
/** HAPILON_HOME 非法（相对路径）时退回默认，不让审计/沙箱判定炸掉主流程 */
function safeHapilonHome() {
    try {
        return hapilonHome();
    }
    catch {
        return join(homedir(), ".hapilon");
    }
}
export { classifyCommand, classifyWithLabel, hasShellInjection } from "./classifier.js";
export default function (pi) {
    // 加载时初始化项目信任缓存：本进程是 project trust 的消费方
    initProjectTrust(process.cwd());
    // Auto 模式会话级开关：--gate-auto 强制开启（settings gateAuto.enabled 亦可）
    pi.registerFlag("gate-auto", {
        type: "boolean",
        default: false,
        description: "会话级开启安全门 Auto 判定（confirm 级命令由沙箱规则/档位模型自动放行）",
    });
    // Auto 会话状态：配置 + 同命令判定缓存（会话级，session_start 重置）
    let gateAutoConfig;
    let verdictCache = new Map();
    // 行为滚动窗口：安全门亲历的近期 bash 命令（含被拦的），行为观察员的唯一信息源。
    // 记录的是「实际做了什么」而非 agent 自述——客观性来自信息源。
    let activityWindow = [];
    const ACTIVITY_WINDOW_SIZE = 12;
    pi.on("session_start", () => {
        gateAutoConfig = readGateAutoConfig();
        verdictCache = new Map();
        activityWindow = [];
    });
    // ─── /gate-auto-mode：Auto 判定开关（无对话框三态） ─────────────────
    const GATE_AUTO_MODE_USAGE = "用法：/gate-auto-mode [on|off]（不带参数查看状态）";
    pi.registerCommand("gate-auto-mode", {
        description: "查看/切换安全门 Auto 判定（写入 settings.json 的 gateAuto.enabled）",
        getArgumentCompletions: (query) => argumentCompletions([{ value: "on", label: "on" }, { value: "off", label: "off" }], query),
        handler: async (args, ctx) => {
            const arg = args.trim();
            if (gateAutoConfig === undefined)
                gateAutoConfig = readGateAutoConfig();
            if (arg !== "" && arg !== "on" && arg !== "off") {
                ctx.ui.notify(GATE_AUTO_MODE_USAGE, "error");
                return;
            }
            if (arg === "") {
                const settings = readGateAutoConfig();
                const flag = pi.getFlag("gate-auto") === true;
                ctx.ui.notify([
                    "安全门 Auto 判定",
                    `settings.json gateAuto.enabled：${settings.enabled ? "开启" : "关闭"}`,
                    `本会话实际生效：${gateAutoConfig.enabled || flag ? "开启" : "关闭"}${flag ? "（--gate-auto flag 强制开启）" : ""}`,
                    `判定模型：${gateAutoConfig.model}，超时 ${gateAutoConfig.timeoutMs}ms`,
                    `会话判定缓存：${verdictCache.size} 条`,
                ].join("\n"), "info");
                return;
            }
            // 先改内存：写盘失败也要本会话立即生效
            const enabled = arg === "on";
            gateAutoConfig.enabled = enabled;
            verdictCache.clear();
            const persisted = setGateAutoEnabled(enabled);
            const flagOverride = !enabled && pi.getFlag("gate-auto") === true;
            ctx.ui.notify([
                `安全门 Auto 判定已${enabled ? "开启" : "关闭"}（本会话立即生效）。`,
                persisted
                    ? `已写入 settings.json 的 gateAuto.enabled=${enabled}；其它已开 pane 要 /new 或重开会话才吃到新值。`
                    : "⚠️ settings.json 写入失败（原文件未动），仅本会话生效，持久化失败。",
                ...(flagOverride ? ["注意：本会话以 --gate-auto 启动，flag 仍强制开启 Auto，需重启会话才能关闭。"] : []),
            ].join("\n"), persisted ? "info" : "warning");
        },
    });
    /** Auto 判定 + 审计；返回 true 表示已放行/已决，调用方直接返回；false 回落现状 */
    const runAutoGate = async (command, normalized, ruleLabel, ctx) => {
        if (gateAutoConfig === undefined)
            gateAutoConfig = readGateAutoConfig();
        const enabled = gateAutoConfig.enabled || pi.getFlag("gate-auto") === true;
        if (!enabled)
            return false;
        let scenario;
        const audit = (entry) => appendGateAutoAudit({ ts: new Date().toISOString(), cwd: ctx.cwd, command: normalized, ruleLabel, scenario, ...entry });
        // 1. 会话内缓存：沿用上次 verdict，不重复调模型
        const cached = verdictCache.get(normalized);
        if (cached) {
            if (cached.verdict === "allow") {
                audit({ layer: "cache", verdict: "allow", reason: cached.reason, model: "cache", outcome: "auto-allow" });
                return true;
            }
            audit({
                layer: "cache",
                verdict: cached.verdict,
                reason: cached.reason,
                model: "cache",
                outcome: ctx.hasUI ? "fallback-confirm" : "fallback-block",
            });
            return false;
        }
        // 2. 沙箱规则先行：破坏性命令词 + 全部写目标在沙箱集 → 免模型直接放行
        const sandbox = checkSandboxWrite(command, { cwd: ctx.cwd, home: safeHapilonHome(), projectRoots: projectSandboxRoots(ctx.cwd) });
        if (sandbox.allowed) {
            audit({ layer: "sandbox", verdict: "allow", reason: sandboxSummary(sandbox.targets), model: "sandbox", outcome: "auto-allow" });
            return true;
        }
        // 3. 行为观察员场景描述 + git 事实 + 先例检索（辅助信息；失败不阻塞判定）
        const startedAt = Date.now();
        const gitStatus = gitTrackedSummary(sandbox.targets, ctx.cwd);
        const scenarioResult = await Effect.runPromise(Effect.either(describeScenario({
            modelSpec: gateAutoConfig.model,
            timeoutMs: gateAutoConfig.timeoutMs,
            command,
            cwd: ctx.cwd,
            ruleLabel,
            sandboxSummary: sandboxSummary(sandbox.targets),
            gitStatus,
            activityWindow: activityWindow,
            available: ctx.modelRegistry.getAvailable(),
            complete: (model, request, options) => ctx.modelRegistry.complete(model, request, options),
        })));
        scenario = scenarioResult._tag === "Right" ? scenarioResult.right : undefined;
        const precedents = recentAllows(ruleLabel);
        // 4. 档位模型判定；超时/错误/不合法 → 按 unsure 回落现状
        const result = await Effect.runPromise(Effect.either(judgeCommand({
            modelSpec: gateAutoConfig.model,
            timeoutMs: gateAutoConfig.timeoutMs,
            command,
            cwd: ctx.cwd,
            ruleLabel,
            sandboxSummary: sandboxSummary(sandbox.targets),
            gitStatus,
            scenario,
            precedents,
            available: ctx.modelRegistry.getAvailable(),
            complete: (model, request, options) => ctx.modelRegistry.complete(model, request, options),
        })));
        const latencyMs = Date.now() - startedAt;
        if (result._tag === "Right") {
            const judgement = result.right;
            verdictCache.set(normalized, { verdict: judgement.verdict, reason: judgement.reason });
            if (judgement.verdict === "allow") {
                audit({ layer: "model", verdict: "allow", reason: judgement.reason, model: judgement.model ?? gateAutoConfig.model, latencyMs, outcome: "auto-allow" });
                return true;
            }
            audit({
                layer: "model",
                verdict: judgement.verdict,
                reason: judgement.reason,
                model: judgement.model ?? gateAutoConfig.model,
                latencyMs,
                outcome: ctx.hasUI ? "fallback-confirm" : "fallback-block",
            });
            return false;
        }
        audit({
            layer: "model",
            verdict: "unsure",
            reason: gateAutoErrorReason(result.left),
            model: gateAutoConfig.model,
            latencyMs,
            outcome: ctx.hasUI ? "fallback-confirm" : "fallback-block",
        });
        return false;
    };
    pi.on("tool_call", async (event, ctx) => {
        if (!isToolCallEventType("bash", event))
            return;
        const command = event.input.command;
        if (!command)
            return;
        // 标准化空白字符用于信任匹配
        const normalized = command.trim().replace(/\s+/g, " ");
        activityWindow.push(normalized.slice(0, 100));
        if (activityWindow.length > ACTIVITY_WINDOW_SIZE)
            activityWindow.shift();
        // 折叠后的单行命令（超长截断），所有 warn/reason 提示文本共用
        const shown = compactCommand(command);
        // 分类只看非豁免段：skill 脚本段（解释器直执行 ~/.hapilon*/agents/skills/
        // 或项目 .hapilon/agents/skills/ 下脚本）不参与风险分级，链上其它段照常拦。
        const gated = stripSkillScriptSegments(command, ctx.cwd);
        const { verdict, label } = classifyWithLabel(gated);
        if (verdict === "allow") {
            // 敏感文件 bash 读检测：危险命令规则放行后，
            // 参数命中 READ_CONFIRM 的命令进入分级拦截——
            // subagent 会话硬拦（read 同级），主会话走 confirm。
            if (hasSensitiveReadArg(command, ctx.cwd)) {
                const labels = sensitiveReadLabels(command, ctx.cwd).join("、");
                if (inSubagentSession()) {
                    notify(`[hpl-safety-gate] subagent 会话禁止读取敏感文件（${labels}）: ${shown}`);
                    return {
                        block: true,
                        reason: `🛡️ subagent 会话禁止读取敏感文件（${labels}）：secret 只该被应用运行时读取，agent 读取会进入 LLM 上下文与 transcript。请在主会话中操作，或使用白名单文件（.env.example）。`,
                    };
                }
                if (bashTrusted(normalized, ctx.cwd))
                    return;
                if (!ctx.hasUI) {
                    notify(`[hpl-safety-gate] 非交互模式下禁止读取敏感文件（${labels}）: ${shown}`);
                    return {
                        block: true,
                        reason: `🛡️ 非交互模式下禁止读取敏感文件（${labels}）：${shown}`,
                    };
                }
                const result = await requestConfirm(ctx, "⚠️ 敏感文件读取确认", `命令将读取敏感文件（${labels}）：\n\n> ${normalized.slice(0, 200)}\n\n是否仍然执行？`, { allowSuggestion: deriveAllowPattern(normalized) });
                if (result.status !== "approved") {
                    const reason = result.status === "unavailable"
                        ? `🛡️ 非交互模式下禁止读取敏感文件（${labels}）`
                        : `用户拒绝了敏感文件读取：${shown}`;
                    notify(`[hpl-safety-gate] ${reason}`);
                    return { block: true, reason };
                }
                try {
                    if (result.scope !== "once") {
                        addTrust("bash", result.allowPattern ?? normalized, result.scope, ctx.cwd);
                    }
                }
                catch (err) {
                    notify(`添加信任失败（不影响本次操作）: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            return;
        }
        if (verdict === "block") {
            // 拦截必须留痕（Make It Observable）
            notify(`[hpl-safety-gate] 危险命令已阻止: ${shown}`);
            return {
                block: true,
                reason: `🛡️ 危险命令已阻止：${shown}`,
            };
        }
        // confirm → 先查 trust（逐段匹配，复合命令的段级信任同样生效）
        if (bashTrusted(normalized, ctx.cwd))
            return;
        // Auto 模式：缓存 → 沙箱规则 → 模型判定先行接管 confirm 级（block 级永不放松）
        if (await runAutoGate(command, normalized, label, ctx))
            return;
        if (!ctx.hasUI) {
            // 拦截必须留痕（Make It Observable）
            notify(`[hpl-safety-gate] 非交互模式下拦截中危命令: ${shown}`);
            return {
                block: true,
                reason: `🛡️ 非交互模式下拦截中危命令：${shown}`,
            };
        }
        const result = await requestConfirm(ctx, "⚠️ 危险操作确认", `检测到潜在危险操作：\n\n> ${normalized.slice(0, 200)}\n\n是否仍然执行？`, { allowSuggestion: deriveAllowPattern(normalized) });
        if (result.status !== "approved") {
            const reason = result.status === "unavailable"
                ? `🛡️ 非交互模式下拦截中危命令：${shown}`
                : result.status === "error"
                    ? `🛡️ 确认对话框异常，已阻止：${shown}`
                    : `用户拒绝了此操作：${shown}`;
            // 拦截必须留痕（Make It Observable）
            notify(`[hpl-safety-gate] ${reason}`);
            return { block: true, reason };
        }
        try {
            if (result.scope !== "once") {
                addTrust("bash", result.allowPattern ?? normalized, result.scope, ctx.cwd);
            }
        }
        catch (err) {
            notify(`添加信任失败（不影响本次操作）: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
}
