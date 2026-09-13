import { Effect } from "effect";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  assistantMessageText,
  completePendingRole,
  getPendingRoleWizard,
  handlePendingUserMessage,
  handleTeamCommand,
  TEAM_ACTIONS,
  updateTeamStatus,
} from "./menu.js";
import { herdrEnvAvailable } from "./herdr.js";
import { buildTeamSectionsEffect } from "./state.js";
import { setTeamSections } from "./bridge.js";
import { parseRoleDefSentinel } from "./role-wizard.js";

/** system-prompt 组装方只消费 setStatus 能力——收窄参数面（review #15） */
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
      const key = args.trim();
      if (!key) {
        ctx.ui.notify("用法：/team:open <角色 key>（如 worker / reviewer）", "error");
        return;
      }
      // 不弹档位：主 agent 自己开面板时没人应答弹窗，一律用角色默认档
      await handleTeamCommand(pi, `打开角色 ${key}`, ctx);
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

  pi.registerCommand("team:open-reviewer", {
    description: "Open the reviewer pane (reuse it if already open)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
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
      (ctx as unknown as StatusOnlyContext).ui.setStatus("team", undefined);
      return;
    }
    await updateTeamStatus(ctx as unknown as BeforeAgentStartContext & ExtensionCommandContext);
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
