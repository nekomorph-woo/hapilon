import { existsSync } from "node:fs";
import { Effect } from "effect";
import { agentGet, defaultSpawn, paneGet, paneRead } from "./herdr.js";
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
];
export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;
function idleLike(status) {
    // herdr 的 done = 后台工作结束后未被查看的 idle，同属「已停止」信号
    return status === "idle" || status === "done";
}
function matchesDialog(text) {
    return DIALOG_MARKERS.some((marker) => text.includes(marker));
}
/** 连续两次采样都命中弹窗标记才算确认：单个半帧片段不足以判定等待输入。 */
function dialogConfirmed(samples) {
    if (!samples || samples.length < 2)
        return false;
    return samples.slice(-2).every(matchesDialog);
}
/**
 * 判定优先级：dead（无 pane）→ waiting-input（两次采样确认弹窗）→ done（herdr 已停
 * 且回执在）→ stale（已停/工作中超阈且回执缺席）→ working → unknown。
 * 连通性永不作为完成性证据；信号不足时不猜，落到 unknown。
 */
export function resolveAgentState(signals) {
    if (!signals.paneAlive)
        return "dead";
    if (dialogConfirmed(signals.paneSamples))
        return "waiting-input";
    const { herdrStatus, reportExists } = signals;
    if (idleLike(herdrStatus) && reportExists)
        return "done";
    const threshold = signals.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    const stoppedOrBusy = herdrStatus === "working" || idleLike(herdrStatus);
    if (!reportExists && stoppedOrBusy && signals.lastActivityMs !== undefined
        && signals.lastActivityMs >= threshold) {
        return "stale";
    }
    // idle/done 但回执缺席：不是 done（回执才是凭证），也不足以判 stale
    if (stoppedOrBusy)
        return "working";
    return "unknown";
}
const activities = new Map();
export function resetAgentStateActivity() {
    activities.clear();
}
function observeActivity(paneId, status, at) {
    const previous = activities.get(paneId);
    const since = previous && previous.status === status ? previous.since : at;
    activities.set(paneId, { status, since });
    return at - since;
}
/**
 * 生产侧采样：pane 存活 + herdr 状态 + 两次屏文本 + 回执存在性。
 * ponytail: 两次读之间只隔一次 spawn 往返（几十毫秒），不额外 sleep，保持同步可跑；
 * 若半帧误报真的出现，改成异步 probe + Effect.sleep 分离两次采样。
 */
export const sampleAgentStateEffect = (paneId, options = {}) => Effect.gen(function* () {
    const spawn = options.spawn ?? defaultSpawn;
    const now = options.now ?? Date.now;
    const pane = yield* paneGet(paneId, spawn);
    if (!pane)
        return "dead";
    const herdrStatus = yield* agentGet(paneId, spawn);
    const first = yield* paneRead(paneId, spawn);
    const second = yield* paneRead(paneId, spawn);
    const samples = [first, second].filter((sample) => sample !== undefined);
    return resolveAgentState({
        paneAlive: true,
        herdrStatus,
        paneSamples: samples,
        reportExists: options.reportPath !== undefined && existsSync(options.reportPath),
        lastActivityMs: observeActivity(paneId, herdrStatus, now()),
    });
});
