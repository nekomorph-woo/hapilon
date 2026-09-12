import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  agentGet,
  agentSendKeys,
  buildPaneRunCommand,
  paneGet,
  paneRun,
  paneSplit,
  resolveTierModel,
  type SpawnFn,
} from "./herdr.js";
import {
  currentRole,
  deleteTeamStateEffect,
  findTeamStateForPane,
  isTeamOwner,
  readTeamStateEffect,
  resolveSessionStatePath,
  sessionRootId,
  writeTeamStateEffect,
  type SessionManagerIdentity,
  type TeamPaneState,
  type TeamRole,
  type TeamState,
} from "./state.js";

export const TEAM_ACTIONS = {
  start: "开始编排",
  pause: "暂停编排",
  finish: "结束编排",
  clear: "清空面板上下文",
  review: "打开 Review 面板",
  dispatch: "派发给 Worker",
  view: "查看面板分工",
} as const;

const CLEAR_TARGETS = ["Worker", "Review", "都清"] as const;

export function buildTeamMenuOptions(enabled: boolean): string[] {
  return enabled
    ? [TEAM_ACTIONS.pause, TEAM_ACTIONS.finish, TEAM_ACTIONS.clear, TEAM_ACTIONS.review, TEAM_ACTIONS.dispatch, TEAM_ACTIONS.view]
    : [TEAM_ACTIONS.start, TEAM_ACTIONS.review, TEAM_ACTIONS.view];
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, type);
}

function paneState(state: TeamState, role: TeamRole): TeamPaneState {
  return state.roles[role];
}

async function readState(ctx: ExtensionCommandContext): Promise<TeamState | undefined> {
  const state = await readPersistedState(ctx);
  return state?.enabled ? state : undefined;
}

async function readPersistedState(ctx: ExtensionCommandContext): Promise<TeamState | undefined> {
  const state = await Effect.runPromise(readTeamStateEffect(resolveSessionStatePath(ctx.sessionManager as SessionManagerIdentity)));
  if ("roles" in state) return state;
  const paneId = process.env.HERDR_PANE_ID;
  if (currentRole() && paneId) {
    const roleState = findTeamStateForPane(paneId);
    return roleState && "roles" in roleState ? roleState : undefined;
  }
  return undefined;
}

async function writeState(ctx: ExtensionCommandContext, state: TeamState): Promise<boolean> {
  return Effect.runPromise(writeTeamStateEffect(
    state,
    resolveSessionStatePath(ctx.sessionManager as SessionManagerIdentity),
  ));
}

async function ensurePane(
  ctx: ExtensionCommandContext,
  role: TeamRole,
  spawn?: SpawnFn,
): Promise<{ paneId: string; model: string | null } | undefined> {
  const state = await readPersistedState(ctx);
  const existing = state ? paneState(state, role) : undefined;
  if (existing?.paneId) {
    const live = Effect.runSync(paneGet(existing.paneId, spawn));
    if (live) return { paneId: existing.paneId, model: existing.model };
  }

  const paneId = Effect.runSync(paneSplit(ctx.cwd, spawn));
  if (!paneId) return undefined;
  const model = resolveTierModel(role === "worker" ? "sonnet" : "opus");
  const command = buildPaneRunCommand(role, model);
  if (!Effect.runSync(paneRun(paneId, command, spawn))) return undefined;
  return { paneId, model: model ?? null };
}

function makeState(
  ctx: ExtensionCommandContext,
  worker: TeamPaneState,
  reviewer: TeamPaneState,
  previous?: TeamState,
): TeamState {
  const ownerPane = process.env.HERDR_PANE_ID ?? "";
  return {
    enabled: true,
    since: previous?.since ?? new Date().toISOString(),
    owner: {
      paneId: ownerPane,
      sessionRootId: sessionRootId(ctx.sessionManager as SessionManagerIdentity),
    },
    roles: { worker, reviewer },
  };
}

