import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { Data, Effect } from "effect";
import { readResolvedTiersEffect, parseTierReference, splitThinkingSuffix } from "../hpl-model-tiers/resolved.js";
export class HerdrError extends Data.TaggedError("HerdrError") {
}
export const defaultSpawn = spawnSync;
/** 同步 herdr 调用的兜底超时：server 卡住时不无限阻塞 pi 事件循环 */
const SPAWN_TIMEOUT_MS = 10_000;
export function herdrEnvAvailable() {
    return process.env.HERDR_ENV === "1";
}
function outputText(value) {
    return value === undefined ? "" : value.toString();
}
function parseJson(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return undefined;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start < 0 || end <= start)
            return undefined;
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        }
        catch {
            return undefined;
        }
    }
}
function isHerdrNotFound(error) {
    // herdr CLI 对不存在的 pane/agent 报 exit 1，stderr 是 {"error":{"code":"pane_not_found"}} 形 JSON
    const parsed = parseJson(error instanceof Error ? error.message : String(error));
    const code = parsed?.error?.code;
    return code === "pane_not_found" || code === "agent_not_found";
}
function warnHerdrFailure(args, error) {
    console.warn(`[hpl-orchestra] herdr ${args.join(" ")} 失败：${error instanceof Error ? error.message : String(error)}`);
}
function runJsonRaw(args, spawn) {
    return Effect.try({
        try: () => {
            const bin = process.env.HERDR_BIN_PATH ?? "herdr";
            const result = spawn(bin, args, { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" });
            if (result.error)
                throw result.error;
            if (result.status !== 0) {
                throw new HerdrError({ message: outputText(result.stderr) || `herdr exited with status ${result.status}` });
            }
            const parsed = parseJson(outputText(result.stdout));
            if (parsed === undefined)
                throw new HerdrError({ message: "herdr returned invalid JSON" });
            return parsed;
        },
        catch: (error) => error,
    });
}
function runTextRaw(args, spawn, timeoutMs) {
    return Effect.try({
        try: () => {
            const bin = process.env.HERDR_BIN_PATH ?? "herdr";
            const result = spawn(bin, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
            if (result.error)
                throw result.error;
            if (result.status !== 0) {
                throw new HerdrError({ message: outputText(result.stderr) || `herdr exited with status ${result.status}` });
            }
            return outputText(result.stdout);
        },
        catch: (error) => error,
    });
}
function runJsonEffect(args, spawn = defaultSpawn) {
    return Effect.catchAll(runJsonRaw(args, spawn), (error) => Effect.sync(() => {
        // pane/agent 消失是常态（orchestrator 直接 pane close / 用户动手），不是故障，不刷屏
        if (!isHerdrNotFound(error))
            warnHerdrFailure(args, error);
        return undefined;
    }));
}
function runTextEffect(args, spawn = defaultSpawn, timeoutMs) {
    return Effect.catchAll(runTextRaw(args, spawn, timeoutMs), (error) => Effect.sync(() => {
        if (!isHerdrNotFound(error))
            warnHerdrFailure(args, error);
        return undefined;
    }));
}
function runCommandEffect(args, spawn = defaultSpawn, timeoutMs) {
    return Effect.map(runTextEffect(args, spawn, timeoutMs), (text) => text !== undefined);
}
function findRecord(value, predicate) {
    if (!value || typeof value !== "object")
        return undefined;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findRecord(item, predicate);
            if (found)
                return found;
        }
        return undefined;
    }
    const record = value;
    if (predicate(record))
        return record;
    for (const child of Object.values(record)) {
        const found = findRecord(child, predicate);
        if (found)
            return found;
    }
    return undefined;
}
function parsePaneRecord(raw) {
    const pane = findRecord(raw, (record) => typeof record.pane_id === "string")
        ?? findRecord(raw, (record) => typeof record.id === "string" && ("status" in record || "state" in record));
    if (!pane)
        return undefined;
    const id = typeof pane.pane_id === "string" ? pane.pane_id : String(pane.id);
    const status = typeof pane.status === "string" ? pane.status : undefined;
    const agent = typeof pane.agent === "string" ? pane.agent : undefined;
    const label = typeof pane.label === "string" && pane.label.length > 0 ? pane.label : undefined;
    return { paneId: id, status, ...(agent ? { agent } : {}), ...(label ? { label } : {}) };
}
function paneLookup(paneId, spawn) {
    return Effect.matchEffect(runJsonRaw(["pane", "get", paneId], spawn), {
        onSuccess: (raw) => Effect.succeed(parsePaneRecord(raw)),
        onFailure: (error) => isHerdrNotFound(error)
            ? Effect.succeed("missing")
            : Effect.sync(() => {
                warnHerdrFailure(["pane", "get", paneId], error);
                return undefined;
            }),
    });
}
export function paneGet(paneId, spawn = defaultSpawn) {
    return Effect.map(paneLookup(paneId, spawn), (lookup) => (lookup === "missing" ? undefined : lookup));
}
/** 给 pane 打/换 herdr 标签（显示在 pane 边框上，用于分辨角色） */
export function paneRename(paneId, label, spawn = defaultSpawn) {
    return runCommandEffect(["pane", "rename", paneId, label], spawn);
}
/**
 * pane 里是否还有前台进程（跑在 shell 之上的 agent）。agent 字段尚未上报的启动窗口
 * 只能靠这个信号：
 * pi 已经在跑 → 前台进程不是 shell → true；pi 已崩、只剩 shell 提示符 → false。
 */
export function paneForegroundBusy(paneId, spawn = defaultSpawn) {
    return Effect.map(runJsonEffect(["pane", "process-info", "--pane", paneId], spawn), (raw) => {
        const info = findRecord(raw, (record) => "shell_pid" in record || "foreground_processes" in record);
        if (!info)
            return false;
        const shellPid = typeof info.shell_pid === "number" ? info.shell_pid : undefined;
        const foreground = info.foreground_processes;
        if (Array.isArray(foreground) && foreground.length > 0) {
            return foreground.some((entry) => {
                if (!entry || typeof entry !== "object")
                    return false;
                const pid = entry.pid;
                return shellPid === undefined || (typeof pid === "number" && pid !== shellPid);
            });
        }
        const pgid = typeof info.foreground_process_group_id === "number" ? info.foreground_process_group_id : undefined;
        return pgid !== undefined && shellPid !== undefined && pgid !== shellPid;
    });
}
export function panePresence(paneId, spawn = defaultSpawn) {
    return Effect.gen(function* () {
        const lookup = yield* paneLookup(paneId, spawn);
        if (lookup === "missing")
            return { status: "missing" };
        if (!lookup)
            return { status: "unknown" };
        if (lookup.agent !== undefined)
            return { status: "alive", pane: lookup };
        return (yield* paneForegroundBusy(paneId, spawn))
            ? { status: "alive", pane: lookup }
            : { status: "unknown" };
    });
}
/**
 * 角色 pane 的存活判定：pane 在，且里面还有 agent。
 * 只看 pane 存不存在会把「pi 崩了、只剩 shell」误判为健康——主 agent 会照旧往空 shell 派发。
 */
export function paneAgentAlive(paneId, spawn = defaultSpawn) {
    return Effect.map(panePresence(paneId, spawn), (presence) => presence.status === "alive");
}
/** herdr api schema 的 AgentInfo 字段是 agent_status（无 status/state）；
 *  同时按 pane_id 匹配，防止 findRecord 命中嵌套的其它记录。 */
function agentRecord(raw, paneId) {
    return findRecord(raw, (record) => typeof record.agent_status === "string" && record.pane_id === paneId);
}
function normalizeAgentStatus(rawStatus) {
    if (typeof rawStatus !== "string")
        return "unknown";
    const normalized = rawStatus.toLowerCase();
    if (normalized === "idle")
        return "idle";
    if (normalized === "working" || normalized === "running")
        return "working";
    if (normalized === "blocked")
        return "blocked";
    if (normalized === "done" || normalized === "completed" || normalized === "complete")
        return "done";
    return "unknown";
}
export function agentStateWithSeq(paneId, spawn = defaultSpawn) {
    return Effect.map(runJsonEffect(["agent", "get", paneId], spawn), (raw) => {
        const agent = agentRecord(raw, paneId);
        return {
            status: normalizeAgentStatus(agent?.agent_status),
            seq: typeof agent?.state_change_seq === "number" ? agent.state_change_seq : undefined,
        };
    });
}
export function agentGet(paneId, spawn = defaultSpawn) {
    return Effect.map(agentStateWithSeq(paneId, spawn), (snapshot) => snapshot.status);
}
export function paneSplit(cwd, spawn = defaultSpawn, envArgs = [], options = {}) {
    // 默认 --current 固定到调用面板（herdr skill 要求，不依赖对端聚焦面板）；
    // 指定 target 时改为在目标 pane 上切（布局决定了角色 pane 要叠在右列）
    const anchor = options.target ? ["--pane", options.target] : ["--current"];
    return Effect.map(runJsonEffect(["pane", "split", ...anchor, "--direction", options.direction ?? "right", ...envArgs, "--cwd", cwd, "--no-focus"], spawn), (raw) => {
        const pane = findRecord(raw, (record) => typeof record.pane_id === "string");
        return typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
    });
}
/** 同 tab 各 pane 的显示宽度（`herdr pane layout`）；用于判断右列还能不能塞下新面板 */
export function paneWidths(spawn = defaultSpawn) {
    return Effect.map(runJsonEffect(["pane", "layout"], spawn), (raw) => {
        const widths = new Map();
        const layout = findRecord(raw, (record) => Array.isArray(record.panes));
        const panes = layout?.panes;
        if (!Array.isArray(panes))
            return widths;
        for (const pane of panes) {
            if (!pane || typeof pane !== "object")
                continue;
            const record = pane;
            const rect = record.rect;
            if (typeof record.pane_id === "string" && rect && typeof rect.width === "number") {
                widths.set(record.pane_id, rect.width);
            }
        }
        return widths;
    });
}
export function paneRun(paneId, command, spawn = defaultSpawn) {
    return runCommandEffect(["pane", "run", paneId, command], spawn, SPAWN_TIMEOUT_MS);
}
/**
 * pane 当前屏文本（agent 状态判定用）。herdr pane read 只输出纯文本，无 JSON 外壳；
 * 读取失败返回 undefined（调用方按「采样失败」保守处理）。
 */
export function paneRead(paneId, spawn = defaultSpawn, options = {}) {
    const args = ["pane", "read", paneId, "--source", options.source ?? "visible", "--lines", String(options.lines ?? 40)];
    return runTextEffect(args, spawn, SPAWN_TIMEOUT_MS);
}
/**
 * 向 pane 注入按键。走 pane 级 CLI：自定义 agent 类型（如 hapi）下
 * `herdr agent send-keys` 会以 agent_not_ready 拒绝，pane 级始终可用。
 */
export function agentSendKeys(paneId, keys, spawn = defaultSpawn) {
    return runCommandEffect(["pane", "send-keys", paneId, ...keys], spawn);
}
/** 向 pane 注入文本（不提交）；派发时配合 agentSendKeys(["enter"]) 完成 */
export function paneSendText(paneId, text, spawn = defaultSpawn) {
    return runCommandEffect(["pane", "send-text", paneId, text], spawn);
}
export function agentPrompt(paneId, text, spawn = defaultSpawn) {
    // 派发 = 输入文本 + 回车提交；hapi 是自定义 agent 类型，herdr agent prompt 不认。
    // 文本不落地时（管道/转义问题）不提交，避免把半句话发给模型。
    return Effect.flatMap(paneSendText(paneId, text, spawn), (sent) => sent ? agentSendKeys(paneId, ["enter"], spawn) : Effect.succeed(false));
}
function shellArg(value) {
    return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
/**
 * hapilon 自身入口的绝对路径。扩展跑在 pi 子进程里，process.argv[1] 是
 * pi 的 cli.js 而非 hapilon 入口，因此入口路径由 startup.ts
 * 经 HAPILON_CLI_PATH 注入；无值时降级 argv[1] 并告警。
 */
export function hapilonCliPath() {
    const injected = process.env.HAPILON_CLI_PATH;
    if (injected && isAbsolute(injected))
        return injected;
    const script = process.argv[1] && isAbsolute(process.argv[1])
        ? process.argv[1]
        : resolve(process.cwd(), process.argv[1] ?? "");
    if (injected)
        return resolve(process.cwd(), injected);
    console.warn("[hpl-orchestra] HAPILON_CLI_PATH 未注入，降级用 argv[1]（可能不是 hapilon 入口）");
    return script;
}
export function buildPaneRunCommand(role, model, promptFile, tasksPath) {
    const command = [process.execPath, shellArg(hapilonCliPath() ?? "UNKNOWN_HAPILON_CLI")];
    // role 随命令行走（hapilon 入口把 --team-role 转成 pi 子进程自身 env），
    // 不用 pane split --env：那会把 role 永久留进 pane shell，人工在该
    // shell 重启会被静默变回角色面板。
    if (role)
        command.push("--team-role", shellArg(role));
    // 任务列表路径同理走命令行：每个角色 pane 一份自己的 pi-tasks 文件（PI_TASKS）。
    if (role && tasksPath)
        command.push("--team-tasks", shellArg(tasksPath));
    if (promptFile)
        command.push("--team-role-prompt-file", shellArg(promptFile));
    if (model)
        command.push("--model", shellArg(model));
    return command.join(" ");
}
/** pane split 仅注入配置（HAPILON_HOME）；身份类变量一律走 paneRun 命令行。 */
export function paneSplitEnvArgs() {
    const home = process.env.HAPILON_HOME;
    return home ? ["--env", `HAPILON_HOME=${home}`] : [];
}
const TIER_ORDER = ["opus", "sonnet", "haiku"];
function readResolvedTierModelsSafely() {
    return Effect.runSync(readResolvedTiersEffect);
}
/** 拼出 spawn 用的模型串：条目带 thinking 时追加 :level（pi 原生解析）。 */
function modelSpec(model) {
    return model.thinking ? `${model.provider}/${model.id}:${model.thinking}` : `${model.provider}/${model.id}`;
}
export function resolveTierModelByTier(tier) {
    const first = readResolvedTierModelsSafely()[tier][0];
    return first ? modelSpec(first) : undefined;
}
function modelKey(model) {
    return `${model.provider}/${model.id}`;
}
/** 首个非空档位的首选模型（opus → sonnet → haiku），全空时 undefined。 */
function fallbackModel(tiers) {
    for (const tier of TIER_ORDER) {
        const first = tiers[tier][0];
        if (first)
            return modelSpec(first);
    }
    return undefined;
}
function warnAndFallback(tiers, reason) {
    const fallback = fallbackModel(tiers);
    console.warn(`[hpl-orchestra] ${reason}，回落 ${fallback ?? "pi 默认模型"}`);
    return fallback;
}
/**
 * roles.<role>.model 在 spawn 时现解析：tier:<name>[<index>] 查当前档位表；
 * 具体 provider/id 命中任一档位即原样使用；过期 id、拼写错误、非法/越界指代
 * 回落到首个非空档位的首选。使创建时写死的模型名自动跟上档位配置变更。
 */
export function resolveRoleModel(spec, tiers = readResolvedTierModelsSafely()) {
    const wanted = spec?.trim();
    if (!wanted)
        return undefined;
    const reference = parseTierReference(wanted);
    if (reference) {
        const model = tiers[reference.tier][reference.index];
        if (model)
            return modelSpec(model);
        return warnAndFallback(tiers, `模型指代 ${wanted} 解析失败（${reference.tier} 档共 ${tiers[reference.tier].length} 个模型）`);
    }
    if (wanted.startsWith("tier:")) {
        return warnAndFallback(tiers, `模型指代 ${wanted} 格式非法（应为 tier:<opus|sonnet|haiku>[<index>]）`);
    }
    // 具体 id 可自带 :thinking 后缀；比对剥后缀后的裸 id，档位表中的 thinking 生效。
    const bare = splitThinkingSuffix(wanted).pattern;
    for (const tier of TIER_ORDER) {
        const model = tiers[tier].find((m) => modelKey(m) === bare);
        if (model)
            return modelSpec(model);
    }
    return warnAndFallback(tiers, `模型 ${wanted} 不在任何档位（可能已过期或拼写错误）`);
}
/** 为讨论成员优先挑选与主面板不同 provider 的 opus 模型。 */
export function resolveDiscussantModel(ownerProvider) {
    const models = readResolvedTierModelsSafely().opus;
    if (models.length === 0)
        return undefined;
    const heterogeneous = models.filter((model) => model.provider !== ownerProvider);
    const selected = heterogeneous[0] ?? models[1] ?? models[0];
    return modelSpec(selected);
}
