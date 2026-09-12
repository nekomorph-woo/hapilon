/**
 * bridge.ts — hpl-orchestra → hpl-system-prompt 共享状态桥
 *
 * hpl-system-prompt 组装时读取 getTeamSections()；写入方是 hpl-orchestra
 * 的 before_agent_start（每轮现读状态文件后 setTeamSections）。
 *
 * 顺序依赖：扩展按名字母序加载/执行（hpl-orchestra < hpl-system-prompt），
 * 同一 pi 进程内 orchestrator 先写、组装方后读。跨进程（worker/reviewer
 * 面板是独立 pi 进程）各自求值本模块——env 读取放在写入方同一轮，不依赖
 * 模块缓存。测试用 resetTeamSections 隔离。
 */

import type { TeamSections } from "./state.js";

let sections: TeamSections = {};

export function setTeamSections(next: TeamSections): void {
  sections = next;
}

export function getTeamSections(): TeamSections {
  return sections;
}

export function resetTeamSections(): void {
  sections = {};
}
