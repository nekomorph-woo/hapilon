import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHapilonConfig,
  writeHapilonConfig,
  hasFlag,
  stripHapilonFlags,
  migrateLegacyDefaultsEffect,
} from "../../config/config-io.js";
import { Effect } from "effect";

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

  describe("stripHapilonFlags()（#38）", () => {
    it("剥离裸 --no-safety", () => {
      assert.deepStrictEqual(
        stripHapilonFlags(["--no-safety", "-p", "hello"]),
        ["-p", "hello"],
      );
    });

    it("剥离 --sandbox=value 形式", () => {
      assert.deepStrictEqual(
        stripHapilonFlags(["--sandbox=full", "-p", "hi"]),
        ["-p", "hi"],
      );
    });

    it("两个自有 flag 都剥离，其余原样保留顺序", () => {
      assert.deepStrictEqual(
        stripHapilonFlags(["--model", "gpt-4o", "--sandbox", "--no-safety", "--mode", "json"]),
        ["--model", "gpt-4o", "--mode", "json"],
      );
    });

    it("无自有 flag 时原样返回", () => {
      const args = ["-p", "hello", "--provider", "openai"];
      assert.deepStrictEqual(stripHapilonFlags(args), args);
    });

    it("不误伤相似但不同的 flag（--no-safety-gate 不是自有 flag）", () => {
      assert.deepStrictEqual(
        stripHapilonFlags(["--no-safety-gate"]),
        ["--no-safety-gate"],
      );
    });
  });

  describe("migrateLegacyDefaultsEffect()", () => {
    it("迁移旧默认值、保留原生 settings 其他字段并清理旧 config 字段", () => {
      writeFileSync(
        join(tmpBase, "config.json"),
        JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat", safetyNoticeShown: true }) + "\n",
      );
      mkdirSync(join(tmpBase, "agent"), { recursive: true });
      writeFileSync(join(tmpBase, "agent", "settings.json"), JSON.stringify({ theme: "dark" }) + "\n");

      const migrated = Effect.runSync(migrateLegacyDefaultsEffect);

      assert.equal(migrated, true);
      assert.deepStrictEqual(JSON.parse(readFileSync(join(tmpBase, "agent", "settings.json"), "utf8")), {
        theme: "dark",
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
      });
      assert.deepStrictEqual(JSON.parse(readFileSync(join(tmpBase, "config.json"), "utf8")), {
        safetyNoticeShown: true,
      });
    });

    it("不覆盖已有 Pi 原生默认值，迁移后再次执行幂等", () => {
      writeFileSync(
        join(tmpBase, "config.json"),
        JSON.stringify({ defaultProvider: "legacy-provider", defaultModel: "legacy-model" }) + "\n",
      );
      mkdirSync(join(tmpBase, "agent"), { recursive: true });
      writeFileSync(
        join(tmpBase, "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "native-provider", defaultModel: "native-model", theme: "light" }) + "\n",
      );

      assert.equal(Effect.runSync(migrateLegacyDefaultsEffect), true);
      assert.equal(Effect.runSync(migrateLegacyDefaultsEffect), false);
      assert.deepStrictEqual(JSON.parse(readFileSync(join(tmpBase, "agent", "settings.json"), "utf8")), {
        defaultProvider: "native-provider",
        defaultModel: "native-model",
        theme: "light",
      });
      assert.deepStrictEqual(JSON.parse(readFileSync(join(tmpBase, "config.json"), "utf8")), {});
    });
  });
});
