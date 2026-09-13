/**
 * wait-pane.ts — 确定性地等一个 pane 收敛（团队模式派发的等待原语）
 *
 * 为什么不用 `herdr agent wait <id> --until idle`：那条命令只回答「**现在**是不是
 * idle」，而派发时目标 pane 刚从 /new 回来、本来就是 idle，于是它 3~5ms 就返回
 * （实测），orchestrator 误以为干完了。我们要的是「状态**变过**之后落到终态」，
 * herdr 没有这个原语，但 `agent get` 暴露了 state_change_seq——它只在状态真的
 * 变化时前进。这就是本模块的判据。
 *
 * 退出码（background 唤醒只带退出码，故用码表编码结果）：
 *   0 收敛（idle/done）  2 卡在等待输入（blocked）  3 到时未收敛  4 用法/环境错误
 */
import { Effect } from "effect";
import { agentStateWithSeq, type AgentSnapshot } from "./herdr.js";

/** 默认安静多久算超时（秒）——与派发纪律里的 stale 阈值一致 */
export const DEFAULT_TIMEOUT_SEC = 900;
export const DEFAULT_INTERVAL_MS = 2000;

export const WAIT_EXIT = {
  settled: 0,
  blocked: 2,
  timeout: 3,
  usage: 4,
} as const;

export type WaitOutcome = "settled" | "blocked" | "timeout";

export interface WaitResult {
  outcome: WaitOutcome;
  /** 收敛/超时那一刻的状态 */
  status: AgentSnapshot["status"];
  /** 起始序号（herdr 尚未上报过则为 undefined） */
  baselineSeq: number | undefined;
  /** 结束序号 */
  seq: number | undefined;
  /** 等到结果用掉的毫秒数 */
  elapsedMs: number;
}

export interface WaitDeps {
  snapshot: (paneId: string) => AgentSnapshot;
  sleepMs: (ms: number) => void;
  now: () => number;
}

export const defaultWaitDeps: WaitDeps = {
  snapshot: (paneId) => Effect.runSync(agentStateWithSeq(paneId)),
  // 同步阻塞：CLI 手写的等待不需要事件循环，也让逻辑保持纯循环（无 async 传染）
  sleepMs: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
  now: () => Date.now(),
};

/** 终态：idle/done 收工，blocked 需要人来回答 */
function terminal(status: AgentSnapshot["status"]): WaitOutcome | undefined {
  if (status === "idle" || status === "done") return "settled";
  if (status === "blocked") return "blocked";
  return undefined;
}

/**
 * 轮询到 pane 的状态**变过一次**且落到终态为止。
 *
 * 预置条件是「变过」：pane 派发前就是 idle 属于上一次的旧状态，不能算收敛。
 * seq 缺失（herdr 没上报过）时，只要它后来出现就算变过。
 */
export function waitForPaneSettle(
  paneId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
  deps: WaitDeps = defaultWaitDeps,
): WaitResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_SEC * 1000;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startedAt = deps.now();

  const baseline = deps.snapshot(paneId);
  const baselineSeq = baseline.seq;

  for (;;) {
    const current = deps.snapshot(paneId);
    const changed = current.seq !== baselineSeq;
    const outcome = changed ? terminal(current.status) : undefined;
    if (outcome !== undefined) {
      return {
        outcome,
        status: current.status,
        baselineSeq,
        seq: current.seq,
        elapsedMs: deps.now() - startedAt,
      };
    }
    if (deps.now() - startedAt >= timeoutMs) {
      return {
        outcome: "timeout",
        status: current.status,
        baselineSeq,
        seq: current.seq,
        elapsedMs: deps.now() - startedAt,
      };
    }
    deps.sleepMs(intervalMs);
  }
}

/** `--flag value` 形式的数值参数 */
function numberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const raw = args[index + 1];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * CLI 入口 `hapi wait-pane <pane-id> [--timeout <秒>]`。
 * 返回退出码（调用方写入 process.exitCode）——background 的唤醒只带退出码。
 */
export function runWaitPaneCommand(args: string[], deps: WaitDeps = defaultWaitDeps): number {
  const paneId = args.find((arg) => !arg.startsWith("--"));
  if (!paneId) {
    console.error("用法：hapi wait-pane <pane-id> [--timeout <秒>]");
    return WAIT_EXIT.usage;
  }
  const timeoutSec = numberFlag(args, "--timeout") ?? DEFAULT_TIMEOUT_SEC;

  console.log(`[wait-pane] 等待 ${paneId} 收敛（超时 ${timeoutSec}s）`);
  const result = waitForPaneSettle(paneId, { timeoutMs: timeoutSec * 1000 }, deps);
  console.log(
    `[wait-pane] ${paneId} → ${result.outcome}（status=${result.status}，`
    + `seq ${result.baselineSeq ?? "-"}→${result.seq ?? "-"}，耗时 ${Math.round(result.elapsedMs / 1000)}s）`,
  );
  return WAIT_EXIT[result.outcome];
}
