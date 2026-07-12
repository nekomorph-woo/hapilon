import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelsTable, question, yesno } from "../../config.js";
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

const SAMPLE_OUTPUT = `provider  model              context  max-out  thinking  images
deepseek  deepseek-chat      128K     32K      no        no
deepseek  deepseek-reasoner  128K     32K      yes       no
openai    gpt-4o             128K     16K      no        yes
openai    gpt-4o-mini        128K     16K      no        yes
anthropic  claude-sonnet-4-20250514  200K  32K  yes  yes`;

describe("pi-listing (parseModelsTable)", () => {
  describe("parseModelsTable()", () => {
    it("标准 6 列表格 → 正确解析所有字段", () => {
      const result = parseModelsTable(SAMPLE_OUTPUT);
      assert.strictEqual(result.length, 5, "应解析 5 个模型");

      assert.deepStrictEqual(result[0], {
        provider: "deepseek",
        model: "deepseek-chat",
        context: "128K",
      });
      assert.deepStrictEqual(result[4], {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        context: "200K",
      });
    });

    it("仅 header 无数据 → 返回 []", () => {
      const result = parseModelsTable(
        "provider  model  context  max-out  thinking  images",
      );
      assert.strictEqual(result.length, 0);
    });

    it("指定 targetProvider → 仅返回匹配的行", () => {
      const result = parseModelsTable(SAMPLE_OUTPUT, "deepseek");
      assert.strictEqual(result.length, 2, "deepseek 应有 2 个模型");
      for (const r of result) {
        assert.strictEqual(r.provider, "deepseek");
      }
    });

    it("空字符串 → 返回 []", () => {
      const result = parseModelsTable("");
      assert.strictEqual(result.length, 0);
    });

    it("仅有空白行 → 返回 []", () => {
      const result = parseModelsTable("\n  \n");
      assert.strictEqual(result.length, 0);
    });

    it("某行列数不足（仅 1 列）→ 跳过该行", () => {
      const result = parseModelsTable(
        "provider  model\ndeepseek",
      );
      assert.strictEqual(result.length, 0, "单列行应被跳过");
    });

    it("多 provider 混合 → 正确过滤", () => {
      const result = parseModelsTable(SAMPLE_OUTPUT, "openai");
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].provider, "openai");
      assert.strictEqual(result[1].provider, "openai");
    });
  });

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
});
