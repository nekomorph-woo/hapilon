/**
 * adaptive-facts.ts — 角色 pane 自己的事实上报
 *
 * 角色 pane 的任务列表由 pi-tasks 维护，owner 与选模侧都只能读它。任务是否
 * 完成在 pi-tasks 里是个事实（status+updatedAt），所以由该 pane 每轮开头自查
 * 新完成的任务并写进 tier-adaptive 事实日志；写入按 (paneId, taskId) 去重，
 * 重复上报不会把样本灌水。用户在该 pane 上主动换模型/thinking level 同理：只有
 * 角色 pane 自己看得到这些事件，所以也在这里上报。
 */
import { Effect } from "effect";
import { appendAdaptiveEvent, type ThinkingSwitchEvent } from "../hpl-model-tiers/adaptive-events.js";
import { readTaskStoreEffect } from "./team-tasks.js";
import { teamTasksPathFor, updatePaneModelEffect } from "./state.js";

export interface PaneModelContext {
  model?: { provider?: string; id?: string };
}

export const recordOwnCompletedTasksEffect = (
  ctx: PaneModelContext,
  now = new Date(),
): Effect.Effect<void, never> => {
  const role = process.env.HAPI_ORCH_ROLE;
  const paneId = process.env.HERDR_PANE_ID;
  const provider = ctx.model?.provider;
  const id = ctx.model?.id;
  if (!role || !paneId || !provider || !id) return Effect.void;
  const model = `${provider}/${id}`;
  const ts = now.toISOString();
  // 任务列表不存在/形状不符都不是本流程的错误：事实日志拿不到就不记，绝不猜
  return readTaskStoreEffect(teamTasksPathFor(paneId)).pipe(
    Effect.map((store) => (store?.tasks ?? []).filter((task) => task.status === "completed")),
    Effect.tap((tasks) => Effect.sync(() => {
      for (const task of tasks) {
        appendAdaptiveEvent({
          kind: "task_completed",
          ts,
          role,
          paneId,
          taskId: task.id,
          model,
        }, `task:${paneId}:${task.id}`);
      }
    })),
    Effect.catchAll(() => Effect.void),
    Effect.asVoid,
  );
};

export function recordOwnCompletedTasks(ctx: PaneModelContext, now?: Date): void {
  Effect.runSync(recordOwnCompletedTasksEffect(ctx, now));
}

/** pi model_select 事件里我们消费的最小形状（测试可直接构）。 */
export interface ModelSelectLike {
  source: string;
  model: { provider?: string; id?: string };
  previousModel?: { provider?: string; id?: string };
}

export interface ModelSwitchContext {
  role?: string;
  paneId?: string;
  thinking?: string;
  /** 新模型是否支持思考：决定写回 instance.model 时是否带 `:level` 后缀 */
  reasoning?: boolean;
  now?: Date;
}

const modelKeyOf = (model: { provider?: string; id?: string } | undefined): string | undefined =>
  model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;

/**
 * 角色 pane 的用户主动切模上报。只认 set/cycle（restore 是会话恢复，不是用户选择），
 * 无角色身份的 pane（owner、非 Team 会话）不记；同一模型不发事件。
 * 只记目标模型：旧模型不因“被切走”记负分。
 */
export function recordModelSwitch(event: ModelSelectLike, context: ModelSwitchContext = {}): boolean {
  const role = context.role ?? process.env.HAPI_ORCH_ROLE;
  const paneId = context.paneId ?? process.env.HERDR_PANE_ID;
  if (!role || !paneId) return false;
  if (event.source !== "set" && event.source !== "cycle") return false;
  const model = modelKeyOf(event.model);
  if (!model) return false;
  const previousModel = modelKeyOf(event.previousModel);
  if (previousModel === model) return false;
  appendAdaptiveEvent({
    kind: "model_switch",
    v: 1,
    ts: (context.now ?? new Date()).toISOString(),
    paneId,
    role,
    previousModel: previousModel ?? "",
    model,
    source: event.source,
    ...(context.thinking ? { thinking: context.thinking } : {}),
  });
  return true;
}

/**
 * 角色 pane 切模后把选中模型写回 owner 的状态文件（instance.model）。
 * 与 recordModelSwitch 分开：后者是偏好事实，这里只保证 revive/clear 不回到旧模型；
 * 也用于程序化恢复（此时上层已抑制事实上报）。找不到状态只静默跳过。
 */
export function writeBackPaneModel(event: ModelSelectLike, context: ModelSwitchContext = {}): boolean {
  const paneId = context.paneId ?? process.env.HERDR_PANE_ID;
  if (!paneId) return false;
  if (event.source !== "set" && event.source !== "cycle") return false;
  const base = modelKeyOf(event.model);
  if (!base) return false;
  const spec = context.reasoning && context.thinking ? `${base}:${context.thinking}` : base;
  Effect.runSync(updatePaneModelEffect(paneId, spec));
  return true;
}

/** pi thinking_level_select 事件里我们消费的最小形状（测试可直接构）。 */
export interface ThinkingSelectLike {
  level: string;
  previousLevel?: string;
}

export interface ThinkingSwitchContext {
  role?: string;
  paneId?: string;
  /** 事件发生时的当前模型；缺了就不记（偏好按 role+model 归属） */
  model?: { provider?: string; id?: string };
  now?: Date;
}

/**
 * 缓冲时长：pi 的模型切换会先 setThinkingLevel（同步）再 emit model_select，两个处理器
 * 在同一轮同步跑完，下一拍才落盘的计时器一定能等到。不用长窗猜——只抑制同轮。
 */
const THINKING_SETTLE_MS = 0;

let pendingThinking: ThinkingSwitchEvent[] = [];
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleThinkingFlush(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushPendingThinkingSwitch, THINKING_SETTLE_MS);
}

/** 把缓冲的 thinking 事件按序落盘；没有就什么也不做。 */
export function flushPendingThinkingSwitch(): void {
  pendingTimer = undefined;
  const queued = pendingThinking;
  pendingThinking = [];
  for (const event of queued) appendAdaptiveEvent(event);
}

/**
 * 模型切换同轮调用：pi 事件没有来源，无法当场区分「用户切 thinking」与「模型切换
 * 顺带改了 thinking」，所以 thinking 事件先缓冲一拍。模型切换的附带变化总是紧接着
 * model_select 的最后一条，只丢弃队列末位；更早的真实切换保留并重新排期。
 */
export function discardPendingThinkingSwitch(): void {
  if (pendingThinking.length > 0) pendingThinking.pop();
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = undefined;
  if (pendingThinking.length > 0) scheduleThinkingFlush();
}

/**
 * 角色 pane 的用户主动切 thinking level 上报。无角色身份/paneId/当前模型的 pane
 * （owner、非 Team 会话）不记；同 level pi 本就不发事件，写侧仍兼底。
 */
export function recordThinkingSwitch(event: ThinkingSelectLike, context: ThinkingSwitchContext = {}): boolean {
  const role = context.role ?? process.env.HAPI_ORCH_ROLE;
  const paneId = context.paneId ?? process.env.HERDR_PANE_ID;
  if (!role || !paneId) return false;
  const model = modelKeyOf(context.model);
  if (!model) return false;
  if (event.previousLevel === event.level) return false;
  pendingThinking.push({
    kind: "thinking_switch",
    v: 1,
    ts: (context.now ?? new Date()).toISOString(),
    paneId,
    role,
    model,
    previousLevel: event.previousLevel ?? "",
    level: event.level,
  });
  scheduleThinkingFlush();
  return true;
}
