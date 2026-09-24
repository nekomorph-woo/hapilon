/**
 * adaptive-events.ts — 自适应选模的事实日志与派生画像
 *
 * 事实 append-only（JSONL），画像是纯派生（可删可重建）：路由只看可信证据，
 * 因此日志里必须能区分「用户点名」与「系统自动分配」——后者永远不进偏好，
 * 否则自动路由会自我强化成「谁被分得多谁更常用」。
 *
 * 落盘位置：<HAPILON_HOME>/tier-adaptive/{events.jsonl,profile.json}
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { explicitAffinity, MIN_TRUSTED_SAMPLES } from "./selector.js";
/**
 * 可信样本的时效窗口：更早的事件留在日志里可审计，但不再影响路由。
 * 用硬窗口而不是指数衰减：门槛是整数样本数，硬窗口的语义（哪些样本算数）能直接解释。
 */
export const EVIDENCE_WINDOW_DAYS = 30;
const EMPTY_PROFILE = (generatedAt) => ({ generatedAt, models: {}, providers: {}, assignments: {}, trustedSamples: 0, thinkingSamples: 0, roleLeaders: {} });
export function adaptiveDir() {
    return join(hapilonHome(), "tier-adaptive");
}
export function adaptiveEventsPath() {
    return join(adaptiveDir(), "events.jsonl");
}
export function adaptiveProfilePath() {
    return join(adaptiveDir(), "profile.json");
}
const isEvent = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    return typeof record["kind"] === "string" && typeof record["ts"] === "string";
};
/** 逐行解析：坏行跳过（日志是审计面，一行坏数据不能让画像整体失效）。 */
function parseEvents(raw) {
    const events = [];
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (isEvent(parsed))
                events.push(parsed);
            else
                console.warn("[hpl-model-tiers] tier-adaptive 事件缺 kind/ts，已跳过");
        }
        catch {
            console.warn("[hpl-model-tiers] tier-adaptive 事件行不是合法 JSON，已跳过");
        }
    }
    return events;
}
export const readAdaptiveEventsEffect = Effect.try({
    try: () => {
        const path = adaptiveEventsPath();
        return existsSync(path) ? parseEvents(readFileSync(path, "utf8")) : [];
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] tier-adaptive 事件日志读取失败，按空日志继续：${String(error)}`);
    return [];
})));
export function readAdaptiveEvents() {
    return Effect.runSync(readAdaptiveEventsEffect);
}
function modelEvidence() {
    return {
        trustedSamples: 0,
        explicitPicks: 0,
        switchPicks: 0,
        completedTasks: 0,
        approvals: 0,
        fixRounds: 0,
        rejects: 0,
        roles: {},
        switchRoles: {},
        thinkingLevels: {},
    };
}
/**
 * 纯派生：同一事件键只算一次；task_completed 另按 (paneId, taskId) 去重，
 * 免得 pane 重载后重复上报把样本灌水；超出时效窗口的事件只留日志不进画像。
 * pane_assignment 只计数不进任何分数——自动分配次数不得成为偏好证据。
 */
export function deriveProfile(events, generatedAt) {
    const profile = EMPTY_PROFILE(generatedAt);
    const seenKeys = new Set();
    const seenTasks = new Set();
    const cutoff = Date.parse(generatedAt) - EVIDENCE_WINDOW_DAYS * 86_400_000;
    for (const event of events) {
        const ts = Date.parse(event.ts);
        if (!Number.isFinite(ts) || ts < cutoff)
            continue;
        if (event.key) {
            if (seenKeys.has(event.key))
                continue;
            seenKeys.add(event.key);
        }
        switch (event.kind) {
            case "pane_assignment":
                profile.assignments[event.model] = (profile.assignments[event.model] ?? 0) + 1;
                break;
            case "explicit_selection": {
                const evidence = profile.models[event.model] ?? (profile.models[event.model] = modelEvidence());
                evidence.explicitPicks++;
                evidence.roles[event.role] = (evidence.roles[event.role] ?? 0) + 1;
                break;
            }
            case "model_switch": {
                const evidence = profile.models[event.model] ?? (profile.models[event.model] = modelEvidence());
                evidence.switchPicks++;
                evidence.switchRoles[event.role] = (evidence.switchRoles[event.role] ?? 0) + 1;
                break;
            }
            case "thinking_switch": {
                // thinking 偏好与模型 affinity 完全分开：只在新 level 上正向计数，旧 level 不记负分
                const evidence = profile.models[event.model] ?? (profile.models[event.model] = modelEvidence());
                const byRole = evidence.thinkingLevels[event.level] ?? (evidence.thinkingLevels[event.level] = {});
                byRole[event.role] = (byRole[event.role] ?? 0) + 1;
                profile.thinkingSamples++;
                break;
            }
            case "task_completed": {
                const taskKey = `${event.paneId}:${event.taskId}`;
                if (seenTasks.has(taskKey))
                    break;
                seenTasks.add(taskKey);
                const evidence = profile.models[event.model] ?? (profile.models[event.model] = modelEvidence());
                evidence.completedTasks++;
                break;
            }
            case "review_verdict": {
                const evidence = profile.models[event.model] ?? (profile.models[event.model] = modelEvidence());
                if (event.verdict === "approve")
                    evidence.approvals++;
                else if (event.verdict === "fix-then-approve")
                    evidence.fixRounds++;
                else
                    evidence.rejects++;
                break;
            }
            case "fix_round": {
                const evidence = profile.models[event.model] ?? (profile.models[event.model] = modelEvidence());
                evidence.fixRounds++;
                break;
            }
            case "provider_limit":
            case "provider_failure": {
                const evidence = profile.providers[event.provider]
                    ?? (profile.providers[event.provider] = { limits: 0, failures: 0 });
                if (event.kind === "provider_limit")
                    evidence.limits++;
                else
                    evidence.failures++;
                break;
            }
        }
    }
    for (const [key, evidence] of Object.entries(profile.models)) {
        evidence.trustedSamples = evidence.explicitPicks + evidence.switchPicks + evidence.completedTasks
            + evidence.approvals + evidence.fixRounds + evidence.rejects;
        profile.trustedSamples += evidence.trustedSamples;
        // 低于门槛的模型不进 roleLeaders：状态 UI 的「常用 X」也不该来自观察中样本
        if (evidence.trustedSamples < MIN_TRUSTED_SAMPLES)
            continue;
        const roles = new Set([...Object.keys(evidence.roles), ...Object.keys(evidence.switchRoles)]);
        for (const role of roles) {
            // 榜首按合并后的显式偏好（点名 + 切模）排；标签仍分开表述来源
            const count = explicitAffinity(role, evidence);
            const leader = profile.roleLeaders[role];
            if (!leader || count > explicitAffinity(role, profile.models[leader]))
                profile.roleLeaders[role] = key;
        }
    }
    return profile;
}
/** 选择器只消费模型证据与角色榜首；其余字段留给状态 UI。 */
export function profileView(profile) {
    return { models: profile.models, roleLeaders: profile.roleLeaders };
}
function writeProfileSnapshot(profile) {
    const path = adaptiveProfilePath();
    mkdirSync(adaptiveDir(), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
/** 事件日志 → 画像快照（快照可随时删，重建结果一致）。 */
export const rebuildAdaptiveProfileEffect = (now = new Date().toISOString()) => readAdaptiveEventsEffect.pipe(Effect.map((events) => deriveProfile(events, now)), Effect.tap((profile) => Effect.sync(() => {
    try {
        writeProfileSnapshot(profile);
    }
    catch (error) {
        console.warn(`[hpl-model-tiers] 画像快照写入失败（不影响路由）：${String(error)}`);
    }
})));
export function rebuildAdaptiveProfile(now) {
    return Effect.runSync(rebuildAdaptiveProfileEffect(now));
}
/**
 * 读画像：事件日志是事实来源，直接派生（无缓存即无陈旧）；日志缺失/不可读时
 * 退回快照文件，仍无则空画像。
 */
export const readAdaptiveProfileEffect = (now = new Date().toISOString()) => Effect.gen(function* () {
    const events = yield* readAdaptiveEventsEffect;
    if (events.length > 0)
        return deriveProfile(events, now);
    return yield* Effect.try({
        try: () => {
            const path = adaptiveProfilePath();
            if (!existsSync(path))
                return EMPTY_PROFILE(now);
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            return parsed && typeof parsed === "object" && parsed.models ? parsed : EMPTY_PROFILE(now);
        },
        catch: (error) => error,
    }).pipe(Effect.catchAll((error) => Effect.sync(() => {
        console.warn(`[hpl-model-tiers] 画像快照读取失败，按空画像继续：${String(error)}`);
        return EMPTY_PROFILE(now);
    })));
});
export function readAdaptiveProfile(now) {
    return Effect.runSync(readAdaptiveProfileEffect(now));
}
/**
 * 追加一条事实：带 key 时先按 key 去重（重复上报静默跳过），写入后顺手刷新画像快照。
 * 写失败只告警——事实日志坏掉不该让选模流程炸掉。
 */
export const appendAdaptiveEventEffect = (event, key) => Effect.try({
    try: () => {
        const path = adaptiveEventsPath();
        const events = existsSync(path) ? parseEvents(readFileSync(path, "utf8")) : [];
        if (key && events.some((existing) => existing.key === key))
            return false;
        const stored = key ? { ...event, key } : event;
        mkdirSync(adaptiveDir(), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
        writeProfileSnapshot(deriveProfile([...events, stored], new Date().toISOString()));
        return true;
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] tier-adaptive 事件写入失败（不影响选模）：${String(error)}`);
    return false;
})));
export function appendAdaptiveEvent(event, key) {
    return Effect.runSync(appendAdaptiveEventEffect(event, key));
}
