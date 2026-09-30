/**
 * digest.ts — 「干了什么」的离线语义层：raw 原话 → 一句摘要 + purpose 对照。
 *
 * 时机在报告生成时而非使用瞬间：使用路径零延迟零成本，失败可重跑。
 * 缓存按 hash(skill+tail) 落 skill-digests.jsonl，重跑只补缺失项。
 * 摘要只做展示不进统计数字——计数/热力图的事实层是 raw 原话本身。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { Effect } from "effect";
import { readResolvedTiersEffect } from "../../hpl-model-tiers/resolved.js";
import { selectRecapModel } from "../../hpl-recap/model.js";
import { digestsPath } from "./storage.js";
export function digestKey(skill, tail) {
    return createHash("sha1").update(`${skill}\u0000${tail}`).digest("hex").slice(0, 12);
}
/** 损坏行跳过：缓存宁可缺不崩 */
export function loadDigests() {
    const path = digestsPath();
    const digests = new Map();
    if (!existsSync(path))
        return digests;
    try {
        for (const line of readFileSync(path, "utf8").split("\n")) {
            if (!line.trim())
                continue;
            try {
                const entry = JSON.parse(line);
                if (typeof entry.key === "string" && typeof entry.digest === "string")
                    digests.set(entry.key, entry);
            }
            catch {
                continue;
            }
        }
    }
    catch (error) {
        console.warn(`[hpl-metrics] digest 缓存读取失败，按空缓存处理：${String(error)}`);
    }
    return digests;
}
export function saveDigests(entries) {
    if (entries.length === 0)
        return;
    const path = digestsPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}
function buildPrompt(items) {
    const lines = items.map((item, index) => {
        const purpose = item.purpose ? `\n   [登记用途] ${item.purpose}` : "";
        return `${index + 1}. skill=${item.skill}${purpose}\n   原话：${item.tail}`;
    });
    return ("你是 skill 使用记录分析器。下面是用户在 coding agent 里显式调用 skill 时携带的原始请求，" +
        "按编号逐条输出：digest ≤30 字概括「用户想干什么」；若该条给了 [登记用途]，再输出 " +
        "consistency：一句话判断实际用法与登记用途一致还是偏移（无登记用途的条目不要 consistency 字段）。\n" +
        '只输出 JSON 数组，除此之外一个字都不要：[{"i":1,"digest":"…","consistency":"…"}]\n\n' +
        lines.join("\n"));
}
/** 容错解析：截取首个 [ 到末个 ]，逐条校验 */
function parseDigestResponse(text, count) {
    const result = new Map();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start)
        return result;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(parsed))
            return result;
        for (const item of parsed) {
            const entry = item;
            const index = typeof entry.i === "number" ? entry.i - 1 : -1;
            if (index < 0 || index >= count || typeof entry.digest !== "string")
                continue;
            result.set(index, {
                digest: entry.digest.trim().slice(0, 80),
                ...(typeof entry.consistency === "string" ? { consistency: entry.consistency.trim().slice(0, 120) } : {}),
            });
        }
    }
    catch {
        return result;
    }
    return result;
}
const DIGEST_TOKEN_BUDGET = 2048;
import { FRONT_PAGE_STYLE, GOAL_ANALYSIS_STYLE, OBSERVER_STYLE, SUGGESTION_STYLE, WARE_NOTE_STYLE } from "./style.js";
async function completeText(ctx, systemPrompt, userPrompt, maxTokens) {
    const available = ctx.modelRegistry.getAvailable();
    const resolvedTiers = await Effect.runPromise(readResolvedTiersEffect);
    const choice = selectRecapModel(available, ctx.model, resolvedTiers);
    if (!choice.model)
        throw new Error(choice.reason ?? "没有可用摘要模型");
    const response = await ctx.modelRegistry.complete(choice.model, { systemPrompt, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] }, { maxTokens });
    const content = response?.content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((part) => part?.text ?? "")
        .filter((t) => typeof t === "string")
        .join("\n")
        .trim();
}
/** 容错取 JSON 对象：截取首个 { 到末个 } */
function parseJsonObject(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start)
        return undefined;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return typeof parsed === "object" && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** 批量补缺失摘要：模型不可用或响应无效时返回 error，调用侧降级显示原文 */
