import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setupQuick, doctor } from "../../setup.js";

describe("setup", () => {
  let tmpBase: string;
  const ORIGINAL_ENV = process.env.HAPILON_HOME;

  before(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "hapilon-setup-test-"));
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

  describe("setupQuick()", () => {
    it("创建目录骨架", () => {
      setupQuick();

      const agentDir = join(tmpBase, "agent");
      assert.ok(existsSync(agentDir), "应创建 agent 目录");
      assert.ok(existsSync(join(agentDir, "auth.json")), "应创建 auth.json");
      assert.ok(existsSync(join(agentDir, "settings.json")), "应创建 settings.json");
      assert.ok(existsSync(join(agentDir, "models.json")), "应创建 models.json");
    });

    it("创建基础目录结构", () => {
      setupQuick();

      assert.ok(existsSync(join(tmpBase, "sessions")), "应创建 sessions 目录");
      assert.ok(existsSync(join(tmpBase, "logs")), "应创建 logs 目录");
      assert.ok(existsSync(join(tmpBase, "cache")), "应创建 cache 目录");
    });
  });

  describe("setupInteractive()", () => {
    const SETUP_PATH = join(process.cwd(), "dist", "setup.js");

    it("空输入时创建空 auth.json", () => {
      // 对所有问题回答 "n"
      const answers = ["n", "n", "n", "n", "n", "n", "n", "n", "n", "n", ""];
      const result = spawnSync(process.execPath, ["-e", `
        process.env.HAPILON_HOME = "${tmpBase}";
        import("${SETUP_PATH}").then(m => m.setupInteractive()).catch(() => process.exit(1));
      `], {
        input: answers.join("\n") + "\n",
        encoding: "utf8",
        timeout: 5000,
      });

      const authPath = join(tmpBase, "agent", "auth.json");
      const content = readFileSync(authPath, "utf8");
      const parsed = JSON.parse(content);

      assert.deepStrictEqual(parsed, {}, "空输入时应创建空 auth.json");
    });

    it("配置 provider 并写入 auth.json", () => {
      const answers = [
        "y",
        "sk-deepseek-test-key",
        "n", "n", "n", "n", "n", "n", "n", "n",
        "n",
      ];
      const result = spawnSync(process.execPath, ["-e", `
        process.env.HAPILON_HOME = "${tmpBase}";
        import("${SETUP_PATH}").then(m => m.setupInteractive()).catch(() => process.exit(1));
      `], {
        input: answers.join("\n") + "\n",
        encoding: "utf8",
        timeout: 5000,
      });

      const authPath = join(tmpBase, "agent", "auth.json");
      const content = readFileSync(authPath, "utf8");
      const parsed = JSON.parse(content);

      assert.deepStrictEqual(parsed.deepseek, {
        type: "api_key",
        key: "sk-deepseek-test-key",
      });
    });

    it("支持自定义 provider 添加", () => {
      const answers = [
        "n", "n", "n", "n", "n", "n", "n", "n", "n",
        "y",
        "openai",
        "sk-openai-test-key",
        "",
      ];
      const result = spawnSync(process.execPath, ["-e", `
        process.env.HAPILON_HOME = "${tmpBase}";
        import("${SETUP_PATH}").then(m => m.setupInteractive()).catch(() => process.exit(1));
      `], {
        input: answers.join("\n") + "\n",
        encoding: "utf8",
        timeout: 5000,
      });

      const authPath = join(tmpBase, "agent", "auth.json");
      const content = readFileSync(authPath, "utf8");
      const parsed = JSON.parse(content);

      assert.deepStrictEqual(parsed.openai, {
        type: "api_key",
        key: "sk-openai-test-key",
      });
    });

    it("拒绝无效的 provider ID", () => {
      const answers = [
        "n", "n", "n", "n", "n", "n", "n", "n", "n",
        "y",
        "invalid-provider-id",
        "",
      ];
      const result = spawnSync(process.execPath, ["-e", `
        process.env.HAPILON_HOME = "${tmpBase}";
        import("${SETUP_PATH}").then(m => m.setupInteractive()).catch(() => process.exit(1));
      `], {
        input: answers.join("\n") + "\n",
        encoding: "utf8",
        timeout: 5000,
      });

      const authPath = join(tmpBase, "agent", "auth.json");
      const content = readFileSync(authPath, "utf8");
      const parsed = JSON.parse(content);

      // issue #1 增量合并后，auth.json 保留此前测试写入的条目——仅断言无效 ID 未被写入
      assert.equal(
        Object.hasOwn(parsed, "invalid-provider-id"),
        false,
        "无效 provider 不应被写入",
      );
    });

    it("🤖①②: 增量 setup 保留已有 provider，两轮配置共存（issue #1）", () => {
      const isolated = mkdtempSync(join(tmpdir(), "hapilon-issue1-test-"));
      try {
        const run = (answers: string[]) =>
          spawnSync(process.execPath, ["-e", `
            process.env.HAPILON_HOME = ${JSON.stringify(isolated)};
            import(${JSON.stringify(SETUP_PATH)}).then(m => m.setupInteractive()).catch(() => process.exit(1));
          `], {
            input: answers.join("\n") + "\n",
            encoding: "utf8",
            timeout: 5000,
          });

        // 第一轮：只配置 deepseek（COMMON 第 1 位），其余 8 个 + "其他 provider" 均跳过
        run(["y", "sk-ds-first", "n", "n", "n", "n", "n", "n", "n", "n", "n"]);
        // 第二轮：跳过前 8 个，只配置 zai（COMMON 第 9 位）
        run(["n", "n", "n", "n", "n", "n", "n", "n", "y", "sk-zai-second", "n"]);

        const parsed = JSON.parse(
          readFileSync(join(isolated, "agent", "auth.json"), "utf8"),
        );
        assert.deepStrictEqual(parsed.deepseek, {
          type: "api_key",
          key: "sk-ds-first",
        }, "第一轮配置的 deepseek 不应被第二轮覆盖丢失");
        assert.deepStrictEqual(parsed.zai, {
          type: "api_key",
          key: "sk-zai-second",
        }, "第二轮配置的 zai 应写入");
      } finally {
        rmSync(isolated, { recursive: true, force: true });
      }
    });
  });

  describe("doctor()", () => {
    it("输出包含版本信息", () => {
      const outputs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        outputs.push(args.map(String).join(" "));
      };

      try {
        doctor();

        const output = outputs.join("\n");
        assert.ok(output.includes("hapilon v"), "应包含 hapilon 版本");
        assert.ok(output.includes("Node.js"), "应包含 Node.js 版本");
      } finally {
        console.log = originalLog;
      }
    });

    it("输出包含目录状态", () => {
      const outputs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        outputs.push(args.map(String).join(" "));
      };

      try {
        doctor();

        const output = outputs.join("\n");
        assert.ok(output.includes("~/.hapilon/"), "应包含 ~/.hapilon/ 状态");
        assert.ok(output.includes("~/.hapilon/agent/"), "应包含 ~/.hapilon/agent/ 状态");
      } finally {
        console.log = originalLog;
      }
    });

    it("输出包含 PI_CODING_AGENT_DIR", () => {
      const outputs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        outputs.push(args.map(String).join(" "));
      };

      try {
        doctor();

        const output = outputs.join("\n");
        assert.ok(output.includes("PI_CODING_AGENT_DIR"), "应包含 PI_CODING_AGENT_DIR");
      } finally {
        console.log = originalLog;
      }
    });

    it("Node.js 版本检查正确", () => {
      const outputs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        outputs.push(args.map(String).join(" "));
      };

      try {
        doctor();

        const output = outputs.join("\n");
        const currentVersion = process.version;
        if (currentVersion >= "v22.19.0") {
          assert.ok(output.includes("✅"), "Node.js >= 22.19 应显示 ✅");
        }
      } finally {
        console.log = originalLog;
      }
    });
  });
});
