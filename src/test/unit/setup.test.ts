import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../../cli/setup.js";

describe("doctor（cli/setup）", () => {
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
        assert.ok(output.includes(`${tmpBase}/`), "应包含实际配置目录状态");
        assert.ok(output.includes(`${tmpBase}/agent/`), "应包含实际 agent 目录状态");
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

    it("输出包含 pi binary 可解析检查", () => {
      const outputs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        outputs.push(args.map(String).join(" "));
      };

      try {
        doctor();

        const output = outputs.join("\n");
        assert.ok(output.includes("pi binary"), "应包含 pi binary 检查行");
        assert.ok(output.includes("✅") || output.includes("❌") || output.includes("⚠"),
          "应显示检查结果状态");
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
