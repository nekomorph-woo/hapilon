export function createHerdrState() {
    let mainWorking = false;
    let promptOpen = false;
    let promptMessage;
    const inflight = new Set();
    let last;
    const derive = () => {
        const report = promptOpen
            ? { state: "blocked", message: promptMessage }
            : { state: mainWorking || inflight.size > 0 ? "working" : "idle" };
        if (last && last.state === report.state && last.message === report.message)
            return undefined;
        last = report;
        return report;
    };
    return {
        agentStart: () => {
            mainWorking = true;
            return derive();
        },
        turnStart: () => {
            mainWorking = true;
            return derive();
        },
        agentSettled: () => {
            mainWorking = false;
            return derive();
        },
        promptStart: (message) => {
            promptOpen = true;
            promptMessage = message;
            return derive();
        },
        promptEnd: () => {
            promptOpen = false;
            promptMessage = undefined;
            return derive();
        },
        subagentStarted: (id) => {
            inflight.add(id);
            return derive();
        },
        subagentEnded: (id) => {
            inflight.delete(id);
            return derive();
        },
        /** 新会话：全量重置；session_start 的 idle + sessionPath 由调用方显式上报 */
        reset: () => {
            mainWorking = false;
            promptOpen = false;
            promptMessage = undefined;
            inflight.clear();
            last = undefined;
        },
    };
}
