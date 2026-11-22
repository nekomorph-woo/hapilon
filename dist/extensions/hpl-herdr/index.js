/**
 * hpl-herdr — 让 herdr 把 hapilon 认成自己的 agent（hapi），而不是原生 pi
 *
 * 之前 hapilon 加载 herdr 的 pi 集成，herdr 就把它当 pi：界面显示 pi、状态靠
 * 屏幕抓取、服务器重启时按 `pi --resume` 恢复（hapilon 的壳全丢）。本扩展按
 * herdr 官方自定义集成协议，用 pi 的生命周期事件从进程内部上报语义状态。
 *
 * 状态来自三路事实的合成（state.ts）：主循环起跑/沉淀、后台 subagent 的
 * 生命周期、以及后台 shell 任务（background-tasks 插件经补丁发
 * bg-jobs:started/ended 事件，marker hapiBgJobEvents）——否则主循环 settle、
 * 后台还有活在跑时会误报 idle。
 *
 * 双通道：herdr-tui 走官方 CLI 集成（HERDR_ENV=1 且 HERDR_BIN_PATH/HERDR_PANE_ID
 * 齐全时激活）；herdr-app 同样注入这些变量但 pane 注册表不认（herdr-app#358），
 * CLI 被拒后自动切 OSC 7501 直接写 pty（osc.ts）。两路互斥，同一 pane 只有一条
 * 活通道；都不满足时严格 no-op。
 *
 * tab 命名（issue#75）：独立于上报通道，凡 team 宿主（herdr-tui / herdr-core）
 * 都激活，改名走 orchestra 传输层按宿主分流；herdr-app 改不了名（OSC 无名字
 * 字段），状态机自己会在首次尝试后收手。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Effect } from "effect";
import { hostAddress, resolveHost } from "../hpl-orchestra/host.js";
import { defaultSpawn } from "../hpl-orchestra/herdr.js";
import { paneGet, paneRename } from "../hpl-orchestra/transport.js";
import { notify } from "../notify.js";
import { blockMessage, createHerdrReporter } from "./report.js";
import { createOscReporter } from "./osc.js";
import { createHerdrState } from "./state.js";
import { createTabNamer, qualifyingTaskInput } from "./tab-name.js";
/**
 * rename_tab — 模型自报改名（issue#75 主力路）：它有全对话上下文，读得懂
 * 「继续昨天那个」是续聊而非新任务，边界判断比事件侧启发式准。使用时机靠
 * promptGuidelines 进系统提示；人工保护在 TabNamer 状态机里，工具只转述结果。
 */
function buildRenameTabTool(namer) {
    return defineTool({
        name: "rename_tab",
        label: "重命名标签",
        description: "改 herdr 里本 pane 的标签（tab 名）。只在明显切换到新任务时调用，用 3-6 个词概括当前任务；同一任务的后续消息不要调用。",
        parameters: Type.Object({
            title: Type.String({ description: "新标签，3-6 个词" }),
        }),
        promptGuidelines: [
            "rename_tab 只在话题切换、开始新任务时调用一次，用 3-6 个词命名当前任务；同一任务的后续消息不要调用。",
        ],
        execute: async (_toolCallId, params) => {
            const outcome = namer.renameTo(params.title);
            if (!outcome.ok) {
                return {
                    content: [{ type: "text", text: `[rename_tab] 未改名：${outcome.reason}` }],
                    details: {},
                    isError: true,
                };
            }
            return {
                content: [{ type: "text", text: `[rename_tab] 标签已改为「${outcome.label}」` }],
                details: {},
            };
        },
    });
}
function sessionPathOf(ctx) {
    try {
        return ctx.sessionManager.getSessionFile();
    }
    catch {
        return undefined;
    }
}
function renameHostOf() {
    const host = resolveHost();
    if (host.kind === "none")
        return undefined;
    return { kind: host.kind, paneId: hostAddress(host) ?? "" };
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
    const paneId = deps.host?.paneId;
    const namer = paneId
        ? createTabNamer({
            readPane: () => Effect.runSync(paneGet(paneId, deps.spawn)),
            rename: (label) => Effect.runSync(paneRename(paneId, label, deps.spawn)),
        })
        : undefined;
    if (sinks.length === 0 && !namer)
        return;
    // 主力命名：rename_tab 由模型自报。角色面板（worker）的标签归 orchestra，不注册。
    if (namer && !process.env.HAPI_ORCH_ROLE) {
        pi.registerTool(buildRenameTabTool(namer));
    }
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
    // 底座命名：会话首条任务消息（命令、排队续跑、rpc/extension 投递不算）。
    // 会话边界只重置一次性标记；人工/通道收手状态随 pane 标签存续，不重置。
    if (namer) {
        pi.on("session_start", () => namer.resetSession());
        pi.on("input", (event) => {
            if (!qualifyingTaskInput(event.text, event.source, event.streamingBehavior))
                return;
            namer.onUserInput(event.text);
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
        host: renameHostOf(),
        // 不传 TTY 信息 OSC 通道永远 no-op（isTTY undefined → enabled false）
        osc: { isTTY: process.stdout.isTTY },
    });
}
