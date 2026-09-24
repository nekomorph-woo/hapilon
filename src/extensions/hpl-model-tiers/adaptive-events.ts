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
import { explicitAffinity, MIN_TRUSTED_SAMPLES, type ModelEvidence, type ProfileView } from "./selector.js";

export type AdaptiveEventKind =
  | "pane_assignment"
  | "explicit_selection"
  | "model_switch"
  | "thinking_switch"
  | "task_completed"
  | "provider_limit"
  | "provider_failure"
  | "review_verdict"
  | "fix_round";

export type ReviewVerdict = "approve" | "fix-then-approve" | "reject";

interface EventBase {
  ts: string;
  /** 幂等去重键：重复写入同键事件被跳过（任务完成、窗口打满、同一 verdict） */
  key?: string;
}

export interface PaneAssignmentEvent extends EventBase {
  kind: "pane_assignment";
  role: string;
  paneId: string;
  model: string;
  source: "auto" | "explicit";
  reason: string;
}

export interface ExplicitSelectionEvent extends EventBase {
  kind: "explicit_selection";
  role: string;
  model: string;
  /** 点名来源：命令行参数 */
  source: "arg";
}

/**
 * 用户主动切模（/model 或 Ctrl+P）。仅记录目标模型——切走不等于旧模型变差。
 * ceiling：仓库内没有扩展调 pi.setModel()，所以 set/cycle 都当用户主动选择；
 * 将来引入程序化 setModel 时必须先在这里补来源区分。
 */
export interface ModelSwitchEvent extends EventBase {
  kind: "model_switch";
  /** 事件 schema 版本：字段语义变化时递增，审计侧可据此兼容旧行 */
  v: 1;
  paneId: string;
  role: string;
  /** 切走前的模型；无前值时为空串（例如会话首个 set） */
  previousModel: string;
  model: string;
  source: "set" | "cycle";
  thinking?: string;
}

/**
 * 用户主动切 thinking level（快捷键 / /thinking 等）。pi 的事件不带来源，模型切换
 * 也会先改 thinking 再发 model_select，所以上报侧先缓冲一拍、同轮 model_select 丢弃
 * （见 hpl-orchestra/adaptive-facts.ts）。ceiling：pi 未来若引入其它程序化
 * setThinkingLevel 调用点，必须先补来源区分。
 */
export interface ThinkingSwitchEvent extends EventBase {
  kind: "thinking_switch";
  /** 事件 schema 版本：字段语义变化时递增，审计侧可据此兼容旧行 */
  v: 1;
  paneId: string;
  role: string;
  /** 切换发生时的当前模型（provider/id），thinking 偏好按 role+model+level 累计 */
  model: string;
  previousLevel: string;
  level: string;
}

export interface TaskCompletedEvent extends EventBase {
  kind: "task_completed";
  role: string;
  paneId: string;
  taskId: string;
  model: string;
}

export interface ProviderLimitEvent extends EventBase {
  kind: "provider_limit";
  provider: string;
  window: string;
  percent: number;
  resetAt?: number;
}

export interface ProviderFailureEvent extends EventBase {
  kind: "provider_failure";
  provider: string;
  detail: string;
}

export interface ReviewVerdictEvent extends EventBase {
  kind: "review_verdict";
  model: string;
  verdict: ReviewVerdict;
  taskDir?: string;
}

export interface FixRoundEvent extends EventBase {
  kind: "fix_round";
  model: string;
  round: number;
  taskDir?: string;
}

export type AdaptiveEvent =
  | PaneAssignmentEvent
  | ExplicitSelectionEvent
  | ModelSwitchEvent
  | ThinkingSwitchEvent
  | TaskCompletedEvent
  | ProviderLimitEvent
  | ProviderFailureEvent
  | ReviewVerdictEvent
  | FixRoundEvent;

export interface ProviderEvidence {
  limits: number;
  failures: number;
}

