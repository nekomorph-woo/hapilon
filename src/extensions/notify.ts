/**
 * 扩展运行时提示的统一出口。
 *
 * pi 把 ctx.ui.notify 渲染成 TUI 状态行（打补丁后追加不覆盖）；UI 未就绪（启动早期、print 模式）
 * 时无 sink，回落按严重度分流：warning/error 走 console.warn 留痕，info 直接丢弃——
 * 信息性汇总打进终端会污染输入框（用户实测 herdr-app pty 场景），丢弃无损。
 */
export type NotifyType = "info" | "warning" | "error";

type NotifySink = (message: string, type?: NotifyType) => void;

let sink: NotifySink | undefined;

/** 注册 TUI 出口；ctx.hasUI 为真时调用，任意先到的钩子注册即可，幂等。 */
export function setNotifySink(ui: { notify: (message: string, type?: NotifyType) => void }): void {
  sink = (message, type) => ui.notify(message, type);
}

/** 测试与进程收尾用；清空后 notify 回到「未注册」分流态 */
export function resetNotifySink(): void {
  sink = undefined;
}

export function notify(message: string, type: NotifyType = "info"): void {
  if (sink) {
    sink(message, type);
    return;
  }
  if (type === "info") return;
  console.warn(message);
}
