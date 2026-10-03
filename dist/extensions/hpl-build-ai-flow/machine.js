/**
 * machine.ts — 状态机：state.json 读写、迁移、Gate 机械评估
 *
 * 单会话假设（设计 §5）：流程设计为一次会话内从 S0 走到 freeze，
 * 不设跨会话恢复迁移；意外中断后文件仍在，goto 可手工续走。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { GATE_MARKERS, LAST_STAGE, stageByIndex, STALE_EXEMPT, STAGES } from "./stages.js";
// ─── typed errors ────────────────────────────────────────────────────
export class FlowStateError extends Data.TaggedError("FlowStateError") {
}
/** 已知能力 id（不建通用插件框架，抽象止于真实能力） */
export const KNOWN_CAPABILITIES = ["golden-case"];
export function openDebts(state) {
    return state.debts.filter((d) => !d.resolvedAt);
}
/** 冻结闸门：scale.md 覆盖盘点中，未实现/部分项必须有去向拍板，acceptance 逐条必须在表；返回违规行（空=通过）。无覆盖盘点小节由 S8 Gate 标记拦截，此处不重复报 */
export function coverageDispositionGaps(cwd, slug, acceptance = []) {
    const content = readFileOrNull(join(flowDir(cwd, slug), "scale.md"));
    if (content === null)
        return [];
    const gaps = [];
    const lines = content.split("\n");
    const section = [];
    let inCoverage = false;
    for (const line of lines) {
        if (/覆盖盘点/.test(line)) {
            inCoverage = true;
            continue;
        }
        if (inCoverage && /^#{1,3} /.test(line))
            break; // 覆盖盘点小节结束
        if (!inCoverage)
            continue;
        section.push(line);
        if (!/❌|未实现|◐/.test(line))
            continue;
        if (!/拍板|D-\d{2,3}|用户裁决/.test(line))
            gaps.push(line.trim());
    }
    const sectionText = section.join("\n");
    for (const item of acceptance) {
        if (!sectionText.includes(item))
            gaps.push(`验收要点未入覆盖盘点表：${item}`);
    }
    return gaps;
}
// ─── 路径 ────────────────────────────────────────────────────────────
export function aiFlowRoot(cwd) {
    return join(cwd, ".hapilon", "ai-flow");
}
export function flowDir(cwd, slug) {
    return join(aiFlowRoot(cwd), slug);
}
export function statePath(cwd, slug) {
    return join(flowDir(cwd, slug), "state.json");
}
export function activePath(cwd) {
    return join(aiFlowRoot(cwd), "active.json");
}
// ─── pending start（slug 提炼前的目标暂存，单槽位，重复 start 以最后一次为准） ──────
export function pendingPath(cwd) {
    return join(aiFlowRoot(cwd), ".pending-start.json");
}
export function savePendingGoal(cwd, goal) {
    mkdirSync(aiFlowRoot(cwd), { recursive: true });
    writeFileSync(pendingPath(cwd), JSON.stringify({ goal }), "utf-8");
}
/** 取走暂存目标（读后即删）；无暂存返回 null，文件损坏则抛错不吞 */
export function takePendingGoal(cwd) {
    const path = pendingPath(cwd);
    if (!existsSync(path))
        return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    rmSync(path, { force: true });
    return typeof raw.goal === "string" && raw.goal !== "" ? raw.goal : null;
}
/** base 撞已有 flow 时加 -2/-3 序号；不覆盖旧盘 */
export function uniqueSlug(cwd, base) {
    let slug = base;
    for (let n = 2; existsSync(statePath(cwd, slug)); n++)
        slug = `${base}-${n}`;
    return slug;
}
// ─── 读写 ────────────────────────────────────────────────────────────
function parseState(raw, path) {
    let parsedJson;
    try {
        parsedJson = JSON.parse(raw);
    }
    catch (error) {
        throw new FlowStateError({
            message: `${path} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）。若文件被截断，可参考同目录产物手工修复`,
        });
    }
    if (typeof parsedJson !== "object" || parsedJson === null) {
        throw new FlowStateError({ message: `${path} 顶层不是对象，请人工检查` });
    }
    const s = parsedJson;
    // 机器控制字段 fail closed；展示字段（name/goal/时间戳）fail soft
    if (s.version !== undefined && s.version !== 1) {
        throw new FlowStateError({ message: `${path} 的 state version ${String(s.version)} 不受支持（当前支持 1）——可能由更新版本的 hapilon 写入` });
    }
    if (typeof s.slug !== "string" || s.slug === "") {
        throw new FlowStateError({ message: `${path} 缺 slug 字段，请人工检查` });
    }
    if (typeof s.stage !== "number" || !Number.isInteger(s.stage) || s.stage < 0 || s.stage > LAST_STAGE) {
        throw new FlowStateError({ message: `${path} 的 stage 非法：${String(s.stage)}（合法 0..${LAST_STAGE}）` });
    }
    if (s.status !== "active" && s.status !== "frozen") {
        throw new FlowStateError({
            message: `${path} 的 status 非法："${String(s.status)}"（合法 active | frozen）。请手工修正后重试`,
        });
    }
    if (!Array.isArray(s.history)) {
        throw new FlowStateError({ message: `${path} 的 history 不是数组——状态审计数据损坏，请人工检查` });
    }
    for (const [i, h] of s.history.entries()) {
        if (typeof h !== "object" || h === null || typeof h.kind !== "string") {
            throw new FlowStateError({ message: `${path} 的 history[${i}] 缺 kind 字段，请人工检查` });
        }
    }
    const debts = Array.isArray(s.debts)
        ? s.debts.flatMap((d) => {
            if (typeof d !== "object" || d === null)
                return [];
            const r = d;
            if (typeof r.id !== "string" || typeof r.stage !== "number" || !Array.isArray(r.gaps))
                return [];
            return [{
                    id: r.id,
                    stage: r.stage,
                    gaps: r.gaps.map(String),
                    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
                    ...(typeof r.resolvedAt === "string" ? { resolvedAt: r.resolvedAt } : {}),
                    ...(typeof r.resolution === "string" ? { resolution: r.resolution } : {}),
                }];
        })
        : [];
    let stale = null;
    if (s.stale !== undefined && s.stale !== null) {
        const t = s.stale;
        if (typeof t.from !== "number" ||
            !Number.isInteger(t.from) ||
            t.from < 0 ||
            t.from > LAST_STAGE ||
            typeof t.at !== "string") {
            throw new FlowStateError({ message: `${path} 的 stale 字段非法（应为 {from: 0..${LAST_STAGE}, at} 或 null），请人工检查` });
        }
        stale = { from: t.from, at: t.at };
    }
    const capabilities = {};
    if (s.capabilities !== undefined) {
        if (typeof s.capabilities !== "object" || s.capabilities === null || Array.isArray(s.capabilities)) {
            throw new FlowStateError({ message: `${path} 的 capabilities 非法（应为对象），请人工检查` });
        }
        for (const [id, v] of Object.entries(s.capabilities)) {
            if (!KNOWN_CAPABILITIES.includes(id)) {
                throw new FlowStateError({ message: `${path} 含未知能力 id「${id}」（已知：${KNOWN_CAPABILITIES.join("、")}）` });
            }
            if (typeof v !== "object" || v === null) {
                throw new FlowStateError({ message: `${path} 的 capabilities.${id} 非法，请人工检查` });
            }
            const r = v;
            if (r.status !== "enabled" && r.status !== "declined") {
                throw new FlowStateError({ message: `${path} 的 capabilities.${id}.status 非法："${String(r.status)}"（合法 enabled | declined）` });
            }
            if (r.enabledAtStage !== undefined &&
                (typeof r.enabledAtStage !== "number" || !Number.isInteger(r.enabledAtStage) || r.enabledAtStage < 0 || r.enabledAtStage > LAST_STAGE)) {
                throw new FlowStateError({ message: `${path} 的 capabilities.${id}.enabledAtStage 非法：${String(r.enabledAtStage)}` });
            }
            capabilities[id] = {
                status: r.status,
                ...(typeof r.enabledAtStage === "number" ? { enabledAtStage: r.enabledAtStage } : {}),
                ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
            };
        }
    }
    return {
        version: 1,
        slug: s.slug,
        name: typeof s.name === "string" ? s.name : s.slug,
        goal: typeof s.goal === "string" ? s.goal : "",
        goalStatement: typeof s.goalStatement === "string" && s.goalStatement !== "" ? s.goalStatement : null,
        acceptance: Array.isArray(s.acceptance) ? s.acceptance.filter((a) => typeof a === "string" && a !== "") : [],
        status: s.status,
        stage: s.stage,
        createdAt: typeof s.createdAt === "string" ? s.createdAt : "",
        updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "",
        history: s.history,
        debts,
        stale,
        capabilities,
    };
}
export const loadFlowEffect = (cwd, slug) => Effect.try({
    try: () => parseState(readFileSync(statePath(cwd, slug), "utf-8"), statePath(cwd, slug)),
    catch: (error) => new FlowStateError({ message: `读取 ${statePath(cwd, slug)} 失败：${String(error)}` }),
});
/** 控制面原子写：同目录临时文件 → rename。失败清理 temp，原文件不被半截 JSON 替换 */
export function writeFileAtomic(path, content) {
    const tmp = `${path}.tmp`;
    try {
        writeFileSync(tmp, content, "utf-8");
        renameSync(tmp, path);
    }
    catch (error) {
        try {
            rmSync(tmp, { force: true });
        }
        catch {
            /* 清理尽力而为 */
        }
        throw error;
    }
}
function writeFlow(cwd, state) {
    const dir = flowDir(cwd, state.slug);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileAtomic(statePath(cwd, state.slug), `${JSON.stringify(state, null, 2)}\n`);
}
export const readActiveEffect = (cwd) => Effect.try({
    try: () => {
        const path = activePath(cwd);
        if (!existsSync(path))
            return null;
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        const slug = parsed.slug;
        return typeof slug === "string" && slug !== "" ? slug : null;
    },
    catch: (error) => new FlowStateError({ message: `读取 ${activePath(cwd)} 失败：${String(error)}` }),
});
export function writeActive(cwd, slug) {
    const root = aiFlowRoot(cwd);
    if (!existsSync(root))
        mkdirSync(root, { recursive: true });
    writeFileAtomic(activePath(cwd), `${JSON.stringify({ slug }, null, 2)}\n`);
}
export const listFlowsEffect = (cwd) => Effect.gen(function* () {
    const root = aiFlowRoot(cwd);
    if (!existsSync(root))
        return [];
    const out = [];
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory())
            continue;
        const state = yield* loadFlowEffect(cwd, entry.name).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!state)
            continue;
        out.push({ slug: state.slug, stage: state.stage, status: state.status, goal: state.goal, updatedAt: state.updatedAt });
    }
    return out;
});
// ─── 迁移 ────────────────────────────────────────────────────────────
function append(state, entry) {
    return {
        ...state,
        stage: entry.to,
        updatedAt: new Date().toISOString(),
        history: [...state.history, entry],
    };
}
export const startFlowEffect = (cwd, slug, name, goal) => Effect.gen(function* () {
    if (slug === "")
        return yield* new FlowStateError({ message: "slug 不能为空" });
    if (existsSync(statePath(cwd, slug))) {
        return yield* new FlowStateError({
            message: `flow「${slug}」已存在。机器状态与产物全在磁盘，不依赖会话：续走用 /build-ai-flow goto <阶段> <原因>，或 hapi 会话 resume 恢复对话上下文；开新任务请换名`,
        });
    }
    const now = new Date().toISOString();
    const state = {
        version: 1,
        slug,
        name: name || slug,
        goal,
        status: "active",
        stage: 0,
        createdAt: now,
        updatedAt: now,
        history: [{ kind: "start", to: 0, at: now }],
        debts: [],
        stale: null,
        capabilities: {},
        goalStatement: null,
        acceptance: [],
    };
    writeFlow(cwd, state);
    writeActive(cwd, slug);
    return state;
});
/**
 * next 的推进逻辑：gate 过 → advance（S9 过 → freeze）；gate 不过 → needs-confirm，
 * 由命令层 confirm 后调 forceAdvance。人不点头不推进。
 */
