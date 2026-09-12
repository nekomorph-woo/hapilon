import { Effect } from "effect";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleTeamCommand, updateTeamStatus } from "./menu.js";
import { herdrEnvAvailable } from "./herdr.js";
import { buildTeamSectionsEffect } from "./state.js";
import { setTeamSections } from "./bridge.js";

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
}
