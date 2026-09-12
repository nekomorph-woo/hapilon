import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import {
  agentGet,
  agentSendKeys,
  buildPaneRunCommand,
  defaultSpawn,
  paneGet,
  paneRun,
  paneSplit,
  paneSplitEnvArgs,
  resolveTierModel,
  type AgentStatus,
  type SpawnFn,
} from "./herdr.js";
import {
  currentRole,
  deleteTeamStateEffect,
  findTeamStateForPane,
  isTeamOwner,
  readTeamStateEffect,
  resolveSessionStatePath,
  writeTeamStateEffect,
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

export function buildTeamMenuOptions(enabled: boolean, paused = false): string[] {
  if (enabled) {
    return [TEAM_ACTIONS.pause, TEAM_ACTIONS.finish, TEAM_ACTIONS.clear, TEAM_ACTIONS.review, TEAM_ACTIONS.dispatch, TEAM_ACTIONS.view];
  }
  // 暂停状态：仍可结束（删状态）或重新开始；面板保留
  return paused
    ? [TEAM_ACTIONS.start, TEAM_ACTIONS.finish, TEAM_ACTIONS.view]
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
  const state = await Effect.runPromise(readTeamStateEffect(resolveSessionStatePath()));
  if ("roles" in state && isTeamStateLike(state)) return state;
  const paneId = process.env.HERDR_PANE_ID;
  if (currentRole() && paneId) {
    const roleState = findTeamStateForPane(paneId);
    return roleState && "roles" in roleState && isTeamStateLike(roleState) ? roleState : undefined;
  }
  return undefined;
}

function isTeamStateLike(state: unknown): state is TeamState {
  return typeof state === "object" && state !== null && "roles" in state && "owner" in state;
}

async function writeState(ctx: ExtensionCommandContext, state: TeamState): Promise<boolean> {
  return Effect.runPromise(writeTeamStateEffect(state, resolveSessionStatePath()));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 起窗就绪轮询：agent 状态上报就绪（非 unknown）或超时为止（review #5） */
async function waitAgentReady(paneId: string, spawn: SpawnFn, attempts = 5, intervalMs = 2_000): Promise<AgentStatus> {
  let status: AgentStatus = "unknown";
  for (let i = 0; i < attempts; i++) {
    status = Effect.runSync(agentGet(paneId, spawn));
    if (status !== "unknown") return status;
    await sleep(intervalMs);
  }
  return status;
}

async function ensurePane(
  ctx: ExtensionCommandContext,
  role: TeamRole,
  spawn: SpawnFn,
): Promise<{ paneId: string; model: string | null } | undefined> {
  const state = await readPersistedState(ctx);
  const existing = state ? paneState(state, role) : undefined;
  if (existing?.paneId) {
    const live = Effect.runSync(paneGet(existing.paneId, spawn));
    if (live) return { paneId: existing.paneId, model: existing.model };
  }

  const paneId = Effect.runSync(paneSplit(ctx.cwd, spawn, paneSplitEnvArgs(role)));
  if (!paneId) return undefined;
  const model = resolveTierModel(role === "worker" ? "sonnet" : "opus");
  const command = buildPaneRunCommand(role, model);
  if (!Effect.runSync(paneRun(paneId, command, spawn))) {
    Effect.runSync(runPaneClose(paneId, spawn));
    notify(ctx, `${role === "worker" ? "Worker" : "Review"} 面板启动失败（herdr pane run 未成功）。`, "error");
    return undefined;
  }
  // 就绪校验：pane run 成功只代表命令文本送达，不代表进程起来了
  const ready = await waitAgentReady(paneId, spawn);
  if (ready === "unknown") {
    Effect.runSync(runPaneClose(paneId, spawn));
    notify(ctx, `${role === "worker" ? "Worker" : "Review"} 面板启动后未就绪，已回收面板。`, "error");
    return undefined;
  }
  return { paneId, model: model ?? null };
}

function runPaneClose(paneId: string, spawn: SpawnFn): Effect.Effect<boolean, never> {
  return Effect.try({
    try: () => {
      const bin = process.env.HERDR_BIN_PATH ?? "herdr";
      const result = spawn(bin, ["pane", "close", paneId], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
      return result.status === 0;
    },
    catch: () => false,
  }).pipe(Effect.catchAll(() => Effect.sync(() => false)));
}

function makeState(
  ownerPaneId: string,
  worker: TeamPaneState,
  reviewer: TeamPaneState,
  previous?: TeamState,
): TeamState {
  return {
    enabled: true,
    since: previous?.since ?? new Date().toISOString(),
    owner: { paneId: ownerPaneId },
    roles: { worker, reviewer },
  };
}

async function startOrchestration(ctx: ExtensionCommandContext, spawn: SpawnFn): Promise<void> {
  const ownerPane = process.env.HERDR_PANE_ID;
  if (!ownerPane) {
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
  const saved = await writeState(ctx, makeState(ownerPane, worker, reviewer, previous));
  notify(ctx, saved ? `编排已开始，Worker 面板：${worker.paneId}` : "编排状态保存失败。", saved ? "info" : "error");
}

async function openReview(ctx: ExtensionCommandContext, spawn: SpawnFn): Promise<void> {
  const state = await readState(ctx);
  if (!state || !isTeamOwner(state)) {
    notify(ctx, "请先在主面板开始编排。", "warning");
    return;
  }
  const reviewer = await ensurePane(ctx, "reviewer", spawn);
  if (!reviewer) {
    notify(ctx, "Review 面板创建失败，请检查 herdr。", "error");
    return;
  }
  const next = makeState(process.env.HERDR_PANE_ID ?? state.owner.paneId, state.roles.worker, reviewer, state);
  const saved = await writeState(ctx, next);
  notify(ctx, saved ? `Review 面板已打开：${reviewer.paneId}` : "编排状态保存失败。", saved ? "info" : "error");
}

async function viewDivision(ctx: ExtensionCommandContext, spawn: SpawnFn): Promise<void> {
  const state = await readState(ctx);
  if (!state) {
    const persisted = await readPersistedState(ctx);
    if (persisted) {
      notify(ctx, "编排已暂停（面板保留）：\nWorker：persisted ✗\n可用「开始编排」恢复。");
    } else {
      notify(ctx, "当前未启用编排。");
    }
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

async function clearOne(ctx: ExtensionCommandContext, role: TeamRole, spawn: SpawnFn): Promise<boolean> {
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
  // /new 是异步的：轮询到 idle/done 才算成功；一直 working 说明清空已生效
  // 但面板可能已在处理新会话——超时则报「已发送未确认」（review #12）
  let after: AgentStatus = "unknown";
  for (let i = 0; i < 5; i++) {
    await sleep(1_000);
    after = Effect.runSync(agentGet(paneId, spawn));
    if (after === "idle" || after === "done") {
      notify(ctx, `${label} 面板上下文已清空。`);
      return true;
    }
  }
  notify(ctx, `${label} 清空已发送但未确认（当前状态 ${after}），请稍后检查。`, "warning");
  return false;
}

async function clearContexts(ctx: ExtensionCommandContext, spawn: SpawnFn): Promise<void> {
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
  if (!state || !isTeamOwner(state)) {
    notify(ctx, "当前没有可暂停的编排。", "warning");
    return;
  }
  const saved = await writeState(ctx, { ...state, enabled: false });
  notify(ctx, saved ? "编排已暂停，面板保留。" : "编排状态保存失败。", saved ? "info" : "error");
}

async function finish(ctx: ExtensionCommandContext): Promise<void> {
  // 暂停状态（enabled=false）也允许直接结束——用户不想用了就删状态，
  // 不必先「开始编排」恢复再结束
  const state = await readPersistedState(ctx);
  if (!state || !isTeamOwner(state)) {
    notify(ctx, "当前没有可结束的编排。", "warning");
    return;
  }
  const deleted = await Effect.runPromise(deleteTeamStateEffect(resolveSessionStatePath()));
  notify(
    ctx,
    deleted ? "编排已结束，面板保留，可手动关闭。" : "没有进行中的编排（状态文件不存在）。" ,
    deleted ? "info" : "warning",
  );
}

async function dispatch(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const state = await readState(ctx);
  if (!state || !isTeamOwner(state) || !state.roles.worker.paneId) {
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
  spawn: SpawnFn = defaultSpawn,
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

  const persisted = await readPersistedState(ctx);
  const enabled = Boolean(persisted && persisted.enabled && isTeamOwner(persisted));
  const paused = Boolean(persisted && !persisted.enabled && isTeamOwner(persisted));
  const options = buildTeamMenuOptions(enabled, paused);
  // 显式参数优先直达（含当前菜单未展示的动作，如无状态时 /team 结束编排），
  // 状态不符时由各动作内部报「没有可XX」
  const explicit = args.trim() ? actionForArgs(args, Object.values(TEAM_ACTIONS)) : undefined;
  const action = explicit ?? actionForArgs(args, options) ?? await ctx.ui.select("Team 编排", options);
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

/** 探活结果 10s TTL 缓存：before_agent_start 高频路径避免每次双 spawn（review #8） */
const PROBE_TTL_MS = 10_000;
const probeCache = new Map<string, { live: boolean; at: number }>();

function probePaneLive(paneId: string, spawn: SpawnFn): boolean {
  const cached = probeCache.get(paneId);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.live;
  const live = Boolean(Effect.runSync(paneGet(paneId, spawn)));
  probeCache.set(paneId, { live, at: Date.now() });
  return live;
}

export function resetProbeCache(): void {
  probeCache.clear();
}

export async function updateTeamStatus(ctx: ExtensionCommandContext, spawn: SpawnFn = defaultSpawn): Promise<void> {
  if (currentRole()) {
    ctx.ui.setStatus("team", undefined);
    return;
  }
  const state = await readState(ctx);
  if (!state || !isTeamOwner(state)) {
    ctx.ui.setStatus("team", undefined);
    return;
  }
  const check = (role: TeamRole): boolean => {
    const paneId = state.roles[role].paneId;
    return paneId ? probePaneLive(paneId, spawn) : false;
  };
  const workerLive = check("worker");
  const reviewerLive = check("reviewer");
  ctx.ui.setStatus(
    "team",
    `Team mode on · worker ${state.roles.worker.paneId ?? "—"} ${workerLive ? "✓" : "✗"} · review ${state.roles.reviewer.paneId ?? "—"} ${reviewerLive ? "✓" : "✗"}`,
  );
}