export const advanceFlowEffect = (cwd, slug) => Effect.gen(function* () {
    let state = yield* loadFlowEffect(cwd, slug);
    if (state.status === "frozen")
        return { kind: "frozen", state };
    const gate = evaluateGate(cwd, slug, state.stage, state.stale, state.capabilities);
    if (!gate.passed)
        return { kind: "needs-confirm", state, gaps: gate.failures };
    if (state.stage === LAST_STAGE) {
        // 两阶段提交：这里只报「可冻结」，不写盘——审查/确认后的提交在 freezeFlowEffect
        return { kind: "ready-to-freeze", state };
    }
    state = append(state, { kind: "advance", from: state.stage, to: state.stage + 1, at: new Date().toISOString() });
    state = advanceStale(state, state.stage - 1);
    writeFlow(cwd, state);
    return { kind: "advanced", state };
});
function nextDebtId(state) {
    const max = state.debts.reduce((m, d) => Math.max(m, Number.parseInt(d.id.replace(/^G-/, ""), 10) || 0), 0);
    return `G-${String(max + 1).padStart(3, "0")}`;
}
function addDebt(state, stage, gaps, now) {
    return { ...state, debts: [...state.debts, { id: nextDebtId(state), stage, gaps, createdAt: now }] };
}
/** 刚通过 passedStage 的 Gate 后滚动 stale 起点；越过末尾清除。保留原 at——重存时间只需晚于原始回退时刻 */
function advanceStale(state, passedStage) {
    if (!state.stale || state.stale.from > passedStage)
        return state;
    const from = passedStage + 1;
    return from > LAST_STAGE ? { ...state, stale: null } : { ...state, stale: { ...state.stale, from } };
}
export const forceAdvanceEffect = (cwd, slug, gaps) => Effect.gen(function* () {
    let state = yield* loadFlowEffect(cwd, slug);
    if (state.status === "frozen")
        return { kind: "advanced", state };
    if (state.stage === LAST_STAGE)
        return { kind: "ready-to-freeze", state, gaps };
    const now = new Date().toISOString();
    const from = state.stage;
    state = append(state, { kind: "force", from, to: from + 1, gaps, at: now });
    state = addDebt(state, from, gaps, now);
    state = advanceStale(state, from);
    writeFlow(cwd, state);
    return { kind: "advanced", state };
});
/** 能力启用/拒绝：唯一写入口，只由 cap 命令（人）触发；翻转是真实用户决策，单条目覆盖 + history 留痕 */
/** S2 拍板写回：定位句 + 验收要点清单。唯一写入口是 /build-ai-flow goal（人拍板），history 留痕 kind=goal-set */
export const setGoalEffect = (cwd, slug, goalStatement, acceptance) => Effect.gen(function* () {
    if (goalStatement.trim() === "") {
        return yield* new FlowStateError({ message: "定位句不能为空：/build-ai-flow goal <定位句>（换行后每行一条验收要点）" });
    }
    let state = yield* loadFlowEffect(cwd, slug);
    const now = new Date().toISOString();
    state = {
        ...state,
        goalStatement: goalStatement.trim(),
        acceptance,
    };
    state = append(state, {
        kind: "goal-set",
        to: state.stage,
        reason: `定位句：${goalStatement.trim()}｜验收要点 ${acceptance.length} 条`,
        at: now,
    });
    writeFlow(cwd, state);
    return state;
});
export const setCapabilityEffect = (cwd, slug, id, status, reason) => Effect.gen(function* () {
    if (!KNOWN_CAPABILITIES.includes(id)) {
        return yield* new FlowStateError({ message: `未知能力「${id}」（已知：${KNOWN_CAPABILITIES.join("、")}）` });
    }
    let state = yield* loadFlowEffect(cwd, slug);
    const now = new Date().toISOString();
    const entry = {
        status,
        ...(status === "enabled" ? { enabledAtStage: state.stage } : {}),
        ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
    };
    state = {
        ...state,
        capabilities: { ...state.capabilities, [id]: entry },
    };
    state = append(state, {
        kind: status === "enabled" ? "cap-enable" : "cap-decline",
        to: state.stage,
        reason: reason.trim() !== "" ? reason.trim() : `${id} ${status === "enabled" ? "启用" : "拒绝"}`,
        at: now,
    });
    writeFlow(cwd, state);
    return state;
});
/** 显式关闭 debt：不自动猜测，人确认补齐后才调用 */
export const resolveDebtEffect = (cwd, slug, id, resolution) => Effect.gen(function* () {
    if (resolution.trim() === "") {
        return yield* new FlowStateError({ message: "resolve 必须带说明：/build-ai-flow debt resolve <id> <说明>" });
    }
    let state = yield* loadFlowEffect(cwd, slug);
    const debt = openDebts(state).find((d) => d.id === id.trim());
    if (!debt) {
        const open = openDebts(state).map((d) => d.id).join("、") || "无";
        return yield* new FlowStateError({ message: `未找到未关闭的 debt ${id}（当前未关闭：${open}）` });
    }
    const now = new Date().toISOString();
    state = {
        ...state,
        debts: state.debts.map((d) => d.id === debt.id ? { ...d, resolvedAt: now, resolution: resolution.trim() } : d),
    };
    state = append(state, { kind: "debt-resolve", to: state.stage, reason: `${debt.id} 已关闭：${resolution.trim()}`, at: now });
    writeFlow(cwd, state);
    return state;
});
/** freeze 的唯一提交点：append freeze history + status=frozen + 落盘。幂等。S9 强推缺口统一入 debt。 */
export const freezeFlowEffect = (cwd, slug, forceGaps) => Effect.gen(function* () {
    let state = yield* loadFlowEffect(cwd, slug);
    if (state.status === "frozen")
        return state;
    const now = new Date().toISOString();
    state = append(state, { kind: "freeze", from: LAST_STAGE, to: LAST_STAGE, at: now });
    if (forceGaps && forceGaps.length > 0)
        state = addDebt(state, LAST_STAGE, forceGaps, now);
    state = advanceStale(state, LAST_STAGE);
    state = { ...state, status: "frozen" };
    writeFlow(cwd, state);
    return state;
});
export const gotoStageEffect = (cwd, slug, target, reason) => Effect.gen(function* () {
    if (reason.trim() === "") {
        return yield* new FlowStateError({ message: "goto 必须带原因：/build-ai-flow goto <0-9> <原因>（任意阶段导航，原因留痕）" });
    }
    if (target < 0 || target > LAST_STAGE) {
        return yield* new FlowStateError({ message: `阶段号 ${target} 越界（0..${LAST_STAGE}）` });
    }
    let state = yield* loadFlowEffect(cwd, slug);
    const wasFrozen = state.status === "frozen";
    const kind = wasFrozen
        ? "reopen"
        : target > state.stage
            ? "skip"
            : target < state.stage
                ? "regress"
                : "revisit";
    state = append(state, { kind, from: state.stage, to: target, reason: reason.trim(), at: new Date().toISOString() });
    if (wasFrozen)
        state = { ...state, status: "active" };
    // 回退（regress，或 frozen reopen 到更早阶段）→ 目标之后的阶段产物进入待重确认（stale）；保留更早的标记点
    const wentBack = kind === "regress" || (wasFrozen && target < LAST_STAGE);
    if (wentBack && target + 1 <= LAST_STAGE) {
        state = {
            ...state,
            stale: state.stale
                ? { from: Math.min(state.stale.from, target + 1), at: new Date().toISOString() }
                : { from: target + 1, at: new Date().toISOString() },
        };
    }
    writeFlow(cwd, state);
    writeActive(cwd, slug);
    return state;
});
// ─── Gate 机械评估 ──────────────────────────────────────────────────
const MIN_CHARS = 30;
function readFileOrNull(path) {
    if (!existsSync(path))
        return null;
    try {
        return readFileSync(path, "utf-8");
    }
    catch {
        return null;
    }
}
/**
 * 机械 Gate（设计 §5）：存在性 + 最小内容 + frame 填空句 + D- 条目 + 结构标记 + stale 重确认。
 * stale：stage ≥ stale.from 时，产物必须在回退时刻之后重新落盘过（存在 ≠ 当前有效）；
 * decision-log 豁免（追加式持久认知，不整体失效）。语义质量仍归人。
 * golden-case 启用时的 S3 代理检查（设计 §16）：有草稿但无封金快照 → 缺口；
 * 一个 case 都没起草不拦（启用后不起草是用户拍板，机械层不越权）。
 */
