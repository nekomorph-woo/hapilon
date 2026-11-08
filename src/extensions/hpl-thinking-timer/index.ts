import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachThinkingHooks, type ThinkingStyle } from "./timer.js";

// 思考折叠标签计时：补丁（ensure-pi-patch 的 hapiThinkingElapsed 规则）把折叠标签
// 节点与每帧渲染改走 globalThis 钩子，这里负责注册钩子并持有主题样式与计时状态。
export default function thinkingTimer(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const theme = ctx.ui?.theme as ThinkingStyle | undefined;
    if (!theme?.fg || !theme.italic) return;
    const hooks = attachThinkingHooks(theme);
    const g = globalThis as unknown as Record<string, unknown>;
    g.__hapiThinkingNode = hooks.node;
    g.__hapiThinkingTick = hooks.tick;
  });
}
