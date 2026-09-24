/**
 * selector.ts — 纯模型选择器（无 Effect / 无 Node 依赖）
 *
 * 优先级（设计不变量）：
 *   显式点名 > 配额 bucket > [adaptive 开启时] 可信画像 > 配置顺序 > 负载
 * thinking 是模型选定之后的独立一档：显式后缀 > 档位条目后缀 > [adaptive 开启]
 * 学习到的 role+model 偏好 > pi 自身默认。学习值只由调用方（adaptive.ts）补齐。
 *
 * 事实与画像由 adaptive-events.ts 派生后传进来；本文件只做确定性决策，
 * 因此可以脱离磁盘在单测里穷举全部优先级组合。
 */

import type { ThinkingLevelName } from "./resolved.js";

export type QuotaClass = "ok" | "unknown" | "hot";

/**
 * 可信样本门槛：显式点名、任务完成结果、review verdict、修复轮次、真实失败/限流。
 * 低于门槛只显示「观察中」，不参与路由——自动分配次数永远不是可信样本。
 */
export const MIN_TRUSTED_SAMPLES = 5;

/** 固定标签词表：模型不得自我生成描述，只在这份集合里取。 */
export const ADAPTIVE_LABELS = {
  worker: "常用 Worker",
  reviewer: "常用 Reviewer",
  discussant: "常用 Discussant",
  passing: "一次通过",
  needsFixes: "常需返修",
  namedByUser: "用户常点名",
  switchedByUser: "用户常切换至此",
  observing: "观察中",
  thinkingObserving: "thinking 观察中",
  quotaTight: "配额紧张",
  quotaPlenty: "配额充足",
  quotaUnknown: "暂无配额数据",
} as const;

/** 角色 → 常用标签（未在词表里的自定义角色只显示角色名，不造新词）。 */
const ROLE_LABELS: Record<string, string> = {
  worker: ADAPTIVE_LABELS.worker,
  reviewer: ADAPTIVE_LABELS.reviewer,
  discussant: ADAPTIVE_LABELS.discussant,
};

/** 角色 → thinking 标签里的显示名（示例：「Worker 常用 thinking high」）。 */
const ROLE_DISPLAY: Record<string, string> = {
  worker: "Worker",
  reviewer: "Reviewer",
  discussant: "Discussant",
  "ux-tester": "UX Tester",
};

const roleDisplayName = (role: string): string => ROLE_DISPLAY[role] ?? role;

export interface CandidateModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  /** 该档位条目显式指定的 thinking level；决策与 spawn 串都带上它。 */
  thinking?: ThinkingLevelName;
  /** 配置条目序号：同一条目展开出的兄弟模型共享它，负载只能在这一层打破同位。 */
  entryIndex: number;
}

export interface ModelEvidence {
  trustedSamples: number;
  /** 开 pane 点名的次数（`/team:open <role> <model>`） */
  explicitPicks: number;
  /** 用户在该角色 pane 上主动切模的次数（/model、Ctrl+P）。与点名分开计数便于审计 */
  switchPicks: number;
  completedTasks: number;
  approvals: number;
  fixRounds: number;
  rejects: number;
  /** 角色 → 开 pane 点名次数（偏好按角色区分：worker 的常点名不代表 reviewer 也常用） */
  roles: Record<string, number>;
  /** 角色 → 主动切模次数 */
  switchRoles: Record<string, number>;
  /**
   * 用户主动切到的 thinking level：level → 角色 → 次数。与模型 affinity 分开累计
   * （不计入 trustedSamples），只给新 level 正向证据，旧 level 不记负分。
   */
  thinkingLevels: Record<string, Record<string, number>>;
}

/**
 * 学习到的 thinking 偏好：role+model 下达到门槛且次数最多的 level。
 * 多个 level 都达门槛时取样本多的；并列取先出现的（事件顺序确定，派生可重放）。
 */
