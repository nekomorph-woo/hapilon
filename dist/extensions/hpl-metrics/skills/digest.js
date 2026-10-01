/**
 * digest.ts — 器物晚报的文字管线：摘要、头条、固定分析、目标分析、推荐、器物荐语。
 *
 * 上下文组织是「渐进式 + 工具化」：不把有损摘要一次性塞给模型，而是给它一组
 * 本插件私有的数据查询（纯内存过滤/聚合，见 executeTool——不是 hapi 的工具体系，
 * 不注册、不进会话），模型按需多轮拉取，探索够了再产出文字。质量优先，轮次换深度。
 *
 * 模型与选模：recap 同款（haiku 优先，非推理）。摘要缓存按 hash 落盘。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { Effect } from "effect";
import { readResolvedTiersEffect } from "../../hpl-model-tiers/resolved.js";
import { selectRecapModel } from "../../hpl-recap/model.js";
import { digestsPath } from "./storage.js";
import { FIXED_ANALYSIS_STYLE, FRONT_PAGE_STYLE, GOAL_ANALYSIS_STYLE, OBSERVER_STYLE, SUGGESTION_STYLE, WARE_NOTE_STYLE, } from "./style.js";
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
/* ——— 模型调用 ——— */
/** recap 同款选模 + 单次补全，返回纯文本 */
async function callModel(ctx, systemPrompt, messages, maxTokens) {
    const available = ctx.modelRegistry.getAvailable();
    const resolvedTiers = await Effect.runPromise(readResolvedTiersEffect);
    const choice = selectRecapModel(available, ctx.model, resolvedTiers);
    if (!choice.model)
        throw new Error(choice.reason ?? "没有可用摘要模型");
    const response = await ctx.modelRegistry.complete(choice.model, { systemPrompt, messages: messages.map((m) => ({ ...m, timestamp: Date.now() })) }, { maxTokens });
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
export function parseJsonObject(text) {
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
/** 容错取 JSON 数组：截取首个 [ 到末个 ] */
export function parseJsonArray(text) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start)
        return undefined;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
const DIGEST_TOKEN_BUDGET = 2048;
export async function generateMissingDigests(items, ctx) {
    const digests = loadDigests();
    const missing = items.filter((item) => item.tail && !digests.has(digestKey(item.skill, item.tail)));
    if (missing.length === 0)
        return { entries: digests };
    try {
        const list = missing
            .map((item, index) => `${index + 1}. skill=${item.skill}${item.purpose ? `（登记用途：${item.purpose}）` : ""}\n   原话：${item.tail}`)
            .join("\n");
        const text = await callModel(ctx, `${OBSERVER_STYLE}\n只输出 JSON 数组，其余一个字都不要。`, [{ role: "user", content: `任务：逐条给出 digest（≤30 字，概括这条原话想让器物干什么）；若该条给了登记用途，再给 consistency：一句话判断实际用法与登记用途一致还是偏移。无登记用途的条目不要 consistency 字段。\n\n${list}`, timestamp: Date.now() }], DIGEST_TOKEN_BUDGET);
        const parsed = parseJsonArray(text) ?? [];
        const fresh = [];
        for (const item of parsed) {
            const entry = item;
            const index = typeof entry.i === "number" ? entry.i - 1 : -1;
            if (index < 0 || index >= missing.length || typeof entry.digest !== "string")
                continue;
            const target = missing[index];
            const record = {
                key: digestKey(target.skill, target.tail),
                digest: entry.digest.trim().slice(0, 80),
                ...(typeof entry.consistency === "string" ? { consistency: entry.consistency.trim().slice(0, 120) } : {}),
            };
            digests.set(record.key, record);
            fresh.push(record);
        }
        if (fresh.length > 0)
            saveDigests(fresh);
        return { entries: digests };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[hpl-metrics] skill 摘要调用失败：${message.slice(0, 160)}`);
        return { entries: digests, error: "摘要模型调用失败，相关条目降级显示原文" };
    }
}
const DATA_TOOLS_DOC = `数据查询（每轮输出一个 JSON 对象）：
- {"tool":"list_skills"}                          全量器物与命令排行（含零使用）
- {"tool":"skill_summary","args":{"name":"…"}}    单件器物全量档案：次数/显式自动/时段/间隔/全部原话/搭档/会话
- {"tool":"records_query","args":{"skill":"…","source":"explicit|model|command","limit":20}}  筛选使用记录（时间倒序，含原话与会话线索）
- {"tool":"partners_of","args":{"name":"…"}}      该器物的同会话共现搭档
- {"tool":"hour_profile","args":{"name":"…"}}     时段直方（全局或某器物）
- {"tool":"day_counts"}                           按日计数
- {"tool":"session_preview","args":{"session":"…"}} 某会话的首条用户消息
- {"answer":"…"}                                  数据已足够，提交最终回答（answer 即最终文字）`;
function executeTool(scope, name, args) {
    const argString = (key) => (typeof args[key] === "string" ? args[key].toLowerCase() : "");
    const argNumber = (key, fallback) => (typeof args[key] === "number" ? args[key] : fallback);
    const dayLabel = (ts) => {
        const d = new Date(ts);
        return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const whenLabel = (ts) => {
        const d = new Date(ts);
        return `${dayLabel(ts)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    switch (name) {
        case "list_skills": {
            const counts = new Map();
            for (const event of scope.events) {
                const entry = counts.get(event.skill) ?? { total: 0, explicit: 0, model: 0, command: 0 };
                entry.total += 1;
                if (event.source === "explicit")
                    entry.explicit += 1;
                else if (event.source === "model")
                    entry.model += 1;
                else
                    entry.command += 1;
                counts.set(event.skill, entry);
            }
            const lines = [...counts.entries()]
                .sort((a, b) => b[1].total - a[1].total)
                .map(([skill, c]) => `${skill}: ${c.total} 次（显式 ${c.explicit}/自动 ${c.model}/命令 ${c.command}）`);
            const installed = scope.available.map((skill) => skill.name).filter((name) => !counts.has(name));
            return JSON.stringify({ 排行: lines, 零使用: installed });
        }
        case "skill_summary": {
            const name = argString("name");
            const matched = scope.events.filter((event) => event.skill === name);
            if (matched.length === 0)
                return JSON.stringify({ error: `窗口内没有 ${name} 的记录` });
            const explicit = matched.filter((e) => e.source === "explicit").length;
            const hours = Array.from({ length: 24 }, () => 0);
            for (const event of matched)
                hours[new Date(event.ts).getHours()]++;
            const sessions = [...new Set(matched.map((event) => event.session))];
            const sorted = [...matched].sort((a, b) => a.ts - b.ts);
            const tails = sorted.filter((e) => e.source === "explicit" && e.args).map((e) => `${whenLabel(e.ts)}「${e.args}」`);
            const co = new Map();
            for (const event of scope.events) {
                if (event.skill === name)
                    continue;
                if (matched.some((m) => m.session === event.session))
                    co.set(event.skill, (co.get(event.skill) ?? 0) + 1);
            }
            const partner = [...co.entries()].sort((a, b) => b[1] - a[1])[0];
            return JSON.stringify({
                name,
                总次数: matched.length,
                显式: explicit,
                自动: matched.length - explicit,
                时段直方: hours,
                涉及会话: sessions.length,
                最近: whenLabel(sorted[sorted.length - 1].ts),
                全部原话: tails,
                最常见搭档: partner ? `${partner[0]}（${partner[1]} 次）` : "无",
                会话线索样例: sessions.slice(0, 3).map((s) => scope.sessionPreviews[s]).filter(Boolean),
            });
        }
        case "records_query": {
            const skill = argString("skill");
            const source = argString("source");
            const limit = argNumber("limit", 20);
            const matched = scope.events
                .filter((event) => (!skill || event.skill === skill) && (!source || event.source === source))
                .sort((a, b) => b.ts - a.ts)
                .slice(0, limit);
            return JSON.stringify(matched.map((event) => ({
                时间: whenLabel(event.ts),
                skill: event.skill,
                来源: event.source,
                原话: event.args || undefined,
                会话: event.session.slice(0, 18),
            })));
        }
        case "partners_of": {
            const name = argString("name");
            const sessions = new Set(scope.events.filter((event) => event.skill === name).map((event) => event.session));
            const co = new Map();
            for (const event of scope.events) {
                if (event.skill === name || !sessions.has(event.session))
                    continue;
                co.set(event.skill, (co.get(event.skill) ?? 0) + 1);
            }
            return JSON.stringify(Object.fromEntries([...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)));
        }
        case "hour_profile": {
            const name = argString("name");
            const matched = name ? scope.events.filter((event) => event.skill === name) : scope.events;
            const hours = Array.from({ length: 24 }, () => 0);
            for (const event of matched)
                hours[new Date(event.ts).getHours()]++;
            return JSON.stringify(hours);
        }
        case "day_counts": {
            const counts = new Map();
            for (const event of scope.events) {
                const d = new Date(event.ts);
                const key = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            return JSON.stringify(Object.fromEntries([...counts.entries()].sort()));
        }
        case "session_preview": {
            const session = argString("session");
            return JSON.stringify({ session, 线索: scope.sessionPreviews[session] ?? "（无）" });
        }
        default:
            return JSON.stringify({ error: `未知工具 ${name}` });
    }
}
const AGENT_MAX_ROUNDS = 30;
const TOOL_RESULT_MAX = 6000;
export const FIXED_QUESTIONS = [
    "意图画像 · 它通常被用来干什么",
    "趋势与节奏 · 用量在升还是在降",
    "显式/自动与一致性 · 谁在用它",
    "搭档 · 它常和谁一起出场",
];
/** 单个 scope 的固定分析四问；不足四条视为失败（调用侧降级数据卡） */
export async function generateFixedAnalyses(scopeName, scope, ctx, onProgress) {
    const result = await runDataAgent(`完成「固定分析目标」四问（范围：${scopeName}）。四条 title 依次为：${FIXED_QUESTIONS.join("、")}。`, `只输出 JSON 数组，恰好 4 条：[{"title":"…","text":"…"}]。每条 60~90 字，结论先行、引用数字。`, scope, ctx, { extraStyle: FIXED_ANALYSIS_STYLE, onProgress });
    if (!result)
        return undefined;
    const parsed = parseJsonArray(result.answer) ?? [];
    const analyses = parsed
        .map((item) => item)
        .filter((item) => typeof item.title === "string" && typeof item.text === "string")
        .map((item) => ({ scope: scopeName, title: item.title.trim().slice(0, 40), text: item.text.trim().slice(0, 220) }));
    return analyses.length === FIXED_QUESTIONS.length ? analyses : undefined;
}
/** 头条文章；失败返回 undefined（调用侧用确定性模板兜底） */
export async function generateFrontPage(scope, ctx, onProgress) {
    const result = await runDataAgent("为本期《器物晚报》写头版文章。", `只输出 JSON 对象：{"title":"…","dek":"…","paragraphs":["…","…","…"]}。标题对仗或化用诗句、14 字内、数字用汉字；dek 一句话点出榜首与最大反直觉事实；正文恰好三段，第一段以「本报讯」起笔给总量与时段事实，第二段讲榜首器物与显式/自动分工，第三段收在趋势或新变化。每段 60~110 字。`, scope, ctx, { extraStyle: FRONT_PAGE_STYLE, onProgress });
    if (!result)
        return undefined;
    const parsed = parseJsonObject(result.answer);
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
/** 单条分析目标的模型分析；失败返回 undefined */
export async function generateGoalAnalysis(goal, scope, ctx, onProgress) {
    const result = await runDataAgent(`分析读者登记的分析目标：「${goal}」。`, `只输出 JSON 对象：{"analysis":"…"}。120 字以内，结论先行、至少引用两个数字、结尾指出数据局限；数据不足直说「本期数据不足以回答」并说明缺什么。`, scope, ctx, { extraStyle: GOAL_ANALYSIS_STYLE, onProgress });
    return result?.answer.slice(0, 400) || undefined;
}
/** 目标推荐 5 条（避开已登记）；失败返回空数组 */
export async function generateSuggestions(existingGoals, scope, ctx, onProgress) {
    const existing = existingGoals.length > 0 ? `已登记目标（不要重复）：${existingGoals.join("；")}` : "（尚无登记目标）";
    const result = await runDataAgent(`基于数据提出 5 条值得登记的分析目标。${existing}`, `只输出 JSON 数组，恰好 5 条：[{"title":"…","why":"…","dataNeeded":"…"}]。目标必须能用窗口内数据回答。`, scope, ctx, { extraStyle: SUGGESTION_STYLE, onProgress });
    if (!result)
        return [];
    return (parseJsonArray(result.answer) ?? [])
        .map((item) => item)
        .filter((item) => typeof item.title === "string" && typeof item.why === "string")
        .slice(0, 5)
        .map((item) => ({
        title: item.title.trim().slice(0, 80),
        why: item.why.trim().slice(0, 160),
        dataNeeded: typeof item.dataNeeded === "string" ? item.dataNeeded.trim().slice(0, 80) : "",
    }));
}
/** 器物荐语（结合近期场景的一句话推荐）；失败返回空表 */
export async function generateWareNotes(names, scope, ctx, onProgress) {
    if (names.length === 0)
        return {};
    const result = await runDataAgent(`为下列器物各写一句推荐语（40 字内），结合数据里读者的近期场景说明什么时机用得上：${names.join("、")}。`, `只输出 JSON 数组：[{"name":"…","recommend":"…"}]，每件器物一条。`, scope, ctx, { extraStyle: WARE_NOTE_STYLE, onProgress });
    if (!result)
        return {};
    const notes = {};
    for (const item of parseJsonArray(result.answer) ?? []) {
        const entry = item;
        if (typeof entry.name === "string" && typeof entry.recommend === "string") {
            notes[entry.name.toLowerCase()] = entry.recommend.trim().slice(0, 100);
        }
    }
    return notes;
}
/**
 * 渐进式数据探索：模型按需调用查询、代码回传结果，直到模型提交最终回答。
 * 返回 undefined 表示探索失败（调用方降级）。
 */
export async function runDataAgent(task, finalFormat, scope, ctx, opts) {
    try {
        const system = `${OBSERVER_STYLE}${opts?.extraStyle ? `\n${opts.extraStyle}` : ""}\n\n你将渐进式地探索数据来完成任务：不要假设数据，每轮调用一个查询，看结果再决定下一步；数据足够后用 finish 的 answer 提交最终文字。\n\n${DATA_TOOLS_DOC}\n\n最终回答要求：${finalFormat}`;
        const overview = `基础概览（详细数据用工具查询）：窗口 ${scope.window.start} ~ ${scope.window.end}（${scope.window.days} 天），记录 ${scope.events.length} 条，已安装器物 ${scope.available.length} 件。\n\n[任务]\n${task}`;
        const messages = [
            { role: "user", content: overview, timestamp: Date.now() },
        ];
        for (let round = 1; round <= AGENT_MAX_ROUNDS; round++) {
            const text = await callModel(ctx, system, messages, DIGEST_TOKEN_BUDGET);
            const parsed = parseJsonObject(text);
            if (!parsed)
                return undefined;
            if (typeof parsed.answer === "string" && parsed.answer.trim()) {
                return { answer: parsed.answer.trim(), rounds: round };
            }
            if (typeof parsed.tool !== "string")
                return undefined;
            opts?.onProgress?.(`第 ${round} 轮 · 查询 ${parsed.tool}`);
            const result = executeTool(scope, parsed.tool, (parsed.args ?? {}));
            const clipped = result.length > TOOL_RESULT_MAX ? result.slice(0, TOOL_RESULT_MAX) + "…（截断）" : result;
            messages.push({ role: "user", content: `[你的上一轮动作]\n${JSON.stringify(parsed)}\n[工具结果 ${parsed.tool}]\n${clipped}`, timestamp: Date.now() });
        }
        // 轮次用尽：强制收尾
        messages.push({ role: "user", content: "探索轮次已用完。基于已看到的数据直接输出最终回答（finish 的 answer），不再调用工具。", timestamp: Date.now() });
        const final = await callModel(ctx, system, messages, DIGEST_TOKEN_BUDGET);
        const parsed = parseJsonObject(final);
        const answer = parsed && typeof parsed.answer === "string" ? parsed.answer.trim() : final;
        return answer ? { answer, rounds: AGENT_MAX_ROUNDS + 1 } : undefined;
    }
    catch (error) {
        console.warn(`[hpl-metrics] 数据探索失败：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
