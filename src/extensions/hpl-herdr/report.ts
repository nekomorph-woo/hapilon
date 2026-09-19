/**
 * hpl-herdr 的报告逻辑：把 pi 生命周期事件翻译成 herdr 的 pane report-agent 调用。
 *
 * 依据 herdr 官方《Integrate your own agent》:pane 内进程继承 HERDR_ENV /
 * HERDR_PANE_ID / HERDR_BIN_PATH,用 CLI 上报语义状态即可成为自己的 agent 类型,
 * 不需要 herdr 原生支持(OMP 是同一先例)。纯函数 + 注入 spawn/env,便于单测。
 */
import type { SpawnFn } from "../hpl-orchestra/herdr.js";

/** 源必须稳定且唯一——herdr 用它区分同一 pane 上的不同上报方 */
export const HERDR_SOURCE = "custom:hapilon";
/** 上报的 agent 标识：herdr 界面/agent list 里显示的名字 */
export const HERDR_AGENT = "hapi";

export type HerdrState = "working" | "idle" | "blocked";

export interface HerdrEnv {
	herdrEnv?: string | undefined;
	binPath?: string | undefined;
	paneId?: string | undefined;
}

/** 只在 herdr pane 内、且 CLI 与 pane 信息齐全时启用；其余环境严格 no-op */
export function reporterEnabled(env: HerdrEnv): boolean {
	return env.herdrEnv === "1" && Boolean(env.binPath) && Boolean(env.paneId);
}

export interface ReportOptions {
	message?: string | undefined;
	sessionPath?: string | undefined;
}

/** report-agent 参数（不含 binPath）；seq 由调用方递增 */
export function reportAgentArgs(
	paneId: string,
	state: HerdrState,
	seq: number,
	options: ReportOptions = {},
): string[] {
	const args = [
		"pane", "report-agent", paneId,
		"--source", HERDR_SOURCE,
		"--agent", HERDR_AGENT,
		"--state", state,
		"--seq", String(seq),
	];
	if (options.message) args.push("--message", options.message);
	if (options.sessionPath) args.push("--agent-session-path", options.sessionPath);
	return args;
}

/** release-agent 参数：进程退出时释放同一 source 的生命周期权威 */
export function releaseAgentArgs(paneId: string): string[] {
	return ["pane", "release-agent", paneId, "--source", HERDR_SOURCE, "--agent", HERDR_AGENT];
}

/** blocked 的说明文本：UI prompt 的标题优先，否则用 prompt 类型 */
export function blockMessage(event: { kind?: string; title?: string }): string {
	const kind = event.kind ?? "prompt";
	return event.title ? `${kind}: ${event.title}` : kind;
}

export interface HerdrReporter {
	readonly enabled: boolean;
	report(state: HerdrState, options?: ReportOptions): void;
	release(): void;
}

export interface ReporterDeps {
	spawn: SpawnFn;
	env: HerdrEnv;
	/** 上报失败时通知一次（默认 console.warn）；herdr 不在时永不触发 */
	onError?: (message: string) => void;
	/** 时钟（毫秒），注入以便单测 */
	now?: () => number;
}

const REPORT_TIMEOUT_MS = 3000;

/**
 * 状态上报器。上报失败绝不打断 pi 会话：只是 herdr 侧状态不更新，
 * 因此 catch 后经 onError 报警一次，而不是静默吞掉。
 */
export function createHerdrReporter(deps: ReporterDeps): HerdrReporter {
	const enabled = reporterEnabled(deps.env);
	const onError = deps.onError ?? ((message: string) => console.warn(message));

	// herdr 对每个 (pane, source) 记住已接受的最大 seq，凡 seq <= 它的上报一律「接受但丢弃」
	// （退出码 0、无错误输出），而本扩展每次 /new 或进程重启都会重建、计数从 0 重来，
	// 于是收编/换会话后整个 pane 的上报会静默失效到计数追平旧值为止。
	// 故用墙钟毫秒做 seq（跨实例、跨进程单调），同毫秒内再 +1 保证严格递增。
	let seq = 0;
	const now = deps.now ?? Date.now;
	const nextSeq = (): number => {
		seq = Math.max(seq + 1, now());
		return seq;
	};

	const call = (args: string[]): void => {
		try {
			const result = deps.spawn(deps.env.binPath!, args, { encoding: "utf8", timeout: REPORT_TIMEOUT_MS });
			if (result.error) {
				onError(`[hpl-herdr] 状态上报失败：${result.error.message}`);
				return;
			}
			// herdr 拒绝（exit 1 + stderr JSON）以前被完全吞掉，这里至少留一条线索
			if (result.status !== 0) {
				const detail = (result.stderr?.toString() ?? "").trim().slice(0, 200);
				onError(`[hpl-herdr] herdr 拒绝上报（exit ${result.status}）：${detail}`);
			}
		} catch (error) {
			onError(`[hpl-herdr] 状态上报失败：${error instanceof Error ? error.message : String(error)}`);
		}
	};

	return {
		enabled,
		report(state, options) {
			if (!enabled) return;
			call(reportAgentArgs(deps.env.paneId!, state, nextSeq(), options));
		},
		release() {
			if (!enabled) return;
			call(releaseAgentArgs(deps.env.paneId!));
		},
	};
}
