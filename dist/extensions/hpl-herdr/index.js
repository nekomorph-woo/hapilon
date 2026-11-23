import { Data, Effect } from "effect";
import { defaultSpawn } from "../hpl-orchestra/herdr.js";
import { notify } from "../notify.js";
import { readResolvedTiersEffect } from "../hpl-model-tiers/resolved.js";
import { readRecapConfig } from "../hpl-recap/config.js";
import { createRecapTimer } from "../hpl-recap/timer.js";
import { blockMessage, createHerdrReporter } from "./report.js";
import { createOscReporter } from "./osc.js";
import { createHerdrState } from "./state.js";
import { buildNamingPrompt, createTabNamer, pickNamingTier, qualifyingTaskInput } from "./tab-name.js";
function sessionPathOf(ctx) {
    try {
        return ctx.sessionManager.getSessionFile();
    }
    catch {
        return undefined;
    }
}
class NamingRequestError extends Data.TaggedError("NamingRequestError") {
}
/**
 * 命名生成：进程内走 ctx.modelRegistry.complete（haiku 档，对标 recap 的档位策略，
 * 独立请求，不搭 recap 的车）。此前 spawn `hapi -p` 子进程，入口指向 dist/cli.js，
 * 而 npm run build 先删 dist 再 tsc：窗口期内命名必失败。档位模型不在注册表时
 * 回落当前会话模型；请求失败告警并返回 undefined（调用侧截断兜底）。
 */
