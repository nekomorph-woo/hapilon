/**
 * hpl-exit — /exit 退出
 *
 * pi 内置只有 /quit；注册 /exit 作为别名。裸 exit 不拦截，
 * 交给模型正常回答（避免误触退出）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hplExit(pi: ExtensionAPI): void {
  pi.registerCommand("exit", {
    description: "Quit hapilon (alias of /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
