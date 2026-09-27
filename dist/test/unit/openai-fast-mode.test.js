import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { prepareStartupEffect } from "../../cli/startup.js";
import { discoverExtensions, extensionNames } from "../../extensions/loader.js";
import hplOpenAiFastMode from "../../extensions/hpl-openai-fast-mode/index.js";
import { addFastModeServiceTier, DEFAULT_FAST_MODE_SETTINGS, readFastModeSettingsEffect, writeFastModeSettingsEffect, } from "../../extensions/hpl-openai-fast-mode/settings.js";
const enabledSettings = { ...DEFAULT_FAST_MODE_SETTINGS, enabled: true };
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
    assert.equal(addFastModeServiceTier(body, enabledSettings, { provider: "anthropic", id: "gpt-5.6-sol" }), undefined);
    assert.equal(addFastModeServiceTier(body, enabledSettings, { provider: "openai", id: "gpt-4.1" }), undefined);
    assert.equal(addFastModeServiceTier("invalid body", enabledSettings, codexModel), undefined);
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
test("registers /fast and applies persisted settings to provider requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpl-fast-command-"));
    const previousHome = process.env.HAPILON_HOME;
    process.env.HAPILON_HOME = root;
    const commands = new Map();
    const handlers = new Map();
    const notices = [];
    const ctx = {
        model: codexModel,
        ui: { notify: (message) => notices.push(message) },
    };
    try {
        hplOpenAiFastMode({
            registerCommand: (name, command) => commands.set(name, command),
            on: (event, handler) => { handlers.set(event, handler); return () => { }; },
        });
        const command = commands.get("fast");
        assert.ok(command);
        await command.handler("on", ctx);
        assert.match(notices.at(-1) ?? "", /已开启/);
        const hook = handlers.get("before_provider_request");
        assert.ok(hook);
        assert.deepEqual(hook({ payload: { model: codexModel.id } }, ctx), {
            model: codexModel.id,
            service_tier: "priority",
        });
        assert.equal(JSON.parse(readFileSync(join(root, "agent", "settings.json"), "utf8")).hplFastMode.serviceTier, "fast");
        await command.handler("", ctx);
        assert.match(notices.at(-1) ?? "", /白名单：命中/);
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
