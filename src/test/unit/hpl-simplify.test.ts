/**
 * hpl-simplify 单元测试 — 审查 prompt 构建与 diff 范围解析（#56）
 *
 * 覆盖 audit.ts 的纯函数部分：范围解析、审查 prompt 构建。
 * 命令 handler 的交互流程（ui.select / sendUserMessage）在
 * integration 测试中用 mock pi 验证。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseScope,
  buildAuditPrompt,
  buildApplyPrompt,
  SIMPLIFY_RULES_TEXT,
} from "../../extensions/hpl-simplify/audit.js";

describe("parseScope()", () => {
  it("正常路径: 空参数 → 默认最近一次 commit（HEAD）", () => {
    assert.deepEqual(parseScope(""), { kind: "commit", ref: "HEAD" });
  });

  it("正常路径: --staged → 暂存区", () => {
    assert.deepEqual(parseScope("--staged"), { kind: "staged" });
  });

  it("正常路径: commit 范围 A..B", () => {
    assert.deepEqual(parseScope("main..HEAD"), { kind: "range", from: "main", to: "HEAD" });
  });

  it("边界条件: 未知参数 → null（由 handler 报错提示）", () => {
    assert.equal(parseScope("--bogus"), null);
  });
});

describe("buildAuditPrompt()", () => {
  it("正常路径: prompt 含只读禁令、规则清单全文、范围描述", () => {
    const prompt = buildAuditPrompt({ kind: "staged" });
    assert.ok(prompt.includes("DO NOT"), "含只读禁令");
    assert.ok(prompt.includes(SIMPLIFY_RULES_TEXT.slice(0, 40)), "内嵌规则清单");
    assert.ok(prompt.includes("git diff --cached"), "staged 范围的 diff 命令");
    assert.ok(prompt.includes("numbered"), "报告要求编号列表");
  });

  it("正常路径: commit 范围用 git show", () => {
    const prompt = buildAuditPrompt({ kind: "commit", ref: "HEAD" });
    assert.ok(prompt.includes("git show"), "commit 范围用 git show");
  });
});

describe("buildApplyPrompt()", () => {
  it("正常路径: 含编号选择与执行约束", () => {
    const prompt = buildApplyPrompt([2, 4]);
    assert.ok(prompt.includes("2"), "含编号");
    assert.ok(prompt.includes("4"), "含编号");
    assert.ok(prompt.includes("test"), "要求跑相关测试");
  });
});

describe("SIMPLIFY_RULES_TEXT", () => {
  it("与 #54 code_style 白名单同源：三类注释 + fail fast 红线", () => {
    assert.ok(SIMPLIFY_RULES_TEXT.includes("Functionality summary"), "注释一类");
    assert.ok(SIMPLIFY_RULES_TEXT.includes("Design decision"), "注释二类");
    assert.ok(SIMPLIFY_RULES_TEXT.includes("bug fix"), "注释三类");
    assert.ok(SIMPLIFY_RULES_TEXT.includes("NEVER suggest deleting"), "红线段落存在");
    assert.ok(SIMPLIFY_RULES_TEXT.includes("external APIs"), "外部输入校验红线");
  });
});
