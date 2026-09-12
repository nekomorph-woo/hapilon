import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { fillOrchestratorSection } from "./roles.js";
import { herdrEnvAvailable } from "./herdr.js";

export type TeamRole = "worker" | "reviewer";

export interface TeamPaneState {
  paneId: string | null;
  model: string | null;
}

export interface TeamOwner {
  paneId: string;
}

export interface TeamState {
  enabled: boolean;
  since: string;
  owner: TeamOwner;
  roles: Record<TeamRole, TeamPaneState>;
}

export interface DisabledTeamState {
  enabled: false;
}

export type ReadTeamState = TeamState | DisabledTeamState;

export interface TeamSections {
  orchestrator?: string;
  role?: TeamRole;
}

export class TeamStateError extends Data.TaggedError("TeamStateError")<{
  message: string;
}> {}

const disabledState = (): DisabledTeamState => ({ enabled: false });

const isPaneState = (value: unknown): value is TeamPaneState => {
  if (!value || typeof value !== "object") return false;
  const pane = value as Record<string, unknown>;
  return (typeof pane.paneId === "string" || pane.paneId === null)
    && (typeof pane.model === "string" || pane.model === null);
};

const isTeamState = (value: unknown): value is TeamState => {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const owner = state.owner;
  const roles = state.roles;
  if (typeof state.enabled !== "boolean" || typeof state.since !== "string") return false;
  if (!owner || typeof owner !== "object") return false;
  const ownerRecord = owner as Record<string, unknown>;
  if (typeof ownerRecord.paneId !== "string") return false;
  if (!roles || typeof roles !== "object") return false;
  const roleRecord = roles as Record<string, unknown>;
  return isPaneState(roleRecord.worker) && isPaneState(roleRecord.reviewer);
};

export function teamsDir(): string {
  return join(hapilonHome(), "teams");
}

/**
 * 状态文件按主面板 herdr pane id 绑定（并行编排天然隔离；主面板 /new
 * 换会话不受影响——review #9 的裁定方案）。冒号是 pane id 分隔符，转下划线。
 */
export function resolveSessionStatePath(ownerPaneId?: string): string {
  const pane = ownerPaneId ?? process.env.HERDR_PANE_ID ?? "";
  return join(teamsDir(), `${pane.replaceAll(":", "_")}.json`);
}

export function currentRole(): TeamRole | undefined {
  const role = process.env.HAPI_ORCH_ROLE;
  return role === "worker" || role === "reviewer" ? role : undefined;
}

export const readTeamStateEffect = (path?: string): Effect.Effect<ReadTeamState, never> => Effect.try({
  try: () => {
    const statePath = path ?? resolveSessionStatePath();
    if (!existsSync(statePath)) return disabledState();
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    return isTeamState(parsed) ? parsed : disabledState();
  },
  catch: (error) => new TeamStateError({
    message: error instanceof Error ? error.message : String(error),
  }),
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] 状态文件读取失败，按未启用处理：${error.message}`);
    return disabledState();
  })),
);

export function readTeamState(path?: string): ReadTeamState {
  return Effect.runSync(readTeamStateEffect(path));
}

/** Role panes have their own Pi session id; locate their owner's state by pane id. */
export const findTeamStateForPaneEffect = (paneId: string): Effect.Effect<ReadTeamState | undefined, never> => Effect.try({
  try: () => {
    const directory = teamsDir();
    if (!existsSync(directory)) return undefined;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const state = readTeamState(join(directory, name));
      if (!isTeamState(state)) continue;
      if (state.roles.worker.paneId === paneId || state.roles.reviewer.paneId === paneId) return state;
    }
    return undefined;
  },
  catch: (error) => new TeamStateError({
    message: error instanceof Error ? error.message : String(error),
  }),
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] 按 pane 查找状态失败：${error.message}`);
    return undefined;
  })),
);

export function findTeamStateForPane(paneId: string): ReadTeamState | undefined {
  return Effect.runSync(findTeamStateForPaneEffect(paneId));
}

export const writeTeamStateEffect = (
  state: TeamState,
  path?: string,
): Effect.Effect<boolean, never> => Effect.try({
  try: () => {
    const statePath = path ?? resolveSessionStatePath();
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return true;
  },
  catch: (error) => new TeamStateError({
    message: error instanceof Error ? error.message : String(error),
  }),
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] 状态文件写入失败：${error.message}`);
    return false;
  })),
);

export const deleteTeamStateEffect = (path?: string): Effect.Effect<boolean, never> => Effect.try({
  try: () => {
    const statePath = path ?? resolveSessionStatePath();
    if (!existsSync(statePath)) return false;
    unlinkSync(statePath);
    return true;
  },
  catch: (error) => new TeamStateError({
    message: error instanceof Error ? error.message : String(error),
  }),
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] 状态文件删除失败：${error.message}`);
    return false;
  })),
);

export function isTeamOwner(state: ReadTeamState): boolean {
  if (!isTeamState(state)) return false;
  const paneId = process.env.HERDR_PANE_ID;
  return Boolean(paneId) && state.owner.paneId === paneId;
}

/** Read the state on every prompt build; this intentionally has no module cache. */
export const buildTeamSectionsEffect = (): Effect.Effect<TeamSections, never> => Effect.try({
  try: () => {
    if (!herdrEnvAvailable()) return {};

    const role = currentRole();
    if (role) return { role };

    const state = readTeamState(resolveSessionStatePath());
    if (!state.enabled || !isTeamOwner(state)) return {};
    return {
      orchestrator: fillOrchestratorSection(state.roles.worker.paneId, state.roles.reviewer.paneId),
    };
  },
  catch: (error) => new TeamStateError({
    message: error instanceof Error ? error.message : String(error),
  }),
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] team section 读取失败，跳过注入：${error instanceof Error ? error.message : String(error)}`);
    return {};
  })),
);

export function buildTeamSections(): TeamSections {
  return Effect.runSync(buildTeamSectionsEffect());
}
