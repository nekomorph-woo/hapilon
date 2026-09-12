import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { getAllRoleDefs } from "./role-registry.js";
import { fillOrchestratorSection } from "./roles.js";
import { herdrEnvAvailable, paneGet } from "./herdr.js";
/** crew 生成时的死 pane 过滤；herdr 不可用（测试/无 herdr 环境）时跳过过滤 */
function paneAlive(paneId) {
    if (!herdrEnvAvailable())
        return true;
    return Boolean(Effect.runSync(paneGet(paneId)));
}
export class TeamStateError extends Data.TaggedError("TeamStateError") {
}
const disabledState = () => ({ enabled: false });
export const isTeamRole = (value, defs = getAllRoleDefs()) => typeof value === "string" && defs.some((role) => role.key === value);
const isRoleInstance = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const instance = value;
    return typeof instance.paneId === "string"
        && (typeof instance.model === "string" || instance.model === null)
        && (instance.transient === undefined || typeof instance.transient === "boolean");
};
const isRoleEntry = (value, defs) => {
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
    return (isTeamRole(entry.key, defs) || transientOnly || entry.instances.length > 0)
        && entry.key.length > 0;
};
const isTeamState = (value, defs) => {
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
    if (!Array.isArray(roles) || !roles.every((entry) => isRoleEntry(entry, defs)))
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
export function currentRole(defs = getAllRoleDefs()) {
    const roleValue = process.env.HAPI_ORCH_ROLE;
    if (typeof roleValue === "string" && defs.some((role) => role.key === roleValue))
        return roleValue;
    if (typeof roleValue !== "string" || roleValue.length === 0)
        return undefined;
    const transientPrompt = process.env.HAPI_ORCH_ROLE_PROMPT;
    if (process.env.HAPI_ORCH_TRANSIENT_ROLE === "1" && typeof transientPrompt === "string" && transientPrompt.length > 0) {
        return roleValue;
    }
    // 自定义定义可能在角色面板仍存活时被删除；该 pane 仍应保持角色
    // prompt，而不是因缺失 registry 定义退回 orchestrator。
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId || !existsSync(teamsDir()))
        return undefined;
    try {
        const roleState = findTeamStateForPane(paneId, defs);
        return roleState && "roles" in roleState
            && roleState.roles.some((entry) => entry.key === roleValue
                && entry.instances.some((instance) => instance.paneId === paneId))
            ? roleValue
            : undefined;
    }
    catch {
        return undefined;
    }
}
export const readTeamStateEffect = (path, defs = getAllRoleDefs()) => Effect.try({
    try: () => {
        const statePath = path ?? resolveSessionStatePath();
        if (!existsSync(statePath))
            return disabledState();
        const parsed = JSON.parse(readFileSync(statePath, "utf8"));
        return isTeamState(parsed, defs) ? parsed : disabledState();
    },
    catch: (error) => new TeamStateError({
        message: error instanceof Error ? error.message : String(error),
    }),
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-orchestra] 状态文件读取失败，按未启用处理：${error.message}`);
    return disabledState();
})));
export function readTeamState(path, defs) {
    return Effect.runSync(readTeamStateEffect(path, defs));
}
/** Role panes have their own Pi session id; locate their owner's state by pane id. */
export const findTeamStateForPaneEffect = (paneId, defs = getAllRoleDefs()) => Effect.try({
    try: () => {
        const directory = teamsDir();
        if (!existsSync(directory))
            return undefined;
        for (const name of readdirSync(directory)) {
            if (!name.endsWith(".json"))
                continue;
            const state = readTeamState(join(directory, name), defs);
            if (!("roles" in state))
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
export function findTeamStateForPane(paneId, defs = getAllRoleDefs()) {
    return Effect.runSync(findTeamStateForPaneEffect(paneId, defs));
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
export function isTeamOwner(state, defs) {
    if (!("roles" in state) || !isTeamState(state, defs ?? getAllRoleDefs()))
        return false;
    const paneId = process.env.HERDR_PANE_ID;
    return Boolean(paneId) && state.owner.paneId === paneId;
}
/** Read the state on every prompt build; this intentionally has no module cache. */
export const buildTeamSectionsEffect = () => Effect.try({
    try: () => {
        if (!herdrEnvAvailable())
            return {};
        const defs = getAllRoleDefs();
        const role = currentRole(defs);
        if (role)
            return { role };
        const state = readTeamState(resolveSessionStatePath(), defs);
        if (!state.enabled || !isTeamOwner(state, defs))
            return {};
        const stateRoles = new Map(state.roles.map((entry) => [entry.key, entry]));
        const keys = [
            ...defs.map((roleDef) => roleDef.key),
            ...state.roles.map((entry) => entry.key).filter((key) => !defs.some((roleDef) => roleDef.key === key)),
        ];
        const crew = keys.flatMap((key) => {
            const instances = stateRoles.get(key)?.instances ?? [];
            if (instances.length === 0)
                return [{ key, paneId: "not open" }];
            // 探活过滤：死 pane 不能进 crew——orchestrator 会按提示词往这些
            // pane 派发，只会拿到 herdr 报错（review-r3 N7）。probe 结果经
            // herdr.ts 的 10s TTL 缓存复用，before_agent_start 高频路径可承受。
            return instances
                .filter((instance) => paneAlive(instance.paneId))
                .map((instance) => ({ key, paneId: instance.paneId }));
        }).concat(
        // 全部实例已死的角色保留一行 not open，而不是从 crew 消失
        keys
            .filter((key) => {
            const instances = stateRoles.get(key)?.instances ?? [];
            return instances.length > 0
                && instances.every((instance) => !paneAlive(instance.paneId));
        })
            .map((key) => ({ key, paneId: "not open" })));
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
