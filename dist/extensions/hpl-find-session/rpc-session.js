/**
 * rpc-session.ts — 父扩展侧的 RPC 子进程管理
 *
 * 用 pi 的 RpcClient 拉起 `--mode rpc --no-session` 子进程：隔离全局扩展
 * （-ne 后只显式加载 worker）、锁定 haiku 档模型、系统提示词换成检索目标，
 * 模型工具循环全部复用 pi 内核。事件流在这里归约为面板可消费的更新；
 * 子进程 stderr 经 client.getStderr() 读出、随错误透出；不接管父进程 stderr，
 * RpcClient 自身向父 stderr 的转发保留（错误可见优先于花屏担忧，不吞父进程）。
 */
import { Data, Effect, Schema } from "effect";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";
import { RESULT_TOOL } from "./worker.js";
export class RpcSessionError extends Data.TaggedError("RpcSessionError") {
}
const STOP_MESSAGE = "子进程已关闭";
export const describeCause = (cause) => cause instanceof Error ? cause.message : String(cause);
/** details 载荷 schema：worker 产出经 stdout JSON 到达，属不可信边界 */
const ResultPayload = Schema.Struct({
    findSessionResults: Schema.Array(Schema.Struct({
        sessionId: Schema.String,
        path: Schema.String,
        summary: Schema.String,
        reason: Schema.String,
        evidence: Schema.Array(Schema.Struct({
            line: Schema.Number,
            messageId: Schema.String,
            quote: Schema.String,
            role: Schema.optional(Schema.String),
            timestamp: Schema.optional(Schema.String),
        })),
    })),
});
const decodePayload = Schema.decodeUnknownEither(ResultPayload);
export const GOAL_PROMPT = [
    "你是历史会话检索助手，帮用户在本地会话档案里找回相关历史讨论。",
    "",
    "规则：",
    "- 只用提供的只读会话工具，绝不臆测内容；引文必须逐字来自 session_read / session_search 的输出。",
    "- 建议流程：先 session_search 用几个不同的关键词（短而具体），命中后 session_read 分页读上下文；需要追溯讨论源头时用 session_parent。",
    "- 会话里有当前这轮对话、子代理任务转述等，它们不是用户的原始讨论；引用时注明出处文件，子代理会话是独立文件可以引用但要说明。不要把转述冒充原始讨论。",
    "- 结论确定后调用一次 find_session_result 发布：每条含 sessionId、path、summary（内容总结）、reason（匹配理由）、evidence（行号+消息id+逐字引文）。可发布多条。",
    "- 没有匹配就发布空 results，并在正文说明找过哪些关键词。",
    "- 发布后用一两句话告诉用户结果概况。",
].join("\n");
const summarizeArgs = (args) => {
    if (typeof args !== "object" || args === null)
        return "";
    const record = args;
    const parts = [];
    for (const key of ["keyword", "path", "cursor", "query"]) {
        const value = record[key];
        if (value === undefined)
            continue;
        parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    return parts.join(" ").slice(0, 60);
};
export class FindSessionRpc {
    client = null;
    stopped = false;
    busy = false;
    queued = 0;
    detachEvents = null;
    /** client 关闭后的 stderr 快照：stop/启动失败会置空 client，面板报错仍要能读 */
    lastStderr = "";
    /** 在途 send 的关闭哨兵：RpcClient.stop 只清 pendingRequests 不 reject，靠它竞速取消悬挂的 prompt；
     *  条目是 Effect.async 的 resume（参数为 Effect），stop 时统一触发（迟到的 resume 对已结束的 fiber 是无操作） */
    pendingGates = new Set();
    options;
    constructor(options) {
        this.options = options;
    }
    get isBusy() {
        return this.busy;
    }
    get stderrDump() {
        return this.client ? this.client.getStderr() : this.lastStderr;
    }
    /** 拉起子进程；失败即 typed error，并退订事件，不留全局残留 */
    start = () => Effect.gen(this, function* () {
        if (this.stopped) {
            return yield* Effect.fail(new RpcSessionError({ message: STOP_MESSAGE }));
        }
        const client = this.options.createClient?.() ?? this.createRealClient();
        this.client = client;
        this.detachEvents = client.onEvent((event) => this.handleEvent(event));
        const started = yield* Effect.either(Effect.tryPromise({
            try: () => client.start(),
            catch: (cause) => new RpcSessionError({
                message: `找回会话子进程启动失败：${describeCause(cause)}`,
            }),
        }));
        // 启动失败或启动期间被 stop：杀进程、还原 stderr、退订；主错误照常上报，清理失败另告警
        if (started._tag === "Left" || this.stopped) {
            // 实例已死：置 stopped 防 send/事件继续走，清 client 供 stop 幂等
            this.stopped = true;
            this.client = null;
            const cleaned = yield* Effect.either(this.teardown(client));
            if (cleaned._tag === "Left") {
                yield* Effect.sync(() => notify(`找回会话子进程清理失败：${cleaned.left.message}`, "warning"));
            }
            if (started._tag === "Left")
                return yield* Effect.fail(started.left);
            return yield* Effect.fail(new RpcSessionError({ message: STOP_MESSAGE }));
        }
        const thinking = this.options.model.thinking;
        if (thinking) {
            yield* Effect.tryPromise({
                try: () => client.setThinkingLevel(thinking),
                catch: (cause) => new RpcSessionError({
                    message: `设置 thinking 级别失败：${describeCause(cause)}`,
                }),
            });
        }
    });
    send = (text) => Effect.gen(this, function* () {
        if (this.stopped || !this.client) {
            return yield* Effect.fail(new RpcSessionError({ message: STOP_MESSAGE }));
        }
        const trimmed = text.trim();
        if (!trimmed)
            return;
        const client = this.client;
        const streaming = this.busy;
        // 忙碌时按 followUp 排队（pi 语义：流式中裸 prompt 会报错），闲时直接开新一轮。
        // 双侧都永不失败（prompt either 化、gate 是 null 哨兵）：race 谁先完成谁赢，
        // stop 时哨兵触发 → send 以 typed error 结束，不再悬挂在已清空的 pendingRequests 上
        const outcome = yield* Effect.race(Effect.either(Effect.tryPromise({
            try: () => client.prompt(trimmed, undefined, streaming ? "followUp" : undefined),
            catch: (cause) => new RpcSessionError({
                message: `发送失败：${describeCause(cause)}`,
            }),
        })), Effect.async((resume) => {
            this.pendingGates.add(resume);
        }));
        if (outcome === null) {
            return yield* Effect.fail(new RpcSessionError({ message: STOP_MESSAGE }));
        }
        if (outcome._tag === "Left") {
            return yield* Effect.fail(outcome.left);
        }
        const result = outcome.right;
        // await 期间可能已被关闭；迟到的状态变更不再投递
        if (this.stopped || !this.client) {
            return yield* Effect.fail(new RpcSessionError({ message: STOP_MESSAGE }));
        }
        if (streaming) {
            this.queued += 1;
            this.options.callbacks.onQueued(this.queued);
        }
        else if (result === "handled") {
            // 无运行产生（如 / 开头的扩展命令），没有 agent_settled 会来
            this.options.callbacks.onSettled(false);
        }
        else {
            this.busy = true;
            this.options.callbacks.onUserAccepted(trimmed);
        }
    });
    /** 停止当前一轮（不关面板、不清历史），之后可继续提问 */
    abort = () => Effect.gen(this, function* () {
        if (this.stopped || !this.client)
            return;
        const client = this.client;
        yield* Effect.tryPromise({
            try: () => client.abort(),
            catch: (cause) => new RpcSessionError({
                message: `停止失败：${describeCause(cause)}`,
            }),
        });
    });
    /** 关闭面板/退出：杀子进程、退订事件、清引用；退出失败以 typed error 上报 */
    stop = () => Effect.gen(this, function* () {
        if (this.stopped)
            return;
        this.stopped = true;
        const client = this.client;
        this.client = null;
        yield* this.teardown(client);
    });
    /** 本地资源回收（幂等）+ 子进程退出；本地回收先于 await，退出报错也不残留 */
    teardown(client) {
        if (client)
            this.lastStderr = client.getStderr();
        const detachEvents = this.detachEvents;
        this.detachEvents = null;
        detachEvents?.();
        const gates = [...this.pendingGates];
        this.pendingGates.clear();
        return Effect.gen(this, function* () {
            for (const resume of gates) {
                resume(Effect.succeed(null));
            }
            if (client) {
                yield* Effect.tryPromise({
                    try: () => client.stop(),
                    catch: (cause) => new RpcSessionError({ message: `子进程退出失败：${describeCause(cause)}` }),
                });
            }
        });
    }
    createRealClient() {
        const client = new RpcClient({
            cliPath: this.options.cliPath,
            // cwd 放会话根目录：那里没有项目 .pi 配置，避免任何项目侧资源被拾取
            cwd: this.options.sessionsRoot,
            provider: this.options.model.provider,
            model: this.options.model.id,
            args: [
                "--no-session",
                "-ne",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "--no-mcp",
                "--no-builtin-tools",
                "--system-prompt", this.options.systemPrompt,
                "-e", this.options.workerPath,
            ],
            env: {
                HAPI_FIND_SESSION_ROOT: this.options.sessionsRoot,
                PI_SKIP_VERSION_CHECK: "1",
            },
        });
        return client;
    }
    handleEvent(event) {
        if (this.stopped)
            return;
        // RPC 独有的 extension_error 不在 JsonAgentSessionEvent 联合类型里，先单判
        const raw = event;
        if (raw.type === "extension_error") {
            this.options.callbacks.onError(`扩展错误：${raw.error ?? "未知"}（${raw.extensionPath ?? "?"}）`);
            return;
        }
        switch (event.type) {
            case "message_update": {
                const update = event.assistantMessageEvent;
                if (update?.type === "text_delta" && update.delta) {
                    this.options.callbacks.onAssistantDelta(update.delta);
                }
                return;
            }
            case "message_end": {
                const message = event.message;
                if (message?.role === "assistant") {
                    this.options.callbacks.onAssistantFinal(textOf(message.content));
                }
                return;
            }
            case "tool_execution_start": {
                const start = event;
                if (start.toolName) {
                    this.options.callbacks.onToolStart(start.toolName, summarizeArgs(start.args));
                }
                return;
            }
            case "tool_execution_end": {
                const end = event;
                if (end.toolName === RESULT_TOOL) {
                    this.publishResults(end.result?.details);
                }
                if (end.toolName) {
                    this.options.callbacks.onToolEnd(end.toolName, end.isError === true);
                }
                return;
            }
            case "agent_settled": {
                this.busy = false;
                this.queued = 0;
                this.options.callbacks.onSettled(event.aborted === true);
                return;
            }
            default:
                return;
        }
    }
    publishResults(details) {
        const decoded = decodePayload(details);
        if (decoded._tag === "Left") {
            this.options.callbacks.onError("结果载荷格式异常，已丢弃（看 stderr 排查）");
            return;
        }
        this.options.callbacks.onResults(decoded.right.findSessionResults);
    }
}
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content.flatMap((block) => {
        if (typeof block !== "object" || block === null)
            return [];
        const value = block;
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).join("\n");
}
