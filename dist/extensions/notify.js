let sink;
/** 注册 TUI 出口；ctx.hasUI 为真时调用，任意先到的钩子注册即可，幂等。 */
export function setNotifySink(ui) {
    sink = (message, type) => ui.notify(message, type);
}
export function notify(message, type = "info") {
    if (sink) {
        sink(message, type);
        return;
    }
    console.warn(message);
}
