import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { readRecapConfig, type RecapConfig } from "./config.js";
import { buildRecapMessages } from "./context.js";
import { recapModelLabel, selectRecapModel, type RecapModelShape } from "./model.js";
import { readResolvedTiersEffect } from "../hpl-model-tiers/resolved.js";
import { createRecapTimer, type RecapTimer } from "./timer.js";

const WIDGET_KEY = "hpl-recap";
const RECAP_SYSTEM_PROMPT =
  "你是一个后台 recap 助手。请用简洁中文总结最近对话：刚才做了什么、当前状态、下一步建议。只输出正文，不要标题，不超过 200 字。";

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 160) || "未知错误";
}

function responseText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const text = (part as { type?: unknown; text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).filter(Boolean).join("\n").trim();
}

function recapLines(
  ctx: ExtensionContext,
  text: string,
  model: RecapModelShape,
  degradedReason?: string,
  now = new Date(),
): string[] {
  const timestamp = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const lines = [
    ctx.ui.theme.fg("muted", `※ recap · ${timestamp} · ${recapModelLabel(model)}`),
  ];
  if (degradedReason) lines.push(ctx.ui.theme.fg("muted", degradedReason));
  lines.push(...text.slice(0, 200).split(/\r?\n/).map((line) => ctx.ui.theme.fg("muted", line)));
  return lines;
}

function failureLines(ctx: ExtensionContext, reason: string): string[] {
  return [
    ctx.ui.theme.fg("muted", `※ recap · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`),
    ctx.ui.theme.fg("muted", `上次 recap 失败：${reason}`),
  ];
}

/**
 * recap 一律不传推理开关。`reasoningEffort` 是 openai-completions 家族专属键，且在
 * glm-4.7 这类 supportsReasoningEffort:false 的模型上，该键的「有无」本身就是思考开关
 * ——传 minimal 等于开思考，每次白烧数百 reasoning token；`reasoning` 键只在
 * streamSimple 被读，complete() 路径根本不认。空正文与参数无关：旧参数
 * （thinking:disabled + 256）下同样出现过，成因疑为服务端偶发、未定位，故防线是
 * 正文为空时以 4096 预算重试一次（覆盖「思考关不掉又吃光小预算」的假想场景）。
 */
function runRecapEffect(
  ctx: ExtensionContext,
  config: RecapConfig,
  controller: AbortController,
): Effect.Effect<void, never> {
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
    if (messages.length === 0) return;

    const completeOnce = (maxTokens: number) =>
      Effect.tryPromise({
        try: () => ctx.modelRegistry.complete(choice.model!, {
          systemPrompt: RECAP_SYSTEM_PROMPT,
          messages,
        }, { signal: controller.signal, maxTokens }),
        catch: (error) => error,
      });

    let text = responseText(yield* completeOnce(256));
    if (!text) text = responseText(yield* completeOnce(4096));
    if (!text) {
      ctx.ui.setWidget(WIDGET_KEY, failureLines(ctx, "模型未返回有效内容"));
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, recapLines(ctx, text, choice.model, choice.reason));
  }).pipe(
    Effect.catchAllCause((cause) => Effect.sync(() => {
      if (controller.signal.aborted) return;
      const reason = errorText(cause);
      console.warn(`[hpl-recap] recap 调用失败：${reason}`);
      ctx.ui.setWidget(WIDGET_KEY, failureLines(ctx, reason));
    })),
  );
}

export default function hplRecap(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let config: RecapConfig | undefined;
  let timer: RecapTimer | undefined;
  let controller: AbortController | undefined;
  let inFlight = false;
  let sessionActive = false;
  let lastActivityAt = 0;

  const resetTimer = (): void => {
    if (sessionActive && config?.enabled && timer) {
      timer.reset(config.idleMinutes * 60_000);
    }
  };

  const run = (): void => {
    if (!sessionActive || !config?.enabled || !ctx || inFlight) return;
    if (Date.now() - lastActivityAt < config.idleMinutes * 60_000) {
      resetTimer();
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
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

  const activity = (): void => {
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
