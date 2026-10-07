/**
 * auto-judge.ts — Auto 模式模型判定层
 *
 * confirm 级命令在沙箱规则未命中时交给档位模型做三值判定
 * （allow / block / unsure，unsure 与一切失败都回落现有人工路径，不存在 fail-open）。
 *
 * - 模型指代：`tier:<opus|sonnet|haiku>[<index>]` 经 model-tiers-resolved.json 解析
 *   （hpl-model-tiers/resolved.ts 的共享 reader），或直接用 glob/具体 id 对可用模型匹配，不硬编码 id。
 * - 超时 / API 错误 / 输出不合法 → typed error（GateAutoTimeout / GateAutoApiError /
 *   GateAutoInvalidOutput），调用方统一按 unsure 回落。
 * - 判定结果 {verdict, reason} 走 Schema 校验，模型输出属不可信边界。
 */
import { notify } from "../notify.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { agentDir } from "../../config/hapilon-home.js";
import { matchesModelPattern } from "../hpl-model-tiers/index.js";
import { readResolvedTiersEffect } from "../hpl-model-tiers/resolved.js";
export const GATE_AUTO_DEFAULTS = {
    enabled: false,
    // 10s 在慢模型/长上下文下频繁触发判定超时回落（实测 cd 类命令被 fallback-confirm），放宽到 30s
    timeoutMs: 30000,
    model: "tier:haiku",
};
/** <HAPILON_HOME>/agent/settings.json 的 gateAuto 键，默认关闭 */
export function gateAutoSettingsPath() {
    return join(agentDir(), "settings.json");
}
function boolOr(raw, fallback, warn) {
    if (raw === undefined)
        return fallback;
    if (typeof raw === "boolean")
        return raw;
    notify(`[hpl-safety-gate] ${warn}，使用默认值。`);
    return fallback;
}
function positiveIntOr(raw, fallback, warn) {
    if (raw === undefined)
        return fallback;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0)
        return raw;
    notify(`[hpl-safety-gate] ${warn}，使用默认值。`);
    return fallback;
}
function stringOr(raw, fallback, warn) {
    if (raw === undefined)
        return fallback;
    if (typeof raw === "string" && raw.trim() !== "")
        return raw.trim();
    notify(`[hpl-safety-gate] ${warn}，使用默认值。`);
    return fallback;
}
export const readGateAutoConfigEffect = Effect.try({
    try: () => {
        const path = gateAutoSettingsPath();
        if (!existsSync(path))
            return { ...GATE_AUTO_DEFAULTS };
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            notify(`[hpl-safety-gate] ${path} 顶层必须是对象，gateAuto 使用默认配置。`);
            return { ...GATE_AUTO_DEFAULTS };
        }
        const raw = parsed.gateAuto;
        if (raw === undefined)
            return { ...GATE_AUTO_DEFAULTS };
        if (typeof raw !== "object" || Array.isArray(raw)) {
            notify("[hpl-safety-gate] settings.json gateAuto 必须是对象，使用默认配置。");
            return { ...GATE_AUTO_DEFAULTS };
        }
        const g = raw;
        return {
            enabled: boolOr(g.enabled, GATE_AUTO_DEFAULTS.enabled, "gateAuto.enabled 非布尔值"),
            timeoutMs: positiveIntOr(g.timeoutMs, GATE_AUTO_DEFAULTS.timeoutMs, "gateAuto.timeoutMs 非正数"),
            model: stringOr(g.model, GATE_AUTO_DEFAULTS.model, "gateAuto.model 非字符串"),
        };
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    notify(`[hpl-safety-gate] gateAuto 配置读取失败，使用默认配置：${String(error)}`);
    return { ...GATE_AUTO_DEFAULTS };
})));
export function readGateAutoConfig() {
    return Effect.runSync(readGateAutoConfigEffect);
}
const isSettingsObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** 读整个 settings.json；解析失败/非对象 → undefined，调用方据此放弃写入（绝不清空用户配置）。 */
function readSettings(path) {
    if (!existsSync(path))
        return {};
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        notify(`[hpl-safety-gate] 无法读取 settings.json，跳过写入：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
    if (!isSettingsObject(parsed)) {
        notify("[hpl-safety-gate] settings.json 不是对象，跳过写入。");
        return undefined;
    }
    return parsed;
}
function writeSettings(path, settings) {
    const parent = dirname(path);
    if (!existsSync(parent))
        mkdirSync(parent, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
/**
 * 只改 settings.json 的 `gateAuto.enabled`，gateAuto 其余字段（model/timeoutMs）与
 * settings 其他键一律保留。返回是否落盘成功：失败时调用方仍可只本会话生效。
 */
export const setGateAutoEnabledEffect = (enabled) => Effect.try({
    try: () => {
        const path = gateAutoSettingsPath();
        const settings = readSettings(path);
        if (!settings)
            return false;
        const gateAuto = isSettingsObject(settings.gateAuto) ? settings.gateAuto : {};
        gateAuto.enabled = enabled;
        settings.gateAuto = gateAuto;
        writeSettings(path, settings);
        return true;
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    notify(`[hpl-safety-gate] gateAuto 设置写入失败：${String(error)}`);
    return false;
})));
export function setGateAutoEnabled(enabled) {
    return Effect.runSync(setGateAutoEnabledEffect(enabled));
}
// ─── typed errors ────────────────────────────────────────────────────
export class GateAutoTimeout extends Data.TaggedError("GateAutoTimeout") {
}
export class GateAutoApiError extends Data.TaggedError("GateAutoApiError") {
}
export class GateAutoInvalidOutput extends Data.TaggedError("GateAutoInvalidOutput") {
}
const DESCRIBE_SYSTEM_PROMPT = `你是 hapilon 安全门的行为观察员。你只依据给出的近期工具行为记录（安全门亲眼所见的命令序列，客观事实）描述现场，不臆测、不转述 agent 的自我声明。
用不超过 80 字回答：agent 正在做什么任务、这条待判命令在其中扮演什么角色、写目标是什么、是否 git 可恢复。若记录显示待执行脚本由近期行为中 agent 自己创建或修改（heredoc/sed/write 生成后运行），明确指出「脚本为 agent 本会话自建」。记录不足时直说「记录不足」，不要编。只输出描述文本。`;
export const describeScenario = (deps) => Effect.gen(function* () {
    const resolvedTiers = yield* readResolvedTiersEffect;
    const model = resolveAutoModel(deps.modelSpec, deps.available, resolvedTiers);
    if (!model) {
        return yield* new GateAutoApiError({
            message: `观察员模型不可用（${deps.modelSpec}）`,
            command: deps.command,
        });
    }
    const userMessage = [
        `近期工具行为（从新到旧）：\n${deps.activityWindow.slice().reverse().map((a) => `- ${a}`).join("\n") || "（无）"}`,
        `cwd：${deps.cwd}`,
        ...(deps.ruleLabel ? [`命中安全规则：${deps.ruleLabel}`] : []),
        ...(deps.sandboxSummary ? [`写目标解析：${deps.sandboxSummary}`] : []),
        ...(deps.gitStatus ? [`写目标 git 状态：${deps.gitStatus}`] : []),
        `待判命令：\n${deps.command}`,
    ].join("\n\n");
    const response = yield* Effect.tryPromise({
        try: (signal) => deps.complete(model, {
            systemPrompt: DESCRIBE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
        }, { signal, reasoning: "off", maxTokens: 300 }),
        catch: (error) => new GateAutoApiError({
            message: error instanceof Error ? error.message : String(error),
            command: deps.command,
        }),
    }).pipe(Effect.timeout(deps.timeoutMs), Effect.catchTag("TimeoutException", () => new GateAutoTimeout({ timeoutMs: deps.timeoutMs, command: deps.command })));
    const text = response && typeof response === "object" && Array.isArray(response.content)
        ? response.content.map((p) => p.text ?? "").join("").trim()
        : "";
    if (!text) {
        return yield* new GateAutoInvalidOutput({ message: "观察员描述为空", command: deps.command });
    }
    return text.slice(0, 400);
});
// ─── 先例：近 7 天同规则自动放行记录 ───────────────────────
/** 读 gate-auto.jsonl 近 N 天同 ruleLabel 的 auto-allow 先例（compact 命令，至多 3 条） */
export function recentAllows(ruleLabel, days = 7, limit = 3, now = Date.now()) {
    if (!ruleLabel)
        return [];
    let lines;
    try {
        lines = readFileSync(join(agentDir(), "gate-auto.jsonl"), "utf8").split("\n").filter(Boolean);
    }
    catch {
        return [];
    }
    const matches = [];
    const cutoff = now - days * 86_400_000;
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.ruleLabel !== ruleLabel || entry.outcome !== "auto-allow")
                continue;
            const ts = Date.parse(entry.ts);
            if (ts < cutoff)
                continue;
            const compact = (entry.command ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
            if (compact)
                matches.push({ ts, compact });
        }
        catch {
            // 脏行跳过
        }
    }
    return matches.sort((a, b) => b.ts - a.ts).slice(0, limit).map((m) => m.compact);
}
const VERDICT_SCHEMA = Schema.Struct({
    verdict: Schema.Literal("allow", "block", "unsure"),
    reason: Schema.String,
});
const decodeVerdict = Schema.decodeUnknownSync(VERDICT_SCHEMA);
const JUDGE_SYSTEM_PROMPT = `你是 hapilon（终端 coding agent）安全门的判定员，对 bash 命令做三值判定。

环境自述：这是 hapilon 自己的机器环境。$HAPILON_HOME（~/.hapilon*）是 hapilon 的家目录：其中 agents/skills/ 是随版本分发的自带技能与脚本（可信工具链），plan-task/ 是临时工作区。当前 cwd 通常是一个 git 仓库：git 跟踪的文件被删改都可恢复（reflog/历史），但未被跟踪的新文件删了就没了。

判定看性质，不比对命令名单：
- allow：写目标可静态解析且在临时目录/沙箱/hapilon 家目录/项目申报路径内；或目标受 git 跟踪可恢复（sed -i 改源码、git push、commit --amend、checkout/restore 恢复、npm version 这类单人仓库常规迭代）；技能脚本（$HAPILON_HOME/agents/skills/ 下）执行属于工具链调用；观察员指出待执行脚本是 agent 本会话自己创建或修改的文件时，执行它属于自建工具行为，写目标限于仓库与 /tmp 即可放行。
- block：不可逆且越出仓库与沙箱——删根/home、格式化磁盘、清生产数据、强推共享主干、写系统路径。
- unsure：写目标无法静态解析、影响面拿不准、需要人来拍板。拿不准一律 unsure，宁可多问不可放过。

场景描述与先例是辅助信息，可能有误：命令本身、写目标解析、git 跟踪状态、cwd 才是硬事实，冲突时以硬事实为准。
只输出一行 JSON：{"verdict":"allow|block|unsure","reason":"不超过 60 字的理由"}`;
/** `tier:<name>[<index>]` 查 resolved 档位表取可用模型；其余按 glob/具体 id 直接匹配。
 *  tier 指代解析与 hpl-model-tiers 的 parseTierReference 重复，有意保留：
 *  判定层自含解析不做跨扩展依赖；新代码解析 tier 指代请直接用 parseTierReference。 */
function resolveAutoModel(spec, available, resolvedTiers) {
    const wanted = spec.trim();
    const ref = /^tier:(opus|sonnet|haiku)(?:\[(\d+)\])?$/.exec(wanted);
    if (ref) {
        const tier = ref[1];
        const index = ref[2] === undefined ? 0 : Number(ref[2]);
        const entry = resolvedTiers[tier][index];
        if (!entry)
            return undefined;
        return available.find((m) => m.provider === entry.provider && m.id === entry.id);
    }
    return available.find((m) => matchesModelPattern(wanted, m));
}
/** 从模型响应提取 {verdict, reason}；围栏/前后噪声容忍，解析或校验失败 → InvalidOutput */
export function parseJudgeOutput(raw, command) {
    let text = "";
    if (raw && typeof raw === "object" && Array.isArray(raw.content)) {
        text = raw.content
            .map((part) => (part && typeof part === "object" && typeof part.text === "string"
            ? part.text
            : ""))
            .filter(Boolean)
            .join("\n");
    }
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const candidate = (fenced ? fenced[1] : text).trim();
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) {
        throw new GateAutoInvalidOutput({ message: `响应不含 JSON：${text.slice(0, 120)}`, command });
    }
    let parsed;
    try {
        parsed = JSON.parse(candidate.slice(start, end + 1));
    }
    catch (error) {
        throw new GateAutoInvalidOutput({
            message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
            command,
        });
    }
    try {
        const verdict = decodeVerdict(parsed);
        return { verdict: verdict.verdict, reason: verdict.reason };
    }
    catch (error) {
        throw new GateAutoInvalidOutput({
            message: `schema 校验失败：${error instanceof Error ? error.message : String(error)}`,
            command,
        });
    }
}
function buildUserMessage(deps) {
    const parts = [`命令：\n${deps.command}`, `cwd：${deps.cwd}`];
    if (deps.ruleLabel)
        parts.push(`命中安全规则：${deps.ruleLabel}`);
    if (deps.sandboxSummary)
        parts.push(`写目标解析：${deps.sandboxSummary}`);
    if (deps.gitStatus)
        parts.push(`写目标 git 状态（硬事实）：${deps.gitStatus}`);
    if (deps.scenario)
        parts.push(`行为观察员的场景描述（辅助，可能有误）：${deps.scenario}`);
    if (deps.precedents && deps.precedents.length > 0) {
        parts.push(`近 7 天同规则自动放行先例：\n${deps.precedents.map((p) => `- ${p}`).join("\n")}`);
    }
    return parts.join("\n\n");
}
/**
 * 模型判定：返回判定结果；超时 / 调用失败 / 输出不合法分别以 typed error 失败，
 * 由调用方按 unsure 回落现有人工路径。
 */
export const judgeCommand = (deps) => Effect.gen(function* () {
    const resolvedTiers = yield* readResolvedTiersEffect;
    const model = resolveAutoModel(deps.modelSpec, deps.available, resolvedTiers);
    if (!model) {
        return yield* new GateAutoApiError({
            message: `判定模型不可用（${deps.modelSpec} 在 resolved 档位/可用列表中无匹配）`,
            command: deps.command,
        });
    }
    const response = yield* Effect.tryPromise({
        try: (signal) => deps.complete(model, {
            systemPrompt: JUDGE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildUserMessage(deps), timestamp: Date.now() }],
        }, {
            signal,
            reasoning: "low",
            maxTokens: 500,
        }),
        catch: (error) => new GateAutoApiError({
            message: error instanceof Error ? error.message : String(error),
            command: deps.command,
        }),
    }).pipe(Effect.timeout(deps.timeoutMs), Effect.catchTag("TimeoutException", () => new GateAutoTimeout({ timeoutMs: deps.timeoutMs, command: deps.command })));
    // parseJudgeOutput 只会抛 GateAutoInvalidOutput，此处提起为 typed failure（避免成为 defect）
    const parsed = yield* Effect.try({
        try: () => parseJudgeOutput(response, deps.command),
        catch: (error) => error,
    });
    return { ...parsed, model: `${model.provider}/${model.id}` };
});
