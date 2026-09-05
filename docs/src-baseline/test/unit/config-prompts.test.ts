/**
 * config/prompts.ts 单元测试 — question / yesno（从 pi-listing.test.ts 迁出）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { question, yesno } from "../../config/prompts.js";
import { createInterface } from "node:readline";

// Helper: create a mock readline with controllable asyncIterator
function mockReadline(responses: string[]) {
  let idx = 0;
  const asyncIter = {
    [Symbol.asyncIterator]() { return this; },
    next: async () => {
      if (idx >= responses.length) return { value: "", done: true };
      return { value: responses[idx++], done: false };
    },
  };
  return {
    [Symbol.asyncIterator]() { return asyncIter[Symbol.asyncIterator](); },
    close() {},
  } as ReturnType<typeof createInterface>;
}

describe("question()", () => {
  it("正常返回用户输入", async () => {
    const rl = mockReadline(["hello"]);
    const result = await question(rl, "> ");
    assert.strictEqual(result, "hello");
  });

  it("EOF (done=true) 返回空字符串", async () => {
    const rl = mockReadline([]);
    const result = await question(rl, "> ");
    assert.strictEqual(result, "");
  });
});

describe("yesno()", () => {
  it("y 返回 true", async () => {
    const rl = mockReadline(["y"]);
    assert.strictEqual(await yesno(rl, "确认？"), true);
  });

  it("yes 返回 true", async () => {
    const rl = mockReadline(["yes"]);
    assert.strictEqual(await yesno(rl, "确认？"), true);
  });

  it("Y 大写返回 true", async () => {
    const rl = mockReadline(["Y"]);
    assert.strictEqual(await yesno(rl, "确认？"), true);
  });

  it("n 返回 false", async () => {
    const rl = mockReadline(["n"]);
    assert.strictEqual(await yesno(rl, "确认？"), false);
  });

  it("空行返回 false", async () => {
    const rl = mockReadline([""]);
    assert.strictEqual(await yesno(rl, "确认？"), false);
  });

  it("random text 返回 false", async () => {
    const rl = mockReadline(["maybe"]);
    assert.strictEqual(await yesno(rl, "确认？"), false);
  });
});
