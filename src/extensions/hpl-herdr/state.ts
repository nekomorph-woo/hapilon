/**
 * herdr 状态合成：主循环（agent_start/turn_start → agent_settled）与后台
 * subagent（subagents:started → completed/failed）两路事实合成一个语义状态，
 * 阻塞式 UI prompt 的 blocked 优先。状态不变时不产出，调用方跳过上报——
 * 修复「主循环已 settle、subagent 还在跑时误报 idle」。
 */
import type { HerdrState } from "./report.js";

export interface DerivedReport {
	state: HerdrState;
	message?: string | undefined;
}

export function createHerdrState() {
	let mainWorking = false;
	let promptOpen = false;
	let promptMessage: string | undefined;
	const inflight = new Set<string>();
	let last: DerivedReport | undefined;

	const derive = (): DerivedReport | undefined => {
		const report: DerivedReport = promptOpen
			? { state: "blocked", message: promptMessage }
			: { state: mainWorking || inflight.size > 0 ? "working" : "idle" };
		if (last && last.state === report.state && last.message === report.message) return undefined;
		last = report;
		return report;
	};

	return {
		agentStart: (): DerivedReport | undefined => {
			mainWorking = true;
			return derive();
		},
		turnStart: (): DerivedReport | undefined => {
			mainWorking = true;
			return derive();
		},
		agentSettled: (): DerivedReport | undefined => {
			mainWorking = false;
			return derive();
		},
		promptStart: (message?: string): DerivedReport | undefined => {
			promptOpen = true;
			promptMessage = message;
			return derive();
		},
		promptEnd: (): DerivedReport | undefined => {
			promptOpen = false;
			promptMessage = undefined;
			return derive();
		},
		subagentStarted: (id: string): DerivedReport | undefined => {
			inflight.add(id);
			return derive();
		},
		subagentEnded: (id: string): DerivedReport | undefined => {
			inflight.delete(id);
			return derive();
		},
		/** 新会话：全量重置；session_start 的 idle + sessionPath 由调用方显式上报 */
		reset: (): void => {
			mainWorking = false;
			promptOpen = false;
			promptMessage = undefined;
			inflight.clear();
			last = undefined;
		},
	};
}
