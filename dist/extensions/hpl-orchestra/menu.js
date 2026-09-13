import { Effect } from "effect";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { agentGet, agentSendKeys, buildPaneRunCommand, defaultSpawn, paneAgentAlive, paneGet, paneRename, paneRun, paneSplit, paneSplitEnvArgs, paneWidths, resolveDiscussantModel, resolveRoleModel, resolveTierModelByTier, } from "./herdr.js";
import { deleteCustomRoleDef, getAllRoleDefs, getRoleDef, saveCustomRoleDef, } from "./role-registry.js";
import { buildTransientRolePrompt, buildWizardPrompt } from "./role-wizard.js";
import { currentRole, deleteTeamStateEffect, findRoleEntry, findTeamStateForPane, isTeamOwner, listTeamStates, readTeamStateEffect, resolveSessionStatePath, rolePromptPathFor, teamStateError, teamsDir, writeTeamStateEffect, } from "./state.js";
import { sampleAgentStateEffect } from "./agent-state.js";
const TRANSIENT_ROLE_OPTION = "临时角色（本次会话）";
export const TEAM_ACTIONS = {
    open: "打开面板",
    start: "开始编排",
    pause: "暂停编排",
    finish: "结束编排",
    kick: "踢出角色",
    disband: "解散团队",
    clear: "清空面板上下文",
    create: "创建自定义角色",
    manage: "管理自定义角色",
    dispatch: "派发给 Worker",
    view: "查看面板分工",
    resume: "接续主 agent 会话",
    takeover: "接管上一个团队",
};
/**
 * 菜单项：takeover / resume 是条件项（有可接管的旧团队、主 agent 会话与当前会话不一致时才出现）。
 * 解散与结束编排同列：结束只停编排、面板保留；解散连面板一起关。
 */
