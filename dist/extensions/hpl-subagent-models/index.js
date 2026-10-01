/**
 * hpl-subagent-models — subagent 派发模型列表
 *
 * 两个接入点共享同一张列表与选型逻辑：
 *  - tool_call 钩子拦 Agent / TaskExecute：未显式指定模型的派发改写为列表条目；
 *  - 全局钩子 __hplSubagentModelsPick 由 ensure-pi-patch 注入 workflow host，
 *    覆盖 SubagentWorkflow 的 agent() 派发（该路径无 tool_call 可拦）。
 *
 * 语义：调用方显式点名永远赢（provider 紧张只告警）；resume 接续原会话不动；
 * 列表未配置 / 关闭 / 全部配额紧张（≥90% 窗口）时不改写，回落父 agent 的模型。
 * thinking 条目只对 Agent 工具生效（TaskExecute 与 workflow 派发无此参数直通车）。
 */
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { readQuotaSnapshots } from "../hpl-quota-usage/cache.js";
import { quotaNamespace, snapshotHot } from "../hpl-quota-usage/snapshot.js";
import { readSubagentModelsEffect } from "./config.js";
import { pickSubagentModel } from "./selector.js";
import { handleSubagentModelsCommand } from "./command.js";
const PREFIX = "[hpl-subagent-models]";
function hotProviders() {
    return new Set(readQuotaSnapshots().filter(snapshotHot).map((s) => s.provider));
}
/** 同一张列表的选型：配置现读 + 配额顺延；不命中返回 undefined（回落父模型）。 */
function pickEntry(cwd) {
    const { enabled, entries } = Effect.runSync(readSubagentModelsEffect(cwd));
    if (!enabled || entries.length === 0)
        return undefined;
    const pick = pickSubagentModel(entries, hotProviders());
    if (pick.kind === "all-hot") {
        console.warn(`${PREFIX} 列表全部 provider 配额紧张（≥90%），不改写，回落父 agent 的模型`);
        return undefined;
    }
    return pick.kind === "entry" ? pick.entry : undefined;
}
const withThinking = (entry) => entry.thinking ? `:${entry.thinking}` : "";
export default function (pi) {
    pi.registerCommand("subagent-models", {
        description: "交互编辑 subagent 派发模型列表（Agent/TaskExecute/Workflow 的模型与 thinking）",
        handler: async (_args, ctx) => {
            await handleSubagentModelsCommand(ctx);
        },
    });
    // 供补丁后的 workflow host 调用；进程内单例，重复加载扩展以最后一次为准。
    // host 只消费 provider/id：workflow 的思考深度走脚本自己的 effort 参数，条目 thinking 不直通
    globalThis.__hplSubagentModelsPick = (cwd) => {
        const entry = pickEntry(cwd);
        if (entry) {
            console.warn(`${PREFIX} workflow 派发改写 → ${entry.provider}/${entry.id}`);
        }
        return entry;
    };
    pi.on("tool_call", async (event, ctx) => {
        const isAgent = isToolCallEventType("Agent", event);
        const isTaskExecute = !isAgent && isToolCallEventType("TaskExecute", event);
        if (!isAgent && !isTaskExecute)
            return;
        const input = event.input;
        // resume 是接续已有会话，模型属于原会话，列表不插手
        if (typeof input.resume === "string" && input.resume !== "")
            return;
        const explicit = typeof input.model === "string" ? input.model.trim() : "";
        if (explicit !== "") {
            const slash = explicit.indexOf("/");
            if (slash > 0) {
                const provider = explicit.slice(0, slash);
                if (hotProviders().has(quotaNamespace(provider))) {
                    console.warn(`${PREFIX} 显式模型 ${explicit} 的 provider ${provider} 配额紧张（≥90%），仍按点名使用`);
                }
            }
            return;
        }
        const entry = pickEntry(ctx.cwd);
        if (!entry)
            return;
        input.model = `${entry.provider}/${entry.id}`;
        if (isAgent && entry.thinking) {
            input.thinking = entry.thinking;
        }
        console.warn(`${PREFIX} ${event.toolName} 派发改写 → ${input.model}${withThinking(entry)}`);
    });
}
