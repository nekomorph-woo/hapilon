import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, GLOBAL_FLAGS } from "../../cli/commands.js";

describe("commands", () => {
  it("所有命令有 name 和 description", () => {
    for (const cmd of COMMANDS) {
      assert.ok(cmd.name && cmd.name.length > 0, `${cmd.name}: 应有 name`);
      assert.ok(cmd.description && cmd.description.length > 0, `${cmd.name}: 应有 description`);
    }
  });

  it("无重复 name", () => {
    const names = COMMANDS.map((c) => c.name);
    const unique = new Set(names);
    assert.strictEqual(unique.size, names.length, "命令 name 应唯一");
  });

  it("doctor/help 已注册，setup/config/mcp 已移除（配置交给 pi 原生）", () => {
    const nameSet = new Set(COMMANDS.map((c) => c.name));
    assert.ok(nameSet.has("doctor"), "应包含 doctor");
    assert.ok(nameSet.has("help"), "应包含 help");
    for (const gone of ["setup", "config", "mcp"]) {
      assert.ok(!nameSet.has(gone), `不应再包含 ${gone}`);
    }
  });

  it("子命令也有 description", () => {
    for (const cmd of COMMANDS) {
      if (cmd.subcommands) {
        for (const sub of cmd.subcommands) {
          assert.ok(sub.name && sub.name.length > 0, `${cmd.name} > ${sub.name}: 应有 name`);
          assert.ok(sub.description && sub.description.length > 0, `${cmd.name} > ${sub.name}: 应有 description`);
        }
      }
    }
  });

  it("路由由注册表驱动：doctor/help 均有 handler", () => {
    for (const name of ["doctor", "help"]) {
      const cmd = COMMANDS.find((c) => c.name === name);
      assert.ok(cmd, `应存在 ${name}`);
      assert.equal(typeof cmd!.handler, "function", `${name} 应有 handler`);
    }
  });
});

describe("GLOBAL_FLAGS", () => {
  it("含 --help / --no-safety / --sandbox（help 文本回源）", () => {
    const names = GLOBAL_FLAGS.map((f) => f.name);
    assert.ok(names.some((n) => n.includes("--help")), "应含 --help");
    assert.ok(names.some((n) => n.includes("--no-safety")), "应含 --no-safety");
    assert.ok(names.some((n) => n.includes("--sandbox")), "应含 --sandbox");
  });

  it("每个 flag 有 description", () => {
    for (const f of GLOBAL_FLAGS) {
      assert.ok(f.description && f.description.length > 0, `${f.name}: 应有 description`);
    }
  });
});
