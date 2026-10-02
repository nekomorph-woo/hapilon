/**
 * 扩展运行时提示的统一出口。
 *
 * 为什么不经 console.warn：pi 会把 ctx.ui.notify 渲染成 TUI 状态行（打补丁后追加不覆盖），
 * 而裸 console.warn 只是 stderr 兜底。UI 未就绪（启动早期、print 模式）时 notify 无处落，
 * 此时回落 console.warn，与历史行为一致、不丢消息。
 */
export type NotifyType = "info" | "warning" | "error";

type NotifySink = (message: string, type?: NotifyType) => void;

let sink: NotifySink | undefined;

/** 注册 TUI 出口；ctx.hasUI 为真时调用，任意先到的钩子注册即可，幂等。 */
export function setNotifySink(ui: { notify: (message: string, type?: NotifyType) => void }): void {
  sink = (message, type) => ui.notify(message, type);
}

export function notify(message: string, type: NotifyType = "info"): void {
  if (sink) {
    sink(message, type);
    return;
  }
  console.warn(message);
}
