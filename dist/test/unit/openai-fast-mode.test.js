import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { prepareStartupEffect } from "../../cli/startup.js";
import { discoverExtensions, extensionNames } from "../../extensions/loader.js";
import hplOpenAiFastMode from "../../extensions/hpl-openai-fast-mode/index.js";
import { addFastModeModel, addFastModeServiceTier, DEFAULT_FAST_MODE_SETTINGS, readFastModeSettingsEffect, removeFastModeModel, toggleFastModeModel, writeFastModeSettingsEffect, } from "../../extensions/hpl-openai-fast-mode/settings.js";
const enabledSettings = { ...DEFAULT_FAST_MODE_SETTINGS, enabled: true, models: ["gpt-5*"] };
const codexModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
const openAiModel = { provider: "openai", id: "gpt-5.6-sol" };
test("maps Fast for Codex and preserves the chosen tier for OpenAI", () => {
    const body = { model: "gpt-5.6-sol", input: "hello" };
    assert.deepEqual(addFastModeServiceTier(body, enabledSettings, codexModel), {
        ...body,
        service_tier: "priority",
    });
    assert.deepEqual(addFastModeServiceTier(body, enabledSettings, openAiModel), {
        ...body,
        service_tier: "fast",
    });
    for (const serviceTier of ["standard", "flex", "priority"]) {
        assert.deepEqual(addFastModeServiceTier(body, { ...enabledSettings, serviceTier }, codexModel), {
            ...body,
            service_tier: serviceTier,
        });
    }
    assert.equal(addFastModeServiceTier(body, DEFAULT_FAST_MODE_SETTINGS, codexModel), undefined);
    assert.equal(addFastModeServiceTier(body, { ...DEFAULT_FAST_MODE_SETTINGS, enabled: true }, codexModel), undefined);
    assert.equal(addFastModeServiceTier(body, { ...DEFAULT_FAST_MODE_SETTINGS, enabled: true }, openAiModel), undefined);
    assert.equal(addFastModeServiceTier(body, enabledSettings, { provider: "anthropic", id: "gpt-5.6-sol" }), undefined);
    assert.equal(addFastModeServiceTier(body, enabledSettings, { provider: "openai", id: "gpt-4.1" }), undefined);
    assert.equal(addFastModeServiceTier("invalid body", enabledSettings, codexModel), undefined);
});
test("starts with an empty allowlist and supports exact add, toggle, and glob removal", () => {
    assert.deepEqual(DEFAULT_FAST_MODE_SETTINGS.models, []);
    const added = addFastModeModel(DEFAULT_FAST_MODE_SETTINGS, openAiModel);
    assert.deepEqual(added.models, ["openai/gpt-5.6-sol"]);
    assert.deepEqual(toggleFastModeModel(added, openAiModel).settings.models, []);
    const withGlobs = { ...DEFAULT_FAST_MODE_SETTINGS, models: ["gpt-5*", "gpt-4*"] };
    assert.deepEqual(toggleFastModeModel(withGlobs, openAiModel).settings.models, ["gpt-4*"]);
    assert.deepEqual(removeFastModeModel(withGlobs, "gpt-5*").models, ["gpt-4*"]);
});
test("persists Fast settings while preserving other Pi settings", () => {
    const root = mkdtempSync(join(tmpdir(), "hpl-fast-mode-"));
    const agent = join(root, "agent");
    mkdirSync(agent);
    const path = join(agent, "settings.json");
    writeFileSync(path, JSON.stringify({ defaultProvider: "openai-codex", gateAuto: { enabled: true } }));
    const next = { ...enabledSettings, serviceTier: "flex" };
    try {
        assert.equal(Effect.runSync(writeFastModeSettingsEffect(agent, next)), true);
        const stored = JSON.parse(readFileSync(path, "utf8"));
        assert.deepEqual(stored.gateAuto, { enabled: true });
        assert.deepEqual(Effect.runSync(readFastModeSettingsEffect(agent)), next);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("/fast shortcuts, completions, and menu manage the allowlist and settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpl-fast-command-"));
    const previousHome = process.env.HAPILON_HOME;
    process.env.HAPILON_HOME = root;
    const commands = new Map();
    const handlers = new Map();
    const notices = [];
    const picks = [];
    const inputs = [];
    const inputCalls = [];
    const selectCalls = [];
    const available = [
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        { provider: "openai", id: "gpt-5.6-sol" },
        { provider: "anthropic", id: "claude-sonnet" },
    ];
    const ctx = {
        model: codexModel,
        modelRegistry: { getAvailable: () => available },
        ui: {
            notify: (message) => notices.push(message),
            select: async (title, options) => {
                selectCalls.push({ title, options });
                const index = picks.shift();
                return index === undefined ? undefined : options[index];
            },
            input: async (title, placeholder) => {
                inputCalls.push({ title, placeholder });
                return inputs.shift();
            },
        },
    };
    try {
        hplOpenAiFastMode({
            registerCommand: (name, command) => commands.set(name, command),
            on: (event, handler) => { handlers.set(event, handler); return () => { }; },
        });
        const command = commands.get("fast");
        assert.ok(command);
        assert.deepEqual(command.getArgumentCompletions?.("")?.map(({ value }) => value), [
            "on", "off", "tier fast", "tier priority", "tier standard", "tier flex",
        ]);
        await command.handler("on", ctx);
        await command.handler("off", ctx);
        assert.equal(Effect.runSync(readFastModeSettingsEffect(join(root, "agent"))).enabled, false);
        picks.push(0);
        await command.handler("", ctx);
        assert.match(selectCalls[0].title, /全局 Fast：关闭/);
        assert.match(selectCalls[0].title, /当前模型：openai-codex\/gpt-5\.6-sol（未命中）/);
        assert.match(selectCalls[0].title, /模型白名单：（空）/);
        assert.deepEqual(Effect.runSync(readFastModeSettingsEffect(join(root, "agent"))).models, [
            "openai-codex/gpt-5.6-sol",
        ]);
        picks.push(1, 1);
        await command.handler("", ctx);
        assert.deepEqual(selectCalls.at(-1)?.options, [
            "openai-codex/gpt-5.6-luna",
            "openai/gpt-5.6-sol",
        ]);
        assert.deepEqual(Effect.runSync(readFastModeSettingsEffect(join(root, "agent"))).models, [
            "openai-codex/gpt-5.6-sol",
            "openai/gpt-5.6-sol",
        ]);
        const current = Effect.runSync(readFastModeSettingsEffect(join(root, "agent")));
        Effect.runSync(writeFastModeSettingsEffect(join(root, "agent"), {
            ...current,
            models: [...current.models, "gpt-5*"],
        }));
        picks.push(3, 2);
        await command.handler("", ctx);
        assert.deepEqual(selectCalls.at(-1)?.options, [
            "openai-codex/gpt-5.6-sol",
            "openai/gpt-5.6-sol",
            "gpt-5*",
        ]);
        assert.deepEqual(Effect.runSync(readFastModeSettingsEffect(join(root, "agent"))).models, [
            "openai-codex/gpt-5.6-sol",
            "openai/gpt-5.6-sol",
        ]);
        inputs.push(" gpt* ");
        picks.push(2);
        await command.handler("", ctx);
        assert.deepEqual(Effect.runSync(readFastModeSettingsEffect(join(root, "agent"))).models, [
            "openai-codex/gpt-5.6-sol",
            "openai/gpt-5.6-sol",
            "gpt*",
        ]);
        assert.match(notices.at(-1) ?? "", /模式 gpt\* 加入白名单/);
        assert.deepEqual(inputCalls.at(-1), {
            title: "输入白名单模式（glob）",
            placeholder: "gpt* 或 openai-codex/gpt*",
        });
        picks.push(4, 2);
        await command.handler("", ctx);
        assert.equal(Effect.runSync(readFastModeSettingsEffect(join(root, "agent"))).serviceTier, "standard");
        await command.handler("tier fast", ctx);
        picks.push(5);
        await command.handler("", ctx);
        assert.equal(Effect.runSync(readFastModeSettingsEffect(join(root, "agent"))).enabled, true);
        const settingsPath = join(root, "agent", "settings.json");
        for (const response of [undefined, "   "]) {
            const savedSettings = readFileSync(settingsPath, "utf8");
            utimesSync(settingsPath, new Date(0), new Date(0));
            const savedMtime = statSync(settingsPath, { bigint: true }).mtimeNs;
            const inputCount = inputCalls.length;
            inputs.push(response);
            picks.push(2);
            await command.handler("", ctx);
            assert.deepEqual(selectCalls.at(-1)?.options[2], "按模式添加（glob）");
            assert.equal(inputCalls.length, inputCount + 1);
            assert.equal(readFileSync(settingsPath, "utf8"), savedSettings);
            assert.equal(statSync(settingsPath, { bigint: true }).mtimeNs, savedMtime);
        }
        const savedSettings = readFileSync(settingsPath, "utf8");
        utimesSync(settingsPath, new Date(0), new Date(0));
        const savedMtime = statSync(settingsPath, { bigint: true }).mtimeNs;
        picks.push(1);
        await command.handler("", ctx);
        assert.equal(selectCalls.at(-1)?.title, "添加 OpenAI 系模型");
        assert.equal(readFileSync(settingsPath, "utf8"), savedSettings);
        assert.equal(statSync(settingsPath, { bigint: true }).mtimeNs, savedMtime);
        const hook = handlers.get("before_provider_request");
        assert.ok(hook);
        assert.deepEqual(hook({ payload: { model: codexModel.id } }, ctx), {
            model: codexModel.id,
            service_tier: "priority",
        });
        assert.equal(Effect.runSync(readFastModeSettingsEffect(join(root, "agent"))).serviceTier, "fast");
        assert.ok(notices.length > 0);
    }
    finally {
        if (previousHome === undefined)
            delete process.env.HAPILON_HOME;
        else
            process.env.HAPILON_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    }
});
test("loader discovers the extension directory without a separate registry", () => {
    assert.ok(extensionNames(discoverExtensions()).includes("hpl-openai-fast-mode"));
});
test("startup passes the extension to Pi", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpl-fast-startup-"));
    const previousHome = process.env.HAPILON_HOME;
    process.env.HAPILON_HOME = root;
    try {
        const plan = await Effect.runPromise(prepareStartupEffect(["--print", "--no-safety"]));
        assert.ok(plan.extensionFlags.some((value, index) => value === "-e" && plan.extensionFlags[index + 1]?.endsWith("hpl-openai-fast-mode/index.js")));
        assert.ok(JSON.parse(plan.piEnv.HAPILON_EXTENSIONS ?? "[]").includes("hpl-openai-fast-mode"));
    }
    finally {
        if (previousHome === undefined)
            delete process.env.HAPILON_HOME;
        else
            process.env.HAPILON_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    }
});
