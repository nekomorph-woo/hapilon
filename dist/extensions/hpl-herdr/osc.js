/**
 * herdr-app 通道：OSC 7501（Program Status Protocol）直接写 pty。herdr-app
 * （libghostty 内嵌）解析后驱动 pane 的 agent 识别与状态显示；app=hapilon
 * 让它认出 hapilon，而不是回落按进程名显示 pi。
 *
 * 盲写即可：协议规定不支持该 OSC 的终端静默忽略，无需查询握手。
 */
import { formatProgramStatus } from "@earendil-works/pi-tui";
import { writeSync } from "node:fs";
import { reporterEnabled, } from "./report.js";
/** herdr-app 界面显示的程序名（OSC 7501 app 键，[A-Za-z0-9_.+-]{1,32}） */
export const OSC_APP = "hapilon";
/** CLI 通道激活时（herdr-tui 官方集成）让路，避免同一 pane 双通道 */
export function oscEnabled(env, isTTY) {
    return Boolean(isTTY) && !reporterEnabled(env);
}
/** 编码一条状态上报；msg 仅在有说明文本时携带（与 CLI 路径同约定） */
export function programStatusSequence(state, message) {
    return formatProgramStatus({ state, app: OSC_APP, message });
}
/**
 * OSC 7501 出口，与 CLI reporter 同接口，index.ts 里并联使用。
 * release 写 state=clear，终端撤掉状态显示（对应 CLI 路径的 release-agent）。
 */
export function createOscReporter(deps) {
    const enabled = oscEnabled(deps.env, deps.isTTY);
    const write = deps.write ?? ((sequence) => writeSync(1, sequence));
    return {
        enabled,
        report(state, options) {
            if (!enabled)
                return;
            write(programStatusSequence(state, options?.message));
        },
        release() {
            if (!enabled)
                return;
            write(formatProgramStatus({ state: "clear" }));
        },
    };
}