export function learnedThinkingLevel(
  role: string,
  evidence: ModelEvidence | undefined,
): ThinkingLevelName | undefined {
  const levels = evidence?.thinkingLevels;
  if (!levels) return undefined;
  let best: { level: ThinkingLevelName; count: number } | undefined;
  for (const [level, roles] of Object.entries(levels)) {
    const count = roles[role] ?? 0;
    if (count < MIN_TRUSTED_SAMPLES) continue;
    if (!best || count > best.count) best = { level: level as ThinkingLevelName, count };
  }
  return best?.level;
}

/**
 * thinking 画像标签：达门槛显示「Worker 常用 thinking high」，有样本但不足门槛显示
 * 「thinking 观察中」，完全没有该角色的样本则不出标签（模型轴已另有「观察中」）。
 */
export function thinkingLabel(role: string, evidence: ModelEvidence | undefined): string | undefined {
  const levels = evidence?.thinkingLevels;
  if (!levels) return undefined;
  const hasSample = Object.values(levels).some((roles) => (roles[role] ?? 0) > 0);
  if (!hasSample) return undefined;
  const level = learnedThinkingLevel(role, evidence);
  return level ? `${roleDisplayName(role)} 常用 thinking ${level}` : ADAPTIVE_LABELS.thinkingObserving;
}

/**
 * 角色的可信显式偏好 = 开 pane 点名 + 主动切模。两者都是用户主动选择，
 * 路由上合并生效；标签展示仍按来源分开表述，不把切模说成点名。
 */
export function explicitAffinity(role: string, evidence: ModelEvidence | undefined): number {
  if (!evidence) return 0;
  return (evidence.roles[role] ?? 0) + (evidence.switchRoles?.[role] ?? 0);
}

export interface ProfileView {
  models: Record<string, ModelEvidence>;
  /** 角色 → 该角色点名次数最多的模型 key（仅展示） */
  roleLeaders: Record<string, string>;
}

export interface ExplicitModel {
  spec: string;
  provider: string;
  id: string;
  thinking?: ThinkingLevelName;
}

export interface SelectionInput {
  role: string;
  candidates: readonly CandidateModel[];
  /** provider → 配额状态；缺键即 unknown（未知配额中性，不惩罚） */
  quotas?: Readonly<Record<string, QuotaClass>>;
  /** 模型 key → 当前 live pane 数（全部角色合计） */
  load?: Readonly<Record<string, number>>;
  profile?: ProfileView;
  adaptiveEnabled: boolean;
  explicit?: ExplicitModel;
}

export type SelectionSource = "explicit" | "quota" | "profile" | "load" | "config" | "none";

export interface RankedCandidate {
  model: CandidateModel;
  key: string;
  spec: string;
  /** 档位配置里的位置（候选数组下标）：同配额同画像时的最终判据 */
  index: number;
  quota: QuotaClass;
  /** -1 提升 / 0 中性 / +1 降级；adaptive 关闭或样本不足时恒为 0 */
  profileRank: number;
  load: number;
  labels: string[];
}

export interface SelectionDecision {
  spec?: string;
  source: SelectionSource;
  reason: string;
  warnings: string[];
  /** 有效顺序（effective order），供状态 UI 与日志展示 */
  order: RankedCandidate[];
}

