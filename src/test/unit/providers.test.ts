import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeAuthFile,
  writeSettingsFile,
  writeSkeletonFiles,
  semverGte,
  COMMON,
  ALL_PROVIDERS,
} from "../../providers.js";

describe("providers", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hapilon-providers-test-"));
  });

  after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  describe("writeAuthFile()", () => {
    it("写入正确的 auth.json 格式", () => {
      const entries = {
        deepseek: "sk-ds-xxx",
        openai: "sk-oa-yyy",
      };
      writeAuthFile(tmpDir, entries);

      const content = readFileSync(join(tmpDir, "auth.json"), "utf8");
      const parsed = JSON.parse(content);

      assert.deepStrictEqual(parsed.deepseek, { type: "api_key", key: "sk-ds-xxx" });
      assert.deepStrictEqual(parsed.openai, { type: "api_key", key: "sk-oa-yyy" });
    });

    it("空对象时写入空 auth.json", () => {
      writeAuthFile(tmpDir, {});

      const content = readFileSync(join(tmpDir, "auth.json"), "utf8");
      const parsed = JSON.parse(content);

      assert.deepStrictEqual(parsed, {});
    });

    it("文件权限为 0600", () => {
      writeAuthFile(tmpDir, { test: "key" });

      const stat = statSync(join(tmpDir, "auth.json"));
      const mode = stat.mode & 0o777;
      assert.strictEqual(mode, 0o600, `auth.json 权限应为 0600，实际 ${mode.toString(8)}`);
    });

    it("文件以换行符结尾", () => {
      writeAuthFile(tmpDir, { key: "value" });

      const content = readFileSync(join(tmpDir, "auth.json"), "utf8");
      assert.ok(content.endsWith("\n"), "auth.json 应以换行符结尾");
    });

    it("覆盖已存在的文件", () => {
      writeAuthFile(tmpDir, { first: "key1" });
      writeAuthFile(tmpDir, { second: "key2" });

      const content = readFileSync(join(tmpDir, "auth.json"), "utf8");
      const parsed = JSON.parse(content);

      assert.strictEqual(parsed.first, undefined, "旧条目应被覆盖");
      assert.deepStrictEqual(parsed.second, { type: "api_key", key: "key2" });
    });
  });

  describe("writeSettingsFile()", () => {
    it("写入正确的 settings.json 格式", () => {
      const config = { theme: "dark", timeout: 30 };
      writeSettingsFile(tmpDir, config);

      const content = readFileSync(join(tmpDir, "settings.json"), "utf8");
      const parsed = JSON.parse(content);

      assert.deepStrictEqual(parsed, config);
    });

    it("空对象时写入空 settings.json", () => {
      writeSettingsFile(tmpDir, {});

      const content = readFileSync(join(tmpDir, "settings.json"), "utf8");
      const parsed = JSON.parse(content);

      assert.deepStrictEqual(parsed, {});
    });

    it("文件以换行符结尾", () => {
      writeSettingsFile(tmpDir, { key: "value" });

      const content = readFileSync(join(tmpDir, "settings.json"), "utf8");
      assert.ok(content.endsWith("\n"), "settings.json 应以换行符结尾");
    });
  });

  describe("writeSkeletonFiles()", () => {
    it("创建所有骨架文件", () => {
      writeSkeletonFiles(tmpDir);

      assert.ok(existsSync(join(tmpDir, "auth.json")), "应创建 auth.json");
      assert.ok(existsSync(join(tmpDir, "settings.json")), "应创建 settings.json");
      assert.ok(existsSync(join(tmpDir, "models.json")), "应创建 models.json");
    });

    it("不覆盖已存在的文件", () => {
      const customAuth = '{"custom": true}\n';
      writeFileSync(join(tmpDir, "auth.json"), customAuth);

      writeSkeletonFiles(tmpDir);

      const content = readFileSync(join(tmpDir, "auth.json"), "utf8");
      assert.strictEqual(content, customAuth, "已存在的文件不应被覆盖");
    });

    it("auth.json 权限为 0600", () => {
      try { rmSync(join(tmpDir, "auth.json")); } catch { /* ignore */ }

      writeSkeletonFiles(tmpDir);

      const stat = statSync(join(tmpDir, "auth.json"));
      const mode = stat.mode & 0o777;
      assert.strictEqual(mode, 0o600, `骨架 auth.json 权限应为 0600`);
    });

    it("models.json 包含正确的引导注释", () => {
      writeSkeletonFiles(tmpDir);

      const content = readFileSync(join(tmpDir, "models.json"), "utf8");
      assert.ok(content.includes("_guide"), "models.json 应包含 _guide 字段");
      assert.ok(content.includes("Custom providers only"), "应包含引导说明");
    });
  });

  describe("semverGte()", () => {
    it("v1 > v2 返回 true", () => {
      assert.strictEqual(semverGte("v22.19.0", "v22.18.0"), true);
      assert.strictEqual(semverGte("v23.0.0", "v22.19.0"), true);
    });

    it("v1 = v2 返回 true", () => {
      assert.strictEqual(semverGte("v22.19.0", "v22.19.0"), true);
    });

    it("v1 < v2 返回 false", () => {
      assert.strictEqual(semverGte("v22.18.0", "v22.19.0"), false);
      assert.strictEqual(semverGte("v21.0.0", "v22.0.0"), false);
    });

    it("不带 v 前缀也能比较", () => {
      assert.strictEqual(semverGte("22.19.0", "22.18.0"), true);
      assert.strictEqual(semverGte("22.19.0", "22.19.0"), true);
    });

    it("处理不同长度的版本号", () => {
      assert.strictEqual(semverGte("v22.19", "v22.19.0"), true);
      assert.strictEqual(semverGte("v22.19.0", "v22.19"), true);
    });
  });

  describe("Provider 定义", () => {
    it("COMMON 是 ALL_PROVIDERS 的子集", () => {
      const allIds = new Set(ALL_PROVIDERS.map((p) => p.id));
      for (const p of COMMON) {
        assert.ok(allIds.has(p.id), `${p.id} 应在 ALL_PROVIDERS 中`);
      }
    });

    it("所有 provider ID 唯一", () => {
      const ids = ALL_PROVIDERS.map((p) => p.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, ids.length, "provider ID 应唯一");
    });

    it("所有 provider 有名称", () => {
      for (const p of ALL_PROVIDERS) {
        assert.ok(p.name && p.name.length > 0, `${p.id} 应有名称`);
      }
    });
  });
});