export function buildTeamMenuOptions(enabled, paused = false, extras = {}) {
    const own = enabled
        ? [
            TEAM_ACTIONS.open,
            TEAM_ACTIONS.pause,
            TEAM_ACTIONS.finish,
            TEAM_ACTIONS.kick,
            TEAM_ACTIONS.disband,
            TEAM_ACTIONS.clear,
            TEAM_ACTIONS.create,
            TEAM_ACTIONS.manage,
            TEAM_ACTIONS.dispatch,
            TEAM_ACTIONS.view,
        ]
        : paused
            ? [TEAM_ACTIONS.start, TEAM_ACTIONS.finish, TEAM_ACTIONS.kick, TEAM_ACTIONS.disband, TEAM_ACTIONS.view]
            : [TEAM_ACTIONS.start, TEAM_ACTIONS.open, TEAM_ACTIONS.manage, TEAM_ACTIONS.view];
    return [
        ...(extras.takeover ?? []),
        ...(extras.canResume ? [TEAM_ACTIONS.resume] : []),
        ...own,
    ];
}
function notify(ctx, message, type = "info") {
    ctx.ui.notify(message, type);
}
/** 写状态时盖 owner 身份：pane id + 主 agent 的 pi 会话文件（崩溃后 resume 的凭据）。 */
function ownerFor(ctx) {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId)
        return undefined;
    const session = ctx.sessionManager.getSessionFile();
    return session ? { paneId, session } : { paneId };
}
/** 状态文件写坏/来自旧版本时只提示一次：静默按未启用会让团队凭空消失。 */
let reportedStateIssue;
function reportStateIssue(ctx) {
    const issue = teamStateError();
    if (!issue || issue === reportedStateIssue)
        return;
    reportedStateIssue = issue;
    notify(ctx, `团队状态文件不可用：${issue}（${resolveSessionStatePath()}）`, "warning");
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
    reportStateIssue(ctx);
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
/** 拟人名池（owner 与角色共用）：短、字形差别大，窄边框里也能一眼分辨 */
const ROLE_NICKNAMES = ["阿岚", "阿澈", "小满", "小柚", "老白", "豆子", "麦子", "星野", "阿柯", "林子", "阿棠", "小鱼"];
/** 团队名两个词池随机拼（100×100）：不用正经，好玩就行 */
export const TEAM_NAME_HEADS = [
    "汪汪", "喵喵", "咕咕", "呱呱", "嗡嗡", "咩咩", "哞哞", "啾啾", "吱吱", "嘶嘶",
    "摸鱼", "熬夜", "打盹", "发呆", "划水", "摸黑", "早起", "加班", "躺平", "摆烂",
    "会飞的", "发光", "安静", "硬核", "极简", "滚烫", "冰镇", "咸鱼", "嘴硬", "心软",
    "赛博", "蒸汽", "量子", "像素", "机械", "电波", "晶片", "雷达", "磁场", "齿轮",
    "深空", "赤道", "极夜", "星尘", "月背", "北纬", "南极", "深海", "荒原", "沙丘",
    "泡面", "甜筒", "火锅", "奶茶", "汤圆", "月饼", "烤肉", "啤酒", "冰粉", "糖葫芦",
    "追风", "拧螺丝", "搬砖", "遛弯", "巡山", "赶海", "放羊", "砍价", "打铁", "漂流",
    "街角", "深夜", "午后", "雨天", "星期天", "地下室", "天台", "走廊", "阳台", "门厅",
    "苔藓", "竹子", "蘑菇", "仙人掌", "蒲公英", "芦苇", "藤蔓", "苔原", "松果", "麦浪",
    "泡泡", "橡皮", "弹簧", "魔方", "气球", "风筝", "纸飞机", "陀螺", "弹珠", "小黄鸭",
];
export const TEAM_NAME_TAILS = [
    "大队", "小队", "特工队", "突击队", "别动队", "游击队", "巡逻队", "搜救队", "消防队", "车队",
    "事务所", "研究所", "实验室", "工作室", "编辑室", "指挥部", "后勤部", "研发部", "管理局", "委员会",
    "联盟", "合作社", "互助会", "俱乐部", "同乡会", "读书会", "合唱团", "剧团", "乐队", "棋社",
    "茶水间", "放映厅", "食堂", "酒馆", "澡堂", "驿站", "码头", "车间", "工厂", "仓库",
    "小卖部", "便利店", "面馆", "烧烤摊", "糖水铺", "煎饼摊", "早餐店", "火锅店", "包子铺", "杂货铺",
    "五金店", "花店", "书店", "唱片行", "照相馆", "当铺", "钱庄", "邮局", "修车铺", "裁缝铺",
    "钟表店", "眼镜店", "理发店", "中医馆", "算命摊", "气象站", "天文台", "灯塔", "船坞", "车站",
    "月台", "隧道", "树屋", "蜂巢", "蚁穴", "鸟巢", "羊圈", "鸡舍", "鱼塘", "菜地",
    "果园", "麦田", "竹林", "松林", "湿地", "绿洲", "火山口", "陨石坑", "星系", "虫洞",
    "游乐园", "电影院", "台球厅", "游戏厅", "网吧", "树篱迷宫", "旋转木马", "摩天轮", "过山车", "碰碰车",
];
function randomTeamName() {
    const head = TEAM_NAME_HEADS[Math.floor(Math.random() * TEAM_NAME_HEADS.length)];
    const tail = TEAM_NAME_TAILS[Math.floor(Math.random() * TEAM_NAME_TAILS.length)];
    return `${head}${tail}`;
}
/** 这个团队已占用的拟人名（owner + 全部角色实例） */
function allNicknames(state) {
    return [state.owner.nickname, ...state.roles.flatMap((entry) => entry.instances.map((instance) => instance.nickname))];
}
/** 从池子里挑一个没人用过的拟人名；池子用完退化成编号，保证不重名 */
function nextNickname(taken) {
    const used = new Set(taken.filter((nickname) => Boolean(nickname)));
    return ROLE_NICKNAMES.find((nickname) => !used.has(nickname)) ?? `路人${used.size + 1}`;
}
/** 写状态前的身份收口：缺团队名就取一个、owner 缺拟人名就补一个（其余字段原样保留） */
function ensureIdentity(state) {
    const named = state.name ? state : { ...state, name: randomTeamName() };
    if (named.owner.nickname)
        return named;
    return { ...named, owner: { ...named.owner, nickname: nextNickname(allNicknames(named)) } };
}
/** owner pane 的 herdr 标签：`<owner 拟人名> · owner · <团队名>`——团队名挂在这里最显眼 */
function applyOwnerLabel(state, spawn) {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId || paneId !== state.owner.paneId)
        return;
    const label = [state.owner.nickname, "owner", state.name]
        .filter((part) => Boolean(part)).join(" · ");
    Effect.runSync(paneRename(paneId, label, spawn));
}
/** owner 写状态：收口身份，写完刷新 owner pane 标签 */
async function writeOwnerState(state, spawn) {
    const next = ensureIdentity(state);
    if (!await writeState(next))
        return false;
    applyOwnerLabel(next, spawn);
    return true;
}
/**
 * 角色 pane 的 herdr 标签：`拟人名 · 角色 key · 面板 id`——一排 pane 光看标题分不出谁是谁。
 * 创建/重灌时强制写；复用路径只补空标签，不覆盖用户手动改过的名字。
 */
