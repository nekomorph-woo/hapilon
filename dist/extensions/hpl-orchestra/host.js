/**
 * host.ts — /team 的宿主判别（唯一出处）。
 *
 * 一个已解析的宿主只有三种结果：
 * - tui  ：HERDR_ENV=1 且 HERDR_PANE_ID 非空（herdr 面板内）。
 * - core ：HC_TERMINAL_ID 非空且不在 herdr 面板内（herdr-core 终端里直接跑 hapi）。
 * - none ：两者皆缺，或身份嵌套/残缺（歧义）。
 *
 * 判定只看实际宿主环境，绝不看 CLI 是否可用——herdr/hc 装没装不影响判别，
 * 传输层在调用点按宿主分流（transport.ts）。歧义一律落 none 并带原因，
 * 由调用方拒绝编排操作，不做猜测。
 */
import { createHash } from "node:crypto";
/**
 * core 命名空间线索：HC_TERMINAL_SOCKET（实测环境变量）是 socket 路径——
 * 路径不进文件名（分隔符/长度不可控），落 sha256 前 10 位十六进制摘要。
 * core.id 跨 scratch 会话可重复，单靠终端地址不足以区分两套 socket；线索
 * 缺失时不猜——命名空间退化为地址，跨 socket 同地址的极端场景由 owner 侧
 * launch 身份校验兜底。
 */
function coreNamespace(env) {
    const socket = env.HC_TERMINAL_SOCKET?.trim();
    if (socket)
        return `s${createHash("sha256").update(socket).digest("hex").slice(0, 10)}`;
    const serverId = env.HC_SERVER_ID?.trim();
    return serverId || undefined;
}
export function resolveHost(env = process.env) {
    const herdrActive = env.HERDR_ENV === "1";
    const paneId = env.HERDR_PANE_ID?.trim();
    const terminalId = env.HC_TERMINAL_ID?.trim();
    if (herdrActive && terminalId) {
        return { kind: "none", reason: "宿主身份歧义：herdr 面板内出现 HC_TERMINAL_ID" };
    }
    if (herdrActive) {
        if (!paneId)
            return { kind: "none", reason: "herdr 环境缺少 HERDR_PANE_ID" };
        return { kind: "tui", paneId };
    }
    if (terminalId) {
        const namespace = coreNamespace(env);
        return namespace
            ? { kind: "core", terminalId, namespace }
            : { kind: "core", terminalId };
    }
    return { kind: "none", reason: "非团队宿主：既无 herdr 面板身份也无 core 终端身份" };
}
/** 当前宿主的编址 id：tui 是 pane id，core 是终端 id；none 返回 undefined。 */
export function hostAddress(host = resolveHost()) {
    if (host.kind === "tui")
        return host.paneId;
    if (host.kind === "core")
        return host.terminalId;
    return undefined;
}
export function isCoreHost(host = resolveHost()) {
    return host.kind === "core";
}
export function isTeamCapableHost(host = resolveHost()) {
    return host.kind !== "none";
}