export function modelKey(model: Pick<CandidateModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function modelSpec(model: Pick<CandidateModel, "provider" | "id" | "thinking">): string {
  return model.thinking ? `${model.provider}/${model.id}:${model.thinking}` : `${model.provider}/${model.id}`;
}

/** 固定词表内的展示标签：配额状态 + 可信证据摘要（样本不足一律「观察中」）。 */
export function candidateLabels(
  evidence: ModelEvidence | undefined,
  quota: QuotaClass,
  profile: ProfileView | undefined,
  role: string,
  key: string,
): string[] {
  const labels: string[] = [];
  const quotaLabel = quota === "hot"
    ? ADAPTIVE_LABELS.quotaTight
    : quota === "ok" ? ADAPTIVE_LABELS.quotaPlenty : ADAPTIVE_LABELS.quotaUnknown;
  labels.push(quotaLabel);
  if (profile?.roleLeaders[role] === key) {
    labels.push(ROLE_LABELS[role] ?? `常用 ${role}`);
  }
  const thinking = thinkingLabel(role, evidence);
  if (!evidence || evidence.trustedSamples < MIN_TRUSTED_SAMPLES) {
    labels.push(ADAPTIVE_LABELS.observing);
    if (thinking) labels.push(thinking);
    return labels;
  }
  const outcomes = evidence.approvals + evidence.fixRounds + evidence.rejects;
  const fixRate = outcomes > 0 ? (evidence.fixRounds + evidence.rejects) / outcomes : 0;
  const approveRate = outcomes > 0 ? evidence.approvals / outcomes : 0;
  if ((evidence.roles[role] ?? 0) >= MIN_TRUSTED_SAMPLES && fixRate <= 0.2) {
    labels.push(ADAPTIVE_LABELS.namedByUser);
  }
  if ((evidence.switchRoles?.[role] ?? 0) >= MIN_TRUSTED_SAMPLES) {
    labels.push(ADAPTIVE_LABELS.switchedByUser);
  }
  if (evidence.approvals >= MIN_TRUSTED_SAMPLES && approveRate >= 0.8 && evidence.rejects === 0) {
    labels.push(ADAPTIVE_LABELS.passing);
  }
  if (evidence.fixRounds + evidence.rejects >= MIN_TRUSTED_SAMPLES && fixRate >= 0.5) {
    labels.push(ADAPTIVE_LABELS.needsFixes);
  }
  if (thinking) labels.push(thinking);
  return labels;
}

/**
 * 画像等级：只有达门槛的证据才动 effective order。
 * 提升条件取「本角色常点名」或「一次通过率高」，降级条件取「常需返修」；
 * 两者都不满足（样本够但不突出）保持中性，交给配置顺序。
 */
function profileRankOf(
  role: string,
  key: string,
  evidence: ModelEvidence | undefined,
  adaptiveEnabled: boolean,
): number {
  if (!adaptiveEnabled || !evidence || evidence.trustedSamples < MIN_TRUSTED_SAMPLES) return 0;
  const outcomes = evidence.approvals + evidence.fixRounds + evidence.rejects;
  const fixRate = outcomes > 0 ? (evidence.fixRounds + evidence.rejects) / outcomes : 0;
  const approveRate = outcomes > 0 ? evidence.approvals / outcomes : 0;
  if (explicitAffinity(role, evidence) >= MIN_TRUSTED_SAMPLES && fixRate <= 0.2) return -1;
  if (evidence.approvals >= MIN_TRUSTED_SAMPLES && approveRate >= 0.8 && evidence.rejects === 0) return -1;
  if (evidence.fixRounds + evidence.rejects >= MIN_TRUSTED_SAMPLES && fixRate >= 0.5) return 1;
  return 0;
}

const QUOTA_ORDER: Record<QuotaClass, number> = { ok: 0, unknown: 0, hot: 1 };

function rankedCandidates(input: SelectionInput): RankedCandidate[] {
  const quotas = input.quotas ?? {};
  const load = input.load ?? {};
  const ranked = input.candidates.map((model, index) => {
    const key = modelKey(model);
    const quota = quotas[model.provider] ?? "unknown";
    return {
      model,
      key,
      spec: modelSpec(model),
      index,
      quota,
      profileRank: profileRankOf(input.role, key, input.profile?.models[key], input.adaptiveEnabled),
      load: load[key] ?? 0,
      labels: candidateLabels(input.profile?.models[key], quota, input.profile, input.role, key),
    };
  });
  // 配额 → 画像 → 条目序号（配置顺序）→ 负载 → 位置：负载只在同一条目展开的兄弟模型间打破同位。
  return ranked.sort((left, right) =>
    QUOTA_ORDER[left.quota] - QUOTA_ORDER[right.quota]
    || left.profileRank - right.profileRank
    || left.model.entryIndex - right.model.entryIndex
    || left.load - right.load
    || left.index - right.index);
}

function quotaLabel(quota: QuotaClass): string {
  return quota === "hot" ? "配额紧张" : quota === "ok" ? "配额充足" : "暂无配额数据";
}

/** 只按配额 + 配置顺序排出的首位：画像/负载改没改结果，以它为参照。 */
function quotaFirstOf(order: readonly RankedCandidate[]): RankedCandidate | undefined {
  return [...order].sort((left, right) =>
    QUOTA_ORDER[left.quota] - QUOTA_ORDER[right.quota]
    || left.model.entryIndex - right.model.entryIndex
    || left.index - right.index)[0];
}

function configFirstOf(order: readonly RankedCandidate[]): RankedCandidate | undefined {
  return [...order].sort((left, right) =>
    left.model.entryIndex - right.model.entryIndex || left.index - right.index)[0];
}

function buildReason(
  source: SelectionSource,
  chosen: RankedCandidate,
  quotaFirst: RankedCandidate,
  configFirst: RankedCandidate | undefined,
): string {
  const parts: string[] = [];
  if (source === "quota" && configFirst) {
    parts.push(`配额：${configFirst.model.provider} ${quotaLabel(configFirst.quota)}顺延`);
  } else if (source === "profile") {
    // 画像改结果可能是「提升了选中的」也可能是「降级了原本的配置首位」，两者要说清楚
    parts.push(quotaFirst.profileRank > 0
      ? `可信画像：${quotaFirst.key} 降级（${quotaFirst.labels.join("、")}）`
      : `可信画像：${chosen.key} 提升（${chosen.labels.join("、")}）`);
  } else if (source === "load") {
    parts.push(`负载：同条目候选中 ${chosen.key} 最空闲（另有 ${quotaFirst.load} 个 pane 在用同位候选）`);
  }
  parts.push(`选定 ${chosen.spec}`);
  return parts.join("；");
}

/**
 * 决策纯函数：显式点名直接胜出（配额只告警）；否则按配额 bucket、可信画像、
 * 配置顺序、负载依次排序取首位。空候选返回 source=none。
 */
export function selectTierModel(input: SelectionInput): SelectionDecision {
  const warnings: string[] = [];
  const order = rankedCandidates(input);

  if (input.explicit) {
    const quota = input.quotas?.[input.explicit.provider] ?? "unknown";
    if (quota === "hot") {
      warnings.push(`显式点名 ${input.explicit.spec} 的 provider ${quotaLabel(quota)}（≥90%），仍按点名使用`);
    }
    return {
      spec: input.explicit.spec,
      source: "explicit",
      reason: `显式点名 ${input.explicit.spec}`,
      warnings,
      order,
    };
  }

  const chosen = order[0];
  if (!chosen) {
    return { source: "none", reason: "该档位没有可用候选模型", warnings, order };
  }

  const quotaFirst = quotaFirstOf(order)!;
  const configFirst = configFirstOf(order);
  const source: SelectionSource = chosen.key === quotaFirst.key
    ? (chosen.key === configFirst?.key ? "config" : "quota")
    : chosen.profileRank !== quotaFirst.profileRank ? "profile" : "load";

  // 全 hot 仍要选：给出顺序并显式告警，而不是无声降级或换 provider
  if (order.every((candidate) => candidate.quota === "hot")) {
    warnings.push("全部候选 provider 配额紧张（≥90%），仍按顺序选择，请留意限流");
  }

  return {
    spec: chosen.spec,
    source,
    reason: buildReason(source, chosen, quotaFirst, configFirst),
    warnings,
    order,
  };
}
