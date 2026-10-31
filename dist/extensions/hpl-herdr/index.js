import { defaultSpawn } from "../hpl-orchestra/herdr.js";
import { blockMessage, createHerdrReporter } from "./report.js";
import { createOscReporter } from "./osc.js";
import { createHerdrState } from "./state.js";
function sessionPathOf(ctx) {
    try {
        return ctx.sessionManager.getSessionFile();
    }
    catch {
        return undefined;
    }
}
export function registerHerdrReporting(pi, deps) {
    // 两条出口同接口，激活哪条走哪条；sessionPath 这类 CLI 专有参数由各出口自行忽略
    const sinks = [
        createHerdrReporter({ spawn: deps.spawn, env: deps.env }),
        createOscReporter({ env: deps.env, ...deps.osc }),
    ].filter((sink) => sink.enabled);
    if (sinks.length === 0)
        return;
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