export interface AdaptiveProfile {
  generatedAt: string;
  models: Record<string, ModelEvidence>;
  providers: Record<string, ProviderEvidence>;
  /** 模型 key → 自动分配次数（仅展示：分配次数永不参与排序） */
  assignments: Record<string, number>;
  /** 全部模型的可靠样本合计（状态 UI 展示用；不含 thinking 偏好样本） */
  trustedSamples: number;
  /** thinking 偏好样本合计（按 role+model+level 独立累计） */
  thinkingSamples: number;
  /** 角色 → 点名次数最多的模型 key（仅展示） */
  roleLeaders: Record<string, string>;
}

/**
 * 可信样本的时效窗口：更早的事件留在日志里可审计，但不再影响路由。
 * 用硬窗口而不是指数衰减：门槛是整数样本数，硬窗口的语义（哪些样本算数）能直接解释。
 */
export const EVIDENCE_WINDOW_DAYS = 30;

const EMPTY_PROFILE = (generatedAt: string): AdaptiveProfile =>
  ({ generatedAt, models: {}, providers: {}, assignments: {}, trustedSamples: 0, thinkingSamples: 0, roleLeaders: {} });

export function adaptiveDir(): string {
  return join(hapilonHome(), "tier-adaptive");
}

export function adaptiveEventsPath(): string {
  return join(adaptiveDir(), "events.jsonl");
}

export function adaptiveProfilePath(): string {
  return join(adaptiveDir(), "profile.json");
}

const isEvent = (value: unknown): value is AdaptiveEvent => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["kind"] === "string" && typeof record["ts"] === "string";
};

/** 逐行解析：坏行跳过（日志是审计面，一行坏数据不能让画像整体失效）。 */
function parseEvents(raw: string): AdaptiveEvent[] {
  const events: AdaptiveEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isEvent(parsed)) events.push(parsed);
      else console.warn("[hpl-model-tiers] tier-adaptive 事件缺 kind/ts，已跳过");
    } catch {
      console.warn("[hpl-model-tiers] tier-adaptive 事件行不是合法 JSON，已跳过");
    }
  }
  return events;
}