async function startOrchestration(ctx: ExtensionCommandContext, spawn?: SpawnFn): Promise<void> {
  if (!process.env.HERDR_PANE_ID) {
    notify(ctx, "无法开始编排：当前 herdr 面板缺少 HERDR_PANE_ID。", "error");
    return;
  }
  const previous = await readPersistedState(ctx);
  const worker = await ensurePane(ctx, "worker", spawn);
  if (!worker) {
    notify(ctx, "Worker 面板创建失败，请检查 herdr。", "error");
    return;
  }
  const reviewer = previous?.roles.reviewer ?? { paneId: null, model: null };
  const saved = await writeState(ctx, makeState(ctx, worker, reviewer, previous));
  notify(ctx, saved ? `编排已开始，Worker 面板：${worker.paneId}` : "编排状态保存失败。", saved ? "info" : "error");
}

async function openReview(ctx: ExtensionCommandContext, spawn?: SpawnFn): Promise<void> {
  const state = await readState(ctx);
  if (!state || !isTeamOwner(state, ctx.sessionManager as SessionManagerIdentity)) {
    notify(ctx, "请先在主面板开始编排。", "warning");
    return;
  }
  const reviewer = await ensurePane(ctx, "reviewer", spawn);
  if (!reviewer) {
    notify(ctx, "Review 面板创建失败，请检查 herdr。", "error");
    return;
  }
  const next = makeState(ctx, state.roles.worker, reviewer, state);
  const saved = await writeState(ctx, next);
  notify(ctx, saved ? `Review 面板已打开：${reviewer.paneId}` : "编排状态保存失败。", saved ? "info" : "error");
}

async function viewDivision(ctx: ExtensionCommandContext, spawn?: SpawnFn): Promise<void> {
  const state = await readPersistedState(ctx);
  if (!state) {
    notify(ctx, "当前未启用编排。\nWorker：未创建 ✗\nReview：未打开 ✗");
    return;
  }
  const check = async (role: TeamRole): Promise<boolean> => {
    const paneId = state.roles[role].paneId;
    return paneId ? Boolean(Effect.runSync(paneGet(paneId, spawn))) : false;
  };
  const [workerLive, reviewerLive] = await Promise.all([check("worker"), check("reviewer")]);
  const worker = state.roles.worker.paneId ?? "未创建";
  const reviewer = state.roles.reviewer.paneId ?? "未打开";
  notify(ctx, [
    "当前面板分工：",
    `Worker：${worker} ${workerLive ? "✓" : "✗"}（写码并自验）`,
    `Review：${reviewer} ${reviewerLive ? "✓" : "✗"}（只读审码）`,
    `主面板：${state.owner.paneId}（只调度）`,
  ].join("\n"));
}

async function clearOne(ctx: ExtensionCommandContext, role: TeamRole, spawn?: SpawnFn): Promise<boolean> {
  const state = await readState(ctx);
  const paneId = state?.roles[role].paneId;
  const label = role === "worker" ? "Worker" : "Review";
  if (!paneId) {
    notify(ctx, `${label} 面板尚未打开。`, "warning");
    return true;
  }
  const before = Effect.runSync(agentGet(paneId, spawn));
  if (before === "working") {
    notify(ctx, `${label} 正在工作中，等它完成后重试`, "warning");
    return false;
  }
  if (before === "blocked" || before === "unknown") {
    notify(ctx, `${label} 状态为 ${before}，暂不清空。`, "warning");
    return false;
  }
  if (!Effect.runSync(agentSendKeys(paneId, ["/", "n", "e", "w", "enter"], spawn))) {
    notify(ctx, `${label} 清空失败，请检查 herdr。`, "error");
    return false;
  }
  const after = Effect.runSync(agentGet(paneId, spawn));
  if (after !== "idle" && after !== "done") {
    notify(ctx, `${label} 清空后状态为 ${after}，请稍后检查。`, "warning");
    return false;
  }
  notify(ctx, `${label} 面板上下文已清空。`);
  return true;
}

async function clearContexts(ctx: ExtensionCommandContext, spawn?: SpawnFn): Promise<void> {
  const target = await ctx.ui.select("清空哪个面板的上下文？", [...CLEAR_TARGETS]);
  if (!target) return;
  if (target === "Worker") {
    await clearOne(ctx, "worker", spawn);
  } else if (target === "Review") {
    await clearOne(ctx, "reviewer", spawn);
  } else {
    if (await clearOne(ctx, "worker", spawn)) await clearOne(ctx, "reviewer", spawn);
  }
}

