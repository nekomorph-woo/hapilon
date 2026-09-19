/**
 * team-cli.ts — owner 侧团队收口 CLI：team-status / team-enqueue / wake-owner。
 *
 * 与 wait-pane 同级注册（cli/commands.ts），沿用同一套约定：退出码即结果
 * （background 唤醒只带退出码），stdout 给人和模型看。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { agentPrompt, defaultSpawn, paneAgentAlive, type SpawnFn } from "./herdr.js";
import { allInstances, findTeamStateForPane, isTeamOwner, readTeamState, teamTasksPathFor } from "./state.js";
import { sampleAgentStateEffect } from "./agent-state.js";
import { briefDirOf, appendPendingTaskEffect, readTaskStoreEffect, taskLabel, type StoredTask } from "./team-tasks.js";

export const TEAM_STATUS_EXIT = { ok: 0, noTeam: 2 } as const;
export const TEAM_ENQUEUE_EXIT = { ok: 0, notInTeam: 2, store: 3, usage: 4 } as const;
export const WAKE_OWNER_EXIT = { sent: 0, noTeam: 2, herdr: 3 } as const;

/** pane 回执文件名（按角色定）：只有这两个角色有固定回执名，其余不猜。 */
const REPORT_FILES: Record<string, string> = {
  worker: "worker-report.md",
  reviewer: "reviewer-report.md",
};

