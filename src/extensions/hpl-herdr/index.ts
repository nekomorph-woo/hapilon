/**
 * hpl-herdr — 让 herdr 把 hapilon 认成自己的 agent（hapi），而不是原生 pi
 *
 * 之前 hapilon 加载 herdr 的 pi 集成，herdr 就把它当 pi：界面显示 pi、状态靠
 * 屏幕抓取、服务器重启时按 `pi --resume` 恢复（hapilon 的壳全丢）。本扩展按
 * herdr 官方自定义集成协议，用 pi 的生命周期事件从进程内部上报语义状态。
 *
 * 状态来自两路事实的合成（state.ts）：主循环起跑/沉淀，加上后台 subagent 的
 * 生命周期——否则主循环 settle、subagent 还在跑时会误报 idle。
 *
 * 仅在 herdr pane 内生效（HERDR_ENV=1 且 HERDR_BIN_PATH/HERDR_PANE_ID 齐全），
 * 其余环境严格 no-op。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultSpawn, type SpawnFn } from "../hpl-orchestra/herdr.js";
import { blockMessage, createHerdrReporter, type HerdrEnv } from "./report.js";
import { createHerdrState, type DerivedReport } from "./state.js";

function sessionPathOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile();
	} catch {
		return undefined;
	}
}

interface SubagentLifecycleEvent {
	id?: unknown;
}

export function registerHerdrReporting(pi: ExtensionAPI, deps: { spawn: SpawnFn; env: HerdrEnv }): void {
	const reporter = createHerdrReporter({ spawn: deps.spawn, env: deps.env });
	if (!reporter.enabled) return;

	const state = createHerdrState();
	const report = (derived: DerivedReport | undefined) => {
		if (derived) reporter.report(derived.state, derived.message ? { message: derived.message } : undefined);
	};
	const subagentId = (event: unknown): string | undefined => {
		const id = (event as SubagentLifecycleEvent | undefined)?.id;
		return typeof id === "string" ? id : undefined;
	};

	// 起始：新会话重置状态机，并带上 session 路径（herdr 展示/resume 判断用）
	pi.on("session_start", (_event, ctx) => {
		state.reset();
		reporter.report("idle", { sessionPath: sessionPathOf(ctx) });
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
		if (id) report(state.subagentStarted(id));
	});
	pi.events.on("subagents:completed", (event) => {
		const id = subagentId(event);
		if (id) report(state.subagentEnded(id));
	});
	pi.events.on("subagents:failed", (event) => {
		const id = subagentId(event);
		if (id) report(state.subagentEnded(id));
	});

	// 阻塞：ask_user / 权限确认等阻塞式 UI prompt，标题优先当说明
	pi.on("ui_prompt_start", (event) => report(state.promptStart(blockMessage(event))));
	pi.on("ui_prompt_end", () => report(state.promptEnd()));

	// 退出：释放生命周期权威，herdr 不再把这个 pane 当活跃 agent
	pi.on("session_shutdown", () => reporter.release());
}

export default function hplHerdr(pi: ExtensionAPI): void {
	registerHerdrReporting(pi, {
		spawn: defaultSpawn,
		env: {
			herdrEnv: process.env.HERDR_ENV,
			binPath: process.env.HERDR_BIN_PATH,
			paneId: process.env.HERDR_PANE_ID,
		},
	});
}
