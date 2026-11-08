let sink;
/** 注册 TUI 出口；ctx.hasUI 为真时调用，任意先到的钩子注册即可，幂等。 */
export function setNotifySink(ui) {
    sink = (message, type) => ui.notify(message, type);
}
/** 测试与进程收尾用；清空后 notify 回到「未注册」分流态 */
export function resetNotifySink() {
    sink = undefined;
}
export function notify(message, type = "info") {
    if (sink) {
        sink(message, type);
        return;
    }
    if (type === "info")
        return;
    console.warn(message);
}