export const readAdaptiveEventsEffect: Effect.Effect<AdaptiveEvent[], never> = Effect.try({
  try: () => {
    const path = adaptiveEventsPath();
    return existsSync(path) ? parseEvents(readFileSync(path, "utf8")) : [];
  },
  catch: (error) => error,
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] tier-adaptive 事件日志读取失败，按空日志继续：${String(error)}`);
    return [] as AdaptiveEvent[];
  })),
);

export function readAdaptiveEvents(): AdaptiveEvent[] {
  return Effect.runSync(readAdaptiveEventsEffect);
}

function modelEvidence(): ModelEvidence {
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
export function deriveProfile(events: readonly AdaptiveEvent[], generatedAt: string): AdaptiveProfile {
  const profile = EMPTY_PROFILE(generatedAt);
  const seenKeys = new Set<string>();
  const seenTasks = new Set<string>();
  const cutoff = Date.parse(generatedAt) - EVIDENCE_WINDOW_DAYS * 86_400_000;

  for (const event of events) {
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    if (event.key) {
      if (seenKeys.has(event.key)) continue;
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
        if (seenTasks.has(taskKey)) break;
        seenTasks.add(taskKey);
        const evidence = profile.models[event.model] ?? (profile.models[event.model] = modelEvidence());
        evidence.completedTasks++;
        break;
      }
      case "review_verdict": {
        const evidence = profile.models[event.model] ?? (profile.models[event.model] = modelEvidence());
        if (event.verdict === "approve") evidence.approvals++;
        else if (event.verdict === "fix-then-approve") evidence.fixRounds++;
        else evidence.rejects++;
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
        if (event.kind === "provider_limit") evidence.limits++;
        else evidence.failures++;
        break;
      }
    }
  }

  for (const [key, evidence] of Object.entries(profile.models)) {
    evidence.trustedSamples = evidence.explicitPicks + evidence.switchPicks + evidence.completedTasks
      + evidence.approvals + evidence.fixRounds + evidence.rejects;
    profile.trustedSamples += evidence.trustedSamples;
    // 低于门槛的模型不进 roleLeaders：状态 UI 的「常用 X」也不该来自观察中样本
    if (evidence.trustedSamples < MIN_TRUSTED_SAMPLES) continue;
    const roles = new Set([...Object.keys(evidence.roles), ...Object.keys(evidence.switchRoles)]);
    for (const role of roles) {
      // 榜首按合并后的显式偏好（点名 + 切模）排；标签仍分开表述来源
      const count = explicitAffinity(role, evidence);
      const leader = profile.roleLeaders[role];
      if (!leader || count > explicitAffinity(role, profile.models[leader])) profile.roleLeaders[role] = key;
    }
  }
  return profile;
}

/** 选择器只消费模型证据与角色榜首；其余字段留给状态 UI。 */
export function profileView(profile: AdaptiveProfile): ProfileView {
  return { models: profile.models, roleLeaders: profile.roleLeaders };
}

function writeProfileSnapshot(profile: AdaptiveProfile): void {
  const path = adaptiveProfilePath();
  mkdirSync(adaptiveDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** 事件日志 → 画像快照（快照可随时删，重建结果一致）。 */
export const rebuildAdaptiveProfileEffect = (now = new Date().toISOString()): Effect.Effect<AdaptiveProfile, never> =>
  readAdaptiveEventsEffect.pipe(
    Effect.map((events) => deriveProfile(events, now)),
    Effect.tap((profile) => Effect.sync(() => {
      try {
        writeProfileSnapshot(profile);
      } catch (error) {
        console.warn(`[hpl-model-tiers] 画像快照写入失败（不影响路由）：${String(error)}`);
      }
    })),
  );

export function rebuildAdaptiveProfile(now?: string): AdaptiveProfile {
  return Effect.runSync(rebuildAdaptiveProfileEffect(now));
}

/**
 * 读画像：事件日志是事实来源，直接派生（无缓存即无陈旧）；日志缺失/不可读时
 * 退回快照文件，仍无则空画像。
 */
export const readAdaptiveProfileEffect = (now = new Date().toISOString()): Effect.Effect<AdaptiveProfile, never> =>
  Effect.gen(function* () {
    const events = yield* readAdaptiveEventsEffect;
    if (events.length > 0) return deriveProfile(events, now);
    return yield* Effect.try({
      try: () => {
        const path = adaptiveProfilePath();
        if (!existsSync(path)) return EMPTY_PROFILE(now);
        const parsed = JSON.parse(readFileSync(path, "utf8")) as AdaptiveProfile;
        return parsed && typeof parsed === "object" && parsed.models ? parsed : EMPTY_PROFILE(now);
      },
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) => Effect.sync(() => {
        console.warn(`[hpl-model-tiers] 画像快照读取失败，按空画像继续：${String(error)}`);
        return EMPTY_PROFILE(now);
      })),
    );
  });

export function readAdaptiveProfile(now?: string): AdaptiveProfile {
  return Effect.runSync(readAdaptiveProfileEffect(now));
}

/**
 * 追加一条事实：带 key 时先按 key 去重（重复上报静默跳过），写入后顺手刷新画像快照。
 * 写失败只告警——事实日志坏掉不该让选模流程炸掉。
 */
export const appendAdaptiveEventEffect = (
  event: AdaptiveEvent,
  key?: string,
): Effect.Effect<boolean, never> => Effect.try({
  try: () => {
    const path = adaptiveEventsPath();
    const events = existsSync(path) ? parseEvents(readFileSync(path, "utf8")) : [];
    if (key && events.some((existing) => existing.key === key)) return false;
    const stored: AdaptiveEvent = key ? { ...event, key } : event;
    mkdirSync(adaptiveDir(), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
    writeProfileSnapshot(deriveProfile([...events, stored], new Date().toISOString()));
    return true;
  },
  catch: (error) => error,
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] tier-adaptive 事件写入失败（不影响选模）：${String(error)}`);
    return false;
  })),
);

export function appendAdaptiveEvent(event: AdaptiveEvent, key?: string): boolean {
  return Effect.runSync(appendAdaptiveEventEffect(event, key));
}
