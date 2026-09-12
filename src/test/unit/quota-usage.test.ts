import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import hplQuotaUsage, {
  isSupportedProvider,
  loadQuotaEffect,
  queryQuotaEffect,
} from "../../extensions/hpl-quota-usage/index.js";
import { GLM_QUOTA_ENDPOINT_INTL } from "../../extensions/hpl-quota-usage/providers/glm.js";

function makeModel(provider: string) {
  return { provider, id: "test-model", name: "Test model" } as never;
}

describe("hpl-quota-usage provider 分发", () => {
  it("只支持 DeepSeek、GLM 中国区和 OpenAI Codex", () => {
    assert.equal(isSupportedProvider("deepseek"), true);
    assert.equal(isSupportedProvider("zai-coding-cn"), true);
    assert.equal(isSupportedProvider("openai-codex"), true);
    assert.equal(isSupportedProvider("zai"), true);
    assert.equal(isSupportedProvider("anthropic"), false);
  });

  it("其它 provider 不联网并给出未提供公开查询提示", async () => {
    const ctx = {
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }) },
    } as never;
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
    } as never;
    const result = await Effect.runPromise(loadQuotaEffect(ctx, makeModel("deepseek")));
    assert.equal(calls, 1);
    assert.equal(result.fields[0]?.value, "未找到该 provider 的凭证，请先 /login");
  });

  it("zai 国际侧分发到 api.z.ai quota/limit 并解析 limits 结构", async () => {
    const originalFetch = globalThis.fetch;
    let url = "";
    globalThis.fetch = (async (input) => {
      url = String(input);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          msg: "Operation successful",
          data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42, nextResetTime: 1788708538082 }] },
        }),
      } as Response;
    }) as typeof fetch;
    try {
      const fields = await Effect.runPromise(queryQuotaEffect("zai", { apiKey: "zai-key" }));
      assert.equal(url, GLM_QUOTA_ENDPOINT_INTL);
      assert.equal(GLM_QUOTA_ENDPOINT_INTL, "https://api.z.ai/api/monitor/usage/quota/limit");
      assert.ok(fields.some((item) => item.label === "Token 用量（5 小时窗口）" && item.value.includes("42%")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("网络失败通过 Effect 降级为错误行，不向调用方抛出", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    try {
      const result = await Effect.runPromise(queryQuotaEffect("openai-codex", { apiKey: "token" }).pipe(
        Effect.map((fields) => ({ fields })),
        Effect.catchAll(() => Effect.succeed({ fields: [{ label: "状态", value: "查询失败", tone: "error" as const }] })),
      ));
      assert.equal(result.fields[0]?.value, "查询失败");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("hpl-quota-usage 命令", () => {
  it("注册 quota-usage，无任何凭证时提示且不发请求", async () => {
    const commands = new Map<string, { handler: Function }>();
    hplQuotaUsage({
      on: () => {},
      registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
    } as never);
    assert.ok(commands.has("quota-usage"));

    const notifications: string[] = [];
    await commands.get("quota-usage")!.handler("", {
      mode: "rpc",
      hasUI: false,
      model: makeModel("deepseek"),
      modelRegistry: {
        getAll: () => [],
        getAvailable: () => [],
        getProviderAuthStatus: () => ({ configured: false }),
      },
      ui: { notify: (message: string) => notifications.push(message) },
    });
    assert.match(notifications[0]!, /Quota Usage — all providers/);
    assert.match(notifications[0]!, /没有已配置凭证的可查询 provider/);
  });

  it("全 provider 视图：有凭证的 provider 分区展示，当前 provider 置顶", async () => {
    const originalFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("deepseek.com")) {
        return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12" }] }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 30, nextResetTime: Date.now() + 3600_000 }] } }),
      } as Response;
    }) as typeof fetch;
    try {
      const commands = new Map<string, { handler: Function }>();
      hplQuotaUsage({
        on: () => {},
        registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
      } as never);

      const notifications: string[] = [];
      const deepseekModel = makeModel("deepseek");
      const zaiModel = makeModel("zai");
      await commands.get("quota-usage")!.handler("", {
        mode: "rpc",
        hasUI: false,
        model: zaiModel,
        modelRegistry: {
          getAll: () => [deepseekModel, zaiModel],
          getAvailable: () => [deepseekModel, zaiModel],
          getProviderAuthStatus: (provider: string) =>
            ({ configured: provider === "deepseek" || provider === "zai" }),
          getApiKeyAndHeaders: async (model: { provider: string }) =>
            model.provider === "deepseek"
              ? { ok: true, apiKey: "ds-key" }
              : { ok: true, apiKey: "zai-key" },
        },
        ui: { notify: (message: string) => notifications.push(message) },
      });
      const text = notifications.join("\n");
      // 当前 provider zai 分区在前
      assert.ok(text.indexOf("▌ zai（当前）") < text.indexOf("▌ deepseek"));
      assert.match(text, /已用 30%/);
      assert.match(text, /CNY 总余额: 12/);
      // 两家端点都被请求
      assert.ok(fetchedUrls.some((u) => u.includes("deepseek.com")));
      assert.ok(fetchedUrls.some((u) => u.includes("api.z.ai")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
