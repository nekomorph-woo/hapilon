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
 * tab 命名（issue#75）：独立于上报通道，所有会话都激活（worker 角色面板除外）。
 * 写入通道是 ctx.setSessionName——pi 自己把「π - <sessionName> - <cwd>」
 * 渲染成 OSC 终端标题，herdr GUI/TUI 与普通终端的 tab 都跟随，名字随
 * session 文件持久、resume 后仍在，不需要按宿主派发 pane rename。
 * 生成走 hapi -p 子进程（haiku 档，对标 recap 档位策略，独立请求）；
 * 时机 1 是首条任务消息，时机 2 对标 recap 触发（空闲到点且 agent 空闲）。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { defaultSpawn, type SpawnFn } from "../hpl-orchestra/herdr.js";
import { notify } from "../notify.js";
import { readResolvedTiersEffect } from "../hpl-model-tiers/resolved.js";
import { readRecapConfig } from "../hpl-recap/config.js";
import { createRecapTimer, type RecapTimer, type TimerHandle } from "../hpl-recap/timer.js";
import { blockMessage, createHerdrReporter, type HerdrEnv, type HerdrReporter } from "./report.js";
import { createOscReporter } from "./osc.js";
import { createHerdrState, type DerivedReport } from "./state.js";
import { buildNamingPrompt, createTabNamer, namingModelRef, qualifyingTaskInput } from "./tab-name.js";

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

interface BgJobLifecycleEvent {
	id?: unknown;
}

/**
 * 命名生成：hapi -p 子进程（haiku 档，对标 recap 的档位选择策略；独立请求，
 * 不搭 recap 的车）。--no-session --no-tools 避免污染会话列表、不加载工具；
 * HERDR_/HAPI_ORCH_ 前缀的变量从子环境剥掉，避免子进程被 herdr 认成 pane。
 */
function createNamingGenerator(): (texts: readonly string[]) => Promise<string | undefined> {
	// 入口从模块位置定位：process.argv[1] 在安装形态是 shell shim（setup-herdr 生成），
	// node 直接执行它会语法炸
	const cliPath = fileURLToPath(new URL("../../cli.js", import.meta.url));
	return async (texts) => {
		if (!cliPath) return undefined;
		const resolved = Effect.runSync(Effect.either(readResolvedTiersEffect));
		const modelRef = resolved._tag === "Right" ? namingModelRef(resolved.right) : undefined;
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key.startsWith("HERDR_") || key.startsWith("HAPI_ORCH_")) delete env[key];
		}
		const args = [
			"-p",
			"--no-session",
			"--no-tools",
			...(modelRef ? ["--model", modelRef] : []),
			buildNamingPrompt(texts),
		];
		try {
			const label = await new Promise<string>((resolve, reject) => {
				// stdin 必须 ignore：pi print 模式等 stdin EOF 才开工，execFile 的常开管道会让它永久阻塞
				const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
				let out = "";
				let errs = "";
				const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
				child.stdout.on("data", (chunk: Buffer) => {
					out += chunk;
					if (out.length > 1024 * 1024) child.kill("SIGKILL");
				});
				child.stderr.on("data", (chunk: Buffer) => {
					errs += chunk;
				});
				child.on("error", (e) => {
					clearTimeout(killer);
					reject(e);
				});
				child.on("close", (code) => {
					clearTimeout(killer);
					if (code === 0) resolve(out);
					else reject(new Error(errs.trim().slice(0, 200) || `exit ${code}`));
				});
			});
			return label.trim() || undefined;
		} catch (error) {
			const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
			notify(`[hpl-herdr] 标签命名子进程失败，用截断兑底：${reason}`, "warning");
			return undefined;
		}
	};
}

