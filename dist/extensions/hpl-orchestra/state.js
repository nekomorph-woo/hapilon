import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { getAllRoleDefs } from "./role-registry.js";
import { fillOrchestratorSection } from "./roles.js";
import { herdrEnvAvailable, panePresence } from "./herdr.js";
export class TeamStateError extends Data.TaggedError("TeamStateError") {
}
const disabledState = () => ({ enabled: false });
/**
 * round-1 之前的状态形态：`roles: {worker: {paneId, model}}`（paneId:null = 未打开）。
 * 读侧兼容，写侧只写新形态——旧状态下一次写入即自动升级，不必单独迁移。
 */
function upgradeLegacyRoles(parsed) {
    if (!parsed || typeof parsed !== "object")
        return parsed;
    const roles = parsed.roles;
    if (!roles || typeof roles !== "object" || Array.isArray(roles))
        return parsed;
    const entries = [];
    for (const [key, value] of Object.entries(roles)) {
        if (!value || typeof value !== "object")
            continue;
        const pane = value;
        if (typeof pane.paneId !== "string")
            continue;
        entries.push({
            key,
            instances: [{ paneId: pane.paneId, model: typeof pane.model === "string" ? pane.model : null }],
        });
    }
    return { ...parsed, roles: entries };
}
export const isTeamRole = (value, defs = getAllRoleDefs()) => typeof value === "string" && defs.some((role) => role.key === value);
const isRoleInstance = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const instance = value;
    return typeof instance.paneId === "string"
        && (typeof instance.model === "string" || instance.model === null)
        && (instance.transient === undefined || typeof instance.transient === "boolean")
        && (instance.nickname === undefined || typeof instance.nickname === "string");
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
    if (ownerRecord.session !== undefined && typeof ownerRecord.session !== "string")
        return false;
    if (ownerRecord.nickname !== undefined && typeof ownerRecord.nickname !== "string")
        return false;
    if (state.name !== undefined && typeof state.name !== "string")
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
/** transient 角色 prompt 落盘路径（pane id 派生，revive 无需另行存储）。 */
export function rolePromptPathFor(paneId) {
    return join(teamsDir(), `${paneId.replaceAll(":", "_")}.prompt`);
}
/**
 * 角色 pane 自己的 pi-tasks 任务列表路径（pane id 派生，与 rolePromptPathFor 同款）。
 * 一个 role 一份列表：不共享、不聚合，owner 想看得走 team-status。
 */
export function teamTasksPathFor(paneId) {
    return join(teamsDir(), `${paneId.replaceAll(":", "_")}.tasks.json`);
}
/** 任务档案根目录；每任务一子目录，见 planTaskDirFor */
const planTaskRoot = () => join(hapilonHome(), "plan-task");
/** 单个任务的档案目录（task-brief.md + 回执）；slug 约定 YYYY-MM-DD-短横线小写 */
export function planTaskDirFor(slug) {
    return join(planTaskRoot(), slug);
}
/**
 * 状态文件按主面板 herdr pane id 绑定（并行编排天然隔离；主面板 /new
 * 换会话不受影响）。冒号是 pane id 分隔符，转下划线。
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
        const upgraded = upgradeLegacyRoles(parsed);
        return isTeamState(upgraded, defs) ? upgraded : disabledState();
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
/** 盘上所有可用的团队状态（接管候选扫描、按 pane 查找共用）。 */
export function listTeamStates(defs = getAllRoleDefs()) {
    const directory = teamsDir();
    if (!existsSync(directory))
        return [];
    const found = [];
    for (const name of readdirSync(directory)) {
        if (!name.endsWith(".json"))
            continue; // 原子写的 .tmp 残留一并排除
        const path = join(directory, name);
        const state = readTeamState(path, defs);
        if ("roles" in state)
            found.push({ path, state });
    }
    return found;
}
/** 状态文件存在但不可用时的原因；无文件或文件可用时返回 undefined（只给 UI 提示用）。 */
export function teamStateError(path, defs = getAllRoleDefs()) {
    const statePath = path ?? resolveSessionStatePath();
    if (!existsSync(statePath))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(statePath, "utf8"));
        return isTeamState(upgradeLegacyRoles(parsed), defs) ? undefined : "结构不合法（可能被写坏或来自不兼容版本）";
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
/**
 * Role panes have their own Pi session id; locate their owner's state by pane id.
 * 带回状态文件路径，调方需要原路写回时用（角色 pane 不知道 owner 的 paneId，只能扫 teams 目录）。
 */
