/** 可注入 scheduler 的 session 级 timer，reset 必定取消上一轮。 */
export function createRecapTimer(onElapsed, schedule = setTimeout, cancel = clearTimeout) {
    let handle;
    const clear = () => {
        if (handle !== undefined)
            cancel(handle);
        handle = undefined;
    };
    return {
        reset(delayMs) {
            clear();
            handle = schedule(onElapsed, delayMs);
        },
        clear,
    };
}