export function evaluateGate(cwd, slug, stage, stale, capabilities) {
    const dir = flowDir(cwd, slug);
    const def = stageByIndex(stage);
    const failures = [];
    const staleAt = stale && stage >= stale.from ? Date.parse(stale.at) : 0;
    for (const artifact of def.artifacts) {
        const content = readFileOrNull(join(dir, artifact));
        if (content === null) {
            failures.push(`${artifact} 不存在`);
            continue;
        }
        if (content.trim().length < MIN_CHARS) {
            failures.push(`${artifact} 内容不足（<${MIN_CHARS} 字符）`);
        }
        if (staleAt > 0 && !STALE_EXEMPT.has(artifact)) {
            const mtime = statSync(join(dir, artifact)).mtimeMs;
            if (mtime <= staleAt) {
                failures.push(`${artifact} 是上游调整（自 S${stale.from - 1} 起）前的旧版本，需基于新上游重新验证/重写后保存（确认仍有效也重新落盘）`);
            }
        }
    }
    if (stage === 2) {
        const frame = readFileOrNull(join(dir, "frame.md")) ?? "";
        if (!frame.includes("用来判断"))
            failures.push("frame.md 缺定位句关键词「用来判断」");
        if (frame.includes("___"))
            failures.push("frame.md 定位句还有 ___ 没填");
    }
    if (stage === 3) {
        const log = readFileOrNull(join(dir, "decision-log.md")) ?? "";
        if (!/^D-\d+/m.test(log))
            failures.push("decision-log.md 没有 D- 编号条目（格式：D-001｜active｜内容｜日期）");
    }
    // 结构标记（stages.ts 的 GATE_MARKERS）：机械判"明显步骤有没有做"，不判内容好坏
    for (const [file, markers] of Object.entries(GATE_MARKERS[def.slug] ?? {})) {
        const content = readFileOrNull(join(dir, file));
        if (content === null)
            continue; // 缺文件已由存在性检查报告
        for (const marker of markers) {
            if (!content.includes(marker))
                failures.push(`${file} 缺关键结构标记「${marker}」`);
        }
    }
    // golden-case S3 代理检查：只在默认根目录存在时生效（用户搬迁 case 根则静默跳过，不误伤）
    if (stage === 3 && capabilities?.["golden-case"]?.status === "enabled") {
        const casesYaml = join(cwd, ".hapilon", "go-case", "cases.yaml");
        const frozenMd = join(cwd, ".hapilon", "go-case", "frozen.md");
        if (existsSync(casesYaml) && !existsSync(frozenMd)) {
            failures.push("golden-case 已启用且已有 case 草稿（cases.yaml），但尚无封金快照（frozen.md）——本轮核心 case 需完成 business truth freeze；仍要推进可强推（缺口转 debt）");
        }
    }
    return { passed: failures.length === 0, failures };
}
/** 全部阶段产物（供渲染/派发引用） */
export function listArtifacts(cwd, slug) {
    const dir = flowDir(cwd, slug);
    const names = new Set();
    for (const def of STAGES)
        for (const a of def.artifacts)
            names.add(a);
    return [...names].map((name) => ({ name, exists: existsSync(join(dir, name)) }));
}
