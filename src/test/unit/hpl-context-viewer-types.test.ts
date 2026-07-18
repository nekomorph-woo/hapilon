/**
 * types.ts 单元测试 — ContextSnapshot 类型 + token 估算工具
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateTotalTokens,
  safePercent,
} from "../../extensions/hpl-context-viewer/types.js";

describe("estimateTokens", () => {
  it("正常路径: 英文文本 chars/4", () => {
    assert.equal(estimateTokens("hello world"), 3); // 11 chars → ceil(11/4)=3
  });

  it("正常路径: 多字节中文 (chars/4 保守高估)", () => {
    assert.equal(estimateTokens("你好世界"), 1); // 4 chars → ceil(4/4)=1
  });

  it("边界条件: 空字符串", () => {
    assert.equal(estimateTokens(""), 0); // ceil(0/4)=0
  });

  it("边界条件: 小于 4 字符", () => {
    assert.equal(estimateTokens("ab"), 1); // ceil(2/4)=1
  });

  it("正常路径: 边界对齐 (4 chars)", () => {
    assert.equal(estimateTokens("abcd"), 1); // ceil(4/4)=1
  });

  it("正常路径: 边界+1 (5 chars)", () => {
    assert.equal(estimateTokens("abcde"), 2); // ceil(5/4)=2
  });
});

describe("estimateTotalTokens", () => {
  it("正常路径: 多段求和", () => {
    assert.equal(estimateTotalTokens("hello", "world"), 4); // ceil(5/4)=2 + ceil(5/4)=2 = 4
  });

  it("边界条件: 空数组", () => {
    assert.equal(estimateTotalTokens(), 0);
  });

  it("边界条件: 单个空字符串", () => {
    assert.equal(estimateTotalTokens(""), 0);
  });

  it("正常路径: 混合中英文", () => {
    assert.equal(estimateTotalTokens("hello", "你好世界"), 3); // ceil(5/4)=2 + ceil(4/4)=1 = 3
  });
});

describe("safePercent", () => {
  const ctxWin = 128000;

  it("正常路径: 计算百分比", () => {
    assert.equal(safePercent(12800, ctxWin), 10); // 10%
  });

  it("正常路径: 小数百分比 (1 decimal)", () => {
    assert.equal(safePercent(1664, ctxWin), 1.3); // 1.3%
  });

  it("边界条件: tokens 为 null → null", () => {
    assert.equal(safePercent(null, ctxWin), null);
  });

  it("边界条件: contextWindow 为 0 → null", () => {
    assert.equal(safePercent(1000, 0), null);
  });

  it("边界条件: tokens 为 0 → 0%", () => {
    assert.equal(safePercent(0, ctxWin), 0);
  });

  it("边界条件: 100% 满", () => {
    assert.equal(safePercent(ctxWin, ctxWin), 100);
  });
});
