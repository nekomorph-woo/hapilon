import { existsSync } from "node:fs";
import { Effect } from "effect";
import { agentGet, defaultSpawn, paneAgentAlive, paneRead, type AgentStatus, type SpawnFn } from "./herdr.js";

/**
 * 状态判定与展示分离：本模块只出状态，按键/代答由 orchestrator LLM 执行（代码不按键）。
 */
export type AgentState = "dead" | "waiting-input" | "done" | "stale" | "idle" | "working" | "unknown";

/**
 * 弹窗标记的单一出处：pi 升级改文案只动这里。命中任一即视为「人机交互弹窗」。
 * ask_user：question-view.ts / submit-view.ts 底部提示行；
 * 权限确认：hpl-protected-paths/confirm.ts 的 4 选项文案。
 */
export const DIALOG_MARKERS = [
  "↑↓ navigate",
  "Enter select",
  "←/→ navigate",
  "Allow Once",
  "Allow this Session",
  "Allow this Project",
] as const;

export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;

/** 信号输入全参数化：单测直接注入，不依赖 herdr/文件系统。 */
export interface AgentSignals {
  /** pane/进程是否仍存在；false 即 dead（唯一死亡证据） */
  paneAlive: boolean;
  /** herdr agent get 的状态；undefined = 该信号不可得 */
  herdrStatus?: AgentStatus | undefined;
  /** 最近的屏文本样本，旧 → 新；不足两次 = 采样不完整 */
  paneSamples?: readonly string[] | undefined;
  /** 回执文件（worker-report.md / reviewer-report.md）是否存在——done 的唯一凭证 */
  reportExists: boolean;
  /**
   * 该 pane 确有 in_progress 任务时，距任务最后一次更新的毫秒数；
   * undefined = 没有在办任务（不期待报告 → 永不 stale）。任务时间戳由调用方从
   * 任务列表读出，跨 CLI 进程持久，替代以前每次进程都清零的内存活动计时；
   * 仅在 herdr 已停（idleLike）时参与 stale 判定。
   */
  expectedReportAgeMs?: number | undefined;
  staleThresholdMs?: number | undefined;
}

function idleLike(status: AgentStatus | undefined): boolean {
  // herdr 的 done = 后台工作结束后未被查看的 idle，同属「已停止」信号
  return status === "idle" || status === "done";
}

function matchesDialog(text: string): boolean {
  return DIALOG_MARKERS.some((marker) => text.includes(marker));
}

/** 连续两次采样都命中弹窗标记才算确认：单个半帧片段不足以判定等待输入。 */
function dialogConfirmed(samples: readonly string[] | undefined): boolean {
  if (!samples || samples.length < 2) return false;
  return samples.slice(-2).every(matchesDialog);
}

/**
 * 判定优先级：dead（无 pane）→ waiting-input（两次采样确认弹窗）→ done（herdr 已停
 * 且回执在）→ stale（herdr 已停、在办任务超阈且回执缺席）→ idle（活着、当前无 turn）
 * → working → unknown。
 * 连通性永不作为完成性证据；idle 与无报告都不是完成凭证；信号不足时不猜，落到 unknown。
 */
export function resolveAgentState(signals: AgentSignals): AgentState {
  if (!signals.paneAlive) return "dead";
  if (dialogConfirmed(signals.paneSamples)) return "waiting-input";

  const { herdrStatus, reportExists } = signals;
  if (idleLike(herdrStatus) && reportExists) return "done";

  // stale 只适用于已停下的 pane：任务记录年龄是记账新鲜度，不是活动心跳，不能推翻
  // herdr 的 working（hapi 每个 turn_start 都上报），否则长任务会被误判 stale 而遭打断。
  const threshold = signals.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  if (idleLike(herdrStatus) && !reportExists && signals.expectedReportAgeMs !== undefined
    && signals.expectedReportAgeMs >= threshold) {
    return "stale";
  }

  // herdr 报告已停：活着、当前没有 turn。回执缺席只说明任务没做完，不能反推忙碌
  if (idleLike(herdrStatus)) return "idle";
  if (herdrStatus === "working") return "working";
  return "unknown";
}

export interface PaneProbeOptions {
  spawn?: SpawnFn;
  /** 回执文件绝对路径；调用方拿不到当前任务目录时不传 → done 不成立 */
  reportPath?: string;
  /** 在办任务最后一次更新的时间戳；缺省 = 没有在办任务 → stale 不成立 */
  expectedReportSince?: number;
  /** 测试注入时钟 */
  now?: () => number;
}

/**
 * 生产侧采样：pane 存活 + herdr 状态 + 两次屏文本 + 回执存在性。
 * ponytail: 两次读之间只隔一次 spawn 往返（几十毫秒），不额外 sleep，保持同步可跑；
 * 若半帧误报真的出现，改成异步 probe + Effect.sleep 分离两次采样。
 */
export const sampleAgentStateEffect = (
  paneId: string,
  options: PaneProbeOptions = {},
): Effect.Effect<AgentState, never> =>
  Effect.gen(function* () {
    const spawn = options.spawn ?? defaultSpawn;
    const now = options.now ?? Date.now;
    // dead = pane 里已经没有 agent：pane 关了，或 pi 崩了只剩 shell（后者以前会被当成 alive）
    if (!(yield* paneAgentAlive(paneId, spawn))) return "dead" as const;

    const herdrStatus = yield* agentGet(paneId, spawn);
    const first = yield* paneRead(paneId, spawn);
    const second = yield* paneRead(paneId, spawn);
    const samples = [first, second].filter((sample): sample is string => sample !== undefined);

    return resolveAgentState({
      paneAlive: true,
      herdrStatus,
      paneSamples: samples,
      reportExists: options.reportPath !== undefined && existsSync(options.reportPath),
      expectedReportAgeMs: options.expectedReportSince === undefined
        ? undefined
        : now() - options.expectedReportSince,
    });
  });
