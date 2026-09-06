import { Effect } from "effect";
import { readRecapConfig } from "./config.js";
import { buildRecapMessages } from "./context.js";
import { recapModelLabel, selectRecapModel } from "./model.js";
import { readResolvedTiersEffect } from "./resolved.js";
import { createRecapTimer } from "./timer.js";
const WIDGET_KEY = "hpl-recap";
const RECAP_SYSTEM_PROMPT = "你是一个后台 recap 助手。请用简洁中文总结最近对话：刚才做了什么、当前状态、下一步建议。只输出正文，不要标题，不超过 200 字。";
function errorText(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/g, " ").trim().slice(0, 160) || "未知错误";
}
function responseText(response) {
    if (!response || typeof response !== "object")
        return "";
    const content = response.content;
    if (!Array.isArray(content))
        return "";
    return content.map((part) => {
        if (!part || typeof part !== "object")
            return "";
        const text = part.text;
        return typeof text === "string" ? text : "";
    }).filter(Boolean).join("\n").trim();
}
function recapLines(ctx, text, model, degradedReason, now = new Date()) {
    const timestamp = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const lines = [
        ctx.ui.theme.fg("muted", `Recap · ${timestamp} · ${recapModelLabel(model)}`),
    ];
    if (degradedReason)
        lines.push(ctx.ui.theme.fg("muted", degradedReason));
    lines.push(...text.slice(0, 200).split(/\r?\n/).map((line) => ctx.ui.theme.fg("customMessageText", line)));
    return lines;
}
function failureLines(ctx, reason) {
    return [
        ctx.ui.theme.fg("muted", `Recap · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`),
        ctx.ui.theme.fg("customMessageText", `上次 recap 失败：${reason}`),
    ];
}
function runRecapEffect(ctx, config, controller) {
    return Effect.gen(function* () {
        const available = ctx.modelRegistry.getAvailable();
        const resolvedTiers = yield* readResolvedTiersEffect;
        const choice = selectRecapModel(available, ctx.model, resolvedTiers);
        if (!choice.model) {
            ctx.ui.setWidget(WIDGET_KEY, failureLines(ctx, choice.reason ?? "没有可用 recap 模型"));
            return;
        }
        const entries = ctx.sessionManager.buildContextEntries();
        const messages = buildRecapMessages(entries, config.maxContextChars);
        if (messages.length === 0)
            return;
        const response = yield* Effect.tryPromise({
            try: () => ctx.modelRegistry.complete(choice.model, {
                systemPrompt: RECAP_SYSTEM_PROMPT,
                messages,
            }, {
                signal: controller.signal,
                reasoning: "off",
                maxTokens: 256,
            }),
            catch: (error) => error,
        });
        const text = responseText(response);
        if (!text) {
            ctx.ui.setWidget(WIDGET_KEY, failureLines(ctx, "模型未返回有效内容"));
            return;
        }
        ctx.ui.setWidget(WIDGET_KEY, recapLines(ctx, text, choice.model, choice.reason));
    }).pipe(Effect.catchAllCause((cause) => Effect.sync(() => {
        if (controller.signal.aborted)
            return;
        const reason = errorText(cause);
        console.warn(`[hpl-recap] recap 调用失败：${reason}`);
        ctx.ui.setWidget(WIDGET_KEY, failureLines(ctx, reason));
    })));
}
export default function hplRecap(pi) {
    let ctx;
    let config;
    let timer;
    let controller;
    let inFlight = false;
    let sessionActive = false;
    let lastActivityAt = 0;
    const resetTimer = () => {
        if (sessionActive && config?.enabled && timer) {
            timer.reset(config.idleMinutes * 60_000);
        }
    };
    const run = () => {
        if (!sessionActive || !config?.enabled || !ctx || inFlight)
            return;
        if (Date.now() - lastActivityAt < config.idleMinutes * 60_000) {
            resetTimer();
            return;
        }
        if (!ctx.isIdle() || ctx.hasPendingMessages())
            return;
        inFlight = true;
        controller = new AbortController();
        const currentController = controller;
        void Effect.runPromise(runRecapEffect(ctx, config, currentController)).finally(() => {
            if (controller === currentController) {
                controller = undefined;
                inFlight = false;
            }
        });
    };
    pi.on("session_start", (_event, nextCtx) => {
        ctx = nextCtx;
        config = readRecapConfig();
        sessionActive = true;
        lastActivityAt = Date.now();
        timer?.clear();
        timer = createRecapTimer(run);
        nextCtx.ui.setWidget(WIDGET_KEY, undefined);
        resetTimer();
    });
    const activity = () => {
        lastActivityAt = Date.now();
        resetTimer();
    };
    pi.on("agent_settled", activity);
    pi.on("message_end", activity);
    pi.on("turn_end", activity);
    pi.on("input", (_event, inputCtx) => {
        // 新输入意味着旧 recap 已过时；返回 undefined 让 Pi 继续处理输入。
        inputCtx.ui.setWidget(WIDGET_KEY, undefined);
    });
    pi.on("session_shutdown", (_event, shutdownCtx) => {
        sessionActive = false;
        timer?.clear();
        timer = undefined;
        controller?.abort();
        controller = undefined;
        inFlight = false;
        lastActivityAt = 0;
        shutdownCtx.ui.setWidget(WIDGET_KEY, undefined);
        ctx = undefined;
        config = undefined;
    });
}
