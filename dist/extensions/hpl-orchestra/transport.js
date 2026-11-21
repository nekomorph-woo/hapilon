/**
 * transport.ts — 按实际宿主分流的团队传输层（唯一 seam）。
 *
 * 函数签名与 herdr.ts 同形：menu/state/agent-state/team-cli 只换 import，
 * 不改调用面。分流只看 resolveHost()（实际宿主环境），绝不看 CLI 是否可用。
 * none/歧义宿主一律拒绝编排动作（返回失败态），不猜、不回落、不重试。
 */
import { Effect } from "effect";
import { notify } from "../notify.js";
import { agentStateWithSeq as herdrAgentStateWithSeq, defaultSpawn, paneAgentAlive as herdrPaneAgentAlive, paneForegroundBusy as herdrPaneForegroundBusy, paneGet as herdrPaneGet, panePresence as herdrPanePresence, paneRead as herdrPaneRead, paneRename as herdrPaneRename, paneRun as herdrPaneRun, paneSplit as herdrPaneSplit, paneWidths as herdrPaneWidths, agentSubmitPrompt as herdrAgentSubmitPrompt, } from "./herdr.js";
import { coreClearKeys, coreKill, coreLabel, coreRead, coreRunBg, coreSend, coreStateIrreversible, coreTerminalGet, coreStatus, isOurAgentApp, } from "./core.js";
import { hostAddress, isCoreHost, isTeamCapableHost, resolveHost } from "./host.js";
export { defaultSpawn };
/** none/歧义宿主的统一拒绝：警告说明原因，动作不执行（静默拒绝会把失败记成成功）。 */
function refuseHost(op) {
    const host = resolveHost();
    const reason = host.kind === "none" ? host.reason : "宿主状态异常";
    notify(`[hpl-orchestra] ${op} 被拒绝：${reason}`, "warning");
}
export function paneGet(paneId, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`查询 ${paneId}`);
        return Effect.succeed(undefined);
    }
    if (!isCoreHost())
        return herdrPaneGet(paneId, spawn);
    return Effect.map(coreTerminalGet(paneId, spawn), (terminal) => terminal
        ? { paneId: terminal.terminalId, ...(terminal.workStatus ? { status: terminal.workStatus } : {}), ...(terminal.label ? { label: terminal.label } : {}) }
        : undefined);
}
/**
 * 存活判定三态。core：终端生命周期已终结 → missing；app 未上报或不是我们
 * 拉起的 hapi → unknown（启动窗口或无关程序占位——绝不指向无关终端）；
 * app 命中 hapi → alive。
 */
export function panePresence(paneId, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`探活 ${paneId}`);
        return Effect.succeed({ status: "unknown" });
    }
    if (!isCoreHost())
        return herdrPanePresence(paneId, spawn);
    return Effect.gen(function* () {
        const terminal = yield* coreTerminalGet(paneId, spawn);
        if (!terminal)
            return { status: "missing" };
        if (coreStateIrreversible(terminal.state))
            return { status: "missing" };
        if (!isOurAgentApp(terminal.app))
            return { status: "unknown" };
        return { status: "alive", pane: { paneId: terminal.terminalId, ...(terminal.workStatus ? { status: terminal.workStatus } : {}), ...(terminal.label ? { label: terminal.label } : {}) } };
    });
}
export function paneAgentAlive(paneId, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`探活 ${paneId}`);
        return Effect.succeed(false);
    }
    if (!isCoreHost())
        return herdrPaneAgentAlive(paneId, spawn);
    // core：只有「我们的 hapi 在前台」才算活——unknown/missing 都不算。
    return Effect.map(panePresence(paneId, spawn), (presence) => presence.status === "alive");
}
export function agentGet(paneId, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`读取状态 ${paneId}`);
        return Effect.succeed("unknown");
    }
    if (!isCoreHost())
        return herdrAgentStateWithSeq(paneId, spawn).pipe(Effect.map((s) => s.status));
    return coreStatus(paneId, spawn);
}
export function agentStateWithSeq(paneId, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`读取状态 ${paneId}`);
        return Effect.succeed({ status: "unknown", seq: undefined });
    }
    if (!isCoreHost())
        return herdrAgentStateWithSeq(paneId, spawn);
    // core 没有 herdr 的状态序号：seq 恒缺。core 的收敛等待走 hc send --wait
    // （宿主专属派发路由），wait-pane 这条 TUI 通道在 core 不该被使用。
    return Effect.map(coreStatus(paneId, spawn), (status) => ({ status, seq: undefined }));
}
export function paneRead(paneId, spawn = defaultSpawn, options = {}) {
    if (!isTeamCapableHost()) {
        refuseHost(`读屏 ${paneId}`);
        return Effect.succeed(undefined);
    }
    if (!isCoreHost())
        return herdrPaneRead(paneId, spawn, options);
    return coreRead(paneId, spawn, options.lines ?? 40);
}
export function paneRename(paneId, label, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`打标签 ${paneId}`);
        return Effect.succeed(false);
    }
    if (!isCoreHost())
        return herdrPaneRename(paneId, label, spawn);
    return coreLabel(paneId, label, spawn);
}
/**
 * 一次写入文本+回车的派发。core 走 `hc send --if idle`：目标 working/blocked
 * 时 hc 拒绝（active 守卫），返回 false——与 TUI 侧失败同形，上层照常拦截派发。
 */
