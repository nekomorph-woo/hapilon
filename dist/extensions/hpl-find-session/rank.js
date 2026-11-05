/**
 * rank.ts — 用 haiku 档模型对候选会话排序并生成一行摘要
 */
import { selectRecapModel } from "../hpl-recap/model.js";
const RANK_SYSTEM_PROMPT = [
    "你是会话检索助手。给你用户的一句话描述和一批历史会话候选（含首末用户消息）。",
    "任务：挑出与描述相关的会话，按相关度降序，每个给一行不超过 40 字的中文摘要（概括这个会话在做什么）。",
    '只返回严格 JSON 数组，不要任何其它文字：[{"i":<候选编号>,"s":"<一行摘要>"}]，最多 10 项，i 必须来自候选编号。',
    "没有相关会话时返回 []。",
].join("\n");
function candidateLine(index, entry) {
    const cwd = entry.cwd.replace(/^\/Users\/[^/]+/, "~");
    const name = entry.name || "(未命名)";
    return `[${index}] ${entry.modified.slice(0, 16)} ${cwd} 「${name}」 消息${entry.messageCount}条 首:${entry.firstUser.slice(0, 120)} 末:${entry.lastUser.slice(0, 120)}`;
}
function responseText(response) {
    if (response && typeof response === "object") {
        const content = response.content;
        if (typeof content === "string")
            return content;
        if (Array.isArray(content)) {
            return content
                .map((b) => (typeof b === "object" && b !== null && b.text) ?? "")
                .join("");
        }
    }
    return "";
}
/** 解析模型输出；容错代码围栏与非 JSON 输出，返回 null 表示降级。 */
export function parseRankedJson(text) {
    const stripped = text.trim().replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    const start = stripped.indexOf("[");
    const end = stripped.lastIndexOf("]");
    if (start < 0 || end <= start)
        return [];
    let parsed;
    try {
        parsed = JSON.parse(stripped.slice(start, end + 1));
    }
    catch {
        return [];
    }
    if (!Array.isArray(parsed))
        return [];
    const out = [];
    for (const item of parsed) {
        if (typeof item !== "object" || item === null)
            continue;
        if (typeof item.i !== "number" || !Number.isInteger(item.i))
            continue;
        if (typeof item.s !== "string" || !item.s.trim())
            continue;
        out.push({ index: item.i, summary: item.s.trim().slice(0, 60) });
    }
    return out;
}
/** 候选超过上限时截断，返回摘要降级用的短句。 */
export function fallbackSummary(entry) {
    const base = entry.firstUser || entry.lastUser || "(无用户消息)";
    return base.slice(0, 60);
}
/**
 * 用 haiku 档模型对候选排序 + 摘要。模型不可用或输出无效时降级为原序 + 首条消息截断。
 * 返回按相关度降序的候选（含被模型排除在 top 之外的，排在其后，保持关键词序）。
 */
export async function rankEntries(query, candidates, deps) {
    const choice = selectRecapModel(deps.available, deps.currentModel, deps.resolvedTiers);
    if (!choice.model || candidates.length === 0) {
        return {
            ranked: candidates.map((entry) => ({ entry, summary: fallbackSummary(entry) })),
            degraded: true,
            modelLabel: choice.model ? "" : "无可用模型",
        };
    }
    const modelLabel = choice.model.name?.trim() || `${choice.model.provider}/${choice.model.id}`;
    let modelOrder = [];
    try {
        const userPrompt = `用户描述：${query}\n\n候选：\n${candidates.map((entry, index) => candidateLine(index, entry)).join("\n")}`;
        const text = responseText(await deps.complete(choice.model, [{ role: "user", content: userPrompt }], RANK_SYSTEM_PROMPT));
        modelOrder = parseRankedJson(text);
    }
    catch {
        modelOrder = [];
    }
    const byIndex = new Map(modelOrder.map((r) => [r.index, r.summary]));
    const ranked = [];
    for (const item of modelOrder) {
        const entry = candidates[item.index];
        if (entry)
            ranked.push({ entry, summary: item.summary });
    }
    for (let index = 0; index < candidates.length; index++) {
        if (!byIndex.has(index))
            ranked.push({ entry: candidates[index], summary: fallbackSummary(candidates[index]) });
    }
    return { ranked, degraded: modelOrder.length === 0 || choice.degraded, modelLabel };
}