async function pause(ctx: ExtensionCommandContext): Promise<void> {
  const state = await readState(ctx);
  if (!state || !isTeamOwner(state, ctx.sessionManager as SessionManagerIdentity)) {
    notify(ctx, "当前没有可暂停的编排。", "warning");
    return;
  }
  const saved = await writeState(ctx, { ...state, enabled: false });
  notify(ctx, saved ? "编排已暂停，面板保留。" : "编排状态保存失败。", saved ? "info" : "error");
}

async function finish(ctx: ExtensionCommandContext): Promise<void> {
  const state = await readState(ctx);
  if (!state || !isTeamOwner(state, ctx.sessionManager as SessionManagerIdentity)) {
    notify(ctx, "当前没有可结束的编排。", "warning");
    return;
  }
  const deleted = await Effect.runPromise(deleteTeamStateEffect(resolveSessionStatePath(ctx.sessionManager as SessionManagerIdentity)));
  notify(ctx, deleted ? "编排已结束，面板保留，可手动关闭。" : "编排状态删除失败。", deleted ? "info" : "error");
}

async function dispatch(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const state = await readState(ctx);
  if (!state || !isTeamOwner(state, ctx.sessionManager as SessionManagerIdentity) || !state.roles.worker.paneId) {
    notify(ctx, "Worker 面板尚未就绪。", "warning");
    return;
  }
  pi.sendUserMessage(`当前 Worker ${state.roles.worker.paneId} 已待命，请把需要写码的任务告诉我。`);
  notify(ctx, "已提醒主面板模型向你收集写码任务。", "info");
}

function actionForArgs(args: string, options: string[]): string | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  return options.find((option) => option === trimmed)
    ?? options.find((option) => option.startsWith(trimmed));
}

export async function handleTeamCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  spawn?: SpawnFn,
): Promise<void> {
  if (currentRole()) {
    const trimmed = args.trim();
    if (trimmed && trimmed !== TEAM_ACTIONS.view) {
      notify(ctx, "Worker/Review 面板只允许查看分工，拒绝写操作。", "error");
      return;
    }
    const selected = trimmed || await ctx.ui.select("Team 编排", [TEAM_ACTIONS.view]);
    if (selected !== TEAM_ACTIONS.view) return;
    await viewDivision(ctx, spawn);
    return;
  }

  const state = await readState(ctx);
  const enabled = Boolean(state && isTeamOwner(state, ctx.sessionManager as SessionManagerIdentity));
  const options = buildTeamMenuOptions(enabled);
  const action = actionForArgs(args, options) ?? await ctx.ui.select("Team 编排", options);
  if (!action) return;

  switch (action) {
    case TEAM_ACTIONS.start:
      await startOrchestration(ctx, spawn);
      break;
    case TEAM_ACTIONS.review:
      await openReview(ctx, spawn);
      break;
    case TEAM_ACTIONS.pause:
      await pause(ctx);
      break;
    case TEAM_ACTIONS.finish:
      await finish(ctx);
      break;
    case TEAM_ACTIONS.clear:
      await clearContexts(ctx, spawn);
      break;
    case TEAM_ACTIONS.dispatch:
      await dispatch(ctx, pi);
      break;
    case TEAM_ACTIONS.view:
      await viewDivision(ctx, spawn);
      break;
  }
}

export async function updateTeamStatus(ctx: ExtensionCommandContext): Promise<void> {
  if (currentRole()) {
    ctx.ui.setStatus("team", undefined);
    return;
  }
  const state = await readState(ctx);
  if (!state || !isTeamOwner(state, ctx.sessionManager as SessionManagerIdentity)) {
    ctx.ui.setStatus("team", undefined);
    return;
  }
  const check = (role: TeamRole): boolean => {
    const paneId = state.roles[role].paneId;
    return paneId ? Boolean(Effect.runSync(paneGet(paneId))) : false;
  };
  const workerLive = check("worker");
  const reviewerLive = check("reviewer");
  ctx.ui.setStatus(
    "team",
    `Team mode on · worker ${state.roles.worker.paneId ?? "—"} ${workerLive ? "✓" : "✗"} · review ${state.roles.reviewer.paneId ?? "—"} ${reviewerLive ? "✓" : "✗"}`,
  );
}
