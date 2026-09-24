import { Effect } from "effect";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  assistantMessageText,
  completePendingRole,
  getPendingRoleWizard,
  handlePendingUserMessage,
  handleTeamCommand,
  updateTeamStatus,
} from "./menu.js";
import { herdrEnvAvailable } from "./herdr.js";
import { discardPendingThinkingSwitch, recordModelSwitch, recordOwnCompletedTasks, recordThinkingSwitch } from "./adaptive-facts.js";
import { buildTeamSectionsEffect } from "./state.js";
import { setTeamSections } from "./bridge.js";
import { parseRoleDefSentinel } from "./role-wizard.js";

/** system-prompt 组装方只消费 setStatus 能力——收窄参数面 */
type StatusOnlyContext = { ui: { setStatus: (key: string, text: string | undefined) => void } };

interface BeforeAgentStartContext {
  ui: { setStatus: (key: string, text: string | undefined) => void };
  hasUI?: boolean;
  mode?: string;
}

export default function hplOrchestra(pi: ExtensionAPI): void {
  pi.registerCommand("team", {
    description: "Manage the herdr three-pane team",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!herdrEnvAvailable()) {
        ctx.ui.notify("/team 仅能在 herdr 面板环境中使用。", "error");
        return;
      }
      await handleTeamCommand(pi, args, ctx);
    },
  });

  pi.registerCommand("team:open", {
    description: "Open (or revive) a role pane at its default tier, no dialogs",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!herdrEnvAvailable()) {
        ctx.ui.notify("/team:open 仅能在 herdr 面板环境中使用。", "error");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const key = parts[0];
      if (!key) {
        ctx.ui.notify("用法：/team:open <角色 key> [模型]（模型如 tier:sonnet[1] 或 provider/id:high）", "error");
        return;
      }
      // 不弹档位：主 agent 自己开面板时没人应答弹窗，一律用角色默认档；
      // 带模型参数时是用户点名，作为最高优先覆盖交给选模。
      const explicitModel = parts.slice(1).join(" ");
      await handleTeamCommand(pi, `打开角色 ${key}${explicitModel ? ` ${explicitModel}` : ""}`, ctx);
    },
  });

  pi.registerCommand("team:kick", {
    description: "Kick a role pane out of the team (role key or pane id), no dialogs",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!herdrEnvAvailable()) {
        ctx.ui.notify("/team:kick 仅能在 herdr 面板环境中使用。", "error");
        return;
      }
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("用法：/team:kick <角色 key | pane id>", "error");
        return;
      }
      await handleTeamCommand(pi, `踢出角色 ${target}`, ctx);
    },
  });

  pi.registerCommand("team:clear", {
    description: "Clear a role pane's context, no dialogs (role key or pane id)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!herdrEnvAvailable()) {
        ctx.ui.notify("/team:clear 仅能在 herdr 面板环境中使用。", "error");
        return;
      }
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("用法：/team:clear <角色 key | pane id>", "error");
        return;
      }
      const result = await handleTeamCommand(pi, `清空角色 ${target}`, ctx);
      // 拒绝原因必须进模型上下文：命令回执只到 UI，owner 看不到自己刚被拒了
      if (result && !result.ok) {
        await pi.sendMessage(
          { customType: "team:clear-refused", content: `[team:clear ${target}] ${result.line}`, display: false },
          { deliverAs: "nextTurn" },
        );
      }
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // 每轮现读 env + 状态文件写入 bridge，供 hpl-system-prompt 组装消费；
    // 无模块缓存（jiti 每扩展独立实例，跨扩展必须走本进程内显式传递）。
    setTeamSections(Effect.runSync(buildTeamSectionsEffect()));
    // 角色 pane 自己上报已完成任务（事实来源是该 pane 的任务列表；owner 不代报）
    recordOwnCompletedTasks(ctx as { model?: { provider?: string; id?: string } });
    if (!herdrEnvAvailable()) {
      (ctx as unknown as StatusOnlyContext).ui.setStatus("team", undefined);
      return;
    }
    await updateTeamStatus(ctx as unknown as BeforeAgentStartContext & ExtensionCommandContext);
  });

  pi.on("model_select", (event, ctx) => {
    // 模型切换会先 setThinkingLevel 再发本事件；同轮缓冲的 thinking 事件是切换的
    // 附带变化，不是用户偏好，先丢弃再记切模。restore/owner 由 recordModelSwitch 过滤。
    discardPendingThinkingSwitch();
    recordModelSwitch(event, { thinking: ctx.thinkingLevel });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    // 先缓冲，同轮如果来 model_select 就丢弃；直接切 thinking 才落盘（自适应 thinking 偏好）
    recordThinkingSwitch(event, { model: ctx.model });
  });

  pi.on("message_end", async (event) => {
    if (handlePendingUserMessage(event.message)) return;
    const pending = getPendingRoleWizard();
    if (!pending) return;
    const parsed = parseRoleDefSentinel(assistantMessageText(event.message));
    if (!parsed) return;
    await completePendingRole(parsed);
  });
}
