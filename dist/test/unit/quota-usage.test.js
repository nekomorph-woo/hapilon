import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import hplQuotaUsage, { isSupportedProvider, loadQuotaEffect, queryQuotaEffect, } from "../../extensions/hpl-quota-usage/index.js";
function makeModel(provider) {
    return { provider, id: "test-model", name: "Test model" };
}
describe("hpl-quota-usage provider 分发", () => {
    it("只支持 DeepSeek、GLM 中国区和 OpenAI Codex", () => {
        assert.equal(isSupportedProvider("deepseek"), true);
        assert.equal(isSupportedProvider("zai-coding-cn"), true);
        assert.equal(isSupportedProvider("openai-codex"), true);
        assert.equal(isSupportedProvider("zai"), false);
        assert.equal(isSupportedProvider("anthropic"), false);
    });
    it("其它 provider 不联网并给出未提供公开查询提示", async () => {
        const ctx = {
            modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }) },
        };
        const result = await Effect.runPromise(loadQuotaEffect(ctx, makeModel("xai")));
        assert.equal(result.fields[0]?.value, "该 provider 未提供公开用量查询");
    });
    it("支持 provider 缺凭证时不发请求并提示 /login", async () => {
        let calls = 0;
        const ctx = {
            modelRegistry: {
                getApiKeyAndHeaders: async () => {
                    calls++;
                    return { ok: false, error: "No API key" };
                },
            },
        };
        const result = await Effect.runPromise(loadQuotaEffect(ctx, makeModel("deepseek")));
        assert.equal(calls, 1);
        assert.equal(result.fields[0]?.value, "未找到该 provider 的凭证，请先 /login");
    });
    it("网络失败通过 Effect 降级为错误行，不向调用方抛出", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => { throw new Error("network down"); });
        try {
            const result = await Effect.runPromise(queryQuotaEffect("openai-codex", { apiKey: "token" }).pipe(Effect.map((fields) => ({ fields })), Effect.catchAll(() => Effect.succeed({ fields: [{ label: "状态", value: "查询失败", tone: "error" }] }))));
            assert.equal(result.fields[0]?.value, "查询失败");
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
describe("hpl-quota-usage 命令", () => {
    it("注册 quota-usage，并把凭证缺失结果送入 FloatingPane fallback", async () => {
        const commands = new Map();
        hplQuotaUsage({
            registerCommand: (name, definition) => commands.set(name, definition),
        });
        assert.ok(commands.has("quota-usage"));
        const notifications = [];
        await commands.get("quota-usage").handler("", {
            mode: "rpc",
            hasUI: false,
            model: makeModel("deepseek"),
            modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }) },
            ui: { notify: (message) => notifications.push(message) },
        });
        assert.match(notifications[0], /Quota Usage — deepseek/);
        assert.match(notifications[0], /未找到该 provider 的凭证，请先 \/login/);
    });
});
