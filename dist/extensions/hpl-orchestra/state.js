import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { getAllRoleDefs, getRoleDef } from "./role-registry.js";
import { fillOrchestratorSection } from "./roles.js";
import { herdrEnvAvailable } from "./herdr.js";
export class TeamStateError extends Data.TaggedError("TeamStateError") {
}
const disabledState = () => ({ enabled: false });
export const isTeamRole = (value) => typeof value === "string" && getRoleDef(value) !== undefined;
const isRoleInstance = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const instance = value;
    return typeof instance.paneId === "string"
        && (typeof instance.model === "string" || instance.model === null)
        && (instance.transient === undefined || typeof instance.transient === "boolean");
};
const isRoleEntry = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const entry = value;
    if (typeof entry.key !== "string" || !Array.isArray(entry.instances))
        return false;
    const validInstances = entry.instances.every(isRoleInstance);
    if (!validInstances)
        return false;
    const transientOnly = entry.instances.length > 0
        && entry.instances.every((instance) => instance.transient === true);
    // 注册表角色是正常路径；带实例的未知 key 可能是已删除定义的残留，
    // 仍需保留以便状态/菜单显示原 key。transient 同样不写注册表。
    return (isTeamRole(entry.key) || transientOnly || entry.instances.length > 0)
        && entry.key.length > 0;
};
const isTeamState = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const state = value;
    const owner = state.owner;
    const roles = state.roles;
    if (typeof state.enabled !== "boolean" || typeof state.since !== "string")
        return false;
    if (!owner || typeof owner !== "object")
        return false;
    const ownerRecord = owner;
    if (typeof ownerRecord.paneId !== "string")
        return false;
    if (!Array.isArray(roles) || !roles.every(isRoleEntry))
        return false;
    return new Set(roles.map((entry) => entry.key)).size === roles.length;
};
export function findRoleEntry(state, key) {
    return state.roles.find((entry) => entry.key === key);
}
export function allInstances(state) {
    return state.roles.flatMap((entry) => entry.instances);
}
export function teamsDir() {
    return join(hapilonHome(), "teams");
}
/**
 * 状态文件按主面板 herdr pane id 绑定（并行编排天然隔离；主面板 /new
 * 换会话不受影响——review #9 的裁定方案）。冒号是 pane id 分隔符，转下划线。
 */
export function resolveSessionStatePath(ownerPaneId) {
    const pane = ownerPaneId ?? process.env.HERDR_PANE_ID ?? "";
    return join(teamsDir(), `${pane.replaceAll(":", "_")}.json`);
}
export function currentRole() {
    const roleValue = process.env.HAPI_ORCH_ROLE;
    if (typeof roleValue === "string" && getRoleDef(roleValue))
        return roleValue;
    if (typeof roleValue !== "string" || roleValue.length === 0)
        return undefined;
    const transientPrompt = process.env.HAPI_ORCH_ROLE_PROMPT;
    return process.env.HAPI_ORCH_TRANSIENT_ROLE === "1" && typeof transientPrompt === "string" && transientPrompt.length > 0
        ? roleValue
        : undefined;
}
export const readTeamStateEffect = (path) => Effect.try({
    try: () => {
        const statePath = path ?? resolveSessionStatePath();
        if (!existsSync(statePath))
            return disabledState();
        const parsed = JSON.parse(readFileSync(statePath, "utf8"));
        return isTeamState(parsed) ? parsed : disabledState();
    },
    catch: (error) => new TeamStateError({
        message: error instanceof Error ? error.message : String(error),
    }),
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] 状态文件读取失败，按未启用处理：${error.message}`);
    return disabledState();
})));
export function readTeamState(path) {
    return Effect.runSync(readTeamStateEffect(path));
}
/** Role panes have their own Pi session id; locate their owner's state by pane id. */
export const findTeamStateForPaneEffect = (paneId) => Effect.try({
    try: () => {
        const directory = teamsDir();
        if (!existsSync(directory))
            return undefined;
        for (const name of readdirSync(directory)) {
            if (!name.endsWith(".json"))
                continue;
            const state = readTeamState(join(directory, name));
            if (!isTeamState(state))
                continue;
            if (allInstances(state).some((instance) => instance.paneId === paneId))
                return state;
        }
        return undefined;
    },
    catch: (error) => new TeamStateError({
        message: error instanceof Error ? error.message : String(error),
    }),
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] 按 pane 查找状态失败：${error.message}`);
    return undefined;
})));
export function findTeamStateForPane(paneId) {
    return Effect.runSync(findTeamStateForPaneEffect(paneId));
}
export const writeTeamStateEffect = (state, path) => Effect.try({
    try: () => {
        const statePath = path ?? resolveSessionStatePath();
        mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
        writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        return true;
    },
    catch: (error) => new TeamStateError({
        message: error instanceof Error ? error.message : String(error),
    }),
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] 状态文件写入失败：${error.message}`);
    return false;
})));
export const deleteTeamStateEffect = (path) => Effect.try({
    try: () => {
        const statePath = path ?? resolveSessionStatePath();
        if (!existsSync(statePath))
            return false;
        unlinkSync(statePath);
        return true;
    },
    catch: (error) => new TeamStateError({
        message: error instanceof Error ? error.message : String(error),
    }),
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] 状态文件删除失败：${error.message}`);
    return false;
})));
export function isTeamOwner(state) {
    if (!isTeamState(state))
        return false;
    const paneId = process.env.HERDR_PANE_ID;
    return Boolean(paneId) && state.owner.paneId === paneId;
}
/** Read the state on every prompt build; this intentionally has no module cache. */
export const buildTeamSectionsEffect = () => Effect.try({
    try: () => {
        if (!herdrEnvAvailable())
            return {};
        const role = currentRole();
        if (role)
            return { role };
        const state = readTeamState(resolveSessionStatePath());
        if (!state.enabled || !isTeamOwner(state))
            return {};
        const stateRoles = new Map(state.roles.map((entry) => [entry.key, entry]));
        const keys = [
            ...getAllRoleDefs().map((roleDef) => roleDef.key),
            ...state.roles.map((entry) => entry.key).filter((key) => !getRoleDef(key)),
        ];
        const crew = keys.flatMap((key) => {
            const instances = stateRoles.get(key)?.instances ?? [];
            return instances.length > 0
                ? instances.map((instance) => ({ key, paneId: instance.paneId }))
                : [{ key, paneId: "not open" }];
        });
        return { orchestrator: fillOrchestratorSection(crew) };
    },
    catch: (error) => new TeamStateError({
        message: error instanceof Error ? error.message : String(error),
    }),
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] team section 读取失败，跳过注入：${error instanceof Error ? error.message : String(error)}`);
    return {};
})));
export function buildTeamSections() {
    return Effect.runSync(buildTeamSectionsEffect());
}