export function generateTabName(ctx, texts) {
    return Effect.runPromise(Effect.gen(function* () {
        const tier = pickNamingTier(yield* readResolvedTiersEffect);
        const model = (tier ? ctx.modelRegistry.find(tier.provider, tier.id) : undefined) ?? ctx.model;
        if (!model)
            return undefined;
        const response = yield* Effect.tryPromise({
            try: () => ctx.modelRegistry.complete(model, {
                messages: [{ role: "user", content: buildNamingPrompt(texts), timestamp: Date.now() }],
            }),
            catch: (error) => new NamingRequestError({ message: error instanceof Error ? error.message : String(error) }),
        });
        return response.content.find((part) => part.type === "text")?.text.trim() || undefined;
    }).pipe(Effect.catchAll((error) => Effect.sync(() => {
        notify(`[hpl-herdr] 标签命名请求失败，用截断兜底：${error.message.slice(0, 200)}`, "warning");
        return undefined;
    }))));
}
export function registerHerdrReporting(pi, deps) {
    // 两条出口同接口；herdr-app GUI 注入 HERDR_* 却不认这个 pane id（herdr-app#358），
    // CLI 首次 pane_not_found 后 escalate 翻转：CLI 通道闭嘴、OSC 顶上——同一 pane 仍只有一条活通道
    const escalate = { value: false };
    const cli = createHerdrReporter({
        spawn: deps.spawn,
        env: deps.env,
        onPaneNotFound: () => {
            escalate.value = true;
            notify("[hpl-herdr] herdr 不认这个 pane（pane_not_found），改走 OSC 7501 通道上报");
        },
    });
    const osc = createOscReporter({ env: deps.env, ...deps.osc, escalate });
    // CLI 专有参数 sessionPath 由各出口自行忽略；OSC 静态未激活时也要留在 sinks 里等 escalate
    const sinks = [];
    if (cli.enabled)
        sinks.push(cli);
    if (deps.osc?.isTTY)
        sinks.push(osc);
    if (sinks.length > 0) {
        const state = createHerdrState();
        const report = (derived) => {
            if (!derived)
                return;
            for (const sink of sinks) {
                sink.report(derived.state, derived.message ? { message: derived.message } : undefined);
            }
        };
        const subagentId = (event) => {
            const id = event?.id;
            return typeof id === "string" ? id : undefined;
        };
        // 起始：新会话重置状态机，并带上 session 路径（herdr 展示/resume 判断用）
        pi.on("session_start", (_event, ctx) => {
            state.reset();
            for (const sink of sinks)
                sink.report("idle", { sessionPath: sessionPathOf(ctx) });
        });
        // 主循环：起跑与每轮开始算 working；完全沉淀（无重试/压缩/排队续跑）才是
        // idle——agent_end 可能还有续跑，不报
        pi.on("agent_start", () => report(state.agentStart()));
        pi.on("turn_start", () => report(state.turnStart()));
        pi.on("agent_settled", () => report(state.agentSettled()));
        // 后台 subagent 在跑同样撑住 working：主循环 settle 后由这两路事实接管，
        // 最后一个结束才真正 idle（Agent/TaskExecute/Workflow 三路派发都过 manager）
        pi.events.on("subagents:started", (event) => {
            const id = subagentId(event);
            if (id)
                report(state.subagentStarted(id));
        });
        pi.events.on("subagents:completed", (event) => {
            const id = subagentId(event);
            if (id)
                report(state.subagentEnded(id));
        });
        pi.events.on("subagents:failed", (event) => {
            const id = subagentId(event);
            if (id)
                report(state.subagentEnded(id));
        });
        // 后台 shell 任务（background-tasks 插件）在跑同样撑住 working：任务 id 是
        // 数字，与 subagent 的字符串 id 分开收
        const jobId = (event) => {
            const id = event?.id;
            return typeof id === "number" ? id : undefined;
        };
        pi.events.on("bg-jobs:started", (event) => {
            const id = jobId(event);
            if (id !== undefined)
                report(state.bgStarted(id));
        });
        pi.events.on("bg-jobs:ended", (event) => {
            const id = jobId(event);
            if (id !== undefined)
                report(state.bgEnded(id));
        });
        // 阻塞：ask_user / 权限确认等阻塞式 UI prompt，标题优先当说明
        pi.on("ui_prompt_start", (event) => report(state.promptStart(blockMessage(event))));
        pi.on("ui_prompt_end", () => report(state.promptEnd()));
        // 退出：释放生命周期权威（CLI 的 release-agent / OSC 的 state=clear），
        // herdr 不再把这个 pane 当活跃 agent
        pi.on("session_shutdown", () => {
            for (const sink of sinks)
                sink.release();
        });
    }
    // 命名（issue#75）：时机 1 = 会话首条任务消息；时机 2 对标 recap 触发
    // （同一组活动事件 + recap 的 idleMinutes，独立模型请求）。角色面板（worker）
    // 的标签归 orchestra，命名整体不接；print/管道模式（hapi -p）没有 tab 标题概念，
    // 不激活。
    if (!process.env.HAPI_ORCH_ROLE && (deps.namingTTY ?? process.stdout.isTTY)) {
        let namingCtx;
        const namer = createTabNamer({
            sessionName: { get: () => pi.getSessionName(), set: (name) => pi.setSessionName(name) },
            // 时机 1/2 都只在 session_start 之后触发，那时 namingCtx 已就位
            generate: deps.generateNaming ?? ((texts) => generateTabName(namingCtx, texts)),
        });
        const idleMs = readRecapConfig().idleMinutes * 60_000;
        const timer = createRecapTimer(() => {
            // 与 recap 同款：忙时不改名也不重排，等下次活动事件重开计时
            if (!namingCtx?.isIdle() || namingCtx.hasPendingMessages())
                return;
            void namer.onRecapFire();
        }, deps.namingSchedule, deps.namingCancel);
        const activity = () => {
            timer.reset(idleMs);
        };
        pi.on("session_start", (_event, sessionCtx) => {
            namer.resetSession();
            namingCtx = sessionCtx;
            activity();
        });
        pi.on("agent_settled", activity);
        pi.on("message_end", activity);
        pi.on("turn_end", activity);
        pi.on("session_shutdown", () => timer.clear());
        // 时机 1：首条任务消息（命令、排队续跑、rpc/extension 投递不算）
        pi.on("input", (event) => {
            if (!qualifyingTaskInput(event.text, event.source, event.streamingBehavior))
                return;
            void namer.onUserInput(event.text);
        });
    }
}
export default function hplHerdr(pi) {
    registerHerdrReporting(pi, {
        spawn: defaultSpawn,
        env: {
            herdrEnv: process.env.HERDR_ENV,
            binPath: process.env.HERDR_BIN_PATH,
            paneId: process.env.HERDR_PANE_ID,
        },
        // 不传 TTY 信息 OSC 通道永远 no-op（isTTY undefined → enabled false）
        osc: { isTTY: process.stdout.isTTY },
    });
}
