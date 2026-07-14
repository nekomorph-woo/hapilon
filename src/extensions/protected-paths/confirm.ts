/**
 * confirm.ts — confirm 弹框辅助
 *
 * 封装 ctx.ui.confirm 调用，区分四种状态：
 *   approved — 用户批准
 *   rejected — 用户拒绝
 *   unavailable — 非交互模式无 UI
 *   error — 对话框异常
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ConfirmResult =
  | { status: "approved" }
  | { status: "rejected" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export async function requestConfirm(
  ctx: ExtensionContext,
  title: string,
  msg: string,
): Promise<ConfirmResult> {
  if (!ctx.hasUI) return { status: "unavailable" };
  try {
    const approved = await ctx.ui.confirm(title, msg);
    return approved ? { status: "approved" } : { status: "rejected" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("安全确认对话框异常:", message);
    return { status: "error", message };
  }
}