export function paneRun(paneId, command, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`派发 ${paneId}`);
        return Effect.succeed(false);
    }
    if (!isCoreHost())
        return herdrPaneRun(paneId, command, spawn);
    return Effect.map(coreSend(paneId, command, spawn), (outcome) => outcome === "sent");
}
/**
 * 清空提交的宿主专属通道：TUI 是 pane 级一次写入 `/new`；core 是
 * `hc keys / n e w enter`（send 整段 "/new" 会被 slash 补全改写，探针已验证
 * 键序渲染 `New session started`）。证据复核（marker 增量）留在调用方。
 */
export function paneClear(paneId, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`清空 ${paneId}`);
        return Effect.succeed(false);
    }
    if (!isCoreHost())
        return herdrPaneRun(paneId, "/new", spawn);
    return coreClearKeys(paneId, spawn);
}
export function agentSubmitPrompt(paneId, text, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`探测提交 ${paneId}`);
        return Effect.succeed("failed");
    }
    if (!isCoreHost())
        return herdrAgentSubmitPrompt(paneId, text, spawn);
    // hc 对自定义 agent 没有 herdr 的 agent prompt 通道：恒 not-ready，
    // 让调用方（submitClear）直接落宿主主路径。
    return Effect.succeed("not-ready");
}
export function runPaneClose(paneId, spawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`关闭 ${paneId}`);
        return Effect.succeed(false);
    }
    if (!isCoreHost()) {
        return Effect.try({
            try: () => {
                const bin = process.env.HERDR_BIN_PATH ?? "herdr";
                const result = spawn(bin, ["pane", "close", paneId], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
                return result.status === 0;
            },
            catch: () => false,
        }).pipe(Effect.catchAll(() => Effect.sync(() => false)));
    }
    return coreKill(paneId, spawn);
}
export function paneSplit(cwd, spawn, launch) {
    if (resolveHost().kind !== launch.kind) {
        refuseHost("开面板");
        return Effect.succeed(undefined);
    }
    if (launch.kind === "core")
        return coreRunBg({ cwd, argv: launch.argv, names: launch.names }, spawn);
    return Effect.map(herdrPaneSplit(cwd, spawn, launch.envArgs, launch.layout), (paneId) => paneId ? { paneId, nickname: launch.nickname } : undefined);
}
/** core 没有 layout 查询：空表让 planRoleSplit 走默认方向。 */
export function paneWidths(spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost("读布局");
        return Effect.succeed(new Map());
    }
    if (!isCoreHost())
        return herdrPaneWidths(spawn);
    return Effect.succeed(new Map());
}
export function paneForegroundBusy(paneId, spawn = defaultSpawn) {
    if (!isTeamCapableHost()) {
        refuseHost(`读前台 ${paneId}`);
        return Effect.succeed(false);
    }
    if (!isCoreHost())
        return herdrPaneForegroundBusy(paneId, spawn);
    return Effect.map(coreStatus(paneId, spawn), (status) => status === "working");
}
/**
 * 通知类投递（wake-owner）：同 paneRun 守卫，但 core 不等 owner 整轮收敛
 * （hc send 无 --wait）——通知发出即返回，owner 侧收敛由它自己的循环处理。
 */
export function paneNotify(paneId, text, spawn = defaultSpawn) {
    return paneRun(paneId, text, spawn);
}
/** paneRun 的语义别名：投递一段文本，宿主分流同 paneRun。 */
export const agentPrompt = paneRun;
/** owner 派发后的收敛等待路由（prompt 文案用）：TUI wait-pane / core hc send --wait。 */
export function dispatchWaitRoute() {
    if (isCoreHost())
        return `hc send <地址> "<task>" --if idle --wait`;
    return `herdr pane run <id> "<task>" && node "$HAPILON_CLI_PATH" wait-pane <id>`;
}
/** 当前宿主能用的地址；none 返回 undefined（调用方拒绝编排）。 */
export function currentAddress() {
    return hostAddress();
}