export function generateMissingDigests(items, ctx) {
    return Effect.gen(function* () {
        const digests = loadDigests();
        const missing = items.filter((item) => item.tail && !digests.has(digestKey(item.skill, item.tail)));
        if (missing.length === 0)
            return { entries: digests };
        const available = ctx.modelRegistry.getAvailable();
        const resolvedTiers = yield* readResolvedTiersEffect;
        const choice = selectRecapModel(available, ctx.model, resolvedTiers);
        if (!choice.model)
            return { entries: digests, error: choice.reason ?? "没有可用摘要模型" };
        const attempted = yield* Effect.either(Effect.tryPromise({
            try: () => ctx.modelRegistry.complete(choice.model, { systemPrompt: "只输出 JSON 数组，其余一个字都不要。", messages: [{ role: "user", content: buildPrompt(missing), timestamp: Date.now() }] }, { maxTokens: DIGEST_TOKEN_BUDGET }),
            catch: (error) => error,
        }));
        if (attempted._tag === "Left") {
            const cause = attempted.left;
            const message = cause instanceof Error ? cause.message : String(cause);
            console.warn(`[hpl-metrics] skill 摘要调用失败：${message.slice(0, 160)}`);
            return { entries: digests, error: "摘要模型调用失败，相关条目降级显示原文" };
        }
        const response = attempted.right;
        const content = response?.content;
        const text = Array.isArray(content)
            ? content.map((part) => part?.text ?? "").filter((t) => typeof t === "string").join("\n")
            : "";
        const parsed = parseDigestResponse(text, missing.length);
        if (parsed.size === 0)
            return { entries: digests, error: "摘要响应无法解析，相关条目降级显示原文" };
        const fresh = [];
        for (const [index, value] of parsed) {
            const item = missing[index];
            const entry = { ...value, key: digestKey(item.skill, item.tail) };
            digests.set(entry.key, entry);
            fresh.push(entry);
        }
        saveDigests(fresh);
        return { entries: digests };
    });
}
export async function generateMissingDigestsAsync(items, ctx) {
    return Effect.runPromise(generateMissingDigests(items, ctx));
}
function goalAnalysisPrompt(goal, summary) {
    return `任务：针对下面这条分析目标，用给定数据写一段分析。

[分析目标] ${goal}
[统计数据]
窗口：${summary.window}
总量：${summary.totals}
排行：${summary.topSkills}
时段：${summary.hourProfile}
来源：${summary.sourceProfile}
搭档：${summary.partners}

只输出 JSON：{"analysis":"…"}`;
}
/** 逐条生成目标分析；单条失败即跳过（报告侧降级显示数据卡） */
export async function generateGoalAnalyses(goals, summary, ctx) {
    const results = [];
    for (const goal of goals) {
        try {
            const text = await completeText(ctx, `${OBSERVER_STYLE}\n${GOAL_ANALYSIS_STYLE}\n只输出 JSON 对象：{"analysis":"…"}，其余一个字都不要。`, goalAnalysisPrompt(goal, summary), 1024);
            const parsed = parseJsonObject(text);
            const analysis = typeof parsed?.analysis === "string" ? parsed.analysis.trim().slice(0, 300) : "";
            if (analysis)
                results.push({ goal, analysis });
        }
        catch (error) {
            console.warn(`[hpl-metrics] 目标分析失败（跳过）：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return results;
}
function suggestionsPrompt(existing, summary) {
    return `任务：基于给定统计数据，提出 5 条值得登记的「自定义分析目标」。

[统计数据]
窗口：${summary.window}
总量：${summary.totals}
排行：${summary.topSkills}
时段：${summary.hourProfile}
来源：${summary.sourceProfile}
搭档：${summary.partners}
已登记目标：${existing.length > 0 ? existing.join("；") : "（无）"}

只输出 JSON 数组：[{"title":"…","why":"…","dataNeeded":"…"}]`;
}
/** 目标推荐：一次调用出 5 条；解析失败的条目丢弃 */
export async function generateSuggestions(existingGoals, summary, ctx) {
    try {
        const text = await completeText(ctx, `${OBSERVER_STYLE}\n${SUGGESTION_STYLE}\n只输出 JSON 数组：[{"title":"…","why":"…","dataNeeded":"…"}]，其余一个字都不要。`, suggestionsPrompt(existingGoals, summary), DIGEST_TOKEN_BUDGET);
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start === -1 || end <= start)
            return [];
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(parsed))
            return [];
        const suggestions = [];
        for (const item of parsed.slice(0, 5)) {
            const entry = item;
            if (typeof entry.title !== "string" || typeof entry.why !== "string")
                continue;
            suggestions.push({
                title: entry.title.trim().slice(0, 80),
                why: entry.why.trim().slice(0, 160),
                dataNeeded: typeof entry.dataNeeded === "string" ? entry.dataNeeded.trim().slice(0, 80) : "",
            });
        }
        return suggestions;
    }
    catch (error) {
        console.warn(`[hpl-metrics] 目标推荐生成失败：${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}
/** 为闲置与低频器物各写一句推荐语（结合读者最近的活儿）；失败返回空表 */
export async function generateWareNotes(items, summary, ctx) {
    if (items.length === 0)
        return {};
    try {
        const text = await completeText(ctx, `${OBSERVER_STYLE}\n${WARE_NOTE_STYLE}\n只输出 JSON 数组：[{"name":"…","recommend":"…"}]，其余一个字都不要。`, `任务：为下面这些「上架未用/用得极少」的器物各写一句推荐语，结合读者近期的工作场景（见统计数据）。

[统计数据]
${summary.window} · ${summary.totals} · ${summary.topSkills}

[器物清单]
${items.map((item) => `- ${item.name}（${item.tag}）：${item.description || "（无描述）"}`).join("\n")}

只输出 JSON 数组：[{"name":"…","recommend":"…"}]`, 1536);
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start === -1 || end <= start)
            return {};
        const parsed = JSON.parse(text.slice(start, end + 1));
        const notes = {};
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                const entry = item;
                if (typeof entry.name === "string" && typeof entry.recommend === "string") {
                    notes[entry.name.toLowerCase()] = entry.recommend.trim().slice(0, 100);
                }
            }
        }
        return notes;
    }
    catch (error) {
        console.warn(`[hpl-metrics] 器物荐语生成失败：${error instanceof Error ? error.message : String(error)}`);
        return {};
    }
}
export const FRONT_PAGE_FALLBACK_NOTICE = "（本期头条由资料室按模板整理）";
/** 确定性兜底：模型不可用时按数据拼模板文 */
export function fallbackFrontPage(summary, topSkill, topTotal) {
    return {
        title: `${summary.window} 器物唤起一览`,
        dek: `${topSkill} 以 ${topTotal} 次登顶；本期各版按报式排定。`,
        paragraphs: [
            `本期窗口 ${summary.window}：${summary.totals}。${summary.topSkills}。`,
            `时段上，${summary.hourProfile}${summary.partners ? `搭档方面，${summary.partners}。` : ""}`,
            `来源方面，${summary.sourceProfile}。各版明细见下方逐条简讯。`,
        ],
    };
}
/** 头条文章：一次调用生成标题、副题与三段正文 */
export async function generateFrontPage(summary, ctx) {
    try {
        const text = await completeText(ctx, `${OBSERVER_STYLE}\n${FRONT_PAGE_STYLE}\n只输出 JSON 对象：{"title":"…","dek":"…","paragraphs":["…"]}，其余一个字都不要。`, `任务：为本期《器物晚报》写头版文章。

[统计数据]
窗口：${summary.window}
总量：${summary.totals}
排行：${summary.topSkills}
时段：${summary.hourProfile}
来源：${summary.sourceProfile}
搭档：${summary.partners}`, 2048);
        const parsed = parseJsonObject(text);
        if (!parsed)
            return undefined;
        const paragraphs = Array.isArray(parsed.paragraphs)
            ? parsed.paragraphs.filter((p) => typeof p === "string" && p.trim().length > 0).slice(0, 3)
            : [];
        if (typeof parsed.title !== "string" || paragraphs.length === 0)
            return undefined;
        return {
            title: parsed.title.trim().slice(0, 40),
            dek: typeof parsed.dek === "string" ? parsed.dek.trim().slice(0, 80) : "",
            paragraphs,
        };
    }
    catch (error) {
        console.warn(`[hpl-metrics] 头条生成失败，用模板兜底：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