export const findTeamStateEntryForPaneEffect = (paneId, defs = getAllRoleDefs()) => Effect.try({
    try: () => {
        for (const entry of listTeamStates(defs)) {
            if (allInstances(entry.state).some((instance) => instance.paneId === paneId))
                return entry;
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
/** Role panes have their own Pi session id; locate their owner's state by pane id. */
export const findTeamStateForPaneEffect = (paneId, defs = getAllRoleDefs()) => findTeamStateEntryForPaneEffect(paneId, defs).pipe(Effect.map((entry) => entry?.state));
/**
 * 角色 pane 自己切模后的写回：owner `/team:clear`（实际发 `/new`）重建 session 时，pi 按
 * pane 启动时的 `--model` 恢复——不写回就回到旧模型。找不到状态（pane 已不在任何团队）
 * 静默跳过。约定：instance.model 存完整 spec（`provider/id` 可带 `:level` 后缀），
 * 与 reviveModelSpec 的 splitThinkingSuffix 消费语义一致，重灌时用户选的档位不丢。
 */
export const updatePaneModelEffect = (paneId, model) => Effect.gen(function* () {
    const entry = yield* findTeamStateEntryForPaneEffect(paneId);
    if (!entry)
        return;
    const instance = allInstances(entry.state).find((candidate) => candidate.paneId === paneId);
    if (!instance || instance.model === model)
        return;
    instance.model = model;
    yield* writeTeamStateEffect(entry.state, entry.path);
});
export function findTeamStateForPane(paneId, defs = getAllRoleDefs()) {
    return Effect.runSync(findTeamStateForPaneEffect(paneId, defs));
}
export const writeTeamStateEffect = (state, path) => Effect.try({
    try: () => {
        const statePath = path ?? resolveSessionStatePath();
        mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
        // 任务书的原生落盘位置：随每一次 team 状态写入（创建/启用/打开角色面板）
        // 一并确保存在，/tmp 里的 brief 重启即失。
        mkdirSync(planTaskRoot(), { recursive: true, mode: 0o700 });
        // 原子写：主 agent 崩溃正好撞上写盘时会留下半截 JSON，整个团队会被当成「未启用」
        // 静默丢失。tmp + rename 保证读侧要么看到旧版、要么看到新版。
        const tmpPath = `${statePath}.tmp`;
        writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        renameSync(tmpPath, statePath);
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
        // 每实例只探活一次：crew 过滤与剪枝判定共用结果。
        // 代价：每个实例每轮一次同步 pane get（~10s 超时上限，正常 <50ms）；
        // 实例数通常 ≤4，可接受。非 herdr 环境早已在函数入口返回。
        const presenceCache = new Map();
        const presenceOf = (paneId) => {
            let presence = presenceCache.get(paneId);
            if (!presence) {
                presence = Effect.runSync(panePresence(paneId));
                presenceCache.set(paneId, presence);
            }
            return presence;
        };
        // missing（herdr 明确报 pane 已关）→ 从花名册剪掉并持久化：orchestrator 不会再
        // 往死 pane 派发，也免去每轮探活的重复报错。瞬时失败（herdr 不可用）与
        // 「pane 在但 agent 死」保守保留原状。
        const pruned = [];
        for (const entry of state.roles) {
            entry.instances = entry.instances.filter((instance) => {
                if (presenceOf(instance.paneId).status === "missing") {
                    pruned.push({ key: entry.key, paneId: instance.paneId });
                    return false;
                }
                return true;
            });
        }
        if (pruned.length > 0) {
            // 非注册表 key 的条目空了必须整条删：空实例过不了 isRoleEntry 校验，
            // 整个状态会被读成「未启用」（registry 角色保留空条目，继续显示 not open 行）
            state.roles = state.roles.filter((entry) => entry.instances.length > 0 || isTeamRole(entry.key, defs));
            Effect.runSync(writeTeamStateEffect(state));
            // 剪枝已持久化，下一轮不再看到该实例 → 本通知天然只发一次
            console.warn(`[hpl-orchestra] ${pruned.map(({ key, paneId }) => `${key} 的成员 pane ${paneId} 已关闭，自动移出 team`).join("；")}`);
        }
        const crew = keys.flatMap((key) => {
            const instances = stateRoles.get(key)?.instances ?? [];
            if (instances.length === 0)
                return [{ key, paneId: "not open" }];
            // 探活过滤：死 pane 不能进 crew——orchestrator 会按提示词往这些
            // pane 派发，只会拿到 herdr 报错（review-r3 N7）。
            return instances
                .filter((instance) => presenceOf(instance.paneId).status === "alive")
                .map((instance) => ({ key, paneId: instance.paneId }));
        }).concat(
        // 全部实例已死的角色保留一行 not open，而不是从 crew 消失
        keys
            .filter((key) => {
            const instances = stateRoles.get(key)?.instances ?? [];
            return instances.length > 0
                && instances.every((instance) => presenceOf(instance.paneId).status !== "alive");
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
