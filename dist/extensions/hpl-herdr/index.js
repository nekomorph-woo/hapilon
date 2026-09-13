import { defaultSpawn } from "../hpl-orchestra/herdr.js";
import { blockMessage, createHerdrReporter } from "./report.js";
function sessionPathOf(ctx) {
    try {
        return ctx.sessionManager.getSessionFile();
    }
    catch {
        return undefined;
    }
}
export default function hplHerdr(pi) {
    const reporter = createHerdrReporter({
        spawn: defaultSpawn,
        env: {
            herdrEnv: process.env.HERDR_ENV,
            binPath: process.env.HERDR_BIN_PATH,
            paneId: process.env.HERDR_PANE_ID,
        },
    });
    if (!reporter.enabled)
        return;
    // 起始：新会话就绪，并带上 session 路径（herdr 展示/resume 判断用）
    pi.on("session_start", (_event, ctx) => reporter.report("idle", { sessionPath: sessionPathOf(ctx) }));
    // 运行中：agent 起跑与每轮开始都算 working
    pi.on("agent_start", () => reporter.report("working"));
    pi.on("turn_start", () => reporter.report("working"));
    // 完全沉淀（无重试/压缩/排队续跑）才是 idle——agent_end 可能还有续跑，不报
    pi.on("agent_settled", () => reporter.report("idle"));
    // 阻塞：ask_user / 权限确认等阻塞式 UI prompt，标题优先当说明
    pi.on("ui_prompt_start", (event) => reporter.report("blocked", { message: blockMessage(event) }));
    pi.on("ui_prompt_end", (_event, ctx) => reporter.report(ctx.isIdle() ? "idle" : "working"));
    // 退出：释放生命周期权威，herdr 不再把这个 pane 当活跃 agent
    pi.on("session_shutdown", () => reporter.release());
}