/** `--flag value` / `--flag=value` 两种取值形式 */
function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/** 非 flag 参数（`--flag value` 的 value 不计入）：subject 不强制引号也能拼回来 */
function positionals(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (!arg.includes("=")) i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function countBy(tasks: readonly StoredTask[], status: string): StoredTask[] {
  return tasks.filter((task) => task.status === status);
}

/** 数值 id 升序；非数值 id 排到最后（pi-tasks 自己只产生数值 id）。 */
function byId(tasks: readonly StoredTask[]): StoredTask[] {
  return [...tasks].sort((a, b) => (Number.parseInt(a.id, 10) || 0) - (Number.parseInt(b.id, 10) || 0));
}

function labels(tasks: readonly StoredTask[], limit: number): string {
  const listed = tasks.slice(0, limit).map(taskLabel);
  return tasks.length > limit ? `${listed.join(", ")}, +${tasks.length - limit} more` : listed.join(", ");
}

/** 任务里有 brief 的最新一条（优先在做的），用它推回执路径。 */
function reportPathFor(roleKey: string, tasks: readonly StoredTask[]): string | undefined {
  const reportFile = REPORT_FILES[roleKey];
  if (!reportFile) return undefined;
  const ordered = byId(tasks).reverse();
  const inProgress = ordered.filter((task) => task.status === "in_progress");
  for (const task of [...inProgress, ...ordered]) {
    const dir = briefDirOf(task);
    if (dir) return join(dir, reportFile);
  }
  return undefined;
}

function readStore(path: string): { tasks: StoredTask[]; error?: string } {
  const result = Effect.runSync(Effect.either(readTaskStoreEffect(path)));
  if (result._tag === "Left") return { tasks: [], error: result.left.message };
  return { tasks: result.right?.tasks ?? [] };
}

function paneLines(key: string, paneId: string, nickname: string | undefined, spawn: SpawnFn): string[] {
  const who = `${key} ${paneId}${nickname ? ` ${nickname}` : ""}`;
  const { tasks, error } = readStore(teamTasksPathFor(paneId));
  const reportPath = reportPathFor(key, tasks);
  const state = Effect.runSync(sampleAgentStateEffect(paneId, {
    spawn,
    ...(reportPath ? { reportPath } : {}),
  }));
  const report = reportPath === undefined
    ? "n/a"
    : existsSync(reportPath) ? `exists (${reportPath})` : `missing (${reportPath})`;
  const header = `- ${who} · ${state} · report ${report}`;

  if (error) return [header, `  tasks: 不可读 — ${error}`];
  if (tasks.length === 0) return [header, "  tasks: 空（该 pane 还没建过任务）"];

  const ordered = byId(tasks);
  const completed = countBy(ordered, "completed");
  const inProgress = countBy(ordered, "in_progress");
  const pending = countBy(ordered, "pending");
  const parts = [
    `${pending.length} pending${pending.length > 0 ? ` [${labels(pending, 3)}]` : ""}`,
    `${inProgress.length} in_progress${inProgress.length > 0 ? ` [${labels(inProgress, 3)}]` : ""}`,
    `${completed.length} completed${completed.length > 0 ? ` [last ${taskLabel(completed[completed.length - 1]!)}]` : ""}`,
  ];
  return [header, `  tasks: ${parts.join(", ")}`];
}

/**
 * `hapi team-status`：owner 一眼看全 crew。
 * 只读——绝不写团队状态、绝不写任务列表。
 */
export function runTeamStatusCommand(_args: string[], spawn: SpawnFn = defaultSpawn): number {
  const state = readTeamState();
  if (!state.enabled || !isTeamOwner(state)) {
    console.log("[team-status] 当前面板不是 Team 主面板（或没有进行中的编排）。");
    return TEAM_STATUS_EXIT.noTeam;
  }
  const owner = state.owner;
  console.log(`团队${state.name ? ` ${state.name}` : ""} — owner ${owner.paneId}${owner.nickname ? ` ${owner.nickname}` : ""}`);
  const instances = allInstances(state);
  if (instances.length === 0) {
    console.log("- 当前没有角色面板");
    return TEAM_STATUS_EXIT.ok;
  }
  for (const entry of state.roles) {
    for (const instance of entry.instances) {
      for (const line of paneLines(entry.key, instance.paneId, instance.nickname, spawn)) console.log(line);
    }
  }
  return TEAM_STATUS_EXIT.ok;
}

/**
 * `hapi team-enqueue <pane-id> <subject> [--brief <path>]`：
 * 往目标 role pane 自己的任务列表末尾追加一条 pending（不触碰那个 pane）。
 */
export function runTeamEnqueueCommand(args: string[], now: () => number = Date.now): number {
  const [paneId, ...subjectParts] = positionals(args);
  const subject = subjectParts.join(" ").trim();
  if (!paneId || !subject) {
    console.error("用法：hapi team-enqueue <pane-id> <subject> [--brief <档案目录|task-brief.md>]");
    return TEAM_ENQUEUE_EXIT.usage;
  }
  const brief = flagValue(args, "--brief");

  const state = readTeamState();
  if (!state.enabled || !isTeamOwner(state)) {
    console.error("[team-enqueue] 当前面板不是 Team 主面板（或没有进行中的编排）。");
    return TEAM_ENQUEUE_EXIT.notInTeam;
  }
  if (!allInstances(state).some((instance) => instance.paneId === paneId)) {
    const known = allInstances(state).map((instance) => instance.paneId).join(" ") || "(无)";
    console.error(`[team-enqueue] ${paneId} 不在本团队，未写入。当前 crew：${known}`);
    return TEAM_ENQUEUE_EXIT.notInTeam;
  }

  const path = teamTasksPathFor(paneId);
  const result = Effect.runSync(Effect.either(
    appendPendingTaskEffect(path, { paneId, subject, ...(brief ? { brief } : {}) }, now),
  ));
  if (result._tag === "Left") {
    console.error(`[team-enqueue] 未写入：${result.left.message}`);
    return TEAM_ENQUEUE_EXIT.store;
  }
  console.log(`[team-enqueue] 已入队 #${result.right} → ${paneId}：${subject}`);
  return TEAM_ENQUEUE_EXIT.ok;
}

/**
 * `hapi wake-owner [--message <一行>]`：角色 pane 一轮结束/需要决策时主动叫 owner。
 * 退出码 0 已投递 / 2 不属于任何团队 / 3 herdr 投递失败。
 */
export function runWakeOwnerCommand(args: string[], spawn: SpawnFn = defaultSpawn): number {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    console.error("[wake-owner] 缺少 HERDR_PANE_ID，无法确定发送方。");
    return WAKE_OWNER_EXIT.noTeam;
  }
  const state = findTeamStateForPane(paneId);
  if (!state || !("roles" in state)) {
    console.error(`[wake-owner] 面板 ${paneId} 不属于任何团队，未投递。`);
    return WAKE_OWNER_EXIT.noTeam;
  }
  const instance = allInstances(state).find((candidate) => candidate.paneId === paneId);
  const message = flagValue(args, "--message")?.trim() || "一轮结束";
  const text = `[${instance?.nickname ?? paneId} ${paneId}] ${message}`;
  const ownerPane = state.owner.paneId;
  if (!Effect.runSync(paneAgentAlive(ownerPane, spawn))) {
    console.error(`[wake-owner] owner 面板 ${ownerPane} 不可用，未投递。`);
    return WAKE_OWNER_EXIT.herdr;
  }
  if (!Effect.runSync(agentPrompt(ownerPane, text, spawn))) {
    console.error(`[wake-owner] 向 ${ownerPane} 投递失败，未送达。`);
    return WAKE_OWNER_EXIT.herdr;
  }
  console.log(`[wake-owner] 已通知 ${ownerPane}：${text}`);
  return WAKE_OWNER_EXIT.sent;
}
