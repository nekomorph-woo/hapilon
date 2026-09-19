/** 源必须稳定且唯一——herdr 用它区分同一 pane 上的不同上报方 */
export const HERDR_SOURCE = "custom:hapilon";
/** 上报的 agent 标识：herdr 界面/agent list 里显示的名字 */
export const HERDR_AGENT = "hapi";
/** 只在 herdr pane 内、且 CLI 与 pane 信息齐全时启用；其余环境严格 no-op */
export function reporterEnabled(env) {
    return env.herdrEnv === "1" && Boolean(env.binPath) && Boolean(env.paneId);
}
/** report-agent 参数（不含 binPath）；seq 由调用方递增 */
export function reportAgentArgs(paneId, state, seq, options = {}) {
    const args = [
        "pane", "report-agent", paneId,
        "--source", HERDR_SOURCE,
        "--agent", HERDR_AGENT,
        "--state", state,
        "--seq", String(seq),
    ];
    if (options.message)
        args.push("--message", options.message);
    if (options.sessionPath)
        args.push("--agent-session-path", options.sessionPath);
    return args;
}
/** release-agent 参数：进程退出时释放同一 source 的生命周期权威 */
export function releaseAgentArgs(paneId) {
    return ["pane", "release-agent", paneId, "--source", HERDR_SOURCE, "--agent", HERDR_AGENT];
}
/** blocked 的说明文本：UI prompt 的标题优先，否则用 prompt 类型 */
export function blockMessage(event) {
    const kind = event.kind ?? "prompt";
    return event.title ? `${kind}: ${event.title}` : kind;
}
const REPORT_TIMEOUT_MS = 3000;
/**
 * 状态上报器。上报失败绝不打断 pi 会话：只是 herdr 侧状态不更新，
 * 因此 catch 后经 onError 报警一次，而不是静默吞掉。
 */
export function createHerdrReporter(deps) {
    const enabled = reporterEnabled(deps.env);
    const onError = deps.onError ?? ((message) => console.warn(message));
    // herdr 对每个 (pane, source) 记住已接受的最大 seq，凡 seq <= 它的上报一律「接受但丢弃」
    // （退出码 0、无错误输出），而本扩展每次 /new 或进程重启都会重建、计数从 0 重来，
    // 于是收编/换会话后整个 pane 的上报会静默失效到计数追平旧值为止。
    // 故用墙钟毫秒做 seq（跨实例、跨进程单调），同毫秒内再 +1 保证严格递增。
    let seq = 0;
    const now = deps.now ?? Date.now;
    const nextSeq = () => {
        seq = Math.max(seq + 1, now());
        return seq;
    };
    const call = (args) => {
        try {
            const result = deps.spawn(deps.env.binPath, args, { encoding: "utf8", timeout: REPORT_TIMEOUT_MS });
            if (result.error) {
                onError(`[hpl-herdr] 状态上报失败：${result.error.message}`);
                return;
            }
            // herdr 拒绝（exit 1 + stderr JSON）以前被完全吞掉，这里至少留一条线索
            if (result.status !== 0) {
                const detail = (result.stderr?.toString() ?? "").trim().slice(0, 200);
                onError(`[hpl-herdr] herdr 拒绝上报（exit ${result.status}）：${detail}`);
            }
        }
        catch (error) {
            onError(`[hpl-herdr] 状态上报失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    return {
        enabled,
        report(state, options) {
            if (!enabled)
                return;
            call(reportAgentArgs(deps.env.paneId, state, nextSeq(), options));
        },
        release() {
            if (!enabled)
                return;
            call(releaseAgentArgs(deps.env.paneId));
        },
    };
}
