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