export function registerHerdrReporting(
	pi: ExtensionAPI,
	deps: {
		spawn: SpawnFn;
		env: HerdrEnv;
		osc?: { isTTY?: boolean | undefined; write?: (sequence: string) => void };
		/** 测试注入：命名生成器（缺省 hapi -p 子进程） */
		generateNaming?: (texts: readonly string[]) => Promise<string | undefined>;
		/** 测试注入：命名通道的 TTY 判据（缺省 process.stdout.isTTY） */
		namingTTY?: boolean;
		/** 测试注入：时机 2 计时器 scheduler（缺省全局 setTimeout） */
		namingSchedule?: (callback: () => void, delayMs: number) => TimerHandle;
		namingCancel?: (handle: TimerHandle) => void;
	},
): void {
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
	const sinks: HerdrReporter[] = [];
	if (cli.enabled) sinks.push(cli);
	if (deps.osc?.isTTY) sinks.push(osc);

	if (sinks.length > 0) {
		const state = createHerdrState();
		const report = (derived: DerivedReport | undefined) => {
			if (!derived) return;
			for (const sink of sinks) {
				sink.report(derived.state, derived.message ? { message: derived.message } : undefined);
			}
		};
		const subagentId = (event: unknown): string | undefined => {
			const id = (event as SubagentLifecycleEvent | undefined)?.id;
			return typeof id === "string" ? id : undefined;
		};

		// 起始：新会话重置状态机，并带上 session 路径（herdr 展示/resume 判断用）
		pi.on("session_start", (_event, ctx) => {
			state.reset();
			for (const sink of sinks) sink.report("idle", { sessionPath: sessionPathOf(ctx) });
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

		// 后台 shell 任务（background-tasks 插件）在跑同样撑住 working：任务 id 是
		// 数字，与 subagent 的字符串 id 分开收
		const jobId = (event: unknown): number | undefined => {
			const id = (event as BgJobLifecycleEvent | undefined)?.id;
			return typeof id === "number" ? id : undefined;
		};
		pi.events.on("bg-jobs:started", (event) => {
			const id = jobId(event);
			if (id !== undefined) report(state.bgStarted(id));
		});
		pi.events.on("bg-jobs:ended", (event) => {
			const id = jobId(event);
			if (id !== undefined) report(state.bgEnded(id));
		});

		// 阻塞：ask_user / 权限确认等阻塞式 UI prompt，标题优先当说明
		pi.on("ui_prompt_start", (event) => report(state.promptStart(blockMessage(event))));
		pi.on("ui_prompt_end", () => report(state.promptEnd()));

		// 退出：释放生命周期权威（CLI 的 release-agent / OSC 的 state=clear），
		// herdr 不再把这个 pane 当活跃 agent
		pi.on("session_shutdown", () => {
			for (const sink of sinks) sink.release();
		});
	}

	// 命名（issue#75）：时机 1 = 会话首条任务消息；时机 2 对标 recap 触发
	// （同一组活动事件 + recap 的 idleMinutes，独立模型请求）。角色面板（worker）
	// 的标签归 orchestra，命名整体不接；print/管道模式（hapi -p）没有 tab
	// 标题概念，必须不激活——否则 -p 子进程里的命名扩展会自嵌套 spawn（每层
	// 90s 超时递归）并在 stale ctx 上读 session 名炸掉子进程。
	if (!process.env.HAPI_ORCH_ROLE && (deps.namingTTY ?? process.stdout.isTTY)) {
		const namer = createTabNamer({
			sessionName: { get: () => pi.getSessionName(), set: (name) => pi.setSessionName(name) },
			generate: deps.generateNaming ?? createNamingGenerator(),
		});
		const idleMs = readRecapConfig().idleMinutes * 60_000;
		let namingCtx: ExtensionContext | undefined;
		const timer = createRecapTimer(
			() => {
				// 与 recap 同款：忙时不改名也不重排，等下次活动事件重开计时
				if (!namingCtx?.isIdle() || namingCtx.hasPendingMessages()) return;
				void namer.onRecapFire();
			},
			deps.namingSchedule,
			deps.namingCancel,
		);
		const activity = (): void => {
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
			if (!qualifyingTaskInput(event.text, event.source, event.streamingBehavior)) return;
			void namer.onUserInput(event.text);
		});
	}
}

export default function hplHerdr(pi: ExtensionAPI): void {
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