function applyPaneLabel(paneId, key, nickname, spawn, options = {}) {
    if (options.onlyIfUnlabeled && Effect.runSync(paneGet(paneId, spawn))?.label)
        return;
    const short = paneId.replace(/^[^:]*:/, "");
    const label = [nickname, key, short].filter((part) => Boolean(part)).join(" · ");
    Effect.runSync(paneRename(paneId, label, spawn));
}
/** transient 角色 prompt 落盘：多行文本不上命令行，revive 按 pane id 找回。 */
function writeRolePromptFile(paneId, prompt) {
    const path = rolePromptPathFor(paneId);
    mkdirSync(teamsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(path, prompt);
    return path;
}
function removeRolePromptFile(paneId) {
    rmSync(rolePromptPathFor(paneId), { force: true });
}
/**
 * 把角色启动命令重灌进仍然存在的 pane（pi 崩了、只剩 shell 的场景）。
 * role/prompt 都随命令行自带（创建时落的 prompt 文件按 pane id 找回），
 * 不依赖 pane 里的残留 env。pane id 不变 → 状态不用改。
 */
async function revivePane(instance, roleKey, spawn) {
    const promptFile = rolePromptPathFor(instance.paneId);
    const command = buildPaneRunCommand(roleKey, resolveRoleModel(instance.model ?? undefined), existsSync(promptFile) ? promptFile : undefined);
    if (!Effect.runSync(paneRun(instance.paneId, command, spawn)))
        return false;
    return waitPaneReady(instance.paneId, spawn);
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
/** 老版本状态里的实例没有拟人名：复用/重灌时补一个并落盘，免得标签每次都不一样 */
async function adoptNickname(state, key, paneId) {
    const nickname = nextNickname(allNicknames(state));
    await writeState({
        ...state,
        roles: state.roles.map((entry) => entry.key !== key ? entry : {
            ...entry,
            instances: entry.instances.map((instance) => instance.paneId === paneId
                ? { ...instance, nickname }
                : instance),
        }),
    });
    return nickname;
}
/** 右列窄到这个宽度就没法看了 → 退化到「owner 下方再开一个」（用户可接受的最坏形态） */
const SPLIT_MIN_WIDTH = 40;
/**
 * 布局：第一块角色面板从 owner 右侧开（owner 永远独占左列），之后统一叠在右列最后一个下面，
 * 而不是每次都去切 owner 那一列。右列窄到 SPLIT_MIN_WIDTH 以下时退化成 owner 下方开一个。
 */
function planRoleSplit(state, spawn) {
    const live = (state?.roles ?? []).flatMap((entry) => entry.instances)
        .filter((instance) => Effect.runSync(paneAgentAlive(instance.paneId, spawn)));
    const last = live[live.length - 1];
    if (!last)
        return { direction: "right" };
    const width = Effect.runSync(paneWidths(spawn)).get(last.paneId) ?? 0;
    if (width > 0 && width < SPLIT_MIN_WIDTH)
        return { direction: "down" };
    return { target: last.paneId, direction: "down" };
}
async function ensurePane(ctx, role, model, spawn, options = {}, defs = getAllRoleDefs()) {
    const state = await readPersistedState(ctx, defs);
    const recorded = state ? findRoleEntry(state, role.key)?.instances ?? [] : [];
    if (role.singleton && state) {
        for (const instance of recorded) {
            // 复用判定用直连探活：TTL 缓存会把「刚关闭的面板」误判为存活
            // 最多 10s，导致复用提示错误且新档位无法应用（review-r3 N3）
            if (Effect.runSync(paneAgentAlive(instance.paneId, spawn))) {
                const nickname = instance.nickname ?? await adoptNickname(state, role.key, instance.paneId);
                applyPaneLabel(instance.paneId, role.key, nickname, spawn, { onlyIfUnlabeled: true });
                return { paneId: instance.paneId, model: instance.model, reused: true, nickname };
            }
            // pane 还在但 agent 已经不在（pi 崩溃/退出）：原地重灌角色命令，而不是
            // 谎报「已在运行」或另开新面板留下孤儿（review D1）
            if (Effect.runSync(paneGet(instance.paneId, spawn)) && await revivePane(instance, role.key, spawn)) {
                const nickname = instance.nickname ?? nextNickname(allNicknames(state));
                applyPaneLabel(instance.paneId, role.key, nickname, spawn);
                notify(ctx, `${role.label} 面板 ${instance.paneId} 里的 agent 已不在，已在该 pane 重灌角色命令。`, "warning");
                return { paneId: instance.paneId, model: instance.model, reused: false, nickname };
            }
        }
    }
    const paneId = Effect.runSync(paneSplit(ctx.cwd, spawn, paneSplitEnvArgs(), planRoleSplit(state, spawn)));
    if (!paneId)
        return undefined;
    const promptFile = options.prompt ? writeRolePromptFile(paneId, options.prompt) : undefined;
    // 创建路径存的可能是具体 id（tier 改了不传播）或 tier:name[i] 指代；
    // 统一在 spawn 时解析，档位表变更后下次开面板即生效。
    const resolvedModel = resolveRoleModel(model);
    const command = buildPaneRunCommand(role.key, resolvedModel, promptFile);
    if (!Effect.runSync(paneRun(paneId, command, spawn))) {
        Effect.runSync(runPaneClose(paneId, spawn));
        removeRolePromptFile(paneId);
        notify(ctx, `${role.label} 面板启动失败（herdr pane run 未成功）。`, "error");
        return undefined;
    }
    if (!await waitPaneReady(paneId, spawn)) {
        Effect.runSync(runPaneClose(paneId, spawn));
        removeRolePromptFile(paneId);
        notify(ctx, `${role.label} 面板启动后未就绪，已回收面板。`, "error");
        return undefined;
    }
    const nickname = nextNickname(state ? allNicknames(state) : []);
    applyPaneLabel(paneId, role.key, nickname, spawn);
    return { paneId, model: resolvedModel ?? null, reused: false, nickname };
}
function emptyState(owner, enabled) {
    return {
        enabled,
        since: new Date().toISOString(),
        owner,
        roles: [],
        name: randomTeamName(),
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
    const base = previous ?? emptyState(ownerFor(ctx) ?? { paneId: ownerPaneId }, !options.transient);
    const next = {
        ...base,
        // 临时角色可在未启用 Team 时存在；结束编排会随状态文件消失。
        enabled: previous?.enabled ?? !options.transient,
        owner: ownerFor(ctx) ?? { paneId: ownerPaneId },
        roles: await appendRoleInstance(base.roles, role, {
            paneId: created.paneId,
            model: created.model,
            ...(created.nickname ? { nickname: created.nickname } : {}),
            ...(options.transient ? { transient: true } : {}),
        }, spawn),
    };
    const saved = await writeOwnerState(next, spawn);
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
    const base = previous ?? emptyState(ownerFor(ctx) ?? { paneId: ownerPane }, true);
    const next = {
        ...base,
        enabled: true,
        owner: ownerFor(ctx) ?? { paneId: ownerPane },
        roles: await appendRoleInstance(base.roles, worker, {
            paneId: result.paneId,
            model: result.model,
            ...(result.nickname ? { nickname: result.nickname } : {}),
        }, spawn),
    };
    const saved = await writeOwnerState(next, spawn);
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
    const liveRoles = state.roles.filter((entry) => entry.instances.length > 0);
    // 回执路径需要当前任务目录，team 状态里没有这项；probe 不传 → done 在面板上
    // 不可达（宁可少报，不靠猜目录误报 done）。
    const roleLines = await Promise.all(liveRoles.map(async (entry) => {
        const panes = await Promise.all(entry.instances.map(async (instance) => `${instance.paneId}: ${await Effect.runPromise(sampleAgentStateEffect(instance.paneId, { spawn }))}`));
        return `${entryLabel(entry, defs)}：${panes.join(" ")}`;
    }));
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
async function pause(ctx, spawn) {
    const defs = getAllRoleDefs();
    const state = await readEnabledState(ctx, defs);
    if (!state || !isTeamOwner(state, defs)) {
        notify(ctx, "当前没有可暂停的编排。", "warning");
        return;
    }
    const saved = await writeOwnerState({ ...state, enabled: false, owner: ownerFor(ctx) ?? state.owner }, spawn);
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
async function resumeOwnerSession(ctx, state) {
    const target = state.owner.session;
    if (!target) {
        notify(ctx, "这个团队没有记录主 agent 会话，无法接续。", "warning");
        return;
    }
    if (ctx.sessionManager.getSessionFile() === target) {
        notify(ctx, "当前已经是主 agent 会话，无需接续。");
        return;
    }
    if (!existsSync(target)) {
        notify(ctx, `主 agent 会话文件不存在：${target}`, "error");
        return;
    }
    await ctx.waitForIdle();
    // switchSession 之后旧 ctx 失效，后续动作必须在 withSession 给的 ctx 上做
    const result = await ctx.switchSession(target, {
        withSession: async (next) => {
            next.ui.notify(`已接续主 agent 会话：${target}`, "info");
        },
    });
    if (result.cancelled)
        notify(ctx, "接续会话被取消。", "warning");
}
/** 可接管的旧团队：owner 已经不再有 agent（pane 关了或只剩 shell），且不是我自己那个状态文件。 */
function takeoverCandidates(myPath, spawn) {
    return listTeamStates().filter((entry) => entry.path !== myPath
        && entry.state.enabled
        && !Effect.runSync(paneAgentAlive(entry.state.owner.paneId, spawn)));
}
function takeoverLabel(candidate) {
    return `接管 ${candidate.state.owner.paneId} 的团队`;
}
async function takeoverTeam(ctx, spawn, candidate) {
    const owner = ownerFor(ctx);
    if (!owner) {
        notify(ctx, "无法接管：当前 herdr 面板缺少 HERDR_PANE_ID。", "error");
        return;
    }
    const formerOwner = candidate.state.owner.paneId;
    const target = candidate.state.owner.session;
    const resumable = Boolean(target && existsSync(target));
    const next = { ...candidate.state, owner: resumable ? { paneId: owner.paneId, session: target } : owner };
    if (!await writeOwnerState(next, spawn)) {
        notify(ctx, "接管失败：团队状态保存失败。", "error");
        return;
    }
    // 同一批角色 pane 不能被两个 owner 同时认领（角色 pane 靠扫盘找归属）
    await Effect.runPromise(deleteTeamStateEffect(candidate.path));
    const live = next.roles.flatMap((entry) => entry.instances)
        .filter((instance) => Effect.runSync(paneAgentAlive(instance.paneId, spawn))).length;
    notify(ctx, `已接管 ${formerOwner} 的团队：${live} 个角色面板归队。`);
    if (resumable)
        await resumeOwnerSession(ctx, next);
    else
        notify(ctx, "原主面板没有可用会话记录，未接续会话（可用 /resume 手动挑）。", "warning");
}
/** 解散 = 结束编排 + 关闭该团队全部角色面板（含只剩 shell 的僵死 pane）。 */
async function disband(ctx, spawn) {
    const defs = getAllRoleDefs();
    const state = await readPersistedState(ctx, defs);
    if (!state || !isTeamOwner(state, defs)) {
        notify(ctx, "当前没有可解散的团队。", "warning");
        return;
    }
    const instances = state.roles.flatMap((entry) => entry.instances);
    const livePaneIds = instances
        .filter((instance) => Effect.runSync(paneAgentAlive(instance.paneId, spawn)))
        .map((instance) => instance.paneId);
    const confirmed = await ctx.ui.confirm("解散团队", livePaneIds.length > 0
        ? `将结束编排并关闭 ${livePaneIds.length} 个角色面板（${livePaneIds.join(" ")}），确定？`
        : "将结束编排（当前没有存活的角色面板），确定？");
    if (!confirmed)
        return;
    // 先全查再动手：有一个在干活的 pane 就整体放弃，避免只关掉一半
    for (const paneId of livePaneIds) {
        if (Effect.runSync(agentGet(paneId, spawn)) === "working") {
            notify(ctx, `${paneId} 正在工作中，等它完成后重试。`, "warning");
            return;
        }
    }
    const deleted = await Effect.runPromise(deleteTeamStateEffect(resolveSessionStatePath()));
    let closed = 0;
    for (const paneId of livePaneIds) {
        if (Effect.runSync(runPaneClose(paneId, spawn)))
            closed++;
    }
    notify(ctx, `团队已解散：关闭 ${closed}/${livePaneIds.length} 个角色面板${deleted ? "" : "（状态文件本就不存在）"}。`);
}
/** /team:open <key>：用角色默认档直接开/救活——这是主 agent 自愈路径，不能卡在档位对话框上等人。 */
async function openRoleByKey(ctx, spawn, key) {
    const defs = getAllRoleDefs();
    const role = getRoleDef(key, defs);
    if (!role) {
        notify(ctx, `没有 key 为 ${key} 的角色。`, "error");
        return;
    }
    await openRolePanel(ctx, role, modelForTier(role, role.defaultTier, ownerProvider(ctx)), spawn);
}
/** 单个实例的菜单标签：临时角色不写注册表，按 "临时" 展示 */
function instanceLabel(entry, instance, defs) {
    return `${instance.transient ? "临时" : roleLabel(entry.key, defs)}（${instance.paneId}）`;
}
/**
 * 踢出角色面板：从团队状态里摘掉实例并关掉对应 pane（角色定义保留，可再 /team:open 拉回来）。
 * selector 为空走菜单选择（带确认）；给 key 踢该角色全部实例，给 pane id 只踢那一个。
 */
async function kickRoles(ctx, spawn, selector, defs) {
    const state = await readPersistedState(ctx, defs);
    if (!state || !isTeamOwner(state, defs)) {
        notify(ctx, "当前没有可管理的团队。", "warning");
        return;
    }
    const targets = state.roles
        .flatMap((entry) => entry.instances.map((instance) => ({ entry, instance })))
        .filter(({ entry, instance }) => selector === undefined
        ? true
        : entry.key === selector || instance.paneId === selector);
    const labeled = targets.map(({ entry, instance }) => ({ entry, instance, label: instanceLabel(entry, instance, defs) }));
    if (labeled.length === 0) {
        notify(ctx, selector === undefined ? "当前没有可踢出的角色面板。" : `没有匹配 ${selector} 的角色面板。`, "warning");
        return;
    }
    let chosen = labeled;
    if (selector === undefined) {
        const selected = await ctx.ui.select("踢出哪个角色面板？", labeled.map(({ label }) => label));
        if (!selected)
            return;
        chosen = labeled.filter(({ label }) => label === selected);
        const confirmed = await ctx.ui.confirm("踢出角色面板", `将关闭 ${chosen.map(({ instance }) => instance.paneId).join(" ")} 并移出团队（角色定义保留），确定？`);
        if (!confirmed)
            return;
    }
    // 先全查再动手：有 pane 在干活就整体放弃，不留下关一半的状态
    for (const { instance } of chosen) {
        if (Effect.runSync(paneAgentAlive(instance.paneId, spawn))
            && Effect.runSync(agentGet(instance.paneId, spawn)) === "working") {
            notify(ctx, `${instance.paneId} 正在工作中，等它完成后重试。`, "warning");
            return;
        }
    }
    const kicked = new Set(chosen.map(({ instance }) => instance.paneId));
    // 实例清空的条目整体删掉：非注册表 key（自定义/临时）留空实例会让整个状态文件校验不过，
    // 团队会被静默当成「未启用」。注册表角色不靠条目也在 crew 表里（由 defs 生成）。
    const roles = state.roles.flatMap((entry) => {
        const kept = entry.instances.filter((instance) => !kicked.has(instance.paneId));
        return kept.length > 0 ? [{ ...entry, instances: kept }] : [];
    });
    if (!await writeState({ ...state, roles })) {
        notify(ctx, "踢出失败：团队状态保存失败。", "error");
        return;
    }
    let closed = 0;
    for (const { instance } of chosen) {
        if (Effect.runSync(paneGet(instance.paneId, spawn)) && Effect.runSync(runPaneClose(instance.paneId, spawn)))
            closed++;
    }
    notify(ctx, `已踢出 ${chosen.map(({ instance }) => instance.paneId).join(" ")}（关闭 ${closed}/${chosen.length} 个面板，角色定义保留）。`);
}
export async function handleTeamCommand(pi, args, ctx, spawn = defaultSpawn) {
    const defs = getAllRoleDefs();
    // 菜单侧与 prompt 侧同一条不变量（assemble.ts review-r3 N2）：HAPI_ORCH_ROLE 非空
    // 的面板永远是角色面板、只读——哪怕它的角色定义与状态都已不在，也不能退回主面板权限。
    if (process.env.HAPI_ORCH_ROLE) {
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
    // /team:open <key> / /team:kick <key|paneId> 走这两条：角色 pane 之外才允许动 team
    const openKey = /^打开角色\s+(\S+)$/.exec(args.trim());
    if (openKey) {
        await openRoleByKey(ctx, spawn, openKey[1]);
        return;
    }
    const kickTarget = /^踢出角色\s+(\S+)$/.exec(args.trim());
    if (kickTarget) {
        await kickRoles(ctx, spawn, kickTarget[1], defs);
        return;
    }
    const persisted = await readPersistedState(ctx, defs);
    const enabled = Boolean(persisted && persisted.enabled && isTeamOwner(persisted, defs));
    const candidates = persisted ? [] : takeoverCandidates(resolveSessionStatePath(), spawn);
    const canResume = Boolean(persisted?.owner.session && persisted.owner.session !== ctx.sessionManager.getSessionFile());
    const options = buildTeamMenuOptions(enabled, Boolean(persisted && !persisted.enabled), {
        takeover: candidates.map(takeoverLabel),
        canResume,
    });
    const requested = args.trim();
    const explicit = requested ? actionForArgs(args, Object.values(TEAM_ACTIONS)) : undefined;
    const action = explicit ?? await ctx.ui.select("Team 编排", options);
    // 接管项是动态标签（带 owner pane id），菜单选中与显式传参两种来源都要认出来
    const candidate = candidates.find((entry) => takeoverLabel(entry) === action)
        ?? (requested ? candidates.find((entry) => takeoverLabel(entry).startsWith(requested)) : undefined);
    if (candidate) {
        await takeoverTeam(ctx, spawn, candidate);
        return;
    }
    if (!action)
        return;
    switch (action) {
        case TEAM_ACTIONS.start:
            await startOrchestration(ctx, spawn);
            break;
        case TEAM_ACTIONS.open:
            await openPanel(pi, ctx, spawn);
            break;
        case TEAM_ACTIONS.pause:
            await pause(ctx, spawn);
            break;
        case TEAM_ACTIONS.finish:
            await finish(ctx);
            break;
        case TEAM_ACTIONS.kick:
            await kickRoles(ctx, spawn, undefined, defs);
            break;
        case TEAM_ACTIONS.disband:
            await disband(ctx, spawn);
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
        case TEAM_ACTIONS.resume:
            if (persisted)
                await resumeOwnerSession(ctx, persisted);
            break;
        case TEAM_ACTIONS.takeover:
            notify(ctx, "没有可接管的团队。", "warning");
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
    const live = Effect.runSync(paneAgentAlive(paneId, spawn));
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
