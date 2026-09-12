import { Effect } from "effect";
import { agentGet, agentSendKeys, buildPaneRunCommand, defaultSpawn, paneGet, paneRun, paneSplit, paneSplitEnvArgs, resolveDiscussantModel, resolveTierModelByTier, } from "./herdr.js";
import { getAllRoleDefs, getRoleDef, } from "./role-registry.js";
import { currentRole, deleteTeamStateEffect, findRoleEntry, findTeamStateForPane, isTeamOwner, readTeamStateEffect, resolveSessionStatePath, writeTeamStateEffect, } from "./state.js";
const TRANSIENT_ROLE_OPTION = "临时角色（本次会话）";
export const TEAM_ACTIONS = {
    open: "打开面板",
    start: "开始编排",
    pause: "暂停编排",
    finish: "结束编排",
    clear: "清空面板上下文",
    create: "创建自定义角色",
    manage: "管理自定义角色",
    // 保留旧命令直达兼容；菜单 v2 不再展示此项。
    review: "打开 Review 面板",
    dispatch: "派发给 Worker",
    view: "查看面板分工",
};
export function buildTeamMenuOptions(enabled, _paused = false) {
    if (enabled) {
        return [
            TEAM_ACTIONS.open,
            TEAM_ACTIONS.pause,
            TEAM_ACTIONS.finish,
            TEAM_ACTIONS.clear,
            TEAM_ACTIONS.create,
            TEAM_ACTIONS.manage,
            TEAM_ACTIONS.dispatch,
            TEAM_ACTIONS.view,
        ];
    }
    return [TEAM_ACTIONS.start, TEAM_ACTIONS.open, TEAM_ACTIONS.manage, TEAM_ACTIONS.view];
}
function notify(ctx, message, type = "info") {
    ctx.ui.notify(message, type);
}
function roleLabel(key) {
    if (key === "临时")
        return key;
    return getRoleDef(key)?.label ?? key;
}
function entryLabel(entry) {
    return entry.instances.some((instance) => instance.transient === true) ? "临时" : roleLabel(entry.key);
}
function roleDuty(role) {
    switch (role.key) {
        case "worker": return "写码+自验";
        case "reviewer": return "只读审码+verdict";
        case "ux-tester": return "实操验证效果→体验报告";
        case "discussant": return "只读讨论：观点/反驳/补盲区";
        default: return role.promptTemplate.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "按自定义职责工作";
    }
}
function roleOption(role) {
    return `${role.label}（${roleDuty(role)}）`;
}
function firstInstance(state, key) {
    return findRoleEntry(state, key)?.instances[0];
}
function isTeamStateLike(state) {
    return typeof state === "object" && state !== null && "roles" in state && "owner" in state;
}
async function readPersistedState(ctx) {
    const state = await Effect.runPromise(readTeamStateEffect(resolveSessionStatePath()));
    if ("roles" in state && isTeamStateLike(state))
        return state;
    const paneId = process.env.HERDR_PANE_ID;
    if (currentRole() && paneId) {
        const roleState = findTeamStateForPane(paneId);
        return roleState && "roles" in roleState && isTeamStateLike(roleState) ? roleState : undefined;
    }
    return undefined;
}
async function readEnabledState(ctx) {
    const state = await readPersistedState(ctx);
    return state?.enabled ? state : undefined;
}
async function writeState(state) {
    return Effect.runPromise(writeTeamStateEffect(state, resolveSessionStatePath()));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** pane 存活即视为就绪；hapilon 子进程不依赖 herdr 的 agent 识别上报。 */
async function waitPaneReady(paneId, spawn, attempts = 5, intervalMs = 1_000) {
    for (let i = 0; i < attempts; i++) {
        if (Effect.runSync(paneGet(paneId, spawn)))
            return true;
        await sleep(intervalMs);
    }
    return false;
}
function runPaneClose(paneId, spawn) {
    return Effect.try({
        try: () => {
            const bin = process.env.HERDR_BIN_PATH ?? "herdr";
            const result = spawn(bin, ["pane", "close", paneId], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
            return result.status === 0;
        },
        catch: () => false,
    }).pipe(Effect.catchAll(() => Effect.sync(() => false)));
}
function ownerProvider(ctx) {
    const model = ctx.model;
    return typeof model?.provider === "string" ? model.provider : undefined;
}
function modelForTier(role, tier, provider) {
    return role.key === "discussant" && tier === "opus"
        ? resolveDiscussantModel(provider)
        : resolveTierModelByTier(tier);
}
function tierName(tier) {
    return tier[0].toUpperCase() + tier.slice(1);
}
function tierOptions(role, provider) {
    const defaultTier = role.defaultTier;
    const tiers = [defaultTier, ...["opus", "sonnet", "haiku"].filter((tier) => tier !== defaultTier)];
    return tiers.map((tier) => {
        const model = modelForTier(role, tier, provider);
        const labels = [model ? `${tierName(tier)} — ${model}` : `${tierName(tier)} — 未配置`];
        if (role.key === "discussant" && tier === "opus" && model)
            labels.push("异构");
        if (tier === defaultTier)
            labels.push("默认");
        return { tier, model, text: `${labels[0]}${labels.length > 1 ? `（${labels.slice(1).join("，")}）` : ""}` };
    });
}
function appendRoleInstance(roles, role, instance) {
    const index = roles.findIndex((entry) => entry.key === role.key);
    if (index < 0)
        return [...roles, { key: role.key, instances: [instance] }];
    return roles.map((entry, entryIndex) => {
        if (entryIndex !== index)
            return entry;
        return role.singleton
            ? { ...entry, instances: [instance] }
            : { ...entry, instances: [...entry.instances, instance] };
    });
}
async function ensurePane(ctx, role, model, spawn, options = {}) {
    const state = await readPersistedState(ctx);
    if (role.singleton) {
        const existing = state ? findRoleEntry(state, role.key)?.instances ?? [] : [];
        for (const instance of existing) {
            if (Effect.runSync(paneGet(instance.paneId, spawn))) {
                return { paneId: instance.paneId, model: instance.model, reused: true };
            }
        }
    }
    const paneId = Effect.runSync(paneSplit(ctx.cwd, spawn, paneSplitEnvArgs(role.key, options)));
    if (!paneId)
        return undefined;
    const command = buildPaneRunCommand(role.key, model);
    if (!Effect.runSync(paneRun(paneId, command, spawn))) {
        Effect.runSync(runPaneClose(paneId, spawn));
        notify(ctx, `${role.label} 面板启动失败（herdr pane run 未成功）。`, "error");
        return undefined;
    }
    if (!await waitPaneReady(paneId, spawn)) {
        Effect.runSync(runPaneClose(paneId, spawn));
        notify(ctx, `${role.label} 面板启动后未就绪，已回收面板。`, "error");
        return undefined;
    }
    return { paneId, model: model ?? null, reused: false };
}
function emptyState(ownerPaneId, enabled) {
    return {
        enabled,
        since: new Date().toISOString(),
        owner: { paneId: ownerPaneId },
        roles: [],
    };
}
async function openRolePanel(ctx, role, model, spawn, options = {}) {
    const ownerPaneId = process.env.HERDR_PANE_ID;
    if (!ownerPaneId) {
        notify(ctx, "无法打开面板：当前 herdr 面板缺少 HERDR_PANE_ID。", "error");
        return;
    }
    const previous = await readPersistedState(ctx);
    if (previous && !isTeamOwner(previous)) {
        notify(ctx, "只能从 Team 主面板打开角色面板。", "warning");
        return;
    }
    const created = await ensurePane(ctx, role, model, spawn, options);
    if (!created) {
        notify(ctx, `${role.label} 面板创建失败，请检查 herdr。`, "error");
        return;
    }
    if (created.reused) {
        notify(ctx, `${role.label} 已在 ${created.paneId} 运行。`);
        return;
    }
    const base = previous ?? emptyState(ownerPaneId, !options.transient);
    const next = {
        ...base,
        // 临时角色可在未启用 Team 时存在；结束编排会随状态文件消失。
        enabled: previous?.enabled ?? !options.transient,
        owner: { paneId: ownerPaneId },
        roles: appendRoleInstance(base.roles, role, {
            paneId: created.paneId,
            model: created.model,
            ...(options.transient ? { transient: true } : {}),
        }),
    };
    const saved = await writeState(next);
    notify(ctx, saved ? `${role.label} 面板已打开：${created.paneId}` : "编排状态保存失败。", saved ? "info" : "error");
}
async function startOrchestration(ctx, spawn) {
    const ownerPane = process.env.HERDR_PANE_ID;
    if (!ownerPane) {
        notify(ctx, "无法开始编排：当前 herdr 面板缺少 HERDR_PANE_ID。", "error");
        return;
    }
    const previous = await readPersistedState(ctx);
    const worker = getRoleDef("worker");
    const result = await ensurePane(ctx, worker, modelForTier(worker, worker.defaultTier, ownerProvider(ctx)), spawn);
    if (!result) {
        notify(ctx, "Worker 面板创建失败，请检查 herdr。", "error");
        return;
    }
    const base = previous ?? emptyState(ownerPane, true);
    const next = {
        ...base,
        enabled: true,
        owner: { paneId: ownerPane },
        roles: appendRoleInstance(base.roles, worker, {
            paneId: result.paneId,
            model: result.model,
        }),
    };
    const saved = await writeState(next);
    notify(ctx, saved ? `编排已开始，Worker 面板：${result.paneId}` : "编排状态保存失败。", saved ? "info" : "error");
}
async function openPanel(pi, ctx, spawn) {
    const roles = getAllRoleDefs();
    const choices = [...roles.map(roleOption), TRANSIENT_ROLE_OPTION];
    const selected = await ctx.ui.select("打开哪个角色面板？", choices);
    if (!selected)
        return;
    const selectedRole = roles.find((role) => roleOption(role) === selected);
    const transient = selected === TRANSIENT_ROLE_OPTION;
    const role = selectedRole ?? (transient ? undefined : roles.find((candidate) => candidate.label === selected));
    if (!role && !transient)
        return;
    const transientRole = getRoleDef("__transient__") ?? {
        key: "__transient__",
        label: "临时",
        promptTemplate: "",
        defaultTier: "sonnet",
        singleton: false,
        builtin: false,
    };
    const tierRole = role ?? transientRole;
    const choicesByTier = tierOptions(tierRole, ownerProvider(ctx));
    const selectedTier = await ctx.ui.select("选择模型档位", choicesByTier.map((choice) => choice.text));
    if (!selectedTier)
        return;
    const tierChoice = choicesByTier.find((choice) => choice.text === selectedTier)
        ?? choicesByTier.find((choice) => choice.text.startsWith(selectedTier));
    if (!tierChoice)
        return;
    if (transient) {
        pendingTransient = {
            pi,
            ctx,
            spawn,
            model: tierChoice.model,
        };
        pi.sendUserMessage(`请根据当前对话现场设计一个临时团队角色，职责边界清晰，不编排不派发其它面板。只输出一行 JSON 哨兵，不要 Markdown 代码围栏：{"teamRoleDef":{"key":"英文短横线 key","label":"中文名称","prompt":"职责与输出格式","tier":"${tierChoice.tier}"}}`);
        notify(ctx, "已请主面板模型生成临时角色；收到下一条角色哨兵后创建面板。", "info");
        return;
    }
    await openRolePanel(ctx, role, tierChoice.model, spawn);
}
async function openReviewCompat(ctx, spawn) {
    const role = getRoleDef("reviewer");
    await openRolePanel(ctx, role, modelForTier(role, role.defaultTier, ownerProvider(ctx)), spawn);
}
async function viewDivision(ctx, spawn) {
    const state = await readEnabledState(ctx);
    if (!state) {
        const persisted = await readPersistedState(ctx);
        if (persisted) {
            const persistedRoles = persisted.roles
                .filter((entry) => entry.instances.length > 0)
                .map((entry) => `${entryLabel(entry)}：persisted ✗`);
            notify(ctx, `编排已暂停（面板保留）：\n${persistedRoles.join("\n")}\n可用「开始编排」恢复。`);
        }
        else {
            notify(ctx, "当前未启用编排。");
        }
        return;
    }
    const roleLines = await Promise.all(state.roles
        .filter((entry) => entry.instances.length > 0)
        .map(async (entry) => {
        const instances = await Promise.all(entry.instances.map(async (instance) => {
            const live = Boolean(Effect.runSync(paneGet(instance.paneId, spawn)));
            return `${instance.paneId} ${live ? "✓" : "✗"}`;
        }));
        return `${entryLabel(entry)}：${instances.join(" ")}`;
    }));
    notify(ctx, ["当前面板分工：", ...roleLines, `主面板：${state.owner.paneId}（只调度）`].join("\n"));
}
async function clearOne(ctx, key, spawn) {
    const state = await readEnabledState(ctx);
    const instances = state ? findRoleEntry(state, key)?.instances ?? [] : [];
    const label = roleLabel(key);
    if (instances.length === 0) {
        notify(ctx, `${label} 面板尚未打开。`, "warning");
        return true;
    }
    for (const instance of instances) {
        const before = Effect.runSync(agentGet(instance.paneId, spawn));
        if (before === "working") {
            notify(ctx, `${label} 正在工作中，等它完成后重试`, "warning");
            return false;
        }
        if (before === "blocked" || before === "unknown") {
            notify(ctx, `${label} 状态为 ${before}，暂不清空。`, "warning");
            return false;
        }
        if (!Effect.runSync(agentSendKeys(instance.paneId, ["/", "n", "e", "w", "enter"], spawn))) {
            notify(ctx, `${label} 清空失败，请检查 herdr。`, "error");
            return false;
        }
        let after = "unknown";
        for (let i = 0; i < 5; i++) {
            await sleep(1_000);
            after = Effect.runSync(agentGet(instance.paneId, spawn));
            if (after === "idle" || after === "done")
                break;
        }
        if (after !== "idle" && after !== "done") {
            notify(ctx, `${label} 清空已发送但未确认（当前状态 ${after}），请稍后检查。`, "warning");
            return false;
        }
    }
    notify(ctx, `${label} 面板上下文已清空。`);
    return true;
}
async function clearContexts(ctx, spawn) {
    const state = await readEnabledState(ctx);
    const activeRoles = state?.roles.filter((entry) => entry.instances.length > 0) ?? [];
    if (activeRoles.length === 0) {
        notify(ctx, "当前没有可清空的面板。", "warning");
        return;
    }
    const roleOptions = activeRoles.map(entryLabel);
    const target = await ctx.ui.select("清空哪个面板的上下文？", [...roleOptions, "都清"]);
    if (!target)
        return;
    if (target === "都清") {
        for (const entry of activeRoles) {
            if (!await clearOne(ctx, entry.key, spawn))
                return;
        }
    }
    else {
        const entry = activeRoles.find((candidate) => entryLabel(candidate) === target);
        if (entry)
            await clearOne(ctx, entry.key, spawn);
    }
}
async function pause(ctx) {
    const state = await readEnabledState(ctx);
    if (!state || !isTeamOwner(state)) {
        notify(ctx, "当前没有可暂停的编排。", "warning");
        return;
    }
    const saved = await writeState({ ...state, enabled: false });
    notify(ctx, saved ? "编排已暂停，面板保留。" : "编排状态保存失败。", saved ? "info" : "error");
}
async function finish(ctx) {
    const state = await readPersistedState(ctx);
    if (!state || !isTeamOwner(state)) {
        notify(ctx, "当前没有可结束的编排。", "warning");
        return;
    }
    const deleted = await Effect.runPromise(deleteTeamStateEffect(resolveSessionStatePath()));
    notify(ctx, deleted ? "编排已结束，面板保留，可手动关闭。" : "没有进行中的编排（状态文件不存在）。", deleted ? "info" : "warning");
}
async function dispatch(ctx, pi) {
    const state = await readEnabledState(ctx);
    const worker = state ? firstInstance(state, "worker") : undefined;
    if (!state || !isTeamOwner(state) || !worker) {
        notify(ctx, "Worker 面板尚未就绪。", "warning");
        return;
    }
    pi.sendUserMessage(`当前 Worker ${worker.paneId} 已待命，请把需要写码的任务告诉我。`);
    notify(ctx, "已提醒主面板模型向你收集写码任务。", "info");
}
function actionForArgs(args, options) {
    const trimmed = args.trim();
    if (!trimmed)
        return undefined;
    return options.find((option) => option === trimmed) ?? options.find((option) => option.startsWith(trimmed));
}
let pendingTransient;
function messageText(message) {
    if (!message || typeof message !== "object")
        return "";
    const content = message.content;
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content.map((part) => {
        if (!part || typeof part !== "object")
            return "";
        const text = part.text;
        return typeof text === "string" ? text : "";
    }).filter(Boolean).join("\n");
}
/** 从 assistant 消息中提取本轮临时角色哨兵；注册表角色不会被误当 transient。 */
export function extractTransientRole(message) {
    if (!message || typeof message !== "object" || message.role !== "assistant")
        return undefined;
    const lines = messageText(message).split(/\r?\n/);
    for (const line of lines) {
        const start = line.indexOf('{');
        if (start < 0)
            continue;
        try {
            const parsed = JSON.parse(line.slice(start).trim());
            if (!parsed || typeof parsed !== "object")
                continue;
            const raw = parsed.teamRoleDef;
            if (!raw || typeof raw !== "object")
                continue;
            const value = raw;
            if (typeof value.key !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.key))
                continue;
            if (typeof value.label !== "string" || value.label.trim() === "")
                continue;
            if (typeof value.prompt !== "string" || value.prompt.trim() === "")
                continue;
            if (getRoleDef(value.key))
                continue;
            const tier = value.tier;
            return {
                key: value.key,
                label: value.label.trim(),
                prompt: value.prompt.trim(),
                ...(tier === "opus" || tier === "sonnet" || tier === "haiku" ? { tier } : {}),
            };
        }
        catch {
            // assistant 常在 JSON 前后附带解释；非哨兵行继续扫描。
        }
    }
    return undefined;
}
export async function handleTransientMessage(message) {
    const roleInput = extractTransientRole(message);
    if (!roleInput || !pendingTransient)
        return false;
    const pending = pendingTransient;
    pendingTransient = undefined;
    const role = {
        key: roleInput.key,
        label: roleInput.label,
        promptTemplate: roleInput.prompt,
        defaultTier: roleInput.tier ?? "sonnet",
        singleton: false,
        builtin: false,
    };
    await openRolePanel(pending.ctx, role, pending.model, pending.spawn, { transient: true, prompt: roleInput.prompt });
    return true;
}
export async function handleTeamCommand(pi, args, ctx, spawn = defaultSpawn) {
    if (currentRole()) {
        const trimmed = args.trim();
        if (trimmed && trimmed !== TEAM_ACTIONS.view) {
            notify(ctx, "角色面板只允许查看分工，拒绝写操作。", "error");
            return;
        }
        const selected = trimmed || await ctx.ui.select("Team 编排", [TEAM_ACTIONS.view]);
        if (selected !== TEAM_ACTIONS.view)
            return;
        await viewDivision(ctx, spawn);
        return;
    }
    const persisted = await readPersistedState(ctx);
    const enabled = Boolean(persisted && persisted.enabled && isTeamOwner(persisted));
    const options = buildTeamMenuOptions(enabled, Boolean(persisted && !persisted.enabled));
    const explicit = args.trim() ? actionForArgs(args, Object.values(TEAM_ACTIONS)) : undefined;
    const action = explicit ?? await ctx.ui.select("Team 编排", options);
    if (!action)
        return;
    switch (action) {
        case TEAM_ACTIONS.start:
            await startOrchestration(ctx, spawn);
            break;
        case TEAM_ACTIONS.open:
            await openPanel(pi, ctx, spawn);
            break;
        case TEAM_ACTIONS.review:
            await openReviewCompat(ctx, spawn);
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
        case TEAM_ACTIONS.create:
        case TEAM_ACTIONS.manage:
            notify(ctx, "该菜单项将在轮次 3 开放。", "info");
            break;
        case TEAM_ACTIONS.dispatch:
            await dispatch(ctx, pi);
            break;
        case TEAM_ACTIONS.view:
            await viewDivision(ctx, spawn);
            break;
    }
}
/** 探活结果 10s TTL 缓存：before_agent_start 高频路径避免每次双 spawn。 */
const PROBE_TTL_MS = 10_000;
const probeCache = new Map();
function probePaneLive(paneId, spawn) {
    const cached = probeCache.get(paneId);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS)
        return cached.live;
    const live = Boolean(Effect.runSync(paneGet(paneId, spawn)));
    probeCache.set(paneId, { live, at: Date.now() });
    return live;
}
export function resetProbeCache() {
    probeCache.clear();
}
export async function updateTeamStatus(ctx, spawn = defaultSpawn) {
    if (currentRole()) {
        ctx.ui.setStatus("team", undefined);
        return;
    }
    const state = await readEnabledState(ctx);
    if (!state || !isTeamOwner(state)) {
        ctx.ui.setStatus("team", undefined);
        return;
    }
    const segments = state.roles
        .filter((entry) => entry.instances.length > 0)
        .map((entry) => `${entryLabel(entry)} ${entry.instances.map((instance) => `${instance.paneId} ${probePaneLive(instance.paneId, spawn) ? "✓" : "✗"}`).join(" ")}`);
    const text = `Team mode on${segments.length > 0 ? ` · ${segments.join(" · ")}` : ""}`;
    const columns = process.stdout.columns ?? 80;
    const { truncateToWidth } = await import("@earendil-works/pi-tui");
    ctx.ui.setStatus("team", truncateToWidth(text, Math.max(20, Math.min(columns, 80))));
}
