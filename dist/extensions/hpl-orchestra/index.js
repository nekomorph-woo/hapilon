import { Effect } from "effect";
import { assistantMessageText, completePendingRole, getPendingRoleWizard, handlePendingUserMessage, handleTeamCommand, TEAM_ACTIONS, updateTeamStatus, } from "./menu.js";
import { herdrEnvAvailable } from "./herdr.js";
import { buildTeamSectionsEffect } from "./state.js";
import { setTeamSections } from "./bridge.js";
import { parseRoleDefSentinel } from "./role-wizard.js";
export default function hplOrchestra(pi) {
    pi.registerCommand("team", {
        description: "Manage the herdr three-pane team",
        handler: async (args, ctx) => {
            if (!herdrEnvAvailable()) {
                ctx.ui.notify("/team 仅能在 herdr 面板环境中使用。", "error");
                return;
            }
            await handleTeamCommand(pi, args, ctx);
        },
    });
    pi.registerCommand("team:open-reviewer", {
        description: "Open the reviewer pane (reuse it if already open)",
        handler: async (_args, ctx) => {
            if (!herdrEnvAvailable()) {
                ctx.ui.notify("/team:open-reviewer 仅能在 herdr 面板环境中使用。", "error");
                return;
            }
            // 复用菜单同一路径：role 解析/ensurePane 复用判定/状态注册只有一份实现。
            await handleTeamCommand(pi, TEAM_ACTIONS.review, ctx);
        },
    });
    pi.on("before_agent_start", async (_event, ctx) => {
        // 每轮现读 env + 状态文件写入 bridge，供 hpl-system-prompt 组装消费；
        // 无模块缓存（jiti 每扩展独立实例，跨扩展必须走本进程内显式传递）。
        setTeamSections(Effect.runSync(buildTeamSectionsEffect()));
        if (!herdrEnvAvailable()) {
            ctx.ui.setStatus("team", undefined);
            return;
        }
        await updateTeamStatus(ctx);
    });
    pi.on("message_end", async (event) => {
        if (handlePendingUserMessage(event.message))
            return;
        const pending = getPendingRoleWizard();
        if (!pending)
            return;
        const parsed = parseRoleDefSentinel(assistantMessageText(event.message));
        if (!parsed)
            return;
        await completePendingRole(parsed);
    });
}
