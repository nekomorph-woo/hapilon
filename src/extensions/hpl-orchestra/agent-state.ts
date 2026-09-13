import { existsSync } from "node:fs";
import { Effect } from "effect";
import { agentGet, defaultSpawn, paneAgentAlive, paneRead, type AgentStatus, type SpawnFn } from "./herdr.js";

/**
 * 五态 + unknown。判定与展示分离：本模块只出状态，按键/代答由 orchestrator LLM
 * 执行（代码不按键）。
 */
export type AgentState = "dead" | "waiting-input" | "done" | "stale" | "working" | "unknown";

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
  /** 距最后一次观察到的活动（herdr 状态变化）的毫秒数；undefined = 未知 */
  lastActivityMs?: number | undefined;
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
 * 且回执在）→ stale（已停/工作中超阈且回执缺席）→ working → unknown。
 * 连通性永不作为完成性证据；信号不足时不猜，落到 unknown。
 */
export function resolveAgentState(signals: AgentSignals): AgentState {
  if (!signals.paneAlive) return "dead";
  if (dialogConfirmed(signals.paneSamples)) return "waiting-input";

  const { herdrStatus, reportExists } = signals;
  if (idleLike(herdrStatus) && reportExists) return "done";

  const threshold = signals.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const stoppedOrBusy = herdrStatus === "working" || idleLike(herdrStatus);
  if (!reportExists && stoppedOrBusy && signals.lastActivityMs !== undefined
    && signals.lastActivityMs >= threshold) {
    return "stale";
  }

  // idle/done 但回执缺席：不是 done（回执才是凭证），也不足以判 stale
  if (stoppedOrBusy) return "working";
  return "unknown";
}

/**
 * herdr 不提供活动时间戳，只提供状态；因此 lastActivity 由本进程观察状态串的
 * 最后一次变化得到。首次观察即算活动——宁可晚报 stale，不在未知时长上误报。
 */
interface PaneActivity {
  status: AgentStatus;
  since: number;
}

const activities = new Map<string, PaneActivity>();

export function resetAgentStateActivity(): void {
  activities.clear();
}

function observeActivity(paneId: string, status: AgentStatus, at: number): number {
  const previous = activities.get(paneId);
  const since = previous && previous.status === status ? previous.since : at;
  activities.set(paneId, { status, since });
  return at - since;
}

export interface PaneProbeOptions {
  spawn?: SpawnFn;
  /** 回执文件绝对路径；调用方拿不到当前任务目录时不传 → done 不成立 */
  reportPath?: string;
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
      lastActivityMs: observeActivity(paneId, herdrStatus, now()),
    });
  });
