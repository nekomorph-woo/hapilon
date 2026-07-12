import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hapilonHome, ensureHapilonDirs, configFilePath } from "../../hapilon-home.js";

describe("hapilon-home", () => {
  describe("hapilonHome()", () => {
    const ORIGINAL_ENV = process.env.HAPILON_HOME;

    before(() => {
      delete process.env.HAPILON_HOME;
    });

    after(() => {
      if (ORIGINAL_ENV !== undefined) {
        process.env.HAPILON_HOME = ORIGINAL_ENV;
      } else {
        delete process.env.HAPILON_HOME;
      }
    });

    it("默认返回 ~/.hapilon 路径", () => {
      const home = hapilonHome();
      assert.ok(home.endsWith(".hapilon"), `期望路径以 .hapilon 结尾，得到: ${home}`);
      assert.ok(!home.includes("undefined"), "路径不应包含 undefined");
    });

    it("HAPILON_HOME 环境变量可覆盖默认路径", () => {
      const customPath = "/custom/hapilon/path";
      process.env.HAPILON_HOME = customPath;
      assert.strictEqual(hapilonHome(), customPath);
    });

    it("空字符串 HAPILON_HOME 应被忽略（使用默认值）", () => {
      process.env.HAPILON_HOME = "";
      const home = hapilonHome();
      assert.ok(home.endsWith(".hapilon"), "空字符串时应回退到默认值");
    });
  });

  describe("ensureHapilonDirs()", () => {
    let tmpBase: string;
    const ORIGINAL_ENV = process.env.HAPILON_HOME;

    before(() => {
      tmpBase = mkdtempSync(join(tmpdir(), "hapilon-test-"));
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

    it("创建所有子目录", () => {
      const dirs = ensureHapilonDirs();

      assert.strictEqual(dirs.base, tmpBase);
      assert.strictEqual(dirs.agent, join(tmpBase, "agent"));
      assert.strictEqual(dirs.sessions, join(tmpBase, "sessions"));
      assert.strictEqual(dirs.logs, join(tmpBase, "logs"));
      assert.strictEqual(dirs.cache, join(tmpBase, "cache"));

      for (const p of Object.values(dirs)) {
        const stat = statSync(p);
        assert.ok(stat.isDirectory(), `${p} 应该是目录`);
      }
    });

    it("目录权限为 0700", () => {
      const dirs = ensureHapilonDirs();

      for (const p of Object.values(dirs)) {
        const stat = statSync(p);
        const mode = stat.mode & 0o777;
        assert.strictEqual(mode, 0o700, `${p} 权限应为 0700，实际 ${mode.toString(8)}`);
      }
    });

    it("重复调用不报错（幂等性）", () => {
      assert.doesNotThrow(() => {
        ensureHapilonDirs();
        ensureHapilonDirs();
      });
    });

    it("已存在目录时不覆盖", () => {
      const dirs1 = ensureHapilonDirs();
      const mtime1 = statSync(dirs1.agent).mtime;

      const dirs2 = ensureHapilonDirs();
      const mtime2 = statSync(dirs2.agent).mtime;

      assert.deepStrictEqual(dirs1, dirs2);
      assert.strictEqual(mtime1.getTime(), mtime2.getTime(), "已存在目录不应被修改");
    });

    it("无效路径时抛出有意义的错误", () => {
      process.env.HAPILON_HOME = "/root/invalid_path_that_cannot_be_created_12345";
      assert.throws(
        () => ensureHapilonDirs(),
        (err: Error) => {
          assert.ok(err.message.includes("Failed to create directory"), "错误信息应包含 'Failed to create directory'");
          assert.ok(err.message.includes("/root/invalid"), "错误信息应包含路径");
          return true;
        },
      );
    });
  });

  describe("configFilePath()", () => {
    const ORIGINAL_ENV = process.env.HAPILON_HOME;

    after(() => {
      if (ORIGINAL_ENV !== undefined) {
        process.env.HAPILON_HOME = ORIGINAL_ENV;
      } else {
        delete process.env.HAPILON_HOME;
      }
    });

    it("默认路径为 ~/.hapilon/config.json", () => {
      delete process.env.HAPILON_HOME;
      const path = configFilePath();
      assert.ok(path.endsWith(".hapilon/config.json"), `路径应以 .hapilon/config.json 结尾，得到: ${path}`);
      assert.ok(!path.includes("undefined"), "路径不应包含 undefined");
    });

    it("HAPILON_HOME 环境变量时路径随之变化", () => {
      process.env.HAPILON_HOME = "/custom/hapilon";
      const path = configFilePath();
      assert.strictEqual(path, "/custom/hapilon/config.json");
    });
  });
});
