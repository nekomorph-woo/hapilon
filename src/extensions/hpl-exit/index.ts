/**
 * hpl-exit — /exit 与裸 exit 退出
 *
 * Claude Code(/exit)与 cursor-agent(裸 exit)的退出习惯;pi 内置
 * 只有 /quit。裸 exit 走 input 拦截:仅交互输入的精确 "exit" 触发,
 * 其余(如 "exit vim 怎么办")原样放行给模型。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hplExit(pi: ExtensionAPI): void {
  pi.registerCommand("exit", {
    description: "Quit hapilon (alias of /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" || event.text.trim() !== "exit") {
      return undefined;
    }
    ctx.shutdown();
    return { action: "handled" };
  });
}
