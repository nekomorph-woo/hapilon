import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHapilonConfig,
  writeHapilonConfig,
  hasFlag,
  injectDefaultArgs,
} from "../../config-io.js";

describe("config-io", () => {
  let tmpBase: string;
  const ORIGINAL_ENV = process.env.HAPILON_HOME;

  before(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "hapilon-config-io-test-"));
    process.env.HAPILON_HOME = tmpBase;
  });

  after(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.HAPILON_HOME = ORIGINAL_ENV;
    } else {
      delete process.env.HAPILON_HOME;
    }
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  describe("readHapilonConfig()", () => {
    it("文件不存在时返回 {}", () => {
      const config = readHapilonConfig();
      assert.deepStrictEqual(config, {});
    });

    it("空 JSON 文件返回 {}", () => {
      writeFileSync(join(tmpBase, "config.json"), "{}\n");
      const config = readHapilonConfig();
      assert.deepStrictEqual(config, {});
    });

    it("正确解析 defaultProvider 和 defaultModel", () => {
      writeFileSync(
        join(tmpBase, "config.json"),
        JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" }) + "\n",
      );
      const config = readHapilonConfig();
      assert.deepStrictEqual(config, {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      });
    });

    it("仅有 defaultProvider 时正确解析", () => {
      writeFileSync(
        join(tmpBase, "config.json"),
        JSON.stringify({ defaultProvider: "openai" }) + "\n",
      );
      const config = readHapilonConfig();
      assert.deepStrictEqual(config, { defaultProvider: "openai" });
    });

    it("JSON 语法错误时返回 {} + 打印警告（含错误详情）", () => {
      writeFileSync(join(tmpBase, "config.json"), "not valid json\n");

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      try {
        const config = readHapilonConfig();
        assert.deepStrictEqual(config, {});
        assert.ok(warnings.length > 0, "应打印警告");
        assert.ok(
          warnings.join(" ").includes("SyntaxError") ||
          warnings.join(" ").includes("Unexpected"),
          "警告应包含错误详情",
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    it("defaultProvider 不是字符串 → warn + 忽略", () => {
      writeFileSync(
        join(tmpBase, "config.json"),
        JSON.stringify({ defaultProvider: 42, defaultModel: "valid" }) + "\n",
      );

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      try {
        const config = readHapilonConfig();
        assert.strictEqual(config.defaultProvider, undefined, "非字符串 defaultProvider 应被忽略");
        assert.strictEqual(config.defaultModel, "valid", "合法 defaultModel 应保留");
        assert.ok(warnings.length > 0, "应打印警告");
      } finally {
        console.warn = originalWarn;
      }
    });

    it("非对象 JSON（数组）时返回 {} + 打印警告", () => {
      writeFileSync(join(tmpBase, "config.json"), "[1,2,3]\n");

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      try {
        const config = readHapilonConfig();
        assert.deepStrictEqual(config, {});
        assert.ok(warnings.length > 0, "应打印警告");
      } finally {
        console.warn = originalWarn;
      }
    });

    it("正确解析 safetyNoticeShown 为 true", () => {
      writeFileSync(
        join(tmpBase, "config.json"),
        JSON.stringify({ safetyNoticeShown: true, defaultProvider: "test" }) + "\n",
      );
      const config = readHapilonConfig();
      assert.strictEqual(config.safetyNoticeShown, true);
      assert.strictEqual(config.defaultProvider, "test", "其他字段不受影响");
    });

    it("safetyNoticeShown 不是布尔值 → warn + 忽略", () => {
      writeFileSync(
        join(tmpBase, "config.json"),
        JSON.stringify({ safetyNoticeShown: "yes" }) + "\n",
      );

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      try {
        const config = readHapilonConfig();
        assert.strictEqual(config.safetyNoticeShown, undefined, "非布尔 safetyNoticeShown 应被忽略");
        assert.ok(warnings.length > 0, "应打印警告");
      } finally {
        console.warn = originalWarn;
      }
    });

    it("正确解析 safetyNoticeShown 为 false", () => {
      writeFileSync(
        join(tmpBase, "config.json"),
        JSON.stringify({ safetyNoticeShown: false }) + "\n",
      );
      const config = readHapilonConfig();
      assert.strictEqual(config.safetyNoticeShown, false);
    });

    it("safetyNoticeShown 为 null → warn + 忽略", () => {
      writeFileSync(
        join(tmpBase, "config.json"),
        JSON.stringify({ safetyNoticeShown: null }) + "\n",
      );

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      try {
        const config = readHapilonConfig();
        assert.strictEqual(config.safetyNoticeShown, undefined, "null safetyNoticeShown 应被忽略");
        assert.ok(warnings.length > 0, "应打印警告");
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("writeHapilonConfig()", () => {
    it("写入后可 read 回相同内容", () => {
      writeHapilonConfig({
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      });

      const config = readHapilonConfig();
      assert.deepStrictEqual(config, {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      });
    });

    it("覆盖已有 config.json", () => {
      writeHapilonConfig({ defaultProvider: "openai" });
      writeHapilonConfig({ defaultProvider: "deepseek" });

      const config = readHapilonConfig();
      assert.deepStrictEqual(config, { defaultProvider: "deepseek" });
    });

    it("写入后文件以换行符结尾", () => {
      writeHapilonConfig({ defaultProvider: "test" });

      const content = readFileSync(join(tmpBase, "config.json"), "utf8");
      assert.ok(content.endsWith("\n"), "config.json 应以换行符结尾");
    });

    it("写入空对象产生 {}", () => {
      writeHapilonConfig({});

      const content = readFileSync(join(tmpBase, "config.json"), "utf8");
      const parsed = JSON.parse(content);
      assert.deepStrictEqual(parsed, {});
    });

    it("写入 safetyNoticeShown 后可 read 回相同内容", () => {
      writeHapilonConfig({ safetyNoticeShown: true, defaultProvider: "test" });

      const config = readHapilonConfig();
      assert.strictEqual(config.safetyNoticeShown, true);
      assert.strictEqual(config.defaultProvider, "test", "其他字段不受影响");
    });
  });

  describe("hasFlag()", () => {
    it("--provider 在 args 中返回 true", () => {
      assert.strictEqual(hasFlag(["--provider", "deepseek"], "--provider"), true);
    });

    it("--provider=xxx 格式返回 true", () => {
      assert.strictEqual(hasFlag(["--provider=deepseek"], "--provider"), true);
    });

    it("--model 不在 args 中返回 false", () => {
      assert.strictEqual(hasFlag(["--provider", "deepseek"], "--model"), false);
    });

    it("空 args 返回 false", () => {
      assert.strictEqual(hasFlag([], "--provider"), false);
    });

    it("包含 -- 分隔符后的 flag 仍返回 true", () => {
      assert.strictEqual(hasFlag(["--", "--model", "gpt-4o"], "--model"), true);
    });
  });

  describe("injectDefaultArgs()", () => {
    it("有两者默认且用户均未传 → 注入两者", () => {
      const result = injectDefaultArgs(["hello"], {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      });
      assert.deepStrictEqual(result, [
        "--model", "deepseek-chat",
        "--provider", "deepseek",
        "hello",
      ]);
    });

    it("用户传了 --provider → 不注入 provider，但注入 model", () => {
      const result = injectDefaultArgs(["--provider", "openai", "hello"], {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      });
      assert.deepStrictEqual(result, [
        "--model", "deepseek-chat",
        "--provider", "openai",
        "hello",
      ]);
    });

    it("用户传了 --model → 不注入 model，但注入 provider", () => {
      const result = injectDefaultArgs(["--model", "gpt-4o", "hello"], {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      });
      assert.deepStrictEqual(result, [
        "--provider", "deepseek",
        "--model", "gpt-4o",
        "hello",
      ]);
    });

    it("用户传了两者 → 都不注入", () => {
      const result = injectDefaultArgs(
        ["--provider", "openai", "--model", "gpt-4o", "hello"],
        { defaultProvider: "deepseek", defaultModel: "deepseek-chat" },
      );
      assert.deepStrictEqual(result, [
        "--provider", "openai",
        "--model", "gpt-4o",
        "hello",
      ]);
    });

    it("config 为空 → 不修改 args", () => {
      const result = injectDefaultArgs(["hello", "world"], {});
      assert.deepStrictEqual(result, ["hello", "world"]);
    });

    it("用户传 --provider=xxx 格式 → 不注入 provider", () => {
      const result = injectDefaultArgs(["--provider=openai", "hello"], {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      });
      assert.deepStrictEqual(result, [
        "--model", "deepseek-chat",
        "--provider=openai",
        "hello",
      ]);
    });
  });
});
