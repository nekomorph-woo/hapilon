import { Effect } from "effect";
import { agentGet, agentSendKeys, buildPaneRunCommand, defaultSpawn, paneGet, paneRun, paneSplit, paneSplitEnvArgs, resolveDiscussantModel, resolveTierModelByTier, } from "./herdr.js";
import { deleteCustomRoleDef, getAllRoleDefs, getRoleDef, saveCustomRoleDef, } from "./role-registry.js";
import { buildTransientRolePrompt, buildWizardPrompt } from "./role-wizard.js";
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
export function buildTeamMenuOptions(enabled, paused = false) {
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
    return paused
        ? [TEAM_ACTIONS.start, TEAM_ACTIONS.finish, TEAM_ACTIONS.view]
        : [TEAM_ACTIONS.start, TEAM_ACTIONS.open, TEAM_ACTIONS.manage, TEAM_ACTIONS.view];
}
function notify(ctx, message, type = "info") {
    ctx.ui.notify(message, type);
}
function roleLabel(key, defs = getAllRoleDefs()) {
    if (key === "临时")
        return key;
    return getRoleDef(key, defs)?.label ?? key;
}
function entryLabel(entry, defs = getAllRoleDefs()) {
    return entry.instances.some((instance) => instance.transient === true) ? "临时" : roleLabel(entry.key, defs);
}
function roleDuty(role) {
    switch (role.key) {
        case "worker": return "写码+自验";
        case "reviewer": return "只读审码+verdict";
        case "ux-tester": return "实操验证效果→体验报告";
        case "discussant": return "只读讨论：观点/反驳/补盲区";
        default: {
            const lines = role.promptTemplate.split(/\r?\n/).map((line) => line.trim());
            const frameworkMarker = lines.findIndex((line) => line === "Role responsibilities and style:");
            const candidates = frameworkMarker >= 0 ? lines.slice(frameworkMarker + 1) : lines;
            return candidates.find((line) => line.length > 0
                && line !== "<ROLE_PROMPT>"
                && !line.startsWith("<team")
                && !line.startsWith("</team")) ?? "按自定义职责工作";
        }
    }
}
function roleOption(role) {
    // 带 key 防止重名 label 让选中映射错对象（review-r3 N4）
    return `${role.label}（${role.key}·${roleDuty(role)}）`;
}
function firstInstance(state, key) {
    return findRoleEntry(state, key)?.instances[0];
}
function isTeamStateLike(state) {
    return typeof state === "object" && state !== null && "roles" in state && "owner" in state;
}
async function readPersistedState(ctx, defs = getAllRoleDefs()) {
    const state = await Effect.runPromise(readTeamStateEffect(resolveSessionStatePath(), defs));
    if ("roles" in state && isTeamStateLike(state))
        return state;
    const paneId = process.env.HERDR_PANE_ID;
    if (currentRole(defs) && paneId) {
        const roleState = findTeamStateForPane(paneId);
        return roleState && "roles" in roleState && isTeamStateLike(roleState) ? roleState : undefined;
    }
    return undefined;
}
async function readEnabledState(ctx, defs = getAllRoleDefs()) {
    const state = await readPersistedState(ctx, defs);
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
        const modelProvider = model?.split("/", 1)[0];
        if (role.key === "discussant" && tier === "opus" && model && modelProvider !== provider)
            labels.push("异构");
        if (tier === defaultTier)
            labels.push("默认");
        return { tier, model, text: `${labels[0]}${labels.length > 1 ? `（${labels.slice(1).join("，")}）` : ""}` };
    });
}
async function pruneRoleInstances(roles, key, spawn) {
    const index = roles.findIndex((entry) => entry.key === key);
    if (index < 0)
        return roles;
    const entry = roles[index];
    const liveInstances = entry.instances.filter((instance) => probePaneLive(instance.paneId, spawn));
    if (liveInstances.length === entry.instances.length)
        return roles;
    return roles.map((candidate, candidateIndex) => candidateIndex === index
        ? { ...candidate, instances: liveInstances }
        : candidate);
}
async function appendRoleInstance(roles, role, instance, spawn) {
    const prunedRoles = await pruneRoleInstances(roles, role.key, spawn);
    const index = prunedRoles.findIndex((entry) => entry.key === role.key);
    if (index < 0)
        return [...prunedRoles, { key: role.key, instances: [instance] }];
    return prunedRoles.map((entry, entryIndex) => {
        if (entryIndex !== index)
            return entry;
        return role.singleton
            ? { ...entry, instances: [instance] }
            : { ...entry, instances: [...entry.instances, instance] };
    });
}
async function ensurePane(ctx, role, model, spawn, options = {}, defs = getAllRoleDefs()) {
    const state = await readPersistedState(ctx, defs);
    if (role.singleton) {
        const existing = state ? findRoleEntry(state, role.key)?.instances ?? [] : [];
        for (const instance of existing) {
            // 复用判定用直连 paneGet：TTL 缓存会把「刚关闭的面板」误判为存活
            // 最多 10s，导致复用提示错误且新档位无法应用（review-r3 N3）
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
    const defs = getAllRoleDefs();
    const previous = await readPersistedState(ctx, defs);
    if (previous && !isTeamOwner(previous, defs)) {
        notify(ctx, "只能从 Team 主面板打开角色面板。", "warning");
        return;
    }
    const created = await ensurePane(ctx, role, model, spawn, options, defs);
    if (!created) {
        notify(ctx, `${role.label} 面板创建失败，请检查 herdr。`, "error");
        return;
    }
    if (created.reused) {
        const tierNote = options.selectedTier
            ? `（本次选择的 ${tierName(options.selectedTier)} 未应用；如需换档请先关闭该面板）`
            : "";
        notify(ctx, `${role.label} 已在 ${created.paneId} 运行${tierNote}。`);
        return;
    }
    const base = previous ?? emptyState(ownerPaneId, !options.transient);
    const next = {
        ...base,
        // 临时角色可在未启用 Team 时存在；结束编排会随状态文件消失。
        enabled: previous?.enabled ?? !options.transient,
        owner: { paneId: ownerPaneId },
        roles: await appendRoleInstance(base.roles, role, {
            paneId: created.paneId,
            model: created.model,
            ...(options.transient ? { transient: true } : {}),
        }, spawn),
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
    const defs = getAllRoleDefs();
    const previous = await readPersistedState(ctx, defs);
    const worker = getRoleDef("worker", defs);
    const result = await ensurePane(ctx, worker, modelForTier(worker, worker.defaultTier, ownerProvider(ctx)), spawn, {}, defs);
    if (!result) {
        notify(ctx, "Worker 面板创建失败，请检查 herdr。", "error");
        return;
    }
    const base = previous ?? emptyState(ownerPane, true);
    const next = {
        ...base,
        enabled: true,
        owner: { paneId: ownerPane },
        roles: await appendRoleInstance(base.roles, worker, {
            paneId: result.paneId,
            model: result.model,
        }, spawn),
    };
    const saved = await writeState(next);
    notify(ctx, saved ? `编排已开始，Worker 面板：${result.paneId}` : "编排状态保存失败。", saved ? "info" : "error");
}
async function openPanel(pi, ctx, spawn) {
    const roles = getAllRoleDefs();
    const persisted = await readPersistedState(ctx, roles);
    const choices = [...roles.map(roleOption), TRANSIENT_ROLE_OPTION];
    const selected = await ctx.ui.select("打开哪个角色面板？", choices);
    if (!selected)
        return;
    const selectedRole = roles.find((role) => roleOption(role) === selected);
    const transient = selected === TRANSIENT_ROLE_OPTION;
    const role = selectedRole ?? (transient ? undefined : roles.find((candidate) => candidate.label === selected));
    if (!role && !transient)
        return;
    if (role && !persisted) {
        notify(ctx, "打开面板将启用 Team 编排（主面板进入调度模式）", "info");
    }
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
        if (!tierChoice.model) {
            notify(ctx, "该档未配置模型，将以默认模型启动", "warning");
        }
        beginTransientWizard(pi, ctx, spawn, tierChoice.model, tierChoice.tier);
        return;
    }
    await openRolePanel(ctx, role, tierChoice.model, spawn, { selectedTier: tierChoice.tier });
}
async function openReviewCompat(ctx, spawn, defs = getAllRoleDefs()) {
    const role = getRoleDef("reviewer", defs);
    await openRolePanel(ctx, role, modelForTier(role, role.defaultTier, ownerProvider(ctx)), spawn, { selectedTier: role.defaultTier });
}
async function viewDivision(ctx, spawn) {
    const defs = getAllRoleDefs();
    const state = await readEnabledState(ctx, defs);
    if (!state) {
        const persisted = await readPersistedState(ctx, defs);
        if (persisted) {
            const persistedRoles = persisted.roles
                .filter((entry) => entry.instances.length > 0)
                .map((entry) => `${entryLabel(entry, defs)}：persisted ✗`);
            notify(ctx, `编排已暂停（面板保留）：\n${persistedRoles.join("\n")}\n可用「开始编排」恢复。`);
        }
        else {
            notify(ctx, "当前未启用编排。");
        }
        return;
    }
    const liveRoles = await liveRoleEntries(state, spawn);
    const roleLines = liveRoles.map((entry) => `${entryLabel(entry, defs)}：${entry.instances.map((instance) => `${instance.paneId} ✓`).join(" ")}`);
    notify(ctx, ["当前面板分工：", ...roleLines, `主面板：${state.owner.paneId}（只调度）`].join("\n"));
}
async function clearOne(ctx, key, spawn, instancesOverride, defs = getAllRoleDefs()) {
    const state = await readEnabledState(ctx, defs);
    const instances = instancesOverride ?? (state ? findRoleEntry(state, key)?.instances ?? [] : []);
    const label = instances.some((instance) => instance.transient === true) ? "临时" : roleLabel(key, defs);
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
    const defs = getAllRoleDefs();
    const state = await readEnabledState(ctx, defs);
    const activeRoles = state ? await liveRoleEntries(state, spawn) : [];
    if (activeRoles.length === 0) {
        notify(ctx, "当前没有可清空的面板。", "warning");
        return;
    }
    const roleOptions = activeRoles.map((entry) => entryLabel(entry, defs));
    const target = await ctx.ui.select("清空哪个面板的上下文？", [...roleOptions, "都清"]);
    if (!target)
        return;
    if (target === "都清") {
        for (const entry of activeRoles) {
            if (!await clearOne(ctx, entry.key, spawn, entry.instances, defs))
                return;
        }
    }
    else {
        const entry = activeRoles.find((candidate) => entryLabel(candidate, defs) === target);
        if (entry)
            await clearOne(ctx, entry.key, spawn, entry.instances, defs);
    }
}
async function pause(ctx) {
    const defs = getAllRoleDefs();
    const state = await readEnabledState(ctx, defs);
    if (!state || !isTeamOwner(state, defs)) {
        notify(ctx, "当前没有可暂停的编排。", "warning");
        return;
    }
    const saved = await writeState({ ...state, enabled: false });
    notify(ctx, saved ? "编排已暂停，面板保留。" : "编排状态保存失败。", saved ? "info" : "error");
}
async function finish(ctx) {
    const defs = getAllRoleDefs();
    const state = await readPersistedState(ctx, defs);
    if (!state || !isTeamOwner(state, defs)) {
        notify(ctx, "当前没有可结束的编排。", "warning");
        return;
    }
    const deleted = await Effect.runPromise(deleteTeamStateEffect(resolveSessionStatePath()));
    notify(ctx, deleted ? "编排已结束，面板保留，可手动关闭。" : "没有进行中的编排（状态文件不存在）。", deleted ? "info" : "warning");
}
async function dispatch(ctx, pi) {
    const defs = getAllRoleDefs();
    const state = await readEnabledState(ctx, defs);
    const worker = state ? firstInstance(state, "worker") : undefined;
    if (!state || !isTeamOwner(state, defs) || !worker) {
        notify(ctx, "Worker 面板尚未就绪。", "warning");
        return;
    }
    pi.sendUserMessage(`当前 Worker ${worker.paneId} 已待命，请把需要写码的任务告诉我。`);
    notify(ctx, "已提醒主面板模型向你收集写码任务。", "info");
}
function roleDetails(role) {
    return JSON.stringify(role, null, 2);
}
function beginCustomWizard(pi, ctx, existing) {
    const requestText = buildWizardPrompt(existing);
    pendingRoleWizard = {
        kind: existing ? "edit" : "create",
        existingKey: existing?.key,
        ctx,
        // pi.sendUserMessage 注入的请求文本会同步触发一次 user message_end，
        // 用 requestText 精确忽略它，防止向导刚启动就被「取消」判定清掉
        ignoreNextUserMessage: true,
        requestText,
    };
    pi.sendUserMessage(requestText);
    notify(ctx, "向导已开始，请在对话中完成；完成后自动保存（中途输入「取消」终止）", "info");
}
function beginTransientWizard(_pi, ctx, spawn, model, tier) {
    const requestText = buildTransientRolePrompt(tier);
    const pending = {
        kind: "transient",
        ctx,
        spawn,
        model,
        tier,
        ignoreNextUserMessage: true,
        requestText,
    };
    // 先发送请求；若运行时同步发出该 user message 的 message_end，不应
    // 被误判为用户取消。异步到达时用 requestText 精确忽略同一条消息。
    _pi.sendUserMessage(requestText);
    pendingRoleWizard = pending;
    notify(ctx, "已请主面板模型生成临时角色；收到下一条角色哨兵后创建面板。", "info");
}
async function manageRoles(ctx, pi, spawn) {
    const roles = getAllRoleDefs();
    // 选项带 key：label 无唯一性约束，展示串当唯一键会操作错对象（review-r3 N4）
    const options = [...roles.map((role) => `${role.label}${role.builtin ? "（内置）" : ""}（${role.key}）`), "返回"];
    const selected = await ctx.ui.select("管理角色", options);
    if (!selected || selected === "返回")
        return;
    const role = roles.find((candidate) => selected.endsWith(`（${candidate.key}）`));
    if (!role)
        return;
    const action = await ctx.ui.select(`${role.label}（${role.key}）`, role.builtin ? ["查看详情", "返回"] : ["查看详情", "编辑", "删除", "返回"]);
    if (!action || action === "返回")
        return;
    if (action === "查看详情") {
        notify(ctx, `角色定义：\n${roleDetails(role)}`);
        return;
    }
    if (role.builtin) {
        notify(ctx, "内置角色不可编辑或删除。", "warning");
        return;
    }
    if (action === "编辑") {
        beginCustomWizard(pi, ctx, role);
        return;
    }
    if (action !== "删除")
        return;
    const confirmed = await ctx.ui.confirm("删除自定义角色", `确定删除「${role.label}」吗？`);
    if (!confirmed)
        return;
    const defs = getAllRoleDefs();
    const state = await readPersistedState(ctx, defs);
    const hasLiveInstance = Boolean(state?.roles.find((entry) => entry.key === role.key)?.instances.some((instance) => probePaneLive(instance.paneId, spawn)));
    if (!deleteCustomRoleDef(role.key)) {
        notify(ctx, `自定义角色「${role.label}」删除失败。`, "error");
        return;
    }
    notify(ctx, `自定义角色「${role.label}」已删除。`, "info");
    if (hasLiveInstance) {
        notify(ctx, "该角色面板保留但已脱离 team 管理。", "warning");
    }
}
function actionForArgs(args, options) {
    const trimmed = args.trim();
    if (!trimmed)
        return undefined;
    return options.find((option) => option === trimmed) ?? options.find((option) => option.startsWith(trimmed));
}
let pendingRoleWizard;
export function getPendingRoleWizard() {
    return pendingRoleWizard;
}
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
        if (part.type !== "text")
            return "";
        const text = part.text;
        return typeof text === "string" ? text : "";
    }).filter(Boolean).join("\n");
}
export function assistantMessageText(message) {
    return message && typeof message === "object" && message.role === "assistant"
        ? messageText(message)
        : "";
}
// \b 对 CJK 无效（中文标点不构成词边界），用显式前瞻限定取消词结尾
const WIZARD_CANCEL_PATTERN = /^(取消|算了|退出|放弃|cancel|stop)(?=$|[\s，。！？、,.!?;:：])/i;
export function handlePendingUserMessage(message) {
    if (!pendingRoleWizard)
        return false;
    if (!message || typeof message !== "object" || message.role !== "user")
        return false;
    if (pendingRoleWizard.ignoreNextUserMessage && pendingRoleWizard.requestText === messageText(message).trim()) {
        pendingRoleWizard.ignoreNextUserMessage = false;
        return false;
    }
    const text = messageText(message).trim();
    const ctx = pendingRoleWizard.ctx;
    const kind = pendingRoleWizard.kind;
    // transient：下一条 user 消息即取消（哨兵只等一条）。create/edit 是
    // 逐项问答——user 消息是回答，不是取消信号；只有显式取消词才终止
    // （review 终审新问题 1：否则用户答第一题向导就被判死）
    if (kind !== "transient" && !WIZARD_CANCEL_PATTERN.test(text)) {
        return false;
    }
    pendingRoleWizard = undefined;
    notify(ctx, kind === "transient" ? "临时角色未生成，已取消" : "角色向导已取消，未保存任何改动", "warning");
    return true;
}
export async function completePendingRole(role) {
    const pending = pendingRoleWizard;
    if (!pending)
        return false;
    if (pending.kind === "transient") {
        if (getRoleDef(role.key) || !pending.spawn) {
            notify(pending.ctx, `临时角色未创建：key ${role.key} 与现有角色冲突或面板通道不可用。`, "error");
            return false;
        }
        pendingRoleWizard = undefined;
        await openRolePanel(pending.ctx, { ...role, singleton: false, builtin: false }, pending.model, pending.spawn, { transient: true, prompt: role.promptTemplate, selectedTier: pending.tier });
        return true;
    }
    const existing = getRoleDef(role.key);
    if (existing && !(pending.kind === "edit" && pending.existingKey === role.key)) {
        notify(pending.ctx, `角色未保存：key ${role.key} 与现有角色「${existing.label}」冲突，请换一个 key。`, "error");
        return false;
    }
    if (!saveCustomRoleDef(role)) {
        notify(pending.ctx, "角色未保存：写入注册表失败，请检查 HAPILON_HOME 权限。", "error");
        return false;
    }
    if (pending.kind === "edit" && pending.existingKey && pending.existingKey !== role.key) {
        deleteCustomRoleDef(pending.existingKey);
    }
    pendingRoleWizard = undefined;
    notify(pending.ctx, pending.kind === "edit"
        ? `角色 ${role.label} 已更新，可在『打开面板』使用`
        : `角色 ${role.label} 已创建，可在『打开面板』使用`, "info");
    return true;
}
export async function handleTeamCommand(pi, args, ctx, spawn = defaultSpawn) {
    const defs = getAllRoleDefs();
    if (currentRole(defs)) {
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
    const persisted = await readPersistedState(ctx, defs);
    const enabled = Boolean(persisted && persisted.enabled && isTeamOwner(persisted, defs));
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
            await openReviewCompat(ctx, spawn, defs);
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
            beginCustomWizard(pi, ctx);
            break;
        case TEAM_ACTIONS.manage:
            await manageRoles(ctx, pi, spawn);
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
let probeCaches = new WeakMap();
function probePaneLive(paneId, spawn) {
    let probeCache = probeCaches.get(spawn);
    if (!probeCache) {
        probeCache = new Map();
        probeCaches.set(spawn, probeCache);
    }
    const cached = probeCache.get(paneId);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS)
        return cached.live;
    const live = Boolean(Effect.runSync(paneGet(paneId, spawn)));
    probeCache.set(paneId, { live, at: Date.now() });
    return live;
}
async function liveRoleEntries(state, spawn) {
    return state.roles.flatMap((entry) => {
        const instances = entry.instances.filter((instance) => probePaneLive(instance.paneId, spawn));
        return instances.length > 0 ? [{ ...entry, instances }] : [];
    });
}
export function resetProbeCache() {
    // WeakMap 无需逐个清理；替换引用即可让既有缓存全部失效。
    probeCaches = new WeakMap();
}
export async function updateTeamStatus(ctx, spawn = defaultSpawn) {
    const defs = getAllRoleDefs();
    if (currentRole(defs)) {
        ctx.ui.setStatus("team", undefined);
        return;
    }
    const state = await readEnabledState(ctx, defs);
    if (!state || !isTeamOwner(state, defs)) {
        ctx.ui.setStatus("team", undefined);
        return;
    }
    const liveRoles = await liveRoleEntries(state, spawn);
    const segments = liveRoles
        .map((entry) => `${entryLabel(entry, defs)} ${entry.instances.map((instance) => `${instance.paneId} ${probePaneLive(instance.paneId, spawn) ? "✓" : "✗"}`).join(" ")}`);
    const text = `Team mode on${segments.length > 0 ? ` · ${segments.join(" · ")}` : ""}`;
    const columns = process.stdout.columns ?? 80;
    const { truncateToWidth } = await import("@earendil-works/pi-tui");
    ctx.ui.setStatus("team", truncateToWidth(text, Math.max(20, Math.min(columns, 120))));
}
