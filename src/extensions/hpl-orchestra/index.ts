import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleTeamCommand, updateTeamStatus } from "./menu.js";
import { herdrEnvAvailable } from "./herdr.js";

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
    if (!herdrEnvAvailable()) {
      ctx.ui.setStatus("team", undefined);
      return;
    }
    await updateTeamStatus(ctx as ExtensionCommandContext);
  });
}
