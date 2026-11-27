import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hapilonHome } from "../../config/hapilon-home.js";
import { runMenuLoop } from "../../shared/menu-loop.js";
import { readTierConfigFileEffect, saveModelTiersEffect } from "../hpl-model-tiers/config.js";
import { MODEL_TIERS } from "../hpl-model-tiers/resolved.js";
import { modelIdentity, recommendTiers, tierSize } from "./recommend.js";
import { applyCompressPresetEffect, COMPRESS_PRESETS, presetSummary } from "./compress.js";
const TIER_LABEL = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const SAVE = "覆盖并保存";
const CANCEL = "取消";
const RULE_TEMPLATE = new URL("../../../resources/setup/ego-browser.md", import.meta.url);
class RuleError extends Data.TaggedError("RuleError") {
}
async function editTier(ctx, candidates, draft, tier, index) {
    const entries = draft[tier];
    const used = new Set(entries.filter((_, position) => position !== index).map(({ model }) => modelIdentity(model)));
    const available = candidates.filter(({ model }) => !used.has(modelIdentity(model)));
    const moveUp = "上移一位";
    const model = await ctx.ui.select(`${TIER_LABEL[tier]} ${index + 1} · 选择模型`, [
        ...available.map((candidate) => candidate.model), ...(index > 0 && index < entries.length ? [moveUp] : []),
    ]);
    if (model === moveUp) {
        const [entry] = entries.splice(index, 1);
        entries.splice(index - 1, 0, entry);
        return;
    }
    const candidate = available.find((entry) => entry.model === model);
    if (!candidate)
        return;
    const thinking = await ctx.ui.select(`${TIER_LABEL[tier]} · ${candidate.model} · 思考强度`, [...candidate.thinking]);
    const supported = candidate.thinking.find((level) => level === thinking);
    if (supported !== undefined)
        entries[index] = { model: candidate.model, thinking: supported };
}
async function setupTiers(ctx) {
    const models = ctx.modelRegistry.getAvailable();
    const candidates = models.map((model) => ({
        model: `${model.provider}/${model.id}`,
        name: model.name,
        thinking: getSupportedThinkingLevels(model),
    }));
    const model = models.find((entry) => entry.provider === ctx.model?.provider && entry.id === ctx.model?.id) ?? models[0];
    if (!model) {
        ctx.ui.notify("没有可用模型。请先登录或添加模型供应商。", "warning");
        return;
    }
    const recommendation = await ctx.ui.custom((tui, theme, _keys, done) => {
        const loader = new BorderedLoader(tui, theme, `正在用 ${model.provider}/${model.id} 联网查询并生成推荐…`);
        loader.onAbort = () => done(null);
        void Effect.runPromise(recommendTiers({ cwd: ctx.cwd, signal: loader.signal, model, candidates }).pipe(Effect.catchTag("RecommendationError", (error) => Effect.sync(() => {
            if (loader.signal.aborted)
                return null;
            ctx.ui.notify(`${error.message}。你仍可手动选择。`, "warning");
            return { opus: [], sonnet: [], haiku: [] };
        })))).then((draft) => { if (!loader.signal.aborted)
            done(draft); });
        return loader;
    });
    if (!recommendation)
        return;
    const path = join(hapilonHome(), "model-tiers.json");
    const { global, project } = await Effect.runPromise(Effect.all({
        global: readTierConfigFileEffect(path),
        project: readTierConfigFileEffect(join(ctx.cwd, ".hapilon", "model-tiers.json")),
    }));
    const count = tierSize(candidates);
    while (true) {
        const rows = MODEL_TIERS.flatMap((tier) => {
            const entries = recommendation[tier];
            return Array.from({ length: Math.min(count, entries.length + 1) }, (_, index) => {
                const next = entries[index];
                const current = global[tier]?.[index] ?? "未设置";
                const choice = next ? `${next.model} · ${next.thinking}` : "选择模型";
                const overridden = project[tier] !== undefined ? " · 当前项目有覆盖" : "";
                const label = `${TIER_LABEL[tier]} ${index + 1} · ${current} → ${choice}${overridden}${next?.reason ? `\n    ${next.reason}` : ""}`;
                return { label, tier, index };
            });
        });
        const complete = MODEL_TIERS.every((tier) => recommendation[tier].length === count);
        const selected = await ctx.ui.select("模型档位 · 全局配置\n第 1 项是首选。回车编辑。保存会覆盖三档和旧候补。", [...rows.map(({ label }) => label), ...(complete ? [SAVE] : []), CANCEL]);
        if (selected === undefined || selected === CANCEL)
            return;
        if (selected === SAVE) {
            if (!await ctx.ui.confirm("覆盖模型档位？", path))
                continue;
            const spec = (tier) => recommendation[tier].map(({ model, thinking }) => `${model}:${thinking}`);
            const saved = await Effect.runPromise(saveModelTiersEffect({ opus: spec("opus"), sonnet: spec("sonnet"), haiku: spec("haiku") }));
            ctx.ui.notify(saved ? "已覆盖全局模型档位。执行 /reload 使档位生效。" : "保存模型档位失败。", saved ? "info" : "error");
            return;
        }
        const row = rows.find(({ label }) => label === selected);
        if (row)
            await editTier(ctx, candidates, recommendation, row.tier, row.index);
    }
}
function readRule(path) {
    return Effect.try({
        try: () => readFileSync(path, "utf8"),
        catch: (cause) => new RuleError({ message: `读取规则失败：${String(cause)}` }),
    });
}
async function setupEgo(pi, ctx) {
    const probe = await pi.exec("ego-browser", ["--version"], { timeout: 5_000, maxBuffer: 4096 });
    const path = join(hapilonHome(), "agents", "rules", "ego-browser.md");
    const template = await Effect.runPromise(readRule(RULE_TEMPLATE));
    const check = probe.code === 0 ? "已找到 ego-browser" : "未找到可用的 ego-browser";
    const selected = await ctx.ui.select(`Ego Lite 任务空间 · ${check}\n${path}\n\n${template.trim()}`, [CANCEL, ...(probe.code === 0 ? ["启用规则"] : [])]);
    if (selected !== "启用规则")
        return;
    const installed = await Effect.runPromise(Effect.try({
        try: () => {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            writeFileSync(path, template, { flag: "wx", mode: 0o600 });
        },
        catch: (cause) => new RuleError({ message: `写入规则失败：${String(cause)}` }),
    }).pipe(Effect.either));
    if (installed._tag === "Right") {
        ctx.ui.notify("已启用 Ego Lite 任务空间规则。", "info");
        return;
    }
    const existing = await Effect.runPromise(readRule(path).pipe(Effect.either));
    if (existing._tag === "Left") {
        ctx.ui.notify(installed.left.message, "error");
        return;
    }
    const same = existing.right === template;
    ctx.ui.notify(same ? "Ego Lite 规则已启用。" : `保留现有的同名规则，未覆盖 ${path}`, same ? "info" : "warning");
}
const ACP_CONFIG_PATH = join(homedir(), ".pi", "acp.json");
/** 上下文压缩档位：按每个可用模型的最大上下文选档，写进 billion-context 读的 ~/.pi/acp.json */
async function setupCompress(ctx) {
    const models = ctx.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        contextWindow: model.contextWindow,
    }));
    const chosen = await ctx.ui.select(`上下文压缩档位 · ${ACP_CONFIG_PATH}\n每档：增长量 / 强制提醒的窗口占比。未列出的模型按插件默认。`, [...COMPRESS_PRESETS.map((preset) => `${preset.label}：${presetSummary(preset, models)}`), CANCEL]);
    const preset = COMPRESS_PRESETS.find((entry) => `${entry.label}：${presetSummary(entry, models)}` === chosen);
    if (!preset)
        return;
    const result = await Effect.runPromise(applyCompressPresetEffect(ACP_CONFIG_PATH, preset, models).pipe(Effect.either));
    ctx.ui.notify(result._tag === "Right" ? `已写入压缩档位「${preset.label}」，新会话生效。` : result.left.message, result._tag === "Right" ? "info" : "error");
}
export default function fastHapilonSetup(pi) {
    pi.registerCommand("fast-hapilon-setup", {
        description: "快速配置模型档位、上下文压缩档位和 Ego Lite 任务空间",
        handler: (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("快速设置需要交互终端。", "warning");
                return Promise.resolve();
            }
            return runMenuLoop(ctx, {
                title: "Hapilon 快速设置",
                build: () => [
                    { label: "推荐模型档位", run: () => setupTiers(ctx) },
                    { label: "上下文压缩档位", run: () => setupCompress(ctx) },
                    { label: "启用 Ego Lite 任务空间", run: () => setupEgo(pi, ctx) },
                ],
            });
        },
    });
}
