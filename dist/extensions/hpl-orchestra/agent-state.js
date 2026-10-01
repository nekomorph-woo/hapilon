import { existsSync } from "node:fs";
import { Effect } from "effect";
import { agentGet, defaultSpawn, paneAgentAlive, paneRead } from "./herdr.js";
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
export function screenAwaitingInput(samples) {
    if (!samples || samples.length < 2)
        return false;
    return samples.slice(-2).every(matchesDialog);
}
/** 采样两帧屏幕，判断 pane 是不是停在交互 UI（弹窗/确认框）。 */
export const paneAwaitingInputEffect = (paneId, spawn = defaultSpawn) => Effect.gen(function* () {
    const first = yield* paneRead(paneId, spawn);
    const second = yield* paneRead(paneId, spawn);
    return screenAwaitingInput([first, second].filter((sample) => sample !== undefined));
});
/**
 * 判定优先级：dead（无 pane）→ waiting-input（两次采样确认弹窗）→ done（herdr 已停
 * 且回执在）→ stale（herdr 已停、在办任务超阈且回执缺席）→ idle（活着、当前无 turn）
 * → working → unknown。
 * 连通性永不作为完成性证据；idle 与无报告都不是完成凭证；信号不足时不猜，落到 unknown。
 */
export function resolveAgentState(signals) {
    if (!signals.paneAlive)
        return "dead";
    if (screenAwaitingInput(signals.paneSamples))
        return "waiting-input";
    const { herdrStatus, reportExists } = signals;
    if (idleLike(herdrStatus) && reportExists)
        return "done";
    // stale 只适用于已停下的 pane：任务记录年龄是记账新鲜度，不是活动心跳，不能推翻
    // herdr 的 working（hapi 每个 turn_start 都上报），否则长任务会被误判 stale 而遭打断。
    const threshold = signals.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    if (idleLike(herdrStatus) && !reportExists && signals.expectedReportAgeMs !== undefined
        && signals.expectedReportAgeMs >= threshold) {
        return "stale";
    }
    // herdr 报告已停：活着、当前没有 turn。回执缺席只说明任务没做完，不能反推忙碌
    if (idleLike(herdrStatus))
        return "idle";
    if (herdrStatus === "working")
        return "working";
    return "unknown";
}
/** pi 新会话启动时打印的横幅（清空成功的证词） */
export const NEW_SESSION_MARKER = "✓ New session started";
/** 文本里出现标记的次数；读不到按 0 记。 */
function markerCount(text) {
    return text === undefined ? 0 : text.split(NEW_SESSION_MARKER).length - 1;
}
/**
 * 清空是否落地：近期输出里新会话标记的**条数增加**。
 *
 * 判据故意与 herdr 的 agent_status / state_change_seq 词表无关：`/new` 对 herdr 而言只是
 * release + 同值重报，seq 不动、状态停在 done，靠状态猜必然误判。只认屏幕证据。
 *
 * 只看视口（调用方的 pane read 用 `visible`）：会话一旦开工，启动横幅会被顶出视口，
 * 因此视口里的横幅基本等价于「刚开过新会话」，滚动缓冲里的旧横幅不会误伤。
 *
 * 判定用条数增量而不是「这一屏变了」：屏变了并不等于新横幅出来了——输入框里有半截文本
 * 时，`/new` 会被当正文提交，这一屏确实多了一行消息，但那是提交失败的证据。
 * 基线本来就停在会话起点（1 → 1）时退化成「未见新会话标记」提醒——旧上下文本就是空的，
 * 误报无害。
 */
export function newSessionMarkerSeen(baseline, current) {
    return markerCount(current) > markerCount(baseline);
}
/**
 * 生产侧采样：pane 存活 + herdr 状态 + 两次屏文本 + 回执存在性。
 * ponytail: 两次读之间只隔一次 spawn 往返（几十毫秒），不额外 sleep，保持同步可跑；
 * 若半帧误报真的出现，改成异步 probe + Effect.sleep 分离两次采样。
 */
export const sampleAgentStateEffect = (paneId, options = {}) => Effect.gen(function* () {
    const spawn = options.spawn ?? defaultSpawn;
    const now = options.now ?? Date.now;
    // dead = pane 里已经没有 agent：pane 关了，或 pi 崩了只剩 shell（后者以前会被当成 alive）
    if (!(yield* paneAgentAlive(paneId, spawn)))
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
        expectedReportAgeMs: options.expectedReportSince === undefined
            ? undefined
            : now() - options.expectedReportSince,
    });
});
