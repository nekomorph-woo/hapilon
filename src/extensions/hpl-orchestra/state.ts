import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { fillOrchestratorSection } from "./roles.js";

export type TeamRole = "worker" | "reviewer";

export interface TeamPaneState {
  paneId: string | null;
  model: string | null;
}

export interface TeamOwner {
  paneId: string;
  sessionRootId: string;
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

export interface SessionManagerIdentity {
  getHeader?: () => { id?: unknown } | null;
  getSessionId?: () => string;
}

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
  if (typeof ownerRecord.paneId !== "string" || typeof ownerRecord.sessionRootId !== "string") return false;
  if (!roles || typeof roles !== "object") return false;
  const roleRecord = roles as Record<string, unknown>;
  return isPaneState(roleRecord.worker) && isPaneState(roleRecord.reviewer);
};

export function teamsDir(): string {
  return join(hapilonHome(), "teams");
}

export function sessionRootId(sessionManager?: SessionManagerIdentity | string): string {
  if (typeof sessionManager === "string" && sessionManager.length > 0) return sessionManager;

  if (sessionManager && typeof sessionManager !== "string") {
    try {
      const header = sessionManager.getHeader?.();
      if (typeof header?.id === "string" && header.id.length > 0) return header.id;
    } catch {
      // Fall through to the current session id; test doubles may only expose that API.
    }
    try {
      const id = sessionManager.getSessionId?.();
      if (id) return id;
    } catch {
      // Fall through to the deterministic environment fallback below.
    }
  }

  // Pi exposes no separate root-session API in the current ReadonlySessionManager.
  // getSessionId() is therefore the final fallback when a test/context has no header.
  return process.env.HAPI_ORCH_SESSION_ROOT_ID ?? process.env.HAPI_ORCH_SESSION_ID ?? "unknown";
}

export function resolveSessionStatePath(sessionManager?: SessionManagerIdentity | string): string {
  return join(teamsDir(), `${sessionRootId(sessionManager)}.json`);
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
    mkdirSync(join(statePath, ".."), { recursive: true, mode: 0o700 });
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
    if (existsSync(statePath)) unlinkSync(statePath);
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

export function isTeamOwner(state: ReadTeamState, sessionManager?: SessionManagerIdentity | string): boolean {
  if (!isTeamState(state)) return false;
  const paneId = process.env.HERDR_PANE_ID;
  return Boolean(paneId)
    && state.owner.paneId === paneId
    && state.owner.sessionRootId === sessionRootId(sessionManager);
}

/** Read the state on every prompt build; this intentionally has no module cache. */
export const buildTeamSectionsEffect = (
  sessionManager?: SessionManagerIdentity,
): Effect.Effect<TeamSections, never> => Effect.try({
  try: () => {
    if (!process.env.HERDR_ENV) return {};

    const role = currentRole();
    if (role) return { role };

    const state = readTeamState(resolveSessionStatePath(sessionManager));
    if (!state.enabled || !isTeamOwner(state, sessionManager)) return {};
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

export function buildTeamSections(sessionManager?: SessionManagerIdentity): TeamSections {
  return Effect.runSync(buildTeamSectionsEffect(sessionManager));
}
