/**
 * confirm.ts — confirm 弹框辅助（4 选项 select）
 *
 * 用 ctx.ui.select() 替代 ctx.ui.confirm()，提供：
 *   Allow Once      — 仅本次放行
 *   Allow Session   — 当前 session 不再询问（内存）
 *   Allow Project   — 本项目不再询问（持久化到 .hapilon/config.local.json）
 *   Deny            — 拒绝本次
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ConfirmResult =
  | { status: "approved"; scope: "once" | "session" | "project" }
  | { status: "rejected" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

const OPTIONS = [
  "Allow Once",
  "Allow this Session",
  "Allow this Project",
  "Deny",
] as const;

export async function requestConfirm(
  ctx: ExtensionContext,
  title: string,
  msg: string,
): Promise<ConfirmResult> {
  if (!ctx.hasUI) return { status: "unavailable" };
  try {
    const choice = await ctx.ui.select(title + "\n\n" + msg, [...OPTIONS]);
    switch (choice) {
      case "Allow Once":          return { status: "approved", scope: "once" };
      case "Allow this Session":  return { status: "approved", scope: "session" };
      case "Allow this Project":  return { status: "approved", scope: "project" };
      default:                     return { status: "rejected" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("安全确认对话框异常:", message);
    return { status: "error", message };
  }
}
