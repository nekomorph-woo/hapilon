/**
 * core-owner-tools.ts — core 宿主的 owner 控制工具。
 *
 * core（herdr-core 终端）里 slash 文本会被 pi 输入包装层改写，且 `hc send
 * --if idle` 投不进正在工作的 owner 自己——所以自开面板/清空这类 owner 控制
 * 动作不走文本投递，走注册工具。只在 core 宿主注册；TUI 宿主维持 slash 流。
 */
import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";
import { isCoreHost } from "./host.js";
import { defaultSpawn } from "./herdr.js";
import { clearRoleBySelector, openRoleByKey } from "./menu.js";
import { getAllRoleDefs } from "./role-registry.js";
import { isTeamOwner, readTeamState } from "./state.js";
const TEAM_CTL = "team_ctl";
/** handler 侧守卫：角色 pane 与非 owner 的调用一律拒绝，并回实际原因。 */
function ownerGuard() {
    if (process.env.HAPI_ORCH_ROLE)
        return "角色面板不允许调用 team_ctl";
    const state = readTeamState();
    if (!state.enabled || !isTeamOwner(state))
        return "当前进程不是进行中团队的主面板（owner）";
    return undefined;
}
function actionContext(toolCtx) {
    const source = toolCtx;
    return {
        cwd: process.cwd(),
        ui: { notify: (message, type) => notify(message, type ?? "info") },
        sessionManager: { getSessionFile: () => source.sessionManager?.getSessionFile() },
    };
}
const clearLine = (outcome, target) => ({
    ok: outcome.ok,
    text: `[team_ctl clear ${target}] ${outcome.line}`,
});
export function registerCoreOwnerTools(pi, spawn = defaultSpawn) {
    if (!isCoreHost() || process.env.HAPI_ORCH_ROLE)
        return;
    let registered = false;
    pi.on("before_agent_start", () => {
        const allowed = ownerGuard() === undefined;
        if (!registered) {
            if (!allowed)
                return;
            pi.registerTool(buildTeamCtlTool(spawn));
            registered = true;
        }
        const active = pi.getActiveTools();
        if (active.includes(TEAM_CTL) !== allowed) {
            pi.setActiveTools(allowed ? [...active, TEAM_CTL] : active.filter((name) => name !== TEAM_CTL));
        }
    });
}
function buildTeamCtlTool(spawn) {
    return defineTool({
        name: TEAM_CTL,
        label: "Team Control",
        description: "Core-host team owner control: open a role terminal (action open, role key, optional model) "
            + "or clear a role terminal's context (action clear, target = role key or terminal address). "
            + "Refuses while the target is working or blocked; a refused clear marks it clear? — never dispatch to it.",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("open"), Type.Literal("clear")], { description: "open = 拉起角色终端；clear = 清空角色上下文" }),
            role: Type.Optional(Type.String({ description: "open：角色 key（worker/reviewer/…）" })),
            model: Type.Optional(Type.String({ description: "open：显式模型（如 tier:sonnet[1]）" })),
            target: Type.Optional(Type.String({ description: "clear：角色 key 或终端地址" })),
        }),
        execute: async (_toolCallId, params, _signal, _onUpdate, toolCtx) => {
            // handler 侧守卫：注册后归属可能变化（团队被结束/接管），调用当下再查。
            const refused = ownerGuard();
            if (refused) {
                return { content: [{ type: "text", text: `[team_ctl] ${refused}` }], details: {}, isError: true };
            }
            const ctx = actionContext(toolCtx);
            try {
                if (params.action === "open") {
                    if (!params.role) {
                        return { content: [{ type: "text", text: "open 需要 role（角色 key）" }], details: {}, isError: true };
                    }
                    await openRoleByKey(ctx, spawn, params.role, params.model);
                    return { content: [{ type: "text", text: `open ${params.role} 已执行，以 team-status / 状态通知为准` }], details: {} };
                }
                const target = params.target?.trim();
                if (!target) {
                    return { content: [{ type: "text", text: "clear 需要 target（角色 key 或终端地址）" }], details: {}, isError: true };
                }
                const outcome = await clearRoleBySelector(ctx, spawn, target, getAllRoleDefs());
                const line = clearLine(outcome, target);
                return { content: [{ type: "text", text: line.text }], details: {}, isError: !line.ok };
            }
            catch (error) {
                // 实际错误如实上报：吞掉会让 owner 以为动作已发生。
                const message = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `[team_ctl] 执行失败：${message}` }], details: {}, isError: true };
            }
        },
    });
}
