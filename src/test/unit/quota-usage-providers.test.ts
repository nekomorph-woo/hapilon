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

  it("GLM 中国区 quota 样例解析计划、额度、使用量和续期", () => {
    const rows = parseGlmQuota({
      code: 200,
      msg: "操作成功",
      data: {
        planName: "Coding Plan Pro",
        totalQuota: 1000000,
        usedQuota: 250000,
        remainingQuota: 750000,
        resetTime: "2026-10-01T00:00:00Z",
      },
    });
    const text = values(rows);
    assert.match(text, /计划: Coding Plan Pro/);
    assert.match(text, /总额度: 1000000/);
    assert.match(text, /剩余额度: 750000/);
    assert.match(text, /续期时间: 2026-10-01/);
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
    assert.match(text, /计划: pro/);
    assert.match(text, /主窗口已使用: 12%/);
    assert.match(text, /次窗口窗口秒数: 604800/);
    assert.match(text, /额度余额: 7\.50/);
    assert.match(text, /无限额度: false/);
  });

  it("Codex 私有响应缺字段时不抛异常", () => {
    const rows = parseCodexQuota({ plan_type: "pro", rate_limit: {}, credits: {} });
    assert.ok(rows.some((row) => row.label === "主窗口已使用" && row.value === "unknown"));
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
    assert.notEqual(GLM_QUOTA_ENDPOINT, "https://api.z.ai/api/monitor/usage/quota");
    assert.equal(CODEX_USAGE_ENDPOINT, "https://chatgpt.com/backend-api/wham/usage");
  });
});
