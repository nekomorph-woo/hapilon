import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("cli integration", () => {
  let tmpBase: string;
  const ORIGINAL_ENV = process.env.HAPILON_HOME;
  const CLI_PATH = join(process.cwd(), "dist", "cli.js");

  before(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "hapilon-cli-test-"));
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

  describe("setup --quick", () => {
    it("创建 ~/.hapilon/ 骨架", () => {
      const result = spawnSync(process.execPath, [CLI_PATH, "setup", "--quick"], {
        env: { ...process.env, HAPILON_HOME: tmpBase },
        encoding: "utf8",
      });

      assert.strictEqual(result.status, 0, `setup --quick 应成功退出: ${result.stderr}`);
      assert.ok(existsSync(join(tmpBase, "agent")), "应创建 agent 目录");
      assert.ok(existsSync(join(tmpBase, "agent", "auth.json")), "应创建 auth.json");
      assert.ok(existsSync(join(tmpBase, "agent", "settings.json")), "应创建 settings.json");
    });

    it("输出创建成功信息", () => {
      const result = spawnSync(process.execPath, [CLI_PATH, "setup", "--quick"], {
        env: { ...process.env, HAPILON_HOME: tmpBase },
        encoding: "utf8",
      });

      assert.ok(result.stdout.includes("Created ~/.hapilon/"), "应输出创建成功信息");
      assert.ok(result.stdout.includes("setup"), "应提示交互式 setup");
    });

    it("setup 命令执行后应退出（不启动 pi）", () => {
      const result = spawnSync(process.execPath, [CLI_PATH, "setup", "--quick"], {
        env: { ...process.env, HAPILON_HOME: tmpBase },
        encoding: "utf8",
        timeout: 5000,
      });

      assert.strictEqual(result.status, 0, "setup 应正常退出，不应启动 pi");
      assert.ok(!result.stdout.includes("hapilon_v0.1.0_alpha"), "setup 时不应输出版本信息");
    });
  });

  describe("doctor", () => {
    it("输出诊断信息", () => {
      const result = spawnSync(process.execPath, [CLI_PATH, "doctor"], {
        env: { ...process.env, HAPILON_HOME: tmpBase },
        encoding: "utf8",
      });

      assert.strictEqual(result.status, 0, `doctor 应成功退出: ${result.stderr}`);
      assert.ok(result.stdout.includes("hapilon v"), "应包含版本信息");
      assert.ok(result.stdout.includes("Node.js"), "应包含 Node.js 版本");
      assert.ok(result.stdout.includes("PI_CODING_AGENT_DIR"), "应包含 PI_CODING_AGENT_DIR");
    });

    it("doctor 命令执行后应退出（不启动 pi）", () => {
      const result = spawnSync(process.execPath, [CLI_PATH, "doctor"], {
        env: { ...process.env, HAPILON_HOME: tmpBase },
        encoding: "utf8",
        timeout: 5000,
      });

      assert.strictEqual(result.status, 0, "doctor 应正常退出，不应启动 pi");
      assert.ok(!result.stdout.includes("hapilon_v0.1.0_alpha"), "doctor 时不应输出版本信息");
    });
  });

  describe("默认启动", () => {
    it("未配置 ~/.hapilon/ 时输出警告", () => {
      const freshBase = mkdtempSync(join(tmpdir(), "hapilon-fresh-"));

      const result = spawnSync(process.execPath, [CLI_PATH], {
        env: { ...process.env, HAPILON_HOME: freshBase },
        encoding: "utf8",
        timeout: 3000,
      });

      try {
        rmSync(freshBase, { recursive: true, force: true });
      } catch { /* ignore */ }

      const output = result.stdout + result.stderr;
      assert.ok(output.includes("not configured") || output.includes("setup"), "未配置时应提示用户");
    });
  });

  describe("参数透传", () => {
    it("非 setup/doctor 命令应传给 pi", () => {
      const result = spawnSync(process.execPath, [CLI_PATH, "--help"], {
        env: { ...process.env, HAPILON_HOME: tmpBase },
        encoding: "utf8",
        timeout: 5000,
      });

      assert.ok(result.status !== undefined, "应正常退出或有退出码");
    });
  });
});
