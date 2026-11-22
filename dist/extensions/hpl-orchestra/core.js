/**
 * core.ts — herdr-core（hc）宿主专属传输层。
 *
 * 只在 core 宿主被调用（transport.ts 分流）；TUI 宿主走 herdr.ts，两条传输
 * 互不接触。地址是 hc 终端 id（如 `t7`），来自团队状态，不得指向无关终端。
 * 错误按 herdr.ts 同款惯例收口：pane/终端消失是常态不刷屏，其余 notify 警告。
 * 仅在 Core 明确拒绝重名时换一个名字重试。
 */
import { notify } from "../notify.js";
import { Data, Effect, Option, Schema } from "effect";
export class CoreError extends Data.TaggedError("CoreError") {
}
const SPAWN_TIMEOUT_MS = 10_000;
export function coreBin() {
    return process.env.HC_BIN_PATH ?? "hc";
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
function warnCoreFailure(args, error) {
    notify(`[hpl-orchestra] hc ${args.join(" ")} 失败：${error instanceof Error ? error.message : String(error)}`, "warning");
}
/** hc 对不存在终端的报错：stderr/文本含 not_found（如 terminal_not_found）即视为已关。 */
export function isCoreNotFound(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.includes("not_found");
}
export function runCoreRaw(args, spawn, timeoutMs = SPAWN_TIMEOUT_MS) {
    return Effect.try({
        try: () => {
            const result = spawn(coreBin(), args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
            if (result.error)
                throw result.error;
            if (result.status !== 0) {
                throw new CoreError({ message: outputText(result.stderr) || `hc exited with status ${result.status}` });
            }
            return outputText(result.stdout);
        },
        catch: (error) => error,
    });
}
/** 终端消失静默、其余失败告警并返回 undefined 的通用收口。 */
function runCoreQuiet(args, spawn, timeoutMs) {
    return Effect.catchAll(runCoreRaw(args, spawn, timeoutMs), (error) => Effect.sync(() => {
        if (!isCoreNotFound(error))
            warnCoreFailure(args, error);
        return undefined;
    }));
}
/** hc 终端记录的地址字段：实测 `hc run --bg --json` 返回 `.address`，无 terminal_id。 */
function addressOf(record) {
    for (const key of ["address", "terminal_id", "pane_id", "id"]) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0)
            return value;
    }
    return undefined;
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
/**
 * 宽容解析 `hc get <t> --json`：字段名随 hc 版本可能漂移，只认「终端 id +
 * 状态」的最小形状（terminal_id / pane_id / id 任一命中，status 原样带出）。
 * hc 的实际 JSON 形状由隔离探针核实；解析不出 id 视为查询失败。
 */
export function parseCoreTerminal(raw) {
    const record = findRecord(raw, (candidate) => addressOf(candidate) !== undefined);
    if (!record)
        return undefined;
    // hc 的标签在嵌套 labels.map（labels.label），顶层 label 字段不存在；
    // 只读顶层会永远拿不到，下游人工占有判定会误触发
    const labelsMap = record.labels && typeof record.labels === "object" && !Array.isArray(record.labels)
        ? record.labels
        : undefined;
    const rawLabel = record.label ?? labelsMap?.label;
    const label = typeof rawLabel === "string" && rawLabel.length > 0 ? rawLabel : undefined;
    const state = typeof record.state === "string" ? record.state : undefined;
    // status 双形态：对象（status.app / status.state）或字符串（工作状态词）
    let app;
    let workStatus;
    const status = record.status;
    if (status && typeof status === "object" && !Array.isArray(status)) {
        const statusRecord = status;
        if (typeof statusRecord.app === "string")
            app = statusRecord.app;
        if (typeof statusRecord.state === "string")
            workStatus = statusRecord.state;
    }
    else if (typeof status === "string" && status.length > 0) {
        workStatus = status;
    }
    const reportedMs = typeof record.reported === "number" ? record.reported : undefined;
    const createdMs = typeof record.created_ms === "number" ? record.created_ms : undefined;
    return {
        terminalId: addressOf(record),
        ...(state ? { state } : {}),
        ...(app ? { app } : {}),
        ...(workStatus ? { workStatus } : {}),
        ...(reportedMs !== undefined ? { reportedMs } : {}),
        ...(createdMs !== undefined ? { createdMs } : {}),
        ...(label ? { label } : {}),
    };
}
/** `hc run --bg --json` 输出 → 新终端 id；解析不出返回 undefined（调用方回收判定）。 */
export function parseCoreLaunch(raw) {
    const record = findRecord(raw, (candidate) => addressOf(candidate) !== undefined);
    return record ? addressOf(record) : undefined;
}
/** hc 状态词 → 共享 AgentStatus 词表（与 herdr 的 normalizeAgentStatus 同口径）。 */
export function normalizeCoreStatus(raw) {
    if (!raw)
        return "unknown";
    const normalized = raw.toLowerCase();
    if (normalized === "idle")
        return "idle";
    if (normalized === "working" || normalized === "running" || normalized === "busy")
        return "working";
    if (normalized === "blocked")
        return "blocked";
    if (normalized === "done" || normalized === "completed" || normalized === "complete" || normalized === "exited")
        return "done";
    return "unknown";
}
/**
 * core server 身份（`hc server status --json` 的 `.core.id`）：地址命名空间用。
 * 注意：跨 scratch 会话同一台机器可能给出相同 core.id——单靠它不能区分两套
 * socket；状态文件命名空间由 host.ts 组合 serverId 与 socket 线索，缺失时宁缺
 * 勿猜。解析不出返回 undefined。
 */
export function parseCoreServerId(raw) {
    const record = findRecord(raw, (candidate) => typeof candidate.id === "string" && candidate.id.length > 0);
    return record ? record.id : undefined;
}
export function coreServerId(spawn) {
    return Effect.map(runCoreQuiet(["server", "status", "--json"], spawn), (text) => text === undefined ? undefined : parseCoreServerId(parseJson(text)));
}
// ── 操作（transport.ts 消费） ─────────────────────────────────────
/** `hc get <t> --json`；解析不出记录返回 undefined。 */
export function coreTerminalGet(terminalId, spawn) {
    return Effect.map(runCoreQuiet(["get", terminalId, "--json"], spawn), (text) => (text === undefined ? undefined : parseCoreTerminal(parseJson(text))));
}
export function coreStatus(terminalId, spawn) {
    return Effect.map(coreTerminalGet(terminalId, spawn), (terminal) => normalizeCoreStatus(terminal?.workStatus));
}
/** `hc wait <t> --timeout <sec>`：core 宿主的收敛原语（agent 语义，等停止 working）。 */
export function coreWaitSettle(terminalId, timeoutSec, spawn) {
    // 超时由 hc wait 自管；spawn 兑底只防 hc 卡死，留 5s 余量
    return Effect.map(runCoreQuiet(["wait", terminalId, "--timeout", String(Math.ceil(timeoutSec))], spawn, timeoutSec * 1000 + 5_000), (text) => {
        const parsed = text === undefined
            ? undefined
            : parseJson(text);
        const status = typeof parsed?.status === "string" ? parsed.status : undefined;
        return {
            settled: parsed?.ended === true && normalizeCoreStatus(status) !== "working",
            status,
            reason: typeof parsed?.reason === "string" ? parsed.reason : undefined,
        };
    });
}
/** 终端生命周期已终结的判词：存活集合里不该再派发（陈旧地址的形态之一）。 */
export function coreStateIrreversible(state) {
    if (!state)
        return false;
    const normalized = state.toLowerCase();
    return normalized === "exited" || normalized === "finished" || normalized === "failed" || normalized === "dead";
}
/** 前台程序身份是否为我们拉起的 agent（hapi）。 */
export function isOurAgentApp(app) {
    return app !== undefined && app.toLowerCase().includes("hapi");
}
/**
 * `hc send` 结果判定的唯一口径：只有退出 0 **且** JSON 可解析才算 sent——
 * 退出码与解析不一致、或输出无法判读，一律 failed，绝不把模糊提交重解释成成功。
 * 非零输出里带 idle/blocked 字样才记 refused（状态守卫拒绝），其余失败。
 */
export function sendOutcome(exit, stdout, stderr) {
    if (exit === 0) {
        return parseJson(stdout) !== undefined ? "sent" : "failed";
    }
    const message = `${stderr}\n${stdout}`;
    return message.toLowerCase().includes("idle") || message.toLowerCase().includes("blocked")
        ? "refused"
        : "failed";
}
/**
 * 守卫发送：`hc send <t> <text> --if idle --json`。进程内调用只做即时投递——
 * --wait 的整轮收敛等待必须发生在 background CLI 进程里（orchestrator 的派发
 * 路由），不能阻塞 pi 事件循环。结果按 sendOutcome 判定，模糊输出就是 failed。
 */
export function coreSend(terminalId, text, spawn) {
    return Effect.catchAll(Effect.try({
        try: () => {
            const args = ["send", terminalId, "--if", "idle", "--json", text];
            const result = spawn(coreBin(), args, { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" });
            if (result.error)
                throw result.error;
            return sendOutcome(result.status, outputText(result.stdout), outputText(result.stderr));
        },
        catch: () => "failed",
    }), (outcome) => Effect.succeed(outcome));
}
/**
 * `hc keys <t> / n e w enter`：raw 有界清空。真实探针已验证该键序渲染
 * `New session started`；hc send 整段 "/new" 会被 pi 的 slash 补全菜单改写
 * （与 TUI 侧 send-keys 同坑），因此清空绝不走 send。
 */
export function coreClearKeys(terminalId, spawn) {
    return Effect.map(runCoreQuiet(["keys", terminalId, "/", "n", "e", "w", "enter"], spawn), (text) => text !== undefined);
}
/** `hc read <t> --lines <n>`：屏文本 + 有限历史，天然有界。失败返回 undefined。 */
export function coreRead(terminalId, spawn, lines) {
    return runCoreQuiet(["read", terminalId, "--lines", String(lines)], spawn);
}
/** `hc label <t> label=<value>`：打团队标签。失败静默 false。 */
export function coreLabel(terminalId, label, spawn) {
    return Effect.map(runCoreQuiet(["label", terminalId, `label=${label}`], spawn), (text) => text !== undefined);
}
const decodeNameTaken = Schema.decodeUnknownOption(Schema.parseJson(Schema.Struct({
    error: Schema.Struct({ kind: Schema.Literal("name_taken") }),
})));
export function coreRunBg(options, spawn) {
    return Effect.gen(function* () {
        for (const nickname of options.names) {
            const args = ["run", "--bg", "--json", "--name", nickname, "--label", `label=${nickname}`,
                "--outlive-parent", "--cwd", options.cwd, ...options.argv];
            const result = yield* Effect.either(runCoreRaw(args, spawn, 30_000));
            if (result._tag === "Left") {
                if (result.left instanceof CoreError && Option.isSome(decodeNameTaken(result.left.message)))
                    continue;
                warnCoreFailure(args, result.left);
                return undefined;
            }
            const paneId = parseCoreLaunch(parseJson(result.right));
            if (paneId)
                return { paneId, nickname };
            warnCoreFailure(args, new CoreError({ message: "启动回执缺少终端 id" }));
            return undefined;
        }
        notify("[hpl-orchestra] 找不到可用的终端名。", "warning");
        return undefined;
    });
}
/** `hc kill <t>`：结束终端程序。失败静默 false。 */
export function coreKill(terminalId, spawn) {
    return Effect.map(runCoreQuiet(["kill", terminalId], spawn), (text) => text !== undefined);
}
