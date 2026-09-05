/**
 * collector.ts 单元测试 — 上下文数据收集
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  collectContextSnapshot,
  type CollectorInput,
} from "../../extensions/hpl-context-viewer/collector.js";
import {
  clearLastMeta,
  setLastMeta,
} from "../../extensions/hpl-system-prompt/metadata.js";

describe("collectContextSnapshot", () => {
  beforeEach(() => {
    clearLastMeta();
  });

  const baseInput: CollectorInput = {
    contextUsage: { tokens: 20000, contextWindow: 128000, percent: 15.6 },
    systemPromptOptions: {
      toolSnippets: { read: "Read a file", bash: "Run a command" },
      selectedTools: ["read", "bash"],
    },
    model: { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 128000 },
    sessionStats: {
      userMessages: 5,
      assistantMessages: 4,
      totalMessages: 19,
      tokens: { input: 5000, output: 3000, total: 8000 },
    },
  };

  it("正常路径: 返回 ContextSnapshot 含所有 category", () => {
    setLastMeta({
      assembledAt: Date.now(),
      cwd: "/test",
      sections: {
        roleAndIdentity: 200,
        piDocumentation: 300,
        tools: 0,
        guidelines: 400,
        codeStyle: 250,
        hapilonInstructions: 0,
        hapilonRules: 0,
        contextFiles: 0,
        skills: 0,
        customToolsNote: 100,
        additionalData: 0,
        environment: 100,
      },
    });

    const snapshot = collectContextSnapshot(baseInput);
    assert.ok(snapshot.categories.length >= 5, "至少 5 个 category");
    assert.equal(snapshot.model.id, "deepseek-v4");
    assert.equal(snapshot.usage.contextWindow, 128000);
    assert.equal(snapshot.usage.percent, 15.6);
  });

  it("正常路径: System tools 包含 tool items", () => {
    const snapshot = collectContextSnapshot(baseInput);
    const toolsCat = snapshot.categories.find((c) => c.label === "System tools");
    assert.ok(toolsCat, "存在 System tools category");
    assert.ok(toolsCat!.tokens! > 0);
    assert.equal(toolsCat!.items?.length, 2);
    assert.equal(toolsCat!.items?.[0].name, "read");
  });

  it("正常路径: Skills 包含 skill items", () => {
    const input: CollectorInput = {
      ...baseInput,
      systemPromptOptions: {
        ...baseInput.systemPromptOptions,
        skills: [
          { name: "my-skill", description: "A test skill" },
          { name: "other-skill", description: "Another skill" },
        ],
      },
    };
    const snapshot = collectContextSnapshot(input);
    const skillsCat = snapshot.categories.find((c) => c.label === "Skills");
    assert.ok(skillsCat, "存在 Skills category");
    assert.ok(skillsCat!.tokens! > 0);
    assert.equal(skillsCat!.items?.length, 2);
  });

  it("正常路径: Context files 被包含", () => {
    const input: CollectorInput = {
      ...baseInput,
      systemPromptOptions: {
        ...baseInput.systemPromptOptions,
        contextFiles: [{ path: "/test/AGENTS.md", content: "# Agents file content here" }],
      },
    };
    const snapshot = collectContextSnapshot(input);
    const cfCat = snapshot.categories.find((c) => c.label === "Context files");
    assert.ok(cfCat, "存在 Context files category");
    assert.ok(cfCat!.tokens! > 0);
  });

  it("边界条件: 空 skills 列表 → tokens 为 null", () => {
    const snapshot = collectContextSnapshot(baseInput);
    const skillsCat = snapshot.categories.find((c) => c.label === "Skills");
    assert.ok(skillsCat);
    assert.equal(skillsCat!.tokens, null);
    assert.equal(skillsCat!.items, undefined);
  });

  it("边界条件: 空 tools → tokens 为 null", () => {
    const input: CollectorInput = {
      ...baseInput,
      systemPromptOptions: {
        toolSnippets: {},
        selectedTools: [],
      },
    };
    const snapshot = collectContextSnapshot(input);
    const toolsCat = snapshot.categories.find((c) => c.label === "System tools");
    assert.ok(toolsCat);
    assert.equal(toolsCat!.tokens, null);
  });

  it("边界条件: contextUsage 为 undefined → fallback model.contextWindow", () => {
    const input: CollectorInput = {
      ...baseInput,
      contextUsage: undefined,
    };
    const snapshot = collectContextSnapshot(input);
    assert.equal(snapshot.usage.contextWindow, 128000);
    assert.equal(snapshot.usage.tokens, null);
    assert.equal(snapshot.usage.percent, null);
  });

  it("边界条件: model 为 undefined → fallback id/name", () => {
    const input: CollectorInput = {
      contextUsage: baseInput.contextUsage,
      systemPromptOptions: baseInput.systemPromptOptions,
    };
    const snapshot = collectContextSnapshot(input);
    assert.equal(snapshot.model.id, "unknown");
    assert.equal(snapshot.model.contextWindow, 128000);
  });

  it("边界条件: 无 metadata 时 System prompt 不出现", () => {
    const snapshot = collectContextSnapshot(baseInput);
    const spCat = snapshot.categories.find((c) => c.label === "System prompt");
    assert.equal(spCat, undefined, "无 metadata → 无 System prompt category");
  });

  it("正常路径: Free space 始终存在", () => {
    const snapshot = collectContextSnapshot(baseInput);
    const freeCat = snapshot.categories.find((c) => c.label === "Free space");
    assert.ok(freeCat);
    assert.ok(freeCat!.tokens! > 0);
  });

  it("边界条件: contextWindow 为 0 → Free space 为 0", () => {
    const input: CollectorInput = {
      contextUsage: { tokens: null, contextWindow: 0, percent: null },
    };
    const snapshot = collectContextSnapshot(input);
    const freeCat = snapshot.categories.find((c) => c.label === "Free space");
    assert.ok(freeCat);
    assert.equal(freeCat!.tokens, 0);
  });
});

describe("token 统计不重复计算（issue #8）", () => {
  beforeEach(() => {
    clearLastMeta();
  });

  const baseInput: CollectorInput = {
    contextUsage: { tokens: 20000, contextWindow: 128000, percent: 15.6 },
    systemPromptOptions: {
      toolSnippets: { read: "Read a file", bash: "Run a command" },
      selectedTools: ["read", "bash"],
    },
    model: { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 128000 },
  };

  /** sections 故意让 tools/skills/contextFiles/rules 都有大长度，验证不被双倍计入 spTokens */
  function fullMeta() {
    return {
      assembledAt: Date.now(),
      cwd: "/test",
      sections: {
        roleAndIdentity: 100,
        piDocumentation: 100,
        tools: 4000,
        guidelines: 100,
        codeStyle: 250,
        hapilonInstructions: 800,
        hapilonRules: 2000,
        contextFiles: 3000,
        skills: 2000,
        customToolsNote: 0,
        additionalData: 0,
        environment: 100,
      },
    };
  }

  it("spTokens 只含纯 system 部分，不含 tools/skills/contextFiles/rules", () => {
    setLastMeta(fullMeta());
    const snapshot = collectContextSnapshot(baseInput);
    const spCat = snapshot.categories.find((c) => c.label === "System prompt");
    assert.ok(spCat, "存在 System prompt category");
    // roleAndIdentity 100 + piDocumentation 100 + guidelines 100 + codeStyle 250 + environment 100 = 650 chars → 163 tokens
    assert.equal(spCat!.tokens, 163);
  });

  it("Rules 分类独立展示 hapilonRules", () => {
    setLastMeta(fullMeta());
    const snapshot = collectContextSnapshot(baseInput);
    const rulesCat = snapshot.categories.find((c) => c.label === "Rules");
    assert.ok(rulesCat, "存在 Rules category");
    assert.equal(rulesCat!.tokens, Math.ceil(2000 / 4));
  });

  it("HAPILON.md 分类独立展示 hapilonInstructions", () => {
    setLastMeta(fullMeta());
    const snapshot = collectContextSnapshot(baseInput);
    const mdCat = snapshot.categories.find((c) => c.label === "HAPILON.md");
    assert.ok(mdCat, "存在 HAPILON.md category");
    assert.equal(mdCat!.tokens, Math.ceil(800 / 4));
  });

  it("虚高的 staticTotal 不再把 Messages 压成 null", () => {
    setLastMeta(fullMeta());
    const input: CollectorInput = {
      ...baseInput,
      contextUsage: { tokens: 3000, contextWindow: 128000, percent: 2.3 },
    };
    const snapshot = collectContextSnapshot(input);
    const msgCat = snapshot.categories.find((c) => c.label === "Messages");
    assert.ok(msgCat, "Messages category 存在（未被压成 null）");
    assert.ok(msgCat!.tokens! > 0);
  });

  it("分类 percent 加总不超过 100%（含 Free space）", () => {
    setLastMeta(fullMeta());
    const snapshot = collectContextSnapshot(baseInput);
    const total = snapshot.categories.reduce((s, c) => s + (c.percent ?? 0), 0);
    assert.ok(total <= 100.5, `percent 加总 ${total} 应 ≤ 100`);
  });
});
