import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import {
  DEEPSEEK_BALANCE_ENDPOINT,
  fetchQuotaEffect as fetchDeepSeekQuota,
  parseQuotaLines as parseDeepSeekQuota,
} from "../../extensions/hpl-quota-usage/providers/deepseek.js";
import {
  GLM_QUOTA_ENDPOINT,
  parseQuotaLines as parseGlmQuota,
} from "../../extensions/hpl-quota-usage/providers/glm.js";
import {
  CODEX_USAGE_ENDPOINT,
  parseQuotaLines as parseCodexQuota,
} from "../../extensions/hpl-quota-usage/providers/codex.js";

function values(rows: Array<{ label: string; value: string }>): string {
  return rows.map((row) => `${row.label}: ${row.value}`).join("\n");
}

describe("hpl-quota-usage provider 解析", () => {
  it("DeepSeek balance 样例明确展示余额而非用量窗口", () => {
    const rows = parseDeepSeekQuota({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: 20, granted_balance: 10, topped_up_balance: 10 },
        { currency: "USD", total_balance: 2.5, granted_balance: 0, topped_up_balance: 2.5 },
      ],
    });
    const text = values(rows);
    assert.match(text, /类型: 余额（非用量窗口）/);
    assert.match(text, /CNY 总余额: 20/);
    assert.match(text, /USD 充值余额: 2\.5/);
  });

  it("DeepSeek 字段缺失时逐项显示 unknown", () => {
    const rows = parseDeepSeekQuota({ is_available: true, balance_infos: [{}] });
    assert.match(values(rows), /unknown 总余额: unknown/);
    assert.match(values(rows), /unknown 充值余额: unknown/);
  });

  it("GLM quota/limit 真实结构解析双 Token 窗口与 MCP 用量", () => {
    const rows = parseGlmQuota({
      code: 200,
      msg: "操作成功",
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 18, nextResetTime: 1788708538082 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 76, nextResetTime: 1788770076982 },
          {
            type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 309,
            remaining: 3691, percentage: 7, nextResetTime: 1790152476997,
            usageDetails: [{ modelCode: "search-prime", usage: 170 }],
          },
        ],
      },
    });
    const text = values(rows);
    assert.match(text, /Token 用量（5 小时窗口）: 已用 18% · 每 5 小时重置/);
    assert.match(text, /Token 用量（周窗口）: 已用 76%/);
    assert.match(text, /MCP 工具月用量: 已用 7% · 309\/4000 次调用/);
    assert.match(text, /重置于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(text, /Top: search-prime 170/);
  });

  it("GLM 用量 ≥90% 标 warning，接口错误 code 透出 msg", () => {
    const rows = parseGlmQuota({
      code: 200,
      data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 95, nextResetTime: 1788708538082 }] },
    });
    assert.ok(rows.some((row) => row.tone === "warning"));

    const err = parseGlmQuota({ code: 1001, msg: "Header中未收到Authorization参数" });
    assert.ok(err.some((row) => row.label === "状态" && row.value.includes("1001")));
    assert.ok(err.some((row) => row.label === "状态" && row.value.includes("Authorization")));
  });

  it("GLM quota 字段缺失降级为 unknown", () => {
    const rows = parseGlmQuota({ code: 200, data: {} });
    assert.ok(rows.every((row) => row.value === "unknown"));
  });

  it("Codex wham usage 样例解析双窗口和 credits", () => {
    const rows = parseCodexQuota({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 12, reset_at: 1770000000, limit_window_seconds: 10800 },
        secondary_window: { used_percent: 4, reset_at: 1770100000, limit_window_seconds: 604800 },
      },
      credits: { has_credits: true, unlimited: false, balance: "7.50" },
    });
    const text = values(rows);
    assert.match(text, /订阅计划: pro/);
    assert.match(text, /5 小时窗口已使用: 12%/);
    assert.match(text, /每周窗口已使用: 4%/);
    assert.match(text, /每周窗口窗口: 7 天/);
    assert.match(text, /每周窗口重置时间: \d{4}-\d{2}-\d{2}/);
    assert.match(text, /额度余额: 7\.50/);
    assert.match(text, /无限额度: false/);
  });

  it("Codex 私有响应缺字段时不抛异常", () => {
    const rows = parseCodexQuota({ plan_type: "pro", rate_limit: {}, credits: {} });
    assert.ok(rows.some((row) => row.label === "5 小时窗口已使用" && row.value === "unknown"));
    assert.ok(rows.some((row) => row.label === "额度余额" && row.value === "unknown"));
  });
});

describe("hpl-quota-usage provider 请求", () => {
  it("DeepSeek fetch 使用公开 endpoint、Bearer 凭证和超时信号", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ is_available: true, balance_infos: [] }),
      } as Response;
    }) as typeof fetch;
    try {
      await Effect.runPromise(fetchDeepSeekQuota({ apiKey: "test-key" }));
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(requestUrl, DEEPSEEK_BALANCE_ENDPOINT);
    assert.equal((requestInit?.headers as Record<string, string>).Authorization, "Bearer test-key");
    assert.ok(requestInit?.signal, "请求带 AbortSignal.timeout 信号");
    assert.equal(GLM_QUOTA_ENDPOINT, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    assert.equal(CODEX_USAGE_ENDPOINT, "https://chatgpt.com/backend-api/wham/usage");
  });
});
